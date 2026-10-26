import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRoomMcp } from "../src/mcp/server";
import { Fake, makeRoom } from "./helpers";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqliteConnection } from "../src/storage/sqlite";
import { SqliteMigrationRunner } from "../src/storage/migrations";
import { schemaMigrations } from "../src/storage/schema-v1";
import { AGENTROOM_TOOL_MANIFESTS, DurableToolGateway, ToolManifestRegistry } from "../src/gateway/tools";
import { SqliteToolReceiptStore } from "../src/storage/tool-receipts";

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
  assert.deepEqual(names, ["ask_user", "claim_task", "complete_task", "create_task", "forget", "journal", "list_tasks", "post_message", "propose_skill", "read_channel", "recall", "remember"]);

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

test("mcp: mutating calls inside a durable turn commit policy-complete effect receipts", async () => {
  const db = await SqliteConnection.open(join(mkdtempSync(join(tmpdir(), "ar-mcp-receipt-")), "agentroom.db"));
  await new SqliteMigrationRunner(db, schemaMigrations).apply();
  await db.exec(`
    INSERT INTO workspaces(id,name,root_uri,created_at,updated_at) VALUES ('w1','W','file:///w',1,1);
    INSERT INTO tasks(id,workspace_id,title,status,created_by,created_at,updated_at) VALUES ('t1','w1','T','todo','user',1,1);
    INSERT INTO runs(id,workspace_id,task_id,status,attempt,created_at,updated_at) VALUES ('r1','w1','t1','running',1,1,1);
    INSERT INTO steps(id,workspace_id,run_id,ordinal,kind,status,idempotency_key,version,created_at,updated_at)
      VALUES ('s1','w1','r1',0,'model','running','turn',1,1,1);
  `);
  const { room } = makeRoom(new Fake());
  (room as any).running.set("lead:main", { chain: "c", abort: new AbortController(), depth: 0, readOnly: false, workspaceId: "w1", stepId: "s1" });
  const gateway = new DurableToolGateway(new ToolManifestRegistry(AGENTROOM_TOOL_MANIFESTS), new SqliteToolReceiptStore(db));
  const mcp = new AgentRoomMcp(room, gateway); await mcp.start();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "receipt", version: "0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urlFor("lead"))));
    await client.callTool({ name: "post_message", arguments: { text: "durable notice" } });
    const saved = await db.get<any>("SELECT tool_id, status, receipt_json FROM tool_receipts");
    assert.equal(saved.tool_id, "post_message"); assert.equal(saved.status, "succeeded");
    assert.equal(JSON.parse(saved.receipt_json).policy_input.effects.network, "local");
  } finally { await client.close(); mcp.dispose(); room.stopAll(); await db.close(); }
});
