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

## Kiến thức nền về AgentRoom v0.1 (để cấu hình đúng)

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
- Agent phối hợp qua các tool MCP `agentroom`: `post_message`, `read_channel`, `list_tasks`, `create_task`, `claim_task`, `complete_task`.

---

## Bước 0: Thu thập yêu cầu

🛑 **HỎI NGƯỜI DÙNG** (gộp vào một tin nhắn):

1. Bạn dùng được những gì: **Claude Code** (gói Pro/Max hay API key?), **Codex CLI** (ChatGPT login hay API key?)
2. Muốn bắt đầu với bao nhiêu worker? (Khuyến nghị cho tuần đầu: 3 là lead, một dev, qa.)
3. Có vai trò bắt buộc nào không? (ví dụ "cần 1 dev mobile", "cần reviewer bảo mật")
4. Nhánh chính tên gì? (`main` / `develop` / …)
5. Có cho phép copy file `.env` vào worktree của agent không? (Mặc định: **không**)
6. Model mong muốn cho từng loại vai trò? (Bỏ trống thì dùng model mặc định của CLI.)

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

### 4.3 Bảng `allowedTools` theo vai trò (Claude)

| Vai trò | allowedTools |
|---|---|
| lead | `[Read, Grep, Glob]` |
| dev vùng X | `[Read, Grep, Glob, "Edit(X/**)", "Write(X/**)", "Bash(<lệnh test vùng X>:*)", "Bash(<lệnh lint>:*)", "Bash(<lệnh cài dependency>)", "Bash(git status:*)", "Bash(git diff:*)", "Bash(git add:*)", "Bash(git commit:*)"]` |
| qa | `[Read, Grep, Glob, "Bash(<lệnh test>:*)", "Bash(git diff:*)", "Bash(git log:*)"]` |

**Không bao giờ** đưa vào: `Bash` (không giới hạn), `Bash(git push:*)`, `Bash(rm:*)`, hoặc `Edit` / `Write` không kèm đường dẫn.

🛑 **HỎI NGƯỜI DÙNG:** trình bảng phân công dự kiến (worker, vai trò, vùng, provider, model) và chờ đồng ý trước khi viết YAML.

---

## Bước 5: Viết `.agentroom/workers.yaml`

### 5.1 Schema chính xác (v0.1)

**`accounts.<account-id>`**

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `provider` | ✔ | `claude` \| `codex` | | |
| `home` | | chuỗi | login mặc định | `~` được mở rộng |
| `apiKeyEnv` | | chuỗi | | tên biến môi trường chứa key |
| `maxConcurrent` | | số nguyên ≥ 1 | `1` | |

**`workers[]`**

| Trường | Bắt buộc | Kiểu | Mặc định | Ghi chú |
|---|---|---|---|---|
| `id` | ✔ | `^[a-z][a-z0-9_-]*$` | | duy nhất; không phải `all`/`user`/`system` |
| `name` | ✔ | chuỗi | | tên hiển thị (có thể có dấu) |
| `role` | ✔ | chuỗi | | |
| `account` | ✔ | chuỗi | | phải có trong `accounts` |
| `skills` | | danh sách chuỗi | `[]` | |
| `model` | | chuỗi | mặc định của CLI | |
| `instructions` | | chuỗi (dùng `\|` cho nhiều dòng) | `""` | |
| `allowedTools` | | danh sách chuỗi | `[Read, Grep, Glob]` | chỉ Claude |
| `worktree` | | bool | `false` | `true` cho mọi dev sửa code |
| `coordinator` | | bool | `false` | ít nhất một worker nên là `true` |
| `sandbox` | | `read-only` \| `workspace-write` \| `danger-full-access` | `workspace-write` | chỉ Codex |

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

### 5.3 Viết `instructions` tốt

Mỗi worker cần có:
1. Vùng của mình (đường dẫn).
2. Việc cần làm lần đầu (cài dependency).
3. Điều kiện để được coi là "xong" (test nào phải pass).
4. Phải báo cho ai khi nào.

Không lặp lại nội dung đã có trong `CLAUDE.md`. Giữ dưới 15 dòng.

---

## Bước 6: `.gitignore`

Tạo `.agentroom/.gitignore` với nội dung:

```
state/
worktrees/
survey.md
```

Nếu `.gitignore` ở thư mục gốc đang ignore toàn bộ `.agentroom`, hãy báo người dùng. `workers.yaml` **nên** được commit để cả team dùng chung.

**Kiểm tra:** `git check-ignore -v .agentroom/worktrees/x .agentroom/state/x` in ra 2 dòng, và `git check-ignore .agentroom/workers.yaml` không in gì.

---

## Bước 7 (tùy chọn): Tạo sẵn worktree

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
(cd "$CHECK_DIR" && npm init -y >/dev/null && npm i --silent yaml)
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
- [ ] Không có giá trị bí mật trong YAML, CLAUDE.md hay AGENTS.md (`grep -nEi "sk-|api[_-]?key\s*[:=]\s*\S{12,}|password" CLAUDE.md AGENTS.md .agentroom/workers.yaml` không ra kết quả đáng ngờ).

---

## Bước 9: Bàn giao

Gửi người dùng báo cáo gồm:

1. **File đã tạo hoặc sửa** (danh sách đường dẫn), kèm diff ngắn nếu có sửa file cũ.
2. **Bảng đội:** id, tên, vai trò, vùng, provider, model.
3. **Kết quả kiểm tra** ở Bước 8 và các cảnh báo được giữ lại.
4. **Việc người dùng cần tự làm:**
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
| Codex sửa file ngoài vùng | Codex không có thẻ duyệt | Nhắc vùng trong `instructions`; dùng `sandbox: read-only` cho vai trò chỉ đọc |

---

## Phụ lục A: `validate-agentroom.mjs`

```js
// Kiểm tra .agentroom/workers.yaml theo đúng luật của AgentRoom v0.1.
// Cách chạy: node validate-agentroom.mjs <đường-dẫn-repo>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const YAML = require("yaml");

const repo = process.argv[2] ?? ".";
const file = join(repo, ".agentroom", "workers.yaml");
const errors = [], warns = [];
if (!existsSync(file)) { console.error(`✗ Không có ${file}`); process.exit(1); }
const cfg = YAML.parse(readFileSync(file, "utf8")) ?? {};

const accounts = cfg.accounts ?? {};
if (typeof accounts !== "object" || !Object.keys(accounts).length) errors.push("accounts: phải có ít nhất 1 account");
for (const [id, a] of Object.entries(accounts)) {
  if (!["claude", "codex"].includes(a?.provider)) errors.push(`accounts.${id}.provider phải là claude hoặc codex`);
  if (a?.maxConcurrent !== undefined && !(Number.isInteger(a.maxConcurrent) && a.maxConcurrent >= 1)) errors.push(`accounts.${id}.maxConcurrent phải là số nguyên ≥ 1`);
  if (a?.provider === "claude" && (a?.maxConcurrent ?? 1) > 3) warns.push(`accounts.${id}: maxConcurrent > 3 dễ hết quota subscription`);
}

const workers = Array.isArray(cfg.workers) ? cfg.workers : [];
if (!workers.length) errors.push("workers: phải có ít nhất 1 worker");
const ids = new Set();
const known = new Set(["id", "name", "role", "skills", "account", "model", "instructions", "allowedTools", "worktree", "coordinator", "sandbox"]);
for (const [i, w] of workers.entries()) {
  const at = `workers[${i}]${w?.id ? ` (${w.id})` : ""}`;
  if (!/^[a-z][a-z0-9_-]*$/.test(w?.id ?? "")) errors.push(`${at}.id phải bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 _ -`);
  if (ids.has(w?.id)) errors.push(`${at}: trùng id`);
  ids.add(w?.id);
  if (w?.id === "all" || w?.id === "user" || w?.id === "system") errors.push(`${at}.id "${w.id}" là tên dành riêng`);
  for (const k of ["name", "role", "account"]) if (typeof w?.[k] !== "string" || !w[k]) errors.push(`${at}.${k} bắt buộc (chuỗi)`);
  if (w?.account && !accounts[w.account]) errors.push(`${at}.account "${w.account}" không có trong accounts`);
  for (const k of ["skills", "allowedTools"]) if (w?.[k] !== undefined && !(Array.isArray(w[k]) && w[k].every((s) => typeof s === "string"))) errors.push(`${at}.${k} phải là danh sách chuỗi`);
  for (const k of ["worktree", "coordinator"]) if (w?.[k] !== undefined && typeof w[k] !== "boolean") errors.push(`${at}.${k} phải là true/false`);
  if (w?.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(w.sandbox)) errors.push(`${at}.sandbox không hợp lệ`);
  for (const k of Object.keys(w ?? {})) if (!known.has(k)) warns.push(`${at}: trường "${k}" không được dùng (bị bỏ qua)`);
  const provider = accounts[w?.account]?.provider;
  const tools = w?.allowedTools ?? [];
  if (provider === "claude" && tools.some((t) => /^(Edit|Write)$/.test(t)) && !w?.worktree) warns.push(`${at}: được Edit/Write toàn repo mà không có worktree`);
  if (provider === "claude" && tools.some((t) => t === "Bash")) warns.push(`${at}: "Bash" không giới hạn — nên dùng Bash(<lệnh>:*)`);
  if (provider === "codex" && w?.allowedTools) warns.push(`${at}: allowedTools không có tác dụng với Codex (dùng sandbox)`);
  if (provider === "codex" && w?.sandbox === "danger-full-access") warns.push(`${at}: sandbox danger-full-access — rủi ro cao`);
}
if (!workers.some((w) => w?.coordinator)) warns.push("Không có worker coordinator: tin nhắn không @mention sẽ không ai nhận");

const gi = join(repo, ".agentroom", ".gitignore");
if (!existsSync(gi) || !/worktrees/.test(readFileSync(gi, "utf8")) || !/state/.test(readFileSync(gi, "utf8"))) errors.push(".agentroom/.gitignore phải chứa state/ và worktrees/");
if (!existsSync(join(repo, "CLAUDE.md")) && workers.some((w) => accounts[w?.account]?.provider === "claude")) warns.push("Thiếu CLAUDE.md");
if (!existsSync(join(repo, "AGENTS.md")) && workers.some((w) => accounts[w?.account]?.provider === "codex")) warns.push("Thiếu AGENTS.md");

warns.forEach((m) => console.log("⚠", m));
errors.forEach((m) => console.log("✗", m));
console.log(errors.length ? `\nKHÔNG ĐẠT: ${errors.length} lỗi, ${warns.length} cảnh báo` : `\nĐẠT (${workers.length} worker, ${warns.length} cảnh báo)`);
process.exit(errors.length ? 1 : 0);
```
