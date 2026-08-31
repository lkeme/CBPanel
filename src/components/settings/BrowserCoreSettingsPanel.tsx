import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Activity, Download, ExternalLink, FilePlus2, ListChecks, RefreshCw, Sparkles, Trash2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import { type BinaryInfo, type BrowserCoreEnvRuntimeValue, type BrowserCoreImportedBuild, type BrowserCoreLicenseState, type BrowserCoreUpdateCheck, binaryPathOverrideFrom } from "../../shared/browserCore";
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

type ControlledBrowserCoreEnvKey = (typeof OPTIONAL_CLOAKBROWSER_ENV_KEYS)[number];

type CoreSourceDraft = Pick<
  BinarySettings,
  "licenseKey" | "browserVersionMode" | "pinnedBrowserVersion"
>;

const controlledBrowserCoreEnvDefaults: Record<ControlledBrowserCoreEnvKey, {
  value: string;
  valueKind: BrowserCoreEnvValueKind;
}> = {
  CLOAKBROWSER_BINARY_PATH: { value: "", valueKind: "path" },
  CLOAKBROWSER_DOWNLOAD_URL: { value: "", valueKind: "url" },
  CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS: { value: "20", valueKind: "number" },
  CLOAKBROWSER_VERSION: { value: "", valueKind: "text" },
  CLOAKBROWSER_LICENSE_KEY: { value: "", valueKind: "secret" },
  CLOAKBROWSER_RELEASE_CHANNEL: { value: "preview", valueKind: "text" },
};

export function BrowserCoreSettingsPanel({
  binaryInfo,
  busy,
  cancelBrowserCoreOperation,
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
  cancelBrowserCoreOperation?: () => Promise<void>;
  checkBrowserCoreUpdate: () => Promise<void>;
  clearBinaryCache: () => Promise<void>;
  importBrowserCoreZip: (filePath: string, options?: { targetTier?: BrowserCoreTierMode }) => void;
  installBinary: () => Promise<void>;
  openRuntimeCheck: () => void;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  settings: AppSettings;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateBinary: () => Promise<void>;
}) {
  const binary = settings.binary;
  const [coreSourceDraft, setCoreSourceDraft] = useState<CoreSourceDraft>(() => coreSourceDraftFromBinary(binary));
  const [importPath, setImportPath] = useState("");
  const licenseKeySaveRef = useRef<number | undefined>(undefined);
  useEffect(() => () => {
    if (licenseKeySaveRef.current) window.clearTimeout(licenseKeySaveRef.current);
  }, []);
  useEffect(() => {
    setCoreSourceDraft(coreSourceDraftFromBinary(binary));
  }, [binary.licenseKey, binary.browserVersionMode, binary.pinnedBrowserVersion]);
  // Reads the resolved runtime env, so it covers the customBinaryPathEnabled setting, a custom env
  // row and an externally-set variable alike. Scanning customEnvVars missed the settings form — the
  // ordinary UI path — and left every managed action clickable while the cache was inert.
  const binaryPathOverride = binaryPathOverrideFrom(binaryInfo?.core?.env ?? []);
  const managedCoreDisabled = Boolean(binaryPathOverride);
  const operationBusy = browserCoreOperationActive(binaryInfo?.core?.operation) || isBrowserCoreBusy(busy);
  const checkBusy = busy === "browser-core-check-update";
  const importBusy = busy === "browser-core-import";
  const actionBusy = operationBusy || checkBusy;
  const coreInstalled = Boolean(binaryInfo?.installed);
  const update = binaryInfo?.core?.update;
  const updateAvailable = Boolean(update?.updateAvailable);
  const canApplyUpdate = updateAvailable && !update?.blockedReason;
  // Computed once here and passed down, because two places withdraw a claim on it: the badge inside
  // VersionValue and the caveat line below. The stored check is persisted in settings.binary.lastUpdateCheck
  // and nothing re-runs it when the cache changes, so both outlive the build they describe otherwise.
  const checkedThisBuild = updateDescribesBuild(update, binaryInfo?.version);
  const license = binaryInfo?.core?.license;
  // The cache layout this configuration produces, which is what every managed action acts on. Not
  // core.tier: that is proBinaryReady(...) read off disk with no license check, so it reports "pro"
  // whenever a Pro build plus its marker survive — with no key at all.
  const cacheTier = binaryInfo?.core?.targetTier ?? binary.tierMode;
  const installedTier = binaryInfo?.core?.tier;
  // Reporting Free beside a `…\chromium-<version>-pro\chrome.exe` path and a green ready line stated
  // two contradictory facts. The row keeps saying what launches will use; the disagreement is named.
  const tierCacheMismatch = !binaryPathOverride && Boolean(installedTier && installedTier !== cacheTier);
  const tierCacheMismatchText = installedTier
    ? t("browserCore.tierCacheMismatch", {
        derived: browserCoreTierLabel(cacheTier, t),
        installed: browserCoreTierLabel(installedTier, t),
      })
    : undefined;
  const targetVersionMode = binaryInfo?.core?.versionMode ?? binary.browserVersionMode;
  const statusDetail = managedCoreDisabled
    ? t("browserCore.managedActionsDisabled")
    : coreInstalled
      ? t("browserCore.installedStatusDetail")
      : t("browserCore.missingStatusDetail");
  const updateMeta = update
    ? `${t("browserCore.lastCheckedAt")}: ${formatTime(update.checkedAt, "dateTime")}`
    : t("browserCore.updateNotCheckedShort");
  const customDownloadUrl = binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_DOWNLOAD_URL");
  const customDownloadSource = customDownloadUrl
    ? Boolean(customDownloadUrl.enabled && customDownloadUrl.value.trim())
    : binary.downloadSourceMode === "custom" && Boolean(binary.customDownloadBaseUrl.trim());
  // A free *plan* is force-served the latest build, so a pin it cannot honour is hidden rather than
  // offered. Read from the server's plan derivation, not from the tier: the tier is the cache layout
  // and a valid free-plan key produces the Pro one, so `cacheTier === "free"` no longer answers this.
  const planIsFree = binaryInfo?.core?.planIsFree ?? false;

  function saveBinary(patch: Partial<BinarySettings>) {
    void saveSettings({ binary: patch });
  }

  function saveCoreSourceDraft(patch: Partial<CoreSourceDraft>) {
    setCoreSourceDraft((current) => ({ ...current, ...patch }));
    saveBinary(patch);
  }

  // The licence key is the one field whose save reaches an external service: the server validates it
  // to derive the tier. Saving per keystroke sent a partial key to the licence server on every
  // character and earned an HTTP 429, after which a correct key could not be validated at all — the
  // exact failure the derived tier exists to prevent. Keep the field responsive locally and let the
  // save settle first.
  //
  // A pending timer is deliberately left to fire when the switch goes off mid-debounce: it writes the
  // characters typed in the last 700ms, and keeping the key on file is exactly what switching off
  // promises. It reaches no licence server either, because `settingsLicenseKey`
  // (server/services/binaryService.ts) drops the stored key out of the env resolution while the switch is
  // off, so nothing is validated until it is on again.
  function saveLicenseKeyDraft(licenseKey: string) {
    setCoreSourceDraft((current) => ({ ...current, licenseKey }));
    if (licenseKeySaveRef.current) window.clearTimeout(licenseKeySaveRef.current);
    licenseKeySaveRef.current = window.setTimeout(() => {
      licenseKeySaveRef.current = undefined;
      saveBinary({ licenseKey });
    }, 700);
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
        <div className={`settings-status-line browser-core-status-line ${binaryPathOverride ? "warning" : coreInstalled ? "enabled" : "warning"}`}>
          <strong>
            {binaryPathOverride
              ? t("browserCore.overrideShort")
              : coreInstalled ? t("browserCore.readyShort") : t("browserCore.missingShort")}
          </strong>
          <small>{updateMeta}</small>
        </div>
        {binaryPathOverride && (
          <div className="result-line">{t("browserCore.overrideTakesOver", { path: binaryPathOverride })}</div>
        )}
        {tierCacheMismatch && tierCacheMismatchText && (
          <div className="result-line">{tierCacheMismatchText}</div>
        )}
        {update?.error && <div className="inline-error">{update.error}</div>}
        {update?.blockedReason && <div className="result-line">{update.blockedReason}</div>}
        {/* The verdict above came out of a real comparison, but not out of a sound one: the imported
            build and the download source report versions in different shapes, so the answer cannot
            change. Gated on checkedThisBuild for the same reason the up-to-date badge is — the caveat
            describes the build the stored check compared, and once the cache holds a different one it is
            talking about something that is no longer installed. Dropped under an override for the same
            reason the badge is — it is about a build the override prevents from launching. */}
        {update?.baselineCaveat && checkedThisBuild && !binaryPathOverride && (
          <div className="result-line">{t("browserCore.updateBaselineImportedTier")}</div>
        )}
        {binaryInfo?.core?.env.some((item) => item.requiresRuntimeRestart) && (
          <div className="result-line">{t("browserCore.envChangesRestartShort")}</div>
        )}
        {operationBusy && (
          <BrowserCoreOperationPanel
            busy={busy}
            cancelOperation={cancelBrowserCoreOperation ? () => void cancelBrowserCoreOperation() : undefined}
            operation={binaryInfo?.core?.operation}
            t={t}
          />
        )}
        <KeyValueList
          className="browser-core-download-details"
          items={[
            {
              label: binaryPathOverride
                ? t("browserCore.cachedVersion")
                : coreInstalled ? t("browserCore.installedVersion") : t("browserCore.targetVersion"),
              value: (
                <VersionValue
                  importedBuild={binaryInfo?.core?.importedBuild}
                  t={t}
                  // An up-to-date verdict about a build the override prevents from launching is noise.
                  update={binaryPathOverride ? undefined : update}
                  value={binaryInfo?.version}
                />
              ),
            },
            {
              // The hint about where the tier comes from hangs off this label instead of standing on its
              // own line: as a line it restated the value this very row shows, and the value was never the
              // point — the sentence exists to say why no Free/Pro selector is offered. The conditional
              // title below answers a different question (which build the cache still holds), so the two
              // do not compete. `settings-section-title-with-tip` is layout only, so the label keeps the
              // type scale of every other `dt` here.
              label: (
                <span className="settings-section-title-with-tip">
                  {t("browserCore.tier")}
                  <InfoTip text={t("browserCore.tierDerivedHint", { tier: browserCoreTierLabel(cacheTier, t) })} />
                </span>
              ),
              title: tierCacheMismatch ? tierCacheMismatchText : undefined,
              value: browserCoreTierLabel(cacheTier, t),
            },
            { label: t("browserCore.licensePlan"), value: licensePlanText(license, t) },
            { label: t("browserCore.versionMode"), value: browserCoreVersionModeLabel(targetVersionMode, t) },
            { label: t("browserCore.bundledVersion"), value: <CopyableValueRow value={binaryInfo?.core?.versions.baselineChromiumVersion} /> },
            { label: t("browserCore.wrapperVersion"), value: <CopyableValueRow value={binaryInfo?.core?.versions.wrapperVersion} /> },
            { label: coreInstalled ? t("browserCore.executablePath") : t("browserCore.expectedExecutablePath"), value: <CopyableValueRow t={t} value={binaryInfo?.binaryPath} /> },
            {
              // Under an override the wrapper rewrites cacheDir to the override binary's own directory,
              // so the managed cache is not what this path names. Calling it the cache directory is the
              // same claim the rest of this panel stopped making: that the managed core is in play.
              label: binaryPathOverride
                ? t("browserCore.overrideBinaryDirectory")
                : coreInstalled ? t("browserCore.cacheDirectory") : t("browserCore.expectedCacheDirectory"),
              value: <CopyableValueRow t={t} value={binaryInfo?.cacheDir} />,
            },
          ]}
        />
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
        <h2>{t("browserCore.sourceAndLicense")}</h2>
        <ToggleField
          checked={binary.licenseKeyEnabled}
          help={t("browserCore.licenseKeyEnabledHelp")}
          label={t("browserCore.licenseKeyEnabled")}
          onChange={(licenseKeyEnabled) => saveBinary({ licenseKeyEnabled })}
        />
        {/* The switch owns whether a key can be typed at all, so the fieldset carries the disabled state
            and the input stays unaware of it — the shape ManualProxyFields uses for "enable the proxy,
            then fill it in". `disabled-fieldset` is the shared class that styling lives on: `input` here
            has an explicit background and colour, so a disabled input is otherwise indistinguishable
            from an editable one, and a bare fieldset would draw the UA's groove border. Only the key is
            inside it. The release channel, the version mode and the pin are not licence-gated, and the
            switch itself must stay outside or it would disable the only control able to turn it back on. */}
        <fieldset className="disabled-fieldset" disabled={!binary.licenseKeyEnabled}>
          <Field label={t("browserCore.licenseKey")} help={t("browserCore.licenseKeyHelp")} wide>
            <input
              autoComplete="off"
              type="password"
              value={coreSourceDraft.licenseKey}
              onChange={(event) => saveLicenseKeyDraft(event.target.value)}
              placeholder="cb_xxxxxxxx"
            />
          </Field>
        </fieldset>
        {/* customDownloadSource, not downloadSourceMode: a custom URL coming from a custom env row
            flips the tier to free too, and without this note the tier drops with no explanation. */}
        {customDownloadSource && coreSourceDraft.licenseKey.trim() && (
          <div className="result-line">{t("browserCore.customSourceDisablesPro")}</div>
        )}
        <Field label={t("browserCore.releaseChannel")} help={t("browserCore.releaseChannelHelp")}>
          <Segmented
            value={binary.releaseChannel}
            options={[
              { value: "stable", label: t("browserCore.releaseChannelStable") },
              { value: "preview", label: t("browserCore.releaseChannelPreview") },
            ]}
            onChange={(releaseChannel) => saveBinary({ releaseChannel })}
          />
        </Field>
        {!planIsFree && <Field label={t("browserCore.versionMode")}>
          <Segmented
            value={coreSourceDraft.browserVersionMode}
            options={[
              { value: "latest", label: t("browserCore.versionLatest") },
              { value: "pinned", label: t("browserCore.versionPinned") },
            ]}
            onChange={(browserVersionMode) => saveCoreSourceDraft({ browserVersionMode })}
          />
        </Field>}
        {!planIsFree && coreSourceDraft.browserVersionMode === "pinned" && (
          <Field label={t("browserCore.pinnedVersion")} help={t("browserCore.pinnedVersionHelp")} wide>
            <input
              value={coreSourceDraft.pinnedBrowserVersion}
              onChange={(event) => saveCoreSourceDraft({ pinnedBrowserVersion: event.target.value })}
              placeholder="148.0.7778.215.2"
            />
          </Field>
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
      </section>

      <section className="settings-section">
        <h2>{t("browserCore.offlineImport")}</h2>
        <Field label={t("browserCore.manualImport")} help={t("browserCore.manualImportHelp")} wide>
          <div className={`inline-file-row${isTauri() ? "" : " no-picker"}`}>
            <input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder={t("browserCore.importZipPlaceholder")} />
            {isTauri() && (
              <button className="command subtle" onClick={() => void pickBrowserCoreZip(setImportPath, t)} type="button">
                {t("actions.chooseFile")}
              </button>
            )}
            <button
              className="command"
              disabled={!importPath.trim() || actionBusy || importBusy}
              onClick={() => importBrowserCoreZip(importPath, { targetTier: cacheTier })}
              type="button"
            >
              {t("browserCore.analyzeImport")}
            </button>
          </div>
          {/* Below the row, not inside it: sharing the picker's grid track let this sentence take the
              width it needed and squeeze the path input to about 62px in en-US, where the string is
              118 characters. The input is the control this section exists for. */}
          {!isTauri() && <span className="input-hint">{t("browserCore.webManualPathOnly")}</span>}
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

/**
 * The four states the license derivation can come from, kept distinct: no key at all, a key switched
 * off, a plan the license server confirmed, and a key whose plan could not be confirmed. The last one
 * must not read as free — that is the guess the derived tier exists to remove.
 *
 * Nothing the server wrote in prose reaches this cell. `licenseState.error` is an English sentence
 * from the license server, and a rejected key's `plan` is a token the server picks for itself
 * ("unknown", "solo") — rendering it produced `unknown · Invalid`, which collided with this panel's own
 * "could not be validated" wording and meant the opposite of it.
 */
function licensePlanText(
  license: BrowserCoreLicenseState | undefined,
  t: (key: TranslationKey) => string,
): string {
  if (!license?.configured) return t("browserCore.licensePlanNone");
  if (!license.active) return t("browserCore.licensePlanDisabled");
  // Never attempted yet: validation runs behind the read that scheduled it, so the first response
  // after a key is entered carries no verdict. Calling that "could not be validated" asserts a
  // failure that has not happened.
  if (!license.checkedAt) return t("browserCore.licensePlanValidating");
  // Attempted, and the server said no. A rejection is reported as a rejection, never as a plan.
  if (license.valid === false) return t("browserCore.licensePlanInvalid");
  // Attempted, and no verdict came back — the server was unreachable and no cached answer existed.
  if (!license.plan) return t("browserCore.licensePlanUnknown");
  return license.plan;
}

function coreSourceDraftFromBinary(binary: BinarySettings): CoreSourceDraft {
  return {
    licenseKey: binary.licenseKey,
    browserVersionMode: binary.browserVersionMode,
    pinnedBrowserVersion: binary.pinnedBrowserVersion,
  };
}

/**
 * Whether the stored check describes the build that is installed now. A check is persisted in
 * settings.binary.lastUpdateCheck and nothing re-runs it when the cache changes; the managed cache holds
 * exactly one build, so importing a package is an ordinary way to leave the check describing a build that
 * is gone. Every claim read off that check — the up-to-date badge and the baseline caveat alike — has to
 * pass through here, or it keeps stating something about the previous build until the next check.
 *
 * A check with no `currentVersion`, or a panel with no installed version, names no build to disagree with,
 * so it is not treated as stale.
 */
function updateDescribesBuild(update: BrowserCoreUpdateCheck | undefined, version: string | undefined): boolean {
  return Boolean(update && (!update.currentVersion || !version || update.currentVersion === version));
}

function VersionValue({
  importedBuild,
  t,
  update,
  value,
}: {
  importedBuild?: BrowserCoreImportedBuild;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  update?: BrowserCoreUpdateCheck;
  value?: string;
}) {
  // "Up to date" is a claim about a specific build, and the stored check names the build it compared.
  // Nothing re-runs the check when the cache changes, and the managed cache now holds exactly one build,
  // so importing an older package is an ordinary way to make the installed version differ from the one
  // the comparison looked at. Saying nothing beats vouching for a build nobody checked. The other two
  // badges name the version they refer to in their own text, so staleness cannot be read off them.
  const checkedThisBuild = updateDescribesBuild(update, value);
  // The baseline caveat is that same objection one step on: the versions do agree, but they were compared
  // across two release feeds whose version shapes differ, so the verdict is fixed and never meant
  // anything. Both conditions withdraw only "up to date"; neither touches the other two badges.
  const upToDate = Boolean(update && checkedThisBuild && !update.baselineCaveat);
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
      : upToDate
        ? <StatusPill tone="running">{t("browserCore.upToDate")}</StatusPill>
        : null;
  // Provenance is a fact about the build this row names, read back from that build's own directory — not
  // a verdict about it — so it does not compete with the badge above and the two coexist. The update
  // badge still comes first because it is the one a user acts on. Two pills is the ceiling here, which is
  // the other reason the caveat withdraws "up to date" instead of adding a third pill next to it. The gap
  // between them belongs to `.browser-core-detail-suffix`, the slot they share: it is static spacing, and
  // the only inline styles in this codebase carry values CSS cannot know.
  //
  // The version in the tooltip is the archive's own, and the text says so: the server accepts a marker
  // whose version names the same Chromium build as the resolved one rather than the identical string, so
  // after repairCompatibleManagedCache renamed the build onto a longer version's directory name this
  // number legitimately differs from the one this very row shows.
  const localBadge = importedBuild
    ? (
        <StatusPill
          title={t("browserCore.localBuildBadgeDetail", {
            at: formatTime(importedBuild.importedAt, "dateTime"),
            file: importedBuild.fileName,
            sha: importedBuild.sha256.slice(0, 12),
            version: importedBuild.version,
          })}
        >
          {t("browserCore.localBuildBadge")}
        </StatusPill>
      )
    : null;

  return (
    <CopyableValueRow
      className="browser-core-version-value"
      // Undefined rather than an always-present fragment: CopyableValueRow keys its suffix layout off
      // this prop being set at all.
      suffix={badge || localBadge ? <>{badge}{localBadge}</> : undefined}
      value={value}
    />
  );
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
