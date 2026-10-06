import { foldVietnamese, redact } from "../text.ts";
import { getState, inTransaction, setState, type Db } from "../db.ts";
import { adfToText, AtlassianClient } from "./atlassian.ts";

export interface IssueRecord {
  key: string;
  project: string;
  type: string | null;
  status: string | null;
  priority: string | null;
  summary: string;
  description: string;
  /** Free-text custom fields, then comments; already redacted. */
  texts: Array<{ field: string; text: string }>;
  labels: string[];
  components: string[];
  parentKey: string | null;
  created: string | null;
  updated: string | null;
  resolution: string | null;
  url: string;
  links: Array<{ toKey: string; linkType: string }>;
}

interface JiraField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type?: string; custom?: string };
}

interface JiraIssue {
  key: string;
  fields: Record<string, any>;
}

const STANDARD_FIELDS = [
  "summary",
  "description",
  "status",
  "issuetype",
  "priority",
  "labels",
  "components",
  "parent",
  "issuelinks",
  "created",
  "updated",
  "resolution",
  "project",
  "comment"
];

/** Jira Cloud REST: field metadata and paged issue search. */
export class JiraClient extends AtlassianClient {
  async fields(): Promise<JiraField[]> {
    return (await this.request("GET", "/rest/api/3/field")) as JiraField[];
  }

  /** Every page of issues matching `jql`, using the cursor-based search endpoint. */
  async *search(jql: string, fields: string[]): AsyncGenerator<JiraIssue[]> {
    let nextPageToken: string | undefined;
    for (;;) {
      const page = (await this.request("POST", "/rest/api/3/search/jql", {
        jql,
        fields,
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {})
      })) as { issues?: JiraIssue[]; nextPageToken?: string; isLast?: boolean };
      yield page.issues ?? [];
      if (page.isLast !== false || !page.nextPageToken) return;
      nextPageToken = page.nextPageToken;
    }
  }
}

/**
 * Map a Jira issue to what the index stores. All free text is redacted here,
 * before it can reach the database or an AI tool.
 */
export function toIssueRecord(issue: JiraIssue, textFields: Map<string, string>, baseUrl: string): IssueRecord {
  const fields = issue.fields ?? {};
  const texts: IssueRecord["texts"] = [];
  for (const [id, name] of textFields) {
    const text = adfToText(fields[id]);
    if (text) texts.push({ field: name, text: redact(text) });
  }
  const comments: Array<{ author?: { displayName?: string }; body?: unknown }> = fields.comment?.comments ?? [];
  if (comments.length > 0) {
    const thread = comments.map((comment) => `- ${comment.author?.displayName ?? "?"}: ${adfToText(comment.body)}`).join("\n");
    texts.push({ field: "Bình luận", text: redact(thread) });
  }

  const links: IssueRecord["links"] = [];
  for (const link of fields.issuelinks ?? []) {
    if (link.outwardIssue?.key) links.push({ toKey: link.outwardIssue.key, linkType: link.type?.outward ?? "relates to" });
    if (link.inwardIssue?.key) links.push({ toKey: link.inwardIssue.key, linkType: link.type?.inward ?? "relates to" });
  }

  return {
    key: issue.key,
    project: fields.project?.key ?? issue.key.split("-")[0] ?? "",
    type: fields.issuetype?.name ?? null,
    status: fields.status?.name ?? null,
    priority: fields.priority?.name ?? null,
    summary: redact(fields.summary ?? ""),
    description: redact(adfToText(fields.description)),
    texts,
    labels: fields.labels ?? [],
    components: (fields.components ?? []).map((component: { name?: string }) => component.name ?? "").filter(Boolean),
    parentKey: fields.parent?.key ?? null,
    created: fields.created ?? null,
    updated: fields.updated ?? null,
    resolution: fields.resolution?.name ?? null,
    url: `${baseUrl}/browse/${issue.key}`,
    links
  };
}

export function upsertIssue(db: Db, record: IssueRecord): void {
  db.prepare(
    `INSERT INTO issues(key, project, type, status, priority, summary, description, extra_text, labels, components, parent_key, created, updated, resolution, url)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET project = excluded.project, type = excluded.type, status = excluded.status,
       priority = excluded.priority, summary = excluded.summary, description = excluded.description,
       extra_text = excluded.extra_text, labels = excluded.labels, components = excluded.components,
       parent_key = excluded.parent_key, created = excluded.created, updated = excluded.updated,
       resolution = excluded.resolution, url = excluded.url`
  ).run(
    record.key,
    record.project,
    record.type,
    record.status,
    record.priority,
    record.summary,
    record.description,
    "", // filled in by rebuildIssueText below
    JSON.stringify(record.labels),
    JSON.stringify(record.components),
    record.parentKey,
    record.created,
    record.updated,
    record.resolution,
    record.url
  );
  db.prepare("DELETE FROM issue_links WHERE from_key = ?").run(record.key);
  const insertLink = db.prepare("INSERT OR IGNORE INTO issue_links(from_key, to_key, link_type) VALUES (?, ?, ?)");
  for (const link of record.links) insertLink.run(record.key, link.toKey, link.linkType);

  db.prepare("DELETE FROM issue_texts WHERE key = ?").run(record.key);
  const insertText = db.prepare("INSERT INTO issue_texts(key, position, field, text) VALUES (?, ?, ?, ?)");
  record.texts.forEach((entry, position) => insertText.run(record.key, position, entry.field, entry.text));
  rebuildIssueText(db, record.key);
}

/** Long text repeated verbatim on this many issues is a template, not content. */
const TEMPLATE_MIN_CHARS = 40;
const TEMPLATE_MIN_ISSUES = 5;
const TEMPLATE_MIN_SHARE = 0.05;
/** A value on nearly every issue carries no information, however short. */
const CONSTANT_MIN_SHARE = 0.9;

/**
 * Jira custom fields often ship a default template ("We believe that
 * [idea]…", or just "N/A") that nobody fills in, and it then sits on every
 * issue. Detect it by repetition — the same long text in the same field on
 * many issues, or any text on nearly all of them — and leave it out of what AI
 * tools read and what search matches. A short value on only some issues
 * ("UAT", "iOS") is a real category and is kept.
 */
export function refreshIssueTexts(db: Db): { templates: number } {
  const total = (db.prepare("SELECT COUNT(*) AS n FROM issues").get() as { n: number }).n;
  const minIssues = Math.max(TEMPLATE_MIN_ISSUES, Math.ceil(total * TEMPLATE_MIN_SHARE));
  const nearlyAll = Math.max(minIssues, Math.ceil(total * CONSTANT_MIN_SHARE));
  inTransaction(db, () => {
    db.exec("DELETE FROM text_templates");
    db.prepare(
      `INSERT INTO text_templates(field, text)
       SELECT field, text FROM issue_texts
       GROUP BY field, text
       HAVING COUNT(DISTINCT key) >= ? AND (length(text) >= ? OR COUNT(DISTINCT key) >= ?)`
    ).run(minIssues, TEMPLATE_MIN_CHARS, nearlyAll);
    for (const row of db.prepare("SELECT key FROM issues").all() as Array<{ key: string }>) {
      rebuildIssueText(db, row.key);
    }
  });
  return { templates: (db.prepare("SELECT COUNT(*) AS n FROM text_templates").get() as { n: number }).n };
}

/** Recompute an issue's readable extra text and its search entry, skipping templates. */
function rebuildIssueText(db: Db, key: string): void {
  const texts = db
    .prepare(
      `SELECT t.field, t.text FROM issue_texts t
       WHERE t.key = ? AND NOT EXISTS (SELECT 1 FROM text_templates x WHERE x.field = t.field AND x.text = t.text)
       ORDER BY t.position`
    )
    .all(key) as Array<{ field: string; text: string }>;
  const extraText = texts.map((entry) => `${entry.field}:\n${entry.text}`).join("\n\n");
  db.prepare("UPDATE issues SET extra_text = ? WHERE key = ?").run(extraText, key);

  const issue = db.prepare("SELECT summary, description FROM issues WHERE key = ?").get(key) as { summary: string; description: string | null };
  db.prepare("DELETE FROM issues_fts WHERE key = ?").run(key);
  db.prepare("INSERT INTO issues_fts(key, summary, body) VALUES (?, ?, ?)").run(
    key,
    foldVietnamese(issue.summary),
    foldVietnamese(`${issue.description ?? ""}\n${extraText}`)
  );
}

/** Custom fields that hold free text (acceptance criteria and the like). */
export function textFieldsOf(fields: JiraField[]): Map<string, string> {
  return new Map(
    fields
      .filter((field) => field.custom && field.schema?.type === "string" && /textarea|textfield/.test(field.schema.custom ?? ""))
      .map((field) => [field.id, field.name])
  );
}

export interface JiraSyncResult {
  issues: number;
  mode: "full" | "incremental";
  /** Distinct boilerplate field values detected and left out. */
  templates: number;
}

/**
 * Pull issues into the index. After the first full pass only issues updated
 * since the previous sync are fetched; the window starts a day early so that
 * time-zone differences between this machine and Jira cannot skip an update.
 */
export async function syncJira(
  db: Db,
  client: JiraClient,
  projects: string[],
  options: { full?: boolean; now?: Date; onPage?: (count: number) => void } = {}
): Promise<JiraSyncResult> {
  const startedAt = options.now ?? new Date();
  const since = options.full ? null : getState(db, "jira:since");
  const textFields = textFieldsOf(await client.fields());
  const projectClause = `project in (${projects.map((project) => `"${project}"`).join(", ")})`;
  const jql = since ? `${projectClause} AND updated >= "${since}" ORDER BY updated ASC` : `${projectClause} ORDER BY updated ASC`;

  let count = 0;
  for await (const page of client.search(jql, [...STANDARD_FIELDS, ...textFields.keys()])) {
    inTransaction(db, () => {
      for (const issue of page) upsertIssue(db, toIssueRecord(issue, textFields, client.baseUrl));
    });
    count += page.length;
    options.onPage?.(count);
  }

  const { templates } = refreshIssueTexts(db);
  const dayBefore = new Date(startedAt.getTime() - 24 * 60 * 60 * 1000);
  setState(db, "jira:since", dayBefore.toISOString().slice(0, 10));
  return { issues: count, mode: since ? "incremental" : "full", templates };
}

/** Load issues from a JSON export (an array, or a search response with `issues`). */
export function importIssues(db: Db, raw: unknown, baseUrl: string): number {
  const issues = (Array.isArray(raw) ? raw : (raw as { issues?: JiraIssue[] }).issues ?? []) as JiraIssue[];
  inTransaction(db, () => {
    for (const issue of issues) upsertIssue(db, toIssueRecord(issue, new Map(), baseUrl));
  });
  refreshIssueTexts(db);
  return issues.length;
}
