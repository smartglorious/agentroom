import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PromptSection } from "./prompt";
import { TurnUsage } from "./types";

export const estimateTokens = (text: string) => Math.ceil(text.length / 4);

export interface SectionInfo {
  name: string;
  chars: number;
  tokens: number;
}

export interface TurnRecord {
  turnId: string;
  ts: number;
  worker: string;
  account: string;
  model?: string;
  sessionKey: string;
  resumed: boolean;
  taskId?: string;
  cwd: string;
  readOnly: boolean;
  allowedTools: string[];
  useSkills: string[];
  systemSections: SectionInfo[];
  promptSections: SectionInfo[];
  systemAppend: string;
  prompt: string;
  usage?: TurnUsage;
  /** New Claude sessions only: what the CLI says fills the window before the worker does anything. */
  context?: { categories: { name: string; tokens: number }[]; total: number };
  error?: string;
}

export const sectionInfo = (sections: PromptSection[]): SectionInfo[] =>
  sections.map((s) => ({ name: s.name, chars: s.text.length, tokens: estimateTokens(s.text) }));

export const newTurnId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** Stores what AgentRoom sent for each turn, newest `keep` turns only (0 disables). */
export class TurnInspector {
  private dir: string;

  constructor(stateDir: string, private keep: number) {
    this.dir = join(stateDir, "turns");
  }

  save(rec: TurnRecord) {
    if (this.keep <= 0) return;
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${rec.turnId}.json`), JSON.stringify(rec));
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".json")).sort();
    for (const f of files.slice(0, Math.max(0, files.length - this.keep))) rmSync(join(this.dir, f), { force: true });
  }

  load(turnId: string): TurnRecord | undefined {
    if (!/^[\w-]+$/.test(turnId)) return undefined;
    const f = join(this.dir, `${turnId}.json`);
    if (!existsSync(f)) return undefined;
    try { return JSON.parse(readFileSync(f, "utf8")); } catch { return undefined; }
  }
}

const fence = (text: string) => "````text\n" + text.replace(/````/g, "```") + "\n````";
const num = (n: number) => n.toLocaleString("en-US");

/** Markdown view of one turn: what was sent, split by section, with token estimates. */
export function renderTurn(r: TurnRecord): string {
  const sent = [...r.systemSections, ...r.promptSections].reduce((a, s) => a + s.tokens, 0);
  const u = r.usage;
  const real = u ? u.input + u.cacheRead + u.cacheWrite : undefined;
  const lines: string[] = [
    `# Lượt ${r.turnId} — @${r.worker}`,
    "",
    `| | |`, `|---|---|`,
    `| Thời gian | ${new Date(r.ts).toLocaleString()} |`,
    `| Account / model | ${r.account} / ${r.model ?? u?.model ?? "mặc định"} |`,
    `| Session | ${r.sessionKey} (${r.resumed ? "tiếp tục session cũ" : "session mới"}) |`,
    `| Thư mục làm việc | ${r.cwd} |`,
    `| Chế độ | ${r.readOnly ? "chỉ đọc (nguồn không tin cậy)" : "bình thường"} |`,
    `| Quyền tự động | ${r.allowedTools.join(", ") || "(không)"} |`,
    `| Skills bật | ${r.useSkills.join(", ") || "(không)"} |`,
  ];
  if (u) {
    lines.push(`| Token thực tế | input ${num(u.input)} · cache đọc ${num(u.cacheRead)} · cache ghi ${num(u.cacheWrite)} · output ${num(u.output)} |`);
    lines.push(`| Chi phí | ${u.costUsd === undefined ? "—" : `$${u.costUsd.toFixed(4)}${u.estimated ? " (ước tính)" : ""}`} |`);
  }
  if (r.error) lines.push(`| Lỗi | ${r.error} |`);
  lines.push("", "## Token theo phần (ước tính = ký tự ÷ 4)", "", "| Phần | Ký tự | ≈ Token |", "|---|---:|---:|");
  for (const s of [...r.systemSections.map((x) => ({ ...x, name: `System · ${x.name}` })), ...r.promptSections.map((x) => ({ ...x, name: `Prompt · ${x.name}` }))]) {
    lines.push(`| ${s.name} | ${num(s.chars)} | ${num(s.tokens)} |`);
  }
  lines.push(`| **Tổng AgentRoom gửi** | | **${num(sent)}** |`);
  if (real !== undefined) {
    lines.push("", `Token thực tế phía model: **${num(real)}**. Phần chênh ≈ **${num(Math.max(0, real - sent))}** là system prompt của CLI và lịch sử session đã resume — phần này không xem chi tiết được.`);
  }
  if (r.context) {
    lines.push("", "## Context cố định của session mới (CLI báo)", "", "| Mục | Token |", "|---|---:|");
    for (const c of [...r.context.categories].sort((a, b) => b.tokens - a.tokens)) lines.push(`| ${c.name} | ${num(c.tokens)} |`);
    lines.push(`| **Tổng** | **${num(r.context.total)}** |`, "", "Phần này được đọc lại ở MỌI lần gọi của session, nên nó là mức sàn của mỗi lượt.");
  }
  lines.push("", "## System prompt (phần AgentRoom thêm vào)", "", fence(r.systemAppend), "", "## Prompt của lượt", "", fence(r.prompt), "");
  return lines.join("\n");
}
