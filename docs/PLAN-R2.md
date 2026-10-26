# PLAN-R2: chương trình nhiều milestone, gate tự động, dừng chờ ở gate thiết bị và gate người

**Trạng thái: đề xuất để duyệt. Chưa có mã.** Mọi thứ dưới đây là thiết kế, không phải tính năng đã có. Phần "chưa kiểm chứng" ở cuối nói rõ những gì chưa biết.

## 1. Vì sao có tài liệu này

Các phép đo ở `docs/BENCH-ROOM.md` cho thấy với việc nhỏ (một vùng, vài file, đặc tả tự chứa), một agent làm tuần tự cho cùng kết quả với chi phí thấp hơn 3–6 lần so với một đội. Vì vậy giá trị của đội, nếu có, không nằm ở việc nhỏ. Giả thuyết đang được theo đuổi (chưa kiểm chứng):

> AgentRoom đáng dùng cho chương trình lớn, nhiều milestone, nhiều chủ sở hữu, cần chạy kéo dài và tự kiểm duyệt theo các cổng (gate) đã khai báo, chấp nhận chi phí cao hơn để đổi lấy hệ thống quản lý tự động.

Hiện nay, khi giao một brief lớn, việc chạy **không liền mạch**: người dùng phải can thiệp nhiều. Đọc mã cho thấy lý do cụ thể:

- Task (`src/core/tasks.ts`, `TaskBoard`) chỉ có tiêu đề, mô tả, phụ thuộc, trạng thái; `complete()` đặt `done` ngay khi worker gọi `complete_task`. Không có tiêu chí nghiệm thu hay bằng chứng: "báo xong" là "xong".
- `coordinator` là một cờ trên worker; không có runtime nào theo dõi tiến độ, phát hiện kẹt, hay tự chuyển bước.
- Không có khái niệm milestone, gate, ngân sách theo hạng mục, hay trạng thái cấp chương trình để tiếp tục sau gián đoạn.

## 2. Mục tiêu và không-mục-tiêu

**Mục tiêu**
1. Một **chương trình** khai báo milestone, hạng mục, gate; hệ thống tự chạy đến khi gặp gate cần người hoặc thiết bị.
2. **Báo xong ≠ xong**: một hạng mục chỉ được coi là đạt khi bằng chứng đạt mức đã khai báo.
3. **Dừng chờ có kiểm soát** ở gate thiết bị và gate người, rồi tiếp tục khi người nhập kết quả. Không bỏ qua, không đoán thay.
4. **Có trần**: ngân sách theo milestone, số lần thử lại, thời gian; chạm trần thì dừng và hỏi.
5. **Truy vết**: sổ bằng chứng chỉ ghi thêm (append-only), biết ai/khi nào/nguồn nào.

**Không-mục-tiêu (sprint đầu)**
- Tự phân rã mục tiêu thành hạng mục (planner). Người (hoặc `lead` rồi người duyệt) viết chương trình.
- Phát hiện việc chủ động, học tự động, hồ sơ năng lực worker, mức tự chủ L4.
- Thay thế UAT: UAT cần người dùng nghiệp vụ. Hệ thống chỉ chuẩn bị gói bằng chứng "sẵn sàng cho UAT".
- Hỗ trợ chế độ `legacy` (xem mục 8).

## 3. Khái niệm

**Chương trình** (`program`): một tệp khai báo, do người viết hoặc người duyệt, gồm các **milestone** có thứ tự phụ thuộc. Mỗi milestone có các **hạng mục** (work item, ánh xạ tới task hiện có), các **gate**, **ngân sách** và **vùng** (thư mục được phép sửa).

**Ba loại gate**

| Loại | Ai chạy | Hành vi khi chạm gate |
|---|---|---|
| `auto` | máy chủ chạy một lệnh đã khai báo (test, build, lint, e2e, quét bảo mật) | chạy, ghi kết quả; đạt thì đi tiếp, hỏng thì thử lại có giới hạn |
| `device` | người cắm thiết bị và chạy kịch bản (ví dụ benchmark trên bo mạch) | milestone **dừng chờ**; hệ thống sinh hướng dẫn và mẫu kết quả; tiếp tục khi người nhập kết quả |
| `human` | người quyết hoặc ký duyệt (ADR, ngưỡng, UAT) | milestone **dừng chờ** kèm gói bằng chứng; tiếp tục khi người nhập quyết định |

**Thang bằng chứng** (cấu hình được; mặc định `D` tài liệu, `C` mã, `T` test đạt, `H` thiết bị, `R` production, `U` người dùng xác nhận): mỗi gate cấp một mức; mỗi milestone khai báo mức cần đạt (`needs`). Worker chỉ tạo được bằng chứng mà nó có thật (`C`, `T` do máy chủ chạy). `H`, `R`, `U` chỉ đến từ người nhập. Nhãn **"hoàn thành"** chỉ cấp khi đủ mức `needs`; chưa đủ thì nhãn là "đã triển khai, chờ bằng chứng H" (hoặc mức tương ứng).

**Vùng cấm và ADR mở**: khai báo đường dẫn không được đụng và danh sách quyết định chưa chốt. Hạng mục chạm vùng cấm hoặc phụ thuộc ADR chưa quyết bị **chặn chờ người**, không thử cho qua (khớp quy tắc 1 và 2 trong `CLAUDE.md`).

### Ví dụ tệp chương trình (giản lược)

```yaml
program: sort-rush
evidence: [D, C, T, H, U]          # thang bằng chứng
red_lines: [infra/, "**/.env"]
milestones:
  - id: m1-server
    needs: T
    budget: { cache_write: 300000, max_turns: 40, wall_minutes: 90 }
    items: [ { task: "Server Sort Rush", owner: be, zone: [rules-service/] } ]
    gates:
      - { id: unit, type: auto, run: "npm test", cwd: rules-service, gives: T }
      - { id: build, type: auto, run: "npm run build", cwd: rules-service, gives: C }
  - id: m2-client
    depends_on: [m1-server]
    needs: H
    gates:
      - { id: e2e, type: auto, run: "npm test", cwd: play-frontend, gives: T }
      - { id: kiosk, type: device, instruction: "Chạy kịch bản kiosk 30 lượt và nhập số lỗi", result: { errors: int }, pass_if: "errors == 0", gives: H }
  - id: m3-release
    depends_on: [m2-client]
    needs: U
    gates:
      - { id: approve, type: human, question: "Duyệt phát hành thử cho nhóm nội bộ?", gives: U }
```

## 4. Vòng chạy

```
milestone sẵn sàng (phụ thuộc đã đạt)
  → giao hạng mục cho worker (task có level; trong vùng của owner)
  → worker báo "claimed_done" (complete_task không còn đặt done)
  → máy chủ chạy gate auto (không phải worker)
       đạt → ghi bằng chứng (T/C) → nếu cần H/U: mở gate device/human
       hỏng → thử lại có giới hạn (tăng level một bậc, hoặc đổi worker) → hết giới hạn → dừng + gói leo thang
  → gate device/human: milestone ở trạng thái "chờ người"; milestone độc lập khác vẫn chạy
       người nhập kết quả (lệnh VS Code / CLI daemon) → ghi bằng chứng (H/U) → chạy tiếp
  → đủ `needs` → "hoàn thành"; milestone kế tiếp sẵn sàng
```

Chạm trần ngân sách, hết hạn mức gói (PlanMonitor), hoặc lệnh dừng của người: chương trình **tạm dừng**; tiếp tục tự động khi hết hạn mức hoặc khi người tiếp tục, không mất trạng thái.

## 5. Trạng thái hạng mục và milestone

`proposed → in_progress → claimed_done → verifying → verified` (đủ mức bằng chứng) ; nhánh: `blocked_red_line`, `blocked_adr`, `waiting_device`, `waiting_human`, `retrying(n)`, `paused_budget`, `paused_quota`, `failed` (hết thử lại, chờ người), `cancelled`. Mỗi chuyển trạng thái là một sự kiện chỉ ghi thêm, có người/máy gây ra và lý do.

## 6. Ràng buộc từ quy tắc dự án

- **Quy tắc 1, 2 (quyền do người cấp, không đoán):** lệnh của gate chỉ đến từ tệp chương trình **do người duyệt** (băm nội dung được ghim). Agent chỉ *đề xuất* đổi chương trình; đề xuất đó ở trạng thái chờ người duyệt. Máy chủ chạy lệnh gate qua cùng danh sách cho/chặn của `autonomy.ts`; gate không nâng quyền.
- **Quyền nhập kết quả:** chỉ người (lệnh VS Code, CLI daemon; Telegram để sau và phải có PIN) nhập được kết quả gate `device`/`human`. **Không có công cụ MCP cho việc đó**; API từ chối nguồn là agent hoặc nội dung ngoài.
- **Quy tắc 3:** tin hệ thống về gate/dừng không chứa `@`.
- **Quy tắc 6:** trạng thái chương trình đi trong prompt của lượt (`TaskPacket`), không vào system prompt ổn định.
- **Quy tắc 8:** tin của người dùng không bao giờ bị chặn bởi giới hạn chương trình; lệnh dừng/tiếp tục của người luôn có hiệu lực.
- **Quy tắc 9:** nội dung kết quả gate, log lệnh, nội dung do worker viết là dữ liệu không tin cậy (bọc `<untrusted_payload>` khi đưa lại cho model); log lệnh được che bí mật (`redactSecrets`).
- **Quy tắc 12:** chuỗi hiển thị qua `tr()`.
- **Giữ hành vi cũ:** task ngoài chương trình giữ nguyên, kể cả `complete_task` ra `done` ngay. Chỉ hạng mục thuộc chương trình đi qua `claimed_done`.

## 7. Dữ liệu và điểm gắn vào mã

Dựa trên những gì đã có (đã đọc trong repo): `src/storage/` (migration tới v9, Run/Step có lease, sổ sự kiện), `DurableTurnQueue`, phê duyệt bền, `TaskPacket`, `Room.runTurn`, `TaskBoard`, `complete_task` trong `src/mcp/server.ts`, PlanMonitor trong `src/core/plan.ts`.

- Migration v10: bảng `programs`, `milestones`, `gates`, `evidence` (chỉ ghi thêm), `program_events`.
- Mô-đun mới `src/program/`: bộ đọc và kiểm tra tệp chương trình, máy trạng thái, bộ chạy gate `auto` (hết hạn `timeout`, giới hạn đầu ra, che bí mật), bộ lập lịch milestone, trần ngân sách.
- Điểm gắn: `complete_task` (rẽ nhánh cho hạng mục thuộc chương trình), `Room` (vòng chạy và nối với `PlanMonitor`), lệnh VS Code và CLI daemon (nhập kết quả, tiếp tục, duyệt đổi chương trình), tab *Chương trình* (danh sách milestone, gate, bằng chứng, nút nhập kết quả).

## 8. Điều kiện: cần `durable`

Trạng thái chương trình phải bền qua tắt đột ngột và qua nhiều cửa sổ hạn mức, nên dùng SQLite. Ở `legacy`, tính năng này **tắt** và báo rõ lý do (không giả lập bằng file). Đây là điều kiện chấp nhận cái giá của gói SQLite. Khuyến nghị: yêu cầu `durable` cho chương trình, đồng thời ổn định `durable` trên project thật là việc của sprint đầu (chưa chạy lâu với Claude thật, chưa thử qua daemon/VPS).

## 9. Phạm vi sprint đầu (lát cắt chạy được)

1. Tệp chương trình, kiểm tra hợp lệ, migration v10, sổ sự kiện.
2. Gate `auto` do máy chủ chạy; `claimed_done` thay cho `done` trong chương trình; sổ bằng chứng.
3. Thử lại có giới hạn (mặc định 2, tăng level một bậc), trần ngân sách theo milestone, tạm dừng khi hết hạn mức.
4. Gate `device` và `human`: dừng chờ, nhập kết quả bằng lệnh VS Code/CLI, tiếp tục; milestone độc lập vẫn chạy.
5. Vùng cấm và ADR mở chặn chờ người.
6. Tab *Chương trình* tối thiểu.

Sprint này **không** gồm planner, Telegram để nhập kết quả, học tự động, proactive.

## 10. Nghiệm thu: kịch bản và chỉ số

Dựng chương trình mô phỏng 3 milestone trên nền các fixture `sortrush-*` (`docs/BENCH-ROOM.md`): M1 server (gate auto: test ẩn), M2 client (gate auto + một gate `device` mà bộ đo nhập kết quả sau khi run dừng), M3 báo cáo (gate `human` mà bộ đo nhập quyết định). Kịch bản bắt buộc có test tự động:

1. Mọi gate `auto` đạt → milestone đạt, milestone kế tự bắt đầu, không cần người.
2. Worker báo xong nhưng gate hỏng → thử lại; hết giới hạn → dừng kèm gói leo thang; **không** gắn nhãn hoàn thành.
3. Gate `device`: milestone dừng chờ, milestone độc lập vẫn chạy; nhập kết quả mức thấp hơn `needs` không thỏa gate; nhập đủ mức thì tiếp tục.
4. Gate `human`: agent không nhập được kết quả (không có công cụ; API từ chối).
5. Chạm trần ngân sách → tạm dừng, không tốn thêm, chờ quyết định.
6. Hết hạn mức gói → tạm dừng, tự tiếp tục khi hết.
7. Tắt đột ngột giữa chừng → khôi phục trạng thái, không trùng kết quả gate hay lượt.
8. Hạng mục chạm vùng cấm hoặc ADR chưa quyết → chặn.
9. Agent đề xuất đổi lệnh gate → chờ người duyệt; băm bị ghim.

**Chỉ số** (thay cho benchmark token): tỉ lệ gate `auto` qua không cần người; số lần can thiệp mỗi milestone (phân loại: thẻ duyệt, câu hỏi, kẹt, lỗi, gate người/thiết bị); cache-write mỗi milestone; **số lần "hoàn thành" sai (phải bằng 0)**; lỗi lọt qua gate (test ẩn); đúng đắn khi tiếp tục. So với cách chạy hiện nay (ba lời giao việc riêng, người đứng canh) trên cùng chương trình.

Phép đo với Claude thật tốn quota; sẽ nêu trần ngân sách trước khi chạy và bắt đầu bằng một lượt thử.

## 11. Chưa kiểm chứng và rủi ro

- Tôi chưa biết `complete_task` đang được dùng thế nào trong các luồng khác (UI, daemon, Telegram); đổi hành vi cho hạng mục chương trình cần rà soát trước khi viết mã.
- `durable`: chưa chạy lâu với Claude thật, chưa thử qua daemon/VPS, chưa thử tiếp tục qua nhiều cửa sổ hạn mức.
- Chi phí của chạy kiểu này chưa đo; các phép đo hiện có chỉ ở bài nhỏ (đội tốn 3–6 lần agent đơn).
- Nguy cơ chính: tăng độ phức tạp mà không giảm số lần can thiệp. Vì vậy sprint đầu kết thúc bằng phép đo ở mục 10; nếu số lần can thiệp mỗi milestone không giảm rõ so với cách chạy hiện nay, **dừng** thay vì mở rộng.
- Gate `auto` chỉ tốt bằng chính lệnh của nó: test yếu thì "đạt" vẫn là bằng chứng yếu. Tài liệu này không giải quyết chất lượng của test.
- Một số tiêu chí "hoàn thành" cần người và thiết bị thật (UAT, benchmark phần cứng, dữ liệu có đồng ý) và sẽ luôn cần người.

## 12. Quyết định cần chủ dự án chốt

1. Gate `device` và `human` **dừng chờ**, tiếp tục khi người nhập kết quả (đã xác nhận). Ai được nhập? Đề xuất: chủ máy qua VS Code hoặc CLI daemon; Telegram (có PIN) để sau.
2. Chương trình **bắt buộc** `durable` (khuyến nghị) hay thiết kế thêm đường `legacy`?
3. Mặc định: thử lại 2 lần, tăng level một bậc; ngân sách theo milestone **bắt buộc khai báo**.
4. Tên và số mức của thang bằng chứng (mặc định `D/C/T/H/R/U`, cấu hình được).
5. Trần ngân sách cho các phép đo Claude thật ở mục 10.
