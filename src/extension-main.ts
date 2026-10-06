import os from "node:os";
import { getState } from "./db.ts";
import { canAutoSync, createAutoSync, extensionConfig, missingIndexMessage, noticeFor, readOnlyMissingIndexMessage, staleNotice } from "./extension.ts";
import { startMcpServer } from "./mcp-server.ts";

// Entry point of the Claude Desktop extension bundle (see scripts/build-extension.ts).
// stdout carries the MCP protocol, so everything else is logged to stderr,
// which Claude Desktop keeps in its MCP logs.
const log = (message: string) => console.error(`[context-hub] ${message}`);

const config = extensionConfig(process.env, process.argv.slice(2), os.homedir());

if (!canAutoSync(config)) {
  // No credentials: serve the index another server syncs (see canAutoSync).
  await startMcpServer(config, {
    missingIndex: () => readOnlyMissingIndexMessage(config.dbPath),
    notice: (db) => staleNotice(getState(db, "auto:last"), new Date())
  });
  log(`index: ${config.dbPath}; chỉ đọc (không có email/token nên không tự đồng bộ)`);
} else {
  const intervalHours = Number(process.env.CTX_SYNC_HOURS) > 0 ? Number(process.env.CTX_SYNC_HOURS) : 3;
  const sync = createAutoSync(config, { intervalHours, log });
  await startMcpServer(config, {
    missingIndex: () => missingIndexMessage(sync.status()),
    notice: () => noticeFor(sync.status())
  });
  log(`index: ${config.dbPath}; đồng bộ mỗi ${intervalHours} giờ`);
  sync.start(15_000);
  // Claude Desktop stops a server by closing its input or signalling it; leave
  // no lock behind either way. A kill that skips this is covered by the lock's
  // dead-process check.
  process.on("exit", () => sync.releaseLock());
}
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.on(signal, () => process.exit(0));
process.stdin.on("close", () => process.exit(0));

