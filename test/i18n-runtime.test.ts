import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderScan } from "../src/core/cleanup";
import { getLang, setLang } from "../src/core/i18n";
import { IssueStore } from "../src/core/issues";
import { untilText, windowLabel } from "../src/core/plan";
import { describeApproval } from "../src/channels/telegram/format";
import { parseConfig } from "../src/core/config";
import { Fake, idle, makeRoom } from "./helpers";

const inLang = async (l: "vi" | "en", fn: () => unknown | Promise<unknown>) => {
  const was = getLang();
  setLang(l);
  try { await fn(); } finally { setLang(was); }
};

test("i18n runtime: the same code paths give English or Vietnamese by language, with parameters filled", async () => {
  await inLang("en", () => {
    assert.equal(windowLabel("five_hour"), "5 hours");
    assert.equal(untilText(Date.now() + 90 * 60_000, Date.now()), "1 h 30 min");
    assert.equal(renderScan([]), "No junk, temp or cache files found to clean up.");
    assert.match(describeApproval({ id: "a", workerId: "be", tool: "Bash", input: { command: "ls" }, host: "box" } as never, "Minh"), /Minh \(@be\) on machine box asks permission to use Bash/);
    const md = new IssueStore(join(mkdtempSync(join(tmpdir(), "ar-i18n-")), "i.json"), { version: "1.2.3" }).markdown();
    assert.match(md, /# AgentRoom error \/ issue report/);
    assert.match(md, /## Open \(0\)/);
  });
  await inLang("vi", () => {
    assert.equal(windowLabel("five_hour"), "5 giờ");
    assert.equal(untilText(Date.now() + 90 * 60_000, Date.now()), "1 giờ 30 phút");
    assert.match(renderScan([]), /Không thấy file rác/);
  });
});

test("i18n runtime: a system notice from the Room is in the language current when it is posted", async () => {
  const cfg = parseConfig(`accounts: { c: { provider: claude } }
workers:
  - { id: be, name: Minh, role: r, account: c, coordinator: true }
`);
  for (const [lang, expect] of [["en", /Minh \(id: be\) hit an error: boom/], ["vi", /Minh \(id: be\) gặp lỗi: boom/]] as const) {
    await inLang(lang, async () => {
      const { room } = makeRoom(new Fake(() => { throw new Error("boom"); }), { config: cfg });
      room.post("user", "@be go");
      await new Promise((r) => setTimeout(r, 60));
      await idle(room);
      assert.match(room.snapshot().messages.filter((m) => m.from === "system").map((m) => m.text).join("\n"), expect);
    });
  }
});

test("i18n runtime: the daemon accepts a language setting and rejects others", async () => {
  const { SETTING_PARSERS } = await import("../src/daemon/store");
  assert.equal(SETTING_PARSERS.language("en"), "en");
  assert.equal(SETTING_PARSERS.language("auto"), "auto");
  assert.throws(() => SETTING_PARSERS.language("fr"));
});
