import { test } from "node:test";
import assert from "node:assert/strict";
import { CORE_TOOLS, claudeToolSet } from "../src/adapters/types";
import { buildClaudeOptions } from "../src/adapters/claude";
import { parseConfig } from "../src/core/config";

const w = (over: object = {}) => ({ allowedTools: ["Read", "Grep", "Glob"], useSkills: [] as string[], ...over });

test("tools: by default the core coding set plus whatever allowedTools names (scopes stripped, MCP ignored)", () => {
  assert.deepEqual(claudeToolSet(w()), CORE_TOOLS);
  assert.deepEqual(claudeToolSet(w({ allowedTools: ["Read", "Edit(apps/api/**)", "WebFetch", "mcp__x__y", "Bash(npm test)"] })), [...CORE_TOOLS, "WebFetch"]);
  assert.ok(!claudeToolSet(w()).includes("WebSearch"), "web tools are opt-in");
  assert.ok(!claudeToolSet(w()).includes("Agent"), "subagents are opt-in");
});

test("tools: an explicit `tools:` list is exactly what loads; read-only turns are always Read/Grep/Glob; skills add Skill", () => {
  assert.deepEqual(claudeToolSet(w({ tools: ["Read", "Grep"] })), ["Read", "Grep"]);
  assert.deepEqual(claudeToolSet(w({ tools: [] })), [], "an empty list is allowed: a pure chat worker");
  assert.deepEqual(claudeToolSet(w({ tools: ["Read", "Edit", "Write", "Bash"] }), true), ["Read", "Grep", "Glob"], "an untrusted trigger never gets more, whatever tools: says");
  assert.deepEqual(claudeToolSet(w({ tools: ["Read"], useSkills: ["x"] })), ["Read", "Skill"]);
  assert.deepEqual(claudeToolSet(w({ useSkills: ["x"] })), [...CORE_TOOLS, "Skill"]);
  assert.deepEqual(claudeToolSet(w({ useSkills: ["x"] }), true), ["Read", "Grep", "Glob", "Skill"]);
});

test("tools: the SDK is handed `tools`, so unlisted tool definitions are not loaded", () => {
  const cfg = parseConfig(`accounts: { c: { provider: claude } }
workers:
  - { id: lead, name: L, role: r, account: c, coordinator: true, tools: [Read, Grep, Glob], allowedTools: [Read, Grep, Glob] }
  - { id: be, name: B, role: r, account: c }
`);
  const account = cfg.accounts[0];
  const base = { cwd: "/w", systemAppend: "S", mcpUrl: "http://x", account, approve: async () => true };
  const lead = buildClaudeOptions({ ...base, worker: cfg.workers[0] }, undefined, new AbortController());
  const be = buildClaudeOptions({ ...base, worker: cfg.workers[1] }, undefined, new AbortController());
  const ro = buildClaudeOptions({ ...base, worker: cfg.workers[1], readOnly: true }, undefined, new AbortController());
  assert.deepEqual(lead.tools, ["Read", "Grep", "Glob"]);
  assert.deepEqual(be.tools, CORE_TOOLS);
  assert.deepEqual(ro.tools, ["Read", "Grep", "Glob"]);
  assert.ok(lead.allowedTools!.includes("mcp__agentroom"), "the room's own tools are untouched by the built-in list");
});

test("tools: config accepts a list of names and keeps it unset otherwise", () => {
  const c = parseConfig(`accounts: { c: { provider: claude } }
workers:
  - { id: a, name: A, role: r, account: c, tools: [Read, WebFetch] }
  - { id: b, name: B, role: r, account: c }
`);
  assert.deepEqual(c.workers[0].tools, ["Read", "WebFetch"]);
  assert.equal(c.workers[1].tools, undefined);
  assert.throws(() => parseConfig(`accounts: { c: { provider: claude } }\nworkers:\n  - { id: a, name: A, role: r, account: c, tools: [""] }\n`));
});

test("claude options: only the room's MCP server is used (no claude.ai connectors) unless AGENTROOM_KEEP_CONNECTORS=1", () => {
  const cfg = parseConfig(`accounts: { c: { provider: claude } }\nworkers:\n  - { id: be, name: B, role: r, account: c }\n`);
  const base = { cwd: "/w", systemAppend: "S", mcpUrl: "http://x", account: cfg.accounts[0], approve: async () => true };
  const mk = () => buildClaudeOptions({ ...base, worker: cfg.workers[0] }, undefined, new AbortController()) as unknown as Record<string, unknown>;
  const save = process.env.AGENTROOM_KEEP_CONNECTORS;
  try {
    delete process.env.AGENTROOM_KEEP_CONNECTORS;
    const o = mk();
    assert.equal(o.strictMcpConfig, true);
    assert.deepEqual(o.settings, { disableClaudeAiConnectors: true });
    assert.deepEqual(Object.keys(o.mcpServers as object), ["agentroom"]);
    process.env.AGENTROOM_KEEP_CONNECTORS = "1";
    const k = mk();
    assert.equal(k.strictMcpConfig, undefined);
    assert.equal(k.settings, undefined);
  } finally { if (save === undefined) delete process.env.AGENTROOM_KEEP_CONNECTORS; else process.env.AGENTROOM_KEEP_CONNECTORS = save; }
});
