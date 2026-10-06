import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { getState, openDb } from "../src/db.ts";
import {
  canAutoSync,
  createAutoSync,
  explainSyncError,
  extensionConfig,
  isSyncDue,
  missingIndexMessage,
  noticeFor,
  readOnlyMissingIndexMessage,
  staleNotice
} from "../src/extension.ts";
import { tempDir } from "./helpers.ts";

test("extension settings come from the install form, and unset ones are ignored", () => {
  const home = tempDir("ctx-home");
  const config = extensionConfig(
    {
      JIRA_EMAIL: " me@example.com ",
      JIRA_API_TOKEN: "token",
      JIRA_BASE_URL: "https://example.atlassian.net/jira/software",
      CTX_JIRA_PROJECTS: "HOS, ABC",
      CTX_CONFLUENCE_SPACES: "${user_config.confluence_spaces}"
    },
    ["/work/healthos", "${user_config.repos}", "/other/healthos"],
    home
  );
  assert.equal(config.dbPath, path.join(home, ".context-hub", "context.db"));
  assert.equal(config.jira.baseUrl, "https://example.atlassian.net");
  assert.deepEqual(config.jira.projects, ["HOS", "ABC"]);
  assert.equal(config.jira.email, "me@example.com");
  // A placeholder Claude Desktop left unreplaced means "not set".
  assert.deepEqual(config.confluence.spaces, []);
  assert.deepEqual(
    config.repos.map((repo) => [repo.name, repo.path]),
    [
      ["healthos", path.resolve("/work/healthos")],
      ["healthos-2", path.resolve("/other/healthos")]
    ]
  );
  assert.deepEqual(extensionConfig({ CTX_DATA_DIR: "/data/ctx" }, [], home).dbPath, path.resolve("/data/ctx/context.db"));
});

test("a sync is due on first run and once the interval has passed", () => {
  const now = new Date("2026-10-06T12:00:00Z");
  assert.equal(isSyncDue(null, 3, now), true);
  assert.equal(isSyncDue("2026-10-06T10:00:00Z", 3, now), false);
  assert.equal(isSyncDue("2026-10-06T08:59:00Z", 3, now), true);
});

test("sync errors read as what the user should do", () => {
  assert.match(explainSyncError(new Error("Atlassian GET /rest/api/3/field failed: HTTP 401 Unauthorized")), /email hoặc API token/);
  assert.match(explainSyncError(new Error("Atlassian GET /wiki/api/v2/spaces failed: HTTP 403 Forbidden")), /không có quyền/);
  assert.match(explainSyncError(new TypeError("fetch failed")), /không kết nối được/);
  assert.match(explainSyncError(new Error("Không thấy Confluence space Nope (sai key, hoặc token không có quyền xem).")), /Không thấy Confluence space Nope/);
});

test("auto-sync runs once at a time, records success, and reports errors in answers", async () => {
  const dataDir = tempDir("ctx-ext");
  const config = extensionConfig({ CTX_DATA_DIR: dataDir, JIRA_EMAIL: "a", JIRA_API_TOKEN: "b" }, [], dataDir);
  let release: () => void = () => {};
  let calls = 0;
  const sync = createAutoSync(config, {
    intervalHours: 3,
    log: () => {},
    syncAll: async () => {
      calls += 1;
      await new Promise<void>((resolve) => (release = resolve));
    }
  });

  const first = sync.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sync.status().running, true);
  assert.equal(sync.status().firstSync, true);
  assert.match(noticeFor(sync.status()) ?? "", /đang tải dữ liệu Jira và Confluence lần đầu/);

  // A second call in this process, or another process sharing the data folder, waits its turn.
  await sync.runOnce();
  const other = createAutoSync(config, { intervalHours: 3, log: () => {}, syncAll: async () => void (calls += 100) });
  await other.runOnce();
  assert.equal(calls, 1);

  release();
  await first;
  assert.equal(sync.status().running, false);
  assert.ok(sync.status().lastSuccess);
  assert.equal(noticeFor(sync.status()), null);
  assert.ok(!fs.existsSync(path.join(dataDir, "sync.lock")));
  const db = openDb(config.dbPath);
  assert.ok(getState(db, "auto:last"));
  db.close();

  // A lock left by a process that was killed mid-sync does not block the next one.
  fs.writeFileSync(path.join(dataDir, "sync.lock"), "999999");
  const afterCrash = createAutoSync(config, { intervalHours: 3, log: () => {}, syncAll: async () => void (calls += 1) });
  await afterCrash.runOnce();
  assert.equal(calls, 2);
  assert.ok(!fs.existsSync(path.join(dataDir, "sync.lock")));

  const failing = createAutoSync(config, {
    intervalHours: 3,
    log: () => {},
    syncAll: async () => {
      throw new Error("Atlassian GET /rest/api/3/field failed: HTTP 401 Unauthorized");
    }
  });
  await failing.runOnce();
  assert.match(noticeFor(failing.status()) ?? "", /⚠ Lần đồng bộ gần nhất bị lỗi: .*API token/);
  assert.match(missingIndexMessage(failing.status()), /chưa tải được dữ liệu/);
  assert.match(missingIndexMessage(sync.status()), /đang tải dữ liệu/);
});

test("without credentials the server only reads, and says when the data has gone stale", () => {
  const home = tempDir("ctx-home");
  assert.equal(canAutoSync(extensionConfig({ JIRA_BASE_URL: "https://example.atlassian.net" }, [], home)), false);
  assert.equal(canAutoSync(extensionConfig({ JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "a", JIRA_API_TOKEN: "${user_config.jira_api_token}" }, [], home)), false);
  assert.equal(canAutoSync(extensionConfig({ JIRA_BASE_URL: "https://example.atlassian.net", JIRA_EMAIL: "a", JIRA_API_TOKEN: "b" }, [], home)), true);

  const now = new Date("2026-10-08T12:00:00Z");
  assert.equal(staleNotice(null, now), null);
  assert.equal(staleNotice("2026-10-08T01:00:00Z", now), null);
  assert.match(staleNotice("2026-10-06T09:00:00Z", now) ?? "", /cập nhật lần cuối 2026-10-06/);
  assert.match(readOnlyMissingIndexMessage("/x/context.db"), /extension context-hub trong Claude Desktop/);
});
