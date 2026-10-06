import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { claudeAddArgs, cmdLine, findDesktopServer, parseRepos } from "../src/install.ts";
import { tempDir } from "./helpers.ts";

test("claude mcp add gets the settings as -e flags, and none when sharing the Desktop index", () => {
  assert.deepEqual(claudeAddArgs({ server: "/x/index.mjs", env: { JIRA_EMAIL: "a@b.c", JIRA_API_TOKEN: "t" }, repos: ["/code/healthos"] }), [
    "mcp", "add", "context-hub", "-s", "user", "-e", "JIRA_EMAIL=a@b.c", "-e", "JIRA_API_TOKEN=t", "--", "node", "/x/index.mjs", "/code/healthos"
  ]);
  assert.deepEqual(claudeAddArgs({ server: "/x/index.mjs", env: null, repos: [] }), ["mcp", "add", "context-hub", "-s", "user", "--", "node", "/x/index.mjs"]);
});

test("a cmd.exe command line quotes paths with spaces and leaves plain words alone", () => {
  assert.equal(
    cmdLine("claude", ["mcp", "add", "-e", "JIRA_BASE_URL=https://example.atlassian.net", "--", "node", "C:\\Users\\Lan Anh\\context-hub-mcp\\server\\index.mjs"]),
    'claude mcp add -e JIRA_BASE_URL=https://example.atlassian.net -- node "C:\\Users\\Lan Anh\\context-hub-mcp\\server\\index.mjs"'
  );
  assert.equal(cmdLine("x", ['say "hi"']), 'x "say ""hi"""');
});

test("repo folders typed on one line are split on ; and keep their spaces", () => {
  assert.deepEqual(parseRepos(' "/code/my app" ; /code/healthos ;; '), [path.resolve("/code/my app"), path.resolve("/code/healthos")]);
  assert.deepEqual(parseRepos(""), []);
});

test("the Desktop extension's server is found where Claude Desktop installs it on each system", () => {
  const home = tempDir("ctx-install-home");
  assert.equal(findDesktopServer("darwin", {}, home), null);
  const mac = path.join(home, "Library", "Application Support", "Claude", "Claude Extensions", "local.mcpb.nghiant96.context-hub", "server", "index.mjs");
  fs.mkdirSync(path.dirname(mac), { recursive: true });
  fs.writeFileSync(mac, "");
  assert.equal(findDesktopServer("darwin", {}, home), mac);

  // Windows Store build: app data lives inside the package folder.
  const local = tempDir("ctx-install-local");
  const store = path.join(local, "Packages", "Claude_pzs8sxrjxfjjc", "LocalCache", "Roaming", "Claude", "Claude Extensions", "local.mcpb.nghiant96.context-hub", "server", "index.mjs");
  fs.mkdirSync(path.dirname(store), { recursive: true });
  fs.writeFileSync(store, "");
  assert.equal(findDesktopServer("win32", { APPDATA: path.join(local, "Roaming"), LOCALAPPDATA: local }, home), store);
});
