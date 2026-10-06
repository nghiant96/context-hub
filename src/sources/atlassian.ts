export interface AtlassianCredentials {
  /** Site root, e.g. https://onemount.atlassian.net; Confluence lives under /wiki. */
  baseUrl: string;
  email: string;
  apiToken: string;
}

/** REST access to one Atlassian Cloud site, shared by Jira and Confluence: API token auth and 429 back-off. */
export class AtlassianClient {
  readonly baseUrl: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    credentials: AtlassianCredentials,
    fetchImpl: typeof fetch = fetch,
    sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  ) {
    this.baseUrl = credentials.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${credentials.email}:${credentials.apiToken}`).toString("base64")}`;
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
  }

  async request(method: string, pathname: string, body?: unknown): Promise<unknown> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
        method,
        headers: {
          Authorization: this.authHeader,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: body === undefined ? undefined : JSON.stringify(body)
      });
      if ((response.status === 429 || response.status === 503) && attempt < 5) {
        const retryAfter = Number(response.headers.get("retry-after"));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
        continue;
      }
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 300);
        throw new Error(`Atlassian ${method} ${pathname} failed: HTTP ${response.status} ${detail}`);
      }
      return response.json();
    }
  }
}

interface AdfNode {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
}

/**
 * Atlassian Document Format (how Jira and Confluence Cloud store rich text) to
 * plain text. Keeps structure that carries meaning for requirements — list
 * items, tasks, table rows, headings — and drops media and diagrams.
 */
export function adfToText(node: unknown): string {
  return collapseBlankLines(renderAdf(node));
}

function renderAdf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(renderAdf).join("");
  const adf = node as AdfNode;
  const attr = (name: string) => (typeof adf.attrs?.[name] === "string" ? (adf.attrs[name] as string) : "");
  switch (adf.type) {
    case "text":
      return adf.text ?? "";
    case "hardBreak":
      return "\n";
    case "mention":
      return attr("text") || "@user";
    case "emoji":
      return attr("text") || attr("shortName");
    case "inlineCard":
    case "blockCard":
    case "embedCard":
      return attr("url");
    case "status":
      return `[${attr("text")}]`;
    case "date": {
      const ms = Number(attr("timestamp"));
      return ms > 0 ? new Date(ms).toISOString().slice(0, 10) : "";
    }
    case "rule":
      return "\n---\n";
    // Editor hints ("Type your notes here") are never content.
    case "placeholder":
    case "media":
    case "mediaSingle":
    case "mediaGroup":
    case "mediaInline":
      return "";
  }
  const inner = (adf.content ?? []).map(renderAdf);
  switch (adf.type) {
    case "paragraph":
    case "heading":
    case "codeBlock":
    case "blockquote":
    case "panel":
      return `${inner.join("")}\n`;
    case "listItem":
    case "decisionItem":
      return `- ${inner.join("").trim()}\n`;
    case "taskItem":
      return `- [${attr("state") === "DONE" ? "x" : " "}] ${inner.join("").trim()}\n`;
    case "expand":
    case "nestedExpand":
      return `${attr("title")}\n${inner.join("")}`;
    case "tableRow":
      return `| ${inner.map((cell) => cell.trim().replace(/\n+/g, " ")).join(" | ")} |\n`;
    case "tableCell":
    case "tableHeader":
      return inner.join(" ");
    default:
      return inner.join("");
  }
}

function collapseBlankLines(text: string): string {
  return text.replace(/\n{3,}/g, "\n\n").trim();
}
