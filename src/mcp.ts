import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { loadConfig, type HubConfig } from "./config.ts";
import { openDbReadOnly, type Db } from "./db.ts";
import { formatFileHistory, formatPage, formatSearch, formatTestScope, formatTicketContext } from "./format.ts";
import { fileHistory, pageContent, search, testScope, ticketContext } from "./queries.ts";

const INSTRUCTIONS = `context-hub trả về ngữ cảnh nghiệp vụ của dự án: ticket Jira (mô tả, AC, bình luận) và tài liệu Confluence, nối với lịch sử code.
Dùng ticket_context trước khi làm hoặc review một ticket; test_scope để chọn phạm vi regression cho một nhánh;
search khi chỉ biết mô tả nghiệp vụ; file_history để biết vì sao một file/thư mục có hình dạng như hiện tại;
confluence_page để đọc một trang tài liệu mà các tool kia trả về.`;

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

/**
 * Build the server around a database opener rather than an open handle, so
 * each call reads the latest index — a sync can run while AI tools query.
 */
export function createMcpServer(config: HubConfig, openDb: () => Db | null): McpServer {
  const server = new McpServer({ name: "context-hub", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  const run = (render: (db: Db) => string): ToolResult => {
    const db = openDb();
    if (!db) {
      return { content: [{ type: "text", text: "Chưa có index. Chạy `npm run ctx -- sync` trong thư mục context-hub." }], isError: true };
    }
    try {
      return { content: [{ type: "text", text: render(db) }] };
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
      description: "Tìm theo từ khoá nghiệp vụ, có dấu hay không dấu đều được: ticket Jira, nội dung commit và tài liệu Confluence.",
      inputSchema: {
        query: z.string().describe("Từ khoá, ví dụ: quên mã PIN"),
        limit: z.number().int().min(1).max(30).optional()
      },
      annotations: { readOnlyHint: true }
    },
    async ({ query, limit }) => run((db) => formatSearch(query, search(db, query, limit ?? 10)))
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

export async function startMcpServer(config: HubConfig): Promise<void> {
  const server = createMcpServer(config, () => openDbReadOnly(config.dbPath));
  await server.connect(new StdioServerTransport());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await startMcpServer(loadConfig(process.env.CTX_CONFIG ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "context-hub.config.json")));
}
