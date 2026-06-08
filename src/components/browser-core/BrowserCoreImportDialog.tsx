import { useEffect, useState } from "react";

import type { TranslationKey } from "../../i18n";
import type { BrowserCoreImportAnalysis } from "../../shared/browserCore";

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
    <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="browser-core-import-title">
      <button className="modal-scrim" aria-label={t("actions.close")} onClick={isBusy ? undefined : close} type="button" />
      <section className="modal-panel registry-editor-panel">
        <header className="modal-header">
          <h2 id="browser-core-import-title">{t("browserCore.importAnalysis")}</h2>
          <p>{t("browserCore.manualImportHelp")}</p>
        </header>
        <div className="modal-body">
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
              <dl className="kv-list">
                <div>
                  <dt>{t("browserCore.importZipPath")}</dt>
                  <dd className="mono-cell">{analysis.filePath}</dd>
                </div>
                <div>
                  <dt>{t("form.platform")}</dt>
                  <dd>{analysis.platform}</dd>
                </div>
                <div>
                  <dt>{t("form.version")}</dt>
                  <dd>{analysis.importedVersion ?? "-"}</dd>
                </div>
                <div>
                  <dt>SHA-256</dt>
                  <dd className="mono-cell">{analysis.sha256}</dd>
                </div>
                <div>
                  <dt>{t("form.cache")}</dt>
                  <dd className="mono-cell">{analysis.targetCacheDir ?? "-"}</dd>
                </div>
              </dl>
            </div>
          )}
        </div>
        <footer className="modal-footer">
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
        </footer>
      </section>
    </div>
  );
}
