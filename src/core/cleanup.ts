import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

/**
 * Housekeeping that never deletes. `scanCleanup` only looks; `gatherCleanup` MOVES the chosen files
 * into `.agentroom/cleanup/<stamp>/files/` (with a manifest) so the owner can inspect and delete that
 * one folder themselves, or `restoreCleanup` to put things back. Nothing here runs on its own: it is
 * called only from an owner action (command, button, Telegram, CLI), never from an agent.
 */
export type CleanupKind = "junk" | "temp" | "cache" | "backup" | "agentroom";

export interface CleanupItem {
  /** posix path relative to the workspace root */
  rel: string;
  kind: CleanupKind;
  dir: boolean;
  bytes: number;
  mtime: number;
  why: string;
}

export interface ScanOptions {
  /** Files under .agentroom/state/turns older than this many days are candidates. 0 = none. */
  turnsOlderThanDays?: number;
  now?: number;
  maxItems?: number;
}

const FILE_RULES: [RegExp, CleanupKind, string][] = [
  [/^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i, "junk", "file hệ thống do OS tạo"],
  [/\.(tmp|temp|swp|swo)$/i, "temp", "file tạm"],
  [/^\.#.+|~$/, "temp", "file tạm của trình soạn thảo"],
  [/\.(orig|rej)$/i, "backup", "file còn lại sau khi merge/patch"],
  [/\.bak$/i, "backup", "bản sao lưu .bak"],
  [/\.pyc$/i, "cache", "bytecode Python"],
  [/^\.eslintcache$|^\.stylelintcache$|\.tsbuildinfo$/i, "cache", "cache công cụ build/lint"],
];
const DIR_RULES: [RegExp, string][] = [
  [/^(__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.parcel-cache|\.turbo|\.nyc_output|\.sass-cache)$/, "thư mục cache"],
];
/** Never entered or offered: the repo itself, dependencies, build outputs, our own data. */
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", "venv", "dist", "build", "out", "target", ".agentroom"]);

const posix = (p: string) => p.split(sep).join("/");

function tracked(root: string): Set<string> | undefined {
  try {
    const out = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return undefined;
  }
}

function sizeOf(p: string): number {
  let st;
  try { st = lstatSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.size;
  let n = 0;
  for (const e of readdirSync(p)) n += sizeOf(join(p, e));
  return n;
}

/** Read-only. Files tracked by git are never candidates. */
export function scanCleanup(root: string, opt: ScanOptions = {}): CleanupItem[] {
  const now = opt.now ?? Date.now();
  const max = opt.maxItems ?? 500;
  const git = tracked(root);
  const out: CleanupItem[] = [];
  const isTracked = (rel: string, dir: boolean) => !!git && (dir ? [...git].some((t) => t.startsWith(rel + "/")) : git.has(rel));

  const walk = (dir: string, depth: number) => {
    if (out.length >= max || depth > 8) return;
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      if (out.length >= max) return;
      const abs = join(dir, name);
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      const rel = posix(relative(root, abs));
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) {
        if (SKIP_DIRS.has(name)) continue;
        const rule = DIR_RULES.find(([re]) => re.test(name));
        if (rule) {
          if (!isTracked(rel, true)) out.push({ rel, kind: "cache", dir: true, bytes: sizeOf(abs), mtime: st.mtimeMs, why: rule[1] });
          continue;
        }
        walk(abs, depth + 1);
      } else if (st.isFile()) {
        const rule = FILE_RULES.find(([re]) => re.test(name));
        if (rule && !isTracked(rel, false)) out.push({ rel, kind: rule[1], dir: false, bytes: st.size, mtime: st.mtimeMs, why: rule[2] });
      }
    }
  };
  walk(root, 0);

  const days = opt.turnsOlderThanDays ?? 0;
  const turns = join(root, ".agentroom", "state", "turns");
  if (days > 0 && existsSync(turns)) {
    for (const f of readdirSync(turns)) {
      const abs = join(turns, f);
      const st = lstatSync(abs);
      if (st.isFile() && now - st.mtimeMs > days * 86_400_000 && out.length < max) out.push({ rel: posix(relative(root, abs)), kind: "agentroom", dir: false, bytes: st.size, mtime: st.mtimeMs, why: `bản ghi lượt cũ hơn ${days} ngày (Context Inspector)` });
    }
  }
  const aud = join(root, ".agentroom", "audit.1.jsonl");
  if (existsSync(aud)) out.push({ rel: posix(relative(root, aud)), kind: "agentroom", dir: false, bytes: lstatSync(aud).size, mtime: lstatSync(aud).mtimeMs, why: "audit đã xoay vòng" });
  return out.sort((a, b) => b.bytes - a.bytes);
}

export interface ManifestEntry { rel: string; bytes: number; kind: CleanupKind; dir: boolean }
export interface Manifest { stamp: string; createdAt: number; root: string; entries: ManifestEntry[]; restored?: string[] }

export const cleanupDir = (root: string) => join(root, ".agentroom", "cleanup");

/** Keeps the cleanup folder out of git without touching what the owner already put in .agentroom/.gitignore. */
export function ensureCleanupIgnored(root: string) {
  const f = join(root, ".agentroom", ".gitignore");
  try {
    const cur = existsSync(f) ? readFileSync(f, "utf8") : undefined;
    if (cur === undefined) return; // a fresh "*" file is written by init; nothing to add without one
    if (cur.split("\n").some((l) => l.trim() === "cleanup/" || l.trim() === "*")) return;
    appendFileSync(f, (cur.endsWith("\n") || !cur ? "" : "\n") + "cleanup/\n");
  } catch { /* best effort */ }
}

const inside = (root: string, p: string) => {
  const r = resolve(root);
  const a = resolve(p);
  return a === r ? false : a.startsWith(r + sep);
};

function moveOne(from: string, to: string) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    // Another filesystem: copy, check the copy, only then remove the original (a move, not a delete).
    copyTree(from, to);
    if (sizeOf(to) !== sizeOf(from)) throw new Error(`copy of ${from} is incomplete; original kept`);
    rmSync(from, { recursive: true, force: true });
  }
}
function copyTree(from: string, to: string) {
  const st = lstatSync(from);
  if (st.isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const e of readdirSync(from)) copyTree(join(from, e), join(to, e));
  } else copyFileSync(from, to);
}

/**
 * Moves the given paths (relative to `root`) into a new timestamped folder. Paths outside the
 * workspace, inside .git/node_modules/the cleanup folder itself, or already gone are skipped and reported.
 */
export function gatherCleanup(root: string, rels: string[], now = Date.now()): { dir: string; manifest: Manifest; skipped: { rel: string; why: string }[] } {
  ensureCleanupIgnored(root);
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  const base = join(cleanupDir(root), stamp);
  const entries: ManifestEntry[] = [];
  const skipped: { rel: string; why: string }[] = [];
  for (const rel of [...new Set(rels)]) {
    const abs = resolve(root, rel);
    const top = posix(relative(root, abs)).split("/")[0];
    if (!inside(root, abs)) { skipped.push({ rel, why: "ngoài thư mục project" }); continue; }
    if (top === ".git" || top === "node_modules" || abs.startsWith(cleanupDir(root))) { skipped.push({ rel, why: "vùng được bảo vệ" }); continue; }
    if (!existsSync(abs)) { skipped.push({ rel, why: "không còn tồn tại" }); continue; }
    const st = lstatSync(abs);
    const bytes = sizeOf(abs);
    try {
      moveOne(abs, join(base, "files", rel));
      entries.push({ rel: posix(rel), bytes, kind: "junk", dir: st.isDirectory() });
    } catch (e) {
      skipped.push({ rel, why: e instanceof Error ? e.message : String(e) });
    }
  }
  const manifest: Manifest = { stamp, createdAt: now, root, entries };
  if (entries.length) {
    mkdirSync(base, { recursive: true });
    writeFileSync(join(base, "manifest.json"), JSON.stringify(manifest, null, 2));
    writeFileSync(join(base, "README.txt"), `AgentRoom đã DỌN (di chuyển, không xóa) ${entries.length} mục vào đây lúc ${new Date(now).toISOString()}.\nXóa thư mục này khi bạn chắc chắn không cần; hoặc khôi phục bằng lệnh "AgentRoom: Khôi phục mục đã dọn".\n`);
  }
  return { dir: base, manifest, skipped };
}

/** Existing batches, newest first. */
export function listBatches(root: string): Manifest[] {
  const d = cleanupDir(root);
  if (!existsSync(d)) return [];
  const out: Manifest[] = [];
  for (const s of readdirSync(d)) {
    try { out.push(JSON.parse(readFileSync(join(d, s, "manifest.json"), "utf8"))); } catch { /* not a batch */ }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

/** Puts a batch back where it came from. Never overwrites something that has appeared there since. */
export function restoreCleanup(root: string, stamp: string): { restored: string[]; skipped: { rel: string; why: string }[] } {
  if (!/^[\w-]+$/.test(stamp)) throw new Error("tên lô không hợp lệ");
  const base = join(cleanupDir(root), stamp);
  const m: Manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8"));
  const restored: string[] = [];
  const skipped: { rel: string; why: string }[] = [];
  for (const e of m.entries) {
    const src = join(base, "files", e.rel);
    const dst = resolve(root, e.rel);
    if (!inside(root, dst)) { skipped.push({ rel: e.rel, why: "ngoài thư mục project" }); continue; }
    if (!existsSync(src)) { skipped.push({ rel: e.rel, why: "không còn trong thư mục dọn" }); continue; }
    if (existsSync(dst)) { skipped.push({ rel: e.rel, why: "đã có file mới ở chỗ cũ" }); continue; }
    moveOne(src, dst);
    restored.push(e.rel);
  }
  writeFileSync(join(base, "manifest.json"), JSON.stringify({ ...m, restored: [...(m.restored ?? []), ...restored] }, null, 2));
  return { restored, skipped };
}

export const humanBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${(n / 1024 ** 3).toFixed(2)} GB`);

export function renderScan(items: CleanupItem[]): string {
  if (!items.length) return "Không thấy file rác, tạm hay cache nào để dọn.";
  const total = items.reduce((a, i) => a + i.bytes, 0);
  return [`Tìm thấy ${items.length} mục (${humanBytes(total)}). Chưa có gì bị đụng tới.`, ...items.slice(0, 40).map((i) => `- ${i.rel}${i.dir ? "/" : ""} · ${humanBytes(i.bytes)} · ${i.why}`), items.length > 40 ? `… và ${items.length - 40} mục nữa` : ""].filter(Boolean).join("\n");
}
