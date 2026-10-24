import { tr, trVi } from "./i18n";
import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { AgentAdapter, ApprovalResult } from "../adapters/types";
import { TurnInspector, TurnRecord, newTurnId, sectionInfo } from "./inspector";
import { CONSOLIDATE_PROMPT, MemoryEntry, MemoryStore, redactSecrets, ymd } from "./memory";
import { buildPersona, buildTurn } from "./prompt";
import { parseMentions, route } from "./router";
import { isRateLimit, Scheduler } from "./scheduler";
import { REMOTE_SKILLS, SkillDraft, SkillDrafts, SkillRegistry, buildPlugin, claudeSkillOptions, codexSkillDirs, codexSkillsBlock } from "./skills";
import { Autonomy, PolicyContext, absolutePath, decide, describeCall, toolPaths } from "./autonomy";
import { PlanMonitor, PlanProbe } from "./plan";
import type { IssueInput, IssueStore } from "./issues";
import type { GuardVerdict, PluginManager } from "./plugins";
import { RoomStore } from "./store";
import { TaskBoard } from "./tasks";
import { ApprovalRequest, ChatMessage, ChoiceSet, HUMAN, Provider, RoomConfig, SYSTEM, Task, TurnUsage, Worker, WorkerStatus } from "./types";
import { nextMidnight, UsageStore } from "./usage";

export interface RoomOptions {
  maxAgentHops: number;
  contextMessages: number;
  /** Characters of memory (SOUL + MEMORY + journal) put in each persona prompt. */
  memoryBudgetChars: number;
  /** Wait this long before waking a worker for a message from another worker, so replies that arrive together become one turn. */
  agentDebounceMs?: number;
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
  /** Local log of errors and friction, for fixing and upgrading AgentRoom. Optional. */
  issues?: IssueStore;
  /** Extension points (guards, panels). Optional. */
  plugins?: PluginManager;
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
  /** Conversation id; a worker's messages inherit it from the turn they are written in. */
  chain?: string;
  replyTo?: string;
  options?: ChoiceSet;
  choice?: { message: string; option: string };
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
  chain: string;
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
/** The worker's agreed way of saying "nothing to do". */
export const isNoop = (t: string) => /^\s*\[NOOP\]/i.test(t) || /^\s*NOOP\s*[.!]?\s*$/i.test(t);

/** Tokens of context after which a worker's Claude session is replaced (see Room.rotateIfLarge). */
export const DEFAULT_CONTEXT_LIMIT = 150_000;

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
  /** Turns started per conversation (see ChatMessage.chain), and the conversations/tasks already announced as stopped. */
  private chainTurns = new Map<string, number>();
  private stopNotes = new Set<string>();
  private debounce = new Map<string, NodeJS.Timeout>();
  /** Replies that were not posted because they carried nothing new. */
  readonly suppressed = { noop: 0, repeat: 0 };
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
      if (w.autonomy === "full" && stored !== "full") this.post(SYSTEM, tr("⚠️ workers.yaml đặt autonomy: full cho {name} ({id}) nhưng Full Access chỉ do người dùng bật trên máy của mình (nút ở thẻ worker). Đang chạy ở chế độ Auto.", { name: w.name, id: w.id }), { alert: true });
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
  setAutonomy(workerId: string, mode: Autonomy, by = tr("người dùng")) {
    const w = this.workers.find((x) => x.id === workerId);
    if (!w) throw new Error(tr("Không có worker \"{workerId}\"", { workerId }));
    const was = this.autonomyOf(workerId);
    if (was === mode) return;
    this.modes.set(workerId, mode);
    this.deps.autonomyStore?.set(workerId, mode);
    this.deps.store.appendAudit({ ts: this.now(), worker: workerId, event: "mode", from: was, to: mode, by });
    const label = { manual: tr("Manual (hỏi mọi thao tác)"), auto: tr("Auto (tự duyệt việc an toàn trong thư mục của worker)"), full: tr("FULL ACCESS (không hỏi gì, trừ vài hành động có thể phá máy)") }[mode];
    this.post(SYSTEM, tr("{p} {name} ({workerId}): chế độ {was} → {mode}. {label}. Đổi bởi {by}.", { p: mode === "full" ? "⚡" : "🛡", name: w.name, workerId, was, mode, label, by }), { alert: true });
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
    // "Reply" on a worker's message sends the answer back to that worker, in the session (task) the message came from,
    // unless the text @mentions somebody, which is then taken as the user's own choice of who answers.
    const target = opts.replyTo ? this.messages.find((m) => m.id === opts.replyTo) : undefined;
    const replyBack = from === HUMAN && target && this.hasWorker(target.from) && !parseMentions(text, this.workers).length ? [target.from] : undefined;
    // A slash command registered by a plugin is for the plugin, not for the workers.
    const command = from === HUMAN && !opts.to ? this.deps.plugins?.matchCommand(text) : undefined;
    const to = command ? [] : opts.to ? opts.to.filter((id) => this.hasWorker(id)) : replyBack ?? (readOnly ? [] : route({ from, text, depth }, this.workers, this.deps.options));
    const taskId = opts.taskId ?? (from === HUMAN ? target?.taskId : undefined);
    const id = randomUUID();
    // A human or trigger message starts a conversation; a worker's messages belong to the one its running turn is part of.
    const chain = opts.chain ?? (from === HUMAN || from === SYSTEM ? undefined : this.chainOf(from)) ?? id;
    const msg: ChatMessage = {
      id, chain, ts: this.now(), from, text, to, depth, taskId, turnId: opts.turnId, readOnly: readOnly || undefined, source: opts.source, alert: opts.alert || undefined,
      ...(target ? { replyTo: target.id } : {}), ...(opts.options ? { options: opts.options } : {}), ...(opts.choice ? { choice: opts.choice } : {}),
    };
    this.messages.push(msg);
    this.deps.store.appendMessage(msg);
    this.emit("message", msg);
    for (const id of to) this.deliver(id, msg);
    if (command) void this.runChatCommand(command, msg.id);
    return msg;
  }

  /** Runs a plugin's chat command and shows its reply as a system notice (no @, so it wakes nobody). */
  async runChatCommand(command: { def: { name: string; run(args: string): string | void | Promise<string | void> }; args: string }, chain?: string): Promise<string | undefined> {
    let out: string | void;
    try { out = await command.def.run(command.args); } catch (e) { out = tr("Lệnh /{name} lỗi: {msg}", { name: command.def.name, msg: e instanceof Error ? e.message : String(e) }); }
    if (!out) return undefined;
    const text = redactSecrets(String(out)).replace(/@/g, "(at)");
    this.post(SYSTEM, text, { to: [], chain });
    return text;
  }

  /** The task whose session `workerId` is working in right now, when that is unambiguous. */
  private currentTask(workerId: string): string | undefined {
    const keys = [...this.running.keys()].filter((k) => k.startsWith(`${workerId}:`));
    if (keys.length !== 1) return undefined;
    const t = keys[0].slice(workerId.length + 1);
    return t === "main" ? undefined : t;
  }

  /**
   * A worker asks the user to pick one of 2–8 options. The message carries buttons; the pick (or a typed reply) goes back to
   * this worker in the same session, so the worker can simply end its turn and continue when the answer arrives.
   * Nobody is woken by the question itself (`to: []`), whatever the option texts say.
   */
  askUser(me: string, args: { question: string; options: { label: string; description?: string }[] }, taskId?: string): ChatMessage {
    const tidy = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
    const question = tidy(args.question, 500);
    if (!question) throw new Error(tr("Thiếu câu hỏi"));
    const items = args.options.map((o, i) => ({ id: String(i + 1), label: tidy(o.label, 80), ...(o.description ? { description: tidy(o.description, 200) } : {}) }));
    if (items.length < 2 || items.length > 8) throw new Error(tr("Cần 2 đến 8 lựa chọn"));
    if (items.some((i) => !i.label)) throw new Error(tr("Mỗi lựa chọn cần có nhãn"));
    if (new Set(items.map((i) => i.label.toLowerCase())).size !== items.length) throw new Error(tr("Các lựa chọn bị trùng nhãn"));
    const lines = items.map((i) => `${i.id}. ${i.label}${i.description ? ` — ${i.description}` : ""}`);
    return this.post(me, `${question}\n${lines.join("\n")}\n` + tr("@user hãy chọn một phương án (bấm nút) hoặc trả lời bằng chữ."), { to: [], options: { question, items }, taskId: taskId ?? this.currentTask(me) });
  }

  /** The user picks option `optionId` of message `messageId`; once per question. */
  answerOption(messageId: string, optionId: string, via?: string): ChatMessage {
    const m = this.messages.find((x) => x.id === messageId);
    if (!m?.options) throw new Error(tr("Tin nhắn này không có lựa chọn"));
    if (!this.hasWorker(m.from)) throw new Error(tr("Chỉ trả lời được lựa chọn của worker"));
    if (this.messages.some((x) => x.choice?.message === messageId)) throw new Error(tr("Câu hỏi này đã được trả lời"));
    const item = m.options.items.find((i) => i.id === optionId);
    if (!item) throw new Error(tr("Không có lựa chọn này"));
    return this.post(HUMAN, tr("Tôi chọn {id}: {label}", { id: item.id, label: item.label }), { replyTo: m.id, choice: { message: m.id, option: item.id }, to: [m.from], taskId: m.taskId, source: via });
  }

  /** A short quote of a message, for the prompt of whoever is being replied to. */
  quoteOf(id: string): string | undefined {
    const t = this.messages.find((m) => m.id === id);
    if (!t) return undefined;
    const body = t.text.replace(/\s+/g, " ").trim();
    return `${t.from === HUMAN ? "@user" : t.from === SYSTEM ? "[system]" : "@" + t.from}: ${body.length > 240 ? body.slice(0, 237) + "…" : body}`;
  }

  transcript(limit: number): string {
    return this.messages.slice(-limit).map((m) => `${m.from === HUMAN ? "@user" : m.from === SYSTEM ? "[system]" : "@" + m.from}: ${m.text}`).join("\n");
  }

  createTask(me: string, args: { title: string; description?: string; assignee?: string; dependsOn?: string[] }): Task {
    if (args.assignee && !this.hasWorker(args.assignee)) throw new Error(tr("Không có worker \"{assignee}\"", { assignee: args.assignee }));
    const t = this.tasks.create({ ...args, createdBy: me });
    this.saveTasks();
    if (t.assignee && t.status === "todo" && t.assignee !== me) this.notifyAssignee(t, this.isReadOnlyRunning(me), this.chainOf(me));
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
      this.post(SYSTEM, tr("@{createdBy} task [{id}] \"{title}\" đã xong bởi {me}: {result}", { createdBy: t.createdBy, id: t.id, title: t.title, me, result }), { readOnly: ro || undefined, chain: this.chainOf(me) });
    }
    for (const u of change.unblocked) if (u.assignee) this.notifyAssignee(u, ro, this.chainOf(me));
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
    for (const [key, t] of [...this.debounce]) if (key.startsWith(`${workerId}:`)) { clearTimeout(t); this.debounce.delete(key); }
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
    this.post(SYSTEM, tr("📚 Worker {workerId} đề xuất skill \"{name}\". Hãy duyệt hoặc bỏ trong tab Hồ sơ.", { workerId, name }), { alert: true });
    return d;
  }

  approveSkill(name: string) {
    this.deps.skillDrafts.approve(name);
    this.deps.skills.scan();
    this.rebuildSkills();
    this.emit("drafts", this.deps.skillDrafts.list());
    this.post(SYSTEM, tr("✅ Đã duyệt skill \"{name}\". Thêm vào useSkills của worker để bật.", { name }));
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
      if (announce) this.noteIssue({ kind: "friction", source: "budget", title: trVi("Account {accountId} chạm ngân sách ngày nên tạm dừng", { accountId }) });
      this.deps.scheduler.pauseUntil(accountId, nextMidnight(this.now()));
      say("stop", tr("⛔ Account {accountId} đã chạm ngân sách ngày (${p} / ${budgetUsdPerDay}). Tạm dừng đến 0h; bấm \"Cho chạy tiếp hôm nay\" để tiếp tục.", { accountId, p: spent.toFixed(2), budgetUsdPerDay: acc.budgetUsdPerDay }));
      for (const w of this.workers.filter((x) => x.account === accountId)) {
        if (this.statuses.get(w.id)?.state === "queued") this.setStatus(w.id, "over_budget");
      }
    } else if (pct >= acc.warnAtPercent) {
      say("warn", tr("⚠️ Account {accountId} đã dùng {p}% ngân sách ngày (${p1} / ${budgetUsdPerDay}).", { accountId, p: pct.toFixed(0), p1: spent.toFixed(2), budgetUsdPerDay: acc.budgetUsdPerDay }));
    }
  }

  // ---- internals ----

  private isReadOnlyRunning(workerId: string): boolean {
    for (const [key, r] of this.running) if (key.startsWith(`${workerId}:`) && r.readOnly) return true;
    return false;
  }

  private notifyAssignee(t: Task, readOnly?: boolean, chain?: string) {
    if (readOnly) {
      // Created during an untrusted-trigger turn: record it, but wait for a human to start the assignee.
      this.post(SYSTEM, tr("Task [{id}] \"{title}\" đã được giao cho {assignee} nhưng CHƯA kích hoạt vì tạo từ nguồn không tin cậy. Hãy xem lại rồi nhắn \"@{assignee} làm task {id}\" để bắt đầu.", { id: t.id, title: t.title, assignee: t.assignee }), { taskId: t.id, readOnly: true, alert: true, chain });
      return;
    }
    this.post(SYSTEM, tr("@{assignee} bạn được giao task [{id}] \"{title}\". {description}\nHãy claim_task rồi bắt đầu.", { assignee: t.assignee, id: t.id, title: t.title, description: t.description }), { taskId: t.id, chain });
  }

  private saveTasks() {
    const list = this.tasks.list();
    this.deps.store.saveTasks(list);
    this.emit("tasks", list);
  }

  private isRepeat(workerId: string, text: string, chain: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().slice(0, 300);
    const mine = norm(text);
    if (mine.length < 12) return false;
    let seen = 0;
    for (let i = this.messages.length - 1; i >= 0 && seen < 12; i--) {
      const m = this.messages[i];
      if (m.from !== workerId || m.chain !== chain) continue;
      seen++;
      if (norm(m.text) === mine) return true;
    }
    return false;
  }

  private chainOf(workerId: string): string | undefined {
    for (const [key, r] of this.running) if (key.startsWith(`${workerId}:`)) return r.chain;
    return undefined;
  }

  /** Says once (per conversation or task) why work between workers stopped. */
  get issues() { return this.deps.issues; }
  get plugins() { return this.deps.plugins; }

  /** Never throws: the issue log must not break a turn. Use `Room.reportIssue` for the owner's own notes. */
  noteIssue(i: IssueInput) {
    try { this.deps.issues?.record(i); } catch { /* best effort */ }
  }

  /** A note the owner wrote (⚑ button, /issue, CLI). */
  reportIssue(text: string, worker?: string) {
    const t = text.trim();
    if (!t) return undefined;
    return this.deps.issues?.record({ kind: "user", source: "user", title: t.split("\n")[0].slice(0, 200), detail: t.includes("\n") ? t : undefined, worker });
  }

  private announceStop(key: string, text: string, chain?: string) {
    if (this.stopNotes.has(key)) return;
    this.noteIssue({ kind: "friction", source: "limit", title: key.startsWith("task:") ? tr("Task chạm limits.usdPerTask nên các worker dừng") : tr("Chuỗi trao đổi chạm limits.chainTurns nên các worker dừng") });
    this.stopNotes.add(key);
    if (this.stopNotes.size > 500) this.stopNotes.delete(this.stopNotes.values().next().value!);
    this.post(SYSTEM, text, { alert: true, to: [], chain });
  }

  /** True when a message from one worker to another must not start more work (conversation too long, or task too expensive). */
  private overLimit(msg: ChatMessage): boolean {
    const lim = this.deps.config.limits;
    if (msg.chain && (this.chainTurns.get(msg.chain) ?? 0) >= lim.chainTurns) {
      this.announceStop(`chain:${msg.chain}`, tr("🧯 Các worker đã trao đổi {chainTurns} lượt cho tin nhắn này của bạn nên tôi tạm dừng để tránh tốn token vô ích. Nhắn lại (hoặc @tên-worker …) để tiếp tục. Đổi giới hạn bằng limits.chainTurns trong workers.yaml.", { chainTurns: lim.chainTurns }), msg.chain);
      return true;
    }
    if (lim.usdPerTask && msg.taskId && this.deps.usage.costOfTask(msg.taskId) >= lim.usdPerTask) {
      this.announceStop(`task:${msg.taskId}`, tr("🧯 Task {taskId} đã tốn ${p} (giới hạn limits.usdPerTask = ${usdPerTask}), nên các worker tạm dừng làm tiếp việc này với nhau. Bạn nhắn vào task để tiếp tục.", { taskId: msg.taskId, p: this.deps.usage.costOfTask(msg.taskId).toFixed(2), usdPerTask: lim.usdPerTask }), msg.chain);
      return true;
    }
    return false;
  }

  private runningDepth(workerId: string): number {
    let d = 0;
    for (const [key, r] of this.running) if (key.startsWith(`${workerId}:`)) d = Math.max(d, r.depth);
    return d;
  }

  private deliver(workerId: string, msg: ChatMessage) {
    // Written by a worker, or by the room on behalf of a worker's turn (task notices): not something a person typed.
    const fromWorker = msg.from !== HUMAN && (this.hasWorker(msg.from) || msg.chain !== msg.id);
    if (fromWorker && this.overLimit(msg)) return;
    const key = `${workerId}:${msg.taskId ?? "main"}`;
    const box = this.inbox.get(key) ?? [];
    box.push(msg);
    this.inbox.set(key, box);
    const wait = this.deps.options.agentDebounceMs ?? 0;
    if (fromWorker && wait > 0) {
      // Let replies that arrive together be answered in one turn.
      if (!this.scheduled.has(key) && !this.debounce.has(key)) {
        const t = setTimeout(() => { this.debounce.delete(key); this.schedule(key); }, wait);
        t.unref?.();
        this.debounce.set(key, t);
      }
      return;
    }
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
        { this.noteIssue({ kind: "friction", source: "rate-limit", title: trVi("Account {account} bị rate limit", { account: worker.account }), worker: worker.id }); this.setStatus(worker.id, "rate_limited", tr("chờ đến {p}", { p: new Date(until).toLocaleTimeString() })); })
      .catch((err) => {
        if (err instanceof Error && err.message === "cancelled") return;
        const reason = err instanceof Error ? err.message : String(err);
        this.setStatus(worker.id, "error", reason);
        this.noteIssue({ kind: "error", source: "turn", title: trVi("Lượt của worker lỗi: {reason}", { reason }), worker: worker.id });
        // Deliberately no "@id" here: a mention would route the error back to the failing worker.
        this.post(SYSTEM, tr("⚠️ {name} (id: {id}) gặp lỗi: {reason}", { name: worker.name, id: worker.id, reason }), { alert: true });
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
    const chain = batch[0].chain ?? batch[0].id;
    this.running.set(key, { abort, depth, readOnly, chain });
    this.chainTurns.set(chain, (this.chainTurns.get(chain) ?? 0) + 1);
    if (this.chainTurns.size > 2000) this.chainTurns.delete(this.chainTurns.keys().next().value!);
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
        model: usage?.model ?? worker.model, sessionKey: key, sessionId: this.sessions[sessKey], taskId,
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
      if (host && (!remote?.base || !this.deps.remote)) throw new Error(tr("Không chạy được worker {id} trên host \"{host}\": thiếu workdir/repo hoặc chưa cấu hình kết nối", { id: worker.id, host }));
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
      const turn = buildTurn(worker, this.workers, recent, batch, this.tasks.list(), sendMemory ? { sections: memoSections, update: !fresh } : undefined, (id) => this.quoteOf(id));
      const cwd = host ? `${host}:${remote!.base}` : await this.deps.resolveCwd(worker);
      // What approvals are judged against: this machine's folder, or what the remote runner reports (unexpanded until it does).
      let approvalCwd = host ? remote!.base : cwd;
      record = {
        turnId, ts: startedAt, worker: worker.id, account: account.id, model: worker.model, sessionKey: sessKey,
        resumed: !fresh, taskId, cwd, readOnly,
        allowedTools: readOnly ? [tr("(chỉ đọc)")] : worker.allowedTools, useSkills: worker.useSkills,
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
      this.rotateIfLarge(worker, key, sessKey, result.usage);
      this.plan?.touch(account.id);
      // A reply to other workers that carries nothing new ("[NOOP]", or the same words as before in this conversation)
      // is not posted: it would only wake someone to answer it. A human's message is always answered.
      const text = result.text.trim();
      const agentOnly = batch.every((m) => m.from !== HUMAN);
      const noop = agentOnly && isNoop(text);
      const repeat = agentOnly && !noop && !!text && this.isRepeat(worker.id, text, chain);
      if (noop) this.suppressed.noop++;
      if (repeat) this.suppressed.repeat++;
      if (!noop) this.writeJournal(worker.id, taskId, result.text, edited);
      this.checkBudget(account.id);
      this.emit("usage");
      if (text && !noop && !repeat) this.post(worker.id, text, { taskId, depth: depth + 1, turnId, readOnly });
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

  /**
   * Every call of a session reads its whole context again (cache), so a session that has grown big makes each later
   * turn expensive. Past the worker's limit the session is dropped: the next turn starts fresh and gets the team and
   * personal memory, the journal and the recent chat in its prompt, exactly as after a persona change.
   */
  private rotateIfLarge(worker: Worker, key: string, sessKey: string, usage: TurnUsage | undefined) {
    const limit = worker.contextLimit ?? (worker.coordinator ? 0 : DEFAULT_CONTEXT_LIMIT);
    if (!usage || worker.provider !== "claude" || !limit || !this.sessions[sessKey]) return;
    // The totals add up every call of the turn, so the average per call is a lower bound of the context at its end.
    const ctx = Math.round((usage.input + usage.cacheRead + usage.cacheWrite) / Math.max(1, usage.numTurns ?? 1));
    if (ctx <= limit) return;
    delete this.sessions[sessKey];
    delete this.sessionMeta[sessKey];
    delete this.cursors[key];
    this.deps.store.saveSessions(this.sessions);
    this.deps.store.saveSessionMeta(this.sessionMeta);
    this.deps.store.saveCursors(this.cursors);
    this.post(SYSTEM, tr("♻️ Session của {name} đã lên ~{k}k token context nên lượt sau bắt đầu session mới (trí nhớ và nhật ký được nạp lại) để tiết kiệm hạn mức.", { name: worker.name, k: Math.round(ctx / 1000) }), { to: [] });
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

  private notifyApproved(workerId: string, tool: string, input: unknown, ctx: PolicyContext, where: { cwd?: string; host?: string }, by: "policy" | "user") {
    if (!this.deps.plugins) return;
    const paths = toolPaths(tool, input).flatMap((p) => { const a = absolutePath(p, ctx); return a ? [a] : []; });
    this.deps.plugins.notifyApproved({ workerId, tool, input, paths, cwd: where.cwd, host: where.host, by });
  }

  private pluginGuard(workerId: string, tool: string, input: unknown, ctx: PolicyContext, where: { cwd?: string; host?: string }): ReturnType<PluginManager["check"]> {
    if (!this.deps.plugins) return undefined;
    const paths = toolPaths(tool, input).flatMap((p) => { const a = absolutePath(p, ctx); return a ? [a] : []; });
    return this.deps.plugins.check({ workerId, tool, input, paths, cwd: where.cwd, host: where.host });
  }

  private audit(workerId: string, mode: Autonomy, tool: string, input: unknown, outcome: string, reason?: string) {
    this.deps.store.appendAudit({ ts: this.now(), worker: workerId, mode, call: redactSecrets(describeCall(tool, input)), outcome, reason });
  }

  private async requestApproval(workerId: string, tool: string, input: unknown, signal: AbortSignal, key: string, where: { cwd?: string; host?: string } = {}): Promise<ApprovalResult> {
    const mode = this.autonomyOf(workerId);
    const ctx = this.policyContext(workerId, where);
    let why: string | undefined, authored: string[] | undefined;
    // A plugin guard can only tighten: it never turns a block or a question into an allow (see core/plugins.ts).
    const guard = this.pluginGuard(workerId, tool, input, ctx, where);
    const w = this.workers.find((x) => x.id === workerId);
    const blocked = (by: string, reason: string, outcome: string): ApprovalResult => {
      this.audit(workerId, mode, tool, input, outcome, reason);
      this.post(SYSTEM, tr("🧩 Plugin {by} đã chặn {p}: {p1} — {p2}", { by, p: w?.name ?? workerId, p1: redactSecrets(describeCall(tool, input)).replace(/@/g, "(at)"), p2: reason.replace(/@/g, "(at)") }), {});
      return { allow: false, reason: tr("Bị chặn bởi plugin {by}: {reason}. Hãy dùng cách khác hoặc hỏi người dùng (@user) nếu thật sự cần.", { by, reason }) };
    };
    if (guard?.action === "deny") return blocked(guard.by, guard.reason, tr("chặn"));
    if (mode !== "manual") {
      const v = decide(mode, tool, input, ctx);
      if (v.kind === "allow" && !guard) {
        this.noteWritten(workerId, tool, input, ctx);
        this.notifyApproved(workerId, tool, input, ctx, where, "policy");
        this.audit(workerId, mode, tool, input, tr("tự duyệt"));
        return true;
      }
      if (v.kind === "deny") {
        this.audit(workerId, mode, tool, input, tr("chặn"), v.reason);
        this.post(SYSTEM, tr("🛡 Chế độ {mode} đã chặn {p}: {p1} — {p2}", { mode, p: w?.name ?? workerId, p1: redactSecrets(describeCall(tool, input)).replace(/@/g, "(at)"), p2: v.reason.replace(/@/g, "(at)") }), {});
        return { allow: false, reason: tr("Bị chặn bởi chế độ {mode}: {reason}. Hãy dùng cách khác trong thư mục làm việc, hoặc hỏi người dùng (@user) nếu thật sự cần.", { mode, reason: v.reason }) };
      }
      if (v.kind === "ask") { why = tr("Chế độ {mode}: {why}", { mode, why: v.reason }); authored = v.authored; }
    }
    if (guard) why = [why, tr("Plugin {by}: {reason}", { by: guard.by, reason: guard.reason })].filter(Boolean).join(" · ");
    const req: ApprovalRequest = { id: randomUUID(), workerId, tool, input, ...where, ...(why ? { reason: why } : {}) };
    const allowed = await new Promise<boolean>((resolve) => {
      this.approvals.set(req.id, { req, resolve, key });
      signal.addEventListener("abort", () => this.respondApproval(req.id, false), { once: true });
      this.setStatus(workerId, "waiting_approval", tool);
      this.emit("approval", req);
    });
    if (mode !== "manual" || guard) this.audit(workerId, mode, tool, input, allowed ? tr("người dùng cho phép") : tr("người dùng từ chối"), why);
    if (allowed) {
      this.noteWritten(workerId, tool, input, ctx);
      this.notifyApproved(workerId, tool, input, ctx, where, "user");
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
