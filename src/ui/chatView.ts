import { EN } from "../core/i18n-en";
import { getLang, tr } from "../core/i18n";
import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { CronEngine } from "../core/cron";
import type { LockInfo } from "../core/lock";
import type { Room } from "../core/room";
import type { RoomConfig } from "../core/types";
import type { UsageRange, UsageStore } from "../core/usage";
import type { WebhookHandler } from "../core/webhooks";
import type { HostManager } from "../remote/host";
import type { PluginManager } from "../core/plugins";
import type { TelegramPanel } from "./telegramPanel";

/** Messages the webview sends to the extension. */
type FromWebview =
  | { type: "ready" }
  | { type: "reportIssue" }
  | { type: "send"; text: string; replyTo?: string }
  | { type: "answerOption"; messageId: string; optionId: string }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "stop"; workerId: string }
  | { type: "inspect"; turnId: string }
  | { type: "getProfile"; workerId: string }
  | { type: "openFile"; workerId: string; kind: string }
  | { type: "setRange"; range: string }
  | { type: "runSchedule"; id: string }
  | { type: "toggleSchedule"; id: string; enabled: boolean }
  | { type: "approveSkill"; name: string }
  | { type: "rejectSkill"; name: string }
  | { type: "allowBudget"; account: string }
  | { type: "copyHook"; id: string }
  | { type: "newSkill" }
  | { type: "hostCheck"; name?: string }
  | { type: "refreshPlans" }
  | { type: "setAutonomy"; workerId: string; mode: string }
  | { type: "takeOver" }
  | { type: "telegramAction"; action: string };

export interface ViewContext {
  room: Room;
  cron: CronEngine;
  hooks?: WebhookHandler;
  hookPort?: number;
  usage: UsageStore;
  config: RoomConfig;
  hosts?: HostManager;
  telegram?: TelegramPanel;
  plugins?: PluginManager;
}

export interface ViewHandlers {
  inspect(turnId: string): Promise<void>;
  openFile(workerId: string, kind: "soul" | "memory" | "journal" | "team"): Promise<void>;
  copy(text: string): void;
  /** Switches a worker's autonomy; `full` is confirmed with the user here, never in the webview. */
  setAutonomy(workerId: string, mode: string): Promise<void>;
}

const RANGES: UsageRange[] = ["today", "7d", "30d"];
const FILE_KINDS = ["soul", "memory", "journal", "team"] as const;

/** Sidebar webview that renders the room. The extension host stays the source of truth. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private ctx?: ViewContext;
  private handlers?: ViewHandlers;
  private range: UsageRange = "today";
  private locked?: LockInfo;
  private unsubscribe: (() => void)[] = [];

  constructor(private extensionUri: vscode.Uri) {}

  setHandlers(h: ViewHandlers) { this.handlers = h; }

  /** Re-sends the worker list (e.g. after the user cancelled a mode change, so the selector snaps back). */
  refreshWorkers() { if (this.ctx) this.post({ type: "workers", workers: this.ctx.room.snapshot().workers }); }

  /** Another window already runs this room: show who, and offer to take over. */
  attachLocked(holder?: LockInfo) {
    this.attach(undefined);
    this.locked = holder ?? { token: "", pid: 0, host: "?", startedAt: 0, heartbeat: 0 };
    this.post({ type: "locked", holder: this.locked });
  }

  attach(ctx: ViewContext | undefined) {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.ctx = ctx;
    this.locked = undefined;
    if (!ctx) return void this.post({ type: "init", state: null });
    const { room, cron, hooks, hosts, telegram, plugins } = ctx;
    const sub = <T extends unknown[]>(target: { on(e: never, h: never): unknown; off(e: never, h: never): unknown }, event: string, map: (...a: T) => unknown) => {
      const h = (...a: T) => this.post(map(...a));
      target.on(event as never, h as never);
      this.unsubscribe.push(() => target.off(event as never, h as never));
    };
    sub(room, "message", (msg) => ({ type: "message", msg }));
    sub(room, "status", (status) => ({ type: "status", status }));
    sub(room, "approval", (req) => ({ type: "approval", req }));
    sub(room, "approvalResolved", (id) => ({ type: "approvalResolved", id }));
    sub(room, "tasks", (tasks) => ({ type: "tasks", tasks }));
    sub(room, "drafts", (drafts) => ({ type: "drafts", drafts }));
    sub(room, "usage", () => this.usagePayload());
    sub(room, "autonomy", () => ({ type: "workers", workers: room.snapshot().workers }));
    sub(room, "plan", () => ({ type: "plans", plans: room.plan?.list() ?? [], now: Date.now() }));
    sub(cron, "change", () => ({ type: "schedules", schedules: cron.statuses() }));
    if (hooks) sub(hooks, "call", () => this.hooksPayload());
    if (hosts) sub(hosts, "change", () => this.hostsPayload());
    if (telegram) sub(telegram, "change", () => this.telegramPayload());
    if (plugins) sub(plugins, "panels", () => ({ type: "panels", panels: plugins.panels() }));
    this.post(this.initPayload());
  }

  private initPayload() {
    const c = this.ctx!;
    return { type: "init", state: c.room.snapshot(), usage: this.usagePayload(), schedules: c.cron.statuses(), hooks: this.hooksPayload(), hosts: this.hostsPayload(), telegram: this.telegramPayload(), panels: c.plugins?.panels() ?? [] };
  }

  private telegramPayload() {
    return { type: "telegram", status: this.ctx?.telegram?.status() };
  }

  private hostsPayload() {
    return { type: "hosts", hosts: this.ctx?.hosts?.statuses() ?? [] };
  }

  private usagePayload() {
    const c = this.ctx!;
    const snap = c.room.snapshot();
    return { type: "usage", range: this.range, summary: c.usage.summarize(this.range), accounts: snap.accounts, todayByWorker: snap.todayByWorker };
  }

  private hooksPayload() {
    const c = this.ctx!;
    const defs = c.hooks?.definitions() ?? [];
    return {
      type: "hooks",
      port: c.hookPort,
      hooks: defs.map((d) => ({
        id: d.id, worker: d.worker, readOnly: d.readOnly, maxPerHour: d.maxPerHour,
        url: c.hookPort ? `http://127.0.0.1:${c.hookPort}/hook/${d.id}` : undefined,
        status: !c.hookPort ? tr("cổng không mở được") : d.secretEnv ? (process.env[d.secretEnv] ? tr("bật (HMAC)") : tr("tắt: chưa đặt biến {env}", { env: d.secretEnv })) : tr("bật (không ký, chỉ để thử)"),
      })),
      calls: c.hooks?.history() ?? [],
    };
  }

  /** After the display language changed: rebuild the page (it asks for its state again with "ready"). */
  reloadHtml() {
    if (this.view) this.view.webview.html = this.html(this.view.webview, vscode.Uri.joinPath(this.extensionUri, "media"));
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m));
  }

  private onMessage(m: FromWebview) {
    if (m.type === "ready") {
      if (this.ctx) return void this.post(this.initPayload());
      this.post({ type: "init", state: null });
      return void (this.locked && this.post({ type: "locked", holder: this.locked }));
    }
    if (m.type === "newSkill") return void vscode.commands.executeCommand("agentroom.newSkill");
    if (m.type === "takeOver") return void vscode.commands.executeCommand("agentroom.takeOver");
    const c = this.ctx;
    if (!c) return;
    const room = c.room;
    switch (m.type) {
      case "send": if (typeof m.text === "string" && m.text.trim()) room.post("user", m.text.trim(), typeof m.replyTo === "string" ? { replyTo: m.replyTo } : {}); break;
      case "answerOption":
        try { room.answerOption(String(m.messageId), String(m.optionId)); }
        catch (e) { vscode.window.showWarningMessage(String(e instanceof Error ? e.message : e)); this.post({ type: "optionError", messageId: String(m.messageId) }); }
        break;
      case "approve": room.respondApproval(String(m.id), !!m.allow); break;
      case "stop": room.stop(String(m.workerId)); break;
      case "reportIssue": void vscode.commands.executeCommand("agentroom.reportIssue"); break;
      case "inspect": void this.handlers?.inspect(String(m.turnId)); break;
      case "getProfile": { const profile = room.profile(String(m.workerId)); if (profile) this.post({ type: "profile", profile }); break; }
      case "openFile": if ((FILE_KINDS as readonly string[]).includes(m.kind)) void this.handlers?.openFile(String(m.workerId), m.kind as (typeof FILE_KINDS)[number]); break;
      case "setRange": if ((RANGES as string[]).includes(m.range)) { this.range = m.range as UsageRange; this.post(this.usagePayload()); } break;
      case "runSchedule": {
        try {
          const ok = c.cron.runNow(String(m.id));
          if (!ok) vscode.window.showInformationMessage(tr("Lịch \"{id}\" vẫn đang chạy lần trước nên chưa chạy thêm.", { id: String(m.id) }));
        } catch (e) { vscode.window.showWarningMessage(String(e instanceof Error ? e.message : e)); }
        break;
      }
      case "toggleSchedule": c.cron.setEnabled(String(m.id), !!m.enabled); break;
      case "approveSkill": try { room.approveSkill(String(m.name)); } catch (e) { vscode.window.showWarningMessage(String(e instanceof Error ? e.message : e)); } break;
      case "rejectSkill": room.rejectSkill(String(m.name)); break;
      case "allowBudget": if (c.config.accounts.some((a) => a.id === m.account)) room.allowBudgetToday(m.account); break;
      case "telegramAction": {
        const cmd = { setup: "agentroom.telegram.setup", pair: "agentroom.telegram.pair", unpair: "agentroom.telegram.unpair", setPin: "agentroom.telegram.setPin", disable: "agentroom.telegram.disable" }[String(m.action)];
        if (cmd) void vscode.commands.executeCommand(cmd);
        break;
      }
      case "setAutonomy": if (typeof m.workerId === "string" && typeof m.mode === "string") void this.handlers?.setAutonomy(m.workerId, m.mode); break;
      case "refreshPlans": void room.plan?.refresh(undefined, true); break;
      case "hostCheck": void c.hosts?.check(typeof m.name === "string" ? m.name : undefined); break;
      case "copyHook": { const h = this.hooksPayload().hooks.find((x) => x.id === m.id); if (h?.url) this.handlers?.copy(h.url); break; }
    }
  }

  private post(msg: unknown) {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, media: vscode.Uri) {
    const nonce = randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.js"));
    return `<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body>
  <header id="team"></header>
  <nav>
    <button data-tab="chat" class="on">Chat</button><button data-tab="tasks">Tasks</button><button data-tab="cost">${tr("Chi phí")}</button><button data-tab="sched">${tr("Lịch")}</button><button data-tab="hosts">${tr("Máy")}</button><button data-tab="profile">${tr("Hồ sơ")}<span id="draftBadge" hidden></span></button><button id="flag" class="flag" title="${tr("Ghi một vấn đề / lỗi")}">⚑</button>
  </nav>
  <main id="chat" class="tab"></main>
  <section id="tasks" class="tab" hidden></section>
  <section id="cost" class="tab" hidden></section>
  <section id="sched" class="tab" hidden></section>
  <section id="hosts" class="tab" hidden></section>
  <section id="profile" class="tab" hidden></section>
  <div id="approvals"></div>
  <div id="replybar" hidden></div>
  <form id="composer"><textarea id="input" rows="2" placeholder="${tr("Nhắn cả nhóm… dùng @id để gọi ai đó (Enter để gửi)")}"></textarea></form>
  <script nonce="${nonce}">window.__AR_LANG=${JSON.stringify(getLang())};window.__AR_EN=${getLang() === "en" ? JSON.stringify(EN).replace(/</g, "\\u003c") : "null"};</script>
  <script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
