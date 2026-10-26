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
