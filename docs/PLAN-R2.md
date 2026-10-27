# PLAN-R2 (v2): chương trình nhiều milestone, gate có kiểu, dừng chờ có kiểm soát

**Trạng thái: kế hoạch triển khai để chủ dự án duyệt. Chưa có mã.** Bản v2 thay bản v1 sau khi (a) đọc mã để gắn từng hạng mục vào điểm có thật, (b) nhận các phản biện đã đồng ý từ báo cáo nghiên cứu ngoài (điều kiện hoàn thành có kiểu, gate không dùng shell, phân loại lỗi, phiên bản chương trình bất biến, ngân sách nhiều chiều). Mọi nhãn **[ĐÃ XÁC MINH]** nghĩa là đã đọc trong mã ở `main` công khai 0.14.21; **[CHƯA XÁC MINH]** là việc của Sprint 0.

## 1. Vì sao, và điều đã biết

- Các phép đo ở `docs/BENCH-ROOM.md` (bài nhỏ, một vùng, đặc tả tự chứa): một agent làm tuần tự cho cùng kết quả 16/16 với 37K–41K cache-write, trong khi đội năm worker cần 139K (≈3,5 lần) và không nhanh hơn; ở lượt song song đo thêm, lỗi xuất hiện ở chỗ nối client và server. Vì vậy **đội không phải mặc định tốt hơn**.
- Giả thuyết đang theo đuổi (**chưa kiểm chứng**): AgentRoom đáng tiền ở chương trình lớn, nhiều milestone, kéo dài, kiểm duyệt theo gate đã khai báo, với chi phí cao hơn đổi lấy hệ thống quản lý tự động. Mọi phép đo hiện có đều ngắn hơn vài phút nên chưa chạm tới chế độ này.
- Khoảng trống cụ thể trong mã: `TaskBoard.complete()` đặt `done` ngay khi worker gọi `complete_task`, không có tiêu chí nghiệm thu hay bằng chứng; `coordinator` chỉ là một cờ; không có milestone, gate, ngân sách theo hạng mục, hay trạng thái cấp chương trình.

## 2. Mục tiêu, không-mục-tiêu, cổng giá trị

**Mục tiêu**
1. Chương trình khai báo milestone, hạng mục, gate; hệ thống tự chạy đến khi gặp gate cần người hoặc thiết bị.
2. **Báo xong ≠ xong**: hạng mục chỉ "verified" khi vị từ nghiệm thu thỏa bằng bằng chứng có kiểu.
3. **Dừng chờ có kiểm soát** ở gate thiết bị và gate người; tiếp tục khi người nhập kết quả.
4. **Có trần** nhiều chiều (lượt, thời gian, chi phí, lần thử lại); chạm trần thì dừng và hỏi.
5. **Truy vết**: sổ sự kiện và sổ bằng chứng chỉ ghi thêm.

**Không-mục-tiêu (đến khi qua cổng giá trị ở mục 10)**: planner phân rã mục tiêu, trí nhớ thông minh, proactive, học tự động, bộ định tuyến model, bảng điều khiển đầy đủ, chữ ký mật mã cho capability, hỗ trợ `legacy`, gate chạy trên máy từ xa.

**Cổng giá trị (bắt buộc, sau Sprint 2)**: chương trình mô phỏng cố định (mục 9.4) chạy theo hai cách, *đối chứng* (cách làm hiện nay: người giao từng milestone và đứng canh) và *R2*. Tiếp tục (Sprint 3+) chỉ khi R2 đạt đồng thời: **0 lần "hoàn thành" sai**; số lần can thiệp ngoài kế hoạch mỗi milestone ≤ một nửa đối chứng; chi phí mỗi milestone verified ≤ 2,0 lần đối chứng. Các ngưỡng này là **đề xuất cần chủ dự án duyệt**, không phải kết quả đã đạt. Nếu không đạt thì dừng và xem lại, không mở rộng.

## 3. Điểm gắn vào mã (đã đọc)

| Điểm | Sự thật trong mã | Hệ quả cho thiết kế |
|---|---|---|
| Hoàn thành task | Một chỗ gọi `TaskBoard.complete()`: `Room.completeTask(me, id, result)` (`src/core/room.ts`), được gọi từ tool MCP `complete_task` (`src/mcp/server.ts`); bảng tool của gateway (`src/gateway/tools.ts`) cũng khai báo tên này **[ĐÃ XÁC MINH]** | Rẽ nhánh duy nhất ở `Room.completeTask`; task ngoài chương trình giữ nguyên |
| Mô hình `Task` | Trường `level` (0.14.16) từng không được SQLite chiếu, làm đối chiếu thất bại trên project thật (`task-projection`, sửa ở 0.14.19–0.14.20) **[ĐÃ XÁC MINH]** | **Không thêm trường vào `Task`.** Dùng bảng ánh xạ riêng `program_item_tasks`; nếu sau này buộc phải thêm, phải thêm đồng thời vào chiếu và test đối chiếu |
| Sổ sự kiện | `SqliteEventStore.append/appendWithin(event, project)` với hàm chiếu `(tx, stored)`; mẫu dùng ở task/run/step **[ĐÃ XÁC MINH]** | Chương trình dùng cùng mẫu: aggregate `program_run`, `milestone_run`, `gate_run` + bảng chiếu |
| Migration | `schemaMigrations` tới v9 (`taskLevelV9`), mỗi migration là `{version,name,sql}` **[ĐÃ XÁC MINH]** | Thêm v10 chỉ **thêm bảng**; không đổi bảng cũ |
| Step | `kind` là chuỗi tự do (hiện dùng `"model"`); `DurableWorkflowService` có `claim/heartbeat/recover/succeed/fail` **[ĐÃ XÁC MINH]** | Có thể dùng step kind `gate` cho GateRun; **[CHƯA XÁC MINH]** `recover`/`claim` bỏ qua đúng kind lạ |
| PlanMonitor | Thăm dò định kỳ (`setTimeout`) và phát sự kiện `change` (`src/core/plan.ts`); cửa sổ `five_hour`, `seven_day` **[ĐÃ XÁC MINH]** | Gắn `paused_quota` vào sự kiện `change`, không cần thăm dò riêng |
| Thư mục làm việc | Worktree và `cwd` do `resolveCwd` ở extension/daemon/runner quyết định, không ở lõi `Room` **[ĐÃ XÁC MINH]** | Gate nhận `cwd` từ lớp ngoài; Sprint 1 chạy trên máy chủ điều phối, không trên máy từ xa |
| Một bên điều phối | Khóa `room.lock` mỗi `.agentroom/` (quy tắc 5) | Quyền sở hữu độc quyền chương trình đã có ở mức tiến trình; thêm `epoch` để chống tiếp tục hai lần trong cùng tiến trình |
| Local API | Loopback; token 32 byte ngẫu nhiên, file 0600 (`local-api.token`; extension: thư mục `globalStorage`; daemon: `~/.agentroom/`), so sánh thời gian cố định, tiêu đề CSRF; các route gồm **`POST /v1/approvals/:id`**, `/v1/messages`, `/v1/tasks` **[ĐÃ XÁC MINH]** | Không có danh tính người duyệt hay chống phát lại. **Không thêm route nhập kết quả gate vào API ở Sprint 1** (xem mục 4.7) |
| Đường dẫn nhạy cảm | `autonomy.ts` có `HOME_SECRET_DIRS` gồm `.ssh .aws .gnupg .kube .docker .config .azure .gcloud .npm .claude .codex .agentroom`; thư mục hệ thống ngoài `cwd` bị chặn **[ĐÃ XÁC MINH]** | Token của daemon (`~/.agentroom`) và của extension trên Linux (`~/.config`) được phân loại nhạy cảm. Trên macOS (`~/Library/Application Support/...`) và Windows (`AppData`) **[CHƯA XÁC MINH]** — Sprint 0 phải kiểm |
| Daemon CLI | `src/daemon/main.ts` chọn lệnh bằng `switch` (`status`, `autonomy`, `issues`, `cleanup`, …) **[ĐÃ XÁC MINH]** | Thêm nhóm lệnh `program` |
| UI | Tab qua `nav button[data-tab]` trong `media/main.js`; tab *Cài đặt* nhận `getSettings/setSetting` **[ĐÃ XÁC MINH]** | Thêm tab *Chương trình* theo cùng mẫu |
| Lệnh VS Code | Khai báo trong `package.json` (`agentroom.*`) **[ĐÃ XÁC MINH]** | Thêm lệnh nhập kết quả gate và duyệt đề xuất |

**Chưa xác minh (làm ở Sprint 0):** chữ ký repository sau v9; API của Context Broker và `TaskPacket`; lược đồ trí nhớ lai; cách `Room.runTurn` gắn mã tương quan chương trình; đường dẫn token trên macOS/Windows; step kind `gate` với `recover`; tương tác với collab của bản pro; trường tương quan có thêm được vào bản ghi `usage.jsonl` mà không phá đọc dữ liệu cũ.

## 4. Quyết định thiết kế

### 4.1 Điều kiện hoàn thành là vị từ có kiểu, không phải thang
Thang D/C/T/H/R/U chỉ còn là **nhãn hiển thị**. Engine biểu diễn:

```yaml
acceptance:
  allOf:
    - { type: code }
    - { type: unit_test }
    - anyOf:
        - { type: device_test }
        - { type: device_waiver, approvedBy: human }
```
Kiểu bằng chứng mặc định: `code` (commit/diff hash), `unit_test`, `integration_test`, `build`, `lint`, `device_test`, `device_waiver`, `release`, `user_acceptance`, `decision`. Mỗi gate khai báo kiểu nó **sinh ra** (`produces`). Hạng mục "verified" khi vị từ của milestone đúng trên các bằng chứng hợp lệ của phiên bản chương trình và ảnh chụp mã hiện tại.

### 4.2 Gate không dùng shell
`GateSpec` có cấu trúc, không phải chuỗi lệnh:
```yaml
exec: { file: npm, args: ["test"], cwd: rules-service, env: [CI], timeoutSec: 600, outputCapKb: 256 }
```
Chạy bằng `spawn(file, args)` **không shell**; `cwd` được `realpath` rồi phải nằm trong thư mục làm việc đã duyệt; môi trường chỉ gồm danh sách cho phép; chặn khi tìm thấy đường dẫn ra ngoài; đầu ra giới hạn và che bí mật bằng `redactSecrets`; hết hạn thì giết cả cây tiến trình. Shell chỉ được phép bằng một cờ riêng `shell: true` mang mức rủi ro cao và phải được người duyệt ở cấp từng gate. (Bài học từ các phép đo: các lệnh có pipe và heredoc chính là thứ gây kẹt.)

### 4.3 Phiên bản chương trình bất biến
Mỗi lần chạy gắn `programVersion` và `specHash` (băm của dạng chuẩn hóa). Agent **không sửa** bản đang chạy; chỉ tạo đề xuất bản mới (mục 4.8). Chỉ người duyệt mới đổi bản đang chạy sang bản mới, ở ranh giới an toàn (khi không có gate đang chạy).

### 4.4 Phân loại lỗi và dấu vân tay
| Lớp lỗi | Ví dụ nhận biết | Xử lý |
|---|---|---|
| `transient` | timeout mạng, `EAGAIN`, giới hạn hạn mức | thử lại cùng worker, lùi dần |
| `environment` | thiếu lệnh, `npm ci` hỏng, đường dẫn không tồn tại | dừng, sinh gói chẩn đoán cho người |
| `acceptance_failure` | test hoặc build đỏ | trả bằng chứng (tên test lỗi, đoạn log) cho worker sửa |
| `reasoning_failure` | acceptance_failure lặp với cùng dấu vân tay | tăng level một bậc **một lần**, hoặc đổi worker; không thêm lượt khi không đổi gì |
| `policy_block` | chạm vùng cấm, cần quyền | không thử lại; chờ người |
| `ambiguous_requirement` | worker/qa nêu thiếu thông tin | gate `human` |

**Dấu vân tay** = băm của `gateId` + chữ ký lỗi đã chuẩn hóa (tên các test đỏ đã sắp xếp, hoặc K dòng cuối với đường dẫn, số dòng, thời gian được thay bằng ký hiệu) + `snapshotHash` của mã. Hai lần liên tiếp cùng dấu vân tay **và** cùng `snapshotHash` ⇒ dừng trước số lần thử lại tối đa và leo thang lên người.

### 4.5 Ngân sách nhiều chiều
`maxTurns`, `wallMinutes`, `cacheWrite` (và `costUsd` khi có), `retries` mỗi hạng mục và mỗi milestone. Kiểm tra **trước khi giao lượt mới** (không ngắt lượt đang chạy). Chạm trần cứng ⇒ `paused_budget`; chỉ người nâng trần hoặc chấp nhận mới tiếp tục. Mặc định **bắt buộc khai báo**; thiếu thì chương trình không hợp lệ.

### 4.6 Single-Agent-First làm mặc định (Sprint 3, sau cổng)
Hạng mục giao cho **một** worker; chia nhỏ hoặc thêm người rà soát độc lập chỉ khi chương trình khai báo rõ lý do (`parallel: { contractPinned: true }` hoặc `verifier: independent` với rủi ro cao). Không dùng model để chọn worker. Trọng số điểm worker chỉ thêm khi có dữ liệu.

### 4.7 Ai được nhập kết quả gate `device`/`human`
Kết quả mang `nonce` do hệ thống cấp khi mở gate, gắn với `gateRunId` và `specHash`; nhập sai nonce hoặc sai phiên bản bị từ chối; mỗi nonce dùng một lần (chống phát lại). Kênh Sprint 1: **lệnh VS Code** (trong tiến trình extension, không qua mạng) và **CLI daemon**. **Không có tool MCP và không có route HTTP** cho việc này.

Phân tích mối đe dọa (cần chủ dự án biết): Local API hiện đã có `POST /v1/approvals/:id`; ai có token (cùng tài khoản hệ điều hành) có thể duyệt thẻ. Nghĩa là một worker đọc được file token sẽ tự duyệt được. Phòng thủ hiện có là chính sách đường dẫn của `autonomy.ts`. Kế hoạch **không làm yếu thêm** ranh giới này, và Sprint 0 phải (a) kiểm token trên ba hệ điều hành, (b) thêm test rằng Read/Bash tới các đường dẫn token bị hỏi/chặn ở chế độ Manual và Auto. Ở chế độ Full (do người dùng bật) ranh giới này không còn; tài liệu nêu rõ. Chữ ký mật mã cho capability (Ed25519) **hoãn** đến khi có mối đe dọa cụ thể mà băm, nonce và bản ghi phê duyệt không xử lý được.

### 4.8 Đề xuất đổi chương trình
Một tool MCP mới `propose_program_change` (chỉ cấp cho worker `coordinator`, tuân quy tắc 7: bộ tool tường minh) ghi một bản đề xuất ở trạng thái `pending`. Người duyệt bằng lệnh VS Code/CLI, tạo `programVersion` mới có `approvedBy`, `approvedAt`, `specHash`. Đề xuất không bao giờ tự áp dụng.

### 4.9 Trí nhớ
Sprint 1–2 **không** viết trí nhớ mới. Chỉ một ràng buộc: worker không được biến lời của mình thành sự thật bền; đầu ra của gate là bằng chứng chứ không phải trí nhớ. Hợp đồng `candidate → verified` chờ cổng giá trị.

## 5. Dữ liệu (migration v10, chỉ thêm)

Sổ sự kiện dùng bảng `events` sẵn có với aggregate `program_run`, `milestone_run`, `gate_run`; các bảng dưới là bản chiếu và sổ bằng chứng.

| Bảng | Cột chính | Ghi chú |
|---|---|---|
| `program_specs` | `workspace_id, program_id, version, spec_json, spec_hash, approved_by, approved_at, supersedes` | khóa `(workspace_id, program_id, version)`; bất biến |
| `program_runs` | `id, workspace_id, program_id, version, spec_hash, status, epoch, created_at, updated_at` | `epoch` tăng mỗi lần tiếp tục |
| `milestone_runs` | `id, program_run_id, milestone_id, status, budget_json, started_at, ended_at` | |
| `item_runs` | `id, milestone_run_id, item_id, worker_id, attempt, status, snapshot_hash` | |
| `program_item_tasks` | `task_id PK, program_run_id, item_id` | ánh xạ riêng, **không đổi bảng `tasks`** |
| `gate_runs` | `id, milestone_run_id, gate_id, attempt, idempotency_key UNIQUE, status, exit_code, artifact_dir, snapshot_hash, nonce, result_json, started_at, ended_at` | |
| `evidence` | `id, program_run_id, type, subject_ref, producer, artifact_sha256, gate_run_id, spec_hash, snapshot_hash, observed_at, verdict` | **chỉ ghi thêm**: trigger chặn `UPDATE`/`DELETE` |
| `program_proposals` | `id, program_id, base_version, spec_json, spec_hash, proposed_by, status, decided_by, decided_at` | |

`idempotency_key` của gate = `programRun + milestone + gate + specHash + snapshotHash + attempt`. Khởi động lại không chạy lại gate đã có kết quả. `snapshotHash` = băm của `HEAD` + băm `git diff HEAD` + băm danh sách file chưa theo dõi; bằng chứng của ảnh chụp này không dùng cho ảnh chụp khác.

Tệp nhật ký lớn của gate nằm ở `.agentroom/program/artifacts/<gateRunId>/` (đã che bí mật, có sha256); sổ bằng chứng chỉ giữ tham chiếu.

## 6. Máy trạng thái

**Hạng mục:** `proposed → ready → in_progress → claimed_done → verifying → verified`; nhánh `retrying(n)`, `waiting_device`, `waiting_human`, `blocked_policy`, `paused_budget`, `paused_quota`, `failed`, `cancelled`.

| Từ | Sang | Điều kiện / bảo vệ |
|---|---|---|
| `ready` | `in_progress` | phụ thuộc đã verified; còn ngân sách; không chạm vùng cấm |
| `in_progress` | `claimed_done` | worker gọi `complete_task` (hạng mục chương trình) |
| `claimed_done` | `verifying` | tự động; chụp `snapshotHash` |
| `verifying` | `verified` | vị từ nghiệm thu thỏa trên bằng chứng hợp lệ |
| `verifying` | `retrying` | lỗi `transient` hoặc `acceptance_failure`, còn lượt, dấu vân tay mới |
| `verifying` | `waiting_device`/`waiting_human` | vị từ cần bằng chứng `device_*`/`user_acceptance`/`decision` |
| `waiting_*` | `verifying` | nhập kết quả hợp lệ (đúng nonce và phiên bản) |
| bất kỳ | `paused_budget`/`paused_quota` | chạm trần / PlanMonitor báo giới hạn |
| `paused_*` | trạng thái trước | người tiếp tục / hạn mức hồi phục |
| `verifying` | `blocked_policy` | vùng cấm, ADR chưa quyết, cần quyền |
| `verifying` | `failed` | hết thử lại hoặc cùng dấu vân tay hai lần liên tiếp |

Mỗi chuyển là một sự kiện kèm `actor` (`host`/`human`/`worker`), trạng thái trước/sau và lý do. Chuyển không hợp lệ bị từ chối **trong giao dịch**. Milestone `verified` khi mọi hạng mục `verified` và các gate cấp milestone thỏa; milestone độc lập vẫn chạy khi milestone khác đang chờ.

## 7. Ràng buộc từ quy tắc dự án

| Quy tắc | Áp dụng |
|---|---|
| 1, 2 | Lệnh gate chỉ từ chương trình do người duyệt; agent không nâng quyền; cái chưa chắc thì hỏi người (`blocked_policy`/gate `human`) |
| 3 | Tin hệ thống về gate/dừng không chứa `@` |
| 4 | Log che bằng `redactSecrets`; token không vào TaskPacket hay bằng chứng |
| 5 | Một bên điều phối mỗi `.agentroom/` (khóa `room.lock`) |
| 6 | Trạng thái chương trình đi trong prompt của lượt (TaskPacket), không vào system prompt ổn định |
| 7 | `propose_program_change` chỉ cấp cho `coordinator`; không tool mới cho worker khác |
| 8 | Tin của người dùng và lệnh dừng/tiếp tục không bao giờ bị giới hạn chương trình chặn |
| 9 | Kết quả gate, log, đầu ra worker là dữ liệu không tin cậy khi đưa lại cho model (`<untrusted_payload>`) |
| 10 | Mỗi lần tăng `version`: CHANGELOG, README, `CLAUDE.md` cùng commit |
| 11 | Chương trình không xóa file của người dùng; không có gate nào di chuyển/xóa file |
| 12 | Chuỗi hiển thị qua `tr()`; log qua `trVi` |

## 8. Phân rã công việc

Cỡ: S ≤ 1 ngày, M 2–3 ngày, L 4–5 ngày **công**, một lập trình viên; **ước lượng chưa kiểm chứng**, tinh chỉnh sau Sprint 0. Không phải lịch.

### Sprint 0: xác minh (S–M, 2–3 ngày)
| ID | Việc | Cách làm | Xong khi |
|---|---|---|---|
| S0-1 | Token: vị trí và chính sách đường dẫn trên Linux/macOS/Windows | Test `autonomy` cho các đường dẫn token ở Manual và Auto | Có test xanh; nếu có hệ điều hành để lọt, ghi vào tài liệu và sửa chính sách |
| S0-2 | Step kind `gate` | Test `DurableWorkflowService` với step kind lạ qua `recover/claim` | Có kết luận bằng test |
| S0-3 | Rà `TaskPacket`/Context Broker, mã tương quan trong `Room.runTurn` | Đọc mã, ghi sơ đồ gọi | Tài liệu một trang; điểm gắn chốt |
| S0-4 | `usage.jsonl` thêm trường tương quan | Test đọc dữ liệu cũ | Bản ghi cũ vẫn đọc được |
| S0-5 | Đối chứng cho cổng giá trị | Dựng chương trình mô phỏng (9.4) và đo cách chạy hiện nay | Có số can thiệp và chi phí mỗi milestone của đối chứng |

### Sprint 1: mặt phẳng điều khiển và gate `auto` (khoảng 20 ngày công)
| ID | Việc | Module | Kiểm thử | Cỡ |
|---|---|---|---|---|
| P1-1 | Đọc, kiểm tra, chuẩn hóa tệp chương trình; DAG; băm | `src/program/spec.ts` | cùng đầu vào cùng băm; DAG vòng, ID trùng, `budget` thiếu bị từ chối | M |
| P1-2 | Migration v10 + sổ sự kiện + bản chiếu + trigger bằng chứng | `src/storage/schema-v1.ts` (hoặc tệp v10), `src/program/store.ts` | chạy lại migration không phá dữ liệu; `UPDATE`/`DELETE` evidence bị chặn | M |
| P1-3 | Máy trạng thái hạng mục/milestone | `src/program/machine.ts` | bảng chuyển hợp lệ/không hợp lệ; sự kiện trùng không trùng trạng thái | M |
| P1-4 | `claimed_done` cho hạng mục chương trình | `Room.completeTask`, `program_item_tasks` | task ngoài chương trình giữ `done` ngay; hạng mục chương trình ra `claimed_done` | M |
| P1-5 | Bộ chạy gate `auto` (không shell) | `src/program/gate-runner.ts` | timeout, giết cây tiến trình, `realpath`/symlink, env allowlist, giới hạn đầu ra, che bí mật | L |
| P1-6 | `snapshotHash` và idempotency | `src/program/snapshot.ts` | khởi động lại không chạy lại gate đã xong; bằng chứng của ảnh chụp A không thỏa ảnh chụp B | M |
| P1-7 | Bộ lập lịch milestone và vòng chạy | `src/program/orchestrator.ts` | milestone kế tự `ready` khi gate đạt; milestone độc lập chạy song song | M |
| P1-8 | Lệnh VS Code và CLI: nạp, duyệt, xem, tạm dừng/tiếp tục | `src/extension.ts`, `src/daemon/main.ts`, `package.json` | CLI và lệnh gọi cùng một lớp dịch vụ; tin hệ thống không có `@` | M |
| P1-9 | Tab *Chương trình* tối thiểu (danh sách, trạng thái, bằng chứng) | `src/ui/`, `media/main.js` | `tr()` đủ hai ngôn ngữ (`test/i18n.test.ts`) | M |
| P1-10 | Cờ `agentroom.program.enabled` (mặc định tắt) và chặn ở `legacy` | `package.json`, `src/extension.ts`, `src/daemon/daemon.ts` | bật ở `legacy` báo rõ lý do, không ghi gì | S |
| P1-11 | Harness chạy chương trình bằng adapter giả | `test/program-*.test.ts`, mở rộng `test/helpers.ts` | các kịch bản T1–T4 (mục 9.1) | M |

**Cổng Sprint 1:** trạng thái chương trình sống sót qua tắt đột ngột một cách xác định (T7); false completion = 0 trong ma trận test. Không đạt thì không sang Sprint 2.

### Sprint 2: gate thiết bị/người, ngân sách, thử lại, chính sách (khoảng 24 ngày công)
| ID | Việc | Kiểm thử | Cỡ |
|---|---|---|---|
| P2-1 | Gate `device`/`human`: mở gate, sinh gói hướng dẫn và mẫu kết quả (có kiểu), nonce, nhập kết quả, tiếp tục | T3, T4, T10 | L |
| P2-2 | Vị từ nghiệm thu `allOf/anyOf`, kiểu bằng chứng, `device_waiver` | bằng chứng không đủ thì không `verified`; waiver cần `approvedBy: human` | M |
| P2-3 | Phân loại lỗi, dấu vân tay, thử lại có giới hạn, dừng sớm khi lặp | T2, T11 | L |
| P2-4 | Ngân sách nhiều chiều; kiểm trước khi giao lượt; `paused_budget` | T5 | M |
| P2-5 | `paused_quota` qua PlanMonitor `change`; tự tiếp tục | T6 | M |
| P2-6 | Vùng cấm và ADR mở chặn chờ người | T8 | M |
| P2-7 | Phiên bản chương trình bất biến; đề xuất đổi (`propose_program_change`); duyệt; áp dụng ở ranh giới an toàn | T9 | L |
| P2-8 | Phục hồi: khởi động lại ở mọi trạng thái; `epoch` | T7 | M |
| P2-9 | Tương quan phép đo: mã chương trình/milestone/hạng mục/lần thử trong `usage.jsonl`; các chỉ số can thiệp có phân loại | kiểm tra khớp với sổ sự kiện | M |
| P2-10 | Chạy cổng giá trị trên chương trình mô phỏng (đối chứng và R2) | báo cáo số đo | M |

**Cổng Sprint 2 (cổng giá trị, mục 2):** quyết định tiếp tục hay dừng dựa trên số đo, không dựa trên cảm nhận.

### Sprint 3+ (chỉ sau cổng giá trị; chỉ phác thảo)
Dispatcher Single-Agent-First và TaskPacket theo hạng mục; bộ phát hiện kẹt và tái lập kế hoạch có giới hạn; hợp đồng trí nhớ `candidate → verified`; bảng điều khiển; sandbox và chữ ký nếu có mối đe dọa cụ thể; gate trên máy từ xa. Mỗi mục có cổng riêng; không cam kết.

## 9. Kiểm thử

### 9.1 Kịch bản bắt buộc (adapter giả, trong `npm test`)
| ID | Kịch bản | Kỳ vọng |
|---|---|---|
| T1 | Mọi gate `auto` đạt | milestone `verified`, milestone kế tự bắt đầu, không cần người |
| T2 | Worker báo xong nhưng gate hỏng | thử lại; hết giới hạn thì dừng kèm gói leo thang; **không** nhãn hoàn thành |
| T3 | Gate `device` | milestone chờ; milestone độc lập vẫn chạy; kết quả thiếu kiểu/sai nonce bị từ chối; đủ thì tiếp tục |
| T4 | Gate `human` | agent/tool MCP không nhập được kết quả |
| T5 | Chạm trần ngân sách | `paused_budget`; không giao lượt mới; chờ người |
| T6 | PlanMonitor báo giới hạn rồi hồi phục | `paused_quota` rồi tự tiếp tục, không chạy lại gate đã xong |
| T7 | Tắt đột ngột ở `verifying`/`waiting_*`/giữa gate | khởi động lại đúng trạng thái; không trùng gate hay kết quả |
| T8 | Hạng mục chạm vùng cấm / ADR chưa quyết | `blocked_policy`, không hiệu ứng phụ |
| T9 | Agent đề xuất đổi lệnh gate | `pending`; bản đang chạy không đổi; băm không đổi |
| T10 | Phát lại nonce cũ / kết quả cho phiên bản cũ | bị từ chối và ghi sự kiện |
| T11 | Cùng dấu vân tay hai lần liên tiếp | dừng sớm, không tốn lượt model thêm |
| T12 | Bằng chứng của ảnh chụp A dùng cho ảnh chụp B | không thỏa vị từ |
| T13 | Gate cố thoát `cwd`/symlink/ghi `.env` | bị chặn, không hiệu ứng phụ, có sự kiện |
| T14 | `legacy` + bật chương trình | báo lý do, không ghi gì; task cũ không đổi |

### 9.2 Bất biến an toàn (mỗi phát hành)
0 "hoàn thành" sai; 0 kết quả gate nhập bởi agent; 0 gate chạy hai lần cho cùng khóa; 0 lượt model mới sau khi chạm trần cứng; chương trình bị sửa băm không chạy.

### 9.3 Harness
Mở rộng `test/helpers.ts` (`Fake`, `makeRoom`) bằng chương trình mẫu và bộ chạy gate giả (kết quả lập trình trước). `npm run bench:room` thêm kịch bản `program` để đo thời gian thêm mỗi chuyển trạng thái.

### 9.4 Chương trình mô phỏng cho cổng giá trị (Claude thật)
Ba milestone nối tiếp trên nền các fixture `sortrush-*` (`docs/BENCH-ROOM.md`): M1 server (gate `auto`: test ẩn), M2 client (gate `auto` + một gate `device` mà bộ đo nhập kết quả sau khi chương trình dừng), M3 báo cáo (gate `human` mà bộ đo nhập quyết định). Đối chứng: ba lời giao việc riêng, người đứng canh (số can thiệp được đếm theo phân loại). Chỉ số: số can thiệp ngoài kế hoạch mỗi milestone (thẻ duyệt, câu hỏi, kẹt, lỗi), cache-write mỗi milestone verified, số "hoàn thành" sai, lỗi lọt qua gate. Chạy bằng Claude thật tốn quota: **trần ngân sách do chủ dự án đặt trước khi chạy**; bắt đầu bằng một lượt thử và dừng nếu vượt ước tính.

## 10. Phát hành, lui bước và rủi ro

- **Phát hành:** cờ `agentroom.program.enabled` mặc định tắt, chỉ bật khi `durable` khỏe. Đây là công cụ chọn tham gia, không đổi hành vi hiện có. Số phiên bản và `CHANGELOG`/README theo quy tắc 10 (đề xuất bản công khai tiếp theo sau 0.14.21, đưa sang bản pro bằng cách gộp như thường lệ).
- **Lui bước:** tắt cờ; bảng v10 bị bỏ qua; không hạ migration; task cũ giữ nguyên. Dữ liệu chương trình giữ lại để bật lại sau.
- **Dừng ngay nếu:** có "hoàn thành" sai; agent nhập được kết quả gate; cùng gate tạo hiệu ứng phụ hai lần; mất hoặc hỏng trạng thái bền; hai bên cùng điều phối một chương trình; vẫn giao lượt model mới sau trần cứng; chương trình bị sửa vẫn chạy; bằng chứng của ảnh chụp này dùng cho ảnh chụp khác.

| Rủi ro | Mức | Giảm thiểu |
|---|---|---|
| Tăng độ phức tạp mà không giảm can thiệp | Cao | Cổng giá trị sau Sprint 2; không mở rộng khi không đạt |
| Gate `auto` yếu (test yếu thì "đạt" vẫn yếu) | Cao | Tài liệu nêu rõ; gate là hợp đồng do người viết; không giải quyết chất lượng test |
| Token Local API đọc được bởi worker | Cao | Sprint 0 (S0-1); không thêm route nhập kết quả; ghi rõ ranh giới ở chế độ Full |
| Thêm trường vào `Task` gây lỗi đối chiếu SQLite | Cao | Không đổi `Task`; bảng ánh xạ riêng |
| `durable` chưa chạy lâu với Claude thật | Cao | Thêm kịch bản tắt đột ngột; không bật mặc định |
| Chi phí cao hơn một worker | Trung bình | Single-Agent-First; ngân sách bắt buộc; cổng giá trị đặt trần 2,0 lần |
| Một số kết quả cần người và thiết bị thật (UAT, phần cứng, dữ liệu có đồng ý) | Cố hữu | Gate `device`/`human` dừng chờ; không thay UAT |

## 11. Quyết định cần chủ dự án chốt trước Sprint 1

1. **Kênh nhập kết quả gate:** lệnh VS Code và CLI daemon (khuyến nghị), không HTTP/Telegram ở Sprint 1. Đồng ý?
2. **`durable` bắt buộc** cho chương trình (khuyến nghị) hay thêm đường `legacy`?
3. **Mặc định:** thử lại tối đa 2, dừng sớm khi cùng dấu vân tay; ngân sách bắt buộc khai báo. Đồng ý?
4. **Ngưỡng cổng giá trị:** 0 hoàn thành sai; can thiệp ≤ 0,5 lần đối chứng; chi phí ≤ 2,0 lần đối chứng. Đồng ý hay đổi?
5. **Trần ngân sách** cho phép đo Claude thật ở S0-5 và P2-10.
6. **Chữ ký mật mã cho capability:** hoãn (khuyến nghị) đến khi có mối đe dọa cụ thể.
7. **Cấp bản phát hành:** tính năng này đi vào bản công khai (trung tính), không vào riêng bản pro?

## 12. Chưa kiểm chứng (nhắc lại)

- Hiệu ích của toàn bộ hướng này ở chương trình lớn: **chưa có bằng chứng**; cổng giá trị là cách duy nhất ta có để biết.
- Chi phí của chạy kiểu này, hiệu quả của thử lại theo dấu vân tay, và việc `durable` giữ vững qua nhiều ngày: chưa đo.
- Các điểm ở mục 3 đánh dấu **[CHƯA XÁC MINH]**.
- Ước lượng ngày công chưa kiểm chứng và sẽ được tinh chỉnh sau Sprint 0.
