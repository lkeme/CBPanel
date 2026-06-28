import { Copy, Download, RefreshCw } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { SystemDiagnostics } from "../../shared/entities";
import type { BinaryInfo, CloakBrowserEnvInfo } from "../../shared/browserCore";
import type { PanelState } from "../../shared/profile";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";
import { KeyValueList } from "../ui/KeyValueList";

const binaryEnvRows: Array<{ key: keyof CloakBrowserEnvInfo; label: string }> = [
  { key: "binaryPath", label: "CLOAKBROWSER_BINARY_PATH" },
  { key: "cacheDir", label: "CLOAKBROWSER_CACHE_DIR" },
  { key: "downloadUrl", label: "CLOAKBROWSER_DOWNLOAD_URL" },
  { key: "autoUpdate", label: "CLOAKBROWSER_AUTO_UPDATE" },
  { key: "skipChecksum", label: "CLOAKBROWSER_SKIP_CHECKSUM" },
  { key: "geoipTimeoutSeconds", label: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS" },
  { key: "version", label: "CLOAKBROWSER_VERSION" },
  { key: "licenseKey", label: "CLOAKBROWSER_LICENSE_KEY" },
];

export function SystemStatusContent({
  binaryInfo,
  busy,
  copyDiagnostics,
  diagnostics,
  exportDiagnostics,
  refreshBinary,
  refreshDiagnostics,
  runtime,
  state,
  storage,
  t,
}: {
  binaryInfo: BinaryInfo | null;
  busy: string;
  copyDiagnostics: () => Promise<void>;
  diagnostics: SystemDiagnostics | null;
  exportDiagnostics: () => void;
  refreshBinary: () => Promise<void>;
  refreshDiagnostics: () => Promise<void>;
  runtime: DesktopRuntimeInfo | null;
  state: PanelState | null;
  storage?: StorageInfo;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="system-status-scroll">
      <div className="settings-stack system-status-stack">
        <section className="settings-section">
          <div className="settings-section-head">
            <h2>{t("system.diagnostics")}</h2>
            <div className="row-actions">
              <button className="command subtle" disabled={busy === "diagnostics-refresh"} onClick={() => void refreshDiagnostics()} type="button">
                <RefreshCw size={16} aria-hidden="true" />
                {t("actions.refresh")}
              </button>
              <button className="command subtle" disabled={!diagnostics} onClick={() => void copyDiagnostics()} type="button">
                <Copy size={16} aria-hidden="true" />
                {t("actions.copy")}
              </button>
              <button className="command subtle" disabled={!diagnostics} onClick={exportDiagnostics} type="button">
                <Download size={16} aria-hidden="true" />
                {t("actions.json")}
              </button>
            </div>
          </div>
          <KeyValueList
            items={[
              { label: t("system.checkedAt"), value: diagnostics?.checkedAt ? new Date(diagnostics.checkedAt).toLocaleString() : "-" },
              { label: t("system.schemaVersion"), value: diagnostics?.schemaVersion ?? "-" },
              { label: t("session.dataDir"), value: diagnostics?.dataDir ?? state?.meta.dataDir ?? "-" },
            ]}
          />
        </section>

        <section className="settings-section">
          <h2>{t("system.storage")}</h2>
          <KeyValueList
            items={[
              { label: t("settings.kind"), value: storage?.kind ?? "sqlite" },
              { label: t("settings.database"), value: storage?.databasePath ?? "-" },
              { label: t("settings.legacyJson"), value: storage?.legacyJsonPath ?? "-" },
              { label: t("settings.portable"), value: storage?.portable ? t("settings.yes") : t("settings.no") },
              { label: t("settings.migrated"), value: storage?.migratedFromJson ? t("settings.yes") : t("settings.no") },
              { label: t("session.dataDir"), value: state?.meta.dataDir ?? "-" },
            ]}
          />
          {storage?.migrationError && <div className="inline-error">{storage.migrationError}</div>}
        </section>

        <section className="settings-section">
          <h2>{t("system.networkTrace")}</h2>
          <KeyValueList
            items={[
              { label: t("networkTrace.provider"), value: diagnostics?.networkTrace.providerName ?? state?.settings.networkTrace.providerId ?? "-" },
              { label: t("networkTrace.url"), value: diagnostics?.networkTrace.providerUrl ?? "-" },
              { label: t("networkTrace.timeout"), value: diagnostics?.networkTrace.timeoutSeconds ?? state?.settings.networkTrace.timeoutSeconds ?? "-" },
            ]}
          />
        </section>

        <section className="settings-section">
          <h2>{t("system.sessions")}</h2>
          <KeyValueList
            items={[
              { label: t("system.total"), value: diagnostics?.sessions.total ?? state?.sessions.length ?? 0 },
              { label: t("status.running"), value: diagnostics?.sessions.running ?? 0 },
              { label: t("status.launching"), value: diagnostics?.sessions.launching ?? 0 },
              { label: t("status.error"), value: diagnostics?.sessions.error ?? 0 },
            ]}
          />
        </section>

        <section className="settings-section">
          <h2>{t("system.runtime")}</h2>
          <KeyValueList
            items={[
              { label: t("settings.shell"), value: runtime?.shell ?? "web" },
              { label: t("settings.platform"), value: runtime?.platform ?? "-" },
              { label: t("settings.chrome"), value: runtime?.chrome ?? "native" },
              { label: t("settings.sidecar"), value: runtime?.sidecar.status ?? t("settings.notApplicable") },
              { label: t("settings.advancedWebEntry"), value: state?.settings.desktop.advancedWebEntry ? t("settings.yes") : t("settings.no") },
              { label: t("system.webEndpoint"), value: runtime ? `${runtime.api.host}:${runtime.api.port}` : "-" },
              { label: t("system.webToken"), value: runtime?.api.tokenRequired ? t("system.required") : t("system.notRequired") },
            ]}
          />
          {state?.settings.desktop.advancedWebEntry && <div className="result-line">{t("system.advancedWebLocalOnly")}</div>}
        </section>

        <section className="settings-section">
          <h2>{t("system.extensions")}</h2>
          <KeyValueList
            items={[
              {
                label: t("module.extensionSourcesTitle"),
                value: diagnostics
                  ? `${diagnostics.extensionSources.enabled}/${diagnostics.extensionSources.total}`
                  : `${state?.extensionSources?.filter((source) => source.status === "enabled").length ?? 0}/${state?.extensionSources?.length ?? 0}`,
              },
              { label: t("system.extensionCache"), value: diagnostics?.extensionCache.directory ?? "-" },
              { label: t("system.installedCount"), value: diagnostics?.extensionCache.installedCount ?? state?.extensions?.filter((extension) => extension.installState === "installed").length ?? 0 },
              { label: t("system.lastError"), value: diagnostics?.extensionSources.lastError ?? diagnostics?.extensionCache.lastError ?? "-" },
            ]}
          />
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h2>{t("system.binary")}</h2>
            <button className="command subtle" onClick={() => void refreshBinary()} type="button">
              <RefreshCw size={16} aria-hidden="true" />
              {t("actions.refresh")}
            </button>
          </div>
          <KeyValueList
            items={[
              { label: t("settings.binary"), value: binaryInfo?.installed ? t("form.installed") : t("form.missing") },
              { label: t("form.version"), value: binaryInfo?.version ?? "-" },
              { label: t("browserCore.tier"), value: binaryInfo?.tier ?? "-" },
              { label: t("form.path"), value: binaryInfo?.binaryPath ?? "-" },
              { label: t("form.cache"), value: binaryInfo?.cacheDir ?? "-" },
              { label: t("settings.platform"), value: binaryInfo?.platform ?? "-" },
            ]}
          />
          <EnvStatusPanel env={binaryInfo?.env} t={t} />
        </section>

        <section className="settings-section">
          <h2>{t("system.recentErrors")}</h2>
          {diagnostics?.recentErrors.length ? (
            <div className="system-error-list">
              {diagnostics.recentErrors.map((error) => (
                <div className="session-event error" key={`${error.at}-${error.source}-${error.message}`}>
                  <span>{new Date(error.at).toLocaleString()}</span>
                  <strong>{error.source}</strong>
                  <small>{error.message}</small>
                </div>
              ))}
            </div>
          ) : (
            <div className="preflight-empty">{t("system.noRecentErrors")}</div>
          )}
        </section>

        <section className="settings-section">
          <h2>{t("system.diagnosticsJson")}</h2>
          <pre className="diagnostics-json">{diagnostics ? JSON.stringify(diagnostics, null, 2) : "-"}</pre>
        </section>
      </div>
    </div>
  );
}

function EnvStatusPanel({
  env,
  t,
}: {
  env?: CloakBrowserEnvInfo;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <section className="env-panel">
      <div className="panel-heading">
        <strong>{t("form.env")}</strong>
        <span>{t("form.readOnly")}</span>
      </div>
      <dl className="env-grid system-env-grid">
        {binaryEnvRows.map((row) => (
          <div key={row.key}>
            <dt>{row.label}</dt>
            <dd>{env?.[row.key] || "-"}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
