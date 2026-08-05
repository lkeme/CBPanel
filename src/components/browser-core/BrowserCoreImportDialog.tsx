import { useEffect, useState } from "react";

import type { TranslationKey } from "../../i18n";
import type { BrowserCoreImportAnalysis, BrowserCoreImportRefusal } from "../../shared/browserCore";
import { DialogShell } from "../ui/DialogShell";
import { Field, Segmented } from "../ui/form-controls";
import { KeyValueList } from "../ui/KeyValueList";

// The server also sends the refusal as an English sentence for direct API consumers; the panel shows
// the translated form instead, and only falls back to that sentence for a code it does not know.
const IMPORT_REFUSAL_KEYS: Record<BrowserCoreImportRefusal, TranslationKey> = {
  "sessions-running": "browserCore.importRefusalSessionsRunning",
  "unverified-package": "browserCore.importRefusalUnverified",
};

// The analysis reports the operation as a token for the API's benefit. It used to reach the panel
// verbatim, so a zh-CN user read "导入类型：reinstall".
const IMPORT_KIND_KEYS: Record<BrowserCoreImportAnalysis["operation"], TranslationKey> = {
  install: "browserCore.importKindInstall",
  upgrade: "browserCore.importKindUpgrade",
  reinstall: "browserCore.importKindReinstall",
  downgrade: "browserCore.importKindDowngrade",
  blocked: "browserCore.importKindBlocked",
};

export type BrowserCoreImportDialogState = {
  filePath: string;
  targetTier?: BrowserCoreImportAnalysis["targetTier"];
  analysis?: BrowserCoreImportAnalysis;
} | null;

// Exported for its test: the tier change must discard the cached analysis so the effect above asks the
// server again, rather than patch a verdict that was computed for the other tier.
export function importStateForTier(
  current: BrowserCoreImportDialogState,
  targetTier: BrowserCoreImportAnalysis["targetTier"],
): BrowserCoreImportDialogState {
  return current ? { ...current, targetTier, analysis: undefined } : current;
}

export function BrowserCoreImportDialog({
  analyzeImport,
  binaryPathOverride,
  busy,
  close,
  installImport,
  setState,
  state,
  t,
}: {
  analyzeImport: (
    filePath: string,
    options?: Partial<Pick<BrowserCoreImportAnalysis, "targetTier">>,
  ) => Promise<BrowserCoreImportAnalysis>;
  binaryPathOverride?: string;
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
        const analysis = await analyzeImport(state.filePath, { targetTier: state.targetTier });
        if (!cancelled) setState((current) => (current ? { ...current, analysis } : current));
      } catch (analysisError) {
        if (!cancelled) setError((analysisError as Error).message);
      }
    }
    if (!state.analysis) void analyze();
    return () => {
      cancelled = true;
    };
  }, [analyzeImport, setState, state.analysis, state.filePath, state.targetTier]);

  const analysis = state.analysis;
  // Re-analyzed on the server rather than patched in place: allowed, reason and targetCacheDir are all
  // tier-dependent, so a local patch left the verdict computed for the tier the user just moved away
  // from. That showed "import allowed" for a directory a running session may be executing, with Import
  // still enabled until the server refused it — and, the other way round, kept Import disabled for a
  // tier that was fine.
  function changeTargetTier(targetTier: BrowserCoreImportAnalysis["targetTier"]) {
    setState((current) => importStateForTier(current, targetTier));
  }
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
      {binaryPathOverride && (
        <div className="inline-error">{t("browserCore.importOverrideWarning", { path: binaryPathOverride })}</div>
      )}
      {!analysis && !error && <div className="preflight-empty">{t("browserCore.analyzeImport")}</div>}
      {analysis && (
        <div className="settings-stack no-padding">
          <div className={analysis.allowed ? "settings-status-line enabled" : "inline-error"}>
            <strong>
              {analysis.allowed
                ? t("browserCore.importAllowed", {
                  operation: IMPORT_KIND_KEYS[analysis.operation]
                    ? t(IMPORT_KIND_KEYS[analysis.operation])
                    : analysis.operation,
                })
                : t("browserCore.importBlocked", {
                  reason: analysis.reasonCode && IMPORT_REFUSAL_KEYS[analysis.reasonCode]
                    ? t(IMPORT_REFUSAL_KEYS[analysis.reasonCode])
                    : analysis.reason ?? "-",
                })}
            </strong>
            <span>{t("browserCore.importVersionChange", { current: analysis.currentVersion, next: analysis.importedVersion ?? "-" })}</span>
          </div>
          <KeyValueList
            items={[
              { label: t("browserCore.importZipPath"), value: analysis.filePath, mono: true },
              { label: t("form.platform"), value: analysis.platform },
              { label: t("form.version"), value: analysis.importedVersion ?? "-" },
              { label: t("browserCore.tier"), value: t(analysis.targetTier === "pro" ? "browserCore.tierPro" : "browserCore.tierFree") },
              { label: "SHA-256", value: analysis.sha256, mono: true },
              { label: t("form.cache"), value: analysis.targetCacheDir ?? "-", mono: true },
            ]}
          />
          <Field label={t("browserCore.importTier")} help={t("browserCore.importTierHelp")}>
            <Segmented
              value={analysis.targetTier}
              options={[
                { value: "free", label: t("browserCore.tierFree") },
                { value: "pro", label: t("browserCore.tierPro") },
              ]}
              onChange={changeTargetTier}
            />
          </Field>
        </div>
      )}
    </DialogShell>
  );
}
