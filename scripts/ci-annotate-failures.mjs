#!/usr/bin/env node
// Turns the failing tests of a `node --test` run (TAP output saved in a file) into GitHub Actions annotations, so a red job names its failures
// even where the raw log cannot be fetched. Prints at most `--max` annotations (GitHub shows few per step).
//   node scripts/ci-annotate-failures.mjs test.log [--max 10]
import { readFileSync } from "node:fs";

const file = process.argv[2];
const maxIdx = process.argv.indexOf("--max");
const max = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : 10;
if (!file) { console.error("usage: ci-annotate-failures.mjs <test.log> [--max N]"); process.exit(2); }

const esc = (s) => s.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
const lines = readFileSync(file, "utf8").split(/\r?\n/);
const failures = [];
for (let i = 0; i < lines.length; i++) {
  const m = /^(\s*)not ok \d+ - (.+)$/.exec(lines[i]);
  if (!m) continue;
  const indent = m[1].length;
  // The YAML block under the line carries `error:` and the assertion; stop at the next test line of the same or lower depth.
  const block = [];
  for (let j = i + 1; j < lines.length && block.length < 14; j++) {
    if (/^\s*(not ok|ok) \d+ - /.test(lines[j]) && lines[j].search(/\S/) <= indent) break;
    if (/^\s*(error:|\+ |- |code:|expected:|actual:|location:)/.test(lines[j]) || /Error|ENOENT|EBUSY|EPERM|EACCES|ENOTEMPTY/.test(lines[j])) block.push(lines[j].trim());
  }
  failures.push({ name: m[2].trim(), detail: block.slice(0, 8).join(" | ") });
}
const total = failures.length;
// No "not ok" line but a failed step: the run itself died (crash, hang, bundling error). The tail of the log is then the evidence.
if (total === 0) {
  const tail = lines.filter((l) => l.trim()).slice(-30);
  console.log(`no failing test line in ${file}; last ${tail.length} line(s):`);
  console.log(`::error title=${esc("no failing test line; end of the log")}::${esc(tail.join("\n"))}`);
  process.exit(0);
}
console.log(`${total} failing test(s) in ${file}`);
for (const f of failures.slice(0, max)) console.log(`::error title=${esc("failing test")}::${esc(f.name + (f.detail ? "  =>  " + f.detail : ""))}`);
if (total > max) console.log(`::warning title=more failures::${total - max} more failing test(s) not annotated`);
