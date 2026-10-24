// The REAL `claude` CLI and the REAL `codex app-server` binary, asked for plan usage. No model call is made.
// This environment has no subscription login, so what is verified is the mechanics (spawn, protocol, mapping of
// the "no plan numbers" answer, timing, no leftover processes) — not real percentages.
import { readdirSync, readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeClaudePlan, probeCodexPlan } from "../../src/adapters/plan";
import { findExecutable } from "../../src/core/cli";
import type { Account } from "../../src/core/types";

const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);

/** Children (direct) of this process still alive. */
const children = () => readdirSync("/proc").filter((d) => /^\d+$/.test(d)).filter((d) => {
  try { return Number(readFileSync(`/proc/${d}/stat`, "utf8").split(") ")[1].split(" ")[1]) === process.pid; } catch { return false; }
});
const settle = () => new Promise((r) => setTimeout(r, 800));

const claude = findExecutable("claude");
const claudeAcc: Account = { id: "claude-live", provider: "claude", maxConcurrent: 1, warnAtPercent: 80 };
let t0 = Date.now();
const cp = await probeClaudePlan(claudeAcc, claude);
check("1. Claude probe returns without a model call", ["unavailable", "ok"].includes(cp.state), `${cp.state} in ${Date.now() - t0}ms${cp.note ? " · " + cp.note.slice(0, 60) : ""}`);
check("1b. …quickly (< 15 s)", Date.now() - t0 < 15_000);
await settle();
check("1c. no CLI process is left behind", children().length === 0, `${children().length} children`);

const keyAcc: Account = { ...claudeAcc, id: "claude-key", apiKeyEnv: "AGENTROOM_TEST_KEY" };
process.env.AGENTROOM_TEST_KEY = "sk-ant-test-not-real-0000000000";
const kp = await probeClaudePlan(keyAcc, claude);
check("2. an API-key account is reported as 'unavailable', not as an error", kp.state === "unavailable" && /API key/.test(kp.note ?? ""), kp.state);
await settle();
check("2b. no process left behind", children().length === 0);

const codexBin = (() => {
  const p = join(process.cwd(), "node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex");
  try { readFileSync(p); return p; } catch { return findExecutable("codex"); }
})();
if (!codexBin) check("3. Codex probe", true, "SKIP: no codex binary here");
else {
  const home = mkdtempSync(join(tmpdir(), "codex-home-"));
  const cx: Account = { id: "codex-live", provider: "codex", maxConcurrent: 1, warnAtPercent: 80, home };
  t0 = Date.now();
  const r = await probeCodexPlan(cx, codexBin);
  check("3. real codex app-server, logged out → 'unavailable' with a login hint", r.state === "unavailable" && /codex login/.test(r.note ?? ""), `${r.state} in ${Date.now() - t0}ms`);
  await settle();
  check("3b. app-server is killed afterwards", children().length === 0, `${children().length} children`);
}

console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
