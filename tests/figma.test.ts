import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { openDb } from "../src/db.ts";
import { parseFigmaLinks } from "../src/figma.ts";
import { formatFigmaLookup, formatTicketContext } from "../src/format.ts";
import { figmaLookup, ticketContext } from "../src/queries.ts";
import { toPageRecord, upsertPage } from "../src/sources/confluence.ts";
import { toIssueRecord, upsertIssue } from "../src/sources/jira.ts";
import { tempDir } from "./helpers.ts";

const SITE = "https://example.atlassian.net";
const OFFICIAL = "https://www.figma.com/design/JxdA38iI5USpOrIIdnPbAY/%E2%9C%85-HealthOS-v.2--Official-";
const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
const linked = (text: string, href: string) => ({ type: "paragraph", content: [{ type: "text", text, marks: [{ type: "link", attrs: { href } }] }] });
const card = (url: string) => ({ type: "paragraph", content: [{ type: "inlineCard", attrs: { url } }] });

function issue(key: string, summary: string, fields: Record<string, unknown> = {}) {
  return { key, fields: { project: { key: "HOS" }, summary, issuetype: { name: "Story" }, status: { name: "Done" }, updated: "2026-07-01T10:00:00.000+0700", ...fields } };
}

function page(id: string, title: string, body: unknown) {
  return { id, title, version: { createdAt: "2026-07-02T00:00:00.000Z" }, body: { atlas_doc_format: { value: JSON.stringify(body) } }, _links: { webui: `/spaces/Healthcare/pages/${id}/x` } };
}

function addCommit(db: ReturnType<typeof openDb>, sha: string, key: string, date: string, files: string[]): void {
  db.prepare("INSERT INTO commits(repo, sha, author, date, subject, is_merge) VALUES ('app', ?, 'Dev', ?, ?, 0)").run(sha, date, `${key} feat: màn hình`);
  db.prepare("INSERT INTO commit_issues(repo, sha, issue_key) VALUES ('app', ?, ?)").run(sha, key);
  for (const file of files) db.prepare("INSERT INTO commit_files(repo, sha, path, additions, deletions) VALUES ('app', ?, ?, 10, 0)").run(sha, file);
}

test("parseFigmaLinks reads every link shape the team pastes and drops tracking parameters", () => {
  const links = parseFigmaLinks(
    [
      `${OFFICIAL}?node-id=554-21150&t=LbiU858pPiBgq9U2-4`,
      // Older links: /file/, the node id escaped as 718%3A2136, and text glued on.
      "Xem https://www.figma.com/file/AOf7tuHyaqwHTmfvBvq4kc/ISC_Admin_Vendor?node-id=718%3A2136Cải thiện",
      "| [Figma](https://figma.com/proto/K8N5o6o7Pz1VNXGYyfDMrj/HealthOS?node-id=1:2) |",
      "https://www.figma.com/design/K8N5o6o7Pz1VNXGYyfDMrj/HealthOS-v.2--Unofficial-?m=auto&t=abc",
      // The same frame again, its slug unescaped, and links that are not Figma files.
      "https://www.figma.com/design/JxdA38iI5USpOrIIdnPbAY/✅-HealthOS-v.2--Official-?node-id=554-21150",
      "https://www.figma.com/design/short/x https://example.com/design/JxdA38iI5USpOrIIdnPbAY"
    ].join("\n")
  );
  assert.deepEqual(links, [
    { fileKey: "JxdA38iI5USpOrIIdnPbAY", nodeId: "554-21150", fileName: "✅ HealthOS v.2 Official", url: `${OFFICIAL}?node-id=554-21150` },
    {
      fileKey: "AOf7tuHyaqwHTmfvBvq4kc",
      nodeId: "718-2136",
      fileName: "ISC_Admin_Vendor",
      url: "https://www.figma.com/design/AOf7tuHyaqwHTmfvBvq4kc/ISC_Admin_Vendor?node-id=718-2136"
    },
    { fileKey: "K8N5o6o7Pz1VNXGYyfDMrj", nodeId: "1-2", fileName: "HealthOS", url: "https://www.figma.com/proto/K8N5o6o7Pz1VNXGYyfDMrj/HealthOS?node-id=1-2" },
    {
      fileKey: "K8N5o6o7Pz1VNXGYyfDMrj",
      nodeId: "",
      fileName: "HealthOS v.2 Unofficial",
      url: "https://www.figma.com/design/K8N5o6o7Pz1VNXGYyfDMrj/HealthOS-v.2--Unofficial-"
    }
  ]);
});

test("Figma links in tickets and pages, even behind link text, show up in ticket context", () => {
  const db = openDb(path.join(tempDir("ctx-figma"), "context.db"));
  upsertIssue(db, toIssueRecord(issue("HOS-330", "Health Profile Activation", { description: doc(card(`${OFFICIAL}?node-id=1-1`)) }), new Map(), SITE));
  upsertIssue(
    db,
    toIssueRecord(issue("HOS-516", "Màn hình câu hỏi bắt buộc", { parent: { key: "HOS-330" }, description: doc(linked("Thiết kế", `${OFFICIAL}?node-id=554-21150&t=x`)) }), new Map(), SITE)
  );
  upsertPage(db, toPageRecord(page("7", "Onboarding flow", doc(paragraph("Câu hỏi bắt buộc HOS-516"), card(`${OFFICIAL}?node-id=554-30000`))), "Healthcare", SITE, ["HOS"]));

  const context = ticketContext(db, { ignorePaths: [] }, "HOS-516");
  assert.deepEqual(
    context.designs.map((design) => [design.nodeId, design.from]),
    [
      ["554-21150", "HOS-516"],
      ["1-1", "HOS-330"],
      ["554-30000", "Onboarding flow"]
    ]
  );
  const markdown = formatTicketContext(context);
  assert.match(markdown, /### Thiết kế Figma\n- \[✅ HealthOS v\.2 Official · node 554-21150\]\(https:\/\/www\.figma\.com\/design\/JxdA38iI5USpOrIIdnPbAY\/[^)]+\?node-id=554-21150\)/);
  assert.match(markdown, /node 1-1\]\([^)]+\) _\(ticket cha HOS-330\)_/);
  assert.match(markdown, /_\(trong trang Onboarding flow\)_/);
  assert.doesNotMatch(markdown, /t=x/);
});

test("a Figma link finds the tickets, pages and code screens built from that design", () => {
  const db = openDb(path.join(tempDir("ctx-figma"), "context.db"));
  upsertIssue(db, toIssueRecord(issue("HOS-516", "Màn hình câu hỏi bắt buộc", { description: doc(card(`${OFFICIAL}?node-id=554-21150`)) }), new Map(), SITE));
  upsertIssue(db, toIssueRecord(issue("HOS-375", "Màn hình câu hỏi khảo sát", { description: doc(card(`${OFFICIAL}?node-id=600-1`)) }), new Map(), SITE));
  upsertPage(db, toPageRecord(page("7", "Onboarding flow", doc(paragraph("Xem HOS-516"), card(`${OFFICIAL}?node-id=554-21150`))), "Healthcare", SITE, ["HOS"]));
  addCommit(db, "a1", "HOS-516", "2026-07-10T10:00:00+07:00", [
    "src/features/onboarding/screens/RequiredQuestionsScreen.tsx",
    "src/features/onboarding/hooks/useRequiredQuestionsScreen.ts",
    "src/features/onboarding/screens/__tests__/RequiredQuestionsScreen.test.tsx",
    "src/features/onboarding/api/onboarding.ts"
  ]);
  addCommit(db, "a2", "HOS-375", "2026-07-11T10:00:00+07:00", ["src/features/onboarding/screens/SurveyScreen.tsx"]);

  const exact = figmaLookup(db, { ignorePaths: [] }, parseFigmaLinks(`${OFFICIAL}?node-id=554-21150&t=zzz`)[0]!);
  assert.deepEqual(exact.tickets.map((ticket) => ticket.key), ["HOS-516"]);
  assert.deepEqual(exact.pages.map((found) => found.id), [7]);
  assert.deepEqual(exact.screens.map((screen) => [screen.path, screen.keys]), [["src/features/onboarding/screens/RequiredQuestionsScreen.tsx", ["HOS-516"]]]);
  assert.deepEqual(exact.otherNodes.map((node) => [node.nodeId, node.keys]), [["600-1", ["HOS-375"]]]);

  const markdown = formatFigmaLookup(exact);
  assert.match(markdown, /# Figma: ✅ HealthOS v\.2 Official · node 554-21150/);
  assert.match(markdown, /### Màn hình trong code\n- `app:src\/features\/onboarding\/screens\/RequiredQuestionsScreen\.tsx` — HOS-516/);
  assert.doesNotMatch(markdown, /api\/onboarding\.ts|useRequiredQuestionsScreen|\.test\.tsx/);

  // The whole file: every node's tickets and screens.
  const whole = figmaLookup(db, { ignorePaths: [] }, parseFigmaLinks(OFFICIAL)[0]!);
  assert.deepEqual(whole.tickets.map((ticket) => ticket.key).sort(), ["HOS-375", "HOS-516"]);
  assert.equal(whole.screens.length, 2);

  const unknown = figmaLookup(db, { ignorePaths: [] }, parseFigmaLinks("https://www.figma.com/design/ZZZZZZZZZZZZZZZZZZZZZZ/Khac")[0]!);
  assert.match(formatFigmaLookup(unknown), /Chưa có ticket hay tài liệu nào nhắc tới thiết kế này/);
});

test("an index built before Figma support gets links from the text it already holds", () => {
  const dbPath = path.join(tempDir("ctx-figma"), "context.db");
  const old = openDb(dbPath);
  old.prepare("INSERT INTO issues(key, project, summary, description) VALUES ('HOS-1', 'HOS', 'Cũ', ?)").run(`Figma: ${OFFICIAL}?node-id=9-9`);
  old.exec("DROP TABLE figma_links");
  old.close();

  const reopened = openDb(dbPath);
  const rows = reopened.prepare("SELECT source, source_id, node_id FROM figma_links").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ source: "issue", source_id: "HOS-1", node_id: "9-9" }]);
});
