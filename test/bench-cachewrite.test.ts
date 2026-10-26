import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const load = async () => (await import(pathToFileURL(join(__dirname, "..", "scripts", "bench-cachewrite.mjs")).href)) as {
  analyze(rows: object[], o?: { ttlMin?: number; units?: number }): any;
  compare(a: any, b: any, max?: number): { ratio: number; pass: boolean; deltaPerUnit: number };
  parseUsage(t: string): object[];
};
const MIN = 60_000;
const row = (o: object) => ({ provider: "claude", account: "c", sessionKey: "be:main", sessionId: "s1", input: 5, output: 100, cacheRead: 0, cacheWrite: 0, durationMs: 10_000, estimated: false, ...o });

test("cache-write bench: first turn, cold resume and warm turns are told apart", async () => {
  const { analyze } = await load();
  const t0 = 1_000_000_000;
  const r = analyze([
    row({ ts: t0, cacheWrite: 44_000 }),                                  // new session
    row({ ts: t0 + 2 * MIN, cacheWrite: 9_000, cacheRead: 44_000 }),     // warm
    row({ ts: t0 + 90 * MIN, cacheWrite: 60_000 }),                       // idle 88 min: cold
    row({ ts: t0 + 92 * MIN, cacheWrite: 5_000, cacheRead: 60_000 }),     // warm again
    row({ ts: t0 + 93 * MIN, sessionId: "s2", cacheWrite: 43_000 }),      // another new session
  ], { units: 2 });
  assert.equal(r.parts.fresh.turns, 2);
  assert.equal(r.parts.fresh.cacheWrite, 87_000);
  assert.equal(r.parts.cold.turns, 1);
  assert.equal(r.parts.cold.cacheWrite, 60_000);
  assert.equal(r.parts.warm.cacheWrite, 14_000);
  assert.equal(r.cacheWrite, 161_000);
  assert.equal(r.perUnit.cacheWrite, 80_500, "per unit divides by the declared units");
  assert.equal(r.freshAvg, 43_500);
  assert.equal(r.sessions, 2);
});

test("cache-write bench: other endpoints, Codex, errors and estimates are not Claude plan usage", async () => {
  const { analyze } = await load();
  const r = analyze([
    row({ ts: 1, cacheWrite: 10 }),
    row({ ts: 2, provider: "codex", cacheWrite: 999 }),
    row({ ts: 3, error: "boom", cacheWrite: 999 }),
    row({ ts: 4, estimated: true, cacheWrite: 999 }),
  ]);
  assert.equal(r.cacheWrite, 10);
  assert.equal(r.turns, 1);
});

test("cache-write bench: a run passes only when its cache writes per unit stay within the limit of the baseline", async () => {
  const { analyze, compare } = await load();
  const legacy = analyze([row({ ts: 1, cacheWrite: 100_000 })], { units: 2 });
  const ok = analyze([row({ ts: 1, cacheWrite: 108_000 })], { units: 2 });
  const worse = analyze([row({ ts: 1, cacheWrite: 180_000 })], { units: 2 });
  assert.equal(compare(legacy, ok).pass, true);
  assert.equal(compare(legacy, worse).pass, false);
  assert.equal(compare(legacy, worse).ratio, 1.8);
  assert.equal(compare(legacy, worse, 2).pass, true, "the limit is configurable");
});

test("cache-write bench: broken lines in the log are skipped", async () => {
  const { parseUsage } = await load();
  assert.equal(parseUsage('{"a":1}\nnot json\n\n{"b":2}\n').length, 2);
});
