# Theo dõi hạn mức gói đăng ký (v0.8)

Tab **Chi phí** có phần **Gói đăng ký còn lại**: với mỗi account, các cửa sổ hạn mức (ví dụ 5 giờ, 7 ngày), phần trăm còn lại và thời điểm reset. Telegram: `/plan` (và `/plan refresh`).

## Đo bằng cách nào

| Nhà cung cấp | Nguồn | Chi phí |
|---|---|---|
| **Claude** | Phiên CLI hỏi dữ liệu của lệnh `/usage` qua Agent SDK (`usage_EXPERIMENTAL_…`), kèm tín hiệu `rate_limit_event` trong lúc chạy | Không gửi prompt, **không gọi model, không tốn token**; mỗi lần khoảng 1 giây |
| **Codex** | `codex app-server` (JSON-RPC qua stdio): `initialize` rồi `account/rateLimits/read` | Không gọi model |

Đọc lại: mỗi `agentroom.planUsage.pollMinutes` phút (mặc định 10; 0 = tắt đọc định kỳ), sau mỗi lượt chạy của account đó (cách nhau ít nhất 2 phút), khi Claude báo thay đổi trạng thái hạn mức, và khi bấm **Làm mới**. Tối đa một lần đọc cùng lúc cho mỗi account.

## Điều cần biết

- **Chỉ có phần trăm, không có số token tuyệt đối.** Cả hai nhà cung cấp chỉ báo phần trăm đã dùng của từng cửa sổ và lúc reset. "Còn lại" = 100% trừ phần đã dùng.
- **Chỉ cho đăng nhập bằng gói thuê bao** (Claude Pro/Max/Team/Enterprise; Codex qua tài khoản ChatGPT). Account dùng **API key** hoặc cloud (Bedrock, Vertex…) không có hạn mức gói: thẻ hiện "không có số liệu" và bạn xem chi phí thật ở tab Chi phí.
- **Account chạy trên máy từ xa (`host:`) chưa đo được** từ máy này; thẻ ghi rõ. Chi phí của chúng vẫn có ở tab Chi phí.
- Đọc lỗi (mạng, giới hạn của endpoint) thì **giữ số liệu cũ** và ghi "cũ: N phút trước"; không xoá thẻ.

## Cảnh báo và tự dừng

- Một cửa sổ đạt `warnAtPercent` của account (mặc định 80%): một cảnh báo cho mỗi cửa sổ mỗi chu kỳ reset (hiện trong chat, và về Telegram nếu bật).
- Một cửa sổ đầy 100% **và có giờ reset ở tương lai**: cảnh báo, rồi hàng đợi của account tạm dừng tới lúc reset (thay vì để từng lượt chạy thất bại). Sau khi reset, hàng đợi tự chạy tiếp.

## Daemon

Cùng cơ chế. Cài đặt: `agentroom-daemon set planPollMinutes 10`.

## Đã kiểm chứng gì và chưa

Đã kiểm chứng: ánh xạ dữ liệu của hai nhà cung cấp (kể cả cửa sổ lạ, giá trị > 100, null), bộ giám sát (cảnh báo một lần mỗi chu kỳ, tạm dừng, giãn cách, gộp lần đọc đồng thời, giữ số liệu cũ khi lỗi, tài khoản từ xa), tích hợp vào phòng, văn bản `/plan`, giao thức Codex với một máy chủ giả, và **tiến trình thật**: `claude` CLI thật (không gửi prompt, ~1 giây, không để lại tiến trình, account API key được nhận ra là "không có số liệu") và `codex app-server` thật (chưa đăng nhập → "không có số liệu" kèm gợi ý `codex login`, đóng gọn). Giao diện kiểm bằng Chromium (sáng/tối).

**Chưa kiểm chứng: số liệu thật.** Môi trường dựng không có đăng nhập gói thuê bao Claude hay ChatGPT, nên chưa thấy một phần trăm thật nào từ hai nguồn. Cụ thể chưa kiểm: đơn vị và tên cửa sổ trong dữ liệu thật (tôi dựa vào định nghĩa kiểu của SDK và schema giao thức Codex), độ trễ của endpoint thật, và hành vi khi endpoint bị giới hạn tần suất. API của Claude là **thử nghiệm** (`..._MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`) và có thể đổi hoặc biến mất trong bản SDK sau; khi đó thẻ hiện lỗi thay vì làm hỏng gì khác. Hãy xem thẻ đầu tiên với gói thật và báo tôi nếu số liệu lệch với `/usage` của Claude Code hoặc `/status` của Codex.
