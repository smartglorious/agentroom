import { execFile } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { Worker } from "./types";

const git = promisify(execFile);

export const expandHome = (p: string, home = homedir()) => (p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p);

/** The checkout a worker belongs to: its own `workdir`, else the workspace. Relative paths are relative to the workspace. */
export function localBase(workspace: string, w: Pick<Worker, "workdir">, home = homedir()): string {
  if (!w.workdir) return workspace;
  const p = expandHome(w.workdir, home);
  return isAbsolute(p) ? p : resolve(workspace, p);
}

/**
 * Keeps worktrees out of `git status` in a checkout that is not the main workspace.
 * A fresh folder is ignored entirely ("*" also hides the .gitignore itself); an existing
 * .agentroom/.gitignore (the main workspace's) only gets `worktrees/` added.
 */
function ensureIgnored(base: string) {
  const dir = join(base, ".agentroom");
  const f = join(dir, ".gitignore");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(f)) return writeFileSync(f, "# AgentRoom: this checkout hosts worker worktrees\n*\n");
  const cur = readFileSync(f, "utf8");
  if (!/^\/?worktrees\/?\s*$/m.test(cur)) appendFileSync(f, (cur.endsWith("\n") ? "" : "\n") + "worktrees/\n");
}

/**
 * Gives each code-writing worker its own checkout at <base>/.agentroom/worktrees/<id> on
 * branch agentroom/<id>, so parallel workers never overwrite each other's files.
 * Without `worktree` the worker works in `base` directly. Falls back to `base` when it is
 * not a git repository.
 */
export async function ensureWorktree(base: string, w: Pick<Worker, "id" | "worktree">): Promise<string> {
  if (!existsSync(base)) throw new Error(`Thư mục làm việc không tồn tại: ${base}`);
  if (!w.worktree) return base;
  const dir = join(base, ".agentroom", "worktrees", w.id);
  if (existsSync(dir)) return dir;
  try {
    await git("git", ["rev-parse", "--is-inside-work-tree"], { cwd: base });
  } catch {
    return base;
  }
  ensureIgnored(base);
  const branch = `agentroom/${w.id}`;
  const { stdout } = await git("git", ["branch", "--list", branch], { cwd: base });
  const args = stdout.trim() ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir];
  await git("git", args, { cwd: base });
  return dir;
}
