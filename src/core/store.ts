import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ScheduleState } from "./cron";
import { ChatMessage, Task } from "./types";

/** What the room remembers about a session besides its id. */
export interface SessionMeta {
  persona: string;
  mem: string;
  /** When the last turn of the session ended, and how big its context was then (tokens, per model call): enough to tell whether resuming it would pay to write the whole context again. */
  end?: number;
  ctx?: number;
  /** Model the session runs on (a different one would not read this session's cache, so a change starts a new session). */
  model?: string;
}

/** Persistence boundary used by Room. Implementations may be file-, memory-, or database-backed. */
export interface RoomStateStore {
  loadMessages(): ChatMessage[];
  appendMessage(message: ChatMessage): void;
  appendAudit(entry: object): void;
  loadTasks(): Task[];
  saveTasks(tasks: Task[]): void;
  loadSessions(): Record<string, string>;
  saveSessions(sessions: Record<string, string>): void;
  loadSessionMeta(): Record<string, SessionMeta>;
  saveSessionMeta(metadata: Record<string, SessionMeta>): void;
  loadCursors(): Record<string, number>;
  saveCursors(cursors: Record<string, number>): void;
  loadSchedules(): ScheduleState;
  saveSchedules(state: ScheduleState): void;
}

/**
 * Persists the room under <workspace>/.agentroom:
 *   chat.jsonl     — append-only message log
 *   tasks.json     — task board snapshot
 *   sessions.json  — "<worker>:<thread>" → provider session/thread id (for resume)
 *   cursors.json   — last message id each worker has seen
 *   schedules.json — cron bookkeeping (last runs, disabled schedules)
 */
export class RoomStore implements RoomStateStore {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  loadMessages(): ChatMessage[] {
    const f = join(this.dir, "chat.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as ChatMessage]; } catch { return []; }
    });
  }

  appendMessage(m: ChatMessage) {
    appendFileSync(join(this.dir, "chat.jsonl"), JSON.stringify(m) + "\n");
  }

  /** One line per automatic decision (and per escalation) made under a worker's autonomy mode. Rotated at 5 MB. */
  appendAudit(entry: object) {
    const f = join(this.dir, "audit.jsonl");
    try {
      if (existsSync(f) && statSync(f).size > 5_000_000) renameSync(f, join(this.dir, "audit.1.jsonl"));
      appendFileSync(f, JSON.stringify(entry) + "\n");
    } catch { /* the audit log must never break a turn */ }
  }

  loadTasks(): Task[] { return this.readJson("tasks.json", []); }
  saveTasks(t: Task[]) { this.writeJson("tasks.json", t); }

  loadSessions(): Record<string, string> { return this.readJson("sessions.json", {}); }
  saveSessions(s: Record<string, string>) { this.writeJson("sessions.json", s); }

  /** Per session: hash of the persona it was started with, and of the memory it last saw. */
  loadSessionMeta(): Record<string, SessionMeta> { return this.readJson("sessionmeta.json", {}); }
  saveSessionMeta(m: Record<string, SessionMeta>) { this.writeJson("sessionmeta.json", m); }

  loadCursors(): Record<string, number> { return this.readJson("cursors.json", {}); }
  saveCursors(c: Record<string, number>) { this.writeJson("cursors.json", c); }

  loadSchedules(): ScheduleState { return this.readJson("schedules.json", { lastRun: {}, disabled: [], last: {} }); }
  saveSchedules(s: ScheduleState) { this.writeJson("schedules.json", s); }

  private readJson<T>(name: string, fallback: T): T {
    const f = join(this.dir, name);
    if (!existsSync(f)) return fallback;
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
  }

  private writeJson(name: string, value: unknown) {
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2));
  }
}
