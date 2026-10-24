# Runbook: Thiết lập AgentRoom cho một project đang có

> **Dành cho AI agent** (Claude Code, Codex, …) làm việc trong repo của người dùng.
> Làm lần lượt từ Bước 0 đến Bước 9. Mỗi bước có **Đầu ra** và **Kiểm tra**. Chỉ sang bước sau khi Kiểm tra đạt.
> Các ô **🛑 HỎI NGƯỜI DÙNG** là điểm dừng bắt buộc: hỏi, chờ trả lời, không tự quyết.

---

## Nguyên tắc chung (đọc trước, áp dụng suốt quá trình)

1. **Không sửa code sản phẩm.** Bạn chỉ được tạo hoặc sửa: `CLAUDE.md`, `AGENTS.md`, các file trong `.agentroom/`, và `.gitignore` (chỉ thêm dòng).
2. **Không ghi đè.** Nếu `CLAUDE.md` / `AGENTS.md` đã có, chỉ **thêm** một mục mới ở cuối file và giữ nguyên nội dung cũ.
3. **Không chạm vào bí mật.** Không đọc, không in ra, không copy `.env*`, khóa, token, trừ khi người dùng cho phép rõ ràng ở Bước 7.
4. **Không commit, không push** khi người dùng chưa đồng ý (Bước 9).
5. **Sự thật lấy từ repo.** Lệnh build/test, cấu trúc thư mục, stack đều phải lấy từ file thật (package.json, Makefile, CI, …). Không đoán. Không tìm thấy thì ghi `TODO: xác nhận với người dùng`.
6. Ghi lại mọi thứ đã làm để báo cáo ở Bước 9.

## Kiến thức nền về AgentRoom v0.6 (để cấu hình đúng)

- AgentRoom là VS Code extension. Nó đọc **`.agentroom/workers.yaml`** ở thư mục gốc workspace.
- **Account** là một login Claude Code hoặc Codex dùng chung. **Worker** là một persona (vai trò, kỹ năng, hướng dẫn) chạy trên một account. Nhiều worker có thể dùng chung một account.
- Tin nhắn trong chat:
  - Không có `@mention` → đến các worker có `coordinator: true`.
  - `@<id>` → đến đúng worker đó.
  - `@all` → đến tất cả.
  - Agent nhắn cho nhau chỉ bằng `@mention`. Sau `maxAgentHops` (mặc định 6) bước liên tiếp thì dừng gọi.
- Worker có `worktree: true` làm việc trong `.agentroom/worktrees/<id>`, trên nhánh git `agentroom/<id>`. Extension tự tạo worktree từ `HEAD` ở lượt đầu nếu thư mục chưa có. Nếu thư mục đã có, extension dùng lại.
- Worker Claude tự đọc **`CLAUDE.md`** của thư mục làm việc. Worker Codex tự đọc **`AGENTS.md`**.
- **`allowedTools`** (chỉ áp dụng cho Claude) là danh sách quyền được tự động cho phép, theo cú pháp luật quyền của Claude Code:
  - `Read`, `Grep`, `Glob`: đọc.
  - `Edit(apps/api/**)`, `Write(apps/api/**)`: chỉ sửa hoặc tạo file trong thư mục đó.
  - `Bash(pnpm test:*)`: chỉ chạy lệnh bắt đầu bằng `pnpm test`.

  Mọi thao tác ngoài danh sách sẽ hiện thẻ **Cho phép / Từ chối** để người dùng duyệt.
- **Codex** không có bước duyệt. An toàn của Codex dựa vào `sandbox`: `read-only`, `workspace-write` (mặc định), hoặc `danger-full-access`.
- Trạng thái chạy được lưu trong `.agentroom/state/`, worktree trong `.agentroom/worktrees/`. Cả hai **không** được commit.
- Agent phối hợp qua các tool MCP `agentroom`: `post_message`, `read_channel`, `list_tasks`, `create_task`, `claim_task`, `complete_task`, và các tool trí nhớ/skill: `remember`, `forget`, `recall`, `journal`, `propose_skill`.
- **Trí nhớ bền vững** (mỗi worker, dạng file, nằm ở thư mục gốc workspace nên mọi session đều đọc chung):
  - `.agentroom/agents/<id>/SOUL.md`: tính cách và cách làm việc. **Người dùng viết**, agent không tự sửa.
  - `.agentroom/agents/<id>/MEMORY.md`: những điều đã chắt lọc, agent ghi qua tool `remember` (mỗi mục có id `[Mn]`, kind `fact`/`lesson`/`decision`). Mục `decision` được bảo vệ, chỉ xoá khi người dùng yêu cầu.
  - `.agentroom/agents/<id>/journal/<ngày>.md`: nhật ký, hệ thống tự ghi một dòng sau mỗi lượt.
  - `.agentroom/team/MEMORY.md`: trí nhớ chung của cả đội.
  - Mỗi lượt, persona của worker chứa SOUL + trí nhớ + nhật ký gần đây (tối đa `agentroom.memoryBudgetChars`, mặc định 12000 ký tự). Nội dung giống khóa/mật khẩu bị từ chối khi ghi.
- **Skills thật** (`useSkills`): quy trình dạng `SKILL.md` (frontmatter `name`, `description`). Tìm theo thứ tự `.agentroom/skills/<tên>/`, `.claude/skills/<tên>/`, `~/.claude/skills/<tên>/`. Claude chỉ thấy đúng skill được bật; Codex được nhắc trong prompt (mức kiểm soát lỏng hơn). Agent có thể `propose_skill`: bản nháp nằm ở `.agentroom/skills/_drafts/`, **chỉ có hiệu lực sau khi người dùng bấm Duyệt**.
- **Chi phí và ngân sách**: mỗi lượt ghi vào `.agentroom/state/usage.jsonl`. Claude trả chi phí thật; Codex chỉ có token nên chi phí là **ước tính** theo setting `agentroom.pricing` (model không có trong bảng thì không có chi phí). `accounts.<id>.budgetUsdPerDay` tạm dừng account khi chạm 100% trong ngày (cảnh báo ở `warnAtPercent`).
- **Context Inspector**: nút 🔍 trên tin nhắn của agent mở đúng những gì đã gửi cho model ở lượt đó (lưu `.agentroom/state/turns/`, giữ `agentroom.inspector.keepTurns` lượt gần nhất, mặc định 300).
- **Lịch chạy (`schedules`)**: cron 5 trường, chỉ chạy khi VS Code đang mở. Lịch bị lỡ khi VS Code đóng được chạy bù **một** lần nếu trễ không quá `catchUpHours` (mặc định 6). `builtin: consolidate-memory` bảo worker tự gom trí nhớ.
- **Webhook (`webhooks`)**: máy chủ chỉ nghe `127.0.0.1:<agentroom.hookPort>` (mặc định 47321), đường dẫn `/hook/<id>`. **Bắt buộc ký HMAC SHA-256** (header `X-Hub-Signature-256`, tương thích GitHub) với secret lấy từ biến môi trường `secretEnv`. Muốn nhận từ Internet thì người dùng tự mở tunnel.
- **Nhiều máy (`hosts`)**: worker có thể chạy trên máy khác qua SSH. Khai báo máy ở `hosts:`, rồi gán `host:` cho **account** (account = một đăng nhập Claude/Codex trên **một** máy). Worker dùng account đó sẽ chạy ở máy đó, trong clone `workdir` (hoặc `hosts.<tên>.repo`), tạo worktree/nhánh `agentroom/<id>` ngay trên máy đó. AgentRoom tự cài một "runner" (1 file ~2 MB) vào `~/.agentroom/runner/` của máy đó qua SSH; máy đó cần Node ≥ 20 và `claude`/`codex` đã đăng nhập. Không cần mở VS Code ở máy đó, không cần port forwarding. Chi tiết: `docs/MULTI-MACHINE.md`.
- **Telegram (điều khiển từ điện thoại)** là cài đặt của **người dùng**, không nằm trong `workers.yaml`: token bot ở kho bí mật của VS Code, bật bằng lệnh "AgentRoom: Telegram — thiết lập", cần một bot **riêng** (không dùng chung bot đang gắn với chương trình khác). **Agent không được hỏi, nhận hay ghi token vào bất kỳ file nào.** Chi tiết: `docs/TELEGRAM.md`.
- **Một cửa sổ cho mỗi thư mục `.agentroom/`**: cửa sổ thứ hai thấy thẻ "đang chạy ở cửa sổ khác" và không chạy room (file `.agentroom/state/room.lock`). Đừng mở nhiều cửa sổ để "mỗi cửa sổ một worker".
- **Chuỗi chỉ-đọc (nguồn không tin cậy)**: webhook có `readOnly: true` chạy worker chỉ với tool đọc (tool ghi/Bash/web bị cấm hẳn). Câu trả lời và task tạo ra trong lượt đó **không tự đánh thức ai** qua `@mention`; người dùng đọc rồi tự nhắn `@<worker> ...` để tiếp tục. Nội dung payload luôn được bọc trong `<untrusted_payload>`.

---

## Bước 0: Thu thập yêu cầu

🛑 **HỎI NGƯỜI DÙNG** (gộp vào một tin nhắn):

1. Bạn dùng được những gì: **Claude Code** (gói Pro/Max hay API key?), **Codex CLI** (ChatGPT login hay API key?)
2. Muốn bắt đầu với bao nhiêu worker? (Khuyến nghị cho tuần đầu: 3 là lead, một dev, qa.)
3. Có vai trò bắt buộc nào không? (ví dụ "cần 1 dev mobile", "cần reviewer bảo mật")
4. Nhánh chính tên gì? (`main` / `develop` / …)
5. Có cho phép copy file `.env` vào worktree của agent không? (Mặc định: **không**)
6. **Máy chạy worker**: tất cả ở máy này, hay có worker chạy trên máy khác qua SSH? Nếu có máy khác, với **mỗi máy** hỏi: địa chỉ SSH (`user@host` hoặc alias), có đăng nhập bằng khoá không, đường dẫn clone repo **trên máy đó**, đã cài Node ≥ 20 và Claude Code/Codex (đã đăng nhập) chưa, và worker nào chạy ở đó.
7. Model mong muốn cho từng loại vai trò? (Bỏ trống thì dùng model mặc định của CLI.)

**Đầu ra:** một bản ghi câu trả lời. Dùng nó cho các bước sau.

---

## Bước 1: Kiểm tra môi trường

Chạy và ghi kết quả:

```bash
git rev-parse --show-toplevel          # phải là repo git
git status --porcelain | head          # ghi nhận nếu có thay đổi chưa commit
git branch --show-current
claude --version                       # nếu dùng Claude
codex --version                        # nếu dùng Codex
node --version                         # cần ≥ 20 cho script kiểm tra
```

**Kiểm tra:**
- Không phải repo git → 🛑 báo người dùng: worktree sẽ không hoạt động, tất cả worker sẽ dùng chung thư mục gốc. Hỏi có `git init` không.
- Thiếu `claude` / `codex` mà người dùng định dùng → 🛑 báo người dùng cách cài:
  - Claude Code: xem https://code.claude.com/docs (native installer).
  - Codex: `npm i -g @openai/codex`.
  - Đăng nhập bằng `claude` rồi `/login`, hoặc `codex login`.
- Đang có thay đổi chưa commit → ghi chú lại. Worktree tạo từ `HEAD` sẽ **không** chứa các thay đổi này. Báo người dùng ở Bước 9.

---

## Bước 2: Khảo sát repo

Mục tiêu: hiểu cấu trúc đủ để chia **vùng sở hữu** (ownership zone).

```bash
git ls-files | sed 's#/.*##' | sort | uniq -c | sort -rn | head -30     # thư mục cấp 1 và số file
git ls-files | awk -F/ 'NF>2{print $1"/"$2}' | sort | uniq -c | sort -rn | head -40
ls -a
git log --since="90 days ago" --name-only --pretty=format: | awk -F/ 'NF>1{print $1"/"$2}' | sort | uniq -c | sort -rn | head -20   # vùng hay thay đổi
```

Đọc (nếu có): `package.json` (+ workspaces), `pnpm-workspace.yaml`, `turbo.json`, `nx.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, `build.gradle*`, `Makefile`, `docker-compose*.yml`, `.github/workflows/*`, `.gitlab-ci.yml`, `README*`, `CONTRIBUTING*`, `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.github/copilot-instructions.md`.

**Đầu ra:** bảng dưới đây, lưu tạm vào `.agentroom/survey.md`:

```markdown
| Vùng (đường dẫn) | Ngôn ngữ / framework | Lệnh test | Lệnh lint | Phụ thuộc vào vùng | Ghi chú |
|---|---|---|---|---|---|
| apps/api | TypeScript / NestJS | pnpm --filter api test | pnpm --filter api lint | packages/shared | DB Prisma |
| apps/web | TypeScript / Next.js | pnpm --filter web test | … | packages/shared, apps/api (HTTP) | |
| packages/shared | TypeScript | … | … | — | types dùng chung |
| infra/ | Terraform | — | terraform fmt -check | — | ⚠ nhạy cảm |
```

Thêm: lệnh cài dependency, lệnh build, lệnh chạy dev, quy ước commit/nhánh (nếu thấy trong CONTRIBUTING hoặc CI), và vùng **nhạy cảm** (infra, migrations, auth, billing, CI).

**Kiểm tra:** mọi lệnh trong bảng phải trỏ được tới file nguồn (script trong package.json, target Makefile, bước CI). Lệnh nào không chắc thì ghi `TODO`.

---

## Bước 3: Viết `CLAUDE.md` và `AGENTS.md`

Hai file này là "sổ tay dự án" cho mọi agent, nên có nội dung giống nhau.
- Nếu file **chưa có**: tạo mới theo mẫu dưới.
- Nếu file **đã có**: thêm vào cuối một mục `## AgentRoom — làm việc nhóm`, gồm phần "Vùng sở hữu" và "Quy tắc nhóm". Các phần đã có thì không lặp lại.

Mẫu (thay toàn bộ phần trong `<…>` bằng dữ liệu thật từ Bước 2; giữ dưới ~150 dòng):

```markdown
# <Tên project>

## Tổng quan
<1–3 câu: sản phẩm làm gì, stack chính>

## Cấu trúc
- `<vùng>` — <mô tả ngắn>, <framework>
- …

## Lệnh
- Cài dependency: `<lệnh>`
- Build: `<lệnh>`
- Test toàn bộ: `<lệnh>` · Test một vùng: `<lệnh>`
- Lint/format: `<lệnh>`
- Chạy local: `<lệnh>`

## Quy ước
- <quy ước code/đặt tên/commit lấy từ repo>
- <ví dụ: không sửa migration cũ, tạo migration mới>

## Vùng sở hữu (AgentRoom)
| Vùng | Người phụ trách |
|---|---|
| `<đường dẫn>` | @<worker-id> |
Sửa file ngoài vùng của mình: hãy nhờ người phụ trách qua @mention, hoặc xin người dùng duyệt.

## Quy tắc nhóm
- Mỗi task: đọc yêu cầu → claim_task → làm → chạy test vùng của mình → complete_task (kèm tóm tắt + file đã sửa).
- Lần đầu làm việc trong worktree: chạy lệnh cài dependency trước.
- Không commit thẳng vào <nhánh chính>. Commit trong nhánh `agentroom/<id>` của bạn, message dạng `<id>: <mô tả>`.
- Không đọc/in/sửa file bí mật (`.env*`, khóa, token).
```

**Kiểm tra:** `CLAUDE.md` và `AGENTS.md` có cùng phần "Lệnh" và "Vùng sở hữu". Không chứa bí mật.

---

## Bước 4: Thiết kế đội

### 4.1 Luật chia việc

1. **Chia theo vùng code, không chia theo tính năng.** Mỗi vùng ở Bước 2 có đúng **một** worker phụ trách việc sửa. Một worker có thể phụ trách nhiều vùng nhỏ liên quan.
2. **Luôn có 1 coordinator** (`lead`): chỉ đọc, chia task, giao việc, tổng kết. Không sửa code.
3. **Nên có 1 reviewer/QA** (`qa`): đọc diff, chạy test, báo lỗi. Không sửa code sản phẩm.
4. **Vùng nhạy cảm** (infra, migrations, auth, billing, CI) không giao cho ai được tự động sửa. Nếu cần, giao cho một dev nhưng **không** đưa vùng đó vào `allowedTools`. Như vậy mọi lần sửa đều phải được duyệt.
5. **Số lượng:** bằng số người dùng chọn ở Bước 0. Nếu có nhiều vùng hơn số dev thì gộp các vùng liên quan, ví dụ `packages/shared` đi cùng backend.
6. **Chọn provider:**
   - **Claude:** lead, qa, và dev ở vùng cần thận trọng (có thẻ duyệt quyền).
   - **Codex:** dev nhận task đã được mô tả rõ (sandbox `workspace-write`).
   - Người dùng chỉ có một loại thì dùng loại đó cho tất cả.
7. **id worker:** ngắn, chữ thường, dễ gõ khi @mention: `lead`, `be`, `fe`, `mobile`, `infra`, `qa`, `docs`. Không dùng `all`, `user`, `system`.

### 4.2 Luật account và song song

- Mỗi login thật là **một** account trong YAML. Bỏ trống `home` để dùng login mặc định của máy.
  - Chỉ đặt `home` (giá trị `CLAUDE_CONFIG_DIR` / `CODEX_HOME`) khi người dùng có **nhiều** login và muốn tách riêng. Mỗi thư mục `home` cần đăng nhập riêng một lần.
- Dùng API key: đặt `apiKeyEnv: <TÊN_BIẾN_MÔI_TRƯỜNG>`. Chỉ ghi **tên biến**, không bao giờ ghi giá trị key vào YAML.
- `maxConcurrent`: subscription Claude để **2** (tối đa 3), Codex ChatGPT login để **1**, API key thì tùy hạn mức.

- **Account gắn với máy**: mỗi account là một đăng nhập trên một máy. Muốn worker chạy ở máy khác thì tạo account riêng có `host:`; cùng một gói subscription đăng nhập trên hai máy vẫn là **hai account** (giới hạn thật dùng chung phía nhà cung cấp, nên đặt `maxConcurrent` cẩn thận).

### 4.3 Bảng `allowedTools` theo vai trò (Claude)

| Vai trò | allowedTools |
|---|---|
| lead | `[Read, Grep, Glob]` |
| dev vùng X | `[Read, Grep, Glob, "Edit(X/**)", "Write(X/**)", "Bash(<lệnh test vùng X>:*)", "Bash(<lệnh lint>:*)", "Bash(<lệnh cài dependency>)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git add:*)", "Bash(git commit:*)"]` |
| qa | `[Read, Grep, Glob, "Bash(<lệnh test>:*)", "Bash(git diff:*)", "Bash(git log:*)"]` |

**Không bao giờ** đưa vào: `Bash` (không giới hạn), `Bash(git push:*)`, `Bash(rm:*)`, hoặc `Edit` / `Write` không kèm đường dẫn.

### 4.4 Luật cho trí nhớ, skills, ngân sách, lịch và webhook

1. **SOUL.md**: mỗi worker có một bản, 5–15 dòng: cách làm việc, ưu tiên, điều không bao giờ làm. Soạn **nháp từ vai trò** của worker rồi để người dùng sửa (Bước 5.4). Không đưa thông tin bí mật vào.
2. **Skills**: chỉ tạo skill cho quy trình **lặp lại và có nhiều bước** đã thấy trong repo (ví dụ "đổi schema DB", "thêm endpoint kèm test"). Mỗi skill một việc, `description` nói rõ *khi nào dùng*. Không tạo skill cho thứ đã có trong `CLAUDE.md`. Mỗi worker bật 0–4 skill.
3. **Ngân sách**: account dùng API key thì đặt `budgetUsdPerDay` (hỏi người dùng con số). Account subscription thì **bỏ qua** (chi phí chỉ là giá trị tương đương); dùng `maxConcurrent` để kiểm soát.
4. **Lịch**: chỉ thêm khi người dùng yêu cầu. Gợi ý hợp lý: `qa` chạy test ban đêm, `lead` viết standup buổi sáng, `memory-gc` hằng đêm (`worker: "*"`, `builtin: consolidate-memory`). Luôn đặt `timezone` theo người dùng.
5. **Webhook**: chỉ thêm khi người dùng yêu cầu. Luôn `secretEnv` + `readOnly: true` + worker nhận là coordinator, `match` đủ hẹp (ví dụ chỉ `conclusion: failure`). Không bao giờ ghi giá trị secret vào file.

🛑 **HỎI NGƯỜI DÙNG:** trình bảng phân công dự kiến (worker, vai trò, vùng, provider, model) và chờ đồng ý trước khi viết YAML.

### 4.5 Luật cho nhiều máy

1. **Chỉ dùng máy khác khi người dùng yêu cầu** (Bước 0). Mặc định mọi worker chạy ở máy này.
2. **Một máy = một mục `hosts`**, tên viết thường ngắn gọn (`gpu-box`, `mac-mini`). `ssh` chỉ là `user@host`, `host` hoặc alias; **không bao giờ** đưa tuỳ chọn ssh (`-o…`), mật khẩu hay khoá riêng vào file.
3. **`repo` là đường dẫn trên máy đó** (tuyệt đối hoặc `~/…`), không phải đường dẫn ở máy này. Worker cần clone khác thì đặt `workdir`.
4. **Worker ghi code trên máy khác luôn `worktree: true`**; hai worker cùng một clone mà không có worktree sẽ ghi đè nhau.
5. **Worker từ xa phải push**: persona đã nhắc `git push origin agentroom/<id>`; đảm bảo clone trên máy đó có quyền push tới `origin` (khoá/credential của máy đó), nếu không thì báo người dùng.
6. **`node`/`claudePath`/`codexPath`**: chỉ đặt khi người dùng biết đường dẫn đầy đủ (login shell của SSH thường không có PATH của nvm). Không đoán.
7. Mỗi máy cần **account riêng** (`account.host`); đặt `maxConcurrent` theo máy.

---

## Bước 5: Viết `.agentroom/workers.yaml`

### 5.1 Schema chính xác (v0.4)

**`hosts.<tên>`** (tùy chọn; tên như id worker, không phải `local`)

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `ssh` | ✔ | `user@host` / host / alias | | không được bắt đầu bằng `-`, không có khoảng trắng |
| `repo` | | đường dẫn trên máy đó | | tuyệt đối hoặc `~/…`; bắt buộc nếu worker không có `workdir` |
| `port` | | 1–65535 | 22 | |
| `identityFile` | | đường dẫn khoá trên **máy này** | ssh-agent / mặc định | |
| `node` | | đường dẫn trên máy đó | `node` | khi login shell không thấy node |
| `claudePath`, `codexPath` | | đường dẫn trên máy đó | tìm trong PATH | |
| `connectTimeoutSec` | | 1–120 | `15` | |

**`accounts.<account-id>`**

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `provider` | ✔ | `claude` \| `codex` | | |
| `home` | | chuỗi | login mặc định | `~` được mở rộng |
| `apiKeyEnv` | | chuỗi | | tên biến môi trường chứa key |
| `maxConcurrent` | | số nguyên ≥ 1 | `1` | |
| `host` | | tên trong `hosts` | máy này | account là một đăng nhập **trên máy đó**; `home`/`apiKeyEnv` cũng là của máy đó |
| `budgetUsdPerDay` | | số > 0 | không giới hạn | tạm dừng account khi chi phí trong ngày chạm mức này |
| `warnAtPercent` | | số 1–100 | `80` | cảnh báo trong chat |

**`workers[]`**

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `id` | ✔ | `^[a-z][a-z0-9_-]*$` | | duy nhất; không phải `all`/`user`/`system` |
| `name` | ✔ | chuỗi | | tên hiển thị (có thể có dấu) |
| `role` | ✔ | chuỗi | | |
| `account` | ✔ | chuỗi | | phải có trong `accounts` |
| `skills` | | danh sách chuỗi | `[]` | thẻ mô tả, hiển thị cho đồng đội |
| `useSkills` | | danh sách tên skill | `[]` | skill **thật** được bật (phải tồn tại) |
| `model` | | chuỗi | mặc định của CLI | |
| `contextLimit` | | số nguyên | `150000` (điều phối viên: tắt) | token context mà sau đó session Claude bị thay bằng session mới để tiết kiệm hạn mức; `0` = không bao giờ |
| `instructions` | | chuỗi (dùng `\|` cho nhiều dòng) | `""` | |
| `allowedTools` | | danh sách chuỗi | `[Read, Grep, Glob]` | chỉ Claude |
| `worktree` | | bool | `false` | `true` cho mọi dev sửa code |
| `coordinator` | | bool | `false` | ít nhất một worker nên là `true` |
| `color` | | chuỗi `#rrggbb` | tự chọn từ bảng 10 màu | màu của worker trong chat; bỏ trống thì tự gán, tránh trùng màu đã chọn |
| `workdir` | | đường dẫn | workspace (hoặc `hosts.<tên>.repo`) | clone worker dùng; trên máy này có thể tương đối, trên host phải tuyệt đối/`~/…` |
| `sandbox` | | `read-only` \| `workspace-write` \| `danger-full-access` | `workspace-write` | chỉ Codex |
| `tools` | | danh sách tên tool | lõi (`Read, Grep, Glob, Edit, Write, Bash`) + các tool trong `allowedTools` | **Chỉ Claude.** Những built-in tool được NẠP cho worker. Mỗi tool nạp tốn token ở mọi lượt (đo: nạp hết ≈ 33 nghìn token mỗi session, bộ lõi ≈ 8 nghìn, chỉ `Read, Grep, Glob` ≈ 6 nghìn). `allowedTools` chỉ tự duyệt, không giới hạn việc nạp. Thêm tool ngoài lõi (`WebFetch`, `WebSearch`, `Agent`, `TodoWrite`…) bằng cách ghi vào `allowedTools` hoặc `tools:`. Lượt chỉ-đọc luôn chỉ có `Read, Grep, Glob`. `Skill` tự được thêm khi có `useSkills`. Worker chỉ điều phối nên đặt `tools: [Read, Grep, Glob]` |
| `autonomy` | | `manual` \| `auto` \| `full` | `manual` | mức tự chủ: `manual` hỏi mọi thao tác chưa được duyệt trước; `auto` tự duyệt việc an toàn trong thư mục của worker, chặn xóa file/hệ thống/sudo, hỏi khi không chắc. **`full` ghi ở đây không có hiệu lực** (chạy Auto): Full Access chỉ do người dùng bật trên máy của mình. Xem `docs/AUTONOMY.md` |

**`limits`** (tùy chọn, cấp cao nhất): chặn các worker nói chuyện với nhau thành vòng lặp tốn token. Xem `docs/FEWER-TURNS.md`.

| Khóa | Kiểu | Mặc định | Ý nghĩa |
|---|---|---|---|
| `chainTurns` | số nguyên 2–100 | `10` | Số lượt worker tối đa mà MỘT tin nhắn của người dùng (hoặc một lịch/webhook) được phép kéo theo. Hết thì tạm dừng và báo |
| `usdPerTask` | số > 0 | không giới hạn | Task đã tốn bằng này (USD) thì các worker thôi làm tiếp việc đó với nhau; bạn vẫn nhắn vào task để tiếp tục |

**`schedules[]`** (tùy chọn)

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `id` | ✔ | như id worker | | duy nhất |
| `worker` | ✔ | id worker hoặc `"*"` | | `"*"` = mọi worker |
| `cron` | ✔ | chuỗi cron 5 trường | | ví dụ `"0 2 * * 1-5"` (phải đặt trong nháy kép) |
| `timezone` | | IANA | giờ máy | ví dụ `Asia/Ho_Chi_Minh` |
| `prompt` | một trong hai | chuỗi | | nội dung giao cho worker |
| `builtin` | một trong hai | `consolidate-memory` | | không dùng cùng `prompt` |
| `session` | | `fresh` \| `persistent` | `fresh` | `fresh`: session mới mỗi lần |
| `skipIfRunning` | | bool | `true` | bỏ qua nếu lần trước chưa xong |
| `catchUpHours` | | số ≥ 0 | `6` | chạy bù một lần nếu bị lỡ không quá số giờ này |
| `notify` | | bool | `false` | hiện thông báo VS Code khi worker trả lời |
| `enabled` | | bool | `true` | |

**`webhooks[]`** (tùy chọn)

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `id` | ✔ | như id worker | | URL: `http://127.0.0.1:<hookPort>/hook/<id>` |
| `worker` | ✔ | id worker | | |
| `prompt` | ✔ | chuỗi | | `{{a.b.c}}` được thay bằng trường của payload (một dòng, ≤ 500 ký tự) |
| `secretEnv` | ✔ (hoặc `allowUnsigned`) | tên biến môi trường | | chứa HMAC secret; **chỉ ghi tên biến** |
| `allowUnsigned` | | bool | `false` | chỉ để thử trên máy mình |
| `match` | | object | `{}` | `{ "workflow_run.conclusion": failure }`: mọi cặp phải khớp |
| `maxPerHour` | | số nguyên ≥ 1 | `6` | vượt thì trả 429 |
| `readOnly` | | bool | `false` | **nên `true`**: chỉ tool đọc, chuỗi chỉ-đọc |

Trường không có trong bảng sẽ bị bỏ qua.

### 5.2 Mẫu

Thay theo kết quả Bước 4. Chuỗi có ký tự `( ) * :` phải đặt trong dấu nháy kép.

```yaml
accounts:
  claude-main:
    provider: claude
    maxConcurrent: 2
  codex-main:
    provider: codex
    maxConcurrent: 1

workers:
  - id: lead
    name: Lan
    role: Tech Lead
    account: claude-main
    coordinator: true
    skills: [phân tích yêu cầu, chia task, review kiến trúc]
    allowedTools: [Read, Grep, Glob]
    instructions: |
      Bạn không sửa code. Với mỗi yêu cầu:
      1) Đọc code liên quan, chia thành task nhỏ (≤ nửa ngày), mỗi task thuộc MỘT vùng.
      2) create_task với assignee theo bảng "Vùng sở hữu" trong CLAUDE.md, khai báo dependsOn khi cần.
      3) Khi các task xong, giao @qa review, rồi tổng kết cho @user: đã làm gì, nhánh nào cần merge.
      Câu hỏi về nghiệp vụ hoặc ưu tiên thì hỏi @user, không tự đoán.

  - id: be
    name: Minh
    role: Backend Developer
    account: claude-main
    worktree: true
    skills: [NestJS, Prisma, PostgreSQL]
    useSkills: [prisma-migration]          # chỉ khi skill này tồn tại (Bước 5.4)
    allowedTools:
      - Read
      - Grep
      - Glob
      - "Edit(apps/api/**)"
      - "Write(apps/api/**)"
      - "Edit(packages/shared/**)"
      - "Bash(pnpm install)"
      - "Bash(pnpm --filter api test:*)"
      - "Bash(pnpm --filter api lint:*)"
      - "Bash(git status:*)"
      - "Bash(git diff:*)"
      - "Bash(git add:*)"
      - "Bash(git commit:*)"
    instructions: |
      Vùng của bạn: apps/api, packages/shared. Lần đầu hãy chạy `pnpm install`.
      Mỗi thay đổi phải có test. Chạy test vùng trước khi complete_task.
      Thay đổi API contract thì báo @fe kèm ví dụ request/response.

  - id: fe
    name: Hoa
    role: Frontend Developer
    account: codex-main
    worktree: true
    sandbox: workspace-write
    skills: [Next.js, Tailwind, accessibility]
    instructions: |
      Vùng của bạn: apps/web. Không sửa file ngoài vùng; cần thì @mention người phụ trách.
      Lần đầu hãy chạy `pnpm install`. Chạy `pnpm --filter web test` trước khi complete_task.

  - id: qa
    name: Tuấn
    role: QA / Reviewer
    account: claude-main
    skills: [review code, viết test case, tìm bug]
    allowedTools: [Read, Grep, Glob, "Bash(pnpm test:*)", "Bash(git diff:*)", "Bash(git log:*)"]
    instructions: |
      Khi được nhờ review nhánh agentroom/<id>: chạy `git diff <nhánh chính>...agentroom/<id>`, đọc kỹ, chạy test.
      Báo lỗi cụ thể (file:dòng, cách tái hiện) cho đúng người phụ trách bằng @mention.
      Chỉ báo "đạt" khi test pass và không còn lỗi nghiêm trọng.
```

Thêm **chỉ khi người dùng yêu cầu** worker chạy ở máy khác (Bước 4.5):

```yaml
hosts:
  gpu-box:
    ssh: dev@gpu-box.example.com
    repo: /home/dev/app

# trong accounts: thêm một account trên máy đó
#   gpu-claude: { provider: claude, host: gpu-box, maxConcurrent: 2 }
# rồi đổi account của worker cần chạy ở đó:
#   - { id: be, name: Minh, role: Backend Developer, account: gpu-claude, worktree: true }
```

Thêm vào cuối file **chỉ khi người dùng yêu cầu** lịch hoặc webhook (Bước 4.4):

```yaml
schedules:
  - id: nightly-tests
    worker: qa
    cron: "0 2 * * 1-5"
    timezone: Asia/Ho_Chi_Minh
    prompt: Chạy toàn bộ test trên main. Nếu fail, tạo task cho đúng người phụ trách vùng.
  - id: memory-gc
    worker: "*"
    cron: "0 3 * * *"
    builtin: consolidate-memory

webhooks:
  - id: ci-failed
    worker: lead
    secretEnv: AGENTROOM_HOOK_SECRET
    readOnly: true
    match: { "workflow_run.conclusion": failure }
    prompt: "CI fail ở nhánh {{workflow_run.head_branch}} ({{workflow_run.html_url}}). Tìm nguyên nhân và đề xuất người sửa."
```

### 5.3 Viết `instructions` tốt

Mỗi worker cần có:
1. Vùng của mình (đường dẫn).
2. Việc cần làm lần đầu (cài dependency).
3. Điều kiện để được coi là "xong" (test nào phải pass).
4. Phải báo cho ai khi nào.

Không lặp lại nội dung đã có trong `CLAUDE.md`. Giữ dưới 15 dòng.

---

### 5.4 Viết `SOUL.md` và skills

**SOUL.md** (mỗi worker). Extension tự tạo file mẫu khi nạp cấu hình; nếu chưa có thì tạo tay `.agentroom/agents/<id>/SOUL.md`. Viết nháp từ vai trò và `instructions`, ví dụ:

```markdown
# Minh (@be) — SOUL
Bạn cẩn thận, ưa giải pháp đơn giản nhất chạy được.
- Viết test trước khi sửa lỗi; không sửa migration cũ.
- Gặp yêu cầu mơ hồ thì hỏi @lead một câu cụ thể thay vì đoán.
- Không bao giờ chạm vào `infra/` hay file `.env`.
```

Báo người dùng: đây là bản **nháp**, họ nên sửa cho đúng ý. Đừng ghi quá 15 dòng. Validator sẽ cảnh báo nếu file vẫn là bản mẫu rỗng.

**Skills.** Với mỗi quy trình lặp lại xác định ở Bước 4.4, tạo `.agentroom/skills/<tên>/SKILL.md`:

```markdown
---
name: prisma-migration
description: Dùng khi cần thay đổi schema DB. Tạo migration mới (không sửa migration cũ), chạy migrate rồi test.
---
1. Sửa `apps/api/prisma/schema.prisma`.
2. `pnpm --filter api prisma migrate dev --name <mô tả ngắn>`.
3. Chạy `pnpm --filter api test`; sửa tới khi pass.
4. Báo @fe nếu API contract đổi.
```

Quy tắc: `name` chỉ gồm `a-z 0-9 -` và trùng tên thư mục; `description` bắt buộc và nói *khi nào dùng*; các bước lấy từ quy trình thật của repo (CONTRIBUTING, CI, lịch sử commit), không bịa. Sau đó thêm tên skill vào `useSkills` của đúng worker. Không đặt bí mật trong skill (file vẫn đọc được qua Read/Bash).

---

## Bước 6: `.gitignore`

Tạo `.agentroom/.gitignore` với nội dung:

```
state/
worktrees/
.plugin/
survey.md
agents/*/journal/
```

Nếu `.gitignore` ở thư mục gốc đang ignore toàn bộ `.agentroom`, hãy báo người dùng. **Nên commit** để cả team dùng chung: `workers.yaml`, `skills/`, `agents/*/SOUL.md`, `agents/*/MEMORY.md`, `team/MEMORY.md`. **Không commit**: `state/` (chứa lịch sử chat, chi phí, nội dung gửi cho model), `worktrees/`, `.plugin/`, nhật ký.

**Kiểm tra:** `git check-ignore -v .agentroom/worktrees/x .agentroom/state/x` in ra 2 dòng, và `git check-ignore .agentroom/workers.yaml` không in gì.

---

## Bước 7 (tùy chọn): Tạo sẵn worktree

> Chỉ cho worker chạy **ở máy này**. Worktree của worker trên máy khác do AgentRoom tạo ở máy đó khi chạy lượt đầu; đừng tự ssh vào để tạo.

Làm bước này nếu muốn lượt đầu của agent nhanh hơn. Nếu bỏ qua, extension sẽ tự tạo worktree.

Với **mỗi** worker có `worktree: true`:

```bash
ID=be                                    # lặp cho từng worker
BASE=main                                # nhánh chính từ Bước 0
git worktree add -b agentroom/$ID .agentroom/worktrees/$ID $BASE
# Nếu nhánh agentroom/$ID đã có:  git worktree add .agentroom/worktrees/$ID agentroom/$ID
(cd .agentroom/worktrees/$ID && <lệnh cài dependency>)
```

- Đường dẫn và tên nhánh phải **đúng y** như trên thì extension mới dùng lại được.
- Chỉ copy `.env` khi người dùng đã cho phép ở Bước 0: `cp .env .agentroom/worktrees/$ID/.env`

**Kiểm tra:** `git worktree list` có đủ các worktree.

---

## Bước 8: Kiểm tra cấu hình

Tạo script kiểm tra **ngoài repo** (để không làm bẩn repo) rồi chạy:

```bash
CHECK_DIR="$(mktemp -d)"
# Ghi nội dung ở Phụ lục A vào "$CHECK_DIR/validate-agentroom.mjs"
(cd "$CHECK_DIR" && npm init -y >/dev/null && npm i --silent yaml croner)
node "$CHECK_DIR/validate-agentroom.mjs" "$(git rev-parse --show-toplevel)"
```

**Kiểm tra:**
- Kết quả phải là `ĐẠT`.
- Sửa tất cả lỗi `✗`.
- Với mỗi cảnh báo `⚠`: sửa, hoặc ghi lý do giữ nguyên vào báo cáo.

Kiểm tra thủ công thêm:
- [ ] Mỗi vùng ở Bước 2 có đúng một người phụ trách (khớp bảng "Vùng sở hữu" trong `CLAUDE.md`).
- [ ] Đường dẫn trong `Edit(...)` / `Write(...)` tồn tại thật (`ls <đường dẫn>`).
- [ ] Lệnh trong `Bash(...)` khớp lệnh thật ở Bước 2.
- [ ] Mọi tên trong `useSkills` có `SKILL.md` thật; mỗi skill có `description` nói rõ khi nào dùng.
- [ ] Mỗi worker có `SOUL.md` đã viết nháp (không còn là bản mẫu rỗng).
- [ ] Mỗi webhook có `secretEnv` (chỉ là **tên** biến), `readOnly: true`, `match` hẹp; lịch có `timezone`.
- [ ] Mỗi `hosts.<tên>`: `ssh` đúng dạng, `repo`/`workdir` là đường dẫn **trên máy đó**; mỗi account có `host:` trỏ tới host có thật; không worker nào ghi code trên host mà thiếu `worktree: true`.
- [ ] Không có giá trị bí mật trong YAML, CLAUDE.md hay AGENTS.md (`grep -nEi "sk-|api[_-]?key\s*[:=]\s*\S{12,}|password" CLAUDE.md AGENTS.md .agentroom/workers.yaml` không ra kết quả đáng ngờ).

---

## Bước 9: Bàn giao

Gửi người dùng báo cáo gồm:

1. **File đã tạo hoặc sửa** (danh sách đường dẫn), kèm diff ngắn nếu có sửa file cũ.
2. **Bảng đội:** id, tên, vai trò, vùng, provider, model.
3. **Kết quả kiểm tra** ở Bước 8 và các cảnh báo được giữ lại.
4. **Việc người dùng cần tự làm:**
   - Đọc và sửa các `SOUL.md` nháp.
   - Nếu có máy từ xa, với **mỗi máy** (agent không tự làm được các việc này): (1) `ssh <ssh>` vào được bằng khoá và đã xác nhận host key (chạy một lần trong terminal); (2) Node ≥ 20; (3) Claude Code/Codex đã cài và đăng nhập; (4) đã clone repo về đúng `repo`/`workdir` và `git pull` mới; (5) clone đó push được tới `origin`. Sau đó chạy lệnh **"AgentRoom: Kiểm tra kết nối các máy"** (hoặc tab *Máy* → *Kiểm tra tất cả*) và cho phép hộp thoại xác nhận host.
   - Chỉ mở **một** cửa sổ VS Code cho repo này (cửa sổ thứ hai sẽ bị chặn).
   - (Tuỳ chọn) Muốn điều khiển từ điện thoại: tự tạo một bot Telegram **riêng** ở @BotFather rồi chạy lệnh **"AgentRoom: Telegram — thiết lập"** trong VS Code (xem `docs/TELEGRAM.md`). Đừng gửi token cho agent.
   - Nếu có webhook: đặt biến môi trường `secretEnv` (giá trị là một chuỗi ngẫu nhiên dài) **trước khi mở VS Code**, và dùng cùng giá trị đó làm secret khi cấu hình webhook ở bên gửi (GitHub: Settings → Webhooks → Secret). Muốn nhận từ GitHub thì tự mở tunnel tới cổng `agentroom.hookPort`.
   - Nếu dùng Codex và muốn thấy chi phí: điền `agentroom.pricing` trong Settings (USD / 1 triệu token). Bỏ trống thì Codex chỉ hiện token.
   - Cài extension AgentRoom (file `.vsix`: Extensions → `…` → Install from VSIX).
   - Đăng nhập `claude` / `codex` nếu chưa.
   - Mở repo trong VS Code → biểu tượng AgentRoom ở activity bar. Nếu chưa thấy worker: `Ctrl+Shift+P` → **AgentRoom: Nạp lại workers.yaml**.
   - Nếu có thay đổi chưa commit (ghi nhận ở Bước 1): commit trước, vì worktree tạo từ `HEAD` sẽ không chứa chúng.
5. **Ba tin nhắn chạy thử**, theo thứ tự:
   - `@all giới thiệu ngắn: bạn là ai, phụ trách vùng nào, lệnh test của bạn là gì?` → kiểm tra mỗi worker hiểu đúng vai trò.
   - `@qa chạy test toàn bộ và báo kết quả.` → kiểm tra quyền Bash và lệnh test.
   - `<một task nhỏ thật, ví dụ sửa một bug nhỏ>` (không @mention) → kiểm tra lead chia việc → dev làm → qa review.
6. 🛑 **HỎI NGƯỜI DÙNG:** có muốn commit `CLAUDE.md`, `AGENTS.md`, `.agentroom/workers.yaml`, `.agentroom/.gitignore` không? Nếu có thì commit trên một nhánh mới, ví dụ `chore/agentroom-setup`. Không push nếu chưa được yêu cầu.

---

## Xử lý sự cố

| Triệu chứng | Nguyên nhân | Cách xử lý |
|---|---|---|
| Thông báo "workers.yaml lỗi — …" | Sai schema | Chạy lại Bước 8, sửa theo thông báo |
| "Không tìm thấy CLI claude/codex" | CLI không có trong PATH của VS Code | Settings → `agentroom.claudePath` / `agentroom.codexPath` (Windows: trỏ tới `.exe`) |
| Tin nhắn không ai trả lời | Không @mention và không có coordinator; hoặc gõ sai id | Thêm `coordinator: true` cho lead; id phải viết thường |
| Agent hỏi duyệt liên tục | `allowedTools` quá hẹp hoặc sai lệnh | Thêm đúng mẫu `Bash(<lệnh>:*)` / `Edit(<vùng>/**)` |
| Trạng thái "hết quota" | Account dùng chung bị giới hạn | Giảm `maxConcurrent`, ít worker hơn, hoặc thêm account |
| Worktree thiếu dependency hoặc `.env` | Worktree là checkout mới | Chạy lệnh cài trong worktree; copy `.env` nếu được phép |
| Hai agent nhắn qua lại không dứt | Instructions khuyến khích @mention lẫn nhau | Sửa instructions; giảm `agentroom.maxAgentHops` |
| Tab "Chi phí" không có số tiền cho Codex | Chưa khai báo giá | Điền `agentroom.pricing` cho đúng tên model; bỏ trống thì chỉ có token |
| Account tự dừng, worker báo "hết ngân sách" | Chạm `budgetUsdPerDay` | Bấm "Cho chạy tiếp hôm nay" ở tab Chi phí, hoặc nâng ngân sách |
| Lịch không chạy | VS Code đang đóng, hoặc lịch bị tắt | Lịch chỉ chạy khi VS Code mở; xem tab Lịch. Bị lỡ quá `catchUpHours` thì bỏ qua |
| Webhook trả 401 | Sai chữ ký hoặc secret khác nhau | Secret ở bên gửi phải bằng giá trị của biến `secretEnv` |
| Webhook trả 503 | Biến môi trường `secretEnv` chưa được đặt cho VS Code | Đặt biến rồi khởi động lại VS Code |
| Webhook chạy nhưng không ai làm tiếp | Chuỗi chỉ-đọc không tự gọi ai | Đúng thiết kế: đọc báo cáo rồi nhắn `@<worker> ...` để tiếp tục |
| Cảnh báo "skills" khi nạp | `useSkills` trỏ tới skill không tồn tại, hoặc `SKILL.md` thiếu `description` | Chạy lại Bước 8, sửa theo thông báo |
| Telegram báo "Bot đang được một chương trình khác nhận tin" | Bot đang dùng chung với chương trình khác (mỗi token một nơi nhận tin) | Tạo bot riêng cho AgentRoom (@BotFather → /newbot) |
| Thẻ "Phòng này đang chạy ở một cửa sổ khác" | Có cửa sổ khác đang điều phối thư mục này | Dùng cửa sổ đó, hoặc bấm *Chiếm quyền điều phối* |
| "Chưa xác nhận host key" / "SSH từ chối đăng nhập" / "Không tìm thấy node" / "Không tìm thấy CLI claude" | Chuẩn bị máy từ xa chưa đủ | Xem bảng xử lý sự cố ở `docs/MULTI-MACHINE.md` (mục 10) |
| Worker từ xa làm xong nhưng code không thấy ở máy này | Thay đổi nằm trong clone của máy đó | Worker phải `git push origin agentroom/<id>`; rồi `git fetch` ở máy này |
| Codex sửa file ngoài vùng | Codex không có thẻ duyệt | Nhắc vùng trong `instructions`; dùng `sandbox: read-only` cho vai trò chỉ đọc |

---

## Phụ lục A: `validate-agentroom.mjs`

```js
// Kiểm tra .agentroom/workers.yaml theo đúng luật của AgentRoom v0.6.
// Cách chạy: node validate-agentroom.mjs <đường-dẫn-repo>
// Cần: npm i yaml croner (cài ở thư mục tạm, không cài vào repo).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const YAML = require("yaml");
const { Cron } = require("croner");

const repo = process.argv[2] ?? ".";
const file = join(repo, ".agentroom", "workers.yaml");
const errors = [], warns = [];
if (!existsSync(file)) { console.error(`✗ Không có ${file}`); process.exit(1); }
const cfg = YAML.parse(readFileSync(file, "utf8")) ?? {};
const ID = /^[a-z][a-z0-9_-]*$/;
const isStr = (v) => typeof v === "string" && v.length > 0;
const isBool = (v) => typeof v === "boolean";
const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

// ---- khóa cấp cao nhất ----
for (const k of Object.keys(cfg)) {
  if (["hosts", "accounts", "workers", "schedules", "webhooks", "limits"].includes(k)) continue;
  warns.push(/telegram|channel|bot/i.test(k)
    ? `Khóa "${k}" bị bỏ qua: Telegram được cấu hình trong cài đặt VS Code của người dùng (lệnh "AgentRoom: Telegram — thiết lập"), KHÔNG đặt token hay cấu hình bot trong file của repo`
    : `Khóa cấp cao nhất "${k}" không được dùng (bị bỏ qua)`);
}
if (/\d{6,}:[A-Za-z0-9_-]{30,}/.test(readFileSync(file, "utf8"))) errors.push("workers.yaml có chuỗi giống TOKEN BOT TELEGRAM — xoá ngay và tạo token mới ở @BotFather (/revoke); token không được nằm trong repo");

// ---- skills có sẵn (cùng thứ tự ưu tiên với extension) ----
const skillDirs = [join(repo, ".agentroom", "skills"), join(repo, ".claude", "skills"), join(homedir(), ".claude", "skills")];
const skills = new Set();
for (const dir of skillDirs) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue;
    const f = join(dir, entry, "SKILL.md");
    if (!existsSync(f) || !statSync(join(dir, entry)).isDirectory()) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(f, "utf8"));
    let meta = {};
    try { meta = m ? YAML.parse(m[1]) ?? {} : {}; } catch { /* bỏ qua */ }
    if (!isStr(meta.description)) { errors.push(`Skill ${join(dir, entry)}: thiếu description trong frontmatter`); continue; }
    const name = isStr(meta.name) ? meta.name : entry;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { errors.push(`Skill ${join(dir, entry)}: tên "${name}" không hợp lệ (a-z, 0-9, '-')`); continue; }
    skills.add(name);
  }
}

// ---- hosts (máy chạy worker qua SSH) ----
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+-]*$/;
const remotePath = (p) => p === "~" || p.startsWith("~/") || p.startsWith("/");
const hosts = cfg.hosts ?? {};
if (typeof hosts !== "object" || Array.isArray(hosts)) errors.push("hosts: phải là object {tên: {ssh, repo, …}}");
const hostKnown = new Set(["ssh", "port", "identityFile", "repo", "node", "claudePath", "codexPath", "connectTimeoutSec"]);
for (const [name, h] of Object.entries(typeof hosts === "object" && !Array.isArray(hosts) ? hosts : {})) {
  const at = `hosts.${name}`;
  if (!ID.test(name)) errors.push(`${at}: tên host phải bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 _ -`);
  if (name === "local") errors.push(`${at}: "local" là tên dành riêng`);
  if (!isStr(h?.ssh) || !SSH_TARGET.test(h.ssh)) errors.push(`${at}.ssh phải là user@host, host hoặc alias trong ~/.ssh/config (không được bắt đầu bằng '-', không có khoảng trắng)`);
  if (h?.port !== undefined && !(Number.isInteger(h.port) && h.port >= 1 && h.port <= 65535)) errors.push(`${at}.port phải là số nguyên 1–65535`);
  if (h?.identityFile !== undefined && (!isStr(h.identityFile) || h.identityFile.startsWith("-"))) errors.push(`${at}.identityFile không hợp lệ`);
  for (const k of ["repo", "node", "claudePath", "codexPath"]) if (h?.[k] !== undefined && !isStr(h[k])) errors.push(`${at}.${k} phải là chuỗi`);
  if (isStr(h?.repo) && !remotePath(h.repo)) errors.push(`${at}.repo phải là đường dẫn tuyệt đối hoặc bắt đầu bằng ~ (đây là đường dẫn TRÊN máy đó)`);
  if (h?.connectTimeoutSec !== undefined && !(Number.isInteger(h.connectTimeoutSec) && h.connectTimeoutSec >= 1 && h.connectTimeoutSec <= 120)) errors.push(`${at}.connectTimeoutSec phải là số nguyên 1–120`);
  for (const k of Object.keys(h ?? {})) if (!hostKnown.has(k)) warns.push(`${at}: trường "${k}" không được dùng (bị bỏ qua)`);
  if (!h?.repo) warns.push(`${at}: chưa có repo mặc định — mọi worker trên host này phải có workdir`);
  if (/(password|passwd|secret|token)/i.test(JSON.stringify(h ?? {}))) warns.push(`${at}: có vẻ chứa bí mật; SSH chỉ dùng khoá/ssh-agent, không đặt mật khẩu trong file`);
}

// ---- accounts ----
const accounts = cfg.accounts ?? {};
if (typeof accounts !== "object" || Array.isArray(accounts) || !Object.keys(accounts).length) errors.push("accounts: phải có ít nhất 1 account");
for (const [id, a] of Object.entries(accounts)) {
  if (!["claude", "codex"].includes(a?.provider)) errors.push(`accounts.${id}.provider phải là claude hoặc codex`);
  if (a?.maxConcurrent !== undefined && !(Number.isInteger(a.maxConcurrent) && a.maxConcurrent >= 1)) errors.push(`accounts.${id}.maxConcurrent phải là số nguyên ≥ 1`);
  if (a?.budgetUsdPerDay !== undefined && !(typeof a.budgetUsdPerDay === "number" && a.budgetUsdPerDay > 0)) errors.push(`accounts.${id}.budgetUsdPerDay phải là số > 0`);
  if (a?.warnAtPercent !== undefined && !(typeof a.warnAtPercent === "number" && a.warnAtPercent >= 1 && a.warnAtPercent <= 100)) errors.push(`accounts.${id}.warnAtPercent phải nằm trong 1–100`);
  if (a?.host !== undefined && !hosts?.[a.host]) errors.push(`accounts.${id}.host "${a.host}" không có trong hosts`);
  if (a?.host && a?.home) warns.push(`accounts.${id}: home là đường dẫn TRÊN máy "${a.host}"`);
  if (a?.provider === "claude" && (a?.maxConcurrent ?? 1) > 3) warns.push(`accounts.${id}: maxConcurrent > 3 dễ hết quota subscription`);
}

// ---- workers ----
const workers = Array.isArray(cfg.workers) ? cfg.workers : [];
if (!workers.length) errors.push("workers: phải có ít nhất 1 worker");
const ids = new Set();
const known = new Set(["id", "name", "role", "skills", "useSkills", "account", "model", "instructions", "allowedTools", "worktree", "coordinator", "sandbox", "workdir", "color", "autonomy", "tools"]);
const baseUsers = new Map();
for (const [i, w] of workers.entries()) {
  const at = `workers[${i}]${w?.id ? ` (${w.id})` : ""}`;
  if (!ID.test(w?.id ?? "")) errors.push(`${at}.id phải bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 _ -`);
  if (ids.has(w?.id)) errors.push(`${at}: trùng id`);
  ids.add(w?.id);
  if (["all", "user", "system"].includes(w?.id)) errors.push(`${at}.id "${w.id}" là tên dành riêng`);
  for (const k of ["name", "role", "account"]) if (!isStr(w?.[k])) errors.push(`${at}.${k} bắt buộc (chuỗi)`);
  if (w?.account && !accounts[w.account]) errors.push(`${at}.account "${w.account}" không có trong accounts`);
  for (const k of ["skills", "useSkills", "allowedTools"]) if (w?.[k] !== undefined && !strList(w[k])) errors.push(`${at}.${k} phải là danh sách chuỗi`);
  for (const k of ["worktree", "coordinator"]) if (w?.[k] !== undefined && !isBool(w[k])) errors.push(`${at}.${k} phải là true/false`);
  if (w?.tools !== undefined) {
    if (!Array.isArray(w.tools) || w.tools.some((t) => !isStr(t))) errors.push(`${at}.tools phải là danh sách tên tool`);
    else if (provider === "claude") {
      for (const a of w.allowedTools ?? []) { const base = String(a).replace(/\(.*$/, ""); if (base && !base.startsWith("mcp__") && !w.tools.includes(base)) warns.push(`${at}: allowedTools có "${base}" nhưng tools: không có, nên tool này không được nạp`); }
      if ((w.useSkills ?? []).length && !w.tools.includes("Skill")) warns.push(`${at}: có useSkills (Skill được tự thêm vào tools)`);
    } else warns.push(`${at}: tools không có tác dụng với Codex`);
  }
  if (w?.autonomy !== undefined && ["manual", "auto", "full"].includes(w.autonomy)) errors.push(`${at}.autonomy phải là manual, auto hoặc full`);
  if (w?.autonomy === "full") warns.push(`${at}: autonomy: full trong workers.yaml KHÔNG có hiệu lực (sẽ chạy Auto). Full Access chỉ do người dùng bật trên máy của mình`);
  if (w?.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(w.sandbox)) errors.push(`${at}.sandbox không hợp lệ`);
  for (const k of Object.keys(w ?? {})) if (!known.has(k)) warns.push(`${at}: trường "${k}" không được dùng (bị bỏ qua)`);
  for (const s of strList(w?.useSkills) ? w.useSkills : []) if (!skills.has(s)) errors.push(`${at}.useSkills "${s}" không tồn tại (tìm trong .agentroom/skills, .claude/skills, ~/.claude/skills)`);
  const provider = accounts[w?.account]?.provider;
  const tools = w?.allowedTools ?? [];
  if (provider === "claude" && tools.some((t) => /^(Edit|Write)$/.test(t)) && !w?.worktree) warns.push(`${at}: được Edit/Write toàn repo mà không có worktree`);
  if (provider === "claude" && tools.some((t) => t === "Bash")) warns.push(`${at}: "Bash" không giới hạn — nên dùng Bash(<lệnh>:*)`);
  if (provider === "codex" && w?.allowedTools) warns.push(`${at}: allowedTools không có tác dụng với Codex (dùng sandbox)`);
  if (provider === "codex" && w?.sandbox === "danger-full-access") warns.push(`${at}: sandbox danger-full-access — rủi ro cao`);
  if (provider === "codex" && (w?.useSkills ?? []).length) warns.push(`${at}: Codex không lọc được skill theo worker; skill chỉ được nhắc trong prompt (mức kiểm soát lỏng hơn Claude)`);
  if (w?.workdir !== undefined && !isStr(w.workdir)) errors.push(`${at}.workdir phải là chuỗi`);
  if (w?.color !== undefined && !(isStr(w.color) && /^#[0-9a-fA-F]{6}$/.test(w.color))) errors.push(`${at}.color phải có dạng #rrggbb`);
  const hostName = accounts[w?.account]?.host;
  if (hostName && hosts?.[hostName]) {
    const base = w?.workdir ?? hosts[hostName].repo;
    if (!base) errors.push(`${at}: chạy trên host "${hostName}" nên cần workdir (hoặc hosts.${hostName}.repo)`);
    else if (!remotePath(base)) errors.push(`${at}: đường dẫn trên host phải tuyệt đối hoặc bắt đầu bằng ~ (nhận "${base}")`);
    else {
      const key = `${hostName}:${base}`;
      baseUsers.set(key, [...(baseUsers.get(key) ?? []), { id: w.id, worktree: w.worktree === true, writes: tools.some((t) => /^(Edit|Write)/.test(t)) || provider === "codex" }]);
    }
    if (w?.worktree !== true && (tools.some((t) => /^(Edit|Write)/.test(t)) || provider === "codex")) warns.push(`${at}: ghi code trên host "${hostName}" mà không có worktree — thay đổi nằm thẳng trong clone đó`);
  } else if (isStr(w?.workdir)) {
    const p = w.workdir.startsWith("~") ? join(homedir(), w.workdir.slice(1)) : w.workdir.startsWith("/") || /^[A-Za-z]:/.test(w.workdir) ? w.workdir : join(repo, w.workdir);
    if (!existsSync(p)) warns.push(`${at}.workdir "${w.workdir}" chưa tồn tại trên máy này (${p})`);
  }
  const soul = join(repo, ".agentroom", "agents", w?.id ?? "?", "SOUL.md");
  if (existsSync(soul) && /Viết tính cách, cách làm việc/.test(readFileSync(soul, "utf8"))) warns.push(`${at}: SOUL.md vẫn là bản mẫu chưa viết (.agentroom/agents/${w.id}/SOUL.md)`);
}
for (const [key, users] of baseUsers) {
  const shared = users.filter((u) => !u.worktree && u.writes);
  if (shared.length > 1) warns.push(`Các worker ${shared.map((u) => u.id).join(", ")} cùng ghi vào ${key} mà không có worktree — sẽ ghi đè lên nhau`);
}
if (!workers.some((w) => w?.coordinator)) warns.push("Không có worker coordinator: tin nhắn không @mention sẽ không ai nhận");

// ---- schedules ----
const schedules = cfg.schedules ?? [];
if (!Array.isArray(schedules)) errors.push("schedules: phải là danh sách");
const schedIds = new Set();
for (const [i, s] of (Array.isArray(schedules) ? schedules : []).entries()) {
  const at = `schedules[${i}]${s?.id ? ` (${s.id})` : ""}`;
  if (!ID.test(s?.id ?? "")) errors.push(`${at}.id không hợp lệ`);
  if (schedIds.has(s?.id)) errors.push(`${at}: trùng id`);
  schedIds.add(s?.id);
  if (s?.worker !== "*" && !ids.has(s?.worker)) errors.push(`${at}.worker "${s?.worker}" không tồn tại (dùng "*" cho mọi worker)`);
  if (!isStr(s?.cron)) errors.push(`${at}.cron bắt buộc`);
  else {
    try { new Cron(s.cron, { paused: true, timezone: s.timezone }).nextRun(); }
    catch (e) { errors.push(`${at}: cron/timezone không hợp lệ (${e.message.split("\n")[0]})`); }
  }
  if (!s?.prompt === !s?.builtin) errors.push(`${at}: cần đúng một trong prompt hoặc builtin`);
  if (s?.builtin !== undefined && s.builtin !== "consolidate-memory") errors.push(`${at}.builtin chỉ nhận consolidate-memory`);
  if (s?.session !== undefined && !["fresh", "persistent"].includes(s.session)) errors.push(`${at}.session phải là fresh hoặc persistent`);
  for (const k of ["skipIfRunning", "notify", "enabled"]) if (s?.[k] !== undefined && !isBool(s[k])) errors.push(`${at}.${k} phải là true/false`);
  if (s?.catchUpHours !== undefined && !(typeof s.catchUpHours === "number" && s.catchUpHours >= 0)) errors.push(`${at}.catchUpHours phải là số ≥ 0`);
  if (s?.worker === "*" && !s?.builtin) warns.push(`${at}: prompt chạy cho MỌI worker — tốn quota; cân nhắc chọn một worker`);
}

// ---- limits ----
if (cfg.limits !== undefined) {
  const l = cfg.limits;
  if (!l || typeof l !== "object" || Array.isArray(l)) errors.push("limits: phải là object { chainTurns, usdPerTask }");
  else {
    for (const k of Object.keys(l)) if (!["chainTurns", "usdPerTask"].includes(k)) warns.push(`limits.${k} không được dùng (bị bỏ qua)`);
    if (l.chainTurns !== undefined && !(Number.isInteger(l.chainTurns) && l.chainTurns >= 2 && l.chainTurns <= 100)) errors.push("limits.chainTurns phải là số nguyên từ 2 đến 100");
    if (l.usdPerTask !== undefined && !(typeof l.usdPerTask === "number" && l.usdPerTask > 0)) errors.push("limits.usdPerTask phải là số > 0");
  }
}

// ---- webhooks ----
const webhooks = cfg.webhooks ?? [];
if (!Array.isArray(webhooks)) errors.push("webhooks: phải là danh sách");
const hookIds = new Set();
for (const [i, h] of (Array.isArray(webhooks) ? webhooks : []).entries()) {
  const at = `webhooks[${i}]${h?.id ? ` (${h.id})` : ""}`;
  if (!ID.test(h?.id ?? "")) errors.push(`${at}.id không hợp lệ`);
  if (hookIds.has(h?.id)) errors.push(`${at}: trùng id`);
  hookIds.add(h?.id);
  if (!ids.has(h?.worker)) errors.push(`${at}.worker "${h?.worker}" không tồn tại`);
  if (!isStr(h?.prompt)) errors.push(`${at}.prompt bắt buộc`);
  if (!h?.secretEnv && h?.allowUnsigned !== true) errors.push(`${at}: cần secretEnv (tên biến môi trường chứa HMAC secret) hoặc allowUnsigned: true chỉ để thử trên máy mình`);
  if (h?.secretEnv !== undefined && !isStr(h.secretEnv)) errors.push(`${at}.secretEnv phải là chuỗi`);
  if (h?.secretEnv && /^[A-Za-z0-9+/=_-]{20,}$/.test(h.secretEnv) && !/^[A-Z][A-Z0-9_]*$/.test(h.secretEnv)) errors.push(`${at}.secretEnv trông như một giá trị bí mật; chỉ ghi TÊN biến môi trường`);
  if (h?.match !== undefined && (typeof h.match !== "object" || Array.isArray(h.match))) errors.push(`${at}.match phải là object {đường.dẫn: giá-trị}`);
  if (h?.maxPerHour !== undefined && !(Number.isInteger(h.maxPerHour) && h.maxPerHour >= 1)) errors.push(`${at}.maxPerHour phải là số nguyên ≥ 1`);
  if (h?.allowUnsigned === true) warns.push(`${at}: allowUnsigned — chỉ dùng thử trên máy mình, đừng mở tunnel`);
  if (h?.readOnly !== true) warns.push(`${at}: readOnly chưa bật — dữ liệu từ bên ngoài sẽ chạy trong worker có quyền ghi; nên đặt readOnly: true`);
  const tw = workers.find((w) => w?.id === h?.worker);
  if (tw?.coordinator !== true && h?.readOnly !== true) warns.push(`${at}: gọi worker không phải coordinator với quyền ghi`);
  if (h?.readOnly !== true && tw?.autonomy === "auto") warns.push(`${at}: worker "${tw.id}" chạy Auto và webhook không readOnly: dữ liệu bên ngoài có thể điều khiển nó mà không qua thẻ duyệt`);
}

// ---- file phụ trợ ----
const gi = join(repo, ".agentroom", ".gitignore");
const giText = existsSync(gi) ? readFileSync(gi, "utf8") : "";
if (!/state\//.test(giText) || !/worktrees\//.test(giText)) errors.push(".agentroom/.gitignore phải chứa state/ và worktrees/");
if (!/\.plugin\//.test(giText)) warns.push(".agentroom/.gitignore nên chứa .plugin/ (plugin skills tự sinh)");
if (!/journal/.test(giText)) warns.push(".agentroom/.gitignore nên chứa agents/*/journal/ (nhật ký hằng ngày)");
if (!existsSync(join(repo, "CLAUDE.md")) && workers.some((w) => accounts[w?.account]?.provider === "claude")) warns.push("Thiếu CLAUDE.md");
if (!existsSync(join(repo, "AGENTS.md")) && workers.some((w) => accounts[w?.account]?.provider === "codex")) warns.push("Thiếu AGENTS.md");

warns.forEach((m) => console.log("⚠", m));
errors.forEach((m) => console.log("✗", m));
console.log(errors.length ? `\nKHÔNG ĐẠT: ${errors.length} lỗi, ${warns.length} cảnh báo` : `\nĐẠT (${workers.length} worker, ${Object.keys(hosts).length} máy từ xa, ${schedIds.size} lịch, ${hookIds.size} webhook, ${warns.length} cảnh báo)`);
process.exit(errors.length ? 1 : 0);
```
