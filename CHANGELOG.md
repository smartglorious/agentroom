# Lịch sử phiên bản

Mỗi phiên bản có một mục ở đây **và** README được cập nhật cho khớp (bản cài `.vsix`, bảng tính năng, danh sách tài liệu, settings). `test/readme.test.ts` kiểm tra điều này.

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
