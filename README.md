# AgentRoom

Group chat cho một "đội" AI trong VS Code. Mỗi worker là một persona (vai trò, kỹ năng, tính cách, trí nhớ riêng) chạy trên Claude Code hoặc Codex. Nhiều worker dùng chung một account.

Thiết kế và kế hoạch: `docs/DESIGN.md`, `docs/PLAN-v0.2.md`. **Nhiều máy / SSH: `docs/MULTI-MACHINE.md`. Điện thoại / Telegram: `docs/TELEGRAM.md`. Chạy không cần VS Code: `docs/DAEMON.md`. Hạn mức gói: `docs/PLAN-USAGE.md`. Mức tự chủ: `docs/AUTONOMY.md`. Reply và lựa chọn: `docs/REPLY-OPTIONS.md`. Bớt lượt: `docs/FEWER-TURNS.md`. Model theo độ khó task: `docs/MODEL-ROUTING.md`. Daemon trên VPS: `docs/DAEMON-VPS.md`. Đo cache-write: `docs/BENCH-CACHEWRITE.md`. Chế độ lưu trữ: `docs/STORAGE-MODES.md`. Dọn dẹp: `docs/CLEANUP.md`. Gom lỗi: `docs/ISSUES.md`. Hai ngôn ngữ: `docs/I18N.md`. Điểm mở rộng: `docs/EXTENSIONS.md`.** Để agent thiết lập cho một project có sẵn: `docs/SETUP-GUIDE.md`.

## Tính năng

| | |
|---|---|
| **Group chat nhiều worker** | `@id` gọi một worker, `@all` gọi tất cả; tin không @mention đến coordinator. Chặn vòng lặp agent↔agent. |
| **Account dùng chung** | Giới hạn chạy song song, tự chờ và chạy lại khi bị rate limit, ngân sách USD theo ngày. |
| **Trí nhớ bền vững** | `SOUL.md`, `MEMORY.md`, nhật ký ngày cho từng worker + trí nhớ chung của đội. Agent ghi qua tool `remember` / `recall` / `forget` / `journal`. |
| **Skills thật** | `useSkills` bật các `SKILL.md` cho đúng worker; agent có thể đề xuất skill mới, chỉ có hiệu lực sau khi bạn duyệt. |
| **Mức tự chủ** | Mỗi worker chọn 🛡 Manual (hỏi mọi thao tác) · 🤖 Auto (tự duyệt việc an toàn trong thư mục của worker, chặn xóa file/hệ thống/sudo, hỏi khi không chắc) · ⚡ Full (không hỏi, trừ vài hành động phá máy; có hộp thoại cảnh báo, chỉ bạn bật được). Nhật ký quyết định ở `audit.jsonl`. **Auto không phải sandbox.** Xem `docs/AUTONOMY.md`. |
| **Trả lời đúng tin, lựa chọn bằng nút** | Nút ↩ trên tin của worker: câu trả lời tới đúng tác giả, đúng phiên, kèm trích dẫn. Worker cần bạn chọn thì gọi `ask_user` và hiện nút; bấm là trả lời về đúng phiên đó. Cả trên Telegram. Xem `docs/REPLY-OPTIONS.md`. |
| **Ít lượt vô ích** | Các worker không còn nhắn qua lại vô tận: giới hạn lượt cho mỗi tin của bạn (`limits.chainTurns`), ngân sách theo task (`limits.usdPerTask`), `[NOOP]` thay cho "không có việc mới", chống lặp, gom tin đến cùng lúc vào một lượt. Xem `docs/FEWER-TURNS.md`. Task có thể có độ khó (`level`) để mỗi worker chạy model/effort phù hợp (`levels:`), xem `docs/MODEL-ROUTING.md`. |
| **Tiếng Việt / English** | `agentroom.language` = `vi` (mặc định) · `en` · `auto`: giao diện chat, hộp thoại, tin hệ thống, Telegram và CLI daemon. Prompt gửi cho AI vẫn tiếng Việt. Xem `docs/I18N.md`. |
| **Điểm mở rộng** | Plugin gộp vào bản build có thể thêm guard (chỉ làm chặt hơn: hỏi hoặc chặn, không bao giờ nới quyền), tab chỉ-xem, lệnh chat `/tên`, sự kiện sau khi duyệt, tên nhánh worktree và phần `ext:` trong cấu hình. Xem `docs/EXTENSIONS.md`. |
| **Gom lỗi để cải tiến** | Lỗi lượt, lỗi Telegram, rate limit, chạm ngân sách/giới hạn được ghi cục bộ, gộp trùng, ẩn bí mật; xuất báo cáo Markdown (`AgentRoom: Xuất báo cáo lỗi`, Telegram `/issues`, `agentroom-daemon issues`). Không tự tải lên đâu cả. Xem `docs/ISSUES.md`. |
| **Dọn dẹp, không xóa** | Lệnh *Dọn dẹp file rác/tạm/cache*: tìm `.DS_Store`, `*.tmp`, `__pycache__`… (bỏ qua file git theo dõi), và khi bạn chọn thì *di chuyển* vào `.agentroom/cleanup/` để bạn tự xóa; có khôi phục. Không bao giờ tự xóa. Xem `docs/CLEANUP.md`. |
| **Hạn mức gói** | Tab *Chi phí* hiện phần trăm còn lại của gói Claude/Codex theo từng cửa sổ (5 giờ, 7 ngày…) và giờ reset; cảnh báo, tự tạm dừng khi hết; Telegram `/plan`. Xem `docs/PLAN-USAGE.md`. |
| **Lưu trữ SQLite (tùy chọn)** | `agentroom.storage.mode`: `legacy` (mặc định, file như cũ), `verify` (dựng và đối chiếu bản SQLite) hoặc `durable` (lượt chạy bền vững phục hồi sau khi tắt đột ngột, phê duyệt bền, Context Broker, trí nhớ lai, sổ chi phí model, API cục bộ `/v1`). Có sao lưu, đối chiếu và tự quay về `legacy` khi lỗi. Chưa kiểm chứng trên dữ liệu thật. Xem `docs/STORAGE-MODES.md`. |
| **Cài đặt trong giao diện** | Tab *Cài đặt*: đổi các cài đặt `agentroom.*` thường dùng (ngôn ngữ, số tin phát lại, ngân sách trí nhớ, giới hạn agent↔agent, đường dẫn `claude`/`codex`…) không cần mở `settings.json`. Mỗi mục báo đã đặt ở đâu, có cần tải lại cửa sổ không, và có nút về mặc định; giá trị được kiểm tra trước khi ghi. Giới hạn trong `workers.yaml` chỉ hiển thị, sửa trong file. |
| **Chi phí** | Tab *Chi phí*: token, chi phí, cache hit theo worker / account / model / task / tool. |
| **Context Inspector** | Nút 🔍 trên tin nhắn: xem chính xác những gì đã gửi cho model, chia theo phần, kèm số token. |
| **Lịch chạy** | Cron có timezone, chạy bù khi VS Code vừa mở lại, nút *Chạy ngay*. |
| **Webhook** | `127.0.0.1`, bắt buộc HMAC, chống trùng, giới hạn tần suất, payload coi như dữ liệu không tin cậy, chế độ chỉ-đọc. |
| **Nhiều máy** | Worker chạy trên máy này **và** trên các máy khác qua SSH, cùng lúc, cùng một repo git. Tự cài runner, không cần port forwarding, duyệt quyền xuyên máy, tab *Máy*. |
| **Điện thoại (Telegram)** | Nhắn cho đội, nhận tóm tắt, cảnh báo và thẻ xin quyền; duyệt việc sửa file *an toàn* bằng nút (PIN tuỳ chọn). Bot riêng, chỉ một người đã ghép cặp, tin tồn đọng không bị phát lại. |
| **Chương trình nền** | `agentroom-daemon`: Telegram, lịch và webhook chạy khi VS Code đóng (systemd), cùng khóa phòng với extension. |
| **Một cửa sổ điều phối** | Khóa `.agentroom/state/room.lock`: cửa sổ thứ hai không chạy song song làm hỏng dữ liệu, có thể chiếm quyền. |
| **An toàn** | Worktree riêng cho từng dev, thẻ duyệt quyền (Claude), sandbox (Codex), xác nhận trước khi ssh tới host trong cấu hình repo. |

## Yêu cầu

- VS Code ≥ 1.90
- Đã cài và đăng nhập **Claude Code** (`claude` → `/login`) và/hoặc **Codex CLI** (`codex login`). Extension dùng chính CLI này, nên không gói kèm binary.
  Nếu `claude`/`codex` không nằm trong PATH, đặt `agentroom.claudePath` / `agentroom.codexPath` trong Settings.

## Cài từ file .vsix

```bash
code --install-extension agentroom-0.14.21.vsix
```

Hoặc trong VS Code: Extensions → `…` → **Install from VSIX…** → chọn file.

## Build từ mã nguồn (cần Node ≥ 20)

```bash
npm install
npm run build        # dist/extension.js + dist/runner.mjs (file được cài lên máy từ xa)
npm test             # router, scheduler, task board, room, MCP, memory, skills, usage, cron, webhook, khóa, runner/SSH, Telegram
npm run test:live    # kịch bản thật với Claude (tốn vài cent, cần đã đăng nhập claude)
npm run test:ssh     # nhiều máy qua sshd THẬT + Claude thật (cần openssh-server, root: scripts/live/ssh-sandbox.sh up)
npm run package      # agentroom-<version>.vsix
```

Mở thư mục này trong VS Code → F5 (Run Extension). Trong cửa sổ mới:

1. Mở một project → `Ctrl+Shift+P` → **AgentRoom: Tạo cấu hình workers mẫu**
2. Sửa `.agentroom/workers.yaml` (account, worker, model) và viết `.agentroom/agents/<id>/SOUL.md`
3. Mở biểu tượng AgentRoom ở activity bar → nhắn tin. Không @mention thì coordinator (`lead`) nhận; `@be`, `@qa`, `@all` để gọi trực tiếp.

## Cấu hình

```yaml
accounts:
  claude-main: { provider: claude, maxConcurrent: 2 }        # home: ~/.claude-team → CLAUDE_CONFIG_DIR
  codex-main:  { provider: codex,  maxConcurrent: 1, budgetUsdPerDay: 10 }
workers:
  - id: be
    name: Minh
    role: Backend Developer
    account: claude-main
    worktree: true                     # git worktree riêng: .agentroom/worktrees/be
    color: "#e5703a"                   # tuỳ chọn: màu trong chat (bỏ trống = tự gán)
    tools: [Read, Grep, Glob, Edit, Write, Bash]   # tuỳ chọn: built-in tool được nạp (mỗi tool tốn token ở mọi lượt); mặc định bộ lõi này
    autonomy: auto                     # manual (mặc định) | auto. `full` chỉ bật được ở giao diện/daemon, không bật qua file này
    skills: [Node.js, SQL]             # thẻ mô tả hiển thị cho đồng đội
    useSkills: [prisma-migration]      # skill thật: .agentroom/skills/prisma-migration/SKILL.md
    allowedTools: [Read, Grep, Glob, "Edit(apps/api/**)"]   # tool khác phải được duyệt trên UI
    instructions: Viết code kèm test.
hosts:                                 # máy khác chạy worker qua SSH (xem docs/MULTI-MACHINE.md)
  gpu-box: { ssh: "dev@gpu-box.example.com", repo: /home/dev/app }
# accounts: gpu-claude: { provider: claude, host: gpu-box }   rồi worker dùng account đó sẽ chạy trên gpu-box
schedules:
  - { id: nightly-tests, worker: qa, cron: "0 2 * * 1-5", timezone: Asia/Ho_Chi_Minh, prompt: Chạy toàn bộ test }
webhooks:
  - { id: ci-failed, worker: lead, secretEnv: AGENTROOM_HOOK_SECRET, readOnly: true, match: { "workflow_run.conclusion": failure }, prompt: "CI fail ở {{workflow_run.head_branch}}" }
```

Schema đầy đủ: `docs/SETUP-GUIDE.md` (Bước 5.1). Mỗi worker còn có `workdir` (clone riêng, kể cả trên cùng máy).

### Thư mục `.agentroom/`

| Đường dẫn | Nội dung | Commit? |
|---|---|---|
| `workers.yaml` | cấu hình | ✔ |
| `skills/<tên>/SKILL.md` | skills của đội (`_drafts/` = bản nháp chờ duyệt) | ✔ |
| `agents/<id>/SOUL.md`, `MEMORY.md` | tính cách, trí nhớ dài hạn | ✔ |
| `team/MEMORY.md` | trí nhớ chung | ✔ |
| `agents/<id>/journal/` | nhật ký ngày | ✘ |
| `state/` | chat, task, session, `usage.jsonl`, `turns/` (cho Inspector), `schedules.json`, `room.lock` | ✘ |
| `worktrees/`, `.plugin/` | worktree của worker, plugin skills tự sinh | ✘ |

### Settings

`agentroom.maxAgentHops`, `agentroom.contextMessages`, `agentroom.memoryBudgetChars`, `agentroom.inspector.keepTurns` (0 = tắt), `agentroom.pricing` (giá Codex, USD/1M token; bỏ trống thì Codex chỉ có token), `agentroom.planUsage.pollMinutes`, `agentroom.agentDebounceMs`, `agentroom.hookPort`, `agentroom.claudePath`, `agentroom.codexPath`, và nhóm `agentroom.telegram.*` (chỉ đặt được trong cài đặt người dùng).

### Lệnh

*Tạo cấu hình workers mẫu*, *Nạp lại workers.yaml*, *Dừng tất cả worker*, *Gom trí nhớ worker*, *Tạo skill mới*, *Kiểm tra kết nối các máy (hosts)*, *Chiếm quyền điều phối*, *Telegram — thiết lập / tạo mã ghép cặp / ngắt ghép cặp / đặt PIN / tắt*.

## Tool agent dùng để phối hợp (MCP `agentroom`)

`post_message`, `ask_user`, `read_channel`, `list_tasks`, `create_task`, `claim_task`, `complete_task`, `remember`, `forget`, `recall`, `journal`, `propose_skill`.

## Bảo mật: webhook và dữ liệu không tin cậy

- Chỉ nghe `127.0.0.1`. Muốn nhận từ Internet, tự mở tunnel; mọi webhook đều phải có chữ ký HMAC-SHA256 (`secretEnv`).
- Payload được bọc trong `<untrusted_payload>`, cắt còn 8 KB; `@mention` nằm trong payload không gọi ai.
- `readOnly: true`: worker chỉ có tool đọc (Edit/Write/Bash/Web bị cấm hẳn, không phụ thuộc cài đặt của repo). Câu trả lời và task tạo trong lượt đó **không tự đánh thức** worker nào; bạn đọc rồi nhắn `@<worker> ...` để tiếp tục.
- Với Codex, chế độ chỉ-đọc dựa vào `sandbox: read-only` (chưa kiểm chứng với Codex thật).

## English summary

AgentRoom is a VS Code extension (plus a headless daemon) for a team of AI workers — each a persona running on Claude Code or Codex, several sharing one account — in one group chat. It adds SSH multi-machine workers, Telegram phone control, plan-usage tracking, Manual/Auto/Full autonomy, reply-to-message with option buttons, and token-saving defaults. New in 0.11: a bilingual UI (`agentroom.language`: `vi` default, `en`, `auto`), a local issue collector (`AgentRoom: Report an issue`, `Export issue report`, Telegram `/issues`), and a cleanup tool that **gathers** junk/temp/cache files into `.agentroom/cleanup/` for you to delete yourself — it never deletes anything on its own. Install: `code --install-extension agentroom-0.14.21.vsix`. The docs in `docs/` are in Vietnamese. See `docs/I18N.md` for what is and is not translated.
