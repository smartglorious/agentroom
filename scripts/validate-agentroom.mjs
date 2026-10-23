// Kiểm tra .agentroom/workers.yaml theo đúng luật của AgentRoom v0.1.
// Cách chạy: node validate-agentroom.mjs <đường-dẫn-repo>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const YAML = require("yaml");

const repo = process.argv[2] ?? ".";
const file = join(repo, ".agentroom", "workers.yaml");
const errors = [], warns = [];
if (!existsSync(file)) { console.error(`✗ Không có ${file}`); process.exit(1); }
const cfg = YAML.parse(readFileSync(file, "utf8")) ?? {};

const accounts = cfg.accounts ?? {};
if (typeof accounts !== "object" || !Object.keys(accounts).length) errors.push("accounts: phải có ít nhất 1 account");
for (const [id, a] of Object.entries(accounts)) {
  if (!["claude", "codex"].includes(a?.provider)) errors.push(`accounts.${id}.provider phải là claude hoặc codex`);
  if (a?.maxConcurrent !== undefined && !(Number.isInteger(a.maxConcurrent) && a.maxConcurrent >= 1)) errors.push(`accounts.${id}.maxConcurrent phải là số nguyên ≥ 1`);
  if (a?.provider === "claude" && (a?.maxConcurrent ?? 1) > 3) warns.push(`accounts.${id}: maxConcurrent > 3 dễ hết quota subscription`);
}

const workers = Array.isArray(cfg.workers) ? cfg.workers : [];
if (!workers.length) errors.push("workers: phải có ít nhất 1 worker");
const ids = new Set();
const known = new Set(["id", "name", "role", "skills", "account", "model", "instructions", "allowedTools", "worktree", "coordinator", "sandbox"]);
for (const [i, w] of workers.entries()) {
  const at = `workers[${i}]${w?.id ? ` (${w.id})` : ""}`;
  if (!/^[a-z][a-z0-9_-]*$/.test(w?.id ?? "")) errors.push(`${at}.id phải bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 _ -`);
  if (ids.has(w?.id)) errors.push(`${at}: trùng id`);
  ids.add(w?.id);
  if (w?.id === "all" || w?.id === "user" || w?.id === "system") errors.push(`${at}.id "${w.id}" là tên dành riêng`);
  for (const k of ["name", "role", "account"]) if (typeof w?.[k] !== "string" || !w[k]) errors.push(`${at}.${k} bắt buộc (chuỗi)`);
  if (w?.account && !accounts[w.account]) errors.push(`${at}.account "${w.account}" không có trong accounts`);
  for (const k of ["skills", "allowedTools"]) if (w?.[k] !== undefined && !(Array.isArray(w[k]) && w[k].every((s) => typeof s === "string"))) errors.push(`${at}.${k} phải là danh sách chuỗi`);
  for (const k of ["worktree", "coordinator"]) if (w?.[k] !== undefined && typeof w[k] !== "boolean") errors.push(`${at}.${k} phải là true/false`);
  if (w?.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(w.sandbox)) errors.push(`${at}.sandbox không hợp lệ`);
  for (const k of Object.keys(w ?? {})) if (!known.has(k)) warns.push(`${at}: trường "${k}" không được dùng (bị bỏ qua)`);
  const provider = accounts[w?.account]?.provider;
  const tools = w?.allowedTools ?? [];
  if (provider === "claude" && tools.some((t) => /^(Edit|Write)$/.test(t)) && !w?.worktree) warns.push(`${at}: được Edit/Write toàn repo mà không có worktree`);
  if (provider === "claude" && tools.some((t) => t === "Bash")) warns.push(`${at}: "Bash" không giới hạn — nên dùng Bash(<lệnh>:*)`);
  if (provider === "codex" && w?.allowedTools) warns.push(`${at}: allowedTools không có tác dụng với Codex (dùng sandbox)`);
  if (provider === "codex" && w?.sandbox === "danger-full-access") warns.push(`${at}: sandbox danger-full-access — rủi ro cao`);
}
if (!workers.some((w) => w?.coordinator)) warns.push("Không có worker coordinator: tin nhắn không @mention sẽ không ai nhận");

const gi = join(repo, ".agentroom", ".gitignore");
if (!existsSync(gi) || !/worktrees/.test(readFileSync(gi, "utf8")) || !/state/.test(readFileSync(gi, "utf8"))) errors.push(".agentroom/.gitignore phải chứa state/ và worktrees/");
if (!existsSync(join(repo, "CLAUDE.md")) && workers.some((w) => accounts[w?.account]?.provider === "claude")) warns.push("Thiếu CLAUDE.md");
if (!existsSync(join(repo, "AGENTS.md")) && workers.some((w) => accounts[w?.account]?.provider === "codex")) warns.push("Thiếu AGENTS.md");

warns.forEach((m) => console.log("⚠", m));
errors.forEach((m) => console.log("✗", m));
console.log(errors.length ? `\nKHÔNG ĐẠT: ${errors.length} lỗi, ${warns.length} cảnh báo` : `\nĐẠT (${workers.length} worker, ${warns.length} cảnh báo)`);
process.exit(errors.length ? 1 : 0);
