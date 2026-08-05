import type { LanguageMode } from "./shared/settings";
import { type Dictionary, type TranslationKey, zhCN } from "./locales/zh-CN";

export type { TranslationKey };
export type Locale = "zh-CN" | "en-US";

// zh-CN stays in the entry chunk because translate() uses it as the missing-key
// fallback for every locale. Other locales are fetched on demand and cached here.
const loadedDictionaries = new Map<Locale, Dictionary>([["zh-CN", zhCN]]);
const pendingDictionaries = new Map<Locale, Promise<void>>();

async function loadDictionary(locale: Locale): Promise<Dictionary> {
  if (locale === "en-US") return (await import("./locales/en-US")).enUS;
  return zhCN;
}

export function isLocaleReady(locale: Locale): boolean {
  return loadedDictionaries.has(locale);
}

export function ensureLocaleReady(locale: Locale): Promise<void> {
  if (loadedDictionaries.has(locale)) return Promise.resolve();
  const pending = pendingDictionaries.get(locale);
  if (pending) return pending;
  const request = loadDictionary(locale)
    .then((dictionary) => {
      loadedDictionaries.set(locale, dictionary);
    })
    .catch((error: unknown) => {
      pendingDictionaries.delete(locale);
      throw error;
    });
  pendingDictionaries.set(locale, request);
  return request;
}

/**
 * Plural forms are encoded in the template itself as `singular||plural` rather than as a second
 * key, so a locale that needs no plural (zh-CN) just omits the separator and both dictionaries
 * keep the same key set. The count that drives the choice is `count`, or `total` when there is
 * no `count` — those are the only two names the dictionary uses for a quantity.
 */
const PLURAL_SEPARATOR = "||";

function selectPluralForm(template: string, params: Record<string, string | number>): string {
  if (!template.includes(PLURAL_SEPARATOR)) return template;
  const [singular, plural = ""] = template.split(PLURAL_SEPARATOR);
  const quantity = Number(params.count ?? params.total);
  return quantity === 1 ? singular : plural;
}

export function translate(locale: Locale, key: TranslationKey, params: Record<string, string | number> = {}): string {
  const template: string = loadedDictionaries.get(locale)?.[key] ?? zhCN[key] ?? key;
  const resolved = selectPluralForm(template, params);
  return Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), resolved);
}

export function isSupportedLocale(value: string): value is Locale {
  return value === "zh-CN" || value === "en-US";
}

export function localeFromMode(mode: LanguageMode, browserLanguage: string): Locale {
  if (mode === "zh-CN" || mode === "en-US") return mode;
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}
