import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const PIN_FORMAT = /^\d{4,8}$/;

/** "salt:hash" (hex). The PIN itself is never stored. */
export function hashPin(pin: string, salt = randomBytes(16)): string {
  return `${salt.toString("hex")}:${scryptSync(pin, salt, 32).toString("hex")}`;
}

export function verifyPin(pin: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const got = scryptSync(pin, Buffer.from(salt, "hex"), 32);
  const want = Buffer.from(hash, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Three wrong PINs lock approvals-by-phone for ten minutes. */
export class PinGuard {
  private fails = new Map<number, { n: number; until: number }>();

  constructor(private now: () => number = Date.now, private maxFails = 3, private lockMs = 10 * 60_000) {}

  locked(user: number): number {
    const f = this.fails.get(user);
    return f && f.until > this.now() ? f.until - this.now() : 0;
  }

  check(user: number, pin: string, stored: string): "ok" | "bad" | "locked" {
    if (this.locked(user)) return "locked";
    if (verifyPin(pin, stored)) { this.fails.delete(user); return "ok"; }
    const f = this.fails.get(user) ?? { n: 0, until: 0 };
    f.n++;
    if (f.n >= this.maxFails) { f.until = this.now() + this.lockMs; f.n = 0; this.fails.set(user, f); return "locked"; }
    this.fails.set(user, f);
    return "bad";
  }
}
