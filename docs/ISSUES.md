# Bộ gom lỗi / vấn đề

Mục đích: trong lúc dùng AgentRoom có sẵn bằng chứng để sửa lỗi và nâng cấp. **Mọi thứ nằm cục bộ** (`.agentroom/state/issues.json`, đã nằm trong `.gitignore`); không có gì tự tải lên. Bạn xuất báo cáo Markdown rồi tự quyết định đưa cho ai (GitHub issue, hoặc đưa cho Claude để lập kế hoạch sửa).

## Tự ghi những gì

| Loại | Nguồn | Khi nào |
|---|---|---|
| `error` | `turn` | Lượt của worker lỗi (CLI không chạy, mất kết nối máy từ xa, …) |
| `error` | `telegram` | Bot không khởi động được, lỗi xử lý tin/nút, không gửi được |
| `friction` | `rate-limit` | Account bị rate limit |
| `friction` | `budget` | Account chạm ngân sách ngày |
| `friction` | `limit` | Chuỗi trao đổi/task chạm `limits.chainTurns` / `limits.usdPerTask` |
| `user` | `user` | Bạn tự ghi |

`friction` không phải lỗi mà là chỗ cấu hình/sản phẩm gây cản trở: nếu một dòng lặp lại nhiều lần, đó là gợi ý chỉnh giới hạn hoặc cải tiến.

## Cách dùng

- VS Code: nút ⚑ trên thanh tab của chat, hoặc `AgentRoom: Ghi một vấn đề / lỗi`, `AgentRoom: Xuất báo cáo lỗi (Markdown)` (ghi `.agentroom/state/issues-report.md` rồi mở).
- Telegram: `/issue <mô tả>`, `/issues`.
- Daemon: `agentroom-daemon issues [list|export|report <mô tả>|fix <id> [ghi chú]|wontfix <id>]`.

## Gộp trùng, đóng và mở lại

Cùng một vấn đề (khác số, đường dẫn, id) chỉ là một dòng có bộ đếm, danh sách bản đã gặp, lần đầu/cuối. Khi bạn đánh dấu `fix`, AgentRoom nhớ bản đang chạy; nếu lỗi tái diễn ở bản *bằng hoặc mới hơn* thì tự mở lại (`mở lại N lần`), còn bản cũ hơn gặp lại thì không.

## Riêng tư

Khóa/token bị ẩn (cùng bộ lọc với trí nhớ), đường dẫn project thành `<project>`, thư mục home thành `~`. Vẫn nên đọc lại báo cáo trước khi gửi. Tối đa 1000 dòng; dòng đã đóng bị bỏ trước.

## Không làm (cố ý)

- Không có tool `report_issue` cho agent: mỗi tool MCP tốn token ở mọi lượt (xem CLAUDE.md, nguyên tắc 7). Lỗi của lượt tự được ghi; điều agent nhận thấy thì bạn ghi bằng `/issue`.
- Chưa ghi lỗi của lệnh con (`ssh`, runner) ngoài những gì làm lượt thất bại; chưa có tab *Lỗi* trong giao diện chat (xem danh sách bằng `/issues`, `agentroom-daemon issues` hoặc báo cáo Markdown).
