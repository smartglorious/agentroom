import { z } from "zod";
import YAML from "yaml";
import { Cron } from "croner";
import { homedir } from "node:os";
import { RoomConfig, SSH_TARGET } from "./types";

const expandHome = (p?: string) => (p?.startsWith("~") ? homedir() + p.slice(1) : p);

const ID = z.string().regex(/^[a-z][a-z0-9_-]*$/, "id: bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 '-' '_'");

const HostSchema = z.object({
  ssh: z.string().regex(SSH_TARGET, "ssh: dạng user@host, host hoặc alias trong ~/.ssh/config (không được bắt đầu bằng '-')"),
  port: z.number().int().min(1).max(65535).optional(),
  identityFile: z.string().min(1).refine((p) => !p.startsWith("-"), "identityFile không hợp lệ").optional(),
  repo: z.string().min(1).optional(),
  node: z.string().min(1).optional(),
  claudePath: z.string().min(1).optional(),
  codexPath: z.string().min(1).optional(),
  connectTimeoutSec: z.number().int().min(1).max(120).default(15),
});

const AccountSchema = z.object({
  host: z.string().optional(),
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
  contextLimit: z.number().int().min(0).optional(),
  instructions: z.string().default(""),
  allowedTools: z.array(z.string()).default(["Read", "Grep", "Glob"]),
  worktree: z.boolean().default(false),
  coordinator: z.boolean().default(false),
  sandbox: z.enum(["read-only", "workspace-write", "danger-full-access"]).default("workspace-write"),
  workdir: z.string().min(1).optional(),
  autonomy: z.enum(["manual", "auto", "full"]).default("manual"),
  tools: z.array(z.string().min(1)).optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "color: dạng #rrggbb").optional(),
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

const LimitsSchema = z.object({
  chainTurns: z.number().int().min(2).max(100).default(6),
  /** Most workers one worker message may wake. */
  maxFanout: z.number().int().min(1).max(20).default(3),
  usdPerTask: z.number().positive().optional(),
});

const FileSchema = z.object({
  limits: LimitsSchema.default(() => ({ chainTurns: 6, maxFanout: 3 })),
  hosts: z.record(ID, HostSchema).default({}),
  accounts: z.record(z.string(), AccountSchema),
  workers: z.array(WorkerSchema).min(1),
  schedules: z.array(ScheduleSchema).default([]),
  webhooks: z.array(WebhookSchema).default([]),
  /** One section per plugin: `ext: { <plugin id>: … }`. Opaque to the core. */
  ext: z.record(z.string(), z.unknown()).default({}),
});

function unique(kind: string, ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) throw new Error(`Trùng ${kind} id: ${id}`);
    seen.add(id);
  }
}

/** Distinguishable on both light and dark themes. */
export const PALETTE = ["#4f8cff", "#e5703a", "#3fb97f", "#c261e6", "#e0b43a", "#ee5d8f", "#2fb8c4", "#8f7cf0", "#a3c93a", "#d9534f"];

export function validCron(expr: string, timezone?: string): string | undefined {
  try {
    // croner only rejects a bad timezone when it computes a run time, so do that here too.
    new Cron(expr, { paused: true, timezone }).nextRun();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

const isRemotePath = (p: string) => p === "~" || p.startsWith("~/") || p.startsWith("/");

export function parseConfig(text: string): RoomConfig {
  const raw = FileSchema.parse(YAML.parse(text));
  const hosts = Object.entries(raw.hosts).map(([name, h]) => ({ name, ...h }));
  if (hosts.some((h) => h.name === "local")) throw new Error('Tên host "local" là tên dành riêng');
  const hostNames = new Set(hosts.map((h) => h.name));
  // `home` is a path on the account's own machine, so only expand ~ for local accounts.
  const accounts = Object.entries(raw.accounts).map(([id, a]) => ({ id, ...a, home: a.host ? a.home : expandHome(a.home) }));
  for (const a of accounts) if (a.host && !hostNames.has(a.host)) throw new Error(`Account ${a.id}: không có host "${a.host}" trong hosts:`);
  unique("worker", raw.workers.map((w) => w.id));
  // Unset colours take the palette in order, skipping ones another worker chose explicitly.
  const chosen = new Set(raw.workers.flatMap((w) => (w.color ? [w.color.toLowerCase()] : [])));
  const free = PALETTE.filter((c) => !chosen.has(c));
  const pool = free.length ? free : PALETTE;
  let nextColor = 0;
  const workers = raw.workers.map((w) => {
    const acc = accounts.find((a) => a.id === w.account);
    if (!acc) throw new Error(`Worker ${w.id}: không có account "${w.account}"`);
    if (acc.host) {
      const base = w.workdir ?? hosts.find((h) => h.name === acc.host)!.repo;
      if (!base) throw new Error(`Worker ${w.id}: chạy trên host "${acc.host}" nên cần workdir (hoặc hosts.${acc.host}.repo)`);
      if (!isRemotePath(base)) throw new Error(`Worker ${w.id}: đường dẫn trên host phải tuyệt đối hoặc bắt đầu bằng ~ (nhận "${base}")`);
    }
    return { ...w, provider: acc.provider, color: w.color ?? pool[nextColor++ % pool.length] };
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
  return { hosts, accounts, workers, schedules: raw.schedules, webhooks: raw.webhooks, limits: raw.limits, ext: raw.ext };
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
    tools: [Read, Grep, Glob]        # chỉ nạp các tool này: mỗi tool nạp tốn token ở MỌI lượt
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

# Chạy worker trên máy khác qua SSH (cần khoá SSH/ssh-agent, Node ≥ 20 và claude/codex đã đăng nhập trên máy đó).
# Mỗi account là một đăng nhập trên MỘT máy: thêm host: vào account để worker dùng account đó chạy ở máy kia.
# hosts:
#   gpu-box:
#     ssh: dev@gpu-box.example.com   # hoặc alias trong ~/.ssh/config
#     repo: /home/dev/app            # clone của repo trên máy đó (worker có thể đặt workdir riêng)
#     # node: /usr/local/bin/node    # nếu node không có trong PATH của login shell
# accounts:
#   claude-gpu: { provider: claude, host: gpu-box, maxConcurrent: 2 }

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
