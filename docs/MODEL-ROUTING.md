# Chọn model theo độ khó của task

Từ 0.14.16. Mỗi task có thể có một mức độ khó (`low`, `mid`, `high`); worker khai báo model và độ nỗ lực suy luận (effort) cho từng mức. Các lượt của người nhận trên task đó chạy theo mức tương ứng.

## Cách dùng

```yaml
workers:
  - id: be
    model: claude-sonnet-5-5          # dùng khi task không có level và cho chat thường
    levels:
      low:  { model: claude-haiku-5-5, effort: low }
      mid:  { effort: medium }         # không ghi model = giữ model của worker
      high: { model: claude-opus-5-5, effort: high }
```

Người tạo task (thường là lead) đặt `level` khi gọi `create_task`. Để lead biết khi nào dùng mức nào, ghi vào `instructions` của lead, ví dụ: "level low: đổi tên, sửa chính tả, chạy lệnh có sẵn; mid: tính năng thông thường, sửa lỗi rõ ràng; high: thiết kế, lỗi khó tái hiện, đụng nhiều module". Quy tắc là của bạn; AgentRoom không tự chấm độ khó bằng model (một quyết định "chưa chắc" thì người dùng hoặc lead quyết).

## Vì sao chọn ở ranh giới task (và không đổi giữa chừng)

- **Mỗi model có cache riêng.** Đổi model giữa session làm lượt kế đọc lại toàn bộ lịch sử không có cache (tài liệu Claude Code, mục "Switching models"). Vì mỗi task đã có session riêng, chọn model theo task không làm mất cache nào đang có. Nếu mức của task đổi sau khi session đã chạy, AgentRoom bắt đầu **session mới** (rẻ hơn nạp lại session cũ trên model khác).
- **Effort giữ cache** trên Opus 5.5, Sonnet 5.5, Haiku 5.5 và Fable 5.1 khi dùng gói thuê bao hoặc API key (tài liệu cùng mục, "Changing effort level"); trên model khác, mỗi mức effort có cache riêng. Mặc định trên các model 5.5 là `medium`.
- Account `baseUrl` (cổng khác): model của mức được gửi như tên model của cổng đó, nhưng **không** gửi `effort`. Account dự phòng `baseUrl` không nhận tên model của worker.

## Người khác làm thế nào (nghiên cứu, không phải đo của chúng tôi)

Nguồn là bài viết và tài liệu công khai; nhiều con số là của chính tác giả.

- **Phân loại độ khó rồi gọi model yếu/mạnh** (RouteLLM: `weak_model`/`strong_model` với ngưỡng độ phức tạp). Một bài tổng hợp báo tiết kiệm 30–40% hóa đơn nhưng cảnh báo chi phí ẩn: model yếu làm "gần đúng" thì phải thử lại, nên cần đo tỷ lệ token ra kết quả dùng được, không chỉ đơn giá.
- **Bộ định tuyến trong harness** (LangChain): báo giảm 64% chi phí trung vị mỗi thread, không thấy đổi chất lượng (con số của họ, chưa kiểm).
- **Planner mạnh + executor rẻ** (Claude Code `opusplan`: Opus khi lập kế hoạch, Sonnet khi thực thi; kiểu "Opus lập kế hoạch, Haiku làm"). Mỗi lần bật/tắt chế độ lập kế hoạch là một lần đổi model nên mất cache. Subagent có thể có `model` riêng trong frontmatter (mặc định thừa hưởng model chính).
- **Cảnh báo chung:** với quy mô nhỏ (dưới vài trăm lượt gọi mỗi ngày) chi phí duy trì bộ phân loại có thể lớn hơn phần tiết kiệm. Vì vậy AgentRoom dùng quy tắc tường minh do con người/lead đặt, không thêm một model phân loại.
- **9Router** (proxy cục bộ): chuyển model theo **combo** (thứ tự gói thuê bao → rẻ → miễn phí) khi hết hạn mức hoặc lỗi, không phải theo độ phức tạp; API chính kiểu OpenAI. Đã quyết định không dùng.

## Chưa kiểm chứng

Mức tiết kiệm thật chưa đo. Rủi ro chính là chọn mức quá thấp rồi phải làm lại: nên bắt đầu với `low` cho việc cơ học rõ ràng và theo dõi tỷ lệ task phải làm lại. Chưa chạy với Claude thật. Model không hỗ trợ `effort` có thể bị CLI hạ về mức thấp hơn gần nhất hoặc bỏ qua (theo tài liệu), chưa thử từng model.

## Nguồn

- Claude Code, [Model configuration](https://code.claude.com/docs/en/model-config) và [Prompt caching](https://code.claude.com/docs/en/prompt-caching).
- RouteLLM, bài tổng hợp ["Model routing for coding agents"](https://getunblocked.com/blog/model-routing-coding-agents) và bài của LangChain ["How to build a model router in the harness"](https://www.langchain.com/blog/how-to-build-a-model-router-in-the-harness): chỉ đọc qua kết quả tìm kiếm, chưa đọc nguyên văn.
- 9Router: <https://github.com/decolua/9router>.
