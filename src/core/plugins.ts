import { EventEmitter } from "node:events";
import { tr } from "./i18n";
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

/**
 * Panels are plain data the chat UI draws: text rows, buttons and small forms. A button or a form
 * calls `onAction` of the panel with the values the person typed. The UI never gets to run plugin
 * code or choose what to call: the host looks the action up in what the panel itself just rendered,
 * checks every value against the form that was declared, and only then calls the plugin.
 */
export type FieldType = "text" | "textarea" | "select" | "multiselect";
export interface FieldDef {
  name: string;
  label: string;
  type: FieldType;
  /** Required for select and multiselect: the only values accepted. */
  options?: { value: string; label?: string }[];
  required?: boolean;
  /** Longest text accepted (default 200 for text, 2000 for textarea). */
  max?: number;
  placeholder?: string;
  help?: string;
  /** Initial value (an array for multiselect). */
  value?: string | string[];
}
export interface FormDef { fields: FieldDef[]; submit: string }
export interface PanelAction {
  id: string;
  label: string;
  /** Fixed values sent back with the action (for example the id of the row it is on). Not editable by the person. */
  args?: Record<string, string>;
  /** Shown as a small form before the action runs. Without it the button runs the action at once. */
  form?: FormDef;
  /** Ask "sure?" before running. */
  confirm?: boolean;
  danger?: boolean;
}
export interface PanelRow { text: string; tag?: string; level?: "info" | "warn" | "error"; actions?: PanelAction[] }
export interface PanelSection {
  title: string;
  rows: PanelRow[];
  /** Section-level buttons. */
  actions?: PanelAction[];
  /** A form that is always shown at the end of the section; submitting runs the action `form.id`. */
  form?: FormDef & { id: string; title?: string };
}
export type ActionValues = Record<string, string | string[]>;
export interface PanelDef {
  id: string;
  title: () => string;
  sections: () => PanelSection[];
  /** A number shown on the tab (things waiting for the person). */
  badge?: () => number;
  /** Runs a button or form of this panel. The returned text is shown to the person; a thrown error is shown as a failure. */
  onAction?: (action: string, values: ActionValues) => string | void | Promise<string | void>;
}
export interface PanelData { id: string; title: string; sections: PanelSection[]; badge?: number }
export interface ActionResult { ok: boolean; message: string }

const TEXT_MAX = 200;
const AREA_MAX = 2000;
const MULTI_MAX = 50;
const clean = (s: string, keepNewlines: boolean) => s.replace(keepNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g : /[\u0000-\u001f\u007f]/g, "").replace(/\r\n?/g, "\n");

/** Checks what the UI sent against the form that was declared. Returns the cleaned values, or the message to show. */
export function validateForm(form: FormDef | undefined, raw: unknown): { values: ActionValues } | { error: string } {
  const src = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const values: ActionValues = {};
  for (const f of form?.fields ?? []) {
    const v = src[f.name];
    if (f.type === "multiselect") {
      const arr = Array.isArray(v) ? v : v === undefined || v === "" ? [] : [v];
      if (arr.length > MULTI_MAX || arr.some((x) => typeof x !== "string" || !f.options?.some((o) => o.value === x))) return { error: tr("{label}: giá trị không hợp lệ", { label: f.label }) };
      if (f.required && !arr.length) return { error: tr("{label}: cần chọn ít nhất một mục", { label: f.label }) };
      values[f.name] = arr as string[];
      continue;
    }
    const s = typeof v === "string" ? v : v === undefined || v === null ? "" : undefined;
    if (s === undefined) return { error: tr("{label}: giá trị không hợp lệ", { label: f.label }) };
    const text = clean(s, f.type === "textarea").trim();
    if (f.required && !text) return { error: tr("{label}: không được để trống", { label: f.label }) };
    if (text.length > (f.max ?? (f.type === "textarea" ? AREA_MAX : TEXT_MAX))) return { error: tr("{label}: quá dài (tối đa {max} ký tự)", { label: f.label, max: f.max ?? (f.type === "textarea" ? AREA_MAX : TEXT_MAX) }) };
    if (f.type === "select" && text && !f.options?.some((o) => o.value === text)) return { error: tr("{label}: giá trị không hợp lệ", { label: f.label }) };
    values[f.name] = text;
  }
  return { values };
}

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
      try {
        let badge: number | undefined;
        try { const b = def.badge?.(); badge = typeof b === "number" && b > 0 ? Math.min(99, Math.floor(b)) : undefined; } catch { /* no badge */ }
        out.push({ id: def.id, title: def.title(), sections: def.sections(), ...(badge ? { badge } : {}) });
      } catch { /* a broken panel must not break the UI */ }
    }
    return out;
  }

  /**
   * A button or form was used. The action is looked up in what the panel renders right now (so the UI cannot
   * invoke anything the panel did not offer), the values are checked against that form, fixed `args` are added
   * by the host, and only then does the plugin run.
   */
  async invokePanelAction(panelId: string, actionId: string, rawValues: unknown): Promise<ActionResult> {
    const entry = [...this.panelDefs.values()].find((p) => p.def.id === panelId);
    if (!entry?.def.onAction) return { ok: false, message: tr("Không có hành động này.") };
    let found: { form?: FormDef; args?: Record<string, string> } | undefined;
    try {
      for (const s of entry.def.sections()) {
        if (s.form?.id === actionId) found = { form: s.form };
        for (const a of s.actions ?? []) if (a.id === actionId) found = { form: a.form, args: a.args };
        for (const r of s.rows) for (const a of r.actions ?? []) if (a.id === actionId && (!found || a.args)) {
          // The same action id can sit on many rows (one per item): the row whose fixed args the UI echoes back wins.
          const echoed = (rawValues && typeof rawValues === "object" ? (rawValues as Record<string, unknown>).__args : undefined) as Record<string, unknown> | undefined;
          if (!a.args || Object.entries(a.args).every(([k, v]) => echoed?.[k] === v)) found = { form: a.form, args: a.args };
        }
      }
    } catch { /* fall through */ }
    if (!found) return { ok: false, message: tr("Không có hành động này.") };
    const checked = validateForm(found.form, rawValues);
    if ("error" in checked) return { ok: false, message: checked.error };
    try {
      const out = await entry.def.onAction(actionId, { ...checked.values, ...(found.args ?? {}) });
      this.emit("panels");
      return { ok: true, message: typeof out === "string" && out ? out : tr("Xong.") };
    } catch (e) {
      this.emit("panels");
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
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
