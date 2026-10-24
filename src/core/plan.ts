import { tr } from "./i18n";
import { EventEmitter } from "node:events";
import type { Account, Provider } from "./types";

/**
 * How much of a subscription plan an account has used. Neither provider reports absolute token
 * counts for a plan, only the share of each rolling window that is used and when it resets, so
 * "remaining" is always `100 - usedPercent` of a window.
 */
export interface PlanWindow {
  key: string;
  label: string;
  /** 0-100 */
  usedPercent: number;
  /** epoch ms */
  resetsAt?: number;
}

export interface PlanUsage {
  account: string;
  provider: Provider;
  /** ok: under the account's warning level · warning: at/above it · limited: a window is full · unavailable: no plan numbers exist for this login · error: the probe failed */
  state: "ok" | "warning" | "limited" | "unavailable" | "error";
  plan?: string;
  windows: PlanWindow[];
  note?: string;
  fetchedAt: number;
}

export type PlanProbe = (account: Account) => Promise<PlanUsage>;

const clampPct = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
const isoMs = (s: string | null | undefined) => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : undefined;
};
const secMs = (n: number | null | undefined) => (typeof n === "number" ? (n < 1e12 ? n * 1000 : n) : undefined);

export const windowLabel = (key: string): string => {
  switch (key) {
    case "five_hour": return tr("5 giờ");
    case "seven_day": return tr("7 ngày");
    case "seven_day_opus": return tr("7 ngày · Opus");
    case "seven_day_sonnet": return tr("7 ngày · Sonnet");
    case "seven_day_oauth_apps": return tr("7 ngày · ứng dụng OAuth");
    default: return key;
  }
};

/** Maps the Claude Agent SDK's usage response. Unknown windows that carry a utilization are kept, not dropped. */
export function fromClaudeUsage(account: string, r: unknown, now: number): PlanUsage {
  const base = { account, provider: "claude" as const, fetchedAt: now };
  const u = r as { subscription_type?: string | null; rate_limits_available?: boolean; rate_limits?: Record<string, unknown> | null };
  if (!u?.rate_limits_available || !u.rate_limits) {
    return { ...base, state: "unavailable", windows: [], note: tr("Đăng nhập bằng API key hoặc nhà cung cấp khác nên không có hạn mức gói. Chi phí thật xem ở tab Chi phí.") };
  }
  const windows: PlanWindow[] = [];
  for (const [key, v] of Object.entries(u.rate_limits)) {
    if (key === "extra_usage" || key === "model_scoped" || !v || typeof v !== "object") continue;
    const w = v as { utilization?: number | null; resets_at?: string | null };
    if (typeof w.utilization !== "number") continue;
    windows.push({ key, label: windowLabel(key), usedPercent: clampPct(w.utilization), resetsAt: isoMs(w.resets_at) });
  }
  const scoped = u.rate_limits.model_scoped;
  if (Array.isArray(scoped)) {
    for (const s of scoped as { display_name?: string; utilization?: number | null; resets_at?: string | null }[]) {
      if (typeof s?.utilization === "number") windows.push({ key: `model:${s.display_name}`, label: tr("7 ngày · {display_name}", { display_name: s.display_name }), usedPercent: clampPct(s.utilization), resetsAt: isoMs(s.resets_at) });
    }
  }
  const extra = u.rate_limits.extra_usage as { is_enabled?: boolean; utilization?: number | null; used_credits?: number | null; monthly_limit?: number | null; currency?: string | null } | null | undefined;
  let note: string | undefined;
  if (extra?.is_enabled) {
    if (typeof extra.utilization === "number") windows.push({ key: "extra_usage", label: tr("Credit bổ sung (tháng)"), usedPercent: clampPct(extra.utilization) });
    if (extra.used_credits != null) note = (tr("Credit bổ sung đã dùng: {used}", { used: extra.used_credits }) + (extra.monthly_limit != null ? ` / ${extra.monthly_limit}` : "") + ` ${extra.currency ?? ""}`).trim();
  }
  return { ...base, state: "ok", plan: u.subscription_type ?? undefined, windows, note };
}

const mins = (m: number | null | undefined) => (m == null ? undefined : m === 300 ? tr("5 giờ") : m === 10080 ? tr("7 ngày") : m % 1440 === 0 ? tr("{p} ngày", { p: m / 1440 }) : m % 60 === 0 ? tr("{p} giờ", { p: m / 60 }) : tr("{m} phút", { m }));

/** Maps the Codex app-server's `account/rateLimits/read` result. */
export function fromCodexLimits(account: string, r: unknown, now: number): PlanUsage {
  const base = { account, provider: "codex" as const, fetchedAt: now };
  const res = r as { rateLimits?: Snapshot; rateLimitsByLimitId?: Record<string, Snapshot> | null };
  type Win = { usedPercent: number; windowDurationMins?: number | null; resetsAt?: number | null };
  type Snapshot = { limitId?: string | null; limitName?: string | null; planType?: string | null; primary?: Win | null; secondary?: Win | null; rateLimitReachedType?: string | null; credits?: { hasCredits: boolean; unlimited: boolean; balance?: string | null } | null };
  const buckets = res?.rateLimitsByLimitId && Object.keys(res.rateLimitsByLimitId).length ? Object.values(res.rateLimitsByLimitId) : res?.rateLimits ? [res.rateLimits] : [];
  if (!buckets.length) return { ...base, state: "unavailable", windows: [], note: tr("Codex không trả số liệu hạn mức cho tài khoản này.") };
  const windows: PlanWindow[] = [];
  let plan: string | undefined, reached = false, note: string | undefined;
  for (const b of buckets) {
    plan ??= b.planType ?? undefined;
    reached ||= !!b.rateLimitReachedType;
    const name = buckets.length > 1 ? (b.limitName ?? b.limitId ?? "") : "";
    for (const [slot, w] of [["primary", b.primary], ["secondary", b.secondary]] as const) {
      if (!w) continue;
      windows.push({ key: `${b.limitId ?? "codex"}:${slot}`, label: [mins(w.windowDurationMins) ?? slot, name].filter(Boolean).join(" · "), usedPercent: clampPct(w.usedPercent), resetsAt: secMs(w.resetsAt) });
    }
    if (b.credits && !b.credits.unlimited && b.credits.hasCredits && b.credits.balance) note = tr("Credit còn lại: {balance}", { balance: b.credits.balance });
  }
  return { ...base, state: reached ? "limited" : "ok", plan, windows, note };
}

/** Sets warning/limited from the windows; `warnAt` is the account's warnAtPercent. */
export function classify(p: PlanUsage, warnAt: number): PlanUsage {
  if (p.state !== "ok" && p.state !== "warning") return p;
  const top = Math.max(0, ...p.windows.map((w) => w.usedPercent));
  return { ...p, state: top >= 100 ? "limited" : top >= warnAt ? "warning" : "ok" };
}

export interface PlanMonitorDeps {
  accounts: Account[];
  probe: PlanProbe;
  now?: () => number;
  /** 0 turns polling off (manual refresh and after-turn refreshes still work). */
  pollMs: () => number;
  /** Minimum gap between two probes of the same account unless forced. */
  minGapMs?: number;
  alert(text: string): void;
  /** A window is full: hold the account's queue until it resets. */
  pause(accountId: string, untilMs: number): void;
}

/**
 * Keeps the latest plan numbers per account. The probes are cheap but the endpoints behind them are
 * rate-limited, so probes are spaced out, run one at a time per account, and a failed probe keeps the
 * previous numbers (marked stale by `fetchedAt`) instead of blanking the card.
 */
export class PlanMonitor extends EventEmitter<{ change: [] }> {
  private data = new Map<string, PlanUsage>();
  private lastTry = new Map<string, number>();
  private inflight = new Map<string, Promise<void>>();
  private announced = new Set<string>();
  private timer?: NodeJS.Timeout;
  private now: () => number;

  constructor(private d: PlanMonitorDeps) {
    super();
    this.now = d.now ?? Date.now;
  }

  list(): PlanUsage[] {
    return this.d.accounts.map((a) => this.data.get(a.id) ?? { account: a.id, provider: a.provider, state: "unavailable" as const, windows: [], note: tr("Chưa đo."), fetchedAt: 0 });
  }

  start() {
    this.stop();
    void this.refresh();
    const tick = () => {
      const ms = this.d.pollMs();
      this.timer = setTimeout(() => { void this.refresh().finally(tick); }, ms > 0 ? ms : 60_000);
      this.timer.unref?.();
    };
    tick();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** After a turn or a rate-limit event: refresh that account, at most every `minGapMs`. */
  touch(accountId: string) {
    void this.refresh(accountId);
  }

  async refresh(accountId?: string, force = false): Promise<void> {
    const targets = this.d.accounts.filter((a) => !accountId || a.id === accountId);
    await Promise.all(targets.map((a) => this.refreshOne(a, force)));
  }

  private refreshOne(a: Account, force: boolean): Promise<void> {
    const running = this.inflight.get(a.id);
    if (running) return running;
    if (a.baseUrl) {
      this.set({ account: a.id, provider: a.provider, state: "unavailable", windows: [], fetchedAt: this.now(), note: tr("Account dùng endpoint riêng ({url}): không có gói đăng ký để đo. Chi phí xem ở tab Chi phí (số tiền do CLI ước tính theo giá Anthropic, có thể sai).", { url: new URL(a.baseUrl).host }) });
      return Promise.resolve();
    }
    if (a.host) {
      this.set({ account: a.id, provider: a.provider, state: "unavailable", windows: [], fetchedAt: this.now(), note: tr("Tài khoản chạy trên máy \"{host}\": chưa đo được hạn mức gói từ xa. Chi phí xem ở tab Chi phí.", { host: a.host }) });
      return Promise.resolve();
    }
    const gap = this.d.minGapMs ?? 120_000;
    const last = this.lastTry.get(a.id) ?? 0;
    if (!force && this.now() - last < gap) return Promise.resolve();
    this.lastTry.set(a.id, this.now());
    const p = (async () => {
      let next: PlanUsage;
      try {
        next = classify(await this.d.probe(a), a.warnAtPercent);
      } catch (e) {
        const prev = this.data.get(a.id);
        const msg = e instanceof Error ? e.message : String(e);
        // Keep the last good numbers (their fetchedAt shows how old they are).
        next = prev && prev.windows.length ? { ...prev, note: tr("Không cập nhật được: {msg}", { msg }) } : { account: a.id, provider: a.provider, state: "error", windows: [], fetchedAt: this.now(), note: msg };
      }
      this.set(next);
      this.react(a, next);
    })().finally(() => this.inflight.delete(a.id));
    this.inflight.set(a.id, p);
    return p;
  }

  private set(p: PlanUsage) {
    this.data.set(p.account, p);
    this.emit("change");
  }

  /** One alert per window per reset period and level; a full window holds the account's queue. */
  private react(a: Account, p: PlanUsage) {
    if (p.state === "error" || p.state === "unavailable") return;
    for (const w of p.windows) {
      const cycle = w.resetsAt ? Math.floor(w.resetsAt / 60_000) : "x";
      const tag = `${a.id}:${w.key}:${cycle}`;
      const left = w.resetsAt ? ` Reset ${new Date(w.resetsAt).toLocaleString("vi-VN")}.` : "";
      if (w.usedPercent >= 100) {
        if (this.announced.has(tag + ":full")) continue;
        this.announced.add(tag + ":full");
        this.d.alert(tr("⛔ Gói của account {id} ({label}) đã hết hạn mức.{left}{p}", { id: a.id, label: w.label, left, p: w.resetsAt ? tr(" Hàng đợi của account tạm dừng tới lúc reset.") : "" }));
        if (w.resetsAt && w.resetsAt > this.now()) this.d.pause(a.id, w.resetsAt);
      } else if (w.usedPercent >= a.warnAtPercent) {
        if (this.announced.has(tag + ":warn") || this.announced.has(tag + ":full")) continue;
        this.announced.add(tag + ":warn");
        this.d.alert(tr("⚠️ Gói của account {id} ({label}) đã dùng {p}%.{left}", { id: a.id, label: w.label, p: Math.round(w.usedPercent), left }));
      }
    }
  }
}

/** "2 giờ 13 phút" style countdown for the UI and Telegram. */
export function untilText(resetsAt: number | undefined, now: number): string {
  if (!resetsAt) return "";
  const ms = resetsAt - now;
  if (ms <= 0) return tr("đang reset");
  const m = Math.round(ms / 60_000);
  if (m < 60) return tr("{m} phút", { m });
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? tr("{h} giờ {m} phút", { h, m: m % 60 }) : tr("{h} giờ", { h });
  return tr("{n} ngày", { n: Math.round(h / 24) });
}
