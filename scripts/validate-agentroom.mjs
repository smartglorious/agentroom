// Kiểm tra .agentroom/workers.yaml theo đúng luật của AgentRoom v0.6.
// Cách chạy: node validate-agentroom.mjs <đường-dẫn-repo>
// Cần: npm i yaml croner (cài ở thư mục tạm, không cài vào repo).
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const YAML = require("yaml");
const { Cron } = require("croner");

const repo = process.argv[2] ?? ".";
const file = join(repo, ".agentroom", "workers.yaml");
const errors = [], warns = [];
if (!existsSync(file)) { console.error(`✗ Không có ${file}`); process.exit(1); }
const cfg = YAML.parse(readFileSync(file, "utf8")) ?? {};
const ID = /^[a-z][a-z0-9_-]*$/;
const isStr = (v) => typeof v === "string" && v.length > 0;
const isBool = (v) => typeof v === "boolean";
const strList = (v) => Array.isArray(v) && v.every((s) => typeof s === "string");

// ---- khóa cấp cao nhất ----
for (const k of Object.keys(cfg)) {
  if (["hosts", "accounts", "workers", "schedules", "webhooks"].includes(k)) continue;
  warns.push(/telegram|channel|bot/i.test(k)
    ? `Khóa "${k}" bị bỏ qua: Telegram được cấu hình trong cài đặt VS Code của người dùng (lệnh "AgentRoom: Telegram — thiết lập"), KHÔNG đặt token hay cấu hình bot trong file của repo`
    : `Khóa cấp cao nhất "${k}" không được dùng (bị bỏ qua)`);
}
if (/\d{6,}:[A-Za-z0-9_-]{30,}/.test(readFileSync(file, "utf8"))) errors.push("workers.yaml có chuỗi giống TOKEN BOT TELEGRAM — xoá ngay và tạo token mới ở @BotFather (/revoke); token không được nằm trong repo");

// ---- skills có sẵn (cùng thứ tự ưu tiên với extension) ----
const skillDirs = [join(repo, ".agentroom", "skills"), join(repo, ".claude", "skills"), join(homedir(), ".claude", "skills")];
const skills = new Set();
for (const dir of skillDirs) {
  if (!existsSync(dir)) continue;
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith("_") || entry.startsWith(".")) continue;
    const f = join(dir, entry, "SKILL.md");
    if (!existsSync(f) || !statSync(join(dir, entry)).isDirectory()) continue;
    const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(readFileSync(f, "utf8"));
    let meta = {};
    try { meta = m ? YAML.parse(m[1]) ?? {} : {}; } catch { /* bỏ qua */ }
    if (!isStr(meta.description)) { errors.push(`Skill ${join(dir, entry)}: thiếu description trong frontmatter`); continue; }
    const name = isStr(meta.name) ? meta.name : entry;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { errors.push(`Skill ${join(dir, entry)}: tên "${name}" không hợp lệ (a-z, 0-9, '-')`); continue; }
    skills.add(name);
  }
}

// ---- hosts (máy chạy worker qua SSH) ----
const SSH_TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:%+-]*$/;
const remotePath = (p) => p === "~" || p.startsWith("~/") || p.startsWith("/");
const hosts = cfg.hosts ?? {};
if (typeof hosts !== "object" || Array.isArray(hosts)) errors.push("hosts: phải là object {tên: {ssh, repo, …}}");
const hostKnown = new Set(["ssh", "port", "identityFile", "repo", "node", "claudePath", "codexPath", "connectTimeoutSec"]);
for (const [name, h] of Object.entries(typeof hosts === "object" && !Array.isArray(hosts) ? hosts : {})) {
  const at = `hosts.${name}`;
  if (!ID.test(name)) errors.push(`${at}: tên host phải bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 _ -`);
  if (name === "local") errors.push(`${at}: "local" là tên dành riêng`);
  if (!isStr(h?.ssh) || !SSH_TARGET.test(h.ssh)) errors.push(`${at}.ssh phải là user@host, host hoặc alias trong ~/.ssh/config (không được bắt đầu bằng '-', không có khoảng trắng)`);
  if (h?.port !== undefined && !(Number.isInteger(h.port) && h.port >= 1 && h.port <= 65535)) errors.push(`${at}.port phải là số nguyên 1–65535`);
  if (h?.identityFile !== undefined && (!isStr(h.identityFile) || h.identityFile.startsWith("-"))) errors.push(`${at}.identityFile không hợp lệ`);
  for (const k of ["repo", "node", "claudePath", "codexPath"]) if (h?.[k] !== undefined && !isStr(h[k])) errors.push(`${at}.${k} phải là chuỗi`);
  if (isStr(h?.repo) && !remotePath(h.repo)) errors.push(`${at}.repo phải là đường dẫn tuyệt đối hoặc bắt đầu bằng ~ (đây là đường dẫn TRÊN máy đó)`);
  if (h?.connectTimeoutSec !== undefined && !(Number.isInteger(h.connectTimeoutSec) && h.connectTimeoutSec >= 1 && h.connectTimeoutSec <= 120)) errors.push(`${at}.connectTimeoutSec phải là số nguyên 1–120`);
  for (const k of Object.keys(h ?? {})) if (!hostKnown.has(k)) warns.push(`${at}: trường "${k}" không được dùng (bị bỏ qua)`);
  if (!h?.repo) warns.push(`${at}: chưa có repo mặc định — mọi worker trên host này phải có workdir`);
  if (/(password|passwd|secret|token)/i.test(JSON.stringify(h ?? {}))) warns.push(`${at}: có vẻ chứa bí mật; SSH chỉ dùng khoá/ssh-agent, không đặt mật khẩu trong file`);
}

// ---- accounts ----
const accounts = cfg.accounts ?? {};
if (typeof accounts !== "object" || Array.isArray(accounts) || !Object.keys(accounts).length) errors.push("accounts: phải có ít nhất 1 account");
for (const [id, a] of Object.entries(accounts)) {
  if (!["claude", "codex"].includes(a?.provider)) errors.push(`accounts.${id}.provider phải là claude hoặc codex`);
  if (a?.maxConcurrent !== undefined && !(Number.isInteger(a.maxConcurrent) && a.maxConcurrent >= 1)) errors.push(`accounts.${id}.maxConcurrent phải là số nguyên ≥ 1`);
  if (a?.budgetUsdPerDay !== undefined && !(typeof a.budgetUsdPerDay === "number" && a.budgetUsdPerDay > 0)) errors.push(`accounts.${id}.budgetUsdPerDay phải là số > 0`);
  if (a?.warnAtPercent !== undefined && !(typeof a.warnAtPercent === "number" && a.warnAtPercent >= 1 && a.warnAtPercent <= 100)) errors.push(`accounts.${id}.warnAtPercent phải nằm trong 1–100`);
  if (a?.host !== undefined && !hosts?.[a.host]) errors.push(`accounts.${id}.host "${a.host}" không có trong hosts`);
  if (a?.host && a?.home) warns.push(`accounts.${id}: home là đường dẫn TRÊN máy "${a.host}"`);
  if (a?.provider === "claude" && (a?.maxConcurrent ?? 1) > 3) warns.push(`accounts.${id}: maxConcurrent > 3 dễ hết quota subscription`);
}

// ---- workers ----
const workers = Array.isArray(cfg.workers) ? cfg.workers : [];
if (!workers.length) errors.push("workers: phải có ít nhất 1 worker");
const ids = new Set();
const known = new Set(["id", "name", "role", "skills", "useSkills", "account", "model", "instructions", "allowedTools", "worktree", "coordinator", "sandbox", "workdir", "color", "autonomy"]);
const baseUsers = new Map();
for (const [i, w] of workers.entries()) {
  const at = `workers[${i}]${w?.id ? ` (${w.id})` : ""}`;
  if (!ID.test(w?.id ?? "")) errors.push(`${at}.id phải bắt đầu bằng chữ thường, chỉ gồm a-z 0-9 _ -`);
  if (ids.has(w?.id)) errors.push(`${at}: trùng id`);
  ids.add(w?.id);
  if (["all", "user", "system"].includes(w?.id)) errors.push(`${at}.id "${w.id}" là tên dành riêng`);
  for (const k of ["name", "role", "account"]) if (!isStr(w?.[k])) errors.push(`${at}.${k} bắt buộc (chuỗi)`);
  if (w?.account && !accounts[w.account]) errors.push(`${at}.account "${w.account}" không có trong accounts`);
  for (const k of ["skills", "useSkills", "allowedTools"]) if (w?.[k] !== undefined && !strList(w[k])) errors.push(`${at}.${k} phải là danh sách chuỗi`);
  for (const k of ["worktree", "coordinator"]) if (w?.[k] !== undefined && !isBool(w[k])) errors.push(`${at}.${k} phải là true/false`);
  if (w?.autonomy !== undefined && !["manual", "auto", "full"].includes(w.autonomy)) errors.push(`${at}.autonomy phải là manual, auto hoặc full`);
  if (w?.autonomy === "full") warns.push(`${at}: autonomy: full trong workers.yaml KHÔNG có hiệu lực (sẽ chạy Auto). Full Access chỉ do người dùng bật trên máy của mình`);
  if (w?.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(w.sandbox)) errors.push(`${at}.sandbox không hợp lệ`);
  for (const k of Object.keys(w ?? {})) if (!known.has(k)) warns.push(`${at}: trường "${k}" không được dùng (bị bỏ qua)`);
  for (const s of strList(w?.useSkills) ? w.useSkills : []) if (!skills.has(s)) errors.push(`${at}.useSkills "${s}" không tồn tại (tìm trong .agentroom/skills, .claude/skills, ~/.claude/skills)`);
  const provider = accounts[w?.account]?.provider;
  const tools = w?.allowedTools ?? [];
  if (provider === "claude" && tools.some((t) => /^(Edit|Write)$/.test(t)) && !w?.worktree) warns.push(`${at}: được Edit/Write toàn repo mà không có worktree`);
  if (provider === "claude" && tools.some((t) => t === "Bash")) warns.push(`${at}: "Bash" không giới hạn — nên dùng Bash(<lệnh>:*)`);
  if (provider === "codex" && w?.allowedTools) warns.push(`${at}: allowedTools không có tác dụng với Codex (dùng sandbox)`);
  if (provider === "codex" && w?.sandbox === "danger-full-access") warns.push(`${at}: sandbox danger-full-access — rủi ro cao`);
  if (provider === "codex" && (w?.useSkills ?? []).length) warns.push(`${at}: Codex không lọc được skill theo worker; skill chỉ được nhắc trong prompt (mức kiểm soát lỏng hơn Claude)`);
  if (w?.workdir !== undefined && !isStr(w.workdir)) errors.push(`${at}.workdir phải là chuỗi`);
  if (w?.color !== undefined && !(isStr(w.color) && /^#[0-9a-fA-F]{6}$/.test(w.color))) errors.push(`${at}.color phải có dạng #rrggbb`);
  const hostName = accounts[w?.account]?.host;
  if (hostName && hosts?.[hostName]) {
    const base = w?.workdir ?? hosts[hostName].repo;
    if (!base) errors.push(`${at}: chạy trên host "${hostName}" nên cần workdir (hoặc hosts.${hostName}.repo)`);
    else if (!remotePath(base)) errors.push(`${at}: đường dẫn trên host phải tuyệt đối hoặc bắt đầu bằng ~ (nhận "${base}")`);
    else {
      const key = `${hostName}:${base}`;
      baseUsers.set(key, [...(baseUsers.get(key) ?? []), { id: w.id, worktree: w.worktree === true, writes: tools.some((t) => /^(Edit|Write)/.test(t)) || provider === "codex" }]);
    }
    if (w?.worktree !== true && (tools.some((t) => /^(Edit|Write)/.test(t)) || provider === "codex")) warns.push(`${at}: ghi code trên host "${hostName}" mà không có worktree — thay đổi nằm thẳng trong clone đó`);
  } else if (isStr(w?.workdir)) {
    const p = w.workdir.startsWith("~") ? join(homedir(), w.workdir.slice(1)) : w.workdir.startsWith("/") || /^[A-Za-z]:/.test(w.workdir) ? w.workdir : join(repo, w.workdir);
    if (!existsSync(p)) warns.push(`${at}.workdir "${w.workdir}" chưa tồn tại trên máy này (${p})`);
  }
  const soul = join(repo, ".agentroom", "agents", w?.id ?? "?", "SOUL.md");
  if (existsSync(soul) && /Viết tính cách, cách làm việc/.test(readFileSync(soul, "utf8"))) warns.push(`${at}: SOUL.md vẫn là bản mẫu chưa viết (.agentroom/agents/${w.id}/SOUL.md)`);
}
for (const [key, users] of baseUsers) {
  const shared = users.filter((u) => !u.worktree && u.writes);
  if (shared.length > 1) warns.push(`Các worker ${shared.map((u) => u.id).join(", ")} cùng ghi vào ${key} mà không có worktree — sẽ ghi đè lên nhau`);
}
if (!workers.some((w) => w?.coordinator)) warns.push("Không có worker coordinator: tin nhắn không @mention sẽ không ai nhận");

// ---- schedules ----
const schedules = cfg.schedules ?? [];
if (!Array.isArray(schedules)) errors.push("schedules: phải là danh sách");
const schedIds = new Set();
for (const [i, s] of (Array.isArray(schedules) ? schedules : []).entries()) {
  const at = `schedules[${i}]${s?.id ? ` (${s.id})` : ""}`;
  if (!ID.test(s?.id ?? "")) errors.push(`${at}.id không hợp lệ`);
  if (schedIds.has(s?.id)) errors.push(`${at}: trùng id`);
  schedIds.add(s?.id);
  if (s?.worker !== "*" && !ids.has(s?.worker)) errors.push(`${at}.worker "${s?.worker}" không tồn tại (dùng "*" cho mọi worker)`);
  if (!isStr(s?.cron)) errors.push(`${at}.cron bắt buộc`);
  else {
    try { new Cron(s.cron, { paused: true, timezone: s.timezone }).nextRun(); }
    catch (e) { errors.push(`${at}: cron/timezone không hợp lệ (${e.message.split("\n")[0]})`); }
  }
  if (!s?.prompt === !s?.builtin) errors.push(`${at}: cần đúng một trong prompt hoặc builtin`);
  if (s?.builtin !== undefined && s.builtin !== "consolidate-memory") errors.push(`${at}.builtin chỉ nhận consolidate-memory`);
  if (s?.session !== undefined && !["fresh", "persistent"].includes(s.session)) errors.push(`${at}.session phải là fresh hoặc persistent`);
  for (const k of ["skipIfRunning", "notify", "enabled"]) if (s?.[k] !== undefined && !isBool(s[k])) errors.push(`${at}.${k} phải là true/false`);
  if (s?.catchUpHours !== undefined && !(typeof s.catchUpHours === "number" && s.catchUpHours >= 0)) errors.push(`${at}.catchUpHours phải là số ≥ 0`);
  if (s?.worker === "*" && !s?.builtin) warns.push(`${at}: prompt chạy cho MỌI worker — tốn quota; cân nhắc chọn một worker`);
}

// ---- webhooks ----
const webhooks = cfg.webhooks ?? [];
if (!Array.isArray(webhooks)) errors.push("webhooks: phải là danh sách");
const hookIds = new Set();
for (const [i, h] of (Array.isArray(webhooks) ? webhooks : []).entries()) {
  const at = `webhooks[${i}]${h?.id ? ` (${h.id})` : ""}`;
  if (!ID.test(h?.id ?? "")) errors.push(`${at}.id không hợp lệ`);
  if (hookIds.has(h?.id)) errors.push(`${at}: trùng id`);
  hookIds.add(h?.id);
  if (!ids.has(h?.worker)) errors.push(`${at}.worker "${h?.worker}" không tồn tại`);
  if (!isStr(h?.prompt)) errors.push(`${at}.prompt bắt buộc`);
  if (!h?.secretEnv && h?.allowUnsigned !== true) errors.push(`${at}: cần secretEnv (tên biến môi trường chứa HMAC secret) hoặc allowUnsigned: true chỉ để thử trên máy mình`);
  if (h?.secretEnv !== undefined && !isStr(h.secretEnv)) errors.push(`${at}.secretEnv phải là chuỗi`);
  if (h?.secretEnv && /^[A-Za-z0-9+/=_-]{20,}$/.test(h.secretEnv) && !/^[A-Z][A-Z0-9_]*$/.test(h.secretEnv)) errors.push(`${at}.secretEnv trông như một giá trị bí mật; chỉ ghi TÊN biến môi trường`);
  if (h?.match !== undefined && (typeof h.match !== "object" || Array.isArray(h.match))) errors.push(`${at}.match phải là object {đường.dẫn: giá-trị}`);
  if (h?.maxPerHour !== undefined && !(Number.isInteger(h.maxPerHour) && h.maxPerHour >= 1)) errors.push(`${at}.maxPerHour phải là số nguyên ≥ 1`);
  if (h?.allowUnsigned === true) warns.push(`${at}: allowUnsigned — chỉ dùng thử trên máy mình, đừng mở tunnel`);
  if (h?.readOnly !== true) warns.push(`${at}: readOnly chưa bật — dữ liệu từ bên ngoài sẽ chạy trong worker có quyền ghi; nên đặt readOnly: true`);
  const tw = workers.find((w) => w?.id === h?.worker);
  if (tw?.coordinator !== true && h?.readOnly !== true) warns.push(`${at}: gọi worker không phải coordinator với quyền ghi`);
  if (h?.readOnly !== true && tw?.autonomy === "auto") warns.push(`${at}: worker "${tw.id}" chạy Auto và webhook không readOnly: dữ liệu bên ngoài có thể điều khiển nó mà không qua thẻ duyệt`);
}

// ---- file phụ trợ ----
const gi = join(repo, ".agentroom", ".gitignore");
const giText = existsSync(gi) ? readFileSync(gi, "utf8") : "";
if (!/state\//.test(giText) || !/worktrees\//.test(giText)) errors.push(".agentroom/.gitignore phải chứa state/ và worktrees/");
if (!/\.plugin\//.test(giText)) warns.push(".agentroom/.gitignore nên chứa .plugin/ (plugin skills tự sinh)");
if (!/journal/.test(giText)) warns.push(".agentroom/.gitignore nên chứa agents/*/journal/ (nhật ký hằng ngày)");
if (!existsSync(join(repo, "CLAUDE.md")) && workers.some((w) => accounts[w?.account]?.provider === "claude")) warns.push("Thiếu CLAUDE.md");
if (!existsSync(join(repo, "AGENTS.md")) && workers.some((w) => accounts[w?.account]?.provider === "codex")) warns.push("Thiếu AGENTS.md");

warns.forEach((m) => console.log("⚠", m));
errors.forEach((m) => console.log("✗", m));
console.log(errors.length ? `\nKHÔNG ĐẠT: ${errors.length} lỗi, ${warns.length} cảnh báo` : `\nĐẠT (${workers.length} worker, ${Object.keys(hosts).length} máy từ xa, ${schedIds.size} lịch, ${hookIds.size} webhook, ${warns.length} cảnh báo)`);
process.exit(errors.length ? 1 : 0);
