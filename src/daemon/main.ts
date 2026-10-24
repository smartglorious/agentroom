#!/usr/bin/env node
// agentroom-daemon: runs the room (Telegram, schedules, webhooks, remote hosts) without VS Code.
import { resolveLang, setLang, tr } from "../core/i18n";
import { existsSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BotApi } from "../channels/telegram/api";
import { PIN_FORMAT, hashPin } from "../channels/telegram/pin";
import { Autonomy, isAutonomy } from "../core/autonomy";
import { gatherCleanup, humanBytes, listBatches, renderScan, restoreCleanup, scanCleanup } from "../core/cleanup";
import { parseConfig } from "../core/config";
import { IssueStore, IssueStatus } from "../core/issues";
import { VERSION } from "../core/version";
import { RoomLock } from "../core/lock";
import { fingerprint } from "../remote/host";
import { createHash } from "node:crypto";
import { DaemonError, DaemonHandle, EXIT, startDaemon } from "./daemon";
import { DaemonStore, SETTING_PARSERS, defaultStoreFile, pairingFile } from "./store";

const usage = () => {
  const rows: [string, string][] = [
    [tr("run [--root <thư mục>] [--take-over]"), tr("chạy phòng (Telegram, lịch, webhook, máy từ xa)")],
    [tr("setup-telegram"), tr("nhập token bot (ẩn), kiểm tra, lưu")],
    [tr("telegram-off"), tr("xoá token bot đã lưu")],
    [tr("set-pin"), tr("đặt/bỏ PIN duyệt quyền từ điện thoại")],
    [tr("pair"), tr("lấy mã ghép cặp từ daemon đang chạy")],
    [tr("trust-hosts [--root <thư mục>]"), tr("cho phép daemon ssh tới các hosts trong workers.yaml")],
    [tr("settings"), tr("xem cài đặt")],
    [tr("set <khóa> <giá trị>"), tr("đổi cài đặt (detail, hookPort, claudePath, …)")],
    [tr("autonomy [<worker> <manual|auto|full>] [--root <thư mục>]"), tr("xem/đổi mức tự chủ của worker")],
    [tr("issues [list|export|report <mô tả>|fix <id> [ghi chú]|wontfix <id>]"), tr("lỗi/vấn đề đã gom (cục bộ)")],
    [tr("cleanup [scan|gather|list|restore <lô>] [--root <thư mục>]"), tr("dọn file rác/tạm/cache: GOM vào .agentroom/cleanup/, không xóa")],
    [tr("status [--root <thư mục>]"), tr("ai đang giữ phòng")],
    [tr("service [--root <thư mục>]"), tr("in file systemd mẫu")],
  ];
  const w = Math.min(46, Math.max(...rows.map(([l]) => l.length)) + 2);
  return [
    tr("agentroom-daemon — chạy AgentRoom không cần VS Code"),
    "",
    ...rows.map(([l, r]) => "  " + l.padEnd(w) + r),
    "",
    tr("Dữ liệu riêng của daemon: {file} (chế độ 0600). Token cũng có thể đặt bằng biến AGENTROOM_TELEGRAM_TOKEN.", { file: defaultStoreFile("~") }),
  ].join("\n");
};

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
  if (!existsSync(f)) die(tr("Không thấy {f}. Dùng --root <thư mục project>.", { f }));
  try { return parseConfig(readFileSync(f, "utf8")); } catch (e) { return die(tr("workers.yaml lỗi — {p}", { p: e instanceof Error ? e.message : e })); }
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
    log(tr("nạp lại ({why})", { why }));
    handle?.stop();
    handle = undefined;
    try { await boot(false); } catch (e) {
      // A broken workers.yaml must not end the process: keep watching and retry on the next save.
      log(tr("nạp lại thất bại: {p}. Sửa workers.yaml rồi lưu để thử lại.", { p: e instanceof Error ? e.message : e }));
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
      debounce = setTimeout(() => void reload(tr("workers.yaml thay đổi")), 800);
    } catch { /* editor mid-save */ }
  }, 2000);

  const quit = (sig: string) => { log(tr("nhận {sig}, đang dừng", { sig })); handle?.stop(); setTimeout(() => process.exit(EXIT.ok), 200).unref(); };
  process.on("SIGINT", () => quit("SIGINT"));
  process.on("SIGTERM", () => quit("SIGTERM"));
  process.on("SIGHUP", () => void reload("SIGHUP"));
  process.on("SIGUSR1", () => { handle?.requestPairing(); });
  await new Promise(() => {});
}

async function main() {
  setLang(resolveLang(process.env.AGENTROOM_LANG ?? store.settings().language, process.env.LC_ALL || process.env.LANG));
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest, root } = parseArgs(argv);
  switch (cmd) {
    case "run":
      return run(root, flags["take-over"] === true);

    case "setup-telegram": {
      console.error(tr("Hãy dùng một bot RIÊNG cho AgentRoom (không dùng chung với chương trình khác đang nhận tin của bot đó)."));
      const token = await ask(tr("Token bot (từ @BotFather): "));
      if (!/^\d{5,}:[\w-]{20,}$/.test(token)) die(tr("Token có dạng 123456789:AAxxxxxxxx…"));
      let me;
      try { me = await new BotApi(token).getMe(); } catch (e) { return die(`Telegram: ${e instanceof Error ? e.message : e}`); }
      store.update((f) => { f.telegram = { ...f.telegram, token }; });
      console.log(tr("Đã lưu bot @{p} vào {file} (0600). Khởi động lại daemon, rồi chạy: agentroom-daemon pair", { p: me.username ?? me.first_name, file: store.file }));
      return;
    }
    case "telegram-off":
      store.update((f) => { if (f.telegram) delete f.telegram.token; });
      console.log(tr("Đã xoá token bot. Khởi động lại daemon để tắt Telegram."));
      return;

    case "set-pin": {
      const pin = await ask(tr("PIN mới (4–8 chữ số, để trống để bỏ PIN): "));
      if (!pin) { store.update((f) => { if (f.telegram) delete f.telegram.pin; }); return console.log(tr("Đã bỏ PIN.")); }
      if (!PIN_FORMAT.test(pin)) die(tr("PIN chỉ gồm 4–8 chữ số."));
      if ((await ask(tr("Nhập lại PIN: "))) !== pin) die(tr("Hai lần nhập không khớp."));
      store.update((f) => { f.telegram = { ...f.telegram, pin: hashPin(pin) }; });
      return console.log(tr("Đã đặt PIN (lưu dạng băm). Có hiệu lực ngay, không cần khởi động lại."));
    }

    case "pair": {
      const token = currentToken();
      if (!token) die(tr("Chưa có token. Chạy: agentroom-daemon setup-telegram"));
      const lock = new RoomLock(join(root, ".agentroom", "state", "room.lock")).peek();
      if (!lock || lock.kind !== "daemon" || Date.now() - lock.heartbeat > 20_000) die(tr("Không có daemon nào đang chạy cho thư mục này (chạy: agentroom-daemon run)."));
      const pf = pairingFile(home, tokenId(token!));
      const before = existsSync(pf) ? readFileSync(pf, "utf8") : "";
      process.kill(lock!.pid, "SIGUSR1");
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 200));
        try {
          const cur = readFileSync(pf, "utf8");
          const c = JSON.parse(cur) as { code: string; expiresAt: number };
          if (cur !== before && c.expiresAt > Date.now()) return console.log(tr("Mở Telegram, chat RIÊNG với bot và gửi:  /pair {code}   (hết hạn sau 10 phút)", { code: c.code }));
        } catch { /* not written yet */ }
      }
      return die(tr("Daemon không trả mã (đã ghép cặp rồi? Telegram bị lỗi? xem log của daemon)."));
    }

    case "trust-hosts": {
      const config = loadConfig(root);
      if (!config.hosts.length) return console.log(tr("workers.yaml không khai báo hosts."));
      for (const h of config.hosts) console.log(`  ${h.name}: ssh ${h.ssh}${h.port ? " -p " + h.port : ""}  repo ${h.repo}`);
      if ((await ask(tr("Cho phép daemon kết nối SSH tới các máy trên, bằng tài khoản SSH của người dùng này? [y/N] "), false)).toLowerCase() !== "y") die(tr("Đã huỷ."), 1);
      store.update((f) => { f.trusted = [...new Set([...(f.trusted ?? []), ...config.hosts.map((h) => `${root}|${fingerprint(h)}`)])]; });
      return console.log(tr("Đã cho phép."));
    }

    case "settings": {
      const cur = store.settings();
      for (const k of Object.keys(SETTING_PARSERS)) console.log(`${k} = ${JSON.stringify(cur[k as keyof typeof cur])}`);
      return;
    }
    case "set": {
      const [k, ...v] = rest;
      if (!k) die(tr("Dùng: agentroom-daemon set <khóa> <giá trị>"));
      try { store.set(k, v.join(" ")); } catch (e) { die(`${k}: ${e instanceof Error ? e.message : e}`); }
      return console.log(tr("{k} đã đặt. Khởi động lại daemon (hoặc SIGHUP) nếu đó là hookPort/maxAgentHops/contextMessages/memoryBudgetChars/inspectorKeepTurns; các khoá còn lại có hiệu lực ngay.", { k }));
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
      if (!config.workers.some((w) => w.id === id)) die(tr("Không có worker \"{id}\" (có: {p})", { id, p: config.workers.map((w) => w.id).join(", ") }));
      if (!isAutonomy(mode)) die(tr("Mức tự chủ: manual | auto | full"));
      if (mode === "full") {
        console.error([
          tr("⚠ FULL ACCESS: worker sẽ không còn hỏi trước khi sửa/xóa file (kể cả ngoài dự án), chạy lệnh tùy ý, tải rồi chạy mã, cài gói, git push --force…"),
          tr("Nội dung nó đọc được (web, issue, file lạ) có thể chứa chỉ dẫn độc hại. Vẫn hỏi (qua Telegram/VS Code) với rm -rf thư mục gốc/home/hệ thống, sudo, ghi đĩa, tắt máy."),
          tr("Daemon chạy không có ai canh: chỉ dùng trong máy ảo/container hoặc repo đã commit sạch. Mức này được GIỮ cho tới khi bạn đổi lại."),
        ].join("\n"));
        if ((await ask(tr("Gõ FULL để xác nhận: "), false)) !== "FULL") die(tr("Đã huỷ."), 1);
      }
      const chosen = mode as Autonomy;
      store.update((f) => { f.autonomy = { ...f.autonomy, [key(id)]: chosen }; });
      return console.log(tr("{id}: {mode}. Có hiệu lực ở lượt tới của worker (không cần khởi động lại daemon).", { id, mode }));
    }

    case "issues": {
      const st = new IssueStore(join(root, ".agentroom", "state", "issues.json"), { version: VERSION, platform: process.platform, node: process.version, scrub: [[root, "<project>"], [home, "~"]] });
      const [sub = "list", ...more] = rest;
      if (sub === "export") { process.stdout.write(st.markdown()); return; }
      if (sub === "report") {
        if (!more.length) die(tr("issues report <mô tả>"), 1);
        const text = more.join(" ");
        return console.log(tr("Đã ghi {p}.", { p: st.record({ kind: "user", source: "user", title: text.split("\n")[0].slice(0, 200), detail: text }).id }));
      }
      if (sub === "fix" || sub === "wontfix") {
        const [id, ...note] = more;
        const it = id ? st.setStatus(id, (sub === "fix" ? "fixed" : "wontfix") as IssueStatus, note.join(" ") || undefined) : undefined;
        return it ? console.log(`${it.id}: ${it.status}`) : die(tr("Không thấy id đó (xem: issues list)."), 1);
      }
      const open = st.list("open").sort((a, b) => b.count - a.count);
      return console.log(open.length ? open.map((i) => `${i.id}  ×${i.count}  [${i.kind}/${i.source}]  ${i.title}`).join("\n") : tr("Không có vấn đề nào đang mở."));
    }

    case "cleanup": {
      const [sub = "scan", arg] = rest;
      if (sub === "scan") return console.log(renderScan(scanCleanup(root)));
      if (sub === "gather") {
        const items = scanCleanup(root);
        if (!items.length) return console.log(renderScan(items));
        console.log(renderScan(items));
        if ((await ask(tr("Gom {n} mục này vào {p} (di chuyển, không xóa)? [y/N] ", { n: items.length, p: join(root, ".agentroom", "cleanup") }), false)).trim().toLowerCase() !== "y") die(tr("Đã huỷ, không có gì bị đụng tới."), 1);
        const r = gatherCleanup(root, items.map((i) => i.rel));
        return console.log(tr("Đã gom {n} mục vào {dir}. Bạn tự xóa thư mục đó khi chắc chắn.", { n: r.manifest.entries.length, dir: r.dir }) + (r.skipped.length ? " " + tr("Bỏ qua {n}.", { n: r.skipped.length }) : ""));
      }
      if (sub === "list") {
        const b = listBatches(root);
        return console.log(b.length ? b.map((x) => tr("{stamp}  {n} mục  {p}", { stamp: x.stamp, n: x.entries.length, p: humanBytes(x.entries.reduce((a, e) => a + e.bytes, 0)) })).join("\n") : tr("Chưa có lô dọn dẹp nào."));
      }
      if (sub === "restore") {
        if (!arg) die(tr("Cần tên lô (xem: cleanup list)."), 1);
        const r = restoreCleanup(root, arg);
        return console.log(tr("Đã khôi phục {n} mục.", { n: r.restored.length }) + (r.skipped.length ? " " + tr("Bỏ qua {n}.", { n: r.skipped.length }) : ""));
      }
      return die(tr("cleanup [scan|gather|list|restore <lô>]"), 1);
    }

    case "status": {
      const l = new RoomLock(join(root, ".agentroom", "state", "room.lock")).peek();
      const fresh = l && Date.now() - l.heartbeat < 20_000;
      console.log(fresh ? tr("Đang chạy: {p} · máy {p1} · pid {p2} · từ {p3}", { p: l!.kind === "daemon" ? "daemon" : "cửa sổ VS Code", p1: l!.host, p2: l!.pid, p3: new Date(l!.startedAt).toLocaleString() }) : tr("Không có ai điều phối thư mục này."));
      const t = store.read().telegram;
      console.log(`Telegram: ${currentToken() ? tr("có token") : tr("chưa thiết lập")}${t?.pin ? tr(", có PIN") : ""}`);
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
${tr("# exit 3 = phòng đang do cửa sổ VS Code giữ: đừng vòng lặp khởi động lại")}
RestartPreventExitStatus=3 2
${tr("# bí mật cho webhook (AGENTROOM_HOOK_SECRET=…), mỗi dòng KEY=VALUE, chmod 600")}
EnvironmentFile=-%h/.agentroom/daemon.env
${tr("# systemd không có PATH của bạn: nếu claude/codex nằm ngoài, dùng: agentroom-daemon set claudePath <đường dẫn>")}
Environment=PATH=%h/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`);
      return;
    }

    default:
      console.log(usage());
      process.exit(cmd && cmd !== "help" && cmd !== "--help" ? 1 : 0);
  }
}

main().catch((e) => die(e instanceof Error ? e.message : String(e), 1));
