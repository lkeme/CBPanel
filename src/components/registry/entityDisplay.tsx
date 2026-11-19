import type { TranslationKey } from "../../i18n";
import type { ExtensionPermissionRisk } from "../../shared/entities";
import { StatusPill } from "../ui/StatusPill";

export function renderEntityStatus(status: string | undefined, t: (key: TranslationKey) => string) {
  const enabled = status !== "disabled";
  return <StatusPill tone={enabled ? "running" : "stopped"}>{t(enabled ? "status.enabled" : "status.disabled")}</StatusPill>;
}

const riskReasonKeys: Record<NonNullable<ExtensionPermissionRisk["reasonKey"]>, TranslationKey> = {
  "all-urls": "risk.allUrls",
  "content-script-all-urls": "risk.contentScriptAllUrls",
  "high-privilege": "risk.highPrivilege",
  "tabs-metadata": "risk.tabsMetadata",
};

export function riskReasonText(risk: ExtensionPermissionRisk, t: (key: TranslationKey) => string) {
  const reasonKey = risk.reasonKey ? riskReasonKeys[risk.reasonKey] : undefined;
  if (!reasonKey) return risk.reason;
  return `${risk.optional ? t("risk.optionalPrefix") : ""}${t(reasonKey)}`;
}
