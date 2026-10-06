# context-hub

Indexes Jira, Confluence and git history into SQLite (`data/context.db`) and serves it over MCP. Node 24 runs the TypeScript in `src/` directly; there is no build step.

- `src/sources/` reads git, Jira and Confluence (shared Atlassian HTTP and ADF code in `atlassian.ts`); `src/queries.ts` answers; `src/format.ts` renders capped markdown; `src/mcp.ts` and `src/cli.ts` are the entry points.
- Redact before storing (`redact` in `src/text.ts`): Jira and Confluence content may hold patients' personal data.
- Keep tool output small: users are on fixed Claude allowances.
- Use only erasable TypeScript syntax (no enums, no constructor parameter properties) and `.ts` import extensions.
- Checks: `npm test` and `npm run typecheck`.
