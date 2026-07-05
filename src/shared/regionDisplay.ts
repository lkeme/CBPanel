export type RegionDisplayLocale = string | readonly string[];

export function normalizeRegionCode(loc: string | undefined): string | undefined {
  const trimmed = loc?.trim();
  if (!trimmed) return undefined;
  return /^[A-Za-z]{2}$/.test(trimmed) ? trimmed.toUpperCase() : undefined;
}

export function flagEmojiFromRegionCode(code: string | undefined): string {
  const normalized = normalizeRegionCode(code);
  if (!normalized) return "";
  return Array.from(normalized)
    .map((char) => String.fromCodePoint(0x1f1a5 + char.charCodeAt(0)))
    .join("");
}

export function formatRegionLabel(loc: string | undefined, locale: RegionDisplayLocale = "zh-CN"): string {
  const trimmed = loc?.trim() ?? "";
  if (!trimmed) return "";
  const code = normalizeRegionCode(trimmed);
  if (!code) return trimmed;

  try {
    const name = new Intl.DisplayNames(locale, { type: "region" }).of(code)?.trim();
    if (name && name.toUpperCase() !== code) return `${name} (${code})`;
  } catch {
    // Some runtimes throw for non-standard/reserved region codes; keep the raw trace value.
  }

  return code;
}
