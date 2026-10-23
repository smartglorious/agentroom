# AgentRoom — Thiết kế & Kế hoạch triển khai

> Phần bổ sung v0.2–v0.4 (trí nhớ, skills, chi phí, Inspector, cron, webhook) nằm ở `docs/PLAN-v0.2.md`. Nhiều máy qua SSH (v0.5) ở `docs/MULTI-MACHINE.md`.

> VS Code extension cho phép nhiều **AI worker** (mỗi worker là một persona: vai trò + kỹ năng + hướng dẫn riêng) chạy trên **Claude Code** hoặc **Codex**, dùng chung account, cùng làm việc trong **một group chat**.

## 1. Mục tiêu & phạm vi

| # | Yêu cầu | Cách đáp ứng |
|---|---|---|
| R1 | Mỗi worker = 1 dev / nhân sự có skill cụ thể | `Worker` trong `.agentroom/workers.yaml`: `role`, `skills`, `instructions`, `allowedTools`, `model`; persona được ghép vào system prompt (`src/core/prompt.ts`) |
| R2 | Worker gắn với 1 hoặc nhiều session Claude Code / Codex | Session key = `<worker>:main` hoặc `<worker>:<taskId>`; mỗi key lưu `session_id` (Claude) / `thread_id` (Codex) trong `state/sessions.json` và được resume |
| R3 | Account dùng chung, không phải 1 worker 1 account | `accounts:` tách khỏi `workers:`; nhiều worker trỏ tới một account; `Scheduler` giới hạn `maxConcurrent` và backoff khi bị rate limit |
| R4 | Nhiều worker trong 1 group chat | Webview chat ở sidebar; `Room` route tin nhắn theo @mention / coordinator; agent cũng chủ động nhắn qua MCP tool `post_message` |
| R5 | Không giẫm chân nhau khi sửa code | `worktree: true` → mỗi worker một git worktree riêng trên nhánh `agentroom/<id>` |
| R6 | Con người kiểm soát | Thẻ duyệt quyền (Claude `canUseTool`), nút dừng từng worker, giới hạn hop agent→agent |

**Ngoài phạm vi v0.1:** nhiều người dùng cùng một room qua mạng, chạy agent trong container, tự merge worktree.

## 2. Kiến trúc

```
┌──────────────────────── VS Code ────────────────────────┐
│ Webview (media/main.js)                                 │
│   team bar · chat · tasks · approval cards · composer   │
│              ▲ postMessage / onDidReceiveMessage        │
│ ─────────────┼───────────────────────────────────────── │
│ Extension host (dist/extension.js)                      │
│   ChatViewProvider ── Room (orchestrator) ── RoomStore  │
│                        │   ├ router.ts   (ai trả lời)   │
│                        │   ├ tasks.ts    (task board)   │
│                        │   ├ prompt.ts   (persona/turn) │
│                        │   └ scheduler.ts(quota/backoff)│
│                        ├── ClaudeAdapter ─► claude-agent-sdk ─► Claude Code CLI
│                        ├── CodexAdapter  ─► codex-sdk ───────► codex exec
│                        └── AgentRoomMcp (HTTP 127.0.0.1) ◄── cả hai loại agent gọi tool
└─────────────────────────────────────────────────────────┘
       .agentroom/workers.yaml   .agentroom/state/*   .agentroom/worktrees/<id>
```

### 2.1 Module

| File | Trách nhiệm |
|---|---|
| `src/core/types.ts` | Kiểu dữ liệu: `Account`, `Worker`, `ChatMessage`, `Task`, `WorkerStatus`, `ApprovalRequest` |
| `src/core/config.ts` | Đọc + validate `workers.yaml` bằng zod; cấu hình mẫu |
| `src/core/router.ts` | `parseMentions`, `route`: người dùng → người được mention hoặc coordinator; agent → chỉ người được mention, dừng khi vượt `maxAgentHops` |
| `src/core/scheduler.ts` | Hàng đợi theo account, `maxConcurrent`, phát hiện rate limit, backoff lũy thừa, retry |
| `src/core/tasks.ts` | Task board có dependency: `blocked → todo → in_progress → done`, tự mở task phụ thuộc |
| `src/core/prompt.ts` | Persona prompt (danh sách đồng đội, quy tắc nhóm) + prompt từng lượt (ngữ cảnh room, task của mình, inbox) |
| `src/core/room.ts` | Orchestrator: `post` → lưu → route → inbox theo session → lập lịch lượt → gọi adapter → đăng câu trả lời; duyệt quyền; dừng |
| `src/core/store.ts` | Lưu `chat.jsonl`, `tasks.json`, `sessions.json`, `cursors.json` |
| `src/core/worktree.ts` | Tạo git worktree cho từng worker |
| `src/adapters/claude.ts` | `query()` với `resume`, preset `claude_code` + `append`, `allowedTools`, `canUseTool`, MCP HTTP, `CLAUDE_CONFIG_DIR` |
| `src/adapters/codex.ts` | `startThread` / `resumeThread`, `runStreamed`, sandbox, MCP qua `config.mcp_servers`, `CODEX_HOME` |
| `src/mcp/server.ts` | MCP server streamable HTTP (stateless) với 6 tool phối hợp; URL chứa token + worker id |
| `src/ui/chatView.ts` | `WebviewViewProvider`, CSP + nonce, cầu nối sự kiện Room ↔ webview |
| `src/extension.ts` | Kích hoạt, nạp cấu hình, lệnh `init` / `reload` / `stopAll`, theo dõi file cấu hình |

### 2.2 Luồng một tin nhắn

```
User: "Làm tính năng đăng nhập"            (không mention)
 └─ Room.post(user) → route → [lead] (coordinator)
     └─ inbox["lead:main"] += msg → Scheduler.submit(account=claude-main)
         └─ ClaudeAdapter.runTurn(resume=sessions["lead:main"])
             ├─ lead gọi MCP create_task(title="API login", assignee="be")
             │    └─ Room.post(system, "@be bạn được giao task [T1]…", taskId=T1)
             │         └─ inbox["be:T1"] → session riêng cho task T1 của be
             └─ kết thúc lượt: "Đã chia việc: @be làm API, @fe làm UI sau khi T1 xong"
                  └─ Room.post(lead, depth=1) → route → [be, fe] …
be xong → complete_task(T1) → T2 (UI, dependsOn T1) mở → báo @fe
       → báo creator @lead "task T1 đã xong"
```

### 2.3 Quyết định thiết kế chính

1. **Không broadcast toàn bộ chat cho mọi agent.** Chỉ người được mention / được giao task mới chạy lượt; ngữ cảnh mỗi lượt giới hạn `contextMessages` tin nhắn kể từ lần cuối worker đó xem (`cursors`). Agent cần thêm thì gọi `read_channel`.
2. **Phối hợp bằng tool, không parse text.** Một MCP server chung cho cả Claude và Codex → hành vi giống nhau giữa hai provider.
3. **Gộp inbox.** Worker đang bận mà có thêm tin nhắn → gom lại trả lời trong một lượt (tiết kiệm quota).
4. **Chống vòng lặp.** `depth` tăng mỗi bước agent→agent; vượt `maxAgentHops` thì tin nhắn vẫn hiển thị nhưng không gọi ai.
5. **Một worker, nhiều session.** Mỗi task có session riêng → ngữ cảnh gọn, không lẫn task.
6. **Account là tài nguyên dùng chung.** `Scheduler` coi mỗi account là một "làn" có giới hạn song song; khi Claude báo `rate_limit_event: rejected` thì dừng cả làn tới `resetsAt`.
7. **An toàn.** Claude: tool ngoài `allowedTools` phải được duyệt trên UI. Codex `exec` không có hook duyệt → dùng `sandboxMode` (mặc định `workspace-write`). MCP chỉ nghe `127.0.0.1` và yêu cầu token ngẫu nhiên.

## 3. Bảng kế hoạch chi tiết

Ước lượng tính theo ngày công của 1 dev. ✅ = đã có trong mã nguồn v0.1 (đã build + test).

| Giai đoạn | # | Hạng mục | File chính | Ước lượng | Tiêu chí hoàn thành | Trạng thái |
|---|---|---|---|---|---|---|
| **P0 Nền tảng** | 0.1 | Khung extension, esbuild (SDK external + dynamic import), tsconfig | `package.json`, `esbuild.mjs` | 0.5 | `npm run build` ra `dist/extension.js` | ✅ |
| | 0.2 | Kiểu dữ liệu + cấu hình YAML có validate | `types.ts`, `config.ts` | 0.5 | Cấu hình mẫu parse được; báo lỗi rõ khi sai | ✅ |
| | 0.3 | Lưu trữ room | `store.ts` | 0.5 | Mở lại VS Code vẫn còn chat, task, session | ✅ |
| **P1 Một worker chạy được** | 1.1 | ClaudeAdapter: stream, resume, persona, MCP, env account | `adapters/claude.ts` | 1.5 | Gửi tin → Claude trả lời trong chat; lượt sau nhớ ngữ cảnh | ✅ (cần chạy thử với account thật) |
| | 1.2 | Webview chat: team bar, tin nhắn, composer, @mention | `ui/chatView.ts`, `media/*` | 2 | Gõ @ / click worker để mention; trạng thái realtime | ✅ |
| | 1.3 | Duyệt quyền tool trên UI | `room.ts`, `main.js` | 1 | Edit/Bash ngoài allowlist hiện thẻ Cho phép/Từ chối | ✅ |
| **P2 Nhiều worker** | 2.1 | Router @mention / coordinator / hop limit | `router.ts` | 0.5 | Test: hai agent ping nhau dừng ở giới hạn | ✅ |
| | 2.2 | Scheduler theo account + backoff rate limit | `scheduler.ts` | 1 | Test: không vượt `maxConcurrent`; 429 → chờ → chạy lại | ✅ |
| | 2.3 | Room orchestrator: inbox, session theo thread, dừng worker | `room.ts` | 2 | Test: lead → be → qa → lead, resume đúng session | ✅ |
| | 2.4 | CodexAdapter | `adapters/codex.ts` | 1 | Worker Codex trả lời và resume thread | ✅ (cần chạy thử với account thật) |
| **P3 Phối hợp** | 3.1 | MCP server 6 tool | `mcp/server.ts` | 1.5 | Test bằng MCP client thật qua HTTP | ✅ |
| | 3.2 | Task board có dependency + tab Tasks | `tasks.ts`, `main.js` | 1 | Hoàn thành task → task phụ thuộc mở, người phụ trách được báo | ✅ |
| | 3.3 | Git worktree theo worker | `worktree.ts` | 0.5 | Worker `worktree: true` làm việc trong `.agentroom/worktrees/<id>` | ✅ |
| **P4 Hoàn thiện** | 4.1 | Review diff từng worktree + nút merge | `ui/diff.ts` (mới) | 2 | Mở diff `agentroom/<id>` so với nhánh chính; merge 1 click | ⬜ |
| | 4.2 | Hiển thị chi phí/token theo worker & account | adapters, `main.js` | 1 | Claude `total_cost_usd`, Codex `usage` cộng dồn trên team bar | ✅ (v0.3, xem `PLAN-v0.2.md`) |
| | 4.3 | Tóm tắt ngữ cảnh dài (summary message định kỳ) | `prompt.ts` | 1.5 | Room > N tin nhắn → tự tạo bản tóm tắt dùng làm ngữ cảnh | ⬜ |
| | 4.4 | Template đội ngũ (SOP: PM → Dev → QA), lệnh chọn template | `config.ts` | 1 | `AgentRoom: Init` cho chọn template | ⬜ |
| | 4.5 | Codex qua `codex app-server` để có duyệt quyền tương tác | `adapters/codexAppServer.ts` (mới) | 2 | Lệnh Codex cần duyệt hiện thẻ như Claude | ⬜ |
| | 4.6 | Markdown rendering an toàn trong chat | `main.js` | 1 | Code block, list hiển thị đẹp, không XSS | ⬜ |
| **P5 Phát hành** | 5.1 | Test E2E bằng `@vscode/test-electron` | `test/e2e/*` | 1.5 | CI mở VS Code, gửi tin, nhận trả lời từ adapter giả | ⬜ |
| | 5.2 | Đóng gói theo nền tảng (SDK có binary native) | CI | 1 | `vsce package --target linux-x64/darwin-arm64/win32-x64` | ⬜ |
| | 5.3 | Kiểm tra điều khoản dùng chung account | — | 0.5 | Xác nhận cách đăng nhập hợp lệ trước khi phát hành công khai | ⬜ |

**Tổng:** P0–P3 ≈ 15 ngày công (đã có bản chạy được); P4–P5 ≈ 15 ngày công.

## 4. Rủi ro & cách giảm

| Rủi ro | Ảnh hưởng | Giảm thiểu |
|---|---|---|
| Hết quota vì nhiều worker dùng chung account | Đội ngũ đứng hình | `maxConcurrent`, gộp inbox, chỉ gọi người được mention, backoff theo `resetsAt` |
| Agent nói chuyện vòng vòng | Tốn token | `maxAgentHops`, agent không mention = không gọi ai, nút dừng |
| Hai worker sửa cùng file | Xung đột | Worktree riêng; merge qua review (P4.1) |
| Codex `exec` không có hook duyệt | Lệnh nguy hiểm | `sandbox: workspace-write` hoặc `read-only`; P4.5 chuyển sang app-server |
| API SDK thay đổi | Build hỏng | Ghim version chính xác trong `package.json`; adapter cô lập mỗi provider một file |
| Điều khoản dùng chung subscription | Pháp lý | Một người dùng nhiều session trên account của chính mình; sản phẩm công khai thì dùng API key (`apiKeyEnv`) |
