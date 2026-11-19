import { useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { FolderOpen, Link2, Puzzle, Unlink2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { errorMessage } from "../../lib/apiClient";
import { useExtensionIcon } from "../../lib/extensionIcons";
import {
  RUNTIME_QUICK_ARGS,
  type BrowserProfile,
  type RuntimeQuickArg,
  buildProxyUrl,
  isEnhancedProxyEnabled,
  isRuntimeQuickArgEnabled,
  setEnhancedProxy,
  setRuntimeQuickArg,
  textFromLines,
} from "../../shared/profile";
import type { ExtensionEntity } from "../../shared/entities";
import { Field, ToggleField } from "../ui/form-controls";
import { extensionInstallStateLabel, localPathBaseName } from "../../shared/extensionDisplay";

/** Copies a path and reports it on the button itself — the editor has no toast channel of its own. */
async function copyPath(path: string, button: HTMLButtonElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(path);
  } catch {
    return;
  }
  button.classList.add("is-copied");
  window.setTimeout(() => button.classList.remove("is-copied"), 1500);
}

/**
 * The manifest icon, falling back to the same glyph the registry uses. The hook only asks for installed
 * unpacked copies, so a metadata-only row costs no request.
 */
function ExtensionRowIcon({ extension }: { extension: ExtensionEntity }) {
  const icon = useExtensionIcon(extension);
  return (
    <span className="extension-binding-icon" aria-hidden="true">
      {icon.src ? (
        <img alt="" className="extension-binding-icon-img" onError={icon.onError} src={icon.src} />
      ) : (
        <Puzzle size={18} aria-hidden="true" />
      )}
    </span>
  );
}

/** Pass-through and FakeShadowRoot diagnose a symptom; the rest are ordinary page or protocol switches. */
const DIAGNOSTIC_QUICK_ARG_IDS: ReadonlySet<RuntimeQuickArg["id"]> = new Set(["fingerprint-off", "fake-shadow-root"]);

export function QuickArgsPanel({
  draft,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const groups: Array<{ id: "common" | "diagnostic"; items: RuntimeQuickArg[] }> = [
    { id: "common", items: RUNTIME_QUICK_ARGS.filter((item) => !DIAGNOSTIC_QUICK_ARG_IDS.has(item.id)) },
    { id: "diagnostic", items: RUNTIME_QUICK_ARGS.filter((item) => DIAGNOSTIC_QUICK_ARG_IDS.has(item.id)) },
  ];
  return (
    <section className="quick-args-panel wide">
      <div className="panel-heading">
        <strong>{t("form.quickArgs")}</strong>
      </div>
      {groups.map((group) => (
        <div className={group.id === "diagnostic" ? "quick-arg-group diagnostic" : "quick-arg-group"} key={group.id}>
          <div className="quick-arg-group-heading">
            <strong>{t(group.id === "diagnostic" ? "form.quickArgsDiagnostic" : "form.quickArgsCommon")}</strong>
          </div>
          <div className="quick-arg-grid">
            {group.items.map((item) => {
              // SAPI voices only exist on a Windows persona; on any other persona the flag has nothing to
              // act on, so the row is disabled with the reason instead of toggling a no-op.
              const windowsPersonaOnly = item.id === "sapi-voices-off";
              const incompatible = windowsPersonaOnly && draft.fingerprint.platform === "macos";
              return (
                <ToggleField
                  key={item.id}
                  label={item.label}
                  help={item.helpKey ? t(item.helpKey as TranslationKey) : undefined}
                  checked={isRuntimeQuickArgEnabled(draft, item.id)}
                  disabled={incompatible}
                  onChange={(enabled) => setDraft(setRuntimeQuickArg(draft, item.id, enabled))}
                />
              );
            })}
          </div>
        </div>
      ))}
      {/*
        The switches above are projections of this list. Keeping the raw textarea inside the same card
        shows where they land, instead of putting "what you see" one card away from "what is written".
      */}
      <Field help={t("tips.chromiumArgs")} label={t("form.chromiumArgs")} wide>
        <textarea
          rows={4}
          placeholder={t("placeholder.chromiumArgs")}
          spellCheck={false}
          value={textFromLines(draft.runtime.extraArgs)}
          onChange={(event) =>
            setDraft({
              ...draft,
              runtime: {
                ...draft.runtime,
                extraArgs: event.target.value
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
              },
            })
          }
        />
      </Field>
    </section>
  );
}

/**
 * Enhanced proxy is a stronger connection mode on top of a configured proxy, so it is a single row on the
 * proxy tab rather than a card of its own: one switch does not need a heading, a hint and a panel.
 */
export function EnhancedProxyRow({
  draft,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="wide">
      <ToggleField
        label={t("form.enhancedProxy")}
        help={t("tips.enhancedProxy")}
        checked={isEnhancedProxyEnabled(draft)}
        disabled={!buildProxyUrl(draft.proxy)}
        onChange={(enabled) => setDraft(setEnhancedProxy(draft, enabled))}
      />
    </div>
  );
}

export function ExtensionBindingPanel({
  busy,
  draft,
  draftIsNew,
  extensions,
  boundExtensionIds,
  setDraftExtensionBinding,
  t,
}: {
  busy: string;
  draft: BrowserProfile;
  draftIsNew: boolean;
  extensions: ExtensionEntity[];
  boundExtensionIds: string[];
  setDraftExtensionBinding: (extension: ExtensionEntity, bound: boolean) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [error, setError] = useState("");
  // A real user data dir is what the extension loader needs; an ephemeral context has none, so the
  // binding action would only fail later, at launch.
  const ephemeral = draft.mode === "ephemeral";
  async function openLocalDirectory(path: string) {
    try {
      // Rust command, not the shell plugin's JS `open`: that one validates against a scope regex that
      // accepts no filesystem path at all (see cbpanel_open_directory). The command re-checks the path.
      await invoke("cbpanel_open_directory", { path });
    } catch (openError) {
      setError(t("error.openDirectoryFailed", { message: errorMessage(openError) }));
    }
  }
  return (
    <section className="extension-binding-panel wide">
      <div className="panel-heading">
        <strong>{t("form.extensionLibrary")}</strong>
        <span>{t("tips.extensionLibrary")}</span>
      </div>
      {ephemeral && (
        <div className="preflight-empty">{t("editor.extensionNeedsPersistentMode")}</div>
      )}
      {error && <div className="inline-error" role="alert">{error}</div>}
      {/* The unsaved-draft mask is owned by the surrounding extension surface, which covers this panel
          and the manual path list together — one reason, one frame, both halves of "extensions". */}
      {extensions.length === 0 ? (
        <div className="module-empty compact">
          <strong>{t("module.extensionsEmptyTitle")}</strong>
          <span>{t("module.extensionsEmptyBody")}</span>
        </div>
      ) : (
        <div className="extension-binding-list">
          {extensions.map((extension) => {
            const bound = boundExtensionIds.includes(extension.id);
            const installable = extension.status === "enabled" && extension.installState === "installed" && Boolean(extension.localPath);
            const disabledReason = extension.sourceKind === "chrome-web-store"
              ? t("module.webStoreMetadataOnly")
              : draftIsNew
                ? t("editor.saveBeforeExtensionBinding")
                : t("module.extensionNotInstalled");
            const highRiskCount = extension.permissionRisks.filter((risk) => risk.level === "high").length;
            const mediumRiskCount = extension.permissionRisks.filter((risk) => risk.level === "medium").length;
            const stateLabel = extensionInstallStateLabel(extension.installState, t);
            // The folder controls only exist while there is a directory to point at: a metadata-only
            // store entry names a listing, not a path.
            const localPath = extension.localPath;
            return (
              <div className={`extension-binding-row${bound ? " is-bound" : ""}`} key={extension.id}>
                <ExtensionRowIcon extension={extension} />
                <div className="extension-binding-main">
                  <span className="extension-binding-title">
                    <strong>{extension.name}</strong>
                    <small>{extension.version}</small>
                    <span className="entity-badge">{stateLabel}</span>
                  </span>
                  <span className="extension-binding-meta">
                    {localPath ? (
                      <>
                        {/*
                          The path itself is the copy control: a row of icon buttons beside a short
                          directory name crowds the line, and copying the path is the only thing an
                          operator does with it. `title` still names the full path on hover.
                        */}
                        <button
                          aria-label={t("actions.copyPath")}
                          className="extension-binding-path"
                          onClick={(event) => void copyPath(localPath, event.currentTarget)}
                          title={localPath}
                          type="button"
                        >
                          {localPathBaseName(localPath)}
                        </button>
                        {isTauri() && (
                          <button
                            aria-label={t("actions.openDirectory")}
                            className="icon-button compact"
                            onClick={() => void openLocalDirectory(localPath)}
                            title={t("actions.openDirectory")}
                            type="button"
                          >
                            <FolderOpen size={14} aria-hidden="true" />
                          </button>
                        )}
                      </>
                    ) : (
                      <small className="extension-binding-path" title={extension.sourceUrl || undefined}>
                        {extension.sourceUrl || t("module.extensionNoPath")}
                      </small>
                    )}
                    {(highRiskCount > 0 || mediumRiskCount > 0) && (
                      <span className="risk-badge-group">
                        {highRiskCount > 0 && <span className="risk-badge risk-high">{t("module.extensionRisk", { count: highRiskCount })}</span>}
                        {mediumRiskCount > 0 && <span className="risk-badge risk-medium">{t("module.extensionRiskMedium", { count: mediumRiskCount })}</span>}
                      </span>
                    )}
                    {/* `bound` no longer needs a path comparison: every bound extension reaches the launch
                        from the library, so "bound but not loadable yet" is exactly the state worth naming. */}
                    {bound && !installable && <small className="extension-binding-note">{t("module.extensionNotInstalled")}</small>}
                    {!installable && !bound && <small className="extension-binding-note">{disabledReason}</small>}
                    {busy === `extension-bind-draft:${extension.id}` && <small className="extension-binding-note">{t("status.saving")}</small>}
                  </span>
                </div>
                {/*
                  One icon button, two states: a link glyph when the extension is not bound, a broken
                  link when it is. The label stays in `aria-label`/`title`, so the row keeps its width
                  and the colour still separates the two states.
                */}
                <button
                  aria-label={bound ? t("actions.unbind") : t("actions.bind")}
                  aria-pressed={bound}
                  className={`icon-button compact binding-toggle ${bound ? "is-bound-action" : ""}`}
                  disabled={draftIsNew || ephemeral || (!installable && !bound) || busy === `extension-bind-draft:${extension.id}`}
                  onClick={() => void setDraftExtensionBinding(extension, !bound)}
                  title={ephemeral && !bound ? t("editor.extensionNeedsPersistentMode") : !installable && !bound ? disabledReason : bound ? t("actions.unbind") : t("actions.bind")}
                  type="button"
                >
                  {bound ? <Unlink2 size={16} aria-hidden="true" /> : <Link2 size={16} aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
