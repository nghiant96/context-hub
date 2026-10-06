import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { HubConfig } from "./config.ts";
import { openDbReadOnly, type Db } from "./db.ts";
import { parseFigmaLinks } from "./figma.ts";
import { formatChanges, formatFigmaLookup, formatFileHistory, formatPage, formatSearch, formatTestScope, formatTicketContext } from "./format.ts";
import { changes, defaultSince, figmaLookup, fileHistory, pageContent, search, testScope, ticketContext } from "./queries.ts";

const INSTRUCTIONS = `context-hub trả về ngữ cảnh nghiệp vụ của dự án: ticket Jira (mô tả, AC, bình luận) và tài liệu Confluence, nối với lịch sử code.
Dùng ticket_context trước khi làm hoặc review một ticket; test_scope để chọn phạm vi regression cho một nhánh;
search khi chỉ biết mô tả nghiệp vụ, hoặc với một link Figma để tìm ticket và màn hình code làm từ thiết kế đó;
changes để biết ticket/tài liệu nào vừa sửa và spec nào sửa sau khi đã code; file_history để biết vì sao một file/thư mục
có hình dạng như hiện tại; confluence_page để đọc một trang tài liệu mà các tool kia trả về.`;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

export interface ServerOptions {
  /** What to say when there is no index yet. */
  missingIndex?: () => string;
  /** A line put before every answer, such as "first sync still running". */
  notice?: (db: Db) => string | null;
}

/**
 * Build the server around a database opener rather than an open handle, so
 * each call reads the latest index — a sync can run while AI tools query.
 */
export function createMcpServer(config: HubConfig, openDb: () => Db | null, options: ServerOptions = {}): McpServer {
  const server = new McpServer({ name: "context-hub", version: "0.2.2" }, { instructions: INSTRUCTIONS });
  const missingIndex = options.missingIndex ?? (() => "Chưa có index. Chạy `npm run ctx -- sync` trong thư mục context-hub.");

  const run = (render: (db: Db) => string): ToolResult => {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text", text: missingIndex() }], isError: true };
    }
    try {
      const notice = options.notice?.(db);
      return { content: [{ type: "text", text: notice ? `${notice}\n\n${render(db)}` : render(db) }] };
    } catch (error) {
      return { content: [{ type: "text", text: `Lỗi: ${(error as Error).message}` }], isError: true };
    } finally {
      db.close();
    }
  };

  server.registerTool(
    "ticket_context",
    {
      title: "Ngữ cảnh một ticket",
      description:
        "Mô tả, AC, ticket cha/con/liên kết, tài liệu Confluence liên quan, file code từng sửa cho ticket, ticket khác đụng cùng file, lỗi từng sửa ở cùng khu vực, ticket tương tự. Gọi trước khi bắt đầu làm, review hoặc viết test cho một ticket.",
      inputSchema: { key: z.string().describe("Mã ticket, ví dụ HOS-1313") },
      annotations: { readOnlyHint: true }
    },
    async ({ key }) => run((db) => formatTicketContext(ticketContext(db, config, key.trim().toUpperCase())))
  );

  server.registerTool(
    "search",
    {
      title: "Tìm ticket theo nghiệp vụ",
      description:
        "Tìm theo từ khoá nghiệp vụ, có dấu hay không dấu đều được: ticket Jira, nội dung commit và tài liệu Confluence. Đưa link Figma thì trả về ticket, tài liệu và màn hình code làm từ thiết kế đó.",
      inputSchema: {
        query: z.string().describe("Từ khoá, ví dụ: quên mã PIN; hoặc một link Figma"),
        limit: z.number().int().min(1).max(30).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit }) =>
      run((db) => {
        const figma = parseFigmaLinks(query)[0];
        return figma ? formatFigmaLookup(figmaLookup(db, config, figma)) : formatSearch(query, search(db, query, limit ?? 10));
      })
  );

  server.registerTool(
    "changes",
    {
      title: "Thay đổi gần đây",
      description:
        "Ticket Jira và trang Confluence sửa từ một ngày (mặc định 7 ngày trước), kèm dòng thêm/bớt so với bản trước, và cảnh báo trang spec sửa sau commit cuối của ticket (code có thể đã lệch spec). Truyền key của epic/story để chỉ xem phạm vi đó.",
      inputSchema: {
        since: z.string().optional().describe("Từ ngày YYYY-MM-DD, mặc định 7 ngày trước"),
        key: z.string().optional().describe("Epic hoặc story, ví dụ HOS-330: chỉ xem ticket đó, ticket con và tài liệu nhắc tới chúng")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ since, key }) => run((db) => formatChanges(changes(db, { since: since?.trim() || defaultSince(), key: key?.trim().toUpperCase() || null })))
  );

  server.registerTool(
    "test_scope",
    {
      title: "Phạm vi regression của một nhánh",
      description:
        "Với một nhánh/thay đổi, liệt kê ticket cũ có code nằm trong các file vừa sửa (danh sách regression) và các lỗi từng sửa ở đó. Dùng khi QC chuẩn bị test hoặc dev đánh giá rủi ro.",
      inputSchema: {
        repo: z.string().describe(`Tên repo: ${config.repos.map((repo) => repo.name).join(", ")}`),
        base: z.string().optional().describe("Nhánh gốc, mặc định origin/develop"),
        head: z.string().optional().describe("Nhánh cần test, mặc định HEAD")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ repo, base, head }) => run((db) => formatTestScope(testScope(db, config, repo, base ?? "origin/develop", head ?? "HEAD")))
  );

  server.registerTool(
    "file_history",
    {
      title: "Lịch sử ticket của file/thư mục",
      description: "Những ticket đã định hình một file hoặc thư mục, kèm các lần sửa lỗi gần đây.",
      inputSchema: {
        path: z.string().describe("Đường dẫn file hoặc thư mục, ví dụ src/features/auth"),
        repo: z.string().optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ path: prefix, repo }) => run((db) => formatFileHistory(fileHistory(db, prefix, repo ?? null)))
  );

  server.registerTool(
    "confluence_page",
    {
      title: "Đọc trang Confluence",
      description:
        "Nội dung chữ của một trang Confluence đã index (spec, PRD, checklist…) và các ticket trang nhắc tới. Trang dài được chia phần khoảng 3.5KB; đọc phần 1 trước, chỉ đọc tiếp khi cần.",
      inputSchema: {
        page: z.string().describe("Link trang Confluence (từ ticket_context hoặc search) hoặc id trang"),
        part: z.number().int().min(1).optional().describe("Phần cần đọc, mặc định 1")
      },
      annotations: { readOnlyHint: true }
    },
    async ({ page, part }) => run((db) => formatPage(page, pageContent(db, page, part ?? 1)))
  );

  return server;
}

export async function startMcpServer(config: HubConfig, options: ServerOptions = {}): Promise<void> {
  const server = createMcpServer(config, () => openDbReadOnly(config.dbPath), options);
  await server.connect(new StdioServerTransport());
}
