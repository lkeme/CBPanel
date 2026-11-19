import { useEffect, useRef, useState } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Activity, CloudOff, Cloud, Download, ExternalLink, Eye, EyeOff, ListChecks, RefreshCw, Sparkles, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import { type BinaryInfo, type BrowserCoreEnvRuntimeValue, type BrowserCoreImportedBuild, type BrowserCoreLicenseState, type BrowserCoreOfficialLicenseState, type BrowserCoreTargetVersion, type BrowserCoreUpdateCheck, type BrowserCorePrivateRelease, binaryPathOverrideFrom, browserCoreLicenseIssue, browserCorePinIssue } from "../../shared/browserCore";
import { api, browserCoreErrorMessage, browserCoreUpdateErrorMessage } from "../../lib/apiClient";
import { BROWSER_CORE_LINKS, openBrowserCoreLink, type BrowserCoreLink } from "../../lib/browserCoreExternalNavigation";
import { normalizeGithubRepositoryUrl } from "../../shared/githubRepository";
import { githubTokenKind } from "../../shared/githubToken";
import {
  type AppSettings,
  type AppSettingsPatch,
  type BinarySettings,
  type BrowserCoreTierMode,
  type BrowserCoreChannel,
  type BrowserCoreChannelMode,
} from "../../shared/settings";
import {
  BrowserCoreOperationPanel,
  browserCoreOperationActive,
  isBrowserCoreBusy,
} from "../browser-core/BrowserCoreStatusPanels";
import { Field, InfoTip, Segmented, ToggleField } from "../ui/form-controls";
import { CopyableValueRow, KeyValueList } from "../ui/KeyValueList";
import { StatusPill } from "../ui/StatusPill";
import { BrowserCoreEnvironmentEditor } from "./BrowserCoreEnvironmentEditor";
import { BrowserCoreLicenseIndicator } from "./BrowserCoreLicenseIndicator";
import { countWrapperGesture } from "./coreWrapperGesture";
import { readStoredCoreCard, resolveCoreCard, storeCoreCard } from "./coreCardSelection";
import {
  emptyPrivateCoreCatalog,
  privateCoreConfigurationDirty,
  receivePrivateCoreCatalog,
  type PrivateCoreCatalog,
} from "./privateCoreReleaseState";

type CoreSourceDraft = Pick<
  BinarySettings,
  "licenseKey" | "browserVersionMode" | "pinnedBrowserVersion"
>;

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
  loadPrivateReleases,
  testPrivateRepository,
  installPrivateVersion,
  activateCoreChannel,
  clearPrivateToken,
  hasActiveSessions = false,
}: {
  binaryInfo: BinaryInfo | null;
  busy: string;
  cancelBrowserCoreOperation?: () => Promise<void>;
  checkBrowserCoreUpdate: (options?: { targetChannel?: BrowserCoreChannel }) => Promise<void>;
  clearBinaryCache: (targetChannel?: BrowserCoreChannel) => Promise<void>;
  importBrowserCoreZip: (filePath: string, options?: { targetTier?: BrowserCoreTierMode; targetChannel?: BrowserCoreChannel }) => void;
  installBinary: (targetChannel?: BrowserCoreChannel) => Promise<void>;
  openRuntimeCheck: () => void;
  saveSettings: (patch: AppSettingsPatch, options?: { throwOnError?: boolean }) => Promise<void>;
  settings: AppSettings;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateBinary: (targetChannel?: BrowserCoreChannel) => Promise<void>;
  loadPrivateReleases?: (repositoryUrl?: string) => Promise<BrowserCorePrivateRelease[]>;
  testPrivateRepository?: (repositoryUrl: string, token?: string) => Promise<{ configured?: boolean; repositoryUrl?: string }>;
  installPrivateVersion?: (version?: string, source?: { repositoryUrl?: string; releaseId?: number }) => Promise<void>;
  activateCoreChannel?: (channel: BrowserCoreChannel, mode: BrowserCoreChannelMode, expectedVersion?: string) => Promise<void>;
  clearPrivateToken?: () => Promise<void>;
  hasActiveSessions?: boolean;
}) {
  const binary = settings.binary;
  const activeChannel = binaryInfo?.core?.channel ?? binary.coreChannel;
  const activeMode = binaryInfo?.core?.channelMode ?? binary.coreChannelMode;
  const privateUnlocked = binary.privateChannelUnlocked;
  // One card, one channel at a time. The gesture on the version label (and only it) moves this; while
  // the card is not the active channel, every action in it is aimed at the channel it shows. The choice
  // is a view preference and outlives the drawer: reopening settings lands on the same card instead of
  // starting from whichever channel runs.
  const [displayChannel, setDisplayChannel] = useState<BrowserCoreChannel>(() =>
    resolveCoreCard(readStoredCoreCard(), { unlocked: binary.privateChannelUnlocked, activeChannel }),
  );
  const [coreSourceDraft, setCoreSourceDraft] = useState<CoreSourceDraft>(() => coreSourceDraftFromBinary(binary));
  const [importOpen, setImportOpen] = useState(false);
  const [importPath, setImportPath] = useState("");
  const [importPicking, setImportPicking] = useState(false);
  const [importError, setImportError] = useState<string>();
  const licenseKeySaveRef = useRef<number | undefined>(undefined);
  const pendingLicenseSave = useRef<(() => void) | undefined>(undefined);
  const licenseSaveSequence = useRef(0);
  const [licenseSaving, setLicenseSaving] = useState(false);
  const [versionSaving, setVersionSaving] = useState(false);
  const [pinTouched, setPinTouched] = useState(binary.browserVersionMode === "pinned");
  const [directoryPicking, setDirectoryPicking] = useState(false);
  const [directoryError, setDirectoryError] = useState<string>();
  const [privateRepositoryUrl, setPrivateRepositoryUrl] = useState(binary.privateRepositoryUrl);
  const [privateToken, setPrivateToken] = useState("");
  const [privateCatalog, setPrivateCatalog] = useState<PrivateCoreCatalog>(emptyPrivateCoreCatalog);
  const [privateReleasesBusy, setPrivateReleasesBusy] = useState(false);
  const [privateRepositoryBusy, setPrivateRepositoryBusy] = useState(false);
  const privateUnlockClicks = useRef(0);
  const [unlockSaving, setUnlockSaving] = useState(false);
  useEffect(() => () => {
    if (licenseKeySaveRef.current) window.clearTimeout(licenseKeySaveRef.current);
    pendingLicenseSave.current?.();
  }, []);
  // The card follows the running channel when something else changes it — but not on mount, where the
  // stored choice is what the operator last left on screen, and not for a gesture: that path moves the
  // display first and lets the activation catch up. Comparing against the previous value instead of a
  // "first run" flag keeps this idempotent under an effect that runs twice.
  const previousActiveChannel = useRef(activeChannel);
  useEffect(() => {
    if (previousActiveChannel.current === activeChannel) return;
    previousActiveChannel.current = activeChannel;
    showChannel(activeChannel);
  }, [activeChannel]);
  useEffect(() => {
    if (!licenseSaving) setCoreSourceDraft((current) => ({ ...current, licenseKey: binary.licenseKey }));
  }, [binary.licenseKey, licenseSaving]);
  useEffect(() => {
    if (!versionSaving) setCoreSourceDraft((current) => ({ ...current, browserVersionMode: binary.browserVersionMode, pinnedBrowserVersion: binary.pinnedBrowserVersion }));
  }, [binary.browserVersionMode, binary.pinnedBrowserVersion, versionSaving]);
  useEffect(() => {
    setPrivateRepositoryUrl(binary.privateRepositoryUrl);
    setPrivateCatalog(emptyPrivateCoreCatalog());
  }, [binary.privateRepositoryUrl]);
  // Reads the resolved runtime env, so it covers the customBinaryPathEnabled setting, a custom env
  // row and an externally-set variable alike. Scanning customEnvVars missed the settings form — the
  // ordinary UI path — and left every managed action clickable while the cache was inert.
  const binaryPathOverride = externalCoreOverride(binaryInfo);
  const managedCoreDisabled = Boolean(binaryPathOverride);
  const operationBusy = browserCoreOperationActive(binaryInfo?.core?.operation) || isBrowserCoreBusy(busy);
  const checkBusy = busy === "browser-core-check-update";
  const importBusy = busy === "browser-core-import";
  const actionBusy = operationBusy || checkBusy || busy === "browser-core-channel-switch";
  const downloadActionBusy = actionBusy || licenseSaving || versionSaving;
  const channelStates = coreChannelStates(binaryInfo, activeChannel);
  const display = displayChannel;
  const displayIsActive = display === activeChannel;
  // Mode belongs to the running channel; a channel that is not running is always looked at in its
  // online configuration, because that is what enabling it installs.
  const displayMode: BrowserCoreChannelMode = displayIsActive ? activeMode : "online";
  const displayInstalled = displayIsActive ? Boolean(binaryInfo?.installed) : channelStates[display].installed;
  const displayVersion = displayIsActive ? binaryInfo?.version : channelStates[display].version;
  const official = display === "official";
  // The mode switch is live only where it can act. Every other combination — the other card, a missing
  // build, a running operation, live sessions, an override — renders the same inert readout, so the
  // icon never offers a hover state the click cannot honour.
  const modeSwitchable = displayIsActive && displayInstalled && !actionBusy && !hasActiveSessions && !managedCoreDisabled;
  const onlineCheckSupported = displayMode === "online";
  // The stored check belongs to the running channel, so every claim it supports is read only while that
  // channel is the one on screen.
  const update = binaryInfo?.core?.update;
  // Computed once here and passed down, because two places withdraw a claim on it: the badge inside
  // VersionValue and the caveat line below. The stored check is persisted in settings.binary.lastUpdateCheck
  // and nothing re-runs it when the cache changes, so both outlive the build they describe otherwise.
  const checkedThisBuild = updateDescribesBuild(update, displayVersion);
  const updateAvailable = Boolean(update?.updateAvailable && checkedThisBuild);
  // The stored check describes the running channel and the build it compared. A card showing the
  // other channel must not apply it, and an override or a rejected key withdraws it for the reasons
  // below, exactly as before.
  const canApplyUpdate = displayIsActive && onlineCheckSupported && displayInstalled && updateAvailable && !update?.blockedReason;
  const license = binaryInfo?.core?.license;
  const licenseIssue = browserCoreLicenseIssue(binaryInfo);
  // A key that is known to be unusable stops the official card here. An *unvalidated* key does not:
  // with the private channel running, validation is suspended, and gating on a verdict nobody asked
  // for would leave the official card unusable — which is the one state a switch has to be able to
  // leave.
  const officialLicense = binaryInfo?.core?.officialLicense;
  const licenseBlocked = official && !officialLicenseUsable({ displayIsActive, license, licenseIssue, officialLicense });
  // A key that is merely unvalidated is not a rejected one. Hiding the target-version query in that state
  // hid it for every install that had not run yet — which is precisely when the number is useful — so it
  // is gated on the key being absent or rejected instead.
  const controlsDisabled = (official && licenseBlocked) || licenseSaving || versionSaving;
  const licenseEnv = binaryInfo?.core?.env.find((item) => item.key === "CLOAKBROWSER_LICENSE_KEY" && item.enabled);
  // Imports follow the SDK cache layout, independently of the account's license plan.
  const cacheTier = binaryInfo?.core?.targetTier ?? binary.tierMode;
  const statusDetail = managedCoreDisabled
    ? t("browserCore.managedActionsDisabled")
    : displayInstalled
      ? t("browserCore.installedStatusDetail")
      : t("browserCore.missingStatusDetail");
  // The other channel on disk but not running is a state the operator has to be able to see: the
  // build is there, and the only thing missing is the switch.
  const installedNotActive = !displayIsActive && displayInstalled;
  // A free *plan* is force-served the latest build, so a pin it cannot honour is hidden rather than
  // offered. Read from the server's plan derivation, not from the tier: the tier is the cache layout
  // and a valid free-plan key produces the Pro one, so `cacheTier === "free"` no longer answers this.
  const plan = license?.plan?.trim().toLowerCase();
  const planIsFree = Boolean(binaryInfo?.core?.planIsFree || plan === "free");
  // A pin is a policy of the running official channel: the version it names is the build that launches,
  // so it cannot be edited from a card whose channel is not the one being pinned.
  const canPinVersion = official && displayIsActive && displayMode === "online" && Boolean(license?.active && license.valid === true && plan && plan !== "unknown" && !planIsFree);
  const pinned = canPinVersion && coreSourceDraft.browserVersionMode === "pinned";
  const pinIssue = pinned ? browserCorePinIssue(coreSourceDraft.pinnedBrowserVersion) : undefined;
  const pinError = pinTouched && pinIssue ? t(pinIssue === "required" ? "error.browserCorePinRequired" : pinIssue === "chromium-only" ? "error.browserCorePinRevision" : "error.browserCorePinInvalid") : undefined;

  function saveBinary(patch: Partial<BinarySettings>) {
    void saveSettings({ binary: patch }).catch((error) => toast.error((error as Error).message));
  }

  async function activateChannel(channel: BrowserCoreChannel, mode: BrowserCoreChannelMode, expectedVersion?: string) {
    if (!activateCoreChannel || actionBusy) return;
    try { await activateCoreChannel(channel, mode, expectedVersion); }
    catch (error) { toast.error((error as Error).message); }
  }

  // Every move of the card goes through here so the choice is remembered exactly once. Storage is a
  // view preference (which card to look at), never an activation: it is written for a move that only
  // changes what is on screen too.
  function showChannel(channel: BrowserCoreChannel) {
    setDisplayChannel(channel);
    storeCoreCard(channel);
  }

  // The gesture is the only switch. It is deliberately inert — no hover state, no button role, no
  // cursor change, no tooltip — because it is also the hidden trigger for the advanced channel, and a
  // control that advertises itself is not hidden.
  //
  // Every action it performs costs a full sequence of clicks, unlocking included: a single click must
  // never move the running channel, or an accidental click on a version label would replace what
  // launches. The sequence is the guard, so it is counted for every click and reset only when it fires.
  //
  // Activating a channel that is not running is always an online activation: mode belongs to the running
  // channel, so carrying the running mode across would enable the target offline — the exact state in
  // which its own repository and update checks are refused.
  async function handleWrapperGesture() {
    if (unlockSaving || actionBusy || hasActiveSessions) return;
    const gesture = countWrapperGesture(privateUnlockClicks.current);
    privateUnlockClicks.current = gesture.clicks;
    if (!gesture.fired) return;
    if (!privateUnlocked) {
      setUnlockSaving(true);
      try { await saveSettings({ binary: { privateChannelUnlocked: true } }, { throwOnError: true }); }
      catch (error) { toast.error((error as Error).message); return; }
      finally { setUnlockSaving(false); }
      showChannel("private");
      // Unlocking reveals the card; it does not switch what launches. A sequence that only meant to
      // unlock must not replace the running core, so activation is left to the next deliberate one.
      return;
    }
    if (!displayIsActive) {
      if (channelStates[display].installed) { await activateChannel(display, "online"); return; }
      // Nothing to enable yet: take the operator back to the channel that is running rather than
      // leaving them on a card whose switch cannot do anything.
      showChannel(activeChannel);
      return;
    }
    const next: BrowserCoreChannel = display === "official" ? "private" : "official";
    showChannel(next);
    if (channelStates[next].installed) await activateChannel(next, "online");
  }

  async function saveVersionSettings(patch: Pick<CoreSourceDraft, "browserVersionMode"> & Partial<Pick<CoreSourceDraft, "pinnedBrowserVersion">>) {
    setCoreSourceDraft((current) => ({ ...current, ...patch }));
    setVersionSaving(true);
    try { await saveSettings({ binary: patch }, { throwOnError: true }); }
    finally { setVersionSaving(false); }
  }

  function changeVersionMode(browserVersionMode: "latest" | "pinned") {
    setCoreSourceDraft((current) => ({ ...current, browserVersionMode }));
    setPinTouched(browserVersionMode === "pinned" && Boolean(coreSourceDraft.pinnedBrowserVersion));
    if (browserVersionMode === "latest" || !browserCorePinIssue(coreSourceDraft.pinnedBrowserVersion)) {
      void saveVersionSettings({ browserVersionMode, ...(browserVersionMode === "pinned" ? { pinnedBrowserVersion: coreSourceDraft.pinnedBrowserVersion.trim() } : {}) }).catch(() => undefined);
    }
  }

  function savePinnedVersion() {
    setPinTouched(true);
    if (versionSaving || browserCorePinIssue(coreSourceDraft.pinnedBrowserVersion)) return;
    const value = coreSourceDraft.pinnedBrowserVersion.trim();
    if (binary.browserVersionMode === "pinned" && binary.pinnedBrowserVersion === value) return;
    void saveVersionSettings({ browserVersionMode: "pinned", pinnedBrowserVersion: value }).catch(() => undefined);
  }

  async function runCoreAction(action: () => void | Promise<void>, requiresPin = false) {
    if (requiresPin && pinIssue) { setPinTouched(true); return; }
    const value = coreSourceDraft.pinnedBrowserVersion.trim();
    if (pinned && !pinIssue && (binary.browserVersionMode !== "pinned" || binary.pinnedBrowserVersion !== value)) {
      await saveVersionSettings({ browserVersionMode: "pinned", pinnedBrowserVersion: value });
    }
    await action();
  }

  async function pickCacheDirectory() {
    setDirectoryPicking(true);
    setDirectoryError(undefined);
    try {
      const selected = await openDialog({ directory: true, multiple: false, defaultPath: binary.customCacheDir || undefined, title: t("browserCore.chooseCacheDirectory") });
      if (typeof selected === "string") await saveSettings({ binary: { customCacheDir: selected } });
    } catch (error) {
      setDirectoryError(t("browserCore.directoryPickerFailed"));
      console.warn(t("browserCore.directoryPickerFailed"), error);
    } finally { setDirectoryPicking(false); }
  }

  async function pickCustomBinary() {
    setDirectoryPicking(true);
    setDirectoryError(undefined);
    try {
      const selected = await openDialog({ directory: false, multiple: false, defaultPath: binary.customBinaryPath || undefined, title: t("browserCore.chooseCustomBinary") });
      if (typeof selected === "string") await saveSettings({ binary: { customBinaryPath: selected } });
    } catch (error) {
      setDirectoryError(t("browserCore.directoryPickerFailed"));
      console.warn(t("browserCore.directoryPickerFailed"), error);
    } finally { setDirectoryPicking(false); }
  }

  // Debounce external validation, and keep core actions disabled until the latest edit is saved.
  function saveLicenseKeyDraft(licenseKey: string) {
    setCoreSourceDraft((current) => ({ ...current, licenseKey }));
    setLicenseSaving(true);
    const sequence = ++licenseSaveSequence.current;
    if (licenseKeySaveRef.current) window.clearTimeout(licenseKeySaveRef.current);
    pendingLicenseSave.current = () => {
      pendingLicenseSave.current = undefined;
      licenseKeySaveRef.current = undefined;
      void saveSettings({ binary: { licenseKey } }).finally(() => {
        if (sequence === licenseSaveSequence.current) setLicenseSaving(false);
      }).catch(() => undefined);
    };
    licenseKeySaveRef.current = window.setTimeout(() => pendingLicenseSave.current?.(), 700);
  }

  function flushLicenseKey() {
    if (licenseKeySaveRef.current) window.clearTimeout(licenseKeySaveRef.current);
    pendingLicenseSave.current?.();
  }

  function beginImport() {
    if (importPicking || actionBusy || importBusy) return;
    if (!isTauri()) { setImportOpen(true); return; }
    void pickAndImport();
  }

  async function pickAndImport() {
    setImportPicking(true);
    setImportError(undefined);
    try {
      const selected = await openDialog({
        multiple: false,
        directory: false,
        filters: [{ name: "CloakBrowser Archive", extensions: ["zip", "tar.gz", "tgz"] }],
      });
      if (typeof selected === "string" && selected.trim()) {
        setImportPath(selected);
        importBrowserCoreZip(selected, { targetTier: cacheTier, targetChannel: display });
      }
    } catch (error) {
      setImportError(t("browserCore.filePickerFailed"));
      console.warn(t("browserCore.filePickerFailed"), error);
    } finally {
      setImportPicking(false);
    }
  }

  function importFromPath() {
    if (!importPath.trim() || actionBusy || importBusy) return;
    importBrowserCoreZip(importPath.trim(), { targetTier: cacheTier, targetChannel: display });
  }

  const channelLabel = t(display === "private" ? "browserCore.channelPrivate" : "browserCore.channelOfficial");

  return (
    <div className="settings-stack no-padding browser-core-settings">
      <section className="settings-section">
        <div className="settings-section-head browser-core-download-head">
          <div className="settings-section-title-with-tip">
            <h2>{t("browserCore.downloadInstall")}</h2>
            <InfoTip text={statusDetail} />
          </div>
          <div className="browser-core-channel-head">
            {/* The mode is the running channel's own. It is a state readout, not a third way to import:
                offline means this channel makes no network request, and the import action is the only
                path that changes the build while it is in that state.
                It is a control only while this card is the running channel *and* the switch can act;
                every other case is the same inert readout as the other card, so hovering the icon never
                means "disabled control" on one card and "plain text" on the other. The readout carries
                its meaning in text and shows the mode the card is configured in. */}
            {modeSwitchable ? (
              <button
                className="icon-button compact borderless browser-core-mode-toggle"
                aria-label={t(displayMode === "online" ? "browserCore.switchOffline" : "browserCore.switchOnline")}
                title={t(displayMode === "online" ? "browserCore.switchOffline" : "browserCore.switchOnline")}
                aria-pressed={displayMode === "offline"}
                onClick={() => void activateChannel(display, displayMode === "online" ? "offline" : "online")}
                type="button"
              >
                {displayMode === "online"
                  ? <Cloud size={15} aria-hidden="true" />
                  : <CloudOff size={15} aria-hidden="true" />}
              </button>
            ) : (
              <span className="icon-button compact borderless browser-core-mode-static" title={t(displayMode === "online" ? "browserCore.modeOnline" : "browserCore.modeOffline")}>
                {displayMode === "online"
                  ? <Cloud size={15} aria-hidden="true" />
                  : <CloudOff size={15} aria-hidden="true" />}
              </span>
            )}
            {/* The gesture trigger. Only the number is shown: the label named the wrapper, and the
                version itself is the fact anyone reading this row wants. No tooltip, hover state or
                button role, for the same reason the trigger is hidden at all — a control that
                advertises itself is not hidden. */}
            <span className="browser-core-wrapper-version" onClick={handleWrapperGesture}>
              {binaryInfo?.core?.versions.wrapperVersion ?? "-"}
            </span>
          </div>
        </div>
        <div className="row-actions" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget) && pinned) savePinnedVersion(); }}>
          {canApplyUpdate && (
            <button
              className="command primary"
              data-core-action="true"
              disabled={managedCoreDisabled || downloadActionBusy || licenseBlocked || Boolean(pinIssue)}
              onClick={() => void runCoreAction(() => updateBinary(display), true).catch(() => undefined)}
              title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
              type="button"
            >
              <RefreshCw size={16} aria-hidden="true" />
              {t("actions.update")}
            </button>
          )}
          {!displayInstalled && onlineCheckSupported && <button
            className="command success"
            data-core-action="true"
            disabled={managedCoreDisabled || downloadActionBusy || licenseBlocked || Boolean(pinIssue) || (display === "private" && (!binaryInfo?.core?.privateTokenConfigured || !binary.privateRepositoryUrl.trim()))}
            onClick={() => void runCoreAction(() => installBinary(display), true).catch(() => undefined)}
            title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
            type="button"
          >
            <Download size={16} aria-hidden="true" />
            {t("actions.install")}
          </button>}
          {onlineCheckSupported && <button className="command" data-core-action="true" disabled={downloadActionBusy || licenseBlocked || (display === "private" && (!binaryInfo?.core?.privateTokenConfigured || !binary.privateRepositoryUrl.trim()))} onClick={() => void runCoreAction(() => checkBrowserCoreUpdate({ targetChannel: display })).catch(() => undefined)} type="button">
            <Activity size={16} aria-hidden="true" />
            {t("actions.checkUpdate")}
          </button>}
          <button
            className="command"
            data-core-action="true"
            // Local: the archive is on disk and the target is this channel's cache.
            disabled={actionBusy || importBusy || managedCoreDisabled}
            onClick={beginImport}
            title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
            type="button"
          >
            <Upload size={16} aria-hidden="true" />
            {t("browserCore.offlineImport")}
          </button>
          <button
            className="command danger subtle"
            data-core-action="true"
            // Local and independent of the credential: it removes superseded builds from this channel's
            // own cache and never reaches the network.
            disabled={managedCoreDisabled || actionBusy}
            onClick={() => void runCoreAction(() => clearBinaryCache(display)).catch(() => undefined)}
            title={managedCoreDisabled ? t("browserCore.managedActionsDisabled") : undefined}
            type="button"
          >
            <Trash2 size={16} aria-hidden="true" />
            {t("actions.clearCache")}
          </button>
          <button className="command subtle" data-core-action="true" disabled={actionBusy} onClick={() => void runCoreAction(openRuntimeCheck).catch(() => undefined)} type="button">
            <ListChecks size={16} aria-hidden="true" />
            {t("browserCore.runtimeCheckTitle")}
          </button>
          {official && <BrowserCoreExternalLink link="free-key" t={t} />}
        </div>
        {/* Cache location sits immediately under the actions that consume it — clear, import and launch
            all resolve through it — and above the credential fields, which are policy rather than
            storage. */}
        {/* The installed build, then where builds live. Both are read-backs of this channel's cache, so
            they sit together and before the credential fields. */}
        <KeyValueList className="browser-core-download-details" items={[
          ...(displayInstalled || (displayIsActive && binaryPathOverride) ? [{
            label: displayIsActive && binaryPathOverride ? t("browserCore.customVersion") : t("browserCore.installedVersion"),
            value: <VersionValue
              importedBuild={displayIsActive ? binaryInfo?.core?.importedBuild : undefined}
              t={t}
              update={!displayIsActive || binaryPathOverride || (licenseBlocked && update?.error) ? undefined : update}
              value={displayVersion} />,
          }] : []),
        ]} />
        <div className="browser-core-cache-settings">
          <Field label={t("browserCore.cacheDirMode")} help={t("browserCore.cacheDirectoryHelp")}>
            <Segmented
              value={binary.cacheDirMode}
              options={[
                { value: "auto", label: t("browserCore.cacheAuto") },
                { value: "custom", label: t("browserCore.cacheCustom") },
              ]}
              onChange={(cacheDirMode) => saveBinary({ cacheDirMode })}
            />
          </Field>
          {binary.cacheDirMode === "custom" && <>
            <div className={`inline-file-row browser-core-cache-picker${isTauri() ? "" : " no-picker"}`}>
              <input aria-label={t("browserCore.customCacheDir")} readOnly={isTauri()} disabled={operationBusy || directoryPicking}
                value={binary.customCacheDir}
                onChange={(event) => saveBinary({ customCacheDir: event.target.value })}
                placeholder={t(isTauri() ? "browserCore.cacheDirectoryEmpty" : "browserCore.customCacheDirPlaceholder")}
              />
              {isTauri() && <button className="command subtle" disabled={operationBusy || directoryPicking} onClick={() => void pickCacheDirectory()} type="button">{t("browserCore.chooseCacheDirectory")}</button>}
            </div>
            {!isTauri() && <span className="input-hint">{t("browserCore.webManualDirectoryOnly")}</span>}
            {directoryError && <span className="field-error" role="alert">{directoryError}</span>}
          </>}
        </div>
        {(!isTauri() && importOpen) && <>
          <div className="inline-file-row no-picker browser-core-import-row">
            <input aria-label={t("browserCore.importZipPath")} disabled={actionBusy || importBusy}
              value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder={t("browserCore.importZipPlaceholder")} />
            <button className="command" disabled={!importPath.trim() || actionBusy || importBusy} onClick={importFromPath} type="button">{t("browserCore.confirmImport")}</button>
          </div>
          <span className="input-hint">{t("browserCore.webManualPathOnly")}</span>
        </>}
        {importError && <span className="field-error" role="alert">{importError}</span>}
        {/* The two cards have the same shape. Each leads with the credential that gates its own remote
            operations — a license key for the official channel, a repository and token for the private
            one — because that is the only thing either of them depends on. Everything after it
            (installed version, cache directory, import, clear, runtime check) is local and stays
            available while the credential is missing. */}
        {official ? <Field label={t("browserCore.licenseKey")} wide>
          <div className="browser-core-license-input">
            <input aria-label={t("browserCore.licenseKey")} autoComplete="off" type="password" value={coreSourceDraft.licenseKey}
              onChange={(event) => saveLicenseKeyDraft(event.target.value)} onBlur={flushLicenseKey} placeholder="cb_xxxxxxxx" />
            {displayIsActive && displayMode === "offline" && license?.active && license.valid === undefined
              ? <span className="input-hint">{t("browserCore.offlineLicenseCheck")}</span>
              // The indicator describes the card it sits on: on the running card that is `core.license`,
              // on the other one the official channel's own key state, which is not suspended by a
              // private activation. `installed` follows the same rule — the running channel's build is
              // not the one this card installs into.
              : <BrowserCoreLicenseIndicator
                license={displayIsActive ? license : { configured: Boolean(officialLicense?.configured), active: Boolean(officialLicense?.configured), valid: officialLicense?.valid, plan: officialLicense?.plan }}
                saving={licenseSaving}
                installed={displayInstalled}
                source={licenseEnv ? envSourceText(licenseEnv.source, t) : undefined}
                t={t} />}
          </div>
        </Field> : <PrivateChannelFields
          binary={binary}
          busy={actionBusy}
          catalog={privateCatalog}
          platform={binaryInfo?.platform}
          privateReleasesBusy={privateReleasesBusy}
          privateRepositoryBusy={privateRepositoryBusy}
          privateRepositoryUrl={privateRepositoryUrl}
          privateToken={privateToken}
          tokenConfigured={Boolean(binaryInfo?.core?.privateTokenConfigured)}
          setPrivateRepositoryUrl={(value) => { setPrivateRepositoryUrl(value); setPrivateCatalog(emptyPrivateCoreCatalog()); }}
          setPrivateToken={(value) => { setPrivateToken(value); setPrivateCatalog(emptyPrivateCoreCatalog()); }}
          setCatalog={setPrivateCatalog}
          setPrivateReleasesBusy={setPrivateReleasesBusy}
          setPrivateRepositoryBusy={setPrivateRepositoryBusy}
          loadPrivateReleases={loadPrivateReleases}
          testPrivateRepository={testPrivateRepository}
          installPrivateVersion={installPrivateVersion}
          clearPrivateToken={clearPrivateToken}
          t={t}
        />}
        {/* Remote policy belongs to the official channel while it is online: the private channel's
            releases are its policy, so that row is absent there. Both cards keep the fields below it. */}
        {official && displayMode === "online" && <fieldset className="disabled-fieldset in-place" disabled={controlsDisabled}>
          <div className="browser-core-release-row">
            <Field label={t("browserCore.releaseChannel")} help={t("browserCore.releaseChannelHelp")}>
              <Segmented value={binary.releaseChannel} options={[
                { value: "stable", label: t("browserCore.releaseChannelStable") },
                { value: "preview", label: t("browserCore.releaseChannelPreview") },
              ]} onChange={(releaseChannel) => saveBinary({ releaseChannel })} />
            </Field>
            {displayIsActive && !binaryPathOverride && <div className="browser-core-target-version-field">
              <TargetVersionValue configuration={JSON.stringify([binary.browserVersionMode, binary.pinnedBrowserVersion, binary.releaseChannel, binary.licenseKey, binary.customEnvVars, binaryInfo?.platform, planIsFree])} t={t} />
            </div>}
          </div>
        </fieldset>}
        {official && displayMode === "online" && canPinVersion && <Field label={t("browserCore.versionMode")}>
          <Segmented value={coreSourceDraft.browserVersionMode} options={[
            { value: "latest", label: t("browserCore.versionLatest") },
            { value: "pinned", label: t("browserCore.versionPinned") },
          ]} onChange={changeVersionMode} />
        </Field>}
        {official && displayMode === "online" && pinned && (
          <Field label={t("browserCore.pinnedVersion")} help={t("browserCore.pinnedVersionHelp")} error={pinError} wide>
            <input value={coreSourceDraft.pinnedBrowserVersion} onChange={(event) => setCoreSourceDraft((current) => ({ ...current, pinnedBrowserVersion: event.target.value }))}
              onBlur={(event) => { if (!(event.relatedTarget instanceof HTMLElement && event.relatedTarget.dataset.coreAction)) savePinnedVersion(); }}
              aria-invalid={Boolean(pinError) || undefined} required placeholder="156.0.8078.47.1" />
          </Field>
        )}
        {displayMode === "offline" && <div className="result-line">{t("browserCore.offlineModeHint")}</div>}
        {installedNotActive && <div className="settings-action-row">
          <span className="input-hint" role="status">{t("browserCore.installedNotActive", { channel: channelLabel, version: displayVersion ?? "-" })}</span>
        </div>}
        {binaryPathOverride && (
          <div className="result-line">{t("browserCore.overrideTakesOver", { path: binaryPathOverride })}</div>
        )}
        {/* The one documented configuration item with no dedicated control used to be reachable only
            through an environment row. It sits here, under the managed install/update actions it takes
            over, because that is the consequence an operator needs in view when enabling it. */}
        <div className="browser-core-custom-binary">
          <ToggleField
            label={t("browserCore.customBinaryEnabled")}
            help={t("browserCore.customBinaryHelp")}
            checked={binary.customBinaryPathEnabled}
            disabled={actionBusy}
            onChange={(customBinaryPathEnabled) => saveBinary({ customBinaryPathEnabled })}
          />
          {binary.customBinaryPathEnabled && (
            <div className={`inline-file-row browser-core-cache-picker${isTauri() ? "" : " no-picker"}`}>
              <input
                aria-label={t("browserCore.customBinaryPath")}
                disabled={actionBusy}
                readOnly={isTauri()}
                placeholder={t(isTauri() ? "browserCore.customBinaryPlaceholder" : "browserCore.customBinaryPlaceholderWeb")}
                value={binary.customBinaryPath}
                onChange={(event) => saveBinary({ customBinaryPath: event.target.value })}
              />
              {isTauri() && (
                <button className="command subtle" disabled={actionBusy || directoryPicking} onClick={() => void pickCustomBinary()} type="button">
                  {t("browserCore.chooseCustomBinary")}
                </button>
              )}
            </div>
          )}
          {binary.customBinaryPathEnabled && !isTauri() && (
            <span className="input-hint">{t("browserCore.webManualDirectoryOnly")}</span>
          )}
        </div>
        {update?.error && displayIsActive && !licenseBlocked && <div className="inline-error">{browserCoreUpdateErrorMessage(update, t)}</div>}
        {update?.blockedReason && displayIsActive && <div className="result-line">{update.blockedReason}</div>}
        {/* The verdict above came out of a real comparison, but not out of a sound one: the imported
            build and the download source report versions in different shapes, so the answer cannot
            change. Gated on checkedThisBuild for the same reason the up-to-date badge is — the caveat
            describes the build the stored check compared, and once the cache holds a different one it is
            talking about something that is no longer installed. Dropped under an override for the same
            reason the badge is — it is about a build the override prevents from launching. */}
        {update?.baselineCaveat && checkedThisBuild && displayIsActive && !binaryPathOverride && (
          <div className="result-line">{t("browserCore.updateBaselineImportedTier")}</div>
        )}
        {operationBusy && (
          <BrowserCoreOperationPanel
            busy={busy}
            cancelOperation={cancelBrowserCoreOperation ? () => void cancelBrowserCoreOperation() : undefined}
            operation={binaryInfo?.core?.operation}
            t={t}
          />
        )}
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div className="settings-section-title-with-tip">
            <h2>{t("browserCore.customEnv")}</h2>
            <InfoTip text={t("browserCore.envEditorHelp")} />
          </div>
          <BrowserCoreExternalLink link="configuration" t={t} />
        </div>
        <BrowserCoreEnvironmentEditor binary={binary} saveBinary={saveBinary} t={t} />
        {binaryInfo?.core?.env.some((item) => item.requiresRuntimeRestart) && (
          <div className="result-line">{t("browserCore.envChangesRestartShort")}</div>
        )}
      </section>
    </div>
  );
}

/**
 * The private channel's own configuration — repository, token and releases. Only rendered on the
 * private card, so the official card never exposes a setting that belongs to another channel.
 */
function PrivateChannelFields({
  binary,
  busy,
  catalog,
  platform,
  privateReleasesBusy,
  privateRepositoryBusy,
  privateRepositoryUrl,
  privateToken,
  tokenConfigured,
  setPrivateRepositoryUrl,
  setPrivateToken,
  setCatalog,
  setPrivateReleasesBusy,
  setPrivateRepositoryBusy,
  loadPrivateReleases,
  testPrivateRepository,
  installPrivateVersion,
  clearPrivateToken,
  t,
}: {
  binary: BinarySettings;
  busy: boolean;
  catalog: PrivateCoreCatalog;
  platform?: string;
  privateReleasesBusy: boolean;
  privateRepositoryBusy: boolean;
  privateRepositoryUrl: string;
  privateToken: string;
  tokenConfigured: boolean;
  setPrivateRepositoryUrl: (value: string) => void;
  setPrivateToken: (value: string) => void;
  setCatalog: React.Dispatch<React.SetStateAction<PrivateCoreCatalog>>;
  setPrivateReleasesBusy: (value: boolean) => void;
  setPrivateRepositoryBusy: (value: boolean) => void;
  loadPrivateReleases?: (repositoryUrl?: string) => Promise<BrowserCorePrivateRelease[]>;
  testPrivateRepository?: (repositoryUrl: string, token?: string) => Promise<{ configured?: boolean; repositoryUrl?: string }>;
  installPrivateVersion?: (version?: string, source?: { repositoryUrl?: string; releaseId?: number }) => Promise<void>;
  clearPrivateToken?: () => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [error, setError] = useState("");
  const [installing, setInstalling] = useState(false);
  const [tokenSaved, setTokenSaved] = useState(tokenConfigured);
  const [repositoryTouched, setRepositoryTouched] = useState(false);
  const [tokenTouched, setTokenTouched] = useState(false);
  const [tokenVisible, setTokenVisible] = useState(false);
  const controlsBusy = busy || privateRepositoryBusy || privateReleasesBusy || installing;
  const configurationDirty = privateCoreConfigurationDirty(binary.privateRepositoryUrl, privateRepositoryUrl, privateToken);
  useEffect(() => setTokenSaved(tokenConfigured), [tokenConfigured]);

  // The canonical URL this draft resolves to. Whatever page the operator copied from, the path after
  // `owner/repository` and any query or fragment are not part of the repository's identity, so the
  // value that is validated, tested and persisted is always the canonical one.
  const normalizedRepository = normalizeGithubRepositoryUrl(privateRepositoryUrl);
  const tokenKind = githubTokenKind(privateToken);
  const repositoryError = repositoryTouched && privateRepositoryUrl.trim() && !normalizedRepository
    ? t("error.privateRepositoryInvalid")
    : undefined;
  const tokenError = tokenTouched && privateToken.trim() && !tokenKind
    ? t("error.privateTokenInvalid")
    : undefined;
  // Testing is what saves the credential, so it needs a repository to test against and a key to test.
  // An empty key field is not "use the saved one" for this control: the saved key is already proven,
  // and re-proving it without typing anything is not what this button is for.
  const canTest = Boolean(normalizedRepository) && Boolean(tokenKind);
  // Both halves of the credential must exist on the server before the release row can do anything:
  // the list it refreshes is fetched with the stored key against the stored repository. A catalog that
  // was just fetched proves the second half even while the refreshed settings that carry the saved
  // repository are still in flight, which is the gap a successful test would otherwise fall into.
  const connected = tokenSaved && (Boolean(binary.privateRepositoryUrl.trim()) || catalog.loaded);

  function normalizeRepositoryDraft() {
    setRepositoryTouched(true);
    if (normalizedRepository && normalizedRepository !== privateRepositoryUrl.trim()) {
      setPrivateRepositoryUrl(normalizedRepository);
    }
  }

  async function testRepository() {
    if (!testPrivateRepository || !canTest || controlsBusy) return;
    const repositoryUrl = normalizedRepository;
    if (!repositoryUrl) return;
    setPrivateRepositoryUrl(repositoryUrl);
    setError("");
    setPrivateRepositoryBusy(true);
    try {
      // The key is sent exactly as typed. The server trims it; validating a trimmed copy here would
      // let a value the server refuses pass this gate.
      const result = await testPrivateRepository(repositoryUrl, privateToken);
      setPrivateRepositoryUrl(result.repositoryUrl?.trim() || repositoryUrl);
      setTokenSaved(Boolean(result.configured));
      setPrivateToken("");
      setTokenTouched(false);
      setTokenVisible(false);
      if (loadPrivateReleases) {
        try {
          const releases = await loadPrivateReleases(result.repositoryUrl?.trim() || repositoryUrl);
          setCatalog(receivePrivateCoreCatalog(result.repositoryUrl?.trim() || repositoryUrl, releases));
        } catch {
          setCatalog(emptyPrivateCoreCatalog());
        }
      } else {
        setCatalog(emptyPrivateCoreCatalog());
      }
      toast.success(t("browserCore.privateConnected"));
    } catch (error) {
      setError(browserCoreErrorMessage(error, t));
    } finally {
      setPrivateRepositoryBusy(false);
    }
  }

  async function refreshReleases() {
    if (!loadPrivateReleases || !binary.privateRepositoryUrl.trim() || controlsBusy || configurationDirty) return;
    setError("");
    setPrivateReleasesBusy(true);
    try {
      const repositoryUrl = binary.privateRepositoryUrl;
      const releases = await loadPrivateReleases(repositoryUrl);
      setCatalog(receivePrivateCoreCatalog(repositoryUrl, releases));
    } catch (error) {
      setError(browserCoreErrorMessage(error, t));
    } finally {
      setPrivateReleasesBusy(false);
    }
  }

  async function installRelease(release: BrowserCorePrivateRelease) {
    if (!installPrivateVersion || controlsBusy || configurationDirty) return;
    setError("");
    setInstalling(true);
    // The row's own identity travels with the request: the catalog it came from is the catalog its
    // assets were listed under, and the server refuses a mismatch rather than downloading another
    // repository's build under this version number.
    try { await installPrivateVersion(release.version, { repositoryUrl: catalog.repositoryUrl, releaseId: release.id }); }
    catch (error) { setError(browserCoreErrorMessage(error, t)); }
    finally { setInstalling(false); }
  }

  async function clearToken() {
    if (!clearPrivateToken || controlsBusy) return;
    setError("");
    setPrivateRepositoryBusy(true);
    try { await clearPrivateToken(); setTokenSaved(false); setPrivateToken(""); setCatalog(emptyPrivateCoreCatalog()); }
    catch (error) { setError(browserCoreErrorMessage(error, t)); }
    finally { setPrivateRepositoryBusy(false); }
  }

  // The list belongs to the saved repository. An unsaved edit makes it stale rather than usable, so the
  // refresh waits for the connection test that would persist it — no other state gates it. With no
  // credential on file there is nothing to list and no key to list it with.
  const releasesStale = !connected || configurationDirty;
  return (
    <>
      <Field label={t("browserCore.privateRepository")} help={t("browserCore.privateRepositoryHelp")} error={repositoryError} wide>
        <input
          value={privateRepositoryUrl}
          onChange={(event) => setPrivateRepositoryUrl(event.target.value)}
          onBlur={normalizeRepositoryDraft}
          placeholder="https://github.com/owner/repository"
          inputMode="url"
          autoComplete="url"
          aria-invalid={Boolean(repositoryError) || undefined}
        />
      </Field>
      <Field label={t("browserCore.privateToken")} help={t("browserCore.privateTokenHelp")} error={tokenError} wide>
        <div className="browser-core-license-input">
          <input
            aria-label={t("browserCore.privateToken")}
            type={tokenVisible ? "text" : "password"}
            value={privateToken}
            onChange={(event) => setPrivateToken(event.target.value)}
            onBlur={() => setTokenTouched(true)}
            placeholder={tokenSaved ? t("browserCore.privateTokenPlaceholder") : t("browserCore.privateToken")}
            autoComplete="new-password"
            aria-invalid={Boolean(tokenError) || undefined}
          />
          {/* Three controls can share this field, and their order is the order they are used in: reveal
              while typing, clear the stored key, then test. The reveal control only exists while there
              is something typed to reveal — a saved key never comes back in plaintext, so offering the
              eye on an empty field would promise something it cannot show. The clear control only
              exists while a key is stored. The test control is always the last one, so its position
              never moves when the other two appear or disappear. */}
          {privateToken.trim() && (
            <button
              className="icon-button compact browser-core-license-reveal"
              aria-label={t(tokenVisible ? "actions.hidePassword" : "actions.showPassword")}
              title={t(tokenVisible ? "actions.hidePassword" : "actions.showPassword")}
              aria-pressed={tokenVisible}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => setTokenVisible((visible) => !visible)}
              type="button"
            >
              {tokenVisible ? <EyeOff size={15} aria-hidden="true" /> : <Eye size={15} aria-hidden="true" />}
            </button>
          )}
          {clearPrivateToken && tokenSaved && (
            <button
              className="icon-button compact browser-core-license-clear"
              aria-label={t("browserCore.privateClearToken")}
              title={t("browserCore.privateClearToken")}
              disabled={controlsBusy}
              onClick={() => void clearToken()}
              type="button"
            >
              <Trash2 size={15} aria-hidden="true" />
            </button>
          )}
          {/* The connection test belongs to the credential it tests, so it lives inside that field
              rather than beside the repository: testing is what saves the key, and nothing else does.
              It is the anchor: always at the end of the field, disabled until both halves of the
              credential are present, so the row has no layout shift as the other controls come and go. */}
          <button
            className="icon-button compact browser-core-license-test"
            aria-label={privateRepositoryBusy ? t("browserCore.privateTesting") : t("browserCore.privateTest")}
            title={privateRepositoryBusy ? t("browserCore.privateTesting") : t("browserCore.privateTest")}
            disabled={controlsBusy || !canTest}
            onClick={() => void testRepository()}
            type="button"
          >
            <Activity size={16} aria-hidden="true" />
          </button>
        </div>
        {configurationDirty && <span className="input-hint" role="status">{t("browserCore.privateConfigurationUnsaved")}</span>}
      </Field>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {/* The refresh control and the empty state are one row: a release list with nothing to show needs
          the one action that can change that, and a button on a line of its own reads as a section
          heading for content that is not there. The row is inert until a repository and a key are both
          on file: before that there is nothing to refresh it with. */}
      {!connected ? (
        <div className="browser-core-private-empty">
          <span className="input-hint">{t("browserCore.privateReleasesLocked")}</span>
        </div>
      ) : catalog.releases.length > 0 ? (
        <div className="browser-core-private-releases" role="group" aria-label={t("browserCore.privateReleaseList")}>
          <div className="browser-core-private-releases-head">
            <span className="input-hint">{t("browserCore.privateReleaseList")}</span>
            <button
              className="icon-button compact"
              aria-label={t("browserCore.privateRefresh")}
              title={t("browserCore.privateRefresh")}
              disabled={controlsBusy || releasesStale}
              onClick={() => void refreshReleases()}
              type="button"
            >
              <RefreshCw size={15} aria-hidden="true" />
            </button>
          </div>
          {/* One row per release, each with its own install control: the list is a set of independent
              builds, the same shape a GitHub release list has, not a choice of one. */}
          {catalog.releases.map((release) => (
            <div className="browser-core-private-release" key={release.id} title={release.title}>
              <span className="browser-core-private-release-main">
                <strong>{release.version}</strong>
                <small title={release.title}>{release.title}</small>
              </span>
              <span className="browser-core-private-release-meta">
                {release.assets.filter((asset) => asset.name !== "SHA256SUMS" && (!platform || asset.platform === platform)).map((asset) => <small key={asset.name}>{asset.name}{asset.checksum ? ` · ${asset.checksum.slice(0, 12)}` : ""}</small>)}
              </span>
              {installPrivateVersion && (
                <button
                  className="icon-button compact browser-core-private-release-install"
                  aria-label={t("browserCore.privateInstallVersion", { version: release.version })}
                  title={t("browserCore.privateInstallVersion", { version: release.version })}
                  disabled={controlsBusy || configurationDirty}
                  onClick={() => void installRelease(release)}
                  type="button"
                >
                  <Download size={15} aria-hidden="true" />
                </button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <div className="browser-core-private-empty">
          <span className="input-hint">{t(catalog.loaded && catalog.repositoryUrl === binary.privateRepositoryUrl ? "browserCore.privateNoPlatformReleases" : "browserCore.privateNoReleases")}</span>
          <button
            className="icon-button compact"
            aria-label={t("browserCore.privateRefresh")}
            title={t("browserCore.privateRefresh")}
            disabled={controlsBusy || releasesStale}
            onClick={() => void refreshReleases()}
            type="button"
          >
            <RefreshCw size={15} aria-hidden="true" />
          </button>
        </div>
      )}
    </>
  );
}

/**
 * What each channel has on disk. The server reports both; this only fills in before the first poll,
 * where the running channel's own state is the only fact available.
 */
function coreChannelStates(
  info: BinaryInfo | null,
  activeChannel: BrowserCoreChannel,
): Record<BrowserCoreChannel, { installed: boolean; version?: string }> {
  if (info?.core?.channels) return info.core.channels;
  return {
    official: activeChannel === "official"
      ? { installed: Boolean(info?.installed), version: info?.version }
      : { installed: false },
    private: activeChannel === "private"
      ? { installed: Boolean(info?.installed), version: info?.version }
      : { installed: false },
  };
}

/**
 * Whether the official card may reach the network for its key. A key the server rejected blocks; a key
 * that was merely never validated does not, and neither does a key that is only absent from the *running*
 * channel's state while the private channel is the one running: `core.license` is the private placeholder
 * there, and the official channel's own configuration is `core.officialLicense`.
 *
 * Exported for tests: the other-channel card can only be reached through the gesture, which a static
 * render cannot perform, so the derivation is asserted where it lives.
 */
export function officialLicenseUsable(input: {
  displayIsActive: boolean;
  license?: BrowserCoreLicenseState;
  licenseIssue: ReturnType<typeof browserCoreLicenseIssue>;
  officialLicense?: BrowserCoreOfficialLicenseState;
}): boolean {
  if (input.displayIsActive) {
    return Boolean(input.license?.active) && input.license?.valid !== false && !input.licenseIssue;
  }
  const official = input.officialLicense;
  if (!official?.configured) return false;
  return official.valid !== false;
}

function coreSourceDraftFromBinary(binary: BinarySettings): CoreSourceDraft {
  return {
    licenseKey: binary.licenseKey,
    browserVersionMode: binary.browserVersionMode,
    pinnedBrowserVersion: binary.pinnedBrowserVersion,
  };
}

/** Managed channel binaries use the wrapper override internally. Only user overrides disable management. */
export function externalCoreOverride(info: BinaryInfo | null): string | undefined {
  const env = info?.core?.env ?? [];
  const row = env.find((item) => item.key === "CLOAKBROWSER_BINARY_PATH");
  if (row?.source === "cbpanel-default") return undefined;
  return binaryPathOverrideFrom(env);
}

function BrowserCoreExternalLink({ link, t }: { link: BrowserCoreLink; t: (key: TranslationKey) => string }) {
  return (
    <a className="command subtle" href={BROWSER_CORE_LINKS[link]} rel="noopener noreferrer" target="_blank"
      onClick={(event) => {
        event.preventDefault();
        void openBrowserCoreLink(link).catch(() => toast.error(t("browserCore.openLinkFailed")));
      }}>
      <ExternalLink size={16} aria-hidden="true" />
      {t(link === "free-key" ? "browserCore.getFreeKey" : "browserCore.envDocs")}
    </a>
  );
}

function TargetVersionValue({ configuration, t }: { configuration: string; t: (key: TranslationKey) => string }) {
  const [result, setResult] = useState<{ configuration: string; version?: string; failed?: boolean }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setResult(undefined);
    void api<BrowserCoreTargetVersion>("/api/browser-core/target-version", { signal: controller.signal }).then(
      ({ version }) => { if (!controller.signal.aborted) setResult({ configuration, version }); },
      () => { if (!controller.signal.aborted) setResult({ configuration, failed: true }); },
    );
    return () => controller.abort();
  }, [configuration, retry]);
  const current = result?.configuration === configuration ? result : undefined;
  return current?.version
    ? <CopyableValueRow className="browser-core-target-version-value" value={current.version} t={t} />
    : <span className="browser-core-target-status" role="status">
        {t(current?.failed ? "browserCore.targetVersionFailed" : "browserCore.targetVersionLoading")}
        {current?.failed && <button aria-label={t("browserCore.retryTargetVersion")} title={t("browserCore.retryTargetVersion")} className="icon-button compact" onClick={() => setRetry((value) => value + 1)} type="button">
          <RefreshCw size={14} aria-hidden="true" />
        </button>}
      </span>;
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
        <StatusPill tone="error" title={browserCoreUpdateErrorMessage(update, t)}>
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

function envSourceText(
  source: BrowserCoreEnvRuntimeValue["source"],
  t: (key: TranslationKey) => string,
): string {
  if (source === "settings") return t("browserCore.envSource.settings");
  if (source === "custom") return t("browserCore.envSource.custom");
  if (source === "external") return t("browserCore.envSource.external");
  if (source === "cbpanel-default") return t("browserCore.envSource.cbpanel");
  if (source === "cloakbrowser-default") return t("browserCore.envSource.cloakbrowser");
  return "";
}
