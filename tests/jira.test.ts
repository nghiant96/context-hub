import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDb } from "../src/db.ts";
import { search } from "../src/queries.ts";
import { adfToText } from "../src/sources/atlassian.ts";
import { importIssues, JiraClient, syncJira } from "../src/sources/jira.ts";
import { fakeAtlassian as fakeJira, tempDir } from "./helpers.ts";

const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });

const FIELDS = [
  { id: "summary", name: "Summary", custom: false, schema: { type: "string" } },
  {
    id: "customfield_100",
    name: "Acceptance Criteria",
    custom: true,
    schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea" }
  },
  { id: "customfield_200", name: "Story Points", custom: true, schema: { type: "number" } }
];

function issue(key: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    key,
    fields: {
      project: { key: "HOS" },
      summary,
      issuetype: { name: "Story" },
      status: { name: "In Progress" },
      updated: "2026-10-01T10:00:00.000+0700",
      ...extra
    }
  };
}

test("adfToText keeps the structure requirements rely on", () => {
  const text = adfToText(
    doc(
      { type: "heading", content: [{ type: "text", text: "Luồng chính" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [paragraph("Nhập OTP 6 số")] }, { type: "listItem", content: [paragraph("Sai 5 lần thì khoá")] }] },
      {
        type: "table",
        content: [{ type: "tableRow", content: [{ type: "tableHeader", content: [paragraph("Mã lỗi")] }, { type: "tableCell", content: [paragraph("401")] }] }]
      },
      { type: "paragraph", content: [{ type: "mention", attrs: { text: "@QC" } }, { type: "text", text: " kiểm tra" }] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x" } }] }
    )
  );
  assert.equal(text, "Luồng chính\n- Nhập OTP 6 số\n- Sai 5 lần thì khoá\n| Mã lỗi | 401 |\n@QC kiểm tra");
  assert.equal(adfToText(null), "");
  assert.equal(adfToText("plain"), "plain");
});

test("syncJira pages through issues, keeps text fields, and redacts personal data", async () => {
  const db = openDb(path.join(tempDir("ctx-jira"), "context.db"));
  const { calls, fetchImpl } = fakeJira([
    { body: FIELDS },
    {
      body: {
        issues: [
          issue("HOS-10", "Đăng nhập bằng OTP", {
            description: doc(paragraph("Người dùng nhập OTP gửi qua SMS.")),
            customfield_100: doc({ type: "bulletList", content: [{ type: "listItem", content: [paragraph("OTP hết hạn sau 60 giây")] }] }),
            comment: { comments: [{ author: { displayName: "QC Lan" }, body: doc(paragraph("BN gọi 0912345678 báo lỗi")) }] },
            issuelinks: [{ type: { outward: "blocks", inward: "is blocked by" }, outwardIssue: { key: "HOS-11" } }]
          })
        ],
        nextPageToken: "page-2",
        isLast: false
      }
    },
    { status: 429, headers: { "retry-after": "1" } },
    { body: { issues: [issue("HOS-11", "Hồ sơ người dùng", { parent: { key: "HOS-1" } })], isLast: true } }
  ]);
  const sleeps: number[] = [];
  const client = new JiraClient({ baseUrl: "https://example.atlassian.net/", email: "me@example.com", apiToken: "token" }, fetchImpl, async (ms) => {
    sleeps.push(ms);
  });

  const result = await syncJira(db, client, ["HOS"], { now: new Date("2026-10-06T00:00:00Z") });
  assert.deepEqual(result, { issues: 2, mode: "full", templates: 0 });

  assert.equal(calls[0]!.url, "https://example.atlassian.net/rest/api/3/field");
  assert.equal(calls[0]!.headers.Authorization, `Basic ${Buffer.from("me@example.com:token").toString("base64")}`);
  const firstSearch = calls[1]!.body;
  assert.equal(firstSearch.jql, 'project in ("HOS") ORDER BY updated ASC');
  assert.ok(firstSearch.fields.includes("customfield_100"));
  assert.ok(!firstSearch.fields.includes("customfield_200"));
  assert.equal(calls[3]!.body.nextPageToken, "page-2");
  assert.deepEqual(sleeps, [1000]);

  const row = db.prepare("SELECT * FROM issues WHERE key = 'HOS-10'").get() as Record<string, string>;
  assert.equal(row.description, "Người dùng nhập OTP gửi qua SMS.");
  assert.match(row.extra_text!, /Acceptance Criteria:\n- OTP hết hạn sau 60 giây/);
  assert.match(row.extra_text!, /QC Lan: BN gọi \[phone\] báo lỗi/);
  assert.ok(!row.extra_text!.includes("0912345678"));
  assert.equal(row.url, "https://example.atlassian.net/browse/HOS-10");
  assert.equal((db.prepare("SELECT parent_key FROM issues WHERE key = 'HOS-11'").get() as { parent_key: string }).parent_key, "HOS-1");
  // node:sqlite rows have a null prototype; compare plain copies.
  const links = db.prepare("SELECT to_key, link_type FROM issue_links").all().map((link) => ({ ...link }));
  assert.deepEqual(links, [{ to_key: "HOS-11", link_type: "blocks" }]);

  // Acceptance criteria are searchable, without diacritics.
  assert.deepEqual(search(db, "het han 60 giay").issues.map((issue) => issue.key), ["HOS-10"]);
});

test("default field templates nobody filled in are left out of text and search", async () => {
  const db = openDb(path.join(tempDir("ctx-jira"), "context.db"));
  const template = doc(paragraph("We believe that [idea] for [user] will drive [metric] because [expected outcome]"));
  const issues = Array.from({ length: 10 }, (_, index) =>
    issue(`HOS-${100 + index}`, `Story ${index}`, {
      customfield_100: index === 0 ? doc(paragraph("Sai OTP 5 lần thì khoá tài khoản 30 phút")) : template,
      customfield_300: doc(paragraph(index < 6 ? "UAT" : "Production")),
      customfield_400: "N/A"
    })
  );
  const textField = (id: string, name: string) => ({
    id,
    name,
    custom: true,
    schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textfield" }
  });
  const fields = [...FIELDS, textField("customfield_300", "Environment"), textField("customfield_400", "Version/Build Number")];
  const { fetchImpl } = fakeJira([{ body: fields }, { body: { issues, isLast: true } }]);
  const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "b" }, fetchImpl);

  const result = await syncJira(db, client, ["HOS"]);
  // The long template, and "N/A" which every issue carries.
  assert.equal(result.templates, 2);

  const extra = (key: string) => (db.prepare("SELECT extra_text FROM issues WHERE key = ?").get(key) as { extra_text: string }).extra_text;
  assert.doesNotMatch(extra("HOS-101"), /We believe that/);
  assert.doesNotMatch(extra("HOS-101"), /N\/A/);
  // Real content in the same field survives, and so does a short value only some issues share.
  assert.match(extra("HOS-100"), /Acceptance Criteria:\nSai OTP 5 lần thì khoá tài khoản 30 phút/);
  assert.match(extra("HOS-101"), /Environment:\nUAT/);
  assert.match(extra("HOS-107"), /Environment:\nProduction/);
  assert.deepEqual(search(db, "we believe idea").issues, []);
  assert.deepEqual(search(db, "khoa tai khoan").issues.map((row) => row.key), ["HOS-100"]);
});

test("a second sync only asks for recently updated issues", async () => {
  const db = openDb(path.join(tempDir("ctx-jira"), "context.db"));
  const first = fakeJira([{ body: [] }, { body: { issues: [], isLast: true } }]);
  const client = (fetchImpl: typeof fetch) => new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "b" }, fetchImpl);
  await syncJira(db, client(first.fetchImpl), ["HOS"], { now: new Date("2026-10-06T08:00:00Z") });

  const second = fakeJira([{ body: [] }, { body: { issues: [], isLast: true } }]);
  const result = await syncJira(db, client(second.fetchImpl), ["HOS"]);
  assert.equal(result.mode, "incremental");
  assert.equal(second.calls[1]!.body.jql, 'project in ("HOS") AND updated >= "2026-10-05" ORDER BY updated ASC');
});

test("a Jira error surfaces with its status instead of an empty sync", async () => {
  const db = openDb(path.join(tempDir("ctx-jira"), "context.db"));
  const { fetchImpl } = fakeJira([{ status: 401, body: { errorMessages: ["Unauthorized"] } }]);
  const client = new JiraClient({ baseUrl: "https://example.atlassian.net", email: "a", apiToken: "wrong" }, fetchImpl);
  await assert.rejects(syncJira(db, client, ["HOS"]), /HTTP 401/);
});

test("importIssues loads a JSON export", () => {
  const db = openDb(path.join(tempDir("ctx-jira"), "context.db"));
  const count = importIssues(db, { issues: [issue("HOS-30", "Lịch tiêm chủng")] }, "https://example.atlassian.net");
  assert.equal(count, 1);
  assert.deepEqual(search(db, "lich tiem").issues.map((issue) => issue.key), ["HOS-30"]);
});
