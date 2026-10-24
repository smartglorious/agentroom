import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { EN } from "../src/core/i18n-en";
import { fill, getLang, resolveLang, setLang, tr, trVi } from "../src/core/i18n";

const root = join(__dirname, "..");
const VI = "ăâêôơưđáàảãạéèẻẽẹíìỉĩịóòỏõọúùủũụýỳỷỹỵ";
const hasVi = (t: string) => [...t.toLowerCase()].some((c) => VI.includes(c));
const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const sources = [...walk(join(root, "src")).filter((f) => f.endsWith(".ts") && !f.endsWith("i18n-en.ts")), join(root, "media", "main.js")];
const read = (f: string) => readFileSync(f, "utf8");
const KEY = /\btr\(\s*"((?:[^"\\\n]|\\.)*)"/g;
const unescape = (s: string) => JSON.parse(`"${s}"`) as string;
const placeholders = (t: string) => [...t.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

const used = new Map<string, string>();
for (const f of sources) for (const m of read(f).matchAll(KEY)) used.set(unescape(m[1]), f);

test("i18n: every Vietnamese string passed to tr() has an English translation with the same parameters", () => {
  for (const [key, file] of used) {
    if (!hasVi(key)) continue;
    assert.ok(key in EN, `missing English for: ${key}  (${file})`);
    assert.deepEqual(placeholders(EN[key]), placeholders(key), `parameters differ for: ${key}`);
    assert.ok(EN[key].trim() && !hasVi(EN[key]), `English text is empty or still Vietnamese: ${key}`);
  }
});

test("i18n: no stale English entries (every key is still used by some tr() call)", () => {
  for (const key of Object.keys(EN)) assert.ok(used.has(key), `unused English entry: ${key}`);
});

const UI_FILES = ["src/extension.ts", "src/ui/chatView.ts", "src/core/room.ts", "src/core/plan.ts", "src/channels/telegram/service.ts", "src/channels/telegram/format.ts", "src/channels/telegram/bot.ts", "src/daemon/daemon.ts", "src/daemon/main.ts", "src/daemon/store.ts", "src/remote/host.ts", "src/core/cleanup.ts", "src/core/issues.ts", "media/main.js"];
// Vietnamese that is on purpose: patterns that match Vietnamese log text, and the prompt the worker itself receives.
const ALLOWED = ["TELEGRAM_FAULT =", "[gom trí nhớ]", "chạm ngân sách|", "lỗi|không (gửi"];

test("i18n: files that show text to the owner have no Vietnamese outside tr()/trVi() (except the allowed few)", () => {
  const bad: string[] = [];
  for (const f of UI_FILES) {
    read(join(root, f)).split("\n").forEach((line, i) => {
      const code = line.replace(/\btr(?:Vi)?\(\s*"(?:[^"\\\n]|\\.)*"/g, "TR");
      if (/^\s*(\/\/|\/?\*)/.test(code) || !hasVi(code) || ALLOWED.some((a) => line.includes(a))) return;
      bad.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
    });
  }
  assert.deepEqual(bad, [], "wrap these in tr(\"…\") and add the English to src/core/i18n-en.ts");
});

test("i18n: tr() follows the language; Vietnamese is the key itself; unknown keys fall back; trVi never translates", () => {
  const was = getLang();
  try {
    setLang("vi");
    assert.equal(tr("Hôm nay"), "Hôm nay");
    assert.equal(tr("Đã ghi vấn đề {id}.", { id: "i1" }), "Đã ghi vấn đề i1.");
    setLang("en");
    assert.equal(tr("Hôm nay"), "Today");
    assert.equal(tr("Đã ghi vấn đề {id}.", { id: "i1" }), "Issue i1 recorded.");
    assert.equal(tr("chưa có bản dịch {x}", { x: 1 }), "chưa có bản dịch 1", "a missing entry falls back to Vietnamese");
    assert.equal(trVi("Đã ghi vấn đề {id}.", { id: "i1" }), "Đã ghi vấn đề i1.");
    assert.equal(fill("a {b} {c}", { b: 1 }), "a 1 {c}", "unknown placeholders are left alone");
  } finally { setLang(was); }
});

test("i18n: language setting — vi by default, auto follows the editor, anything else falls back to vi", () => {
  assert.equal(resolveLang(undefined), "vi");
  assert.equal(resolveLang("en"), "en");
  assert.equal(resolveLang("auto", "vi-VN"), "vi");
  assert.equal(resolveLang("auto", "en-US"), "en");
  assert.equal(resolveLang("auto", "vi_VN.UTF-8"), "vi");
  assert.equal(resolveLang("fr", "en"), "vi");
});

test("i18n: package.json texts come from package.nls*.json, both languages have the same keys", () => {
  const pkg = JSON.parse(read(join(root, "package.json")));
  const en = JSON.parse(read(join(root, "package.nls.json")));
  const vi = JSON.parse(read(join(root, "package.nls.vi.json")));
  assert.deepEqual(Object.keys(en).sort(), Object.keys(vi).sort());
  const refs = [...JSON.stringify(pkg).matchAll(/"%([\w.]+)%"/g)].map((m) => m[1]);
  assert.ok(refs.length > 20);
  for (const r of refs) assert.ok(r in en, `package.json refers to %${r}% which package.nls.json lacks`);
  const bare = JSON.stringify({ ...pkg, contributes: { ...pkg.contributes } }).match(/"(description|title)":"[^"%][^"]*"/g) ?? [];
  assert.deepEqual(bare.filter((s) => hasVi(s)), [], "Vietnamese text left in package.json instead of package.nls.vi.json");
  assert.ok(pkg.contributes.configuration.properties["agentroom.language"], "language setting exists");
  assert.equal(pkg.contributes.configuration.properties["agentroom.language"].default, "vi");
});
