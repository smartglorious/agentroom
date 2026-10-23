// Bundle extension host code to CommonJS. The agent SDKs are ESM-only and ship
// native binaries, so they stay external and are loaded with dynamic import().
import * as esbuild from "esbuild";
import { readdirSync } from "node:fs";

const watch = process.argv.includes("--watch");
const tests = process.argv.includes("--tests");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: true,
  external: ["vscode", "@anthropic-ai/claude-agent-sdk", "@openai/codex-sdk", "@modelcontextprotocol/sdk", "zod"],
};

const config = tests
  ? { ...common, entryPoints: readdirSync("test").filter((f) => f.endsWith(".test.ts")).map((f) => `test/${f}`), outdir: "out-test" }
  : { ...common, entryPoints: ["src/extension.ts"], outfile: "dist/extension.js" };

if (watch) await (await esbuild.context(config)).watch();
else await esbuild.build(config);
