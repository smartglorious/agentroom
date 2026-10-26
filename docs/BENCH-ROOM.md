# Đo cơ chế của Room, tự động (`npm run bench:room`)

Chạy cùng một phòng với model giả (độ trễ cố định), ở `legacy` và `durable`, lặp nhiều lần. **Không tốn quota** và không cần đăng nhập Claude.

```bash
npm run bench:room                              # bảng kết quả
npm run bench:room -- --json                    # JSON, để lưu hoặc so sánh
npm run bench:room -- --scenario=longturn --reps=10
npm run bench:room -- --max-overhead-ms=100     # đỏ nếu durable chậm hơn legacy quá 100 ms mỗi lượt
```

Tham số: `--reps` (mặc định 5), `--size` (số tin trong `chat`, số worker trong `burst`; mặc định 6), `--latency` (ms của model giả; mặc định 20), `--scenario`, `--json`, `--max-overhead-ms`.

## Kịch bản

| Tên | Làm gì | Bắt được |
|---|---|---|
| `chat` | Nhiều tin liên tiếp, mỗi tin đánh thức hai worker | Thời gian thêm mỗi lượt của `durable` |
| `burst` | Một tin đánh thức nhiều worker cùng lúc | Lỗi đồng thời, lượt chạy hai lần |
| `longturn` | Một lượt chạy lâu hơn lease trong khi worker khác nhận việc | Lỗi `Event version conflict`, lượt bị chạy lại (đỏ nếu tắt gia hạn lease) |
| `crash` | Tiến trình chết giữ lease; lần khởi động sau phải làm nốt đúng một lần (chỉ `durable`) | Phục hồi sau khi tắt đột ngột |

Mã ở `test/bench/`. `test/bench-room.test.ts` chạy cả bốn kịch bản ở cỡ nhỏ trong `npm test`, nên lỗi đồng thời hoặc phục hồi hỏng sẽ làm CI đỏ.

## Đo được gì, không đo được gì

- **Đo:** thời gian thêm của `durable` mỗi lượt, lỗi và lượt dư khi chạy đồng thời, phục hồi sau khi tắt.
- **Không đo:** token, quota, chất lượng câu trả lời của Claude, độ trễ thật của model. Muốn thế dùng `npm run test:live`, bench-kit và `npm run bench:cachewrite` (tốn quota thật).
- Số thời gian có nhiễu (máy dùng chung, `idle()` đo theo chu kỳ 10 ms): đọc trung vị với nhiều lần lặp, đừng so từng con số lẻ. Ở lần chạy đầu trên Linux, `durable` thêm khoảng 10 ms mỗi lượt; đó là một lần đo, không phải cam kết.

## Tầng 2: A/B với Claude thật (`npm run bench:ab`) — TỐN QUOTA

Cùng kịch bản ba worker của `npm run bench:tokens` (haiku, project trống), chạy xen kẽ ở `legacy` và `durable` (`BENCH_MODE`), đọc cache-write từ `usage.jsonl` của từng lượt. Dùng `claude` đã đăng nhập trên máy.

```bash
node scripts/bench-ab.mjs --pilot                         # một lượt legacy, xem một lượt tốn bao nhiêu
node scripts/bench-ab.mjs --reps 3 --cap 500000 --out <thư mục>   # reps × 2 lượt; dừng nếu lượt kế tiếp có thể vượt trần
```

Mỗi lượt lưu `usage.jsonl`, `stdout.txt` và `result.json` ở thư mục `--out`.

**Giới hạn khi đọc kết quả:** đầu ra của model thay đổi từ lượt này sang lượt khác (số lượt model 9–15, cache-write 19K–39K cho cùng kịch bản), nên với 3 lượt mỗi bên khoảng dao động của hai chế độ chồng lên nhau. Con số trung vị không đủ để kết luận bên nào tiết kiệm hơn. Muốn kết luận cần nhiều lượt hơn hoặc kịch bản ít phụ thuộc vào ý model. Kịch bản không kiểm tra chất lượng: cột `file ok` chỉ cho biết `be` có ghi được `sub()` vào file hay không, và cả hai chế độ đều có lượt không ghi được (thẻ duyệt bị từ chối vì không có người).

## Tầng 2b: giao một mục tiêu (`npm run bench:goal`) — TỐN QUOTA

Giao một mục tiêu cho phòng ba worker (haiku) trong một project nhỏ có lỗi cài sẵn (`scripts/live/goal-fixtures.ts`: `auth`, `cart`, `orders`). Sau khi chạy, bộ kiểm tra thêm test ẩn và đếm số test đạt. Báo: có giải xong không, số lượt model, cache-write, thời gian, số thẻ duyệt, số câu hỏi gửi người dùng.

```bash
node scripts/bench-goal.mjs --pilot --goal auth
node scripts/bench-goal.mjs --goals auth,cart,orders --reps 2 --cap 300000 --mode durable --out <thư mục>
```

Thẻ duyệt được tự động đồng ý khi là đọc/ghi trong project hoặc lệnh `node --test`, `npm test` kèm lọc đơn giản (`tail`, `head`, `cat`); lệnh khác bị từ chối và đếm là "cần người". Chính sách này khá chặt: lệnh `grep` lọc kết quả test và ghi file bằng `cat > f <<EOF` bị từ chối dù vô hại, nên cột `interventions` đếm thừa; cột `questions` (ask_user) mới là câu hỏi thật.

Kết quả lần chạy đầu (haiku, `durable`, 7 lượt, khoảng 70K cache-write tổng): cả `auth` (3 lỗi), `cart` (4 hành vi) và `orders` (6 lỗi chéo 5 module) đều được `lead` tự giải xong, đạt toàn bộ test ẩn, trong **một lượt model** (6K–16K cache-write, 28–65 giây), 0 câu hỏi cho người dùng. Mục tiêu cỡ này không có chỗ cho planner cải thiện; để thấy chênh lệch cần mục tiêu lớn hơn một lượt, và chưa có phép đo đó.

### Fixture `sortrush`: mô phỏng một task giao việc thực tế

Dựng từ một brief thật (mini game Sort Rush cần thêm vào một nền tảng có sẵn): `scripts/live/fixtures/sortrush/files` là hệ thống nhỏ đã có (tenant, QR, phiên chơi dùng chung, thưởng exactly-once, game mẫu `tapFrenzy`) kèm đặc tả trong `README.md`; `hidden/hidden.test.js` (9 test) kiểm các tiêu chí nghiệm thu: cô lập tenant/QR, không lộ đáp án, `event_id` gửi 10 lần chỉ ghi một hành động, điểm do server tính, thưởng một lần, config xấu bị từ chối. Test ẩn đỏ 8/9 trên bản chưa làm (một test đạt vì kiểu game lạ vốn bị từ chối) và đạt 9/9 với một bản giải tham chiếu.

Kết quả (haiku, `durable`, 3 lượt): cả ba lượt đều đạt 9/9 test ẩn, **một lượt model**, 32K–40K cache-write, 111–129 giây, 0 câu hỏi cho người dùng. Chỉ mô phỏng (project nhỏ, đặc tả tự chứa trong một file): task thật tốn 6–9 ngày kỹ sư trên một codebase lớn hơn nhiều, nên đừng ngoại suy kết quả này sang đó.

### Fixture `sortrush-team`: đội bốn người (lead, fe, be, qa) với quyền theo vai trò

Cùng đặc tả Sort Rush, nhưng thêm phần client web (`web/`, theo mẫu `web/tapFrenzyClient.js`: hàng đợi khi mất mạng, `event_id` cố định, resume) và 16 test ẩn (9 backend + 7 client chạy trên backend thật). Phòng có bốn worker và chính sách duyệt theo vai trò: `lead` không ghi file, `fe` chỉ ghi trong `web/`, `be` chỉ ghi ngoài `web/`, `qa` chỉ ghi file test; ghi sai vai trò bị từ chối và đếm ở cột `roleDenied`. Khác với `sortrush` (một worker tự làm hết), ở đây công việc phải chia ra. Bản giải tham chiếu đạt 16/16; bản chưa làm đạt 1/16 (không tính test không nạp được).

Kết quả lần chạy đầu (haiku, `durable`, **1 lượt**, nên chỉ là một điểm đo): 10 lượt model (be 4, qa 2, lead 2, fe 2), **216K cache-write** (so với 32K–40K khi một worker tự làm), 163 giây, 0 câu hỏi cho người dùng, 0 lần ghi sai vai trò. **Đính chính:** lúc đó bộ chấm báo 15/16 test ẩn và tôi đã diễn giải là "chưa giải xong", nhưng test thứ 16 đòi `finish()` của client gọi lần hai vẫn trả điểm, điều đặc tả không yêu cầu (client xóa phiên sau khi xong là hợp lý). Sau khi bỏ đòi hỏi đó, cùng bài làm đạt 16/16. Vậy lượt này đã giải xong; chỉ chi phí cao hơn là kết luận còn đứng.

### Fixture `sortrush-zones`: dùng file workers thật

Cùng bài, bố cục theo vùng như một dự án thật: `rules-service/` (server), `play-frontend/` (client), `docs/` + `WORKING.md` (đặc tả ở `docs/specs/sort-rush.md`), mỗi app có `package.json` và `npm ci`/`npm test`/`npm run build`. Dùng file workers của chủ dự án qua `BENCH_WORKERS_FILE=<workers.yaml>` (file giữ ngoài repo, không commit): năm worker (lead, be, fe, qa, docs), `levels`, `instructions`, `maxConcurrent: 1` mỗi account, vùng ghi theo vai trò. Chỉ chạy Claude: account Codex được thay bằng một account Claude thứ hai (cùng đăng nhập) để fe/qa giữ chỗ chạy riêng; `lead` và `docs` (không khai model) chạy `claude-sonnet-5-5`; `useSkills` bị bỏ vì các skill đó không có trong project thử.

Khác thực tế: không có git worktree (cùng một thư mục), không có skill riêng của dự án, project nhỏ, chạy bằng một lượt giao việc; không đo xung đột merge.

Kết quả lần chạy đầu (Sonnet 5.5, `durable`, **1 lượt**): 10 lượt model (fe 4, be 2, lead 2, qa 1, docs 1), **139K cache-write**, 329 giây, 0 câu hỏi cho người dùng, 0 lần ghi sai vùng, 16/16 test ẩn sau khi sửa test như trên (lúc chấm đầu báo 15/16 vì cùng lỗi của test).

### Fixture `sortrush-solo`: một agent làm lần lượt từng giai đoạn (so với đội)

Cùng bài, cùng bố cục `sortrush-zones`, cùng model (Sonnet 5.5) và cùng bộ chấm, nhưng giao cho **một** worker (`BENCH_TARGET=solo`, `BENCH_WORKERS_FILE` trỏ tới file một worker) kèm yêu cầu làm tuần tự: server, client, tự rà soát lại như reviewer độc lập, rồi docs, mỗi giai đoạn một nhánh git và commit.

Kết quả (Sonnet, `durable`): ba lượt hợp lệ đều **16/16**, mỗi lượt một lượt model, **37K–41K cache-write**, 182–221 giây. Cùng bài, đội năm worker bằng file workers thật: **139K** cache-write, 10 lượt model, 329 giây, 16/16 (một lượt). Tức đội tốn khoảng 3,5 lần cache-write và chậm hơn khoảng 1,5 lần, với cùng kết quả ở bài cỡ này. Hai lượt khác bị loại vì bộ đo chặn nhầm lệnh `git checkout -q -b` (agent hỏi lại người dùng rồi dừng); chính sách đã sửa.

Giới hạn: một bài, haiku/Sonnet, đặc tả tự chứa, không worktree thật (nhánh git trong cùng thư mục), `rà soát độc lập` do cùng một agent tự làm nên không đo được giá trị của một reviewer khác; chưa đo bài lớn, nhiều máy, firmware/mobile, hay dùng Codex.

### Fixture `sortrush-par`: be và fe làm song song

Cùng bài và cùng file workers, nhưng lời giao việc nói rõ hợp đồng API đã đủ trong đặc tả nên giao `be` và `fe` cùng lúc. Trong lượt `sortrush-zones` thường, đội gần như chạy tuần tự (tổng thời gian các lượt chia cho thời gian thực: 1,12; `fe` chờ `be`). Ở `sortrush-par` hai worker chạy chồng thật (hệ số 1,51; `fe` giây 19–125, `be` giây 25–198).

Kết quả (Sonnet, `durable`, **1 lượt**): 8 lượt model, 112K cache-write, 300 giây (chậm hơn agent đơn 182–221 giây và gần bằng đội tuần tự 329 giây), **11/16 test ẩn: chưa giải xong**. Server đạt 9/9; phần client sai khớp với server ở các phản hồi của `action` (test tích hợp của chính `fe` đỏ ở cuối lượt chạy, chưa sửa xong). Gợi ý, chưa đủ để kết luận (n=1; bộ đo cũng từ chối các lệnh Bash dạng `python3 - <<EOF` mà worker dùng để sửa file): làm song song khi chưa có test hợp đồng chung dễ để lại lỗi ở chỗ nối, và `be` vẫn mất 174 giây một mình nên song song không rút ngắn thời gian ở bài cỡ này.
