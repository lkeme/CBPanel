import type { NetworkCheckResult } from "./entities";
import { flagEmojiFromRegionCode, formatRegionLabel, normalizeRegionCode, type RegionDisplayLocale } from "./regionDisplay";

type NetworkCheckSuccessPartOptions = {
  includeColo?: boolean;
  includeFlag?: boolean;
  includeIp?: boolean;
  includeLatency?: boolean;
  includeRegion?: boolean;
};

type NetworkCheckSummaryOptions = NetworkCheckSuccessPartOptions & {
  emptyText?: string;
  failedText?: string;
  failurePrefix?: string;
  locale?: RegionDisplayLocale;
  separator?: string;
  successPrefix?: string;
};

export function networkCheckCountryCode(check: NetworkCheckResult | undefined): string | undefined {
  return normalizeRegionCode(check?.trace?.loc) ?? normalizeRegionCode(check?.geo?.countryCode);
}

export function networkCheckFlagEmoji(check: NetworkCheckResult | undefined): string {
  return flagEmojiFromRegionCode(networkCheckCountryCode(check));
}

export function networkCheckRegionLabel(
  check: NetworkCheckResult | undefined,
  locale: RegionDisplayLocale = "zh-CN",
): string {
  const countryCode = networkCheckCountryCode(check);
  if (countryCode) return formatRegionLabel(countryCode, locale);

  const countryName = check?.geo?.countryName?.trim();
  if (countryName) return countryName;

  return formatRegionLabel(check?.trace?.loc, locale);
}

export function buildNetworkCheckSuccessParts(
  check: NetworkCheckResult | undefined,
  options: NetworkCheckSuccessPartOptions & { locale?: RegionDisplayLocale } = {},
): string[] {
  if (!check?.ok) return [];

  const {
    includeColo = true,
    includeFlag = false,
    includeIp = true,
    includeLatency = true,
    includeRegion = true,
    locale = "zh-CN",
  } = options;

  const parts: string[] = [];
  if (includeIp && check.ip?.trim()) parts.push(check.ip.trim());

  if (includeRegion) {
    const region = networkCheckRegionLabel(check, locale);
    if (region) {
      const flag = includeFlag ? networkCheckFlagEmoji(check) : "";
      parts.push(flag ? `${flag} ${region}` : region);
    }
  }

  const colo = check.trace?.colo?.trim();
  if (includeColo && colo) parts.push(colo);

  if (includeLatency && typeof check.latencyMs === "number" && Number.isFinite(check.latencyMs)) {
    parts.push(`${check.latencyMs}ms`);
  }

  return parts;
}

export function networkCheckSummaryText(
  check: NetworkCheckResult | undefined,
  options: NetworkCheckSummaryOptions = {},
): string {
  const {
    emptyText = "",
    failedText = "",
    failurePrefix = "",
    locale = "zh-CN",
    separator = " · ",
    successPrefix = "",
    ...successPartOptions
  } = options;

  if (!check) return emptyText;
  if (!check.ok) {
    const failure = check.error?.trim() || failedText;
    if (!failure) return emptyText;
    return failurePrefix ? `${failurePrefix} ${failure}` : failure;
  }

  const summary = buildNetworkCheckSuccessParts(check, { ...successPartOptions, locale }).join(separator);
  if (!summary) return emptyText;
  return successPrefix ? `${successPrefix} ${summary}` : summary;
}
