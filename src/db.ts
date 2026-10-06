import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type Db = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS issues (
  key TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  type TEXT,
  status TEXT,
  priority TEXT,
  summary TEXT NOT NULL,
  description TEXT,
  extra_text TEXT,
  labels TEXT,
  components TEXT,
  parent_key TEXT,
  created TEXT,
  updated TEXT,
  resolution TEXT,
  url TEXT
);
CREATE INDEX IF NOT EXISTS issues_parent ON issues(parent_key);

-- Free-text custom fields and comments, one row each, so boilerplate can be
-- told apart from content (see refreshIssueTexts).
CREATE TABLE IF NOT EXISTS issue_texts (
  key TEXT NOT NULL,
  position INTEGER NOT NULL,
  field TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (key, position)
);
CREATE INDEX IF NOT EXISTS issue_texts_value ON issue_texts(field, text);

CREATE TABLE IF NOT EXISTS text_templates (
  field TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (field, text)
);

CREATE TABLE IF NOT EXISTS issue_links (
  from_key TEXT NOT NULL,
  to_key TEXT NOT NULL,
  link_type TEXT NOT NULL,
  PRIMARY KEY (from_key, to_key, link_type)
);

CREATE TABLE IF NOT EXISTS commits (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  author TEXT,
  date TEXT,
  subject TEXT,
  is_merge INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo, sha)
);

CREATE TABLE IF NOT EXISTS commit_issues (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  issue_key TEXT NOT NULL,
  PRIMARY KEY (repo, sha, issue_key)
);
CREATE INDEX IF NOT EXISTS commit_issues_key ON commit_issues(issue_key);

CREATE TABLE IF NOT EXISTS commit_files (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  additions INTEGER,
  deletions INTEGER,
  PRIMARY KEY (repo, sha, path)
);
CREATE INDEX IF NOT EXISTS commit_files_path ON commit_files(repo, path);

-- Search columns hold folded text (see foldVietnamese), so queries match with
-- or without diacritics.
CREATE VIRTUAL TABLE IF NOT EXISTS issues_fts USING fts5(
  key UNINDEXED, summary, body, tokenize = "unicode61 remove_diacritics 2"
);
CREATE VIRTUAL TABLE IF NOT EXISTS commits_fts USING fts5(
  repo UNINDEXED, sha UNINDEXED, subject, tokenize = "unicode61 remove_diacritics 2"
);

-- Confluence pages. The id is Confluence's numeric page id, which is also the
-- rowid of the search entry, so updating a page never scans the search table.
CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY,
  space TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  parent_id INTEGER,
  updated TEXT,
  url TEXT
);
CREATE INDEX IF NOT EXISTS pages_space ON pages(space);

CREATE TABLE IF NOT EXISTS page_issues (
  page_id INTEGER NOT NULL,
  issue_key TEXT NOT NULL,
  PRIMARY KEY (page_id, issue_key)
);
CREATE INDEX IF NOT EXISTS page_issues_key ON page_issues(issue_key);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, body, tokenize = "unicode61 remove_diacritics 2"
);

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Open (and create if needed) the index for reading and writing. */
export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

/**
 * Open an existing index read-only. The MCP server uses this so a sync can
 * keep writing (WAL) while AI tools query.
 */
export function openDbReadOnly(dbPath: string): Db | null {
  if (!fs.existsSync(dbPath)) return null;
  return new DatabaseSync(dbPath, { readOnly: true });
}

/** Run `fn` in one transaction; bulk inserts are orders of magnitude faster. */
export function inTransaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/**
 * Whether a table exists. The MCP server opens the index read-only and cannot
 * create tables an older index lacks; queries use this to answer without them
 * until the next sync adds them.
 */
export function hasTable(db: Db, name: string): boolean {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
}

export function getState(db: Db, source: string): string | null {
  const row = db.prepare("SELECT value FROM sync_state WHERE source = ?").get(source) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setState(db: Db, source: string, value: string): void {
  db.prepare("INSERT INTO sync_state(source, value) VALUES (?, ?) ON CONFLICT(source) DO UPDATE SET value = excluded.value").run(source, value);
}
