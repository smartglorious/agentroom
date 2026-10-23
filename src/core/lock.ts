import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

export interface LockInfo {
  token: string;
  pid: number;
  host: string;
  startedAt: number;
  heartbeat: number;
}

export interface LockOptions {
  /** A lock whose heartbeat is older than this is considered abandoned. */
  staleMs?: number;
  heartbeatMs?: number;
  now?: () => number;
  pid?: number;
  host?: string;
}

export type AcquireResult = { ok: true } | { ok: false; holder?: LockInfo };

/**
 * One orchestrator per .agentroom/ folder. Two windows on the same folder would each keep
 * their own chat, overwrite each other's task board, double-fire schedules and ignore each
 * other's account limits, so the second window must not run a room.
 *
 * The holder rewrites the file every `heartbeatMs`; if it ever finds another token there
 * (someone took over, or a start-up race) it emits "lost" and must shut its room down.
 */
export class RoomLock extends EventEmitter<{ lost: [] }> {
  readonly token = randomUUID();
  private timer?: NodeJS.Timeout;
  private held = false;
  private opts: Required<LockOptions>;

  constructor(private file: string, opts: LockOptions = {}) {
    super();
    this.opts = {
      staleMs: opts.staleMs ?? 20_000,
      heartbeatMs: opts.heartbeatMs ?? 5_000,
      now: opts.now ?? Date.now,
      pid: opts.pid ?? process.pid,
      host: opts.host ?? hostname(),
    };
  }

  get isHeld() { return this.held; }

  peek(): LockInfo | undefined {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      return typeof v?.token === "string" && typeof v?.heartbeat === "number" ? (v as LockInfo) : undefined;
    } catch {
      return undefined;
    }
  }

  private info(startedAt = this.opts.now()): LockInfo {
    return { token: this.token, pid: this.opts.pid, host: this.opts.host, startedAt, heartbeat: this.opts.now() };
  }

  private write(info: LockInfo) {
    const tmp = `${this.file}.${this.token.slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(info));
    renameSync(tmp, this.file);
  }

  acquire(): AcquireResult {
    mkdirSync(dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(this.file, "wx");
        closeSync(fd);
        this.write(this.info());
        return this.hold();
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      const cur = this.peek();
      if (cur?.token === this.token) return this.hold();
      if (cur && this.opts.now() - cur.heartbeat < this.opts.staleMs) return { ok: false, holder: cur };
      // Abandoned (or unreadable): remove it only if it is still the same file we looked at.
      const again = this.peek();
      if (!again || (cur && again.token === cur.token && again.heartbeat === cur.heartbeat)) {
        try { unlinkSync(this.file); } catch { /* someone else removed it */ }
      }
    }
    return { ok: false, holder: this.peek() };
  }

  /** Forces the lock. The previous holder notices at its next heartbeat and shuts down. */
  takeOver() {
    mkdirSync(dirname(this.file), { recursive: true });
    this.write(this.info());
    this.hold();
  }

  private hold(): AcquireResult {
    this.held = true;
    if (!this.timer) {
      this.timer = setInterval(() => this.beat(), this.opts.heartbeatMs);
      this.timer.unref?.();
    }
    return { ok: true };
  }

  /** One heartbeat. Public so tests can drive it without waiting. */
  beat() {
    if (!this.held) return;
    const cur = this.peek();
    if (!cur || cur.token !== this.token) {
      this.stop();
      this.emit("lost");
      return;
    }
    try { this.write({ ...cur, heartbeat: this.opts.now() }); } catch { /* retry on the next beat */ }
  }

  private stop() {
    this.held = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  release() {
    const was = this.held;
    this.stop();
    if (was && existsSync(this.file) && this.peek()?.token === this.token) {
      try { unlinkSync(this.file); } catch { /* already gone */ }
    }
  }
}
