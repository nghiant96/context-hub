import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDb } from "../src/db.ts";
import { formatChanges, formatTicketContext } from "../src/format.ts";
import { changes, defaultSince, ticketContext } from "../src/queries.ts";
import { toPageRecord, upsertPage } from "../src/sources/confluence.ts";
import { toIssueRecord, upsertIssue } from "../src/sources/jira.ts";
import { lineDiff } from "../src/text.ts";
import { tempDir } from "./helpers.ts";

const SITE = "https://example.atlassian.net";
const AC = new Map([["customfield_100", "Acceptance Criteria"]]);
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

function issue(key: string, fields: Record<string, unknown>) {
  return { key, fields: { project: { key: "HOS" }, issuetype: { name: "Story" }, created: "2026-06-01T09:00:00.000+0700", ...fields } };
}

function page(id: string, title: string, updated: string, ...lines: string[]) {
  return {
    id,
    title,
    version: { createdAt: updated },
    body: { atlas_doc_format: { value: JSON.stringify(doc(...lines.map(paragraph))) } },
    _links: { webui: `/spaces/Healthcare/pages/${id}/x` }
  };
}

const saveIssue = (db: ReturnType<typeof openDb>, raw: ReturnType<typeof issue>) => upsertIssue(db, toIssueRecord(raw, AC, SITE));
const savePage = (db: ReturnType<typeof openDb>, raw: ReturnType<typeof page>) => upsertPage(db, toPageRecord(raw, "Healthcare", SITE, ["HOS"]));

function addCommit(db: ReturnType<typeof openDb>, sha: string, key: string, date: string): void {
  db.prepare("INSERT INTO commits(repo, sha, author, date, subject, is_merge) VALUES ('app', ?, 'Dev', ?, ?, 0)").run(sha, date, `${key} feat: làm theo spec`);
  db.prepare("INSERT INTO commit_issues(repo, sha, issue_key) VALUES ('app', ?, ?)").run(sha, key);
}

/**
 * Epic HOS-1 with story HOS-2 (built in July) and an unrelated HOS-9. The
 * OTP spec names HOS-2 and is edited in October, after the code was written.
 */
function buildIndex() {
  const db = openDb(path.join(tempDir("ctx-changes"), "context.db"));
  saveIssue(db, issue("HOS-1", { summary: "Onboarding", status: { name: "In Progress" }, updated: "2026-06-01T09:00:00.000+0700" }));
  saveIssue(
    db,
    issue("HOS-2", {
      summary: "Xác thực OTP",
      parent: { key: "HOS-1" },
      status: { name: "In Progress" },
      updated: "2026-07-01T09:00:00.000+0700",
      customfield_100: doc(paragraph("Sai OTP 5 lần thì khoá 5 phút"), paragraph("Gửi lại OTP sau 30 giây"))
    })
  );
  saveIssue(db, issue("HOS-9", { summary: "Sổ tiêm chủng", status: { name: "To Do" }, updated: "2026-10-03T09:00:00.000+0700" }));
  savePage(db, page("10", "Spec OTP", "2026-07-01T00:00:00.000Z", "Áp dụng cho HOS-2", "Sai OTP 5 lần thì khoá 5 phút", "Gửi lại OTP sau 30 giây"));
  addCommit(db, "c1", "HOS-2", "2026-07-15T10:00:00+07:00");

  // October: the spec and the story change.
  savePage(db, page("10", "Spec OTP", "2026-10-02T03:00:00.000Z", "Áp dụng cho HOS-2", "Sai OTP 3 lần thì khoá 15 phút", "Gửi lại OTP sau 30 giây"));
  saveIssue(
    db,
    issue("HOS-2", {
      summary: "Xác thực OTP",
      parent: { key: "HOS-1" },
      status: { name: "Done" },
      updated: "2026-10-02T09:00:00.000+0700",
      customfield_100: doc(paragraph("Sai OTP 3 lần thì khoá 15 phút"), paragraph("Gửi lại OTP sau 30 giây"))
    })
  );
  return db;
}

test("lineDiff lists lines added and removed, counting repeats", () => {
  assert.deepEqual(lineDiff("a\nb\nb\nc", "a\nb\nd\n\n"), { added: ["d"], removed: ["b", "c"] });
  assert.deepEqual(lineDiff("", "x"), { added: ["x"], removed: [] });
});

test("a sync keeps the version a page or ticket had before it changed, and only then", () => {
  const db = buildIndex();
  const pageVersion = db.prepare("SELECT updated, body FROM page_versions WHERE page_id = 10").get() as { updated: string; body: string };
  assert.equal(pageVersion.updated, "2026-07-01T00:00:00.000Z");
  assert.match(pageVersion.body, /Sai OTP 5 lần/);
  const issueVersion = db.prepare("SELECT status, text FROM issue_versions WHERE key = 'HOS-2'").get() as { status: string; text: string };
  assert.equal(issueVersion.status, "In Progress");
  assert.match(issueVersion.text, /Acceptance Criteria:\nSai OTP 5 lần thì khoá 5 phút/);

  // Fetching an unchanged page again (incremental syncs overlap by a day) keeps the older version.
  savePage(db, page("10", "Spec OTP", "2026-10-02T03:00:00.000Z", "Áp dụng cho HOS-2", "Sai OTP 3 lần thì khoá 15 phút", "Gửi lại OTP sau 30 giây"));
  assert.match((db.prepare("SELECT body FROM page_versions WHERE page_id = 10").get() as { body: string }).body, /Sai OTP 5 lần/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM issue_versions WHERE key <> 'HOS-2'").get() as { n: number }).n, 0);
});

test("changes lists what moved since a date, with lines changed and specs edited after the code", () => {
  const db = buildIndex();
  const result = changes(db, { since: "2026-10-01" });
  assert.deepEqual(result.issues.map((entry) => entry.issue.key), ["HOS-9", "HOS-2"]);
  const story = result.issues.find((entry) => entry.issue.key === "HOS-2")!;
  assert.equal(story.statusBefore, "In Progress");
  assert.deepEqual(story.diff, { added: ["Sai OTP 3 lần thì khoá 15 phút"], removed: ["Sai OTP 5 lần thì khoá 5 phút"] });

  assert.deepEqual(result.pages.map((entry) => entry.id), [10]);
  assert.deepEqual(result.pages[0]!.diff, { added: ["Sai OTP 3 lần thì khoá 15 phút"], removed: ["Sai OTP 5 lần thì khoá 5 phút"] });
  assert.deepEqual(result.pages[0]!.drift.map((entry) => entry.key), ["HOS-2"]);
  assert.deepEqual(result.drifting.map((entry) => entry.id), [10]);

  const markdown = formatChanges(result);
  assert.match(markdown, /# Thay đổi từ 2026-10-01/);
  assert.match(markdown, /### ⚠ Spec sửa sau khi đã code/);
  assert.match(markdown, /\[Spec OTP\]\([^)]+\) sửa 2026-10-02 — sau commit cuối của HOS-2 \(2026-07-15\)/);
  assert.match(markdown, /HOS-2 — Xác thực OTP _\(Story, Done\)_ · 2026-10-02 · trạng thái In Progress → Done/);
  assert.match(markdown, /\+ Sai OTP 3 lần thì khoá 15 phút/);
  assert.match(markdown, /− Sai OTP 5 lần thì khoá 5 phút/);
});

test("changes for an epic covers its stories and the pages naming them, nothing else", () => {
  const db = buildIndex();
  const result = changes(db, { since: "2026-10-01", key: "HOS-1" });
  assert.deepEqual(result.issues.map((entry) => entry.issue.key), ["HOS-2"]);
  assert.deepEqual(result.pages.map((entry) => entry.id), [10]);
  assert.match(formatChanges(result), /phạm vi HOS-1 và 1 ticket con/);

  // Drift is checked on every changed page, not only the ones listed.
  for (let index = 0; index < 12; index += 1) savePage(db, page(String(100 + index), `Ghi chú ${index}`, "2026-10-04T00:00:00.000Z", "Không nhắc ticket nào"));
  const crowded = changes(db, { since: "2026-10-01" });
  assert.equal(crowded.totalPages, 13);
  assert.ok(!crowded.pages.some((entry) => entry.id === 10));
  assert.deepEqual(crowded.drifting.map((entry) => entry.id), [10]);

  const quiet = changes(db, { since: "2026-10-05", key: "HOS-1" });
  assert.match(formatChanges(quiet), /_Không có ticket hay trang nào thay đổi\._/);
  assert.throws(() => changes(db, { since: "hôm qua" }), /YYYY-MM-DD/);
  assert.equal(defaultSince(new Date("2026-10-08T05:00:00Z")), "2026-10-01");
});

test("ticket context marks a spec edited after the ticket's last commit", () => {
  const db = buildIndex();
  const context = ticketContext(db, { ignorePaths: [] }, "HOS-2");
  assert.deepEqual(context.docs.map((doc) => [doc.id, doc.editedAfterCode]), [[10, true]]);
  assert.match(formatTicketContext(context), /\[Spec OTP\]\([^)]+\) · cập nhật 2026-10-02 · ⚠ sửa sau commit cuối \(2026-07-15\)/);
});
