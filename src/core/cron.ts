import { EventEmitter } from "node:events";
import { Cron } from "croner";
import { ScheduleDef } from "./types";

export interface ScheduleState {
  lastRun: Record<string, number>;
  disabled: string[];
  last: Record<string, { ts: number; result: "fired" | "busy" | "missed" | "manual" | "error"; workers: string[]; error?: string }>;
}

export interface CronDeps {
  schedules: ScheduleDef[];
  workerIds: string[];
  now: () => number;
  load(): ScheduleState;
  save(s: ScheduleState): void;
  /** Starts the schedule's job for one worker. `taskId` selects the session. */
  fire(s: ScheduleDef, workerId: string, taskId: string): void;
  /** True while the worker still has a session whose task id starts with `taskPrefix`. */
  isBusy(workerId: string, taskPrefix: string): boolean;
}

export interface ScheduleStatus {
  id: string;
  worker: string;
  cron: string;
  description: string;
  timezone?: string;
  enabled: boolean;
  nextRun?: number;
  lastRun?: number;
  lastResult?: string;
  error?: string;
  builtin?: string;
}

const DOW: Record<string, string> = { "1-5": "các ngày trong tuần", "*": "hằng ngày", "0,6": "cuối tuần", "6,0": "cuối tuần" };

/** Small Vietnamese description for the common cron shapes; falls back to the raw expression. */
export function describeCron(expr: string): string {
  const p = expr.trim().split(/\s+/);
  if (p.length !== 5) return expr;
  const [m, h, dom, mon, dow] = p;
  const num = /^\d+$/;
  if (/^\*\/\d+$/.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `mỗi ${m.slice(2)} phút`;
  if (num.test(m) && h === "*" && dom === "*" && mon === "*" && dow === "*") return `mỗi giờ, phút ${m}`;
  if (num.test(m) && num.test(h) && dom === "*" && mon === "*" && DOW[dow]) {
    return `${DOW[dow]} lúc ${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
  }
  return expr;
}

/**
 * Fires schedules on time. `tick` is driven by a timer in production and called
 * directly in tests with a fake clock.
 *  - First time a schedule is seen it is not back-filled.
 *  - After downtime, a missed run fires once if it is at most `catchUpHours` late.
 *  - `skipIfRunning`: a worker that is still on the previous run is skipped.
 */
export class CronEngine extends EventEmitter<{ change: [] }> {
  private state: ScheduleState;
  private crons = new Map<string, Cron>();
  private timer?: NodeJS.Timeout;

  constructor(private deps: CronDeps) {
    super();
    const s = deps.load();
    this.state = { lastRun: s.lastRun ?? {}, disabled: s.disabled ?? [], last: s.last ?? {} };
    for (const d of deps.schedules) this.crons.set(d.id, new Cron(d.cron, { paused: true, timezone: d.timezone }));
  }

  start(intervalMs = 20_000) {
    this.tick();
    this.timer = setInterval(() => this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.crons.forEach((c) => c.stop());
  }

  private isEnabled(d: ScheduleDef) { return d.enabled && !this.state.disabled.includes(d.id); }
  private targets(d: ScheduleDef) { return d.worker === "*" ? this.deps.workerIds : [d.worker]; }
  /** "~" cannot appear in a schedule id, so `sched-<id>~` is an unambiguous prefix for busy checks. */
  private taskIdFor(d: ScheduleDef, now: number) { return d.session === "persistent" ? `sched-${d.id}~p` : `sched-${d.id}~${now.toString(36)}`; }
  private persist() { this.deps.save(this.state); this.emit("change"); }

  tick() {
    const now = this.deps.now();
    let dirty = false;
    for (const d of this.deps.schedules) {
      if (!this.isEnabled(d)) continue;
      try {
        const last = this.state.lastRun[d.id];
        if (last === undefined) { this.state.lastRun[d.id] = now; dirty = true; continue; }
        const next = this.crons.get(d.id)!.nextRun(new Date(last));
        if (!next || next.getTime() > now) continue;
        this.state.lastRun[d.id] = now;
        dirty = true;
        if (now - next.getTime() > d.catchUpHours * 3_600_000) {
          this.state.last[d.id] = { ts: now, result: "missed", workers: [] };
          continue;
        }
        this.run(d, now, "fired");
      } catch (e) {
        // One broken schedule must not stop the others.
        this.state.last[d.id] = { ts: now, result: "error", workers: [], error: e instanceof Error ? e.message : String(e) };
        dirty = true;
      }
    }
    if (dirty) this.persist();
  }

  private run(d: ScheduleDef, now: number, result: "fired" | "manual") {
    const taskId = this.taskIdFor(d, now);
    const started: string[] = [];
    for (const w of this.targets(d)) {
      if (d.skipIfRunning && this.deps.isBusy(w, `sched-${d.id}~`)) continue;
      this.deps.fire(d, w, taskId);
      started.push(w);
    }
    this.state.last[d.id] = { ts: now, result: started.length ? result : "busy", workers: started };
    return started.length > 0;
  }

  /** Runs a schedule now. Returns false if every target was still busy with the previous run. */
  runNow(id: string): boolean {
    const d = this.deps.schedules.find((s) => s.id === id);
    if (!d) throw new Error(`Không có lịch "${id}"`);
    const ok = this.run(d, this.deps.now(), "manual");
    this.persist();
    return ok;
  }

  setEnabled(id: string, enabled: boolean) {
    const set = new Set(this.state.disabled);
    if (enabled) set.delete(id); else set.add(id);
    this.state.disabled = [...set];
    // Re-enabling must not replay everything missed while it was off.
    if (enabled) this.state.lastRun[id] = this.deps.now();
    this.persist();
  }

  private safeNext(id: string, now: number): number | undefined {
    try { return this.crons.get(id)!.nextRun(new Date(now))?.getTime(); } catch { return undefined; }
  }

  statuses(): ScheduleStatus[] {
    const now = this.deps.now();
    return this.deps.schedules.map((d) => ({
      id: d.id, worker: d.worker, cron: d.cron, description: describeCron(d.cron), timezone: d.timezone, builtin: d.builtin,
      enabled: this.isEnabled(d),
      nextRun: this.isEnabled(d) ? this.safeNext(d.id, now) : undefined,
      lastRun: this.state.last[d.id]?.ts,
      lastResult: this.state.last[d.id]?.result,
      error: this.state.last[d.id]?.error,
    }));
  }
}
