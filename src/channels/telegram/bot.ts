import { EventEmitter } from "node:events";
import { BotApi, InlineButton, TelegramError, TgCallback, TgMessage, TgUpdate, TgUser } from "./api";
import { CHUNK, splitMessage } from "./format";
import { Outbox } from "./outbox";

export type BotState = "stopped" | "starting" | "running" | "retrying" | "conflict" | "error";

export interface BotDeps {
  log?: (text: string) => void;
  sleep?: (ms: number) => Promise<void>;
  pollSec?: number;
  outbox?: Outbox;
  /** How often a conflicting poller is re-tried before giving up. */
  conflictRetries?: number;
  conflictWaitMs?: number;
}

export interface SendArgs { buttons?: InlineButton[][]; quiet?: boolean }

/**
 * Long-polling bot. Outbound connections only: nothing listens, nothing needs a tunnel.
 *  - Updates that piled up while AgentRoom was off are read and DISCARDED (reported through
 *    "backlog"): replaying a stale "/stop" or an old approval tap would be worse than losing a message.
 *  - 401 (bad token) and persistent 409 (another poller or a webhook owns the bot) stop the loop with
 *    an explanation instead of fighting over the bot.
 */
export class TelegramBot extends EventEmitter<{ state: []; message: [TgMessage]; callback: [TgCallback]; backlog: [TgUpdate[]] }> {
  state: BotState = "stopped";
  error?: string;
  me?: TgUser;
  private running = false;
  private offset = 0;
  private outbox: Outbox;
  private sleep: (ms: number) => Promise<void>;
  private loop?: Promise<void>;

  constructor(private api: BotApi, private deps: BotDeps = {}) {
    super();
    this.outbox = deps.outbox ?? new Outbox();
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private set(state: BotState, error?: string) {
    this.state = state;
    this.error = error;
    this.emit("state");
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.set("starting");
    try {
      this.me = await this.api.getMe();
      await this.discardBacklog();
    } catch (e) {
      this.running = false;
      return this.fail(e);
    }
    this.set("running");
    this.loop = this.poll();
  }

  stop() {
    this.running = false;
    this.set("stopped");
  }

  private fail(e: unknown) {
    if (e instanceof TelegramError && e.code === 401) return this.set("error", "Token bot không hợp lệ (Telegram trả 401). Đặt lại token.");
    if (e instanceof TelegramError && e.code === 409) return this.set("conflict", "Bot đang được một chương trình khác nhận tin (hoặc có webhook). Mỗi token chỉ có một nơi nhận tin: hãy dùng bot riêng cho AgentRoom.");
    return this.set("error", e instanceof Error ? e.message : String(e));
  }

  private async discardBacklog() {
    const old: TgUpdate[] = [];
    for (let i = 0; i < 20; i++) {
      const batch = await this.api.getUpdates(this.offset, 0);
      if (!batch.length) break;
      old.push(...batch);
      this.offset = batch[batch.length - 1].update_id + 1;
    }
    if (old.length) this.emit("backlog", old);
  }

  private async poll() {
    let backoff = 1000, conflicts = 0;
    while (this.running) {
      try {
        const updates = await this.api.getUpdates(this.offset, this.deps.pollSec ?? 25);
        if (!this.running) return;
        if (this.state !== "running") this.set("running");
        backoff = 1000; conflicts = 0;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          try {
            if (u.message) this.emit("message", u.message);
            else if (u.callback_query) this.emit("callback", u.callback_query);
          } catch (e) {
            this.deps.log?.(`lỗi khi xử lý update ${u.update_id}: ${e instanceof Error ? e.message : e}`);
          }
        }
      } catch (e) {
        if (!this.running) return;
        if (e instanceof TelegramError && e.code === 401) { this.running = false; return this.fail(e); }
        if (e instanceof TelegramError && e.code === 409) {
          if (++conflicts > (this.deps.conflictRetries ?? 4)) { this.running = false; return this.fail(e); }
          this.set("conflict", "Có nơi khác đang nhận tin của bot này; đang thử lại…");
          await this.sleep(this.deps.conflictWaitMs ?? 15_000);
          continue;
        }
        this.set("retrying", e instanceof Error ? e.message : String(e));
        await this.sleep(backoff);
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  }

  /** Waits for the poll loop to end (tests). */
  async idle() { await this.loop; }

  // ---- outbound ----

  /** Sends text (split into several messages if long); returns the id of the last one. Buttons go on the last. */
  async send(chat: number, text: string, args: SendArgs = {}): Promise<number> {
    const parts = splitMessage(text, CHUNK);
    let id = 0;
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1;
      const m = await this.outbox.enqueue({
        chat, quiet: !!args.quiet,
        run: () => this.api.sendMessage(chat, parts[i], { silent: args.quiet, buttons: last ? args.buttons : undefined }),
      });
      id = m.message_id;
    }
    return id;
  }

  async edit(chat: number, messageId: number, text: string, buttons: InlineButton[][] = []) {
    try {
      await this.api.editMessageText(chat, messageId, text.slice(0, 4000), buttons);
    } catch (e) {
      // "message is not modified" and "message to edit not found" are harmless
      if (!(e instanceof TelegramError && e.code === 400)) throw e;
    }
  }

  answer(callbackId: string, text?: string) { return this.api.answerCallbackQuery(callbackId, text).catch(() => undefined); }
  remove(chat: number, messageId: number) { return this.api.deleteMessage(chat, messageId).catch(() => undefined); }
}
