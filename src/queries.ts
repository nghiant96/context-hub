import { isIgnoredPath, type HubConfig } from "./config.ts";
import { hasTable, type Db } from "./db.ts";
import { changedFiles, isFixSubject, ticketsInRange } from "./sources/git.ts";
import { foldVietnamese, searchTerms, splitText, toFtsQuery } from "./text.ts";

export interface IssueRow {
  key: string;
  type: string | null;
  status: string | null;
  priority: string | null;
  summary: string;
  description: string | null;
  extra_text: string | null;
  parent_key: string | null;
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
  /** Pages naming the ticket, or its parent (`via`). */
  docs: Array<PageRef & { via: string }>;
  /** Pages whose text resembles the ticket's summary but do not name it. */
  similarDocs: PageRef[];
  /** Sprint reports and go-live checklists that list the ticket among many. */
  listings: PageRef[];
}

/**
 * A page naming more tickets than this is a listing — a sprint report or a
 * go-live checklist — not a document about any one of them. Specs and API
 * pages here name one to a handful.
 */
const LISTING_MIN_TICKETS = 11;

const fileId = (repo: string, path: string) => `${repo}:${path}`;

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
  const docs = naming
    .filter((page) => page.breadth < LISTING_MIN_TICKETS)
    .slice(0, 6)
    .map(({ breadth, ...page }) => page);
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
    listings
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
