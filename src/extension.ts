import * as vscode from "vscode";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter, PriceTable } from "./adapters/codex";
import { RemoteAdapter } from "./adapters/remote";
import { findExecutable } from "./core/cli";
import { parseConfig, SAMPLE_CONFIG } from "./core/config";
import { CronEngine } from "./core/cron";
import { TurnInspector, renderTurn } from "./core/inspector";
import { RoomLock } from "./core/lock";
import { MemoryStore } from "./core/memory";
import { Room } from "./core/room";
import { Scheduler } from "./core/scheduler";
import { SKILL_NAME, SKILL_TEMPLATE, SkillDrafts, SkillRegistry, checkWorkerSkills, skillSources } from "./core/skills";
import { RoomStore } from "./core/store";
import { SYSTEM } from "./core/types";
import { UsageStore } from "./core/usage";
import { WebhookHandler, WebhookServer } from "./core/webhooks";
import { HostManager, fingerprint } from "./remote/host";
import { ensureWorktree, localBase } from "./core/worktree";
import { AgentRoomMcp } from "./mcp/server";
import { ChatViewProvider, ViewContext } from "./ui/chatView";

interface Live {
  lock: RoomLock;
  hosts?: HostManager;
  room: Room;
  mcp: AgentRoomMcp;
  cron: CronEngine;
  hooks?: WebhookHandler;
  hookServer?: WebhookServer;
  inspector: TurnInspector;
  root: string;
}

let live: Live | undefined;

function dispose() {
  if (!live) return;
  live.room.stopAll();
  live.cron.stop();
  live.hookServer?.dispose();
  live.hosts?.closeAll();
  live.mcp.dispose();
  live.lock.release();
  live = undefined;
}

export async function activate(ctx: vscode.ExtensionContext) {
  const view = new ChatViewProvider(ctx.extensionUri);
  ctx.subscriptions.push(vscode.window.registerWebviewViewProvider("agentroom.chat", view, { webviewOptions: { retainContextWhenHidden: true } }));

  // Context Inspector documents: agentroom-turn:/<turnId>.md
  ctx.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider("agentroom-turn", {
    provideTextDocumentContent(uri) {
      const id = uri.path.replace(/^\//, "").replace(/\.md$/, "");
      const rec = live?.inspector.load(id);
      return rec ? renderTurn(rec) : "Không tìm thấy lượt này (đã bị xoá do vượt giới hạn lưu, hoặc Inspector đang tắt).";
    },
  }));

  const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const settings = () => vscode.workspace.getConfiguration("agentroom");
  const out = vscode.window.createOutputChannel("AgentRoom");
  ctx.subscriptions.push(out);
  let forceTakeOver = false;

  /** Hosts are defined by the repo's workers.yaml, so the user approves each one before we ssh anywhere. */
  const confirmHost = (ws: string) => async (spec: import("./core/types").HostDef) => {
    const key = `${ws}|${fingerprint(spec)}`;
    const trusted = ctx.globalState.get<string[]>("agentroom.trustedHosts", []);
    if (trusted.includes(key)) return true;
    const choice = await vscode.window.showWarningMessage(
      `AgentRoom muốn kết nối SSH tới "${spec.ssh}"${spec.port ? ":" + spec.port : ""} (host "${spec.name}")`,
      { modal: true, detail: `Cấu hình này nằm trong ${ws}/.agentroom/workers.yaml. AgentRoom sẽ chạy một chương trình nhỏ (runner) trên máy đó để chạy worker, bằng tài khoản SSH của bạn. Chỉ cho phép nếu bạn tin repo này.` },
      "Cho phép lần này", "Luôn cho phép host này",
    );
    if (!choice) return false;
    if (choice === "Luôn cho phép host này") await ctx.globalState.update("agentroom.trustedHosts", [...trusted, key]);
    return true;
  };

  // Resolved on every turn so a CLI installed after activation is picked up.
  const cli = (name: "claude" | "codex") => () => {
    const found = findExecutable(name, settings().get<string>(`${name}Path`));
    if (!found) throw new Error(`Không tìm thấy CLI "${name}". Hãy cài ${name === "claude" ? "Claude Code" : "Codex CLI"} hoặc đặt agentroom.${name}Path.`);
    return found;
  };

  const load = async () => {
    dispose();
    const ws = root();
    const file = ws && join(ws, ".agentroom", "workers.yaml");
    if (!ws || !file || !existsSync(file)) return view.attach(undefined);
    // One orchestrator per .agentroom folder (see RoomLock).
    const lock = new RoomLock(join(ws, ".agentroom", "state", "room.lock"));
    if (forceTakeOver) { forceTakeOver = false; lock.takeOver(); }
    else {
      const got = lock.acquire();
      if (!got.ok) return view.attachLocked(got.holder);
    }
    lock.on("lost", () => {
      dispose();
      view.attachLocked(lock.peek());
      vscode.window.showWarningMessage("AgentRoom: một cửa sổ khác đã chiếm quyền điều phối thư mục này, nên cửa sổ này đã dừng.");
    });
    try {
      const cfg = settings();
      const config = parseConfig(readFileSync(file, "utf8"));
      const agentroomDir = join(ws, ".agentroom");
      const stateDir = join(agentroomDir, "state");
      const store = new RoomStore(stateDir);
      const skills = new SkillRegistry(skillSources(ws, homedir()));
      const server: { current?: AgentRoomMcp } = {};
      const inspector = new TurnInspector(stateDir, cfg.get("inspector.keepTurns", 300));
      const usage = new UsageStore(stateDir);

      let hosts: HostManager | undefined;
      if (config.hosts.length) {
        const runnerPath = join(ctx.extensionPath, "dist", "runner.mjs");
        if (!existsSync(runnerPath)) vscode.window.showWarningMessage("AgentRoom: thiếu dist/runner.mjs nên không chạy được worker trên máy khác (chạy npm run build).");
        hosts = new HostManager(config.hosts, {
          runner: existsSync(runnerPath) ? readFileSync(runnerPath) : undefined,
          confirm: confirmHost(ws),
          prices: () => cfg.get("pricing", {}),
          log: (t) => out.appendLine(t),
          onRunnerUpload: (h) => out.appendLine(`[${h}] đã cài runner mới`),
        });
      }

      const room = new Room({
        config,
        store,
        remote: hosts ? new RemoteAdapter(hosts) : undefined,
        adapters: { claude: new ClaudeAdapter(cli("claude")), codex: new CodexAdapter(cli("codex"), () => cfg.get<PriceTable>("pricing", {})) },
        scheduler: new Scheduler(),
        options: { maxAgentHops: cfg.get("maxAgentHops", 6), contextMessages: cfg.get("contextMessages", 30), memoryBudgetChars: cfg.get("memoryBudgetChars", 12000) },
        memory: new MemoryStore(agentroomDir),
        skills,
        skillDrafts: new SkillDrafts(join(agentroomDir, "skills")),
        pluginDir: join(agentroomDir, ".plugin"),
        usage,
        inspector,
        resolveCwd: (w) => ensureWorktree(localBase(ws, w), w),
        mcpUrl: (id) => server.current!.urlFor(id),
      });
      const mcp = (server.current = new AgentRoomMcp(room));
      await mcp.start();

      const problems = [...checkWorkerSkills(config.workers, skills), ...skills.problems.map((p) => `${p.dir}: ${p.message}`)];
      if (problems.length) vscode.window.showWarningMessage(`AgentRoom: ${problems.length} vấn đề với skills — ${problems[0]}`);

      // Schedules: notify when a notifying run's worker answers.
      const notify = new Map<string, string>();
      room.on("message", (m) => {
        const id = m.taskId && notify.get(m.taskId);
        if (id && m.from !== SYSTEM && m.from !== "user") {
          notify.delete(m.taskId!);
          vscode.window.showInformationMessage(`AgentRoom · lịch "${id}": ${m.text.slice(0, 160)}`);
        }
      });
      const cron = new CronEngine({
        schedules: config.schedules,
        workerIds: config.workers.map((w) => w.id),
        now: Date.now,
        load: () => store.loadSchedules(),
        save: (s) => store.saveSchedules(s),
        isBusy: (w, prefix) => room.isActive(`${w}:${prefix}`),
        fire: (s, workerId, taskId) => {
          if (s.notify) notify.set(taskId, s.id);
          if (s.builtin === "consolidate-memory") room.consolidateMemory(workerId, taskId);
          else room.post(SYSTEM, `@${workerId} [lịch ${s.id}] ${s.prompt}`, { taskId, to: [workerId] });
        },
      });
      cron.start();

      // Webhooks (127.0.0.1 only).
      let hooks: WebhookHandler | undefined;
      let hookServer: WebhookServer | undefined;
      if (config.webhooks.length) {
        hooks = new WebhookHandler(config.webhooks, {
          env: (n) => process.env[n],
          now: Date.now,
          trigger: (def, text, taskId) => room.post(SYSTEM, `@${def.worker} ${text}`, { taskId, to: [def.worker], readOnly: def.readOnly || undefined }),
        });
        hookServer = new WebhookServer(hooks, cfg.get("hookPort", 47321));
        try {
          await hookServer.start();
        } catch (e) {
          vscode.window.showWarningMessage(`AgentRoom: không mở được cổng webhook ${hookServer.port} (${e instanceof Error ? e.message : e}). Đổi agentroom.hookPort.`);
          hookServer = undefined;
        }
      }

      live = { lock, hosts, room, mcp, cron, hooks, hookServer, inspector, root: agentroomDir };
      const vctx: ViewContext = { room, cron, hooks, hookPort: hookServer?.port, usage, config, hosts };
      view.attach(vctx);
    } catch (e) {
      dispose();
      lock.release();
      vscode.window.showErrorMessage(`AgentRoom: workers.yaml lỗi — ${e instanceof Error ? e.message : e}`);
      view.attach(undefined);
    }
  };

  view.setHandlers({
    inspect: async (turnId) => {
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(`agentroom-turn:/${turnId}.md`));
      await vscode.window.showTextDocument(doc, { preview: true });
    },
    // Paths come from the room's own profile, never from the webview.
    openFile: async (workerId, kind) => {
      const p = live?.room.profile(workerId);
      const path = p && { soul: p.soulPath, memory: p.memoryPath, journal: p.journalPath, team: p.teamMemoryPath }[kind];
      if (!path) return;
      if (!existsSync(path)) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, ""); }
      await vscode.window.showTextDocument(vscode.Uri.file(path));
    },
    copy: (text) => vscode.env.clipboard.writeText(text),
  });

  ctx.subscriptions.push(
    vscode.commands.registerCommand("agentroom.init", async () => {
      const ws = root();
      if (!ws) return vscode.window.showWarningMessage("Hãy mở một thư mục trước.");
      const dir = join(ws, ".agentroom");
      const file = join(dir, "workers.yaml");
      mkdirSync(dir, { recursive: true });
      if (!existsSync(file)) writeFileSync(file, SAMPLE_CONFIG);
      writeFileSync(join(dir, ".gitignore"), "state/\nworktrees/\n.plugin/\nsurvey.md\nagents/*/journal/\n");
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      await load();
    }),
    vscode.commands.registerCommand("agentroom.reload", load),
    vscode.commands.registerCommand("agentroom.takeOver", async () => { forceTakeOver = true; await load(); }),
    vscode.commands.registerCommand("agentroom.checkHosts", async () => {
      if (!live?.hosts) return vscode.window.showInformationMessage("Chưa khai báo hosts: trong workers.yaml.");
      const st = await live.hosts.check();
      out.show(true);
      for (const h of st) out.appendLine(`${h.state === "ready" ? "✓" : "✗"} ${h.name} (${h.ssh}) — ${h.state === "ready" ? `node ${h.node}, ${h.platform}, claude: ${h.claude ?? "không thấy"}, codex: ${h.codex ?? "không thấy"}` : h.error}`);
    }),
    vscode.commands.registerCommand("agentroom.stopAll", () => live?.room.stopAll()),
    vscode.commands.registerCommand("agentroom.consolidateMemory", async () => {
      if (!live) return vscode.window.showWarningMessage("AgentRoom chưa được cấu hình.");
      const pick = await vscode.window.showQuickPick(["(tất cả worker)", ...live.room.workers.map((w) => w.id)], { placeHolder: "Gom trí nhớ của ai?" });
      if (!pick) return;
      for (const w of pick === "(tất cả worker)" ? live.room.workers : live.room.workers.filter((x) => x.id === pick)) live.room.consolidateMemory(w.id);
    }),
    vscode.commands.registerCommand("agentroom.newSkill", async () => {
      const ws = root();
      if (!ws) return;
      const name = await vscode.window.showInputBox({ prompt: "Tên skill (a-z, 0-9, '-')", validateInput: (v) => (SKILL_NAME.test(v) ? undefined : "Chỉ dùng a-z, 0-9 và '-'") });
      if (!name) return;
      const description = await vscode.window.showInputBox({ prompt: "Mô tả: khi nào nên dùng skill này?" });
      if (!description) return;
      const f = join(ws, ".agentroom", "skills", name, "SKILL.md");
      if (existsSync(f)) return vscode.window.showWarningMessage(`Skill "${name}" đã tồn tại.`);
      mkdirSync(join(f, ".."), { recursive: true });
      writeFileSync(f, SKILL_TEMPLATE(name, description));
      await vscode.window.showTextDocument(vscode.Uri.file(f));
      vscode.window.showInformationMessage(`Đã tạo skill "${name}". Thêm vào useSkills của worker trong workers.yaml để bật.`);
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher("**/.agentroom/workers.yaml");
  watcher.onDidChange(load);
  watcher.onDidCreate(load);
  ctx.subscriptions.push(watcher, { dispose });

  await load();
}

export function deactivate() {
  dispose();
}
