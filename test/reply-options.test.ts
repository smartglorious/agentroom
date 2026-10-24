import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentRoomMcp } from "../src/mcp/server";
import type { ChatMessage } from "../src/core/types";
import { Fake, idle, makeRoom } from "./helpers";

const workerMsg = (room: ReturnType<typeof makeRoom>["room"], from: string, text: string, taskId?: string) => room.post(from, text, { taskId, to: [] });
const lastTo = (room: ReturnType<typeof makeRoom>["room"]) => room.snapshot().messages.at(-1)!;

test("reply: a reply goes back to the author of the message, in that message's task session", async () => {
  const fake = new Fake(() => "ok");
  const { room } = makeRoom(fake);
  const q = workerMsg(room, "be", "Dùng REST hay GraphQL?", "T1");
  const a = room.post("user", "REST nhé", { replyTo: q.id });
  assert.deepEqual(a.to, ["be"], "no @mention needed: it answers @be");
  assert.equal(a.taskId, "T1", "…in the session of task T1");
  assert.equal(a.replyTo, q.id);
  await idle(room);
  assert.deepEqual(fake.prompts.map((p) => p.worker), ["be"]);
  assert.match(fake.calls[0].prompt, /\[task T1\] \[trả lời tin “@be: Dùng REST hay GraphQL\?”\]: REST nhé/);
});

test("reply: an @mention in the reply is the user's own choice of who answers; unknown targets are ignored; plain messages are unchanged", async () => {
  const { room } = makeRoom(new Fake(() => "ok"));
  const q = workerMsg(room, "be", "Cần review không?");
  const a = room.post("user", "@qa xem giúp", { replyTo: q.id });
  assert.deepEqual(a.to, ["qa"]);
  assert.equal(a.replyTo, q.id, "still linked to the message it answers");
  const orphan = room.post("user", "tin lẻ", { replyTo: "khong-co" });
  assert.equal(orphan.replyTo, undefined);
  assert.deepEqual(orphan.to, ["lead"], "falls back to the coordinator like any message");
  const plain = room.post("user", "@be làm việc");
  assert.equal(plain.replyTo, undefined);
  await idle(room);
});

test("reply: replying to a system notice or to the user's own message does not pick a recipient by itself", () => {
  const { room } = makeRoom(new Fake(() => "ok"));
  const sys = room.post("system", "⚠️ có lỗi", { to: [] });
  const r = room.post("user", "ok", { replyTo: sys.id });
  assert.deepEqual(r.to, ["lead"]);
});

test("ask_user: the question carries options, wakes nobody, and lands in the task session the worker is in", async () => {
  let ask: ChatMessage | undefined;
  const fake = new Fake((req) => {
    if (req.worker.id === "be") {
      ask = room.askUser("be", { question: "Chọn cơ sở dữ liệu?", options: [{ label: "Postgres", description: "ổn định" }, { label: "SQLite" }, { label: "Gọi @qa hỏi" }] });
    }
    return "đợi bạn chọn";
  });
  const { room } = makeRoom(fake);
  room.post("user", "@be bắt đầu", { taskId: "T9" });
  await idle(room);
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(ask);
  assert.equal(ask!.taskId, "T9", "the question belongs to the session that asked it");
  assert.deepEqual(ask!.to, [], "an @mention inside an option does not wake anyone");
  assert.deepEqual(ask!.options!.items.map((i) => [i.id, i.label]), [["1", "Postgres"], ["2", "SQLite"], ["3", "Gọi @qa hỏi"]]);
  assert.match(ask!.text, /^Chọn cơ sở dữ liệu\?\n1\. Postgres — ổn định\n2\. SQLite\n3\. Gọi @qa hỏi\n@user /);
  assert.equal(fake.calls.length, 1, "nobody else was woken");
});

test("answerOption: the pick goes to the asking worker's own session once, and cannot be repeated or forged", async () => {
  const fake = new Fake(() => "tiếp tục");
  const { room } = makeRoom(fake);
  const q = room.askUser("be", { question: "Chọn?", options: [{ label: "A" }, { label: "B" }] }, "T5");
  const a = room.answerOption(q.id, "2", "telegram");
  assert.equal(a.text, "Tôi chọn 2: B");
  assert.deepEqual([a.from, a.to, a.taskId, a.replyTo, a.choice, a.source], ["user", ["be"], "T5", q.id, { message: q.id, option: "2" }, "telegram"]);
  await idle(room);
  assert.match(fake.calls[0].prompt, /\[task T5\] \[trả lời tin “@be: Chọn\?/);
  assert.match(fake.calls[0].prompt, /Tôi chọn 2: B/);

  assert.throws(() => room.answerOption(q.id, "1"), /đã được trả lời/);
  assert.throws(() => room.answerOption("không-có", "1"), /không có lựa chọn/i);
  const q2 = room.askUser("be", { question: "Hai?", options: [{ label: "X" }, { label: "Y" }] });
  assert.throws(() => room.answerOption(q2.id, "9"), /Không có lựa chọn này/);
  const plain = workerMsg(room, "be", "không có nút");
  assert.throws(() => room.answerOption(plain.id, "1"), /không có lựa chọn/i);
  const sys = room.post("system", "x", { to: [], options: { question: "q", items: [{ id: "1", label: "a" }, { id: "2", label: "b" }] } });
  assert.throws(() => room.answerOption(sys.id, "1"), /Chỉ trả lời/, "a system message cannot be turned into a question for a worker");
});

test("ask_user: validates the options it is given", () => {
  const { room } = makeRoom(new Fake(() => "ok"));
  const ask = (options: { label: string }[], question = "Q?") => () => room.askUser("be", { question, options });
  assert.throws(ask([{ label: "a" }]), /2 đến 8/);
  assert.throws(ask(Array.from({ length: 9 }, (_, i) => ({ label: `o${i}` }))), /2 đến 8/);
  assert.throws(ask([{ label: "a" }, { label: "  " }]), /nhãn/);
  assert.throws(ask([{ label: "a" }, { label: "A" }]), /trùng/);
  assert.throws(ask([{ label: "a" }, { label: "b" }], "  "), /câu hỏi/);
  const m = room.askUser("be", { question: "Q\n\n  nhiều   dòng?", options: [{ label: "x".repeat(200) }, { label: "b\u0007c" }] });
  assert.equal(m.options!.question, "Q nhiều dòng?");
  assert.equal(m.options!.items[0].label.length, 80);
  assert.equal(m.options!.items[1].label, "b c");
});

test("ask_user over MCP: the tool is offered, a question is posted for the calling worker, and bad input is reported not thrown", async () => {
  const holder: { mcp?: AgentRoomMcp } = {};
  const { room } = makeRoom(new Fake(() => ""), { mcpUrl: (id) => holder.mcp!.urlFor(id) });
  const mcp = (holder.mcp = new AgentRoomMcp(room));
  await mcp.start();
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(mcp.urlFor("be"))));
  const ok = await client.callTool({ name: "ask_user", arguments: { question: "Chọn màu?", options: [{ label: "Đỏ" }, { label: "Xanh", description: "dịu mắt" }] } });
  assert.match((ok.content as { text: string }[])[0].text, /kết thúc lượt/);
  const m = lastTo(room);
  assert.deepEqual([m.from, m.options?.items.length, m.to], ["be", 2, []]);
  const dup = await client.callTool({ name: "ask_user", arguments: { question: "?", options: [{ label: "a" }, { label: "a" }] } });
  assert.match((dup.content as { text: string }[])[0].text, /trùng/);
  await client.close();
  mcp.dispose();
});

test("replies and options survive a restart: they are part of the stored chat", () => {
  const a = makeRoom(new Fake(() => "ok"));
  const q = a.room.askUser("be", { question: "Chọn?", options: [{ label: "A" }, { label: "B" }] });
  a.room.answerOption(q.id, "1");
  const stored = a.deps.store.loadMessages();
  const sq = stored.find((m) => m.id === q.id)!;
  assert.equal(sq.options!.items.length, 2);
  const ans = stored.find((m) => m.choice)!;
  assert.deepEqual([ans.replyTo, ans.choice!.option], [q.id, "1"]);
});
