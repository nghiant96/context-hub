# context-hub

Ngữ cảnh nghiệp vụ dùng chung cho BA, dev và QC. Công cụ đọc **Jira**, **Confluence** và **lịch sử git**, nối mỗi ticket với tài liệu nhắc tới nó và đoạn code đã hiện thực nó, lưu vào một file SQLite, rồi cho Claude truy vấn qua **MCP**.

Không thay đổi cách team đang làm việc: BA và QC vẫn viết trên Jira và Confluence, dev vẫn commit theo quy ước `HOS-xxxx type: mô tả`. Không có tài liệu nào phải chép tay sang git, không có bộ đếm ID dùng chung, nên không có xung đột khi nhiều người làm song song.

## Dùng để làm gì

| Ai | Hỏi Claude | Tool được gọi |
|---|---|---|
| Dev | "Bắt đầu HOS-1313, cho mình ngữ cảnh" | `ticket_context`: mô tả, AC, tài liệu Confluence liên quan, file từng sửa, ticket dễ ảnh hưởng lẫn nhau, lỗi từng sửa ở cùng khu vực |
| QC | "Nhánh qc/HOS-1310-… cần regression những gì?" | `test_scope`: ticket cũ có code nằm trong các file vừa sửa, lỗi cũ ở các file đó |
| BA | "Đã có story nào về quên mã PIN chưa?" | `search`: tìm ticket, commit và tài liệu theo nghiệp vụ, có dấu hay không dấu |
| Cả team | "Spec API quên mã PIN nói gì?" | `confluence_page`: đọc một trang Confluence theo từng phần |
| Cả team | "Vì sao thư mục `features/security` như hiện tại?" | `file_history` |

Mỗi phần trong câu trả lời đều có giới hạn độ dài, trang Confluence dài được đọc từng phần khoảng 3.5KB, nên tốn ít hạn mức gói Claude.

## Cài đặt

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

## Gắn vào Claude Code

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
ctx search <từ khoá…>             Tìm ticket và tài liệu theo nghiệp vụ
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
- **Tìm kiếm:** SQLite FTS5 trên văn bản đã bỏ dấu, nên "quen ma pin" khớp "Quên mã PIN".
- Lockfile, ảnh, thư mục build và các mẫu trong `ignorePaths` bị loại khỏi xếp hạng.

## Phát triển

```bash
npm test          # node:test, không cần mạng hay Jira thật
npm run typecheck
```
