/**
 * Runs jobs against shared accounts: at most `maxConcurrent` jobs per account at once,
 * and when a job hits a rate limit the whole account pauses with exponential backoff
 * and the job goes back to the front of the queue.
 */

export class RateLimitError extends Error {
  constructor(message: string, readonly retryAfterMs?: number) {
    super(message);
  }
}

const RATE_LIMIT = /rate.?limit|\b429\b|usage limit|overloaded|quota|too many requests/i;

export function isRateLimit(err: unknown): boolean {
  if (err instanceof RateLimitError) return true;
  return RATE_LIMIT.test(err instanceof Error ? err.message : String(err));
}

interface Job {
  key: string;
  run: () => Promise<void>;
  onRateLimited?: (untilMs: number) => void;
  resolve: () => void;
  reject: (e: unknown) => void;
}

interface Lane {
  max: number;
  running: number;
  queue: Job[];
  pausedUntil: number;
  strikes: number;
  timer?: NodeJS.Timeout;
}

export interface SchedulerOptions {
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  now?: () => number;
}

export class Scheduler {
  private lanes = new Map<string, Lane>();
  private base: number;
  private cap: number;
  private now: () => number;

  constructor(opts: SchedulerOptions = {}) {
    this.base = opts.baseBackoffMs ?? 30_000;
    this.cap = opts.maxBackoffMs ?? 15 * 60_000;
    this.now = opts.now ?? Date.now;
  }

  setLimit(account: string, max: number) {
    this.lane(account).max = Math.max(1, max);
    this.pump(account);
  }

  /** Resolves when the job finally succeeds; rejects on a non rate-limit error. */
  submit(account: string, key: string, run: () => Promise<void>, onRateLimited?: (untilMs: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      this.lane(account).queue.push({ key, run, onRateLimited, resolve, reject });
      this.pump(account);
    });
  }

  /** Holds the account (no new jobs start) until `untilMs`. Running jobs are not interrupted. */
  pauseUntil(account: string, untilMs: number) {
    const l = this.lane(account);
    l.pausedUntil = Math.max(l.pausedUntil, untilMs);
    this.pump(account);
  }

  /** True while the account is held (rate limit back-off, plan used up, budget). */
  isPaused(account: string): boolean { return this.lane(account).pausedUntil > this.now(); }

  resume(account: string) {
    const l = this.lane(account);
    l.pausedUntil = 0;
    l.strikes = 0;
    if (l.timer) { clearTimeout(l.timer); l.timer = undefined; }
    this.pump(account);
  }

  /** Drops queued (not running) jobs whose key starts with `prefix`. */
  cancelQueued(prefix: string) {
    for (const lane of this.lanes.values()) {
      lane.queue = lane.queue.filter((j) => {
        if (!j.key.startsWith(prefix)) return true;
        j.reject(new Error("cancelled"));
        return false;
      });
    }
  }

  stats(account: string) {
    const l = this.lane(account);
    return { running: l.running, queued: l.queue.length, pausedUntil: l.pausedUntil };
  }

  private lane(account: string): Lane {
    let l = this.lanes.get(account);
    if (!l) this.lanes.set(account, (l = { max: 1, running: 0, queue: [], pausedUntil: 0, strikes: 0 }));
    return l;
  }

  private pump(account: string) {
    const l = this.lane(account);
    const wait = l.pausedUntil - this.now();
    if (wait > 0) {
      if (!l.timer) { l.timer = setTimeout(() => { l.timer = undefined; this.pump(account); }, wait); if (wait > 60_000) l.timer.unref?.(); }
      return;
    }
    while (l.running < l.max && l.queue.length) {
      const job = l.queue.shift()!;
      l.running++;
      job.run().then(
        () => { l.strikes = 0; job.resolve(); },
        (err) => {
          if (!isRateLimit(err)) return job.reject(err);
          l.strikes++;
          const delay = err instanceof RateLimitError && err.retryAfterMs
            ? err.retryAfterMs
            : Math.min(this.cap, this.base * 2 ** (l.strikes - 1));
          l.pausedUntil = this.now() + delay;
          l.queue.unshift(job);
          job.onRateLimited?.(l.pausedUntil);
        },
      ).finally(() => { l.running--; this.pump(account); });
    }
  }
}
