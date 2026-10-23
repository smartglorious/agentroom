// AgentRoom webview. Pure rendering: all state lives in the extension host.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const state = { workers: [], statuses: {}, tasks: [], approvals: {} };

  const STATE_LABEL = {
    idle: "rảnh", queued: "chờ lượt", working: "đang làm", waiting_approval: "chờ duyệt",
    rate_limited: "hết quota", error: "lỗi",
  };

  const nameOf = (id) => id === "user" ? "Bạn" : id === "system" ? "Hệ thống" : (state.workers.find((w) => w.id === id)?.name ?? id);
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function renderTeam() {
    const team = $("team");
    team.replaceChildren();
    for (const w of state.workers) {
      const s = state.statuses[w.id] || { state: "idle" };
      const card = el("div", `worker ${s.state}`);
      card.title = `${w.role} · ${w.provider}${w.skills.length ? " · " + w.skills.join(", ") : ""}`;
      card.append(el("span", "dot"), el("b", null, w.name), el("span", "id", "@" + w.id));
      card.append(el("span", "state", STATE_LABEL[s.state] + (s.activity ? ` — ${s.activity}` : "")));
      if (s.state !== "idle") {
        const stop = el("button", "stop", "■");
        stop.title = "Dừng worker này";
        stop.onclick = () => vscode.postMessage({ type: "stop", workerId: w.id });
        card.append(stop);
      }
      card.onclick = (e) => { if (e.target.tagName !== "BUTTON") insertMention(w.id); };
      team.append(card);
    }
  }

  function renderMessage(m) {
    const row = el("article", `msg from-${m.from === "user" ? "user" : m.from === "system" ? "system" : "agent"}`);
    const head = el("div", "head");
    head.append(el("b", null, nameOf(m.from)));
    if (m.taskId) head.append(el("span", "tag", m.taskId));
    if (m.to.length) head.append(el("span", "to", "→ " + m.to.map(nameOf).join(", ")));
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
        card.append(el("div", "meta", `${t.assignee ? "@" + t.assignee : "chưa giao"}${t.dependsOn.length ? " · cần " + t.dependsOn.join(", ") : ""}`));
        if (t.result) card.append(el("div", "result", t.result));
        c.append(card);
      }
      box.append(c);
    }
  }

  function renderApproval(req) {
    const card = el("div", "approval");
    card.id = "ap-" + req.id;
    card.append(el("b", null, `${nameOf(req.workerId)} muốn dùng ${req.tool}`));
    card.append(el("pre", null, JSON.stringify(req.input, null, 2).slice(0, 2000)));
    const yes = el("button", "allow", "Cho phép");
    const no = el("button", "deny", "Từ chối");
    yes.onclick = () => vscode.postMessage({ type: "approve", id: req.id, allow: true });
    no.onclick = () => vscode.postMessage({ type: "approve", id: req.id, allow: false });
    card.append(yes, no);
    $("approvals").append(card);
  }

  function insertMention(id) {
    const input = $("input");
    input.value = (input.value && !input.value.endsWith(" ") ? input.value + " " : input.value) + "@" + id + " ";
    input.focus();
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
        state.workers = data.state.workers;
        state.statuses = Object.fromEntries(data.state.statuses.map((s) => [s.id, s]));
        state.tasks = data.state.tasks;
        data.state.messages.forEach(renderMessage);
        data.state.approvals.forEach(renderApproval);
        renderTeam(); renderTasks();
        break;
      }
      case "message": renderMessage(data.msg); break;
      case "status": state.statuses[data.status.id] = data.status; renderTeam(); break;
      case "tasks": state.tasks = data.tasks; renderTasks(); break;
      case "approval": renderApproval(data.req); break;
      case "approvalResolved": $("ap-" + data.id)?.remove(); break;
    }
  });

  $("input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = e.target.value.trim();
      if (text) vscode.postMessage({ type: "send", text });
      e.target.value = "";
    }
  });

  document.querySelectorAll("nav button").forEach((b) => b.addEventListener("click", () => {
    document.querySelectorAll("nav button").forEach((x) => x.classList.toggle("on", x === b));
    $("chat").hidden = b.dataset.tab !== "chat";
    $("tasks").hidden = b.dataset.tab !== "tasks";
  }));

  vscode.postMessage({ type: "ready" });
})();
