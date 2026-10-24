import { EventEmitter } from "node:events";
import type { Room } from "./room";
import type { RoomConfig } from "./types";

/**
 * Extension points. A plugin is a module that is bundled in at build time (see `agentroom:plugins`
 * in esbuild.mjs); it can add checks before a worker uses a tool, add a read-only panel to the chat
 * UI, and read its own section of `workers.yaml` (`ext.<plugin id>`).
 *
 * Safety rule (CLAUDE.md, rule 13): a guard can only make a call STRICTER. It can turn "allowed" into
 * "ask the user" or "blocked", never the reverse, so a plugin cannot widen what a worker may do.
 */
export interface GuardContext {
  workerId: string;
  tool: string;
  input: unknown;
  /** Absolute paths the call touches, when they can be worked out. */
  paths: string[];
  cwd?: string;
  host?: string;
}

export type GuardVerdict = { action: "ask" | "deny"; reason: string } | undefined;
export type Guard = (ctx: GuardContext) => GuardVerdict;

export interface PanelRow { text: string; tag?: string; level?: "info" | "warn" | "error" }
export interface PanelSection { title: string; rows: PanelRow[] }
export interface PanelDef { id: string; title: () => string; sections: () => PanelSection[] }
export interface PanelData { id: string; title: string; sections: PanelSection[] }

/** What a plugin sees after a tool call was approved (by the policy or by the user). */
export interface ApprovedCall extends GuardContext {
  /** "policy": the autonomy mode allowed it; "user": a person did. */
  by: "policy" | "user";
}

export interface ChatCommandDef {
  /** The word after the slash: `/name args`. a-z, 0-9, '-'. */
  name: string;
  /** One line shown by /help in Telegram and in the plugin listing. */
  help: string;
  /** Returns the reply shown in the chat (and on Telegram) as a system notice. `@` in it is replaced by `(at)`. */
  run(args: string): string | void | Promise<string | void>;
}

export interface PluginHost {
  room: Room;
  config: RoomConfig;
  /** Workspace root of this room. */
  root: string;
  log(text: string): void;
  registerGuard(guard: Guard): () => void;
  registerPanel(panel: PanelDef): () => void;
  /** Adds a slash command a person can type in the chat or on Telegram. It is never sent to a worker. */
  registerChatCommand(cmd: ChatCommandDef): () => void;
  /** Called after a tool call was allowed. Errors are swallowed. */
  onApproved(fn: (call: ApprovedCall) => void): () => void;
  /** Names the git branch of a worker's worktree (default `agentroom/<id>`). Only used when the worktree is first created. */
  setBranchNamer(fn: (workerId: string) => string | undefined): () => void;
  /** Tells the UI that a panel's content changed. */
  panelsChanged(): void;
}

export interface AgentRoomPlugin {
  /** Also the key of its section in `workers.yaml`: `ext: { <id>: … }`. a-z, 0-9, '-'. */
  id: string;
  /** May return a cleanup function. Errors are logged and do not stop the room. */
  activate(host: PluginHost): void | (() => void);
}

const PLUGIN_ID = /^[a-z0-9-]{1,32}$/;

export class PluginManager extends EventEmitter<{ panels: [] }> {
  private guards = new Map<symbol, { by: string; fn: Guard }>();
  private panelDefs = new Map<symbol, { by: string; def: PanelDef }>();
  private commands = new Map<string, { by: string; def: ChatCommandDef }>();
  private approvedFns = new Map<symbol, (c: ApprovedCall) => void>();
  private branchNamers = new Map<symbol, (workerId: string) => string | undefined>();
  private cleanups: (() => void)[] = [];
  private active: string[] = [];

  constructor(private plugins: AgentRoomPlugin[] = []) {
    super();
  }

  /** Ids of the plugins that activated. */
  list(): string[] { return [...this.active]; }

  activate(base: Pick<PluginHost, "room" | "config" | "root" | "log">) {
    for (const p of this.plugins) {
      if (!PLUGIN_ID.test(p.id) || this.active.includes(p.id)) { base.log(`plugin "${p.id}": bad or duplicate id, skipped`); continue; }
      const host: PluginHost = {
        ...base,
        registerGuard: (fn) => {
          const k = Symbol(p.id);
          this.guards.set(k, { by: p.id, fn });
          return () => void this.guards.delete(k);
        },
        registerPanel: (def) => {
          const k = Symbol(p.id);
          this.panelDefs.set(k, { by: p.id, def: { ...def, id: `${p.id}-${def.id}` } });
          this.emit("panels");
          return () => { this.panelDefs.delete(k); this.emit("panels"); };
        },
        registerChatCommand: (def) => {
          if (!PLUGIN_ID.test(def.name) || this.commands.has(def.name)) throw new Error(`chat command "${def.name}": bad or duplicate name`);
          this.commands.set(def.name, { by: p.id, def });
          return () => void this.commands.delete(def.name);
        },
        onApproved: (fn) => {
          const k = Symbol(p.id);
          this.approvedFns.set(k, fn);
          return () => void this.approvedFns.delete(k);
        },
        setBranchNamer: (fn) => {
          const k = Symbol(p.id);
          this.branchNamers.set(k, fn);
          return () => void this.branchNamers.delete(k);
        },
        panelsChanged: () => void this.emit("panels"),
      };
      try {
        const off = p.activate(host);
        if (typeof off === "function") this.cleanups.push(off);
        this.active.push(p.id);
      } catch (e) {
        base.log(`plugin "${p.id}" failed to activate: ${e instanceof Error ? e.message : e}`);
      }
    }
  }

  /**
   * The strictest verdict among all guards: deny beats ask. A guard that throws counts as "ask":
   * when a safety check cannot run, the safe answer is to put the call in front of the user.
   */
  check(ctx: GuardContext): (GuardVerdict & { by: string }) | undefined {
    let ask: (GuardVerdict & { by: string }) | undefined;
    for (const { by, fn } of this.guards.values()) {
      let v: GuardVerdict;
      try { v = fn(ctx); } catch (e) { v = { action: "ask", reason: `check failed (${e instanceof Error ? e.message : e})` }; }
      if (!v) continue;
      if (v.action === "deny") return { ...v, by };
      ask ??= { ...v, by };
    }
    return ask;
  }

  /** `/name rest` → the command and its arguments, when a plugin registered that name. */
  matchCommand(text: string): { def: ChatCommandDef; args: string } | undefined {
    const m = /^\/([a-z0-9-]{1,32})(?:\s+([\s\S]*))?$/.exec(text.trim());
    const c = m && this.commands.get(m[1]);
    return c ? { def: c.def, args: (m![2] ?? "").trim() } : undefined;
  }

  commandHelp(): string[] { return [...this.commands.values()].map((c) => `/${c.def.name} — ${c.def.help}`); }

  notifyApproved(call: ApprovedCall) {
    for (const fn of this.approvedFns.values()) { try { fn(call); } catch { /* a plugin must not break a turn */ } }
  }

  branchName(workerId: string): string | undefined {
    for (const fn of this.branchNamers.values()) {
      try { const b = fn(workerId); if (b && /^[A-Za-z0-9._\/-]{1,120}$/.test(b) && !b.includes("..") && !b.startsWith("-")) return b; } catch { /* default name */ }
    }
    return undefined;
  }

  panels(): PanelData[] {
    const out: PanelData[] = [];
    for (const { def } of this.panelDefs.values()) {
      try { out.push({ id: def.id, title: def.title(), sections: def.sections() }); } catch { /* a broken panel must not break the UI */ }
    }
    return out;
  }

  dispose() {
    for (const off of this.cleanups.splice(0).reverse()) { try { off(); } catch { /* shutting down */ } }
    this.guards.clear();
    this.commands.clear();
    this.approvedFns.clear();
    this.branchNamers.clear();
    this.panelDefs.clear();
    this.active = [];
  }
}
