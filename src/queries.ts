import { isIgnoredPath, type HubConfig } from "./config.ts";
import { hasTable, type Db } from "./db.ts";
import type { FigmaLink } from "./figma.ts";
import { changedFiles, isFixSubject, ticketsInRange } from "./sources/git.ts";
import { issueText } from "./sources/jira.ts";
import { foldVietnamese, lineDiff, searchTerms, splitText, toFtsQuery } from "./text.ts";

export interface IssueRow {
  key: string;
  type: string | null;
  status: string | null;
  priority: string | null;
  summary: string;
  description: string | null;
  extra_text: string | null;
  parent_key: string | null;
  created: string | null;
  updated: string | null;
  url: string | null;
}

export interface CommitRow {
  repo: string;
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface FileTouch {
  repo: string;
  path: string;
  touches: number;
  additions: number;
  deletions: number;
  last: string;
}

export interface TicketRef {
  key: string;
  issue: IssueRow | null;
}

export interface RelatedTicket extends TicketRef {
  sharedFiles: number;
  last: string;
}

export interface FixCommit extends CommitRow {
  keys: string[];
}

export interface PageRef {
  id: number;
  title: string;
  updated: string | null;
  url: string | null;
}

export interface TicketContext {
  key: string;
  issue: IssueRow | null;
  parent: IssueRow | null;
  children: IssueRow[];
  links: Array<TicketRef & { linkType: string }>;
  commits: { count: number; authors: string[]; first: string | null; last: string | null; recent: CommitRow[] };
  files: FileTouch[];
  relatedTickets: RelatedTicket[];
  priorFixes: FixCommit[];
  similar: TicketRef[];
  /**
   * Pages naming the ticket, or its parent (`via`). `editedAfterCode`: the
   * page naming the ticket changed after its last commit, so the code may
   * no longer match it.
   */
  docs: Array<PageRef & { via: string; editedAfterCode: boolean }>;
  /** Pages whose text resembles the ticket's summary but do not name it. */
  similarDocs: PageRef[];
  /** Sprint reports and go-live checklists that list the ticket among many. */
  listings: PageRef[];
  /** Figma links from the ticket, then its parent, then its pages. */
  designs: DesignRef[];
}

export interface DesignRef extends FigmaLink {
  /** The ticket key or page title the link was found in. */
  from: string;
  kind: "ticket" | "parent" | "page";
}

/**
 * A page naming more tickets than this is a listing — a sprint report or a
 * go-live checklist — not a document about any one of them. Specs and API
 * pages here name one to a handful.
 */
const LISTING_MIN_TICKETS = 11;

const fileId = (repo: string, path: string) => `${repo}:${path}`;

/** Whether `later` is strictly after `earlier`; timestamps from Jira, Confluence and git carry different offsets. */
const isAfter = (later: string | null | undefined, earlier: string | null | undefined) =>
  Boolean(later && earlier) && Date.parse(later!) > Date.parse(earlier!);

/** The date of the newest commit naming each ticket. */
function lastCommitOf(db: Db, keys: string[]): Map<string, string> {
  if (keys.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT ci.issue_key AS key, MAX(c.date) AS last FROM commit_issues ci
       JOIN json_each(?) j ON j.value = ci.issue_key
       JOIN commits c ON c.repo = ci.repo AND c.sha = ci.sha
       WHERE c.is_merge = 0
       GROUP BY ci.issue_key`
    )
    .all(JSON.stringify(keys)) as Array<{ key: string; last: string }>;
  return new Map(rows.map((row) => [row.key, row.last]));
}

/** Figma links of the given tickets and pages, in that order, each frame once. */
function designsOf(db: Db, sources: Array<{ source: "issue" | "page"; id: string; from: string; kind: DesignRef["kind"] }>, limit: number): DesignRef[] {
  if (!hasTable(db, "figma_links")) return [];
  const statement = db.prepare("SELECT file_key, node_id, file_name, url FROM figma_links WHERE source = ? AND source_id = ? ORDER BY rowid");
  const seen = new Set<string>();
  const designs: DesignRef[] = [];
  for (const { source, id, from, kind } of sources) {
    for (const row of statement.all(source, id) as Array<{ file_key: string; node_id: string; file_name: string | null; url: string }>) {
      const frame = `${row.file_key}#${row.node_id}`;
      if (seen.has(frame)) continue;
      seen.add(frame);
      designs.push({ fileKey: row.file_key, nodeId: row.node_id, fileName: row.file_name ?? "", url: row.url, from, kind });
    }
  }
  return designs.slice(0, limit);
}

export function getIssue(db: Db, key: string): IssueRow | null {
  return (db.prepare("SELECT * FROM issues WHERE key = ?").get(key) as IssueRow | undefined) ?? null;
}

function issuesByKey(db: Db, keys: string[]): Map<string, IssueRow> {
  if (keys.length === 0) return new Map();
  const rows = db.prepare("SELECT i.* FROM issues i JOIN json_each(?) j ON j.value = i.key").all(JSON.stringify(keys)) as unknown as IssueRow[];
  return new Map(rows.map((row) => [row.key, row]));
}

function keysOfCommit(db: Db, repo: string, sha: string): string[] {
  return (db.prepare("SELECT issue_key FROM commit_issues WHERE repo = ? AND sha = ? ORDER BY issue_key").all(repo, sha) as Array<{ issue_key: string }>).map(
    (row) => row.issue_key
  );
}

/**
 * Commits whose subject marks them as fixes (see isFixSubject), on the given
 * files, excluding those that belong to `excludeKeys`.
 */
function fixCommitsOn(db: Db, fileIds: string[], excludeKeys: string[], limit: number): FixCommit[] {
  if (fileIds.length === 0) return [];
  // One row per fix message: copies and repeated commits of the same fix
  // would otherwise crowd out other fixes from a short list.
  const rows = db
    .prepare(
      `SELECT c.repo, MIN(c.sha) AS sha, c.author, MAX(c.date) AS date, c.subject
       FROM commit_files cf
       JOIN json_each(?) j ON j.value = cf.repo || ':' || cf.path
       JOIN commits c ON c.repo = cf.repo AND c.sha = cf.sha
       WHERE c.is_merge = 0
         AND NOT EXISTS (
           SELECT 1 FROM commit_issues ci JOIN json_each(?) x ON x.value = ci.issue_key
           WHERE ci.repo = c.repo AND ci.sha = c.sha
         )
       GROUP BY c.subject
       ORDER BY date DESC`
    )
    .all(JSON.stringify(fileIds), JSON.stringify(excludeKeys)) as unknown as CommitRow[];
  return rows
    .filter((row) => isFixSubject(row.subject))
    .slice(0, limit)
    .map((row) => ({ ...row, keys: keysOfCommit(db, row.repo, row.sha) }));
}

const pageRef = ({ id, title, updated, url }: PageRef): PageRef => ({ id, title, updated, url });

/**
 * Pages that name any of `keys`, ranked by key order (the ticket before its
 * parent), then the most specific first: a spec about one ticket outranks a
 * release checklist listing eighty.
 */
function pagesNaming(db: Db, keys: string[], limit: number): Array<PageRef & { via: string; breadth: number }> {
  if (keys.length === 0 || !hasTable(db, "pages")) return [];
  const rows = db
    .prepare(
      `SELECT p.id, p.title, p.updated, p.url, MIN(j.key) AS rank,
              (SELECT COUNT(*) FROM page_issues x WHERE x.page_id = p.id) AS breadth
       FROM page_issues pi
       JOIN json_each(?) j ON j.value = pi.issue_key
       JOIN pages p ON p.id = pi.page_id
       GROUP BY p.id
       ORDER BY rank, breadth, p.updated DESC
       LIMIT ?`
    )
    .all(JSON.stringify(keys), limit) as unknown as Array<PageRef & { rank: number; breadth: number }>;
  return rows.map((row) => ({ ...pageRef(row), via: keys[row.rank]!, breadth: row.breadth }));
}

/** Pages ranked by full-text match, titles weighing ten times the body. */
function pagesMatching(db: Db, query: string, limit: number): Array<PageRef & { body: string }> {
  if (!query || !hasTable(db, "pages")) return [];
  return db
    .prepare(
      `WITH hits AS (
         SELECT rowid AS id, bm25(pages_fts, 10.0, 1.0) AS score FROM pages_fts WHERE pages_fts MATCH ? ORDER BY score LIMIT ?
       )
       SELECT p.id, p.title, p.updated, p.url, p.body FROM hits JOIN pages p ON p.id = hits.id ORDER BY hits.score`
    )
    .all(query, limit) as unknown as Array<PageRef & { body: string }>;
}

/** Everything an engineer needs to start on a ticket, in one query. */
export function ticketContext(db: Db, config: Pick<HubConfig, "ignorePaths">, key: string): TicketContext {
  const issue = getIssue(db, key);
  const parent = issue?.parent_key ? getIssue(db, issue.parent_key) : null;
  const children = db.prepare("SELECT * FROM issues WHERE parent_key = ? ORDER BY key").all(key) as unknown as IssueRow[];

  const linkRows = db.prepare("SELECT to_key, link_type FROM issue_links WHERE from_key = ?").all(key) as Array<{ to_key: string; link_type: string }>;
  const linkedIssues = issuesByKey(db, linkRows.map((row) => row.to_key));
  const links = linkRows.map((row) => ({ key: row.to_key, linkType: row.link_type, issue: linkedIssues.get(row.to_key) ?? null }));

  // A rebased or cherry-picked commit gets a new sha on every branch it lands
  // on but keeps its author date and subject; those two identify the logical
  // change, so copies are counted once.
  const commitRows = db
    .prepare(
      `SELECT c.repo, MIN(c.sha) AS sha, c.author, c.date, c.subject FROM commit_issues ci
       JOIN commits c ON c.repo = ci.repo AND c.sha = ci.sha
       WHERE ci.issue_key = ? AND c.is_merge = 0
       GROUP BY c.date, c.subject
       ORDER BY c.date DESC`
    )
    .all(key) as unknown as CommitRow[];

  const files = (
    db
      .prepare(
        `SELECT repo, path, COUNT(*) AS touches, COALESCE(SUM(additions), 0) AS additions,
                COALESCE(SUM(deletions), 0) AS deletions, MAX(date) AS last
         FROM (
           SELECT DISTINCT cf.repo, cf.path, c.date, c.subject, cf.additions, cf.deletions
           FROM commit_issues ci
           JOIN commit_files cf ON cf.repo = ci.repo AND cf.sha = ci.sha
           JOIN commits c ON c.repo = cf.repo AND c.sha = cf.sha
           WHERE ci.issue_key = ?
         )
         GROUP BY repo, path
         ORDER BY touches DESC, last DESC`
      )
      .all(key) as unknown as FileTouch[]
  ).filter((file) => !isIgnoredPath(config, file.path));

  // Bound the fan-out: a ticket that touched hundreds of files would
  // otherwise relate to every ticket in the repository.
  const topFileIds = files.slice(0, 60).map((file) => fileId(file.repo, file.path));

  const relatedRows = topFileIds.length
    ? (db
        .prepare(
          `SELECT ci.issue_key AS key, COUNT(DISTINCT cf.repo || ':' || cf.path) AS sharedFiles, MAX(c.date) AS last
           FROM commit_files cf
           JOIN json_each(?) j ON j.value = cf.repo || ':' || cf.path
           JOIN commit_issues ci ON ci.repo = cf.repo AND ci.sha = cf.sha
           JOIN commits c ON c.repo = cf.repo AND c.sha = cf.sha
           WHERE ci.issue_key <> ?
           GROUP BY ci.issue_key
           ORDER BY sharedFiles DESC, last DESC
           LIMIT 10`
        )
        .all(JSON.stringify(topFileIds), key) as Array<{ key: string; sharedFiles: number; last: string }>)
    : [];
  const relatedIssues = issuesByKey(db, relatedRows.map((row) => row.key));

  const naming = pagesNaming(db, [key, ...(issue?.parent_key ? [issue.parent_key] : [])], 40);
  const lastCommit = commitRows[0]?.date ?? null;
  const docs = naming
    .filter((page) => page.breadth < LISTING_MIN_TICKETS)
    .slice(0, 6)
    .map(({ breadth, ...page }) => ({ ...page, editedAfterCode: page.via === key && isAfter(page.updated, lastCommit) }));
  // A listing matters when it names this ticket (it is in that sprint or
  // release); one naming only the parent says nothing about this ticket.
  const listings = naming
    .filter((page) => page.breadth >= LISTING_MIN_TICKETS && page.via === key)
    .slice(0, 4)
    .map(pageRef);
  const named = new Set(naming.map((page) => page.id));
  const similarDocs = issue?.summary
    ? pagesMatching(db, toFtsQuery(issue.summary, "any"), 3 + named.size)
        .filter((page) => !named.has(page.id))
        .slice(0, 3)
        .map(pageRef)
    : [];

  let similar: TicketRef[] = [];
  if (issue?.summary) {
    const query = toFtsQuery(issue.summary, "any");
    if (query) {
      const rows = db
        .prepare("SELECT key FROM issues_fts WHERE issues_fts MATCH ? AND key <> ? ORDER BY bm25(issues_fts) LIMIT 5")
        .all(query, key) as Array<{ key: string }>;
      const similarIssues = issuesByKey(db, rows.map((row) => row.key));
      similar = rows.map((row) => ({ key: row.key, issue: similarIssues.get(row.key) ?? null }));
    }
  }

  return {
    key,
    issue,
    parent,
    children,
    links,
    commits: {
      count: commitRows.length,
      authors: [...new Set(commitRows.map((row) => row.author))],
      first: commitRows.at(-1)?.date ?? null,
      last: commitRows[0]?.date ?? null,
      recent: commitRows.slice(0, 30)
    },
    files,
    relatedTickets: relatedRows.map((row) => ({ ...row, issue: relatedIssues.get(row.key) ?? null })),
    priorFixes: fixCommitsOn(db, topFileIds, [key], 8),
    similar,
    docs,
    similarDocs,
    listings,
    designs: designsOf(
      db,
      [
        { source: "issue", id: key, from: key, kind: "ticket" },
        ...(issue?.parent_key ? [{ source: "issue" as const, id: issue.parent_key, from: issue.parent_key, kind: "parent" as const }] : []),
        ...docs.map((doc) => ({ source: "page" as const, id: String(doc.id), from: doc.title, kind: "page" as const }))
      ],
      6
    )
  };
}

export interface SearchResult {
  issues: IssueRow[];
  ticketsFromCommits: Array<{ key: string; matches: number; subjects: string[]; issue: IssueRow | null }>;
  pages: Array<PageRef & { excerpt: string }>;
}

/**
 * A short passage around the first searched word. Positions are found on
 * folded text, so "quen ma pin" lands on "Quên mã PIN"; folding keeps
 * precomposed Vietnamese letters one character each, so they line up.
 */
function excerpt(body: string, terms: string[], size = 180): string {
  const folded = foldVietnamese(body);
  const hits = terms.map((term) => folded.indexOf(term)).filter((index) => index >= 0);
  const start = Math.max(0, (hits.length ? Math.min(...hits) : 0) - 60);
  const passage = body.slice(start, start + size).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "… " : ""}${passage}${start + size < body.length ? " …" : ""}`;
}

/**
 * Search tickets by meaning words, with or without diacritics. Commit subjects
 * are searched too: they describe what was actually built, and they cover
 * tickets even before Jira has been synced.
 */
export function search(db: Db, text: string, limit = 10): SearchResult {
  const query = toFtsQuery(text);
  if (!query) return { issues: [], ticketsFromCommits: [], pages: [] };

  const issueKeys = db
    .prepare("SELECT key FROM issues_fts WHERE issues_fts MATCH ? ORDER BY bm25(issues_fts) LIMIT ?")
    .all(query, limit) as Array<{ key: string }>;
  const issueMap = issuesByKey(db, issueKeys.map((row) => row.key));

  const commitHits = db
    .prepare(
      `SELECT ci.issue_key AS key, c.subject AS subject
       FROM commits_fts f
       JOIN commits c ON c.repo = f.repo AND c.sha = f.sha
       JOIN commit_issues ci ON ci.repo = c.repo AND ci.sha = c.sha
       WHERE commits_fts MATCH ? AND c.is_merge = 0
       ORDER BY bm25(commits_fts)
       LIMIT 200`
    )
    .all(query) as Array<{ key: string; subject: string }>;
  const grouped = new Map<string, { matches: number; subjects: string[] }>();
  for (const hit of commitHits) {
    const entry = grouped.get(hit.key) ?? { matches: 0, subjects: [] };
    entry.matches += 1;
    if (entry.subjects.length < 2) entry.subjects.push(hit.subject);
    grouped.set(hit.key, entry);
  }
  const commitTickets = [...grouped.entries()].slice(0, limit);
  const commitIssueMap = issuesByKey(db, commitTickets.map(([key]) => key));

  return {
    issues: issueKeys.map((row) => issueMap.get(row.key)).filter((row): row is IssueRow => Boolean(row)),
    ticketsFromCommits: commitTickets.map(([key, entry]) => ({ key, ...entry, issue: commitIssueMap.get(key) ?? null })),
    // Each page carries an excerpt, so fewer of them fit the same budget.
    pages: pagesMatching(db, query, Math.min(limit, 6)).map((page) => ({ ...pageRef(page), excerpt: excerpt(page.body ?? "", searchTerms(text)) }))
  };
}

export interface TestScope {
  repo: string;
  base: string;
  head: string;
  changedFiles: string[];
  ownTickets: TicketRef[];
  regressionTickets: Array<TicketRef & { files: string[]; last: string }>;
  untrackedFiles: string[];
  priorFixes: FixCommit[];
}

/**
 * What a change could break: tickets whose code lives in the files this
 * branch changes. Those tickets' acceptance criteria are the regression
 * checklist for QC.
 */
export function testScope(db: Db, config: HubConfig, repoName: string, base: string, head: string): TestScope {
  const repo = config.repos.find((candidate) => candidate.name === repoName);
  if (!repo) {
    throw new Error(`Unknown repo "${repoName}". Configured: ${config.repos.map((candidate) => candidate.name).join(", ") || "(none)"}`);
  }
  const projectKeys = config.jira.projects;
  const files = changedFiles(repo.path, base, head).filter((file) => !isIgnoredPath(config, file));
  const own = new Set(ticketsInRange(repo.path, base, head, projectKeys));

  const rows = files.length
    ? (db
        .prepare(
          `SELECT ci.issue_key AS key, cf.path AS path, MAX(c.date) AS last
           FROM commit_files cf
           JOIN json_each(?) j ON j.value = cf.path
           JOIN commits c ON c.repo = cf.repo AND c.sha = cf.sha
           JOIN commit_issues ci ON ci.repo = cf.repo AND ci.sha = cf.sha
           WHERE cf.repo = ?
           GROUP BY ci.issue_key, cf.path`
        )
        .all(JSON.stringify(files), repoName) as Array<{ key: string; path: string; last: string }>)
    : [];

  const byTicket = new Map<string, { files: string[]; last: string }>();
  const trackedFiles = new Set<string>();
  for (const row of rows) {
    // The branch's own commits are indexed too (sync reads every ref), so
    // only history from other tickets makes a file "known".
    if (own.has(row.key)) continue;
    trackedFiles.add(row.path);
    const entry = byTicket.get(row.key) ?? { files: [], last: "" };
    entry.files.push(row.path);
    if (row.last > entry.last) entry.last = row.last;
    byTicket.set(row.key, entry);
  }
  const ranked = [...byTicket.entries()]
    .sort(([, left], [, right]) => right.files.length - left.files.length || right.last.localeCompare(left.last))
    .slice(0, 15);
  const issues = issuesByKey(db, [...own, ...ranked.map(([key]) => key)]);

  return {
    repo: repoName,
    base,
    head,
    changedFiles: files,
    ownTickets: [...own].map((key) => ({ key, issue: issues.get(key) ?? null })),
    regressionTickets: ranked.map(([key, entry]) => ({ key, issue: issues.get(key) ?? null, ...entry })),
    untrackedFiles: files.filter((file) => !trackedFiles.has(file)),
    priorFixes: fixCommitsOn(db, files.map((file) => fileId(repoName, file)), [...own], 8)
  };
}

export interface FileHistory {
  prefix: string;
  repo: string | null;
  tickets: Array<TicketRef & { commits: number; files: number; last: string }>;
  priorFixes: FixCommit[];
}

/**
 * Which tickets shaped a file or folder, newest first. A folder matches whole
 * path segments, so "src/auth" never pulls in "src/authentication".
 */
export function fileHistory(db: Db, target: string, repo: string | null): FileHistory {
  const prefix = target.trim().replace(/^\.(?=\/|$)/, "").replace(/^\/+|\/+$/g, "");
  const under = prefix ? `${prefix.replace(/[\\%_]/g, (char) => `\\${char}`)}/%` : "%";
  const rows = db
    .prepare(
      `SELECT ci.issue_key AS key, COUNT(DISTINCT c.date || '|' || c.subject) AS commits, COUNT(DISTINCT cf.path) AS files, MAX(c.date) AS last
       FROM commit_files cf
       JOIN commits c ON c.repo = cf.repo AND c.sha = cf.sha
       JOIN commit_issues ci ON ci.repo = cf.repo AND ci.sha = cf.sha
       WHERE (cf.path = ? OR cf.path LIKE ? ESCAPE '\\') AND (? IS NULL OR cf.repo = ?)
       GROUP BY ci.issue_key
       ORDER BY last DESC
       LIMIT 20`
    )
    .all(prefix, under, repo, repo) as Array<{ key: string; commits: number; files: number; last: string }>;
  const issues = issuesByKey(db, rows.map((row) => row.key));

  const fileIds = (
    db
      .prepare("SELECT DISTINCT repo, path FROM commit_files WHERE (path = ? OR path LIKE ? ESCAPE '\\') AND (? IS NULL OR repo = ?) LIMIT 200")
      .all(prefix, under, repo, repo) as Array<{ repo: string; path: string }>
  ).map((row) => fileId(row.repo, row.path));

  return {
    prefix,
    repo,
    tickets: rows.map((row) => ({ ...row, issue: issues.get(row.key) ?? null })),
    priorFixes: fixCommitsOn(db, fileIds, [], 10)
  };
}

export interface PageContent {
  page: PageRef & { space: string };
  part: number;
  parts: number;
  text: string;
  /** Tickets the page names; listed with the first part only. */
  issues: TicketRef[];
}

/** Characters per part: one part is about as much as any other tool answer. */
const PAGE_PART_CHARS = 3500;

/** A page id from an id or from any Confluence link that carries one. */
export function pageIdOf(value: string): number | null {
  const match = /\/pages\/(\d+)/.exec(value) ?? /[?&]pageId=(\d+)/.exec(value) ?? /^\s*(\d+)\s*$/.exec(value);
  return match ? Number(match[1]) : null;
}

/** One part of a page's text, so a 60KB spec can be read without spending a whole allowance on it. */
export function pageContent(db: Db, ref: string, part = 1): PageContent | null {
  const id = pageIdOf(ref);
  if (id === null || !hasTable(db, "pages")) return null;
  const row = db.prepare("SELECT id, space, title, body, updated, url FROM pages WHERE id = ?").get(id) as
    | (PageRef & { space: string; body: string | null })
    | undefined;
  if (!row) return null;

  const parts = splitText(row.body ?? "", PAGE_PART_CHARS);
  const index = Math.min(Math.max(1, Math.trunc(part)), parts.length);
  const keys = (db.prepare("SELECT issue_key FROM page_issues WHERE page_id = ? ORDER BY issue_key").all(id) as Array<{ issue_key: string }>).map(
    (entry) => entry.issue_key
  );
  const issues = index === 1 ? issuesByKey(db, keys) : new Map<string, IssueRow>();
  return {
    page: { ...pageRef(row), space: row.space },
    part: index,
    parts: parts.length,
    text: parts[index - 1]!,
    issues: index === 1 ? keys.map((key) => ({ key, issue: issues.get(key) ?? null })) : []
  };
}

type LineDiff = ReturnType<typeof lineDiff>;

export interface ChangedIssue {
  issue: IssueRow;
  /** Created on or after the date asked about. */
  isNew: boolean;
  /** The status before the latest change, when that change moved it. */
  statusBefore: string | null;
  /** When the version the diff compares against was last edited. */
  versionDate: string | null;
  diff: LineDiff | null;
}

export interface ChangedPage extends PageRef {
  versionDate: string | null;
  diff: LineDiff | null;
  /** Tickets with code older than this edit: the code may not match the page any more. */
  drift: Array<{ key: string; lastCommit: string }>;
}

export interface Changes {
  since: string;
  key: string | null;
  /** Tickets under `key` (children and their children). */
  scopeSize: number;
  issues: ChangedIssue[];
  totalIssues: number;
  pages: ChangedPage[];
  totalPages: number;
  /** Every changed page edited after its tickets' code, not only the pages listed. */
  drifting: Array<PageRef & { drift: ChangedPage["drift"] }>;
}

const CHANGED_ISSUES = 15;
const CHANGED_PAGES = 10;
/** Line diffs cost the most output; only the newest changes carry one. */
const DIFFED = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

/** A week before `now`, as YYYY-MM-DD. */
export function defaultSince(now = new Date()): string {
  return new Date(now.getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
}

/**
 * What changed in Jira and Confluence since a date, optionally only under one
 * epic or story: tickets and pages edited, the lines their latest edit added
 * or removed (when sync kept the version before it), and pages edited after
 * the code for the tickets they name was last committed.
 */
export function changes(db: Db, options: { since: string; key?: string | null }): Changes {
  const { since } = options;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new Error(`Ngày "${since}" không đúng dạng YYYY-MM-DD.`);
  const key = options.key ?? null;
  const scope = key
    ? (
        db
          .prepare(
            `WITH RECURSIVE tree(key, depth) AS (
               SELECT ?, 0 UNION SELECT i.key, t.depth + 1 FROM issues i JOIN tree t ON i.parent_key = t.key WHERE t.depth < 2
             )
             SELECT key FROM tree`
          )
          .all(key) as Array<{ key: string }>
      ).map((row) => row.key)
    : null;
  const scopeJson = scope ? JSON.stringify(scope) : null;
  const versionAfter = (table: "issue_versions" | "page_versions", column: string, id: string | number) =>
    hasTable(db, table)
      ? ((db.prepare(`SELECT * FROM ${table} WHERE ${column} = ? AND substr(changed, 1, 10) >= ?`).get(id, since) as Record<string, string | null> | undefined) ?? null)
      : null;

  const issueRows = db
    .prepare(
      `SELECT * FROM issues
       WHERE substr(updated, 1, 10) >= ? AND (? IS NULL OR key IN (SELECT value FROM json_each(?)))
       ORDER BY updated DESC`
    )
    .all(since, scopeJson, scopeJson) as unknown as IssueRow[];
  const issues = issueRows.slice(0, CHANGED_ISSUES).map((issue, index): ChangedIssue => {
    const version = index < DIFFED ? versionAfter("issue_versions", "key", issue.key) : null;
    const texts = version ? (db.prepare("SELECT field, text FROM issue_texts WHERE key = ? ORDER BY position").all(issue.key) as Array<{ field: string; text: string }>) : [];
    return {
      issue,
      isNew: (issue.created ?? "").slice(0, 10) >= since,
      statusBefore: version && version.status !== issue.status ? version.status ?? null : null,
      versionDate: version?.updated ?? null,
      diff: version ? lineDiff(version.text ?? "", issueText(issue.description, texts)) : null
    };
  });

  const pageRows = hasTable(db, "pages")
    ? (db
        .prepare(
          `SELECT p.id, p.title, p.updated, p.url, p.body, (SELECT COUNT(*) FROM page_issues x WHERE x.page_id = p.id) AS breadth
           FROM pages p
           WHERE substr(p.updated, 1, 10) >= ?
             AND (? IS NULL OR p.id IN (SELECT pi.page_id FROM page_issues pi JOIN json_each(?) j ON j.value = pi.issue_key))
           ORDER BY p.updated DESC`
        )
        .all(since, scopeJson, scopeJson) as unknown as Array<PageRef & { body: string | null; breadth: number }>)
    : [];
  // Within an epic, a sprint report that merely lists its stories is noise.
  const relevantPages = scope ? pageRows.filter((page) => page.breadth < LISTING_MIN_TICKETS) : pageRows;
  const inScope = scope ? new Set(scope) : null;
  const driftOf = (page: (typeof relevantPages)[number]): ChangedPage["drift"] => {
    // A listing names too many tickets for its edits to say anything about their code.
    if (page.breadth >= LISTING_MIN_TICKETS) return [];
    const named = (db.prepare("SELECT issue_key FROM page_issues WHERE page_id = ? ORDER BY issue_key").all(page.id) as Array<{ issue_key: string }>).map((row) => row.issue_key).filter((ticket) => !inScope || inScope.has(ticket));
    const lastCommits = lastCommitOf(db, named);
    return named.filter((ticket) => isAfter(page.updated, lastCommits.get(ticket))).map((ticket) => ({ key: ticket, lastCommit: lastCommits.get(ticket)! }));
  };
  const drifts = new Map(relevantPages.map((page) => [page.id, driftOf(page)]));
  const pages = relevantPages.slice(0, CHANGED_PAGES).map((page, index): ChangedPage => {
    const version = index < DIFFED ? versionAfter("page_versions", "page_id", page.id) : null;
    return {
      ...pageRef(page),
      versionDate: version?.updated ?? null,
      diff: version ? lineDiff(version.body ?? "", page.body ?? "") : null,
      drift: drifts.get(page.id)!
    };
  });

  return {
    since,
    key,
    scopeSize: scope ? scope.length - 1 : 0,
    issues,
    totalIssues: issueRows.length,
    pages,
    totalPages: relevantPages.length,
    drifting: relevantPages
      .filter((page) => drifts.get(page.id)!.length)
      .slice(0, CHANGED_PAGES)
      .map((page) => ({ ...pageRef(page), drift: drifts.get(page.id)! }))
  };
}

export interface FigmaLookup {
  link: FigmaLink;
  fileName: string;
  /** Tickets linking this design, then tickets named by pages that link it. */
  tickets: TicketRef[];
  pages: PageRef[];
  /** Screen files the tickets' commits touched: where the design lives in code. */
  screens: Array<{ repo: string; path: string; keys: string[] }>;
  /** Other frames of the same file that tickets or pages link. */
  otherNodes: Array<{ nodeId: string; url: string; keys: string[]; pages: string[] }>;
}

/**
 * A screen component: a file directly in a screens/ folder, or a component
 * named *Screen. Hooks named after their screen (useLoginScreen.ts) and
 * tests are not screens.
 */
export function isScreenFile(filePath: string): boolean {
  const parts = filePath.split("/");
  const name = parts.at(-1) ?? "";
  if (/^use[A-Z]/.test(name) || /\.(?:test|spec)\./.test(name)) return false;
  return /^screens?$/i.test(parts.at(-2) ?? "") || /Screen\.(?:tsx|jsx|swift|kt|dart)$/.test(name);
}

/**
 * From a Figma link to what was built from it: the tickets and pages linking
 * that frame (or any frame of the file, for a file link) and, through the
 * tickets' commits, the screen files that implement it.
 */
export function figmaLookup(db: Db, config: Pick<HubConfig, "ignorePaths">, link: FigmaLink): FigmaLookup {
  const rows = hasTable(db, "figma_links")
    ? (db.prepare("SELECT source, source_id, node_id, file_name, url FROM figma_links WHERE file_key = ? ORDER BY rowid").all(link.fileKey) as Array<{
        source: "issue" | "page";
        source_id: string;
        node_id: string;
        file_name: string | null;
        url: string;
      }>)
    : [];
  const isTarget = (row: { node_id: string }) => !link.nodeId || row.node_id === link.nodeId;
  const target = rows.filter(isTarget);

  const pageIds = [...new Set(target.filter((row) => row.source === "page").map((row) => Number(row.source_id)))];
  const pages = pageIds.length
    ? (db.prepare("SELECT p.id, p.title, p.updated, p.url FROM pages p JOIN json_each(?) j ON j.value = p.id ORDER BY p.updated DESC").all(JSON.stringify(pageIds)) as unknown as PageRef[])
    : [];
  const namedByPages = pageIds.length
    ? (
        db
          .prepare(
            `SELECT DISTINCT pi.issue_key AS key FROM page_issues pi JOIN json_each(?) j ON j.value = pi.page_id
             WHERE (SELECT COUNT(*) FROM page_issues x WHERE x.page_id = pi.page_id) < ?
             ORDER BY pi.issue_key`
          )
          .all(JSON.stringify(pageIds), LISTING_MIN_TICKETS) as Array<{ key: string }>
      ).map((row) => row.key)
    : [];
  const keys = [...new Set([...target.filter((row) => row.source === "issue").map((row) => row.source_id), ...namedByPages])];
  const issues = issuesByKey(db, keys);

  const touched = keys.length
    ? (db
        .prepare(
          `SELECT cf.repo, cf.path, GROUP_CONCAT(DISTINCT ci.issue_key) AS keys, COUNT(DISTINCT ci.issue_key) AS tickets, MAX(c.date) AS last
           FROM commit_issues ci
           JOIN json_each(?) j ON j.value = ci.issue_key
           JOIN commit_files cf ON cf.repo = ci.repo AND cf.sha = ci.sha
           JOIN commits c ON c.repo = cf.repo AND c.sha = cf.sha
           GROUP BY cf.repo, cf.path
           ORDER BY tickets DESC, last DESC`
        )
        .all(JSON.stringify(keys)) as Array<{ repo: string; path: string; keys: string }>)
    : [];
  const screens = touched
    .filter((file) => isScreenFile(file.path) && !isIgnoredPath(config, file.path))
    .slice(0, 8)
    .map((file) => ({ repo: file.repo, path: file.path, keys: file.keys.split(",").sort() }));

  const others = new Map<string, FigmaLookup["otherNodes"][number]>();
  for (const row of rows.filter((candidate) => !isTarget(candidate))) {
    const node = others.get(row.node_id) ?? { nodeId: row.node_id, url: row.url, keys: [], pages: [] };
    if (row.source === "issue") node.keys.push(row.source_id);
    else node.pages.push(row.source_id);
    others.set(row.node_id, node);
  }
  const otherNodes = [...others.values()].slice(0, 8);
  const titles = new Map(
    (hasTable(db, "pages") && otherNodes.some((node) => node.pages.length)
      ? (db.prepare("SELECT p.id, p.title FROM pages p JOIN json_each(?) j ON j.value = p.id").all(JSON.stringify(otherNodes.flatMap((node) => node.pages.map(Number)))) as Array<{ id: number; title: string }>)
      : []
    ).map((row) => [String(row.id), row.title])
  );
  for (const node of otherNodes) node.pages = node.pages.map((id) => titles.get(id) ?? id);

  return {
    link,
    fileName: link.fileName || rows.find((row) => row.file_name)?.file_name || "",
    tickets: keys.map((ticket) => ({ key: ticket, issue: issues.get(ticket) ?? null })),
    pages,
    screens,
    otherNodes
  };
}

export interface IndexStats {
  issues: number;
  commits: number;
  linkedCommits: number;
  ticketsWithCode: number;
  repos: Array<{ repo: string; commits: number; last: string | null }>;
  jiraSince: string | null;
  pages: number;
  pagesWithTickets: number;
  confluenceSince: string | null;
}

export function stats(db: Db): IndexStats {
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    issues: count("SELECT COUNT(*) AS n FROM issues"),
    commits: count("SELECT COUNT(*) AS n FROM commits"),
    linkedCommits: count("SELECT COUNT(DISTINCT repo || sha) AS n FROM commit_issues"),
    ticketsWithCode: count("SELECT COUNT(DISTINCT issue_key) AS n FROM commit_issues"),
    repos: db.prepare("SELECT repo, COUNT(*) AS commits, MAX(date) AS last FROM commits GROUP BY repo ORDER BY repo").all() as IndexStats["repos"],
    jiraSince: (db.prepare("SELECT value FROM sync_state WHERE source = 'jira:since'").get() as { value: string } | undefined)?.value ?? null,
    pages: hasTable(db, "pages") ? count("SELECT COUNT(*) AS n FROM pages") : 0,
    pagesWithTickets: hasTable(db, "pages") ? count("SELECT COUNT(DISTINCT page_id) AS n FROM page_issues") : 0,
    confluenceSince: (db.prepare("SELECT MIN(value) AS value FROM sync_state WHERE source LIKE 'confluence:since:%'").get() as { value: string | null }).value
  };
}
