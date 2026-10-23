import { createServer, IncomingMessage, Server } from "node:http";
import { randomBytes } from "node:crypto";
import { AddressInfo } from "node:net";
import { z } from "zod";
import { MemoryError, KINDS } from "../core/memory";
import type { Room } from "../core/room";

type McpSdk = typeof import("@modelcontextprotocol/sdk/server/mcp.js");
type HttpSdk = typeof import("@modelcontextprotocol/sdk/server/streamableHttp.js");

const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });
const fail = (e: unknown) => ({ ...text(e instanceof Error ? e.message : String(e)), isError: true });

/**
 * Local MCP server (streamable HTTP, stateless) that gives every agent — Claude or
 * Codex — the same coordination tools. The URL embeds a random token and the
 * worker id, so the server knows who is calling and nothing else on the machine can.
 *   http://127.0.0.1:<port>/mcp/<token>/<workerId>
 */
export class AgentRoomMcp {
  private http?: Server;
  private token = randomBytes(16).toString("hex");
  private port = 0;

  constructor(private room: Room) {}

  async start(): Promise<void> {
    const [{ McpServer }, { StreamableHTTPServerTransport }] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/mcp.js") as Promise<McpSdk>,
      import("@modelcontextprotocol/sdk/server/streamableHttp.js") as Promise<HttpSdk>,
    ]);
    this.http = createServer(async (req, res) => {
      const m = req.url?.match(/^\/mcp\/([0-9a-f]+)\/([\w-]+)$/);
      if (!m || m[1] !== this.token || !this.room.hasWorker(m[2])) return void res.writeHead(404).end();
      if (req.method !== "POST") return void res.writeHead(405).end();
      try {
        const body = await readJson(req);
        const server = new McpServer({ name: "agentroom", version: "0.1.0" });
        this.registerTools(server, m[2]);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on("close", () => { transport.close(); server.close(); });
        await server.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (e) {
        if (!res.headersSent) res.writeHead(500).end(String(e));
      }
    });
    await new Promise<void>((resolve) => this.http!.listen(0, "127.0.0.1", resolve));
    this.port = (this.http.address() as AddressInfo).port;
  }

  urlFor(workerId: string): string {
    return `http://127.0.0.1:${this.port}/mcp/${this.token}/${workerId}`;
  }

  dispose() {
    this.http?.close();
  }

  private registerTools(server: InstanceType<McpSdk["McpServer"]>, me: string) {
    const room = this.room;
    server.registerTool("post_message", {
      description: "Đăng tin nhắn vào group chat ngay lập tức (giữa lượt). @mention id để gọi đồng đội trả lời.",
      inputSchema: { text: z.string(), taskId: z.string().optional() },
    }, async ({ text: t, taskId }) => {
      const msg = room.post(me, t, { taskId });
      return text(msg.to.length ? `Đã gửi, sẽ gọi: ${msg.to.join(", ")}` : "Đã gửi (không ai bị gọi).");
    });

    server.registerTool("read_channel", {
      description: "Đọc N tin nhắn gần nhất của group chat.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(30) },
    }, async ({ limit }) => text(room.transcript(limit)));

    server.registerTool("list_tasks", {
      description: "Liệt kê task trên bảng. mine=true chỉ lấy task của bạn.",
      inputSchema: { mine: z.boolean().default(false) },
    }, async ({ mine }) => {
      const tasks = room.tasks.list().filter((t) => !mine || t.assignee === me);
      return text(JSON.stringify(tasks, null, 2));
    });

    server.registerTool("create_task", {
      description: "Tạo task mới, có thể giao cho đồng đội (assignee = worker id) và khai báo task phụ thuộc.",
      inputSchema: {
        title: z.string(),
        description: z.string().default(""),
        assignee: z.string().optional(),
        dependsOn: z.array(z.string()).default([]),
      },
    }, async (args) => {
      try { return text(JSON.stringify(room.createTask(me, args))); } catch (e) { return fail(e); }
    });

    server.registerTool("claim_task", {
      description: "Nhận một task (chuyển sang in_progress).",
      inputSchema: { id: z.string() },
    }, async ({ id }) => {
      try { return text(JSON.stringify(room.claimTask(me, id))); } catch (e) { return fail(e); }
    });

    const memo = <T>(fn: () => T) => { try { return text(JSON.stringify(fn())); } catch (e) { return e instanceof MemoryError ? fail(e) : fail(e); } };

    server.registerTool("remember", {
      description: "Ghi một điều đáng nhớ vào trí nhớ bền vững (còn nguyên ở các session sau). scope: me = riêng bạn, team = cả đội. Mỗi mục một ý, ≤ 500 ký tự, KHÔNG lưu bí mật.",
      inputSchema: { scope: z.enum(["me", "team"]).default("me"), kind: z.enum(KINDS as [string, ...string[]]).default("fact"), text: z.string() },
    }, async ({ scope, kind, text: t }) => memo(() => room.memory.add(scope, me, kind as never, t)));

    server.registerTool("forget", {
      description: "Xoá một mục trí nhớ theo id (vd M7). Mục kind=decision chỉ xoá được khi người dùng yêu cầu rõ (force=true).",
      inputSchema: { scope: z.enum(["me", "team"]).default("me"), id: z.string(), force: z.boolean().default(false) },
    }, async ({ scope, id, force }) => memo(() => room.memory.forget(scope, me, id, force)));

    server.registerTool("recall", {
      description: "Tìm trong trí nhớ và nhật ký 60 ngày gần nhất (khớp mọi từ khoá, không phân biệt hoa thường).",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(50).default(10) },
    }, async ({ query, limit }) => {
      const hits = room.memory.recall(me, query, limit);
      return text(hits.length ? hits.map((h) => `[${h.where}] ${h.text}`).join("\n") : "(không có kết quả)");
    });

    server.registerTool("journal", {
      description: "Ghi thêm một dòng vào nhật ký hôm nay của bạn (việc đã làm, vướng mắc).",
      inputSchema: { text: z.string() },
    }, async ({ text: t }) => {
      try { room.memory.journal(me, t); return text("Đã ghi."); } catch (e) { return fail(e); }
    });

    server.registerTool("propose_skill", {
      description: "Đề xuất một skill mới từ kinh nghiệm (quy trình lặp lại được). Skill chỉ có hiệu lực sau khi người dùng duyệt. name: a-z, 0-9, '-'. description: khi nào nên dùng. body: các bước (markdown).",
      inputSchema: { name: z.string(), description: z.string(), body: z.string() },
    }, async ({ name, description, body }) => {
      try { room.proposeSkill(me, name, description, body); return text("Đã gửi đề xuất, chờ người dùng duyệt."); } catch (e) { return fail(e); }
    });

    server.registerTool("complete_task", {
      description: "Đánh dấu task xong kèm kết quả. Các task phụ thuộc sẽ tự được mở và người phụ trách được báo.",
      inputSchema: { id: z.string(), result: z.string() },
    }, async ({ id, result }) => {
      try { return text(JSON.stringify(room.completeTask(me, id, result))); } catch (e) { return fail(e); }
    });
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : undefined); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
