import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { normalizeJiraBaseUrl } from "./config.ts";

// `node server/index.mjs --install`: add context-hub to Claude Code, asking
// only what a non-technical user can answer. The installer scripts in
// installers/ unpack the .mcpb and run this.

export const SERVER_NAME = "context-hub";
const EXTENSION_ID = "local.mcpb.nghiant96.context-hub";
const DEFAULT_BASE_URL = "https://onemount.atlassian.net";

/** Where Claude Desktop keeps the installed extension's server, if it is installed. */
export function findDesktopServer(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, homeDir: string): string | null {
  const relative = path.join("Claude", "Claude Extensions", EXTENSION_ID, "server", "index.mjs");
  const candidates: string[] = [];
  if (platform === "darwin") candidates.push(path.join(homeDir, "Library", "Application Support", relative));
  if (platform === "win32") {
    if (env.APPDATA) candidates.push(path.join(env.APPDATA, relative));
    // The Store build of Claude Desktop keeps its app data inside its package folder.
    const packages = env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Packages") : null;
    if (packages && fs.existsSync(packages)) {
      for (const name of fs.readdirSync(packages).filter((entry) => entry.startsWith("Claude"))) {
        candidates.push(path.join(packages, name, "LocalCache", "Roaming", relative));
      }
    }
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

export interface InstallPlan {
  server: string;
  /** Atlassian settings; absent when sharing the Desktop extension's index. */
  env: Record<string, string> | null;
  repos: string[];
}

/** Arguments for `claude mcp add`. */
export function claudeAddArgs(plan: InstallPlan): string[] {
  const env = Object.entries(plan.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
  return ["mcp", "add", SERVER_NAME, "-s", "user", ...env, "--", "node", plan.server, ...plan.repos];
}

/**
 * One cmd.exe command line. `claude` is a .cmd shim when installed with npm,
 * and Node only runs those through the shell, which joins arguments as given.
 */
export function cmdLine(command: string, args: string[]): string {
  return [command, ...args].map((arg) => (/^[\w.:/\\=@-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`)).join(" ");
}

/** Run the Claude Code CLI; null when it is not installed. */
function claude(args: string[]): { status: number | null; output: string } | null {
  const result =
    process.platform === "win32"
      ? spawnSync(cmdLine("claude", args), { shell: true, encoding: "utf8" })
      : spawnSync("claude", args, { encoding: "utf8" });
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") return null;
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

/** Repo folders typed as one line, separated by ";" (paths may hold spaces). */
export function parseRepos(line: string): string[] {
  return line
    .split(";")
    .map((entry) => entry.trim().replace(/^["']|["']$/g, ""))
    .filter(Boolean)
    .map((entry) => path.resolve(entry.replace(/^~(?=$|[\\/])/, os.homedir())));
}

/** Who the credentials belong to, or why Atlassian refused them. */
async function checkCredentials(baseUrl: string, email: string, token: string): Promise<{ ok: true; name: string } | { ok: false; reason: string }> {
  try {
    const response = await fetch(`${baseUrl}/rest/api/3/myself`, {
      headers: { Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`, Accept: "application/json" }
    });
    if (response.ok) return { ok: true, name: ((await response.json()) as { displayName?: string }).displayName ?? email };
    return { ok: false, reason: response.status === 401 ? "email hoặc token không đúng" : `Atlassian trả về HTTP ${response.status}` };
  } catch {
    return { ok: false, reason: "không kết nối được Atlassian (kiểm tra mạng hoặc VPN)" };
  }
}

interface Prompter {
  ask(question: string): Promise<string>;
  /** Like ask, without echoing what is typed. */
  secret(question: string): Promise<string>;
  close(): void;
}

function prompter(): Prompter {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true });
  const lines: string[] = [];
  const waiting: Array<(line: string) => void> = [];
  rl.on("line", (line) => (waiting.length ? waiting.shift()!(line) : lines.push(line)));
  // An answer piped in ends the input; treat what is missing as empty.
  rl.on("close", () => waiting.splice(0).forEach((resolve) => resolve("")));
  const next = () => new Promise<string>((resolve) => (lines.length ? resolve(lines.shift()!) : waiting.push(resolve)));
  const muted = rl as unknown as { _writeToOutput: (text: string) => void };
  const write = muted._writeToOutput.bind(rl);
  let hiding = false;
  muted._writeToOutput = (text) => write(hiding && !text.startsWith("\n") && !text.startsWith("\r") ? "" : text);
  return {
    async ask(question) {
      process.stdout.write(question);
      return (await next()).trim();
    },
    async secret(question) {
      process.stdout.write(question);
      hiding = true;
      const answer = await next();
      hiding = false;
      if (!process.stdin.isTTY) process.stdout.write("\n");
      return answer.trim();
    },
    close: () => rl.close()
  };
}

const yes = (answer: string) => answer === "" || /^(y|yes|c|co|có)$/i.test(answer);

export async function runInstaller(): Promise<number> {
  const dryRun = process.env.CTX_INSTALL_DRY_RUN === "1";
  const io = prompter();
  try {
    console.log("\n=== Cài context-hub cho Claude Code ===\n");
    // Through cmd.exe a missing command is not ENOENT but a non-zero exit.
    const version = dryRun ? null : claude(["--version"]);
    if (!dryRun && (!version || version.status !== 0)) {
      console.log("Chưa thấy lệnh `claude` (Claude Code). Cài Claude Code trước: https://docs.claude.com/en/docs/claude-code/setup");
      return 1;
    }

    let plan: InstallPlan | null = null;
    const desktop = findDesktopServer(process.platform, process.env, os.homedir());
    if (desktop) {
      console.log("Máy đã có extension context-hub của Claude Desktop.");
      const share = await io.ask("Dùng chung dữ liệu với extension đó, không cần nhập token? [Y/n] ");
      if (yes(share)) plan = { server: desktop, env: null, repos: [] };
    }

    if (!plan) {
      let baseUrl = "";
      while (!baseUrl) {
        const answer = (await io.ask(`Địa chỉ Atlassian [${DEFAULT_BASE_URL}]: `)) || DEFAULT_BASE_URL;
        if (/^https?:\/\/[^\s/]+/.test(answer)) baseUrl = normalizeJiraBaseUrl(answer);
        else console.log("Địa chỉ phải bắt đầu bằng https://, ví dụ https://onemount.atlassian.net. Bấm Enter để dùng địa chỉ mặc định.");
      }
      let credentials: { email: string; token: string } | null = null;
      for (let attempt = 1; attempt <= 3 && !credentials; attempt += 1) {
        const email = await io.ask("Email Atlassian: ");
        console.log("API token: tạo tại https://id.atlassian.com/manage-profile/security/api-tokens (chọn \"Create API token\").");
        const token = await io.secret("Dán API token (không hiện ra màn hình), rồi Enter: ");
        if (!email || !token) {
          console.log("Thiếu email hoặc token.");
          continue;
        }
        const check = await checkCredentials(baseUrl, email, token);
        if (check.ok) {
          console.log(`✓ Đăng nhập được: ${check.name}`);
          credentials = { email, token };
        } else {
          console.log(`✗ Không đăng nhập được: ${check.reason}. Thử lại.`);
        }
      }
      if (!credentials) {
        console.log("Dừng: chưa có email và token dùng được.");
        return 1;
      }
      const spaces = (await io.ask("Space Confluence [Healthcare]: ")) || "Healthcare";
      const projects = (await io.ask("Project Jira [HOS]: ")) || "HOS";
      plan = {
        server: path.resolve(process.argv[1]!),
        env: { JIRA_BASE_URL: baseUrl, JIRA_EMAIL: credentials.email, JIRA_API_TOKEN: credentials.token, CTX_CONFLUENCE_SPACES: spaces, CTX_JIRA_PROJECTS: projects },
        repos: []
      };
    }

    console.log("\nDev/QC: thư mục repo code để dùng test_scope và lịch sử code (BA/PO bấm Enter để bỏ qua).");
    const repos = parseRepos(await io.ask("Nhiều repo thì cách nhau bằng dấu ; : "));
    for (const repo of repos) {
      if (!fs.existsSync(path.join(repo, ".git"))) console.log(`  ! ${repo} không phải repo git, vẫn thêm nhưng sẽ bị bỏ qua khi đồng bộ.`);
    }
    plan.repos = repos;

    const args = claudeAddArgs(plan);
    if (dryRun) {
      console.log(`\n[dry run] claude ${args.map((arg) => (arg.startsWith("JIRA_API_TOKEN=") ? "JIRA_API_TOKEN=***" : arg)).join(" ")}`);
      return 0;
    }
    claude(["mcp", "remove", SERVER_NAME, "-s", "user"]);
    const added = claude(args)!;
    if (added.status !== 0) {
      console.log(`✗ claude mcp add lỗi:\n${added.output}`);
      return 1;
    }
    const check = claude(["mcp", "get", SERVER_NAME]);
    const connected = check?.output.includes("Connected") ?? false;
    console.log(connected ? "\n✓ Đã gắn context-hub vào Claude Code (Connected)." : `\nĐã gắn context-hub, nhưng chưa kết nối được:\n${check?.output ?? ""}`);
    console.log(
      plan.env
        ? "Mở một phiên Claude Code mới. Lần đầu context-hub tự tải Jira và Confluence trong khoảng một phút, sau đó tự cập nhật mỗi 3 giờ."
        : "Mở một phiên Claude Code mới. Dữ liệu do extension trong Claude Desktop đồng bộ, nên giữ extension đó bật."
    );
    return connected ? 0 : 1;
  } finally {
    io.close();
  }
}
