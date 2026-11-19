import { useEffect, useState } from "react";

import type { TranslationKey } from "../../i18n";
import type { BrowserCoreImportAnalysis, BrowserCoreImportRefusal } from "../../shared/browserCore";
import { browserCorePinIssue } from "../../shared/browserCore";
import type { BrowserCoreChannel } from "../../shared/settings";
import { DialogShell } from "../ui/DialogShell";
import { Field } from "../ui/form-controls";
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
  targetChannel?: BrowserCoreChannel;
  versionHint?: string;
  analysis?: BrowserCoreImportAnalysis;
} | null;

export function importStateForVersionHint(current: BrowserCoreImportDialogState, versionHint: string): BrowserCoreImportDialogState {
  return current ? { ...current, versionHint: versionHint.trim(), analysis: undefined } : current;
}

export function importVersionHintNeedsValidation(state: NonNullable<BrowserCoreImportDialogState>, draft: string): boolean {
  return draft.trim() !== (state.analysis?.versionHint ?? state.versionHint ?? "").trim();
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
    options?: Partial<Pick<BrowserCoreImportAnalysis, "targetTier" | "targetChannel" | "versionHint">>,
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
  const [versionHintDraft, setVersionHintDraft] = useState(state.versionHint ?? state.analysis?.versionHint ?? "");
  const isBusy = busy === "browser-core-import";
  useEffect(() => { setVersionHintDraft(state.versionHint ?? state.analysis?.versionHint ?? ""); }, [state.targetChannel, state.versionHint, state.analysis?.versionHint]);

  useEffect(() => {
    let cancelled = false;
    async function analyze() {
      setError("");
      try {
        const analysis = await analyzeImport(state.filePath, { targetTier: state.targetTier, targetChannel: state.targetChannel, versionHint: state.versionHint });
        if (!cancelled) setState((current) => (current ? { ...current, analysis } : current));
      } catch (analysisError) {
        if (!cancelled) setError((analysisError as Error).message);
      }
    }
    if (!state.analysis) void analyze();
    return () => {
      cancelled = true;
    };
  }, [analyzeImport, setState, state.analysis, state.filePath, state.targetChannel, state.targetTier, state.versionHint]);

  const analysis = state.analysis;
  // The channel is chosen by the card that opened this dialog, not here: the panel shows one channel at
  // a time, so a second selector would let the package land in a cache the operator is not looking at.
  const channel = analysis?.targetChannel ?? state.targetChannel ?? "official";
  const needsVersionHint = channel === "private" && Boolean(analysis?.requiresVersionHint || state.versionHint || versionHintDraft);
  const hintNeedsValidation = importVersionHintNeedsValidation(state, versionHintDraft);
  const hintInvalid = needsVersionHint && Boolean(browserCorePinIssue(versionHintDraft));
  function validateVersionHint() {
    if (isBusy || browserCorePinIssue(versionHintDraft)) return;
    setState((current) => importStateForVersionHint(current, versionHintDraft));
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
            disabled={!analysis?.allowed || isBusy || hintNeedsValidation || hintInvalid}
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
      {needsVersionHint && <Field
        label={t("browserCore.importFullVersion")}
        help={t("browserCore.importFullVersionHelp", { version: analysis?.embeddedVersion ?? "-" })}
        wide
      >
        <div className="inline-file-row no-picker">
          <input
            aria-label={t("browserCore.importFullVersion")}
            value={versionHintDraft}
            onChange={(event) => setVersionHintDraft(event.target.value)}
            disabled={isBusy}
            placeholder="156.0.8078.47.1"
            aria-invalid={hintInvalid && Boolean(versionHintDraft) || undefined}
          />
          <button className="command" disabled={isBusy || hintInvalid || !versionHintDraft.trim()} onClick={validateVersionHint} type="button">{t("browserCore.importValidateVersion")}</button>
        </div>
        {hintNeedsValidation && !hintInvalid && <span className="input-hint">{t("browserCore.importVersionNeedsValidation")}</span>}
      </Field>}
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
              { label: t("browserCore.channel"), value: t(channel === "private" ? "browserCore.channelPrivate" : "browserCore.channelOfficial") },
              { label: "SHA-256", value: analysis.sha256, mono: true },
              { label: t("form.cache"), value: analysis.targetCacheDir ?? "-", mono: true },
            ]}
          />
        </div>
      )}
    </DialogShell>
  );
}
