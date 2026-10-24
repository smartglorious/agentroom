# Bớt số lượt giữa các worker (S8)

Đo cho thấy phần tốn token lớn nhất còn lại không phải là mỗi lượt, mà là **số lượt**: các worker nhắn qua lại, mỗi tin có `@mention` đánh thức một worker khác trả lời ("không có việc mới", "đã xác nhận rồi", "cảm ơn"), và một tin của bạn có thể kéo theo hàng chục lượt vô ích. Năm cơ chế dưới đây cắt chuỗi đó mà không đụng tới câu trả lời cho bạn.

| Cơ chế | Việc nó làm | Cấu hình |
|---|---|---|
| **Giới hạn hội thoại** | Mỗi tin của bạn (hoặc lịch/webhook) bắt đầu một "hội thoại"; mọi tin worker đăng khi làm việc đó mang cùng id, kể cả thông báo giao task. Hội thoại đã kéo `chainTurns` lượt thì các worker **thôi đánh thức nhau**, một thông báo 🧯 (cảnh báo, về Telegram nếu bật) nói rõ lý do. Bạn nhắn tiếp là bắt đầu hội thoại mới với hạn mức mới. | `limits.chainTurns` (mặc định 10) |
| **Ngân sách task** | Task đã tốn từ `usdPerTask` USD thì worker thôi tự làm tiếp việc đó với nhau (báo một lần). Bạn vẫn nhắn vào task để tiếp tục. | `limits.usdPerTask` (mặc định tắt) |
| **`cc:` và giới hạn số người được gọi** (0.14.2) | Dòng bắt đầu bằng `cc:` hoặc `FYI:` trong tin của worker không đánh thức ai (người đó vẫn đọc được ở lượt sau). Một tin của worker chỉ đánh thức tối đa `limits.maxFanout` (3) người @mention đầu tiên. Persona dặn: chỉ @ người phải làm gì ngay; tin gửi đồng đội tối đa ~10 dòng, chi tiết dài ghi vào file. | `limits.maxFanout` |
| **`[NOOP]`** | Persona dặn: tin chỉ báo cáo lại, cảm ơn, xác nhận mà không cần làm gì thì trả lời đúng `[NOOP]`, và đừng `@mention` chỉ để cảm ơn. Câu trả lời `[NOOP]` **không được đăng**, không đánh thức ai. | luôn bật |
| **Chống lặp** | Câu trả lời giống hệt (bỏ dấu câu và hoa thường) với một tin trước đó của chính worker trong cùng hội thoại thì không đăng lại. | luôn bật |
| **Gom tin** | Tin từ worker khác không đánh thức worker ngay mà chờ một chút, để các tin đến cùng lúc được trả lời trong **một** lượt thay vì mỗi tin một lượt. | `agentroom.agentDebounceMs` (mặc định 1500; daemon: `agentroom-daemon set agentDebounceMs`) |

Quy tắc an toàn:
- **Tin của người dùng không bao giờ bị chặn hay nuốt.** Giới hạn chỉ áp dụng cho tin giữa các worker. Nếu bạn nhắn một worker và nó trả lời `[NOOP]`, câu trả lời vẫn được đăng (im lặng ở đó là khó hiểu).
- Tin của hệ thống/lịch/webhook bắt đầu hội thoại mới, không bị cộng dồn vào hội thoại cũ.
- Dừng một worker (`■`, `/stop`) cũng hủy các lần đánh thức đang chờ gom.

Lưu ý khi nâng cấp: thêm quy tắc `[NOOP]` vào persona làm đổi phần prompt hệ thống ổn định, nên **mỗi worker bắt đầu một session mới một lần** (mất ngữ cảnh hội thoại của session cũ, trí nhớ và nhật ký thì giữ nguyên).

## Kết quả đo

Cùng kịch bản `npm run bench:tokens`, 3 lần chạy mỗi bản (Claude thật, `haiku`): số lượt **≈ 25 → 16** (−37%), tin worker đăng **≈ 35 → 17** (−52%), tổng token vào **≈ 0,90 → 0,48 triệu** (−47%), chi phí ước tính **$0,093 → $0,036** (−61%). Tính từ bản gốc trước mọi tối ưu: tổng token vào −77%, chi phí −80%. Model làm theo quy tắc `[NOOP]` (2–8 câu trả lời mỗi lần chạy bị chặn không đăng). Chi tiết và giới hạn của phép đo ở `PLAN-v0.8-tokens.md` mục 0.1.

## Đã kiểm chứng gì và chưa

Đã kiểm chứng bằng test: giới hạn hội thoại (dừng đúng số lượt, báo một lần, không có `@` trong thông báo, người dùng bắt đầu hội thoại mới được; id hội thoại đi theo cả thông báo giao task), ngân sách task (chặn tin giữa worker, người dùng vẫn tiếp tục được), `[NOOP]` (không đăng, không đánh thức; vẫn đăng khi người dùng hỏi), chống lặp, gom tin (hai tin thành một lượt; tin người dùng không chờ; `stop` hủy lượt chờ), cấu hình và validator.

Đã kiểm chứng với Claude thật: model tuân theo quy tắc `[NOOP]` (xem số đo trên), và các kịch bản `memory-skills`, `reply`, `readonly` vẫn qua.

**Chưa kiểm chứng:** chống lặp chưa từng kích hoạt trong 3 lần đo (0 lần, chỉ có test đơn vị); mức giảm chất lượng/độ hoàn thành việc chưa đo được bằng kịch bản này; chưa thử trong VS Code thật.
