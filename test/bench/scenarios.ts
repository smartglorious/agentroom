import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../../src/core/config";
import { SqliteMigrationRunner } from "../../src/storage/migrations";
import { schemaMigrations } from "../../src/storage/schema-v1";
import { SqliteConnection } from "../../src/storage/sqlite";
import { DurableTurnQueue } from "../../src/storage/turn-queue";
import { Fake, idle, makeRoom } from "../helpers";

export type Mode = "legacy" | "durable";
export const SCENARIOS = ["chat", "burst", "longturn", "crash"] as const;
export type ScenarioName = (typeof SCENARIOS)[number];

export interface ScenarioOptions {
  /** Time the scripted model takes per turn. */
  latencyMs: number;
  /** Messages in `chat`, workers woken together in `burst`. */
  size: number;
}

export interface ScenarioResult {
  scenario: ScenarioName;
  mode: Mode;
  /** Wall time of the whole scenario. */
  wallMs: number;
  /** Per-message post → every worker idle, in `chat`. */
  latenciesMs: number[];
  turns: number;
  expectedTurns: number;
  /** Turns that ran beyond what the scenario should cause. */
  extraTurns: number;
  /** "hit an error" system messages. */
  errors: string[];
  /** `crash`: how many turns startup recovery found. */
  recovered?: number;
  ok: boolean;
}

const workersYaml = (n: number) => `accounts: { c: { provider: claude, maxConcurrent: ${Math.max(2, n)} } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true }
${Array.from({ length: n }, (_, i) => `  - { id: w${i}, name: W${i}, role: Dev, account: c }`).join("\n")}
`;

const errorsOf = (room: ReturnType<typeof makeRoom>["room"]) =>
  room.snapshot().messages.filter((m) => m.from === "system" && /hit an error|gặp lỗi/.test(m.text)).map((m) => m.text);

const openDb = async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-bench-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
  return db;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runScenario(scenario: ScenarioName, mode: Mode, opts: ScenarioOptions): Promise<ScenarioResult> {
  if (scenario === "crash") return await crash(mode);
  const db = mode === "durable" ? await openDb() : undefined;
  const leaseMs = scenario === "longturn" ? 900 : 30_000;
  try {
    const workers = scenario === "burst" ? opts.size : 2;
    const fake = new Fake(async (req) => {
      const long = scenario === "longturn" && req.worker.id === "w0";
      await pause(long ? leaseMs * 3 : opts.latencyMs);
      return "[NOOP]";
    });
    const { room } = makeRoom(fake, {
      config: parseConfig(workersYaml(workers)),
      ...(db ? { turnQueue: new DurableTurnQueue(db, "w1", { leaseMs }) } : {}),
    });
    const latenciesMs: number[] = [];
    let expectedTurns = 0;
    const started = performance.now();
    if (scenario === "chat") {
      for (let i = 0; i < opts.size; i += 1) {
        const t = performance.now();
        room.post("user", `@w0 @w1 tin số ${i}`);
        expectedTurns += 2;
        await idle(room);
        latenciesMs.push(performance.now() - t);
      }
    } else if (scenario === "burst") {
      room.post("user", Array.from({ length: workers }, (_, i) => `@w${i}`).join(" ") + " làm cùng lúc");
      expectedTurns = workers;
      await idle(room);
    } else {
      // w0's turn outlives its lease; w1 is woken meanwhile, and its claim runs recovery over every step.
      room.post("user", "@w0 việc dài");
      await pause(leaseMs * 1.5);
      room.post("user", "@w1 việc ngắn");
      expectedTurns = 2;
      await idle(room);
    }
    await pause(100);
    const errors = errorsOf(room);
    const turns = fake.calls.length;
    room.stopAll();
    return {
      scenario, mode, wallMs: performance.now() - started, latenciesMs, turns, expectedTurns,
      extraTurns: Math.max(0, turns - expectedTurns), errors, ok: errors.length === 0 && turns === expectedTurns,
    };
  } finally {
    await db?.close();
  }
}

/** A process died holding a lease; the next start must finish that turn once. Only durable mode can. */
async function crash(mode: Mode): Promise<ScenarioResult> {
  if (mode === "legacy") {
    return { scenario: "crash", mode, wallMs: 0, latenciesMs: [], turns: 0, expectedTurns: 0, extraTurns: 0, errors: [], ok: true };
  }
  const file = join(mkdtempSync(join(tmpdir(), "ar-bench-crash-")), "agentroom.db");
  let now = 100;
  const open = async () => {
    const db = await SqliteConnection.open(file);
    await new SqliteMigrationRunner(db, schemaMigrations).apply();
    await db.run("INSERT OR IGNORE INTO workspaces(id, name, root_uri, created_at, updated_at) VALUES ('w1', 'Workspace', 'file:///w1', 1, 1)");
    return db;
  };
  const started = performance.now();
  const first = await open();
  const message = { id: "m1", from: "user", to: ["lead"], text: "@lead việc dở", ts: 1, depth: 0, chain: "m1" } as never;
  const dying = new DurableTurnQueue(first, "w1", { now: () => now, leaseMs: 50 });
  const turn = await dying.enqueue({ workerId: "lead", sessionKey: "lead:main", messages: [message] });
  await dying.claim(turn, "dead-process");
  await first.close();
  now = 151;
  const second = await open();
  try {
    const fake = new Fake(() => "[NOOP]");
    const { room } = makeRoom(fake, { turnQueue: new DurableTurnQueue(second, "w1", { now: () => now, leaseMs: 50 }), now: () => now });
    const recovered = await room.recoverDurableTurns();
    await idle(room);
    const again = await room.recoverDurableTurns();
    const status = (await second.get<{ status: string }>("SELECT status FROM runs WHERE id = ?", [turn.runId]))?.status;
    room.stopAll();
    const errors = errorsOf(room);
    return {
      scenario: "crash", mode, wallMs: performance.now() - started, latenciesMs: [], turns: fake.calls.length, expectedTurns: 1,
      extraTurns: Math.max(0, fake.calls.length - 1), errors, recovered,
      ok: recovered === 1 && again === 0 && fake.calls.length === 1 && status === "succeeded" && errors.length === 0,
    };
  } finally {
    await second.close();
  }
}
