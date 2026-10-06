import fs from "node:fs";
import path from "node:path";
import { buildConfig, type HubConfig } from "./config.ts";
import { getState, openDb, setState } from "./db.ts";
import { ConfluenceClient, syncConfluence } from "./sources/confluence.ts";
import { syncGitRepo } from "./sources/git.ts";
import { JiraClient, syncJira } from "./sources/jira.ts";

// The Claude Desktop extension: the same MCP server, configured from the
// install form instead of a config file, and syncing on its own so nobody
// needs a terminal.

/** Claude Desktop passes an optional setting the user left empty as its literal placeholder. */
const PLACEHOLDER = /^\$\{[^}]+\}$/;

const clean = (value: string | undefined) => {
  const trimmed = value?.trim() ?? "";
  return PLACEHOLDER.test(trimmed) ? "" : trimmed;
};

const list = (value: string) => value.split(/[,;\s]+/).filter(Boolean);

/**
 * Configuration from the extension's settings (environment variables set by
 * Claude Desktop) and the code folders passed as arguments. The index lives
 * in ~/.context-hub, outside the extension, so updating it keeps the data.
 */
export function extensionConfig(env: NodeJS.ProcessEnv, repoArgs: string[], homeDir: string): HubConfig {
  const dataDir = path.resolve(clean(env.CTX_DATA_DIR) || path.join(homeDir, ".context-hub"));
  const names = new Set<string>();
  const repos = repoArgs
    .map(clean)
    .filter(Boolean)
    .map((repoPath) => {
      const base = path.basename(path.resolve(repoPath));
      let name = base;
      for (let index = 2; names.has(name); index += 1) name = `${base}-${index}`;
      names.add(name);
      return { name, path: path.resolve(repoPath) };
    });
  return buildConfig(
    {
      dbPath: path.join(dataDir, "context.db"),
      jira: { baseUrl: clean(env.JIRA_BASE_URL), projects: list(clean(env.CTX_JIRA_PROJECTS)) },
      confluence: { spaces: list(clean(env.CTX_CONFLUENCE_SPACES)) },
      repos
    },
    dataDir,
    { JIRA_EMAIL: clean(env.JIRA_EMAIL), JIRA_API_TOKEN: clean(env.JIRA_API_TOKEN), JIRA_BASE_URL: clean(env.JIRA_BASE_URL) }
  );
}

const HOUR_MS = 60 * 60 * 1000;

export function isSyncDue(lastSync: string | null, intervalHours: number, now: Date): boolean {
  return !lastSync || now.getTime() - Date.parse(lastSync) >= intervalHours * HOUR_MS;
}

/** A sync error as what the person who installed the extension can do about it. */
export function explainSyncError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/HTTP 401/.test(message)) {
    return "email hoặc API token Atlassian không đúng, hoặc token đã hết hạn. Sửa trong Settings → Extensions → context-hub.";
  }
  if (/HTTP 403/.test(message)) return "tài khoản Atlassian không có quyền xem project hoặc space đã khai báo.";
  if (/fetch failed|ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(message)) {
    return "không kết nối được Atlassian (kiểm tra mạng hoặc VPN). Sẽ thử lại ở lần đồng bộ sau.";
  }
  return message.slice(0, 200);
}

export interface SyncStatus {
  running: boolean;
  /** Nothing from Jira has been indexed yet: answers are still incomplete. */
  firstSync: boolean;
  lastSuccess: string | null;
  lastError: string | null;
}

export function noticeFor(status: SyncStatus): string | null {
  if (status.running && status.firstSync) {
    return "_⏳ context-hub đang tải dữ liệu Jira và Confluence lần đầu (thường vài phút), nên kết quả dưới đây có thể chưa đủ._";
  }
  if (status.lastError) return `_⚠ Lần đồng bộ gần nhất bị lỗi: ${status.lastError}_`;
  return null;
}

export function missingIndexMessage(status: SyncStatus): string {
  if (status.lastError) return `context-hub chưa tải được dữ liệu: ${status.lastError}`;
  return "context-hub đang tải dữ liệu Jira và Confluence lần đầu, thường mất vài phút. Hỏi lại sau ít phút nhé.";
}

/** Index every configured source into the database; what `ctx sync` does, without printing. */
async function syncEverything(config: HubConfig, log: (message: string) => void): Promise<void> {
  const db = openDb(config.dbPath);
  try {
    for (const repo of config.repos) {
      if (!fs.existsSync(path.join(repo.path, ".git"))) {
        log(`bỏ qua ${repo.name}: không thấy git repo tại ${repo.path}`);
        continue;
      }
      syncGitRepo(db, repo.name, repo.path, config.jira.projects);
    }
    const { baseUrl, email, apiToken, projects } = config.jira;
    if (!baseUrl || !email || !apiToken) return;
    const jira = await syncJira(db, new JiraClient({ baseUrl, email, apiToken }), projects);
    log(`jira: ${jira.issues} ticket (${jira.mode})`);
    if (config.confluence.spaces.length) {
      for (const result of await syncConfluence(db, new ConfluenceClient({ baseUrl, email, apiToken }), config.confluence.spaces, projects)) {
        log(`confluence ${result.space}: ${result.pages} trang (${result.mode})`);
      }
    }
  } finally {
    db.close();
  }
}

/** A lock older than this is stale even if its pid now belongs to another program. */
const STALE_LOCK_MS = 2 * HOUR_MS;

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take the data folder's sync lock. Claude Desktop can run more than one
 * server process at a time, and two writers would fight over the index. It
 * also starts and kills servers quickly (to probe them, or when an extension
 * is switched off), so a lock whose process is gone is taken over at once.
 */
function acquireLock(lockPath: string): boolean {
  try {
    fs.writeFileSync(lockPath, String(process.pid), { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const holder = Number(fs.readFileSync(lockPath, "utf8").trim());
    if (isAlive(holder) && Date.now() - fs.statSync(lockPath).mtimeMs < STALE_LOCK_MS) return false;
    fs.writeFileSync(lockPath, String(process.pid));
    return true;
  }
}

export interface AutoSync {
  /** Sync now unless a sync is already running here or in another process. */
  runOnce(): Promise<void>;
  /** After `firstDelayMs`, sync if due, then check again every half hour. */
  start(firstDelayMs: number): void;
  stop(): void;
  /** Give up the lock if this process holds it; for shutdown. */
  releaseLock(): void;
  status(): SyncStatus;
}

export function createAutoSync(
  config: HubConfig,
  options: { intervalHours: number; log: (message: string) => void; syncAll?: (config: HubConfig, log: (message: string) => void) => Promise<void> }
): AutoSync {
  const syncAll = options.syncAll ?? syncEverything;
  const lockPath = path.join(path.dirname(config.dbPath), "sync.lock");
  const state: SyncStatus = { running: false, firstSync: false, lastSuccess: null, lastError: null };
  let timers: NodeJS.Timeout[] = [];

  const releaseLock = () => {
    if (state.running && fs.existsSync(lockPath) && fs.readFileSync(lockPath, "utf8").trim() === String(process.pid)) fs.rmSync(lockPath, { force: true });
  };

  const readState = (name: string) => {
    const db = openDb(config.dbPath);
    try {
      return getState(db, name);
    } finally {
      db.close();
    }
  };

  const runOnce = async () => {
    if (state.running) return;
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    if (!acquireLock(lockPath)) {
      options.log("một tiến trình khác đang đồng bộ, bỏ qua lần này");
      return;
    }
    state.running = true;
    state.firstSync = readState("jira:since") === null;
    try {
      await syncAll(config, options.log);
      const db = openDb(config.dbPath);
      try {
        state.lastSuccess = new Date().toISOString();
        setState(db, "auto:last", state.lastSuccess);
      } finally {
        db.close();
      }
      state.lastError = null;
      options.log("đồng bộ xong");
    } catch (error) {
      state.lastError = explainSyncError(error);
      options.log(`đồng bộ lỗi: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    } finally {
      state.running = false;
      fs.rmSync(lockPath, { force: true });
    }
  };

  const runIfDue = () => {
    if (isSyncDue(readState("auto:last"), options.intervalHours, new Date())) void runOnce();
  };

  return {
    runOnce,
    start(firstDelayMs) {
      // Waiting first leaves a server that is only probed and stopped untouched,
      // and keeps the start-up handshake clear of a blocking git read.
      const first = setTimeout(runIfDue, firstDelayMs);
      // Checking often and syncing only when due copes with a laptop that slept through a timer.
      const recheck = setInterval(runIfDue, HOUR_MS / 2);
      first.unref();
      recheck.unref();
      timers = [first, recheck];
    },
    stop() {
      for (const timer of timers) clearTimeout(timer);
    },
    releaseLock,
    status: () => ({ ...state })
  };
}
