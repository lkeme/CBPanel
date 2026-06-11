import { useEffect, useState } from "react";

import type { TranslationKey } from "../../i18n";
import type { BrowserCoreImportAnalysis } from "../../shared/browserCore";
import { DialogShell } from "../ui/DialogShell";
import { KeyValueList } from "../ui/KeyValueList";

export type BrowserCoreImportDialogState = {
  filePath: string;
  analysis?: BrowserCoreImportAnalysis;
} | null;

export function BrowserCoreImportDialog({
  analyzeImport,
  busy,
  close,
  installImport,
  setState,
  state,
  t,
}: {
  analyzeImport: (filePath: string) => Promise<BrowserCoreImportAnalysis>;
  busy: string;
  close: () => void;
  installImport: (analysis: BrowserCoreImportAnalysis) => Promise<void>;
  setState: React.Dispatch<React.SetStateAction<BrowserCoreImportDialogState>>;
  state: NonNullable<BrowserCoreImportDialogState>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [error, setError] = useState("");
  const isBusy = busy === "browser-core-import";

  useEffect(() => {
    let cancelled = false;
    async function analyze() {
      setError("");
      try {
        const analysis = await analyzeImport(state.filePath);
        if (!cancelled) setState((current) => (current ? { ...current, analysis } : current));
      } catch (analysisError) {
        if (!cancelled) setError((analysisError as Error).message);
      }
    }
    if (!state.analysis) void analyze();
    return () => {
      cancelled = true;
    };
  }, [analyzeImport, setState, state.analysis, state.filePath]);

  const analysis = state.analysis;
  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button
            className="command primary"
            disabled={!analysis?.allowed || isBusy}
            onClick={() => analysis && void installImport(analysis)}
            type="button"
          >
            {t("browserCore.confirmImport")}
          </button>
        </>
      }
      close={close}
      closeDisabled={isBusy}
      description={t("browserCore.manualImportHelp")}
      labelledBy="browser-core-import-title"
      panelClassName="registry-editor-panel"
      t={t}
      title={t("browserCore.importAnalysis")}
    >
      {error && <div className="inline-error">{error}</div>}
      {!analysis && !error && <div className="preflight-empty">{t("browserCore.analyzeImport")}</div>}
      {analysis && (
        <div className="settings-stack no-padding">
          <div className={analysis.allowed ? "settings-status-line enabled" : "inline-error"}>
            <strong>
              {analysis.allowed
                ? t("browserCore.importAllowed", { operation: analysis.operation })
                : t("browserCore.importBlocked", { reason: analysis.reason ?? "-" })}
            </strong>
            <span>{t("browserCore.importVersionChange", { current: analysis.currentVersion, next: analysis.importedVersion ?? "-" })}</span>
          </div>
          <KeyValueList
            items={[
              { label: t("browserCore.importZipPath"), value: analysis.filePath, mono: true },
              { label: t("form.platform"), value: analysis.platform },
              { label: t("form.version"), value: analysis.importedVersion ?? "-" },
              { label: "SHA-256", value: analysis.sha256, mono: true },
              { label: t("form.cache"), value: analysis.targetCacheDir ?? "-", mono: true },
            ]}
          />
        </div>
      )}
    </DialogShell>
  );
}
