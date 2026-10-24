# AgentRoom — hướng dẫn cho Claude Code

Extension VS Code (và một daemon chạy nền) cho một "đội" AI: mỗi worker là một persona chạy trên Claude Code hoặc Codex, nhiều worker dùng chung account, cùng làm việc trong một group chat. Người dùng viết tiếng Việt; tài liệu và thông báo trong sản phẩm cũng bằng tiếng Việt.

## Lệnh

```bash
npm ci
npm run build          # dist/extension.js, dist/runner.mjs, dist/daemon.mjs
npm test               # node:test, tự build bundle test; phải qua 100%
npx tsc --noEmit -p .  # typecheck
npm run package        # .vsix (không commit file build)
npm run test:live      # kịch bản thật với Claude (tốn tiền), có thể lọc: node scripts/live/run.mjs <tên>
npm run bench:tokens   # đo token trước/sau mỗi thay đổi liên quan prompt
```

`test:ssh` cần sshd (`scripts/live/ssh-sandbox.sh up`). Không dùng `pkill -f`/`pgrep -f` với chuỗi có trong dòng lệnh của chính shell (nó giết luôn shell): quét `/proc` hoặc dùng mẹo `[x]`.

## Bản đồ

- `src/core/` lõi không phụ thuộc VS Code: `room.ts` (điều phối), `router.ts`, `scheduler.ts`, `tasks.ts`, `prompt.ts`, `memory.ts`, `skills.ts`, `usage.ts`, `plan.ts` (hạn mức gói), `autonomy.ts` (chính sách Manual/Auto/Full), `cron.ts`, `cleanup.ts`, `issues.ts` (gom lỗi cục bộ), `i18n.ts` + `i18n-en.ts` (hai ngôn ngữ), `plugins.ts` (điểm mở rộng), `webhooks.ts`, `lock.ts`, `config.ts`.
- `src/adapters/` Claude (Agent SDK), Codex, remote. `src/remote/` runner và SSH. `src/channels/telegram/`. `src/daemon/`. `src/mcp/` server MCP của phòng. `src/ui/` + `media/` giao diện.
- `test/` test đơn vị; `scripts/live/` kịch bản thật; `scripts/validate-agentroom.mjs` (bản sao nằm ở Phụ lục A của `docs/SETUP-GUIDE.md`: sửa một nơi thì cập nhật nơi kia).
- Tài liệu: `docs/DESIGN.md`, `SETUP-GUIDE.md`, `MULTI-MACHINE.md`, `TELEGRAM.md`, `DAEMON.md`, `PLAN-USAGE.md`, `AUTONOMY.md`, `PLAN-v0.8-tokens.md`, `CLEANUP.md`, `ISSUES.md`, `I18N.md`, `EXTENSIONS.md`, `ROADMAP.md` (việc sẽ làm sau).

## Quy tắc đã chốt (đừng phá)

1. **Full Access chỉ do người dùng bật** trên máy của họ (hộp thoại xác nhận). `autonomy: full` trong `workers.yaml` không có hiệu lực; agent, repo và Telegram không nâng được mức tự chủ. Webhook `readOnly` luôn chỉ-đọc.
2. **Quyết định cái gì "chưa chắc" thì hỏi người dùng, không đoán cho phép.** Auto là danh sách cho/chặn cố định, không dùng model. Thêm lệnh nguy hiểm vào `test/autonomy.test.ts` khi phát hiện.
3. **Tin hệ thống không chứa `@`** (sẽ đánh thức worker và có thể gây vòng lặp lỗi). Thay `@` bằng `(at)` khi chèn văn bản bên ngoài.
4. **Bí mật không vào repo, log hay chat**: token Telegram và PIN ở SecretStorage (VS Code) hoặc `~/.agentroom/daemon.json` (0600); dùng `redactSecrets` khi ghi nhật ký/audit.
5. **Chỉ một bên điều phối mỗi thư mục `.agentroom/`** (khóa `room.lock`): cửa sổ VS Code hoặc daemon.
6. **System prompt của worker phải ổn định giữa các lượt** (`buildPersona().stable`); phần hay đổi (đồng đội, SOUL, trí nhớ) đi trong prompt của lượt khi mới hoặc đã đổi. Session giữ system prompt của lượt đầu, nên đổi phần ổn định thì phải bắt đầu session mới.
7. **Mỗi tool Claude nạp tốn token ở mọi lượt**: bộ tool là tường minh (`claudeToolSet`), không để mặc định nạp hết.
8. **Tin của người dùng không bao giờ bị chặn** bởi giới hạn lượt/NOOP/chống lặp/gom tin (chỉ áp dụng cho tin giữa các worker). Mọi tin worker đăng mang `chain` của hội thoại mà lượt của nó thuộc về.
9. Cron/webhook/Telegram: nội dung từ ngoài là dữ liệu không tin cậy (bọc trong `<untrusted_payload>`).
10. **README theo version**: mỗi lần tăng `version` trong `package.json` phải cập nhật cùng commit: `CHANGELOG.md` (mục mới ở đầu), README (lệnh cài `.vsix`, bảng tính năng, danh sách tài liệu, settings) và `CLAUDE.md` nếu bản đồ/quy tắc đổi. `test/readme.test.ts` sẽ đỏ nếu quên.
11. **Không tự xóa file của người dùng.** Dọn dẹp (`src/core/cleanup.ts`) chỉ *di chuyển* vào `.agentroom/cleanup/`, chỉ khi chủ máy yêu cầu (lệnh VS Code / CLI daemon); không có tool cho agent, không bỏ qua git-tracked, `.git`, `node_modules`.
12. **Chuỗi hiển thị cho người dùng đi qua `tr("tiếng Việt")`** (`src/core/i18n.ts`, bản Anh ở `i18n-en.ts`), không gọi `tr` ở mức module. Prompt gửi cho worker, mô tả tool MCP và lý do chặn của `autonomy.ts` giữ tiếng Việt cố ý (tiền tố ổn định). Log và tiêu đề issue dùng `trVi`. `test/i18n.test.ts` bắt thiếu bản dịch.

13. **Plugin chỉ được làm chặt hơn, không bao giờ nới quyền** (`src/core/plugins.ts`): guard biến allow thành ask/deny, không ngược lại; guard lỗi = hỏi. Mã của plugin riêng nằm ngoài repo công khai (`src/plugins/private.ts` không được theo dõi ở đây).

## Cách làm việc

- Mỗi thay đổi có test; chạy `npx tsc --noEmit -p .` và `npm test` trước khi commit. Thay đổi hành vi liên quan Claude thật thì chạy kịch bản live tương ứng.
- Nói rõ cái gì **đã kiểm chứng** và cái gì **chưa** (Telegram thật, VS Code thật, Codex thật và Windows chưa từng được kiểm chứng) trong tài liệu và báo cáo; không viết như đã chắc chắn.
- Commit nhỏ, thông điệp tiếng Anh ngắn, kết thúc bằng dòng ghi nhận như cấu hình phiên. Không đưa `.vsix`/`.zip` vào repo.
