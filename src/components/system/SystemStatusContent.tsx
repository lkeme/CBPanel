import { Copy, Download, RefreshCw } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { SystemDiagnostics } from "../../shared/entities";
import type { BinaryInfo, CloakBrowserEnvInfo } from "../../shared/browserCore";
import type { PanelState } from "../../shared/profile";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";

const binaryEnvRows: Array<{ key: keyof CloakBrowserEnvInfo; label: string }> = [
  { key: "binaryPath", label: "CLOAKBROWSER_BINARY_PATH" },
  { key: "cacheDir", label: "CLOAKBROWSER_CACHE_DIR" },
  { key: "downloadUrl", label: "CLOAKBROWSER_DOWNLOAD_URL" },
  { key: "autoUpdate", label: "CLOAKBROWSER_AUTO_UPDATE" },
  { key: "skipChecksum", label: "CLOAKBROWSER_SKIP_CHECKSUM" },
  { key: "geoipTimeoutSeconds", label: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS" },
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
          <dl className="kv-list">
            <div>
              <dt>{t("system.checkedAt")}</dt>
              <dd>{diagnostics?.checkedAt ? new Date(diagnostics.checkedAt).toLocaleString() : "-"}</dd>
            </div>
            <div>
              <dt>{t("system.schemaVersion")}</dt>
              <dd>{diagnostics?.schemaVersion ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("session.dataDir")}</dt>
              <dd>{diagnostics?.dataDir ?? state?.meta.dataDir ?? "-"}</dd>
            </div>
          </dl>
        </section>

        <section className="settings-section">
          <h2>{t("system.storage")}</h2>
          <dl className="kv-list">
            <div>
              <dt>{t("settings.kind")}</dt>
              <dd>{storage?.kind ?? "sqlite"}</dd>
            </div>
            <div>
              <dt>{t("settings.database")}</dt>
              <dd>{storage?.databasePath ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("settings.legacyJson")}</dt>
              <dd>{storage?.legacyJsonPath ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("settings.portable")}</dt>
              <dd>{storage?.portable ? t("settings.yes") : t("settings.no")}</dd>
            </div>
            <div>
              <dt>{t("settings.migrated")}</dt>
              <dd>{storage?.migratedFromJson ? t("settings.yes") : t("settings.no")}</dd>
            </div>
            <div>
              <dt>{t("session.dataDir")}</dt>
              <dd>{state?.meta.dataDir ?? "-"}</dd>
            </div>
          </dl>
          {storage?.migrationError && <div className="inline-error">{storage.migrationError}</div>}
        </section>

        <section className="settings-section">
          <h2>{t("system.networkTrace")}</h2>
          <dl className="kv-list">
            <div>
              <dt>{t("networkTrace.provider")}</dt>
              <dd>{diagnostics?.networkTrace.providerName ?? state?.settings.networkTrace.providerId ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("networkTrace.url")}</dt>
              <dd>{diagnostics?.networkTrace.providerUrl ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("networkTrace.timeout")}</dt>
              <dd>{diagnostics?.networkTrace.timeoutSeconds ?? state?.settings.networkTrace.timeoutSeconds ?? "-"}</dd>
            </div>
          </dl>
        </section>

        <section className="settings-section">
          <h2>{t("system.sessions")}</h2>
          <dl className="kv-list">
            <div>
              <dt>{t("system.total")}</dt>
              <dd>{diagnostics?.sessions.total ?? state?.sessions.length ?? 0}</dd>
            </div>
            <div>
              <dt>{t("status.running")}</dt>
              <dd>{diagnostics?.sessions.running ?? 0}</dd>
            </div>
            <div>
              <dt>{t("status.launching")}</dt>
              <dd>{diagnostics?.sessions.launching ?? 0}</dd>
            </div>
            <div>
              <dt>{t("status.error")}</dt>
              <dd>{diagnostics?.sessions.error ?? 0}</dd>
            </div>
          </dl>
        </section>

        <section className="settings-section">
          <h2>{t("system.runtime")}</h2>
          <dl className="kv-list">
            <div>
              <dt>{t("settings.shell")}</dt>
              <dd>{runtime?.shell ?? "web"}</dd>
            </div>
            <div>
              <dt>{t("settings.platform")}</dt>
              <dd>{runtime?.platform ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("settings.chrome")}</dt>
              <dd>{runtime?.chrome ?? "native"}</dd>
            </div>
            <div>
              <dt>{t("settings.sidecar")}</dt>
              <dd>{runtime?.sidecar.status ?? t("settings.notApplicable")}</dd>
            </div>
            <div>
              <dt>{t("settings.advancedWebEntry")}</dt>
              <dd>{state?.settings.desktop.advancedWebEntry ? t("settings.yes") : t("settings.no")}</dd>
            </div>
            <div>
              <dt>{t("system.webEndpoint")}</dt>
              <dd>{runtime ? `${runtime.api.host}:${runtime.api.port}` : "-"}</dd>
            </div>
            <div>
              <dt>{t("system.webToken")}</dt>
              <dd>{runtime?.api.tokenRequired ? t("system.required") : t("system.notRequired")}</dd>
            </div>
          </dl>
          {state?.settings.desktop.advancedWebEntry && <div className="result-line">{t("system.advancedWebLocalOnly")}</div>}
        </section>

        <section className="settings-section">
          <h2>{t("system.extensions")}</h2>
          <dl className="kv-list">
            <div>
              <dt>{t("module.extensionSourcesTitle")}</dt>
              <dd>
                {diagnostics
                  ? `${diagnostics.extensionSources.enabled}/${diagnostics.extensionSources.total}`
                  : `${state?.extensionSources?.filter((source) => source.status === "enabled").length ?? 0}/${state?.extensionSources?.length ?? 0}`}
              </dd>
            </div>
            <div>
              <dt>{t("system.extensionCache")}</dt>
              <dd>{diagnostics?.extensionCache.directory ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("system.installedCount")}</dt>
              <dd>{diagnostics?.extensionCache.installedCount ?? state?.extensions?.filter((extension) => extension.installState === "installed").length ?? 0}</dd>
            </div>
            <div>
              <dt>{t("system.lastError")}</dt>
              <dd>{diagnostics?.extensionSources.lastError ?? diagnostics?.extensionCache.lastError ?? "-"}</dd>
            </div>
          </dl>
        </section>

        <section className="settings-section">
          <div className="settings-section-head">
            <h2>{t("system.binary")}</h2>
            <button className="command subtle" onClick={() => void refreshBinary()} type="button">
              <RefreshCw size={16} aria-hidden="true" />
              {t("actions.refresh")}
            </button>
          </div>
          <dl className="kv-list">
            <div>
              <dt>{t("settings.binary")}</dt>
              <dd>{binaryInfo?.installed ? t("form.installed") : t("form.missing")}</dd>
            </div>
            <div>
              <dt>{t("form.path")}</dt>
              <dd>{binaryInfo?.binaryPath ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("form.cache")}</dt>
              <dd>{binaryInfo?.cacheDir ?? "-"}</dd>
            </div>
            <div>
              <dt>{t("settings.platform")}</dt>
              <dd>{binaryInfo?.platform ?? "-"}</dd>
            </div>
          </dl>
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
      <dl className="env-grid">
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
