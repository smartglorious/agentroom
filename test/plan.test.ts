import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeCodexPlan } from "../src/adapters/plan";
import { planText } from "../src/channels/telegram/service";
import { PlanMonitor, PlanUsage, classify, fromClaudeUsage, fromCodexLimits, untilText } from "../src/core/plan";
import type { Account } from "../src/core/types";
import { Fake, idle, makeRoom } from "./helpers";

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const H = 3600_000;
const acc = (id: string, over: Partial<Account> = {}): Account => ({ id, provider: "claude", maxConcurrent: 1, warnAtPercent: 80, ...over });

// ------------------------------------------------------------------ mapping

test("plan: Claude usage maps windows, model-scoped rows and extra usage; API-key logins are 'unavailable'", () => {
  const none = fromClaudeUsage("c", { subscription_type: null, rate_limits_available: false, rate_limits: null }, NOW);
  assert.deepEqual([none.state, none.windows.length], ["unavailable", 0]);
  assert.match(none.note!, /API key/);

  const p = fromClaudeUsage("c", {
    subscription_type: "max", rate_limits_available: true,
    rate_limits: {
      five_hour: { utilization: 42.349, resets_at: "2026-10-24T14:13:00Z" },
      seven_day: { utilization: 130, resets_at: "2026-10-30T00:00:00Z" },
      seven_day_opus: null,
      seven_day_sonnet: { utilization: null, resets_at: null },
      some_new_window: { utilization: 5, resets_at: null },
      model_scoped: [{ display_name: "Fable", utilization: 9, resets_at: "2026-10-30T00:00:00Z" }],
      extra_usage: { is_enabled: true, monthly_limit: 50, used_credits: 12.5, utilization: 25, currency: "USD" },
    },
  }, NOW);
  assert.equal(p.plan, "max");
  const by = Object.fromEntries(p.windows.map((w) => [w.key, w]));
  assert.equal(by.five_hour.usedPercent, 42.3);
  assert.equal(by.five_hour.label, "5 giờ");
  assert.equal(by.five_hour.resetsAt, Date.UTC(2026, 9, 24, 14, 13));
  assert.equal(by.seven_day.usedPercent, 100, "clamped");
  assert.ok(by.some_new_window, "unknown windows are kept");
  assert.ok(!by.seven_day_opus && !by.seven_day_sonnet, "null / empty windows are dropped");
  assert.equal(by["model:Fable"].label, "7 ngày · Fable");
  assert.equal(by.extra_usage.usedPercent, 25);
  assert.match(p.note!, /12\.5 \/ 50 USD/);
});

test("plan: Codex limits map primary/secondary windows (seconds → ms), several buckets, and 'reached'", () => {
  const one = fromCodexLimits("x", { rateLimits: { planType: "pro", primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1_792_000_000 }, secondary: { usedPercent: 55, windowDurationMins: 10080, resetsAt: 1_792_500_000 } } }, NOW);
  assert.equal(one.state, "ok");
  assert.equal(one.plan, "pro");
  assert.deepEqual(one.windows.map((w) => [w.label, w.usedPercent, w.resetsAt]), [["5 giờ", 30, 1_792_000_000_000], ["7 ngày", 55, 1_792_500_000_000]]);

  const multi = fromCodexLimits("x", {
    rateLimits: { primary: { usedPercent: 1 } },
    rateLimitsByLimitId: { codex: { limitId: "codex", limitName: "Codex", primary: { usedPercent: 10, windowDurationMins: 300 } }, spark: { limitId: "spark", limitName: "Spark", primary: { usedPercent: 99, windowDurationMins: 60 }, rateLimitReachedType: "rate_limit_reached" } },
  }, NOW);
  assert.equal(multi.state, "limited");
  assert.deepEqual(multi.windows.map((w) => w.label), ["5 giờ · Codex", "1 giờ · Spark"]);

  assert.equal(fromCodexLimits("x", {}, NOW).state, "unavailable");
  assert.equal(fromCodexLimits("x", { rateLimits: { primary: null, secondary: null } }, NOW).windows.length, 0);
});

test("plan: classification uses the account's warning level; countdown text", () => {
  const mk = (...pct: number[]): PlanUsage => ({ account: "a", provider: "claude", state: "ok", fetchedAt: NOW, windows: pct.map((p, i) => ({ key: `w${i}`, label: "w", usedPercent: p })) });
  assert.deepEqual([classify(mk(10, 79), 80).state, classify(mk(10, 80), 80).state, classify(mk(100), 80).state, classify(mk(50), 40).state], ["ok", "warning", "limited", "warning"]);
  assert.equal(classify({ ...mk(99), state: "unavailable" }, 80).state, "unavailable");
  assert.deepEqual([untilText(NOW + 5 * 60_000, NOW), untilText(NOW + 2 * H + 13 * 60_000, NOW), untilText(NOW + 3 * 24 * H, NOW), untilText(NOW - 1, NOW), untilText(undefined, NOW)], ["5 phút", "2 giờ 13 phút", "3 ngày", "đang reset", ""]);
});

// ------------------------------------------------------------------ monitor

function monitorRig(opts: { accounts?: Account[]; minGapMs?: number } = {}) {
  const clock = { t: NOW };
  const alerts: string[] = [], pauses: [string, number][] = [], calls: string[] = [];
  let reply: (a: Account) => PlanUsage | Error = (a) => ({ account: a.id, provider: a.provider, state: "ok", fetchedAt: clock.t, windows: [{ key: "five_hour", label: "5 giờ", usedPercent: 10, resetsAt: clock.t + 3 * H }] });
  const m = new PlanMonitor({
    accounts: opts.accounts ?? [acc("c1")],
    now: () => clock.t, pollMs: () => 0, minGapMs: opts.minGapMs ?? 1000,
    probe: async (a) => { calls.push(a.id); const r = reply(a); if (r instanceof Error) throw r; return r; },
    alert: (t) => alerts.push(t), pause: (id, until) => pauses.push([id, until]),
  });
  return { m, clock, alerts, pauses, calls, set: (f: typeof reply) => { reply = f; } };
}
const usedBy = (pct: number, resetsAt: number, key = "five_hour") => (a: Account): PlanUsage => ({ account: a.id, provider: a.provider, state: "ok", fetchedAt: NOW, windows: [{ key, label: "5 giờ", usedPercent: pct, resetsAt }] });

test("plan monitor: warns once per window and reset period, again after the window resets", async () => {
  const r = monitorRig();
  r.set(usedBy(85, NOW + 2 * H));
  await r.m.refresh(undefined, true);
  await r.m.refresh(undefined, true);
  assert.equal(r.alerts.length, 1, "no repeat for the same period");
  assert.match(r.alerts[0], /85%/);
  assert.equal(r.m.list()[0].state, "warning");
  r.set(usedBy(86, NOW + 7 * H));          // the window rolled over and filled up again
  await r.m.refresh(undefined, true);
  assert.equal(r.alerts.length, 2, "new reset period → new alert");
});

test("plan monitor: a full window alerts once and pauses the account until it resets", async () => {
  const r = monitorRig();
  r.set(usedBy(100, NOW + 90 * 60_000));
  await r.m.refresh(undefined, true);
  await r.m.refresh(undefined, true);
  assert.equal(r.alerts.length, 1);
  assert.match(r.alerts[0], /hết hạn mức/);
  assert.deepEqual(r.pauses, [["c1", NOW + 90 * 60_000]]);
  assert.equal(r.m.list()[0].state, "limited");
  // a full window whose reset time is already past must not pause anything
  const r2 = monitorRig();
  r2.set(usedBy(100, NOW - 1000));
  await r2.m.refresh(undefined, true);
  assert.deepEqual(r2.pauses, []);
});

test("plan monitor: probes are spaced out, deduplicated while running, and forced on demand", async () => {
  const r = monitorRig({ minGapMs: 120_000 });
  await Promise.all([r.m.refresh("c1"), r.m.refresh("c1"), r.m.refresh("c1")]);
  assert.equal(r.calls.length, 1, "concurrent calls share one probe");
  r.m.touch("c1");
  await r.m.refresh("c1");
  assert.equal(r.calls.length, 1, "inside the gap: no new probe");
  r.clock.t += 121_000;
  await r.m.refresh("c1");
  assert.equal(r.calls.length, 2, "after the gap: probes again");
  await r.m.refresh("c1", true);
  assert.equal(r.calls.length, 3, "force ignores the gap");
});

test("plan monitor: a failing probe keeps the last good numbers; unavailable and remote accounts never alert or call the probe", async () => {
  const r = monitorRig({ accounts: [acc("c1"), acc("far", { host: "gpu" })] });
  await r.m.refresh(undefined, true);
  assert.deepEqual(r.calls, ["c1"], "the remote account is not probed from here");
  const far = r.m.list().find((p) => p.account === "far")!;
  assert.equal(far.state, "unavailable");
  assert.match(far.note!, /gpu/);

  const good = r.m.list().find((p) => p.account === "c1")!;
  r.set(() => new Error("usage endpoint rate limited"));
  await r.m.refresh("c1", true);
  const kept = r.m.list().find((p) => p.account === "c1")!;
  assert.deepEqual(kept.windows, good.windows, "numbers survive a failed refresh");
  assert.equal(kept.fetchedAt, good.fetchedAt, "…and their age is still visible");
  assert.match(kept.note!, /rate limited/);

  const fresh = monitorRig();
  fresh.set(() => new Error("boom"));
  await fresh.m.refresh(undefined, true);
  assert.equal(fresh.m.list()[0].state, "error");
  assert.deepEqual([fresh.alerts, fresh.pauses], [[], []]);

  const unavailable = monitorRig();
  unavailable.set((a) => ({ account: a.id, provider: a.provider, state: "unavailable", windows: [], fetchedAt: NOW, note: "API key" }));
  await unavailable.m.refresh(undefined, true);
  assert.deepEqual([unavailable.alerts, unavailable.pauses], [[], []]);
});

test("plan monitor: emits change and lists every account even before the first read", async () => {
  const r = monitorRig({ accounts: [acc("a"), acc("b", { provider: "codex" })] });
  assert.deepEqual(r.m.list().map((p) => [p.account, p.state]), [["a", "unavailable"], ["b", "unavailable"]]);
  let changes = 0;
  r.m.on("change", () => changes++);
  await r.m.refresh(undefined, true);
  assert.ok(changes >= 2);
  assert.ok(r.m.list().every((p) => p.state === "ok"));
});

// ------------------------------------------------------------------ room + telegram text

test("plan in a room: a finished turn refreshes the account, the snapshot carries it, and the UI is told", async () => {
  let n = 0;
  const probe = async (a: Account): Promise<PlanUsage> => ({ account: a.id, provider: a.provider, state: "ok", fetchedAt: Date.now(), windows: [{ key: "five_hour", label: "5 giờ", usedPercent: 10 + 10 * ++n }] });
  const { room } = makeRoom(new Fake(() => "xong"), { planProbe: probe });
  let events = 0;
  room.on("plan", () => events++);
  room.post("user", "@be làm việc");
  await idle(room);
  await new Promise((r) => setTimeout(r, 30));
  const plans = room.snapshot().plans;
  assert.ok(plans.length >= 1 && plans.some((p) => p.windows.length === 1), "snapshot has plan numbers");
  assert.ok(events >= 1);
  const noProbe = makeRoom(new Fake(() => "ok")).room;
  assert.deepEqual(noProbe.snapshot().plans, [], "no probe configured → no plan section");
});

test("plan: Telegram text shows what is left and when it resets, and flags stale numbers", () => {
  const txt = planText([
    { account: "claude-main", provider: "claude", state: "warning", plan: "max", fetchedAt: NOW, windows: [{ key: "a", label: "5 giờ", usedPercent: 85, resetsAt: NOW + 2 * H + 13 * 60_000 }, { key: "b", label: "7 ngày", usedPercent: 20 }] },
    { account: "gpt", provider: "codex", state: "unavailable", windows: [], fetchedAt: NOW - 90 * 60_000, note: "Codex chưa đăng nhập" },
  ], NOW);
  assert.match(txt, /🟡 claude-main \(claude, gói max\)/);
  assert.match(txt, /5 giờ: còn 15% · reset sau 2 giờ 13 phút/);
  assert.match(txt, /7 ngày: còn 80%\n/);
  assert.match(txt, /⚪ gpt \(codex\)\n  Codex chưa đăng nhập\n  \(số liệu cũ: 90 phút trước\)/);
});

// ------------------------------------------------------------------ codex app-server probe (a scripted stand-in speaking the same JSON-RPC)

function fakeAppServer(script: string) {
  const f = join(mkdtempSync(join(tmpdir(), "codexfake-")), "codex");
  writeFileSync(f, `#!/usr/bin/env node\nprocess.stdin.setEncoding("utf8");let b="";const out=(o)=>process.stdout.write(JSON.stringify(o)+"\\n");\nprocess.stdin.on("data",(d)=>{b+=d;let i;while((i=b.indexOf("\\n"))>=0){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);${script}}});\n`);
  chmodSync(f, 0o755);
  return f;
}
const handshake = (rateLimits: string) => `if(m.method==="initialize")out({id:m.id,result:{userAgent:"x"}});else if(m.method==="account/rateLimits/read")${rateLimits};`;

test("codex probe: initialize → initialized → rateLimits/read, result mapped", { skip: process.platform === "win32" }, async () => {
  const bin = fakeAppServer(handshake(`out({id:m.id,result:{rateLimits:{planType:"plus",primary:{usedPercent:61,windowDurationMins:300,resetsAt:1792000000}}}})`));
  const p = await probeCodexPlan(acc("g", { provider: "codex" }), bin, () => NOW, 5000);
  assert.deepEqual([p.state, p.plan, p.windows[0].usedPercent, p.windows[0].label], ["ok", "plus", 61, "5 giờ"]);
});

test("codex probe: logged-out / API-key homes are 'unavailable' with a hint; other errors are errors; a dead or silent server rejects", { skip: process.platform === "win32" }, async () => {
  const a = acc("g", { provider: "codex" });
  const auth = await probeCodexPlan(a, fakeAppServer(handshake(`out({id:m.id,error:{code:-32600,message:"codex account authentication required to read rate limits"}})`)), () => NOW, 5000);
  assert.equal(auth.state, "unavailable");
  assert.match(auth.note!, /codex login/);
  const other = await probeCodexPlan(a, fakeAppServer(handshake(`out({id:m.id,error:{code:-1,message:"backend exploded sk-abcdefghijklmnop"}})`)), () => NOW, 5000);
  assert.equal(other.state, "error");
  assert.ok(!other.note!.includes("sk-abcdefghijklmnop"), "secrets are scrubbed from the note");
  await assert.rejects(probeCodexPlan(a, fakeAppServer(`process.exit(3)`), () => NOW, 5000), /thoát đột ngột/);
  await assert.rejects(probeCodexPlan(a, fakeAppServer(`/* never answers */`), () => NOW, 300), /không có phản hồi/);
  await assert.rejects(probeCodexPlan(a, "/nonexistent/codex", () => NOW, 2000), /ENOENT/);
});
