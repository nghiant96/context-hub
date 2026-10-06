# Hướng dẫn cài đặt context-hub từng bước

Dành cho người không quen kỹ thuật (BA, QC, PO…), trên **Mac** hoặc **Windows**. Cài xong, bạn hỏi Claude kiểu "spec quên mã PIN nói gì?", "HOS-1313 cần làm gì?" và Claude tự tra Jira, Confluence cho bạn.

Có ba cách, chọn theo công cụ bạn dùng:

| | 1. Extension Claude Desktop | 2. Claude Code, không cần repo | 3. Cài đầy đủ từ repo |
|---|---|---|---|
| Dùng trong | Khung chat Claude Desktop (Claude Code dùng chung được) | Claude Code (terminal) | Claude Code và khung chat |
| Cần cài thêm | Không | Node.js | Git, Node.js, GitHub CLI |
| Thời gian | Khoảng 5 phút | Khoảng 10 phút | 30–45 phút |
| Cập nhật dữ liệu | Tự động, vài giờ một lần | Tự động khi Claude Code đang chạy | Tự chạy lệnh `sync` |

- BA, PO, QC dùng Claude Desktop: **cách 1**.
- Dùng Claude Code trên Mac hoặc Windows, không sửa code context-hub: **cách 2**.
- Sửa code context-hub: **cách 3**, từ mục [Trước khi bắt đầu](#trước-khi-bắt-đầu).

Cách 1 và cách 2 dùng file `context-hub-<phiên bản>.mcpb`, tải ở trang **Releases** của repo: https://github.com/nghiant96/context-hub/releases/latest (cần tài khoản GitHub đã được mời vào repo). Chưa có quyền thì xin file từ người quản lý repo.

## Cách 1: cài extension cho Claude Desktop

1. **Tải file `context-hub-<phiên bản>.mcpb`** ở trang Releases (link ở trên).
2. **Tạo API token Atlassian** theo [Bước 5](#bước-5-tạo-api-token-atlassian) bên dưới, rồi copy token ra.
3. **Cài extension:** bấm đúp vào file `.mcpb`. Claude Desktop sẽ mở ra và hỏi có cài không, bấm **Install**. Nếu bấm đúp không có gì xảy ra: mở Claude Desktop, vào **Settings → Extensions**, rồi kéo thả file `.mcpb` vào cửa sổ đó.
4. **Điền form cấu hình:**
   - **Email Atlassian:** email bạn dùng đăng nhập Jira.
   - **API token Atlassian:** dán token ở bước 2. Claude Desktop lưu token trong kho mật khẩu của máy.
   - Các ô còn lại **để nguyên**.
   - Dev và QC muốn dùng `test_scope` và lịch sử code thì chọn thêm thư mục repo ở ô **Thư mục code**.
5. **Bật extension** (công tắc cạnh tên context-hub) và mở một cuộc trò chuyện mới. Lần đầu context-hub mất vài phút để tải dữ liệu. Trong lúc đó, câu trả lời sẽ ghi chú "đang tải dữ liệu lần đầu".

Dữ liệu nằm trên máy bạn, ở thư mục `.context-hub` trong thư mục người dùng. Gỡ extension không xoá thư mục này. Muốn lên bản mới thì cài đè file `.mcpb` mới, dữ liệu vẫn giữ nguyên.

Nếu câu trả lời báo lỗi email hoặc token, vào **Settings → Extensions → context-hub** để sửa, rồi tắt và bật lại extension.

Muốn dùng thêm trong Claude Code, xem mục [Claude Code dùng chung dữ liệu với extension](#claude-code-dùng-chung-dữ-liệu-với-extension) ở cách 2.

## Cách 2: Claude Code, không cần repo

Chạy server có sẵn trong file `.mcpb` trực tiếp từ Claude Code. Server tự tải Jira và Confluence khi Claude Code đang mở. Không cần Git, GitHub CLI hay `npm install`. Trên Windows dùng **Command Prompt**, xem [Cách dùng cửa sổ lệnh](#cách-dùng-cửa-sổ-lệnh-đọc-trước-1-phút).

1. **Cài Node.js** theo [Bước 2](#bước-2-cài-nodejs-bản-24-trở-lên).
2. **Tải file `.mcpb`** ở trang Releases về thư mục Downloads.
3. **Giải nén server.** File `.mcpb` thực chất là file zip, và Windows 10/11 cũng có sẵn lệnh `tar`. Đổi `0.2.2` thành đúng số phiên bản của file bạn tải.

   Windows:

```bat
mkdir "%USERPROFILE%\context-hub-mcp"
```

```bat
tar -xf "%USERPROFILE%\Downloads\context-hub-0.2.2.mcpb" -C "%USERPROFILE%\context-hub-mcp"
```

   Mac:

```bash
mkdir -p "$HOME/context-hub-mcp"
```

```bash
tar -xf "$HOME/Downloads/context-hub-0.2.2.mcpb" -C "$HOME/context-hub-mcp"
```

4. **Tạo API token Atlassian** theo [Bước 5](#bước-5-tạo-api-token-atlassian).
5. **Gắn vào Claude Code.** Thay `ten@congty.com` bằng email của bạn và `<token>` bằng token vừa tạo.

   Windows:

```bat
claude mcp add context-hub -s user -e JIRA_BASE_URL=https://onemount.atlassian.net -e JIRA_EMAIL=ten@congty.com -e JIRA_API_TOKEN=<token> -e CTX_CONFLUENCE_SPACES=Healthcare -- node "%USERPROFILE%\context-hub-mcp\server\index.mjs"
```

   Mac:

```bash
claude mcp add context-hub -s user -e JIRA_BASE_URL=https://onemount.atlassian.net -e JIRA_EMAIL=ten@congty.com -e JIRA_API_TOKEN=<token> -e CTX_CONFLUENCE_SPACES=Healthcare -- node "$HOME/context-hub-mcp/server/index.mjs"
```

   Dev và QC muốn dùng `test_scope` và lịch sử code thì thêm đường dẫn các repo vào **cuối** lệnh, mỗi repo trong một cặp dấu nháy, ví dụ `"D:\code\healthos"`. Máy cần có Git ([Bước 1](#bước-1-cài-git)).

6. **Kiểm tra:**

```bash
claude mcp list
```

   Thấy dòng `context-hub: node … - ✔ Connected` là xong. Mở một phiên Claude Code mới. Khoảng 15 giây sau, context-hub tự tải dữ liệu lần đầu, thường dưới một phút. Từ đó nó tự cập nhật mỗi 3 giờ khi Claude Code đang chạy. Dữ liệu nằm ở thư mục `.context-hub` trong thư mục người dùng.

**Lưu ý:**
- **Token lưu dạng chữ thường** trong file `.claude.json` ở thư mục người dùng. Lệnh ở bước 5 cũng nằm lại trong lịch sử lệnh của cửa sổ. Không chia sẻ file này. Nếu lỡ lộ token, vào trang API token bấm **Revoke**, rồi làm lại bước 5 với token mới.
- **Đổi token** (khi hết hạn hoặc bị lộ): chạy `claude mcp remove context-hub -s user`, rồi chạy lại lệnh ở bước 5.
- **Lên bản mới:** tải file `.mcpb` mới, chạy lại lệnh `tar` ở bước 3 (ghi đè bản cũ), rồi mở phiên Claude Code mới. Cấu hình và dữ liệu giữ nguyên.

### Claude Code dùng chung dữ liệu với extension

Đã cài extension Claude Desktop (cách 1)? Cho Claude Code chạy server của extension, **không truyền email và token**. Claude Code khi đó chỉ đọc dữ liệu, còn extension trong Claude Desktop lo đồng bộ. Không phải lưu token lần thứ hai.

Mac:

```bash
claude mcp add context-hub -s user -- node "$HOME/Library/Application Support/Claude/Claude Extensions/local.mcpb.nghiant96.context-hub/server/index.mjs"
```

Windows: Claude Desktop có thể lưu extension trong thư mục ảo hoá của gói cài. Tìm đường dẫn trước:

```bat
dir /s /b "%APPDATA%\Claude\Claude Extensions\index.mjs" "%LOCALAPPDATA%\Packages\Claude*\index.mjs"
```

Rồi dùng đường dẫn có chữ `nghiant96.context-hub` mà lệnh trên in ra:

```bat
claude mcp add context-hub -s user -- node "<đường dẫn index.mjs vừa tìm được>"
```

Dev và QC thêm đường dẫn repo vào cuối lệnh như ở bước 5, dùng đúng các thư mục đã chọn trong extension. Nếu Claude Desktop lâu không được mở, câu trả lời sẽ ghi chú ngày dữ liệu cập nhật lần cuối.

---

Phần dưới đây là **cách 3: cài đầy đủ từ repo**.

## Trước khi bắt đầu

Bạn cần có sẵn:

1. **Tài khoản GitHub** đã được mời vào repo `nghiant96/context-hub`. Mở email mời từ GitHub và bấm **Accept invitation**. Chưa có lời mời thì nhắn người quản lý repo.
2. **Tài khoản Jira/Confluence** của công ty (đăng nhập được https://onemount.atlassian.net).
3. **Claude Desktop** (tải ở https://claude.ai/download) hoặc **Claude Code**, đã đăng nhập.

## Cách dùng cửa sổ lệnh (đọc trước, 1 phút)

Hầu hết các bước là chép một dòng lệnh, dán vào cửa sổ lệnh rồi nhấn **Enter**.

| | Mac | Windows |
|---|---|---|
| Cửa sổ lệnh dùng trong hướng dẫn này | **Terminal**: nhấn `Cmd + Space`, gõ `Terminal`, Enter | **Command Prompt**: bấm Start, gõ `cmd`, chọn **Command Prompt** |
| Dán lệnh | `Cmd + V` | `Ctrl + V` hoặc chuột phải |

- Mỗi khung xám dưới đây là **một lệnh**. Dán xong nhấn Enter, chờ đến khi con trỏ hiện lại ở dòng mới rồi mới chạy lệnh tiếp theo.
- Lệnh nào khác nhau giữa Mac và Windows sẽ được tách riêng và ghi rõ. Các lệnh còn lại dùng chung cho cả hai.
- Trên Windows, **dùng Command Prompt, không dùng PowerShell**. PowerShell thường chặn lệnh `npm` với lỗi "running scripts is disabled".
- Sau khi cài một phần mềm mới (Git, Node.js, GitHub CLI), **đóng cửa sổ lệnh và mở lại** thì máy mới nhận ra phần mềm đó.

---

## Bước 1. Cài Git

### Mac

Mở Terminal và chạy:

```bash
git --version
```

- Nếu thấy dòng kiểu `git version 2.x.x`: máy đã có Git, sang bước 2.
- Nếu hiện hộp thoại *"The git command requires the command line developer tools"*: bấm **Install**, rồi **Agree**, chờ cài xong (có thể 5–15 phút). Sau đó chạy lại lệnh trên để kiểm tra.
- Nếu không thấy hộp thoại nào, chạy `xcode-select --install` để hộp thoại hiện ra.

### Windows

1. Vào https://git-scm.com/downloads/win, tải **Git for Windows Setup** bản 64-bit.
2. Mở file vừa tải và bấm **Next** ở mọi màn hình (giữ nguyên lựa chọn mặc định), cuối cùng bấm **Install** rồi **Finish**.
3. Mở **Command Prompt mới** và kiểm tra:

```bat
git --version
```

Thấy `git version 2.x.x` là xong.

## Bước 2. Cài Node.js (bản 24 trở lên)

1. Vào https://nodejs.org và tải bản **LTS**, số phiên bản phải từ **24** trở lên.
   - Mac: file `.pkg`.
   - Windows: file `.msi` (Windows Installer).
2. Mở file và bấm **Continue/Next** đến hết, giữ nguyên lựa chọn mặc định.
   - Windows: ở màn *"Tools for Native Modules"*, **không** tick ô *"Automatically install the necessary tools"*.
3. Mở cửa sổ lệnh mới và kiểm tra:

```bash
node --version
```

Kết quả phải là `v24.x.x` hoặc số lớn hơn. Nếu thấy số nhỏ hơn 24 thì tải và cài lại bản mới hơn.

## Bước 3. Cài GitHub CLI và đăng nhập GitHub

Repo đang để private, nên máy cần đăng nhập GitHub mới tải được code.

1. Vào https://cli.github.com, bấm **Download for Mac** hoặc **Download for Windows**, mở file và cài với lựa chọn mặc định.
2. Mở cửa sổ lệnh mới và chạy (Mac và Windows giống nhau):

```bash
gh auth login --web --git-protocol https
```

3. Nếu được hỏi *"Authenticate Git with your GitHub credentials?"*, gõ `Y` rồi Enter.
4. Màn hình hiện một mã gồm 8 ký tự (ví dụ `ABCD-1234`). Nhấn Enter, trình duyệt sẽ mở ra. Dán mã vào trình duyệt và bấm **Authorize**.
5. Quay lại cửa sổ lệnh. Thấy `✓ Logged in as <tên-github-của-bạn>` là xong.

## Bước 4. Tải context-hub về máy

Chạy lần lượt 3 lệnh sau (Mac và Windows giống nhau):

```bash
gh repo clone nghiant96/context-hub
```

```bash
cd context-hub
```

```bash
npm install
```

Code sẽ nằm ở:
- Mac: `/Users/<tên-máy>/context-hub`
- Windows: `C:\Users\<tên-máy>\context-hub`

Lệnh `npm install` chạy khoảng 1 phút và có thể in ra vài dòng `warn`. Như vậy là bình thường.

## Bước 5. Tạo API token Atlassian

Token này cho phép context-hub đọc Jira và Confluence **dưới tên bạn**: bạn được xem ticket hay trang nào thì context-hub đọc được đúng những cái đó.

1. Mở https://id.atlassian.com/manage-profile/security/api-tokens và đăng nhập bằng tài khoản công ty.
2. Bấm **Create API token**. Không chọn *"Create API token with scopes"*.
3. Đặt tên là `context-hub`, chọn ngày hết hạn xa nhất mà trang cho phép, rồi bấm **Create**.
4. Bấm **Copy** và dán tạm vào một chỗ an toàn. **Token chỉ hiện một lần**, đóng trang rồi sẽ không xem lại được.

## Bước 6. Điền token vào file `.env`

Cửa sổ lệnh vẫn phải đang ở thư mục `context-hub` (đã chạy `cd context-hub` ở bước 4).

### Mac

```bash
cp .env.example .env
```

```bash
open -e .env
```

### Windows

```bat
copy .env.example .env
```

```bat
notepad .env
```

File mở ra trong TextEdit (Mac) hoặc Notepad (Windows). Sửa 2 dòng sau, không thêm dấu cách hay dấu nháy:

```text
JIRA_EMAIL=email-dang-nhap-jira-cua-ban@congty.com
JIRA_API_TOKEN=dán-token-ở-bước-5-vào-đây
```

Lưu file (`Cmd + S` hoặc `Ctrl + S`) rồi đóng lại.

> ⚠️ **Không gửi file `.env` cho bất kỳ ai** và không chụp màn hình file này. Ai có token là đọc được Jira dưới tên bạn.

## Bước 7. Tải dữ liệu Jira và Confluence lần đầu

```bash
npm run ctx -- sync
```

Lần đầu có thể mất vài phút. Cứ để cửa sổ chạy đến khi thấy các dòng:

```text
! Bỏ qua healthos: không thấy git repo tại …        ← bình thường nếu bạn không phải dev
✓ jira HOS: … ticket (toàn bộ)
✓ confluence Healthcare: … trang (toàn bộ)
```

Thử tìm một nội dung để kiểm tra:

```bash
npm run ctx -- search quên mã PIN
```

Thấy danh sách ticket và tài liệu hiện ra là dữ liệu đã sẵn sàng.

## Bước 8. Gắn vào Claude

Bạn dùng app Claude nào thì làm theo cách tương ứng. Dùng cả hai thì làm cả hai.

### Cách A: Claude Desktop (khung chat)

1. Trong cửa sổ lệnh (vẫn đang ở thư mục `context-hub`), chạy lệnh sau. Mac và Windows dùng chung một lệnh:

```bash
node -e "console.log(JSON.stringify({mcpServers:{'context-hub':{command:process.execPath,args:[require('path').resolve('src/mcp.ts')]}}},null,2))"
```

   Lệnh này in ra một đoạn cấu hình với đường dẫn đúng cho máy bạn, đại loại:

```json
{
  "mcpServers": {
    "context-hub": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/ten-may/context-hub/src/mcp.ts"]
    }
  }
}
```

   Bôi đen và copy **toàn bộ** đoạn in ra, từ dấu `{` đầu tiên đến dấu `}` cuối cùng.

2. Mở Claude Desktop, vào **Settings**:
   - Mac: menu **Claude** ở góc trên bên trái màn hình → **Settings…**
   - Windows: biểu tượng menu **☰** ở góc trên bên trái cửa sổ → **File** → **Settings…**

3. Chọn tab **Developer** và bấm **Edit Config**. Một thư mục sẽ mở ra, trong đó có file `claude_desktop_config.json`. Mở file này bằng TextEdit (Mac) hoặc Notepad (Windows, chuột phải → **Open with** → **Notepad**).

4. Dán đoạn cấu hình vào file:
   - **File trống hoặc chỉ có `{}`:** xoá hết nội dung cũ rồi dán đoạn vừa copy.
   - **File đã có nội dung khác:** giữ nguyên nội dung cũ và thêm phần `"mcpServers"` vào bên trong cặp ngoặc `{ }` ngoài cùng, ngăn với nội dung cũ bằng một dấu phẩy. Ví dụ:

```json
{
  "preferences": { "...": "giữ nguyên nội dung cũ" },
  "mcpServers": {
    "context-hub": {
      "command": "/usr/local/bin/node",
      "args": ["/Users/ten-may/context-hub/src/mcp.ts"]
    }
  }
}
```

   Nếu file đã có sẵn mục `"mcpServers"`, chỉ thêm phần `"context-hub": { … }` vào trong mục đó, cũng ngăn bằng dấu phẩy. Không chắc thì nhờ một bạn dev xem giúp 1 phút.

5. Lưu file, rồi **thoát hẳn** Claude Desktop. Đóng cửa sổ thôi là chưa đủ.
   - Mac: nhấn `Cmd + Q`.
   - Windows: chuột phải vào biểu tượng Claude ở khay hệ thống (góc dưới bên phải màn hình) → **Quit**.

   Sau đó mở lại Claude Desktop.

6. Kiểm tra: mở cuộc trò chuyện mới, bấm vào biểu tượng công cụ trong ô chat. Thấy **context-hub** là đã kết nối. Thử hỏi: *"Dùng context-hub tìm các ticket về quên mã PIN"*.

### Cách B: Claude Code (terminal, hoặc tab Code trong Claude Desktop)

> Đã cài extension Claude Desktop (cách nhanh)? Claude Code có thể dùng chung dữ liệu của extension, không cần làm lại các bước ở trên: xem mục "Gắn vào Claude Code" trong README.

Chạy một lệnh, không cần sửa đường dẫn. Lệnh này giả định bạn đã tải code về thư mục người dùng như ở bước 4.

Mac:

```bash
claude mcp add context-hub -s user -- node "$HOME/context-hub/src/mcp.ts"
```

Windows (Command Prompt):

```bat
claude mcp add context-hub -s user -- node "%USERPROFILE%\context-hub\src\mcp.ts"
```

Kiểm tra bằng lệnh sau. Thấy dòng `context-hub` kèm `✓ Connected` là xong:

```bash
claude mcp list
```

---

## Dùng hằng ngày

**Cập nhật dữ liệu mới (nên làm mỗi sáng):** mở cửa sổ lệnh và chạy:

```bash
cd context-hub
```

```bash
npm run ctx -- sync
```

Từ lần thứ hai trở đi, lệnh chỉ kéo những ticket và trang mới thay đổi nên chạy nhanh. Việc này **không tốn hạn mức Claude**, vì máy bạn gọi thẳng Jira và Confluence.

**Hỏi Claude, ví dụ:**
- "Dùng context-hub lấy ngữ cảnh HOS-1313"
- "Đã có story nào về quên mã PIN chưa?"
- "Spec onboarding nói gì về màn câu hỏi bắt buộc?"
- "Tổng hợp nghiệp vụ liên quan tới phân quyền web admin"
- "Tuần này spec của epic HOS-330 thay đổi gì? Trang nào sửa sau khi đã code?"
- "Màn này đã làm ở đâu trong code? https://www.figma.com/design/…" (dán link Figma)

## Cập nhật context-hub lên phiên bản mới

Khi được báo có bản mới:

```bash
cd context-hub
```

```bash
git pull
```

```bash
npm install
```

Sau đó thoát hẳn Claude và mở lại.

## Dành cho dev và QC: lịch sử code và `test_scope`

Các câu hỏi về code ("file này do ticket nào sửa", "nhánh này cần regression gì") cần context-hub đọc được repo code trên máy. Đặt thư mục `context-hub` **nằm cạnh** thư mục `healthos-meta`:

```text
<thư mục làm việc>/
├── context-hub/
└── healthos-meta/
    └── mobile/
        ├── healthos/
        └── healthos-app-master/
```

Nghĩa là ở bước 4, bạn `cd` vào thư mục chứa `healthos-meta` trước rồi mới chạy `gh repo clone`. Nếu repo code nằm ở chỗ khác, sửa `path` trong file `context-hub.config.json`. Sau đó chạy:

```bash
npm run ctx -- sync git
```

## Gặp lỗi thì làm gì

| Thông báo / hiện tượng | Cách xử lý |
|---|---|
| `command not found: git` (Mac) hoặc `'git' is not recognized` (Windows), tương tự với `node`, `gh`, `npm` | Phần mềm chưa cài xong, hoặc chưa mở lại cửa sổ lệnh sau khi cài. Đóng cửa sổ lệnh, mở lại rồi thử lần nữa. |
| `running scripts is disabled on this system` (Windows) | Bạn đang dùng PowerShell. Mở **Command Prompt** và chạy lại. |
| `node --version` ra số nhỏ hơn v24 | Cài lại Node.js bản mới hơn (bước 2). |
| `Could not resolve to a Repository` khi `gh repo clone` | Bạn chưa được mời vào repo hoặc chưa bấm Accept lời mời. Nhắn người quản lý repo. |
| `cd: no such file or directory: context-hub` | Bạn đang đứng sai thư mục. Đóng và mở lại cửa sổ lệnh (cửa sổ mới luôn mở ở thư mục người dùng), rồi `cd context-hub`. |
| `Bỏ qua Jira: thiếu JIRA_EMAIL / JIRA_API_TOKEN` | File `.env` chưa được lưu hoặc điền sai. Mở lại file theo bước 6 và kiểm tra. |
| `HTTP 401` | Email hoặc token sai, hoặc token đã hết hạn. Tạo token mới (bước 5) rồi sửa file `.env`. |
| `HTTP 403`, hoặc thiếu ticket/trang mà người khác vẫn thấy | Tài khoản của bạn chưa có quyền xem project hoặc space đó trên Jira/Confluence. |
| Claude không thấy context-hub | Thoát hẳn Claude rồi mở lại. Kiểm tra file cấu hình có đủ dấu ngoặc và dấu phẩy không. Tab **Developer** trong Settings của Claude Desktop có hiện lỗi của từng server. |
| Claude báo `Chưa có index` | Bạn chưa chạy bước 7. |
| `'tar' is not recognized` (Windows cũ) | Đổi đuôi file `.mcpb` thành `.zip`, chuột phải chọn **Extract All…** và giải nén vào thư mục `context-hub-mcp` trong thư mục người dùng. |
| Cách 2: Claude báo `Chưa có dữ liệu ở …` | Lệnh ở bước 5 thiếu email hoặc token, nên server chỉ đọc. Chạy `claude mcp remove context-hub -s user` rồi làm lại bước 5. |

## Lưu ý bảo mật

- **Không gửi** file `.env` hay thư mục `data/` cho người khác, và không đưa chúng lên GitHub. Repo đã được cấu hình để tự bỏ qua hai mục này.
- Nếu lỡ để lộ token, vào lại trang ở bước 5, bấm **Revoke** token cũ rồi tạo token mới.
- Dữ liệu trên máy bạn chỉ gồm những gì tài khoản của bạn được xem. Số điện thoại, email và số CCCD đã được che trước khi lưu.
