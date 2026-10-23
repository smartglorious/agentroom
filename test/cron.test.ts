import { test } from "node:test";
import assert from "node:assert/strict";
import { CronEngine, ScheduleState, describeCron } from "../src/core/cron";
import { parseConfig } from "../src/core/config";
import { ScheduleDef } from "../src/core/types";
import { Fake, idle, makeRoom } from "./helpers";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m, 0).getTime();

function engine(defs: Partial<ScheduleDef>[], opts: { now: { t: number }; busy?: (w: string, p: string) => boolean; initial?: Partial<ScheduleState> }) {
  const fired: { id: string; worker: string; taskId: string }[] = [];
  let saved: ScheduleState = { lastRun: {}, disabled: [], last: {}, ...opts.initial };
  const schedules = defs.map((d) => ({ cron: "0 2 * * *", worker: "qa", prompt: "p", session: "fresh", skipIfRunning: true, catchUpHours: 6, notify: false, enabled: true, ...d }) as ScheduleDef);
  const e = new CronEngine({
    schedules, workerIds: ["lead", "be", "qa"], now: () => opts.now.t,
    load: () => structuredClone(saved), save: (s) => { saved = structuredClone(s); },
    fire: (s, worker, taskId) => fired.push({ id: s.id, worker, taskId }),
    isBusy: opts.busy ?? (() => false),
  });
  return { e, fired, saved: () => saved };
}

test("cron: describes common expressions", () => {
  assert.equal(describeCron("0 2 * * 1-5"), "các ngày trong tuần lúc 02:00");
  assert.equal(describeCron("45 8 * * *"), "hằng ngày lúc 08:45");
  assert.equal(describeCron("*/15 * * * *"), "mỗi 15 phút");
  assert.equal(describeCron("0 */2 * * *"), "0 */2 * * *");
});

test("cron: first sight is not back-filled; fires at the scheduled time; only once", () => {
  const now = { t: at(23, 1, 0) };
  const { e, fired, saved } = engine([{ id: "n" }], { now });
  e.tick();
  assert.equal(fired.length, 0);
  assert.equal(saved().lastRun.n, now.t);
  now.t = at(23, 1, 59); e.tick();
  assert.equal(fired.length, 0);
  now.t = at(23, 2, 0, ); e.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].worker, "qa");
  now.t = at(23, 2, 1); e.tick(); now.t = at(23, 9, 0); e.tick();
  assert.equal(fired.length, 1);
  now.t = at(24, 2, 0); e.tick();
  assert.equal(fired.length, 2);
  assert.notEqual(fired[0].taskId, fired[1].taskId, "fresh session per run");
  assert.match(fired[0].taskId, /^sched-n~/);
});

test("cron: a run missed while VS Code was closed is caught up once if recent, skipped if too old", () => {
  const recent = engine([{ id: "n", catchUpHours: 6 }], { now: { t: at(23, 7, 0) }, initial: { lastRun: { n: at(22, 20, 0) } } });
  recent.e.tick(); recent.e.tick();
  assert.equal(recent.fired.length, 1, "02:00 was 5h ago → catch up exactly once");

  const old = engine([{ id: "n", catchUpHours: 6 }], { now: { t: at(23, 12, 0) }, initial: { lastRun: { n: at(22, 20, 0) } } });
  old.e.tick();
  assert.equal(old.fired.length, 0);
  assert.equal(old.saved().last.n.result, "missed");
  old.e.tick();
  assert.equal(old.fired.length, 0);
});

test("cron: timezone is honoured", () => {
  // 02:00 Asia/Ho_Chi_Minh (UTC+7) = 19:00 UTC of the previous day
  const base = Date.UTC(2026, 9, 22, 18, 59, 0);
  const now = { t: base };
  const { e, fired } = engine([{ id: "n", timezone: "Asia/Ho_Chi_Minh" }], { now });
  e.tick();
  now.t = base + 60_000; e.tick();
  assert.equal(fired.length, 1);
});

test('cron: worker "*" fires for every worker; skipIfRunning skips only the busy ones', () => {
  const now = { t: at(23, 1, 0) };
  const { e, fired, saved } = engine([{ id: "gc", worker: "*", builtin: "consolidate-memory", prompt: undefined }], { now, busy: (w) => w === "be" });
  e.tick();
  now.t = at(23, 3, 0); e.tick();
  assert.deepEqual(fired.map((f) => f.worker), ["lead", "qa"]);
  assert.deepEqual(saved().last.gc.workers, ["lead", "qa"]);
});

test("cron: persistent sessions reuse one task id; busy prefix is unambiguous", () => {
  const seen: string[] = [];
  const now = { t: at(23, 1, 0) };
  const { e, fired } = engine([{ id: "n", session: "persistent" }, { id: "n2" }], { now, busy: (_w, p) => { seen.push(p); return false; } });
  e.tick();
  now.t = at(23, 2, 30); e.tick();
  now.t = at(24, 2, 30); e.tick();
  const n = fired.filter((f) => f.id === "n");
  assert.equal(n.length, 2);
  assert.equal(n[0].taskId, "sched-n~p");
  assert.equal(n[1].taskId, "sched-n~p");
  assert.ok(seen.includes("sched-n~") && seen.includes("sched-n2~"));
});

test("cron: disabling stops runs; re-enabling does not replay the gap; runNow respects busy", () => {
  const now = { t: at(23, 1, 0) };
  let busy = false;
  const { e, fired, saved } = engine([{ id: "n" }], { now, busy: () => busy });
  e.tick();
  e.setEnabled("n", false);
  now.t = at(23, 3, 0); e.tick();
  assert.equal(fired.length, 0);
  assert.equal(e.statuses()[0].enabled, false);
  assert.equal(e.statuses()[0].nextRun, undefined);
  e.setEnabled("n", true);
  now.t = at(23, 4, 0); e.tick();
  assert.equal(fired.length, 0);
  assert.equal(e.runNow("n"), true);
  assert.equal(saved().last.n.result, "manual");
  busy = true;
  assert.equal(e.runNow("n"), false);
  assert.equal(saved().last.n.result, "busy");
  assert.throws(() => e.runNow("zzz"), /Không có lịch/);
  assert.equal(e.statuses()[0].nextRun, at(24, 2, 0));
});

test("cron: config validation rejects bad cron, unknown worker, and prompt/builtin mistakes", () => {
  const base = "accounts: { a: { provider: claude } }\nworkers: [{ id: be, name: B, role: R, account: a }]\n";
  assert.throws(() => parseConfig(base + "schedules: [{ id: x, worker: be, cron: 'nope', prompt: p }]"), /cron không hợp lệ/);
  assert.throws(() => parseConfig(base + "schedules: [{ id: x, worker: zz, cron: '0 2 * * *', prompt: p }]"), /không có worker/);
  assert.throws(() => parseConfig(base + "schedules: [{ id: x, worker: be, cron: '0 2 * * *' }]"), /prompt hoặc builtin/);
  assert.throws(() => parseConfig(base + "schedules: [{ id: x, worker: be, cron: '0 2 * * *', prompt: p, builtin: consolidate-memory }]"), /prompt hoặc builtin/);
  assert.throws(() => parseConfig(base + "schedules: [{ id: x, worker: be, cron: '0 2 * * *', timezone: 'Mars/Base', prompt: p }]"), /cron không hợp lệ/);
  const ok = parseConfig(base + "schedules: [{ id: x, worker: '*', cron: '0 3 * * *', builtin: consolidate-memory }]");
  assert.equal(ok.schedules[0].session, "fresh");
  assert.equal(ok.schedules[0].catchUpHours, 6);
});

test("cron + room: a fired schedule reaches only its worker, in its own session", async () => {
  const fake = new Fake(() => "đã chạy test");
  const { room } = makeRoom(fake);
  const now = { t: at(23, 1, 0) };
  const { e } = engine([{ id: "nightly", worker: "qa", prompt: "Chạy toàn bộ test @be @lead" }], { now });
  void e;
  room.post("system", "@qa [lịch nightly] Chạy toàn bộ test @be @lead", { taskId: "sched-nightly~abc", to: ["qa"] });
  await idle(room);
  assert.deepEqual(fake.calls.map((c) => c.worker.id), ["qa"], "@mentions inside the text must not wake anyone else");
  assert.equal(room.isActive("qa:sched-nightly~"), false);
});

test("cron: a schedule that throws at run time is isolated and reported; the others still fire", () => {
  const now = { t: at(23, 1, 0) };
  const bad = engine([{ id: "bad", timezone: "Mars/Base" }, { id: "good" }], { now });
  bad.e.tick();
  now.t = at(23, 3, 0); bad.e.tick();
  assert.deepEqual(bad.fired.map((f) => f.id), ["good"]);
  const st = bad.e.statuses().find((s) => s.id === "bad")!;
  assert.equal(st.lastResult, "error");
  assert.match(st.error!, /timezone/i);
  assert.equal(st.nextRun, undefined);
});
