import type {
  Changes,
  DesignRef,
  FigmaLookup,
  FileHistory,
  FixCommit,
  IndexStats,
  IssueRow,
  PageContent,
  PageRef,
  SearchResult,
  TestScope,
  TicketContext,
  TicketRef
} from "./queries.ts";
import { truncate } from "./text.ts";

// Output is read by AI tools on a fixed usage allowance, so every section is
// capped: enough to orient, with keys to drill into, never a full dump.
const DESCRIPTION_CHARS = 1500;
const EXTRA_CHARS = 1200;
const PARENT_CHARS = 800;

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "?");

function label(ref: TicketRef): string {
  if (!ref.issue) return `${ref.key} _(chưa có trong Jira index)_`;
  const meta = [ref.issue.type, ref.issue.status].filter(Boolean).join(", ");
  return `${ref.key} — ${ref.issue.summary}${meta ? ` _(${meta})_` : ""}`;
}

/** Keep the newest commit per subject; repeated messages add no information. */
function uniqueSubjects<T extends { subject: string }>(commits: T[]): T[] {
  const seen = new Set<string>();
  return commits.filter((commit) => !seen.has(commit.subject) && Boolean(seen.add(commit.subject)));
}

/** The link ends in the page id, which is what confluence_page takes. */
function pageLine(page: PageRef): string {
  return `- [${page.title}](${page.url}) · cập nhật ${day(page.updated)}`;
}

/** "✅ HealthOS v.2 Official · node 554-21150" */
function designName(design: { fileName: string; nodeId: string }): string {
  return `${design.fileName || "Figma"} · ${design.nodeId ? `node ${design.nodeId}` : "cả file"}`;
}

function designLine(design: DesignRef): string {
  const source = design.kind === "parent" ? ` _(ticket cha ${design.from})_` : design.kind === "page" ? ` _(trong trang ${design.from})_` : "";
  return `- [${designName(design)}](${design.url})${source}`;
}

const DIFF_LINES = 5;

/** Lines an edit added and removed, a few of each, indented under their item. */
function diffLines(diff: { added: string[]; removed: string[] } | null): string[] {
  if (!diff) return [];
  const shown = [...diff.added.slice(0, DIFF_LINES).map((line) => `  + ${truncate(line, 160)}`), ...diff.removed.slice(0, DIFF_LINES).map((line) => `  − ${truncate(line, 160)}`)];
  const hidden = Math.max(0, diff.added.length - DIFF_LINES) + Math.max(0, diff.removed.length - DIFF_LINES);
  return hidden ? [...shown, `  … và ${hidden} dòng khác`] : shown;
}

function fixLines(fixes: FixCommit[]): string[] {
  return fixes.map((fix) => `- ${day(fix.date)} [${fix.keys.join(", ") || "không mã"}] ${truncate(fix.subject, 140)}`);
}

function issueBlock(issue: IssueRow): string[] {
  const lines = [
    `**Loại:** ${issue.type ?? "?"} · **Trạng thái:** ${issue.status ?? "?"} · **Ưu tiên:** ${issue.priority ?? "?"} · **Cập nhật:** ${day(issue.updated)}`
  ];
  if (issue.url) lines.push(`**Link:** ${issue.url}`);
  if (issue.description) lines.push("", "### Mô tả", truncate(issue.description, DESCRIPTION_CHARS));
  if (issue.extra_text) lines.push("", "### Trường bổ sung & bình luận", truncate(issue.extra_text, EXTRA_CHARS));
  return lines;
}

export function formatTicketContext(context: TicketContext): string {
  const { issue } = context;
  const lines = [`# ${context.key}${issue ? ` — ${issue.summary}` : ""}`];
  if (issue) {
    lines.push(...issueBlock(issue));
  } else {
    lines.push("_Ticket chưa có trong Jira index — chỉ có dữ liệu từ lịch sử git. Chạy `ctx sync jira` để có mô tả và AC._");
  }

  if (context.parent) {
    lines.push("", "### Ticket cha", `- ${label({ key: context.parent.key, issue: context.parent })}`);
    // Sub-tasks are usually written as one line; the requirement and its
    // acceptance criteria live on the parent story.
    if (context.parent.description) lines.push("", truncate(context.parent.description, PARENT_CHARS));
    if (context.parent.extra_text) lines.push("", truncate(context.parent.extra_text, PARENT_CHARS));
  }
  if (context.children.length) {
    lines.push("", `### Ticket con (${context.children.length})`, ...context.children.slice(0, 10).map((child) => `- ${label({ key: child.key, issue: child })}`));
  }
  if (context.links.length) {
    lines.push("", "### Liên kết", ...context.links.slice(0, 10).map((link) => `- ${link.linkType}: ${label(link)}`));
  }
  if (context.docs.length || context.similarDocs.length || context.listings.length) {
    lines.push(
      "",
      "### Tài liệu Confluence",
      ...context.docs.map(
        (doc) =>
          `${pageLine(doc)}${doc.via === context.key ? "" : ` _(nhắc ticket cha ${doc.via})_`}${doc.editedAfterCode ? ` · ⚠ sửa sau commit cuối (${day(context.commits.last)})` : ""}`
      ),
      ...context.similarDocs.map((doc) => `${pageLine(doc)} _(không nhắc mã ticket, nội dung gần giống)_`)
    );
    if (context.listings.length) {
      lines.push(`- Có tên trong: ${context.listings.map((page) => `[${page.title}](${page.url})`).join(", ")}`);
    }
  }
  if (context.designs.length) {
    lines.push("", "### Thiết kế Figma", ...context.designs.map(designLine));
  }

  const { commits } = context;
  lines.push("", "### Code đã làm cho ticket này");
  if (commits.count === 0) {
    lines.push("_Chưa có commit nào nhắc tới mã ticket này._");
  } else {
    lines.push(`${commits.count} commit · ${day(commits.first)} → ${day(commits.last)} · ${commits.authors.join(", ")}`);
    lines.push("", "**File thay đổi nhiều nhất:**");
    lines.push(...context.files.slice(0, 15).map((file) => `- \`${file.repo}:${file.path}\` — ${file.touches} lần (+${file.additions}/-${file.deletions})`));
    if (context.files.length > 15) lines.push(`- … và ${context.files.length - 15} file khác`);
    lines.push("", "**Commit gần nhất:**", ...uniqueSubjects(commits.recent).slice(0, 6).map((commit) => `- ${day(commit.date)} ${truncate(commit.subject, 140)}`));
  }

  if (context.relatedTickets.length) {
    lines.push(
      "",
      "### Ticket khác từng sửa cùng file (dễ ảnh hưởng lẫn nhau)",
      ...context.relatedTickets.map((related) => `- ${label(related)} — chung ${related.sharedFiles} file, lần cuối ${day(related.last)}`)
    );
  }
  if (context.priorFixes.length) {
    lines.push("", "### Lỗi từng được sửa ở cùng khu vực code", ...fixLines(context.priorFixes));
  }
  if (context.similar.length) {
    lines.push("", "### Ticket có nội dung tương tự", ...context.similar.map((ref) => `- ${label(ref)}`));
  }
  return lines.join("\n");
}

export function formatSearch(query: string, result: SearchResult): string {
  const lines = [`# Kết quả tìm: "${query}"`];
  if (result.issues.length) {
    lines.push("", "### Ticket trong Jira", ...result.issues.map((issue) => `- ${label({ key: issue.key, issue })}`));
  }
  if (result.ticketsFromCommits.length) {
    lines.push(
      "",
      "### Ticket có code khớp (theo nội dung commit)",
      ...result.ticketsFromCommits.map((hit) => `- ${label(hit)} — ${hit.matches} commit, vd: ${truncate(hit.subjects[0] ?? "", 120)}`)
    );
  }
  if (result.pages.length) {
    lines.push("", "### Tài liệu Confluence", ...result.pages.flatMap((page) => [pageLine(page), `  > ${page.excerpt}`]));
  }
  if (!result.issues.length && !result.ticketsFromCommits.length && !result.pages.length) lines.push("_Không tìm thấy kết quả._");
  return lines.join("\n");
}

export function formatFigmaLookup(lookup: FigmaLookup): string {
  const lines = [`# Figma: ${designName({ fileName: lookup.fileName, nodeId: lookup.link.nodeId })}`, lookup.link.url];
  if (!lookup.tickets.length && !lookup.pages.length) {
    lines.push("", "_Chưa có ticket hay tài liệu nào nhắc tới thiết kế này._");
  }
  if (lookup.tickets.length) {
    lines.push("", "### Ticket nhắc tới thiết kế này", ...lookup.tickets.slice(0, 10).map((ref) => `- ${label(ref)}`));
  }
  if (lookup.pages.length) {
    lines.push("", "### Tài liệu nhắc tới thiết kế này", ...lookup.pages.slice(0, 6).map(pageLine));
  }
  if (lookup.tickets.length) {
    lines.push("", "### Màn hình trong code");
    lines.push(
      ...(lookup.screens.length
        ? lookup.screens.map((screen) => `- \`${screen.repo}:${screen.path}\` — ${screen.keys.join(", ")}`)
        : ["_Các ticket trên chưa có commit nào sửa file màn hình._"])
    );
  }
  if (lookup.otherNodes.length) {
    lines.push(
      "",
      "### Node khác trong cùng file",
      ...lookup.otherNodes.map((node) => `- [node ${node.nodeId || "cả file"}](${node.url}) — ${[...node.keys, ...node.pages].join(", ")}`)
    );
  }
  return lines.join("\n");
}

export function formatChanges(result: Changes): string {
  const scope = result.key ? ` · phạm vi ${result.key}${result.scopeSize ? ` và ${result.scopeSize} ticket con` : ""}` : "";
  const lines = [`# Thay đổi từ ${result.since}${scope}`];
  if (!result.issues.length && !result.pages.length) {
    lines.push("", "_Không có ticket hay trang nào thay đổi._");
    return lines.join("\n");
  }

  if (result.drifting.length) {
    lines.push(
      "",
      "### ⚠ Spec sửa sau khi đã code (cần đối chiếu)",
      ...result.drifting.map(
        (page) =>
          `- [${page.title}](${page.url}) sửa ${day(page.updated)} — sau commit cuối của ${page.drift.map((entry) => `${entry.key} (${day(entry.lastCommit)})`).join(", ")}`
      )
    );
  }
  if (result.pages.length) {
    lines.push("", `### Trang Confluence đã sửa (${result.totalPages})`);
    for (const page of result.pages) {
      lines.push(`${pageLine(page)}${page.versionDate ? ` · so với bản ${day(page.versionDate)}` : ""}`, ...diffLines(page.diff));
    }
    if (result.totalPages > result.pages.length) lines.push(`- … và ${result.totalPages - result.pages.length} trang khác`);
  }
  if (result.issues.length) {
    lines.push("", `### Ticket đã cập nhật (${result.totalIssues})`);
    for (const entry of result.issues) {
      const status = entry.statusBefore ? ` · trạng thái ${entry.statusBefore} → ${entry.issue.status}` : "";
      lines.push(`- ${label({ key: entry.issue.key, issue: entry.issue })} · ${day(entry.issue.updated)}${entry.isNew ? " · mới" : ""}${status}`, ...diffLines(entry.diff));
    }
    if (result.totalIssues > result.issues.length) lines.push(`- … và ${result.totalIssues - result.issues.length} ticket khác`);
  }
  return lines.join("\n");
}

export function formatTestScope(scope: TestScope): string {
  const lines = [
    `# Phạm vi test: ${scope.repo} (${scope.base}...${scope.head})`,
    `${scope.changedFiles.length} file thay đổi (đã bỏ lockfile, file sinh tự động và ảnh).`
  ];
  if (scope.ownTickets.length) {
    lines.push("", "### Ticket của chính thay đổi này", ...scope.ownTickets.map((ref) => `- ${label(ref)}`));
  }
  lines.push("", "### Cần regression: ticket cũ có code nằm trong các file vừa sửa");
  if (scope.regressionTickets.length === 0) {
    lines.push("_Không có ticket cũ nào đụng các file này._");
  } else {
    for (const ticket of scope.regressionTickets) {
      const shown = ticket.files.slice(0, 3).map((file) => `\`${file}\``).join(", ");
      const more = ticket.files.length > 3 ? ` +${ticket.files.length - 3}` : "";
      lines.push(`- ${label(ticket)} — ${ticket.files.length} file chung (${shown}${more}), lần cuối ${day(ticket.last)}`);
    }
  }
  if (scope.untrackedFiles.length) {
    lines.push(
      "",
      "### File chưa có lịch sử ticket (code mới hoặc commit không gắn mã)",
      ...scope.untrackedFiles.slice(0, 10).map((file) => `- \`${file}\``)
    );
  }
  if (scope.priorFixes.length) {
    lines.push("", "### Lỗi từng được sửa trong các file này (nên test lại)", ...fixLines(scope.priorFixes));
  }
  return lines.join("\n");
}

export function formatFileHistory(history: FileHistory): string {
  const lines = [`# Lịch sử ticket: ${history.repo ? `${history.repo}:` : ""}${history.prefix}`];
  if (history.tickets.length === 0) {
    lines.push("_Không có commit gắn mã ticket nào cho đường dẫn này._");
  } else {
    lines.push(...history.tickets.map((ticket) => `- ${label(ticket)} — ${ticket.commits} commit, ${ticket.files} file, lần cuối ${day(ticket.last)}`));
  }
  if (history.priorFixes.length) lines.push("", "### Các lần sửa lỗi gần đây", ...fixLines(history.priorFixes));
  return lines.join("\n");
}

export function formatPage(ref: string, content: PageContent | null): string {
  if (!content) {
    return `_Không có trang "${ref}" trong index. Đưa id hoặc link trang; chạy \`ctx sync confluence\` nếu trang mới tạo._`;
  }
  const { page, part, parts } = content;
  const lines = [`# ${page.title}`, `**Space:** ${page.space} · **Cập nhật:** ${day(page.updated)} · **Link:** ${page.url}`];
  if (parts > 1) lines.push(`_Phần ${part}/${parts}${part < parts ? `, đọc tiếp phần ${part + 1}` : ""}._`);
  if (content.issues.length) {
    lines.push(
      "",
      `### Ticket được nhắc tới (${content.issues.length})`,
      ...content.issues.slice(0, 10).map((ref) => `- ${label(ref)}`),
      ...(content.issues.length > 10 ? [`- … và ${content.issues.length - 10} ticket khác`] : [])
    );
  }
  lines.push("", "---", "", content.text || "_Trang không có nội dung chữ (chỉ có sơ đồ hoặc ảnh)._");
  return lines.join("\n");
}

export function formatStats(stats: IndexStats): string {
  return [
    "# context-hub",
    `- Ticket Jira đã index: ${stats.issues}${stats.jiraSince ? ` (lần sync gần nhất tính từ ${stats.jiraSince})` : " (chưa sync Jira)"}`,
    `- Commit: ${stats.commits}, trong đó ${stats.linkedCommits} gắn mã ticket`,
    `- Ticket có code: ${stats.ticketsWithCode}`,
    `- Trang Confluence: ${stats.pages}${stats.confluenceSince ? `, trong đó ${stats.pagesWithTickets} nhắc mã ticket` : " (chưa sync Confluence)"}`,
    ...stats.repos.map((repo) => `- Repo ${repo.repo}: ${repo.commits} commit, mới nhất ${day(repo.last)}`)
  ].join("\n");
}
