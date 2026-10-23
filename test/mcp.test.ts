import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, SAMPLE_CONFIG } from "../src/core/config";
import { Room } from "../src/core/room";
import { Scheduler } from "../src/core/scheduler";
import { RoomStore } from "../src/core/store";
import { AgentRoomMcp } from "../src/mcp/server";

test("mcp: agents coordinate through tools over streamable HTTP", async () => {
  const idleAdapter = { runTurn: async () => ({ text: "" }) };
  const holder: { mcp?: AgentRoomMcp } = {};
  const room = new Room({
    config: parseConfig(SAMPLE_CONFIG),
    store: new RoomStore(mkdtempSync(join(tmpdir(), "agentroom-"))),
    adapters: { claude: idleAdapter, codex: idleAdapter },
    scheduler: new Scheduler(),
    options: { maxAgentHops: 6, contextMessages: 30 },
    resolveCwd: async () => tmpdir(),
    mcpUrl: (id) => holder.mcp!.urlFor(id),
  });
  const mcp = (holder.mcp = new AgentRoomMcp(room));
  await mcp.start();

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urlFor("lead"))));

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["claim_task", "complete_task", "create_task", "list_tasks", "post_message", "read_channel"]);

  const created = await client.callTool({ name: "create_task", arguments: { title: "API login", assignee: "be" } });
  const task = JSON.parse((created.content as any)[0].text);
  assert.equal(room.tasks.get(task.id)!.assignee, "be");

  await client.callTool({ name: "post_message", arguments: { text: "chào @qa" } });
  const read = await client.callTool({ name: "read_channel", arguments: { limit: 5 } });
  assert.match((read.content as any)[0].text, /@lead: chào @qa/);

  const bad = await fetch(mcp.urlFor("lead").replace(/mcp\/\w+/, "mcp/deadbeef"), { method: "POST" });
  assert.equal(bad.status, 404);

  await client.close();
  mcp.dispose();
});
