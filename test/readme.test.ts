import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
const version: string = JSON.parse(read("package.json")).version;

test("readme: the install command names the current version", () => {
  assert.ok(read("README.md").includes(`agentroom-${version}.vsix`), `README must install agentroom-${version}.vsix`);
});

test("readme: CHANGELOG has an entry for the current version, newest first", () => {
  const heads = [...read("CHANGELOG.md").matchAll(/^## (\d+\.\d+\.\d+)/gm)].map((m) => m[1]);
  assert.equal(heads[0], version, "the top CHANGELOG entry must be the package version");
  assert.equal(new Set(heads).size, heads.length, "no duplicate versions");
});

test("readme: every docs/ file it links exists, and CLAUDE.md states the per-version rule", () => {
  for (const m of read("README.md").matchAll(/`(docs\/[A-Za-z0-9_.-]+\.md)`/g)) assert.ok(existsSync(join(root, m[1])), `${m[1]} is referenced by README but missing`);
  assert.match(read("CLAUDE.md"), /README theo version/);
});
