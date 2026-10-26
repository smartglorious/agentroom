#!/usr/bin/env node
// Measures what drains a Claude plan from a usage.jsonl (cache writes) and compares two runs of the same scenario.
// Offline: reads files, calls no model.
//   node scripts/bench-cachewrite.mjs <usage.jsonl> [--label legacy] [--units 3]
//        [--compare <usage.jsonl> --compare-label durable] [--ttl-min 60] [--max-ratio 1.10] [--json]
// `units` = how many completed scenario units (tasks / golden journeys) the run covers, so runs of different length compare fairly.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const num = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

export function parseUsage(text) {
  return text.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}

/** Claude rows only (not Codex, not another endpoint's estimate), without errors; oldest first. */
export function claudeRows(rows) {
  return rows
    .filter((r) => r && r.provider === "claude" && !r.error && !r.estimated && num(r.cacheRead) + num(r.cacheWrite) + num(r.input) > 0)
    .sort((a, b) => a.ts - b.ts);
}

/**
 * Splits cache writes into: the first turn of every session (the fixed cost of starting one), a cold resume
 * (the session was idle past the cache lifetime, so all of it was written again) and everything else (warm turns).
 */
export function analyze(rows, { ttlMin = 60, units = 1 } = {}) {
  const used = claudeRows(rows);
  const lastEnd = new Map();
  const seen = new Set();
  const total = { turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const parts = {
    fresh: { turns: 0, cacheWrite: 0 },
    cold: { turns: 0, cacheWrite: 0 },
    warm: { turns: 0, cacheWrite: 0 },
  };
  const sessions = new Set();
  for (const r of used) {
    const key = `${r.account}|${r.sessionKey}`;
    const session = `${key}|${r.sessionId ?? ""}`;
    const cw = num(r.cacheWrite);
    total.turns++; total.input += num(r.input); total.output += num(r.output); total.cacheRead += num(r.cacheRead); total.cacheWrite += cw;
    let kind = "warm";
    if (!seen.has(session)) { kind = "fresh"; seen.add(session); sessions.add(session); }
    else if (lastEnd.has(key) && r.ts - lastEnd.get(key) > ttlMin * 60_000) kind = "cold";
    parts[kind].turns++; parts[kind].cacheWrite += cw;
    lastEnd.set(key, r.ts + num(r.durationMs));
  }
  const u = Math.max(1, units);
  return {
    units: u,
    ttlMin,
    ...total,
    sessions: sessions.size,
    parts,
    perUnit: { cacheWrite: Math.round(total.cacheWrite / u), output: Math.round(total.output / u), turns: +(total.turns / u).toFixed(2) },
    freshAvg: parts.fresh.turns ? Math.round(parts.fresh.cacheWrite / parts.fresh.turns) : 0,
  };
}

/** `b` is acceptable against `a` when its cache writes per unit are within `maxRatio` of `a`'s (default +10%). */
export function compare(a, b, maxRatio = 1.1) {
  const ratio = a.perUnit.cacheWrite ? b.perUnit.cacheWrite / a.perUnit.cacheWrite : Infinity;
  return { ratio: +ratio.toFixed(3), maxRatio, pass: ratio <= maxRatio, deltaPerUnit: b.perUnit.cacheWrite - a.perUnit.cacheWrite };
}

const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n));
export function render(label, r) {
  const pct = (n) => (r.cacheWrite ? Math.round((100 * n) / r.cacheWrite) : 0);
  return [
    `## ${label}`,
    `turns ${r.turns} · sessions ${r.sessions} · units ${r.units}`,
    `cacheWrite ${k(r.cacheWrite)} (${k(r.perUnit.cacheWrite)} / unit) · cacheRead ${k(r.cacheRead)} · output ${k(r.output)} (${k(r.perUnit.output)} / unit) · turns / unit ${r.perUnit.turns}`,
    `  first turn of a session: ${r.parts.fresh.turns} turns, ${k(r.parts.fresh.cacheWrite)} (${pct(r.parts.fresh.cacheWrite)}%), avg ${k(r.freshAvg)}`,
    `  cold resume (idle > ${r.ttlMin} min): ${r.parts.cold.turns} turns, ${k(r.parts.cold.cacheWrite)} (${pct(r.parts.cold.cacheWrite)}%)`,
    `  warm turns: ${r.parts.warm.turns} turns, ${k(r.parts.warm.cacheWrite)} (${pct(r.parts.warm.cacheWrite)}%)`,
  ].join("\n");
}

function main(argv) {
  const opt = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") opt.json = true;
    else if (a.startsWith("--")) opt[a.slice(2)] = argv[++i];
    else files.push(a);
  }
  if (!files.length) { console.error("usage: bench-cachewrite.mjs <usage.jsonl> [--label A] [--units N] [--compare <usage.jsonl> --compare-label B] [--ttl-min 60] [--max-ratio 1.10] [--json]"); process.exit(2); }
  const ttlMin = Number(opt["ttl-min"] ?? 60);
  const a = analyze(parseUsage(readFileSync(files[0], "utf8")), { ttlMin, units: Number(opt.units ?? 1) });
  const out = { a };
  const lines = [render(opt.label ?? "A", a)];
  if (opt.compare) {
    const b = analyze(parseUsage(readFileSync(opt.compare, "utf8")), { ttlMin, units: Number(opt["compare-units"] ?? opt.units ?? 1) });
    const c = compare(a, b, Number(opt["max-ratio"] ?? 1.1));
    out.b = b; out.compare = c;
    lines.push(render(opt["compare-label"] ?? "B", b), `\n## ${opt["compare-label"] ?? "B"} vs ${opt.label ?? "A"}: cacheWrite per unit x${c.ratio} (limit x${c.maxRatio}) → ${c.pass ? "PASS" : "FAIL"}`);
  }
  console.log(opt.json ? JSON.stringify(out, null, 2) : lines.join("\n"));
  if (out.compare && !out.compare.pass) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2));
