#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, type HubConfig } from "./config.ts";
import { openDb } from "./db.ts";
import { parseFigmaLinks } from "./figma.ts";
import { formatChanges, formatFigmaLookup, formatFileHistory, formatPage, formatSearch, formatStats, formatTestScope, formatTicketContext } from "./format.ts";
import { startMcpServer } from "./mcp-server.ts";
import { changes, defaultSince, figmaLookup, fileHistory, pageContent, search, stats, testScope, ticketContext } from "./queries.ts";
import { ConfluenceClient, syncConfluence } from "./sources/confluence.ts";
import { syncGitRepo } from "./sources/git.ts";
import { importIssues, JiraClient, syncJira } from "./sources/jira.ts";

const HELP = `context-hub — ngữ cảnh nghiệp vụ cho BA, dev, QC

  ctx sync [git|jira|confluence] [--full]
                                    Index git, Jira, Confluence (mặc định: tất cả)
  ctx import-jira <file.json>       Nạp ticket từ file JSON export của Jira
  ctx ticket <KEY>                  Ngữ cảnh một ticket, vd: ctx ticket HOS-1313
  ctx search <từ khoá…|link Figma>   Tìm ticket và tài liệu theo nghiệp vụ, có dấu hay không dấu;
                                    với link Figma: ticket, tài liệu và màn hình code của thiết kế đó
  ctx changes [--since YYYY-MM-DD] [--key HOS-330]
                                    Ticket và trang đã sửa (mặc định 7 ngày qua), spec sửa sau khi đã code
  ctx page <id|link> [--part n]     Đọc một trang Confluence đã index
  ctx scope --repo <tên> [--base origin/develop] [--head HEAD]
                                    Ticket cần regression cho một nhánh
  ctx file <đường dẫn> [--repo <tên>]
                                    Lịch sử ticket của file/thư mục
  ctx stats                         Thống kê index
  ctx mcp                           Chạy MCP server (stdio) cho Claude
`;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function positional(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index]!.startsWith("--")) {
      if (args[index] !== "--full") index += 1;
      continue;
    }
    values.push(args[index]!);
  }
  return values;
}

function syncGit(config: HubConfig): void {
  if (config.repos.length === 0) {
    console.log("Chưa khai báo repo nào trong context-hub.config.json.");
    return;
  }
  const db = openDb(config.dbPath);
  try {
    for (const repo of config.repos) {
      if (!fs.existsSync(path.join(repo.path, ".git"))) {
        console.warn(`! Bỏ qua ${repo.name}: không thấy git repo tại ${repo.path}`);
        continue;
      }
      const result = syncGitRepo(db, repo.name, repo.path, config.jira.projects);
      console.log(`✓ git ${result.repo}: ${result.commits} commit, ${result.linkedCommits} gắn mã ticket, ${result.tickets} ticket`);
    }
  } finally {
    db.close();
  }
}

async function syncJiraCommand(config: HubConfig, full: boolean, required: boolean): Promise<void> {
  const { baseUrl, email, apiToken, projects } = config.jira;
  if (!baseUrl || !email || !apiToken) {
    const message = "Bỏ qua Jira: thiếu JIRA_EMAIL / JIRA_API_TOKEN trong .env (xem README, mục Kết nối Jira và Confluence).";
    if (required) throw new Error(message);
    console.log(message);
    return;
  }
  const db = openDb(config.dbPath);
  try {
    const client = new JiraClient({ baseUrl, email, apiToken });
    const result = await syncJira(db, client, projects, {
      full,
      onPage: (count) => process.stdout.write(`\r… ${count} ticket`)
    });
    process.stdout.write("\r");
    console.log(
      `✓ jira ${projects.join(", ")}: ${result.issues} ticket (${result.mode === "full" ? "toàn bộ" : "cập nhật mới"}), ` +
        `bỏ ${result.templates} đoạn mẫu điền sẵn chưa ai sửa`
    );
  } finally {
    db.close();
  }
}

async function syncConfluenceCommand(config: HubConfig, full: boolean, required: boolean): Promise<void> {
  const { baseUrl, email, apiToken, projects } = config.jira;
  const { spaces } = config.confluence;
  if (spaces.length === 0 || !baseUrl || !email || !apiToken) {
    const reason = spaces.length === 0 ? "chưa khai báo confluence.spaces trong context-hub.config.json" : "thiếu JIRA_EMAIL / JIRA_API_TOKEN trong .env";
    const message = `Bỏ qua Confluence: ${reason} (xem README, mục Kết nối Jira và Confluence).`;
    if (required) throw new Error(message);
    console.log(message);
    return;
  }
  const db = openDb(config.dbPath);
  try {
    const client = new ConfluenceClient({ baseUrl, email, apiToken });
    const results = await syncConfluence(db, client, spaces, projects, {
      full,
      onPage: (space, count) => process.stdout.write(`\r… ${space}: ${count} trang`)
    });
    process.stdout.write("\r");
    for (const result of results) {
      console.log(
        `✓ confluence ${result.space}: ${result.pages} trang (${result.mode === "full" ? "toàn bộ" : "cập nhật mới"})` +
          (result.removed ? `, bỏ ${result.removed} trang đã xoá hoặc lưu trữ` : "")
      );
    }
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const config = loadConfig(process.env.CTX_CONFIG ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "context-hub.config.json"));

  switch (command) {
    case "sync": {
      const target = positional(args)[0] ?? "all";
      const full = args.includes("--full");
      if (target === "git" || target === "all") syncGit(config);
      if (target === "jira" || target === "all") await syncJiraCommand(config, full, target === "jira");
      if (target === "confluence" || target === "all") await syncConfluenceCommand(config, full, target === "confluence");
      return;
    }
    case "import-jira": {
      const file = positional(args)[0];
      if (!file) throw new Error("Thiếu đường dẫn file JSON.");
      const db = openDb(config.dbPath);
      try {
        const count = importIssues(db, JSON.parse(fs.readFileSync(file, "utf8")), config.jira.baseUrl);
        console.log(`✓ Đã nạp ${count} ticket từ ${file}`);
      } finally {
        db.close();
      }
      return;
    }
    case "ticket":
    case "search":
    case "changes":
    case "scope":
    case "file":
    case "page":
    case "stats": {
      const db = openDb(config.dbPath);
      try {
        console.log(render(command, args, db, config));
      } finally {
        db.close();
      }
      return;
    }
    case "mcp":
      await startMcpServer(config);
      return;
    default:
      console.log(HELP);
      if (command && command !== "help" && command !== "--help") process.exitCode = 1;
  }
}

function render(command: string, args: string[], db: ReturnType<typeof openDb>, config: HubConfig): string {
  const values = positional(args);
  switch (command) {
    case "ticket": {
      const key = values[0];
      if (!key) throw new Error("Thiếu mã ticket, vd: ctx ticket HOS-1313");
      return formatTicketContext(ticketContext(db, config, key.toUpperCase()));
    }
    case "search": {
      const query = values.join(" ");
      if (!query) throw new Error("Thiếu từ khoá tìm kiếm.");
      const figma = parseFigmaLinks(query)[0];
      return figma ? formatFigmaLookup(figmaLookup(db, config, figma)) : formatSearch(query, search(db, query));
    }
    case "changes":
      return formatChanges(changes(db, { since: flag(args, "since") ?? defaultSince(), key: flag(args, "key")?.toUpperCase() ?? null }));
    case "scope": {
      const repo = flag(args, "repo") ?? config.repos[0]?.name;
      if (!repo) throw new Error("Thiếu --repo.");
      return formatTestScope(testScope(db, config, repo, flag(args, "base") ?? "origin/develop", flag(args, "head") ?? "HEAD"));
    }
    case "file": {
      const prefix = values[0];
      if (!prefix) throw new Error("Thiếu đường dẫn.");
      return formatFileHistory(fileHistory(db, prefix, flag(args, "repo") ?? null));
    }
    case "page": {
      const ref = values[0];
      if (!ref) throw new Error("Thiếu id hoặc link trang, vd: ctx page 3879570817");
      return formatPage(ref, pageContent(db, ref, Number(flag(args, "part") ?? 1)));
    }
    default:
      return formatStats(stats(db));
  }
}

main(process.argv.slice(2)).catch((error: Error) => {
  console.error(`Lỗi: ${error.message}`);
  // A failed command must fail the shell too, or scripts and CI read success.
  process.exitCode = 1;
});
