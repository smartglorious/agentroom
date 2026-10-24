import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable } from "../src/core/cli";

/** Lays out what `npm i -g @openai/codex` leaves on Windows: three shims plus the package with its native exe. */
function npmGlobal() {
  const d = mkdtempSync(join(tmpdir(), "ar-cli-"));
  const w = (rel: string, body = "") => { mkdirSync(join(d, rel, ".."), { recursive: true }); writeFileSync(join(d, rel), body); };
  w("codex", "#!/bin/sh\nexec node \"$basedir/node_modules/@openai/codex/bin/codex.js\" \"$@\"\n");
  w("codex.cmd", '@ECHO off\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  w("codex.ps1", "# shim");
  w("node_modules/@openai/codex/package.json", "{}");
  w("node_modules/@openai/codex/bin/codex.js", "// launcher");
  return { d, w };
}
const win = (d: string, override?: string) => findExecutable("codex", override, { platform: "win32", env: { PATH: `C:\\nope;${d}` } });

test("cli(windows): the extensionless npm shim is never returned; the native exe behind codex.cmd is", () => {
  const { d, w } = npmGlobal();
  w("node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe", "MZ");
  const exe = join(d, "node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/codex/codex.exe");
  assert.equal(win(d), exe, "found through PATH");
  assert.equal(win(d, join(d, "codex")), exe, "the user's agentroom.codexPath pointing at the extensionless shim is fixed up");
  assert.equal(win(d, join(d, "codex.cmd")), exe);
});

test("cli(windows): an .exe next to the shim wins; with no exe anywhere the .cmd is returned (run through a shell), not the sh script", () => {
  const a = npmGlobal();
  a.w("codex.exe", "MZ");
  assert.equal(win(a.d), join(a.d, "codex.exe"));
  const b = npmGlobal();
  assert.equal(win(b.d), join(b.d, "codex.cmd"));
  const c = mkdtempSync(join(tmpdir(), "ar-cli-"));
  writeFileSync(join(c, "codex"), "#!/bin/sh");
  assert.equal(win(c), undefined, "only an sh script: not runnable on Windows");
});

test("cli(posix): unchanged — bare name from PATH, absolute path must exist", () => {
  const d = mkdtempSync(join(tmpdir(), "ar-cli-"));
  writeFileSync(join(d, "claude"), "#!/bin/sh");
  assert.equal(findExecutable("claude", undefined, { platform: "linux", env: { PATH: `/nope:${d}` } }), join(d, "claude"));
  assert.equal(findExecutable("claude", join(d, "claude"), { platform: "linux" }), join(d, "claude"));
  assert.equal(findExecutable("claude", join(d, "missing"), { platform: "linux" }), undefined);
});

import { claudeFromEditorExtension } from "../src/core/cli";

test("claude from an editor's Claude Code extension: the newest version wins, other editors count, nothing found gives undefined", () => {
  const home = mkdtempSync(join(tmpdir(), "ar-home-"));
  const mk = (editor: string, name: string) => { const d = join(home, editor, "extensions", name, "resources", "native-binary"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "claude.exe"), "x"); return join(d, "claude.exe"); };
  assert.equal(claudeFromEditorExtension(home, "win32"), undefined);
  mk(".vscode", "anthropic.claude-code-2.1.99-win32-x64");
  const newest = mk(".vscode", "anthropic.claude-code-2.1.310-win32-x64");
  mk(".cursor", "anthropic.claude-code-2.1.12-win32-x64");
  mk(".vscode", "other.publisher-9.9.9");
  assert.equal(claudeFromEditorExtension(home, "win32"), newest, "2.1.310 is newer than 2.1.99 (numeric, not alphabetical)");
  assert.equal(claudeFromEditorExtension(home, "linux"), undefined, "no `claude` (non-.exe) file on linux in this tree");
  assert.equal(findExecutable("claude", undefined, { platform: "win32", env: { PATH: "C:\\nope" }, home }), newest, "used when nothing is on PATH");
  assert.equal(findExecutable("codex", undefined, { platform: "win32", env: { PATH: "C:\\nope" }, home }), undefined, "only for claude");
});
