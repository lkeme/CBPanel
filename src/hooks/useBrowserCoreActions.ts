import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { BrowserCoreImportDialogState } from "../components/browser-core/BrowserCoreImportDialog";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, browserCoreErrorMessage } from "../lib/apiClient";
import {
  binaryPathOverrideFrom,
  type BrowserCoreImportAnalysis,
  type BrowserCoreUpdateCheck,
  type BinaryInfo,
} from "../shared/browserCore";
import type { GithubMirrorProbeResponse } from "../shared/githubMirror";
import type { BrowserProfile, ProfilePreflightReport } from "../shared/profile";

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
}) {
  async function installBinary() {
    setBusy("binary-install");
    try {
      const result = await api<{ binaryPath: string; info: BinaryInfo }>("/api/binary/install", { method: "POST" });
      setBinaryInfo(result.info);
      toast("success", t("toast.binaryReady"));
      if (preflight?.profileId === draft?.id) {
        await checkPreflight();
      }
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  // An update is the one managed action that cannot be undone. Unlike an install it ignores
  // preferExistingCache, so it always downloads, and it finishes by pruning the cache back to a single
  // build — which deletes the imported one. The archive it came from is the operator's own file and
  // CBPanel keeps no copy of it, so a build that was imported rather than downloaded gets a confirmation
  // first. Downloaded builds keep going straight through: re-downloading one costs nothing.
  async function updateBinary() {
    const imported = binaryInfo?.core?.importedBuild;
    if (!imported) {
      await updateBinaryNow();
      return;
    }
    setConfirmDialog({
      title: t("confirm.replaceImportedCoreTitle"),
      body: t("confirm.replaceImportedCore", { version: imported.version, file: imported.fileName }),
      confirmLabel: t("actions.update"),
      tone: "warning",
      busyKey: "binary-update",
      onConfirm: updateBinaryNow,
    });
  }

  async function updateBinaryNow() {
    setBusy("binary-update");
    try {
      const result = await api<{ version: string | null; info: BinaryInfo }>("/api/binary/update", { method: "POST" });
      setBinaryInfo(result.info);
      setConfirmDialog(null);
      toast("success", result.version ? t("toast.binaryUpdated", { version: result.version }) : t("toast.binaryLatest"));
    } catch (error) {
      toast("error", browserCoreErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  // The other manual path that destroys an offline-imported core, and the one difference that matters: the
  // archive is the operator's own file and CBPanel keeps no copy, so unlike a downloaded build this cannot
  // be fetched again. It is still a single confirmation and it still goes through — a destructive action the
  // operator asked for by name should be told, not blocked. (The update guard is the opposite case: there
  // the operator believes they are doing something harmless.)
  async function clearBinaryCache() {
    const imported = binaryInfo?.core?.importedBuild;
    setConfirmDialog({
      title: t("confirm.clearBinaryTitle"),
      body: imported
        ? `${t("confirm.clearBinary")} ${t("confirm.clearBinaryImportedCore", { file: imported.fileName })}`
        : t("confirm.clearBinary"),
      confirmLabel: t("actions.clearCache"),
      tone: "danger",
      busyKey: "binary-clear",
      onConfirm: clearBinaryCacheNow,
    });
  }

  async function clearBinaryCacheNow() {
    setBusy("binary-clear");
    try {
      const result = await api<{ info: BinaryInfo }>("/api/binary/clear-cache", { method: "POST" });
      setBinaryInfo(result.info);
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

  async function checkBrowserCoreUpdate(options: { silent?: boolean } = {}) {
    if (!options.silent) setBusy("browser-core-check-update");
    try {
      const result = await api<{ update: BrowserCoreUpdateCheck; info: BinaryInfo }>("/api/browser-core/check-update", { method: "POST" });
      setBinaryInfo(result.info);
      // A silent check is the startup one, which nobody asked for, and its "update available" toast is the
      // only message that survives silence — deliberately, so a background check can still speak up. Not
      // over an imported build: acting on that prompt replaces a core the operator supplied by hand and
      // CBPanel cannot get back, so the unprompted nudge towards it is withdrawn. The panel still carries
      // the badge and the caveat, and a check the operator runs still answers in full.
      const unpromptedAtImportedBuild = Boolean(options.silent && result.info.core?.importedBuild);
      if (result.update.error && !options.silent) {
        toast("error", result.update.error);
      } else if (result.update.updateAvailable && result.update.latestVersion && !unpromptedAtImportedBuild) {
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
      const result = await api<{ analysis: BrowserCoreImportAnalysis; info: BinaryInfo }>("/api/browser-core/import/install", {
        method: "POST",
        body: JSON.stringify({
          path: analysis.filePath,
          targetTier: analysis.targetTier,
        }),
      });
      setBinaryInfo(result.info);
      setBrowserCoreImport(null);
      const imported = result.analysis.importedVersion ?? "-";
      // The files landed, but that is not the same as the import taking effect. An active override
      // bypasses the managed cache outright, and the wrapper declines a marker naming a build older
      // than its bundled baseline — a plain green success in either case is how a no-op import reads
      // as done.
      const override = binaryPathOverrideFrom(result.info.core?.env ?? []);
      if (override) {
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
    options: Partial<Pick<BrowserCoreImportAnalysis, "targetTier">> = {},
  ): Promise<BrowserCoreImportAnalysis> {
    return api<BrowserCoreImportAnalysis>("/api/browser-core/import/analyze", {
      method: "POST",
      body: JSON.stringify({
        path: filePath,
        targetTier: options.targetTier,
      }),
    });
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
    updateBinary,
  };
}
