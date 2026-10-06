import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb, openDbReadOnly } from "../src/db.ts";
import { createMcpServer } from "../src/mcp.ts";
import { syncGitRepo } from "../src/sources/git.ts";
import { buildFixtureRepo, fixtureConfig, tempDir } from "./helpers.ts";

async function connect(openDbFn: Parameters<typeof createMcpServer>[1], config: Parameters<typeof createMcpServer>[0]) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createMcpServer(config, openDbFn).connect(serverTransport);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(clientTransport);
  return client;
}

const textOf = (result: Awaited<ReturnType<Client["callTool"]>>) =>
  (result.content as Array<{ type: string; text: string }>).map((part) => part.text).join("\n");

test("MCP exposes read-only tools that answer from the index", async () => {
  const repo = buildFixtureRepo();
  const config = fixtureConfig(repo, path.join(tempDir("ctx-mcp"), "context.db"));
  const writer = openDb(config.dbPath);
  syncGitRepo(writer, "app", repo, ["HOS"]);
  writer.close();

  const client = await connect(() => openDbReadOnly(config.dbPath), config);
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["changes", "confluence_page", "file_history", "search", "test_scope", "ticket_context"]);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

  const context = await client.callTool({ name: "ticket_context", arguments: { key: " hos-10 " } });
  assert.match(textOf(context), /# HOS-10/);
  assert.match(textOf(context), /HOS-12 fix: OTP hết hạn/);

  const scope = await client.callTool({ name: "test_scope", arguments: { repo: "app", base: "main", head: "feature" } });
  assert.match(textOf(scope), /HOS-12/);

  const page = await client.callTool({ name: "confluence_page", arguments: { page: "123" } });
  assert.match(textOf(page), /Không có trang "123"/);

  const recent = await client.callTool({ name: "changes", arguments: { since: "2026-01-01" } });
  assert.match(textOf(recent), /# Thay đổi từ 2026-01-01/);
  const badDate = await client.callTool({ name: "changes", arguments: { since: "tuần trước" } });
  assert.equal(badDate.isError, true);

  const design = await client.callTool({ name: "search", arguments: { query: "https://www.figma.com/design/JxdA38iI5USpOrIIdnPbAY/App?node-id=1-2&t=x" } });
  assert.match(textOf(design), /# Figma: App · node 1-2/);

  const bad = await client.callTool({ name: "test_scope", arguments: { repo: "missing" } });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /Unknown repo/);
  await client.close();
});

test("MCP still answers from an index built before Confluence, version and Figma support", async () => {
  const repo = buildFixtureRepo();
  const config = fixtureConfig(repo, path.join(tempDir("ctx-mcp"), "context.db"));
  const writer = openDb(config.dbPath);
  syncGitRepo(writer, "app", repo, ["HOS"]);
  writer.exec("DROP TABLE pages; DROP TABLE page_issues; DROP TABLE pages_fts; DROP TABLE page_versions; DROP TABLE issue_versions; DROP TABLE figma_links;");
  writer.close();

  const client = await connect(() => openDbReadOnly(config.dbPath), config);
  for (const [name, args] of [
    ["ticket_context", { key: "HOS-10" }],
    ["search", { query: "otp" }],
    ["search", { query: "https://www.figma.com/design/JxdA38iI5USpOrIIdnPbAY/App?node-id=1-2" }],
    ["changes", { since: "2026-01-01", key: "HOS-10" }],
    ["confluence_page", { page: "1" }]
  ] as const) {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, `${name}: ${textOf(result)}`);
  }
  await client.close();
});

test("MCP says how to build the index when there is none", async () => {
  const config = fixtureConfig(tempDir("ctx-empty"), path.join(tempDir("ctx-mcp"), "missing.db"));
  const client = await connect(() => openDbReadOnly(config.dbPath), config);
  const result = await client.callTool({ name: "search", arguments: { query: "otp" } });
  assert.equal(result.isError, true);
  assert.match(textOf(result), /ctx -- sync/);
  await client.close();
});
