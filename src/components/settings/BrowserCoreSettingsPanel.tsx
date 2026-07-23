import { useEffect, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Activity, Download, ExternalLink, FilePlus2, ListChecks, RefreshCw, Sparkles, Trash2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import type { BinaryInfo, BrowserCoreEnvRuntimeValue, BrowserCoreUpdateCheck } from "../../shared/browserCore";
import {
  CLOAKBROWSER_ENV_SUGGESTION_KEYS,
  OPTIONAL_CLOAKBROWSER_ENV_KEYS,
  type AppSettings,
  type AppSettingsPatch,
  type BinarySettings,
  type BrowserCoreTierMode,
  type BrowserCoreEnvValueKind,
  type BrowserCoreEnvVarSetting,
  isBuiltinCloakBrowserEnvKey,
  isManagedCloakBrowserEnvKey,
  normalizeCloakBrowserEnvKey,
} from "../../shared/settings";
import {
  BrowserCoreOperationPanel,
  browserCoreOperationActive,
  browserCoreTierLabel,
  browserCoreVersionModeLabel,
  isBrowserCoreBusy,
} from "../browser-core/BrowserCoreStatusPanels";
import { Field, InfoTip, Segmented, ToggleField } from "../ui/form-controls";
import { CopyableValueRow, KeyValueList } from "../ui/KeyValueList";
import { StatusPill } from "../ui/StatusPill";
import { Switch } from "../ui/switch";
import { EnvKeyCombobox } from "./EnvKeyCombobox";

const CLOAKBROWSER_CONFIG_DOC_URL = "https://github.com/CloakHQ/CloakBrowser/tree/main#configuration";

type DownloadLinkView = "current" | "latest";
type ControlledBrowserCoreEnvKey = (typeof OPTIONAL_CLOAKBROWSER_ENV_KEYS)[number];

type OfflineImportDraft = Pick<
  BinarySettings,
  "tierMode" | "licenseKey" | "browserVersionMode" | "pinnedBrowserVersion"
>;

const controlledBrowserCoreEnvDefaults: Record<ControlledBrowserCoreEnvKey, {
  value: string;
  valueKind: BrowserCoreEnvValueKind;
}> = {
  CLOAKBROWSER_BINARY_PATH: { value: "", valueKind: "path" },
  CLOAKBROWSER_DOWNLOAD_URL: { value: "", valueKind: "url" },
  CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS: { value: "12", valueKind: "number" },
  CLOAKBROWSER_VERSION: { value: "", valueKind: "text" },
  CLOAKBROWSER_LICENSE_KEY: { value: "", valueKind: "secret" },
};

export function BrowserCoreSettingsPanel({
  binaryInfo,
  busy,
  checkBrowserCoreUpdate,
  clearBinaryCache,
  importBrowserCoreZip,
  installBinary,
  openRuntimeCheck,
  saveSettings,
  settings,
  t,
  updateBinary,
}: {
  binaryInfo: BinaryInfo | null;
  busy: string;
  checkBrowserCoreUpdate: () => Promise<void>;
  clearBinaryCache: () => Promise<void>;
  importBrowserCoreZip: (
    filePath: string,
    options?: { setAsDefault?: boolean; targetTier?: BrowserCoreTierMode },
  ) => void;
  installBinary: () => Promise<void>;
  openRuntimeCheck: () => void;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  settings: AppSettings;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateBinary: () => Promise<void>;
}) {
  const binary = settings.binary;
  const [offlineImportDraft, setOfflineImportDraft] = useState<OfflineImportDraft>(() => offlineImportDraftFromBinary(binary));
  const [importPath, setImportPath] = useState("");
  const [downloadLinkView, setDownloadLinkView] = useState<DownloadLinkView>("current");
  useEffect(() => {
    setOfflineImportDraft(offlineImportDraftFromBinary(binary));
  }, [binary.tierMode, binary.licenseKey, binary.browserVersionMode, binary.pinnedBrowserVersion]);
  const managedCoreDisabled = Boolean(
    binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_BINARY_PATH" && item.enabled && item.value.trim()),
  );
  const operationBusy = browserCoreOperationActive(binaryInfo?.core?.operation) || isBrowserCoreBusy(busy);
  const checkBusy = busy === "browser-core-check-update";
  const importBusy = busy === "browser-core-import";
  const actionBusy = operationBusy || checkBusy;
  const coreInstalled = Boolean(binaryInfo?.installed);
  const update = binaryInfo?.core?.update;
  const updateAvailable = Boolean(update?.updateAvailable);
  const canApplyUpdate = updateAvailable && !update?.blockedReason;
  const latestDownloadLinks = updateAvailable ? update?.downloadLinks : undefined;
  const currentDownloadLinks = binaryInfo?.core?.downloads.current;
  const selectedDownloadLinks = downloadLinkView === "latest" && latestDownloadLinks ? latestDownloadLinks : currentDownloadLinks;
  const targetTier = binaryInfo?.core?.targetTier ?? binary.tierMode;
  const targetVersionMode = binaryInfo?.core?.versionMode ?? binary.browserVersionMode;
  const statusDetail = managedCoreDisabled
    ? t("browserCore.managedActionsDisabled")
    : coreInstalled
      ? t("browserCore.installedStatusDetail")
      : t("browserCore.missingStatusDetail");
  const updateMeta = update
    ? `${t("browserCore.lastCheckedAt")}: ${formatTime(update.checkedAt, "dateTime")}`
    : t("browserCore.updateNotCheckedShort");
  const customLicenseKey = binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_LICENSE_KEY");
  const managedLicenseKey = customLicenseKey
    ? customLicenseKey.enabled ? customLicenseKey.value.trim() : ""
    : offlineImportDraft.licenseKey.trim();
  const customDownloadUrl = binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_DOWNLOAD_URL");
  const customDownloadSource = customDownloadUrl
    ? Boolean(customDownloadUrl.enabled && customDownloadUrl.value.trim())
    : binary.downloadSourceMode === "custom" && Boolean(binary.customDownloadBaseUrl.trim());
  const freeKeyUsesLatest = !customDownloadSource
    && offlineImportDraft.tierMode === "free"
    && Boolean(managedLicenseKey);

  useEffect(() => {
    setDownloadLinkView(latestDownloadLinks ? "latest" : "current");
  }, [latestDownloadLinks?.primaryUrl]);

  function saveBinary(patch: Partial<BinarySettings>) {
    void saveSettings({ binary: patch });
  }

  function saveOfflineImportDraft(patch: Partial<OfflineImportDraft>) {
    setOfflineImportDraft((current) => ({ ...current, ...patch }));
    saveBinary(patch);
  }

  return (
    <div className="settings-stack no-padding">
      <section className="settings-section">
        <div className="settings-section-head browser-core-download-head">
          <div className="settings-section-title-with-tip">
            <h2>{t("browserCore.downloadInstall")}</h2>
            <InfoTip text={statusDetail} />
          </div>
          <div className="row-actions">
            {canApplyUpdate && (
              <button
                className="command primary"
                disabled={managedCoreDisabled || actionBusy}
                onClick={() => void updateBinary()}
                title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
                type="button"
              >
                <RefreshCw size={16} aria-hidden="true" />
                {t("actions.update")}
              </button>
            )}
            <button
              className="command success"
              disabled={managedCoreDisabled || actionBusy}
              onClick={() => void installBinary()}
              title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
              type="button"
            >
              <Download size={16} aria-hidden="true" />
              {coreInstalled ? t("actions.reinstall") : t("actions.install")}
            </button>
            <button className="command" disabled={actionBusy} onClick={() => void checkBrowserCoreUpdate()} type="button">
              <Activity size={16} aria-hidden="true" />
              {t("actions.checkUpdate")}
            </button>
            <button
              className="command danger subtle"
              disabled={managedCoreDisabled || actionBusy}
              onClick={() => void clearBinaryCache()}
              title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
              type="button"
            >
              <Trash2 size={16} aria-hidden="true" />
              {t("actions.clearCache")}
            </button>
            <button className="command subtle" onClick={openRuntimeCheck} type="button">
              <ListChecks size={16} aria-hidden="true" />
              {t("browserCore.runtimeCheckTitle")}
            </button>
          </div>
        </div>
        <div className={`settings-status-line browser-core-status-line ${coreInstalled ? "enabled" : "warning"}`}>
          <strong>{coreInstalled ? t("browserCore.readyShort") : t("browserCore.missingShort")}</strong>
          <small>{updateMeta}</small>
        </div>
        {update?.error && <div className="inline-error">{update.error}</div>}
        {update?.blockedReason && <div className="result-line">{update.blockedReason}</div>}
        {binaryInfo?.core?.env.some((item) => item.requiresRuntimeRestart) && (
          <div className="result-line">{t("browserCore.envChangesRestartShort")}</div>
        )}
        {operationBusy && (
          <BrowserCoreOperationPanel busy={busy} operation={binaryInfo?.core?.operation} t={t} />
        )}
        <KeyValueList
          className="browser-core-download-details"
          items={[
            {
              label: coreInstalled ? t("browserCore.installedVersion") : t("browserCore.targetVersion"),
              value: (
                <VersionValue
                  t={t}
                  update={update}
                  value={binaryInfo?.version}
                />
              ),
            },
            { label: t("browserCore.tier"), value: browserCoreTierLabel(targetTier, t) },
            { label: t("browserCore.versionMode"), value: browserCoreVersionModeLabel(targetVersionMode, t) },
            { label: t("browserCore.bundledVersion"), value: <CopyableValueRow value={binaryInfo?.core?.versions.baselineChromiumVersion} /> },
            { label: t("browserCore.wrapperVersion"), value: <CopyableValueRow value={binaryInfo?.core?.versions.wrapperVersion} /> },
            { label: coreInstalled ? t("browserCore.executablePath") : t("browserCore.expectedExecutablePath"), value: <CopyableValueRow t={t} value={binaryInfo?.binaryPath} /> },
            { label: coreInstalled ? t("browserCore.cacheDirectory") : t("browserCore.expectedCacheDirectory"), value: <CopyableValueRow t={t} value={binaryInfo?.cacheDir} /> },
          ]}
        />
        <div className="browser-core-download-links-panel">
          <div className="browser-core-download-links-head">
            <strong>{t("browserCore.downloadLinks")}</strong>
            {latestDownloadLinks && (
              <div className="segmented compact" role="group" aria-label={t("browserCore.downloadLinks")}>
                <button
                  className={downloadLinkView === "current" ? "active" : ""}
                  onClick={() => setDownloadLinkView("current")}
                  type="button"
                >
                  {t("browserCore.currentDownload")}
                </button>
                <button
                  className={downloadLinkView === "latest" ? "active" : ""}
                  onClick={() => setDownloadLinkView("latest")}
                  type="button"
                >
                  {t("browserCore.latestDownload")}
                </button>
              </div>
            )}
          </div>
          <KeyValueList
            className="browser-core-download-details compact-links"
            items={[
              { label: t("browserCore.primaryUrl"), value: <CopyableValueRow t={t} value={selectedDownloadLinks?.primaryUrl ?? binaryInfo?.downloadUrl} /> },
              { label: t("browserCore.fallbackUrl"), value: <CopyableValueRow t={t} value={selectedDownloadLinks?.fallbackUrl} /> },
              { label: t("browserCore.signatureUrl"), value: <CopyableValueRow t={t} value={selectedDownloadLinks?.signatureUrl} /> },
            ]}
          />
        </div>
        <ToggleField
          checked={binary.checkForUpdatesOnStartup}
          help={t("browserCore.startupCheckHelp")}
          label={t("browserCore.startupCheck")}
          onChange={(checkForUpdatesOnStartup) => saveBinary({ checkForUpdatesOnStartup })}
        />
        <ToggleField
          checked={binary.preferExistingCache}
          label={t("browserCore.preferExistingCache")}
          help={t("browserCore.preferExistingCacheHelp")}
          onChange={(preferExistingCache) => saveBinary({ preferExistingCache })}
        />
      </section>

      <section className="settings-section">
        <h2>{t("browserCore.offlineImport")}</h2>
        <Field label={t("browserCore.tier")}>
          <Segmented
            value={offlineImportDraft.tierMode}
            options={[
              { value: "free", label: t("browserCore.tierFree") },
              { value: "pro", label: t("browserCore.tierPro") },
            ]}
            onChange={(tierMode) => saveOfflineImportDraft({ tierMode })}
          />
        </Field>
        <Field label={t("browserCore.licenseKey")} help={t("browserCore.licenseKeyHelp")} wide>
          <input
            autoComplete="off"
            type="password"
            value={offlineImportDraft.licenseKey}
            onChange={(event) => saveOfflineImportDraft({ licenseKey: event.target.value })}
            placeholder="cb_xxxxxxxx"
          />
        </Field>
        {!freeKeyUsesLatest && <Field label={t("browserCore.versionMode")}>
          <Segmented
            value={offlineImportDraft.browserVersionMode}
            options={[
              { value: "latest", label: t("browserCore.versionLatest") },
              { value: "pinned", label: t("browserCore.versionPinned") },
            ]}
            onChange={(browserVersionMode) => saveOfflineImportDraft({ browserVersionMode })}
          />
        </Field>}
        {!freeKeyUsesLatest && offlineImportDraft.browserVersionMode === "pinned" && (
          <Field label={t("browserCore.pinnedVersion")} help={t("browserCore.pinnedVersionHelp")} wide>
            <input
              value={offlineImportDraft.pinnedBrowserVersion}
              onChange={(event) => saveOfflineImportDraft({ pinnedBrowserVersion: event.target.value })}
              placeholder="148.0.7778.215.2"
            />
          </Field>
        )}
        {binary.downloadSourceMode === "custom" && offlineImportDraft.licenseKey.trim() && (
          <div className="result-line">{t("browserCore.customSourceDisablesPro")}</div>
        )}
        <Field label={t("browserCore.cacheDirMode")}>
          <Segmented
            value={binary.cacheDirMode}
            options={[
              { value: "auto", label: t("browserCore.cacheAuto") },
              { value: "custom", label: t("browserCore.cacheCustom") },
            ]}
            onChange={(cacheDirMode) => saveBinary({ cacheDirMode })}
          />
        </Field>
        {binary.cacheDirMode === "custom" && (
          <Field label={t("browserCore.customCacheDir")} wide>
            <input
              value={binary.customCacheDir}
              onChange={(event) => saveBinary({ customCacheDir: event.target.value })}
              placeholder={t("browserCore.customCacheDirPlaceholder")}
            />
          </Field>
        )}
        <Field label={t("browserCore.manualImport")} help={t("browserCore.manualImportHelp")} wide>
          <div className="inline-file-row">
            <input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder={t("browserCore.importZipPlaceholder")} />
            {isTauri() ? (
              <button className="command subtle" onClick={() => void pickBrowserCoreZip(setImportPath, t)} type="button">
                {t("actions.chooseFile")}
              </button>
            ) : (
              <span className="input-hint">{t("browserCore.webManualPathOnly")}</span>
            )}
            <button
              className="command"
              disabled={!importPath.trim() || actionBusy || importBusy}
              onClick={() => importBrowserCoreZip(importPath, {
                setAsDefault: offlineImportDraft.browserVersionMode !== "pinned",
                targetTier: offlineImportDraft.tierMode,
              })}
              type="button"
            >
              {t("browserCore.analyzeImport")}
            </button>
          </div>
        </Field>
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <h2>{t("browserCore.runtimeVariables")}</h2>
          <a className="command subtle" href={CLOAKBROWSER_CONFIG_DOC_URL} rel="noreferrer" target="_blank">
            <ExternalLink size={16} aria-hidden="true" />
            {t("browserCore.envDocs")}
          </a>
        </div>
        <BrowserCoreEnvTable env={builtinBrowserCoreRuntimeEnv(binaryInfo?.core?.env ?? [])} t={t} />
        <CustomEnvVarEditor binary={binary} saveBinary={saveBinary} t={t} />
      </section>
    </div>
  );
}

function offlineImportDraftFromBinary(binary: BinarySettings): OfflineImportDraft {
  return {
    tierMode: binary.tierMode,
    licenseKey: binary.licenseKey,
    browserVersionMode: binary.browserVersionMode,
    pinnedBrowserVersion: binary.pinnedBrowserVersion,
  };
}

function VersionValue({
  t,
  update,
  value,
}: {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  update?: BrowserCoreUpdateCheck;
  value?: string;
}) {
  const badge = update?.error
    ? (
        <StatusPill tone="error" title={update.error}>
          {t("browserCore.updateCheckFailed")}
        </StatusPill>
      )
    : update?.updateAvailable && update.latestVersion
      ? (
          <StatusPill tone="warning" title={t("browserCore.updateAvailable", { version: update.latestVersion })}>
            <Sparkles size={12} aria-hidden="true" />
            {t("browserCore.newVersionBadge")}
          </StatusPill>
        )
      : update
        ? <StatusPill tone="running">{t("browserCore.upToDate")}</StatusPill>
        : null;

  return <CopyableValueRow className="browser-core-version-value" suffix={badge} value={value} />;
}

async function pickBrowserCoreZip(
  setImportPath: React.Dispatch<React.SetStateAction<string>>,
  t: (key: TranslationKey) => string,
) {
  try {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "CloakBrowser Archive", extensions: ["zip", "tar.gz", "tgz"] }],
    });
    if (typeof selected === "string") setImportPath(selected);
  } catch (error) {
    console.warn(t("browserCore.filePickerFailed"), error);
  }
}

function BrowserCoreEnvTable({
  env,
  t,
}: {
  env: BrowserCoreEnvRuntimeValue[];
  t: (key: TranslationKey) => string;
}) {
  if (env.length === 0) return <div className="preflight-empty">{t("browserCore.envEmpty")}</div>;
  return (
    <div className="browser-core-env-table">
      {env.map((item) => (
        <div className="browser-core-env-row" key={item.key}>
          <span>
            <strong className="mono-cell">{item.key}</strong>
            <small>{item.detail || envSourceText(item.source, t)}</small>
          </span>
          <StatusPill tone={item.enabled ? "running" : "stopped"}>
            {item.enabled ? t("status.enabled") : t("status.disabled")}
          </StatusPill>
          <span className="mono-cell">{item.maskedValue || "-"}</span>
          <small>{item.requiresRuntimeRestart ? t("browserCore.restartRequired") : "-"}</small>
        </div>
      ))}
    </div>
  );
}

function envSourceText(
  source: BrowserCoreEnvRuntimeValue["source"],
  t: (key: TranslationKey) => string,
): string {
  if (source === "settings") return t("browserCore.envSource.settings");
  if (source === "custom") return t("browserCore.envSource.custom");
  if (source === "external") return t("browserCore.envSource.external");
  if (source === "cbpanel-default") return t("browserCore.envSource.cbpanel");
  return t("browserCore.envSource.cloakbrowser");
}

function builtinBrowserCoreRuntimeEnv(env: BrowserCoreEnvRuntimeValue[]): BrowserCoreEnvRuntimeValue[] {
  return env.filter((item) => isBuiltinCloakBrowserEnvKey(item.key));
}

function CustomEnvVarEditor({
  binary,
  saveBinary,
  t,
}: {
  binary: BinarySettings;
  saveBinary: (patch: Partial<BinarySettings>) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const blank = (): BrowserCoreEnvVarSetting => ({
    id: crypto.randomUUID(),
    key: "",
    value: "",
    enabled: true,
    sensitive: false,
    description: "",
    valueKind: "text",
  });
  const customRows = binary.customEnvVars;
  const customKeyOptions = [
    ...CLOAKBROWSER_ENV_SUGGESTION_KEYS,
    ...customRows.map((item) => item.key),
  ].filter((key, index, list) => list.indexOf(key) === index);
  const [draft, setDraft] = useState<BrowserCoreEnvVarSetting>(() => blank());
  const normalizedKey = normalizeCloakBrowserEnvKey(draft.key);
  const duplicate = normalizedKey ? binary.customEnvVars.some((item) => item.key === normalizedKey) : false;
  const blockedManaged = normalizedKey ? isManagedCloakBrowserEnvKey(normalizedKey) : false;
  const canAdd = Boolean(normalizedKey && draft.value.trim() && !duplicate && !blockedManaged);

  function updateCustomEnv(id: string, patch: Partial<BrowserCoreEnvVarSetting>) {
    saveBinary({
      customEnvVars: binary.customEnvVars.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    });
  }

  function deleteCustomEnv(id: string) {
    saveBinary({ customEnvVars: binary.customEnvVars.filter((item) => item.id !== id) });
  }

  function addCustomEnv() {
    if (!canAdd || !normalizedKey) return;
    saveBinary({
      customEnvVars: [
        ...binary.customEnvVars,
        {
          ...draft,
          id: crypto.randomUUID(),
          key: normalizedKey,
          sensitive: envSensitiveForKey(normalizedKey),
          valueKind: envValueKindForKey(normalizedKey, draft.valueKind),
        },
      ],
    });
    setDraft(blank());
  }

  return (
    <section className="custom-env-editor">
      <div className="panel-heading">
        <span>
          <strong>{t("browserCore.customEnv")}</strong>
          <small>{t("browserCore.envEditorHelp")}</small>
        </span>
        <button
          aria-label={t("browserCore.addEnv")}
          className="icon-button compact"
          disabled={!canAdd}
          onClick={addCustomEnv}
          title={t("browserCore.addEnv")}
          type="button"
        >
          <FilePlus2 size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="custom-env-list">
        {customRows.map((item) => (
          <div className={`custom-env-row ${item.enabled ? "" : "disabled"}`} key={item.id}>
            <Switch
              aria-label={t("browserCore.envEnabled")}
              checked={item.enabled}
              className="toggle-switch"
              onCheckedChange={(enabled) => updateCustomEnv(item.id, { enabled })}
            />
            <EnvKeyCombobox
              options={customKeyOptions}
              t={t}
              value={item.key}
              onChange={(key) => updateCustomEnv(item.id, {
                key,
                sensitive: envSensitiveForKey(key),
                valueKind: envValueKindForKey(key, item.valueKind),
              })}
            />
            <input
              className="mono-cell"
              value={item.value}
              onChange={(event) => updateCustomEnv(item.id, { value: event.target.value })}
              placeholder={t("browserCore.envValuePlaceholder")}
            />
            <button
              aria-label={t("actions.delete")}
              className="icon-button compact danger"
              onClick={() => deleteCustomEnv(item.id)}
              title={t("actions.delete")}
              type="button"
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <div className="custom-env-add-row">
        <span className="env-row-enabled muted">{t("browserCore.envNew")}</span>
        <EnvKeyCombobox
          options={customKeyOptions}
          t={t}
          value={draft.key}
          onChange={(key) => setDraft((current) => ({
            ...current,
            key,
            sensitive: envSensitiveForKey(key),
            valueKind: envValueKindForKey(key, current.valueKind),
          }))}
        />
        <input
          className="mono-cell"
          value={draft.value}
          onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
          placeholder={t("browserCore.envValuePlaceholder")}
        />
        <button
          aria-label={t("browserCore.addEnv")}
          className="icon-button compact"
          disabled={!canAdd}
          onClick={addCustomEnv}
          title={t("browserCore.addEnv")}
          type="button"
        >
          <FilePlus2 size={16} aria-hidden="true" />
        </button>
      </div>
      {blockedManaged && <div className="inline-error">{t("browserCore.envManagedBlocked")}</div>}
      {duplicate && <div className="inline-error">{t("browserCore.envDuplicate")}</div>}
    </section>
  );
}

function envValueKindForKey(key: string, fallback: BrowserCoreEnvValueKind): BrowserCoreEnvValueKind {
  const controlled = controlledBrowserCoreEnvDefaults[key as ControlledBrowserCoreEnvKey];
  if (controlled) return controlled.valueKind;
  if (key.endsWith("_DIR") || key.endsWith("_CDM")) return "directory";
  if (key.endsWith("_URL")) return "url";
  if (key.endsWith("_SECONDS") || key.endsWith("_TIMEOUT")) return "number";
  if (key === "CLOAKBROWSER_WIDEVINE") return "boolean";
  return fallback === "secret" ? "text" : fallback;
}

function envSensitiveForKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(key);
}
