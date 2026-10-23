import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface UsageRecord {
  ts: number;
  turnId: string;
  worker: string;
  account: string;
  provider: string;
  model?: string;
  sessionKey: string;
  taskId?: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Absent when the provider reports none and the model has no price configured. */
  costUsd?: number;
  estimated: boolean;
  durationMs: number;
  numTurns?: number;
  tools: Record<string, number>;
  error?: string | null;
}

export type UsageRange = "today" | "7d" | "30d";

export interface Row {
  key: string;
  turns: number;
  tokens: number;
  costUsd: number;
  /** Some of this row's cost is an estimate (Codex). */
  estimated: boolean;
  /** Turns that have no cost figure. */
  unpriced: number;
}

export interface Totals {
  turns: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
  estimated: boolean;
  unpriced: number;
  errors: number;
  cacheHitRate: number;
}

export interface UsageSummary {
  range: UsageRange;
  from: number;
  totals: Totals;
  byWorker: Row[];
  byAccount: Row[];
  byModel: Row[];
  byTask: Row[];
  tools: Record<string, number>;
}

const startOfDay = (ts: number) => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };

export function rangeStart(range: UsageRange, now: number): number {
  return range === "today" ? startOfDay(now) : now - (range === "7d" ? 7 : 30) * 86_400_000;
}

export function nextMidnight(now: number): number {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function group(records: UsageRecord[], keyOf: (r: UsageRecord) => string | undefined): Row[] {
  const map = new Map<string, Row>();
  for (const r of records) {
    const key = keyOf(r);
    if (!key) continue;
    const row = map.get(key) ?? { key, turns: 0, tokens: 0, costUsd: 0, estimated: false, unpriced: 0 };
    row.turns++;
    row.tokens += r.input + r.output + r.cacheRead + r.cacheWrite;
    if (r.costUsd === undefined) row.unpriced++;
    else row.costUsd += r.costUsd;
    if (r.estimated && r.costUsd !== undefined) row.estimated = true;
    map.set(key, row);
  }
  return [...map.values()].sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens);
}

/** Append-only usage log (usage.jsonl) with in-memory aggregation. */
export class UsageStore {
  private records: UsageRecord[] = [];
  private file: string;

  constructor(dir: string, private now: () => number = Date.now) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "usage.jsonl");
    if (existsSync(this.file)) {
      this.records = readFileSync(this.file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
        try { return [JSON.parse(l) as UsageRecord]; } catch { return []; }
      });
    }
  }

  append(r: UsageRecord) {
    this.records.push(r);
    appendFileSync(this.file, JSON.stringify(r) + "\n");
  }

  all() { return this.records; }

  /** Spend so far today (local time) for one account. */
  costToday(account: string): number {
    const from = startOfDay(this.now());
    return this.records.reduce((sum, r) => (r.account === account && r.ts >= from ? sum + (r.costUsd ?? 0) : sum), 0);
  }

  summarize(range: UsageRange): UsageSummary {
    const from = rangeStart(range, this.now());
    const rs = this.records.filter((r) => r.ts >= from);
    const sum = (f: (r: UsageRecord) => number) => rs.reduce((a, r) => a + f(r), 0);
    const input = sum((r) => r.input), cacheRead = sum((r) => r.cacheRead), cacheWrite = sum((r) => r.cacheWrite);
    const tools: Record<string, number> = {};
    for (const r of rs) for (const [t, n] of Object.entries(r.tools)) tools[t] = (tools[t] ?? 0) + n;
    return {
      range,
      from,
      totals: {
        turns: rs.length,
        input,
        output: sum((r) => r.output),
        cacheRead,
        cacheWrite,
        costUsd: sum((r) => r.costUsd ?? 0),
        estimated: rs.some((r) => r.estimated && r.costUsd !== undefined),
        unpriced: rs.filter((r) => r.costUsd === undefined).length,
        errors: rs.filter((r) => r.error).length,
        cacheHitRate: input + cacheRead + cacheWrite > 0 ? cacheRead / (input + cacheRead + cacheWrite) : 0,
      },
      byWorker: group(rs, (r) => r.worker),
      byAccount: group(rs, (r) => r.account),
      byModel: group(rs, (r) => r.model ?? "(không rõ)"),
      byTask: group(rs, (r) => r.taskId),
      tools,
    };
  }

  /** Spend today per worker, for the team bar. */
  todayByWorker(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const r of this.records.filter((x) => x.ts >= startOfDay(this.now()))) out[r.worker] = (out[r.worker] ?? 0) + (r.costUsd ?? 0);
    return out;
  }
}
