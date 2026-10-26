# Đo cache-write từ usage.jsonl (`npm run bench:cachewrite`)

Hạn mức gói Claude bị đốt chủ yếu bởi **cache-write** (không phải cache-read hay output): hiệu chuẩn thô trên một dự án thật là khoảng 27% cửa sổ 5 giờ cho mỗi 1 triệu token ghi cache (4 điểm đo, **chưa chính thức**). Công cụ này đọc `.agentroom/state/usage.jsonl` và cho biết cache-write nằm ở đâu. Chạy offline, không gọi model.

```bash
node scripts/bench-cachewrite.mjs <usage.jsonl> [--label A] [--units N] [--ttl-min 60]
# so hai lần chạy cùng kịch bản (exit code 1 nếu B vượt giới hạn):
node scripts/bench-cachewrite.mjs a/usage.jsonl --label A --units 6 --compare b/usage.jsonl --compare-label B --max-ratio 1.10
```

Kết quả tách cache-write thành ba nhóm: **lượt đầu của một session** (sàn khi bắt đầu session), **nối lại sau khi nghỉ quá TTL** (cache hết hạn nên ghi lại toàn bộ; trên gói thuê bao khoảng 1 giờ), và **lượt ấm**. `--units` là số đơn vị công việc hoàn tất của lần chạy (task, hành trình), để so hai lần chạy dài khác nhau công bằng.

Chỉ tính lượt Claude thật: bỏ Codex, account `baseUrl`, lượt lỗi và lượt ước lượng.

## Đã đo được gì

- Log 23 giờ của một dự án (317 lượt): 49% cache-write ở lượt đầu của session (55 session, trung bình ~64K), 23% ở lượt nối lại sau nghỉ > 60 phút, 28% ở lượt ấm.
- Hai lần chạy cùng kịch bản 6 tin (22 lượt, 10 session mỗi lần) ở hai chế độ lưu trữ: chênh cache-write ×1,022. Trong đó 79% cache-write nằm ở các session của task, do người nhận task bị gọi hai lần (đã sửa ở 0.14.17).

**Giới hạn:** hệ số 27%/1M chỉ là ước tính thô; mỗi chế độ mới đo 1 lần; log trước khi AgentRoom ghi `sessionId` nhận diện session theo `sessionKey` nên có thể thiếu session mới.
