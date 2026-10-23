import { z } from "zod";
import YAML from "yaml";
import { Cron } from "croner";
import { homedir } from "node:os";
import { RoomConfig } from "./types";

const expandHome = (p?: string) => (p?.startsWith("~") ? homedir() + p.slice(1) : p);

const ID = z.string().regex(/^[a-z][a-z0-9_-]*$/, "id: bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 '-' '_'");

const AccountSchema = z.object({
  provider: z.enum(["claude", "codex"]),
  home: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  maxConcurrent: z.number().int().min(1).default(1),
  budgetUsdPerDay: z.number().positive().optional(),
  warnAtPercent: z.number().min(1).max(100).default(80),
});

const WorkerSchema = z.object({
  id: ID.refine((id) => !["all", "user", "system"].includes(id), "id: all/user/system là tên dành riêng"),
  name: z.string(),
  role: z.string(),
  skills: z.array(z.string()).default([]),
  useSkills: z.array(z.string()).default([]),
  account: z.string(),
  model: z.string().optional(),
  instructions: z.string().default(""),
  allowedTools: z.array(z.string()).default(["Read", "Grep", "Glob"]),
  worktree: z.boolean().default(false),
  coordinator: z.boolean().default(false),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
});

const ScheduleSchema = z.object({
  id: ID,
  worker: z.string(),
  cron: z.string(),
  timezone: z.string().optional(),
  prompt: z.string().optional(),
  builtin: z.enum(["consolidate-memory"]).optional(),
  session: z.enum(["fresh", "persistent"]).default("fresh"),
  skipIfRunning: z.boolean().default(true),
  catchUpHours: z.number().min(0).default(6),
  notify: z.boolean().default(false),
  enabled: z.boolean().default(true),
});

const WebhookSchema = z.object({
  id: ID,
  worker: z.string(),
  secretEnv: z.string().optional(),
  allowUnsigned: z.boolean().default(false),
  match: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  prompt: z.string(),
  maxPerHour: z.number().int().min(1).default(6),
  readOnly: z.boolean().default(false),
});

const FileSchema = z.object({
  accounts: z.record(z.string(), AccountSchema),
  workers: z.array(WorkerSchema).min(1),
  schedules: z.array(ScheduleSchema).default([]),
  webhooks: z.array(WebhookSchema).default([]),
});

function unique(kind: string, ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Trùng ${kind} id: ${id}`);
    seen.add(id);
  }
}

export function validCron(expr: string, timezone?: string): string | undefined {
  try {
    // croner only rejects a bad timezone when it computes a run time, so do that here too.
    new Cron(expr, { paused: true, timezone }).nextRun();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

export function parseConfig(text: string): RoomConfig {
  const raw = FileSchema.parse(YAML.parse(text));
  const accounts = Object.entries(raw.accounts).map(([id, a]) => ({ id, ...a, home: expandHome(a.home) }));
  unique("worker", raw.workers.map((w) => w.id));
  const workers = raw.workers.map((w) => {
    const acc = accounts.find((a) => a.id === w.account);
    if (!acc) throw new Error(`Worker ${w.id}: không có account "${w.account}"`);
    return { ...w, provider: acc.provider };
  });
  const known = new Set(workers.map((w) => w.id));

  unique("schedule", raw.schedules.map((s) => s.id));
  for (const s of raw.schedules) {
    if (s.worker !== "*" && !known.has(s.worker)) throw new Error(`Schedule ${s.id}: không có worker "${s.worker}"`);
    if (!s.prompt === !s.builtin) throw new Error(`Schedule ${s.id}: cần đúng một trong prompt hoặc builtin`);
    const bad = validCron(s.cron, s.timezone);
    if (bad) throw new Error(`Schedule ${s.id}: cron không hợp lệ (${bad})`);
  }

  unique("webhook", raw.webhooks.map((h) => h.id));
  for (const h of raw.webhooks) {
    if (!known.has(h.worker)) throw new Error(`Webhook ${h.id}: không có worker "${h.worker}"`);
    if (!h.secretEnv && !h.allowUnsigned) throw new Error(`Webhook ${h.id}: cần secretEnv (hoặc allowUnsigned: true chỉ để thử trên máy mình)`);
  }
  return { accounts, workers, schedules: raw.schedules, webhooks: raw.webhooks };
}

export const SAMPLE_CONFIG = `# AgentRoom — định nghĩa account dùng chung và các worker (persona).
# Một account có thể phục vụ nhiều worker; maxConcurrent giới hạn số lượt chạy song song.
accounts:
  claude-main:
    provider: claude
    # home: ~/.claude          # CLAUDE_CONFIG_DIR của login dùng chung (bỏ trống = mặc định)
    maxConcurrent: 2
    # budgetUsdPerDay: 20      # tạm dừng account khi chi phí trong ngày chạm mức này
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
    # useSkills: [ten-skill]   # skill thật trong .agentroom/skills/<ten-skill>/SKILL.md
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

# Việc chạy theo lịch (chỉ chạy khi VS Code đang mở). Bỏ dấu # để bật.
# schedules:
#   - id: nightly-tests
#     worker: qa
#     cron: "0 2 * * 1-5"
#     timezone: Asia/Ho_Chi_Minh
#     prompt: Chạy toàn bộ test. Nếu fail, tạo task cho đúng người phụ trách vùng.
#   - id: memory-gc
#     worker: "*"
#     cron: "0 3 * * *"
#     builtin: consolidate-memory

# Webhook (mặc định chỉ nhận trên 127.0.0.1; cần secretEnv = tên biến môi trường chứa HMAC secret).
# webhooks:
#   - id: ci-failed
#     worker: lead
#     secretEnv: AGENTROOM_HOOK_SECRET
#     match: { "workflow_run.conclusion": "failure" }
#     prompt: "CI fail ở nhánh {{workflow_run.head_branch}} ({{workflow_run.html_url}}). Tìm nguyên nhân và giao task sửa."
#     readOnly: true
`;
