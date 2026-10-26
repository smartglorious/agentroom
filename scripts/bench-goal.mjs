#!/usr/bin/env node
// Goal-level measurement with the REAL Claude CLI (haiku): give the room a goal in a small project with seeded problems and record
// whether it got solved (hidden tests), how much human help it needed (denied approvals + questions), and the quota it used.
// COSTS PLAN QUOTA. `--pilot` runs one goal once.
//   node scripts/bench-goal.mjs --pilot [--goal auth]
//   node scripts/bench-goal.mjs --goals auth,cart --reps 2 --cap 800000 --mode durable [--out <dir>]
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : fallback; };
const pilot = process.argv.includes("--pilot");
const goals = pilot ? [arg("goal", "auth")] : arg("goals", "auth,cart").split(",");
const reps = pilot ? 1 : Number(arg("reps", "2"));
const cap = Number(arg("cap", "800000"));
const mode = arg("mode", "durable");
const out = arg("out", mkdtempSync(join(tmpdir(), "bench-goal-")));

await build({
  entryPoints: ["scripts/live/bench-goal.ts"], bundle: true, platform: "node", format: "esm", outfile: "out-test/bench-goal.mjs",
  external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@modelcontextprotocol/sdk", "@appthreat/sqlite3", "zod"],
  banner: { js: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' },
});

const plan = Array.from({ length: reps }, () => goals).flat();
const runs = [];
let spent = 0, largest = 0;
for (const [i, goal] of plan.entries()) {
  if (spent + largest > cap) { console.error(`stop: ${spent} spent + ${largest} for one more run would pass the cap ${cap}`); break; }
  const dir = join(out, `${String(i + 1).padStart(2, "0")}-${goal}`);
  mkdirSync(dir, { recursive: true });
  const r = spawnSync(process.execPath, ["out-test/bench-goal.mjs"], {
    encoding: "utf8", timeout: 14 * 60_000, env: { ...process.env, NODE_NO_WARNINGS: "1", BENCH_GOAL: goal, BENCH_MODE: mode, BENCH_OUT: dir },
  });
  writeFileSync(join(dir, "stdout.txt"), r.stdout ?? "");
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  const res = line ? JSON.parse(line.slice(7)) : { goal, error: (r.stderr ?? "").split("\n").slice(-4).join(" "), cacheWrite: 0 };
  runs.push(res);
  spent += res.cacheWrite ?? 0;
  largest = Math.max(largest, res.cacheWrite ?? 0);
  console.error(`run ${i + 1} ${goal}: ${line ? `solved ${res.solved} (hidden ${res.hiddenPass}/${res.hiddenTotal}) turns ${res.turns} cacheWrite ${res.cacheWrite} interventions ${res.interventions} wall ${res.wallS}s${res.timedOut ? " TIMED OUT" : ""}` : "FAILED " + res.error} (spent ${spent}/${cap})`);
  if (!line) break;
}
writeFileSync(join(out, "result.json"), JSON.stringify({ schema_version: 1, benchmark: "goal", model: "haiku", mode, cap, spent, runs }, null, 2));
console.log(JSON.stringify({ out, spent, runs }, null, 2));
