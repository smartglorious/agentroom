import { tr } from "../core/i18n";
import type { Limits } from "../core/types";

/** One VS Code setting the Settings tab may change. The webview never names a setting the host does not list here. */
export interface SettingDef {
  key: string;
  kind: "enum" | "bool" | "int" | "text";
  options?: string[];
  min?: number;
  max?: number;
  /** Where a change is written: the project (`workspace`) or the user's settings. */
  scope: "workspace" | "user";
  /** `reload`: the room reads it once at start, so a changed value needs the window to be reloaded. */
  apply: "live" | "reload";
  group: "storage" | "room" | "cli";
  label: string;
  help: string;
  /** Shown in a confirmation before a value is accepted (see `confirmValue`). */
  warn?: Partial<Record<string, string>>;
}

/**
 * Built on demand (never at module level) so the labels follow the language the user picked.
 * `declared` (keys without the `agentroom.` prefix, from package.json) hides settings this build does not have, so one list serves every edition.
 */
export const settingDefs = (declared?: ReadonlySet<string>): SettingDef[] => allDefs().filter((d) => !declared || declared.has(d.key));

const allDefs = (): SettingDef[] => [
  {
    key: "storage.mode", kind: "enum", options: ["legacy", "verify", "durable"], scope: "workspace", apply: "reload", group: "storage",
    label: tr("Chế độ lưu trữ"),
    help: tr("legacy: lưu bằng file như cũ (mặc định). verify: dựng bản SQLite để đối chiếu, file vẫn là bản chính. durable: thêm thực thi bền vững (Run/Step, phê duyệt và trí nhớ lưu trong SQLite, phục hồi sau khi tắt đột ngột)."),
    warn: { verify: tr("verify tạo file agentroom.db trong .agentroom/state và đọc toàn bộ dữ liệu cũ để đối chiếu."), durable: tr("durable chưa được kiểm chứng trên dữ liệu thật của bạn. Nên thử trên bản sao của .agentroom/state. Muốn quay lại: đặt lại legacy (file cũ vẫn còn nguyên).") },
  },
  { key: "language", kind: "enum", options: ["vi", "en", "auto"], scope: "user", apply: "live", group: "room", label: tr("Ngôn ngữ"), help: tr("Ngôn ngữ giao diện và tin hệ thống. auto theo VS Code.") },
  { key: "contextMessages", kind: "int", min: 1, max: 200, scope: "workspace", apply: "reload", group: "room", label: tr("Số tin phát lại cho session mới"), help: tr("Số tin gần nhất mà một session mới nhận. Nhiều hơn tốn hạn mức hơn ở lượt đầu của mỗi session.") },
  { key: "memoryBudgetChars", kind: "int", min: 1000, max: 100000, scope: "workspace", apply: "reload", group: "room", label: tr("Ngân sách trí nhớ (ký tự)"), help: tr("Tối đa bao nhiêu ký tự trí nhớ và nhật ký đưa vào prompt.") },
  { key: "maxAgentHops", kind: "int", min: 1, max: 50, scope: "workspace", apply: "reload", group: "room", label: tr("Số bước agent gọi agent tối đa"), help: tr("Sau số bước liên tiếp này, các worker thôi gọi nhau (tin của bạn không bị giới hạn).") },
  { key: "agentDebounceMs", kind: "int", min: 0, max: 60000, scope: "workspace", apply: "reload", group: "room", label: tr("Gom tin giữa các worker (ms)"), help: tr("Chờ chừng này mili giây để gom các tin đến cùng lúc vào một lượt. 0 = tắt.") },
  { key: "inspector.keepTurns", kind: "int", min: 0, max: 5000, scope: "workspace", apply: "reload", group: "room", label: tr("Số lượt giữ cho Inspector"), help: tr("Số lượt gần nhất lưu để xem bằng nút 🔍.") },
  { key: "planUsage.pollMinutes", kind: "int", min: 0, max: 1440, scope: "workspace", apply: "live", group: "room", label: tr("Chu kỳ đọc hạn mức gói (phút)"), help: tr("0 = tắt đọc tự động.") },
  { key: "localApi.enabled", kind: "bool", scope: "workspace", apply: "reload", group: "storage", label: tr("API cục bộ"), help: tr("Mở API /v1 trên 127.0.0.1 (có xác thực) để giao diện gọi qua đó. Tắt thì giao diện gọi trực tiếp.") },
  { key: "claudePath", kind: "text", scope: "user", apply: "live", group: "cli", label: tr("Đường dẫn claude"), help: tr("Để trống nếu claude có trong PATH. Windows: trỏ tới file .exe.") },
  { key: "codexPath", kind: "text", scope: "user", apply: "live", group: "cli", label: tr("Đường dẫn codex"), help: tr("Để trống nếu codex có trong PATH.") },
];

export type SettingValue = string | number | boolean;

export function checkValue(def: SettingDef, raw: unknown): { ok: true; value: SettingValue } | { ok: false; error: string } {
  switch (def.kind) {
    case "enum": return typeof raw === "string" && def.options?.includes(raw) ? { ok: true, value: raw } : { ok: false, error: tr("Chỉ nhận: {list}", { list: (def.options ?? []).join(" | ") }) };
    case "bool": return typeof raw === "boolean" ? { ok: true, value: raw } : { ok: false, error: tr("Cần true hoặc false") };
    case "int": {
      const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isInteger(n) || n < (def.min ?? -Infinity) || n > (def.max ?? Infinity)) return { ok: false, error: tr("Cần số nguyên từ {min} đến {max}", { min: def.min ?? "−∞", max: def.max ?? "∞" }) };
      return { ok: true, value: n };
    }
    case "text": return typeof raw === "string" && raw.length <= 1000 && !/[\u0000-\u001f]/.test(raw) ? { ok: true, value: raw.trim() } : { ok: false, error: tr("Cần một chuỗi một dòng") };
  }
}

/** A message to confirm before accepting `value` for `def`, or undefined. */
export const confirmValue = (def: SettingDef, value: SettingValue): string | undefined => def.warn?.[String(value)];

export interface SettingItem {
  key: string; label: string; help: string; group: SettingDef["group"]; kind: SettingDef["kind"]; options?: string[]; min?: number; max?: number;
  value: SettingValue; defaultValue: SettingValue; source: "default" | "user" | "workspace"; scope: SettingDef["scope"]; apply: SettingDef["apply"];
}

export interface SettingsPayload {
  type: "settings";
  items: SettingItem[];
  /** What the room is running now (read at start), shown next to the storage setting. */
  runtime: { storage?: { requested: string; active: string; error?: string }; version: string; limits?: Limits };
  /** Settings changed since this window started that only apply after a reload. */
  reloadNeeded: string[];
  error?: string;
}

export interface SettingReading { value: unknown; defaultValue: unknown; source: SettingItem["source"] }

export function buildSettingsPayload(read: (key: string) => SettingReading, runtime: SettingsPayload["runtime"], reloadNeeded: string[], error?: string, declared?: ReadonlySet<string>): SettingsPayload {
  const items = settingDefs(declared).map((d): SettingItem => {
    const r = read(d.key);
    const fallback = d.kind === "bool" ? false : d.kind === "int" ? 0 : "";
    const shown = (v: unknown): SettingValue => (typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? v : fallback);
    return { key: d.key, label: d.label, help: d.help, group: d.group, kind: d.kind, options: d.options, min: d.min, max: d.max, value: shown(r.value), defaultValue: shown(r.defaultValue), source: r.source, scope: d.scope, apply: d.apply };
  });
  return { type: "settings", items, runtime, reloadNeeded, ...(error ? { error } : {}) };
}
