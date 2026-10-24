#!/usr/bin/env node
// agentroom-daemon: runs the room (Telegram, schedules, webhooks, remote hosts) without VS Code.
import { existsSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BotApi } from "../channels/telegram/api";
import { PIN_FORMAT, hashPin } from "../channels/telegram/pin";
import { Autonomy, isAutonomy } from "../core/autonomy";
import { parseConfig } from "../core/config";
import { RoomLock } from "../core/lock";
import { fingerprint } from "../remote/host";
import { createHash } from "node:crypto";
import { DaemonError, DaemonHandle, EXIT, startDaemon } from "./daemon";
import { DaemonStore, SETTING_PARSERS, defaultStoreFile, pairingFile } from "./store";

const USAGE = `agentroom-daemon — chạy AgentRoom không cần VS Code

  run [--root <thư mục>] [--take-over]   chạy phòng (Telegram, lịch, webhook, máy từ xa)
  setup-telegram                          nhập token bot (ẩn), kiểm tra, lưu
  telegram-off                            xoá token bot đã lưu
  set-pin                                 đặt/bỏ PIN duyệt quyền từ điện thoại
  pair                                    lấy mã ghép cặp từ daemon đang chạy
  trust-hosts [--root <thư mục>]          cho phép daemon ssh tới các hosts trong workers.yaml
  settings                                xem cài đặt
  set <khóa> <giá trị>                    đổi cài đặt (detail, hookPort, claudePath, …)
  autonomy [<worker> <manual|auto|full>] [--root <thư mục>]   xem/đổi mức tự chủ của worker
  status [--root <thư mục>]               ai đang giữ phòng
  service [--root <thư mục>]              in file systemd mẫu

Dữ liệu riêng của daemon: ${defaultStoreFile("~")} (chế độ 0600). Token cũng có thể đặt bằng biến AGENTROOM_TELEGRAM_TOKEN.`;

const home = homedir();
const store = new DaemonStore(defaultStoreFile(home));
const stamp = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (t: string) => console.log(`${stamp()} ${t}`);
const die = (msg: string, code: number = EXIT.config): never => { console.error(msg); process.exit(code); };

function parseArgs(argv: string[]) {
  const flags: Record<string, string | true> = {};
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (a === "--root" && next) { flags.root = next; i++; } else flags[a.slice(2)] = true;
    } else rest.push(a);
  }
  return { flags, rest, root: resolve(typeof flags.root === "string" ? flags.root : process.cwd()) };
}

/** One line from the terminal, hidden when it is a TTY (token / PIN); one line of stdin when piped. */
async function ask(question: string, hidden = true): Promise<string> {
  process.stderr.write(question);
  if (!process.stdin.isTTY) {
    const buf = Buffer.alloc(1);
    let line = "";
    while (readSync(0, buf, 0, 1, null) === 1 && buf[0] !== 10) line += String.fromCharCode(buf[0]);
    return line.trim();
  }
  return new Promise((res) => {
    let s = "";
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const onData = (ch: string) => {
      for (const c of ch) {
        if (c === "\n" || c === "\r" || c === "\u0004") { stdin.setRawMode(false); stdin.pause(); stdin.off("data", onData); process.stderr.write("\n"); return res(s.trim()); }
        if (c === "\u0003") { process.stderr.write("\n"); process.exit(130); }
        if (c === "\u007f" || c === "\b") s = s.slice(0, -1);
        else { s += c; if (!hidden) process.stderr.write(c); }
      }
    };
    stdin.on("data", onData);
  });
}

const tokenId = (t: string) => createHash("sha256").update(t).digest("hex").slice(0, 12);
const currentToken = () => process.env.AGENTROOM_TELEGRAM_TOKEN?.trim() || store.read().telegram?.token;

function loadConfig(root: string) {
  const f = join(root, ".agentroom", "workers.yaml");
  if (!existsSync(f)) die(`Không thấy ${f}. Dùng --root <thư mục project>.`);
  try { return parseConfig(readFileSync(f, "utf8")); } catch (e) { return die(`workers.yaml lỗi — ${e instanceof Error ? e.message : e}`); }
}

async function run(root: string, takeOver: boolean) {
  const runnerPath = join(dirname(fileURLToPath(import.meta.url)), "runner.mjs");
  let handle: DaemonHandle | undefined;
  const boot = async (to: boolean) => {
    const h = await startDaemon({ root, takeOver: to, log, runnerPath });
    handle = h;
    // Someone took the room: this daemon has already shut itself down. Exit 0 so systemd does not restart it.
    void h.lost.then(() => { if (handle === h) process.exit(EXIT.ok); });
  };
  try { await boot(takeOver); } catch (e) {
    if (e instanceof DaemonError) die(e.message, e.exitCode);
    throw e;
  }

  let reloading = false;
  const reload = async (why: string) => {
    if (reloading) return;
    reloading = true;
    log(`nạp lại (${why})`);
    handle?.stop();
    handle = undefined;
    try { await boot(false); } catch (e) {
      // A broken workers.yaml must not end the process: keep watching and retry on the next save.
      log(`nạp lại thất bại: ${e instanceof Error ? e.message : e}. Sửa workers.yaml rồi lưu để thử lại.`);
    }
    reloading = false;
  };

  // Polling is portable (network drives, editors that replace the file).
  const cfgFile = join(root, ".agentroom", "workers.yaml");
  let lastMtime = statSync(cfgFile).mtimeMs;
  let debounce: NodeJS.Timeout | undefined;
  setInterval(() => {
    try {
      const m = statSync(cfgFile).mtimeMs;
      if (m === lastMtime) return;
      lastMtime = m;
      clearTimeout(debounce);
      debounce = setTimeout(() => void reload("workers.yaml thay đổi"), 800);
    } catch { /* editor mid-save */ }
  }, 2000);

  const quit = (sig: string) => { log(`nhận ${sig}, đang dừng`); handle?.stop(); setTimeout(() => process.exit(EXIT.ok), 200).unref(); };
  process.on("SIGINT", () => quit("SIGINT"));
  process.on("SIGTERM", () => quit("SIGTERM"));
  process.on("SIGHUP", () => void reload("SIGHUP"));
  process.on("SIGUSR1", () => { handle?.requestPairing(); });
  await new Promise(() => {});
}

async function main() {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest, root } = parseArgs(argv);
  switch (cmd) {
    case "run":
      return run(root, flags["take-over"] === true);

    case "setup-telegram": {
      console.error("Hãy dùng một bot RIÊNG cho AgentRoom (không dùng chung với chương trình khác đang nhận tin của bot đó).");
      const token = await ask("Token bot (từ @BotFather): ");
      if (!/^\d{5,}:[\w-]{20,}$/.test(token)) die("Token có dạng 123456789:AAxxxxxxxx…");
      let me;
      try { me = await new BotApi(token).getMe(); } catch (e) { return die(`Telegram: ${e instanceof Error ? e.message : e}`); }
      store.update((f) => { f.telegram = { ...f.telegram, token }; });
      console.log(`Đã lưu bot @${me.username ?? me.first_name} vào ${store.file} (0600). Khởi động lại daemon, rồi chạy: agentroom-daemon pair`);
      return;
    }
    case "telegram-off":
      store.update((f) => { if (f.telegram) delete f.telegram.token; });
      console.log("Đã xoá token bot. Khởi động lại daemon để tắt Telegram.");
      return;

    case "set-pin": {
      const pin = await ask("PIN mới (4–8 chữ số, để trống để bỏ PIN): ");
      if (!pin) { store.update((f) => { if (f.telegram) delete f.telegram.pin; }); return console.log("Đã bỏ PIN."); }
      if (!PIN_FORMAT.test(pin)) die("PIN chỉ gồm 4–8 chữ số.");
      if ((await ask("Nhập lại PIN: ")) !== pin) die("Hai lần nhập không khớp.");
      store.update((f) => { f.telegram = { ...f.telegram, pin: hashPin(pin) }; });
      return console.log("Đã đặt PIN (lưu dạng băm). Có hiệu lực ngay, không cần khởi động lại.");
    }

    case "pair": {
      const token = currentToken();
      if (!token) die("Chưa có token. Chạy: agentroom-daemon setup-telegram");
      const lock = new RoomLock(join(root, ".agentroom", "state", "room.lock")).peek();
      if (!lock || lock.kind !== "daemon" || Date.now() - lock.heartbeat > 20_000) die("Không có daemon nào đang chạy cho thư mục này (chạy: agentroom-daemon run).");
      const pf = pairingFile(home, tokenId(token!));
      const before = existsSync(pf) ? readFileSync(pf, "utf8") : "";
      process.kill(lock!.pid, "SIGUSR1");
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const cur = readFileSync(pf, "utf8");
          const c = JSON.parse(cur) as { code: string; expiresAt: number };
          if (cur !== before && c.expiresAt > Date.now()) return console.log(`Mở Telegram, chat RIÊNG với bot và gửi:  /pair ${c.code}   (hết hạn sau 10 phút)`);
        } catch { /* not written yet */ }
      }
      return die("Daemon không trả mã (đã ghép cặp rồi? Telegram bị lỗi? xem log của daemon).");
    }

    case "trust-hosts": {
      const config = loadConfig(root);
      if (!config.hosts.length) return console.log("workers.yaml không khai báo hosts.");
      for (const h of config.hosts) console.log(`  ${h.name}: ssh ${h.ssh}${h.port ? " -p " + h.port : ""}  repo ${h.repo}`);
      if ((await ask("Cho phép daemon kết nối SSH tới các máy trên, bằng tài khoản SSH của người dùng này? [y/N] ", false)).toLowerCase() !== "y") die("Đã huỷ.", 1);
      store.update((f) => { f.trusted = [...new Set([...(f.trusted ?? []), ...config.hosts.map((h) => `${root}|${fingerprint(h)}`)])]; });
      return console.log("Đã cho phép.");
    }

    case "settings": {
      const cur = store.settings();
      for (const k of Object.keys(SETTING_PARSERS)) console.log(`${k} = ${JSON.stringify(cur[k as keyof typeof cur])}`);
      return;
    }
    case "set": {
      const [k, ...v] = rest;
      if (!k) die("Dùng: agentroom-daemon set <khóa> <giá trị>");
      try { store.set(k, v.join(" ")); } catch (e) { die(`${k}: ${e instanceof Error ? e.message : e}`); }
      return console.log(`${k} đã đặt. Khởi động lại daemon (hoặc SIGHUP) nếu đó là hookPort/maxAgentHops/contextMessages/memoryBudgetChars/inspectorKeepTurns; các khoá còn lại có hiệu lực ngay.`);
    }

    case "autonomy": {
      const config = loadConfig(root);
      const [id, mode] = rest;
      const key = (w: string) => `${root}|${w}`;
      const modeOf = (w: { id: string; autonomy: string }) => store.read().autonomy?.[key(w.id)] ?? (w.autonomy === "full" ? "auto" : w.autonomy);
      if (!id) {
        for (const w of config.workers) console.log(`${w.id.padEnd(12)} ${modeOf(w)}${modeOf(w) === "full" ? "   ⚡ FULL ACCESS" : ""}`);
        return;
      }
      if (!config.workers.some((w) => w.id === id)) die(`Không có worker "${id}" (có: ${config.workers.map((w) => w.id).join(", ")})`);
      if (!isAutonomy(mode)) die("Mức tự chủ: manual | auto | full");
      if (mode === "full") {
        console.error([
          "⚠ FULL ACCESS: worker sẽ không còn hỏi trước khi sửa/xóa file (kể cả ngoài dự án), chạy lệnh tùy ý, tải rồi chạy mã, cài gói, git push --force…",
          "Nội dung nó đọc được (web, issue, file lạ) có thể chứa chỉ dẫn độc hại. Vẫn hỏi (qua Telegram/VS Code) với rm -rf thư mục gốc/home/hệ thống, sudo, ghi đĩa, tắt máy.",
          "Daemon chạy không có ai canh: chỉ dùng trong máy ảo/container hoặc repo đã commit sạch. Mức này được GIỮ cho tới khi bạn đổi lại.",
        ].join("\n"));
        if ((await ask('Gõ FULL để xác nhận: ', false)) !== "FULL") die("Đã huỷ.", 1);
      }
      const chosen = mode as Autonomy;
      store.update((f) => { f.autonomy = { ...f.autonomy, [key(id)]: chosen }; });
      return console.log(`${id}: ${mode}. Có hiệu lực ở lượt tới của worker (không cần khởi động lại daemon).`);
    }

    case "status": {
      const l = new RoomLock(join(root, ".agentroom", "state", "room.lock")).peek();
      const fresh = l && Date.now() - l.heartbeat < 20_000;
      console.log(fresh ? `Đang chạy: ${l!.kind === "daemon" ? "daemon" : "cửa sổ VS Code"} · máy ${l!.host} · pid ${l!.pid} · từ ${new Date(l!.startedAt).toLocaleString()}` : "Không có ai điều phối thư mục này.");
      const t = store.read().telegram;
      console.log(`Telegram: ${currentToken() ? "có token" : "chưa thiết lập"}${t?.pin ? ", có PIN" : ""}`);
      return;
    }

    case "service": {
      const node = process.execPath;
      const script = fileURLToPath(import.meta.url);
      console.log(`[Unit]
Description=AgentRoom daemon (${root})
After=network-online.target

[Service]
ExecStart=${node} ${script} run --root ${root}
WorkingDirectory=${root}
Restart=on-failure
RestartSec=5
# exit 3 = phòng đang do cửa sổ VS Code giữ: đừng vòng lặp khởi động lại
RestartPreventExitStatus=3 2
# bí mật cho webhook (AGENTROOM_HOOK_SECRET=…), mỗi dòng KEY=VALUE, chmod 600
EnvironmentFile=-%h/.agentroom/daemon.env
# systemd không có PATH của bạn: nếu claude/codex nằm ngoài, dùng: agentroom-daemon set claudePath <đường dẫn>
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`);
      return;
    }

    default:
      console.log(USAGE);
      process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e), 1));
