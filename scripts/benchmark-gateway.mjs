import { performance } from "node:perf_hooks";

const iterations = Number(process.env.AGENTROOM_BENCH_ITERATIONS ?? 100_000);
if (!Number.isSafeInteger(iterations) || iterations < 1) throw new Error("AGENTROOM_BENCH_ITERATIONS must be a positive integer");
const candidates = [
  { quality: .92, reliability: .99, cost: 240, latency: 900 },
  { quality: .84, reliability: .98, cost: 80, latency: 450 },
  { quality: .79, reliability: .96, cost: 40, latency: 300 },
];
const start = performance.now(); let checksum = 0;
for (let i = 0; i < iterations; i += 1) {
  let best = -Infinity;
  for (const item of candidates) best = Math.max(best, item.quality * 3 + item.reliability - item.cost / 240 * .2 - item.latency / 900 * .1);
  checksum += best;
}
const elapsedMs = performance.now() - start;
process.stdout.write(`${JSON.stringify({ schema_version: 1, benchmark: "gateway-route-score", node: process.version,
  platform: process.platform, arch: process.arch, iterations, candidates: candidates.length, elapsed_ms: Number(elapsedMs.toFixed(3)),
  routes_per_second: Math.round(iterations / (elapsedMs / 1000)), checksum: Number(checksum.toFixed(3)), measured_at: new Date().toISOString() }, null, 2)}\n`);
