import { EN } from "./i18n-en";

/**
 * Two display languages. The source strings are Vietnamese and ARE the keys: `tr("Đã ghi {id}.", { id })`
 * is shown as is in Vietnamese and looked up in `EN` for English (a missing entry falls back to the
 * Vietnamese text, and test/i18n.test.ts makes sure no entry is missing). `{name}` marks a parameter.
 *
 * Only what the owner reads is translated: the chat UI, commands and dialogs, system notices, Telegram.
 * Text that goes to the AI workers (their prompts, tool descriptions) stays Vietnamese on purpose: it is
 * part of the prompt prefix that must stay byte-identical between turns, and switching it would
 * invalidate every session.
 */
export type Lang = "vi" | "en";
export type LangSetting = "auto" | Lang;

let current: Lang = "vi";

export const setLang = (l: Lang) => { current = l; };
export const getLang = (): Lang => current;

/** `auto` follows the editor's display language; the default setting is `vi`, so upgrading changes nothing. */
export function resolveLang(setting: string | undefined, uiLanguage?: string): Lang {
  if (setting === "en" || setting === "vi") return setting;
  if (setting === "auto") return uiLanguage?.toLowerCase().startsWith("vi") ? "vi" : "en";
  return "vi";
}

export function fill(text: string, params?: Record<string, unknown>): string {
  return params ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m)) : text;
}

export function tr(key: string, params?: Record<string, unknown>): string {
  return fill(current === "en" ? EN[key] ?? key : key, params);
}

/** Fills a Vietnamese template without translating it: logs and issue titles stay Vietnamese so they are greppable and fingerprint the same in either language. */
export const trVi = fill;
