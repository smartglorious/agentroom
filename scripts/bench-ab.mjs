#!/usr/bin/env node
// A/B with the REAL Claude CLI (haiku, an empty project): the same three-worker scenario in `legacy` and in `durable`, alternating, with a hard cap on cache writes.
// COSTS PLAN QUOTA. Run `--pilot` first (one legacy run) to see what a run costs, then size --reps and --cap from it.
//   node scripts/bench-ab.mjs --pilot
//   node scripts/bench-ab.mjs --reps 3 --cap 500000 [--out <dir>] [--json]
// The cap counts cache-write tokens of every run so far; before each run it checks that the cap would still hold if that run cost as much as the largest so far.
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, parseUsage } from "./bench-cachewrite.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback;
};
const pilot = process.argv.includes("--pilot");
const json = process.argv.includes("--json");
const reps = Number(arg("reps", "3"));
const cap = Number(arg("cap", "500000"));
const out = arg("out", mkdtempSync(join(tmpdir(), "bench-ab-")));

await build({
  entryPoints: ["scripts/live/bench-tokens.ts"], bundle: true, platform: "node", format: "esm", outfile: "out-test/bench-tokens.mjs",
  external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@modelcontextprotocol/sdk", "@appthreat/sqlite3", "zod"],
  banner: { js: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' },
});

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
const plan = pilot ? ["legacy"] : Array.from({ length: reps }, (_, i) => (i % 2 ? ["durable", "legacy"] : ["legacy", "durable"])).flat();
const runs = [];
let spent = 0, largest = 0;

for (const [i, mode] of plan.entries()) {
  if (spent + largest > cap) { console.error(`stop: ${spent} spent + ${largest} for one more run would pass the cap ${cap}`); break; }
  const dir = join(out, `${String(i + 1).padStart(2, "0")}-${mode}`);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const r = spawnSync(process.execPath, ["out-test/bench-tokens.mjs"], {
    encoding: "utf8", timeout: 15 * 60_000, env: { ...process.env, NODE_NO_WARNINGS: "1", BENCH_MODE: mode, BENCH_OUT: dir },
  });
  writeFileSync(join(dir, "stdout.txt"), r.stdout ?? "");
  const bench = Object.fromEntries((r.stdout ?? "").split("\n").filter((l) => l.startsWith("BENCH ")).map((l) => [l.slice(6, 40).trim(), l.slice(40).trim()]));
  let usage;
  try { usage = analyze(parseUsage(readFileSync(join(dir, "usage.jsonl"), "utf8"))); } catch { usage = undefined; }
  const run = {
    n: i + 1, mode, ok: r.status === 0 && !!usage, wallS: (Date.now() - started) / 1000,
    turns: usage?.turns ?? 0, errors: Number(bench.errors ?? 0), cacheWrite: usage?.cacheWrite ?? 0, cacheRead: usage?.cacheRead ?? 0,
    output: usage?.output ?? 0, sessions: usage?.sessions ?? 0, fileOk: bench["final file exists with sub()"] === "yes",
    costUsd: Number(bench["cost USD (CLI estimate)"] ?? 0), dir,
  };
  runs.push(run);
  spent += run.cacheWrite;
  largest = Math.max(largest, run.cacheWrite);
  console.error(`run ${run.n} ${mode}: ${run.ok ? "ok" : "FAILED"} cacheWrite ${run.cacheWrite} turns ${run.turns} errors ${run.errors} wall ${run.wallS.toFixed(0)}s (spent ${spent}/${cap})`);
  if (!run.ok) { console.error((r.stderr ?? "").split("\n").slice(-5).join("\n")); break; }
}

const by = (mode) => runs.filter((r) => r.mode === mode && r.ok);
const sum = (mode) => {
  const v = by(mode);
  return { runs: v.length, cacheWriteMedian: median(v.map((r) => r.cacheWrite)), outputMedian: median(v.map((r) => r.output)), turnsMedian: median(v.map((r) => r.turns)),
    wallMedianS: median(v.map((r) => r.wallS)), errors: v.reduce((n, r) => n + r.errors, 0), fileOk: v.every((r) => r.fileOk), cacheWriteAll: v.map((r) => r.cacheWrite) };
};
const result = { schema_version: 1, benchmark: "live-ab", model: "haiku", cap, spent, out, runs, legacy: sum("legacy"), durable: sum("durable"), ratioCacheWrite: undefined };
if (result.legacy.runs && result.durable.runs) result.ratioCacheWrite = +(result.durable.cacheWriteMedian / result.legacy.cacheWriteMedian).toFixed(3);
writeFileSync(join(out, "result.json"), JSON.stringify(result, null, 2));
if (json) console.log(JSON.stringify(result, null, 2));
else {
  console.log(`live A/B (haiku, empty project), ${runs.length} runs, ${spent} cache-write tokens spent of cap ${cap}; files in ${out}\n`);
  for (const m of ["legacy", "durable"]) {
    const s = result[m];
    if (s.runs) console.log(`${m.padEnd(8)} runs ${s.runs}  cacheWrite median ${s.cacheWriteMedian} (${s.cacheWriteAll.join(", ")})  turns ${s.turnsMedian}  output ${s.outputMedian}  wall ${s.wallMedianS.toFixed(0)}s  errors ${s.errors}  file ok ${s.fileOk}`);
  }
  if (result.ratioCacheWrite !== undefined) console.log(`\ndurable / legacy cache-write (median): x${result.ratioCacheWrite}`);
}
process.exit(runs.every((r) => r.ok) ? 0 : 1);
