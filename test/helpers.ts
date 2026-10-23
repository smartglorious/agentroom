import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentAdapter, TurnRequest, TurnResult } from "../src/adapters/types";
import { parseConfig, SAMPLE_CONFIG } from "../src/core/config";
import { TurnInspector } from "../src/core/inspector";
import { MemoryStore } from "../src/core/memory";
import { Room, RoomDeps } from "../src/core/room";
import { Scheduler } from "../src/core/scheduler";
import { SkillDrafts, SkillRegistry, skillSources } from "../src/core/skills";
import { RoomStore } from "../src/core/store";
import { UsageStore } from "../src/core/usage";

/** Scripted adapter: replies via `reply`, records every request. */
export class Fake implements AgentAdapter {
  calls: TurnRequest[] = [];
  constructor(private reply: (req: TurnRequest) => string | TurnResult | Promise<string | TurnResult> = () => "ok") {}
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    this.calls.push(req);
    await new Promise((r) => setTimeout(r, 5));
    const r = await this.reply(req);
    return typeof r === "string" ? { sessionId: `s-${req.worker.id}`, text: r } : r;
  }
  get prompts() { return this.calls.map((c) => ({ worker: c.worker.id, prompt: c.prompt, session: c.sessionId })); }
}

export function makeRoom(adapter: AgentAdapter, over: Partial<RoomDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agentroom-"));
  const state = join(dir, ".agentroom", "state");
  const root = join(dir, ".agentroom");
  mkdirSync(state, { recursive: true });
  const deps: RoomDeps = {
    config: parseConfig(SAMPLE_CONFIG),
    store: new RoomStore(state),
    adapters: { claude: adapter, codex: adapter },
    scheduler: new Scheduler(),
    options: { maxAgentHops: 6, contextMessages: 30, memoryBudgetChars: 12_000 },
    memory: new MemoryStore(root),
    skills: new SkillRegistry(skillSources(dir, join(dir, "home"))),
    skillDrafts: new SkillDrafts(join(root, "skills")),
    pluginDir: join(root, ".plugin"),
    usage: new UsageStore(state),
    inspector: new TurnInspector(state, 50),
    resolveCwd: async () => dir,
    mcpUrl: (id) => `http://x/${id}`,
    ...over,
  };
  return { room: new Room(deps), deps, dir, root };
}

export const idle = (room: Room) => new Promise<void>((resolve) => {
  const check = () => (room.snapshot().statuses.every((s) => s.state === "idle" || s.state === "error" || s.state === "over_budget") ? resolve() : setTimeout(check, 10));
  setTimeout(check, 25);
});
