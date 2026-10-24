# Kế hoạch giảm token (v0.8)

Trạng thái: **kế hoạch, chưa triển khai**. Mọi con số "ước tính" dưới đây là giả thuyết từ việc đọc mã, **chưa đo trên dữ liệu thật của bạn**. Giai đoạn 0 tồn tại để đo trước khi sửa.

## 1. Token đang đi đâu (đọc từ mã hiện tại)

Mỗi lượt của một worker (`Room.runTurn`) gửi và trả tiền cho:

| # | Phần | Ở đâu | Vì sao tốn |
|---|---|---|---|
| A | Prompt hệ thống của Claude Code (preset) + tool + `CLAUDE.md` của repo | `claude.ts` (`preset: claude_code`, `settingSources: project`) | Cố định, lớn; mỗi session có một bản |
| B | `systemAppend` = vai trò + luật + roster + SOUL + trí nhớ đội + trí nhớ cá nhân + **nhật ký** | `prompt.ts buildPersona`, ngân sách `memoryBudgetChars` = 12 000 ký tự | Dựng lại **mỗi lượt**; nhật ký và trí nhớ đổi nên **prefix cache bị phá** → trả giá ghi cache lại |
| C | `<room_context>`: tối đa 30 tin gần nhất kể từ lần cuối worker này nhìn | `room.ts` (`contextMessages` = 30) | Mỗi tin là **toàn văn** (câu trả lời cuối lượt của worker khác có thể dài hàng nghìn token) |
| D | Toàn bộ lịch sử session được `resume` | `sessions[<worker>:main]` | Không bao giờ xoay vòng: càng dùng càng dài; mỗi lượt đọc lại cả lịch sử (giá cache-read, nhưng nhân với số lượt) |
| E | **Số lượt**: mỗi câu trả lời có `@mention` đánh thức worker khác, tối đa `maxAgentHops` = 6 | `router.ts`, `room.ts` | Một yêu cầu của người dùng có thể thành 6+ lượt, mỗi lượt trả A+B+C+D |
| F | Tin không `@mention` luôn đánh thức coordinator | `router.ts` | Mọi câu "ok", "cảm ơn" cũng tốn một lượt |
| G | Model mặc định của account cho **mọi** worker | `model` tuỳ chọn, thường bỏ trống | Worker việc nhẹ chạy model đắt |
| H | Cron/webhook, `consolidate-memory` | `cron.ts`, `webhooks.ts` | Mỗi lần chạy là một lượt đầy đủ |

Giả thuyết cần kiểm chứng: **D, E, G** thường chiếm phần lớn; **B** gây phí ghi cache ngầm; **C** phình lên khi có worker nói dài.

## 2. Giai đoạn 0 — Đo trước (0,5 ngày)

Không sửa gì trước khi biết mục tiêu. Hôm nay, không cần mã mới:

1. Tab **Chi phí**, đổi khoảng thời gian sang 7 ngày, xem theo **worker**, **model**, **task**, **tool**.
2. Xem **cache hit** theo worker (thấp = prefix bị phá, giả thuyết B).
3. Mở **Context Inspector** (nút 🔍) ở lượt tốn nhất: phần nào chiếm nhiều token.
4. Đếm số lượt trên mỗi tin nhắn người dùng (`usage.jsonl` có `turnId`, `taskId`, `numTurns`).

Mã mới (nhỏ):
- Tab Chi phí thêm: **lượt/tin người dùng**, **tỉ lệ lượt do agent đánh thức**, **ghi cache vs đọc cache**, **kích thước ngữ cảnh theo thời gian của từng session** (phát hiện D).
- `scripts/live/bench-tokens.ts`: một kịch bản chuẩn (3 worker, 1 yêu cầu có phối hợp) chạy bằng Claude thật, in tổng token/chi phí từ `usage.jsonl`. **Đây là thước đo trước/sau cho mọi giai đoạn dưới đây.**

Bạn có thể gửi tôi file `.agentroom/state/usage.jsonl` (chỉ gồm worker, model, số token, tên tool, không có nội dung chat) để tôi chọn đúng mục tiêu ngay.

## 3. Giai đoạn 1 — Cấu hình, làm được ngay, không đổi mã (0,5 ngày)

| Thay đổi | Mục tiêu | Rủi ro |
|---|---|---|
| `model:` rẻ hơn cho worker việc nhẹ (coordinator, QA đọc, docs); model mạnh chỉ cho worker thật sự cần | G | Chất lượng của worker đó giảm; thử từng worker |
| `maxAgentHops` 6 → 3 | E | Chuỗi phối hợp dài bị cắt, người dùng phải nhắn tiếp |
| `contextMessages` 30 → 10 | C | Worker thiếu ngữ cảnh cũ |
| `memoryBudgetChars` 12000 → 5000 | B | Trí nhớ bị cắt; `Gom trí nhớ worker` để nén thay vì cắt |
| Bỏ `useSkills`/MCP thừa; `allowedTools` đúng việc | A | Không đáng kể |
| Ghi vào SOUL của từng worker: "không trả lời xác nhận/cảm ơn; chỉ @mention khi cần hành động" | E, F | Tuỳ model tuân thủ |

## 4. Giai đoạn 2 — Bớt những gì mỗi lượt gửi lại (1,5 ngày)

**2a. Nén `<room_context>` và hộp thư (C).** Mỗi tin của worker khác bị cắt còn N ký tự (mặc định 600) kèm mã tin; tool `read_channel` đã có sẵn để đọc toàn văn khi cần. Tin của người dùng giữ nguyên. Tin gửi thẳng cho worker (hộp thư) cắt ở ngưỡng cao hơn (mặc định 3000). Thêm cài đặt `contextMessageChars`.

**2b. Prefix hệ thống ổn định để cache hoạt động (B).** Tách `buildPersona` thành:
- *Ổn định* (vai trò, luật, roster, SOUL) vào `systemAppend`; byte-giống-hệt giữa các lượt.
- *Hay đổi* (trí nhớ đội, trí nhớ cá nhân, nhật ký) chuyển sang **đầu prompt của lượt**, và **chỉ gửi khi session mới hoặc khi nội dung đã đổi** (lưu hash theo session; lượt `resume` cũ đã chứa bản trước đó trong lịch sử). Bản đổi chỉ gửi phần mới (`+`/`-` các mục `[Mn]`, vốn đã có id).
- Nhật ký: chỉ N mục gần nhất, và bỏ hẳn ở lượt resume.

Rủi ro: model "quên" phần trí nhớ không lặp lại. Giảm bằng: gửi lại toàn bộ khi session xoay vòng (giai đoạn 3) hoặc sau M lượt. Cần test kịch bản `e2e-memory-skills` vẫn qua.

**2c. Rút gọn luật** (≈ 350 token → ≈ 150) và roster (id + vai trò, bỏ `skills` dài). Nhỏ nhưng nhân với mọi lượt.

## 5. Giai đoạn 3 — Vệ sinh session (1 ngày) (D)

- **Xoay vòng session** khi vượt `agentroom.sessionMaxTokens` (mặc định đề xuất 80k, đo từ `usage`) hoặc `sessionMaxTurns`: bắt đầu session mới, mở đầu bằng *bản bàn giao* ngắn (trí nhớ + task đang giữ + vài dòng cuối nhật ký), thay vì `resume`.
- Session của task đã `done` không bao giờ được resume lại. Kiểm tra cron/webhook: mỗi lần chạy phải là session mới (cần xác nhận trong mã, tôi chưa kiểm).
- Hiển thị kích thước session trong tab Hồ sơ và nút "Bắt đầu session mới" cho từng worker.

## 6. Giai đoạn 4 — Bớt số lượt (1–1,5 ngày) (E, F, H)

- **Gom tin theo cửa sổ thời gian** (debounce 2–5 giây) cho tin giữa các agent: nhiều tin đến gần nhau thành một lượt.
- **Giới hạn chi phí theo chuỗi/task**: `budgetUsdPerTask` (mặc định tắt). Chạm ngưỡng thì dừng chuỗi, báo qua Telegram, chờ bạn.
- **Cổng cho coordinator** (F): tin ngắn không có động từ hành động ("ok", "cảm ơn", biểu tượng) hiển thị nhưng không đánh thức ai. Bắt đầu bằng danh sách luật đơn giản, có test; không dùng model để phân loại.
- Cron/webhook: cho phép `model:` riêng cho từng lịch/webhook (việc chạy đêm thường dùng model rẻ), mặc định `readOnly` cho webhook như hiện nay.

## 7. Giai đoạn 5 — Chọn model và giới hạn vòng lặp (1 ngày) (G, A)

- `models:` theo loại lượt: `default`, `readOnly`, `scheduled`, và ghi đè theo worker.
- Giới hạn số vòng tool trong một lượt (`maxTurns`) và mức suy nghĩ nếu SDK hỗ trợ: **cần kiểm tra tên tuỳ chọn thật trong SDK trước khi hứa**.
- Với worker "chỉ trò chuyện" không dùng tool (ví dụ coordinator), thử prompt hệ thống tối giản thay vì preset `claude_code` (mục A). Chỉ làm nếu giai đoạn 0 cho thấy A đáng kể, vì có nguy cơ giảm chất lượng.

## 8. Giai đoạn 6 — Cảnh báo (0,5 ngày)

- Lượt vượt ngưỡng token đánh dấu 🔥 trong chat và tab Chi phí.
- Telegram: cảnh báo "worker X đã tốn $N trong 1 giờ qua"; `/cost 1h`.

## 9. Thứ tự và tiêu chí thành công

Thứ tự đề xuất: **0 → 1 → 2 → 3 → 4 → 5 → 6**. 0 và 1 cho kết quả trong ngày. 2–3 là phần đáng làm nhất về mặt kỹ thuật. 4 cần cân nhắc vì đổi hành vi phối hợp.

Tổng ước tính công: ~6–7 ngày cho tất cả; **giai đoạn 0–3 khoảng 3,5 ngày**.

Mỗi giai đoạn chỉ được coi là xong khi:
1. `bench-tokens` trước/sau cho thấy mức giảm **đo được** (ghi số vào tài liệu, không dùng con số ước tính);
2. `npm test` và các kịch bản live liên quan vẫn qua (memory/skills, read-only, webhook, telegram, daemon);
3. Không có worker nào mất khả năng làm việc đã có (kiểm bằng kịch bản chuẩn: giao việc, phối hợp, nhớ lại).

## 10. Điều tôi chưa biết và cần từ bạn

- Dữ liệu thật: `usage.jsonl` hoặc ảnh tab Chi phí (theo worker, model, task) để xác nhận mục tiêu lớn nhất.
- Bạn dùng Claude (gói thuê bao hay API key) hay Codex, và lo ngại hạn mức hay tiền? Với gói thuê bao, "đọc cache" vẫn tính vào hạn mức theo cách tôi chưa kiểm chứng.
- Mức chấp nhận giảm chất lượng: sẵn sàng đổi model rẻ hơn cho worker nào?
- Có worker nào thường xuyên "nói chuyện qua lại" (ping-pong) mà bạn đã thấy?
