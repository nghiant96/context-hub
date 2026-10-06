import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDb } from "../src/db.ts";
import { fileHistory, search, testScope, ticketContext } from "../src/queries.ts";
import { issueKeysByCommit, syncGitRepo, type GitCommit } from "../src/sources/git.ts";
import { formatTestScope, formatTicketContext } from "../src/format.ts";
import { buildFixtureRepo, fixtureConfig, tempDir } from "./helpers.ts";

const repo = buildFixtureRepo();
const config = fixtureConfig(repo, path.join(tempDir("ctx-db"), "context.db"));
const db = openDb(config.dbPath);
const sync = syncGitRepo(db, "app", repo, ["HOS"]);

test("git sync links commits to tickets and is idempotent", () => {
  assert.equal(sync.tickets, 6);
  const again = syncGitRepo(db, "app", repo, ["HOS"]);
  assert.equal(again.commits, sync.commits);
  const count = (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as { n: number }).n;
  assert.equal(count, sync.commits);
});

test("a commit without a key belongs to the branch that merged it, never to a back-merge", () => {
  const pin = ticketContext(db, config, "HOS-30");
  assert.equal(pin.commits.count, 1);
  assert.deepEqual(pin.files.map((file) => file.path), ["src/security/pin-lock.ts"]);
  // Merging main into feat/HOS-31 brought a chore along; it stays ticketless.
  assert.deepEqual(ticketContext(db, config, "HOS-31").files.map((file) => file.path), ["src/authentication/sso.ts"]);
  assert.equal(fileHistory(db, "README.md", null).tickets.length, 0);
});

test("a commit merged through a QC bundle takes the key of its own feature branch", () => {
  const commit = (sha: string, parents: string[], subject: string): GitCommit => ({ sha, parents, subject, author: "a", date: "", body: "", files: [] });
  // develop: base ← chore ←──────────── toDevelop
  //            \                        /
  //             ├─ qcWork ← toQc ──────┘
  //             └─ wip ────┘
  const keys = issueKeysByCommit(
    [
      commit("toDevelop", ["chore", "toQc"], "Merge branch 'qc/HOS-40-41' into 'develop'"),
      commit("chore", ["base"], "chore: dọn dẹp"),
      commit("toQc", ["qcWork", "wip"], "Merge branch 'feature/HOS-40-pin' into 'qc/HOS-40-41'"),
      commit("qcWork", ["base"], "HOS-41 feat: màn hồ sơ"),
      commit("wip", ["base"], "wip"),
      commit("base", [], "HOS-1 feat: khởi tạo")
    ],
    ["HOS"]
  );
  assert.deepEqual(keys.get("wip"), ["HOS-40"]);
  assert.deepEqual(keys.get("qcWork"), ["HOS-41"]);
  assert.deepEqual(keys.get("chore"), []);
});

test("ticket context: files, related tickets, and prior fixes", () => {
  const context = ticketContext(db, config, "HOS-10");

  // The cherry-picked copy has a new sha but is the same change.
  assert.equal(context.commits.count, 2);
  const paths = context.files.map((file) => file.path).sort();
  assert.deepEqual(paths, ["src/auth/login.ts", "src/auth/otp.test.ts", "src/auth/otp.ts"]);
  assert.equal(context.files.find((file) => file.path === "src/auth/otp.ts")?.touches, 1);

  // HOS-12 shares otp.ts and HOS-20 (on its branch) too; HOS-11 shares nothing.
  const related = context.relatedTickets.map((ticket) => ticket.key);
  assert.ok(related.includes("HOS-12"));
  assert.ok(!related.includes("HOS-11"));
  assert.deepEqual(
    context.priorFixes.map((fix) => fix.subject),
    ["HOS-12 fix: OTP hết hạn vẫn cho nhập"]
  );

  const markdown = formatTicketContext(context);
  assert.match(markdown, /chưa có trong Jira index/);
  assert.match(markdown, /src\/auth\/otp\.ts/);
  assert.doesNotMatch(markdown, /package-lock/);
});

test("search finds tickets from commit text without diacritics", () => {
  const result = search(db, "het han otp");
  assert.deepEqual(result.ticketsFromCommits.map((hit) => hit.key), ["HOS-12"]);
  assert.equal(search(db, "").ticketsFromCommits.length, 0);
});

test("test scope lists regression tickets for a branch", () => {
  const scope = testScope(db, config, "app", "main", "feature");
  assert.deepEqual(scope.changedFiles.sort(), ["src/auth/otp.ts", "src/auth/pin.ts"]);
  assert.deepEqual(scope.ownTickets.map((ticket) => ticket.key), ["HOS-20"]);
  assert.deepEqual(scope.regressionTickets.map((ticket) => ticket.key).sort(), ["HOS-10", "HOS-12"]);
  assert.deepEqual(scope.untrackedFiles, ["src/auth/pin.ts"]);
  assert.deepEqual(scope.priorFixes.map((fix) => fix.keys[0]), ["HOS-12"]);
  assert.match(formatTestScope(scope), /Cần regression/);
});

test("test scope rejects an unknown repo", () => {
  assert.throws(() => testScope(db, config, "nope", "main", "feature"), /Unknown repo "nope"/);
});

test("file history lists the tickets that shaped a folder", () => {
  const history = fileHistory(db, "src/auth/", null);
  assert.deepEqual(history.tickets.map((ticket) => ticket.key).sort(), ["HOS-10", "HOS-12", "HOS-20"]);
  // Whole path segments only: "src/auth" is not a prefix of "src/authentication".
  assert.deepEqual(fileHistory(db, "src/auth", null).tickets.map((ticket) => ticket.key).sort(), ["HOS-10", "HOS-12", "HOS-20"]);
  assert.deepEqual(fileHistory(db, "./src/authentication/", null).tickets.map((ticket) => ticket.key), ["HOS-31"]);
  assert.deepEqual(fileHistory(db, "src/auth/login.ts", null).tickets.map((ticket) => ticket.key), ["HOS-10"]);
  assert.equal(fileHistory(db, "src/profile/", "app").tickets[0]?.key, "HOS-11");
  // LIKE wildcards in the prefix are literal.
  assert.equal(fileHistory(db, "src/%", null).tickets.length, 0);
});
