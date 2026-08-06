import type { TranslationKey } from "../i18n";
import type { NetworkCheckResult } from "../shared/entities";
import type { LaunchGeoUnresolvedReason } from "../shared/launchGeoip";
import { launchGeoSummaryText } from "../shared/networkCheckDisplay";

// One mapping for every surface that renders a launch-GeoIP result. The proxy panel renders it inside a
// summary line and the system diagnostics as a note of its own, and two copies would drift the moment a
// reason is added upstream-side.
export const LAUNCH_GEO_REASON_KEYS: Record<LaunchGeoUnresolvedReason, TranslationKey> = {
  "geoip-db-missing": "launchGeoip.reason.geoipDbMissing",
  "geoip-db-unreadable": "launchGeoip.reason.geoipDbUnreadable",
  "ip-not-in-db": "launchGeoip.reason.ipNotInDb",
};

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
    reasonText: (reason) => t(LAUNCH_GEO_REASON_KEYS[reason]),
  });
}
