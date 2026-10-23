# AgentRoom

Group chat cho một "đội" AI trong VS Code. Mỗi worker là một persona (vai trò, kỹ năng, hướng dẫn) chạy trên Claude Code hoặc Codex. Nhiều worker dùng chung một account.

Thiết kế và kế hoạch: [docs/DESIGN.md](docs/DESIGN.md).

## Yêu cầu

- VS Code ≥ 1.90, Node ≥ 20
- Đã đăng nhập Claude Code (`claude` → `/login`) và/hoặc Codex (`codex login`), hoặc có API key

## Chạy thử

```bash
npm install
npm run build        # dist/extension.js
npm test             # 10 test: router, scheduler, task board, room, MCP
```

Mở thư mục này trong VS Code → F5 (Run Extension). Trong cửa sổ mới:

1. Mở một project → `Ctrl+Shift+P` → **AgentRoom: Tạo cấu hình workers mẫu**
2. Sửa `.agentroom/workers.yaml` (account, worker, model)
3. Mở biểu tượng AgentRoom ở activity bar → nhắn tin. Không @mention thì coordinator (`lead`) nhận; `@be`, `@qa`, `@all` để gọi trực tiếp.

## Cấu hình

```yaml
accounts:
  claude-main: { provider: claude, maxConcurrent: 2 }        # home: ~/.claude-team → CLAUDE_CONFIG_DIR
  codex-main:  { provider: codex,  maxConcurrent: 1 }        # home: ~/.codex → CODEX_HOME; apiKeyEnv: MY_OPENAI_KEY
workers:
  - id: be
    name: Minh
    role: Backend Developer
    account: claude-main
    worktree: true                     # git worktree riêng: .agentroom/worktrees/be
    skills: [Node.js, SQL]
    allowedTools: [Read, Grep, Glob, Edit, Write]   # tool khác phải được duyệt trên UI
    instructions: Viết code kèm test.
```

Trạng thái lưu ở `.agentroom/state/`: `chat.jsonl`, `tasks.json`, `sessions.json`.

## Tool agent dùng để phối hợp (MCP `agentroom`)

`post_message`, `read_channel`, `list_tasks`, `create_task`, `claim_task`, `complete_task`
