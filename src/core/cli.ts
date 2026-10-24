import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { tr } from "./i18n";
import { delimiter, dirname, isAbsolute, join, win32 } from "node:path";

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };

/**
 * Finds a CLI the user installed (`claude`, `codex`). The extension ships without the
 * SDKs' platform binaries, so it runs whatever version is on the machine.
 * `override` may be an absolute path or a bare command name.
 *
 * Windows: npm installs `codex` as THREE shims in one folder (`codex` for sh, `codex.cmd`, `codex.ps1`).
 * Node's `spawn` can run none of them (the extensionless one is a shell script, and `.cmd` needs a shell),
 * which shows up as `spawn …\codex ENOENT`. So on Windows we resolve to the real `.exe` the shim launches.
 */
export function findExecutable(name: string, override?: string, opt: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; home?: string } = {}): string | undefined {
  const found = findOnPath(name, override, opt);
  if (found || name !== "claude") return found;
  // Many people only have Claude Code through its VS Code extension, whose folder name carries the version and changes on every update.
  return claudeFromEditorExtension(opt.home ?? homedir(), opt.platform ?? process.platform);
}

const versionKey = (dir: string) => (/claude-code-(\d+(?:\.\d+)*)/.exec(dir)?.[1] ?? "0").split(".").map(Number);
const newer = (a: number[], b: number[]) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] ?? 0) - (b[i] ?? 0); if (d) return d; } return 0; };

/** The newest `claude` binary shipped inside an editor's Claude Code extension, if any. */
export function claudeFromEditorExtension(home: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const exe = platform === "win32" ? "claude.exe" : "claude";
  const found: { dir: string; file: string }[] = [];
  for (const editor of [".vscode", ".vscode-insiders", ".cursor", ".windsurf"]) {
    const root = join(home, editor, "extensions");
    let names: string[];
    try { names = readdirSync(root); } catch { continue; }
    for (const n of names) {
      if (!/^anthropic\.claude-code-\d/.test(n)) continue;
      const file = join(root, n, "resources", "native-binary", exe);
      if (isFile(file)) found.push({ dir: n, file });
    }
  }
  found.sort((a, b) => newer(versionKey(b.dir), versionKey(a.dir)));
  return found[0]?.file;
}

function findOnPath(name: string, override?: string, opt: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}): string | undefined {
  const platform = opt.platform ?? process.platform;
  const cmd = override?.trim() || name;
  const abs = platform === "win32" ? win32.isAbsolute(cmd) : isAbsolute(cmd);
  if (platform !== "win32") {
    if (abs) return existsSync(cmd) ? cmd : undefined;
    for (const dir of (opt.env ?? process.env).PATH?.split(delimiter) ?? []) {
      const p = join(dir, cmd);
      if (isFile(p)) return p;
    }
    return undefined;
  }
  if (abs) return resolveWindows(cmd, name);
  for (const dir of (opt.env ?? process.env).PATH?.split(";") ?? []) {
    const r = resolveWindows(join(dir, cmd), name);
    if (r) return r;
  }
  return undefined;
}

/** `base` may have an extension or not. Prefers a real .exe; reads npm's .cmd shim to find it; falls back to the shim. */
function resolveWindows(base: string, name: string): string | undefined {
  if (/\.exe$/i.test(base)) return isFile(base) ? base : undefined;
  const stem = base.replace(/\.(cmd|bat|ps1)$/i, "");
  if (isFile(stem + ".exe")) return stem + ".exe";
  for (const ext of [".cmd", ".bat"]) {
    if (isFile(stem + ext)) return nativeBehindShim(stem + ext, name) ?? stem + ext;
  }
  return undefined; // only an extensionless sh script (or nothing): not runnable on Windows
}

/** npm's shim ends with `"%dp0%\node_modules\<pkg>\bin\<x>.js"`; the native binary lives inside that package. */
function nativeBehindShim(shim: string, name: string): string | undefined {
  let text: string;
  try { text = readFileSync(shim, "utf8"); } catch { return undefined; }
  const m = /%~?dp0%?[\\/]+([^"\r\n]+?\.(?:js|mjs|cjs))/i.exec(text);
  if (!m) return undefined;
  let pkg = dirname(join(dirname(shim), m[1].replace(/\\/g, "/")));
  for (let i = 0; i < 4 && !existsSync(join(pkg, "package.json")); i++) pkg = dirname(pkg);
  return findFile(pkg, `${name}.exe`, 8);
}

function findFile(dir: string, file: string, depth: number): string | undefined {
  if (depth < 0) return undefined;
  let names: string[];
  try { names = readdirSync(dir); } catch { return undefined; }
  if (names.some((n) => n.toLowerCase() === file)) return join(dir, names.find((n) => n.toLowerCase() === file)!);
  for (const n of names) {
    const p = join(dir, n);
    try { if (!statSync(p).isDirectory()) continue; } catch { continue; }
    const r = findFile(p, file, depth - 1);
    if (r) return r;
  }
  return undefined;
}

/** Spawn options for a CLI path: a `.cmd`/`.bat` shim can only run through a shell. */
export const needsShell = (exe: string) => process.platform === "win32" && /\.(cmd|bat)$/i.test(exe);

/** `spawn x ENOENT/EINVAL` says nothing about what to do; on Windows it almost always means an npm shim was used instead of the .exe. */
export function explainSpawnError(err: unknown, name: string): string {
  const msg = err instanceof Error ? err.message : String(err);
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== "ENOENT" && code !== "EINVAL") return msg;
  return process.platform === "win32"
    ? tr("{msg}. Trên Windows hãy đặt agentroom.{name}Path = đường dẫn tới {name}.exe thật (thường trong node_modules\\@openai\\codex\\…\\vendor\\…\\codex\\codex.exe), không dùng file {name} hoặc {name}.cmd của npm.", { msg, name })
    : tr("{msg}. Kiểm tra agentroom.{name}Path hoặc PATH.", { msg, name });
}
