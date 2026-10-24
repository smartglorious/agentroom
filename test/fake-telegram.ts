import { createServer, IncomingMessage, Server } from "node:http";
import type { InlineButton, TgMessage, TgUpdate } from "../src/channels/telegram/api";

export interface Sent {
  id: number;
  chat: number;
  text: string;
  silent: boolean;
  buttons: InlineButton[][];
  edits: string[];
  deleted: boolean;
}

/**
 * A stand-in for api.telegram.org, built from what the Bot API documents: JSON in/out, `ok` envelope,
 * long-polling getUpdates that confirms by offset, 409 when a second poller (or a webhook) exists,
 * 4096-char and 64-byte limits, 429 with retry_after, "message is not modified". It is only as faithful
 * as that understanding — real Telegram is the final judge.
 */
export class FakeTelegram {
  readonly token = "4242:TEST-TOKEN-abcdef";
  sent: Sent[] = [];
  answers: { id: string; text?: string }[] = [];
  methods: string[] = [];
  webhookUrl = "";
  failNext = 0;
  /** Answer 429 when the same chat is written to again within this many ms. */
  rateLimitMs = 0;
  pollCapMs = 300;
  private server!: Server;
  private updates: TgUpdate[] = [];
  private nextUpdate = 100;
  private nextMsg = 1;
  private waiter?: { reply: (code: number, body: unknown) => void; timer: NodeJS.Timeout };
  private lastSend = new Map<number, number>();
  base = "";

  async start() {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  stop() {
    this.waiter?.reply(200, { ok: true, result: [] });
    this.server.closeAllConnections();
    this.server.close();
  }

  // ---- what the "person on the phone" does ----

  userSays(user: number, text: string | undefined, o: { chat?: number; type?: string; forward?: boolean; edited?: boolean; name?: string } = {}) {
    const msg: TgMessage = {
      message_id: this.nextMsg++, date: 1, chat: { id: o.chat ?? user, type: o.type ?? "private" },
      from: { id: user, first_name: o.name ?? "Minh", is_bot: false }, ...(text !== undefined ? { text } : {}),
      ...(o.forward ? { forward_origin: { type: "user" }, forward_date: 1 } : {}),
    };
    this.push(o.edited ? { update_id: this.nextUpdate++, edited_message: msg } : { update_id: this.nextUpdate++, message: msg });
    return msg;
  }

  userTaps(user: number, sent: Sent, data: string) {
    this.push({
      update_id: this.nextUpdate++,
      callback_query: { id: `cb${this.nextUpdate}`, from: { id: user, first_name: "Minh" }, data, message: { message_id: sent.id, chat: { id: sent.chat, type: "private" }, date: 1, text: sent.text } },
    });
  }

  private push(u: TgUpdate) {
    this.updates.push(u);
    this.waiter?.reply(200, { ok: true, result: this.pending(0) });
  }

  pendingCount() { return this.updates.length; }
  private pending(offset: number) { return this.updates.filter((u) => u.update_id >= offset); }
  texts(chat?: number) { return this.sent.filter((s) => chat === undefined || s.chat === chat).map((s) => s.text); }
  last(chat?: number) { return this.sent.filter((s) => chat === undefined || s.chat === chat).at(-1); }

  // ---- the API ----

  private async handle(req: IncomingMessage, res: import("node:http").ServerResponse) {
    let raw = "";
    for await (const c of req) raw += c;
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url ?? "");
    const params = raw ? JSON.parse(raw) : {};
    const reply = (code: number, body: unknown) => { if (!res.writableEnded) { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); } };
    const err = (code: number, description: string, extra: object = {}) => reply(code, { ok: false, error_code: code, description, ...extra });
    if (!m || m[1] !== this.token) return err(401, "Unauthorized");
    const method = m[2];
    this.methods.push(method);
    if (this.failNext > 0) { this.failNext--; return err(500, "Internal Server Error"); }

    switch (method) {
      case "getMe": return reply(200, { ok: true, result: { id: 999, is_bot: true, first_name: "AgentRoom Test", username: "agentroom_test_bot" } });
      case "getWebhookInfo": return reply(200, { ok: true, result: { url: this.webhookUrl } });
      case "getUpdates": {
        if (this.webhookUrl) return err(409, "Conflict: can't use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first");
        this.updates = this.updates.filter((u) => u.update_id >= (params.offset ?? 0));      // confirm
        if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.reply(409, { ok: false, error_code: 409, description: "Conflict: terminated by other getUpdates request; make sure that only one bot instance is running" }); }
        const now = this.pending(params.offset ?? 0);
        if (now.length || !params.timeout) return reply(200, { ok: true, result: now });
        const timer = setTimeout(() => { this.waiter = undefined; reply(200, { ok: true, result: [] }); }, Math.min(params.timeout * 1000, this.pollCapMs));
        this.waiter = { timer, reply: (c, b) => { clearTimeout(timer); this.waiter = undefined; reply(c, b); } };
        return;
      }
      case "sendMessage": {
        const text: string = params.text ?? "";
        if (!text) return err(400, "Bad Request: message text is empty");
        if (text.length > 4096) return err(400, "Bad Request: message is too long");
        const kb: InlineButton[][] = params.reply_markup?.inline_keyboard ?? [];
        for (const row of kb) for (const b of row) if (Buffer.byteLength(b.callback_data) > 64) return err(400, "Bad Request: BUTTON_DATA_INVALID");
        const last = this.lastSend.get(params.chat_id) ?? 0;
        if (this.rateLimitMs && Date.now() - last < this.rateLimitMs) return err(429, "Too Many Requests: retry after 1", { parameters: { retry_after: 1 } });
        this.lastSend.set(params.chat_id, Date.now());
        const s: Sent = { id: this.nextMsg++, chat: params.chat_id, text, silent: !!params.disable_notification, buttons: kb, edits: [], deleted: false };
        this.sent.push(s);
        return reply(200, { ok: true, result: { message_id: s.id, chat: { id: s.chat, type: "private" }, date: 1, text } });
      }
      case "editMessageText": {
        const s = this.sent.find((x) => x.id === params.message_id && x.chat === params.chat_id);
        if (!s) return err(400, "Bad Request: message to edit not found");
        const kb: InlineButton[][] = params.reply_markup?.inline_keyboard ?? [];
        if (s.text === params.text && JSON.stringify(s.buttons) === JSON.stringify(kb)) return err(400, "Bad Request: message is not modified");
        s.edits.push(params.text); s.text = params.text; s.buttons = kb;
        return reply(200, { ok: true, result: true });
      }
      case "deleteMessage": {
        const s = this.sent.find((x) => x.id === params.message_id && x.chat === params.chat_id);
        if (s) s.deleted = true;
        return reply(200, { ok: true, result: !!s });
      }
      case "answerCallbackQuery": this.answers.push({ id: params.callback_query_id, text: params.text }); return reply(200, { ok: true, result: true });
      default: return err(404, "Not Found");
    }
  }
}

export const until = async (pred: () => boolean, ms = 3000, what = "condition") => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};
