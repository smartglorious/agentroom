# Việc sẽ làm sau (chưa làm)

## Daemon: một bot Telegram cho nhiều project

**Vấn đề hiện tại.** Mỗi token bot chỉ có một nơi nhận tin (`getUpdates`), nên mỗi project chạy cùng lúc cần một bot riêng. Token lưu trong `~/.agentroom/daemon.json` là toàn cục, nên với nhiều project phải đặt `AGENTROOM_TELEGRAM_TOKEN` riêng cho từng tiến trình.

**Hướng làm.**
- Một daemon duy nhất giữ bot và quản lý nhiều phòng (mỗi thư mục `.agentroom/` vẫn một khóa `room.lock`, nguyên tắc 5).
- Danh sách project đăng ký trong `daemon.json` (`agentroom-daemon add-project <thư mục>`), mỗi project có tên ngắn.
- Telegram chọn project: `/project <tên>` (mặc định project gần nhất), hoặc tiền tố `#tên` trong tin; `/status` tổng hợp mọi project; thẻ duyệt và cảnh báo ghi rõ tên project.
- Ghép cặp, PIN và `/mode` chỉ-hạ giữ nguyên ở mức toàn daemon; quyền duyệt từ điện thoại vẫn tính theo từng project.
- Cách ly: tin và lệnh của project A không bao giờ lọt vào phòng B (cần test riêng); `<untrusted_payload>` và nguyên tắc 1, 8, 9 giữ nguyên.

**Chưa quyết.** Đặt tên và chọn project mặc định thế nào cho ít nhầm nhất; có cho mỗi project ép dùng bot riêng không.

Còn lại từ `PLAN-v0.8-tokens.md`: S3–S7, S9, S10.
