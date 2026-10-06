import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.ts";
import { startMcpServer } from "./mcp-server.ts";

// Entry point for `node src/mcp.ts`, which Claude Code and Claude Desktop
// configurations point at; the server itself lives in mcp-server.ts.
await startMcpServer(loadConfig(process.env.CTX_CONFIG ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "context-hub.config.json")));
