// Entry point of the file that is copied to a remote host and started over ssh:  node runner.mjs
// stdout is the protocol channel, so anything that would print there goes to stderr instead.
import { arch, hostname, homedir, platform } from "node:os";
import { ClaudeAdapter } from "../adapters/claude";
import { CodexAdapter } from "../adapters/codex";
import { findExecutable } from "../core/cli";
import { ensureWorktree } from "../core/worktree";
import { Runner } from "./runner";
import { PROTOCOL_VERSION } from "./protocol";

console.log = console.error;
console.info = console.error;

const cli = (name: "claude" | "codex", override?: string) => () => {
  const found = findExecutable(name, override);
  if (!found) throw new Error(`Không tìm thấy CLI "${name}" trên máy ${hostname()}. Cài ${name === "claude" ? "Claude Code" : "Codex CLI"} (và đăng nhập) hoặc đặt hosts.<tên>.${name}Path.`);
  return found;
};

const runner = new Runner(process.stdin, process.stdout, {
  home: homedir(),
  ensureWorktree,
  info: {
    node: process.versions.node, platform: platform(), arch: arch(), hostname: hostname(), home: homedir(),
    claude: findExecutable("claude"), codex: findExecutable("codex"),
  },
  makeAdapter: (provider, turn) =>
    provider === "claude" ? new ClaudeAdapter(cli("claude", turn.claudePath)) : new CodexAdapter(cli("codex", turn.codexPath), () => turn.pricing ?? {}),
});

void PROTOCOL_VERSION;
runner.run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
