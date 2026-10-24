import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IssueStore, fingerprintOf } from "../src/core/issues";

const mk = (version = "0.11.0", extra: object = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "ar-iss-"));
  const file = join(dir, "state", "issues.json");
  return { file, store: (v = version) => new IssueStore(file, { version: v, scrub: [["/home/alice", "~"]], ...extra }) };
};

test("issues: the same problem with different numbers/paths/ids is one issue with a count", () => {
  const { store } = mk();
  const s = store();
  s.record({ kind: "error", source: "turn", title: "Mất kết nối tới host sau 12s: /home/alice/x/y.sock (pid 4411)", worker: "be" });
  s.record({ kind: "error", source: "turn", title: "Mất kết nối tới host sau 31s: /tmp/other/z.sock (pid 9)" });
  assert.equal(s.list().length, 1);
  assert.equal(s.list()[0].count, 2);
  assert.notEqual(fingerprintOf({ kind: "error", source: "turn", title: "a" }), fingerprintOf({ kind: "warning", source: "turn", title: "a" }));
});

test("issues: secrets and the home path never reach the file", () => {
  const { store, file } = mk();
  store().record({ kind: "error", source: "turn", title: "boom", detail: "token sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA at /home/alice/proj/file.ts" });
  const raw = readFileSync(file, "utf8");
  assert.ok(!raw.includes("sk-ant-api03-AAAA"), "secret scrubbed");
  assert.ok(!raw.includes("/home/alice"), "home path scrubbed");
  assert.ok(raw.includes("~/proj/file.ts"));
});

test("issues: survives a restart; fixed stays fixed until it recurs on a version >= the fixed one", () => {
  const { store } = mk();
  const a = store("0.11.0").record({ kind: "error", source: "telegram", title: "bot died" });
  assert.equal(store("0.11.0").setStatus(a.id, "fixed", "patched")!.fixedIn, "0.11.0");
  store("0.10.0").record({ kind: "error", source: "telegram", title: "bot died" });
  assert.equal(store("0.11.0").list()[0].status, "fixed", "an older version hitting it does not reopen");
  store("0.11.1").record({ kind: "error", source: "telegram", title: "bot died" });
  const it = store("0.11.1").list()[0];
  assert.equal(it.status, "open");
  assert.equal(it.reopened, 1);
  assert.deepEqual(it.versions, ["0.11.0", "0.10.0", "0.11.1"]);
});

test("issues: markdown report puts open issues first by frequency and carries the version", () => {
  const { store } = mk();
  const s = store();
  s.record({ kind: "friction", source: "limit", title: "rare" });
  for (let i = 0; i < 3; i++) s.record({ kind: "error", source: "turn", title: "frequent" });
  const md = s.markdown();
  assert.ok(md.indexOf("frequent") < md.indexOf("rare"));
  assert.match(md, /AgentRoom 0\.11\.0/);
  assert.match(md, /\*\*3 lần\*\*/);
});

test("issues: capped; closed ones are dropped before open ones; a corrupt file starts empty", () => {
  const { store, file } = mk("0.11.0", { max: 3 });
  const s = store();
  const a = s.record({ kind: "error", source: "x", title: "a" });
  s.setStatus(a.id, "wontfix");
  for (const t of ["b", "c", "d"]) s.record({ kind: "error", source: "x", title: t });
  assert.deepEqual(s.list().map((i) => i.title).sort(), ["b", "c", "d"]);
  require("node:fs").writeFileSync(file, "{nope");
  assert.equal(store().list().length, 0);
});
