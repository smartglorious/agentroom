// Bundles (1) the extension host code to CommonJS — the agent SDKs are ESM-only and ship native
// binaries, so they stay external and are loaded with dynamic import() — and (2) the runner that is
// copied to remote hosts: one self-contained ESM file with both SDKs inlined (it uses the host's own
// `claude` / `codex` CLIs, so no native binaries are needed).
import * as esbuild from "esbuild";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");
const bench = process.argv.includes("--bench");

const version = JSON.parse(readFileSync("package.json", "utf8")).version;
const define = { __AR_VERSION__: JSON.stringify(version) };
// `agentroom:plugins` is the list of plugins bundled into this build. The public tree has none (none.ts);
// a build that has src/plugins/private.ts uses that file instead, without touching any tracked file.
const pluginList = {
  name: "agentroom-plugins",
  setup(b) {
    b.onResolve({ filter: /^agentroom:plugins$/ }, () => ({ path: resolve(existsSync("src/plugins/private.ts") ? "src/plugins/private.ts" : "src/plugins/none.ts") }));
  },
};
const external = ["vscode", "@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@modelcontextprotocol/sdk", "@appthreat/sqlite3", "zod"];
const cjs = { plugins: [pluginList], define, bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true, external };
const esm = {
  plugins: [pluginList], define, bundle: true, platform: "node", target: "node20", format: "esm",
  banner: { js: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' },
};

const configs = bench
  ? [{ ...cjs, entryPoints: ["test/bench/main.ts"], outfile: "out-bench/main.js", sourcemap: false }]
  : tests
  ? [
      { ...cjs, entryPoints: readdirSync("test").filter((f) => f.endsWith(".test.ts") || f === "fake-runner-main.ts").map((f) => `test/${f}`), outdir: "out-test" },
      // the same runner as production, with a scripted adapter, as the file an ssh host would receive
      { ...esm, entryPoints: ["test/fake-runner-main.ts"], outfile: "out-test/fake-runner.mjs", external: ["vscode"] },
    ]
  : [
      { ...cjs, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" },
      { ...esm, entryPoints: ["src/remote/runner-main.ts"], outfile: "dist/runner.mjs" },
      // headless room (Telegram, schedules, webhooks): `node dist/daemon.mjs run` — also self-contained
      { ...esm, entryPoints: ["src/daemon/main.ts"], outfile: "dist/daemon.mjs", banner: { js: esm.banner.js } },
    ];

for (const c of configs) {
  if (watch) await (await esbuild.context(c)).watch();
  else await esbuild.build(c);
}
