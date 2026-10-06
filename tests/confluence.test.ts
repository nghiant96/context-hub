import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDb } from "../src/db.ts";
import { formatPage, formatSearch, formatTicketContext } from "../src/format.ts";
import { pageContent, pageIdOf, search, ticketContext } from "../src/queries.ts";
import { adfToText } from "../src/sources/atlassian.ts";
import { ConfluenceClient, syncConfluence } from "../src/sources/confluence.ts";
import { splitText } from "../src/text.ts";
import { fakeAtlassian, tempDir } from "./helpers.ts";

const SITE = "https://example.atlassian.net";
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const ticketLink = (key: string) => ({ type: "paragraph", content: [{ type: "inlineCard", attrs: { url: `${SITE}/browse/${key}` } }] });

function page(id: string, title: string, updated: string, body: unknown) {
  return {
    id,
    title,
    parentId: null,
    version: { createdAt: updated },
    body: { atlas_doc_format: { value: JSON.stringify(body) } },
    _links: { webui: `/spaces/Healthcare/pages/${id}/${encodeURIComponent(title)}` }
  };
}

const spaceLookup = { body: { results: [{ id: "77", key: "Healthcare" }] } };
const ids = (...pageIds: string[]) => ({ body: { results: pageIds.map((id) => ({ id })) } });
const client = (fetchImpl: typeof fetch) => new ConfluenceClient({ baseUrl: SITE, email: "a", apiToken: "b" }, fetchImpl);
const pinSpec = page(
  "1",
  "Đặc tả: quên mã PIN",
  "2026-10-06T04:00:00.000Z",
  doc(
    paragraph("Người dùng quên mã PIN thì xác thực lại bằng OTP. Hotline thử nghiệm 0912345678."),
    ticketLink("HOS-1313"),
    { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [{ type: "text", text: "Chốt luồng" }] }] }
  )
);
const checklist = page(
  "2",
  "Checklist golive",
  "2026-10-01T04:00:00.000Z",
  doc(
    paragraph("Các ticket lên bản: HOS-1313, HOS-1400."),
    ...Array.from({ length: 120 }, (_, row) => paragraph(`Bước ${row + 1}: kiểm tra cấu hình môi trường production và log.`))
  )
);

test("adfToText renders the nodes Confluence pages use", () => {
  const text = adfToText(
    doc(
      { type: "expand", attrs: { title: "Chi tiết" }, content: [paragraph("Ẩn bên trong")] },
      { type: "taskList", content: [{ type: "taskItem", attrs: { state: "TODO" }, content: [{ type: "text", text: "Viết test" }] }] },
      { type: "decisionList", content: [{ type: "decisionItem", content: [{ type: "text", text: "Dùng OTP" }] }] },
      { type: "paragraph", content: [{ type: "text", text: "Hạn: " }, { type: "date", attrs: { timestamp: "1791244800000" } }] },
      { type: "paragraph", content: [{ type: "placeholder", attrs: { text: "Type your notes here" } }] },
      { type: "extension", attrs: { extensionKey: "drawio" } }
    )
  );
  assert.equal(text, "Chi tiết\nẨn bên trong\n- [ ] Viết test\n- Dùng OTP\nHạn: 2026-10-06");
});

test("syncConfluence indexes pages, links the tickets they name, and redacts", async () => {
  const db = openDb(path.join(tempDir("ctx-confluence"), "context.db"));
  const { calls, fetchImpl } = fakeAtlassian([
    spaceLookup,
    ids("1", "2"),
    { body: { results: [pinSpec], _links: { next: "/wiki/api/v2/pages?cursor=abc" } } },
    { body: { results: [checklist] } }
  ]);

  const results = await syncConfluence(db, client(fetchImpl), ["Healthcare"], ["HOS"], { now: new Date("2026-10-06T08:00:00Z") });
  assert.deepEqual(results, [{ space: "Healthcare", pages: 2, removed: 0, mode: "full" }]);
  assert.equal(calls[0]!.url, `${SITE}/wiki/api/v2/spaces?keys=Healthcare&limit=250`);
  assert.match(calls[2]!.url, /space-id=77&status=current&sort=-modified-date&body-format=atlas_doc_format/);
  // `_links.next` is relative to the site root.
  assert.equal(calls[3]!.url, `${SITE}/wiki/api/v2/pages?cursor=abc`);

  const row = db.prepare("SELECT * FROM pages WHERE id = 1").get() as Record<string, string>;
  assert.match(row.body!, /Hotline thử nghiệm \[phone\]/);
  assert.ok(!row.body!.includes("0912345678"));
  assert.match(row.body!, /- \[x\] Chốt luồng/);
  assert.equal(row.url, `${SITE}/wiki/spaces/Healthcare/pages/1`);
  const links = db.prepare("SELECT page_id, issue_key FROM page_issues ORDER BY page_id, issue_key").all().map((link) => ({ ...link }));
  assert.deepEqual(links, [
    { page_id: 1, issue_key: "HOS-1313" },
    { page_id: 2, issue_key: "HOS-1313" },
    { page_id: 2, issue_key: "HOS-1400" }
  ]);

  // The page about one ticket ranks above the checklist that lists several.
  const context = ticketContext(db, { ignorePaths: [] }, "HOS-1313");
  assert.deepEqual(context.docs.map((doc) => doc.id), [1, 2]);
  assert.match(formatTicketContext(context), /### Tài liệu Confluence\n- \[Đặc tả: quên mã PIN\]\(https:\/\/example\.atlassian\.net\/wiki\/spaces\/Healthcare\/pages\/1\) · cập nhật 2026-10-06/);

  const found = search(db, "quen ma pin");
  assert.deepEqual(found.pages.map((hit) => hit.id), [1]);
  assert.match(found.pages[0]!.excerpt, /quên mã PIN thì xác thực lại/);
  assert.match(formatSearch("quen ma pin", found), /> Người dùng quên mã PIN/);
});

test("a sprint report naming many tickets is listed apart, and only for tickets it names", async () => {
  const db = openDb(path.join(tempDir("ctx-confluence"), "context.db"));
  const keys = Array.from({ length: 12 }, (_, index) => `HOS-${2000 + index}`);
  const report = page("9", "Sprint 2", "2026-10-05T00:00:00.000Z", doc(...keys.map(ticketLink)));
  const { fetchImpl } = fakeAtlassian([spaceLookup, ids("1", "9"), { body: { results: [pinSpec, report] } }]);
  await syncConfluence(db, client(fetchImpl), ["Healthcare"], ["HOS"]);
  db.prepare("INSERT INTO issues(key, project, summary, parent_key) VALUES ('HOS-3000', 'HOS', 'Màn khác', 'HOS-2000')").run();

  const named = ticketContext(db, { ignorePaths: [] }, "HOS-2000");
  assert.deepEqual(named.docs, []);
  assert.deepEqual(named.listings.map((doc) => doc.id), [9]);
  assert.match(formatTicketContext(named), /- Có tên trong: \[Sprint 2\]/);
  // Through a parent, a listing says nothing about the child ticket.
  assert.deepEqual(ticketContext(db, { ignorePaths: [] }, "HOS-3000").listings, []);
});

test("a long page is read a part at a time, by id or by link", async () => {
  const db = openDb(path.join(tempDir("ctx-confluence"), "context.db"));
  const { fetchImpl } = fakeAtlassian([spaceLookup, ids("2"), { body: { results: [checklist] } }]);
  await syncConfluence(db, client(fetchImpl), ["Healthcare"], ["HOS"]);

  assert.equal(pageIdOf(`${SITE}/wiki/spaces/Healthcare/pages/2/Checklist+golive`), 2);
  assert.equal(pageIdOf(`${SITE}/wiki/pages/viewpage.action?pageId=2`), 2);
  assert.equal(pageIdOf("Checklist golive"), null);

  const first = pageContent(db, `${SITE}/wiki/spaces/Healthcare/pages/2/Checklist+golive`)!;
  assert.equal(first.part, 1);
  assert.ok(first.parts > 1);
  assert.ok(first.text.length <= 3500);
  assert.deepEqual(first.issues.map((ref) => ref.key), ["HOS-1313", "HOS-1400"]);
  assert.match(formatPage("2", first), /Phần 1\/\d+, đọc tiếp phần 2/);

  const last = pageContent(db, "2", 99)!;
  assert.equal(last.part, last.parts);
  assert.deepEqual(last.issues, []);
  assert.match(last.text, /Bước 120:/);
  assert.match(formatPage("404", pageContent(db, "404")), /Không có trang "404"/);
});

test("a later sync reads only recent edits and drops pages that left the space", async () => {
  const db = openDb(path.join(tempDir("ctx-confluence"), "context.db"));
  const first = fakeAtlassian([spaceLookup, ids("1", "2"), { body: { results: [pinSpec, checklist] } }]);
  await syncConfluence(db, client(first.fetchImpl), ["Healthcare"], ["HOS"], { now: new Date("2026-10-06T08:00:00Z") });

  const edited = { ...pinSpec, title: "Đặc tả: quên mã PIN (v2)", version: { createdAt: "2026-10-07T01:00:00.000Z" } };
  const old = page("3", "Trang cũ", "2026-09-01T00:00:00.000Z", doc(paragraph("cũ")));
  // The checklist was deleted. Paging stops at the first page older than the
  // last sync, so the next link is never requested.
  const second = fakeAtlassian([spaceLookup, ids("1"), { body: { results: [edited, old], _links: { next: "/wiki/api/v2/pages?cursor=more" } } }]);
  const results = await syncConfluence(db, client(second.fetchImpl), ["Healthcare"], ["HOS"]);
  assert.deepEqual(results, [{ space: "Healthcare", pages: 1, removed: 1, mode: "incremental" }]);

  const titles = db.prepare("SELECT title FROM pages ORDER BY id").all().map((row) => row.title);
  assert.deepEqual(titles, ["Đặc tả: quên mã PIN (v2)"]);
  assert.deepEqual(search(db, "checklist golive").pages, []);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM page_issues WHERE page_id = 2").get() as { n: number }).n, 0);
});

test("a space the token cannot see fails the sync by name", async () => {
  const db = openDb(path.join(tempDir("ctx-confluence"), "context.db"));
  const { fetchImpl } = fakeAtlassian([spaceLookup]);
  await assert.rejects(syncConfluence(db, client(fetchImpl), ["Healthcare", "Nope"], ["HOS"]), /Không thấy Confluence space Nope/);
});

test("splitText cuts at line breaks and never loses text", () => {
  const text = Array.from({ length: 50 }, (_, index) => `dòng ${index}`).join("\n");
  const parts = splitText(text, 60);
  assert.ok(parts.every((part) => part.length <= 60));
  assert.ok(parts.every((part) => /^dòng \d+/.test(part)));
  assert.equal(parts.join("\n"), text);
  assert.deepEqual(splitText("", 60), [""]);
});
