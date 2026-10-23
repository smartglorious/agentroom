// AgentRoom webview. Pure rendering: all state lives in the extension host.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = {
    workers: [], statuses: {}, tasks: [], drafts: [], accounts: [], todayByWorker: {},
    usage: null, range: "today", schedules: [], hooks: { port: null, hooks: [], calls: [] },
    profile: null, profileWorker: null,
  };

  const STATE_LABEL = {
    idle: "rảnh", queued: "chờ lượt", working: "đang làm", waiting_approval: "chờ duyệt",
    rate_limited: "hết quota", over_budget: "hết ngân sách", error: "lỗi",
  };

  const nameOf = (id) => id === "user" ? "Bạn" : id === "system" ? "Hệ thống" : (state.workers.find((w) => w.id === id)?.name ?? id);
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
      const card = el("div", `worker ${s.state}`);
      card.title = `${w.role} · ${w.provider}${w.skills.length ? " · " + w.skills.join(", ") : ""}`;
      card.append(el("span", "dot"), el("b", null, w.name), el("span", "id", "@" + w.id));
      const cost = state.todayByWorker[w.id];
      if (cost > 0) card.append(el("span", "cost", usd(cost)));
      card.append(el("span", "state", STATE_LABEL[s.state] + (s.activity ? ` — ${s.activity}` : "")));
      const info = btn("ⓘ", (e) => { e.stopPropagation(); openProfile(w.id); }, "stop");
      info.title = "Hồ sơ: SOUL, trí nhớ, skills";
      card.append(info);
      if (s.state !== "idle") {
        const stop = btn("■", (e) => { e.stopPropagation(); send({ type: "stop", workerId: w.id }); }, "stop");
        stop.title = "Dừng worker này";
        card.append(stop);
      }
      card.onclick = () => insertMention(w.id);
      team.append(card);
    }
  }

  // ---------- chat ----------
  function renderMessage(m) {
    const row = el("article", `msg from-${m.from === "user" ? "user" : m.from === "system" ? "system" : "agent"}`);
    const head = el("div", "head");
    head.append(el("b", null, nameOf(m.from)));
    if (m.taskId) head.append(el("span", "tag", m.taskId));
    if (m.readOnly) head.append(el("span", "tag ro", "chỉ đọc"));
    if (m.to.length) head.append(el("span", "to", "→ " + m.to.map(nameOf).join(", ")));
    if (m.turnId) {
      const b = btn("🔍", () => send({ type: "inspect", turnId: m.turnId }), "stop");
      b.title = "Context Inspector: xem chính xác những gì đã gửi cho model ở lượt này";
      head.append(b);
    }
    head.append(el("time", null, new Date(m.ts).toLocaleTimeString()));
    const body = el("div", "body");
    // Highlight @mentions without using innerHTML.
    for (const part of m.text.split(/(@[\w-]+)/g)) body.append(part.startsWith("@") ? el("span", "mention", part) : document.createTextNode(part));
    row.append(head, body);
    const chat = $("chat");
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.append(row);
    if (atBottom) chat.scrollTop = chat.scrollHeight;
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
        card.append(el("div", "meta", `${t.assignee ? "@" + t.assignee : "chưa giao"}${t.dependsOn.length ? " · cần " + t.dependsOn.join(", ") : ""}${spent ? " · " + usd(spent) : ""}`));
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

  function renderCost() {
    const box = $("cost");
    box.replaceChildren();
    const bar = el("div", "ranges");
    for (const [k, label] of [["today", "Hôm nay"], ["7d", "7 ngày"], ["30d", "30 ngày"]]) {
      const b = btn(label, () => send({ type: "setRange", range: k }), state.range === k ? "small on" : "small");
      bar.append(b);
    }
    box.append(bar);

    for (const a of state.accounts.filter((x) => x.budgetUsdPerDay)) {
      const pct = Math.min(100, (a.spentToday / a.budgetUsdPerDay) * 100);
      const row = el("div", "budget" + (pct >= 100 ? " over" : pct >= 80 ? " warn" : ""));
      row.append(el("div", "meta", `${a.id}: ${usd(a.spentToday)} / ${usd(a.budgetUsdPerDay)} hôm nay (${pct.toFixed(0)}%)${a.paused ? " — ĐANG TẠM DỪNG" : ""}`));
      const track = el("div", "bar-track wide");
      const fill = el("span", "bar-fill");
      fill.style.width = pct + "%";
      track.append(fill);
      row.append(track);
      if (a.paused) row.append(btn("Cho chạy tiếp hôm nay", () => send({ type: "allowBudget", account: a.id }), "small"));
      box.append(row);
    }

    const u = state.usage;
    if (!u) { box.append(el("p", "empty", "Chưa có số liệu.")); return; }
    const t = u.summary.totals;
    const grid = el("div", "cards");
    const card = (label, value, sub) => { const c = el("div", "stat"); c.append(el("div", "stat-v", value), el("div", "stat-l", label)); if (sub) c.append(el("div", "stat-s", sub)); grid.append(c); };
    card("Chi phí", (t.estimated ? "≈ " : "") + usd(t.costUsd), t.estimated ? "gồm ước tính Codex" : undefined);
    card("Token", tok(t.input + t.output + t.cacheRead + t.cacheWrite), `vào ${tok(t.input)} · ra ${tok(t.output)}`);
    card("Số lượt", String(t.turns), t.errors ? `${t.errors} lỗi` : "không lỗi");
    card("Cache hit", (t.cacheHitRate * 100).toFixed(0) + "%", `${tok(t.cacheRead)} token từ cache`);
    box.append(grid);
    box.append(el("p", "note", "Chi phí là giá trị tương đương theo giá API. Với account gói subscription, hãy nhìn token và số lượt."));
    if (t.unpriced) box.append(el("p", "note", `${t.unpriced} lượt chưa có chi phí (model chưa có trong cài đặt agentroom.pricing).`));

    const money = { value: (r) => r.costUsd || r.tokens / 1e9, label: (r) => `${r.costUsd ? (r.estimated ? "≈ " : "") + usd(r.costUsd) : "—"} · ${tok(r.tokens)}` };
    box.append(bars("Theo worker", u.summary.byWorker, money), bars("Theo account", u.summary.byAccount, money), bars("Theo model", u.summary.byModel, money), bars("Theo task", u.summary.byTask, money, 10));
    const tools = Object.entries(u.summary.tools).sort((a, b) => b[1] - a[1]).map(([key, n]) => ({ key, n }));
    box.append(bars("Tool được gọi", tools, { value: (r) => r.n, label: (r) => String(r.n) }, 10));
  }

  // ---------- schedules & webhooks ----------
  const RESULT = { fired: "đã chạy", busy: "bỏ qua (lần trước chưa xong)", missed: "lỡ quá lâu, bỏ qua", manual: "chạy tay", error: "lỗi" };

  function renderSched() {
    const box = $("sched");
    box.replaceChildren();
    const h1 = el("h4", null, `Lịch chạy (${state.schedules.length})`);
    box.append(h1);
    if (!state.schedules.length) box.append(el("p", "note", "Chưa có lịch. Thêm mục schedules vào .agentroom/workers.yaml (xem mẫu đã comment trong file). Lịch chỉ chạy khi VS Code đang mở."));
    for (const s of state.schedules) {
      const card = el("div", "task" + (s.enabled ? "" : " off"));
      const head = el("div", "row");
      head.append(el("b", null, s.id), el("span", "tag", s.worker === "*" ? "mọi worker" : "@" + s.worker));
      const tgl = btn(s.enabled ? "Tắt" : "Bật", () => send({ type: "toggleSchedule", id: s.id, enabled: !s.enabled }));
      const run = btn("Chạy ngay", () => send({ type: "runSchedule", id: s.id }));
      head.append(tgl, run);
      card.append(head);
      card.append(el("div", "meta", `${s.description}${s.timezone ? " (" + s.timezone + ")" : ""}${s.builtin ? " · " + s.builtin : ""}`));
      card.append(el("div", "meta", s.enabled ? `Lần tới: ${when(s.nextRun)}` : "Đang tắt"));
      card.append(el("div", "meta", `Lần trước: ${when(s.lastRun)}${s.lastResult ? " — " + (RESULT[s.lastResult] || s.lastResult) : ""}`));
      if (s.error) card.append(el("div", "meta err", s.error));
      box.append(card);
    }

    box.append(el("h4", null, `Webhook (${state.hooks.hooks.length})`));
    if (!state.hooks.hooks.length) box.append(el("p", "note", "Chưa có webhook. Mặc định chỉ nhận trên 127.0.0.1; cần secretEnv (HMAC)."));
    for (const h of state.hooks.hooks) {
      const card = el("div", "task");
      const head = el("div", "row");
      head.append(el("b", null, h.id), el("span", "tag", "@" + h.worker), el("span", "tag" + (h.readOnly ? " ro" : ""), h.readOnly ? "chỉ đọc" : "ghi được"));
      if (h.url) head.append(btn("Copy URL", () => send({ type: "copyHook", id: h.id })));
      card.append(head);
      card.append(el("div", "meta", `${h.status} · tối đa ${h.maxPerHour}/giờ`));
      if (h.url) card.append(el("div", "meta mono", h.url));
      box.append(card);
    }
    if (state.hooks.calls.length) {
      box.append(el("h4", null, "20 lần gọi gần nhất"));
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
      box.append(el("h4", null, `Skill do agent đề xuất (${state.drafts.length})`));
      for (const d of state.drafts) {
        const card = el("div", "task draft");
        card.append(el("b", null, d.name), el("span", "tag", "do @" + d.proposedBy));
        card.append(el("div", "meta", d.description));
        card.append(el("pre", "mono", d.body.slice(0, 1200)));
        const row = el("div", "row");
        row.append(btn("Duyệt", () => send({ type: "approveSkill", name: d.name })), btn("Bỏ", () => send({ type: "rejectSkill", name: d.name })));
        card.append(row);
        box.append(card);
      }
    }

    const pick = el("select");
    for (const w of state.workers) { const o = el("option", null, `${w.name} (@${w.id})`); o.value = w.id; if (w.id === state.profileWorker) o.selected = true; pick.append(o); }
    pick.onchange = () => openProfile(pick.value);
    box.append(pick);
    box.append(btn("+ Tạo skill mới", () => send({ type: "newSkill" })));

    const p = state.profile;
    const w = state.workers.find((x) => x.id === state.profileWorker);
    if (!w) return;
    box.append(el("div", "meta", `${w.role} · ${w.provider} · account ${w.account}${w.skills.length ? " · " + w.skills.join(", ") : ""}`));
    if (!p || p.id !== w.id) { box.append(el("p", "note", "Đang tải…")); return; }

    const files = el("div", "row");
    for (const [kind, label] of [["soul", "SOUL.md"], ["memory", "MEMORY.md"], ["journal", "Nhật ký hôm nay"], ["team", "Trí nhớ đội"]]) {
      files.append(btn(label, () => send({ type: "openFile", workerId: w.id, kind })));
    }
    box.append(files);

    box.append(el("h4", null, "Skills đang bật (useSkills)"));
    if (!p.skills.length) box.append(el("div", "meta", "Chưa bật skill thật nào. Thêm useSkills vào workers.yaml."));
    for (const s of p.skills) {
      const line = el("div", "meta" + (s.ok ? "" : " err"));
      line.textContent = s.ok ? `✓ ${s.name} — ${s.description}` : `✗ ${s.name} — không tìm thấy`;
      box.append(line);
    }

    box.append(el("h4", null, "Trí nhớ mới nhất"));
    if (!p.recentMemory.length) box.append(el("div", "meta", "Chưa có mục nào. Agent tự ghi bằng tool remember."));
    for (const e of p.recentMemory) {
      const line = el("div", "meta");
      line.textContent = `[${e.id}] ${e.date} · ${e.kind} · ${e.text}`;
      box.append(line);
    }
  }

  // ---------- approvals ----------
  function renderApproval(req) {
    const card = el("div", "approval");
    card.id = "ap-" + req.id;
    card.append(el("b", null, `${nameOf(req.workerId)} muốn dùng ${req.tool}`));
    card.append(el("pre", null, JSON.stringify(req.input, null, 2).slice(0, 2000)));
    const yes = el("button", "allow", "Cho phép");
    const no = el("button", "deny", "Từ chối");
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

  // ---------- tabs ----------
  const TABS = ["chat", "tasks", "cost", "sched", "profile"];
  function showTab(name) {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
    for (const t of TABS) $(t).hidden = t !== name;
    if (name === "profile" && !state.profileWorker && state.workers.length) openProfile(state.workers[0].id);
  }
  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

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
        if (!data.state) {
          $("chat").append(el("p", "empty", "Chưa có .agentroom/workers.yaml. Chạy lệnh “AgentRoom: Tạo cấu hình workers mẫu”."));
          state.workers = []; renderTeam(); return;
        }
        const s = data.state;
        state.workers = s.workers;
        state.statuses = Object.fromEntries(s.statuses.map((x) => [x.id, x]));
        state.tasks = s.tasks;
        state.drafts = s.drafts;
        state.accounts = s.accounts;
        state.todayByWorker = s.todayByWorker;
        if (data.usage) { state.usage = data.usage; state.range = data.usage.range; }
        state.schedules = data.schedules || [];
        state.hooks = data.hooks || state.hooks;
        s.messages.forEach(renderMessage);
        s.approvals.forEach(renderApproval);
        renderTeam(); renderTasks(); renderCost(); renderSched(); renderProfile(); badge();
        break;
      }
      case "message": renderMessage(data.msg); break;
      case "status": state.statuses[data.status.id] = data.status; renderTeam(); break;
      case "tasks": state.tasks = data.tasks; renderTasks(); break;
      case "approval": renderApproval(data.req); break;
      case "approvalResolved": $("ap-" + data.id)?.remove(); break;
      case "usage": state.usage = data; state.range = data.range; state.accounts = data.accounts; state.todayByWorker = data.todayByWorker; renderTeam(); renderCost(); renderTasks(); break;
      case "drafts": state.drafts = data.drafts; badge(); renderProfile(); break;
      case "schedules": state.schedules = data.schedules; renderSched(); break;
      case "hooks": state.hooks = data; renderSched(); break;
      case "profile": state.profile = data.profile; renderProfile(); break;
    }
  });

  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text) send({ type: "send", text });
      e.target.value = "";
    }
  });

  send({ type: "ready" });
})();
