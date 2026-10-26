// `npm run bench:room`: the same room, scripted model, legacy against durable. Costs nothing (no real model) and measures the machinery:
// time added per turn, errors under concurrency, turns that ran twice, recovery after a process died. It says nothing about answer quality or tokens.
import { SCENARIOS, runScenario, type Mode, type ScenarioName, type ScenarioResult } from "./scenarios";

const arg = (name: string, fallback: string) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const reps = Number(arg("reps", "5"));
const size = Number(arg("size", "6"));
const latencyMs = Number(arg("latency", "20"));
const maxOverheadMs = Number(arg("max-overhead-ms", "0"));
const only = arg("scenario", "");
const json = process.argv.includes("--json");

const quantile = (values: number[], q: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const fixed = (n: number) => n.toFixed(1);

const main = async () => {
  const names = SCENARIOS.filter((s) => !only || s === only) as ScenarioName[];
  const all: ScenarioResult[] = [];
  for (const scenario of names) {
    for (const mode of ["legacy", "durable"] as Mode[]) {
      for (let i = 0; i < reps; i += 1) all.push(await runScenario(scenario, mode, { latencyMs, size }));
    }
  }
  const rows = names.flatMap((scenario) => (["legacy", "durable"] as Mode[]).map((mode) => {
    const runs = all.filter((r) => r.scenario === scenario && r.mode === mode);
    const walls = runs.map((r) => r.wallMs);
    const perMessage = runs.flatMap((r) => r.latenciesMs);
    return {
      scenario, mode, runs: runs.length,
      wallMedianMs: quantile(walls, .5), wallP95Ms: quantile(walls, .95),
      messageMedianMs: quantile(perMessage, .5), messageP95Ms: quantile(perMessage, .95),
      turns: runs[0]?.turns ?? 0, expectedTurns: runs[0]?.expectedTurns ?? 0,
      extraTurns: runs.reduce((n, r) => n + r.extraTurns, 0),
      errors: runs.reduce((n, r) => n + r.errors.length, 0),
      failedRuns: runs.filter((r) => !r.ok).length,
    };
  }));
  const chat = (mode: Mode) => rows.find((r) => r.scenario === "chat" && r.mode === mode);
  const overheadMs = chat("legacy") && chat("durable")
    ? (chat("durable")!.messageMedianMs - chat("legacy")!.messageMedianMs) / 2
    : undefined;
  const failed = rows.some((r) => r.failedRuns > 0);
  const tooSlow = maxOverheadMs > 0 && overheadMs !== undefined && overheadMs > maxOverheadMs;

  if (json) {
    process.stdout.write(`${JSON.stringify({ schema_version: 1, benchmark: "room-harness", node: process.version, platform: process.platform,
      reps, size, latencyMs, overheadPerTurnMs: overheadMs, rows, ok: !failed && !tooSlow, measured_at: new Date().toISOString() }, null, 2)}\n`);
  } else {
    console.log(`room-harness: ${reps} runs per cell, model latency ${latencyMs} ms, chat size ${size}\n`);
    console.log("scenario  mode     wall med/p95 (ms)   per-message med/p95 (ms)   turns exp/extra   errors  failed");
    for (const r of rows) {
      console.log(`${r.scenario.padEnd(9)} ${r.mode.padEnd(8)} ${`${fixed(r.wallMedianMs)}/${fixed(r.wallP95Ms)}`.padEnd(19)} ${`${fixed(r.messageMedianMs)}/${fixed(r.messageP95Ms)}`.padEnd(26)} ${`${r.expectedTurns}/${r.extraTurns}`.padEnd(17)} ${String(r.errors).padEnd(7)} ${r.failedRuns}`);
    }
    if (overheadMs !== undefined) console.log(`\ndurable adds about ${fixed(overheadMs)} ms per turn over legacy (chat scenario, median).`);
    console.log(failed ? "\nFAILED: a scenario had errors, extra turns or a failed recovery." : tooSlow ? `\nFAILED: overhead above ${maxOverheadMs} ms per turn.` : "\nOK: no errors, no turn ran twice, recovery works.");
  }
  process.exit(failed || tooSlow ? 1 : 0);
};
void main();
