import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { Worker } from "./types";

const git = promisify(execFile);

/**
 * Gives each code-writing worker its own checkout at .agentroom/worktrees/<id> on
 * branch agentroom/<id>, so parallel workers never overwrite each other's files.
 * Falls back to the workspace root when the folder is not a git repository.
 */
export async function ensureWorktree(root: string, w: Worker): Promise<string> {
  if (!w.worktree) return root;
  const dir = join(root, ".agentroom", "worktrees", w.id);
  if (existsSync(dir)) return dir;
  try {
    await git("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root });
  } catch {
    return root;
  }
  const branch = `agentroom/${w.id}`;
  const { stdout } = await git("git", ["branch", "--list", branch], { cwd: root });
  const args = stdout.trim() ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir];
  await git("git", args, { cwd: root });
  return dir;
}
