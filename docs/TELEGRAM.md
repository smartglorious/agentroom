# Điều khiển AgentRoom từ điện thoại qua Telegram (v0.6)

> Nhắn cho đội AI, nhận tóm tắt, và duyệt các yêu cầu quyền *an toàn* ngay trên điện thoại. Kênh này chạy trong cửa sổ VS Code đang điều phối phòng, nên **máy đó phải bật và VS Code phải mở** (muốn chạy khi VS Code đóng: `agentroom-daemon`, xem `DAEMON.md`).

## 1. Dùng một bot RIÊNG

Mỗi token bot chỉ có **một** nơi được nhận tin. OpenClaw (hoặc chương trình khác) đang nhận tin của bot nào thì AgentRoom không dùng chung bot đó được: hai nơi cùng nhận sẽ gây lỗi 409 và mất tin, còn webhook thì loại trừ polling. AgentRoom **không bao giờ xoá webhook** của bot; gặp trường hợp này nó dừng lại và báo "hãy dùng bot riêng".

Tạo bot thứ hai: chat với `@BotFather` → `/newbot` (miễn phí, một phút).

## 2. Thiết lập (một lần)

1. `@BotFather` → `/newbot` → lấy **token**.
2. Trong VS Code chạy **"AgentRoom: Telegram — thiết lập"** → dán token. Token được kiểm tra bằng `getMe`, rồi lưu trong **kho bí mật** của VS Code (không nằm trong file, không nằm trong repo).
3. Hiện **mã ghép cặp** 6 chữ số. Mở Telegram, vào **chat riêng** với bot và gửi `/pair 123456` (mã hết hạn sau 10 phút).
4. Bot trả lời "✅ Đã ghép cặp". Gõ `/help` để xem lệnh.
5. (Khuyến nghị) **"AgentRoom: Telegram — đặt PIN duyệt quyền"**: 4–8 chữ số, lưu dạng băm.

Trạng thái và các nút (Ghép cặp, PIN, Tắt) nằm ở đầu tab **Máy** trong AgentRoom.

## 3. Dùng hằng ngày

| Bạn làm | Kết quả |
|---|---|
| Nhắn bình thường | Gửi cho worker điều phối (`lead`) |
| `@be làm API đăng nhập` | Gọi đúng worker `be` |
| `/status` | Ai đang làm gì, ở máy nào, chi phí hôm nay, số thẻ chờ duyệt |
| `/tasks` · `/cost` | Task đang mở · chi phí và ngân sách hôm nay |
| `/stop be` · `/stop all` | Dừng một worker · dừng tất cả |
| `/mute 2h` · `/unmute` | Tắt/bật tin của worker (cảnh báo và thẻ duyệt vẫn gửi) |
| `/detail summary\|full\|alerts` | Mức chi tiết gửi về (mục 5) |
| `/budget` | Cho account bị dừng vì ngân sách chạy tiếp hôm nay (có nút bấm) |
| `/unpair` | Ngắt ghép cặp |

AgentRoom gửi về điện thoại:
- **Tóm tắt trả lời** của worker (mã được rút gọn thành `[mã: 30 dòng]`, bí mật bị che). Nút **📄 Xem đầy đủ** gửi toàn văn khi bạn bấm. Tin có `@user` (cần bạn quyết định) kêu chuông, tin còn lại im lặng.
- **Thẻ xin quyền** với nút ✅ / ❌.
- **Cảnh báo**: lỗi worker, mất kết nối máy từ xa, chạm ngân sách, skill đang chờ duyệt, task chưa được kích hoạt.
- Tin của chuỗi **chỉ-đọc** (webhook) mang dấu 🔒 và lời nhắc: nhắn lại `@worker …` để tiếp tục.

Tin bạn nhắn từ điện thoại hiện trong chat VS Code với nhãn 📱. Khung giờ yên lặng (`quietHours`) làm mọi tin đến không kêu.

## 4. Duyệt quyền từ điện thoại

| Yêu cầu | Từ điện thoại |
|---|---|
| Sửa/tạo file **nằm trong thư mục làm việc của worker** (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`) | ✅ và ❌ |
| Cùng loại nhưng file **nhạy cảm**: `.env*`, `.git/`, `.github/`, `.agentroom/`, `.claude/`, `.ssh/`, `.husky/`, `.vscode/`, `*.pem`, `*.key`, `credentials*`, `.npmrc`… | chỉ ❌ |
| File **ngoài** thư mục làm việc, đường dẫn có `..`, hoặc không xác định được thư mục | chỉ ❌ |
| `Bash`, `WebFetch`, `WebSearch`, công cụ MCP khác | chỉ ❌ (duyệt ở máy tính) |

- Từ chối luôn được phép. Cho phép phải qua **chính sách này, được kiểm tra lại ở phía dịch vụ** khi bạn bấm (nút bị làm giả cũng không qua).
- Với worker ở **máy từ xa**, so sánh với thư mục *thật* mà runner báo về, không dựa vào tên đường dẫn.
- Đặt `agentroom.telegram.approveFromPhone = none` để chỉ từ chối được từ điện thoại.
- **PIN**: khi đã đặt, bấm ✅ (hoặc nút cho account chạy tiếp) sẽ hỏi PIN. Tin chứa PIN bị xoá khỏi chat; sai 3 lần thì khoá duyệt từ điện thoại 10 phút. Một dãy số giống PIN gõ khi không có lời nhắc sẽ **không** được gửi vào phòng (và bị xoá), để PIN không lọt vào nhật ký hay ngữ cảnh của agent.
- Thẻ đã được xử lý ở máy tính tự đổi thành "✔ Đã xử lý ở máy tính" và nút cũ báo "hết hạn".

## 5. Bảo mật

| Rủi ro | Biện pháp |
|---|---|
| **Nội dung đi qua máy chủ Telegram** (chat với bot không mã hoá đầu cuối) | Mặc định chỉ gửi tóm tắt, che bí mật, không gửi diff hay file. `full` phải bật chủ động, và bot nhắc rủi ro. Chi tiết thì xem ở máy. |
| Ai đó điều khiển bot | Chỉ **một** người đã ghép cặp, theo **id số** (không phải username), trong **chat riêng**, bằng **văn bản thuần**. Người lạ, nhóm, tin chỉnh sửa, tin chuyển tiếp, ảnh/file đều bị bỏ qua (người lạ không nhận phản hồi nào). |
| Đoán mã ghép cặp | Mã 6 số, một lần dùng, 10 phút, tối đa 5 lần thử rồi huỷ; so sánh thời gian hằng định. |
| Tài khoản Telegram bị chiếm | Duyệt chỉ ở mức an toàn (mục 4) + PIN tuỳ chọn + `/unpair` hoặc **"Ngắt ghép cặp"** ở máy. Đổi token bot (`/revoke`) cũng làm ghép cặp cũ mất hiệu lực. |
| Lệnh cũ bị phát lại sau khi VS Code mở lại | Tin tồn đọng lúc tắt bị **bỏ và thông báo số lượng**, không thực thi. Nút của thẻ cũ báo "hết hạn". |
| Cấu hình do repo lạ đặt | Mọi cài đặt Telegram có `scope: machine` nên **workspace không ghi đè được**; token và PIN nằm trong kho bí mật; `workers.yaml` chứa token bị validator báo lỗi. |
| Token lộ qua log/lỗi | Token bị che khỏi mọi thông báo lỗi. |
| Nội dung worker chứa liên kết/định dạng độc | Gửi văn bản thuần, tắt xem trước liên kết. |
| Gửi dồn làm Telegram chặn | Mỗi chat khoảng 1 tin/giây, tuân theo `retry_after`, tin yên lặng bị bỏ bớt khi quá tải (thẻ duyệt và cảnh báo không bao giờ bị bỏ). |

## 6. Cài đặt (chỉ đặt được trong cài đặt người dùng)

| Khóa | Mặc định | Ý nghĩa |
|---|---|---|
| `agentroom.telegram.enabled` | `false` | Bật kênh |
| `agentroom.telegram.detail` | `summary` | `summary` · `full` · `alerts` |
| `agentroom.telegram.approveFromPhone` | `safe` | `safe` · `none` |
| `agentroom.telegram.summaryChars` | `600` | Độ dài tối đa bản tóm tắt (100–3000) |
| `agentroom.telegram.quietHours` | `""` | Ví dụ `22:00-07:00` |

Lệnh: *Telegram — thiết lập*, *tạo mã ghép cặp*, *ngắt ghép cặp*, *đặt PIN duyệt quyền*, *tắt*.

## 7. Một cửa sổ, một bot

Dịch vụ chỉ chạy ở cửa sổ **đang giữ quyền điều phối** (khóa phòng, xem `MULTI-MACHINE.md` mục 7), nên hai cửa sổ không cùng "tranh" một bot. Mở VS Code ở thư mục khác với cùng token thì cửa sổ sau báo xung đột.

## 8. Đã kiểm chứng gì và chưa

Đã kiểm chứng (`npm test` và `npm run test:live -- telegram`):
- **Máy chủ Bot API giả lập** (JSON, long polling xác nhận bằng offset, 409 khi có poller/webhook khác, giới hạn 4096 ký tự và 64 byte `callback_data`, 429 `retry_after`, "message is not modified"): ghép cặp, người lạ, nhóm, chuyển tiếp, tin tồn đọng, nút, lệnh, PIN và khoá, ngân sách, xung đột, mất mạng, tin dài.
- **Claude thật phía sau Telegram giả**: tin từ điện thoại tới worker và tóm tắt quay về; `Write` trong thư mục worker có nút ✅ và hoạt động; `.env` và `Bash` chỉ có ❌; ✅ giả mạo bị từ chối; duyệt ở máy tính vẫn chạy và thẻ trên điện thoại được cập nhật.
- Giao diện (thẻ Telegram, mã ghép cặp, trạng thái xung đột, nhãn 📱) trong Chromium.

**Chưa kiểm chứng:**
- **Chưa thử với Telegram thật**: môi trường dựng không tới được `api.telegram.org`. Máy chủ giả được viết theo hiểu biết của tôi về Bot API (4096 ký tự, 64 byte, ~1 tin/giây/chat, long polling, mã lỗi 401/409/429) và chưa đối chiếu với tài liệu chính thức. **Hãy thử một vòng đầy đủ với bot thật** (ghép cặp, nhắn, duyệt, `/status`) trước khi dựa vào nó.
- Các lệnh VS Code (hộp nhập token, hiện mã) chưa chạy trong VS Code thật.
- Chính sách đường dẫn không theo **symlink**: một đường dẫn nằm trong thư mục làm việc nhưng là liên kết trỏ ra ngoài vẫn được coi là "bên trong".
- Chưa hỗ trợ nhóm/chủ đề (topic), ảnh, file, giọng nói.

## 9. Chạy không cần VS Code

Đã có (v0.7): `agentroom-daemon` tách phần điều phối khỏi VS Code để Telegram, lịch và webhook chạy cả khi bạn không mở VS Code. Xem `docs/DAEMON.md`. Daemon có kho token/PIN/ghép cặp riêng (phải ghép cặp một lần).

## 10. Xử lý sự cố

| Triệu chứng | Cách xử lý |
|---|---|
| "Token bot không hợp lệ" | Dán lại token (`/token` ở BotFather để xem, `/revoke` để tạo mới). |
| "Bot đang được một chương trình khác nhận tin" | Dùng bot **riêng**; hoặc dừng chương trình kia; hoặc bot đang có webhook. AgentRoom không tự xoá webhook. |
| Bot không trả lời `/pair` | Mã hết hạn hoặc chưa tạo (tạo mã mới); phải là chat **riêng** với bot; không phải nhóm. |
| Không nhận thông báo | Cửa sổ đang giữ phòng chưa mở/đã bị chiếm; xem trạng thái ở tab Máy; kiểm tra `/mute` và `quietHours`. |
| Bấm ✅ nhưng báo "Chỉ duyệt ở máy tính" | Yêu cầu không thuộc nhóm an toàn (mục 4); duyệt ở VS Code. |
| "Đang khoá" | Sai PIN 3 lần; chờ 10 phút. |
| Tin gửi lúc VS Code tắt không được xử lý | Đúng thiết kế: tin tồn đọng bị bỏ và thông báo, nhắn lại nếu cần. |
