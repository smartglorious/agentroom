import { test } from "node:test";
import assert from "node:assert/strict";
import type { ScheduleState } from "../src/core/cron";
import type { RoomStateStore } from "../src/core/store";
import type { ChatMessage, Task } from "../src/core/types";
import { Fake, makeRoom } from "./helpers";

class MemoryRoomStateStore implements RoomStateStore {
  messages: ChatMessage[] = [];
  tasks: Task[] = [];
  sessions: Record<string, string> = {};
  sessionMeta: Record<string, { persona: string; mem: string }> = {};
  cursors: Record<string, number> = {};
  schedules: ScheduleState = { lastRun: {}, disabled: [], last: {} };
  audits: object[] = [];

  loadMessages() { return structuredClone(this.messages); }
  appendMessage(message: ChatMessage) { this.messages.push(structuredClone(message)); }
  appendAudit(entry: object) { this.audits.push(structuredClone(entry)); }
  loadTasks() { return structuredClone(this.tasks); }
  saveTasks(tasks: Task[]) { this.tasks = structuredClone(tasks); }
  loadSessions() { return structuredClone(this.sessions); }
  saveSessions(sessions: Record<string, string>) { this.sessions = structuredClone(sessions); }
  loadSessionMeta() { return structuredClone(this.sessionMeta); }
  saveSessionMeta(metadata: Record<string, { persona: string; mem: string }>) { this.sessionMeta = structuredClone(metadata); }
  loadCursors() { return structuredClone(this.cursors); }
  saveCursors(cursors: Record<string, number>) { this.cursors = structuredClone(cursors); }
  loadSchedules() { return structuredClone(this.schedules); }
  saveSchedules(state: ScheduleState) { this.schedules = structuredClone(state); }
}

test("room storage contract: Room runs against a non-file adapter", async () => {
  const store = new MemoryRoomStateStore();
  const { room } = makeRoom(new Fake(), { store });
  const message = room.post("user", "hello", { to: [] });
  assert.equal(store.messages.at(-1)?.id, message.id);

  const task = room.createTask("user", { title: "contract" });
  assert.equal(store.tasks.at(-1)?.id, task.id);
  assert.equal(store.tasks.at(-1)?.title, "contract");
});
