import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { BrowserCoreImportDialogState } from "../components/browser-core/BrowserCoreImportDialog";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api } from "../lib/apiClient";
import type { BrowserCoreImportAnalysis, BrowserCoreUpdateCheck, BinaryInfo } from "../shared/browserCore";
import type { GithubMirrorProbeResponse } from "../shared/githubMirror";
import type { BrowserProfile, ProfilePreflightReport } from "../shared/profile";

export function useBrowserCoreActions({
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
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function updateBinary() {
    setBusy("binary-update");
    try {
      const result = await api<{ version: string | null; info: BinaryInfo }>("/api/binary/update", { method: "POST" });
      setBinaryInfo(result.info);
      toast("success", result.version ? t("toast.binaryUpdated", { version: result.version }) : t("toast.binaryLatest"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function clearBinaryCache() {
    setConfirmDialog({
      title: t("confirm.clearBinaryTitle"),
      body: t("confirm.clearBinary"),
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
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function checkBrowserCoreUpdate(options: { silent?: boolean } = {}) {
    if (!options.silent) setBusy("browser-core-check-update");
    try {
      const result = await api<{ update: BrowserCoreUpdateCheck; info: BinaryInfo }>("/api/browser-core/check-update", { method: "POST" });
      setBinaryInfo(result.info);
      if (result.update.error && !options.silent) {
        toast("error", result.update.error);
      } else if (result.update.updateAvailable && result.update.latestVersion) {
        toast("info", t("browserCore.updateAvailable", { version: result.update.latestVersion }));
      } else if (!options.silent) {
        toast("success", t("toast.binaryLatest"));
      }
    } catch (error) {
      if (!options.silent) toast("error", (error as Error).message);
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
          setAsDefault: analysis.setAsDefault,
        }),
      });
      setBinaryInfo(result.info);
      setBrowserCoreImport(null);
      toast("success", t("browserCore.importInstalled", { version: result.analysis.importedVersion ?? "-" }));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function analyzeBrowserCoreImport(filePath: string): Promise<BrowserCoreImportAnalysis> {
    return api<BrowserCoreImportAnalysis>("/api/browser-core/import/analyze", {
      method: "POST",
      body: JSON.stringify({ path: filePath }),
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
    checkBrowserCoreUpdate,
    checkGithubMirrors,
    clearBinaryCache,
    installBinary,
    installBrowserCoreImport,
    updateBinary,
  };
}
