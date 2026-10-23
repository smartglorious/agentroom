# Nhiều worker trên nhiều máy (v0.5)

> Một cửa sổ VS Code điều phối cả đội. Worker chạy trên **máy này** hoặc trên **máy khác qua SSH**, cùng lúc, cùng làm trên một repo git.

## 1. Mô hình

```
┌──────────────── Máy của bạn: MỘT cửa sổ VS Code (hub) ────────────────┐
│  Chat · task board · trí nhớ · chi phí · lịch · webhook · MCP server  │
│  Room ── Scheduler (mỗi account một "làn")                            │
│   ├─ worker lead, qa   → Claude/Codex chạy ngay trên máy này          │
│   └─ worker be, fe  ───┐                                              │
└────────────────────────┼──────────────────────────────────────────────┘
          ssh (stdio, không cần port forwarding)      ssh
   ┌────────────────────▼───────────┐      ┌───────────────▼──────────────┐
   │ Máy gpu-box (Linux)            │      │ Máy mac-mini (macOS)         │
   │ runner.mjs ── claude CLI ──┐   │      │ runner.mjs ── codex CLI      │
   │ clone repo: /home/dev/app  │   │      │ clone repo: ~/code/app       │
   │  └ .agentroom/worktrees/be ┘   │      │  └ .agentroom/worktrees/fe   │
   └────────────────────────────────┘      └──────────────────────────────┘
        mọi máy cùng một repo git (mỗi worker một nhánh agentroom/<id>)
```

- **Không phải mỗi worker một cửa sổ.** Worker là persona gắn với một session Claude/Codex; trạng thái dùng chung (chat, task, giới hạn account, ngân sách, lịch) cần đúng một chủ. Hai cửa sổ cùng một thư mục `.agentroom/` làm lệch chat, ghi đè bảng task, chạy lịch hai lần và vượt giới hạn account (đã đo ở v0.4), nên từ v0.5 cửa sổ thứ hai bị chặn (mục 7).
- **Máy từ xa không cần mở VS Code.** Hub tự cài một chương trình nhỏ (runner) lên đó qua SSH rồi điều khiển.
- **Mỗi máy dùng đăng nhập Claude/Codex của chính nó.** Vì vậy *account* gắn với một máy.

## 2. Cấu hình

```yaml
hosts:                               # các máy có thể chạy worker
  gpu-box:
    ssh: dev@gpu-box.example.com     # user@host, host, hoặc alias trong ~/.ssh/config
    repo: /home/dev/app              # clone của repo TRÊN máy đó (tuyệt đối hoặc ~/…)
    # port: 22                       # identityFile: ~/.ssh/id_work
    # node: /usr/local/bin/node      # khi `node` không có trong PATH của login shell
    # claudePath: /home/dev/.local/bin/claude     # codexPath: …
    # connectTimeoutSec: 15
  mac-mini:
    ssh: mini
    repo: ~/code/app

accounts:
  local-claude: { provider: claude, maxConcurrent: 2 }                 # đăng nhập trên máy này
  gpu-claude:   { provider: claude, host: gpu-box, maxConcurrent: 2 }  # đăng nhập trên gpu-box
  mini-codex:   { provider: codex,  host: mac-mini }

workers:
  - { id: lead, name: Lan,  role: Tech Lead, account: local-claude, coordinator: true }
  - { id: qa,   name: Tuấn, role: QA,        account: local-claude }              # máy này
  - { id: be,   name: Minh, role: Backend,   account: gpu-claude, worktree: true }
  - { id: fe,   name: Hoa,  role: Frontend,  account: mini-codex, worktree: true, workdir: ~/code/web }
```

| Trường | Ý nghĩa |
|---|---|
| `hosts.<tên>.ssh` | Đích SSH. Chỉ chấp nhận `user@host`, `host`, alias; **không** được bắt đầu bằng `-` hay chứa khoảng trắng (chặn chèn tuỳ chọn ssh từ file cấu hình trong repo). |
| `hosts.<tên>.repo` | Clone mặc định của repo trên máy đó. |
| `account.host` | Account này là một đăng nhập **trên máy đó**. Bỏ trống = máy này. `home` và `apiKeyEnv` của account cũng là của máy đó. |
| `worker.workdir` | Clone mà worker dùng thay cho mặc định. Trên máy này, đường dẫn tương đối tính từ workspace; trên host phải tuyệt đối hoặc `~/…`. Dùng được cả không có host, để trỏ một clone ở đường dẫn khác trên cùng máy. |
| `worker.worktree: true` | Worker làm trong `<repo>/.agentroom/worktrees/<id>` trên nhánh `agentroom/<id>`, tạo ở **phía máy chạy**. Nên bật cho mọi worker ghi code. |

Có thể có nhiều worker trên cùng một máy, kể cả máy từ xa (giới hạn bằng `maxConcurrent` của account).

## 3. Chuẩn bị một máy từ xa (làm một lần)

1. **SSH bằng khoá**: `ssh <ssh>` vào được mà không hỏi mật khẩu (ssh-agent hoặc `identityFile`). AgentRoom dùng `BatchMode`, **không** hỏi mật khẩu.
2. **Xác nhận host key**: chạy `ssh <ssh>` một lần trong terminal. Nếu chưa, AgentRoom báo "Chưa xác nhận host key".
3. **Node ≥ 20** trên máy đó (runner chạy bằng node). Linux hoặc macOS (cần shell POSIX và `head -c`); Windows làm máy từ xa chưa hỗ trợ.
4. **Claude Code và/hoặc Codex CLI** đã cài và **đã đăng nhập** trên máy đó (hoặc `apiKeyEnv` trỏ tới biến môi trường có API key trên máy đó).
5. **Clone repo** về `hosts.<tên>.repo` (hoặc `workdir`), đã `git pull` mới. Worker tạo nhánh từ `HEAD` của clone đó.
6. Nếu `node`/`claude`/`codex` nằm ngoài PATH của login shell (thường gặp khi cài bằng nvm), đặt `node`, `claudePath`, `codexPath` là đường dẫn đầy đủ.
7. Trong VS Code chạy **"AgentRoom: Kiểm tra kết nối các máy"** hoặc mở tab **Máy** → *Kiểm tra tất cả*. Lần đầu AgentRoom hỏi bạn có cho phép kết nối SSH tới máy đó không.

## 4. Cách hoạt động

- **Cài runner**: lần kết nối đầu, hub chạy `ssh … sh -c '…'`. Script đó kiểm tra Node ≥ 20, và chỉ khi file `~/.agentroom/runner/<hash>.mjs` chưa có thì hub gửi file qua stdin (1 file ~2 MB, đã gói sẵn cả hai SDK). Lần sau dùng lại, không gửi lại.
- **Giao thức**: mỗi dòng một JSON (`@AR {…}`) qua stdin/stdout của ssh. Dòng không bắt đầu bằng `@AR ` (banner, motd) bị bỏ qua. Hub gửi lượt chạy; runner trả hoạt động, kết quả, token và chi phí.
- **Công cụ của phòng (MCP)**: agent ở máy xa gọi `post_message`, `create_task`, `remember`… qua một cổng loopback của runner; runner chuyển từng yêu cầu ngược qua kênh ssh về MCP server của hub. **Không cần port forwarding** (đã thử với `AllowTcpForwarding no`). Mỗi lượt có một đường dẫn bí mật riêng, hub biết lượt đó thuộc worker nào nên không giả mạo được worker khác.
- **Duyệt quyền**: yêu cầu quyền của Claude ở máy xa hiện thành thẻ *Cho phép / Từ chối* trên hub như worker cục bộ.
- **Skills**: hub gửi nội dung skill (≤ 5 MB) cùng lượt; runner lưu theo hash vào `~/.agentroom/skills-cache/`. Claude nhận plugin tạo trên máy đó; Codex được nhắc đường dẫn trên máy đó.
- **Session**: id session chỉ có nghĩa trên máy đã tạo ra nó, nên hub lưu riêng theo host (`be:T1@gpu-box`). Đổi account sang máy khác thì thread bắt đầu session mới.
- **Mất kết nối**: heartbeat 20 giây, quá 60 giây không phản hồi thì coi là đứt. Lượt đang chạy báo lỗi một lần (không gọi lại worker), thẻ duyệt quyền đang chờ được rút, runner và `claude` ở máy xa tự dừng khi kênh đóng. Lượt sau tự kết nối lại. Thay đổi file mà lượt bị ngắt đã làm vẫn nằm trong worktree (không hoàn tác).

## 5. Git là điểm nối giữa các máy

- Mỗi worker commit trên nhánh `agentroom/<id>` **trong clone của máy nó chạy**. Persona của worker từ xa nhắc phải `git push origin agentroom/<id>` khi xong, để đồng đội và bạn lấy được.
- Hub **không tự merge**. Bạn (hoặc `qa`) fetch nhánh rồi review/merge như một PR thường.
- Các clone trên mọi máy phải trỏ cùng một `origin`. Hai worker không được dùng chung một thư mục không có worktree.

## 6. Account, giới hạn, ngân sách

- Mỗi account là một "làn": `maxConcurrent`, chờ khi bị rate limit và ngân sách ngày tính **riêng theo account**.
- Cùng một gói subscription đăng nhập trên hai máy là **hai account** trong cấu hình, nhưng giới hạn thật nằm ở phía nhà cung cấp và dùng chung. Hub không thấy giới hạn chung đó: hãy đặt `maxConcurrent` sao cho tổng không vượt khả năng của gói.
- Chi phí, Inspector và nhật ký ghi rõ máy chạy (`gpu-box:/home/dev/app/.agentroom/worktrees/be`).

## 7. Một cửa sổ cho mỗi thư mục `.agentroom/`

Tệp `.agentroom/state/room.lock` (máy, pid, nhịp tim mỗi 5 giây). Cửa sổ thứ hai thấy thẻ "Phòng này đang chạy ở một cửa sổ khác" kèm thông tin, và có thể bấm *Chiếm quyền điều phối*; cửa sổ cũ tự dừng ở nhịp tim kế tiếp. Khóa không còn nhịp tim quá 20 giây được coi là bỏ hoang.

Với Remote-SSH, extension khai báo `extensionKind: workspace` để chạy ở máy đang mở thư mục (mọi worker "máy này" khi đó là máy remote đó).

## 8. Bảo mật

| Rủi ro | Biện pháp |
|---|---|
| File cấu hình trong repo lạ bắt AgentRoom ssh tới đâu đó | Mỗi định nghĩa host (ssh, port, khoá, đường dẫn…) phải được bạn **cho phép bằng hộp thoại** trước lần kết nối đầu; đổi bất kỳ trường nào thì hỏi lại. Extension không chạy trong workspace chưa tin cậy. |
| Chèn tuỳ chọn ssh (`-oProxyCommand=…`) qua trường `ssh`/`identityFile` | Kiểm tra chặt khi nạp cấu hình và khi dựng lệnh; luôn có `--` trước đích. |
| Mật khẩu / khoá | Chỉ khoá SSH hoặc ssh-agent (`BatchMode`); không có chỗ đặt mật khẩu. `apiKeyEnv` là *tên* biến môi trường trên máy đó. |
| Người khác trên máy từ xa gọi vào cổng MCP của runner | Chỉ nghe `127.0.0.1`, đường dẫn bí mật ngẫu nhiên riêng cho từng lượt, chỉ tồn tại trong lúc lượt chạy. |
| Skill độc hại ghi ra ngoài thư mục cache | Từ chối đường dẫn tuyệt đối / `..`; giới hạn 5 MB. |
| Nguồn không tin cậy (webhook) | Giữ nguyên cơ chế chỉ-đọc của v0.4; áp dụng cả với worker từ xa. |

## 9. Đã kiểm chứng gì (v0.5.0)

`npm test` (96 test) và `npm run test:ssh` (17 kiểm tra) với **sshd thật** (cổng 2222, tắt TCP forwarding), **runner thật** và **Claude thật** ở phía "máy từ xa" (chi phí khoảng $0,25 mỗi lần):

- Host key chưa tin cậy → báo cách xử lý, không treo. `node` sai đường dẫn → khuyên đặt `hosts.<tên>.node`.
- Kết nối, cài runner đúng một lần, file trên máy đích trùng từng byte.
- Claude thật ở máy xa trả lời, gọi công cụ của phòng qua kênh ssh, tạo worktree/nhánh `agentroom/be` ở phía máy xa; chi phí và máy chạy được ghi lại; session được resume trên máy xa.
- Thẻ duyệt quyền xuyên máy: cho phép thì file được ghi; từ chối thì không.
- Worker cục bộ và worker từ xa trả lời cùng lúc.
- Đứt SSH giữa lúc chờ duyệt: thẻ được rút, một thông báo lỗi, không gọi lại worker, **không còn tiến trình runner hay `claude` nào sót lại**; lượt sau tự kết nối lại, không gửi lại runner.

**Chưa kiểm chứng / giới hạn:**
- Codex ở máy xa: có test đơn vị cho đường đi, chưa chạy thật (môi trường dựng không tới được OpenAI).
- Hộp thoại xác nhận host, thẻ khóa và tab *Máy* chỉ được thử trong Chromium với API VS Code giả lập, chưa trong VS Code thật. `extensionKind: workspace` (Remote-SSH) và việc VS Code tự tắt extension trong workspace chưa tin cậy là khai báo trong `package.json`, chưa được kiểm chứng.
- Hub chạy trên Windows (dùng `ssh.exe`) và máy từ xa Windows chưa được thử.
- Máy "từ xa" trong bài thử dùng chung hệ tệp và người dùng với hub (một máy ảo), nên chưa thử độ trễ mạng thật hay máy khác hệ điều hành.
- Cần Node ≥ 20 trên máy từ xa.

## 10. Xử lý sự cố

| Thông báo | Cách xử lý |
|---|---|
| "Chưa xác nhận host key" | Chạy `ssh <ssh>` một lần trong terminal. |
| "SSH từ chối đăng nhập" | Dùng khoá/ssh-agent; đặt `identityFile`; thử `ssh <ssh>` bằng tay. |
| "Không tìm thấy node … (cần Node ≥ 20)" | Cài Node trên máy đó hoặc đặt `hosts.<tên>.node` là đường dẫn đầy đủ. |
| "Node … quá cũ" | Nâng Node ≥ 20 hoặc trỏ `node` tới bản mới. |
| "Không tìm thấy CLI claude/codex trên máy …" | Cài + đăng nhập trên máy đó, hoặc đặt `claudePath`/`codexPath`. |
| "Thư mục repo không tồn tại trên máy này" | `repo`/`workdir` phải là đường dẫn trên máy từ xa; clone repo về đó. |
| "Mất kết nối tới …" | Mạng/SSH đứt. Lượt sau tự kết nối lại; kiểm tra tab *Máy*. |
| "Bạn chưa cho phép AgentRoom kết nối SSH" | Bạn đã từ chối hộp thoại; chạy lại *Kiểm tra kết nối các máy* và chọn cho phép. |
| Thẻ "Phòng này đang chạy ở một cửa sổ khác" | Dùng cửa sổ đó, hoặc *Chiếm quyền điều phối*. |
