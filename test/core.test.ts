import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, SAMPLE_CONFIG } from "../src/core/config";
import { parseMentions, route } from "../src/core/router";
import { RateLimitError, Scheduler } from "../src/core/scheduler";
import { TaskBoard } from "../src/core/tasks";
import { Room } from "../src/core/room";
import { RoomStore } from "../src/core/store";
import { AgentAdapter, TurnRequest } from "../src/adapters/types";

const cfg = parseConfig(SAMPLE_CONFIG);
const W = cfg.workers;

test("sample config parses and inherits provider from account", () => {
  assert.equal(W.length, 4);
  assert.equal(W.find((w) => w.id === "fe")!.provider, "codex");
  assert.equal(W.find((w) => w.id === "lead")!.coordinator, true);
});

test("mentions: ids, @all, ignores emails and unknown names", () => {
  assert.deepEqual(parseMentions("@be và @qa xem giúp", W), ["be", "qa"]);
  assert.deepEqual(parseMentions("mail a@be.com @nobody", W), []);
  assert.equal(parseMentions("@all", W).length, 4);
});

test("route: human without mention goes to coordinator; agents stop at hop limit", () => {
  const opts = { maxAgentHops: 3 };
  assert.deepEqual(route({ from: "user", text: "làm login", depth: 0 }, W, opts), ["lead"]);
  assert.deepEqual(route({ from: "be", text: "@qa test giúp @be", depth: 1 }, W, opts), ["qa"]);
  assert.deepEqual(route({ from: "be", text: "@qa", depth: 3 }, W, opts), []);
  assert.deepEqual(route({ from: "be", text: "xong rồi", depth: 1 }, W, opts), []);
});

test("tasks: dependencies block and unblock", () => {
  const b = new TaskBoard();
  const api = b.create({ title: "API", createdBy: "lead", assignee: "be" });
  const ui = b.create({ title: "UI", createdBy: "lead", assignee: "fe", dependsOn: [api.id] });
  assert.equal(ui.status, "blocked");
  assert.throws(() => b.claim(ui.id, "fe"));
  b.claim(api.id, "be");
  const ch = b.complete(api.id, "be", "ok");
  assert.deepEqual(ch.unblocked.map((t) => t.id), [ui.id]);
  assert.equal(b.get(ui.id)!.status, "todo");
});

test("scheduler: respects per-account concurrency", async () => {
  const s = new Scheduler();
  s.setLimit("a", 2);
  let live = 0, peak = 0;
  const job = () => s.submit("a", "k", async () => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 10)); live--; });
  await Promise.all([job(), job(), job(), job(), job()]);
  assert.equal(peak, 2);
});

test("scheduler: rate limit pauses the account and retries the job", async () => {
  const s = new Scheduler({ baseBackoffMs: 20 });
  let calls = 0, limited = 0;
  const t0 = Date.now();
  await s.submit("a", "k", async () => { if (++calls === 1) throw new RateLimitError("429"); }, () => limited++);
  assert.equal(calls, 2);
  assert.equal(limited, 1);
  assert.ok(Date.now() - t0 >= 15);
});

/** Fake adapter: replies by script, records prompts. */
class Fake implements AgentAdapter {
  prompts: { worker: string; prompt: string; session?: string }[] = [];
  constructor(private reply: (req: TurnRequest) => string) {}
  async runTurn(req: TurnRequest) {
    this.prompts.push({ worker: req.worker.id, prompt: req.prompt, session: req.sessionId });
    await new Promise((r) => setTimeout(r, 5));
    return { sessionId: `s-${req.worker.id}`, text: this.reply(req) };
  }
}

function makeRoom(fake: Fake, hops = 6) {
  return new Room({
    config: cfg,
    store: new RoomStore(mkdtempSync(join(tmpdir(), "agentroom-"))),
    adapters: { claude: fake, codex: fake },
    scheduler: new Scheduler(),
    options: { maxAgentHops: hops, contextMessages: 30 },
    resolveCwd: async () => tmpdir(),
    mcpUrl: (id) => `http://x/${id}`,
  });
}

const idle = (room: Room) => new Promise<void>((resolve) => {
  const check = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? resolve() : setTimeout(check, 10));
  setTimeout(check, 20);
});

test("room: lead delegates to be, be reports to qa, session is resumed", async () => {
  const fake = new Fake((req) => {
    if (req.worker.id === "lead") return req.prompt.includes("xong") ? "Tổng kết cho @user" : "@be làm API login";
    if (req.worker.id === "be") return "API xong, @qa kiểm tra giúp";
    if (req.worker.id === "qa") return "Test pass. @lead xong";
    return "";
  });
  const room = makeRoom(fake);
  room.post("user", "Làm tính năng login");
  await idle(room);
  assert.deepEqual(fake.prompts.map((p) => p.worker), ["lead", "be", "qa", "lead"]);
  assert.equal(fake.prompts[0].session, undefined);
  assert.equal(fake.prompts[3].session, "s-lead");
});

test("room: two agents pinging each other stop at the hop limit", async () => {
  const fake = new Fake((req) => (req.worker.id === "be" ? "@qa" : "@be"));
  const room = makeRoom(fake, 4);
  room.post("user", "@be bắt đầu");
  await idle(room);
  assert.equal(fake.prompts.length, 4);
});

test("room: assigning a task notifies the assignee on a separate task session", async () => {
  const fake = new Fake(() => "ok");
  const room = makeRoom(fake);
  const t = room.createTask("lead", { title: "Viết API", assignee: "be" });
  await idle(room);
  assert.equal(fake.prompts.length, 1);
  assert.match(fake.prompts[0].prompt, new RegExp(t.id));
});
