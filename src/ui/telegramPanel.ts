import { EventEmitter } from "node:events";
import type { BotState } from "../channels/telegram/bot";
import type { TelegramService } from "../channels/telegram/service";

export type Phase = "disabled" | "no-token" | BotState;

export interface PanelStatus {
  phase: Phase;
  bot?: string;
  error?: string;
  paired?: { name: string };
  pairing?: { code: string; expiresAt: number };
  mutedUntil?: number;
  pin: boolean;
  detail: string;
}

/** What the UI shows about Telegram, whether or not a service is currently running. */
export class TelegramPanel extends EventEmitter<{ change: [] }> {
  private svc?: TelegramService;
  private reason: "disabled" | "no-token" = "disabled";
  private onChange = () => this.emit("change");

  attach(svc: TelegramService | undefined, reason: "disabled" | "no-token" = "disabled") {
    this.svc?.off("change", this.onChange);
    this.svc = svc;
    this.reason = reason;
    svc?.on("change", this.onChange);
    this.emit("change");
  }

  get service() { return this.svc; }

  status(): PanelStatus {
    if (!this.svc) return { phase: this.reason, pin: false, detail: "summary" };
    const s = this.svc.status();
    return { phase: s.state, bot: s.bot, error: s.error, paired: s.paired && { name: s.paired.name }, pairing: s.pairing, mutedUntil: s.mutedUntil, pin: s.pin, detail: s.detail };
  }
}
