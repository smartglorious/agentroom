# Lịch sử phiên bản

Mỗi phiên bản có một mục ở đây **và** README được cập nhật cho khớp (bản cài `.vsix`, bảng tính năng, danh sách tài liệu, settings). `test/readme.test.ts` kiểm tra điều này.

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
