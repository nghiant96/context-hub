# context-hub

Ngữ cảnh nghiệp vụ dùng chung cho BA, dev và QC. Công cụ đọc **Jira**, **Confluence** và **lịch sử git**, nối mỗi ticket với tài liệu nhắc tới nó và đoạn code đã hiện thực nó, lưu vào một file SQLite, rồi cho Claude truy vấn qua **MCP**.

Không thay đổi cách team đang làm việc: BA và QC vẫn viết trên Jira và Confluence, dev vẫn commit theo quy ước `HOS-xxxx type: mô tả`. Không có tài liệu nào phải chép tay sang git, không có bộ đếm ID dùng chung, nên không có xung đột khi nhiều người làm song song.

## Dùng để làm gì

| Ai | Hỏi Claude | Tool được gọi |
|---|---|---|
| Dev | "Bắt đầu HOS-1313, cho mình ngữ cảnh" | `ticket_context`: mô tả, AC, tài liệu Confluence liên quan (đánh dấu trang sửa sau commit cuối), thiết kế Figma, file từng sửa, ticket dễ ảnh hưởng lẫn nhau, lỗi từng sửa ở cùng khu vực |
| QC | "Nhánh qc/HOS-1310-… cần regression những gì?" | `test_scope`: ticket cũ có code nằm trong các file vừa sửa, lỗi cũ ở các file đó |
| BA | "Đã có story nào về quên mã PIN chưa?" | `search`: tìm ticket, commit và tài liệu theo nghiệp vụ, có dấu hay không dấu |
| Cả team | "Màn Figma này đã làm ở đâu?" (dán link) | `search` với link Figma: ticket, tài liệu nhắc tới frame đó, và file màn hình trong code |
| PO, dev, QC | "Tuần này spec onboarding đổi gì? Có chỗ nào code chưa theo kịp?" | `changes`: ticket và trang đã sửa từ một ngày, dòng thêm/bớt, trang spec sửa sau khi đã code |
| Cả team | "Spec API quên mã PIN nói gì?" | `confluence_page`: đọc một trang Confluence theo từng phần |
| Cả team | "Vì sao thư mục `features/security` như hiện tại?" | `file_history` |

Mỗi phần trong câu trả lời đều có giới hạn độ dài, trang Confluence dài được đọc từng phần khoảng 3.5KB, nên tốn ít hạn mức gói Claude.

## Cài đặt

> Không quen dùng terminal? Làm theo **[hướng dẫn cài đặt từng bước cho Mac và Windows](docs/cai-dat.md)**, có cả phần cài Git, Node.js và gắn vào Claude.

Cần Node.js 24 trở lên (chạy thẳng TypeScript, SQLite có sẵn trong Node).

```bash
cd context-hub
npm install
npm run ctx -- sync git          # index lịch sử git, vài giây
npm run ctx -- ticket HOS-1313   # thử ngay trên terminal
```

Repo được index khai báo trong `context-hub.config.json` (đường dẫn tương đối tính từ thư mục này). Index nằm ở `data/context.db` và **không bao giờ được commit**.

## Kết nối Jira và Confluence

1. Tạo API token tại https://id.atlassian.com/manage-profile/security/api-tokens. Một token dùng được cho cả Jira lẫn Confluence.
2. `cp .env.example .env`, điền `JIRA_EMAIL` và `JIRA_API_TOKEN`. File `.env` không được commit.
3. `npm run ctx -- sync jira`. Lần đầu kéo toàn bộ project; các lần sau chỉ kéo ticket mới cập nhật. Thêm `--full` để kéo lại tất cả.
4. Khai báo space trong `context-hub.config.json` (`"confluence": { "spaces": ["Healthcare"] }`, key lấy từ link `/wiki/spaces/<KEY>/…`), rồi `npm run ctx -- sync confluence`. Space thêm sau vẫn được kéo đầy đủ ở lần sync kế tiếp.

Token đại diện cho bạn: index chỉ chứa những ticket và trang bạn được xem.

Số điện thoại, email, số CCCD/CMND trong mô tả, bình luận và trang Confluence được **che trước khi lưu**, vì đây là dữ liệu y tế và nội dung sẽ được gửi cho AI.

## Extension cho Claude Desktop

Người không dùng terminal có thể cài một file `.mcpb` tải ở [Releases](https://github.com/nghiant96/context-hub/releases/latest), xem [hướng dẫn](docs/cai-dat.md#cách-1-cài-extension-cho-claude-desktop). Cùng file đó chạy được trong Claude Code mà không cần clone repo ([cách 2](docs/cai-dat.md#cách-2-claude-code-không-cần-repo)): script trong `installers/` (đăng kèm mỗi release) giải nén nó rồi chạy `node server/index.mjs --install` (`src/install.ts`), trình cài hỏi email và token, thử đăng nhập rồi gọi `claude mcp add`. Đặt `CTX_INSTALL_DRY_RUN=1` để chỉ in lệnh mà không đổi cấu hình Claude Code. Extension chạy bằng Node có sẵn trong Claude Desktop, nhận email và token Atlassian qua form cài đặt, lưu index ở `~/.context-hub/` và tự đồng bộ vài giờ một lần.

Build file cài:

```bash
npm run build:extension   # → dist/context-hub-<version>.mcpb
```

Lệnh này gom `src/extension-main.ts` cùng các thư viện thành một file `server/index.mjs` (không kèm `node_modules`), ghi `extension/manifest.json` với version lấy từ `package.json`, kiểm tra manifest rồi đóng gói. Muốn phát hành bản mới thì tăng `version` trong `package.json` trước khi build.

## Gắn vào Claude Code

Có hai cách, chọn một:

**Dùng chung index với extension Claude Desktop** (đã cài extension). Claude Code chạy server của extension mà không cần email hay token, nên chỉ đọc `~/.context-hub/`, còn extension trong Claude Desktop lo đồng bộ. Truyền thêm thư mục repo để `test_scope` đọc được nhánh:

```bash
claude mcp add context-hub -s user -- node "$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.nghiant96.context-hub/server/index.mjs" "$HOME/Documents/OM/healthos-meta/mobile/healthos" "$HOME/Documents/OM/healthos-meta/mobile/healthos-app-master"
```

Trên Windows, server nằm ở `%APPDATA%\Claude\Claude Extensions\local.mcpb.nghiant96.context-hub\server\index.mjs`. Máy cần Node 22.13 trở lên. Tên repo là tên thư mục, nên phải trùng với thư mục đã chọn trong extension. Nếu extension lâu không đồng bộ (Claude Desktop không mở), câu trả lời sẽ ghi chú ngày cập nhật cuối.

**Chạy từ repo này** (index riêng ở `data/`, tự chạy `ctx sync`):

```bash
claude mcp add context-hub -s user -- node /đường/dẫn/tới/context-hub/src/mcp.ts
```

Sau đó trong Claude Code ở bất kỳ repo nào: "dùng context-hub lấy ngữ cảnh HOS-1313 rồi …". Server mở index ở chế độ chỉ đọc, nên có thể chạy `sync` bất cứ lúc nào.

## Lệnh

```text
ctx sync [git|jira|confluence] [--full]
                                  Index git, Jira, Confluence (mặc định tất cả)
ctx import-jira <file.json>       Nạp ticket từ file export JSON
ctx ticket <KEY>                  Ngữ cảnh một ticket
ctx search <từ khoá…|link Figma>  Tìm ticket và tài liệu theo nghiệp vụ, hoặc theo thiết kế Figma
ctx changes [--since YYYY-MM-DD] [--key HOS-330]
                                  Ticket và trang đã sửa (mặc định 7 ngày qua)
ctx page <id|link> [--part n]     Đọc một trang Confluence
ctx scope --repo <tên> [--base origin/develop] [--head HEAD]
ctx file <đường dẫn> [--repo <tên>]
ctx stats
ctx mcp                           MCP server (stdio)
```

Chạy bằng `npm run ctx -- <lệnh>`, hoặc `node src/cli.ts <lệnh>`.

## Cách hoạt động

- **Git:** đọc mọi nhánh, gắn commit với ticket qua mã `HOS-xxxx` trong message. Commit không ghi mã thì nhận mã từ tên nhánh đã đưa nó vào, đọc ở merge commit gần nhất (`Merge branch 'feature/HOS-1313-…'`, kể cả nhánh gộp `qc/HOS-1310-1456-1471-1313`); nhánh chưa merge thì chưa dùng được tên nhánh. Commit bị rebase/cherry-pick sang nhánh khác được nhận ra và chỉ tính một lần.
- **Lỗi từng sửa:** commit có loại `fix`/`fixbug`/`hotfix`/`sửa …` ngay sau mã ticket, hoặc `feat(HOS-xxx): fix …`. Commit loại khác chỉ nhắc tới chữ fix (`refactor: … to fix …`, `test: fix flaky`) không tính.
- **Jira:** API `/rest/api/3/search/jql`, lấy mô tả, các trường văn bản tuỳ biến (AC…), bình luận, ticket cha, liên kết.
- **Confluence:** API v2, chỉ trang đang dùng (bỏ trang đã lưu trữ). Trang được nối với ticket qua mã `HOS-xxxx` hoặc link `/browse/HOS-xxxx` trong trang. Trang nhắc trên 10 ticket (báo cáo sprint, checklist golive) được xếp riêng thành "Có tên trong". Các lần sync sau chỉ kéo trang mới sửa, và bỏ trang đã bị xoá, lưu trữ hoặc chuyển khỏi space.
- **Thay đổi:** mỗi lần sync, nếu mô tả/AC/bình luận/trạng thái của ticket hay nội dung trang khác bản đang có, bản cũ được giữ lại (một bản trước cho mỗi ticket/trang), nên `changes` cho thấy dòng thêm/bớt mà không cần gọi lại Atlassian. Dòng thêm/bớt chỉ có từ lần sync sau khi cập nhật lên phiên bản này. Trang được coi là "sửa sau khi đã code" khi nó nhắc một ticket và được sửa sau commit cuối của ticket đó.
- **Figma:** link Figma trong ticket (kể cả link gắn sau chữ) và trong trang Confluence được ghi lại theo file và node, bỏ tham số chia sẻ `t=`. Màn hình trong code là các file thuộc thư mục `screens/` hoặc tên `*Screen.tsx` mà commit của các ticket đó đã sửa. Index cũ được điền link từ văn bản sẵn có ở lần mở đầu tiên; link gắn sau chữ có ở lần sync kế tiếp của ticket/trang đó (`sync --full` để có ngay).
- **Tìm kiếm:** SQLite FTS5 trên văn bản đã bỏ dấu, nên "quen ma pin" khớp "Quên mã PIN".
- Lockfile, ảnh, thư mục build và các mẫu trong `ignorePaths` bị loại khỏi xếp hạng.

## Phát triển

```bash
npm test          # node:test, không cần mạng hay Jira thật
npm run typecheck
```
