import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { Worker } from "./types";

export type SkillSource = "agentroom" | "repo" | "user";

export interface SkillInfo {
  name: string;
  description: string;
  /** Folder that contains SKILL.md. */
  dir: string;
  source: SkillSource;
}

export interface SkillProblem {
  dir: string;
  message: string;
}

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;
export const PLUGIN_NAME = "agentroom";

export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  try {
    const meta = YAML.parse(m[1]);
    return { meta: meta && typeof meta === "object" ? (meta as Record<string, unknown>) : {}, body: m[2] };
  } catch {
    return { meta: {}, body: m[2] };
  }
}

/** Skill folders, in priority order: the team's own, then the repo's, then the user's. */
export function skillSources(workspace: string, home: string): { source: SkillSource; dir: string }[] {
  return [
    { source: "agentroom", dir: join(workspace, ".agentroom", "skills") },
    { source: "repo", dir: join(workspace, ".claude", "skills") },
    { source: "user", dir: join(home, ".claude", "skills") },
  ];
}

export class SkillRegistry {
  private skills = new Map<string, SkillInfo>();
  problems: SkillProblem[] = [];

  constructor(private sources: { source: SkillSource; dir: string }[]) {
    this.scan();
  }

  scan() {
    this.skills.clear();
    this.problems = [];
    for (const { source, dir } of this.sources) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir).sort()) {
        if (entry.startsWith("_") || entry.startsWith(".")) continue;
        const skillDir = join(dir, entry);
        const file = join(skillDir, "SKILL.md");
        if (!existsSync(file) || !statSync(skillDir).isDirectory()) continue;
        const { meta } = parseFrontmatter(readFileSync(file, "utf8"));
        const name = typeof meta.name === "string" ? meta.name : entry;
        const description = typeof meta.description === "string" ? meta.description.trim() : "";
        if (!SKILL_NAME.test(name)) { this.problems.push({ dir: skillDir, message: `tên skill "${name}" không hợp lệ (a-z, 0-9, '-')` }); continue; }
        if (!description) { this.problems.push({ dir: skillDir, message: `skill "${name}" thiếu description trong frontmatter` }); continue; }
        if (!this.skills.has(name)) this.skills.set(name, { name, description, dir: skillDir, source });
      }
    }
  }

  get(name: string) { return this.skills.get(name); }
  list() { return [...this.skills.values()]; }
}

/** Errors for workers whose `useSkills` name a skill that does not exist. */
export function checkWorkerSkills(workers: Worker[], registry: SkillRegistry): string[] {
  return workers.flatMap((w) =>
    w.useSkills.filter((s) => !registry.get(s)).map((s) => `Worker ${w.id}: useSkills "${s}" không tồn tại (tìm trong .agentroom/skills, .claude/skills, ~/.claude/skills)`));
}

/**
 * Builds a local Claude Code plugin holding copies of the given skills, so a worker
 * can enable exactly its own skills with `skills: ["agentroom:<name>"]` even when it
 * runs inside a git worktree. Copies (not symlinks) so it also works on Windows.
 */
export function buildPlugin(pluginDir: string, skills: SkillInfo[]) {
  rmSync(pluginDir, { recursive: true, force: true });
  mkdirSync(join(pluginDir, ".claude-plugin"), { recursive: true });
  writeFileSync(join(pluginDir, ".claude-plugin", "plugin.json"), JSON.stringify({ name: PLUGIN_NAME, version: "0.0.0", description: "AgentRoom skills" }, null, 2));
  for (const s of skills) cpSync(s.dir, join(pluginDir, "skills", s.name), { recursive: true });
}

export interface ClaudeSkillOptions {
  plugins: { type: "local"; path: string }[];
  skills: string[];
}

export function claudeSkillOptions(w: Worker, pluginDir: string, registry: SkillRegistry): ClaudeSkillOptions | undefined {
  const names = w.useSkills.filter((s) => registry.get(s));
  if (!names.length) return undefined;
  return { plugins: [{ type: "local", path: pluginDir }], skills: names.map((n) => `${PLUGIN_NAME}:${n}`) };
}

/** Codex cannot filter skills per thread, so the persona lists them with absolute paths. */
export function codexSkillsBlock(w: Worker, registry: SkillRegistry): string {
  const list = w.useSkills.flatMap((n) => { const s = registry.get(n); return s ? [s] : []; });
  if (!list.length) return "";
  return [
    "Bạn có các skill sau. Khi task khớp mô tả, hãy ĐỌC file SKILL.md tương ứng rồi làm đúng theo đó:",
    ...list.map((s) => `- ${s.name}: ${s.description}\n  file: ${resolve(s.dir, "SKILL.md")}`),
  ].join("\n");
}

export function codexSkillDirs(w: Worker, registry: SkillRegistry): string[] {
  return [...new Set(w.useSkills.flatMap((n) => { const s = registry.get(n); return s ? [resolve(s.dir, "..")] : []; }))];
}

export const SKILL_TEMPLATE = (name: string, description: string, body = "1. …\n2. …\n") =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${body}`;

// ---- draft skills proposed by agents ----

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  proposedBy: string;
}

export class SkillDrafts {
  constructor(private skillsDir: string) {}

  private dir(name: string) { return join(this.skillsDir, "_drafts", name); }

  propose(proposedBy: string, name: string, description: string, body: string): SkillDraft {
    if (!SKILL_NAME.test(name)) throw new Error(`Tên skill không hợp lệ: "${name}" (a-z, 0-9, '-')`);
    if (!description.trim()) throw new Error("Thiếu description");
    if (existsSync(join(this.skillsDir, name))) throw new Error(`Skill "${name}" đã tồn tại`);
    mkdirSync(this.dir(name), { recursive: true });
    writeFileSync(join(this.dir(name), "SKILL.md"), SKILL_TEMPLATE(name, description.replace(/\n/g, " "), body));
    writeFileSync(join(this.dir(name), ".proposed-by"), proposedBy);
    return { name, description, body, proposedBy };
  }

  list(): SkillDraft[] {
    const root = join(this.skillsDir, "_drafts");
    if (!existsSync(root)) return [];
    return readdirSync(root).flatMap((name) => {
      const f = join(root, name, "SKILL.md");
      if (!existsSync(f)) return [];
      const { meta, body } = parseFrontmatter(readFileSync(f, "utf8"));
      const by = join(root, name, ".proposed-by");
      return [{ name, description: String(meta.description ?? ""), body, proposedBy: existsSync(by) ? readFileSync(by, "utf8") : "?" }];
    });
  }

  approve(name: string) {
    const from = this.dir(name);
    if (!existsSync(from)) throw new Error(`Không có bản nháp "${name}"`);
    if (existsSync(join(this.skillsDir, name))) throw new Error(`Skill "${name}" đã tồn tại`);
    rmSync(join(from, ".proposed-by"), { force: true });
    renameSync(from, join(this.skillsDir, name));
  }

  reject(name: string) {
    rmSync(this.dir(name), { recursive: true, force: true });
  }
}
