import { posix, win32 } from "node:path";

/**
 * How much a worker may do without asking.
 *  manual: every tool call that is not pre-approved in allowedTools goes to the human (the original behaviour).
 *  auto:   a fixed policy decides. Safe work inside the worker's own folder runs; anything touching the system,
 *          deleting files, escalating privileges or leaving the folder is refused; anything the policy does not
 *          recognise goes to the human. It never guesses "allow".
 *  full:   nothing is asked, except a short list of catastrophic actions (see `catastrophic`) which still go to the human.
 */
export type Autonomy = "manual" | "auto" | "full";
export const AUTONOMY_MODES: Autonomy[] = ["manual", "auto", "full"];
export const isAutonomy = (v: unknown): v is Autonomy => typeof v === "string" && (AUTONOMY_MODES as string[]).includes(v);

export type Verdict =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason?: string; /** absolute paths of self-written scripts this question is about; once a human approves, they stop being asked */ authored?: string[] };

const allow = (): Verdict => ({ kind: "allow" });
const deny = (reason: string): Verdict => ({ kind: "deny", reason });
const ask = (reason?: string): Verdict => ({ kind: "ask", reason });

export interface PolicyContext {
  /** The folder the worker runs in (on its own machine). Unknown or unexpanded (`~/…`) means file access is always asked. */
  cwd?: string;
  /** Home directory on the worker's machine, when known. */
  home?: string;
  /**
   * True for an absolute path this worker created or edited during the session. Running such a file (or the
   * build file a package manager would run) is asked even in `auto`, because the policy cannot see inside scripts
   * and "write a script, then run it" is the easiest way around a command filter.
   */
  written?: (absPath: string) => boolean;
}

// ------------------------------------------------------------------ paths

const SYSTEM_DIRS = ["/etc", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/boot", "/dev", "/proc", "/sys", "/var", "/root", "/opt", "/srv", "/mnt", "/media", "/run", "/snap", "/System", "/Library", "/Applications", "/private", "/Volumes"];
const SYSTEM_WIN = /^[a-z]:[\\/](windows|program files|program files \(x86\)|programdata|users[\\/][^\\/]+[\\/]appdata)/i;
const HOME_SECRET_DIRS = [".ssh", ".aws", ".gnupg", ".kube", ".docker", ".config", ".azure", ".gcloud", ".npm", ".claude", ".codex", ".agentroom"];
const HOME_RC = /^\.(bashrc|bash_profile|bash_login|zshrc|zprofile|profile|zshenv|netrc|npmrc|pypirc|gitconfig|git-credentials)$/;
const SENSITIVE_SEGMENT = /^(\.git|\.github|\.agentroom|\.claude|\.ssh|\.husky|\.vscode|\.aws|\.gnupg|\.kube)$/i;
const SENSITIVE_FILE = /^(\.env(\..*)?|\.npmrc|\.pypirc|\.netrc|\.bashrc|\.zshrc|\.profile|id_(rsa|ed25519|ecdsa)|.*\.(pem|key|p12|pfx)|credentials(\.json)?|authorized_keys)$/i;
/** `.env.example` and friends carry no secrets. */
const SAFE_ENV = /^\.env\.(example|sample|template|defaults?)$/i;

export type PathClass = "inside" | "sensitive" | "system" | "outside" | "unknown";

const isWin = (p: string) => /^[a-z]:[\\/]/i.test(p) || p.startsWith("\\\\");

/** Resolves `p` against `cwd` without touching the disk. Returns undefined when the text cannot be resolved statically. */
function resolveIn(p: string, cwd: string, home?: string): string | undefined {
  if (/[$`]|%[A-Za-z_]+%/.test(p)) return undefined;
  const lib = isWin(cwd) ? win32 : posix;
  let q = p;
  if (q === "~" || q.startsWith("~/") || q.startsWith("~\\")) {
    if (!home) return undefined;
    q = lib.join(home, q.slice(1));
  } else if (q.startsWith("~")) return undefined;
  return lib.isAbsolute(q) ? lib.normalize(q) : lib.resolve(cwd, q);
}

/** Absolute form of `p` for `written`-style bookkeeping; undefined when it cannot be resolved statically. */
export function absolutePath(p: string, ctx: PolicyContext): string | undefined {
  const cwd = ctx.cwd;
  if (!cwd || cwd.startsWith("~") || !(posix.isAbsolute(cwd) || isWin(cwd))) return posix.isAbsolute(p) || isWin(p) ? posix.normalize(p) : undefined;
  return resolveIn(p, cwd, ctx.home);
}

export function classifyPath(p: string, ctx: PolicyContext): PathClass {
  if (!p) return "unknown";
  if (new RegExp(`^~[\\\\/](\\.(${HOME_SECRET_DIRS.map((d) => d.slice(1)).join("|")})(?:[\\\\/]|$)|\\.(bashrc|bash_profile|zshrc|zprofile|profile|netrc|npmrc|gitconfig|git-credentials)$)`).test(p)) return "system";
  const sensitive = (parts: string[]) =>
    parts.slice(0, -1).some((s) => SENSITIVE_SEGMENT.test(s)) || SENSITIVE_SEGMENT.test(parts[parts.length - 1] ?? "") || ((SENSITIVE_FILE.test(parts[parts.length - 1] ?? "") && !SAFE_ENV.test(parts[parts.length - 1] ?? "")));
  const cwd = ctx.cwd;
  const known = cwd && !cwd.startsWith("~") && (posix.isAbsolute(cwd) || isWin(cwd)) ? cwd : undefined;
  const abs = known ? resolveIn(p, known, ctx.home) : (posix.isAbsolute(p) || isWin(p) ? posix.normalize(p) : undefined);
  if (!abs) return "unknown";
  const lib = isWin(abs) ? win32 : posix;
  const norm = isWin(abs) ? abs.replace(/\//g, "\\") : abs;
  // system locations first: they win even if the worker's folder happens to be below one
  const sys = isWin(abs)
    ? SYSTEM_WIN.test(norm)
    : SYSTEM_DIRS.some((d) => norm === d || norm.startsWith(d + "/")) && !(known && (norm === known || norm.startsWith(known.replace(/\/$/, "") + "/")));
  if (sys) return "system";
  const home = ctx.home;
  if (home && !isWin(abs)) {
    const rel = posix.relative(home, norm);
    if (!rel.startsWith("..") && !posix.isAbsolute(rel)) {
      const first = rel.split("/")[0];
      const insideCwd = known && (norm === known || norm.startsWith(known.replace(/\/$/, "") + "/"));
      if (!insideCwd && (HOME_SECRET_DIRS.includes(first) || HOME_RC.test(first))) return "system";
    }
  }
  if (!known) return "unknown";
  const rel = lib.relative(known, abs);
  if (rel === "" ) return "inside";
  if (rel.startsWith("..") || lib.isAbsolute(rel)) return "outside";
  return sensitive(rel.split(/[\\/]/)) ? "sensitive" : "inside";
}

// ------------------------------------------------------------------ shell analysis

/** Splits a command line into simple commands and their words. Returns undefined when the text cannot be analysed safely. */
export function splitShell(cmd: string): { words: string[]; redirects: string[]; sep: string }[] | undefined {
  const out: { words: string[]; redirects: string[]; sep: string }[] = [];
  let words: string[] = [], redirects: string[] = [], cur = "", has = false, i = 0, quote: "'" | '"' | "" = "";
  const pushWord = () => { if (has) words.push(cur); cur = ""; has = false; };
  const pushCmd = (sep: string) => { pushWord(); if (words.length || redirects.length || sep) out.push({ words, redirects, sep }); words = []; redirects = []; };
  let redirectNext = false;
  const flushWord = () => { if (!has) return; if (redirectNext) { redirects.push(cur); redirectNext = false; cur = ""; has = false; } else pushWord(); };
  while (i < cmd.length) {
    const c = cmd[i];
    if (quote === "'") { if (c === "'") quote = ""; else cur += c; i++; continue; }
    if (quote === '"') {
      if (c === '"') quote = "";
      else if (c === "\\" && i + 1 < cmd.length) { cur += cmd[i + 1]; i++; }
      else if (c === "`" || (c === "$" && cmd[i + 1] === "(")) return undefined;
      else cur += c;
      i++; continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; i++; continue; }
    if (c === "\\") { if (cmd[i + 1] === "\n") { i += 2; continue; } cur += cmd[i + 1] ?? ""; has = true; i += 2; continue; }
    if (c === "`" || (c === "$" && cmd[i + 1] === "(") || ((c === "<" || c === ">") && cmd[i + 1] === "(")) return undefined;
    if (c === "#" && !has && (i === 0 || /\s/.test(cmd[i - 1]))) { while (i < cmd.length && cmd[i] !== "\n") i++; continue; }
    if (c === "\n" || c === ";") { flushWord(); pushCmd(";"); i++; continue; }
    if (c === "&" && cmd[i + 1] === "&") { flushWord(); pushCmd("&&"); i += 2; continue; }
    if (c === "|" && cmd[i + 1] === "|") { flushWord(); pushCmd("||"); i += 2; continue; }
    if (c === "|") { flushWord(); pushCmd("|"); i += cmd[i + 1] === "&" ? 2 : 1; continue; }
    if (c === "&") { flushWord(); pushCmd("&"); i++; continue; }
    if (c === "<" && cmd[i + 1] === "<") return undefined;          // here-documents hide arbitrary text
    if (c === ">" || c === "<") {
      // redirection: "2>&1", ">file", ">>file", "<file", "&>file"
      let j = i + 1;
      if (cmd[j] === ">") j++;
      if (cmd[j] === "&") { // fd duplication like 2>&1: no file involved
        j++;
        while (/\d|-/.test(cmd[j] ?? "")) j++;
        if (has && /^\d+$/.test(cur)) { cur = ""; has = false; }
        i = j; continue;
      }
      if (has && /^\d+$/.test(cur)) { cur = ""; has = false; } else flushWord();
      redirectNext = c === ">";
      if (c === "<") redirectNext = false;
      i = j;
      if (c === "<") { // input redirection: read the next word as a file to read
        while (/\s/.test(cmd[i] ?? "")) i++;
        let f = "";
        while (i < cmd.length && !/[\s;&|<>]/.test(cmd[i])) f += cmd[i++];
        words.push(f);
      }
      continue;
    }
    if (/\s/.test(c)) { flushWord(); i++; continue; }
    cur += c; has = true; i++;
  }
  if (quote) return undefined;
  flushWord();
  if (redirectNext) return undefined;
  pushCmd("");
  return out.filter((c) => c.words.length || c.redirects.length);
}

const WRAPPERS = new Set(["env", "command", "nohup", "time", "nice", "ionice", "stdbuf", "timeout", "builtin"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "ruby", "perl", "php", "lua", "Rscript"]);

const DENY_PRIV = new Set(["sudo", "su", "doas", "pkexec", "runuser", "chroot", "nsenter", "setcap"]);
const DENY_DELETE = new Set(["rm", "rmdir", "unlink", "shred", "trash", "trash-put", "srm", "wipe"]);
const DENY_SYSTEM = new Set(["dd", "fdisk", "parted", "gdisk", "mkfs", "mkswap", "swapon", "swapoff", "mount", "umount", "losetup", "cryptsetup", "lvm", "shutdown", "reboot", "halt", "poweroff", "init", "telinit", "systemctl", "service", "initctl", "iptables", "ip6tables", "nft", "ufw", "firewall-cmd", "useradd", "userdel", "usermod", "groupadd", "groupdel", "passwd", "chpasswd", "visudo", "crontab", "at", "batch", "modprobe", "insmod", "rmmod", "sysctl", "grub-install", "update-grub", "ldconfig", "visudo", "hostnamectl", "timedatectl", "loginctl", "setenforce"]);
const DENY_PKG = new Set(["apt", "apt-get", "aptitude", "dpkg", "yum", "dnf", "rpm", "pacman", "zypper", "apk", "brew", "snap", "flatpak", "nix-env", "port", "choco", "winget", "scoop"]);
const DENY_NET = new Set(["scp", "sftp", "nc", "ncat", "netcat", "socat", "telnet", "ftp", "tftp", "nmap", "tcpdump"]);
/** Programs that read their path arguments and never write them. */
const READERS = new Set(["ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "ag", "tree", "stat", "file", "du", "df", "diff", "cmp", "sort", "uniq", "cut", "tr", "jq", "yq", "realpath", "readlink", "basename", "dirname", "md5sum", "sha1sum", "sha256sum", "nl", "column", "less", "more", "bat", "hexdump", "xxd", "od", "strings", "comm", "paste", "fold", "rev", "tac", "expand", "unexpand", "ls-files"]);
/** Harmless, no (or no interesting) path arguments. */
const SIMPLE = new Set(["pwd", "echo", "printf", "true", "false", "test", "[", "which", "type", "date", "uname", "whoami", "hostname", "nproc", "sleep", "seq", "cd", "pushd", "popd", "wait", "set", "unset", "export", "read", "clear", "yes", "tput", "locale", "arch", "id", "groups", "uptime", "free", "lscpu"]);
const WRITERS_INSIDE = new Set(["mkdir", "touch", "cp", "mv", "ln"]);
const BUILD_TOOLS = new Set(["make", "cmake", "ninja", "tsc", "eslint", "prettier", "jest", "vitest", "mocha", "pytest", "ruff", "mypy", "black", "flake8", "isort", "pylint", "rustfmt", "gofmt", "goimports", "gradle", "gradlew", "mvn", "mvnw", "dotnet", "swift", "bazel", "esbuild", "vite", "webpack", "rollup", "turbo", "nx", "sbt", "rake", "bundle", "composer", "phpunit", "tox", "nox", "playwright", "cypress"]);

const DENY_ALL = new Set([...DENY_PRIV, ...DENY_DELETE, ...DENY_SYSTEM, ...DENY_PKG, ...DENY_NET]);

export interface BashVerdict { verdict: Verdict; catastrophic?: string }

const argsOf = (w: string[]) => w.slice(1);
const flagsOf = (w: string[]) => argsOf(w).filter((a) => a.startsWith("-"));
const nonFlags = (w: string[]) => argsOf(w).filter((a) => !a.startsWith("-"));
const hasFlag = (w: string[], ...names: string[]) => argsOf(w).some((a) => names.includes(a) || names.some((n) => n.length > 2 && a.startsWith(n + "=")) || (/^-[a-zA-Z]+$/.test(a) && names.some((n) => /^-[a-zA-Z]$/.test(n) && a.slice(1).includes(n[1]))));

/** Root-ish targets for `rm -rf` and friends: never run without a human, in any mode. */
const CRITICAL = /^(\/|\/\*|~|~\/|~\/\*|\$HOME|\$\{HOME\}|\.|\.\/|\.\.|\*|\/(bin|boot|dev|etc|home|lib|lib64|opt|proc|root|sbin|srv|sys|usr|var)(\/\*?)?)$/;

const KEYWORDS = new Set(["{", "}", "(", ")", "!", "if", "then", "else", "elif", "fi", "do", "done", "while", "until", "esac", "time"]);
/** System locations whose binaries are the normal way to run a standard tool. */
const BIN_DIRS = /^(\/usr\/bin|\/bin|\/usr\/local\/bin|\/opt\/homebrew\/bin|\/usr\/sbin|\/sbin)\//;

function programOf(words: string[], ctx: PolicyContext): { prog: string; words: string[]; pathIssue?: Verdict } | undefined {
  let w = words;
  for (let guard = 0; guard < 8 && w.length; guard++) {
    while (w.length && (KEYWORDS.has(w[0]) || /^[({]+$/.test(w[0]))) w = w.slice(1);
    if (w.length && /^[({]+[^({]/.test(w[0])) w = [w[0].replace(/^[({]+/, ""), ...w.slice(1)];
    if (w.length && w[0].endsWith(")") && w[0].length > 1 && !w[0].includes("(")) w = [w[0].replace(/\)+$/, ""), ...w.slice(1)];
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) w = w.slice(1);        // VAR=value cmd
    if (!w.length) return undefined;
    if (w[0] === "for" || w[0] === "case" || w[0] === "select") return undefined;      // loop headers run nothing themselves
    const base = posix.basename(w[0].replace(/\\/g, "/"));
    if (!WRAPPERS.has(base)) {
      let pathIssue: Verdict | undefined;
      if (/[\\/]/.test(w[0])) {
        const k = classifyPath(w[0], ctx);
        const std = BIN_DIRS.test(w[0].replace(/\\/g, "/"));
        if (!std && k !== "inside") pathIssue = k === "system" ? deny(`Không chạy chương trình ở vị trí hệ thống: ${w[0]}`) : ask(`Chạy chương trình ngoài thư mục làm việc: ${w[0]}`);
      }
      return { prog: base, words: [w[0], ...w.slice(1)], pathIssue };
    }
    let rest = w.slice(1);
    // wrappers take options (some with a value) and for timeout a duration before the real command
    while (rest.length) {
      const r = rest[0];
      if (r.startsWith("-")) {
        const takesValue = /^-(n|c|s|k|o|e|i|p|u|g)$/.test(r) && !/=/.test(r) && rest[1] !== undefined && /^[-+]?\d+$|^[A-Z0-9]+$|^[IOE]?[LB0-9]+$/.test(rest[1]);
        rest = rest.slice(takesValue ? 2 : 1);
      } else if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(r) || (base === "timeout" && /^\d+(\.\d+)?[smhd]?$/.test(r))) rest = rest.slice(1);
      else break;
    }
    if (!rest.length) return base === "env" ? { prog: "env", words: [w[0]] } : undefined;   // a bare `env` prints the environment
    w = rest;
  }
  return undefined;
}

/**
 * Judges one shell command line for `auto` (and for the catastrophic list of `full`).
 * `strict` = auto: unknown programs are asked, deletes/system/privilege are denied.
 */
export function analyzeBash(command: string, ctx: PolicyContext, depth = 0): BashVerdict {
  if (command.length > 4000 || command.includes("\0")) return { verdict: ask("Lệnh quá dài hoặc có ký tự lạ nên không phân tích được") };
  const cmds = splitShell(command);
  if (!cmds) return { verdict: ask("Lệnh dùng cú pháp shell phức tạp ($(…), `…`, here-doc) nên không phân tích được") };
  if (!cmds.length) return { verdict: allow() };

  let result: Verdict = allow();
  let catastrophic: string | undefined;
  const worse = (v: Verdict) => { if (rank(v) > rank(result)) result = v; };
  const rank = (v: Verdict) => (v.kind === "allow" ? 0 : v.kind === "ask" ? 1 : 2);
  let virtualCwd = ctx.cwd;
  const here = () => ({ ...ctx, cwd: virtualCwd });
  const authoredPaths: string[] = [];
  const authored = (f: string) => { const a = absolutePath(f, here()); if (a && ctx.written?.(a)) { authoredPaths.push(a); return true; } return false; };
  const buildFileEdited = (...names: string[]) => names.some((n) => authored(n));
  const pipeTargets: boolean[] = cmds.map((c, i) => i > 0 && cmds[i - 1].sep === "|");

  cmds.forEach((c, idx) => {
    for (const r of c.redirects) {
      if (r === "/dev/null") continue;
      const k = classifyPath(r, here());
      if (k === "system") { worse(deny(`Ghi (chuyển hướng) vào vị trí hệ thống: ${r}`)); catastrophic ??= /^\/dev\/(sd|nvme|hd|disk)/.test(r) ? `ghi thẳng vào thiết bị ${r}` : undefined; }
      else if (k !== "inside") worse(ask(`Chuyển hướng ghi ra ngoài thư mục làm việc hoặc vào file nhạy cảm: ${r}`));
    }
    const p = programOf(c.words, here());
    if (!p) return;
    const { words } = p;
    const prog = p.prog.toLowerCase() === p.prog ? p.prog : (DENY_ALL.has(p.prog.toLowerCase()) ? p.prog.toLowerCase() : p.prog);
    if (p.pathIssue) worse(p.pathIssue);
    const args = argsOf(words), flags = flagsOf(words), pos = nonFlags(words);

    // ---- privilege, deletion, system
    if (DENY_PRIV.has(prog)) { worse(deny(`Không được nâng quyền (${prog})`)); catastrophic ??= `nâng quyền bằng ${prog}`; return; }
    if (DENY_DELETE.has(prog)) {
      worse(deny(`Không được xóa file (${prog})`));
      if (prog === "rm" && hasFlag(words, "-r", "-R", "--recursive", "-f", "--force") && pos.some((a) => CRITICAL.test(a))) catastrophic ??= `rm trên ${pos.filter((a) => CRITICAL.test(a)).join(" ")}`;
      return;
    }
    if (DENY_SYSTEM.has(prog) || /^mkfs(\.|$)/.test(prog)) {
      worse(deny(`Lệnh can thiệp hệ thống (${prog})`));
      if (["dd", "mkfs", "fdisk", "parted", "gdisk", "shutdown", "reboot", "halt", "poweroff", "init", "telinit"].includes(prog) || /^mkfs/.test(prog)) catastrophic ??= `${prog}: ghi đĩa hoặc tắt máy`;
      return;
    }
    if (DENY_PKG.has(prog)) { worse(deny(`Không cài/gỡ gói hệ thống (${prog})`)); return; }
    if (DENY_NET.has(prog)) { worse(deny(`Không mở kết nối/đẩy dữ liệu ra ngoài (${prog})`)); return; }

    // ---- code piped into an interpreter, interpreters with inline code
    if ((SHELLS.has(prog) || INTERPRETERS.has(prog)) && (pipeTargets[idx] && !pos.length && !hasFlag(words, "-c", "-e"))) {
      worse(deny("Không chạy mã nhận từ đường ống (curl | sh …)")); return;
    }
    if (SHELLS.has(prog)) {
      const ci = args.findIndex((a) => a === "-c" || /^-[a-z]*c[a-z]*$/.test(a));
      if (ci >= 0 && args[ci + 1] !== undefined && depth < 2) { const inner = analyzeBash(args[ci + 1], here(), depth + 1); worse(inner.verdict); catastrophic ??= inner.catastrophic; return; }
      if (pos.length && authored(pos[0])) { worse(ask(`Script ${pos[0]} vừa được chính worker này tạo/sửa trong phiên: hãy xem trước khi chạy`)); return; }
      if (pos.length) { const k = classifyPath(pos[0], here()); worse(k === "inside" ? allow() : ask(`Chạy script ở ${k === "system" ? "vị trí hệ thống" : "ngoài thư mục làm việc"}: ${pos[0]}`)); return; }
      worse(ask("Mở shell tương tác/không rõ lệnh")); return;
    }

    // ---- reading and harmless
    if (SIMPLE.has(prog)) {
      if (prog === "cd" || prog === "pushd") {
        const target = pos[0] ?? ctx.home ?? "";
        const k = classifyPath(target, here());
        if (k === "system") worse(deny(`Không vào thư mục hệ thống: ${target}`));
        else if (k === "inside" || k === "sensitive") { const r = virtualCwd && !/[$`]/.test(target) ? resolveIn(target, virtualCwd, ctx.home) : undefined; if (r) virtualCwd = r; }
        else worse(ask(`Chuyển ra ngoài thư mục làm việc: ${target}`));
      }
      if (prog === "id" || prog === "set" || prog === "export") return;
      return;
    }
    if (READERS.has(prog) || prog === "find" || prog === "sed" || prog === "tar" || prog === "unzip" || prog === "zip") {
      if (prog === "find" && args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a))) { worse(args.includes("-delete") ? deny("find -delete xóa file") : ask("find -exec/-ok chạy lệnh khác")); return; }
      if (prog === "tar" || prog === "unzip" || prog === "zip") { worse(ask(`${prog} có thể ghi đè/giải nén ra nhiều nơi`)); return; }
      if (prog === "sed" && hasFlag(words, "-i", "--in-place")) {
        for (const f of pos.slice(1)) { const k = classifyPath(f, here()); if (k !== "inside") worse(k === "system" ? deny(`sed -i vào vị trí hệ thống: ${f}`) : ask(`sed -i ngoài thư mục làm việc hoặc file nhạy cảm: ${f}`)); }
        return;
      }
      const paths = (prog === "grep" || prog === "egrep" || prog === "fgrep" || prog === "rg" || prog === "ag" || prog === "sed" ? pos.slice(1) : pos).concat(args.filter((a) => a.startsWith("--") && a.includes("=")).map((a) => a.slice(a.indexOf("=") + 1)).filter((v) => v.includes("/")));
      for (const a of paths) {
        if (!/[\/.~$]/.test(a) && prog !== "ls" && prog !== "cat") continue;
        const k = classifyPath(a, here());
        if (k === "system") worse(deny(`Không đọc vị trí hệ thống/bí mật: ${a}`));
        else if (k === "sensitive") worse(ask(`File nhạy cảm: ${a}`));
        else if (k === "outside" || k === "unknown") worse(ask(`Ngoài thư mục làm việc hoặc không xác định được: ${a}`));
      }
      return;
    }
    if (WRITERS_INSIDE.has(prog)) {
      if (prog === "ln") { worse(ask("ln tạo liên kết, có thể trỏ ra ngoài")); return; }
      for (const a of pos) {
        const k = classifyPath(a, here());
        if (k === "system") worse(deny(`Không ghi vào vị trí hệ thống: ${a}`));
        else if (k !== "inside") worse(ask(`${prog} ngoài thư mục làm việc hoặc vào file nhạy cảm: ${a}`));
      }
      return;
    }

    // ---- git
    if (prog === "git") { worse(analyzeGit(words, here())); return; }

    // ---- package managers and language runtimes
    if (["npm", "pnpm", "yarn", "bun", "npx", "pnpx"].includes(prog)) {
      const v = analyzeNode(prog, words);
      worse(v.kind === "allow" && buildFileEdited("package.json") ? ask("package.json vừa được chính worker này sửa trong phiên: hãy xem scripts trước khi chạy") : v);
      return;
    }
    if (["pip", "pip3", "pipx", "uv", "poetry", "conda", "pdm"].includes(prog)) {
      const sub = pos[0];
      if (["list", "show", "freeze", "check", "--version", "tree", "env"].includes(sub ?? "") || (prog === "uv" && ["sync", "run", "lock"].includes(sub ?? "")) || (prog === "poetry" && ["run", "show", "check", "lock", "build"].includes(sub ?? ""))) worse(prog === "uv" && sub === "run" ? analyzeRunner(words.slice(2), here()) : allow());
      else worse(ask(`${prog} ${sub ?? ""}: cài gói có thể ra ngoài môi trường dự án`.trim()));
      return;
    }
    if (INTERPRETERS.has(prog)) {
      if (!pos.length && flags.length && flags.every((f) => /^(-v|-V|--version|--help|-h)$/.test(f))) return;
      if (hasFlag(words, "-c", "-e", "-E", "-p", "-r", "--eval", "--print", "--run") && !hasFlag(words, "-m")) { worse(ask(`${prog} chạy mã nhúng trong dòng lệnh`)); return; }
      const mi = args.indexOf("-m");
      if (mi >= 0) { const mod = args[mi + 1] ?? ""; worse(["pytest", "unittest", "venv", "pip", "mypy", "black", "ruff", "flake8", "build", "compileall", "json.tool", "http.server"].includes(mod) && mod !== "http.server" ? (mod === "pip" ? ask("pip có thể cài ra ngoài môi trường dự án") : allow()) : ask(`${prog} -m ${mod}: module không nằm trong danh sách an toàn`)); return; }
      const script = pos[0];
      if (!script) { worse(ask(`${prog} không có script`)); return; }
      if (authored(script)) { worse(ask(`Script ${script} vừa được chính worker này tạo/sửa trong phiên: hãy xem trước khi chạy`)); return; }
      const k = classifyPath(script, here());
      worse(k === "inside" ? allow() : k === "system" ? deny(`Không chạy script ở vị trí hệ thống: ${script}`) : ask(`Script ngoài thư mục làm việc hoặc nhạy cảm: ${script}`));
      return;
    }
    if (prog === "go") { worse(["test", "build", "vet", "fmt", "run", "mod", "list", "version", "env", "doc"].includes(pos[0] ?? "") ? allow() : ask(`go ${pos[0] ?? ""}${pos[0] === "generate" ? " chạy lệnh nhúng trong mã nguồn" : ""}`.trim())); return; }
    if (prog === "cargo") { worse(["build", "test", "check", "fmt", "clippy", "run", "doc", "bench", "tree", "metadata", "version", "clean"].includes(pos[0] ?? "") ? (pos[0] === "clean" ? ask("cargo clean xóa thư mục build") : allow()) : ask(`cargo ${pos[0] ?? ""}`.trim())); return; }
    if (BUILD_TOOLS.has(prog)) {
      if ((prog === "make" || prog === "cmake" || prog === "ninja") && pos.some((t) => /^(clean|distclean|mrproper|install|uninstall|purge|realclean|maintainer-clean)$/.test(t))) { worse(ask(`${prog} ${pos.join(" ")}: xóa hoặc cài ra ngoài thư mục dự án`)); return; }
      if (prog === "make" && buildFileEdited("Makefile", "makefile", "GNUmakefile")) { worse(ask("Makefile vừa được chính worker này sửa trong phiên: hãy xem trước khi chạy")); return; }
      for (const a of pos) { if (!/[\/~$]/.test(a)) continue; const k = classifyPath(a, here()); if (k === "system") worse(deny(`Không đụng vị trí hệ thống: ${a}`)); else if (k !== "inside") worse(ask(`Ngoài thư mục làm việc: ${a}`)); }
      return;
    }

    // ---- network clients
    if (prog === "curl" || prog === "wget" || prog === "http" || prog === "https") {
      if (hasFlag(words, "-d", "--data", "--data-binary", "--data-raw", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "-X", "--request", "--json") || args.some((a) => /^--(data|form|upload)/.test(a))) { worse(deny("Không gửi dữ liệu ra ngoài (curl/wget có -d/-F/-T/-X)")); return; }
      worse(ask("Truy cập mạng (curl/wget)")); return;
    }
    if (prog === "ssh" || prog === "rsync" || prog === "sshfs" || prog === "git-remote-ssh") { worse(ask(`${prog} kết nối máy khác`)); return; }
    if (["kill", "pkill", "killall", "xkill"].includes(prog)) { worse(ask("Dừng tiến trình khác")); return; }
    if (["chmod", "chown", "chgrp", "setfacl", "chattr"].includes(prog)) {
      const critical = hasFlag(words, "-R", "--recursive") && pos.some((a) => CRITICAL.test(a));
      if (critical) catastrophic ??= `${prog} -R trên ${pos.filter((a) => CRITICAL.test(a)).join(" ")}`;
      worse(ask(`${prog} đổi quyền/chủ sở hữu`)); return;
    }
    if (["docker", "podman", "kubectl", "helm", "terraform", "tofu", "ansible", "ansible-playbook", "vagrant", "aws", "gcloud", "az", "doctl", "flyctl", "heroku", "vercel", "netlify", "gh", "glab"].includes(prog)) { worse(ask(`${prog} tác động hạ tầng hoặc dịch vụ ngoài`)); return; }
    if (["env", "printenv"].includes(prog)) { worse(ask("In biến môi trường có thể lộ khóa bí mật")); return; }
    if (["xargs", "awk", "gawk", "mawk", "eval", "exec", "source", ".", "alias", "trap", "watch", "script", "screen", "tmux", "expect", "parallel"].includes(prog)) { worse(ask(`${prog} chạy lệnh/mã khác nên không phân tích được`)); return; }
    worse(ask(`Lệnh không có trong danh sách an toàn: ${prog}`));
  });
  if (result.kind === "ask" && authoredPaths.length) result = { ...result, authored: [...authoredPaths] };
  return { verdict: result, catastrophic };
}

function analyzeRunner(rest: string[], ctx: PolicyContext): Verdict {
  if (!rest.length) return ask("uv run không có lệnh");
  return analyzeBash(rest.map((w) => (/[\s"'$`\\;&|<>]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w)).join(" "), ctx, 1).verdict;
}

function analyzeNode(prog: string, words: string[]): Verdict {
  const pos = nonFlags(words), flags = flagsOf(words);
  if (flags.some((f) => /^(-g|--global|--location=global|--prefix(=.*)?|--registry(=.*)?)$/.test(f))) return deny("Không cài gói toàn cục hoặc đổi vị trí cài (--global/--prefix)");
  const sub = pos[0];
  if (prog === "npx" || prog === "pnpx") return ask("npx tải rồi chạy gói từ mạng");
  if (!sub) return allow();
  if (["publish", "login", "logout", "adduser", "token", "owner", "deprecate", "unpublish", "access", "whoami", "link", "unlink", "set-script"].includes(sub)) return sub === "publish" || sub === "unpublish" || sub === "deprecate" ? deny(`${prog} ${sub} đưa gói ra công khai`) : ask(`${prog} ${sub}`);
  if (["exec", "dlx", "create", "init", "x"].includes(sub)) return ask(`${prog} ${sub} tải rồi chạy gói từ mạng`);
  if (["config", "set", "get", "cache", "rebuild", "uninstall", "remove", "rm", "un", "prune", "dedupe", "update", "up", "upgrade", "outdated", "audit", "ls", "list", "why", "explain", "info", "view", "pack", "version", "root", "bin", "prefix"].includes(sub)) {
    return ["config", "set", "cache", "uninstall", "remove", "rm", "un", "prune", "link"].includes(sub) ? ask(`${prog} ${sub} đổi cấu hình hoặc gỡ gói`) : allow();
  }
  if (["test", "t", "tst", "run", "run-script", "build", "start", "dev", "lint", "ci", "install", "i", "add", "install-test", "it", "fund", "check", "typecheck", "format", "ci-test", "exec-test"].includes(sub) || /^[a-z][\w:.-]*$/.test(sub)) return allow();
  return ask(`${prog} ${sub}`);
}

const GIT_ALLOW = new Set(["status", "diff", "log", "show", "blame", "grep", "ls-files", "ls-tree", "rev-parse", "rev-list", "describe", "shortlog", "whatchanged", "cat-file", "diff-tree", "show-ref", "for-each-ref", "name-rev", "merge-base", "count-objects", "check-ignore", "help", "version", "add", "commit", "mv", "fetch", "pull", "switch", "cherry-pick", "revert", "apply", "am", "format-patch", "worktree", "notes", "bisect", "reflog", "blame", "archive"]);
function analyzeGit(words: string[], ctx: PolicyContext): Verdict {
  // global options before the subcommand
  let i = 1;
  while (i < words.length && words[i].startsWith("-")) {
    const o = words[i];
    if (o === "-C" || o === "--git-dir" || o === "--work-tree" || o === "-c" || o === "--exec-path" || o === "--namespace") {
      const v = words[i + 1] ?? "";
      if (o === "-C" || o === "--git-dir" || o === "--work-tree") { const k = classifyPath(v, ctx); if (k === "system") return deny(`git ${o} trỏ vào vị trí hệ thống`); if (k !== "inside") return ask(`git ${o} ${v} ngoài thư mục làm việc`); }
      if (o === "-c" && /^(core\.(sshcommand|hookspath|fsmonitor|pager|editor)|credential\.|alias\.|protocol\.|url\.|http\.proxy|include)/i.test(v)) return ask(`git -c ${v} có thể chạy lệnh khác`);
      i += 2;
    } else i++;
  }
  const sub = words[i];
  if (!sub) return allow();
  const rest = words.slice(i + 1);
  // options that make git write to a path or run a command of the caller's choosing
  for (const a of rest) {
    if (/^--(upload-pack|receive-pack|exec|ext-cmd|open-files-in-pager|textconv-cmd)(=|$)/.test(a) || /^-O.+/.test(a) && sub === "grep") return deny(`git ${a.split("=")[0]} chạy lệnh tùy ý`);
    const m = /^--(output|output-directory)(?:=(.*))?$/.exec(a);
    if (m) { const v = m[2] ?? rest[rest.indexOf(a) + 1] ?? ""; const k = classifyPath(v, ctx); if (k !== "inside") return k === "system" ? deny(`git --${m[1]} ghi vào vị trí hệ thống: ${v}`) : ask(`git --${m[1]} ghi ra ngoài thư mục làm việc: ${v}`); }
  }
  if (sub === "bisect" && rest[0] === "run") return ask("git bisect run chạy lệnh tùy ý");
  const flags = rest.filter((a) => a.startsWith("-"));
  const pos = rest.filter((a) => !a.startsWith("-"));
  const has = (...f: string[]) => rest.some((a) => f.includes(a));
  if (["reset"].includes(sub)) return has("--hard", "--merge", "--keep") ? deny("git reset --hard làm mất thay đổi chưa commit") : ask("git reset đổi lịch sử/ chỉ mục");
  if (sub === "clean") return deny("git clean xóa file chưa theo dõi");
  if (sub === "rm") return deny("git rm xóa file");
  if (sub === "filter-branch" || sub === "filter-repo" || sub === "gc" || sub === "prune" || sub === "update-ref" || sub === "replace") return deny(`git ${sub} viết lại/xóa đối tượng`);
  if (sub === "remote") return ["-v", "show", "get-url"].includes(rest[0] ?? "-v") || rest.length === 0 ? allow() : deny("Không đổi đích push (git remote add/set-url/remove)");
  if (sub === "push") {
    if (flags.some((f) => /^(--force|-f|--force-with-lease(=.*)?|--delete|-d|--mirror|--prune|--all|--tags)$/.test(f)) || rest.some((a) => /^\+/.test(a) || /^:/.test(a))) return deny("Không git push ép/xóa/hàng loạt");
    return allow();
  }
  if (sub === "checkout" || sub === "restore") {
    if (has("--", ".") || flags.some((f) => /^(-f|--force|--theirs|--ours|-B)$/.test(f)) || (sub === "restore" && !has("--staged", "-S"))) return ask(`git ${sub} có thể bỏ thay đổi chưa commit`);
    return allow();
  }
  if (sub === "branch") return flags.some((f) => /^(-D|-d|--delete|-M|-m|--move|-f|--force)$/.test(f)) ? ask("git branch xóa/đổi tên nhánh") : allow();
  if (sub === "tag") return flags.some((f) => /^(-d|--delete|-f|--force)$/.test(f)) ? ask("git tag xóa/ghi đè tag") : allow();
  if (sub === "stash") { const a = pos[0] ?? "push"; return ["drop", "clear"].includes(a) ? deny("git stash drop/clear mất thay đổi đã cất") : allow(); }
  if (sub === "merge") return flags.includes("--abort") ? allow() : allow();
  if (sub === "rebase") return ask("git rebase viết lại lịch sử");
  if (sub === "config") return flags.some((f) => /^--(global|system)$/.test(f)) ? deny("Không đổi cấu hình git toàn cục/hệ thống") : (has("--get", "--list", "-l", "--get-all") ? allow() : ask("git config đổi cấu hình"));
  if (sub === "submodule" || sub === "lfs" || sub === "credential" || sub === "daemon") return ask(`git ${sub}`);
  if (GIT_ALLOW.has(sub)) {
    if (sub === "worktree" && ["remove", "prune"].includes(pos[0] ?? "")) return ask("git worktree remove xóa thư mục");
    if (sub === "reflog" && ["expire", "delete"].includes(pos[0] ?? "")) return deny("git reflog expire/delete mất khả năng khôi phục");
    return allow();
  }
  return ask(`git ${sub}`);
}

// ------------------------------------------------------------------ the decision

const FILE_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead"]);
const HARMLESS_TOOLS = new Set(["TodoWrite", "Task", "Agent", "ExitPlanMode", "Skill", "BashOutput", "KillShell", "KillBash", "TaskOutput", "TaskStop", "ToolSearch", "SlashCommand", "AskUserQuestion"]);

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** What Claude calls a file's location in the tool input. */
export function toolPaths(tool: string, input: unknown): string[] {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  if (FILE_TOOLS.has(tool)) return [str(o.file_path) || str(o.notebook_path) || str(o.path)].filter(Boolean);
  if (tool === "Read" || tool === "NotebookRead") return [str(o.file_path) || str(o.notebook_path)].filter(Boolean);
  if (tool === "LS") return [str(o.path)].filter(Boolean);
  if (tool === "Grep") return [str(o.path)].filter(Boolean);
  if (tool === "Glob") return [str(o.path), /^\/|^~|\.\.|^[a-z]:[\\/]/i.test(str(o.pattern)) ? str(o.pattern).split(/[*?[{]/)[0] : ""].filter(Boolean);
  return [];
}

function filePolicy(tool: string, input: unknown, ctx: PolicyContext): Verdict {
  const ps = toolPaths(tool, input);
  if (!ps.length) return READ_TOOLS.has(tool) && tool !== "Read" ? allow() : ask("Không xác định được đường dẫn");   // Grep/Glob/LS with no path run in the folder itself
  const writes = FILE_TOOLS.has(tool);
  for (const p of ps) {
    const k = classifyPath(p, ctx);
    if (k === "system") return deny(`${writes ? "Không ghi" : "Không đọc"} vị trí hệ thống/bí mật: ${p}`);
    if (k === "sensitive") return ask(`File nhạy cảm: ${p}`);
    if (k !== "inside") return ask(`${k === "unknown" ? "Không xác định được vị trí" : "Ngoài thư mục làm việc"}: ${p}`);
  }
  return allow();
}

/** The verdict for one tool call under `mode`. `manual` always asks (pre-approved tools never get here). */
export function decide(mode: Autonomy, tool: string, input: unknown, ctx: PolicyContext = {}): Verdict {
  if (mode === "manual") return ask();
  if (mode === "full") return decideFull(tool, input, ctx);

  if (tool.startsWith("mcp__agentroom")) return allow();          // the room's own tools
  if (FILE_TOOLS.has(tool) || READ_TOOLS.has(tool)) return filePolicy(tool, input, ctx);
  if (HARMLESS_TOOLS.has(tool)) return allow();
  if (tool === "WebSearch") return allow();
  if (tool === "WebFetch") return ask("WebFetch gửi yêu cầu tới địa chỉ do model chọn (có thể dùng để đưa dữ liệu ra ngoài)");
  if (tool === "Bash") {
    const cmd = str((input as { command?: unknown } | null)?.command);
    if (!cmd.trim()) return ask("Lệnh rỗng");
    return analyzeBash(cmd, ctx).verdict;
  }
  if (tool.startsWith("mcp__")) return ask("Công cụ MCP bên ngoài chưa được kiểm tra");
  return ask(`Công cụ không có trong chính sách: ${tool}`);
}

/** Actions that `full` still hands to the human, because they cannot be undone or take the machine down. */
function decideFull(tool: string, input: unknown, ctx: PolicyContext): Verdict {
  if (tool === "Bash") {
    const cmd = str((input as { command?: unknown } | null)?.command);
    if (/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(cmd)) return ask("Fork bomb");
    const a = analyzeBash(cmd, ctx);
    if (a.catastrophic) return ask(`Full Access vẫn hỏi với hành động có thể phá máy: ${a.catastrophic}`);
    return allow();
  }
  if (FILE_TOOLS.has(tool)) {
    for (const p of toolPaths(tool, input)) {
      if (classifyPath(p, ctx) === "system") return ask(`Full Access vẫn hỏi khi ghi vào vị trí hệ thống/bí mật: ${p}`);
    }
  }
  return allow();
}

/** A short label of a tool call for the audit log and chat notices (secrets are redacted by the caller). */
export function describeCall(tool: string, input: unknown): string {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const v = tool === "Bash" ? str(o.command) : toolPaths(tool, input)[0] ?? str(o.url) ?? str(o.query) ?? "";
  const s = `${tool} ${v}`.trim().replace(/\s+/g, " ");
  return s.length > 200 ? s.slice(0, 197) + "…" : s;
}

/** Codex has no approval hook; its autonomy is the sandbox. Never wider than `full`, never below what `manual` configured. */
export function codexSandbox(mode: Autonomy, configured: "read-only" | "workspace-write" | "danger-full-access"): "read-only" | "workspace-write" | "danger-full-access" {
  if (mode === "full") return "danger-full-access";
  if (mode === "auto") return configured === "read-only" ? "read-only" : "workspace-write";
  return configured;
}
