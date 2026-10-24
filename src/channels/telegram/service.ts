import { EventEmitter } from "node:events";
import { randomInt, timingSafeEqual } from "node:crypto";
import { isAutonomy } from "../../core/autonomy";
import { redactSecrets } from "../../core/memory";
import { PlanUsage, untilText } from "../../core/plan";
import type { Room } from "../../core/room";
import type { ApprovalRequest, ChatMessage, RoomConfig } from "../../core/types";
import type { UsageStore } from "../../core/usage";
import { InlineButton, TgCallback, TgMessage, TgUpdate } from "./api";
import { BotState, TelegramBot } from "./bot";
import { describeApproval, inQuietHours, parseDuration, phoneApprovalVerdict, summarize, usd } from "./format";
import { PIN_FORMAT, PinGuard } from "./pin";

export type Detail = "summary" | "full" | "alerts";

export interface TelegramSettings {
  detail: Detail;
  approveFromPhone: "safe" | "none";
  summaryChars: number;
  quietHours: string;
}

export interface PairedUser { id: number; chat: number; name: string; since: number }

export interface TelegramStores {
  paired: { get(): PairedUser | undefined; set(u: PairedUser | undefined): void | Promise<void> };
  /** "salt:hash" from hashPin, or undefined when no PIN is set. */
  pin: { get(): string | undefined };
}

export interface ServiceDeps {
  room: Room;
  usage: UsageStore;
  bot: TelegramBot;
  config: RoomConfig;
  settings(): TelegramSettings;
  stores: TelegramStores;
  log?: (text: string) => void;
  now?: () => number;
  /** 6-digit pairing code source (tests pin it). */
  code?: () => string;
  workspaceName?: string;
}

export interface TelegramStatus {
  state: BotState;
  error?: string;
  bot?: string;
  paired?: { name: string; id: number };
  pairing?: { code: string; expiresAt: number };
  mutedUntil?: number;
  pin: boolean;
  detail: Detail;
}

type PinAction = { kind: "approve"; id: string } | { kind: "budget"; account: string };

const PAIR_TTL = 10 * 60_000;
const PIN_TTL = 90_000;
const FULL_CACHE = 50;
const MAX_INBOUND = 4000;
const HELP = [
  "AgentRoom trên điện thoại",
  "• Nhắn thường → gửi cho worker điều phối; @id → gọi đúng worker",
  "/status — worker đang làm gì · /tasks — việc đang mở · /cost — chi phí hôm nay",
  "/mode — mức tự chủ của worker (chỉ hạ được từ đây) · /plan — hạn mức gói Claude/Codex còn lại (/plan refresh để đọc lại) · /stop <id|all> — dừng worker · /mute [30m|2h] · /unmute",
  "/detail summary|full|alerts — mức chi tiết tin gửi về",
  "/budget — cho account hết ngân sách chạy tiếp · /unpair — ngắt ghép cặp",
].join("\n");

const mentionsUser = (t: string) => /(^|[^\w@])@user\b/i.test(t);

/**
 * Connects a Room to a paired Telegram chat: forwards what matters (summaries, approvals, alerts),
 * accepts messages and a few commands back. Only the one paired person, in a private chat, with
 * plain text, is ever obeyed; everything else is ignored.
 */
export class TelegramService extends EventEmitter<{ change: [] }> {
  private pairing?: { code: string; expiresAt: number; tries: number };
  private mutedUntil = 0;
  private detailOverride?: Detail;
  private approvalMsgs = new Map<string, { chat: number; id: number; text: string }>();
  private phoneHandled = new Set<string>();
  private full = new Map<string, string>();
  private fullSeq = 0;
  /** Telegram message id → room message id, so that a Telegram "reply" lands on the right worker message. */
  private sentRoom = new Map<number, string>();
  /** Questions with buttons that are still open: key (in callback_data) → what to answer, and where to show the pick. */
  private questions = new Map<string, { msg: string; chat: number; tg: number; text: string; items: { id: string; label: string }[] }>();
  private questionOf = new Map<string, string>();
  private questionSeq = 0;
  /** An answer that came in before the phone message of its question was registered (the send had not returned yet). */
  private earlyAnswers = new Map<string, { option: string; where: string }>();
  private pendingPin?: { user: number; action: PinAction; expiresAt: number; prompt?: number };
  private guard: PinGuard;
  private started = false;
  private offRoom: (() => void)[] = [];
  private now: () => number;

  constructor(private d: ServiceDeps) {
    super();
    this.now = d.now ?? Date.now;
    this.guard = new PinGuard(this.now);
  }

  // ---------- lifecycle ----------

  async start() {
    if (this.started) return;
    this.started = true;
    const { room, bot } = this.d;
    bot.on("state", () => this.emit("change"));
    bot.on("message", (m) => void this.onMessage(m).catch((e) => this.log(`lỗi xử lý tin: ${e}`)));
    bot.on("callback", (c) => void this.onCallback(c).catch((e) => this.log(`lỗi xử lý nút: ${e}`)));
    bot.on("backlog", (u) => void this.onBacklog(u).catch(() => undefined));
    const onMsg = (m: ChatMessage) => void this.forward(m).catch((e) => this.log(`không gửi được tin: ${e}`));
    const onApproval = (r: ApprovalRequest) => void this.sendApproval(r).catch((e) => this.log(`không gửi được thẻ duyệt: ${e}`));
    const onResolved = (id: string) => void this.approvalResolved(id).catch(() => undefined);
    room.on("message", onMsg);
    room.on("approval", onApproval);
    room.on("approvalResolved", onResolved);
    this.offRoom = [() => room.off("message", onMsg), () => room.off("approval", onApproval), () => room.off("approvalResolved", onResolved)];
    await bot.start();
    const p = this.d.stores.paired.get();
    if (bot.state === "running" && p) {
      const n = room.snapshot().workers.length;
      void bot.send(p.chat, `🟢 AgentRoom đã kết nối${this.d.workspaceName ? ` (${this.d.workspaceName})` : ""} · ${n} worker. /help để xem lệnh.`, { quiet: true }).catch(() => undefined);
      // approvals that were already waiting when the phone connected
      for (const a of room.snapshot().approvals) void this.sendApproval(a).catch(() => undefined);
    }
    this.emit("change");
  }

  stop() {
    this.started = false;
    this.offRoom.forEach((f) => f());
    this.offRoom = [];
    this.d.bot.removeAllListeners();
    this.d.bot.stop();
    this.emit("change");
  }

  private log(t: string) { this.d.log?.(`[telegram] ${t}`); }

  status(): TelegramStatus {
    const p = this.d.stores.paired.get();
    return {
      state: this.d.bot.state,
      error: this.d.bot.error,
      bot: this.d.bot.me?.username ? `@${this.d.bot.me.username}` : undefined,
      paired: p && { name: p.name, id: p.id },
      pairing: this.pairing && this.pairing.expiresAt > this.now() ? { code: this.pairing.code, expiresAt: this.pairing.expiresAt } : undefined,
      mutedUntil: this.mutedUntil > this.now() ? this.mutedUntil : undefined,
      pin: !!this.d.stores.pin.get(),
      detail: this.detailOverride ?? this.d.settings().detail,
    };
  }

  /** A short-lived code to type into the bot (`/pair 123456`) from the phone. */
  createPairingCode(): { code: string; expiresAt: number } {
    const code = this.d.code?.() ?? String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.pairing = { code, expiresAt: this.now() + PAIR_TTL, tries: 0 };
    this.emit("change");
    return { code, expiresAt: this.pairing.expiresAt };
  }

  async unpair() {
    await this.d.stores.paired.set(undefined);
    this.pairing = undefined;
    this.approvalMsgs.clear();
    this.pendingPin = undefined;
    this.emit("change");
  }

  // ---------- helpers ----------

  private paired() { return this.d.stores.paired.get(); }
  private workerName(id: string) { return this.d.room.snapshot().workers.find((w) => w.id === id)?.name ?? id; }
  private quietNow() { return !!this.d.settings().quietHours && inQuietHours(this.d.settings().quietHours, new Date(this.now())); }
  private detail(): Detail { return this.detailOverride ?? this.d.settings().detail; }

  private rememberFull(text: string): string {
    const key = String(++this.fullSeq);
    this.full.set(key, text);
    if (this.full.size > FULL_CACHE) this.full.delete(this.full.keys().next().value as string);
    return key;
  }

  private async tell(chat: number, text: string, args: { quiet?: boolean; buttons?: InlineButton[][] } = {}) {
    return this.d.bot.send(chat, text, args);
  }

  // ---------- room → phone ----------

  private header(m: ChatMessage): string {
    const w = this.d.room.snapshot().workers.find((x) => x.id === m.from);
    const task = m.taskId && !/^(sched|hook|gc)-/.test(m.taskId) ? ` · ${m.taskId}` : "";
    return `🤖 ${w?.name ?? m.from} (@${m.from})${w?.host ? ` ⇄ ${w.host}` : ""}${task}${m.readOnly ? " 🔒" : ""}`;
  }

  async forward(m: ChatMessage) {
    const p = this.paired();
    if (!p || this.d.bot.state !== "running") return;
    // The user answered a question at the computer: show the pick on the phone too and take its buttons away.
    if (m.choice && m.source !== "telegram") return void (await this.closeQuestion(m.choice.message, m.choice.option, "ở máy tính"));
    if (m.from === "user" || m.source === "telegram") return;
    const quiet = this.quietNow();

    if (m.from === "system") {
      if (!m.alert) return;
      const hint = /chạm ngân sách/.test(m.text) ? "\nGõ /budget để cho chạy tiếp." : "";
      await this.tell(p.chat, redactSecrets(m.text) + hint, { quiet });
      return;
    }

    // A question with buttons is waiting for the user, so /mute does not hide it.
    if (this.mutedUntil > this.now() && !m.options) return;
    const wantsYou = mentionsUser(m.text);
    const mode = this.detail();
    if (mode === "alerts" && !wantsYou) return;

    const cap = this.d.settings().summaryChars;
    const full = mode === "full" && !wantsYou ? { text: redactSecrets(m.text), cut: false } : summarize(m.text, cap);
    const footer = m.readOnly ? "\n\n🔒 Chuỗi chỉ-đọc: bạn nhắn lại @tên-worker để tiếp tục." : "";
    const key = m.options ? (++this.questionSeq).toString(36) : undefined;
    const rows: InlineButton[][] = [
      ...(m.options && key ? m.options.items.map((i) => [{ text: `${i.id}. ${i.label}`.slice(0, 60), callback_data: `op:${key}:${i.id}` }]) : []),
      ...(full.cut ? [[{ text: "📄 Xem đầy đủ", callback_data: `fx:${this.rememberFull(redactSecrets(m.text))}` }]] : []),
    ];
    const text = `${this.header(m)}\n${full.text}${footer}`;
    const id = await this.tell(p.chat, text, { quiet: quiet || !wantsYou, buttons: rows.length ? rows : undefined });
    if (id) {
      this.sentRoom.set(id, m.id);
      if (this.sentRoom.size > 400) this.sentRoom.delete(this.sentRoom.keys().next().value!);
      if (m.options && key) {
        this.questions.set(key, { msg: m.id, chat: p.chat, tg: id, text, items: m.options.items });
        this.questionOf.set(m.id, key);
        const early = this.earlyAnswers.get(m.id);
        if (early) { this.earlyAnswers.delete(m.id); void this.closeQuestion(m.id, early.option, early.where); }
        if (this.questions.size > 100) { const old = this.questions.keys().next().value!; this.questionOf.delete(this.questions.get(old)!.msg); this.questions.delete(old); }
      }
    }
  }

  private async closeQuestion(msgId: string, optionId: string, where: string) {
    const key = this.questionOf.get(msgId);
    const q = key && this.questions.get(key);
    if (!key || !q) {
      // The question may still be on its way to the phone: close it as soon as it is there.
      if (this.earlyAnswers.size < 50) this.earlyAnswers.set(msgId, { option: optionId, where });
      return;
    }
    this.questions.delete(key);
    this.questionOf.delete(msgId);
    const label = q.items.find((i) => i.id === optionId)?.label ?? optionId;
    await this.d.bot.edit(q.chat, q.tg, `${q.text}\n✔ Đã chọn ${optionId}. ${label} (${where})`);
  }

  async sendApproval(req: ApprovalRequest) {
    const p = this.paired();
    if (!p || this.d.bot.state !== "running" || this.approvalMsgs.has(req.id)) return;
    const verdict = phoneApprovalVerdict(req);
    const mayApprove = verdict.safe && this.d.settings().approveFromPhone === "safe";
    const buttons: InlineButton[] = [
      ...(mayApprove ? [{ text: "✅ Cho phép", callback_data: `ap:y:${req.id}` }] : []),
      { text: "❌ Từ chối", callback_data: `ap:n:${req.id}` },
    ];
    const text = describeApproval(req, this.workerName(req.workerId))
      + (req.reason ? `\n${req.reason}` : "")
      + (mayApprove ? (this.d.stores.pin.get() ? "\n(cần PIN để cho phép)" : "") : `\n⚠️ Chỉ duyệt được ở máy tính: ${this.d.settings().approveFromPhone === "none" ? "đã tắt duyệt từ điện thoại" : verdict.reason}`);
    const id = await this.tell(p.chat, text, { quiet: this.quietNow(), buttons: [buttons] });
    if (this.phoneHandled.delete(req.id)) return;
    if (!this.d.room.snapshot().approvals.some((a) => a.id === req.id)) {
      // answered while the message was in flight
      await this.d.bot.edit(p.chat, id, `${text}\n✔ Đã xử lý ở máy tính`);
      return;
    }
    this.approvalMsgs.set(req.id, { chat: p.chat, id, text });
  }

  private async approvalResolved(id: string) {
    const m = this.approvalMsgs.get(id);
    if (!m) return;
    this.approvalMsgs.delete(id);
    await this.d.bot.edit(m.chat, m.id, `${m.text}\n✔ Đã xử lý ở máy tính`);
  }

  // ---------- phone → room ----------

  private async onBacklog(updates: TgUpdate[]) {
    const p = this.paired();
    const n = updates.filter((u) => u.message?.from?.id === p?.id && u.message?.chat.type === "private").length;
    if (p && n) await this.tell(p.chat, `ℹ️ Có ${n} tin bạn gửi lúc AgentRoom đang tắt đã bị bỏ qua (để không chạy lại lệnh cũ). Nhắn lại nếu cần.`, { quiet: true });
  }

  private async onMessage(m: TgMessage) {
    const from = m.from;
    if (m.chat.type !== "private" || !from || from.is_bot) return;
    const text = m.text?.trim();
    const cmd = text?.startsWith("/") ? /^\/(\w+)(?:@\w+)?\s*([\s\S]*)$/.exec(text) : null;

    if (cmd?.[1].toLowerCase() === "pair") return this.onPair(m, cmd[2].trim());

    const p = this.paired();
    if (!p || p.id !== from.id || p.chat !== m.chat.id) { this.log(`bỏ qua tin từ người chưa ghép cặp (id ${from.id})`); return; }
    if (m.forward_origin || m.forward_date) return void (await this.tell(p.chat, "Không nhận tin chuyển tiếp (có thể chứa nội dung lạ). Hãy gõ lại.", { quiet: true }));
    if (!text) return void (await this.tell(p.chat, "Chỉ nhận tin nhắn văn bản.", { quiet: true }));

    if (this.pendingPin?.user === from.id) {
      if (PIN_FORMAT.test(text)) return this.onPin(m, text);
      this.pendingPin = undefined;
      await this.tell(p.chat, "Đã huỷ yêu cầu nhập PIN.", { quiet: true });
    }

    if (cmd) return this.onCommand(p, cmd[1].toLowerCase(), cmd[2].trim());

    // A bare number that looks like the PIN, typed with no prompt waiting, must not end up in the chat log or the agents' context.
    if (this.d.stores.pin.get() && PIN_FORMAT.test(text)) {
      void this.d.bot.remove(m.chat.id, m.message_id);
      return void (await this.tell(p.chat, "Không có yêu cầu nào đang chờ PIN nên tin này không được gửi đi (và đã bị xoá). Muốn gửi số này cho worker, hãy thêm chữ vào cùng tin.", { quiet: true }));
    }

    // Telegram's own "reply" on one of the bot's messages answers that worker message.
    const repliedTo = (m.reply_to_message as { message_id?: number } | undefined)?.message_id;
    const replyTo = repliedTo !== undefined ? this.sentRoom.get(repliedTo) : undefined;
    const posted = this.d.room.post("user", text.slice(0, MAX_INBOUND), { source: "telegram", ...(replyTo ? { replyTo } : {}) });
    if (!posted.to.length) await this.tell(p.chat, "Chưa có worker nào nhận tin này (không có worker điều phối). Hãy @id để gọi một worker.", { quiet: true });
  }

  private async onPair(m: TgMessage, arg: string) {
    const from = m.from!;
    const already = this.paired();
    if (already && already.id === from.id) return void (await this.tell(m.chat.id, "Đã ghép cặp rồi. /help để xem lệnh.", { quiet: true }));
    const pr = this.pairing;
    if (!pr || pr.expiresAt < this.now()) return void this.log("có người gõ /pair nhưng không có mã đang chờ");
    pr.tries++;
    const a = Buffer.from(arg.padEnd(32)), b = Buffer.from(pr.code.padEnd(32));
    if (pr.tries > 5) { this.pairing = undefined; this.log("quá 5 lần thử ghép cặp: huỷ mã"); this.emit("change"); return; }
    if (arg.length !== pr.code.length || !timingSafeEqual(a, b)) return void (await this.tell(m.chat.id, "Mã không đúng.", { quiet: true }));
    this.pairing = undefined;
    const name = [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username || String(from.id);
    await this.d.stores.paired.set({ id: from.id, chat: m.chat.id, name, since: this.now() });
    this.emit("change");
    await this.tell(m.chat.id, `✅ Đã ghép cặp với ${name}.\n\n${HELP}`, { quiet: true });
  }

  private async onCommand(p: PairedUser, cmd: string, arg: string) {
    const room = this.d.room;
    const say = (t: string, buttons?: InlineButton[][]) => this.tell(p.chat, t, { quiet: true, buttons });
    switch (cmd) {
      case "start": case "help": return void (await say(HELP));
      case "status": {
        const s = room.snapshot();
        const icon = (st: string) => ({ idle: "⚪", queued: "🔵", working: "🟢", waiting_approval: "🟡", rate_limited: "🟠", over_budget: "🟠", error: "🔴" }[st] ?? "⚪");
        const lines = s.workers.map((w) => {
          const st = s.statuses.find((x) => x.id === w.id);
          const cost = s.todayByWorker[w.id];
          return `${icon(st?.state ?? "idle")} ${w.name} (@${w.id})${w.host ? ` ⇄ ${w.host}` : ""} — ${st?.state ?? "idle"}${st?.activity ? `: ${st.activity}` : ""}${cost ? ` · ${usd(cost)}` : ""}`;
        });
        const open = s.tasks.filter((t) => t.status !== "done").length;
        return void (await say(`📊 ${this.d.workspaceName ?? "AgentRoom"}\n${lines.join("\n")}\nTask mở: ${open}${s.approvals.length ? ` · đang chờ duyệt: ${s.approvals.length}` : ""}`));
      }
      case "tasks": {
        const open = room.snapshot().tasks.filter((t) => t.status !== "done");
        return void (await say(open.length ? open.slice(0, 15).map((t) => `[${t.id}] (${t.status}) ${t.title}${t.assignee ? ` — @${t.assignee}` : ""}`).join("\n") + (open.length > 15 ? `\n… và ${open.length - 15} task nữa` : "") : "Không có task nào đang mở."));
      }
      case "cost": {
        const t = this.d.usage.summarize("today").totals;
        const accs = room.snapshot().accounts.filter((a) => a.budgetUsdPerDay).map((a) => `${a.id}: ${usd(a.spentToday)} / ${usd(a.budgetUsdPerDay!)}${a.paused ? " ⛔" : ""}`);
        return void (await say(`💰 Hôm nay: ${t.estimated ? "≈ " : ""}${usd(t.costUsd)} · ${t.turns} lượt · ${t.errors} lỗi${accs.length ? "\n" + accs.join("\n") : ""}`));
      }
      case "mode": {
        const ws = room.snapshot().workers;
        const icon = { manual: "🛡", auto: "🤖", full: "⚡" } as const;
        const [id, want] = arg.split(/\s+/);
        if (!id) return void (await say(`Mức tự chủ:\n${ws.map((w) => `${icon[w.autonomy]} ${w.name} (@${w.id}): ${w.autonomy}`).join("\n")}\n\nChỉ HẠ được từ điện thoại: /mode <id> manual|auto. Nâng lên (Auto, Full) phải làm ở máy tính.`));
        const w = ws.find((x) => x.id === id);
        if (!w || !isAutonomy(want)) return void (await say(`Dùng: /mode <${ws.map((x) => x.id).join("|")}> manual|auto`));
        const rank = { manual: 0, auto: 1, full: 2 } as const;
        if (rank[want] >= rank[w.autonomy]) return void (await say(w.autonomy === want ? `@${id} đã ở chế độ ${want}.` : `⛔ Không nâng mức tự chủ từ điện thoại (${w.autonomy} → ${want}). Làm ở máy tính.`));
        room.setAutonomy(id, want, "Telegram");
        return void (await say(`${icon[want]} @${id}: ${w.autonomy} → ${want}.`));
      }
      case "plan": {
        if (!room.plan) return void (await say("Chưa bật theo dõi hạn mức gói."));
        if (arg === "refresh") await room.plan.refresh(undefined, true);
        return void (await say(planText(room.plan.list(), this.now())));
      }
      case "stop": {
        const ids = room.snapshot().workers.map((w) => w.id);
        if (arg === "all") { room.stopAll(); return void (await say("⏹ Đã dừng tất cả worker.")); }
        if (!ids.includes(arg)) return void (await say(`Dùng: /stop <${ids.join("|")}|all>`));
        room.stop(arg);
        return void (await say(`⏹ Đã dừng @${arg}.`));
      }
      case "mute": {
        const ms = arg ? parseDuration(arg) : 3600_000;
        if (!ms) return void (await say("Dùng: /mute 30m (hoặc 2h, 1d)."));
        this.mutedUntil = this.now() + ms;
        this.emit("change");
        return void (await say(`🔕 Tắt tin của worker trong ${arg || "1h"} (cảnh báo và thẻ duyệt vẫn gửi). /unmute để bật lại.`));
      }
      case "unmute": this.mutedUntil = 0; this.emit("change"); return void (await say("🔔 Đã bật lại."));
      case "detail": {
        if (!arg) return void (await say(`Mức chi tiết hiện tại: ${this.detail()}. Dùng /detail summary|full|alerts`));
        if (!["summary", "full", "alerts"].includes(arg)) return void (await say("Dùng: /detail summary|full|alerts"));
        this.detailOverride = arg as Detail;
        this.emit("change");
        return void (await say(`Mức chi tiết: ${arg}${arg === "full" ? "\n⚠️ Toàn văn trả lời của worker (có thể gồm mã) sẽ đi qua máy chủ Telegram, không mã hoá đầu cuối." : ""}`));
      }
      case "budget": {
        const paused = room.snapshot().accounts.filter((a) => a.paused);
        if (!paused.length) return void (await say("Không có account nào đang bị dừng vì ngân sách."));
        return void (await say("Account đang bị dừng vì ngân sách:", paused.map((a) => [{ text: `▶️ Cho ${a.id} chạy tiếp hôm nay (${usd(a.spentToday)} / ${usd(a.budgetUsdPerDay ?? 0)})`, callback_data: `bg:${a.id}` }])));
      }
      case "unpair": await this.unpair(); return void (await this.tell(p.chat, "Đã ngắt ghép cặp. AgentRoom sẽ không gửi gì nữa cho chat này.", { quiet: true }));
      default: return void (await say("Không hiểu lệnh. /help"));
    }
  }

  private async onCallback(c: TgCallback) {
    const p = this.paired();
    const msg = c.message;
    if (!p || c.from.id !== p.id || !msg || msg.chat.id !== p.chat || msg.chat.type !== "private") { this.log(`bỏ qua nút bấm từ id ${c.from.id}`); return; }
    const data = c.data ?? "";
    const bot = this.d.bot;

    if (data.startsWith("fx:")) {
      const t = this.full.get(data.slice(3));
      await bot.answer(c.id, t ? undefined : "Tin này đã quá cũ");
      if (t) await this.tell(p.chat, t, { quiet: true });
      return;
    }

    if (data.startsWith("op:")) {
      const [, key, optionId] = data.split(":");
      const q = this.questions.get(key);
      if (!q) {
        await bot.answer(c.id, "Câu hỏi đã được trả lời hoặc đã quá cũ");
        return void (await bot.edit(msg.chat.id, msg.message_id, `${msg.text ?? ""}\n⌛ Hết hạn`));
      }
      try {
        this.d.room.answerOption(q.msg, optionId, "telegram");
      } catch (e) {
        await bot.answer(c.id, e instanceof Error ? e.message.slice(0, 150) : "Không gửi được");
        return void (await this.closeQuestion(q.msg, optionId, "đã có người trả lời"));
      }
      await bot.answer(c.id, "Đã gửi cho worker");
      return void (await this.closeQuestion(q.msg, optionId, "từ điện thoại"));
    }

    if (data.startsWith("ap:")) {
      const [, verb, id] = data.split(":");
      const req = this.d.room.snapshot().approvals.find((a) => a.id === id);
      if (!req) {
        await bot.answer(c.id, "Yêu cầu đã hết hạn hoặc được xử lý rồi");
        return void (await bot.edit(msg.chat.id, msg.message_id, `${msg.text ?? ""}\n⌛ Đã hết hạn`));
      }
      if (verb === "n") {
        this.phoneHandled.add(id);
        this.approvalMsgs.delete(id);
        this.d.room.respondApproval(id, false);
        await bot.answer(c.id, "Đã từ chối");
        return void (await bot.edit(msg.chat.id, msg.message_id, `${describeApproval(req, this.workerName(req.workerId))}\n❌ Đã từ chối (từ điện thoại)`));
      }
      if (verb !== "y") return;
      // never trust the button: the rules are applied again here
      const verdict = phoneApprovalVerdict(req);
      if (!verdict.safe || this.d.settings().approveFromPhone !== "safe") {
        return void (await bot.answer(c.id, `Chỉ duyệt ở máy tính: ${verdict.reason || "đã tắt"}`));
      }
      return this.confirmWithPin(p, { kind: "approve", id }, c.id);
    }

    if (data.startsWith("bg:")) {
      const account = data.slice(3);
      if (!this.d.room.snapshot().accounts.some((a) => a.id === account && a.paused)) return void (await bot.answer(c.id, "Account này không còn bị dừng"));
      return this.confirmWithPin(p, { kind: "budget", account }, c.id);
    }
  }

  /** Runs the action now, or asks for the PIN first when one is set. */
  private async confirmWithPin(p: PairedUser, action: PinAction, callbackId: string) {
    if (!this.d.stores.pin.get()) { await this.d.bot.answer(callbackId); return this.perform(p, action); }
    const wait = this.guard.locked(p.id);
    if (wait) return void (await this.d.bot.answer(callbackId, `Đang khoá, thử lại sau ${Math.ceil(wait / 60000)} phút`));
    await this.d.bot.answer(callbackId, "Nhập PIN để xác nhận");
    const prompt = await this.tell(p.chat, `🔑 Nhập PIN để ${action.kind === "approve" ? "cho phép" : "cho account chạy tiếp"} (trong ${PIN_TTL / 1000}s). Tin chứa PIN sẽ bị xoá.`);
    this.pendingPin = { user: p.id, action, expiresAt: this.now() + PIN_TTL, prompt };
  }

  private async onPin(m: TgMessage, pin: string) {
    const p = this.paired()!;
    const pending = this.pendingPin!;
    void this.d.bot.remove(m.chat.id, m.message_id);   // do not leave the PIN in the chat
    const stored = this.d.stores.pin.get();
    if (pending.expiresAt < this.now()) { this.pendingPin = undefined; return void (await this.tell(p.chat, "PIN quá hạn, hãy bấm lại nút.", { quiet: true })); }
    const r = stored ? this.guard.check(p.id, pin, stored) : "ok";
    if (r === "ok") { this.pendingPin = undefined; return this.perform(p, pending.action); }
    if (r === "locked") { this.pendingPin = undefined; return void (await this.tell(p.chat, "🔒 Sai PIN quá nhiều lần: khoá duyệt từ điện thoại 10 phút.")); }
    await this.tell(p.chat, "PIN sai. Thử lại hoặc nhắn tin khác để huỷ.", { quiet: true });
  }

  private async perform(p: PairedUser, action: PinAction) {
    const { room, bot } = this.d;
    if (action.kind === "budget") {
      room.allowBudgetToday(action.account);
      return void (await this.tell(p.chat, `▶️ ${action.account} chạy tiếp đến hết hôm nay.`, { quiet: true }));
    }
    const req = room.snapshot().approvals.find((a) => a.id === action.id);
    if (!req) return void (await this.tell(p.chat, "Yêu cầu đã được xử lý rồi.", { quiet: true }));
    const verdict = phoneApprovalVerdict(req);
    if (!verdict.safe) return void (await this.tell(p.chat, `Chỉ duyệt ở máy tính: ${verdict.reason}`, { quiet: true }));
    this.phoneHandled.add(action.id);
    const shown = this.approvalMsgs.get(action.id);
    this.approvalMsgs.delete(action.id);
    room.respondApproval(action.id, true);
    if (shown) await bot.edit(shown.chat, shown.id, `${describeApproval(req, this.workerName(req.workerId))}\n✅ Đã cho phép (từ điện thoại)`);
  }
}

/** Plain text for /plan: one block per account, remaining share and reset time per window. */
export function planText(plans: PlanUsage[], now: number): string {
  if (!plans.length) return "Chưa có account nào.";
  const icon = { ok: "🟢", warning: "🟡", limited: "🔴", unavailable: "⚪", error: "⚠️" } as const;
  return plans.map((p) => {
    const head = `${icon[p.state]} ${p.account} (${p.provider}${p.plan ? ", gói " + p.plan : ""})`;
    const rows = p.windows.map((w) => `  ${w.label}: còn ${Math.max(0, 100 - w.usedPercent).toFixed(0)}%${w.resetsAt ? ` · reset sau ${untilText(w.resetsAt, now)}` : ""}`);
    const age = p.fetchedAt && now - p.fetchedAt > 30 * 60_000 ? `\n  (số liệu cũ: ${Math.round((now - p.fetchedAt) / 60_000)} phút trước)` : "";
    return [head, ...rows, p.note ? `  ${p.note}` : ""].filter(Boolean).join("\n") + age;
  }).join("\n\n");
}
