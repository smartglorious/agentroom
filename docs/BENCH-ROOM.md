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
