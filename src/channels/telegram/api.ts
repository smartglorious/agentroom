/** Minimal Telegram Bot API client (JSON over HTTPS, global fetch). */

export class TelegramError extends Error {
  constructor(readonly code: number, readonly description: string, readonly retryAfter?: number) {
    super(`Telegram ${code}: ${description}`);
  }
}

export interface TgUser { id: number; is_bot?: boolean; first_name?: string; last_name?: string; username?: string }
export interface TgChat { id: number; type: string }
export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
  forward_origin?: unknown;
  forward_date?: number;
  [k: string]: unknown;
}
export interface TgCallback { id: string; from: TgUser; message?: TgMessage; data?: string }
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  edited_message?: TgMessage;
  callback_query?: TgCallback;
}
export interface InlineButton { text: string; callback_data: string }
export interface SendOptions { buttons?: InlineButton[][]; silent?: boolean }

export interface ApiOptions {
  apiBase?: string;
  fetch?: typeof fetch;
}

export class BotApi {
  private base: string;
  private fetchFn: typeof fetch;

  constructor(private token: string, opts: ApiOptions = {}) {
    this.base = (opts.apiBase ?? "https://api.telegram.org").replace(/\/+$/, "");
    this.fetchFn = opts.fetch ?? fetch;
  }

  /** The token is part of every URL, so it must never reach a log or an error message. */
  private scrub(s: string) {
    return s.split(this.token).join("<token>");
  }

  async call<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(params),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new TelegramError(0, this.scrub(`${method}: ${cause?.code ?? cause?.message ?? (e instanceof Error ? e.message : String(e))}`));
    }
    let body: { ok?: boolean; result?: T; error_code?: number; description?: string; parameters?: { retry_after?: number } } | undefined;
    try { body = (await res.json()) as typeof body; } catch { /* not JSON */ }
    if (!body?.ok) throw new TelegramError(body?.error_code ?? res.status, this.scrub(body?.description ?? `HTTP ${res.status}`), body?.parameters?.retry_after);
    return body.result as T;
  }

  getMe() { return this.call<TgUser>("getMe"); }
  getWebhookInfo() { return this.call<{ url?: string }>("getWebhookInfo"); }
  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, (timeoutSec + 10) * 1000);
  }
  sendMessage(chatId: number, text: string, o: SendOptions = {}) {
    return this.call<TgMessage>("sendMessage", {
      chat_id: chatId, text,
      link_preview_options: { is_disabled: true },
      ...(o.silent ? { disable_notification: true } : {}),
      ...(o.buttons?.length ? { reply_markup: { inline_keyboard: o.buttons } } : {}),
    });
  }
  editMessageText(chatId: number, messageId: number, text: string, buttons: InlineButton[][] = []) {
    return this.call<TgMessage | true>("editMessageText", {
      chat_id: chatId, message_id: messageId, text,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: buttons },
    });
  }
  answerCallbackQuery(id: string, text?: string) {
    return this.call<true>("answerCallbackQuery", { callback_query_id: id, ...(text ? { text: text.slice(0, 190) } : {}) });
  }
  deleteMessage(chatId: number, messageId: number) {
    return this.call<true>("deleteMessage", { chat_id: chatId, message_id: messageId });
  }
}
