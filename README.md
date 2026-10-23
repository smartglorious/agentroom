# AgentRoom

Group chat cho một "đội" AI trong VS Code. Mỗi worker là một persona (vai trò, kỹ năng, tính cách, trí nhớ riêng) chạy trên Claude Code hoặc Codex. Nhiều worker dùng chung một account.

Thiết kế và kế hoạch: xem `docs/DESIGN.md` và `docs/PLAN-v0.2.md` trong mã nguồn. Để agent thiết lập cho một project có sẵn: `docs/SETUP-GUIDE.md`.

## Tính năng

| | |
|---|---|
| **Group chat nhiều worker** | `@id` gọi một worker, `@all` gọi tất cả; tin không @mention đến coordinator. Chặn vòng lặp agent↔agent. |
| **Account dùng chung** | Giới hạn chạy song song, tự chờ và chạy lại khi bị rate limit, ngân sách USD theo ngày. |
| **Trí nhớ bền vững** | `SOUL.md`, `MEMORY.md`, nhật ký ngày cho từng worker + trí nhớ chung của đội. Agent ghi qua tool `remember` / `recall` / `forget` / `journal`. |
| **Skills thật** | `useSkills` bật các `SKILL.md` cho đúng worker; agent có thể đề xuất skill mới, chỉ có hiệu lực sau khi bạn duyệt. |
| **Chi phí** | Tab *Chi phí*: token, chi phí, cache hit theo worker / account / model / task / tool. |
| **Context Inspector** | Nút 🔍 trên tin nhắn: xem chính xác những gì đã gửi cho model, chia theo phần, kèm số token. |
| **Lịch chạy** | Cron có timezone, chạy bù khi VS Code vừa mở lại, nút *Chạy ngay*. |
| **Webhook** | `127.0.0.1`, bắt buộc HMAC, chống trùng, giới hạn tần suất, payload coi như dữ liệu không tin cậy, chế độ chỉ-đọc. |
| **An toàn** | Worktree riêng cho từng dev, thẻ duyệt quyền (Claude), sandbox (Codex). |

## Yêu cầu

- VS Code ≥ 1.90
- Đã cài và đăng nhập **Claude Code** (`claude` → `/login`) và/hoặc **Codex CLI** (`codex login`). Extension dùng chính CLI này, nên không gói kèm binary.
  Nếu `claude`/`codex` không nằm trong PATH, đặt `agentroom.claudePath` / `agentroom.codexPath` trong Settings.

## Cài từ file .vsix

```bash
code --install-extension agentroom-0.4.0.vsix
```

Hoặc trong VS Code: Extensions → `…` → **Install from VSIX…** → chọn file.

## Build từ mã nguồn (cần Node ≥ 20)

```bash
npm install
npm run build        # dist/extension.js
npm test             # 59 test: router, scheduler, task board, room, MCP, memory, skills, usage, cron, webhook
npm run test:live    # kịch bản thật với Claude (tốn vài cent, cần đã đăng nhập claude)
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
    skills: [Node.js, SQL]             # thẻ mô tả hiển thị cho đồng đội
    useSkills: [prisma-migration]      # skill thật: .agentroom/skills/prisma-migration/SKILL.md
    allowedTools: [Read, Grep, Glob, "Edit(apps/api/**)"]   # tool khác phải được duyệt trên UI
    instructions: Viết code kèm test.
schedules:
  - { id: nightly-tests, worker: qa, cron: "0 2 * * 1-5", timezone: Asia/Ho_Chi_Minh, prompt: Chạy toàn bộ test }
webhooks:
  - { id: ci-failed, worker: lead, secretEnv: AGENTROOM_HOOK_SECRET, readOnly: true, match: { "workflow_run.conclusion": failure }, prompt: "CI fail ở {{workflow_run.head_branch}}" }
```

Schema đầy đủ: `docs/SETUP-GUIDE.md` (Bước 5.1).

### Thư mục `.agentroom/`

| Đường dẫn | Nội dung | Commit? |
|---|---|---|
| `workers.yaml` | cấu hình | ✔ |
| `skills/<tên>/SKILL.md` | skills của đội (`_drafts/` = bản nháp chờ duyệt) | ✔ |
| `agents/<id>/SOUL.md`, `MEMORY.md` | tính cách, trí nhớ dài hạn | ✔ |
| `team/MEMORY.md` | trí nhớ chung | ✔ |
| `agents/<id>/journal/` | nhật ký ngày | ✘ |
| `state/` | chat, task, session, `usage.jsonl`, `turns/` (cho Inspector), `schedules.json` | ✘ |
| `worktrees/`, `.plugin/` | worktree của worker, plugin skills tự sinh | ✘ |

### Settings

`agentroom.maxAgentHops`, `agentroom.contextMessages`, `agentroom.memoryBudgetChars`, `agentroom.inspector.keepTurns` (0 = tắt), `agentroom.pricing` (giá Codex, USD/1M token; bỏ trống thì Codex chỉ có token), `agentroom.hookPort`, `agentroom.claudePath`, `agentroom.codexPath`.

## Tool agent dùng để phối hợp (MCP `agentroom`)

`post_message`, `read_channel`, `list_tasks`, `create_task`, `claim_task`, `complete_task`, `remember`, `forget`, `recall`, `journal`, `propose_skill`.

## Bảo mật: webhook và dữ liệu không tin cậy

- Chỉ nghe `127.0.0.1`. Muốn nhận từ Internet, tự mở tunnel; mọi webhook đều phải có chữ ký HMAC-SHA256 (`secretEnv`).
- Payload được bọc trong `<untrusted_payload>`, cắt còn 8 KB; `@mention` nằm trong payload không gọi ai.
- `readOnly: true`: worker chỉ có tool đọc (Edit/Write/Bash/Web bị cấm hẳn, không phụ thuộc cài đặt của repo). Câu trả lời và task tạo trong lượt đó **không tự đánh thức** worker nào; bạn đọc rồi nhắn `@<worker> ...` để tiếp tục.
- Với Codex, chế độ chỉ-đọc dựa vào `sandbox: read-only` (chưa kiểm chứng với Codex thật).
