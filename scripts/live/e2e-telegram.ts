// REAL Claude behind a fake Telegram Bot API: what a phone user would see and be allowed to do.
// The approval policy is checked against the tool inputs Claude actually sends, not hand-written ones.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../../src/adapters/claude";
import { CodexAdapter } from "../../src/adapters/codex";
import { BotApi } from "../../src/channels/telegram/api";
import { TelegramBot } from "../../src/channels/telegram/bot";
import { Outbox } from "../../src/channels/telegram/outbox";
import { TelegramService, TelegramSettings } from "../../src/channels/telegram/service";
import { parseConfig } from "../../src/core/config";
import { TurnInspector } from "../../src/core/inspector";
import { MemoryStore } from "../../src/core/memory";
import { Room } from "../../src/core/room";
import { Scheduler } from "../../src/core/scheduler";
import { SkillDrafts, SkillRegistry, skillSources } from "../../src/core/skills";
import { RoomStore } from "../../src/core/store";
import { UsageStore } from "../../src/core/usage";
import { AgentRoomMcp } from "../../src/mcp/server";
import { FakeTelegram, until } from "../../test/fake-telegram";

const USER = 4242;
const results: string[] = [];
const check = (name: string, ok: boolean, extra = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${extra ? " — " + extra : ""}`);

const ws = mkdtempSync(join(tmpdir(), "tg-ws-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ws });
const root = join(ws, ".agentroom"), state = join(root, "state");
mkdirSync(state, { recursive: true });

const config = parseConfig(`accounts: { c: { provider: claude, maxConcurrent: 2 } }
workers:
  - { id: lead, name: Lan, role: Lead, account: c, coordinator: true, allowedTools: [Read, Grep, Glob] }
  - { id: be, name: Minh, role: Backend, account: c, allowedTools: [Read, Grep, Glob] }
`);
const holder: { mcp?: AgentRoomMcp } = {};
const usage = new UsageStore(state);
const room = new Room({
  config, store: new RoomStore(state), adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() }, scheduler: new Scheduler(),
  options: { maxAgentHops: 3, contextMessages: 20, memoryBudgetChars: 12000 }, memory: new MemoryStore(root),
  skills: new SkillRegistry(skillSources(ws, join(ws, "nohome"))), skillDrafts: new SkillDrafts(join(root, "skills")),
  pluginDir: join(root, ".plugin"), usage, inspector: new TurnInspector(state, 30), resolveCwd: async () => ws, mcpUrl: (id) => holder.mcp!.urlFor(id),
});
holder.mcp = new AgentRoomMcp(room);
await holder.mcp.start();

const tg = new FakeTelegram();
await tg.start();
tg.pollCapMs = 400;
const settings: TelegramSettings = { detail: "summary", approveFromPhone: "safe", summaryChars: 600, quietHours: "" };
let paired = { id: USER, chat: USER, name: "Minh", since: 0 };
const svc = new TelegramService({
  room, usage, config, settings: () => settings, workspaceName: "e2e",
  bot: new TelegramBot(new BotApi(tg.token, { apiBase: tg.base }), { pollSec: 1, outbox: new Outbox({ minIntervalMs: 20 }) }),
  stores: { paired: { get: () => paired, set: (u) => { if (u) paired = u; } }, pin: { get: () => undefined } },
});
await svc.start();
const idle = () => new Promise<void>((res) => { const c = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error") ? res() : setTimeout(c, 400)); setTimeout(c, 1500); });
const cards = () => tg.sent.filter((s) => s.text.startsWith("🔐"));

// 1. a message from the phone, the answer on the phone
tg.userSays(USER, "@be Trả lời đúng một dòng: PHONE-OK.");
await until(() => tg.texts(USER).some((t) => /PHONE-OK/.test(t) && t.startsWith("🤖 Minh (@be)")), 90_000, "answer on phone");
await idle();
const fromPhone = room.snapshot().messages.find((m) => m.from === "user");
check("1. phone message reached the worker and the summary came back", fromPhone?.source === "telegram" && tg.texts(USER).some((t) => /^🤖 Minh \(@be\)\nPHONE-OK/.test(t)), tg.texts(USER).at(-1)?.slice(0, 60));

// 2. a file edit inside the worker's folder: ✅ is offered and works
tg.userSays(USER, "@be Dùng tool Write tạo file note.txt trong thư mục hiện tại với nội dung hello. Sau đó trả lời WROTE hoặc REFUSED tuỳ kết quả.");
await until(() => cards().length >= 1, 90_000, "approval card");
const c1 = cards()[0];
console.log("card:", c1.text.replace(/\n/g, " ⏎ ").slice(0, 200));
check("2. real Write input judged safe: ✅ and ❌ offered", c1.buttons[0].map((b) => b.text).join("|") === "✅ Cho phép|❌ Từ chối", c1.buttons[0].map((b) => b.text).join("|"));
tg.userTaps(USER, c1, c1.buttons[0][0].callback_data);
await idle();
check("2. tapping ✅ on the phone let Claude write the file", existsSync(join(ws, "note.txt")) && /hello/.test(readFileSync(join(ws, "note.txt"), "utf8")));
check("2. the card became a record of the decision", /Đã cho phép \(từ điện thoại\)/.test(c1.text) && c1.buttons.length === 0);
check("2. the result came back to the phone", tg.texts(USER).some((t) => /WROTE/.test(t)));

// 3. a credentials file: only ❌ on the phone
tg.userSays(USER, "@be Dùng tool Write tạo file .env với nội dung SECRET=1. Sau đó trả lời WROTE-ENV hoặc REFUSED-ENV.");
await until(() => cards().length >= 2, 90_000, "second card");
const c2 = cards()[1];
check("3. .env: only ❌ offered, reason given", c2.buttons[0].map((b) => b.text).join("|") === "❌ Từ chối" && /nhạy cảm/.test(c2.text), c2.text.split("\n").slice(-1)[0]);
tg.userTaps(USER, c2, c2.buttons[0][0].callback_data);
await idle();
check("3. refused: no .env was created", !existsSync(join(ws, ".env")));

// 4. a shell command: only ❌
tg.userSays(USER, "@be Dùng tool Bash chạy đúng lệnh: echo hi > shell.txt. Sau đó trả lời DONE-SHELL hoặc REFUSED-SHELL.");
await until(() => cards().length >= 3, 90_000, "third card");
const c3 = cards()[2];
check("4. Bash: only ❌ offered; must be approved at the computer", c3.buttons[0].map((b) => b.text).join("|") === "❌ Từ chối" && /Bash chỉ được duyệt ở máy tính/.test(c3.text));
const forged = room.snapshot().approvals.find((a) => a.tool === "Bash")!;
tg.userTaps(USER, c3, `ap:y:${forged.id}`);
await until(() => tg.answers.some((a) => /Chỉ duyệt ở máy tính/.test(a.text ?? "")), 10_000, "forged ✅ refused");
check("4. a forged ✅ on that card is refused by the service", room.snapshot().approvals.some((a) => a.id === forged.id));
room.respondApproval(forged.id, true);                // the person at the computer says yes
await idle();
check("4. approving at the computer still works", existsSync(join(ws, "shell.txt")));
check("4. the phone card says it was handled at the computer", /Đã xử lý ở máy tính/.test(c3.text));

// 5. commands
tg.userSays(USER, "/status");
await until(() => tg.texts(USER).some((t) => t.startsWith("📊 e2e")), 10_000, "status");
tg.userSays(USER, "/cost");
await until(() => tg.texts(USER).some((t) => t.startsWith("💰")), 10_000, "cost");
const cost = tg.texts(USER).find((t) => t.startsWith("💰"))!;
check("5. /cost reports real spend", /\$0\.\d+/.test(cost) && !/\$0\.00 ·/.test(cost), cost.split("\n")[0]);
check("5. nothing from a stranger leaked in", !room.snapshot().messages.some((m) => m.from === "user" && m.source !== "telegram"));

console.log(results.join("\n"));
console.log("total cost USD:", usage.all().reduce((a, x) => a + (x.costUsd ?? 0), 0).toFixed(4));
svc.stop(); tg.stop(); holder.mcp.dispose();
process.exit(results.some((l) => l.startsWith("FAIL")) ? 1 : 0);
