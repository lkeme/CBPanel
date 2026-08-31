import type { TranslationKey } from "../i18n";
import type { NetworkCheckResult } from "../shared/entities";
import { launchGeoSummaryText } from "../shared/networkCheckDisplay";

export function launchGeoSummary(
  check: NetworkCheckResult | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return launchGeoSummaryText(check, {
    emptyText: t("launchGeoip.unchecked"),
    failedText: t("launchGeoip.failed"),
    labels: {
      exitIp: t("system.exitIp"),
      timezone: t("system.timezone"),
      locale: t("system.locale"),
    },
  });
}
