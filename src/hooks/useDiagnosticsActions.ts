import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import { api } from "../lib/apiClient";
import type { SystemDiagnostics } from "../shared/entities";

export function useDiagnosticsActions({
  downloadTextFile,
  diagnostics,
  setBusy,
  setDiagnostics,
  t,
  toast,
}: {
  downloadTextFile: (content: string, filename: string, type: string) => Promise<boolean>;
  diagnostics: SystemDiagnostics | null;
  setBusy: Dispatch<SetStateAction<string>>;
  setDiagnostics: Dispatch<SetStateAction<SystemDiagnostics | null>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  async function fetchDiagnostics(): Promise<SystemDiagnostics> {
    const next = await api<SystemDiagnostics>("/api/system/diagnostics");
    setDiagnostics(next);
    return next;
  }

  async function loadDiagnostics() {
    try {
      await fetchDiagnostics();
    } catch {
      setDiagnostics(null);
    }
  }

  async function refreshDiagnostics() {
    setBusy("diagnostics-refresh");
    try {
      await fetchDiagnostics();
      toast("success", t("actions.refresh"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function copyDiagnostics() {
    if (!diagnostics) return;
    try {
      await navigator.clipboard.writeText(`${JSON.stringify(diagnostics, null, 2)}\n`);
      toast("success", t("toast.diagnosticsCopied"));
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }

  async function exportDiagnostics() {
    if (!diagnostics) return;
    try {
      const saved = await downloadTextFile(`${JSON.stringify(diagnostics, null, 2)}\n`, "cbpanel-diagnostics.json", "application/json");
      if (saved) toast("success", t("toast.exported"));
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }

  return {
    copyDiagnostics,
    exportDiagnostics,
    fetchDiagnostics,
    loadDiagnostics,
    refreshDiagnostics,
  };
}
