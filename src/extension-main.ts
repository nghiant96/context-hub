import os from "node:os";
import { createAutoSync, extensionConfig, missingIndexMessage, noticeFor } from "./extension.ts";
import { startMcpServer } from "./mcp-server.ts";

// Entry point of the Claude Desktop extension bundle (see scripts/build-extension.ts).
// stdout carries the MCP protocol, so everything else is logged to stderr,
// which Claude Desktop keeps in its MCP logs.
const log = (message: string) => console.error(`[context-hub] ${message}`);

const config = extensionConfig(process.env, process.argv.slice(2), os.homedir());
const intervalHours = Number(process.env.CTX_SYNC_HOURS) > 0 ? Number(process.env.CTX_SYNC_HOURS) : 3;
const sync = createAutoSync(config, { intervalHours, log });

await startMcpServer(config, {
  missingIndex: () => missingIndexMessage(sync.status()),
  notice: () => noticeFor(sync.status())
});
log(`index: ${config.dbPath}; đồng bộ mỗi ${intervalHours} giờ`);
sync.start();
