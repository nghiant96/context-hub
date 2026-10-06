# context-hub

Indexes Jira, Confluence and git history into SQLite (`data/context.db`) and serves it over MCP. Node 24 runs the TypeScript in `src/` directly; only the Claude Desktop extension is built (`npm run build:extension`, esbuild into one file, then `mcpb pack`).

- `src/sources/` reads git, Jira and Confluence (shared Atlassian HTTP and ADF code in `atlassian.ts`); `src/queries.ts` answers; `src/format.ts` renders capped markdown; `src/mcp-server.ts` defines the tools.
- Entry points: `src/mcp.ts` (MCP over stdio), `src/cli.ts`, and `src/extension-main.ts` for the extension, which takes its settings from `extension/manifest.json`'s `user_config` and syncs on its own (`src/extension.ts`). MCP stdout is the protocol: log to stderr only.
- Redact before storing (`redact` in `src/text.ts`): Jira and Confluence content may hold patients' personal data.
- Keep tool output small: users are on fixed Claude allowances.
- Use only erasable TypeScript syntax (no enums, no constructor parameter properties) and `.ts` import extensions.
- Checks: `npm test` and `npm run typecheck`.
