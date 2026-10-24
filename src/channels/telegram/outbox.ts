import { TelegramError } from "./api";

export interface Job<T> {
  chat: number;
  /** Quiet jobs may be dropped when a chat is flooded; loud ones (approvals, alerts) never are. */
  quiet: boolean;
  run(): Promise<T>;
}

export interface OutboxOptions {
  /** Telegram asks for roughly one message per second per chat. */
  minIntervalMs?: number;
  maxQueued?: number;
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  onDropped?: (chat: number, n: number) => void;
}

interface Item { job: Job<unknown>; resolve(v: unknown): void; reject(e: unknown): void }

/** Per-chat FIFO that spaces messages out, honours 429 retry_after, and sheds quiet jobs under load. */
export class Outbox {
  private queues = new Map<number, Item[]>();
  private busy = new Set<number>();
  private last = new Map<number, number>();
  private o: Required<Omit<OutboxOptions, "onDropped">> & Pick<OutboxOptions, "onDropped">;

  constructor(opts: OutboxOptions = {}) {
    this.o = {
      minIntervalMs: opts.minIntervalMs ?? 1100,
      maxQueued: opts.maxQueued ?? 30,
      maxRetries: opts.maxRetries ?? 3,
      sleep: opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      now: opts.now ?? Date.now,
      onDropped: opts.onDropped,
    };
  }

  enqueue<T>(job: Job<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const q = this.queues.get(job.chat) ?? [];
      q.push({ job: job as Job<unknown>, resolve: resolve as (v: unknown) => void, reject });
      this.queues.set(job.chat, q);
      this.shed(job.chat);
      void this.pump(job.chat);
    });
  }

  private shed(chat: number) {
    const q = this.queues.get(chat)!;
    let dropped = 0;
    while (q.length > this.o.maxQueued) {
      const i = q.findIndex((x) => x.job.quiet);
      if (i < 0) break;
      const [gone] = q.splice(i, 1);
      gone.reject(new Error("dropped"));
      dropped++;
    }
    if (dropped) this.o.onDropped?.(chat, dropped);
  }

  private async pump(chat: number) {
    if (this.busy.has(chat)) return;
    this.busy.add(chat);
    try {
      const q = this.queues.get(chat)!;
      while (q.length) {
        const wait = (this.last.get(chat) ?? 0) + this.o.minIntervalMs - this.o.now();
        if (wait > 0) await this.o.sleep(wait);
        const item = q.shift()!;
        for (let attempt = 0; ; attempt++) {
          try {
            item.resolve(await item.job.run());
            break;
          } catch (e) {
            if (e instanceof TelegramError && e.code === 429 && attempt < this.o.maxRetries) {
              await this.o.sleep(((e.retryAfter ?? 1) + 0.2) * 1000);
              continue;
            }
            item.reject(e);
            break;
          }
        }
        this.last.set(chat, this.o.now());
      }
    } finally {
      this.busy.delete(chat);
    }
  }
}
