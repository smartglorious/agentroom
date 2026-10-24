# Chương trình nền (daemon) — Telegram, lịch và webhook không cần VS Code (v0.7)

`agentroom-daemon` chạy **cùng một phòng** như extension (worker, task, trí nhớ, chi phí, máy từ xa, Telegram, cron, webhook) nhưng như một tiến trình Node không có cửa sổ. Dùng khi bạn muốn nhắn Telegram, chạy lịch ban đêm hoặc nhận webhook CI mà không phải mở VS Code, ví dụ trên một máy chủ hay máy luôn bật.

## 1. Chạy

Cần Node ≥ 20 và `claude` / `codex` đã đăng nhập trên máy đó.

```bash
node dist/daemon.mjs help                       # từ mã nguồn sau `npm run build`
# hoặc đã cài .vsix:  node ~/.vscode/extensions/agentroom.agentroom-0.8.0/dist/daemon.mjs help
# hoặc:               npm link   →   agentroom-daemon help
```

| Lệnh | Việc |
|---|---|
| `run [--root <thư mục>] [--take-over]` | Chạy phòng của project (mặc định thư mục hiện tại; cần `.agentroom/workers.yaml`) |
| `setup-telegram` | Nhập token bot (ẩn khi gõ), kiểm tra bằng `getMe`, lưu |
| `pair` | In mã ghép cặp từ daemon đang chạy; bạn gửi `/pair <mã>` cho bot |
| `set-pin` | Đặt/bỏ PIN duyệt quyền (lưu dạng băm; có hiệu lực ngay) |
| `telegram-off` | Xoá token đã lưu |
| `trust-hosts` | Cho phép daemon ssh tới các `hosts:` của project (mục 4) |
| `settings` · `set <khóa> <giá trị>` | Xem/đổi cài đặt (mục 3) |
| `status` | Ai đang giữ phòng (daemon hay cửa sổ VS Code) |
| `service` | In file systemd mẫu |

Thiết lập lần đầu:

```bash
agentroom-daemon setup-telegram       # dùng bot RIÊNG, xem TELEGRAM.md mục 1
agentroom-daemon set-pin              # khuyến nghị
agentroom-daemon run --root ~/code/app
agentroom-daemon pair --root ~/code/app    # ở terminal khác; rồi gửi /pair <mã> cho bot
```

Lần ghép cặp trong VS Code **không** được dùng lại: daemon có kho riêng và phải ghép cặp một lần.

## 2. Daemon và VS Code: một phòng, một người điều phối

Daemon dùng chung `RoomLock` (`.agentroom/state/room.lock`) với extension nên hai bên không bao giờ cùng điều phối một thư mục.

- Daemon chạy, bạn mở VS Code ở thư mục đó → thẻ khóa ghi "đang chạy bằng chương trình nền". **Chiếm quyền** sẽ dừng daemon (Telegram, lịch, webhook của nó ngừng cho tới khi bạn chạy lại daemon, và nó chiếm lại phòng).
- VS Code đang giữ phòng, bạn chạy daemon → thoát với mã 3 và nói rõ ai đang giữ; `--take-over` để chiếm.
- Daemon bị chiếm thì **tự thoát với mã 0** (không khởi động lại vòng lặp dưới systemd).
- Chat và task nằm trong `.agentroom/state/`, nên khi chuyển qua lại, VS Code vẫn thấy lịch sử mà daemon đã làm. VS Code chưa thể "xem trực tiếp" phòng của daemon đang chạy: muốn xem sống thì chiếm quyền, hoặc dùng Telegram.
- Đừng dùng cùng một token bot ở cả VS Code và daemon cùng lúc (một token chỉ có một nơi nhận tin, bên sau báo xung đột).

## 3. Cài đặt

Lưu trong `~/.agentroom/daemon.json` (chế độ 0600, chứa cả token bot). Tên khóa trùng với VS Code:

`detail`, `approveFromPhone`, `summaryChars`, `quietHours` (xem TELEGRAM.md mục 6), `hookPort`, `maxAgentHops`, `contextMessages`, `memoryBudgetChars`, `inspectorKeepTurns`, `planPollMinutes` (hạn mức gói, xem PLAN-USAGE.md), `claudePath`, `codexPath`, `pricing` (JSON).

Giá trị sai bị từ chối ngay (`set detail everything` → "chỉ nhận: summary | full | alerts"). Nhóm Telegram và `claudePath`/`codexPath`/`pricing` có hiệu lực ngay; các khóa còn lại sau khi `kill -HUP` hoặc chạy lại.

Token cũng có thể đặt bằng biến `AGENTROOM_TELEGRAM_TOKEN` (ưu tiên hơn file). `AGENTROOM_TELEGRAM_API` đổi địa chỉ Bot API (máy chủ Bot API tự dựng; token được gửi tới đó, chỉ đặt khi bạn tin nó).

Bí mật webhook (`secretEnv` trong workers.yaml) đọc từ môi trường của daemon, ví dụ qua `EnvironmentFile` của systemd.

## 4. Máy từ xa (SSH)

Trong VS Code bạn bấm đồng ý khi một repo muốn ssh. Daemon không có ai để hỏi, nên mặc định **từ chối** mọi host. Chạy `agentroom-daemon trust-hosts --root <project>`: lệnh in từng host, hỏi `y/N` rồi ghi chấp thuận. Chấp thuận gắn với **thư mục project và đúng cấu hình ssh** (đổi `ssh:` hay `port:` thì phải duyệt lại). SSH vẫn là `BatchMode`, nên key phải dùng được không cần nhập mật khẩu (ssh-agent hoặc key không passphrase).

## 5. Chạy thường trực (systemd, người dùng)

```bash
mkdir -p ~/.config/systemd/user
agentroom-daemon service --root ~/code/app > ~/.config/systemd/user/agentroom.service
systemctl --user daemon-reload && systemctl --user enable --now agentroom
journalctl --user -u agentroom -f
loginctl enable-linger $USER      # để chạy cả khi chưa đăng nhập
```

Mẫu có `RestartPreventExitStatus=3 2` (phòng đang bận / workers.yaml lỗi thì không lặp vô hạn). systemd không có `PATH` của shell bạn: nếu `claude` nằm ngoài `~/.local/bin:/usr/local/bin:/usr/bin`, chạy `agentroom-daemon set claudePath /đường/dẫn/claude`. macOS (launchd) và Windows chưa có mẫu; chạy qua `tmux`/`pm2` hoặc Task Scheduler được, nhưng `pair` dùng tín hiệu SIGUSR1 nên **chỉ có trên Linux/macOS/WSL**.

## 6. Nạp lại và dừng

- Sửa `.agentroom/workers.yaml` → daemon tự nạp lại sau vài giây (hoặc `kill -HUP <pid>`). Nếu file đang lỗi, nó báo lỗi trong log, **giữ tiến trình sống** và nạp lại ở lần lưu kế tiếp.
- `SIGTERM`/`SIGINT` → dừng worker đang chạy, đóng kết nối, nhả khóa, thoát mã 0.
- Mã thoát: `0` bình thường/bị chiếm, `2` cấu hình lỗi, `3` phòng đang bận.

## 7. Bảo mật

- Token và hash PIN nằm trong `~/.agentroom/daemon.json` với quyền 0600, **dạng văn bản** (VS Code có kho bí mật của hệ điều hành, daemon thì không). Ai đọc được file đó điều khiển được bot: bảo vệ tài khoản người dùng của máy chạy daemon. Dùng `AGENTROOM_TELEGRAM_TOKEN` từ một trình quản lý bí mật nếu bạn cần tốt hơn.
- Mọi chính sách của Telegram giữ nguyên (một người ghép cặp, văn bản thuần, duyệt phone chỉ cho sửa file an toàn trong thư mục của worker, PIN, tin tồn đọng bị bỏ).
- Daemon chạy workers **không có cửa sổ để bạn duyệt**: thẻ xin quyền chỉ đến điện thoại (theo chính sách an toàn) hoặc chờ cho tới khi bạn mở VS Code và chiếm quyền. Hãy cấp `allowedTools` đủ cho lịch chạy đêm, và dùng `readOnly: true` cho webhook.
- Daemon chạy với quyền của người dùng hiện tại và tin `.agentroom/workers.yaml` của project. Chỉ chạy nó cho repo bạn tin.

## 8. Đã kiểm chứng gì và chưa

Đã kiểm chứng: 5 test đơn vị mới (kho 0600 và kiểm tra giá trị, khóa/chiếm quyền, ghép cặp và vòng tin nhắn với Bot API giả, giữ ghép cặp qua lần khởi động lại, PIN đọc sống, tin cậy host theo project) và kịch bản `npm run test:live -- daemon`: **tiến trình `dist/daemon.mjs` thật**, Claude thật, Bot API giả, tín hiệu và khóa thật (ghép cặp bằng `pair`, tin điện thoại → Claude → điện thoại, tự nạp lại khi sửa workers.yaml, file hỏng không làm chết tiến trình, daemon thứ hai bị từ chối mã 3, SIGTERM mã 0, bị VS Code giữ phòng, `--take-over`, bị chiếm thì tự thoát mã 0). Kịch bản này đã bắt được một lỗi thật (tiến trình tự thoát sau lần nạp lại thất bại), đã sửa.

**Chưa kiểm chứng:** Telegram thật (như v0.6); `setup-telegram`/`set-pin` nhập ẩn trên TTY thật (đã viết, chưa có người gõ thử); unit systemd thật và `loginctl enable-linger`; macOS/Windows; webhook và cron chạy trong tiến trình daemon (dùng đúng mã của extension và đã có test riêng, nhưng không có kịch bản daemon riêng); `trust-hosts` và ssh từ daemon (logic tin cậy đã test, chưa chạy ssh thật từ daemon).
