import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { BrowserCoreImportDialogState } from "../components/browser-core/BrowserCoreImportDialog";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, browserCoreErrorMessage, browserCoreUpdateErrorMessage } from "../lib/apiClient";
import {
  binaryPathOverrideFrom,
  type BrowserCoreImportAnalysis,
  type BrowserCoreUpdateCheck,
  type BinaryInfo,
  type BrowserCorePrivateRelease,
} from "../shared/browserCore";
import type { BrowserCoreChannel, BrowserCoreChannelMode } from "../shared/settings";
import type { GithubMirrorProbeResponse } from "../shared/githubMirror";
import type { BrowserProfile, ProfilePreflightReport } from "../shared/profile";

/** The channel each mutation is aimed at: what the panel is showing, not necessarily what is active. */
function targetChannelBody(targetChannel?: BrowserCoreChannel): string {
  return JSON.stringify(targetChannel ? { targetChannel } : {});
}

/** The channel an operation was aimed at, as the server reports it back. */
type BrowserCoreTargetResult = { channel: BrowserCoreChannel; version?: string };

/**
 * A mutation that lands a build somewhere other than the running channel still answers with the running
 * channel's `info` — that is what launches, and it is what every other endpoint describes — so the
 * version to name in the message comes from `target`, never from `info`.
 */
function installedNotActiveMessage(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  targetChannel: BrowserCoreChannel | undefined,
  target: BrowserCoreTargetResult | undefined,
  fallbackVersion: string | undefined,
): string {
  const channel = target?.channel ?? targetChannel ?? "official";
  return t("browserCore.installedNotActive", {
    channel: t(channel === "private" ? "browserCore.channelPrivate" : "browserCore.channelOfficial"),
    version: target?.version ?? fallbackVersion ?? "-",
  });
}

export function useBrowserCoreActions({
  binaryInfo,
  checkPreflight,
  draft,
  preflight,
  setBinaryInfo,
  setBrowserCoreImport,
  setBusy,
  setConfirmDialog,
  t,
  toast,
  onCoreChanged,
  onPrivateConfigurationChanged,
}: {
  binaryInfo: BinaryInfo | null;
  checkPreflight: () => Promise<void>;
  draft: BrowserProfile | null;
  preflight: ProfilePreflightReport | null;
  setBinaryInfo: Dispatch<SetStateAction<BinaryInfo | null>>;
  setBrowserCoreImport: Dispatch<SetStateAction<BrowserCoreImportDialogState>>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
  onCoreChanged?: (info: BinaryInfo, options?: { restart?: boolean }) => Promise<void>;
  onPrivateConfigurationChanged?: (configuration: { configured: boolean; repositoryUrl?: string }) => void | Promise<void>;
}) {
  async function installBinary(targetChannel?: BrowserCoreChannel) {
    setBusy("binary-install");
    try {
      const result = await api<{ binaryPath: string; info: BinaryInfo; target?: BrowserCoreTargetResult; activated?: boolean }>("/api/binary/install", {
        method: "POST",
        body: targetChannelBody(targetChannel),
      });
      setBinaryInfo(result.info);
      await onCoreChanged?.(result.info, { restart: result.activated !== false });
      // A build that landed while sessions were running is installed, not enabled: saying "ready" would
      // describe a switch the server declined to make.
      toast(result.activated === false ? "info" : "success", result.activated === false
        ? installedNotActiveMessage(t, targetChannel, result.target, result.info.version)
        : t("toast.binaryReady"));
      if (preflight?.profileId === draft?.id) {
        await checkPreflight();
      }
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  // An explicit update can replace an imported build and prune it from the managed cache.
  // The archive it came from is the operator's own file and
  // CBPanel keeps no copy of it, so a build that was imported rather than downloaded gets a confirmation
  // first. Downloaded builds keep going straight through: re-downloading one costs nothing.
  async function updateBinary(targetChannel?: BrowserCoreChannel) {
    const imported = binaryInfo?.core?.importedBuild;
    if (!imported) {
      await updateBinaryNow(targetChannel);
      return;
    }
    setConfirmDialog({
      title: t("confirm.replaceImportedCoreTitle"),
      body: t("confirm.replaceImportedCore", { version: imported.version, file: imported.fileName }),
      confirmLabel: t("actions.update"),
      tone: "warning",
      busyKey: "binary-update",
      onConfirm: () => updateBinaryNow(targetChannel),
    });
  }

  async function updateBinaryNow(targetChannel?: BrowserCoreChannel) {
    setBusy("binary-update");
    try {
      const result = await api<{ version: string | null; info: BinaryInfo; target?: BrowserCoreTargetResult; activated?: boolean }>("/api/binary/update", {
        method: "POST",
        body: targetChannelBody(targetChannel),
      });
      setBinaryInfo(result.info);
      await onCoreChanged?.(result.info, { restart: result.activated !== false });
      setConfirmDialog(null);
      if (result.activated === false) {
        toast("info", installedNotActiveMessage(t, targetChannel, result.target, result.version ?? undefined));
      } else {
        toast("success", result.version ? t("toast.binaryUpdated", { version: result.version }) : t("toast.binaryLatest"));
      }
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  // Clearing keeps the build in use, so an offline import is not destroyed by it: the imported build is
  // what is running, which is exactly the one the server keeps. The import sentence therefore only
  // applies when the import is *not* the running build and would be among the superseded ones.
  async function clearBinaryCache(targetChannel?: BrowserCoreChannel) {
    const imported = binaryInfo?.core?.importedBuild;
    const importedIsRunning = Boolean(imported && binaryInfo?.version && imported.version === binaryInfo.version);
    setConfirmDialog({
      title: t("confirm.clearBinaryTitle"),
      body: imported && !importedIsRunning
        ? `${t("confirm.clearBinary")} ${t("confirm.clearBinaryImportedCore", { file: imported.fileName })}`
        : t("confirm.clearBinary"),
      confirmLabel: t("actions.clearCache"),
      tone: "danger",
      busyKey: "binary-clear",
      onConfirm: () => clearBinaryCacheNow(targetChannel),
    });
  }

  async function clearBinaryCacheNow(targetChannel?: BrowserCoreChannel) {
    setBusy("binary-clear");
    try {
      const result = await api<{ info: BinaryInfo }>("/api/binary/clear-cache", {
        method: "POST",
        body: targetChannelBody(targetChannel),
      });
      setBinaryInfo(result.info);
      await onCoreChanged?.(result.info);
      setConfirmDialog(null);
      toast("success", t("toast.binaryCacheCleared"));
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  // No busy key and no info refresh: the abort is signalled server-side and the operation being cancelled
  // finishes rejecting on its own, so the polled read reports the outcome. Blocking here would make
  // cancelling as slow as the thing being cancelled.
  async function cancelBrowserCoreOperation() {
    try {
      const result = await api<{ cancelled: boolean }>("/api/browser-core/operation/cancel", { method: "POST" });
      toast(result.cancelled ? "info" : "error", t(result.cancelled ? "toast.operationCancelling" : "toast.operationNotRunning"));
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    }
  }

  async function checkBrowserCoreUpdate(options: { silent?: boolean; targetChannel?: BrowserCoreChannel } = {}) {
    if (!options.silent) setBusy("browser-core-check-update");
    try {
      const result = await api<{ update: BrowserCoreUpdateCheck; info: BinaryInfo }>("/api/browser-core/check-update", {
        method: "POST",
        body: targetChannelBody(options.targetChannel),
      });
      setBinaryInfo(result.info);
      // A silent check is the startup one, which nobody asked for, and its "update available" toast is the
      // only message that survives silence — deliberately, so a background check can still speak up. Not
      // over an imported build: acting on that prompt replaces a core the operator supplied by hand and
      // CBPanel cannot get back, so the unprompted nudge towards it is withdrawn. The panel still carries
      // the badge and the caveat, and a check the operator runs still answers in full.
      const suppressAutomaticNotice = Boolean(options.silent && (result.info.core?.importedBuild || result.update.blockedReason));
      // `info` is the running channel, so the comparison is against the running channel's answer. A
      // check aimed at the channel that is not running is not the stored verdict — the card keeps
      // showing the running channel's badge — and this toast is the entire result, so it must not be
      // withdrawn for a check the operator explicitly asked for.
      const otherChannelCheck = Boolean(options.targetChannel && options.targetChannel !== result.info.core?.channel);
      if (result.update.error && !options.silent) {
        toast("error", browserCoreUpdateErrorMessage(result.update, t));
      } else if (otherChannelCheck && !options.silent) {
        toast(result.update.updateAvailable && result.update.latestVersion ? "info" : "success", result.update.updateAvailable && result.update.latestVersion
          ? t("browserCore.updateAvailable", { version: result.update.latestVersion })
          : t("toast.binaryLatest"));
      } else if (result.update.updateAvailable && result.update.latestVersion && !suppressAutomaticNotice) {
        toast("info", t("browserCore.updateAvailable", { version: result.update.latestVersion }));
      } else if (!options.silent) {
        toast("success", t("toast.binaryLatest"));
      }
    } catch (error) {
      if (!options.silent) toast("error", browserCoreErrorMessage(error, t));
    } finally {
      if (!options.silent) setBusy("");
    }
  }

  async function installBrowserCoreImport(analysis: BrowserCoreImportAnalysis) {
    setBusy("browser-core-import");
    try {
      const result = await api<{ analysis: BrowserCoreImportAnalysis; info: BinaryInfo; pendingActivation?: boolean }>("/api/browser-core/import/install", {
        method: "POST",
        body: JSON.stringify({
          path: analysis.filePath,
          targetTier: analysis.targetTier,
          targetChannel: analysis.targetChannel,
          versionHint: analysis.versionHint,
        }),
      });
      setBinaryInfo(result.info);
      await onCoreChanged?.(result.info, { restart: !result.pendingActivation });
      setBrowserCoreImport(null);
      const imported = result.analysis.importedVersion ?? "-";
      // The files landed, but that is not the same as the import taking effect. An active override
      // bypasses the managed cache outright, and the wrapper declines a marker naming a build older
      // than its bundled baseline — a plain green success in either case is how a no-op import reads
      // as done.
      const overrideEnv = result.info.core?.env ?? [];
      const internalManagedPath = overrideEnv.some((row) => row.key === "CLOAKBROWSER_BINARY_PATH" && row.source === "cbpanel-default");
      const override = internalManagedPath ? undefined : binaryPathOverrideFrom(overrideEnv);
      if (result.pendingActivation) {
        toast("info", t("browserCore.pendingImportSessionsRunning"));
      } else if (override) {
        toast("info", t("browserCore.importInertOverride", { version: imported, path: override }));
      } else if (result.analysis.targetCacheDir && result.info.cacheDir !== result.analysis.targetCacheDir) {
        toast("info", t("browserCore.importNotEffective", { version: imported, effective: result.info.version }));
      } else {
        toast("success", t("browserCore.importInstalled", { version: imported }));
      }
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function analyzeBrowserCoreImport(
    filePath: string,
    options: Partial<Pick<BrowserCoreImportAnalysis, "targetTier" | "targetChannel" | "versionHint">> = {},
  ): Promise<BrowserCoreImportAnalysis> {
    return api<BrowserCoreImportAnalysis>("/api/browser-core/import/analyze", {
      method: "POST",
      body: JSON.stringify({
        path: filePath,
        targetTier: options.targetTier,
        targetChannel: options.targetChannel,
        versionHint: options.versionHint,
      }),
    });
  }

  async function testPrivateRepository(repositoryUrl: string, token?: string): Promise<{ configured?: boolean; repositoryUrl?: string }> {
    const result = await api<{ configured?: boolean; repositoryUrl?: string }>("/api/browser-core/private/test", {
      method: "POST",
      body: JSON.stringify({ repositoryUrl, ...(token ? { token } : {}) }),
    });
    privateConfigurationChanged({ configured: Boolean(result.configured), repositoryUrl: result.repositoryUrl });
    return result;
  }

  async function loadPrivateReleases(repositoryUrl?: string): Promise<BrowserCorePrivateRelease[]> {
    const query = repositoryUrl ? `?repositoryUrl=${encodeURIComponent(repositoryUrl)}` : "";
    const result = await api<{ releases?: BrowserCorePrivateRelease[] }>(`/api/browser-core/private/releases${query}`);
    return result.releases ?? [];
  }

  async function clearPrivateToken(): Promise<void> {
    const result = await api<{ configured: boolean }>("/api/browser-core/private/token", { method: "DELETE" });
    privateConfigurationChanged(result);
  }

  function privateConfigurationChanged(configuration: { configured: boolean; repositoryUrl?: string }) {
    // The credential mutation already committed. Return its result to the form immediately, while
    // the common bounded refresh updates the rest of the app independently.
    void Promise.resolve().then(() => onPrivateConfigurationChanged?.(configuration)).catch(() => {
      toast("info", t("browserCore.privateConfigurationRefreshFailed"));
    });
  }

  async function installPrivateVersion(version?: string, source?: { repositoryUrl?: string; releaseId?: number }): Promise<void> {
    setBusy("browser-core-private-install");
    try {
      const result = await api<{ info: BinaryInfo; version: string; target?: BrowserCoreTargetResult; activated?: boolean }>("/api/browser-core/private/install", {
        method: "POST",
        body: JSON.stringify({ ...(version ? { version } : {}), ...source }),
      });
      setBinaryInfo(result.info);
      await onCoreChanged?.(result.info, { restart: result.activated !== false });
      if (result.activated === false) {
        toast("info", installedNotActiveMessage(t, "private", result.target, result.version ?? version));
      } else {
        toast("success", t("browserCore.privateInstalled", { version: result.version ?? version ?? "-" }));
      }
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function activateCoreChannel(channel: BrowserCoreChannel, mode: BrowserCoreChannelMode, expectedVersion?: string): Promise<void> {
    setBusy("browser-core-channel-switch");
    try {
      const result = await api<{ info: BinaryInfo }>("/api/browser-core/channel/activate", {
        method: "POST",
        body: JSON.stringify({ channel, mode, ...(expectedVersion ? { expectedVersion } : {}) }),
      });
      setBinaryInfo(result.info);
      await onCoreChanged?.(result.info, { restart: true });
      toast("success", t("browserCore.channelActivated"));
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function checkGithubMirrors(customGithubMirrorPrefix: string): Promise<GithubMirrorProbeResponse> {
    return api<GithubMirrorProbeResponse>("/api/network/github-mirrors/check", {
      method: "POST",
      body: JSON.stringify({
        providerId: "all",
        customGithubMirrorPrefix,
      }),
    });
  }

  return {
    analyzeBrowserCoreImport,
    cancelBrowserCoreOperation,
    checkBrowserCoreUpdate,
    checkGithubMirrors,
    clearBinaryCache,
    installBinary,
    installBrowserCoreImport,
    installPrivateVersion,
    activateCoreChannel,
    loadPrivateReleases,
    testPrivateRepository,
    clearPrivateToken,
    updateBinary,
  };
}
