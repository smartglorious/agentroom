import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { AgentAdapter, ApprovalResult } from "../adapters/types";
import { TurnInspector, TurnRecord, newTurnId, sectionInfo } from "./inspector";
import { CONSOLIDATE_PROMPT, MemoryEntry, MemoryStore, redactSecrets, ymd } from "./memory";
import { buildPersona, buildTurn } from "./prompt";
import { route } from "./router";
import { isRateLimit, Scheduler } from "./scheduler";
import { REMOTE_SKILLS, SkillDraft, SkillDrafts, SkillRegistry, buildPlugin, claudeSkillOptions, codexSkillDirs, codexSkillsBlock } from "./skills";
import { Autonomy, PolicyContext, absolutePath, decide, describeCall, toolPaths } from "./autonomy";
import { PlanMonitor, PlanProbe } from "./plan";
import { RoomStore } from "./store";
import { TaskBoard } from "./tasks";
import { ApprovalRequest, ChatMessage, HUMAN, Provider, RoomConfig, SYSTEM, Task, TurnUsage, Worker, WorkerStatus } from "./types";
import { nextMidnight, UsageStore } from "./usage";

export interface RoomOptions {
  maxAgentHops: number;
  contextMessages: number;
  /** Characters of memory (SOUL + MEMORY + journal) put in each persona prompt. */
  memoryBudgetChars: number;
}

export interface RoomDeps {
  config: RoomConfig;
  store: RoomStore;
  adapters: Record<Provider, AgentAdapter>;
  /** Runs turns for accounts that live on another machine (see `hosts`). */
  remote?: AgentAdapter;
  scheduler: Scheduler;
  options: RoomOptions;
  memory: MemoryStore;
  skills: SkillRegistry;
  skillDrafts: SkillDrafts;
  /** Where the generated Claude plugin with the enabled skills lives. */
  pluginDir: string;
  usage: UsageStore;
  inspector: TurnInspector;
  /** Working directory for a worker (its git worktree, or the workspace root). */
  resolveCwd(w: Worker): Promise<string>;
  mcpUrl(workerId: string): string;
  now?: () => number;
  /** Reads an account's subscription-plan usage; turns on the plan monitor. */
  planProbe?: PlanProbe;
  /** ms between background plan checks (0 = only on demand and after turns). */
  planPollMs?: () => number;
  /** Where the user's per-worker autonomy choices live (machine-level, never in the repo). */
  autonomyStore?: { get(workerId: string): Autonomy | undefined; set(workerId: string, mode: Autonomy): void };
  /** Home folder on this machine, for judging `~/…` paths of local workers. */
  home?: string;
}

export interface RoomEvents {
  message: [ChatMessage];
  status: [WorkerStatus];
  approval: [ApprovalRequest];
  approvalResolved: [string];
  tasks: [Task[]];
  usage: [];
  plan: [];
  autonomy: [];
  drafts: [SkillDraft[]];
}

export interface PostOptions {
  taskId?: string;
  depth?: number;
  turnId?: string;
  readOnly?: boolean;
  /** Explicit recipients; skips @mention routing. Used for triggers whose text embeds untrusted data. */
  to?: string[];
  source?: string;
  alert?: boolean;
}

export interface WorkerProfile {
  id: string;
  soulPath: string;
  memoryPath: string;
  journalPath: string;
  teamMemoryPath: string;
  recentMemory: MemoryEntry[];
  skills: { name: string; description?: string; ok: boolean }[];
}

interface RunningTurn {
  abort: AbortController;
  depth: number;
  readOnly: boolean;
}

/**
 * The orchestrator. Every message goes through `post`: it is stored, routed to
 * recipients, and each recipient gets a turn on its session for that thread
 * ("<worker>:main" or "<worker>:<taskId>"). Messages arriving while a session is
 * busy pile up in its inbox and are answered together in the next turn.
 */
export class Room extends EventEmitter<RoomEvents> {
  readonly tasks: TaskBoard;
  get memory() { return this.deps.memory; }
  private messages: ChatMessage[];
  private sessions: Record<string, string>;
  private sessionMeta: Record<string, { persona: string; mem: string }>;
  private cursors: Record<string, number>;
  private inbox = new Map<string, ChatMessage[]>();
  private scheduled = new Set<string>();
  private running = new Map<string, RunningTurn>();
  private approvals = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void; key: string }>();
  private statuses = new Map<string, WorkerStatus>();
  private budgetPaused = new Set<string>();
  private budgetNotes = new Set<string>();

  constructor(private deps: RoomDeps) {
    super();
    this.messages = deps.store.loadMessages();
    this.tasks = new TaskBoard(deps.store.loadTasks());
    this.sessions = deps.store.loadSessions();
    this.sessionMeta = deps.store.loadSessionMeta();
    this.cursors = deps.store.loadCursors();
    for (const a of deps.config.accounts) deps.scheduler.setLimit(a.id, a.maxConcurrent);
    for (const w of deps.config.workers) {
      this.statuses.set(w.id, { id: w.id, state: "idle" });
      deps.memory.ensureWorker(w);
    }
    this.rebuildSkills();
    for (const w of deps.config.workers) {
      const stored = deps.autonomyStore?.get(w.id);
      // `full` written in workers.yaml is only a request: a repository cannot grant itself full access.
      this.modes.set(w.id, stored ?? (w.autonomy === "full" ? "auto" : w.autonomy));
      if (w.autonomy === "full" && stored !== "full") this.post(SYSTEM, `⚠️ workers.yaml đặt autonomy: full cho ${w.name} (${w.id}) nhưng Full Access chỉ do người dùng bật trên máy của mình (nút ở thẻ worker). Đang chạy ở chế độ Auto.`, { alert: true });
    }
    for (const a of deps.config.accounts) this.checkBudget(a.id, false);
    if (deps.planProbe) {
      this.plan = new PlanMonitor({
        accounts: deps.config.accounts,
        probe: deps.planProbe,
        now: deps.now,
        pollMs: deps.planPollMs ?? (() => 0),
        alert: (text) => this.post(SYSTEM, text, { alert: true }),
        pause: (id, until) => this.deps.scheduler.pauseUntil(id, until),
      });
      this.plan.on("change", () => this.emit("plan"));
    }
  }

  /** Subscription-plan usage per account (undefined when no probe was given). */
  readonly plan?: PlanMonitor;
  private modes = new Map<string, Autonomy>();
  /** Absolute paths each worker has created or edited this session (see PolicyContext.written). */
  private written = new Map<string, Set<string>>();

  /** The user's stored choice (read live, so a CLI change applies at the next call) over the default taken from workers.yaml. */
  autonomyOf(workerId: string): Autonomy { return this.deps.autonomyStore?.get(workerId) ?? this.modes.get(workerId) ?? "manual"; }

  /** The caller (UI, Telegram, CLI) is responsible for confirming `full` with the user first. */
  setAutonomy(workerId: string, mode: Autonomy, by = "người dùng") {
    const w = this.workers.find((x) => x.id === workerId);
    if (!w) throw new Error(`Không có worker "${workerId}"`);
    const was = this.autonomyOf(workerId);
    if (was === mode) return;
    this.modes.set(workerId, mode);
    this.deps.autonomyStore?.set(workerId, mode);
    this.deps.store.appendAudit({ ts: this.now(), worker: workerId, event: "mode", from: was, to: mode, by });
    const label = { manual: "Manual (hỏi mọi thao tác)", auto: "Auto (tự duyệt việc an toàn trong thư mục của worker)", full: "FULL ACCESS (không hỏi gì, trừ vài hành động có thể phá máy)" }[mode];
    this.post(SYSTEM, `${mode === "full" ? "⚡" : "🛡"} ${w.name} (${workerId}): chế độ ${was} → ${mode}. ${label}. Đổi bởi ${by}.`, { alert: true });
    this.emit("autonomy");
    this.emit("status", this.statuses.get(workerId) ?? { id: workerId, state: "idle" });
  }

  get workers() { return this.deps.config.workers; }
  hasWorker(id: string) { return this.workers.some((w) => w.id === id); }
  private now() { return this.deps.now?.() ?? Date.now(); }

  snapshot() {
    return {
      workers: this.workers.map(({ id, name, role, skills, useSkills, provider, coordinator, account, color }) => ({
        id, name, role, skills, useSkills, provider, coordinator, account, color, autonomy: this.autonomyOf(id), host: this.deps.config.accounts.find((a) => a.id === account)?.host,
      })),
      messages: this.messages.slice(-200),
      statuses: [...this.statuses.values()],
      tasks: this.tasks.list(),
      approvals: [...this.approvals.values()].map((a) => a.req),
      drafts: this.deps.skillDrafts.list(),
      plans: this.plan?.list() ?? [],
      accounts: this.deps.config.accounts.map((a) => ({
        id: a.id,
        provider: a.provider,
        host: a.host,
        budgetUsdPerDay: a.budgetUsdPerDay,
        warnAtPercent: a.warnAtPercent,
        spentToday: this.deps.usage.costToday(a.id),
        paused: this.budgetPaused.has(a.id),
      })),
      todayByWorker: this.deps.usage.todayByWorker(),
    };
  }

  profile(workerId: string): WorkerProfile | undefined {
    const w = this.workers.find((x) => x.id === workerId);
    if (!w) return undefined;
    const m = this.deps.memory;
    return {
      id: w.id,
      soulPath: m.soulFile(w.id),
      memoryPath: m.memoryFile("me", w.id),
      journalPath: m.journalFile(w.id),
      teamMemoryPath: m.memoryFile("team", w.id),
      recentMemory: m.entries("me", w.id).slice(-5).reverse(),
      skills: w.useSkills.map((n) => ({ name: n, description: this.deps.skills.get(n)?.description, ok: !!this.deps.skills.get(n) })),
    };
  }

  /** Posts a message from the human, a worker, or the system and dispatches it. */
  post(from: string, text: string, opts: PostOptions = {}): ChatMessage {
    const depth = opts.depth ?? (from === HUMAN ? 0 : this.runningDepth(from) + 1);
    // Anything an untrusted-trigger turn says stays read-only down the whole chain.
    const readOnly = opts.readOnly ?? (this.isReadOnlyRunning(from) || undefined);
    // A read-only chain started by an untrusted trigger never wakes anyone through @mentions: the text
    // may quote attacker-controlled data, so a human decides who continues. Explicit `to` (the trigger
    // itself) is the only way in.
    const to = opts.to ? opts.to.filter((id) => this.hasWorker(id)) : readOnly ? [] : route({ from, text, depth }, this.workers, this.deps.options);
    const msg: ChatMessage = { id: randomUUID(), ts: this.now(), from, text, to, depth, taskId: opts.taskId, turnId: opts.turnId, readOnly: readOnly || undefined, source: opts.source, alert: opts.alert || undefined };
    this.messages.push(msg);
    this.deps.store.appendMessage(msg);
    this.emit("message", msg);
    for (const id of to) this.deliver(id, msg);
    return msg;
  }

  transcript(limit: number): string {
    return this.messages.slice(-limit).map((m) => `${m.from === HUMAN ? "@user" : m.from === SYSTEM ? "[system]" : "@" + m.from}: ${m.text}`).join("\n");
  }

  createTask(me: string, args: { title: string; description?: string; assignee?: string; dependsOn?: string[] }): Task {
    if (args.assignee && !this.hasWorker(args.assignee)) throw new Error(`Không có worker "${args.assignee}"`);
    const t = this.tasks.create({ ...args, createdBy: me });
    this.saveTasks();
    if (t.assignee && t.status === "todo" && t.assignee !== me) this.notifyAssignee(t, this.isReadOnlyRunning(me));
    return t;
  }

  claimTask(me: string, id: string): Task {
    const t = this.tasks.claim(id, me);
    this.saveTasks();
    return t;
  }

  completeTask(me: string, id: string, result: string) {
    const change = this.tasks.complete(id, me, result);
    this.saveTasks();
    const t = change.task;
    const ro = this.isReadOnlyRunning(me);
    // No "@" in front of the finisher: it must not be woken by its own report.
    if (t.createdBy !== me && this.hasWorker(t.createdBy)) {
      this.post(SYSTEM, `@${t.createdBy} task [${t.id}] "${t.title}" đã xong bởi ${me}: ${result}`, { readOnly: ro || undefined });
    }
    for (const u of change.unblocked) if (u.assignee) this.notifyAssignee(u, ro);
    return change;
  }

  respondApproval(id: string, allow: boolean) {
    const a = this.approvals.get(id);
    if (!a) return;
    this.approvals.delete(id);
    this.emit("approvalResolved", id);
    this.setStatus(a.req.workerId, "working");
    a.resolve(allow);
  }

  /** Stops everything a worker is doing or about to do. */
  stop(workerId: string) {
    this.deps.scheduler.cancelQueued(`${workerId}:`);
    for (const [key, r] of this.running) if (key.startsWith(`${workerId}:`)) r.abort.abort();
    for (const key of [...this.inbox.keys()]) if (key.startsWith(`${workerId}:`)) this.inbox.delete(key);
    for (const [id, a] of this.approvals) if (a.req.workerId === workerId) this.respondApproval(id, false);
  }

  stopAll() { this.workers.forEach((w) => this.stop(w.id)); }

  /** True while any session whose key starts with `prefix` is running, queued or has mail waiting. */
  isActive(prefix: string): boolean {
    const has = (keys: Iterable<string>) => [...keys].some((k) => k.startsWith(prefix));
    return has(this.running.keys()) || has(this.scheduled) || has(this.inbox.keys());
  }

  // ---- memory & skills ----

  /** Starts a dedicated turn in which the worker tidies up its own memory. */
  consolidateMemory(workerId: string, taskId = `gc-${this.now().toString(36)}`): ChatMessage {
    return this.post(SYSTEM, `@${workerId} [gom trí nhớ]\n${CONSOLIDATE_PROMPT}`, { taskId, to: [workerId] });
  }

  proposeSkill(workerId: string, name: string, description: string, body: string): SkillDraft {
    const d = this.deps.skillDrafts.propose(workerId, name, description, body);
    this.emit("drafts", this.deps.skillDrafts.list());
    this.post(SYSTEM, `📚 Worker ${workerId} đề xuất skill "${name}". Hãy duyệt hoặc bỏ trong tab Hồ sơ.`, { alert: true });
    return d;
  }

  approveSkill(name: string) {
    this.deps.skillDrafts.approve(name);
    this.deps.skills.scan();
    this.rebuildSkills();
    this.emit("drafts", this.deps.skillDrafts.list());
    this.post(SYSTEM, `✅ Đã duyệt skill "${name}". Thêm vào useSkills của worker để bật.`);
  }

  rejectSkill(name: string) {
    this.deps.skillDrafts.reject(name);
    this.emit("drafts", this.deps.skillDrafts.list());
  }

  /** Regenerates the Claude plugin from the skills that Claude workers have enabled. */
  rebuildSkills() {
    const names = new Set(this.workers.filter((w) => w.provider === "claude").flatMap((w) => w.useSkills));
    const skills = [...names].flatMap((n) => { const s = this.deps.skills.get(n); return s ? [s] : []; });
    buildPlugin(this.deps.pluginDir, skills);
  }

  // ---- budget ----

  /** Lets an over-budget account keep running for the rest of today. */
  allowBudgetToday(accountId: string) {
    this.budgetNotes.add(`${accountId}:${ymd(new Date(this.now()))}:override`);
    this.budgetPaused.delete(accountId);
    this.deps.scheduler.resume(accountId);
    for (const w of this.workers.filter((x) => x.account === accountId)) {
      if (this.statuses.get(w.id)?.state === "over_budget") this.setStatus(w.id, this.isActive(`${w.id}:`) ? "queued" : "idle");
    }
    this.emit("usage");
  }

  private checkBudget(accountId: string, announce = true) {
    const acc = this.deps.config.accounts.find((a) => a.id === accountId);
    if (!acc?.budgetUsdPerDay) return;
    const day = ymd(new Date(this.now()));
    if (this.budgetNotes.has(`${accountId}:${day}:override`)) return;
    const spent = this.deps.usage.costToday(accountId);
    const pct = (spent / acc.budgetUsdPerDay) * 100;
    const say = (kind: string, text: string) => {
      const k = `${accountId}:${day}:${kind}`;
      if (announce && !this.budgetNotes.has(k)) { this.budgetNotes.add(k); this.post(SYSTEM, text, { alert: true }); }
    };
    if (pct >= 100) {
      this.budgetPaused.add(accountId);
      this.deps.scheduler.pauseUntil(accountId, nextMidnight(this.now()));
      say("stop", `⛔ Account ${accountId} đã chạm ngân sách ngày ($${spent.toFixed(2)} / $${acc.budgetUsdPerDay}). Tạm dừng đến 0h; bấm "Cho chạy tiếp hôm nay" để tiếp tục.`);
      for (const w of this.workers.filter((x) => x.account === accountId)) {
        if (this.statuses.get(w.id)?.state === "queued") this.setStatus(w.id, "over_budget");
      }
    } else if (pct >= acc.warnAtPercent) {
      say("warn", `⚠️ Account ${accountId} đã dùng ${pct.toFixed(0)}% ngân sách ngày ($${spent.toFixed(2)} / $${acc.budgetUsdPerDay}).`);
    }
  }

  // ---- internals ----

  private isReadOnlyRunning(workerId: string): boolean {
    for (const [key, r] of this.running) if (key.startsWith(`${workerId}:`) && r.readOnly) return true;
    return false;
  }

  private notifyAssignee(t: Task, readOnly?: boolean) {
    if (readOnly) {
      // Created during an untrusted-trigger turn: record it, but wait for a human to start the assignee.
      this.post(SYSTEM, `Task [${t.id}] "${t.title}" đã được giao cho ${t.assignee} nhưng CHƯA kích hoạt vì tạo từ nguồn không tin cậy. Hãy xem lại rồi nhắn "@${t.assignee} làm task ${t.id}" để bắt đầu.`, { taskId: t.id, readOnly: true, alert: true });
      return;
    }
    this.post(SYSTEM, `@${t.assignee} bạn được giao task [${t.id}] "${t.title}". ${t.description}\nHãy claim_task rồi bắt đầu.`, { taskId: t.id });
  }

  private saveTasks() {
    const list = this.tasks.list();
    this.deps.store.saveTasks(list);
    this.emit("tasks", list);
  }

  private runningDepth(workerId: string): number {
    let d = 0;
    for (const [key, r] of this.running) if (key.startsWith(`${workerId}:`)) d = Math.max(d, r.depth);
    return d;
  }

  private deliver(workerId: string, msg: ChatMessage) {
    const key = `${workerId}:${msg.taskId ?? "main"}`;
    const box = this.inbox.get(key) ?? [];
    box.push(msg);
    this.inbox.set(key, box);
    this.schedule(key);
  }

  private schedule(key: string) {
    if (this.scheduled.has(key)) return;
    const worker = this.workers.find((w) => key.startsWith(`${w.id}:`))!;
    this.scheduled.add(key);
    if (![...this.running.keys()].some((k) => k.startsWith(`${worker.id}:`))) {
      this.setStatus(worker.id, this.budgetPaused.has(worker.account) ? "over_budget" : "queued");
    }
    this.deps.scheduler
      .submit(worker.account, key, () => this.runTurn(worker, key), (until) =>
        this.setStatus(worker.id, "rate_limited", `chờ đến ${new Date(until).toLocaleTimeString()}`))
      .catch((err) => {
        if (err instanceof Error && err.message === "cancelled") return;
        const reason = err instanceof Error ? err.message : String(err);
        this.setStatus(worker.id, "error", reason);
        // Deliberately no "@id" here: a mention would route the error back to the failing worker.
        this.post(SYSTEM, `⚠️ ${worker.name} (id: ${worker.id}) gặp lỗi: ${reason}`, { alert: true });
      })
      .finally(() => {
        this.scheduled.delete(key);
        if (this.inbox.get(key)?.length) this.schedule(key);
        else if (this.statuses.get(worker.id)?.state !== "error" && ![...this.scheduled].some((k) => k.startsWith(`${worker.id}:`))) {
          this.setStatus(worker.id, "idle");
        }
      });
  }

  private async runTurn(worker: Worker, key: string): Promise<void> {
    const batch = this.inbox.get(key) ?? [];
    this.inbox.delete(key);
    if (!batch.length) return;

    const abort = new AbortController();
    const depth = Math.max(...batch.map((m) => m.depth));
    const readOnly = batch.some((m) => m.readOnly);
    this.running.set(key, { abort, depth, readOnly });
    this.budgetPaused.delete(worker.account);
    this.setStatus(worker.id, "working");
    const taskId = batch.find((m) => m.taskId)?.taskId;
    const account = this.deps.config.accounts.find((a) => a.id === worker.account)!;
    // Session ids only mean something on the machine that created them, so remote ones are kept apart.
    const host = account.host;
    const sessKey = host ? `${key}@${host}` : key;

    const turnId = newTurnId();
    const startedAt = this.now();
    const tools: Record<string, number> = {};
    const edited = new Set<string>();
    let record: TurnRecord | undefined;

    const finish = (usage: TurnUsage | undefined, error?: string) => {
      if (record) this.deps.inspector.save({ ...record, usage, error });
      this.deps.usage.append({
        ts: this.now(), turnId, worker: worker.id, account: account.id, provider: worker.provider,
        model: usage?.model ?? worker.model, sessionKey: key, taskId,
        input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0,
        costUsd: usage?.costUsd, estimated: usage?.estimated ?? false, numTurns: usage?.numTurns,
        durationMs: this.now() - startedAt, tools, error: error ?? null,
      });
    };

    try {
      const memory = this.deps.memory.blocks(worker, this.deps.options.memoryBudgetChars);
      const remote = host
        ? { host, base: worker.workdir ?? this.deps.config.hosts.find((h) => h.name === host)?.repo ?? "", skills: worker.useSkills.flatMap((n) => { const s = this.deps.skills.get(n); return s ? [{ name: s.name, dir: s.dir }] : []; }) }
        : undefined;
      if (host && (!remote?.base || !this.deps.remote)) throw new Error(`Không chạy được worker ${worker.id} trên host "${host}": thiếu workdir/repo hoặc chưa cấu hình kết nối`);
      // The runner on a remote host builds its own plugin and keeps its own copy of the skills.
      const claudeSkills = worker.provider === "claude" && !host ? claudeSkillOptions(worker, this.deps.pluginDir, this.deps.skills) : undefined;
      const skillsBlock = worker.provider === "codex"
        ? codexSkillsBlock(worker, this.deps.skills, host ? (s) => `${REMOTE_SKILLS}/${s.name}/SKILL.md` : undefined)
        : "";
      const persona = buildPersona(worker, this.workers, memory, skillsBlock, host ? { host, base: remote!.base } : undefined);
      const personaHash = createHash("sha1").update(persona.stable.text).digest("hex").slice(0, 16);
      // A session keeps the system prompt it started with. So the system prompt is the stable part of the persona, a changed
      // stable part starts a new session, and the changing parts (teammates, SOUL, memory) ride in the turn prompt when they are new or changed.
      const meta = this.sessionMeta[sessKey];
      if (this.sessions[sessKey] && meta && meta.persona !== personaHash) {
        delete this.sessions[sessKey];
        delete this.cursors[key];
      }
      const fresh = !this.sessions[sessKey];
      const sendMemory = fresh || !meta || meta.mem !== persona.memoryKey;
      const seen = this.cursors[key] ?? 0;
      const recent = this.messages.filter((m) => m.ts > seen).slice(-this.deps.options.contextMessages);
      const memoSections = sendMemory ? [...persona.volatile, ...(fresh && persona.journal ? [persona.journal] : [])] : [];
      const turn = buildTurn(worker, this.workers, recent, batch, this.tasks.list(), sendMemory ? { sections: memoSections, update: !fresh } : undefined);
      const cwd = host ? `${host}:${remote!.base}` : await this.deps.resolveCwd(worker);
      // What approvals are judged against: this machine's folder, or what the remote runner reports (unexpanded until it does).
      let approvalCwd = host ? remote!.base : cwd;
      record = {
        turnId, ts: startedAt, worker: worker.id, account: account.id, model: worker.model, sessionKey: sessKey,
        resumed: !fresh, taskId, cwd, readOnly,
        allowedTools: readOnly ? ["(chỉ đọc)"] : worker.allowedTools, useSkills: worker.useSkills,
        systemSections: sectionInfo(persona.stable.sections), promptSections: sectionInfo(turn.sections),
        systemAppend: persona.stable.text, prompt: turn.text,
      };

      const adapter = host ? this.deps.remote! : this.deps.adapters[worker.provider];
      const result = await adapter.runTurn({
        worker,
        account,
        cwd,
        remote,
        systemAppend: persona.stable.text,
        prompt: turn.text,
        sessionId: this.sessions[sessKey],
        mcpUrl: this.deps.mcpUrl(worker.id),
        claudeSkills,
        extraReadDirs: worker.provider === "codex" && !host ? codexSkillDirs(worker, this.deps.skills) : undefined,
        readOnly,
        signal: abort.signal,
        onCwd: (c) => { approvalCwd = c; },
        onRateLimit: () => this.plan?.touch(account.id),
        autonomy: this.autonomyOf(worker.id),
        onActivity: (a) => {
          const [tool, ...rest] = a.split(" ");
          tools[tool] = (tools[tool] ?? 0) + 1;
          if ((tool === "Edit" || tool === "Write") && rest.length) rest.join(" ").split(/,\s*/).forEach((f) => edited.add(f.split("/").slice(-2).join("/")));
          this.setStatus(worker.id, "working", a);
        },
        approve: (tool, input) => this.requestApproval(worker.id, tool, input, abort.signal, key, { cwd: approvalCwd, host }),
      });

      if (result.sessionId) {
        this.sessions[sessKey] = result.sessionId;
        this.deps.store.saveSessions(this.sessions);
        this.sessionMeta[sessKey] = { persona: personaHash, mem: persona.memoryKey };
        this.deps.store.saveSessionMeta(this.sessionMeta);
      }
      if (result.cwd && record) record.cwd = host ? `${host}:${result.cwd}` : result.cwd;
      this.cursors[key] = startedAt;
      this.deps.store.saveCursors(this.cursors);
      finish(result.usage);
      this.plan?.touch(account.id);
      this.writeJournal(worker.id, taskId, result.text, edited);
      this.checkBudget(account.id);
      this.emit("usage");
      if (result.text.trim()) this.post(worker.id, result.text.trim(), { taskId, depth: depth + 1, turnId, readOnly });
    } catch (err) {
      // The scheduler retries rate-limited jobs, so keep their messages for the retry.
      if (isRateLimit(err)) this.inbox.set(key, [...batch, ...(this.inbox.get(key) ?? [])]);
      else if (!abort.signal.aborted) { finish(undefined, err instanceof Error ? err.message : String(err)); this.emit("usage"); }
      if (abort.signal.aborted) return;
      throw err;
    } finally {
      this.running.delete(key);
      // A turn that ended without answering (connection lost, crash) must not leave its approval card behind.
      for (const [id, a] of [...this.approvals]) if (a.key === key) this.respondApproval(id, false);
    }
  }

  private writeJournal(workerId: string, taskId: string | undefined, text: string, edited: Set<string>) {
    const summary = text.replace(/\s+/g, " ").trim().slice(0, 140);
    if (!summary) return;
    const files = [...edited].slice(0, 5);
    try {
      this.deps.memory.journal(workerId, `${taskId ? `[${taskId}] ` : ""}${summary}${files.length ? ` (sửa: ${files.join(", ")})` : ""}`, { redact: true });
    } catch { /* the journal is best effort */ }
  }

  private policyContext(workerId: string, where: { cwd?: string; host?: string }): PolicyContext {
    const set = this.written.get(workerId);
    return { cwd: where.cwd, home: where.host ? undefined : this.deps.home, written: set ? (p) => set.has(p) : undefined };
  }

  private noteWritten(workerId: string, tool: string, input: unknown, ctx: PolicyContext) {
    if (!["Edit", "MultiEdit", "Write", "NotebookEdit"].includes(tool)) return;
    for (const p of toolPaths(tool, input)) {
      const abs = absolutePath(p, ctx);
      if (!abs) continue;
      let set = this.written.get(workerId);
      if (!set) this.written.set(workerId, (set = new Set()));
      if (set.size > 500) set.clear();
      set.add(abs);
    }
  }

  private audit(workerId: string, mode: Autonomy, tool: string, input: unknown, outcome: string, reason?: string) {
    this.deps.store.appendAudit({ ts: this.now(), worker: workerId, mode, call: redactSecrets(describeCall(tool, input)), outcome, reason });
  }

  private async requestApproval(workerId: string, tool: string, input: unknown, signal: AbortSignal, key: string, where: { cwd?: string; host?: string } = {}): Promise<ApprovalResult> {
    const mode = this.autonomyOf(workerId);
    const ctx = this.policyContext(workerId, where);
    let why: string | undefined, authored: string[] | undefined;
    if (mode !== "manual") {
      const v = decide(mode, tool, input, ctx);
      if (v.kind === "allow") {
        this.noteWritten(workerId, tool, input, ctx);
        this.audit(workerId, mode, tool, input, "tự duyệt");
        return true;
      }
      if (v.kind === "deny") {
        this.audit(workerId, mode, tool, input, "chặn", v.reason);
        const w = this.workers.find((x) => x.id === workerId);
        this.post(SYSTEM, `🛡 Chế độ ${mode} đã chặn ${w?.name ?? workerId}: ${redactSecrets(describeCall(tool, input)).replace(/@/g, "(at)")} — ${v.reason.replace(/@/g, "(at)")}`, {});
        return { allow: false, reason: `Bị chặn bởi chế độ ${mode}: ${v.reason}. Hãy dùng cách khác trong thư mục làm việc, hoặc hỏi người dùng (@user) nếu thật sự cần.` };
      }
      why = v.reason;
      authored = v.authored;
    }
    const req: ApprovalRequest = { id: randomUUID(), workerId, tool, input, ...where, ...(why ? { reason: `Chế độ ${mode}: ${why}` } : {}) };
    const allowed = await new Promise<boolean>((resolve) => {
      this.approvals.set(req.id, { req, resolve, key });
      signal.addEventListener("abort", () => this.respondApproval(req.id, false), { once: true });
      this.setStatus(workerId, "waiting_approval", tool);
      this.emit("approval", req);
    });
    if (mode !== "manual") this.audit(workerId, mode, tool, input, allowed ? "người dùng cho phép" : "người dùng từ chối", why);
    if (allowed) {
      this.noteWritten(workerId, tool, input, ctx);
      // The human has now seen this script run; stop asking about it every time.
      for (const p of authored ?? []) this.written.get(workerId)?.delete(p);
    }
    return allowed;
  }

  private setStatus(id: string, state: WorkerStatus["state"], activity?: string) {
    const s = { id, state, activity };
    this.statuses.set(id, s);
    this.emit("status", s);
  }
}
