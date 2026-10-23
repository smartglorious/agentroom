import { z } from "zod";
import YAML from "yaml";
import { homedir } from "node:os";
import { RoomConfig } from "./types";

const expandHome = (p?: string) => (p?.startsWith("~") ? homedir() + p.slice(1) : p);

const AccountSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  home: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  maxConcurrent: z.number().int().min(1).default(1),
});

const WorkerSchema = z.object({
  id: z.string()
    .regex(/^[a-z][a-z0-9_-]*$/, "id: bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 '-' '_'")
    .refine((id) => !["all", "user", "system"].includes(id), "id: all/user/system là tên dành riêng"),
  name: z.string(),
  role: z.string(),
  skills: z.array(z.string()).default([]),
  account: z.string(),
  model: z.string().optional(),
  instructions: z.string().default(""),
  allowedTools: z.array(z.string()).default(["Read", "Grep", "Glob"]),
  worktree: z.boolean().default(false),
  coordinator: z.boolean().default(false),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
});

const FileSchema = z.object({
  accounts: z.record(z.string(), AccountSchema),
  workers: z.array(WorkerSchema).min(1),
});

export function parseConfig(text: string): RoomConfig {
  const raw = FileSchema.parse(YAML.parse(text));
  const accounts = Object.entries(raw.accounts).map(([id, a]) => ({ id, ...a, home: expandHome(a.home) }));
  const seen = new Set<string>();
  const workers = raw.workers.map((w) => {
    if (seen.has(w.id)) throw new Error(`Trùng worker id: ${w.id}`);
    seen.add(w.id);
    const acc = accounts.find((a) => a.id === w.account);
    if (!acc) throw new Error(`Worker ${w.id}: không có account "${w.account}"`);
    return { ...w, provider: acc.provider };
  });
  return { accounts, workers };
}

export const SAMPLE_CONFIG = `# AgentRoom — định nghĩa account dùng chung và các worker (persona).
# Một account có thể phục vụ nhiều worker; maxConcurrent giới hạn số lượt chạy song song.
accounts:
  claude-main:
    provider: claude
    # home: ~/.claude          # CLAUDE_CONFIG_DIR của login dùng chung (bỏ trống = mặc định)
    maxConcurrent: 2
  codex-main:
    provider: codex
    # home: ~/.codex           # CODEX_HOME
    maxConcurrent: 1

workers:
  - id: lead
    name: Lan
    role: Tech Lead
    account: claude-main
    coordinator: true
    skills: [phân tích yêu cầu, chia task, review]
    allowedTools: [Read, Grep, Glob]
    instructions: |
      Bạn không tự viết code. Hãy chia việc thành task (create_task) và giao cho
      đúng người bằng @mention. Khi mọi task xong, tổng kết cho người dùng.

  - id: be
    name: Minh
    role: Backend Developer
    account: claude-main
    worktree: true
    skills: [Node.js, SQL, REST API]
    allowedTools: [Read, Grep, Glob, Edit, Write]
    instructions: |
      Viết code backend kèm test. Xong việc thì complete_task và báo @qa.

  - id: fe
    name: Hoa
    role: Frontend Developer
    account: codex-main
    worktree: true
    skills: [React, CSS, accessibility]
    sandbox: workspace-write

  - id: qa
    name: Tuấn
    role: QA Engineer
    account: claude-main
    skills: [viết test, tìm bug, review]
    allowedTools: [Read, Grep, Glob, "Bash(npm test:*)", "Bash(git diff:*)"]
    instructions: |
      Chạy test, đọc diff và báo lỗi cụ thể (file:dòng) cho người phụ trách.
`;
