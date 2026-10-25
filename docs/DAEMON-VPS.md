# Cài AgentRoom daemon trên VPS cho một project mới

Bản viết cho AgentRoom **0.14.16 (công khai) / 0.15.16 (pro)**. Dựa trên `docs/DAEMON.md` và mã nguồn của daemon. Mỗi bước có nhãn **[ĐÃ KIỂM]** (đã chạy thật trong kịch bản live của dự án) hoặc **[CHƯA KIỂM]** (đọc từ tài liệu/mã, chưa chạy trên VPS thật). Không bước nào cần dán token hay mật khẩu vào chat hay vào repo.

## 0. Daemon là gì và khi nào nên dùng

`agentroom-daemon` chạy **cùng một phòng** như extension VS Code (worker, task, trí nhớ, chi phí, Telegram, cron, webhook, máy SSH) nhưng là một tiến trình Node nền, không có cửa sổ. Dùng khi muốn chạy lịch đêm, nhận tin Telegram, nhận webhook CI mà không mở VS Code.

Cần hiểu trước:
- **Không có giao diện.** Điều khiển bằng Telegram hoặc đọc log. Thẻ xin quyền chỉ đến điện thoại (theo chính sách an toàn) hoặc chờ cho đến khi bạn mở VS Code và chiếm quyền.
- **Mỗi thư mục `.agentroom/` chỉ một bên điều phối** (khóa `room.lock`): daemon **hoặc** cửa sổ VS Code, không cả hai. Đừng chạy daemon trên VPS và VS Code trên máy bạn cho cùng một clone (chat và task nằm trong clone đó).
- Việc cần thiết bị/toolchain cục bộ (ví dụ ESP32, Flutter, thiết bị USB) **không chạy được trên VPS**. Chỉ giao cho VPS những worker mà toolchain có trên VPS.
- Nếu máy bạn dùng chung gói Claude với VPS thì **chung hạn mức**. Mỗi account là một đăng nhập trên MỘT máy.

## 1. Yêu cầu VPS

- Linux (Ubuntu 22.04/24.04 hoặc Debian 12), 2 vCPU, 4 GB RAM trở lên (mỗi lượt chạy một tiến trình CLI; `maxConcurrent` càng cao càng cần RAM). Thêm swap 2 GB nếu RAM ≤ 4 GB.
- Node.js ≥ 20, git, và toolchain của project (Go, npm, … tùy repo).
- Truy cập ra Internet (api.anthropic.com, github.com, api.telegram.org, …). **Không cần mở cổng vào** nếu không dùng webhook từ ngoài.
- Đăng nhập SSH bằng khóa, tắt đăng nhập bằng mật khẩu. Chạy bằng **người dùng thường**, không phải root.

## 2. Chuẩn bị máy [CHƯA KIỂM trên VPS thật; lệnh chuẩn]

```bash
# người dùng riêng (nếu chưa có)
sudo adduser agentroom && sudo usermod -aG sudo agentroom
# Node 20+ (ví dụ qua nodesource hoặc nvm; kiểm tra:)
node -v        # phải >= v20
sudo apt-get update && sudo apt-get install -y git unzip tmux
# swap nếu cần
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
```

## 3. Cài và đăng nhập Claude Code (và/hoặc Codex) trên VPS [CHƯA KIỂM]

Worker Claude dùng CLI `claude` của máy; worker Codex dùng `codex`. Daemon **không** mang theo đăng nhập của bạn.

1. Cài `claude` theo tài liệu Claude Code (cài bằng trình cài đặt chính thức, rồi `claude --version`).
2. Đăng nhập bằng gói thuê bao: chạy `claude` rồi làm theo luồng đăng nhập; trên máy không có trình duyệt, CLI in một đường dẫn để mở ở máy khác. Làm đúng theo tài liệu Claude Code hiện hành vì luồng này thay đổi.
3. Kiểm tra: `claude -p "ping" --model haiku` trả lời được (tốn một lượt rất nhỏ).
4. Codex (nếu dùng): cài `codex`, đăng nhập theo tài liệu Codex. Kiểm tra bằng `codex --version`.

Dùng account có `baseUrl` (ví dụ DeepSeek)? Đặt khóa bằng **biến môi trường**, không ghi vào `workers.yaml` (mục 8).

## 4. Lấy daemon

Daemon là một file tự chứa `dist/daemon.mjs` (đã nhúng SDK; chỉ cần `claude`/`codex` CLI trên máy). Chưa có gói npm; lấy từ `.vsix` (là file zip) ở máy bạn:

```bash
# trên VPS, sau khi chép agentroom-0.14.16.vsix (hoặc agentroom-pro-0.15.16.vsix) lên bằng scp
mkdir -p ~/agentroom-daemon && cd ~/agentroom-daemon
unzip -o ~/agentroom-0.14.16.vsix 'extension/dist/daemon.mjs' 'extension/package.json'
ln -sf ~/agentroom-daemon/extension/dist/daemon.mjs ~/agentroom-daemon/daemon.mjs
node ~/agentroom-daemon/extension/dist/daemon.mjs help        # phải in danh sách lệnh
```

Tiện hơn: tạo lệnh ngắn

```bash
mkdir -p ~/.local/bin
cat > ~/.local/bin/agentroom-daemon <<'EOF'
#!/bin/sh
exec node "$HOME/agentroom-daemon/extension/dist/daemon.mjs" "$@"
EOF
chmod +x ~/.local/bin/agentroom-daemon
agentroom-daemon help
```

Hoặc dùng nguồn: `git clone` repo AgentRoom, `npm ci && npm run build`, rồi `node dist/daemon.mjs help` **[ĐÃ KIỂM: là cách kịch bản live của dự án chạy]**.

## 5. Chuẩn bị project mới

```bash
mkdir -p ~/code && cd ~/code
git clone <url-repo-cua-ban> app && cd app
```

Tạo `.agentroom/workers.yaml` (bắt buộc; daemon thoát mã 2 nếu thiếu hoặc sai). Cách nhanh nhất:

1. Ở **máy của bạn**, dùng runbook `docs/SETUP-GUIDE.md` (giao cho một agent làm trong repo) để tạo `.agentroom/` đúng cho project. Hoặc sao một `workers.yaml` mẫu rồi sửa.
2. **Commit** các thứ nên dùng chung: `workers.yaml`, `skills/`, `agents/*/SOUL.md`, `agents/*/MEMORY.md`, `team/MEMORY.md`. **Không commit**: `.agentroom/state/` (lịch sử chat, chi phí), `worktrees/`, `.plugin/`. Kiểm tra: `git check-ignore -v .agentroom/state/x .agentroom/worktrees/x` in 2 dòng; `git check-ignore .agentroom/workers.yaml` không in gì.
3. Trên VPS `git pull` để có file, hoặc `scp` riêng `workers.yaml`.

Lưu ý trong `workers.yaml` khi chạy trên VPS:
- Đường dẫn `workdir:` kiểu Windows (`D:\...`) phải đổi thành đường dẫn Linux của VPS.
- `accounts:` chỉ khai những account có đăng nhập trên VPS. Muốn dùng máy khác, thêm `hosts:` (mục 7).
- `schedules:` chạy được trong daemon (đó là mục đích chính); `timezone:` nên đặt tường minh (ví dụ `Asia/Ho_Chi_Minh`).
- Worker trên VPS không có ai bấm thẻ duyệt: cấp `allowedTools` đủ cho việc chạy đêm; webhook dùng `readOnly: true`.

Kiểm tra cú pháp trước khi chạy: `agentroom-daemon run --root ~/code/app` sẽ in lỗi cấu hình và thoát mã 2 nếu sai **[ĐÃ KIỂM]**.

## 6. Chạy lần đầu (ở tmux) [ĐÃ KIỂM: kịch bản live dùng tiến trình thật]

```bash
tmux new -s agentroom
agentroom-daemon run --root ~/code/app
# Ctrl-b rồi d để rời tmux
agentroom-daemon status --root ~/code/app     # ai đang giữ phòng
```

Mã thoát: `0` bình thường/bị chiếm, `2` cấu hình lỗi, `3` phòng đang bận (một cửa sổ VS Code hay daemon khác giữ khóa; dùng `--take-over` chỉ khi chắc chắn).

Sửa `.agentroom/workers.yaml` → daemon tự nạp lại sau vài giây (hoặc `kill -HUP <pid>`); file đang lỗi thì nó báo lỗi trong log, giữ tiến trình sống.

## 7. Telegram (khuyến nghị: cách duy nhất để điều khiển) [CHƯA KIỂM với Telegram thật]

1. Tạo bot **riêng** cho daemon với @BotFather (không dùng chung token với VS Code hoặc chương trình khác: một token chỉ có một nơi nhận tin).
2. Trên VPS: `agentroom-daemon setup-telegram` (token nhập ẩn, kiểm bằng `getMe`, lưu ở `~/.agentroom/daemon.json` quyền 0600). **Đừng gửi token cho ai và đừng dán vào chat này.** Hoặc đặt biến `AGENTROOM_TELEGRAM_TOKEN` từ một trình quản lý bí mật.
3. `agentroom-daemon set-pin` (khuyến nghị: PIN để duyệt quyền từ điện thoại).
4. Khi daemon đang chạy, ở terminal khác: `agentroom-daemon pair --root ~/code/app` → in một mã; gửi `/pair <mã>` cho bot. Lần ghép cặp trong VS Code không dùng lại được.
5. Lệnh trong bot: xem `docs/TELEGRAM.md`.

## 8. Biến môi trường và bí mật

systemd không đọc môi trường của shell bạn. Đặt bí mật ở `~/.agentroom/daemon.env` (mỗi dòng `KEY=VALUE`, `chmod 600`), file này được unit mẫu nạp qua `EnvironmentFile`:

```bash
install -m 600 /dev/null ~/.agentroom/daemon.env
# rồi mở bằng trình soạn thảo và thêm, ví dụ:
#   DEEPSEEK_API_KEY=...          (tên biến khớp authTokenEnv trong workers.yaml)
#   AGENTROOM_HOOK_SECRET=...     (secretEnv của webhook)
```

Account có `baseUrl` mà **thiếu** biến `authTokenEnv` thì AgentRoom **từ chối chạy** (để không gửi đăng nhập Claude của bạn sang endpoint khác).

## 9. Chạy thường trực bằng systemd (người dùng) [CHƯA KIỂM unit thật]

```bash
mkdir -p ~/.config/systemd/user
agentroom-daemon service --root ~/code/app > ~/.config/systemd/user/agentroom.service
# kiểm tra nội dung: ExecStart trỏ tới node + daemon.mjs, PATH có chứa thư mục của claude/codex
systemctl --user daemon-reload
systemctl --user enable --now agentroom
journalctl --user -u agentroom -f
loginctl enable-linger $USER      # chạy cả khi chưa đăng nhập, và qua khởi động lại VPS
```

- Nếu `claude`/`codex` nằm ngoài `~/.local/bin:/usr/local/bin:/usr/bin:/bin`: `agentroom-daemon set claudePath /đường/dẫn/claude` (và `codexPath`), hoặc sửa dòng `Environment=PATH=` trong unit.
- Mẫu có `RestartPreventExitStatus=3 2`: phòng đang bận hoặc cấu hình lỗi thì không lặp khởi động vô hạn. Tắt tmux sau khi chuyển sang systemd (đừng chạy hai daemon).

## 10. Máy SSH khác (tùy chọn) [mã đã kiểm; chưa chạy ssh thật từ daemon]

Nếu `workers.yaml` có `hosts:`, daemon **từ chối** mọi host cho tới khi bạn cho phép. Chạy `agentroom-daemon trust-hosts --root ~/code/app`: lệnh in từng host, hỏi `y/N`. Chấp thuận gắn với thư mục project và đúng cấu hình ssh (đổi `ssh:`/`port:` thì duyệt lại). SSH chạy `BatchMode`: khóa phải dùng được không cần mật khẩu (ssh-agent hoặc khóa không passphrase).

## 11. Bảo mật

- `~/.agentroom/daemon.json` chứa token bot và hash PIN ở **dạng văn bản** (quyền 0600). Ai đọc được file đó điều khiển được bot: bảo vệ tài khoản người dùng trên VPS (khóa SSH, `ufw` chỉ mở cổng SSH, fail2ban nếu muốn).
- **Full Access** chỉ do bạn bật (`agentroom-daemon autonomy <worker> full`, gõ `FULL` để xác nhận); `autonomy: full` trong `workers.yaml` không có hiệu lực. Mặc định để `manual`/`auto`.
- Daemon chạy với quyền người dùng và tin `workers.yaml` của project: chỉ chạy cho repo bạn tin.
- Webhook mặc định chỉ nghe trên `127.0.0.1`; muốn nhận từ ngoài thì đặt sau một reverse proxy có TLS và luôn dùng `secretEnv` (HMAC). Nội dung từ webhook/cron/Telegram bị coi là dữ liệu không tin cậy.
- Không commit `.agentroom/state/`, `daemon.json`, `daemon.env`.

## 12. Cập nhật và sao lưu

- **Nâng cấp:** chép `.vsix` mới lên, `unzip -o` lại `extension/dist/daemon.mjs`, rồi `systemctl --user restart agentroom`. Nâng cấp có thể làm session đang chạy ghi lại tiền tố một lần (tốn hạn mức một lần).
- **Sao lưu:** `~/.agentroom/` (cài đặt daemon) và `~/code/app/.agentroom/` (trừ `worktrees/`). Chat và task nằm ở `.agentroom/state/`.
- **Xem trạng thái:** `agentroom-daemon status --root ~/code/app`, `agentroom-daemon issues list`, `journalctl --user -u agentroom --since today`.

## 13. Kiểm tra sau khi cài (checklist)

1. `agentroom-daemon help` in danh sách lệnh.
2. `claude -p "ping" --model haiku` chạy được trên VPS (và `codex --version` nếu dùng).
3. `agentroom-daemon run --root ~/code/app` không thoát mã 2; log báo phòng đã chạy.
4. Gửi `/pair` xong, nhắn bot một câu cho worker điều phối và nhận được trả lời trên điện thoại.
5. `systemctl --user status agentroom` là `active (running)`; reboot VPS rồi kiểm tra lại (nhờ `enable-linger`).
6. `git status` của repo sạch (không có `state/`, `daemon.env`).

## 14. Chưa kiểm chứng (nói thẳng)

Telegram thật; `setup-telegram`/`set-pin` nhập ẩn trên TTY thật; unit systemd và `loginctl enable-linger` trên VPS thật; luồng đăng nhập Claude/Codex trên máy không có trình duyệt; `trust-hosts` kèm ssh thật từ daemon; macOS/Windows (daemon dùng SIGUSR1 cho `pair` nên chỉ Linux/macOS/WSL). Đã kiểm chứng: tiến trình `dist/daemon.mjs` thật với Claude thật và Bot API giả (ghép cặp, tin điện thoại → Claude → điện thoại, tự nạp lại khi sửa `workers.yaml`, file hỏng không làm chết tiến trình, daemon thứ hai bị từ chối mã 3, SIGTERM mã 0, bị VS Code giữ phòng, `--take-over`).
