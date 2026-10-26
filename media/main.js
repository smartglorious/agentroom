// AgentRoom webview. Pure rendering: all state lives in the extension host.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  // The source strings are Vietnamese; the dictionary (window.__AR_EN, from src/core/i18n-en.ts) maps them to English.
  const EN = window.__AR_LANG === "en" ? window.__AR_EN || {} : null;
  const tr = (key, params) => {
    const s = (EN && EN[key]) || key;
    return params ? s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m)) : s;
  };
  const state = {
    workers: [], plans: [], byId: new Map(), answers: new Map(), replyTo: null, statuses: {}, tasks: [], drafts: [], accounts: [], todayByWorker: {},
    usage: null, range: "today", schedules: [], hooks: { port: null, hooks: [], calls: [] },
    profile: null, profileWorker: null, hostList: [], telegram: null, panels: [], settings: null,
  };

  const STATE_LABEL = {
    idle: tr("rảnh"), queued: tr("chờ lượt"), working: tr("đang làm"), waiting_approval: tr("chờ duyệt"),
    rate_limited: tr("hết quota"), over_budget: tr("hết ngân sách"), error: tr("lỗi"),
  };

  // Colours come from workers.yaml (validated #rrggbb); anything else is ignored rather than put in a style.
  const colorOf = (id) => { const c = state.workers.find((w) => w.id === id)?.color; return /^#[0-9a-f]{6}$/i.test(c || "") ? c : null; };
  const tint = (node, id) => { const c = colorOf(id); if (c) node.style.setProperty("--wc", c); return node; };
  const nameOf = (id) => id === "user" ? tr("Bạn") : id === "system" ? tr("Hệ thống") : (state.workers.find((w) => w.id === id)?.name ?? id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const btn = (label, onclick, cls) => { const b = el("button", cls || "small", label); b.onclick = onclick; return b; };
  const send = (m) => vscode.postMessage(m);

  const tok = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  const usd = (n) => "$" + (n > 0 && n < 0.01 ? n.toFixed(4) : n.toFixed(2));
  const when = (ts) => ts ? new Date(ts).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—";

  // ---------- team bar ----------
  function renderTeam() {
    const team = $("team");
    team.replaceChildren();
    for (const w of state.workers) {
      const s = state.statuses[w.id] || { state: "idle" };
      const card = tint(el("div", `worker ${s.state}`), w.id);
      card.title = `${w.role} · ${w.provider}${w.skills.length ? " · " + w.skills.join(", ") : ""}`;
      card.append(el("span", "dot"), el("b", null, w.name), el("span", "id", "@" + w.id));
      if (w.host) { const h = el("span", "host", "⇄ " + w.host); h.title = tr("Chạy trên máy {host}", { host: w.host }); card.append(h); }
      const cost = state.todayByWorker[w.id];
      if (cost > 0) card.append(el("span", "cost", usd(cost)));
      card.append(el("span", "state", STATE_LABEL[s.state] + (s.activity ? ` — ${s.activity}` : "")));
      const info = btn("ⓘ", (e) => { e.stopPropagation(); openProfile(w.id); }, "stop");
      info.title = tr("Hồ sơ: SOUL, trí nhớ, skills");
      card.append(info);
      const mode = w.autonomy || "manual";
      card.classList.add("mode-" + mode);
      const sel = el("select", "autonomy");
      for (const [v, label] of [["manual", "🛡 Manual"], ["auto", "🤖 Auto"], ["full", "⚡ Full"]]) { const o = el("option", null, label); o.value = v; sel.append(o); }
      sel.value = mode;
      sel.title = tr("Mức tự chủ: Manual hỏi mọi thao tác · Auto tự duyệt việc an toàn, chặn xóa file/hệ thống/sudo, hỏi khi không chắc · Full không hỏi (cần xác nhận)");
      sel.onclick = (e) => e.stopPropagation();
      sel.onchange = (e) => { e.stopPropagation(); send({ type: "setAutonomy", workerId: w.id, mode: sel.value }); };
      card.append(sel);
      if (s.state !== "idle") {
        const stop = btn("■", (e) => { e.stopPropagation(); send({ type: "stop", workerId: w.id }); }, "stop");
        stop.title = tr("Dừng worker này");
        card.append(stop);
      }
      card.onclick = () => insertMention(w.id);
      team.append(card);
    }
  }

  // ---------- chat ----------
  function renderMessage(m) {
    const row = tint(el("article", `msg from-${m.from === "user" ? "user" : m.from === "system" ? "system" : "agent"}`), m.from);
    const head = el("div", "head");
    head.append(el("b", null, nameOf(m.from)));
    if (m.taskId) head.append(el("span", "tag", m.taskId));
    if (m.readOnly) head.append(el("span", "tag ro", tr("chỉ đọc")));
    if (m.source === "telegram") { const t = el("span", "tag", "📱"); t.title = tr("Gửi từ Telegram"); head.append(t); }
    if (m.to.length) head.append(el("span", "to", "→ " + m.to.map(nameOf).join(", ")));
    if (m.turnId) {
      const b = btn("🔍", () => send({ type: "inspect", turnId: m.turnId }), "stop");
      b.title = tr("Context Inspector: xem chính xác những gì đã gửi cho model ở lượt này");
      head.append(b);
    }
    head.append(el("time", null, new Date(m.ts).toLocaleTimeString()));
    if (m.from !== "user" && m.from !== "system") {
      const r = btn("↩", () => startReply(m), "stop");
      r.title = tr("Trả lời đúng tin này");
      head.append(r);
    }
    state.byId.set(m.id, m);
    row.id = "msg-" + m.id;
    const body = el("div", "body");
    // Highlight @mentions without using innerHTML. A question with options shows just the question; the options are buttons.
    for (const part of (m.options ? m.options.question : m.text).split(/(@[\w-]+)/g)) {
      if (!part.startsWith("@")) { body.append(document.createTextNode(part)); continue; }
      body.append(tint(el("span", colorOf(part.slice(1)) ? "mention worker-mention" : "mention", part), part.slice(1)));
    }
    const quoted = m.replyTo ? state.byId.get(m.replyTo) : null;
    if (m.replyTo) {
      const q = el("div", "quote");
      q.append(el("b", null, quoted ? "↩ " + nameOf(quoted.from) : tr("↩ tin cũ")));
      if (quoted) q.append(el("span", null, " " + (quoted.options ? quoted.options.question : quoted.text).replace(/\s+/g, " ").slice(0, 140)));
      q.onclick = () => document.getElementById("msg-" + m.replyTo)?.scrollIntoView({ block: "center" });
      row.append(head, q, body);
    } else row.append(head, body);
    if (m.options) row.append(renderOptions(m));
    if (m.choice) { state.answers.set(m.choice.message, m.choice.option); markAnswered(m.choice.message, m.choice.option); }
    const chat = $("chat");
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.append(row);
    if (atBottom) chat.scrollTop = chat.scrollHeight;
  }

  // ---------- reply and options ----------
  function renderOptions(m) {
    const box = el("div", "options");
    box.dataset.msg = m.id;
    for (const it of m.options.items) {
      const b = el("button", "opt");
      b.dataset.opt = it.id;
      b.append(el("b", null, `${it.id}. ${it.label}`));
      if (it.description) b.append(el("span", "desc", it.description));
      b.onclick = () => { box.querySelectorAll("button").forEach((x) => (x.disabled = true)); send({ type: "answerOption", messageId: m.id, optionId: it.id }); };
      box.append(b);
    }
    const chosen = state.answers.get(m.id);
    if (chosen) setTimeout(() => markAnswered(m.id, chosen));
    return box;
  }
  function markAnswered(msgId, optionId) {
    const box = document.querySelector(`.options[data-msg="${CSS.escape(msgId)}"]`);
    if (!box) return;
    box.classList.add("answered");
    box.querySelectorAll("button").forEach((b) => { b.disabled = true; b.classList.toggle("picked", b.dataset.opt === optionId); });
  }
  function startReply(m) {
    state.replyTo = m.id;
    const bar = $("replybar");
    bar.replaceChildren();
    const text = (m.options ? m.options.question : m.text).replace(/\s+/g, " ").slice(0, 120);
    const x = btn("✕", () => clearReply(), "stop");
    x.title = tr("Bỏ trả lời");
    bar.append(el("span", "rb", tr("↩ Trả lời {name}: {text}", { name: nameOf(m.from), text })), x);
    bar.hidden = false;
    showTab("chat");
    $("input").focus();
  }
  function clearReply() {
    state.replyTo = null;
    $("replybar").hidden = true;
    $("replybar").replaceChildren();
  }

  // ---------- tasks ----------
  function renderTasks() {
    const box = $("tasks");
    box.replaceChildren();
    for (const col of ["blocked", "todo", "in_progress", "done"]) {
      const list = state.tasks.filter((t) => t.status === col);
      const c = el("div", "col");
      c.append(el("h4", null, `${col} (${list.length})`));
      for (const t of list) {
        const card = el("div", "task");
        card.append(el("b", null, `[${t.id}] ${t.title}`));
        const spent = taskCost(t.id);
        card.append(el("div", "meta", `${t.assignee ? "@" + t.assignee : tr("chưa giao")}${t.dependsOn.length ? " · " + tr("cần {ids}", { ids: t.dependsOn.join(", ") }) : ""}${spent ? " · " + usd(spent) : ""}`));
        if (t.result) card.append(el("div", "result", t.result));
        c.append(card);
      }
      box.append(c);
    }
  }
  const taskCost = (id) => state.usage?.summary.byTask.find((r) => r.key === id)?.costUsd ?? 0;

  // ---------- cost ----------
  function bars(title, rows, fmt, limit) {
    const sec = el("div", "col");
    sec.append(el("h4", null, title));
    const shown = rows.slice(0, limit || 8);
    const max = Math.max(1e-9, ...shown.map((r) => fmt.value(r)));
    for (const r of shown) {
      const line = el("div", "bar-row");
      line.append(el("span", "bar-key", r.key));
      const track = el("span", "bar-track");
      const fill = el("span", "bar-fill");
      fill.style.width = Math.max(2, (fmt.value(r) / max) * 100) + "%";
      track.append(fill);
      line.append(track, el("span", "bar-val", fmt.label(r)));
      sec.append(line);
    }
    if (!shown.length) sec.append(el("div", "meta", "—"));
    return sec;
  }

  // ---------- plan usage (subscription windows) ----------
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? tr("vừa xong") : m < 60 ? tr("{n} phút trước", { n: m }) : tr("{n} giờ trước", { n: Math.round(m / 60) }); };
  const until = (ms) => {
    const m = Math.round((ms - Date.now()) / 60000);
    if (m <= 0) return tr("đang reset");
    if (m < 60) return tr("{m} phút", { m });
    const h = Math.floor(m / 60);
    return h < 48 ? (m % 60 ? tr("{h} giờ {m} phút", { h, m: m % 60 }) : tr("{h} giờ", { h })) : tr("{n} ngày", { n: Math.round(h / 24) });
  };
  function renderPlans(box) {
    const head = el("div", "ranges");
    head.append(el("b", null, tr("Gói đăng ký còn lại")), btn(tr("Làm mới"), () => send({ type: "refreshPlans" }), "small"));
    box.append(head);
    if (!state.plans.length) { box.append(el("p", "meta", tr("Chưa có số liệu hạn mức."))); return; }
    for (const p of state.plans) {
      const warnAt = state.accounts.find((a) => a.id === p.account)?.warnAtPercent ?? 80;
      const card = el("div", "plan-card " + (p.state === "limited" ? "over" : p.state === "warning" ? "warn" : ""));
      const title = el("div", "meta");
      title.append(el("b", null, p.account), el("span", null, p.plan ? tr("{provider} · gói {plan}", { provider: p.provider, plan: p.plan }) : p.provider));
      if (p.fetchedAt) title.append(el("span", "tag", (Date.now() - p.fetchedAt > 30 * 60000 ? tr("⚠ cũ: ") : "") + ago(p.fetchedAt)));
      card.append(title);
      for (const w of p.windows) {
        const left = Math.max(0, 100 - w.usedPercent);
        const row = el("div", "plan-row");
        row.append(el("span", "plan-label", w.label));
        const track = el("span", "bar-track wide");
        const fill = el("span", "bar-fill" + (w.usedPercent >= 100 ? " over" : w.usedPercent >= warnAt ? " warn" : ""));
        fill.style.width = Math.min(100, w.usedPercent) + "%";
        track.append(fill);
        row.append(track, el("span", "plan-left", tr("còn {n}%", { n: left.toFixed(0) })));
        if (w.resetsAt) row.append(el("span", "tag", tr("reset sau {t}", { t: until(w.resetsAt) })));
        card.append(row);
      }
      if (p.note) card.append(el("div", "meta" + (p.state === "error" ? " err" : ""), p.note));
      box.append(card);
    }
    box.append(el("p", "note", tr("Các nhà cung cấp chỉ báo phần trăm đã dùng của mỗi cửa sổ, không báo số token tuyệt đối. Số liệu cập nhật định kỳ và sau mỗi lượt chạy.")));
  }

  function renderCost() {
    const box = $("cost");
    box.replaceChildren();
    renderPlans(box);
    const bar = el("div", "ranges");
    for (const [k, label] of [["today", tr("Hôm nay")], ["7d", tr("7 ngày")], ["30d", tr("30 ngày")]]) {
      const b = btn(label, () => send({ type: "setRange", range: k }), state.range === k ? "small on" : "small");
      bar.append(b);
    }
    box.append(bar);

    for (const a of state.accounts.filter((x) => x.budgetUsdPerDay)) {
      const pct = Math.min(100, (a.spentToday / a.budgetUsdPerDay) * 100);
      const row = el("div", "budget" + (pct >= 100 ? " over" : pct >= 80 ? " warn" : ""));
      row.append(el("div", "meta", tr("{id}: {spent} / {budget} hôm nay ({pct}%)", { id: a.id, spent: usd(a.spentToday), budget: usd(a.budgetUsdPerDay), pct: pct.toFixed(0) }) + (a.paused ? " — " + tr("ĐANG TẠM DỪNG") : "")));
      const track = el("div", "bar-track wide");
      const fill = el("span", "bar-fill");
      fill.style.width = pct + "%";
      track.append(fill);
      row.append(track);
      if (a.paused) row.append(btn(tr("Cho chạy tiếp hôm nay"), () => send({ type: "allowBudget", account: a.id }), "small"));
      box.append(row);
    }

    const u = state.usage;
    if (!u) { box.append(el("p", "empty", tr("Chưa có số liệu."))); return; }
    const t = u.summary.totals;
    const grid = el("div", "cards");
    const card = (label, value, sub) => { const c = el("div", "stat"); c.append(el("div", "stat-v", value), el("div", "stat-l", label)); if (sub) c.append(el("div", "stat-s", sub)); grid.append(c); };
    card(tr("Chi phí"), (t.estimated ? "≈ " : "") + usd(t.costUsd), t.estimated ? tr("gồm ước tính Codex") : undefined);
    card("Token", tok(t.input + t.output + t.cacheRead + t.cacheWrite), tr("vào {i} · ra {o}", { i: tok(t.input), o: tok(t.output) }));
    card(tr("Số lượt"), String(t.turns), t.errors ? tr("{n} lỗi", { n: t.errors }) : tr("không lỗi"));
    card("Cache hit", (t.cacheHitRate * 100).toFixed(0) + "%", tr("{n} token từ cache", { n: tok(t.cacheRead) }));
    box.append(grid);
    box.append(el("p", "note", tr("Chi phí là giá trị tương đương theo giá API. Với account gói subscription, hãy nhìn token và số lượt.")));
    if (t.unpriced) box.append(el("p", "note", tr("{n} lượt chưa có chi phí (model chưa có trong cài đặt agentroom.pricing).", { n: t.unpriced })));

    const money = { value: (r) => r.costUsd || r.tokens / 1e9, label: (r) => `${r.costUsd ? (r.estimated ? "≈ " : "") + usd(r.costUsd) : "—"} · ${tok(r.tokens)}` };
    box.append(bars(tr("Theo worker"), u.summary.byWorker, money), bars(tr("Theo account"), u.summary.byAccount, money), bars(tr("Theo model"), u.summary.byModel, money), bars(tr("Theo task"), u.summary.byTask, money, 10));
    const tools = Object.entries(u.summary.tools).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
    box.append(bars(tr("Tool được gọi"), tools, { value: (r) => r.n, label: (r) => String(r.n) }, 10));
  }

  // ---------- schedules & webhooks ----------
  const RESULT = { fired: tr("đã chạy"), busy: tr("bỏ qua (lần trước chưa xong)"), missed: tr("lỡ quá lâu, bỏ qua"), manual: tr("chạy tay"), error: tr("lỗi") };

  function renderSched() {
    const box = $("sched");
    box.replaceChildren();
    const h1 = el("h4", null, tr("Lịch chạy ({n})", { n: state.schedules.length }));
    box.append(h1);
    if (!state.schedules.length) box.append(el("p", "note", tr("Chưa có lịch. Thêm mục schedules vào .agentroom/workers.yaml (xem mẫu đã comment trong file). Lịch chỉ chạy khi VS Code đang mở.")));
    for (const s of state.schedules) {
      const card = el("div", "task" + (s.enabled ? "" : " off"));
      const head = el("div", "row");
      head.append(el("b", null, s.id), el("span", "tag", s.worker === "*" ? tr("mọi worker") : "@" + s.worker));
      const tgl = btn(s.enabled ? tr("Tắt") : tr("Bật"), () => send({ type: "toggleSchedule", id: s.id, enabled: !s.enabled }));
      const run = btn(tr("Chạy ngay"), () => send({ type: "runSchedule", id: s.id }));
      head.append(tgl, run);
      card.append(head);
      card.append(el("div", "meta", `${s.description}${s.timezone ? " (" + s.timezone + ")" : ""}${s.builtin ? " · " + s.builtin : ""}`));
      card.append(el("div", "meta", s.enabled ? tr("Lần tới: {t}", { t: when(s.nextRun) }) : tr("Đang tắt")));
      card.append(el("div", "meta", tr("Lần trước: {t}", { t: when(s.lastRun) }) + (s.lastResult ? " — " + (RESULT[s.lastResult] || s.lastResult) : "")));
      if (s.error) card.append(el("div", "meta err", s.error));
      box.append(card);
    }

    box.append(el("h4", null, `Webhook (${state.hooks.hooks.length})`));
    if (!state.hooks.hooks.length) box.append(el("p", "note", tr("Chưa có webhook. Mặc định chỉ nhận trên 127.0.0.1; cần secretEnv (HMAC).")));
    for (const h of state.hooks.hooks) {
      const card = el("div", "task");
      const head = el("div", "row");
      head.append(el("b", null, h.id), el("span", "tag", "@" + h.worker), el("span", "tag" + (h.readOnly ? " ro" : ""), h.readOnly ? tr("chỉ đọc") : tr("ghi được")));
      if (h.url) head.append(btn("Copy URL", () => send({ type: "copyHook", id: h.id })));
      card.append(head);
      card.append(el("div", "meta", `${h.status} · ` + tr("tối đa {n}/giờ", { n: h.maxPerHour })));
      if (h.url) card.append(el("div", "meta mono", h.url));
      box.append(card);
    }
    if (state.hooks.calls.length) {
      box.append(el("h4", null, tr("20 lần gọi gần nhất")));
      for (const c of state.hooks.calls) {
        const line = el("div", "meta call" + (c.status >= 400 ? " err" : ""));
        line.textContent = `${new Date(c.ts).toLocaleTimeString()} · ${c.hook} · ${c.status}${c.note ? " · " + c.note : ""}`;
        box.append(line);
      }
    }
  }

  // ---------- profile ----------
  function openProfile(workerId) {
    state.profileWorker = workerId;
    showTab("profile");
    send({ type: "getProfile", workerId });
  }

  function renderProfile() {
    const box = $("profile");
    box.replaceChildren();

    if (state.drafts.length) {
      box.append(el("h4", null, tr("Skill do agent đề xuất ({n})", { n: state.drafts.length })));
      for (const d of state.drafts) {
        const card = el("div", "task draft");
        card.append(el("b", null, d.name), el("span", "tag", "do @" + d.proposedBy));
        card.append(el("div", "meta", d.description));
        card.append(el("pre", "mono", d.body.slice(0, 1200)));
        const row = el("div", "row");
        row.append(btn(tr("Duyệt"), () => send({ type: "approveSkill", name: d.name })), btn(tr("Bỏ"), () => send({ type: "rejectSkill", name: d.name })));
        card.append(row);
        box.append(card);
      }
    }

    const pick = el("select");
    for (const w of state.workers) { const o = el("option", null, `${w.name} (@${w.id})`); o.value = w.id; if (w.id === state.profileWorker) o.selected = true; pick.append(o); }
    pick.onchange = () => openProfile(pick.value);
    box.append(pick);
    box.append(btn(tr("+ Tạo skill mới"), () => send({ type: "newSkill" })));

    const p = state.profile;
    const w = state.workers.find((x) => x.id === state.profileWorker);
    if (!w) return;
    box.append(el("div", "meta", `${w.role} · ${w.provider} · account ${w.account}${w.skills.length ? " · " + w.skills.join(", ") : ""}`));
    if (!p || p.id !== w.id) { box.append(el("p", "note", tr("Đang tải…"))); return; }

    const files = el("div", "row");
    for (const [kind, label] of [["soul", "SOUL.md"], ["memory", "MEMORY.md"], ["journal", tr("Nhật ký hôm nay")], ["team", tr("Trí nhớ đội")]]) {
      files.append(btn(label, () => send({ type: "openFile", workerId: w.id, kind })));
    }
    box.append(files);

    box.append(el("h4", null, tr("Skills đang bật (useSkills)")));
    if (!p.skills.length) box.append(el("div", "meta", tr("Chưa bật skill thật nào. Thêm useSkills vào workers.yaml.")));
    for (const s of p.skills) {
      const line = el("div", "meta" + (s.ok ? "" : " err"));
      line.textContent = s.ok ? `✓ ${s.name} — ${s.description}` : `✗ ${s.name} — ` + tr("không tìm thấy");
      box.append(line);
    }

    box.append(el("h4", null, tr("Trí nhớ mới nhất")));
    if (!p.recentMemory.length) box.append(el("div", "meta", tr("Chưa có mục nào. Agent tự ghi bằng tool remember.")));
    for (const e of p.recentMemory) {
      const line = el("div", "meta");
      line.textContent = `[${e.id}] ${e.date} · ${e.kind} · ${e.text}`;
      box.append(line);
    }
  }

  // ---------- hosts ----------
  const HOST_STATE = { idle: tr("chưa kết nối"), connecting: tr("đang kết nối…"), ready: tr("sẵn sàng"), error: tr("lỗi") };

  const PHASE = {
    disabled: tr("chưa bật"), "no-token": tr("chưa có token"), starting: tr("đang kết nối…"), running: tr("đang chạy"), retrying: tr("mất mạng, đang thử lại…"),
    conflict: tr("xung đột: nơi khác đang nhận tin của bot"), error: tr("lỗi"), stopped: tr("đã dừng"),
  };
  const DETAIL = { summary: tr("tóm tắt"), full: tr("toàn văn"), alerts: tr("chỉ cảnh báo") };

  function renderTelegram(box) {
    const t = state.telegram;
    box.append(el("h4", null, tr("Điện thoại (Telegram)")));
    if (!t) { box.append(el("p", "note", tr("Telegram chưa khả dụng."))); return; }
    const card = el("div", "task tg " + t.phase);
    const head = el("div", "row");
    head.append(el("span", "dot " + (t.phase === "running" ? "ready" : t.phase === "error" || t.phase === "conflict" ? "error" : t.phase === "disabled" || t.phase === "no-token" ? "" : "connecting")), el("b", null, t.bot || "Bot Telegram"), el("span", "meta", PHASE[t.phase] || t.phase));
    card.append(head);
    if (t.phase === "disabled" || t.phase === "no-token") {
      card.append(el("div", "meta", tr("Điều khiển và nhận thông báo từ điện thoại qua một bot Telegram RIÊNG (không dùng chung với chương trình khác). Token lưu trong kho bí mật của VS Code.")));
      card.append(btn(t.phase === "no-token" ? tr("Nhập token") : tr("Thiết lập"), () => send({ type: "telegramAction", action: "setup" })));
      box.append(card);
      return;
    }
    if (t.error) card.append(el("div", "meta err", t.error));
    card.append(el("div", "meta", t.paired ? tr("Đã ghép cặp: {name}", { name: t.paired.name }) : tr("Chưa ghép cặp với điện thoại nào")));
    if (t.pairing) {
      const left = Math.max(0, Math.round((t.pairing.expiresAt - Date.now()) / 60000));
      card.append(el("div", "meta mono", tr("Gửi cho bot trong chat riêng:  /pair {code}   (còn ~{n} phút)", { code: t.pairing.code, n: left })));
    }
    card.append(el("div", "meta", tr("Gửi về: {detail} · PIN: {pin}", { detail: DETAIL[t.detail] || t.detail, pin: t.pin ? tr("đã đặt") : tr("chưa") }) + (t.mutedUntil ? " · " + tr("đang tắt tiếng") : "")));
    const row = el("div", "row");
    if (t.paired) row.append(btn(tr("Ngắt ghép cặp"), () => send({ type: "telegramAction", action: "unpair" })));
    else row.append(btn(tr("Tạo mã ghép cặp"), () => send({ type: "telegramAction", action: "pair" })));
    row.append(btn(t.pin ? tr("Đổi/bỏ PIN") : tr("Đặt PIN"), () => send({ type: "telegramAction", action: "setPin" })));
    if (t.phase === "error" || t.phase === "conflict") row.append(btn(tr("Thiết lập lại"), () => send({ type: "telegramAction", action: "setup" })));
    row.append(btn(tr("Tắt"), () => send({ type: "telegramAction", action: "disable" })));
    card.append(row);
    box.append(card);
  }

  function renderHosts() {
    const box = $("hosts");
    box.replaceChildren();
    renderTelegram(box);
    const local = state.workers.filter((w) => !w.host);
    box.append(el("h4", null, tr("Máy này")));
    box.append(el("div", "meta", local.length ? local.map((w) => "@" + w.id).join(", ") : tr("(không có worker nào chạy ở máy này)")));

    box.append(el("h4", null, tr("Máy từ xa ({n})", { n: state.hostList.length })));
    if (!state.hostList.length) {
      box.append(el("p", "note", tr("Chưa có máy từ xa. Thêm mục hosts: vào .agentroom/workers.yaml rồi gán host: cho account (xem docs/MULTI-MACHINE.md). Cần khoá SSH, Node ≥ 20 và claude/codex đã đăng nhập trên máy đó.")));
      return;
    }
    box.append(btn(tr("Kiểm tra tất cả"), () => send({ type: "hostCheck" })));
    for (const h of state.hostList) {
      const card = el("div", "task host-card " + h.state);
      const head = el("div", "row");
      head.append(el("span", "dot " + h.state), el("b", null, h.name), el("span", "tag", h.ssh), el("span", "meta", HOST_STATE[h.state] || h.state));
      head.append(btn(h.state === "ready" ? tr("Kiểm tra lại") : tr("Kết nối"), () => send({ type: "hostCheck", name: h.name })));
      card.append(head);
      if (h.state === "ready") {
        card.append(el("div", "meta", `${h.hostname || "?"} · ${h.platform || "?"} · node ${h.node || "?"}`));
        card.append(el("div", "meta" + (h.claude ? "" : " err"), `claude: ${h.claude || tr("không tìm thấy (đặt hosts.{name}.claudePath)", { name: h.name })}`));
        card.append(el("div", "meta" + (h.codex ? "" : " warn"), `codex: ${h.codex || tr("không tìm thấy")}`));
      }
      if (h.error) card.append(el("div", "meta err", h.error));
      if (h.repo) card.append(el("div", "meta mono", "repo: " + h.repo));
      const on = state.workers.filter((w) => w.host === h.name);
      card.append(el("div", "meta", `Worker: ${on.length ? on.map((w) => "@" + w.id).join(", ") : tr("(chưa có)")}${h.inFlight ? " · " + tr("đang chạy {n} lượt", { n: h.inFlight }) : ""}`));
      box.append(card);
    }
  }

  function renderLocked(holder) {
    const chat = $("chat");
    chat.replaceChildren();
    const card = el("div", "task locked");
    const daemon = holder.kind === "daemon";
    card.append(el("b", null, daemon ? tr("Phòng này đang chạy bằng chương trình nền (daemon)") : tr("Phòng này đang chạy ở một cửa sổ khác")));
    const age = holder.heartbeat ? Math.max(0, Math.round((Date.now() - holder.heartbeat) / 1000)) : null;
    card.append(el("div", "meta", tr("Máy {host}, pid {pid}", { host: holder.host, pid: holder.pid }) + (holder.startedAt ? tr(", từ {t}", { t: when(holder.startedAt) }) : "") + (age != null ? tr(", tín hiệu cuối {n}s trước", { n: age }) : "") + "."));
    card.append(el("p", "note", tr("Chỉ một cửa sổ được điều phối mỗi thư mục .agentroom/: nếu hai cửa sổ cùng chạy, chat, bảng task và giới hạn account sẽ lệch nhau. Hãy dùng cửa sổ kia, hoặc chiếm quyền (cửa sổ kia sẽ tự dừng).") + (daemon ? " " + tr("Chiếm quyền sẽ dừng daemon: Telegram, lịch và webhook của daemon ngừng cho tới khi bạn khởi động lại nó (chạy lại daemon sẽ chiếm lại phòng).") : "")));
    card.append(btn(tr("Chiếm quyền điều phối"), () => send({ type: "takeOver" })));
    chat.append(card);
  }

  // ---------- approvals ----------
  function renderApproval(req) {
    const card = el("div", "approval");
    card.id = "ap-" + req.id;
    card.append(el("b", null, tr("{name} muốn dùng {tool}", { name: nameOf(req.workerId), tool: req.tool })));
    if (req.reason) card.append(el("div", "meta warn", req.reason));
    card.append(el("pre", null, JSON.stringify(req.input, null, 2).slice(0, 2000)));
    const yes = el("button", "allow", tr("Cho phép"));
    const no = el("button", "deny", tr("Từ chối"));
    yes.onclick = () => send({ type: "approve", id: req.id, allow: true });
    no.onclick = () => send({ type: "approve", id: req.id, allow: false });
    card.append(yes, no);
    $("approvals").append(card);
  }

  function insertMention(id) {
    const input = $("input");
    input.value = (input.value && !input.value.endsWith(" ") ? input.value + " " : input.value) + "@" + id + " ";
    input.focus();
  }

  // ---------- settings ----------
  // Every label and help text comes from the host (already in the user's language); the host also validates every change.
  const GROUP_TITLE = { storage: tr("Lưu trữ"), room: tr("Phòng"), cli: tr("Công cụ dòng lệnh") };
  const SOURCE_LABEL = { workspace: tr("đã đặt cho project này"), user: tr("đã đặt cho bạn") };
  function renderSettings() {
    const box = $("settings");
    box.replaceChildren();
    const s = state.settings;
    if (!s) { box.append(el("p", "note", tr("Đang tải cài đặt…"))); return; }
    if (s.error) box.append(el("p", "note err", s.error));
    if (s.reloadNeeded.length) {
      const bar = el("div", "row");
      bar.append(el("span", "note", tr("Có thay đổi chỉ áp dụng sau khi tải lại cửa sổ.")), btn(tr("Tải lại cửa sổ"), () => send({ type: "reloadWindow" })));
      box.append(bar);
    }
    box.append(el("h4", null, tr("Đang chạy")));
    const rt = s.runtime;
    box.append(el("div", "meta", `AgentRoom ${rt.version}`));
    if (rt.storage) {
      const same = rt.storage.requested === rt.storage.active;
      box.append(el("div", "meta" + (rt.storage.error ? " err" : ""), tr("Lưu trữ: đã chọn {requested}, đang dùng {active}", { requested: rt.storage.requested, active: rt.storage.active }) + (same ? "" : " (" + tr("verify chỉ đối chiếu, file vẫn là bản chính") + ")") + (rt.storage.error ? " — " + rt.storage.error : "")));
    }
    for (const group of ["storage", "room", "cli"]) {
      const items = s.items.filter((i) => i.group === group);
      if (!items.length) continue;
      box.append(el("h4", null, GROUP_TITLE[group]));
      for (const it of items) box.append(settingRow(it));
    }
    box.append(el("h4", null, tr("Giới hạn (trong workers.yaml)")));
    if (rt.limits) {
      const L = rt.limits;
      box.append(el("div", "meta", `chainTurns ${L.chainTurns} · maxFanout ${L.maxFanout} · turnIdleMinutes ${L.turnIdleMinutes} · idleFreshMinutes ${L.idleFreshMinutes} · maxModelTurns ${L.maxModelTurns}${L.usdPerTask ? " · usdPerTask " + L.usdPerTask : ""}`));
    }
    box.append(el("p", "note", tr("Các giới hạn, model theo độ khó (levels) và fallback nằm trong workers.yaml, không sửa ở đây để không ghi đè file của bạn.")), btn(tr("Mở workers.yaml"), () => send({ type: "openConfig" })));
    box.append(el("p", "note", tr("Daemon có cài đặt riêng: agentroom-daemon set storageMode legacy|verify|durable.")));
  }
  function settingRow(it) {
    const row = el("div", "setting");
    row.append(el("div", "slabel", it.label));
    row.append(el("div", "meta", it.help));
    const line = el("div", "row");
    const commit = (value) => send({ type: "setSetting", key: it.key, value });
    let ctl;
    if (it.kind === "enum") {
      ctl = el("select");
      for (const o of it.options) { const opt = el("option", null, o); opt.value = o; ctl.append(opt); }
      ctl.value = String(it.value);
      ctl.onchange = () => commit(ctl.value);
    } else if (it.kind === "bool") {
      ctl = el("input"); ctl.type = "checkbox"; ctl.checked = !!it.value;
      ctl.onchange = () => commit(ctl.checked);
    } else {
      ctl = el("input"); ctl.type = it.kind === "int" ? "number" : "text"; ctl.value = String(it.value);
      if (it.kind === "int") { if (it.min != null) ctl.min = String(it.min); if (it.max != null) ctl.max = String(it.max); }
      ctl.onchange = () => commit(ctl.value);
    }
    line.append(ctl);
    if (it.source !== "default") {
      line.append(el("span", "tag", SOURCE_LABEL[it.source]), btn(tr("Mặc định"), () => send({ type: "resetSetting", key: it.key })));
    }
    if (it.apply === "reload") line.append(el("span", "tag", tr("cần tải lại")));
    row.append(line);
    return row;
  }

  // ---------- tabs ----------
  function showTab(name) {
    document.querySelectorAll("nav button[data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
    document.querySelectorAll(".tab").forEach((t) => { t.hidden = t.id !== name; });
    if (name === "profile" && !state.profileWorker && state.workers.length) openProfile(state.workers[0].id);
    if (name === "settings") send({ type: "getSettings" });
  }
  document.querySelectorAll("nav button[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("flag")?.addEventListener("click", () => send({ type: "reportIssue" }));

  function badge() {
    const b = $("draftBadge");
    b.hidden = !state.drafts.length;
    b.textContent = state.drafts.length ? String(state.drafts.length) : "";
  }

  window.addEventListener("message", ({ data }) => {
    switch (data.type) {
      case "init": {
        $("chat").replaceChildren();
        $("approvals").replaceChildren();
        state.byId.clear(); state.answers.clear(); clearReply();
        if (!data.state) {
          $("chat").append(el("p", "empty", tr("Chưa có .agentroom/workers.yaml. Chạy lệnh “AgentRoom: Tạo cấu hình workers mẫu”.")));
          state.workers = []; renderTeam(); return;
        }
        const s = data.state;
        state.workers = s.workers;
        state.statuses = Object.fromEntries(s.statuses.map((x) => [x.id, x]));
        state.tasks = s.tasks;
        state.drafts = s.drafts;
        state.accounts = s.accounts;
        state.todayByWorker = s.todayByWorker;
        state.plans = s.plans || [];
        if (data.usage) { state.usage = data.usage; state.range = data.usage.range; }
        state.schedules = data.schedules || [];
        state.hooks = data.hooks || state.hooks;
        state.hostList = data.hosts ? data.hosts.hosts : [];
        state.telegram = data.telegram ? data.telegram.status : null;
        state.panels = data.panels || [];
        s.messages.forEach(renderMessage);
        s.approvals.forEach(renderApproval);
        renderTeam(); renderTasks(); renderCost(); renderSched(); renderHosts(); renderProfile(); renderPanels(); badge();
        break;
      }
      case "message": renderMessage(data.msg); break;
      case "status": state.statuses[data.status.id] = data.status; renderTeam(); break;
      case "tasks": state.tasks = data.tasks; renderTasks(); break;
      case "plans": state.plans = data.plans; renderCost(); break;
      case "workers": state.workers = data.workers; renderTeam(); break;
      case "optionError": document.querySelector(`.options[data-msg="${CSS.escape(data.messageId)}"]`)?.querySelectorAll("button").forEach((b) => (b.disabled = false)); break;
      case "approval": renderApproval(data.req); break;
      case "approvalResolved": $("ap-" + data.id)?.remove(); break;
      case "usage": state.usage = data; state.range = data.range; state.accounts = data.accounts; state.todayByWorker = data.todayByWorker; renderTeam(); renderCost(); renderTasks(); break;
      case "drafts": state.drafts = data.drafts; badge(); renderProfile(); break;
      case "schedules": state.schedules = data.schedules; renderSched(); break;
      case "hooks": state.hooks = data; renderSched(); break;
      case "hosts": state.hostList = data.hosts; renderHosts(); break;
      case "telegram": state.telegram = data.status || null; renderHosts(); break;
      case "panels": state.panels = data.panels || []; renderPanels(); break;
      case "panelResult": panelResult(data); break;
      case "settings": state.settings = data; renderSettings(); break;
      case "locked": renderLocked(data.holder); break;
      case "profile": state.profile = data.profile; renderProfile(); break;
    }
  });

  // Panels contributed by plugins: a tab each, made of titled sections of text rows. Plain text only (textContent).
  // Forms and buttons of plugin panels. Everything is built with textContent/value (no HTML from plugins), and what the
  // person types is kept in `ui.drafts` so the periodic re-render (panels are refreshed when their data changes) never eats it.
  const ui = { open: new Set(), drafts: new Map(), confirming: new Set(), pending: new Set(), status: new Map() };
  const fkey = (panel, action, args) => panel + "|" + action + "|" + JSON.stringify(args || {});

  function buildForm(panel, action, args, form, title, inline) {
    const key = fkey(panel, action, args);
    const draft = ui.drafts.get(key) || {};
    const box = el("form", "pf");
    if (title) box.append(el("div", "pf-title", String(title)));
    const read = () => {
      const v = {};
      for (const f of form.fields || []) {
        if (f.type === "multiselect") v[f.name] = [...box.querySelectorAll(`input[data-f="${CSS.escape(f.name)}"]:checked`)].map((i) => i.value);
        else v[f.name] = box.querySelector(`[data-f="${CSS.escape(f.name)}"]`)?.value ?? "";
      }
      return v;
    };
    for (const f of form.fields || []) {
      const wrap = el("div", "pf-field");
      wrap.append(el("label", "pf-label", String(f.label) + (f.required ? " *" : "")));
      const cur = draft[f.name] !== undefined ? draft[f.name] : f.value;
      let ctl;
      if (f.type === "select") {
        ctl = el("select", "pf-ctl");
        const none = el("option", null, "—"); none.value = ""; ctl.append(none);
        for (const o of f.options || []) { const op = el("option", null, String(o.label || o.value)); op.value = String(o.value); ctl.append(op); }
        ctl.value = cur === undefined ? "" : String(cur);
      } else if (f.type === "multiselect") {
        ctl = el("div", "pf-multi");
        const picked = new Set(Array.isArray(cur) ? cur : []);
        for (const o of f.options || []) {
          const row = el("label", "pf-check");
          const cb = el("input"); cb.type = "checkbox"; cb.value = String(o.value); cb.dataset.f = f.name; cb.checked = picked.has(o.value);
          row.append(cb, " ", String(o.label || o.value));
          ctl.append(row);
        }
        if (!(f.options || []).length) ctl.append(el("span", "meta", "—"));
      } else {
        ctl = el(f.type === "textarea" ? "textarea" : "input", "pf-ctl");
        if (f.type === "textarea") ctl.rows = 3; else ctl.type = "text";
        ctl.maxLength = f.max || (f.type === "textarea" ? 2000 : 200);
        if (f.placeholder) ctl.placeholder = String(f.placeholder);
        ctl.value = cur === undefined ? "" : String(cur);
      }
      if (f.type !== "multiselect") ctl.dataset.f = f.name;
      wrap.append(ctl);
      if (f.help) wrap.append(el("div", "meta", String(f.help)));
      box.append(wrap);
    }
    box.addEventListener("input", () => ui.drafts.set(key, read()));
    box.addEventListener("change", () => ui.drafts.set(key, read()));
    const actions = el("div", "pf-actions");
    const go = el("button", "small", String(form.submit));
    go.type = "submit"; go.disabled = ui.pending.has(key);
    actions.append(go);
    if (inline) actions.append(btn(tr("Hủy"), () => { ui.open.delete(key); renderPanels(true); }));
    box.append(actions);
    box.addEventListener("submit", (e) => {
      e.preventDefault();
      ui.pending.add(key); go.disabled = true;
      send({ type: "panelAction", panel, action, values: { ...read(), __args: args || {} } });
    });
    return box;
  }

  function actionButton(panel, a, host) {
    const key = fkey(panel, a.id, a.args);
    const cls = "small" + (a.danger ? " danger" : "");
    if (a.form) return btn(String(a.label), () => { if (ui.open.has(key)) ui.open.delete(key); else ui.open.add(key); renderPanels(true); }, cls + (ui.open.has(key) ? " on" : ""));
    if (a.confirm && ui.confirming.has(key)) {
      const span = el("span", "pf-confirm", tr("Chắc chắn?") + " ");
      span.append(btn(tr("Có"), () => { ui.confirming.delete(key); ui.pending.add(key); send({ type: "panelAction", panel, action: a.id, values: { __args: a.args || {} } }); renderPanels(true); }, "small danger"), " ", btn(tr("Không"), () => { ui.confirming.delete(key); renderPanels(true); }));
      return span;
    }
    const b = btn(String(a.label), () => {
      if (a.confirm) { ui.confirming.add(key); renderPanels(true); return; }
      ui.pending.add(key); send({ type: "panelAction", panel, action: a.id, values: { __args: a.args || {} } }); renderPanels(true);
    }, cls);
    b.disabled = ui.pending.has(key);
    return b;
  }

  function panelResult(d) {
    for (const k of [...ui.pending]) if (k.startsWith(d.panel + "|" + d.action + "|")) ui.pending.delete(k);
    if (d.ok) for (const k of [...ui.open, ...ui.drafts.keys()]) if (k.startsWith(d.panel + "|" + d.action + "|")) { ui.open.delete(k); ui.drafts.delete(k); }
    ui.status.set(d.panel, { ok: !!d.ok, message: String(d.message || "") });
    renderPanels(true);
    setTimeout(() => { ui.status.delete(d.panel); renderPanels(); }, 8000);
  }

  document.addEventListener("focusout", () => { if (ui.deferred) setTimeout(() => { if (!document.activeElement?.closest?.(".pf")) renderPanels(); }, 60); });

  // Panels contributed by plugins: a tab each, made of titled sections of text rows, buttons and forms.
  function renderPanels(force) {
    // Do not rebuild under the person's fingers: while they are typing in a form, wait until they leave it.
    const ae = document.activeElement;
    if (!force && ae && ae.closest && ae.closest("section[data-plugin] .pf")) { ui.deferred = true; return; }
    ui.deferred = false;
    const nav = document.querySelector("nav");
    const keep = new Set(state.panels.map((p) => "panel-" + p.id));
    document.querySelectorAll("nav button[data-plugin], section[data-plugin]").forEach((n) => {
      if (!keep.has(n.dataset.plugin)) n.remove();
    });
    for (const p of state.panels) {
      const key = "panel-" + p.id;
      let sec = document.querySelector(`section[data-plugin="${CSS.escape(key)}"]`);
      if (!sec) {
        sec = el("section", "tab"); sec.id = key; sec.dataset.plugin = key; sec.hidden = true;
        $("profile").after(sec);
        const b = el("button", null, p.title); b.dataset.tab = key; b.dataset.plugin = key;
        b.addEventListener("click", () => showTab(key));
        nav.insertBefore(b, $("flag"));
      }
      const tabBtn = nav.querySelector(`button[data-plugin="${CSS.escape(key)}"]`);
      tabBtn.textContent = p.title;
      if (p.badge) tabBtn.append(" ", el("span", "badge", String(p.badge)));
      // keep what the person is typing: scroll position survives, form values come from `ui.drafts`
      const top = sec.scrollTop;
      sec.replaceChildren();
      const st = ui.status.get(p.id);
      if (st) sec.append(el("div", "pf-status " + (st.ok ? "ok" : "err"), st.message));
      for (const s of p.sections || []) {
        sec.append(el("h4", null, String(s.title)));
        if (!(s.rows || []).length && !s.form) sec.append(el("div", "meta", "—"));
        for (const r of s.rows || []) {
          const row = el("div", "meta" + (r.level === "error" ? " err" : r.level === "warn" ? " warn" : ""), String(r.text));
          if (r.tag) row.prepend(el("span", "tag", String(r.tag)), " ");
          sec.append(row);
          if ((r.actions || []).length) {
            const bar = el("div", "pf-actions");
            for (const a of r.actions) bar.append(actionButton(p.id, a), " ");
            sec.append(bar);
            for (const a of r.actions) if (a.form && ui.open.has(fkey(p.id, a.id, a.args))) sec.append(buildForm(p.id, a.id, a.args, a.form, a.label, true));
          }
        }
        if ((s.actions || []).length) {
          const bar = el("div", "pf-actions");
          for (const a of s.actions) bar.append(actionButton(p.id, a), " ");
          sec.append(bar);
          for (const a of s.actions) if (a.form && ui.open.has(fkey(p.id, a.id, a.args))) sec.append(buildForm(p.id, a.id, a.args, a.form, a.label, true));
        }
        if (s.form) sec.append(buildForm(p.id, s.form.id, {}, s.form, s.form.title, false));
      }
      sec.scrollTop = top;
    }
  }

  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text) { send({ type: "send", text, ...(state.replyTo ? { replyTo: state.replyTo } : {}) }); clearReply(); }
      e.target.value = "";
    }
  });

  send({ type: "ready" });
})();
