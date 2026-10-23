import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatMessage, Task } from "./types";

/**
 * Persists the room under <workspace>/.agentroom:
 *   chat.jsonl     — append-only message log
 *   tasks.json     — task board snapshot
 *   sessions.json  — "<worker>:<thread>" → provider session/thread id (for resume)
 *   cursors.json   — last message id each worker has seen
 */
export class RoomStore {
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

  loadTasks(): Task[] { return this.readJson("tasks.json", []); }
  saveTasks(t: Task[]) { this.writeJson("tasks.json", t); }

  loadSessions(): Record<string, string> { return this.readJson("sessions.json", {}); }
  saveSessions(s: Record<string, string>) { this.writeJson("sessions.json", s); }

  loadCursors(): Record<string, number> { return this.readJson("cursors.json", {}); }
  saveCursors(c: Record<string, number>) { this.writeJson("cursors.json", c); }

  private readJson<T>(name: string, fallback: T): T {
    const f = join(this.dir, name);
    if (!existsSync(f)) return fallback;
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return fallback; }
  }

  private writeJson(name: string, value: unknown) {
    writeFileSync(join(this.dir, name), JSON.stringify(value, null, 2));
  }
}
