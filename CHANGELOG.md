# Lịch sử phiên bản

Mỗi phiên bản có một mục ở đây **và** README được cập nhật cho khớp (bản cài `.vsix`, bảng tính năng, danh sách tài liệu, settings). `test/readme.test.ts` kiểm tra điều này.

## 0.14.6
- **Account Claude dùng endpoint khác** (`baseUrl` + `authTokenEnv`): chạy worker Claude Code với model khác qua cổng tương thích API Anthropic, ví dụ DeepSeek (`https://api.deepseek.com/anthropic`). Token ở biến môi trường (chỉ ghi tên biến vào YAML); khóa Anthropic không bao giờ bị gửi sang endpoint đó; không đo gói đăng ký cho account này. **Chưa kiểm chứng với DeepSeek thật** (chưa có khóa); chỉ test phần dựng biến môi trường và cấu hình. Cũng sửa `scripts/validate-agentroom.mjs`: `contextLimit` không còn bị báo là khóa lạ.

## 0.14.5
- **Lệnh "AgentRoom: Đo context cố định của session mới (không tốn hạn mức)":** với mỗi worker Claude, khởi động CLI như một lượt thật nhưng luồng input không bao giờ gửi tin, nên **model không được gọi và không tốn hạn mức**; CLI chỉ báo cái gì sẽ chiếm cửa sổ (system prompt, tool, CLAUDE.md/memory, skill, MCP). Kết quả ở `.agentroom/state/context-report.md`. Đã kiểm chứng với CLI thật (khoảng 2 giây, không có tin nào của assistant). Không đo được worker Codex hoặc worker trên máy từ xa (nói rõ trong báo cáo). Dùng khi hạn mức đang cạn.

## 0.14.4
- Thêm logo PNG cho trang extension trên VS Code Marketplace.
- **Đo context cố định của session Claude mới:** lượt đầu của mỗi session mới ghi lại CLI báo gì đang chiếm cửa sổ (system prompt, tool, CLAUDE.md/memory, skill, MCP…); xem ở nút 🔍 (Context Inspector), mục "Context cố định". Lý do: trên log thật mỗi session mới đã ~70–125 nghìn token trước khi worker làm gì (không phải prompt của AgentRoom, chỉ ~5 nghìn), và mức này bị đọc lại ở mọi lần gọi. Đã kiểm chứng `getContextUsage` với CLI thật ở thời điểm `init` (sau `result` thì phiên đã đóng).
- Tin hệ thống dành cho người dùng (cảnh báo gói, ♻️, 🧯 …; không gửi ai) không còn đưa vào prompt của worker.

## 0.14.3
- `cc` viết giữa dòng ("@lead @user cc @fw @be: …") cũng không đánh thức người đứng sau chữ `cc`, không chỉ dòng bắt đầu bằng `cc:`. Phát hiện từ log thật: model hay viết kiểu này nên `fw`/`be` vẫn bị gọi dậy chỉ để trả `[NOOP]`.

## 0.14.2
- **Bớt đánh thức worker không cần thiết** (mỗi lần một worker được gọi, nó đọc lại cả session: trên log thật, 38 lượt cho 5 tin của người dùng, ~11 triệu token cache đọc, 13 lượt chỉ để nói "không có việc cho mình"). (1) Dòng bắt đầu bằng `cc:`/`FYI:` trong tin của worker không đánh thức ai. (2) Một tin của worker đánh thức tối đa `limits.maxFanout` (mặc định 3) người. (3) `limits.chainTurns` mặc định 10 → 6. (4) Gom tin `agentroom.agentDebounceMs` mặc định 1500 → 8000 ms (các tin đến gần nhau được trả lời trong một lượt). (5) Persona dặn: chỉ @ người phải làm ngay, dùng `cc:` để báo, tin tối đa ~10 dòng. Persona đổi nên session của mọi worker bắt đầu lại một lần. Tin của người dùng không bị giới hạn. **Chưa đo mức tiết kiệm thật**; cần so lại `usage.jsonl` sau một buổi làm việc.

## 0.14.1
- **Đổi session khi context quá lớn (Claude):** mỗi lần gọi trong một session đọc lại toàn bộ context nên session sống lâu làm mọi lượt sau đắt hơn (trên log thật, `fw`/`be` đọc ~520–570 nghìn token cache mỗi lượt). Khi context ước tính của một lượt (trung bình mỗi lần gọi) vượt `contextLimit` của worker (mặc định 150000 token; **điều phối viên mặc định không bị đổi**; `0` = tắt), session bị bỏ và lượt sau bắt đầu session mới, nhận lại trí nhớ, nhật ký và chat gần đây như khi persona đổi. Chat có một dòng hệ thống báo việc này.
- **Cắt output Bash:** đặt `BASH_MAX_OUTPUT_LENGTH=15000` (mặc định của Claude Code là 30000) cho tiến trình Claude, trừ khi bạn đã đặt biến này. **Chưa đo mức tiết kiệm thật** và chưa kiểm chứng biến này với bản CLI của bạn.
- Thông báo "Không tìm thấy CLI" có gợi ý `where`/`which`.

## 0.14.0
- Panel của plugin có nút và form (`actions`, `form`, `badge`, `onAction`): host kiểm mọi giá trị trước khi gọi plugin, UI không chọn được hàm để gọi. Không đổi hành vi bản công khai (không có plugin nào). Xem `docs/EXTENSIONS.md`.

## 0.13.1
- **Sửa chi phí Claude bị cộng dồn:** `total_cost_usd` của Claude CLI là tổng tích lũy của cả session, nhưng trước đây mỗi lượt ghi nguyên số đó nên tab Chi phí và ngân sách phình lên nhiều lần khi session dài (trên một log thật: $201 hiện ra so với ≈ $22,6 thực). Giờ mỗi lượt ghi phần chênh lệch so với lượt trước của cùng session (`sessionId`, `costCum` trong `usage.jsonl`); log cũ được sửa trong bộ nhớ khi nạp (file không bị đổi; suy ra session mới khi số giảm). Token không bị ảnh hưởng. **Chưa kiểm chứng với tài liệu chính thức của SDK**: dựa trên dữ liệu thật (chuỗi chi phí tăng đơn điệu trong mỗi session, lượt 8 token ra vẫn "tốn" $5).

## 0.13.0
- Điểm mở rộng (tiếp): lệnh chat `/tên` do plugin đăng ký (gõ trong chat hoặc Telegram, không bao giờ gửi cho worker; kết quả là tin hệ thống không chứa `@`), sự kiện `onApproved` sau khi một lệnh gọi tool được duyệt, và `setBranchNamer` đặt tên nhánh cho worktree mới. Xem `docs/EXTENSIONS.md`.

## 0.12.0
- Điểm mở rộng (plugins): guard trước khi worker dùng tool (chỉ siết, không nới), tab chỉ-xem do plugin đóng góp, phần `ext:` trong `workers.yaml`, `agentroom:plugins` giải lúc build. Bản công khai không có plugin nào. Xem `docs/EXTENSIONS.md`.

## 0.11.1
- Sửa Windows: `spawn …\codex ENOENT` (Codex không chạy, không hiện usage). Trên Windows `findExecutable` không còn trả file `codex` không đuôi của npm (là script sh) mà tìm `codex.exe` thật sau shim `.cmd`; lỗi spawn có gợi ý đặt `agentroom.codexPath`. **Chưa kiểm chứng trên Windows thật** (chỉ test bằng cây thư mục giả).

## 0.11.0
- Giao diện hai ngôn ngữ Việt/Anh (`agentroom.language`; mặc định `vi`), webview, hộp thoại, tin hệ thống, Telegram, CLI daemon; `package.nls*.json` cho Command Palette.
- Bộ gom lỗi/vấn đề cục bộ (`issues`): tự ghi lỗi lượt/Telegram/rate limit/chạm giới hạn, gộp trùng, ẩn bí mật, xuất Markdown; nút ⚑, lệnh VS Code, Telegram `/issue` `/issues`, CLI daemon.
- Bộ dọn dẹp **gom, không xóa**: file rác/tạm/cache được di chuyển vào `.agentroom/cleanup/<lô>/` khi chủ máy yêu cầu; có khôi phục.
- Quy tắc: README + CHANGELOG cập nhật theo từng version (`test/readme.test.ts`).
- Sửa một test Telegram không ổn định (đợi tin xác nhận ghép cặp).

## 0.10.0
- Trả lời đúng tin (↩), lựa chọn bằng nút (`ask_user`), cả trên Telegram.
- Bớt lượt vô ích: giới hạn lượt/task, `[NOOP]`, chống lặp, gom tin.
- Tối ưu token: bộ tool tường minh, system prompt ổn định giữa các lượt.

## 0.9.0
- Mức tự chủ Manual / Auto / Full cho từng worker, nhật ký `audit.jsonl`.

## 0.8.0
- Theo dõi hạn mức gói Claude / Codex theo từng account.

## 0.7.1
- Mỗi worker một màu trong chat.

## 0.7.0
- Chương trình nền `agentroom-daemon`.

## 0.6.0
- Kênh Telegram.

## 0.5.0
- Worker trên nhiều máy qua SSH, khóa phòng.

## 0.4.0
- Trí nhớ bằng file, skills thật, chi phí, Context Inspector, cron, webhook.
