// The BUILT daemon (dist/daemon.mjs) as a real process: real Claude, fake Telegram Bot API, real signals and lock.
// Run `npm run build` first.
import { ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeTelegram, until } from "../../test/fake-telegram";

const USER = 4242;
const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);
const DAEMON = join(process.cwd(), "dist", "daemon.mjs");
if (!existsSync(DAEMON)) throw new Error("dist/daemon.mjs missing: npm run build");

const home = mkdtempSync(join(tmpdir(), "dm-home-"));
const ws = mkdtempSync(join(tmpdir(), "dm-ws-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
mkdirSync(join(ws, ".agentroom"), { recursive: true });
const cfgFile = join(ws, ".agentroom", "workers.yaml");
writeFileSync(cfgFile, `accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: be, name: Minh, role: Backend, account: c, allowedTools: [Read, Grep, Glob] }
`);

const tg = new FakeTelegram();
await tg.start();
tg.pollCapMs = 400;
mkdirSync(join(home, ".agentroom"), { recursive: true });
writeFileSync(join(home, ".agentroom", "daemon.json"), JSON.stringify({ telegram: { token: tg.token } }), { mode: 0o600 });

const env = { ...process.env, HOME: home, USERPROFILE: home, AGENTROOM_TELEGRAM_API: tg.base, NODE_NO_WARNINGS: "1" };
// Async on purpose: this process also serves the fake Bot API, and a blocking spawnSync would stall it.
const run = (args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((res) => {
  const p = spawn(process.execPath, [DAEMON, ...args], { env, cwd: ws });
  let stdout = "", stderr = "";
  p.stdout.on("data", (d) => (stdout += d));
  p.stderr.on("data", (d) => (stderr += d));
  p.on("close", (status) => res({ status, stdout, stderr }));
});
const cli = (...args: string[]) => run(args);

let out = "";
const start = (...extra: string[]): ChildProcess => {
  const p = spawn(process.execPath, [DAEMON, "run", "--root", ws, ...extra], { env, cwd: ws });
  p.stdout!.on("data", (d) => (out += d));
  p.stderr!.on("data", (d) => (out += d));
  return p;
};
const exited = (p: ChildProcess) => new Promise<number | null>((r) => (p.exitCode !== null ? r(p.exitCode) : p.once("exit", (c) => r(c))));
const lockFile = join(ws, ".agentroom", "state", "room.lock");

// 1. start, then pair using the CLI (SIGUSR1 → pairing file)
let d = start();
await until(() => /daemon đang điều phối/.test(out), 15_000, "daemon up");
await until(() => existsSync(lockFile), 5_000, "lock");
check("1. daemon holds the room lock as kind=daemon", JSON.parse(readFileSync(lockFile, "utf8")).kind === "daemon");
const st = await cli("status", "--root", ws);
check("1b. status names the daemon", /daemon/.test(st.stdout), st.stdout.split("\n")[0]);
const pr = await cli("pair", "--root", ws);
const code = /\/pair (\d{6})/.exec(pr.stdout)?.[1];
check("1c. `pair` prints a code from the running daemon", !!code, (pr.stdout + pr.stderr).trim().slice(0, 80));
tg.userSays(USER, `/pair ${code}`);
await until(() => tg.texts(USER).some((t) => /ghép cặp/i.test(t)), 10_000, "paired");
const file = JSON.parse(readFileSync(join(home, ".agentroom", "daemon.json"), "utf8"));
check("2. pairing was saved to the private file", Object.values(file.telegram.paired ?? {}).length === 1 && (process.platform === "win32" || (statSync(join(home, ".agentroom", "daemon.json")).mode & 0o777) === 0o600));

// 3. a real Claude turn, driven from the phone with no VS Code anywhere
tg.userSays(USER, "@be Trả lời đúng một dòng: DAEMON-OK.");
await until(() => tg.texts(USER).some((t) => /DAEMON-OK/.test(t) && t.startsWith("🤖 Minh (@be)")), 120_000, "answer on phone");
check("3. phone → daemon → real Claude → phone", true);
check("3b. the conversation is on disk for VS Code to show later", existsSync(join(ws, ".agentroom", "state")) && readFileSync(join(ws, ".agentroom", "state", "chat.jsonl"), "utf8").includes("DAEMON-OK"));

// 4. editing workers.yaml reloads without losing the pairing; a broken edit keeps the process alive
out = "";
writeFileSync(cfgFile, readFileSync(cfgFile, "utf8").replace("Backend", "Backend dev"));
await until(() => /nạp lại \(workers\.yaml thay đổi\)/.test(out) && /daemon đang điều phối/.test(out), 15_000, "reload");
check("4. workers.yaml edit reloaded the room", true);
out = "";
writeFileSync(cfgFile, "workers: [");
await until(() => /nạp lại thất bại/.test(out), 15_000, "failed reload logged");
check("4b. broken workers.yaml does not kill the daemon", d.exitCode === null);
writeFileSync(cfgFile, `accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: be, name: Minh, role: Backend, account: c, allowedTools: [Read, Grep, Glob] }
`);
await until(() => /daemon đang điều phối/.test(out), 15_000, "recovered");
check("4c. fixing it brings the room back", true);

// 5. a second daemon is refused (exit 3); SIGTERM stops cleanly (exit 0) and frees the lock
const second = await run(["run", "--root", ws]);
check("5. a second daemon on the same folder exits 3", second.status === 3, (second.stderr || second.stdout).trim().slice(0, 70));
d.kill("SIGTERM");
const code0 = await exited(d);
check("5b. SIGTERM exits 0 and releases the lock", code0 === 0 && !existsSync(lockFile), `exit=${code0}`);

// 6. a VS Code window (lock written by someone else, fresh heartbeat) blocks the daemon; --take-over seizes it
writeFileSync(lockFile, JSON.stringify({ token: "vscode-window", pid: 1, host: "laptop", startedAt: Date.now(), heartbeat: Date.now(), kind: "vscode" }));
const blocked = await run(["run", "--root", ws]);
check("6. VS Code holding the room → daemon exits 3 and says so", blocked.status === 3 && /VS Code/.test(blocked.stderr), blocked.stderr.trim().slice(0, 70));
out = "";
d = start("--take-over");
await until(() => /daemon đang điều phối/.test(out), 15_000, "took over");
check("6b. --take-over seizes it", JSON.parse(readFileSync(lockFile, "utf8")).kind === "daemon");

// 7. someone takes the room from the daemon → it stops by itself with exit 0 (no restart loop under systemd)
writeFileSync(lockFile, JSON.stringify({ token: "vscode-window-2", pid: 1, host: "laptop", startedAt: Date.now(), heartbeat: Date.now(), kind: "vscode" }));
const lostCode = await Promise.race([exited(d), new Promise<string>((r) => setTimeout(() => r("timeout"), 15_000))]);
check("7. taken over → daemon exits 0 by itself", lostCode === 0, String(lostCode));
if (d.exitCode === null) d.kill("SIGKILL");

tg.stop();
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
