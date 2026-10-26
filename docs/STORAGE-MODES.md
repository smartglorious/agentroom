# Chế độ lưu trữ: `legacy`, `verify`, `durable` (0.14.19)

Cài đặt `agentroom.storage.mode` (đổi trong tab *Cài đặt*, cần tải lại cửa sổ). Daemon: `agentroom-daemon set storageMode legacy|verify|durable`.

| | `legacy` (mặc định) | `verify` | `durable` |
|---|---|---|---|
| Chat, task, session, cursor | file trong `.agentroom/state` | file | **vẫn là file** |
| `agentroom.db` (SQLite) | không có | dựng bản sao để đối chiếu | có, và được dùng |
| Một lượt của worker | chạy trực tiếp | như `legacy` | là một Run/Step có lease; nếu tiến trình tắt giữa chừng, lượt được phục hồi khi khởi động lại |
| Phê duyệt đang chờ | mất khi tắt | mất | lưu trong SQLite, còn sau khi khởi động lại |
| Ngữ cảnh, trí nhớ, sổ chi phí | như cũ | như cũ | Context Broker (TaskPacket), trí nhớ lai, sổ chi phí model |
| API cục bộ (`agentroom.localApi.enabled`) | cùng cờ | cùng cờ | cùng cờ |

Khi bật `verify` hoặc `durable`, AgentRoom sao lưu `.agentroom/state` vào `.agentroom/backups/<id>`, đọc dữ liệu cũ vào SQLite, đối chiếu từng bản ghi và từng task. Nếu đối chiếu thất bại thì **tự quay về `legacy`** (file không bị đụng) và ghi lý do vào Output → "AgentRoom" (`[storage] …`). Các file cũ vẫn là bản chính ở mọi chế độ và thay đổi liên tục, nên mỗi lần khởi động bản chụp trong SQLite được làm mới.

Quay lại: đặt `legacy` rồi tải lại cửa sổ; file cũ còn nguyên.

## Đã kiểm chứng gì và chưa

- Đã kiểm chứng: test tự động (bootstrap, importer, migration v1→v9, phục hồi lượt, phê duyệt bền, khởi động lại khi file đổi giữa các lần); hai lần chạy cùng kịch bản 6 tin ở `legacy` và `durable` trên project thử với Claude thật, cache-write chênh ×1,022 (xem `BENCH-CACHEWRITE.md`).
- **Chưa kiểm chứng:** `durable` trên dữ liệu thật của người dùng; phục hồi sau khi tắt đột ngột giữa lượt bằng một lượt live; chạy trên VPS/daemon; `.vsix` công khai tăng khoảng 12 MB vì mang prebuild native của SQLite cho mọi nền tảng (gói theo từng nền tảng chưa làm).
- Nên thử `verify`/`durable` trên **bản sao** của `.agentroom/state` trước.
