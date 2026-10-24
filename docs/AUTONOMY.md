# Mức tự chủ của worker: Manual / Auto / Full (v0.9)

Mỗi worker có một mức tự chủ, chọn ở ô chọn trên thẻ worker (🛡 Manual · 🤖 Auto · ⚡ Full) hoặc đặt mặc định bằng `autonomy:` trong `workers.yaml`.

| | Manual (mặc định) | Auto | Full |
|---|---|---|---|
| Việc an toàn trong thư mục của worker (sửa file, test, git, build…) | hỏi (trừ tool đã có trong `allowedTools`) | **tự chạy** | tự chạy |
| Xóa file, `sudo`, đụng hệ thống/bí mật, đẩy dữ liệu ra ngoài | hỏi | **chặn**, model được báo lý do | tự chạy |
| Việc chính sách không nhận ra hoặc không phân tích được | hỏi | **hỏi** (không đoán "cho phép") | tự chạy |
| Hành động có thể phá máy (xem dưới) | hỏi | chặn | **vẫn hỏi** |

Quy tắc chung: **chỉ nguồn tin cậy mới nâng được mức tự chủ**, và nguồn không tin cậy không bao giờ vượt quyền chỉ-đọc.

## Auto: chính sách cụ thể

Auto dùng một bộ quy tắc cố định, **không** dùng model để đoán. Mỗi lời gọi tool cho ra một trong ba kết quả: cho chạy, chặn (kèm lý do gửi lại cho model), hoặc hỏi người dùng.

**Cho chạy tự động**
- `Read`/`Grep`/`Glob`/`Edit`/`Write` **trong thư mục làm việc của worker**, trừ file nhạy cảm (`.env*` trừ `.env.example`, `.git/`, `.github/`, `.agentroom/`, `.claude/`, `.ssh/`, `*.pem`, `*.key`, `credentials*`, …).
- Bash trong vòng lặp phát triển: `npm/pnpm/yarn test|run|build|ci|install` (không `-g`), `git` (status, diff, log, add, commit, checkout/switch, pull, push **không ép**, stash, merge…), `ls cat grep rg find` (không `-delete`/`-exec`), `mkdir touch cp mv` trong thư mục, `node/python script` trong thư mục, `pytest go cargo make tsc eslint prettier`…, `sed -i` trên file trong thư mục.
- `WebSearch`, công cụ phối hợp của AgentRoom (`mcp__agentroom__*`), `TodoWrite`, `Agent`.

**Chặn** (model thấy lý do và được dặn dùng cách khác hoặc `@user`)
- Xóa: `rm`, `rmdir`, `unlink`, `shred`, `find -delete`, `git clean`, `git rm`, `git reset --hard`, `git stash drop`.
- Nâng quyền và hệ thống: `sudo su doas pkexec`, `chroot`, `mount`, `dd`, `mkfs`, `fdisk`, `shutdown/reboot`, `systemctl`, `iptables`, `useradd`, `crontab`, trình quản lý gói hệ thống (`apt yum brew …`).
- Vị trí hệ thống và bí mật: `/etc /usr /bin /var /root /dev /proc /boot …`, `~/.ssh ~/.aws ~/.gnupg ~/.kube ~/.config …`, shell rc (`~/.bashrc`…), cả khi đi vòng bằng `..` hay đường dẫn tuyệt đối.
- Đẩy dữ liệu ra ngoài: `curl/wget` có `-d -F -T -X`, `scp sftp nc socat ftp`, chạy mã nhận từ mạng (`curl … | sh`).
- Git nguy hiểm: `push --force`, `push --delete`, `push --mirror`, `remote add/set-url`, `config --global`.
- `npm install -g`, `npm publish`.

**Hỏi** (không đoán): mọi thứ ngoài hai danh sách trên, gồm lệnh lạ, `curl`/`wget` đọc đơn thuần, `ssh`, `docker`, `kubectl`, `terraform`, `gh`, `kill`, `chmod`, `npx`, `pip install`, `python -c`, `$(…)` và here-doc (không phân tích được), file nằm ngoài thư mục, file nhạy cảm, `WebFetch`, công cụ MCP bên ngoài.

**Script do chính worker vừa viết**: nếu worker tạo/sửa một script (hoặc `package.json`, `Makefile`) trong phiên này rồi chạy nó, Auto **hỏi lần đầu** (vì chính sách không nhìn được nội dung script, và "viết script rồi chạy" là cách dễ nhất để lách bộ lọc lệnh). Sau khi bạn đã xem, script đó không bị hỏi lại.

### Auto KHÔNG phải sandbox

Chính sách chỉ nhìn được dòng lệnh. Nó **không** thấy được những gì một chương trình làm bên trong: `npm test` chạy mã trong `package.json` và các test, `python build.py` chạy cả file script. Nếu worker (hoặc một chỉ dẫn độc hại nó đọc được) cài sẵn mã nguy hiểm vào mã nguồn từ trước, Auto không ngăn được. Cách bảo vệ thật sự là cô lập: **worktree riêng cho từng dev** (đã có `worktree: true`), repo đã commit sạch, và với việc không tin tưởng thì dùng máy ảo/container. Tôi không bật sandbox của Claude Code vì môi trường dựng không cài `bubblewrap` nên chưa kiểm chứng được.

## Full: cảnh báo và điều kiện

Chọn ⚡ Full sẽ hiện hộp thoại xác nhận (modal) nêu rõ rủi ro và chỉ bật khi bạn bấm **Bật Full Access**.

- Không còn hỏi trước khi sửa/xóa file (kể cả ngoài dự án), chạy lệnh tùy ý, tải rồi chạy mã, cài gói, `git push --force`.
- **Vẫn hỏi bạn** với: `rm -rf` trên `/`, `~`, `$HOME`, thư mục hệ thống, `.`, `*`; `sudo/su/doas`; `dd`, `mkfs`, `fdisk`, `shutdown/reboot`; `chmod -R` trên thư mục gốc/hệ thống; ghi thẳng vào thiết bị; fork bomb; ghi file vào vị trí hệ thống hay bí mật. Đây là chốt chặn tối thiểu (Claude Code cũng vẫn hỏi với `rm` ở đường dẫn tới hạn ở chế độ bypass), không phải sandbox.
- **Chỉ bạn bật được.** `autonomy: full` trong `workers.yaml` **không có hiệu lực** (worker chạy Auto và có thông báo): một repo lạ không thể tự cấp Full cho mình. Agent và Telegram cũng không nâng được.
- **Trong VS Code, Full chỉ kéo dài tới khi bạn đóng VS Code** (Manual/Auto được nhớ theo từng project trên máy bạn).
- Nguồn không tin cậy (webhook `readOnly`) **vẫn chỉ-đọc** dù worker đang ở Full.
- Vẫn nên dùng trong máy ảo/container hoặc repo đã commit sạch: nội dung worker đọc được (web, issue, file lạ) có thể chứa chỉ dẫn độc hại (prompt injection).

## Mọi thứ đều có dấu vết

- Mọi quyết định tự động của Auto/Full được ghi vào `.agentroom/state/audit.jsonl` (giờ, worker, mức, lệnh đã rút gọn và che bí mật, kết quả `tự duyệt` / `chặn` / `người dùng cho phép` / `người dùng từ chối`, lý do), cả việc đổi mức và ai đổi. Tự xoay vòng ở 5 MB.
- Mỗi lần chặn hiện một dòng trong chat (`🛡 Chế độ auto đã chặn …`). Đổi mức tự chủ là một cảnh báo to (⚡ cho Full), cũng gửi về Telegram nếu bật.
- Thẻ xin quyền ghi rõ **vì sao** worker không tự quyết (`Chế độ auto: Truy cập mạng (curl/wget)`).

## Telegram

`/mode` liệt kê mức của từng worker. `/mode <id> manual|auto` **chỉ hạ** được từ điện thoại. Nâng lên (Auto hoặc Full) phải làm ở máy tính; duyệt từ điện thoại vẫn theo chính sách cũ (chỉ sửa file an toàn trong thư mục, `Bash` luôn chỉ từ chối được).

## Daemon

`agentroom-daemon autonomy` liệt kê; `agentroom-daemon autonomy <worker> <manual|auto|full> --root <project>` đổi. Full yêu cầu gõ `FULL` để xác nhận và **được giữ** cho tới khi bạn đổi lại (daemon không có cửa sổ để hỏi lại mỗi phiên). Có hiệu lực ở lượt kế tiếp, không cần khởi động lại. Daemon chạy không có ai canh nên cẩn thận hơn với Auto/Full: thẻ xin quyền chỉ tới điện thoại.

## Codex

Codex không có bước duyệt từng thao tác (`codex exec`), an toàn của nó là **sandbox**, nên mức tự chủ được ánh xạ vào đó: Manual = đúng `sandbox:` đã cấu hình; Auto = tối đa `workspace-write` (không bao giờ `danger-full-access`; `read-only` được giữ); Full = `danger-full-access`. Chính sách lệnh ở trên **không** áp dụng cho Codex. Chưa kiểm chứng với Codex thật.

## Máy từ xa

Quyết định luôn nằm ở máy chủ điều phối (không phải ở runner trên máy từ xa), dựa vào thư mục thật mà runner báo về. Với đường dẫn `~` trên máy từ xa, chính sách không biết thư mục home ở đó nên **hỏi** thay vì đoán; các đường dẫn hệ thống tuyệt đối vẫn bị chặn.

## Đã kiểm chứng gì và chưa

Đã kiểm chứng: 19 test chính sách (hàng trăm lệnh, gồm các cách lách như `\rm`, `"rm"`, `env rm`, `/bin/rm`, `bash -c`, `cd` rồi đọc `/etc`, `..`, đường ống vào shell, nhóm lệnh, biến, `$(…)`), tích hợp vào phòng (thẻ, chặn, ghi dấu vết, lưu mức, `full` trong yaml bị bỏ qua, turn chỉ-đọc không bị nới), chuyển lý do từ chối qua kênh SSH tới runner, `/mode` qua Telegram, và **Claude thật** (`npm run test:live -- autonomy`, 14 mục): Manual cần thẻ; Auto cho `Write` trong thư mục chạy không thẻ, **chặn `rm` (file còn nguyên) và `sudo` và ghi `/etc`**, hỏi với `curl`, và model nhận được lý do; Full chạy `rm` file trong thư mục nhưng vẫn hỏi với `sudo`. Giao diện kiểm bằng Chromium.

**Chưa kiểm chứng:** hộp thoại xác nhận Full trong VS Code thật (đã viết, chưa chạy trong VS Code); Codex thật; Windows (chính sách có nhánh đường dẫn Windows nhưng chỉ kiểm bằng test đơn vị); `pwsh/cmd` (mọi lệnh Windows không nằm trong danh sách đều bị hỏi); và chính sách là danh sách chặn/cho thủ công nên **sẽ có lệnh nguy hiểm tôi chưa nghĩ tới**: nếu thấy một lệnh nguy hiểm được Auto cho chạy, hãy báo để thêm vào bộ test.
