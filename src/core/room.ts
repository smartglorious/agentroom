import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { AgentAdapter } from "../adapters/types";
import { personaPrompt, turnPrompt } from "./prompt";
import { route } from "./router";
import { isRateLimit, Scheduler } from "./scheduler";
import { RoomStore } from "./store";
import { TaskBoard } from "./tasks";
import { ApprovalRequest, ChatMessage, HUMAN, Provider, RoomConfig, SYSTEM, Task, Worker, WorkerStatus } from "./types";

export interface RoomOptions {
  maxAgentHops: number;
  contextMessages: number;
}

export interface RoomDeps {
  config: RoomConfig;
  store: RoomStore;
  adapters: Record<Provider, AgentAdapter>;
  scheduler: Scheduler;
  options: RoomOptions;
  /** Working directory for a worker (its git worktree, or the workspace root). */
  resolveCwd(w: Worker): Promise<string>;
  mcpUrl(workerId: string): string;
}

export interface RoomEvents {
  message: [ChatMessage];
  status: [WorkerStatus];
  approval: [ApprovalRequest];
  approvalResolved: [string];
  tasks: [Task[]];
}

/**
 * The orchestrator. Every message goes through `post`: it is stored, routed to
 * recipients, and each recipient gets a turn on its session for that thread
 * ("<worker>:main" or "<worker>:<taskId>"). Messages arriving while a session is
 * busy pile up in its inbox and are answered together in the next turn.
 */
export class Room extends EventEmitter<RoomEvents> {
  readonly tasks: TaskBoard;
  private messages: ChatMessage[];
  private sessions: Record<string, string>;
  private cursors: Record<string, number>;
  private inbox = new Map<string, ChatMessage[]>();
  private scheduled = new Set<string>();
  private running = new Map<string, { abort: AbortController; depth: number }>();
  private approvals = new Map<string, { req: ApprovalRequest; resolve: (ok: boolean) => void }>();
  private statuses = new Map<string, WorkerStatus>();

  constructor(private deps: RoomDeps) {
    super();
    this.messages = deps.store.loadMessages();
    this.tasks = new TaskBoard(deps.store.loadTasks());
    this.sessions = deps.store.loadSessions();
    this.cursors = deps.store.loadCursors();
    for (const a of deps.config.accounts) deps.scheduler.setLimit(a.id, a.maxConcurrent);
    for (const w of deps.config.workers) this.statuses.set(w.id, { id: w.id, state: "idle" });
  }

  get workers() { return this.deps.config.workers; }
  hasWorker(id: string) { return this.workers.some((w) => w.id === id); }

  snapshot() {
    return {
      workers: this.workers.map(({ id, name, role, skills, provider, coordinator }) => ({ id, name, role, skills, provider, coordinator })),
      messages: this.messages.slice(-200),
      statuses: [...this.statuses.values()],
      tasks: this.tasks.list(),
      approvals: [...this.approvals.values()].map((a) => a.req),
    };
  }

  /** Posts a message from the human, a worker, or the system and dispatches it. */
  post(from: string, text: string, opts: { taskId?: string; depth?: number } = {}): ChatMessage {
    const depth = opts.depth ?? (from === HUMAN ? 0 : this.runningDepth(from) + 1);
    const to = route({ from, text, depth }, this.workers, this.deps.options);
    const msg: ChatMessage = { id: randomUUID(), ts: Date.now(), from, text, to, depth, taskId: opts.taskId };
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
    if (t.assignee && t.status === "todo" && t.assignee !== me) this.notifyAssignee(t);
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
    if (t.createdBy !== me && this.hasWorker(t.createdBy)) {
      this.post(SYSTEM, `@${t.createdBy} task [${t.id}] "${t.title}" đã xong bởi @${me}: ${result}`);
    }
    for (const u of change.unblocked) if (u.assignee) this.notifyAssignee(u);
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

  // ---- internals ----

  private notifyAssignee(t: Task) {
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
    if (![...this.running.keys()].some((k) => k.startsWith(`${worker.id}:`))) this.setStatus(worker.id, "queued");
    this.deps.scheduler
      .submit(worker.account, key, () => this.runTurn(worker, key), (until) =>
        this.setStatus(worker.id, "rate_limited", `chờ đến ${new Date(until).toLocaleTimeString()}`))
      .catch((err) => {
        if (err instanceof Error && err.message === "cancelled") return;
        this.setStatus(worker.id, "error", String(err instanceof Error ? err.message : err));
        this.post(SYSTEM, `⚠️ ${worker.name} (@${worker.id}) gặp lỗi: ${err instanceof Error ? err.message : err}`);
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
    this.running.set(key, { abort, depth });
    this.setStatus(worker.id, "working");
    const taskId = batch.find((m) => m.taskId)?.taskId;
    const account = this.deps.config.accounts.find((a) => a.id === worker.account)!;

    const startedAt = Date.now();
    try {
      const seen = this.cursors[key] ?? 0;
      const recent = this.messages.filter((m) => m.ts > seen).slice(-this.deps.options.contextMessages);
      const result = await this.deps.adapters[worker.provider].runTurn({
        worker,
        account,
        cwd: await this.deps.resolveCwd(worker),
        systemAppend: personaPrompt(worker, this.workers),
        prompt: turnPrompt(worker, this.workers, recent, batch, this.tasks.list()),
        sessionId: this.sessions[key],
        mcpUrl: this.deps.mcpUrl(worker.id),
        signal: abort.signal,
        onActivity: (a) => this.setStatus(worker.id, "working", a),
        approve: (tool, input) => this.requestApproval(worker.id, tool, input, abort.signal),
      });
      if (result.sessionId) {
        this.sessions[key] = result.sessionId;
        this.deps.store.saveSessions(this.sessions);
      }
      this.cursors[key] = startedAt;
      this.deps.store.saveCursors(this.cursors);
      if (result.text.trim()) this.post(worker.id, result.text.trim(), { taskId, depth: depth + 1 });
    } catch (err) {
      // The scheduler retries rate-limited jobs, so keep their messages for the retry.
      if (isRateLimit(err)) this.inbox.set(key, [...batch, ...(this.inbox.get(key) ?? [])]);
      if (abort.signal.aborted) return;
      throw err;
    } finally {
      this.running.delete(key);
    }
  }

  private requestApproval(workerId: string, tool: string, input: unknown, signal: AbortSignal): Promise<boolean> {
    const req: ApprovalRequest = { id: randomUUID(), workerId, tool, input };
    return new Promise((resolve) => {
      this.approvals.set(req.id, { req, resolve });
      signal.addEventListener("abort", () => this.respondApproval(req.id, false), { once: true });
      this.setStatus(workerId, "waiting_approval", tool);
      this.emit("approval", req);
    });
  }

  private setStatus(id: string, state: WorkerStatus["state"], activity?: string) {
    const s = { id, state, activity };
    this.statuses.set(id, s);
    this.emit("status", s);
  }
}
