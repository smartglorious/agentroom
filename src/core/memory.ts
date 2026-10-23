import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "./types";

export type Scope = "me" | "team";
export type Kind = "fact" | "lesson" | "decision";
export const KINDS: Kind[] = ["fact", "lesson", "decision"];

export interface MemoryEntry {
  id: string;
  date: string;
  kind: Kind;
  text: string;
}

export interface RecallHit {
  where: string;
  text: string;
}

export class MemoryError extends Error {}

const LINE = /^- \[(M\d+)\] (\d{4}-\d{2}-\d{2}) · (fact|lesson|decision) · (.*)$/;
export const MAX_ENTRIES = 200;
export const MAX_ENTRY_CHARS = 500;

const SECRETS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/,
  /gh[pousr]_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:password|passwd|secret|token|api[_-]?key)\s*[:=]\s*\S{6,}/i,
];

/** Returns a short label if `text` looks like it contains a credential. */
export function findSecret(text: string): string | undefined {
  return SECRETS.find((r) => r.test(text))?.source.slice(0, 18);
}

export function redactSecrets(text: string): string {
  return SECRETS.reduce((t, r) => t.replace(new RegExp(r.source, r.flags.includes("g") ? r.flags : r.flags + "g"), "[đã ẩn]"), text);
}

const pad = (n: number) => String(n).padStart(2, "0");
export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

export const soulTemplate = (w: Worker) =>
  `# ${w.name} (@${w.id}) — SOUL\n\n<!-- Viết tính cách, cách làm việc và giá trị của worker này. Agent đọc file này mỗi lượt nhưng không tự sửa. -->\n`;

/** Keeps the header and the newest lines of `text` that fit in `budget` characters. */
export function fitTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split("\n");
  const head = lines[0]?.startsWith("#") ? [lines.shift()!] : [];
  const kept: string[] = [];
  let size = head.join("\n").length + 80;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (size + lines[i].length + 1 > budget) break;
    kept.unshift(lines[i]);
    size += lines[i].length + 1;
  }
  const dropped = lines.length - kept.length;
  return [...head, `(… ${dropped} dòng cũ hơn bị lược, dùng recall để tìm)`, ...kept].join("\n");
}

export interface MemoryBlocks {
  soul: string;
  team: string;
  mine: string;
  journal: string;
}

/**
 * File-based memory under <root>/ (usually .agentroom):
 *   agents/<id>/SOUL.md, MEMORY.md, journal/YYYY-MM-DD.md   and   team/MEMORY.md
 * Agents never edit these files directly; they go through add/forget/journal so
 * entries keep stable ids and credentials are refused.
 */
export class MemoryStore {
  constructor(readonly root: string, private now: () => Date = () => new Date()) {}

  agentDir(id: string) { return join(this.root, "agents", id); }
  private memFile(scope: Scope, id: string) {
    return scope === "team" ? join(this.root, "team", "MEMORY.md") : join(this.agentDir(id), "MEMORY.md");
  }
  private journalDir(id: string) { return join(this.agentDir(id), "journal"); }
  journalFile(id: string, date = ymd(this.now())) { return join(this.journalDir(id), `${date}.md`); }
  soulFile(id: string) { return join(this.agentDir(id), "SOUL.md"); }
  memoryFile(scope: Scope, id: string) { return this.memFile(scope, id); }

  /** Creates the worker's folder, a SOUL.md template and empty memory files if missing. */
  ensureWorker(w: Worker) {
    mkdirSync(this.journalDir(w.id), { recursive: true });
    mkdirSync(join(this.root, "team"), { recursive: true });
    if (!existsSync(this.soulFile(w.id))) writeFileSync(this.soulFile(w.id), soulTemplate(w));
    if (!existsSync(this.memFile("me", w.id))) writeFileSync(this.memFile("me", w.id), `# Trí nhớ — @${w.id}\n`);
    if (!existsSync(this.memFile("team", w.id))) writeFileSync(this.memFile("team", w.id), `# Trí nhớ chung của đội\n`);
  }

  entries(scope: Scope, id: string): MemoryEntry[] {
    const f = this.memFile(scope, id);
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").flatMap((l) => {
      const m = LINE.exec(l);
      return m ? [{ id: m[1], date: m[2], kind: m[3] as Kind, text: m[4] }] : [];
    });
  }

  add(scope: Scope, id: string, kind: Kind, text: string): MemoryEntry {
    if (!KINDS.includes(kind)) throw new MemoryError(`kind phải là: ${KINDS.join(", ")}`);
    const clean = text.replace(/\s*\n\s*/g, " ").trim();
    if (!clean) throw new MemoryError("Nội dung trống");
    if (clean.length > MAX_ENTRY_CHARS) throw new MemoryError(`Quá dài (${clean.length} > ${MAX_ENTRY_CHARS} ký tự). Hãy viết ngắn lại.`);
    if (findSecret(clean)) throw new MemoryError("Nội dung giống khóa/mật khẩu nên bị từ chối. Đừng lưu bí mật vào trí nhớ.");
    const list = this.entries(scope, id);
    if (list.length >= MAX_ENTRIES) throw new MemoryError(`Trí nhớ đã đầy (${MAX_ENTRIES} mục). Hãy forget mục lỗi thời hoặc gom lại trước.`);
    const n = list.reduce((m, e) => Math.max(m, Number(e.id.slice(1))), 0) + 1;
    const entry: MemoryEntry = { id: `M${n}`, date: ymd(this.now()), kind, text: clean };
    const f = this.memFile(scope, id);
    mkdirSync(join(f, ".."), { recursive: true });
    const cur = existsSync(f) ? readFileSync(f, "utf8") : "";
    const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
    appendFileSync(f, `${sep}- [${entry.id}] ${entry.date} · ${entry.kind} · ${entry.text}\n`);
    return entry;
  }

  /** Removes an entry. Decisions are protected unless `force` (only on explicit user request). */
  forget(scope: Scope, id: string, entryId: string, force = false): MemoryEntry {
    const f = this.memFile(scope, id);
    const entry = this.entries(scope, id).find((e) => e.id === entryId);
    if (!entry) throw new MemoryError(`Không có mục ${entryId}`);
    if (entry.kind === "decision" && !force) throw new MemoryError(`${entryId} là một decision; chỉ xoá khi người dùng yêu cầu rõ (force=true).`);
    const lines = readFileSync(f, "utf8").split("\n");
    writeFileSync(f, lines.filter((l) => LINE.exec(l)?.[1] !== entryId).join("\n"));
    return entry;
  }

  journal(id: string, text: string, opts: { redact?: boolean } = {}) {
    let clean = text.replace(/\s*\n\s*/g, " ").trim();
    if (!clean) throw new MemoryError("Nội dung trống");
    if (opts.redact) clean = redactSecrets(clean);
    else if (findSecret(clean)) throw new MemoryError("Nội dung giống khóa/mật khẩu nên bị từ chối.");
    const now = this.now();
    mkdirSync(this.journalDir(id), { recursive: true });
    const f = this.journalFile(id, ymd(now));
    if (!existsSync(f)) writeFileSync(f, `# Nhật ký ${ymd(now)} — @${id}\n`);
    appendFileSync(f, `- ${hm(now)} ${clean.slice(0, 600)}\n`);
  }

  journalDates(id: string): string[] {
    const d = this.journalDir(id);
    if (!existsSync(d)) return [];
    return readdirSync(d).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).map((f) => f.slice(0, 10)).sort();
  }

  readJournal(id: string, date: string): string {
    const f = this.journalFile(id, date);
    return existsSync(f) ? readFileSync(f, "utf8") : "";
  }

  /** Case-insensitive search (all terms must match) over memory and recent journals, newest first. */
  recall(id: string, query: string, limit = 10): RecallHit[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const ok = (s: string) => terms.every((t) => s.toLowerCase().includes(t));
    const hits: RecallHit[] = [];
    for (const scope of ["me", "team"] as Scope[]) {
      for (const e of this.entries(scope, id).reverse()) {
        const line = `[${e.id}] ${e.date} · ${e.kind} · ${e.text}`;
        if (ok(line)) hits.push({ where: scope === "team" ? "team" : "memory", text: line });
      }
    }
    for (const date of this.journalDates(id).reverse().slice(0, 60)) {
      for (const l of this.readJournal(id, date).split("\n").reverse()) {
        if (l.startsWith("- ") && ok(l)) hits.push({ where: `journal ${date}`, text: l.slice(2) });
      }
    }
    return hits.slice(0, limit);
  }

  /** Text blocks for the system prompt, each within its share of `budget` characters. */
  blocks(w: Worker, budget = 12_000): MemoryBlocks {
    const read = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").trim() : "");
    let soul = read(this.soulFile(w.id));
    if (soul === soulTemplate(w).trim()) soul = "";
    const stripEmpty = (t: string) => (t.split("\n").some((l) => LINE.test(l) || (l.trim() && !l.startsWith("#"))) ? t : "");
    const today = this.readJournal(w.id, ymd(this.now()));
    const y = new Date(this.now().getTime() - 86_400_000);
    const recentJournal = [this.readJournal(w.id, ymd(y)), today]
      .flatMap((t) => t.split("\n").filter((l) => l.startsWith("- ")).slice(-10))
      .join("\n");
    return {
      soul: fitTail(soul, Math.floor(budget * 0.25)),
      team: fitTail(stripEmpty(read(this.memFile("team", w.id))), Math.floor(budget * 0.25)),
      mine: fitTail(stripEmpty(read(this.memFile("me", w.id))), Math.floor(budget * 0.4)),
      journal: fitTail(recentJournal, Math.floor(budget * 0.1)),
    };
  }
}

export const CONSOLIDATE_PROMPT = [
  "Gom trí nhớ của bạn cho gọn:",
  "1. Dùng recall / đọc phần trí nhớ trong persona và đọc nhật ký 7 ngày gần nhất.",
  "2. forget các mục trùng, lỗi thời hoặc sai.",
  "3. Mục có ích mới rút ra từ nhật ký thì remember (kind: fact / lesson / decision) — ngắn gọn, mỗi mục một ý.",
  "4. KHÔNG xoá mục kind=decision. KHÔNG lưu bí mật.",
  "Khi xong, trả lời một dòng: đã xoá bao nhiêu, thêm bao nhiêu.",
].join("\n");
