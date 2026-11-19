import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import { api, errorMessage } from "../lib/apiClient";
import type { AppUpdateCheck } from "../shared/appUpdate";
import type { PanelState } from "../shared/profile";
import { mergeSettings } from "../shared/settings";

export function useAppUpdateActions({
  setState,
  setBusy,
  t,
  toast,
}: {
  setState: Dispatch<SetStateAction<PanelState | null>>;
  setBusy: Dispatch<SetStateAction<string>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  async function checkAppUpdate(options: { silent?: boolean } = {}): Promise<AppUpdateCheck | null> {
    if (!options.silent) setBusy("app-update-check");
    try {
      const check = await api<AppUpdateCheck>("/api/app-update/check", { method: "POST" });
      setState((current) => current
        ? { ...current, settings: mergeSettings(current.settings, { appUpdate: { lastUpdateCheck: check } }) }
        : current);
      if (check.error) {
        if (!options.silent) toast("error", t("about.update.error", { message: check.error }));
      } else if (check.updateAvailable && check.latestVersion) {
        // The one message a silent check may speak: a new version is actionable, a failure is not.
        toast("info", t("about.update.available", { version: check.latestVersion }));
      } else if (!options.silent) {
        toast("success", t("about.update.upToDate"));
      }
      return check;
    } catch (error) {
      if (!options.silent) toast("error", errorMessage(error));
      return null;
    } finally {
      if (!options.silent) setBusy("");
    }
  }

  return { checkAppUpdate };
}
