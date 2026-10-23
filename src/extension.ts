import * as vscode from "vscode";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { parseConfig, SAMPLE_CONFIG } from "./core/config";
import { Room } from "./core/room";
import { Scheduler } from "./core/scheduler";
import { RoomStore } from "./core/store";
import { ensureWorktree } from "./core/worktree";
import { AgentRoomMcp } from "./mcp/server";
import { ChatViewProvider } from "./ui/chatView";

let room: Room | undefined;
let mcp: AgentRoomMcp | undefined;

export async function activate(ctx: vscode.ExtensionContext) {
  const view = new ChatViewProvider(ctx.extensionUri);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("agentroom.chat", view, { webviewOptions: { retainContextWhenHidden: true } }));

  const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  const load = async () => {
    room?.stopAll();
    mcp?.dispose();
    room = mcp = undefined;
    const ws = root();
    const file = ws && join(ws, ".agentroom", "workers.yaml");
    if (!file || !existsSync(file)) return view.attach(undefined);
    try {
      const settings = vscode.workspace.getConfiguration("agentroom");
      const config = parseConfig(readFileSync(file, "utf8"));
      const server: { current?: AgentRoomMcp } = {};
      room = new Room({
        config,
        store: new RoomStore(join(ws, ".agentroom", "state")),
        adapters: { claude: new ClaudeAdapter(), codex: new CodexAdapter() },
        scheduler: new Scheduler(),
        options: { maxAgentHops: settings.get("maxAgentHops", 6), contextMessages: settings.get("contextMessages", 30) },
        resolveCwd: (w) => ensureWorktree(ws, w),
        mcpUrl: (id) => server.current!.urlFor(id),
      });
      mcp = server.current = new AgentRoomMcp(room);
      await mcp.start();
      view.attach(room);
    } catch (e) {
      vscode.window.showErrorMessage(`AgentRoom: workers.yaml lỗi — ${e instanceof Error ? e.message : e}`);
      view.attach(undefined);
    }
  };

  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentroom.init", async () => {
      const ws = root();
      if (!ws) return vscode.window.showWarningMessage("Hãy mở một thư mục trước.");
      const dir = join(ws, ".agentroom");
      const file = join(dir, "workers.yaml");
      mkdirSync(dir, { recursive: true });
      if (!existsSync(file)) writeFileSync(file, SAMPLE_CONFIG);
      writeFileSync(join(dir, ".gitignore"), "state/\nworktrees/\n");
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      await load();
    }),
    vscode.commands.registerCommand("agentroom.reload", load),
    vscode.commands.registerCommand("agentroom.stopAll", () => room?.stopAll()),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.agentroom/workers.yaml");
  watcher.onDidChange(load);
  watcher.onDidCreate(load);
  ctx.subscriptions.push(watcher, { dispose: () => { room?.stopAll(); mcp?.dispose(); } });

  await load();
}

export function deactivate() {
  room?.stopAll();
  mcp?.dispose();
}
