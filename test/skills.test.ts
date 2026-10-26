import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig } from "../src/core/config";
import { SKILL_TEMPLATE, SkillDrafts, SkillRegistry, buildPlugin, checkWorkerSkills, claudeSkillOptions, codexSkillDirs, codexSkillsBlock, parseFrontmatter, skillSources } from "../src/core/skills";
import { Fake, idle, makeRoom } from "./helpers";

function mkSkill(base: string, name: string, description = `Dùng khi cần ${name}`, extra = "") {
  const dir = join(base, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), SKILL_TEMPLATE(name, description, "Các bước\n") + extra);
  return dir;
}

const setup = () => {
  const ws = mkdtempSync(join(tmpdir(), "skills-"));
  const home = join(ws, "home");
  const src = skillSources(ws, home);
  return { ws, home, src };
};

test("skills: frontmatter parsing", () => {
  const f = parseFrontmatter("---\nname: a\ndescription: \"Dùng: khi X\"\n---\nbody");
  assert.equal(f.meta.name, "a");
  assert.equal(f.meta.description, "Dùng: khi X");
  assert.equal(f.body, "body");
  assert.deepEqual(parseFrontmatter("không có").meta, {});
});

test("skills: registry prefers agentroom > repo > user, skips _drafts, reports bad skills", () => {
  const { ws, home, src } = setup();
  mkSkill(src[0].dir, "dup", "từ agentroom");
  mkSkill(src[1].dir, "dup", "từ repo");
  mkSkill(src[1].dir, "only-repo");
  mkSkill(src[2].dir, "only-user");
  mkSkill(join(src[0].dir, "_drafts"), "draft-one");
  mkSkill(src[0].dir, "no-desc", "");
  mkdirSync(join(src[0].dir, "Bad Name"), { recursive: true });
  writeFileSync(join(src[0].dir, "Bad Name", "SKILL.md"), "---\nname: Bad Name\ndescription: x\n---\n");
  const r = new SkillRegistry(src);
  assert.equal(r.get("dup")!.description, "từ agentroom");
  assert.equal(r.get("dup")!.source, "agentroom");
  assert.deepEqual(r.list().map((s) => s.name).sort(), ["dup", "only-repo", "only-user"]);
  assert.equal(r.problems.length, 2);
  assert.ok(r.problems.some((p) => /thiếu description/.test(p.message)));
  assert.ok(r.problems.some((p) => /không hợp lệ/.test(p.message)));
  void ws; void home;
});

test("skills: useSkills validation and config parsing", () => {
  const { src } = setup();
  mkSkill(src[0].dir, "real");
  const cfg = parseConfig(`accounts: { a: { provider: claude } }\nworkers:\n  - { id: be, name: B, role: R, account: a, useSkills: [real, ghost] }\n`);
  assert.deepEqual(cfg.workers[0].useSkills, ["real", "ghost"]);
  const errs = checkWorkerSkills(cfg.workers, new SkillRegistry(src));
  assert.equal(errs.length, 1);
  assert.match(errs[0], /ghost/);
});

test("skills: plugin is rebuilt with copies of exactly the requested skills", () => {
  const { ws, src } = setup();
  const d = mkSkill(src[0].dir, "alpha");
  mkdirSync(join(d, "scripts"));
  writeFileSync(join(d, "scripts", "run.sh"), "echo hi");
  mkSkill(src[0].dir, "beta");
  const r = new SkillRegistry(src);
  const plugin = join(ws, "plugin");
  buildPlugin(plugin, [r.get("alpha")!]);
  assert.equal(JSON.parse(readFileSync(join(plugin, ".claude-plugin", "plugin.json"), "utf8")).name, "agentroom");
  assert.ok(existsSync(join(plugin, "skills", "alpha", "scripts", "run.sh")));
  assert.ok(!existsSync(join(plugin, "skills", "beta")));
  buildPlugin(plugin, [r.get("beta")!]);
  assert.ok(!existsSync(join(plugin, "skills", "alpha")), "stale skills are removed");
});

test("skills: Claude gets plugin + qualified names; Codex gets a block with absolute paths and read dirs", () => {
  const { src } = setup();
  mkSkill(src[0].dir, "alpha");
  const r = new SkillRegistry(src);
  const cfg = parseConfig(`accounts: { c: { provider: claude }, x: { provider: codex } }\nworkers:\n  - { id: a, name: A, role: R, account: c, useSkills: [alpha, ghost] }\n  - { id: b, name: B, role: R, account: x, useSkills: [alpha] }\n  - { id: n, name: N, role: R, account: c }\n`);
  const [a, b, n] = cfg.workers;
  assert.deepEqual(claudeSkillOptions(a, "/p", r), { plugins: [{ type: "local", path: "/p" }], skills: ["agentroom:alpha"] });
  assert.equal(claudeSkillOptions(n, "/p", r), undefined);
  const block = codexSkillsBlock(b, r);
  assert.match(block, /alpha: Dùng khi cần alpha/);
  assert.match(block, /file: .*alpha[\\/]SKILL\.md/);
  assert.deepEqual(codexSkillDirs(b, r), [src[0].dir]);
  assert.equal(codexSkillsBlock(n, r), "");
});

test("skills: drafts need approval before they exist as skills", () => {
  const { ws, src } = setup();
  const drafts = new SkillDrafts(src[0].dir);
  drafts.propose("be", "prisma-migration", "Dùng khi đổi schema DB", "1. sửa schema\n2. migrate");
  assert.throws(() => drafts.propose("be", "Bad Name", "x", ""), /không hợp lệ/);
  assert.equal(drafts.list().length, 1);
  assert.equal(drafts.list()[0].proposedBy, "be");
  assert.equal(new SkillRegistry(src).get("prisma-migration"), undefined, "a draft is not an active skill");
  drafts.approve("prisma-migration");
  assert.equal(drafts.list().length, 0);
  const reg = new SkillRegistry(src);
  assert.equal(reg.get("prisma-migration")!.description, "Dùng khi đổi schema DB");
  assert.ok(!existsSync(join(src[0].dir, "prisma-migration", ".proposed-by")));
  assert.throws(() => drafts.propose("be", "prisma-migration", "x", ""), /đã tồn tại/);
  drafts.propose("qa", "tmp", "x", "");
  drafts.reject("tmp");
  assert.equal(drafts.list().length, 0);
  void ws;
});

test("room: Claude workers receive their skills; approving a draft rebuilds the plugin", async () => {
  const fake = new Fake(() => "ok");
  const { room, deps, dir } = makeRoom(fake, {
    config: parseConfig(`accounts: { c: { provider: claude }, x: { provider: codex } }\nworkers:\n  - { id: be, name: B, role: R, account: c, coordinator: true, useSkills: [alpha] }\n  - { id: fe, name: F, role: R, account: x, useSkills: [alpha] }\n`),
  });
  mkSkill(join(dir, ".agentroom", "skills"), "alpha");
  deps.skills.scan();
  room.rebuildSkills();
  room.post("user", "@be @fe làm đi");
  await idle(room);
  const claude = fake.calls.find((c) => c.worker.id === "be")!;
  assert.deepEqual(claude.claudeSkills!.skills, ["agentroom:alpha"]);
  assert.ok(existsSync(join(deps.pluginDir, "skills", "alpha", "SKILL.md")));
  const codex = fake.calls.find((c) => c.worker.id === "fe")!;
  assert.match(codex.systemAppend, /file: .*alpha[\\/]SKILL\.md/);
  assert.deepEqual(codex.extraReadDirs, [join(dir, ".agentroom", "skills")]);

  room.proposeSkill("be", "gamma", "Dùng khi cần gamma", "x");
  assert.equal(room.snapshot().drafts.length, 1);
  room.approveSkill("gamma");
  assert.equal(room.snapshot().drafts.length, 0);
  assert.ok(deps.skills.get("gamma"));
});
