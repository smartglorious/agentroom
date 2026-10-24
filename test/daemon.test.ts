import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SAMPLE_CONFIG } from "../src/core/config";
import { hashPin } from "../src/channels/telegram/pin";
import type { HostDef } from "../src/core/types";
import { fingerprint } from "../src/remote/host";
import { DaemonError, EXIT, hostTrusted, startDaemon } from "../src/daemon/daemon";
import { DaemonStore, defaultStoreFile } from "../src/daemon/store";
import { Fake } from "./helpers";
import { FakeTelegram, until } from "./fake-telegram";

const USER = 777;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function project() {
  const home = mkdtempSync(join(tmpdir(), "dhome-"));
  const root = mkdtempSync(join(tmpdir(), "dproj-"));
  mkdirSync(join(root, ".agentroom"), { recursive: true });
  writeFileSync(join(root, ".agentroom", "workers.yaml"), SAMPLE_CONFIG);
  return { home, root, store: new DaemonStore(defaultStoreFile(home)) };
}

const fast = { pollSec: 1, sleep: (ms: number) => sleep(Math.min(ms, 15)), conflictWaitMs: 5, conflictRetries: 2 };

test("daemon store: file is private (0600), settings are validated, bad values are rejected", () => {
  const { store } = project();
  store.update((f) => { f.telegram = { token: "1:abc" }; });
  if (process.platform !== "win32") assert.equal(statSync(store.file).mode & 0o777, 0o600);
  store.set("detail", "full");
  store.set("summaryChars", "900");
  store.set("pricing", '{"gpt-x":{"input":1,"output":2}}');
  assert.deepEqual([store.settings().detail, store.settings().summaryChars, store.settings().hookPort], ["full", 900, 47321]);
  assert.equal(store.read().telegram?.token, "1:abc", "update keeps other keys");
  assert.throws(() => store.set("detail", "everything"), /chỉ nhận/);
  assert.throws(() => store.set("summaryChars", "5"), /số nguyên/);
  assert.throws(() => store.set("hookPort", "80"), /số nguyên/);
  assert.throws(() => store.set("nope", "1"), /Không có cài đặt/);
  assert.throws(() => store.set("quietHours", "night"), /22:00-07:00/);
  writeFileSync(store.file, "not json");
  assert.equal(store.settings().detail, "summary", "a corrupt file falls back to defaults instead of crashing");
});

test("daemon: refuses without workers.yaml, and a broken one is a config error", async () => {
  const { home, root } = project();
  await assert.rejects(startDaemon({ root: join(root, "nope"), home }), (e: DaemonError) => e.exitCode === EXIT.config);
  writeFileSync(join(root, ".agentroom", "workers.yaml"), "workers: [");
  await assert.rejects(startDaemon({ root, home }), (e: DaemonError) => e.exitCode === EXIT.config && /workers\.yaml lỗi/.test(e.message));
});

test("daemon: one orchestrator per folder; --take-over stops the old one, which notices and reports it lost", async () => {
  const { home, root } = project();
  const adapters = { claude: new Fake(), codex: new Fake() };
  const a = await startDaemon({ root, home, adapters, lockHeartbeatMs: 20 });
  await assert.rejects(startDaemon({ root, home, adapters }), (e: DaemonError) => e.exitCode === EXIT.locked && /take-over/.test(e.message));
  const b = await startDaemon({ root, home, adapters, takeOver: true });
  const lock = JSON.parse(readFileSync(join(root, ".agentroom", "state", "room.lock"), "utf8"));
  assert.equal(lock.kind, "daemon");
  await Promise.race([a.lost, sleep(2000).then(() => assert.fail("old daemon never noticed the take-over"))]);
  assert.equal(JSON.parse(readFileSync(join(root, ".agentroom", "state", "room.lock"), "utf8")).token, lock.token, "the new holder keeps the lock");
  b.stop();
  assert.equal(existsSync(join(root, ".agentroom", "state", "room.lock")), false);
});

test("daemon: pairing from the phone, a message round trip, state survives a restart", async () => {
  const { home, root, store } = project();
  const tg = new FakeTelegram();
  await tg.start();
  store.update((f) => { f.telegram = { token: tg.token }; });
  const logs: string[] = [];
  const adapter = new Fake((req) => `xong: ${req.prompt.includes("làm gì") ? "đã nhận việc" : "ok"}`);
  const adapters = { claude: adapter, codex: adapter };
  const boot = () => startDaemon({ root, home, adapters, apiBase: tg.base, bot: fast, log: (t) => logs.push(t) });

  const d = await boot();
  await until(() => !!d.telegram && d.telegram.status().state === "running", 3000, "bot polling");
  const pf = readdirPairing(home);
  assert.ok(pf, "an unpaired daemon creates a pairing code");
  const { code } = JSON.parse(readFileSync(pf!, "utf8"));
  assert.match(code, /^\d{6}$/);
  if (process.platform !== "win32") assert.equal(statSync(pf!).mode & 0o777, 0o600);

  tg.userSays(USER, "/pair 000000");
  await sleep(150);
  assert.equal(Object.keys(store.read().telegram?.paired ?? {}).length, 0, "wrong code does not pair");
  tg.userSays(USER, `/pair ${code}`);
  await until(() => Object.keys(store.read().telegram?.paired ?? {}).length === 1, 3000, "paired");
  assert.equal(Object.values(store.read().telegram!.paired!)[0].id, USER);

  tg.userSays(USER, "hãy cho biết bạn làm gì");
  await until(() => tg.texts(USER).some((t) => t.includes("đã nhận việc")), 5000, "summary back on the phone");
  assert.ok(d.room.snapshot().messages.some((m) => m.from === "user" && m.text.includes("làm gì")), "phone message reached the room");

  d.stop();
  assert.equal(existsSync(pf!), false, "pairing file is removed on stop");

  // restart: still paired, no new pairing code, message works again
  const d2 = await boot();
  await until(() => d2.telegram!.status().state === "running", 3000, "bot polling again");
  assert.equal(d2.telegram!.status().paired?.id, USER);
  assert.equal(readdirPairing(home), undefined, "paired daemon does not offer a code");
  tg.userSays(USER, "/status");
  await until(() => tg.texts(USER).filter((t) => /worker|lead|đang/i.test(t)).length > 0, 3000, "status reply");
  d2.stop();
  tg.stop();
});

test("daemon: a PIN set from the CLI applies to the running bot; hosts are only trusted after trust-hosts", async () => {
  const { home, root, store } = project();
  const tg = new FakeTelegram();
  await tg.start();
  store.update((f) => { f.telegram = { token: tg.token }; });
  const adapter = new Fake();
  const d = await startDaemon({ root, home, adapters: { claude: adapter, codex: adapter }, apiBase: tg.base, bot: fast });
  assert.equal(d.telegram!.status().pin, false);
  store.update((f) => { f.telegram!.pin = hashPin("4821"); });
  assert.equal(d.telegram!.status().pin, true, "read from the file on each use, no restart");
  d.stop();
  tg.stop();

  const spec = { name: "box", ssh: "dev@box.example.com", repo: "/srv/app" } as HostDef;
  assert.equal(hostTrusted(store, root, spec), false);
  store.update((f) => { f.trusted = [`${root}|${fingerprint(spec)}`]; });
  assert.equal(hostTrusted(store, root, spec), true);
  assert.equal(hostTrusted(store, root, { ...spec, ssh: "evil@box.example.com" }), false, "a changed target must be approved again");
  assert.equal(hostTrusted(store, "/other/project", spec), false, "trust is per project");
});

function readdirPairing(home: string) {
  const dir = join(home, ".agentroom");
  try {
    const f = require("node:fs").readdirSync(dir).find((n: string) => n.startsWith("pairing-"));
    return f ? join(dir, f) : undefined;
  } catch { return undefined; }
}
