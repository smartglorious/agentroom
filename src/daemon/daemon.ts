import { tr } from "../core/i18n";
import { IssueStore } from "../core/issues";
import { VERSION } from "../core/version";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ClaudeAdapter } from "../adapters/claude";
import { CodexAdapter } from "../adapters/codex";
import { makePlanProbe } from "../adapters/plan";
import { RemoteAdapter } from "../adapters/remote";
import type { AgentAdapter } from "../adapters/types";
import { BotApi } from "../channels/telegram/api";
import { BotDeps, TelegramBot } from "../channels/telegram/bot";
import { TelegramService } from "../channels/telegram/service";
import { findExecutable } from "../core/cli";
import { parseConfig } from "../core/config";
import { CronEngine } from "../core/cron";
import { TurnInspector } from "../core/inspector";
import { RoomLock } from "../core/lock";
import { MemoryStore } from "../core/memory";
import { Room } from "../core/room";
import { Scheduler } from "../core/scheduler";
import { SkillDrafts, SkillRegistry, checkWorkerSkills, skillSources } from "../core/skills";
import type { HostDef } from "../core/types";
import { RoomStore } from "../core/store";
import { SYSTEM } from "../core/types";
import { UsageStore } from "../core/usage";
import { WebhookHandler, WebhookServer } from "../core/webhooks";
import { ensureWorktree, localBase } from "../core/worktree";
import { AgentRoomMcp } from "../mcp/server";
import { HostManager, fingerprint } from "../remote/host";
import { DaemonStore, defaultStoreFile, pairingFile } from "./store";

export const EXIT = { ok: 0, config: 2, locked: 3 } as const;

export class DaemonError extends Error {
  constructor(readonly exitCode: number, message: string) {
    super(message);
  }
}

export interface DaemonOptions {
  /** The project folder (the one that contains .agentroom/workers.yaml). */
  root: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Seize the room from whoever holds it (a VS Code window, or another daemon). */
  takeOver?: boolean;
  log?: (text: string) => void;
  /** Path of dist/runner.mjs, uploaded to remote hosts. */
  runnerPath?: string;
  // Test seams.
  adapters?: { claude: AgentAdapter; codex: AgentAdapter };
  apiBase?: string;
  bot?: BotDeps;
  planProbe?: import("../core/plan").PlanProbe;
  lockHeartbeatMs?: number;
}

export interface DaemonHandle {
  room: Room;
  telegram?: TelegramService;
  /** Resolves when another process took the room over; the daemon has already shut down by then. */
  lost: Promise<void>;
  /** New 10-minute pairing code, also written to the pairing file for `agentroom-daemon pair`. */
  requestPairing(): { code: string; expiresAt: number } | undefined;
  stop(): void;
}

/** `trust-hosts` records "<root>|<fingerprint>"; a repo cannot make the daemon ssh anywhere on its own. */
export const hostTrusted = (store: DaemonStore, root: string, spec: HostDef) => store.read().trusted?.includes(`${root}|${fingerprint(spec)}`) ?? false;

const tokenId = (token: string) => createHash("sha256").update(token).digest("hex").slice(0, 12);

/**
 * The same room VS Code runs — Telegram, schedules, webhooks, remote hosts — without a window.
 * It takes the same RoomLock, so a daemon and a VS Code window never orchestrate one folder together.
 */
export async function startDaemon(o: DaemonOptions): Promise<DaemonHandle> {
  const log = o.log ?? (() => {});
  const home = o.home ?? homedir();
  const env = o.env ?? process.env;
  const file = join(o.root, ".agentroom", "workers.yaml");
  if (!existsSync(file)) throw new DaemonError(EXIT.config, tr("Không thấy {file}. Chạy với --root <thư mục project>.", { file }));

  let config;
  try {
    config = parseConfig(readFileSync(file, "utf8"));
  } catch (e) {
    throw new DaemonError(EXIT.config, tr("workers.yaml lỗi — {p}", { p: e instanceof Error ? e.message : e }));
  }

  const agentroomDir = join(o.root, ".agentroom");
  const stateDir = join(agentroomDir, "state");
  const lock = new RoomLock(join(stateDir, "room.lock"), { kind: "daemon", heartbeatMs: o.lockHeartbeatMs });
  if (o.takeOver) lock.takeOver();
  else {
    const got = lock.acquire();
    if (!got.ok) {
      const h = got.holder;
      throw new DaemonError(EXIT.locked, tr("Phòng đang chạy ở {who}. Dùng --take-over để chiếm quyền.", { who: h ? tr("{kind} (máy {host}, pid {pid})", { kind: h.kind === "daemon" ? tr("một daemon khác") : tr("một cửa sổ VS Code"), host: h.host, pid: h.pid }) : tr("một tiến trình khác") }));
    }
  }

  const store = new DaemonStore(defaultStoreFile(home));
  const settings = () => store.settings();
  const disposers: (() => void)[] = [];
  let stopped = false;
  let onLost!: () => void;
  const lost = new Promise<void>((r) => (onLost = r));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const d of disposers.reverse()) { try { d(); } catch { /* shutting down */ } }
    lock.release();
  };
  lock.on("lost", () => { log(tr("Một tiến trình khác đã chiếm quyền điều phối; daemon dừng.")); stop(); onLost(); });

  try {
    const s0 = settings();
    const skills = new SkillRegistry(skillSources(o.root, home));
    const usage = new UsageStore(stateDir);
    const issues = new IssueStore(join(stateDir, "issues.json"), { version: VERSION, platform: process.platform, node: process.version, scrub: [[o.root, "<project>"], [home, "~"]] });
    const roomStore = new RoomStore(stateDir);
    const server: { current?: AgentRoomMcp } = {};

    let hosts: HostManager | undefined;
    if (config.hosts.length) {
      const runnerPath = o.runnerPath;
      if (!runnerPath || !existsSync(runnerPath)) log(tr("Thiếu dist/runner.mjs nên không chạy được worker trên máy khác."));
      hosts = new HostManager(config.hosts, {
        runner: runnerPath && existsSync(runnerPath) ? readFileSync(runnerPath) : undefined,
        // Nobody is here to click "allow": hosts must have been approved with `trust-hosts`.
        confirm: async (spec) => {
          const ok = hostTrusted(store, o.root, spec);
          if (!ok) log(tr("Host \"{name}\" ({ssh}) chưa được cho phép. Chạy: agentroom-daemon trust-hosts --root {root}", { name: spec.name, ssh: spec.ssh, root: o.root }));
          return ok;
        },
        prices: () => settings().pricing,
        log: (t) => log(t),
        onRunnerUpload: (h) => log(tr("[{h}] đã cài runner mới", { h })),
      });
      disposers.push(() => hosts!.closeAll());
    }

    const cli = (name: "claude" | "codex") => () => {
      const found = findExecutable(name, settings()[`${name}Path` as "claudePath" | "codexPath"]);
      if (!found) throw new Error(tr("Không tìm thấy CLI \"{name}\" (PATH của daemon: {p}). Cài nó hoặc chạy: agentroom-daemon set {name}Path /đường/dẫn/{name}", { name, p: env.PATH ?? "" }));
      return found;
    };

    const room = new Room({
      config,
      store: roomStore,
      remote: hosts ? new RemoteAdapter(hosts) : undefined,
      adapters: o.adapters ?? { claude: new ClaudeAdapter(cli("claude")), codex: new CodexAdapter(cli("codex"), () => settings().pricing) },
      scheduler: new Scheduler(),
      options: { maxAgentHops: s0.maxAgentHops, contextMessages: s0.contextMessages, memoryBudgetChars: s0.memoryBudgetChars, agentDebounceMs: s0.agentDebounceMs },
      memory: new MemoryStore(agentroomDir),
      skills,
      skillDrafts: new SkillDrafts(join(agentroomDir, "skills")),
      pluginDir: join(agentroomDir, ".plugin"),
      usage,
      inspector: new TurnInspector(stateDir, s0.inspectorKeepTurns),
      resolveCwd: (w) => ensureWorktree(localBase(o.root, w), w),
      mcpUrl: (id) => server.current!.urlFor(id),
      home,
      issues,
      autonomyStore: {
        get: (id) => store.read().autonomy?.[`${o.root}|${id}`],
        set: (id, m) => store.update((f) => { f.autonomy = { ...f.autonomy, [`${o.root}|${id}`]: m }; }),
      },
      planProbe: o.planProbe ?? makePlanProbe({ claude: () => findExecutable("claude", settings().claudePath), codex: cli("codex") }),
      planPollMs: () => settings().planPollMinutes * 60_000,
    });
    room.plan?.start();
    disposers.push(() => room.plan?.stop());
    disposers.push(() => room.stopAll());

    const mcp = (server.current = new AgentRoomMcp(room));
    await mcp.start();
    disposers.push(() => mcp.dispose());

    const problems = [...checkWorkerSkills(config.workers, skills), ...skills.problems.map((p) => `${p.dir}: ${p.message}`)];
    for (const p of problems) log(`skill: ${p}`);

    const cron = new CronEngine({
      schedules: config.schedules,
      workerIds: config.workers.map((w) => w.id),
      now: Date.now,
      load: () => roomStore.loadSchedules(),
      save: (x) => roomStore.saveSchedules(x),
      isBusy: (w, prefix) => room.isActive(`${w}:${prefix}`),
      fire: (sch, workerId, taskId) => {
        log(tr("lịch \"{id}\" → {workerId}", { id: sch.id, workerId }));
        if (sch.builtin === "consolidate-memory") room.consolidateMemory(workerId, taskId);
        else room.post(SYSTEM, tr("@{workerId} [lịch {id}] {prompt}", { workerId, id: sch.id, prompt: sch.prompt }), { taskId, to: [workerId] });
      },
    });
    cron.start();
    disposers.push(() => cron.stop());

    if (config.webhooks.length) {
      const hooks = new WebhookHandler(config.webhooks, {
        env: (n) => env[n],
        now: Date.now,
        trigger: (def, text, taskId) => room.post(SYSTEM, `@${def.worker} ${text}`, { taskId, to: [def.worker], readOnly: def.readOnly || undefined }),
      });
      const server = new WebhookServer(hooks, s0.hookPort);
      try {
        await server.start();
        disposers.push(() => server.dispose());
        log(`webhook: http://127.0.0.1:${server.port}/hook/<id>`);
      } catch (e) {
        log(tr("không mở được cổng webhook {port} ({p}); đổi bằng: agentroom-daemon set hookPort <cổng>", { port: server.port, p: e instanceof Error ? e.message : e }));
      }
    }

    // Telegram: on whenever a token is known (AGENTROOM_TELEGRAM_TOKEN wins over the stored one).
    let telegram: TelegramService | undefined;
    const token = env.AGENTROOM_TELEGRAM_TOKEN?.trim() || store.read().telegram?.token;
    if (token) {
      const id = tokenId(token);
      // Only for a self-hosted Bot API server or a test double; the token is sent there.
      const apiBase = o.apiBase ?? env.AGENTROOM_TELEGRAM_API;
      telegram = new TelegramService({
        room, usage, config,
        bot: new TelegramBot(new BotApi(token, apiBase ? { apiBase } : {}), { log: (t) => { log(`[telegram] ${t}`); if (/lỗi|không (gửi|khởi động)|failed|error/i.test(t)) room.noteIssue({ kind: "error", source: "telegram", title: t }); }, ...o.bot }),
        settings,
        stores: {
          paired: {
            get: () => store.read().telegram?.paired?.[id],
            set: (u) => store.update((f) => {
              f.telegram = { ...f.telegram, paired: { ...f.telegram?.paired } };
              if (u) f.telegram.paired![id] = u; else delete f.telegram.paired![id];
            }),
          },
          pin: { get: () => store.read().telegram?.pin },
        },
        log,
        workspaceName: o.root.split(/[\\/]/).pop(),
      });
      disposers.push(() => telegram!.stop());
      void telegram.start().catch((e) => { const m = tr("không khởi động được: {p}", { p: e instanceof Error ? e.message : e }); log(`[telegram] ${m}`); room.noteIssue({ kind: "error", source: "telegram", title: m }); });
    } else {
      log(tr("Telegram chưa thiết lập (chạy: agentroom-daemon setup-telegram)."));
    }

    const pf = token ? pairingFile(home, tokenId(token)) : undefined;
    if (pf) disposers.push(() => { try { unlinkSync(pf); } catch { /* none */ } });
    const requestPairing = () => {
      if (!telegram || !pf) return undefined;
      const c = telegram.createPairingCode();
      mkdirSync(join(pf, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(pf, JSON.stringify(c), { mode: 0o600 });
      log(tr("mã ghép cặp mới tạo (hết hạn sau 10 phút); xem bằng: agentroom-daemon pair"));
      return c;
    };
    if (telegram && !telegram.status().paired) requestPairing();

    log(tr("daemon đang điều phối {root} ({n} worker)", { root: o.root, n: config.workers.length }));
    return { room, telegram, lost, requestPairing, stop };
  } catch (e) {
    stop();
    throw e;
  }
}
