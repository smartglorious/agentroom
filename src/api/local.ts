import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Room } from "../core/room";
import { HUMAN } from "../core/types";

interface ApiEvent { id: number; type: string; data: unknown; at: number }
const json = (res: ServerResponse, status: number, body: unknown) => { const data = JSON.stringify(body); res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data) }); res.end(data); };
const safeEqual = (a: string, b: string) => timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());

export class DeviceTokenStore {
  constructor(readonly file: string) {}
  loadOrCreate(): string {
    try { const token = readFileSync(this.file, "utf8").trim(); if (token.length >= 32) return token; } catch { /* create */ }
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });
    const token = randomBytes(32).toString("base64url");
    writeFileSync(this.file, token, { encoding: "utf8", mode: 0o600 });
    try { chmodSync(this.file, 0o600); } catch { /* Windows ACL is inherited from the user profile */ }
    return token;
  }
  rotate(): string { const token = randomBytes(32).toString("base64url"); writeFileSync(this.file, token, { encoding: "utf8", mode: 0o600 }); return token; }
}

export interface LocalApiOptions { room: Room; token: () => string; port?: number; maxEvents?: number; allowedOrigins?: string[] }

/** Authenticated loopback REST/SSE authority. It never binds a non-loopback interface. */
export class LocalApiServer {
  private server?: Server;
  private events: ApiEvent[] = [];
  private nextId = 1;
  private listeners = new Set<ServerResponse>();
  private paused = new Set<string>();
  private roomListeners: Array<[string, (...args: any[]) => void]> = [];
  port = 0;
  constructor(private readonly options: LocalApiOptions) {}

  async start() {
    if (this.server) return;
    const bind = (name: string, listener: (...args: any[]) => void) => { this.options.room.on(name as any, listener); this.roomListeners.push([name, listener]); };
    bind("message", (v) => this.push("message", v));
    bind("status", (v) => this.push("status", v));
    bind("tasks", (v) => this.push("tasks", v));
    bind("usage", () => this.push("usage", this.options.room.snapshot().todayByWorker));
    bind("approval", (v) => this.push("approval", v));
    bind("approvalResolved", (v) => this.push("approval_resolved", { id: v }));
    this.server = createServer((req, res) => { void this.handle(req, res).catch((error) => json(res, 500, { error: "internal_error", message: error instanceof Error ? error.message : String(error) })); });
    await new Promise<void>((resolve, reject) => { this.server!.once("error", reject); this.server!.listen(this.options.port ?? 0, "127.0.0.1", resolve); });
    this.port = (this.server.address() as AddressInfo).port;
  }
  url() { return `http://127.0.0.1:${this.port}/v1`; }
  dispose() { for (const res of this.listeners) res.end(); this.listeners.clear(); for (const [name, listener] of this.roomListeners) this.options.room.off(name as any, listener); this.roomListeners = []; this.server?.close(); this.server = undefined; }

  private push(type: string, data: unknown) {
    const event = { id: this.nextId++, type, data, at: Date.now() };
    this.events.push(event);
    const max = this.options.maxEvents ?? 1_000;
    if (this.events.length > max) this.events.splice(0, this.events.length - max);
    for (const listener of this.listeners) {
      if (listener.writableLength > 1024 * 1024) { listener.end(); this.listeners.delete(listener); }
      else this.writeEvent(listener, event);
    }
  }
  private writeEvent(res: ServerResponse, event: ApiEvent) { res.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`); }
  private authorized(req: IncomingMessage) {
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1] ?? "";
    if (!bearer || !safeEqual(bearer, this.options.token())) return false;
    const origin = req.headers.origin;
    if (origin && !(this.options.allowedOrigins ?? ["vscode-webview://", "http://127.0.0.1", "http://localhost"]).some((allowed) => origin.startsWith(allowed))) return false;
    if (!/^(GET|HEAD)$/i.test(req.method ?? "") && !safeEqual(String(req.headers["x-agentroom-csrf"] ?? ""), bearer)) return false;
    return true;
  }
  private async body(req: IncomingMessage) {
    const parts: Buffer[] = []; let size = 0;
    for await (const part of req) { const b = Buffer.from(part); size += b.length; if (size > 256 * 1024) throw new Error("request_body_too_large"); parts.push(b); }
    return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : {};
  }
  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (!this.authorized(req)) return json(res, 401, { error: "unauthorized" });
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, version: 1, cursor: this.nextId - 1 });
    if (req.method === "GET" && url.pathname === "/v1/state") return json(res, 200, this.options.room.snapshot());
    if (req.method === "GET" && url.pathname === "/v1/usage") return json(res, 200, { workers: this.options.room.snapshot().todayByWorker });
    if (req.method === "GET" && url.pathname === "/v1/events") {
      const cursor = Number(req.headers["last-event-id"] ?? url.searchParams.get("cursor") ?? 0);
      const oldest = this.events[0]?.id ?? this.nextId;
      if (cursor > 0 && cursor < oldest - 1) return json(res, 409, { error: "cursor_expired", oldest_cursor: oldest });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      for (const event of this.events) if (event.id > cursor) this.writeEvent(res, event);
      this.listeners.add(res); req.once("close", () => this.listeners.delete(res)); return;
    }
    const worker = /^\/v1\/workers\/([^/]+)\/(pause|resume|cancel)$/.exec(url.pathname);
    if (req.method === "POST" && worker) {
      const id = decodeURIComponent(worker[1]); if (!this.options.room.hasWorker(id)) return json(res, 404, { error: "worker_not_found" });
      if (worker[2] === "pause") { this.paused.add(id); this.options.room.stop(id); }
      else if (worker[2] === "resume") this.paused.delete(id);
      else this.options.room.stop(id);
      this.push(`worker_${worker[2]}`, { id }); return json(res, 202, { id, state: worker[2] });
    }
    const approval = /^\/v1\/approvals\/([^/]+)$/.exec(url.pathname);
    if (req.method === "POST" && approval) { const b = await this.body(req); this.options.room.respondApproval(decodeURIComponent(approval[1]), b.allow === true); return json(res, 200, { ok: true }); }
    if (req.method === "POST" && url.pathname === "/v1/messages") {
      const b = await this.body(req); const recipients = Array.isArray(b.to) ? b.to.filter((id: unknown) => typeof id === "string" && !this.paused.has(id)) : undefined;
      if (typeof b.text !== "string" || !b.text.trim()) return json(res, 400, { error: "text_required" });
      const message = this.options.room.post(HUMAN, b.text, { to: recipients, taskId: typeof b.taskId === "string" ? b.taskId : undefined,
        replyTo: typeof b.replyTo === "string" ? b.replyTo : undefined, source: "local-api" });
      return json(res, 202, message);
    }
    if (req.method === "POST" && url.pathname === "/v1/tasks") {
      const b = await this.body(req); if (typeof b.title !== "string" || !b.title.trim()) return json(res, 400, { error: "title_required" });
      return json(res, 201, this.options.room.createTask(HUMAN, { title: b.title, description: b.description, assignee: b.assignee, dependsOn: b.dependsOn }));
    }
    return json(res, 404, { error: "not_found" });
  }
}
