import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConfig } from "../src/core/config";
import { AgentAdapter, TurnRequest } from "../src/adapters/types";
import { BotApi, TelegramError } from "../src/channels/telegram/api";
import { TelegramBot } from "../src/channels/telegram/bot";
import { describeApproval, inQuietHours, parseDuration, phoneApprovalVerdict, splitMessage, summarize } from "../src/channels/telegram/format";
import { Outbox } from "../src/channels/telegram/outbox";
import { PinGuard, hashPin, verifyPin } from "../src/channels/telegram/pin";
import { PairedUser, TelegramService, TelegramSettings } from "../src/channels/telegram/service";
import { FakeTelegram, until } from "./fake-telegram";
import { Fake, idle, makeRoom } from "./helpers";

const USER = 777;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface RigOptions {
  settings?: Partial<TelegramSettings>;
  paired?: boolean;
  pin?: string;
  adapter?: AgentAdapter;
  config?: ReturnType<typeof parseConfig>;
  before?: (tg: FakeTelegram) => void;
}

async function rig(o: RigOptions = {}) {
  const tg = new FakeTelegram();
  await tg.start();
  o.before?.(tg);
  const { room, deps, dir } = makeRoom(o.adapter ?? new Fake(() => "ok"), o.config ? { config: o.config } : {});
  const bot = new TelegramBot(new BotApi(tg.token, { apiBase: tg.base }), {
    pollSec: 1, outbox: new Outbox({ minIntervalMs: 2 }), sleep: (ms) => sleep(Math.min(ms, 15)), conflictWaitMs: 5, conflictRetries: 2,
  });
  let paired: PairedUser | undefined = o.paired === false ? undefined : { id: USER, chat: USER, name: "Minh", since: 0 };
  const pinHash = o.pin ? hashPin(o.pin) : undefined;
  const settings: TelegramSettings = { detail: "summary", approveFromPhone: "safe", summaryChars: 600, quietHours: "", ...o.settings };
  const clock = { t: new Date(2026, 9, 24, 14, 0).getTime() };
  const svc = new TelegramService({
    room, usage: deps.usage, bot, config: deps.config, settings: () => settings, now: () => clock.t, code: () => "123456", workspaceName: "demo",
    stores: { paired: { get: () => paired, set: (u) => { paired = u; } }, pin: { get: () => pinHash } },
  });
  await svc.start();
  const stop = () => { svc.stop(); tg.stop(); };
  return { tg, room, deps, dir, bot, svc, settings, clock, stop, paired: () => paired };
}

const roomUserMessages = (room: ReturnType<typeof makeRoom>["room"]) => room.snapshot().messages.filter((m) => m.from === "user");

// ------------------------------------------------------------------ format

test("format: summaries drop code and secrets and cut at a word; long text splits under the limit", () => {
  const s = summarize("Xong rồi.\n```ts\nconst a = 1;\nconst b = 2;\n```\nKey sk-abcdefghijklmnopqrstuvwx đã dùng.", 600);
  assert.equal(s.text, "Xong rồi.\n[mã: 2 dòng]\nKey [đã ẩn] đã dùng.");
  assert.equal(s.cut, true);
  const long = summarize("từ ".repeat(400), 100);
  assert.ok(long.text.length <= 101 && long.text.endsWith("…") && long.cut);
  assert.equal(summarize("ngắn", 600).cut, false);

  const parts = splitMessage(("đoạn một dòng dài ".repeat(40) + "\n\n").repeat(12));
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 3800));
  assert.equal(parts.join("").replace(/\s+/g, ""), ("đoạn một dòng dài ".repeat(40)).repeat(12).replace(/\s+/g, ""), "nothing lost");
  assert.deepEqual(splitMessage("x".repeat(8000)).map((p) => p.length), [3800, 3800, 400]);
});

test("format: durations and overnight quiet hours", () => {
  assert.deepEqual(["30m", "2h", "1d", "90s", "2.5h"].map(parseDuration), [1800000, 7200000, 86400000, 90000, 9000000]);
  assert.equal(parseDuration("soon"), undefined);
  const at = (h: number, m = 0) => new Date(2026, 9, 24, h, m);
  assert.deepEqual([at(23), at(2), at(6, 59), at(7), at(12)].map((d) => inQuietHours("22:00-07:00", d)), [true, true, true, false, false]);
  assert.deepEqual([at(13), at(12, 59)].map((d) => inQuietHours("13:00-14:00", d)), [true, false]);
  assert.equal(inQuietHours("", at(3)), false);
});

test("format: what may be approved from a phone — file edits inside the worker's own folder, nothing sensitive", () => {
  const cwd = "/work/app/.agentroom/worktrees/be";
  const v = (tool: string, input: unknown, c: string | null = cwd) => phoneApprovalVerdict({ tool, input, cwd: c ?? undefined });
  assert.equal(v("Edit", { file_path: `${cwd}/src/a.ts` }).safe, true);
  assert.equal(v("Write", { file_path: "src/new/file.ts" }).safe, true, "relative paths are inside by definition");
  assert.equal(v("MultiEdit", { file_path: `${cwd}/README.md` }).safe, true);
  assert.equal(v("NotebookEdit", { notebook_path: `${cwd}/n.ipynb` }).safe, true);
  // remote worktree: judged against the folder the runner reported, never against a name pattern
  const remote = "/home/dev/app/.agentroom/worktrees/be";
  assert.equal(v("Write", { file_path: `${remote}/src/x.ts` }, remote).safe, true);
  assert.equal(v("Write", { file_path: `${remote}/src/x.ts` }, "~/app").safe, false, "an unexpanded ~ proves nothing");
  assert.equal(v("Write", { file_path: "/tmp/other/.agentroom/worktrees/be/x.ts" }, remote).safe, false, "same-looking path elsewhere on the host");
  assert.equal(v("Write", { file_path: `${remote}-evil/x.ts` }, remote).safe, false, "prefix of the name is not the folder");
  assert.equal(v("Write", { file_path: "C:\\Repo\\.agentroom\\worktrees\\be\\src\\a.ts" }, "c:/repo/.agentroom/worktrees/be").safe, true, "windows paths");
  // outside
  for (const f of ["/etc/passwd", `${cwd}/../other/x.ts`, "../x.ts", "../../etc/hosts", "/work/app/src/x.ts", "~/x", "C:\\Users\\a\\x.ts"]) assert.equal(v("Edit", { file_path: f }).safe, false, f);
  // sensitive inside
  for (const f of [".env", ".env.production", ".git/config", ".github/workflows/ci.yml", ".agentroom/workers.yaml", ".claude/settings.json", ".ssh/id_rsa", "deploy/server.pem", "config/credentials.json", ".husky/pre-commit", ".vscode/tasks.json", ".npmrc", "a/.git/hooks/pre-commit"]) {
    assert.equal(v("Write", { file_path: f }).safe, false, f);
  }
  // other tools never
  for (const t of ["Bash", "WebFetch", "WebSearch", "mcp__x__y", "Task"]) assert.equal(v(t, { command: "ls", file_path: "a.ts" }).safe, false, t);
  assert.equal(v("Edit", {}).safe, false);
  assert.equal(v("Edit", { file_path: `${cwd}/a.ts` }, null).safe, false, "absolute path with unknown folder is not trusted");
  assert.match(v("Bash", {}).reason, /máy tính/);
});

test("format: the approval card names the worker, the machine and masks secrets", () => {
  const t = describeApproval({ id: "1", workerId: "be", tool: "Bash", input: { command: "curl -H 'token = abcdef123456789' x" }, host: "gpu-box" }, "Minh");
  assert.match(t, /Minh \(@be\) trên máy gpu-box xin quyền dùng Bash/);
  assert.doesNotMatch(t, /abcdef123456789/);
});

test("pin: hashed, verified, and three misses lock approvals for ten minutes", () => {
  const h = hashPin("4821");
  assert.ok(!h.includes("4821"));
  assert.equal(verifyPin("4821", h), true);
  assert.equal(verifyPin("4822", h), false);
  assert.notEqual(hashPin("4821"), hashPin("4821"), "salted");
  const clock = { t: 0 };
  const g = new PinGuard(() => clock.t);
  assert.deepEqual([g.check(1, "0000", h), g.check(1, "1111", h), g.check(1, "2222", h)], ["bad", "bad", "locked"]);
  assert.equal(g.check(1, "4821", h), "locked", "even the right PIN is refused while locked");
  assert.equal(g.check(2, "4821", h), "ok", "other users are not affected");
  clock.t += 10 * 60_000 + 1;
  assert.equal(g.check(1, "4821", h), "ok");
});

// ------------------------------------------------------------------ api, outbox, bot

test("api: errors carry Telegram's code and text but never the token", async () => {
  const api = new BotApi("123:SECRET", { fetch: (async () => { throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED", message: "connect to /bot123:SECRET/getMe" } }); }) as typeof fetch });
  await assert.rejects(api.getMe(), (e: TelegramError) => e.code === 0 && /ECONNREFUSED/.test(e.message) && !e.message.includes("SECRET"));
  const api2 = new BotApi("123:SECRET", { fetch: (async () => new Response(JSON.stringify({ ok: false, error_code: 429, description: "Too Many Requests: retry after 7 for 123:SECRET", parameters: { retry_after: 7 } }), { status: 429 })) as typeof fetch });
  await assert.rejects(api2.sendMessage(1, "x"), (e: TelegramError) => e.code === 429 && e.retryAfter === 7 && !e.message.includes("SECRET"));
});

test("outbox: spaces messages per chat, honours retry_after, gives up after the retry budget", async () => {
  const clock = { t: 1_000_000 }, slept: number[] = [];
  const box = new Outbox({ minIntervalMs: 1000, now: () => clock.t, sleep: async (ms) => { slept.push(ms); clock.t += ms; } });
  const order: number[] = [];
  await Promise.all([1, 2, 3].map((n) => box.enqueue({ chat: 5, quiet: false, run: async () => { order.push(n); return n; } })));
  assert.deepEqual(order, [1, 2, 3]);
  assert.deepEqual(slept, [1000, 1000], "first goes at once, the next two wait");

  let calls = 0;
  slept.length = 0;
  const got = await box.enqueue({ chat: 6, quiet: false, run: async () => { if (++calls === 1) throw new TelegramError(429, "slow down", 3); return "sent"; } });
  assert.equal(got, "sent");
  assert.ok(slept.some((ms) => ms >= 3000), "waited at least retry_after");

  const fail = box.enqueue({ chat: 7, quiet: false, run: async () => { throw new TelegramError(429, "slow down", 1); } });
  await assert.rejects(fail, /429/);
});

test("outbox: a flooded chat drops quiet messages, never loud ones", async () => {
  const dropped: number[] = [];
  const box = new Outbox({ minIntervalMs: 0, maxQueued: 3, onDropped: (_c, n) => dropped.push(n) });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const first = box.enqueue({ chat: 1, quiet: false, run: async () => { await gate; return "first"; } });
  const quiet = Array.from({ length: 6 }, (_, i) => box.enqueue({ chat: 1, quiet: true, run: async () => `q${i}` }).catch((e: Error) => e.message));
  const loud = box.enqueue({ chat: 1, quiet: false, run: async () => "loud" });
  release();
  assert.equal(await first, "first");
  assert.equal(await loud, "loud");
  const results = await Promise.all(quiet);
  assert.ok(results.filter((r) => r === "dropped").length >= 3);
  assert.ok(dropped.reduce((a, b) => a + b, 0) >= 3);
});

test("bot: long text arrives as several messages in order, buttons only on the last, nothing over the limit", async () => {
  const r = await rig();
  try {
    const text = Array.from({ length: 12 }, (_, i) => `đoạn ${i} ${"nội dung ".repeat(80)}`).join("\n\n");
    await r.bot.send(USER, text, { buttons: [[{ text: "ok", callback_data: "x" }]] });
    const parts = r.tg.sent.filter((s) => !s.text.startsWith("🟢"));
    assert.ok(parts.length >= 3);
    assert.ok(parts.every((p) => p.text.length <= 4096));
    assert.deepEqual(parts.map((p) => p.buttons.length), [...parts.slice(1).map(() => 0), 1]);
    assert.ok(parts[0].text.startsWith("đoạn 0") && parts.at(-1)!.text.includes("đoạn 11"));
  } finally { r.stop(); }
});

test("bot: updates that piled up while AgentRoom was off are dropped, counted, and never replayed", async () => {
  const r = await rig({ before: (tg) => { tg.userSays(USER, "/stop all"); tg.userSays(USER, "xoá hết đi"); tg.userSays(999, "người lạ"); } });
  try {
    await until(() => r.tg.texts(USER).some((t) => /Có 2 tin/.test(t)), 3000, "backlog notice");
    assert.deepEqual(roomUserMessages(r.room), [], "no stale message reached the room");
    r.tg.userSays(USER, "tin mới");
    await until(() => roomUserMessages(r.room).length === 1, 3000, "fresh message");
    assert.equal(roomUserMessages(r.room)[0].text, "tin mới");
  } finally { r.stop(); }
});

test("bot: a bad token stops with advice; an active webhook or other poller is reported, never stolen", async () => {
  const tg = new FakeTelegram();
  await tg.start();
  try {
    const bad = new TelegramBot(new BotApi("1:wrong", { apiBase: tg.base }), { sleep: async () => undefined });
    await bad.start();
    assert.equal(bad.state, "error");
    assert.match(bad.error!, /Token bot không hợp lệ/);

    tg.webhookUrl = "https://openclaw.example/hook";
    const taken = new TelegramBot(new BotApi(tg.token, { apiBase: tg.base }), { sleep: async () => undefined });
    await taken.start();
    assert.equal(taken.state, "conflict");
    assert.match(taken.error!, /bot riêng/);
    assert.ok(!tg.methods.includes("deleteWebhook") && !tg.methods.includes("setWebhook"), "the other consumer's webhook is left alone");

    tg.webhookUrl = "";
    const live = new TelegramBot(new BotApi(tg.token, { apiBase: tg.base }), { pollSec: 1, sleep: (ms) => sleep(Math.min(ms, 10)), conflictWaitMs: 5, conflictRetries: 2 });
    await live.start();
    assert.equal(live.state, "running");
    tg.webhookUrl = "https://someone.else/hook";                  // another consumer takes over later
    await until(() => live.state === "conflict" && /nhận tin/.test(live.error ?? ""), 4000, "conflict");
    live.stop();
  } finally { tg.stop(); }
});

test("bot: network trouble is retried with backoff and the bot recovers by itself", async () => {
  const r = await rig();
  try {
    r.tg.failNext = 2;
    await until(() => r.bot.state === "retrying", 3000, "retrying");
    await until(() => r.bot.state === "running", 4000, "recovered");
    r.tg.userSays(USER, "vẫn nhận được chứ");
    await until(() => roomUserMessages(r.room).length === 1, 3000, "message after recovery");
  } finally { r.stop(); }
});

// ------------------------------------------------------------------ pairing and who is obeyed

test("pairing: a code shown on the computer binds one person; wrong, expired and over-tried codes do nothing", async () => {
  const r = await rig({ paired: false });
  try {
    r.tg.userSays(USER, "/pair 123456");
    await sleep(120);
    assert.equal(r.paired(), undefined, "no code was issued yet → ignored silently");
    assert.deepEqual(r.tg.texts(), []);

    const { code } = r.svc.createPairingCode();
    assert.equal(code, "123456");
    r.tg.userSays(USER, "/pair 000000");
    await until(() => r.tg.texts(USER).some((t) => /Mã không đúng/.test(t)), 3000, "wrong code reply");
    assert.equal(r.paired(), undefined);

    r.tg.userSays(USER, "/pair 123456", { name: "Minh" });
    await until(() => !!r.paired(), 3000, "paired");
    assert.deepEqual([r.paired()!.id, r.paired()!.chat, r.paired()!.name], [USER, USER, "Minh"]);
    assert.match(r.tg.last(USER)!.text, /Đã ghép cặp với Minh/);
    assert.equal(r.svc.status().pairing, undefined, "the code is single use");

    r.svc.createPairingCode();
    r.clock.t += 11 * 60_000;
    r.tg.userSays(888, "/pair 123456", { name: "Kẻ lạ" });
    await sleep(120);
    assert.equal(r.paired()!.id, USER, "an expired code pairs nobody");

    await r.svc.unpair();
    r.svc.createPairingCode();
    for (let i = 0; i < 7; i++) r.tg.userSays(888, `/pair 99999${i}`);
    await sleep(250);
    r.tg.userSays(888, "/pair 123456");
    await sleep(150);
    assert.equal(r.paired(), undefined, "after too many wrong tries even the right code is dead");
  } finally { r.stop(); }
});

test("inbound: only the paired person, in a private chat, with plain text is obeyed", async () => {
  const r = await rig();
  try {
    r.tg.userSays(555, "xin chào");                                         // stranger
    r.tg.userSays(USER, "trong nhóm", { type: "supergroup", chat: -1001 });   // group
    r.tg.userSays(USER, "đã sửa", { edited: true });                           // edited message
    r.tg.userSays(USER, "/status", { chat: 12345 });                           // paired user, but a different chat id
    await sleep(250);
    assert.deepEqual(roomUserMessages(r.room), []);
    assert.deepEqual(r.tg.texts().filter((t) => !t.startsWith("🟢")), [], "strangers get no reply at all");

    r.tg.userSays(USER, "tin chuyển tiếp", { forward: true });
    await until(() => r.tg.texts(USER).some((t) => /Không nhận tin chuyển tiếp/.test(t)), 3000, "forward refusal");
    r.tg.userSays(USER, undefined);
    await until(() => r.tg.texts(USER).some((t) => /Chỉ nhận tin nhắn văn bản/.test(t)), 3000, "non-text refusal");
    assert.deepEqual(roomUserMessages(r.room), []);

    r.tg.userSays(USER, "@be làm API đăng nhập");
    await until(() => roomUserMessages(r.room).length === 1, 3000, "accepted message");
    const m = roomUserMessages(r.room)[0];
    assert.deepEqual([m.text, m.source, m.to], ["@be làm API đăng nhập", "telegram", ["be"]]);
  } finally { r.stop(); }
});

test("inbound: no mention goes to the coordinator; with none, the phone is told why nobody answered", async () => {
  const r = await rig();
  try {
    r.tg.userSays(USER, "làm tính năng login");
    await until(() => roomUserMessages(r.room).length === 1, 3000, "message");
    assert.deepEqual(roomUserMessages(r.room)[0].to, ["lead"]);
  } finally { r.stop(); }
  const none = await rig({ config: parseConfig("accounts: { a: { provider: claude } }\nworkers: [{ id: be, name: B, role: R, account: a }]") });
  try {
    none.tg.userSays(USER, "có ai không");
    await until(() => none.tg.texts(USER).some((t) => /Chưa có worker nào nhận/.test(t)), 3000, "hint");
  } finally { none.stop(); }
});

// ------------------------------------------------------------------ room → phone

test("outbound: replies are short, quiet, labelled; code collapses; a button fetches the full text on demand", async () => {
  const r = await rig();
  try {
    const body = "Đã thêm endpoint.\n```ts\n" + "line();\n".repeat(30) + "```\nChạy `npm test` để kiểm tra.";
    r.room.post("be", body, { taskId: "T1" });
    await until(() => r.tg.texts(USER).some((t) => t.startsWith("🤖")), 3000, "summary");
    const s = r.tg.last(USER)!;
    assert.match(s.text, /^🤖 Minh \(@be\) · T1\nĐã thêm endpoint\.\n\[mã: 30 dòng\]\nChạy/);
    assert.equal(s.silent, true);
    assert.equal(s.buttons[0][0].text, "📄 Xem đầy đủ");
    assert.ok(Buffer.byteLength(s.buttons[0][0].callback_data) <= 64);
    r.tg.userTaps(USER, s, s.buttons[0][0].callback_data);
    await until(() => r.tg.texts(USER).some((t) => t.includes("line();")), 3000, "full text");
    assert.equal(r.tg.answers.length >= 1, true);
  } finally { r.stop(); }
});

test("outbound: @user wakes the phone; your own messages and routine system chatter stay off it", async () => {
  const r = await rig();
  try {
    r.room.post("user", "nhắn từ máy tính");
    r.room.post("system", "task [T1] xong", {});                       // not an alert
    r.room.post("be", "Cần bạn chọn: A hay B? @user quyết giúp");
    r.room.post("be", "Chỉ báo tiến độ nhỏ");
    await until(() => r.tg.texts(USER).filter((t) => t.startsWith("🤖")).length === 2, 3000, "two worker messages");
    const [needs, plain] = r.tg.sent.filter((s) => s.text.startsWith("🤖"));
    assert.deepEqual([needs.silent, plain.silent], [false, true]);
    assert.ok(!r.tg.texts(USER).some((t) => /nhắn từ máy tính|task \[T1\]/.test(t)));
  } finally { r.stop(); }
});

test("outbound: alerts are loud, the read-only chain explains how to continue, budget alerts point to /budget", async () => {
  const r = await rig();
  try {
    r.room.post("system", "⚠️ Minh (id: be) gặp lỗi: boom", { alert: true });
    r.room.post("lead", "Đã xem webhook, đề xuất giao @be sửa.", { readOnly: true });
    r.room.post("system", "⛔ Account claude-main đã chạm ngân sách ngày ($6 / $5).", { alert: true });
    await until(() => r.tg.texts(USER).filter((t) => !t.startsWith("🟢")).length === 3, 3000, "three");
    const [err, ro, bud] = r.tg.sent.filter((s) => !s.text.startsWith("🟢"));
    assert.equal(err.silent, false);
    assert.match(ro.text, /🔒 Chuỗi chỉ-đọc: bạn nhắn lại @tên-worker/);
    assert.match(ro.text, /^🤖 Lan \(@lead\) 🔒/);
    assert.match(bud.text, /\/budget/);
  } finally { r.stop(); }
});

test("outbound: detail modes, /mute and quiet hours", async () => {
  const r = await rig({ settings: { detail: "alerts" } });
  try {
    r.room.post("be", "báo cáo thường");
    r.room.post("be", "@user cần quyết định");
    await until(() => r.tg.texts(USER).some((t) => /cần quyết định/.test(t)), 3000, "attention only");
    assert.ok(!r.tg.texts(USER).some((t) => /báo cáo thường/.test(t)));

    r.tg.userSays(USER, "/detail full");
    await until(() => r.tg.texts(USER).some((t) => /Toàn văn.*không mã hoá đầu cuối/.test(t)), 3000, "warning about full");
    const long = "đoạn rất dài ".repeat(150);
    r.room.post("be", long);
    await until(() => r.tg.texts(USER).some((t) => t.includes(long.trim().slice(0, 200)) && t.length > 1200), 3000, "full text");
    assert.equal(r.svc.status().detail, "full");

    r.tg.userSays(USER, "/mute 30m");
    await until(() => r.svc.status().mutedUntil !== undefined, 3000, "muted");
    const n = r.tg.sent.length;
    r.room.post("be", "trong lúc tắt tiếng");
    r.room.post("system", "⚠️ vẫn phải báo", { alert: true });
    await until(() => r.tg.texts(USER).some((t) => /vẫn phải báo/.test(t)), 3000, "alert while muted");
    assert.ok(!r.tg.texts(USER).slice(n - 1).some((t) => /trong lúc tắt tiếng/.test(t)));
    r.tg.userSays(USER, "/unmute");
    await until(() => r.svc.status().mutedUntil === undefined, 3000, "unmuted");

    r.settings.quietHours = "13:00-15:00";                       // clock is 14:00
    r.room.post("system", "⚠️ cảnh báo lúc đang yên lặng", { alert: true });
    await until(() => r.tg.texts(USER).some((t) => /đang yên lặng/.test(t)), 3000, "quiet alert");
    assert.equal(r.tg.last(USER)!.silent, true);
  } finally { r.stop(); }
});

// ------------------------------------------------------------------ approvals

/** An agent that asks to write `file` and reports what the human answered. */
const writer = (file: (dir: string) => string, tool = "Write") => {
  const ref: { dir: string } = { dir: "" };
  const adapter: AgentAdapter = { runTurn: async (req: TurnRequest) => ({ text: (await req.approve(tool, { file_path: file(ref.dir), command: "ls" })) ? "ĐÃ-DUYỆT" : "BỊ-TỪ-CHỐI" }) };
  return { adapter, ref };
};

test("approval: a safe edit shows ✅/❌ on the phone; ✅ lets the agent continue and updates the card", async () => {
  const w = writer((d) => `${d}/src/auth.ts`);
  const r = await rig({ adapter: w.adapter });
  w.ref.dir = r.dir;
  try {
    r.room.post("user", "@be sửa auth");
    await until(() => r.tg.sent.some((s) => s.buttons.flat().some((b) => b.callback_data.startsWith("ap:y:"))), 5000, "approval card");
    const card = r.tg.sent.find((s) => s.text.startsWith("🔐"))!;
    assert.match(card.text, /Minh \(@be\) xin quyền dùng Write/);
    assert.deepEqual(card.buttons[0].map((b) => b.text), ["✅ Cho phép", "❌ Từ chối"]);
    assert.ok(card.buttons[0].every((b) => Buffer.byteLength(b.callback_data) <= 64));
    r.tg.userTaps(USER, card, card.buttons[0][0].callback_data);
    await idle(r.room);
    assert.ok(r.room.snapshot().messages.some((m) => m.from === "be" && m.text === "ĐÃ-DUYỆT"));
    await until(() => /Đã cho phép \(từ điện thoại\)/.test(card.text), 3000, "card edited");
    assert.deepEqual(card.buttons, [], "buttons are gone");
  } finally { r.stop(); }
});

test("approval: ❌ refuses; and a card answered at the computer is withdrawn on the phone", async () => {
  const w = writer((d) => `${d}/src/a.ts`);
  const r = await rig({ adapter: w.adapter });
  w.ref.dir = r.dir;
  try {
    r.room.post("user", "@be làm A");
    await until(() => r.tg.sent.some((s) => s.text.startsWith("🔐")), 5000, "card 1");
    const c1 = r.tg.sent.find((s) => s.text.startsWith("🔐"))!;
    r.tg.userTaps(USER, c1, c1.buttons[0][1].callback_data);
    await idle(r.room);
    assert.ok(r.room.snapshot().messages.some((m) => m.text === "BỊ-TỪ-CHỐI"));
    await until(() => /Đã từ chối/.test(c1.text), 3000, "card 1 edited");

    r.room.post("user", "@be làm B", { taskId: "B" });
    await until(() => r.tg.sent.filter((s) => s.text.startsWith("🔐")).length === 2, 5000, "card 2");
    const c2 = r.tg.sent.filter((s) => s.text.startsWith("🔐"))[1];
    r.room.respondApproval(r.room.snapshot().approvals[0].id, true);   // answered in VS Code
    await until(() => /Đã xử lý ở máy tính/.test(c2.text), 3000, "card 2 withdrawn");
    r.tg.userTaps(USER, c2, c2.buttons[0]?.[0]?.callback_data ?? "ap:y:gone");
    await until(() => r.tg.answers.some((a) => /hết hạn|không còn|đã được xử lý/.test(a.text ?? "")), 3000, "stale tap answered");
  } finally { r.stop(); }
});

test("approval: anything not clearly safe can only be refused from the phone — and a forged ✅ is refused by the service", async () => {
  const cases: { tool: string; file: (d: string) => string }[] = [
    { tool: "Bash", file: () => "ignored" },
    { tool: "Write", file: () => "/etc/cron.d/evil" },
    { tool: "Edit", file: (d) => `${d}/.env` },
    { tool: "Write", file: (d) => `${d}/.github/workflows/ci.yml` },
  ];
  for (const c of cases) {
    const w = writer(c.file, c.tool);
    const r = await rig({ adapter: w.adapter });
    w.ref.dir = r.dir;
    try {
      r.room.post("user", "@be làm");
      await until(() => r.tg.sent.some((s) => s.text.startsWith("🔐")), 5000, `card for ${c.tool}`);
      const card = r.tg.sent.find((s) => s.text.startsWith("🔐"))!;
      assert.deepEqual(card.buttons[0].map((b) => b.text), ["❌ Từ chối"], c.tool + " " + c.file(r.dir));
      assert.match(card.text, /Chỉ duyệt được ở máy tính/);
      const id = r.room.snapshot().approvals[0].id;
      r.tg.userTaps(USER, card, `ap:y:${id}`);                     // forged ✅
      await until(() => r.tg.answers.some((a) => /Chỉ duyệt ở máy tính/.test(a.text ?? "")), 3000, "forged tap refused");
      assert.equal(r.room.snapshot().approvals.length, 1, "still waiting for the computer");
      r.room.respondApproval(id, false);
    } finally { r.stop(); }
  }
});

test("approval: turning phone approvals off leaves only ❌", async () => {
  const w = writer((d) => `${d}/src/a.ts`);
  const r = await rig({ adapter: w.adapter, settings: { approveFromPhone: "none" } });
  w.ref.dir = r.dir;
  try {
    r.room.post("user", "@be làm");
    await until(() => r.tg.sent.some((s) => s.text.startsWith("🔐")), 5000, "card");
    const card = r.tg.sent.find((s) => s.text.startsWith("🔐"))!;
    assert.deepEqual(card.buttons[0].map((b) => b.text), ["❌ Từ chối"]);
    assert.match(card.text, /đã tắt duyệt từ điện thoại/);
    r.room.respondApproval(r.room.snapshot().approvals[0].id, false);
  } finally { r.stop(); }
});

test("approval with a PIN: ✅ asks for it, the PIN message is deleted, wrong PINs count, three lock it", async () => {
  const w = writer((d) => `${d}/src/a.ts`);
  const r = await rig({ adapter: w.adapter, pin: "4821" });
  w.ref.dir = r.dir;
  try {
    r.room.post("user", "@be làm");
    await until(() => r.tg.sent.some((s) => s.text.startsWith("🔐")), 5000, "card");
    const card = r.tg.sent.find((s) => s.text.startsWith("🔐"))!;
    assert.match(card.text, /cần PIN/);
    r.tg.userTaps(USER, card, card.buttons[0][0].callback_data);
    await until(() => r.tg.texts(USER).some((t) => /Nhập PIN/.test(t)), 3000, "PIN prompt");
    assert.equal(r.room.snapshot().approvals.length, 1, "not approved yet");

    const wrong = r.tg.userSays(USER, "0000");
    await until(() => r.tg.texts(USER).some((t) => /PIN sai/.test(t)), 3000, "wrong PIN");
    assert.equal(r.room.snapshot().approvals.length, 1);

    const right = r.tg.userSays(USER, "4821");
    await idle(r.room);
    assert.ok(r.room.snapshot().messages.some((m) => m.text === "ĐÃ-DUYỆT"));
    assert.ok(wrong.message_id && right.message_id);
    assert.deepEqual(roomUserMessages(r.room).map((m) => m.text), ["@be làm"], "PINs never reached the chat");
  } finally { r.stop(); }

  const w2 = writer((d) => `${d}/src/b.ts`);
  const r2 = await rig({ adapter: w2.adapter, pin: "4821" });
  w2.ref.dir = r2.dir;
  try {
    r2.room.post("user", "@be làm");
    await until(() => r2.tg.sent.some((s) => s.text.startsWith("🔐")), 5000, "card");
    const card = r2.tg.sent.find((s) => s.text.startsWith("🔐"))!;
    r2.tg.userTaps(USER, card, card.buttons[0][0].callback_data);
    await until(() => r2.tg.texts(USER).some((t) => /Nhập PIN/.test(t)), 3000, "prompt");
    for (const p of ["1111", "2222", "3333"]) r2.tg.userSays(USER, p);
    await until(() => r2.tg.texts(USER).some((t) => /khoá duyệt từ điện thoại 10 phút/.test(t)), 3000, "locked");
    r2.tg.userTaps(USER, card, card.buttons[0][0].callback_data);
    await until(() => r2.tg.answers.some((a) => /Đang khoá/.test(a.text ?? "")), 3000, "refused while locked");
    const waiting = r2.room.snapshot().approvals[0].id;
    r2.tg.userSays(USER, "4821");
    await until(() => r2.tg.texts(USER).some((t) => /Không có yêu cầu nào đang chờ PIN/.test(t)), 3000, "stray PIN caught");
    assert.ok(r2.room.snapshot().approvals.some((a) => a.id === waiting), "the right PIN is useless while locked");
    r2.room.respondApproval(waiting, false);
  } finally { r2.stop(); }
});

test("approval: cards already waiting when the phone connects are sent, and cards from before a restart are expired", async () => {
  const w = writer((d) => `${d}/src/a.ts`);
  const r = await rig({ adapter: w.adapter });
  w.ref.dir = r.dir;
  try {
    r.room.post("user", "@be làm");
    await until(() => r.tg.sent.some((s) => s.text.startsWith("🔐")), 5000, "card");
    const old = r.tg.sent.find((s) => s.text.startsWith("🔐"))!;
    r.svc.stop();                                                // phone side goes away…
    assert.equal(r.room.snapshot().approvals.length, 1);
    const bot2 = new TelegramBot(new BotApi(r.tg.token, { apiBase: r.tg.base }), { pollSec: 1, outbox: new Outbox({ minIntervalMs: 2 }), sleep: (ms) => sleep(Math.min(ms, 15)) });
    const svc2 = new TelegramService({
      room: r.room, usage: r.deps.usage, bot: bot2, config: r.deps.config, settings: () => r.settings, now: () => r.clock.t,
      stores: { paired: { get: () => ({ id: USER, chat: USER, name: "Minh", since: 0 }), set: () => undefined }, pin: { get: () => undefined } },
    });
    await svc2.start();
    await until(() => r.tg.sent.filter((s) => s.text.startsWith("🔐")).length === 2, 3000, "re-sent card");
    r.room.respondApproval(r.room.snapshot().approvals[0].id, false);
    await until(() => r.room.snapshot().approvals.length === 0, 3000, "resolved");
    r.tg.userTaps(USER, old, old.buttons[0][0].callback_data);
    await until(() => r.tg.answers.some((a) => /hết hạn/.test(a.text ?? "")), 3000, "old card expired");
    svc2.stop();
  } finally { r.tg.stop(); }
});

// ------------------------------------------------------------------ commands

test("commands: /status /tasks /cost /stop /budget /help work from the phone", async () => {
  const config = parseConfig("accounts: { c: { provider: claude, budgetUsdPerDay: 5 } }\nworkers:\n  - { id: lead, name: Lan, role: R, account: c, coordinator: true }\n  - { id: be, name: Minh, role: R, account: c }\n");
  const slow: AgentAdapter = { runTurn: async (req) => { await new Promise<void>((res, rej) => { const t = setTimeout(res, 2500); req.signal.addEventListener("abort", () => { clearTimeout(t); rej(new Error("stopped")); }); }); return { text: "xong", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 6, estimated: false } }; } };
  const r = await rig({ adapter: slow, config });
  try {
    r.room.createTask("lead", { title: "Viết API", assignee: "be" });
    await until(() => r.room.snapshot().statuses.find((s) => s.id === "be")?.state === "working", 3000, "be working");
    r.tg.userSays(USER, "/status");
    await until(() => r.tg.texts(USER).some((t) => t.startsWith("📊 demo")), 3000, "status");
    const st = r.tg.texts(USER).find((t) => t.startsWith("📊"))!;
    assert.match(st, /🟢 Minh \(@be\) — working/);
    assert.match(st, /⚪ Lan \(@lead\) — idle/);
    assert.match(st, /Task mở: 1/);

    r.tg.userSays(USER, "/tasks");
    await until(() => r.tg.texts(USER).some((t) => /Viết API.*@be/.test(t)), 3000, "tasks");

    r.tg.userSays(USER, "/stop be");
    await until(() => r.tg.texts(USER).some((t) => /Đã dừng @be/.test(t)), 3000, "stopped");
    await until(() => r.room.snapshot().statuses.find((s) => s.id === "be")?.state === "idle", 3000, "be idle");
    r.tg.userSays(USER, "/stop nobody");
    await until(() => r.tg.texts(USER).some((t) => /Dùng: \/stop/.test(t)), 3000, "usage");

    r.tg.userSays(USER, "/cost");
    await until(() => r.tg.texts(USER).some((t) => t.startsWith("💰")), 3000, "cost");

    r.tg.userSays(USER, "/budget");
    await until(() => r.tg.texts(USER).some((t) => /Không có account nào đang bị dừng/.test(t)), 3000, "nothing paused");

    r.tg.userSays(USER, "/help");
    await until(() => r.tg.texts(USER).some((t) => /AgentRoom trên điện thoại/.test(t)), 3000, "help");
    r.tg.userSays(USER, "/lung-tung");
    await until(() => r.tg.texts(USER).some((t) => /Không hiểu lệnh/.test(t)), 3000, "unknown");
  } finally { r.stop(); }
});

test("budget: the stop alert reaches the phone, /budget offers a button, and tapping it lets the account run again", async () => {
  const config = parseConfig("accounts: { c: { provider: claude, budgetUsdPerDay: 5 } }\nworkers:\n  - { id: lead, name: Lan, role: R, account: c, coordinator: true }\n");
  const costly = new Fake(() => ({ text: "ok", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 6, estimated: false } }));
  const r = await rig({ adapter: costly, config });
  try {
    r.tg.userSays(USER, "chạy một lượt tốn tiền");
    await until(() => r.tg.texts(USER).some((t) => /chạm ngân sách/.test(t) && /\/budget/.test(t)), 5000, "budget alert");
    r.tg.userSays(USER, "/budget");
    await until(() => r.tg.sent.some((s) => s.buttons.flat().some((b) => b.callback_data === "bg:c")), 3000, "button");
    const card = r.tg.sent.find((s) => s.buttons.flat().some((b) => b.callback_data === "bg:c"))!;
    r.tg.userTaps(USER, card, "bg:c");
    await until(() => r.tg.texts(USER).some((t) => /c chạy tiếp đến hết hôm nay/.test(t)), 3000, "resumed");
    assert.equal(r.room.snapshot().accounts[0].paused, false);
  } finally { r.stop(); }
});

test("unpair: stops everything; later messages from that phone are ignored", async () => {
  const r = await rig();
  try {
    r.tg.userSays(USER, "/unpair");
    await until(() => r.paired() === undefined, 3000, "unpaired");
    const n = r.tg.sent.length;
    r.room.post("be", "không gửi nữa");
    r.tg.userSays(USER, "còn ai không");
    await sleep(200);
    assert.equal(r.tg.sent.length, n);
    assert.deepEqual(roomUserMessages(r.room), []);
  } finally { r.stop(); }
});

test("end to end: a message from the phone is answered by a worker and the answer comes back to the phone", async () => {
  const r = await rig({ adapter: new Fake((req) => `Xong việc của ${req.worker.id}. Đã sửa 3 file.`) });
  try {
    r.tg.userSays(USER, "@be sửa lỗi đăng nhập");
    await until(() => r.tg.texts(USER).some((t) => /^🤖 Minh \(@be\)/.test(t) && /Xong việc của be/.test(t)), 6000, "answer on phone");
    assert.equal(r.svc.status().state, "running");
    assert.equal(r.svc.status().bot, "@agentroom_test_bot");
  } finally { r.stop(); }
});

test("pin hygiene: digits typed with no PIN prompt waiting are not sent to the room and are deleted", async () => {
  const r = await rig({ pin: "4821" });
  try {
    const stray = r.tg.userSays(USER, "4821");
    await until(() => r.tg.texts(USER).some((t) => /không được gửi đi/.test(t)), 3000, "notice");
    assert.deepEqual(roomUserMessages(r.room), []);
    r.tg.userSays(USER, "4821 là mã lỗi nào?");
    await until(() => roomUserMessages(r.room).length === 1, 3000, "digits plus words are a normal message");
    assert.ok(stray.message_id);
  } finally { r.stop(); }
  const noPin = await rig();
  try {
    noPin.tg.userSays(USER, "1234");
    await until(() => roomUserMessages(noPin.room).length === 1, 3000, "without a PIN numbers are ordinary text");
  } finally { noPin.stop(); }
});
