# Kế hoạch giảm token (bản 2, sau khi đo và tra cứu)

Trạng thái: **S1 (bộ tool tường minh), S2 (prompt ổn định), S8 (bớt số lượt giữa các worker) và công cụ đo `bench:tokens` đã triển khai và đo (mục 0)**; các mục S3–S7, S9–S10 còn lại là kế hoạch. Bản 1 chỉ dựa vào đọc mã. Bản này thêm (a) **số đo thật** bằng Claude CLI và Agent SDK của chính dự án (mô hình `haiku`, SDK 0.3.309, mỗi phép đo là một lượt "Say OK." nên tổng token vào ≈ kích thước tiền tố cố định), và (b) tài liệu chính thức của Anthropic. Nguồn ở mục 8. Con số nào là đo thật, con số nào là từ tài liệu, con số nào là ước tính đều được ghi rõ.

## 0. Kết quả đo sau khi triển khai S1 + S2

Cùng một kịch bản (`npm run bench:tokens`: ba worker lead/be/qa, ba tin nhắn của người dùng, Claude thật, model `haiku`), **3 lần chạy mỗi bản**, từng lần một:

| | Trước (`main`) | Sau (S1 + S2) | Thay đổi |
|---|---|---|---|
| Token vào mỗi lượt, từng lần | 77.049 · 93.006 · 95.056 | 33.730 · 41.587 · 31.330 | |
| **Token vào mỗi lượt, trung bình** | **≈ 88 nghìn** | **≈ 35,5 nghìn** | **−60%** |
| Tổng token vào, trung bình | ≈ 2,04 triệu | ≈ 0,90 triệu | −56% |
| Chi phí ước tính của CLI, trung bình | $0,182 | $0,093 | −49% |
| Số lượt (dao động) | 23 · 17 · 29 | 26 · 26 · 24 | |

Cách đọc và giới hạn:
- **Token mỗi lượt là con số đáng tin nhất**, vì nó phản ánh kích thước tiền tố cố định và gần như không phụ thuộc số lượt. Tổng token và chi phí nhiễu hơn: số lượt dao động từ 17 đến 29 vì các worker nhắn qua lại khó đoán (đây chính là vấn đề S8, chưa giải quyết).
- Phần lớn mức giảm đến từ **S1**: bộ tool tường minh thay cho việc nạp hết (≈ 33 nghìn → ≈ 6–8 nghìn token mỗi session, đo riêng bằng `scripts/measure-prefix.mjs`).
- Ghi cache mỗi lượt **tăng** (≈ 2,2 → ≈ 3,9 nghìn trung bình ở lần đo đầu) và token ra cũng tăng ở lần đo đầu; chưa phân tích nguyên nhân, có thể do kịch bản và nhiễu.
- **Chỉ số "worker thêm được `sub()` vào file" không dùng được để so sánh chất lượng**: thành công 1/3 lần ở bản cũ và 0/3 lần ở bản mới, vì kịch bản có nhiều qua lại lộn xộn. Ở một lần chạy của bản mới, worker `be` từng trả lời "tôi là QA"; chưa có bằng chứng đó là lỗi do thay đổi này (bản cũ cũng thất bại 2/3 lần), nhưng cũng chưa loại trừ được. Cần một kịch bản chất lượng riêng (S10) trước khi kết luận về chất lượng.
- Kiểm chứng chức năng với Claude thật trên bản mới: `memory-skills` (Skill vẫn chạy với bộ tool giới hạn; công cụ `remember` ghi qua MCP; trí nhớ sang session mới), `readonly` (lượt chỉ-đọc không bị nới), `webhook` (chặn chỉ dẫn trong payload). Cả ba đều qua.
- Đo trên model `haiku`, một kịch bản nhỏ, `settingSources: []`. Dự án thật có `CLAUDE.md` và nhiều lịch sử hơn nên tỉ lệ phần trăm sẽ nhỏ hơn; mức tiết kiệm tuyệt đối từ S1 giữ nguyên.


### 0.1. Thêm S8 (bớt số lượt giữa các worker)

Cùng kịch bản, 3 lần chạy mỗi bản, từng lần một. "S1+S2" là các số ở bảng trên; "gốc" là bản trước mọi thay đổi.

| | Gốc | S1 + S2 | **S1 + S2 + S8** | S8 so với S1+S2 | Tổng so với gốc |
|---|---|---|---|---|---|
| Số lượt (từng lần) | 23 · 17 · 29 | 26 · 26 · 24 | **17 · 15 · 16** | −37% | −30% |
| Tin của worker đăng | 34 · 26 · 38 | 32 · 42 · 31 | **15 · 17 · 18** | −52% | −53% |
| Token vào mỗi lượt, trung bình | ≈ 88 nghìn | ≈ 35,5 nghìn | **≈ 30 nghìn** | −15% | −66% |
| Tổng token vào, trung bình | ≈ 2,04 triệu | ≈ 0,90 triệu | **≈ 0,48 triệu** | −47% | **−77%** |
| Chi phí ước tính, trung bình | $0,182 | $0,093 | **$0,036** | −61% | **−80%** |
| `[NOOP]` bị chặn không đăng (từng lần) | n/a | n/a | 8 · 2 · 5 | | |

Cách đọc:
- Mức giảm của S8 đến từ **ít lượt hơn** (16 so với ~25) và ít tin qua lại hơn; token mỗi lượt giảm thêm vì các lượt "xác nhận qua lại" bị cắt bớt. Model **có làm theo** quy tắc `[NOOP]` (2–8 câu trả lời mỗi lần chạy bị chặn không đăng).
- Chất lượng: chỉ số "thêm được `sub()`" thành công 1/3 lần ở S8, như bản gốc (1/3) và không tệ hơn S1+S2 (0/3), nhưng vẫn là chỉ số nhiễu, không dùng để kết luận. Kiểm chứng chức năng với Claude thật trên bản S8: `memory-skills`, `reply` và `readonly` đều qua.
- Chưa tìm cách đo "worker có hoàn thành đúng việc không" ngoài kịch bản nhỏ này; đó là việc của S10 (kịch bản chất lượng).
- Giới hạn lượt cố ý nằm ở mức 10; chưa chạm trong 3 lần đo (số lượt tối đa 17 trên ba tin nhắn của người dùng).

## 1. Phát hiện quan trọng nhất (đã đo)

### 1.1. Mỗi session tốn ~33 000 token cố định, và gần như toàn bộ là định nghĩa tool mà worker không dùng

| Cấu hình | Token vào ở lượt đầu (đo) | So với hiện tại |
|---|---|---|
| **Hiện tại** (`preset claude_code`, không giới hạn tool) | **32 894** | — |
| `tools: [Read, Grep, Glob]` | 6 224 | **−81%** |
| `tools: [Read, Grep, Glob, Edit, Write, Bash]` | 8 102 | −75% |
| …+ `WebFetch, WebSearch` | 9 086 | −72% |
| …+ `Agent, TodoWrite` | 11 793 | −64% |
| `tools: []` | 3 580 | −89% |
| prompt tự viết (chuỗi) + `[Read, Grep, Glob]` | 3 968 | −88% |
| prompt tự viết + `tools: []` | 1 324 | −96% |
| `excludeDynamicSections: true` (cùng tool) | 6 172 vs 6 224 | −52 token, không đáng kể |
| thêm một MCP server `agentroom` | +207 | không đáng kể (tool MCP được nạp trễ) |

`ClaudeAdapter` hiện chỉ truyền `allowedTools`. Theo tài liệu SDK, `allowedTools` **chỉ tự duyệt, không giới hạn** tool nào được nạp; nên worker "chỉ đọc" vẫn mang theo định nghĩa của mọi tool. Tùy chọn đúng để cắt là **`tools`** (mảng tên tool). Đây là thay đổi **lớn nhất, rẻ nhất, đã đo được**.

Ý nghĩa tiền bạc (tính theo hệ số trong tài liệu: ghi cache 1,25×, đọc cache 0,05–0,1×): mỗi lượt có cache nóng, phần cố định giảm từ ~3,3 nghìn xuống ~0,8 nghìn "token tương đương giá đầu vào"; mỗi lần session mới hoặc cache hết hạn, giảm từ ~41 nghìn xuống ~10 nghìn. Với đội 5 worker, mỗi worker một session riêng, khoản này nhân 5.

### 1.2. Prompt persona (`systemAppend`) đã bị **đóng băng** ở các lượt `resume`, nghĩa là có một lỗi chức năng

Thử trực tiếp: lượt 1 `append: "CODEWORD=ALPHA"`, lượt 2 `resume` với `append: "CODEWORD=BETA"`:

- lượt 2 trả lời **ALPHA** (prompt cũ), và đọc cache 32 890 token (cache nguyên vẹn);
- với `snapshot: false`, lượt 3 trả lời đúng nội dung mới, nhưng cache chỉ còn đọc 26 000 và **ghi lại 6 996 token** (phần sau chỗ đổi bị phá).

Khớp với tài liệu: mặc định session dùng lại system prompt đã ghi ở lượt đầu. Hệ quả cho AgentRoom, vì `buildPersona` dựng lại **mỗi lượt** trí nhớ đội, trí nhớ cá nhân, nhật ký, roster và SOUL:
- **Những thay đổi này không bao giờ tới các session đang `resume`**: đồng đội ghi `remember` scope `team`, bạn sửa SOUL, thêm worker mới vào roster, duyệt skill mới: worker đang có session vẫn dùng bản cũ cho tới khi session mới.
- Ngược lại, vì bị đóng băng nên cache không bị phá bởi phần này. Tức là nỗi lo "nhật ký đổi làm vỡ cache" của bản 1 **không xảy ra ở lượt resume** (chỉ xảy ra ở session mới). Bản 1 sai ở điểm này.

Cách đúng: giữ `systemAppend` **ổn định** (vai trò, luật, SOUL), và đưa phần hay đổi (trí nhớ đội/cá nhân, thay đổi roster, skill mới) vào **đầu prompt của lượt**, chỉ khi nội dung đổi so với lần worker này thấy gần nhất (so hash). Vừa sửa lỗi vừa không phá cache.

### 1.3. Chi tiết khác đã biết từ tài liệu và ảnh hưởng thiết kế

- Thứ tự cache là `tools → system → messages`; đổi ở tầng nào thì vô hiệu tầng đó và mọi thứ sau. **Đổi model** vô hiệu toàn bộ; **đổi effort** vô hiệu toàn bộ trên hầu hết model, nhưng **giữ cache** trên Opus 5.5, Sonnet 5.5, Haiku 5.5, Fable 5.1 với API key hoặc gói thuê bao. Vậy: **cố định model cho từng worker trong suốt session**; effort đổi giữa các lượt thì an toàn trên dòng 5.5.
- TTL mặc định **5 phút** (làm mới miễn phí mỗi lần đọc). Gói thuê bao: cuộc hội thoại chính được **1 giờ** trong hạn mức; **API key hoặc cloud: 5 phút**. Ghi cache 1 giờ giá 2× (5 phút: 1,25×). Đặt TTL bằng biến môi trường `CLAUDE_CODE_PROMPT_CACHE_TTL=1h` (từ Claude Code v2.1.242). Subagent và các yêu cầu ngoài cuộc hội thoại chính mặc định 5 phút.
- Đọc cache rẻ hơn nhiều với dòng 5.5: 0,05× (Opus 5.5, Sonnet 5.5), 0,025× (Fable 5.1), 0,1× các model khác.
- `effort` mặc định của Opus/Sonnet/Haiku 5.5 là `medium`; mức cao hơn đắt hơn (token suy nghĩ tính như token đầu ra). Không tắt được thinking trên dòng 5.5, chỉ chỉnh effort.
- Tùy chọn có sẵn trong SDK (xác nhận từ tài liệu): `maxTurns`, `maxBudgetUsd` (ước tính phía client, nên chừa dư), `effort`, `thinking`, `fallbackModel`, `agents[].model/effort/maxTurns`, `getContextUsage()` (đo cửa sổ ngữ cảnh theo nhóm), `taskBudget` (alpha).
- Claude Code tự lo `cache_control`; không cần và không nên tự đặt breakpoint.

## 2. Bằng chứng về phối hợp nhiều agent

- Anthropic: agent dùng ~**4×** token so với chat, hệ nhiều agent ~**15×**; ba yếu tố giải thích 95% phương sai hiệu năng trong đánh giá của họ, riêng lượng token giải thích 80%. Họ nói rõ nhiều agent chỉ đáng khi giá trị việc cao, và **các miền chia sẻ ngữ cảnh/phụ thuộc nhiều như phần lớn việc lập trình là chỗ chưa hợp**. Hệ quả cho AgentRoom: giữ đội nhỏ, giữ giới hạn bước (`maxAgentHops`), và mỗi worker cô lập ngữ cảnh (worktree riêng, phiên riêng) thay vì dồn mọi thứ vào chung.
- Tài liệu chi phí của Claude Code: đội agent dùng ~**7×** token khi các thành viên ở chế độ plan; nên dùng Sonnet cho thành viên, giữ đội nhỏ, tắt thành viên khi xong việc.
- Nghiên cứu "The Complexity Trap" (arXiv 2508.21433), trên agent kỹ thuật phần mềm: **mọi** cách quản lý ngữ cảnh đều tốt hơn không quản lý (chi phí có thể hơn gấp đôi nếu không), và **che bỏ quan sát cũ (observation masking) đơn giản ngang tóm tắt bằng LLM** trong thí nghiệm của họ. Hệ quả: cắt bớt tin dài là đủ, không cần thêm một lượt LLM để tóm tắt.
- RCR-Router (arXiv 2508.04903): định tuyến ngữ cảnh theo vai trò dưới ngân sách token, báo giảm ~35% token. Chỉ có tiêu đề/tóm tắt từ kết quả tìm kiếm, tôi chưa đọc bài; coi là hướng tham khảo, chưa kiểm chứng.
- Các bài blog (con số "70–90% khi tóm tắt lúc bàn giao", "chi phí nhân lên theo bình phương số lần bàn giao") **không có nguồn gốc kiểm chứng được**; không dùng làm căn cứ.

## 3. Giải pháp xếp theo (tác động đo được ÷ công sức)

| # | Giải pháp | Đã đo? | Tác động | Công | Rủi ro |
|---|---|---|---|---|---|
| **S1** | **Danh sách `tools` theo worker** (mặc định = tool trong `allowedTools` ∪ lõi `Read,Grep,Glob,Edit,Write,Bash`; thêm khóa `tools:` để mở thêm `WebFetch`, `WebSearch`, `Agent`…) | **Có**: −64% đến −81% tiền tố cố định | **Lớn nhất**, mọi lượt, mọi worker | 0,5 ngày | Worker mất tool không khai báo (ví dụ `WebSearch`); cần ghi rõ trong tài liệu và mẫu |
| **S2** | **Sửa lỗi persona bị đóng băng**: `systemAppend` ổn định, phần hay đổi vào đầu prompt của lượt khi hash đổi | **Có** (lỗi đã tái hiện) | Đúng chức năng; giữ cache | 1 ngày | Model "quên" nếu chỉ gửi khi đổi: gửi lại đầy đủ khi session mới hoặc sau M lượt |
| **S3** | **Chọn model và effort theo worker/loại lượt** (`model`, `effort`; lượt chỉ-đọc, cron, webhook dùng model rẻ hơn; **không đổi model giữa các lượt của một session**) | Từ tài liệu | Lớn (G trong bản 1), phụ thuộc cấu hình | 0,5–1 ngày | Chất lượng worker nhẹ giảm; thử từng worker |
| **S4** | **Giới hạn mỗi lượt**: `maxTurns` (số vòng tool) và `maxBudgetUsd` mỗi lượt, báo khi chạm | Từ tài liệu | Chặn vòng lặp tool chạy lạc | 0,5 ngày | Cắt lượt dở: phải báo rõ, cho tiếp tục |
| **S5** | **TTL cache 1 giờ cho account API key** khi worker thường nghỉ >5 phút giữa các lượt (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h` trong `env` của phiên); cấu hình `cacheTtl` theo account; gói thuê bao đã được 1 giờ trong hạn mức | Từ tài liệu; **cần đo bằng bench** | Giảm số lần ghi lại ~8–33 nghìn token sau mỗi lần nghỉ | 0,5 ngày | Ghi 2× thay vì 1,25×: lỗ nếu session ít được dùng lại |
| **S6** | **Nén `<room_context>` và hộp thư** theo kiểu che quan sát cũ: tin của worker khác cắt còn N ký tự kèm mã tin (đã có tool `read_channel` để xem toàn văn) | Nghiên cứu (arXiv) | Vừa; giảm theo độ dài tin | 1 ngày | Thiếu chi tiết, worker phải gọi `read_channel` |
| **S7** | **Xoay vòng session theo ngưỡng** (đo bằng `getContextUsage()` thay vì ước lượng; mặc định đề xuất 60–80 nghìn) kèm bản bàn giao ngắn. **Sau S1, một session mới chỉ tốn ~8 nghìn** nên xoay vòng rẻ hơn nhiều so với bản 1 giả định | Một phần (chi phí khởi động đã đo) | Vừa–lớn với session dài | 1 ngày | Mất chi tiết trong bàn giao |
| **S8** | **Bớt số lượt**: gom tin trong 2–5 giây, bỏ qua tin xác nhận ngắn, giới hạn qua lại giữa hai agent, ngân sách theo task, coordinator không bị đánh thức vì "ok/cảm ơn" | Từ phân tích mã + Anthropic (4×/15×) | Lớn nếu có ping-pong; **cần số đo thật của bạn để biết** | 1–1,5 ngày | Đổi hành vi phối hợp |
| **S9** | Prompt tự viết thay `preset claude_code` cho worker không dùng tool (coordinator chỉ trò chuyện): 1 324 token thay vì 3 580 (sau S1) | Có | Nhỏ sau S1 | 0,5 ngày | Mất hành vi mặc định của Claude Code; chỉ dùng cho worker không tool |
| **S10** | **Quan sát**: tab Chi phí thêm lượt/tin người dùng, tỉ lệ lượt do agent đánh thức, ghi so với đọc cache, kích thước session theo thời gian; cảnh báo lượt tốn bất thường (Telegram); **`scripts/live/bench-tokens.ts`** làm thước đo trước/sau | — | Điều kiện để mọi bước khác có bằng chứng | 1 ngày | — |

Việc **không** nên làm: tự đặt `cache_control` (CLI đã làm); đổi model/effort tùy hứng giữa session (vô hiệu cache, trừ effort trên dòng 5.5); `/compact` hay tóm tắt bằng LLM khi cache đã nguội (tự nó là một yêu cầu lớn); `autoCompactWindow` (SDK chỉ cho đặt cho subagent, nên ta tự xoay vòng).

## 4. Thứ tự đề xuất

1. **S10 phần đo** (bench-tokens) để có thước đo, **S1** ngay sau đó và đo lại. Dự kiến thấy mức giảm lớn nhất ở bước này.
2. **S2** (sửa lỗi) cùng S6.
3. **S3, S4, S5** (cấu hình và giới hạn), mỗi bước đo bằng bench.
4. **S7, S8** sau khi có số liệu thật của bạn cho biết session dài hay chuỗi qua lại mới là thủ phạm.

Tổng khoảng 7–8 ngày công cho tất cả; **S10+S1+S2 khoảng 2,5 ngày** và xử lý phần lớn cả chi phí lẫn lỗi.

## 5. Tiêu chí xong của mỗi bước

1. `bench-tokens` trước/sau (cùng kịch bản chuẩn: 3 worker, 1 yêu cầu có phối hợp, Claude thật) cho thấy mức giảm **đo được**, ghi con số vào tài liệu.
2. `npm test` và các kịch bản live liên quan vẫn qua (memory/skills, read-only, webhook, telegram, daemon, plan).
3. Không worker nào mất khả năng đã có ngoài những gì khai báo trong thay đổi (S1 liệt kê rõ tool bị bỏ khi chưa khai báo).

## 6. Điều đã đo nhưng cần nhớ giới hạn

- Đo trên `haiku`, một lượt, `settingSources: []`. Dự án thật có `CLAUDE.md`, skills và lịch sử, nên tiền tố thật lớn hơn; **mức tiết kiệm tuyệt đối từ S1 (~21–27 nghìn token mỗi session) thì giữ nguyên**, tỉ lệ phần trăm sẽ nhỏ hơn.
- Số token "tương đương giá" dựa vào hệ số cache trong tài liệu; hóa đơn thật còn phụ thuộc model, gói thuê bao hay API key, và TTL.
- Chưa đo: tác động của S6, S7, S8 lên chất lượng (cần bench có tiêu chí đúng/sai, không chỉ đếm token).

## 7. Điều cần từ bạn

- Có đồng ý S1 **đổi mặc định** (worker chỉ có lõi 6 tool trừ khi khai báo `tools:`), đổi lại tiết kiệm lớn?
- `usage.jsonl` hoặc ảnh tab Chi phí (theo worker, model, task) để xếp S8 và S7 theo dữ liệu thật.
- Bạn dùng gói thuê bao hay API key (ảnh hưởng S5 và cách tính hạn mức)?

## 8. Nguồn

- Claude Code, quản lý chi phí: <https://code.claude.com/docs/en/costs>
- Claude Code, prompt caching (TTL, các hành động làm mất cache, `CLAUDE_CODE_PROMPT_CACHE_TTL`): <https://code.claude.com/docs/en/prompt-caching.md>
- Cấu hình model, effort, auto-compact: <https://code.claude.com/docs/en/model-config.md>
- Agent SDK (TypeScript) Options: <https://code.claude.com/docs/en/agent-sdk/typescript>
- Prompt caching (API): <https://platform.claude.com/docs/en/build-with-claude/prompt-caching>
- Anthropic, hệ nghiên cứu nhiều agent (4× / 15×): <https://www.anthropic.com/engineering/multi-agent-research-system>
- The Complexity Trap (observation masking): <https://arxiv.org/pdf/2508.21433>
- RCR-Router (chưa đọc toàn văn): <https://arxiv.org/pdf/2508.04903>
- Số đo tự làm: `scripts/measure-prefix.mjs` (cùng SDK 0.3.309 của dự án); đo lặp lại bằng `node scripts/measure-prefix.mjs`.


## Bổ sung 0.13.2 — theo log thật của một người dùng

Số liệu từ `usage.jsonl` của một dự án thật (187 lượt, ~6 giờ): `fw` và `be` chiếm ~2/3 mức dùng; mỗi lượt đọc lại ~520–570 nghìn token cache vì session sống lâu; ghi cache là khoản lớn nhất. Hai thay đổi: (1) **đổi session** khi context vượt `contextLimit` (mặc định 150000, không áp cho điều phối viên); (2) **cắt output Bash** ở 15000 ký tự. Gợi ý cấu hình không cần code: cho các worker làm việc nhẹ (QA, review) dùng `model:` nhỏ hơn, giữ model mạnh cho điều phối viên và người viết code. **Chưa đo** mức tiết kiệm sau thay đổi; cách đo: so token đọc/ghi cache mỗi lượt của từng worker trong `usage.jsonl` trước và sau (và `npm run bench:tokens` cho kịch bản nhỏ).


## Bổ sung 0.14.5 — đo mức sàn không tốn hạn mức

Lệnh "AgentRoom: Đo context cố định của session mới" (`agentroom.measureContext`) cho biết mỗi worker Claude mang bao nhiêu token trước khi làm gì (system prompt, tool, CLAUDE.md, skill, MCP), bằng `getContextUsage` của SDK trên một query có luồng input không bao giờ gửi tin. Lý do: trên log thật, session mới đã ~70–125 nghìn token trong khi file CLAUDE.md/skill của dự án đó chỉ vài nghìn, và mức sàn này bị đọc lại ở mọi lần gọi.
