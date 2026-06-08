import { Download, ListChecks, Settings2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { BrowserCoreInfo } from "../../shared/browserCore";
import { BrowserCoreOperationPanel, browserCoreOperationActive, isBrowserCoreBusy } from "../browser-core/BrowserCoreStatusPanels";
import { ModuleHeader } from "./ModuleHeader";

export type RuntimeCheckBinaryInfo = {
  installed: boolean;
  version: string;
  core?: BrowserCoreInfo;
};

export function RuntimeCheckContent({
  binaryInfo,
  browserCoreMissing,
  busy,
  openBrowserCoreSettings,
  t,
}: {
  binaryInfo: RuntimeCheckBinaryInfo | null;
  browserCoreMissing: boolean;
  busy: string;
  openBrowserCoreSettings: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const core = binaryInfo?.core;
  const operation = core?.operation;
  const update = core?.update;
  const showOperation = browserCoreOperationActive(operation) || isBrowserCoreBusy(busy);
  const coreStatusValue = browserCoreMissing ? t("browserCore.missingShort") : t("browserCore.readyShort");
  return (
    <section className="module-surface runtime-check-page">
      <ModuleHeader
        icon={<ListChecks size={19} />}
        title={t("browserCore.runtimeCheckTitle")}
        body={browserCoreMissing ? t("browserCore.runtimeCheckBodyMissing") : t("browserCore.runtimeCheckBodyReady")}
      />
      <div className={`runtime-check-hero ${browserCoreMissing ? "missing" : "ready"}`}>
        <span className="runtime-check-hero-icon">
          <Download size={18} aria-hidden="true" />
        </span>
        <div className="runtime-check-hero-copy">
          <div className="runtime-check-hero-title-row">
            <strong>{browserCoreMissing ? t("browserCore.installRequired") : t("browserCore.launchReady")}</strong>
            <span className={`pill ${browserCoreMissing ? "error" : "running"}`}>{coreStatusValue}</span>
          </div>
          <small>{browserCoreMissing ? t("browserCore.installRequiredDetail") : t("browserCore.launchReadyDetail")}</small>
          {!browserCoreMissing && (
            <div className="runtime-check-hero-meta">
              <span>{t("browserCore.installation")}</span>
              <strong>{t("browserCore.runtimeCoreReadyDetail", { version: binaryInfo?.version ?? "-" })}</strong>
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

      {showOperation && <BrowserCoreOperationPanel busy={busy} operation={operation} t={t} />}
    </section>
  );
}
