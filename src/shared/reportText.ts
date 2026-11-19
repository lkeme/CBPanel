import type { Locale, TranslationKey } from "../i18n";
import type { LocalizedText, LocalizedTextParam } from "./profile";
import { formatRegionLabel } from "./regionDisplay";

/** The panel's translator: `translate()` bound to the active locale. */
export type Translator = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * Resolves a report item's text with the active dictionary.
 *
 * The builders emit dictionary keys as plain strings because they run where the UI dictionary does not
 * exist — `preflightProfile` runs on the server and the client caches its report, so a builder could
 * neither translate nor be handed a locale. The narrowing to `TranslationKey` therefore happens here,
 * once, at the render boundary.
 *
 * A parameter that carries a `region` marker holds a region code: it is formatted with the active
 * locale here, or an English panel would show the Chinese region name a server-side builder baked in.
 */
export function resolveLocalizedText(text: LocalizedText, t: Translator, locale: Locale): string {
  if ("text" in text) return text.text;
  return t(text.key as TranslationKey, resolveParams(text.params, t, locale));
}

function resolveParams(
  params: Record<string, LocalizedTextParam> | undefined,
  t: Translator,
  locale: Locale,
): Record<string, string | number> | undefined {
  if (!params) return undefined;
  const resolved: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(params)) {
    resolved[name] = resolveParam(value, t, locale);
  }
  return resolved;
}

function resolveParam(value: LocalizedTextParam, t: Translator, locale: Locale): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if ("region" in value) return formatRegionLabel(value.region, locale);
  return resolveLocalizedText(value, t, locale);
}
