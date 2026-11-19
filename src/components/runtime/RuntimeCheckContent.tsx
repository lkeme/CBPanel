import { Download, Settings2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { binaryPathOverrideFrom, browserCoreLicenseIssue, type BrowserCoreInfo } from "../../shared/browserCore";
import { StatusPill } from "../ui/StatusPill";

export type RuntimeCheckBinaryInfo = {
  installed: boolean;
  licenseRequired?: boolean;
  licenseValid?: boolean;
  version: string;
  core?: BrowserCoreInfo;
};

export function RuntimeCheckContent({
  binaryInfo,
  browserCoreMissing,
  openBrowserCoreSettings,
  t,
}: {
  binaryInfo: RuntimeCheckBinaryInfo | null;
  browserCoreMissing: boolean;
  openBrowserCoreSettings: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const core = binaryInfo?.core;
  const update = core?.update;
  const licenseApplies = core?.licensePolicy !== "not-applicable" && core?.channel !== "private";
  const licenseIssue = licenseApplies ? browserCoreLicenseIssue(binaryInfo) : undefined;
  const license = core?.license;
  const unverified = licenseApplies && core?.channelMode !== "offline" && !binaryPathOverrideFrom(core?.env ?? []) && Boolean(license?.active && license.valid !== true);
  const unavailable = browserCoreMissing || Boolean(licenseIssue) || unverified;
  const coreStatusValue = licenseIssue
    ? t(licenseIssue === "required" ? "browserCore.licenseRequiredShort" : "browserCore.licenseInvalidShort")
    : unverified ? t(license?.checkedAt ? "browserCore.licensePlanUnknown" : "browserCore.licensePlanValidating")
    : browserCoreMissing ? t("browserCore.missingShort") : t("browserCore.readyShort");
  const detail = licenseIssue
    ? t(licenseIssue === "required" ? "error.browserCoreLicenseRequired" : "error.browserCoreLicenseInvalid")
    : unverified ? t(license?.checkedAt ? "browserCore.licenseCheckUnavailable" : "browserCore.licenseCheckPending")
    : browserCoreMissing ? t("browserCore.installRequiredDetail") : t("browserCore.launchReadyDetail");
  return (
    <section className="module-surface runtime-check-page">
      <div className={`runtime-check-hero ${unavailable ? "missing" : "ready"}`}>
        <span className="runtime-check-hero-icon">
          <Download size={18} aria-hidden="true" />
        </span>
        <div className="runtime-check-hero-copy">
          <div className="runtime-check-hero-title-row">
            <strong>{licenseIssue || unverified ? t("browserCore.runtimeNotReady") : browserCoreMissing ? t("browserCore.installRequired") : t("browserCore.launchReady")}</strong>
            <StatusPill tone={licenseIssue || browserCoreMissing ? "error" : unverified ? "warning" : "running"}>{coreStatusValue}</StatusPill>
          </div>
          <small>{detail}</small>
          {!browserCoreMissing && (
            <div className="runtime-check-hero-meta">
              <span>{t("browserCore.installation")}</span>
              <strong>{licenseIssue || unverified ? `${t("browserCore.installedShort")} · ${binaryInfo?.version ?? "-"}` : t("browserCore.runtimeCoreReadyDetail", { version: binaryInfo?.version ?? "-" })}</strong>
            </div>
          )}
        </div>
        <div className="row-actions">
          <button className="command primary" onClick={openBrowserCoreSettings} type="button">
            <Settings2 size={17} aria-hidden="true" />
            {update?.updateAvailable ? t("browserCore.goToUpdate") : t("browserCore.openSettings")}
          </button>
        </div>
      </div>

      {/* The operation panel lives only in Settings → Kernel. It used to be rendered here too, which
          meant one download appeared as two independently updating copies of the same progress; the
          page keeps its one job, deciding whether a launch can start. */}
    </section>
  );
}
