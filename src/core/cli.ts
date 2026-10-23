import { existsSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * Finds a CLI the user installed (`claude`, `codex`). The extension ships without the
 * SDKs' platform binaries, so it runs whatever version is on the machine.
 * `override` may be an absolute path or a bare command name.
 */
export function findExecutable(name: string, override?: string): string | undefined {
  const cmd = override?.trim() || name;
  if (isAbsolute(cmd)) return existsSync(cmd) ? cmd : undefined;
  const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, cmd + ext);
      try { if (statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return undefined;
}
