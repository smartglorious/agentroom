import * as vscode from "vscode";
import { randomBytes } from "node:crypto";
import type { Room } from "../core/room";

/** Messages the webview sends to the extension. */
type FromWebview =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "approve"; id: string; allow: boolean }
  | { type: "stop"; workerId: string };

/** Sidebar webview that renders the room. The extension host stays the source of truth. */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private room?: Room;
  private unsubscribe: (() => void)[] = [];

  constructor(private extensionUri: vscode.Uri) {}

  attach(room: Room | undefined) {
    this.unsubscribe.forEach((u) => u());
    this.unsubscribe = [];
    this.room = room;
    if (!room) return void this.post({ type: "init", state: null });
    const on = <K extends "message" | "status" | "approval" | "approvalResolved" | "tasks">(ev: K, map: (x: any) => unknown) => {
      const h = (x: unknown) => this.post(map(x));
      room.on(ev, h as never);
      this.unsubscribe.push(() => room.off(ev, h as never));
    };
    on("message", (msg) => ({ type: "message", msg }));
    on("status", (status) => ({ type: "status", status }));
    on("approval", (req) => ({ type: "approval", req }));
    on("approvalResolved", (id) => ({ type: "approvalResolved", id }));
    on("tasks", (tasks) => ({ type: "tasks", tasks }));
    this.post({ type: "init", state: room.snapshot() });
  }

  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    const media = vscode.Uri.joinPath(this.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: FromWebview) => {
      if (m.type === "ready") this.post({ type: "init", state: this.room?.snapshot() ?? null });
      else if (!this.room) return;
      else if (m.type === "send" && m.text.trim()) this.room.post("user", m.text.trim());
      else if (m.type === "approve") this.room.respondApproval(m.id, m.allow);
      else if (m.type === "stop") this.room.stop(m.workerId);
    });
  }

  private post(msg: unknown) {
    this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview, media: vscode.Uri) {
    const nonce = randomBytes(16).toString("base64");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "main.js"));
    return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="${css}"></head>
<body>
  <header id="team"></header>
  <nav><button data-tab="chat" class="on">Chat</button><button data-tab="tasks">Tasks</button></nav>
  <main id="chat"></main>
  <section id="tasks" hidden></section>
  <div id="approvals"></div>
  <form id="composer"><textarea id="input" rows="2" placeholder="Nhắn cả nhóm… dùng @id để gọi ai đó (Enter để gửi)"></textarea></form>
  <script nonce="${nonce}" src="${js}"></script>
</body></html>`;
  }
}
