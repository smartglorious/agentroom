// Measures the fixed per-session token prefix for different tool / prompt configurations (docs/PLAN-v0.8-tokens.md §1.1).
// One real one-turn call per row ("Say OK."), model haiku: costs a few cents. Run: node scripts/measure-prefix.mjs
import { query } from "@anthropic-ai/claude-agent-sdk";
import { tmpdir } from "node:os";

const base = { cwd: tmpdir(), model: "haiku", settingSources: [], maxTurns: 1 };
const persona = "Bạn là Minh, backend dev trong group chat. Trả lời ngắn.";
const pre = { type: "preset", preset: "claude_code", append: persona };
const rows = [
  ["preset, default tools (today)", { systemPrompt: pre }],
  ["preset, tools Read,Grep,Glob", { systemPrompt: pre, tools: ["Read", "Grep", "Glob"] }],
  ["preset, tools Read,Grep,Glob,Edit,Write,Bash", { systemPrompt: pre, tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"] }],
  ["preset, core6 + WebFetch,WebSearch", { systemPrompt: pre, tools: ["Read", "Grep", "Glob", "Edit", "Write", "Bash", "WebFetch", "WebSearch"] }],
  ["preset, tools []", { systemPrompt: pre, tools: [] }],
  ["custom prompt, tools Read,Grep,Glob", { systemPrompt: persona, tools: ["Read", "Grep", "Glob"] }],
  ["custom prompt, tools []", { systemPrompt: persona, tools: [] }],
];
for (const [name, options] of rows) {
  let u;
  for await (const m of query({ prompt: "Say OK.", options: { ...base, ...options } })) if (m.type === "result") u = m.usage;
  const total = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  console.log(name.padEnd(52), String(total).padStart(6), "input tokens");
}
process.exit(0);
