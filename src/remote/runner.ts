import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AgentAdapter, ApprovalResult } from "../adapters/types";
import { RateLimitError, isRateLimit } from "../core/scheduler";
import { SkillInfo, buildPlugin } from "../core/skills";
import { Account, Provider, Worker } from "../core/types";
import { expandHome } from "../core/worktree";
import { HubToRunner, LineDecoder, ReadyInfo, PROTOCOL_VERSION, TurnMessage, RunnerToHub, b64, encode, unb64 } from "./protocol";

export interface RunnerDeps {
  makeAdapter(provider: Provider, turn: TurnMessage): AgentAdapter;
  ensureWorktree(base: string, w: Pick<Worker, "id" | "worktree">): Promise<string>;
  home: string;
  info: Omit<ReadyInfo, "v">;
}

interface ActiveTurn {
  abort: AbortController;
  secret: string;
  approvals: Map<string, (r: ApprovalResult) => void>;
}

const MCP_REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id"];
const MCP_RESPONSE_HEADERS = ["content-type", "mcp-session-id"];
const MAX_MCP_BODY = 8_000_000;
const MCP_TIMEOUT_MS = 120_000;
const SKILL_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Runs on the remote machine. Speaks the hub protocol over `input`/`output` (ssh stdio),
 * executes turns with the same adapters the hub uses locally, and exposes a loopback HTTP
 * endpoint that relays the agent's MCP calls back through the channel, so the remote CLI
 * can use the room's tools without any port forwarding.
 */
export class Runner {
  private turns = new Map<string, ActiveTurn>();
  private mcpWaiters = new Map<string, { resolve: (m: Extract<HubToRunner, { t: "mcp-res" }>) => void; timer: NodeJS.Timeout }>();
  private proxy?: Server;
  private proxyPort = 0;
  private finished!: () => void;

  constructor(private input: Readable, private output: Writable, private deps: RunnerDeps) {}

  private send(msg: RunnerToHub) {
    if (!this.output.writable) return;
    this.output.write(encode(msg));
  }

  /** Resolves when the hub closes the channel. */
  async run(): Promise<void> {
    await this.startProxy();
    const done = new Promise<void>((r) => (this.finished = r));
    const decoder = new LineDecoder((m) => this.onMessage(m as HubToRunner));
    this.input.on("data", (c) => decoder.push(c));
    this.input.on("end", () => this.shutdown());
    this.input.on("close", () => this.shutdown());
    this.send({ t: "ready", v: PROTOCOL_VERSION, ...this.deps.info });
    await done;
  }

  private shutdown() {
    for (const t of this.turns.values()) {
      t.abort.abort();
      for (const resolve of t.approvals.values()) resolve(false);
    }
    for (const w of this.mcpWaiters.values()) clearTimeout(w.timer);
    this.mcpWaiters.clear();
    this.proxy?.close();
    this.finished?.();
  }

  private onMessage(m: HubToRunner) {
    switch (m.t) {
      case "turn": void this.runTurn(m); break;
      case "abort": {
        const t = this.turns.get(m.id);
        if (t) { t.abort.abort(); for (const resolve of t.approvals.values()) resolve(false); }
        break;
      }
      case "approval":
        for (const t of this.turns.values()) {
          const r = t.approvals.get(m.reqId);
          if (r) { t.approvals.delete(m.reqId); r(m.reason ? { allow: m.allow, reason: m.reason } : m.allow); }
        }
        break;
      case "mcp-res": {
        const w = this.mcpWaiters.get(m.reqId);
        if (w) { clearTimeout(w.timer); this.mcpWaiters.delete(m.reqId); w.resolve(m); }
        break;
      }
      case "ping": this.send({ t: "pong", n: m.n }); break;
    }
  }

  // ---- skills ----

  /** Writes the skills a turn needs under ~/.agentroom/skills-cache/<hash>/ (once per content). */
  materializeSkills(skills: TurnMessage["skills"]): { srcDir: string; pluginDir: string } | undefined {
    if (!skills.length) return undefined;
    const hash = createHash("sha256")
      .update(JSON.stringify([...skills].sort((a, b) => a.name.localeCompare(b.name)).map((s) => [s.name, [...s.files].sort((a, b) => a.path.localeCompare(b.path))])))
      .digest("hex").slice(0, 16);
    const root = join(this.deps.home, ".agentroom", "skills-cache", hash);
    const srcDir = join(root, "src"), pluginDir = join(root, "plugin"), ok = join(root, ".ok");
    if (existsSync(ok)) return { srcDir, pluginDir };
    rmSync(root, { recursive: true, force: true });
    const infos: SkillInfo[] = [];
    for (const s of skills) {
      if (!SKILL_NAME.test(s.name)) throw new Error(`Tên skill không hợp lệ: ${s.name}`);
      for (const f of s.files) {
        const rel = normalize(f.path);
        if (rel.startsWith("..") || rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) throw new Error(`Đường dẫn skill không an toàn: ${f.path}`);
        const dest = join(srcDir, s.name, rel);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, unb64(f.b64));
      }
      infos.push({ name: s.name, description: "", dir: join(srcDir, s.name), source: "agentroom" });
    }
    buildPlugin(pluginDir, infos);
    writeFileSync(ok, "");
    return { srcDir, pluginDir };
  }

  // ---- turns ----

  private async runTurn(m: TurnMessage) {
    const abort = new AbortController();
    const turn: ActiveTurn = { abort, secret: randomBytes(16).toString("hex"), approvals: new Map() };
    this.turns.set(m.id, turn);
    try {
      const base = expandHome(m.base, this.deps.home);
      if (!existsSync(base)) throw new Error(`Thư mục repo không tồn tại trên máy này: ${base}`);
      const cwd = await this.deps.ensureWorktree(base, m.worker);
      this.send({ t: "started", id: m.id, cwd });     // the hub needs the real path to judge approvals
      const skills = this.materializeSkills(m.skills);

      const worker: Worker = {
        id: m.worker.id, name: m.worker.name, role: m.worker.role, skills: [], useSkills: m.worker.useSkills,
        provider: m.account.provider, account: m.account.id, fallback: [], model: m.worker.model, instructions: "",
        allowedTools: m.worker.allowedTools, tools: m.worker.tools, worktree: m.worker.worktree, coordinator: false, sandbox: m.worker.sandbox, color: "#000000", autonomy: "manual",
      };
      const account: Account = { id: m.account.id, provider: m.account.provider, home: m.account.home, apiKeyEnv: m.account.apiKeyEnv, baseUrl: m.account.baseUrl, authTokenEnv: m.account.authTokenEnv, maxConcurrent: 1, warnAtPercent: 80 };
      const claude = m.account.provider === "claude" && skills && worker.useSkills.length
        ? { plugins: [{ type: "local" as const, path: skills.pluginDir }], skills: worker.useSkills.map((n) => `agentroom:${n}`) }
        : undefined;

      const result = await this.deps.makeAdapter(m.account.provider, m).runTurn({
        worker, account, cwd,
        systemAppend: skills ? m.systemAppend.split("@@SKILLS@@").join(skills.srcDir) : m.systemAppend,
        prompt: m.prompt,
        sessionId: m.sessionId,
        mcpUrl: `http://127.0.0.1:${this.proxyPort}/${turn.secret}`,
        claudeSkills: claude,
        extraReadDirs: m.account.provider === "codex" && skills ? [skills.srcDir] : undefined,
        readOnly: m.readOnly,
        signal: abort.signal,
        onActivity: (text) => this.send({ t: "activity", id: m.id, text }),
        autonomy: m.autonomy,
        approve: (tool, input) => new Promise<ApprovalResult>((resolve) => {
          const reqId = randomUUID();
          turn.approvals.set(reqId, resolve);
          this.send({ t: "approve", id: m.id, reqId, tool, input });
        }),
      });
      this.send({ t: "result", id: m.id, sessionId: result.sessionId, text: result.text, usage: result.usage, cwd });
    } catch (e) {
      this.send({
        t: "error", id: m.id, message: e instanceof Error ? e.message : String(e),
        rateLimit: isRateLimit(e) || undefined, retryAfterMs: e instanceof RateLimitError ? e.retryAfterMs : undefined,
      });
    } finally {
      this.turns.delete(m.id);
    }
  }

  // ---- loopback MCP relay ----

  private startProxy(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.proxy = createServer((req, res) => void this.relay(req, res));
      this.proxy.once("error", reject);
      this.proxy.listen(0, "127.0.0.1", () => {
        this.proxyPort = (this.proxy!.address() as { port: number }).port;
        resolve();
      });
    });
  }

  private async relay(req: IncomingMessage, res: ServerResponse) {
    const fail = (status: number, text: string) => { if (!res.headersSent) res.writeHead(status, { "content-type": "text/plain" }); res.end(text); };
    const secret = (req.url ?? "").split("?")[0].split("/")[1];
    const entry = [...this.turns.entries()].find(([, t]) => t.secret === secret);
    if (!secret || !entry) return fail(404, "unknown");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > MAX_MCP_BODY) return fail(413, "too large");
      chunks.push(c as Buffer);
    }
    const headers: Record<string, string> = {};
    for (const h of MCP_REQUEST_HEADERS) { const v = req.headers[h]; if (typeof v === "string") headers[h] = v; }
    const reqId = randomUUID();
    const answer = new Promise<Extract<HubToRunner, { t: "mcp-res" }> | undefined>((resolve) => {
      const timer = setTimeout(() => { this.mcpWaiters.delete(reqId); resolve(undefined); }, MCP_TIMEOUT_MS);
      this.mcpWaiters.set(reqId, { resolve, timer });
    });
    this.send({ t: "mcp", id: entry[0], reqId, method: req.method ?? "POST", headers, b64: b64(Buffer.concat(chunks)) });
    const r = await answer;
    if (!r) return fail(504, "hub did not answer");
    const out: Record<string, string> = {};
    for (const h of MCP_RESPONSE_HEADERS) if (r.headers[h]) out[h] = r.headers[h];
    res.writeHead(r.status, out);
    res.end(unb64(r.b64));
  }
}
