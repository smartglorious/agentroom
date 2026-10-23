import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRoomMcp } from "../src/mcp/server";
import { Fake, makeRoom } from "./helpers";

test("mcp: agents coordinate through tools over streamable HTTP", async () => {
  const holder: { mcp?: AgentRoomMcp } = {};
  const { room } = makeRoom(new Fake(() => ""), { mcpUrl: (id) => holder.mcp!.urlFor(id) });
  const mcp = (holder.mcp = new AgentRoomMcp(room));
  await mcp.start();

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urlFor("lead"))));

  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["claim_task", "complete_task", "create_task", "forget", "journal", "list_tasks", "post_message", "propose_skill", "read_channel", "recall", "remember"]);

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
