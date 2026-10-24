import * as vscode from "vscode";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter, PriceTable } from "./adapters/codex";
import { makePlanProbe } from "./adapters/plan";
import { RemoteAdapter } from "./adapters/remote";
import { BotApi } from "./channels/telegram/api";
import { TelegramBot } from "./channels/telegram/bot";
import { PIN_FORMAT, hashPin } from "./channels/telegram/pin";
import { PairedUser, TelegramService, TelegramSettings } from "./channels/telegram/service";
import { findExecutable } from "./core/cli";
import { gatherCleanup, humanBytes, listBatches, restoreCleanup, scanCleanup } from "./core/cleanup";
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
import type { RoomConfig } from "./core/types";
import { WebhookHandler, WebhookServer } from "./core/webhooks";
import { HostManager, fingerprint } from "./remote/host";
import { ensureWorktree, localBase } from "./core/worktree";
import { AgentRoomMcp } from "./mcp/server";
import { ChatViewProvider, ViewContext } from "./ui/chatView";
import { TelegramPanel } from "./ui/telegramPanel";
import { createHash } from "node:crypto";
import { Autonomy, isAutonomy } from "./core/autonomy";

const FULL_WARNING = [
  "Worker này sẽ KHÔNG còn hỏi bạn trước khi: sửa hoặc xóa bất kỳ file nào (kể cả ngoài dự án), chạy lệnh tùy ý, tải rồi chạy mã từ Internet, cài gói, git push --force, gửi dữ liệu ra ngoài.",
  "",
  "Nội dung worker đọc được (trang web, issue, file lạ) có thể chứa chỉ dẫn độc hại điều khiển nó (prompt injection). Ở Full Access, những chỉ dẫn đó chạy mà không qua kiểm duyệt.",
  "",
  "Vẫn hỏi bạn với: rm -rf thư mục gốc/home/hệ thống, sudo, ghi đĩa, tắt máy, ghi vào /etc… Đây chỉ là chốt chặn tối thiểu, KHÔNG phải sandbox.",
  "",
  "Chỉ nên dùng trong máy ảo/container hoặc repo đã commit sạch. Full Access chỉ kéo dài đến khi bạn đóng VS Code, và chỉ bạn mới bật được (repo, agent và Telegram không bật được). Nguồn không tin cậy như webhook vẫn chỉ-đọc.",
].join("\n");

const TOKEN_KEY = "agentroom.telegram.token";
const PIN_KEY = "agentroom.telegram.pin";

interface Live {
  lock: RoomLock;
  hosts?: HostManager;
  telegram?: TelegramService;
  room: Room;
  mcp: AgentRoomMcp;
  cron: CronEngine;
  hooks?: WebhookHandler;
  hookServer?: WebhookServer;
  inspector: TurnInspector;
  root: string;
  usage: UsageStore;
  config: RoomConfig;
}

let live: Live | undefined;

function dispose() {
  if (!live) return;
  live.room.stopAll();
  live.room.plan?.stop();
  live.cron.stop();
  live.hookServer?.dispose();
  live.telegram?.stop();
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
  const fullGrants = new Set<string>();
  const autonomyKey = (ws: string, id: string) => `agentroom.autonomy.${createHash("sha1").update(ws).digest("hex").slice(0, 10)}.${id}`;
  const panel = new TelegramPanel();
  const pinHolder: { hash?: string } = {};

  /** Starts (or restarts) the Telegram channel for the room that is running, if it is switched on and has a token. */
  const startTelegram = async () => {
    live?.telegram?.stop();
    if (live) live.telegram = undefined;
    panel.attach(undefined, "disabled");
    const room = live?.room;
    const tcfg = vscode.workspace.getConfiguration("agentroom.telegram");
    if (!room || !tcfg.get<boolean>("enabled", false)) return;
    const token = await ctx.secrets.get(TOKEN_KEY);
    if (!token) return panel.attach(undefined, "no-token");
    pinHolder.hash = await ctx.secrets.get(PIN_KEY);
    const pairedKey = `agentroom.telegram.paired.${createHash("sha256").update(token).digest("hex").slice(0, 12)}`;
    const svc = new TelegramService({
      room, usage: live!.usage, config: live!.config,
      bot: new TelegramBot(new BotApi(token), { log: (t) => out.appendLine(`[telegram] ${t}`) }),
      settings: liveSettings,
      stores: {
        paired: { get: () => ctx.globalState.get<PairedUser>(pairedKey), set: async (u) => { await ctx.globalState.update(pairedKey, u); } },
        pin: { get: () => pinHolder.hash },
      },
      log: (t) => out.appendLine(t),
      workspaceName: root() ? root()!.split(/[\\/]/).pop() : undefined,
    });
    live!.telegram = svc;
    panel.attach(svc);
    await svc.start();
  };
  /** Settings are re-read on every use so changes apply without a restart. */
  const liveSettings = (): TelegramSettings => {
    const t = vscode.workspace.getConfiguration("agentroom.telegram");
    return {
      detail: t.get("detail", "summary") as TelegramSettings["detail"],
      approveFromPhone: t.get("approveFromPhone", "safe") as TelegramSettings["approveFromPhone"],
      summaryChars: Math.min(3000, Math.max(100, t.get<number>("summaryChars", 600))),
      quietHours: t.get("quietHours", ""),
    };
  };

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
        options: { maxAgentHops: cfg.get("maxAgentHops", 6), contextMessages: cfg.get("contextMessages", 30), memoryBudgetChars: cfg.get("memoryBudgetChars", 12000), agentDebounceMs: Math.max(0, cfg.get<number>("agentDebounceMs", 1500)) },
        memory: new MemoryStore(agentroomDir),
        skills,
        skillDrafts: new SkillDrafts(join(agentroomDir, "skills")),
        pluginDir: join(agentroomDir, ".plugin"),
        usage,
        inspector,
        resolveCwd: (w) => ensureWorktree(localBase(ws, w), w),
        mcpUrl: (id) => server.current!.urlFor(id),
        autonomyStore: {
          // Manual/Auto are remembered per project on this machine; Full lasts for this VS Code session only.
          get: (id) => (fullGrants.has(`${ws}|${id}`) ? "full" : (ctx.globalState.get<string>(autonomyKey(ws, id)) as Autonomy | undefined)),
          set: (id, m) => {
            if (m === "full") { fullGrants.add(`${ws}|${id}`); return; }
            fullGrants.delete(`${ws}|${id}`);
            void ctx.globalState.update(autonomyKey(ws, id), m);
          },
        },
        home: homedir(),
        planProbe: makePlanProbe({ claude: () => findExecutable("claude", settings().get<string>("claudePath")), codex: cli("codex") }),
        planPollMs: () => Math.max(0, cfg.get<number>("planUsage.pollMinutes", 10)) * 60_000,
      });
      room.plan?.start();
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

      live = { lock, hosts, room, mcp, cron, hooks, hookServer, inspector, root: agentroomDir, usage, config };
      const vctx: ViewContext = { room, cron, hooks, hookPort: hookServer?.port, usage, config, hosts, telegram: panel };
      view.attach(vctx);
      void startTelegram().catch((e) => out.appendLine(`[telegram] không khởi động được: ${e instanceof Error ? e.message : e}`));
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
    setAutonomy: async (workerId, mode) => {
      const room = live?.room;
      if (!room || !isAutonomy(mode) || !room.hasWorker(workerId)) return;
      if (mode === "full" && room.autonomyOf(workerId) !== "full") {
        const name = room.workers.find((w) => w.id === workerId)?.name ?? workerId;
        const pick = await vscode.window.showWarningMessage(`⚠ Bật FULL ACCESS cho ${name} (@${workerId})?`, { modal: true, detail: FULL_WARNING }, "Bật Full Access");
        if (pick !== "Bật Full Access") return view.refreshWorkers();
      }
      room.setAutonomy(workerId, mode, "VS Code");
    },
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
    vscode.commands.registerCommand("agentroom.telegram.setup", async () => {
      const token = await vscode.window.showInputBox({
        title: "AgentRoom — Telegram",
        prompt: "Dán token của bot (từ @BotFather). Hãy dùng một bot RIÊNG cho AgentRoom, không dùng chung với chương trình khác.",
        password: true, ignoreFocusOut: true,
        validateInput: (v) => (/^\d{5,}:[\w-]{20,}$/.test(v.trim()) ? undefined : "Token có dạng 123456789:AAxxxxxxxx…"),
      });
      if (!token) return;
      try {
        const me = await new BotApi(token.trim()).getMe();
        await ctx.secrets.store(TOKEN_KEY, token.trim());
        await vscode.workspace.getConfiguration("agentroom.telegram").update("enabled", true, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`Đã kết nối bot @${me.username ?? me.first_name}.`);
        await startTelegram();
        await vscode.commands.executeCommand("agentroom.telegram.pair");
      } catch (e) {
        vscode.window.showErrorMessage(`Telegram: ${e instanceof Error ? e.message : e}`);
      }
    }),
    vscode.commands.registerCommand("agentroom.telegram.pair", async () => {
      const svc = live?.telegram;
      if (!svc) return vscode.window.showWarningMessage("Telegram chưa chạy. Chạy “AgentRoom: Telegram — thiết lập” trước.");
      const { code } = svc.createPairingCode();
      const who = svc.status().bot ?? "bot của bạn";
      out.appendLine(`[telegram] mã ghép cặp: ${code} (10 phút)`);
      const pick = await vscode.window.showInformationMessage(`Mở Telegram, chat RIÊNG với ${who} và gửi:  /pair ${code}   (hết hạn sau 10 phút)`, "Sao chép lệnh");
      if (pick) await vscode.env.clipboard.writeText(`/pair ${code}`);
    }),
    vscode.commands.registerCommand("agentroom.telegram.unpair", async () => {
      await live?.telegram?.unpair();
      vscode.window.showInformationMessage("Đã ngắt ghép cặp Telegram.");
    }),
    vscode.commands.registerCommand("agentroom.telegram.setPin", async () => {
      const pin = await vscode.window.showInputBox({ title: "PIN duyệt quyền từ điện thoại", prompt: "4–8 chữ số. Để trống để bỏ PIN.", password: true, ignoreFocusOut: true, validateInput: (v) => (!v || PIN_FORMAT.test(v) ? undefined : "Chỉ 4–8 chữ số") });
      if (pin === undefined) return;
      if (!pin) { await ctx.secrets.delete(PIN_KEY); pinHolder.hash = undefined; panel.attach(panel.service); return void vscode.window.showInformationMessage("Đã bỏ PIN."); }
      const again = await vscode.window.showInputBox({ title: "Nhập lại PIN", password: true, ignoreFocusOut: true });
      if (again !== pin) return void vscode.window.showWarningMessage("Hai lần nhập PIN không khớp.");
      const h = hashPin(pin);
      await ctx.secrets.store(PIN_KEY, h);
      pinHolder.hash = h;
      panel.attach(panel.service);
      vscode.window.showInformationMessage("Đã đặt PIN. Duyệt quyền và cho account chạy tiếp từ điện thoại sẽ cần PIN.");
    }),
    vscode.commands.registerCommand("agentroom.telegram.disable", async () => {
      await vscode.workspace.getConfiguration("agentroom.telegram").update("enabled", false, vscode.ConfigurationTarget.Global);
      await startTelegram();
    }),
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
    vscode.commands.registerCommand("agentroom.cleanup", async () => {
      const ws = root();
      if (!ws) return;
      const days = vscode.workspace.getConfiguration("agentroom").get<number>("cleanup.turnsOlderThanDays", 0);
      const items = scanCleanup(ws, { turnsOlderThanDays: days });
      if (!items.length) return vscode.window.showInformationMessage("Không thấy file rác, tạm hay cache nào để dọn.");
      const picks = await vscode.window.showQuickPick(items.map((i) => ({ label: i.rel + (i.dir ? "/" : ""), description: `${humanBytes(i.bytes)} · ${i.why}`, picked: false, rel: i.rel })), { canPickMany: true, title: "Chọn mục để GOM về thư mục dọn dẹp (chỉ di chuyển, không xóa)" });
      if (!picks?.length) return;
      const r = gatherCleanup(ws, picks.map((p) => p.rel));
      const msg = `Đã gom ${r.manifest.entries.length} mục vào ${r.dir}. Không có gì bị xóa; bạn tự xóa thư mục đó khi chắc chắn.${r.skipped.length ? ` Bỏ qua ${r.skipped.length} mục.` : ""}`;
      const act = await vscode.window.showInformationMessage(msg, "Mở thư mục");
      if (act) void vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(r.dir));
    }),
    vscode.commands.registerCommand("agentroom.cleanup.restore", async () => {
      const ws = root();
      if (!ws) return;
      const batches = listBatches(ws);
      if (!batches.length) return vscode.window.showInformationMessage("Chưa có lô dọn dẹp nào.");
      const pick = await vscode.window.showQuickPick(batches.map((b) => ({ label: b.stamp, description: `${b.entries.length} mục · ${humanBytes(b.entries.reduce((a, e) => a + e.bytes, 0))}`, stamp: b.stamp })), { title: "Khôi phục lô nào về chỗ cũ?" });
      if (!pick) return;
      const r = restoreCleanup(ws, pick.stamp);
      vscode.window.showInformationMessage(`Đã khôi phục ${r.restored.length} mục${r.skipped.length ? `, bỏ qua ${r.skipped.length} (đã có file mới hoặc không còn)` : ""}.`);
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

  ctx.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("agentroom.telegram.enabled")) void startTelegram().catch((err) => out.appendLine(`[telegram] ${err}`));
  }));

  const watcher = vscode.workspace.createFileSystemWatcher("**/.agentroom/workers.yaml");
  watcher.onDidChange(load);
  watcher.onDidCreate(load);
  ctx.subscriptions.push(watcher, { dispose });

  await load();
}

export function deactivate() {
  dispose();
}
