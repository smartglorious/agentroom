# Dọn dẹp: gom, không xóa

Nguyên tắc: **AgentRoom không tự xóa file của bạn.** Bộ dọn dẹp chỉ *tìm* file rác / tạm / cache, và khi **bạn** yêu cầu thì *di chuyển* chúng vào một thư mục duy nhất để bạn tự xóa.

## Dùng

- VS Code: `AgentRoom: Dọn dẹp file rác/tạm/cache (gom, không xóa)` → chọn các mục (mặc định không chọn gì) → được gom vào `.agentroom/cleanup/<thời điểm>/files/…`.
- `AgentRoom: Khôi phục mục đã dọn` đưa một lô về chỗ cũ (không ghi đè nếu chỗ cũ đã có file mới).
- Daemon: `agentroom-daemon cleanup scan | gather | list | restore <lô>` (`gather` hỏi `y/N`).

Mỗi lô có `manifest.json` (từ đâu → đâu, dung lượng) và `README.txt`. Muốn dọn thật: xóa thư mục `.agentroom/cleanup/` (hoặc một lô) bằng tay. `cleanup/` được thêm vào `.agentroom/.gitignore`.

## Tìm những gì

- Rác hệ điều hành: `.DS_Store`, `Thumbs.db`, `desktop.ini`.
- File tạm: `*.tmp`, `*.temp`, `*.swp`, `*.swo`, `.#*`, `*~`.
- Còn lại sau merge/sao lưu: `*.orig`, `*.rej`, `*.bak`.
- Cache: `__pycache__`, `*.pyc`, `.pytest_cache`, `.mypy_cache`, `.ruff_cache`, `.parcel-cache`, `.turbo`, `.nyc_output`, `.eslintcache`, `*.tsbuildinfo`.
- Của AgentRoom: `audit.1.jsonl` (đã xoay vòng); bản ghi lượt của Context Inspector cũ hơn N ngày nếu bạn đặt `agentroom.cleanup.turnsOlderThanDays`.

## Không bao giờ đụng tới

- File **git đang theo dõi** (kể cả `*.bak` bạn đã commit).
- `.git/`, `node_modules/`, `dist/`, `build/`, `out/`, `target/`, `.venv/`, và dữ liệu của phòng (`.agentroom/`, trừ hai mục nêu trên).
- Symlink; đường dẫn ngoài thư mục project hoặc có `..`.
- Agent **không có** tool dọn dẹp: chỉ chủ máy gọi được (lệnh VS Code / CLI daemon).

## Giới hạn

- Quét nhận diện theo tên, không đoán nội dung: luôn xem danh sách trước khi chọn.
- Chưa kiểm chứng trên Windows. Telegram chưa có lệnh dọn dẹp (cố ý: hành động trên file nên làm ở máy).
- Việc tự cắt bớt bản ghi lượt theo `agentroom.inspectorKeepTurns` và xoay vòng `audit.jsonl` (5 MB) là chính sách giữ dữ liệu theo cài đặt của bạn, không thuộc bộ dọn dẹp này.
