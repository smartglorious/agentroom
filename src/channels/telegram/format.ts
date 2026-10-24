import { tr } from "../../core/i18n";
import { isAbsolute, posix } from "node:path";
import { redactSecrets } from "../../core/memory";
import type { ApprovalRequest } from "../../core/types";

/** Telegram allows 4096 characters per message; stay clear of the edge. */
export const CHUNK = 3800;

/** Shortens a worker reply for the phone: code blocks become a one-line note, long text is cut at a word. */
export function summarize(text: string, max: number): { text: string; cut: boolean } {
  let cut = false;
  let t = redactSecrets(text).replace(/```[^\n]*\n([\s\S]*?)```/g, (_, code: string) => {
    cut = true;
    return tr("[mã: {p} dòng]", { p: code.trimEnd().split("\n").length });
  });
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  if (t.length > max) {
    const at = t.lastIndexOf(" ", max);
    t = t.slice(0, at > max * 0.6 ? at : max).trimEnd() + "…";
    cut = true;
  }
  return { text: t, cut };
}

/** Splits at paragraph, line or word boundaries so every piece fits in one message. */
export function splitMessage(text: string, limit = CHUNK): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let at = rest.lastIndexOf("\n\n", limit);
    if (at < limit * 0.5) at = rest.lastIndexOf("\n", limit);
    if (at < limit * 0.5) at = rest.lastIndexOf(" ", limit);
    if (at < limit * 0.5) at = limit;
    out.push(rest.slice(0, at).trimEnd());
    rest = rest.slice(at).trimStart();
  }
  if (rest) out.push(rest);
  return out;
}

export const usd = (n: number) => "$" + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));

/** "90s", "30m", "2h", "1d" → milliseconds; undefined when it is not a duration. */
export function parseDuration(s: string): number | undefined {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i.exec(s.trim());
  if (!m) return undefined;
  return Math.round(Number(m[1]) * { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2].toLowerCase() as "s"]);
}

export function inQuietHours(range: string, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(range.trim());
  if (!m) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  const from = Number(m[1]) * 60 + Number(m[2]);
  const to = Number(m[3]) * 60 + Number(m[4]);
  return from <= to ? cur >= from && cur < to : cur >= from || cur < to;
}

// ---------- approvals ----------

const FILE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/** Files a phone tap must never be able to approve, even inside the worktree. */
const SENSITIVE_SEGMENT = /^(\.git|\.github|\.agentroom|\.claude|\.ssh|\.husky|\.vscode|\.aws|\.gnupg|\.kube)$/i;
const SENSITIVE_FILE = /^(\.env.*|\.npmrc|\.pypirc|\.netrc|\.bashrc|\.zshrc|\.profile|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx)|credentials(\.json)?|authorized_keys)$/i;

function pathOf(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return undefined;
  const o = input as Record<string, unknown>;
  const p = o.file_path ?? o.notebook_path ?? o.path;
  return typeof p === "string" && p ? p : undefined;
}

const isAbs = (p: string) => p.startsWith("/") || /^[A-Za-z]:\//.test(p);

/**
 * `file` relative to the turn's folder, or undefined when it is not clearly inside it. A relative path is
 * inside by definition; an absolute one must start with the folder the turn really runs in (as reported by
 * the runner for remote hosts). "~" or an unknown folder proves nothing, so such paths are refused.
 */
export function relativeInside(file: string, cwd: string | undefined): string | undefined {
  const f = file.replace(/\\/g, "/");
  let rel: string | undefined;
  if (!isAbs(f) && !f.startsWith("~")) rel = posix.normalize(f);
  else {
    const base = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
    if (base && isAbs(base)) {
      const ci = /^[A-Za-z]:/.test(base);                   // drive letters compare case-insensitively
      const [a, b] = ci ? [f.toLowerCase(), (base + "/").toLowerCase()] : [f, base + "/"];
      if (a.startsWith(b)) rel = posix.normalize(f.slice(base.length + 1));
    }
  }
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || rel.startsWith("/")) return undefined;
  return rel;
}

export interface Verdict { safe: boolean; reason: string }

/**
 * Whether a permission request may be granted from the phone. Only file edits clearly inside the
 * turn's own folder, and not on credentials, git internals, CI or editor/agent configuration.
 * Everything else (shell commands, network, other MCP servers) has to be approved at the computer.
 */
export function phoneApprovalVerdict(req: Pick<ApprovalRequest, "tool" | "input" | "cwd">): Verdict {
  if (!FILE_TOOLS.includes(req.tool)) return { safe: false, reason: tr("{tool} chỉ được duyệt ở máy tính", { tool: req.tool }) };
  const file = pathOf(req.input);
  if (!file) return { safe: false, reason: tr("không xác định được file") };
  const rel = relativeInside(file, req.cwd);
  if (!rel) return { safe: false, reason: tr("file nằm ngoài thư mục làm việc của worker") };
  const parts = rel.split("/");
  if (parts.slice(0, -1).some((s) => SENSITIVE_SEGMENT.test(s)) || SENSITIVE_SEGMENT.test(parts[parts.length - 1]) || SENSITIVE_FILE.test(parts[parts.length - 1])) {
    return { safe: false, reason: tr("file nhạy cảm (khoá, .env, .git, CI, cấu hình) chỉ duyệt ở máy tính") };
  }
  return { safe: true, reason: "" };
}

/** One-screen description of what is being asked, with secrets masked. */
export function describeApproval(req: ApprovalRequest, workerName: string): string {
  const o = (req.input && typeof req.input === "object" ? req.input : {}) as Record<string, unknown>;
  const detail = pathOf(req.input) ?? (typeof o.command === "string" ? o.command : typeof o.url === "string" ? o.url : JSON.stringify(req.input));
  const where = req.host ? tr(" trên máy {host}", { host: req.host }) : "";
  return redactSecrets(tr("🔐 {workerName} (@{workerId}){where} xin quyền dùng {tool}", { workerName, workerId: req.workerId, where, tool: req.tool }) + `\n${String(detail).slice(0, 300)}`);
}

