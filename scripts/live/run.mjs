// Live end-to-end checks against the REAL Claude Code CLI (costs a few cents, needs `claude` logged in).
//   npm run test:live            all scenarios
//   npm run test:live -- webhook only scenarios whose file name contains "webhook"
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const filter = process.argv[2];
const files = readdirSync("scripts/live").filter((f) => f.startsWith("e2e-") && f.endsWith(".ts") && (!filter || f.includes(filter)));
let failed = 0;
for (const f of files) {
  const out = `out-test/${f.replace(/\.ts$/, ".mjs")}`;
  await build({
    entryPoints: [`scripts/live/${f}`], bundle: true, platform: "node", format: "esm", outfile: out,
    external: ["@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@modelcontextprotocol/sdk", "zod"],
    banner: { js: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' },
  });
  console.log(`\n=== ${f} ===`);
  const r = spawnSync(process.execPath, [out], { stdio: ["ignore", "pipe", "inherit"], encoding: "utf8", env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  process.stdout.write((r.stdout ?? "").split("\n").filter((l) => /^(PASS|FAIL|total cost|\s+\[)/.test(l)).map((l) => l.slice(0, 220)).join("\n") + "\n");
  if (r.status !== 0) failed++;
}
console.log(failed ? `\n${failed} scenario(s) FAILED` : "\nAll live scenarios passed");
process.exit(failed ? 1 : 0);
