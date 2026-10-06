import { foldVietnamese, redact } from "../text.ts";
import { getState, inTransaction, setState, type Db } from "../db.ts";
import { parseFigmaLinks, saveFigmaLinks, type FigmaLink } from "../figma.ts";
import { adfToText, AtlassianClient } from "./atlassian.ts";
import { extractIssueKeys } from "./git.ts";

interface ConfluencePage {
  id: string;
  title: string;
  parentId?: string | null;
  version?: { createdAt?: string };
  body?: { atlas_doc_format?: { value?: string } };
  _links?: { webui?: string };
}

/** Confluence Cloud REST v2: spaces and their current pages. */
export class ConfluenceClient extends AtlassianClient {
  /** Space ids by key. A key the token cannot see is simply absent. */
  async spaceIds(keys: string[]): Promise<Map<string, string>> {
    const ids = new Map<string, string>();
    for await (const spaces of this.paginate<{ id: string; key: string }>(`/wiki/api/v2/spaces?keys=${keys.map(encodeURIComponent).join(",")}&limit=250`)) {
      for (const space of spaces) ids.set(space.key, space.id);
    }
    return ids;
  }

  /** Current pages of a space with their content, most recently edited first. */
  pages(spaceId: string): AsyncGenerator<ConfluencePage[]> {
    return this.paginate(`/wiki/api/v2/pages?space-id=${spaceId}&status=current&sort=-modified-date&body-format=atlas_doc_format&limit=100`);
  }

  /** Ids of every current page in a space, without content: cheap enough to fetch on every sync. */
  async pageIds(spaceId: string): Promise<Set<number>> {
    const ids = new Set<number>();
    for await (const pages of this.paginate<{ id: string }>(`/wiki/api/v2/spaces/${spaceId}/pages?status=current&limit=250`)) {
      for (const page of pages) ids.add(Number(page.id));
    }
    return ids;
  }

  /** Follow `_links.next`, which Confluence gives relative to the site root. */
  private async *paginate<T>(pathname: string): AsyncGenerator<T[]> {
    for (let next: string | undefined = pathname; next; ) {
      const page = (await this.request("GET", next)) as { results?: T[]; _links?: { next?: string } };
      yield page.results ?? [];
      next = page._links?.next;
    }
  }
}

export interface PageRecord {
  id: number;
  space: string;
  title: string;
  /** Plain text, already redacted. */
  body: string;
  parentId: number | null;
  updated: string | null;
  url: string;
  issueKeys: string[];
  figmaLinks: FigmaLink[];
}

/**
 * Map a Confluence page to what the index stores. Text is redacted here,
 * before it can reach the database or an AI tool: specs and checklists can
 * quote real patients' details as test data.
 */
export function toPageRecord(page: ConfluencePage, space: string, baseUrl: string, projectKeys: string[]): PageRecord {
  const adf = page.body?.atlas_doc_format?.value ?? "";
  return {
    id: Number(page.id),
    space,
    title: redact(page.title),
    body: redact(adfToText(adf ? JSON.parse(adf) : null)),
    parentId: page.parentId ? Number(page.parentId) : null,
    updated: page.version?.createdAt ?? null,
    // Without the title slug: shorter, and it still resolves after a rename.
    url: `${baseUrl}/wiki${page._links?.webui?.replace(/(\/pages\/\d+)\/[^/]*$/, "$1") ?? `/pages/viewpage.action?pageId=${page.id}`}`,
    // Tickets appear as links (/browse/HOS-12) and Jira macros as often as in
    // text, so keys are read from the whole document, not the rendered text.
    issueKeys: extractIssueKeys(`${page.title}\n${adf}`, projectKeys),
    figmaLinks: parseFigmaLinks(adf)
  };
}

export function upsertPage(db: Db, page: PageRecord): void {
  // Keep the text the page had before this edit; a refetch of an unchanged
  // page (syncs overlap by a day) must not overwrite it.
  const before = db.prepare("SELECT body, updated FROM pages WHERE id = ?").get(page.id) as { body: string | null; updated: string | null } | undefined;
  if (before && (before.body ?? "") !== page.body) {
    db.prepare("INSERT OR REPLACE INTO page_versions(page_id, updated, body, changed) VALUES (?, ?, ?, ?)").run(page.id, before.updated, before.body, page.updated);
  }
  db.prepare(
    `INSERT INTO pages(id, space, title, body, parent_id, updated, url) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET space = excluded.space, title = excluded.title, body = excluded.body,
       parent_id = excluded.parent_id, updated = excluded.updated, url = excluded.url`
  ).run(page.id, page.space, page.title, page.body, page.parentId, page.updated, page.url);
  db.prepare("DELETE FROM page_issues WHERE page_id = ?").run(page.id);
  const insertKey = db.prepare("INSERT OR IGNORE INTO page_issues(page_id, issue_key) VALUES (?, ?)");
  for (const key of page.issueKeys) insertKey.run(page.id, key);
  db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(page.id);
  db.prepare("INSERT INTO pages_fts(rowid, title, body) VALUES (?, ?, ?)").run(page.id, foldVietnamese(page.title), foldVietnamese(page.body));
  saveFigmaLinks(db, "page", String(page.id), page.figmaLinks);
}

function deletePage(db: Db, id: number): void {
  db.prepare("DELETE FROM pages WHERE id = ?").run(id);
  db.prepare("DELETE FROM page_issues WHERE page_id = ?").run(id);
  db.prepare("DELETE FROM pages_fts WHERE rowid = ?").run(id);
  db.prepare("DELETE FROM page_versions WHERE page_id = ?").run(id);
  db.prepare("DELETE FROM figma_links WHERE source = 'page' AND source_id = ?").run(String(id));
}

export interface ConfluenceSyncResult {
  space: string;
  pages: number;
  /** Pages deleted, archived or moved out of the space since the last sync. */
  removed: number;
  mode: "full" | "incremental";
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pull the pages of each space into the index. Pages arrive newest edit
 * first, so after a space's first full pass paging stops at the first page
 * edited before the previous sync (less a day, for clock differences between
 * this machine and Confluence). Each space keeps its own mark, so a space
 * added to the config later is still read in full. Pages that left the space
 * are found from its list of current page ids.
 */
export async function syncConfluence(
  db: Db,
  client: ConfluenceClient,
  spaces: string[],
  projectKeys: string[],
  options: { full?: boolean; now?: Date; onPage?: (space: string, count: number) => void } = {}
): Promise<ConfluenceSyncResult[]> {
  const startedAt = options.now ?? new Date();
  const spaceIds = await client.spaceIds(spaces);
  const missing = spaces.filter((space) => !spaceIds.has(space));
  if (missing.length > 0) {
    throw new Error(`Không thấy Confluence space ${missing.join(", ")} (sai key, hoặc token không có quyền xem).`);
  }

  const results: ConfluenceSyncResult[] = [];
  for (const space of spaces) {
    const spaceId = spaceIds.get(space)!;
    const state = `confluence:since:${space}`;
    const since = options.full ? null : getState(db, state);

    const current = await client.pageIds(spaceId);
    const gone = (db.prepare("SELECT id FROM pages WHERE space = ?").all(space) as Array<{ id: number }>).filter((row) => !current.has(row.id));
    inTransaction(db, () => gone.forEach((row) => deletePage(db, row.id)));

    let count = 0;
    for await (const batch of client.pages(spaceId)) {
      const fresh = since ? batch.filter((page) => (page.version?.createdAt ?? "") >= since) : batch;
      inTransaction(db, () => {
        for (const page of fresh) upsertPage(db, toPageRecord(page, space, client.baseUrl, projectKeys));
      });
      count += fresh.length;
      options.onPage?.(space, count);
      if (fresh.length < batch.length) break;
    }

    setState(db, state, new Date(startedAt.getTime() - DAY_MS).toISOString());
    results.push({ space, pages: count, removed: gone.length, mode: since ? "incremental" : "full" });
  }
  return results;
}
