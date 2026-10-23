// Bundles (1) the extension host code to CommonJS — the agent SDKs are ESM-only and ship native
// binaries, so they stay external and are loaded with dynamic import() — and (2) the runner that is
// copied to remote hosts: one self-contained ESM file with both SDKs inlined (it uses the host's own
// `claude` / `codex` CLIs, so no native binaries are needed).
import * as esbuild from "esbuild";
import { readdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

const external = ["vscode", "@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@modelcontextprotocol/sdk", "zod"];
const cjs = { bundle: true, platform: "node", target: "node20", format: "cjs", sourcemap: true, external };
const esm = {
  bundle: true, platform: "node", target: "node20", format: "esm",
  banner: { js: 'import{createRequire as __cr}from"module";const require=__cr(import.meta.url);' },
};

const configs = tests
  ? [
      { ...cjs, entryPoints: readdirSync("test").filter((f) => f.endsWith(".test.ts") || f === "fake-runner-main.ts").map((f) => `test/${f}`), outdir: "out-test" },
      // the same runner as production, with a scripted adapter, as the file an ssh host would receive
      { ...esm, entryPoints: ["test/fake-runner-main.ts"], outfile: "out-test/fake-runner.mjs", external: ["vscode"] },
    ]
  : [
      { ...cjs, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" },
      { ...esm, entryPoints: ["src/remote/runner-main.ts"], outfile: "dist/runner.mjs" },
    ];

for (const c of configs) {
  if (watch) await (await esbuild.context(c)).watch();
  else await esbuild.build(c);
}
