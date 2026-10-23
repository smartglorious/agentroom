// The production Runner with the scripted adapter: what a remote host runs in tests.
import { arch, homedir, hostname, platform } from "node:os";
import { ensureWorktree } from "../src/core/worktree";
import { Runner } from "../src/remote/runner";
import { scripted } from "./remote-fakes";

console.log = console.error;
const home = process.env.AR_TEST_HOME ?? homedir();
new Runner(process.stdin, process.stdout, {
  home, ensureWorktree, makeAdapter: () => scripted,
  info: { node: process.versions.node, platform: platform(), arch: arch(), hostname: hostname(), home, claude: "/fake/claude" },
}).run().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
