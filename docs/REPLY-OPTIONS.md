# Trả lời đúng tin và lựa chọn bằng nút (v0.11)

## Trả lời một tin của worker (↩)

Mỗi tin của worker có nút **↩**. Bấm vào, thanh "Trả lời <worker>: …" hiện trên ô nhập; gõ rồi Enter. Tin của bạn:

- **đi thẳng tới tác giả của tin đó**, không cần `@mention`;
- **vào đúng phiên (task) mà tin đó thuộc về**, nên worker trả lời trong đúng ngữ cảnh của việc đang làm;
- hiện kèm đoạn trích tin được trả lời (bấm vào trích dẫn để nhảy tới tin gốc);
- tới worker kèm `[trả lời tin “@be: …”]`, để model biết bạn đang trả lời tin nào.

Nếu trong câu trả lời bạn `@mention` ai đó, đó là lựa chọn của bạn về người trả lời (vẫn gắn với tin gốc). Trả lời tin của hệ thống hoặc của chính bạn không tự chọn người nhận (như tin thường). Trả lời một tin không còn tìm thấy thì thành tin thường.

Trên **Telegram**: dùng chức năng "Trả lời" (reply) của Telegram trên tin của bot; AgentRoom ánh xạ về đúng tin worker (nhớ 400 tin gần nhất; tin cũ hơn thì thành tin thường).

## Worker hỏi bạn chọn (`ask_user`)

Worker cần bạn chọn thì gọi tool **`ask_user`**: câu hỏi và 2–8 phương án (nhãn ≤ 80 ký tự, mô tả ≤ 200). Tin hiện **nút bấm**. Rồi worker kết thúc lượt. Khi bạn bấm:

- câu trả lời "Tôi chọn 2: …" quay về **đúng phiên đó của worker** (cùng task, cùng session Claude), nên worker tiếp tục mà không mất ngữ cảnh;
- các nút khóa lại, nút đã chọn có dấu ✓. Mỗi câu hỏi chỉ trả lời một lần bằng nút; muốn nói điều khác ("làm theo cách khác…") thì dùng ↩ và gõ chữ.

Điều đáng biết:
- **Câu hỏi không đánh thức ai**: dù nhãn phương án có chứa `@tên`, tin chỉ gửi cho bạn.
- Nhãn và mô tả do worker viết nên được xử lý như văn bản thuần (không HTML), cắt độ dài, bỏ ký tự điều khiển, không trùng nhãn.
- Chọn lựa chọn không phải duyệt quyền: nó chỉ là một tin nhắn của bạn gửi cho worker (không cần PIN).

### Telegram

Câu hỏi tới điện thoại **có chuông** (như mọi tin cần bạn quyết định), mỗi phương án một nút, và **không bị `/mute` ẩn đi**. Bấm nút: worker nhận câu trả lời, tin được sửa thành "✔ Đã chọn 2. … (từ điện thoại)", nút biến mất. Trả lời ở máy tính thì tin trên điện thoại cũng được đóng ("ở máy tính"). Nút đã dùng hoặc quá cũ báo "đã được trả lời".

## Đã kiểm chứng gì và chưa

Đã kiểm chứng bằng test: định tuyến trả lời (tác giả, đúng task, `@mention` thắng, mục tiêu không tồn tại), `ask_user` qua MCP thật (kiểm tra đầu vào, không đánh thức ai, rơi vào đúng task đang chạy), `answerOption` (một lần, không giả mạo được, tin hệ thống không thành câu hỏi), lưu bền qua khởi động lại, đoạn trích trong prompt, và phía Telegram (nút, chuông, `/mute`, bấm nút, đóng câu hỏi từ hai phía, reply gốc của Telegram, nút quá cũ). Giao diện kiểm bằng Chromium (sáng/tối): nút ↩, thanh trả lời, gửi kèm `replyTo`, bấm lựa chọn rồi khóa và đánh dấu.

**Chưa kiểm chứng:** Claude thật gọi `ask_user` rồi tiếp tục trong cùng session (kịch bản `npm run test:live -- reply` đã viết, chưa chạy được vì hạn mức Claude của môi trường đang bị giới hạn tạm thời); VS Code thật; Telegram thật.
