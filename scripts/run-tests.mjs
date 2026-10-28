#!/usr/bin/env node
// Runs the bundled tests (out-test/*.test.js) with `node --test`, listing the files itself.
// `npm test` used to pass the glob to the shell, but npm runs scripts through cmd.exe on Windows (no glob expansion) and Node 20 has no glob support in `--test`:
// "Could not find '...\out-test\*.test.js'". Extra arguments (for example --test-name-pattern) are passed on to `node --test`.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("out-test").filter((f) => f.endsWith(".test.js")).sort().map((f) => `out-test/${f}`);
if (!files.length) { console.error("no test bundle found in out-test/ (run `node esbuild.mjs --tests` first)"); process.exit(1); }
const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], { stdio: "inherit" });
process.exit(result.status ?? 1);
