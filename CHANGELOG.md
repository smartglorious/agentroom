# Lịch sử phiên bản

Mỗi phiên bản có một mục ở đây **và** README được cập nhật cho khớp (bản cài `.vsix`, bảng tính năng, danh sách tài liệu, settings). `test/readme.test.ts` kiểm tra điều này.

## 0.14.15
Gói giảm đốt hạn mức, rút ra từ số đo thật của một dự án 23 giờ (374 lượt): 81% lượng ghi cache nằm ở 72 lượt, và 22 lượt nối lại session to sau hơn 60 phút nghỉ chiếm 42%. Phép kiểm trên log cho thấy cache sống khoảng **1 giờ** trên gói (nghỉ 5–60 phút chỉ nguội ~10% số lượt, trên 60 phút nguội 100%), không phải 5 phút như đã giả định trước đây.
- **`limits.idleFreshMinutes` (mặc định 55):** session Claude to (≳ 66k token) bị đánh thức sau thời gian nghỉ này thì lượt sau mở **session mới** thay vì nạp lại toàn bộ, kèm thông báo 🕒. Áp dụng cho cả điều phối viên (vốn không bị xoay theo `contextLimit`). Không áp cho account `baseUrl`. Mô phỏng trên dữ liệu thật ước tính tiết kiệm khoảng 2,2M token ghi cache (~30%), **chưa đo thật sau thay đổi**. Đổi lại worker mất hội thoại chi tiết, chỉ còn trí nhớ, nhật ký và 30 tin gần nhất.
- **`limits.maxModelTurns` (mặc định 60):** giới hạn số lần gọi model trong một lượt Claude (có lượt thật lên tới 33). Chạm giới hạn thì lượt dừng nhưng **giữ lại** phần đã làm, chi phí và session (trước đây `error_max_turns` sẽ bị coi là lỗi); nhắn "tiếp tục" để làm tiếp. Truyền qua cả worker chạy trên máy SSH. `0` = tắt.
- **Mention không còn đánh thức nhầm:** trong tin của worker, tên trong **dòng bảng markdown** (`| @be | … |`) và trong **dòng mở đầu bằng điều kiện** ("Nếu…", "If…", "Trường hợp…") không gọi ai nữa (như `cc:`). Tin của người dùng không bị lọc. Lưu ý: bảng giao việc dạng `| @be | làm X |` giờ không đánh thức; muốn gọi thì @mention ngoài bảng.
- **Không đánh thức hai lần:** người mà worker đã gọi bằng `post_message` trong lượt không bị gọi lại bởi câu trả lời cuối của chính lượt đó (tin vẫn đăng, chỉ không đánh thức).
- **Số đo:** 🔍 Inspector hiện chi phí **của lượt** (trước đây là chi phí cộng dồn của session, lệch với nhật ký usage).
- Còn lại chưa làm: `modelUsage` của subagent, lưu usage khi lượt lỗi hoặc bị hủy, gom session theo task.

## 0.14.14
- **Account Codex: `windowsSandbox: unelevated`** ghi đè `[windows] sandbox` của `~/.codex/config.toml` chỉ cho các lượt của AgentRoom, để khắc phục lỗi `CreateProcess … setup refresh had errors` mà không phải sửa cấu hình toàn cục (ảnh hưởng cả Codex app). Kiểm chứng với `codex-cli 0.164.0` rằng khóa `windows.sandbox` nhận `elevated`, `unelevated`, `mxc` qua `-c`. **Chưa kiểm chứng trên Codex Windows của người dùng** (và trên một số máy `unelevated` cũng lỗi theo báo cáo cộng đồng).

## 0.14.13
- **Codex: công cụ của phòng được duyệt sẵn.** `codex exec` không hỏi được ai nên các lệnh gọi `post_message`, `claim_task`… của máy chủ MCP `agentroom` bị từ chối vì cần duyệt, dù `approvalPolicy` là `never`. Giờ cấu hình thread có `default_tools_approval_mode = "approve"` cho máy chủ này (Claude vốn đã duyệt sẵn). Kiểm chứng với `codex-cli 0.164.0`: giá trị hợp lệ, khóa lạ bị bỏ qua nên bản cũ không lỗi. **Chưa kiểm chứng trên Codex của người dùng** (Windows).
- **Codex trên Windows:** lỗi `CreateProcess … setup refresh had errors` (sandbox lỗi dựng) giờ kèm gợi ý đặt `[windows] sandbox = "unelevated"` trong `~/.codex/config.toml` (theo báo cáo cộng đồng, chưa kiểm chứng), hoặc `sandbox: danger-full-access` cho worker như phương án cuối.

## 0.14.12
- **Sửa dừng nhầm account Claude:** `PlanMonitor` tạm dừng cả account khi **bất kỳ** cửa sổ hạn mức nào chạm 100%, kể cả cửa sổ không tên (ví dụ `iguana_necktie`, reset sau 12 ngày) hoặc cửa sổ theo model. Trên máy một người dùng cửa sổ không tên này về 0% và tất cả worker Claude bị dừng đến ngày reset, trong khi `claude -p` với `sonnet` và `haiku` vẫn chạy bình thường (đã kiểm chứng bằng tay). Giờ chỉ các cửa sổ `five_hour` và `seven_day` mới tạm dừng account; cửa sổ khác chỉ báo một dòng ℹ️. Nếu CLI từ chối thật thì lỗi rate limit của nó vẫn được xử lý như trước (chờ hoặc chuyển sang `fallback`).

## 0.14.11
- Mục "Context cố định" trong 🔍 (lượt đầu của session Claude mới) giờ được đo **sau phản hồi đầu tiên** của model (CLI báo đúng những gì đã gửi, tổng khớp token thực), thay vì chỉ lúc khởi động. Lý do: trên máy một người dùng, lúc khởi động CLI chỉ thấy ~17–25 nghìn token nhưng mỗi session mới thật ra nhận ~90 nghìn ngay ở lượt đầu, và phần ~60 nghìn chênh lệch chưa rõ nằm ở đâu. Đã kiểm chứng với CLI thật (tổng báo 8.424 khớp usage 8.424 trong một lượt thử). Chi phí thêm: một yêu cầu điều khiển đếm token cho mỗi session mới, không gọi model.

## 0.14.10
- **Worker Claude chỉ dùng máy chủ MCP của phòng:** khởi động CLI với `strictMcpConfig` và `disableClaudeAiConnectors`, để CLI không tự nối các connector claude.ai của tài khoản (Figma, Docs, …) và nạp định nghĩa tool của chúng vào mọi session. Lý do: trên máy một người dùng, `claude mcp list` thấy 2 connector claude.ai đang kết nối cùng nhiều server plugin, và mỗi session mới `claude-main` nặng ~85–135 nghìn token trong khi bảng đo chỉ thấy 15–25 nghìn. **Chưa đo mức giảm thật** (chỉ kiểm chứng CLI chấp nhận cờ và test dựng tùy chọn). Muốn giữ connector: đặt biến môi trường `AGENTROOM_KEEP_CONNECTORS=1`.

## 0.14.9
- **Sửa đổi session liên tục (0.13.2):** nếu một session mới đã nặng hơn `contextLimit` ngay từ lượt đầu (trên log thật ~85–95 nghìn token khi giới hạn là 80000) thì trước đây nó bị thay ở **mọi lượt** và mỗi lần ghi lại toàn bộ cache. Giờ session chỉ bị thay khi vượt `contextLimit` **và** đã lớn hơn 1,5 lần kích thước lượt đầu của chính nó (đo trong lần chạy hiện tại).
- Ghi vào `docs/PLAN-v0.8-tokens.md` số đo đầu tiên nối token với phần trăm gói 5 giờ (xem mục "Bổ sung 0.14.9"). Ước lượng thô từ ba cửa sổ, chưa chắc.

## 0.14.8
- **Account dự phòng (`fallback`)**: worker có thể khai báo `fallback: [claude-ds]`. Khi account của worker bị giới hạn (rate limit của lượt đang chạy, gói báo hết, hết ngân sách ngày), các tin đang chờ và tin mới chạy ngay trên account dự phòng đầu tiên còn dùng được; trong chat có dòng 🔀 báo một lần, và ↩️ khi quay về account chính (mỗi lượt đều ưu tiên account chính nếu nó dùng được). Dự phòng phải cùng provider và cùng host; mỗi account dự phòng có session riêng (worker nhận lại trí nhớ, nhật ký và chat gần đây); `model:` của worker không gửi sang account có `baseUrl`. Mặc định không có dự phòng. Một session mới (kể cả sau khi chuyển) luôn bắt đầu từ chat gần đây. **Chưa kiểm chứng với DeepSeek/gói thật**: chỉ có test với bộ điều khiển giả.

## 0.14.7
- **Sửa an toàn (0.14.6):** account có `baseUrl` mà biến `authTokenEnv` chưa có giá trị trong tiến trình thì **không chạy** và báo lỗi rõ. Trước đó CLI sẽ quay về phiên đăng nhập Claude của bạn và gửi nó tới endpoint khác. Nếu bạn đã chạy `claude-ds` khi biến chưa có, nên coi token phiên đăng nhập Claude có thể đã tới endpoint đó và đăng xuất rồi đăng nhập lại Claude.
- **Lượt im lặng quá lâu bị dừng:** `limits.turnIdleMinutes` (mặc định 20, `0` = tắt). Trước đây một CLI treo giữ worker mãi và không báo gì. Thẻ duyệt đang chờ người không tính là im lặng.
- **Không còn im lặng khi worker chạy xong mà không có nội dung** trả lời tin của bạn: có một dòng báo kèm số token.
- **Tự tìm `claude` trong extension Claude Code của VS Code/Cursor** (chọn phiên bản mới nhất) khi không thấy `claude` trong PATH hoặc `agentroom.claudePath` sai. Chưa thử trên Windows thật (chỉ cây thư mục giả).

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
