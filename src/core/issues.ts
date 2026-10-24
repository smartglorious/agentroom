import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "./memory";

/**
 * A local, deduplicated log of what went wrong (or got in the way) while using AgentRoom, so fixes and
 * upgrades have evidence. Nothing is sent anywhere: the owner exports a Markdown report and decides
 * what to do with it. Text is scrubbed of secrets and of the machine's paths before it is stored.
 */
export type IssueKind = "error" | "warning" | "friction" | "user";
export type IssueStatus = "open" | "fixed" | "wontfix";

export interface Issue {
  id: string;
  fingerprint: string;
  kind: IssueKind;
  /** where it came from: "turn", "telegram", "daemon", "remote", "plan", "budget", "limit", "user", … */
  source: string;
  title: string;
  detail?: string;
  worker?: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  versions: string[];
  status: IssueStatus;
  /** version that was running when the owner marked it fixed; a later recurrence reopens it */
  fixedIn?: string;
  reopened?: number;
  note?: string;
}

export interface IssueInput { kind: IssueKind; source: string; title: string; detail?: string; worker?: string }

export interface IssueContext {
  version: string;
  platform?: string;
  node?: string;
  /** [from, to] replacements applied to every text, e.g. [home, "~"] */
  scrub?: [string, string][];
  now?: () => number;
  /** most issues kept; the oldest closed ones go first */
  max?: number;
}

const MAX_TITLE = 200;
const MAX_DETAIL = 2000;

/** Same problem → same fingerprint, whatever the numbers, ids and paths in the message. */
export function fingerprintOf(i: Pick<IssueInput, "kind" | "source" | "title">): string {
  const norm = i.title
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "URL")
    .replace(/(?:~|[a-z]:)?[\\/][\w.\-~@+]+(?:[\\/][\w.\-~@+]+)+/gi, "PATH")
    .replace(/\b[0-9a-f]{8,}\b/g, "HEX")
    .replace(/\d+(?:[.,:]\d+)*/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
  return createHash("sha1").update(`${i.kind}|${i.source}|${norm}`).digest("hex").slice(0, 12);
}

export class IssueStore {
  private issues: Issue[] | undefined;
  private now: () => number;

  constructor(readonly file: string, private ctx: IssueContext) {
    this.now = ctx.now ?? Date.now;
  }

  private load(): Issue[] {
    if (this.issues) return this.issues;
    try {
      const v = JSON.parse(readFileSync(this.file, "utf8"));
      this.issues = Array.isArray(v?.issues) ? v.issues : [];
    } catch {
      this.issues = [];
    }
    return this.issues!;
  }

  private save() {
    const all = this.load();
    const max = this.ctx.max ?? 1000;
    if (all.length > max) {
      const rank = (i: Issue) => (i.status === "open" ? 1 : 0);
      all.sort((a, b) => rank(b) - rank(a) || b.lastSeen - a.lastSeen);
      all.length = max;
    }
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ issues: all }, null, 1));
    renameSync(tmp, this.file);
  }

  private clean(text: string, max: number): string {
    let t = redactSecrets(text);
    for (const [from, to] of this.ctx.scrub ?? []) if (from && from.length > 2) t = t.split(from).join(to);
    return t.length > max ? t.slice(0, max) + "…" : t;
  }

  record(input: IssueInput): Issue {
    const all = this.load();
    const title = this.clean(input.title.replace(/\s+/g, " ").trim(), MAX_TITLE) || "(không có tiêu đề)";
    const fp = fingerprintOf({ ...input, title });
    const at = this.now();
    let it = all.find((i) => i.fingerprint === fp);
    if (it) {
      it.count++;
      it.lastSeen = at;
      if (!it.versions.includes(this.ctx.version)) it.versions.push(this.ctx.version);
      if (input.detail) it.detail = this.clean(input.detail, MAX_DETAIL);
      if (input.worker) it.worker = input.worker;
      if (it.status === "fixed" && it.fixedIn && cmpVersion(this.ctx.version, it.fixedIn) >= 0) {
        it.status = "open";
        it.reopened = (it.reopened ?? 0) + 1;
      }
    } else {
      it = {
        id: `i${at.toString(36)}${Math.random().toString(36).slice(2, 5)}`,
        fingerprint: fp, kind: input.kind, source: input.source, title,
        detail: input.detail ? this.clean(input.detail, MAX_DETAIL) : undefined,
        worker: input.worker, count: 1, firstSeen: at, lastSeen: at, versions: [this.ctx.version], status: "open",
      };
      all.push(it);
    }
    this.save();
    return it;
  }

  list(status?: IssueStatus): Issue[] {
    return this.load().filter((i) => !status || i.status === status).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  setStatus(id: string, status: IssueStatus, note?: string): Issue | undefined {
    const it = this.load().find((i) => i.id === id);
    if (!it) return undefined;
    it.status = status;
    it.fixedIn = status === "fixed" ? this.ctx.version : undefined;
    if (note !== undefined) it.note = this.clean(note, 500);
    this.save();
    return it;
  }

  /** The report the owner reads, attaches to a GitHub issue, or hands to Claude to plan a fix. */
  markdown(): string {
    const all = this.list();
    const open = all.filter((i) => i.status === "open").sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
    const closed = all.filter((i) => i.status !== "open");
    const d = (t: number) => new Date(t).toISOString().slice(0, 16).replace("T", " ");
    const row = (i: Issue) => [
      `### ${i.title}`,
      `- id \`${i.id}\` · ${i.kind} · nguồn \`${i.source}\`${i.worker ? ` · worker @${i.worker}` : ""} · **${i.count} lần** · ${d(i.firstSeen)} → ${d(i.lastSeen)} · bản ${i.versions.join(", ")}${i.reopened ? ` · mở lại ${i.reopened} lần` : ""}`,
      i.status !== "open" ? `- ${i.status === "fixed" ? `đã sửa (ở bản ${i.fixedIn})` : "không sửa"}${i.note ? `: ${i.note}` : ""}` : "",
      i.detail ? "```text\n" + i.detail.replace(/```/g, "'''") + "\n```" : "",
    ].filter(Boolean).join("\n");
    return [
      "# Báo cáo lỗi / vấn đề của AgentRoom",
      "",
      `AgentRoom ${this.ctx.version}${this.ctx.platform ? ` · ${this.ctx.platform}` : ""}${this.ctx.node ? ` · node ${this.ctx.node}` : ""} · tạo lúc ${d(this.now())}`,
      "",
      "> Tự động ẩn khóa/token và đường dẫn máy bạn, nhưng hãy đọc lại trước khi gửi cho ai. Không có gì được tải lên tự động.",
      "",
      `## Đang mở (${open.length})`,
      "",
      open.length ? open.map(row).join("\n\n") : "_Không có._",
      "",
      `## Đã đóng (${closed.length})`,
      "",
      closed.length ? closed.map(row).join("\n\n") : "_Không có._",
      "",
    ].join("\n");
  }
}

function cmpVersion(a: string, b: string): number {
  const pa = a.split(".").map(Number), pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}
