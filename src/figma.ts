import type { Db } from "./db.ts";

export interface FigmaLink {
  fileKey: string;
  /** Frame or layer id as links write it ("554-21150"); empty for the whole file. */
  nodeId: string;
  /** From the link's slug; Figma keeps the file key when a file is renamed, so names can differ between links. */
  fileName: string;
  /** The link without its share and tracking parameters (`t=`, `m=`). */
  url: string;
}

const FIGMA_URL = /https?:\/\/(?:www\.)?figma\.com\/(design|file|proto|board|slides|make)\/([A-Za-z0-9]{10,})(?:\/([^\s?#"'<>|()[\]\\]*))?(?:\?([^\s#"'<>|()[\]\\]*))?/g;

/** `node-id=554-21150`, or the older `node-id=554%3A21150` / `554:21150`, as "554-21150". */
function nodeIdOf(query: string): string {
  const match = /(?:^|&)node-id=(\d+)(?:-|%3A|:)(\d+)/i.exec(query);
  return match ? `${match[1]}-${match[2]}` : "";
}

function decodeSlug(slug: string): string {
  try {
    return decodeURIComponent(slug);
  } catch {
    // A slug cut mid-escape stays as written.
    return slug;
  }
}

/**
 * Figma links in text or raw ADF, one per file and node. Pasted links come as
 * /design/ or the older /file/, with node ids in either format and text glued
 * on after them; all name the same frame, so they are normalized to match.
 */
export function parseFigmaLinks(text: string): FigmaLink[] {
  const links = new Map<string, FigmaLink>();
  for (const [, kind, fileKey, slug = "", query = ""] of text.matchAll(FIGMA_URL)) {
    const nodeId = nodeIdOf(query);
    const id = `${fileKey}#${nodeId}`;
    if (links.has(id)) continue;
    // Text holds the slug escaped or not ("%E2%9C%85-HealthOS" or "✅-HealthOS"); links are written escaped.
    const name = decodeSlug(slug);
    const pathname = `${kind === "file" ? "design" : kind}/${fileKey}${name ? `/${encodeURIComponent(name)}` : ""}`;
    links.set(id, { fileKey: fileKey!, nodeId, fileName: name.replace(/-+/g, " ").trim(), url: `https://www.figma.com/${pathname}${nodeId ? `?node-id=${nodeId}` : ""}` });
  }
  return [...links.values()];
}

/** Replace the Figma links recorded for one ticket or page. */
export function saveFigmaLinks(db: Db, source: "issue" | "page", sourceId: string, links: FigmaLink[]): void {
  db.prepare("DELETE FROM figma_links WHERE source = ? AND source_id = ?").run(source, sourceId);
  const insert = db.prepare("INSERT OR IGNORE INTO figma_links(source, source_id, file_key, node_id, file_name, url) VALUES (?, ?, ?, ?, ?, ?)");
  for (const link of links) insert.run(source, sourceId, link.fileKey, link.nodeId, link.fileName, link.url);
}

/**
 * Fill figma_links for an index built before it existed, from the text already
 * stored. Links hidden behind link text are only in the raw documents; they
 * arrive as each ticket or page is next synced (or at once with `sync --full`).
 */
export function backfillFigmaLinks(db: Db): void {
  const issues = db
    .prepare("SELECT key, description, extra_text FROM issues WHERE description LIKE '%figma.com%' OR extra_text LIKE '%figma.com%'")
    .all() as Array<{ key: string; description: string | null; extra_text: string | null }>;
  for (const row of issues) saveFigmaLinks(db, "issue", row.key, parseFigmaLinks(`${row.description ?? ""}\n${row.extra_text ?? ""}`));
  const pages = db.prepare("SELECT id, body FROM pages WHERE body LIKE '%figma.com%'").all() as Array<{ id: number; body: string }>;
  for (const row of pages) saveFigmaLinks(db, "page", String(row.id), parseFigmaLinks(row.body));
}
