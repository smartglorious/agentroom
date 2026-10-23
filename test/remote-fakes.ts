import { AgentAdapter, TurnRequest, TurnResult } from "../src/adapters/types";
import { RateLimitError } from "../src/core/scheduler";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * What the "remote CLI" does, selected by markers in the prompt, so tests can drive every path of
 * the runner without a real Claude or Codex.
 */
export const scripted: AgentAdapter = {
  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const p = req.prompt;
    if (p.includes("[ACT]")) { req.onActivity("Edit a.ts"); req.onActivity("Bash npm test"); }
    if (p.includes("[APPROVE]")) {
      const ok = await req.approve("Bash", { command: "ls" });
      return { text: ok ? "approved" : "denied" };
    }
    if (p.includes("[MCP]")) {
      // exactly what Claude/Codex do: speak MCP over HTTP to the URL they were given
      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      const client = new Client({ name: "remote-cli", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(req.mcpUrl)));
      const tools = (await client.listTools()).tools.map((t) => t.name);
      await client.callTool({ name: "post_message", arguments: { text: "chào từ máy xa @qa" } });
      const created = await client.callTool({ name: "create_task", arguments: { title: "task từ máy xa", assignee: "be" } });
      await client.close();
      return { text: JSON.stringify({ tools: tools.length, created: (created.content as { text: string }[])[0].text.length > 0 }) };
    }
    if (p.includes("[BADMCP]")) {
      const u = new URL(req.mcpUrl);
      const r = await fetch(`${u.origin}/deadbeefdeadbeef`, { method: "POST", body: "{}" });
      return { text: String(r.status) };
    }
    if (p.includes("[FAIL]")) throw new Error("boom");
    if (p.includes("[RATE]")) throw new RateLimitError("429 từ xa", 1234);
    if (p.includes("[SLEEP]")) {
      await new Promise<void>((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    if (p.includes("[SLOW]")) await sleep(300);
    if (p.includes("[ECHO]")) {
      return {
        sessionId: "sess-" + req.worker.id,
        text: JSON.stringify({
          cwd: req.cwd, session: req.sessionId, readOnly: req.readOnly, worker: req.worker.id, tools: req.worker.allowedTools, sandbox: req.worker.sandbox,
          // no raw @mentions: the reply is posted to the room and would wake those workers
          sys: req.systemAppend.replace(/@/g, "＠"), claudeSkills: req.claudeSkills, extra: req.extraReadDirs, account: req.account.id, home: req.account.home, apiKeyEnv: req.account.apiKeyEnv,
        }),
      };
    }
    return {
      sessionId: "sess-" + req.worker.id, text: "ok:" + p.slice(0, 24),
      usage: { model: "fake-1", input: 10, output: 5, cacheRead: 20, cacheWrite: 0, costUsd: 0.01, estimated: false, numTurns: 1 },
    };
  },
};
