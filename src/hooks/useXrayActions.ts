import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import { api, errorMessage } from "../lib/apiClient";
import type { XrayEngineStatus, XrayUpdateCheck } from "../shared/entities";

/** How long a successful update check stays fresh before the startup check asks again. */
const STARTUP_UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export function shouldRunStartupXrayUpdateCheck(lastCheck: XrayUpdateCheck | undefined, now = Date.now()): boolean {
  if (!lastCheck) return true;
  const checkedAt = Date.parse(lastCheck.checkedAt);
  if (!Number.isFinite(checkedAt)) return true;
  return now - checkedAt >= STARTUP_UPDATE_CHECK_TTL_MS;
}

export function useXrayActions({
  setBusy,
  setXrayStatus,
  t,
  toast,
}: {
  setBusy: Dispatch<SetStateAction<string>>;
  setXrayStatus: Dispatch<SetStateAction<XrayEngineStatus | null>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  async function loadXrayStatus(): Promise<XrayEngineStatus | null> {
    try {
      const status = await api<XrayEngineStatus>("/api/xray");
      setXrayStatus(status);
      return status;
    } catch {
      setXrayStatus(null);
      return null;
    }
  }

  // Install and update are one route: the latest release replaces whatever build is there.
  async function installXray(): Promise<boolean> {
    setBusy("xray-install");
    try {
      const status = await api<XrayEngineStatus>("/api/xray/install", { method: "POST" });
      setXrayStatus(status);
      toast("success", t("toast.xrayInstalled", { version: status.version ?? "" }));
      return true;
    } catch (error) {
      toast("error", errorMessage(error));
      await loadXrayStatus();
      return false;
    } finally {
      setBusy("");
    }
  }

  async function checkXrayUpdate(options: { silent?: boolean } = {}): Promise<XrayUpdateCheck | null> {
    if (!options.silent) setBusy("xray-check-update");
    try {
      const result = await api<{ check: XrayUpdateCheck; status: XrayEngineStatus }>("/api/xray/check-update", { method: "POST" });
      setXrayStatus(result.status);
      if (result.check.error) {
        if (!options.silent) toast("error", result.check.error);
      } else if (result.check.updateAvailable) {
        toast("info", t("toast.xrayUpdateAvailable", { version: result.check.latestVersion ?? "" }));
      } else if (!options.silent) {
        toast("success", t("toast.xrayUpToDate"));
      }
      return result.check;
    } catch (error) {
      if (!options.silent) toast("error", errorMessage(error));
      return null;
    } finally {
      if (!options.silent) setBusy("");
    }
  }

  async function cancelXrayOperation(): Promise<void> {
    try {
      await api("/api/xray/operation/cancel", { method: "POST" });
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  return { cancelXrayOperation, checkXrayUpdate, installXray, loadXrayStatus };
}
