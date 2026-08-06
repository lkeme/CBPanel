// Mirrored from upstream CloakBrowser `js/src/geoip.ts` (cloakbrowser@0.5.5, commit
// c1dd58902a26032b24e7ca821b04800831f3d5c8). The wrapper does not export it — `cloakbrowser`'s
// `exports` map only publishes `.`, `./human` and `./puppeteer`, so `cloakbrowser/dist/geoip.js`
// resolves to ERR_PACKAGE_PATH_NOT_EXPORTED — and the table is what decides which locale a
// `geoip: true` launch actually injects. Reporting a different locale than the launch would apply is
// the one failure this whole feature exists to prevent, so the table is copied verbatim rather than
// re-derived. Re-diff `js/src/geoip.ts` on the next upstream sync.
export const COUNTRY_LOCALE_MAP: Record<string, string> = {
  US: "en-US", GB: "en-GB", AU: "en-AU", CA: "en-CA", NZ: "en-NZ",
  IE: "en-IE", ZA: "en-ZA", SG: "en-SG",
  DE: "de-DE", AT: "de-AT", CH: "de-CH",
  FR: "fr-FR", BE: "fr-BE",
  ES: "es-ES", MX: "es-MX", AR: "es-AR", CO: "es-CO", CL: "es-CL",
  BR: "pt-BR", PT: "pt-PT",
  IT: "it-IT", NL: "nl-NL",
  JP: "ja-JP", KR: "ko-KR", CN: "zh-CN", TW: "zh-TW", HK: "zh-HK",
  RU: "ru-RU", UA: "uk-UA", PL: "pl-PL", CZ: "cs-CZ", RO: "ro-RO",
  IL: "he-IL", TR: "tr-TR", SA: "ar-SA", AE: "ar-AE", EG: "ar-EG",
  IN: "hi-IN", ID: "id-ID", PH: "en-PH",
  TH: "th-TH", VN: "vi-VN", MY: "ms-MY",
  SE: "sv-SE", NO: "nb-NO", DK: "da-DK", FI: "fi-FI",
  GR: "el-GR", HU: "hu-HU", BG: "bg-BG",
  // Extended coverage — common residential/mobile proxy exits
  SI: "sl-SI", SK: "sk-SK", HR: "hr-HR", RS: "sr-RS", LT: "lt-LT",
  LV: "lv-LV", EE: "et-EE", IS: "is-IS", LU: "fr-LU", MT: "en-MT",
  CY: "el-CY", MD: "ro-MD", BY: "ru-BY", GE: "ka-GE", AL: "sq-AL",
  MK: "mk-MK", BA: "bs-BA",
  PE: "es-PE", VE: "es-VE", EC: "es-EC", UY: "es-UY", CR: "es-CR",
  DO: "es-DO", GT: "es-GT", BO: "es-BO", PY: "es-PY",
  PK: "en-PK", BD: "bn-BD", LK: "si-LK", KZ: "ru-KZ", IR: "fa-IR",
  IQ: "ar-IQ", JO: "ar-JO", LB: "ar-LB", KW: "ar-KW", QA: "ar-QA",
  OM: "ar-OM", BH: "ar-BH",
  NG: "en-NG", KE: "en-KE", MA: "fr-MA", DZ: "ar-DZ", TN: "ar-TN",
  GH: "en-GH",
  AM: "hy-AM", AZ: "az-AZ", UZ: "uz-UZ", KG: "ky-KG", TJ: "tg-TJ",
  TM: "tk-TM",
  ME: "sr-ME", XK: "sq-XK", LI: "de-LI", MC: "fr-MC", AD: "ca-AD",
  MM: "my-MM", KH: "km-KH", LA: "lo-LA", MN: "mn-MN", BN: "ms-BN",
  MO: "zh-MO",
  YE: "ar-YE", SY: "ar-SY", PS: "ar-PS", LY: "ar-LY",
  ET: "am-ET", TZ: "sw-TZ", UG: "en-UG", SN: "fr-SN", CI: "fr-CI",
  CM: "fr-CM", AO: "pt-AO", MZ: "pt-MZ", ZM: "en-ZM", ZW: "en-ZW",
  HN: "es-HN", NI: "es-NI", SV: "es-SV", PA: "es-PA", JM: "en-JM",
  TT: "en-TT", PR: "es-PR",
};

// MaxMind writes `country.iso_code` uppercase, which is what upstream indexes the table with
// directly. The normalization here is for the other callers — a trace provider's `loc` field or an
// operator-typed value — so one lookup serves them all instead of each guessing the casing.
export function localeForCountryCode(code: string | undefined): string | undefined {
  const normalized = code?.trim().toUpperCase();
  if (!normalized) return undefined;
  return COUNTRY_LOCALE_MAP[normalized];
}

// Why the GeoIP database could not supply a timezone/locale even though an exit IP did resolve. The
// distinction matters to the operator: `geoip-db-missing` is fixed by a `geoip: true` launch (which
// downloads the database), while `ip-not-in-db` means this exit simply is not covered and no amount
// of retrying changes it. Kept as a code rather than a sentence so the panel translates it, matching
// how BrowserCoreImportRefusal and BrowserCoreUpdateBaselineCaveat are already handled.
//
// The runtime list is the source of the type, not a copy of it: the diagnostics payload is parsed back
// from JSON and has to validate the value, and a hand-written validator would silently drop any reason
// added to the type but not to it.
export const LAUNCH_GEO_UNRESOLVED_REASONS = ["geoip-db-missing", "geoip-db-unreadable", "ip-not-in-db"] as const;

export type LaunchGeoUnresolvedReason = (typeof LAUNCH_GEO_UNRESOLVED_REASONS)[number];

export function launchGeoUnresolvedReasonFrom(value: unknown): LaunchGeoUnresolvedReason | undefined {
  return LAUNCH_GEO_UNRESOLVED_REASONS.find((reason) => reason === value);
}

