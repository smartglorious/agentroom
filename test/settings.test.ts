import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildSettingsPayload, checkValue, confirmValue, settingDefs } from "../src/ui/settings";

const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
const declared = pkg.contributes.configuration.properties as Record<string, { type: string; enum?: string[]; minimum?: number; maximum?: number; default?: unknown }>;
const def = (key: string) => settingDefs().find((d) => d.key === key)!;

test("settings tab: every setting it offers in this build is declared in package.json, with the same options and limits", () => {
  const keys = new Set(Object.keys(declared).map((k) => k.replace(/^agentroom\./, "")));
  const offered = settingDefs(keys);
  assert.ok(offered.length >= 8, "the common settings are all declared");
  for (const d of offered) {
    const p = declared[`agentroom.${d.key}`];
    assert.ok(p, `agentroom.${d.key} is not declared in package.json`);
    if (d.kind === "enum") assert.deepEqual(d.options, p.enum, `${d.key}: options differ from package.json`);
    if (d.kind === "bool") assert.equal(p.type, "boolean");
    if (d.kind === "int") {
      assert.equal(p.type, "number");
      if (p.minimum !== undefined) assert.equal(d.min, p.minimum, `${d.key}: min differs`);
      if (p.maximum !== undefined) assert.equal(d.max, p.maximum, `${d.key}: max differs`);
    }
    if (d.kind === "text") assert.equal(p.type, "string");
  }
});

test("settings tab: a setting this build does not declare is not offered", () => {
  const some = new Set(["language", "contextMessages"]);
  assert.deepEqual(settingDefs(some).map((d) => d.key), ["language", "contextMessages"]);
  const p = buildSettingsPayload(() => ({ value: undefined, defaultValue: undefined, source: "default" }), { version: "0" }, [], undefined, some);
  assert.deepEqual(p.items.map((i) => i.key), ["language", "contextMessages"]);
  assert.ok(settingDefs().length > 2, "without a filter every setting is offered");
});

test("settings tab: values are validated before anything is written", () => {
  assert.deepEqual(checkValue(def("storage.mode"), "durable"), { ok: true, value: "durable" });
  assert.equal(checkValue(def("storage.mode"), "turbo").ok, false);
  assert.equal(checkValue(def("storage.mode"), 5).ok, false);
  assert.deepEqual(checkValue(def("contextMessages"), "40"), { ok: true, value: 40 });
  assert.equal(checkValue(def("contextMessages"), 0).ok, false, "below the minimum");
  assert.equal(checkValue(def("contextMessages"), 1000).ok, false, "above the maximum");
  assert.equal(checkValue(def("contextMessages"), 2.5).ok, false, "not an integer");
  assert.equal(checkValue(def("contextMessages"), "").ok, false);
  assert.deepEqual(checkValue(def("localApi.enabled"), true), { ok: true, value: true });
  assert.equal(checkValue(def("localApi.enabled"), "true").ok, false);
  assert.deepEqual(checkValue(def("claudePath"), "  C:\\tools\\claude.exe "), { ok: true, value: "C:\\tools\\claude.exe" });
  assert.equal(checkValue(def("claudePath"), "a\nb").ok, false, "one line only");
});

test("settings tab: switching storage to verify or durable asks for confirmation, going back to legacy does not", () => {
  const d = def("storage.mode");
  assert.ok(confirmValue(d, "durable"));
  assert.ok(confirmValue(d, "verify"));
  assert.equal(confirmValue(d, "legacy"), undefined);
  assert.equal(confirmValue(def("contextMessages"), 40), undefined);
});

test("settings tab: the payload says where each value comes from, what needs a reload and what the room runs now", () => {
  const stored: Record<string, unknown> = { "storage.mode": "durable", contextMessages: 30 };
  const p = buildSettingsPayload((key) => ({ value: stored[key], defaultValue: key === "storage.mode" ? "legacy" : 30, source: key === "storage.mode" ? "workspace" : "default" }),
    { storage: { requested: "legacy", active: "legacy" }, version: "0.0.0" }, ["storage.mode"], "boom");
  assert.equal(p.type, "settings");
  assert.deepEqual(p.reloadNeeded, ["storage.mode"]);
  assert.equal(p.error, "boom");
  const mode = p.items.find((i) => i.key === "storage.mode")!;
  assert.equal(mode.value, "durable");
  assert.equal(mode.defaultValue, "legacy");
  assert.equal(mode.source, "workspace");
  assert.equal(mode.apply, "reload");
  assert.deepEqual(p.runtime.storage, { requested: "legacy", active: "legacy" });
  const missing = p.items.find((i) => i.key === "claudePath")!;
  assert.equal(missing.value, "", "an unset text setting shows empty, not undefined");
});
