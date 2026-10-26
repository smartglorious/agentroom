import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(__dirname, "..", "scripts", "validate-agentroom.mjs");
const project = (workers: string) => {
  const dir = mkdtempSync(join(tmpdir(), "agentroom-validate-"));
  mkdirSync(join(dir, ".agentroom"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "# x\n");
  writeFileSync(join(dir, ".agentroom", ".gitignore"), "state/\nworktrees/\n.plugin/\nagents/*/journal/\n");
  writeFileSync(join(dir, ".agentroom", "workers.yaml"), `accounts: { c: { provider: claude } }\nworkers:\n${workers}`);
  return dir;
};
const run = (dir: string) => spawnSync(process.execPath, [script, dir], { encoding: "utf8" });

test("validator: a worker with `tools:` and a valid `autonomy:` is accepted (it used to crash, and to reject valid autonomy values)", () => {
  const dir = project("  - { id: be, name: B, role: r, account: c, coordinator: true, tools: [Read, Grep], allowedTools: [Read], autonomy: manual }\n");
  const r = run(dir);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /ĐẠT/);
});

test("validator: an unknown autonomy value is rejected", () => {
  const r = run(project("  - { id: be, name: B, role: r, account: c, coordinator: true, autonomy: yolo }\n"));
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /autonomy phải là manual, auto hoặc full/);
});
