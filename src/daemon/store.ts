import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PairedUser, TelegramSettings } from "../channels/telegram/service";

/** Everything the daemon keeps outside the repo. Lives in ~/.agentroom/daemon.json, mode 0600. */
export interface DaemonSettings extends TelegramSettings {
  hookPort: number;
  maxAgentHops: number;
  contextMessages: number;
  memoryBudgetChars: number;
  inspectorKeepTurns: number;
  planPollMinutes: number;
  claudePath: string;
  codexPath: string;
  pricing: Record<string, { input: number; output: number; cachedInput?: number }>;
}

export interface DaemonFile {
  telegram?: { token?: string; pin?: string; paired?: Record<string, PairedUser> };
  settings?: Partial<DaemonSettings>;
  /** "<root>|<host fingerprint>" the user approved with `trust-hosts`. */
  trusted?: string[];
}

export const DEFAULT_SETTINGS: DaemonSettings = {
  detail: "summary", approveFromPhone: "safe", summaryChars: 600, quietHours: "",
  hookPort: 47321, maxAgentHops: 6, contextMessages: 30, memoryBudgetChars: 12000, inspectorKeepTurns: 300, planPollMinutes: 10,
  claudePath: "", codexPath: "", pricing: {},
};

type Parse = (v: string) => unknown;
const oneOf = (...ok: string[]): Parse => (v) => { if (!ok.includes(v)) throw new Error(`chỉ nhận: ${ok.join(" | ")}`); return v; };
const int = (min: number, max: number): Parse => (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`cần số nguyên từ ${min} đến ${max}`);
  return n;
};

/** Keys `agentroom-daemon set <key> <value>` accepts, with validation. Same names as the VS Code settings. */
export const SETTING_PARSERS: Record<keyof DaemonSettings, Parse> = {
  detail: oneOf("summary", "full", "alerts"),
  approveFromPhone: oneOf("safe", "none"),
  summaryChars: int(100, 3000),
  quietHours: (v) => { if (v && !/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(v)) throw new Error("dạng 22:00-07:00, hoặc để trống"); return v; },
  hookPort: int(1024, 65535),
  maxAgentHops: int(1, 50),
  contextMessages: int(1, 200),
  memoryBudgetChars: int(1000, 100000),
  inspectorKeepTurns: int(0, 5000),
  planPollMinutes: int(0, 1440),
  claudePath: (v) => v,
  codexPath: (v) => v,
  pricing: (v) => { const o = JSON.parse(v); if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("cần một object JSON"); return o; },
};

export class DaemonStore {
  constructor(readonly file: string) {}

  read(): DaemonFile {
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      return v && typeof v === "object" ? (v as DaemonFile) : {};
    } catch {
      return {};
    }
  }

  /** Atomic, and never readable by other users (it holds the bot token). */
  update(fn: (f: DaemonFile) => void) {
    const f = this.read();
    fn(f);
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(f, null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try { chmodSync(this.file, 0o600); } catch { /* windows */ }
  }

  settings(): DaemonSettings {
    return { ...DEFAULT_SETTINGS, ...this.read().settings };
  }

  set(key: string, value: string) {
    if (!(key in SETTING_PARSERS)) throw new Error(`Không có cài đặt "${key}". Có: ${Object.keys(SETTING_PARSERS).join(", ")}`);
    const parsed = SETTING_PARSERS[key as keyof DaemonSettings](value);
    this.update((f) => { f.settings = { ...f.settings, [key]: parsed }; });
  }
}

export const defaultStoreFile = (home: string) => join(home, ".agentroom", "daemon.json");
export const pairingFile = (home: string, tokenId: string) => join(home, ".agentroom", `pairing-${tokenId}.json`);
