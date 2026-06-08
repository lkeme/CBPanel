import type { TranslationKey } from "../../i18n";
import {
  RUNTIME_QUICK_ARGS,
  type BrowserProfile,
  isRuntimeQuickArgEnabled,
  setRuntimeQuickArg,
} from "../../shared/profile";
import type { ExtensionEntity } from "../../shared/entities";
import { ToggleField } from "../ui/form-controls";

export function QuickArgsPanel({
  draft,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <section className="quick-args-panel wide">
      <div className="panel-heading">
        <strong>{t("form.quickArgs")}</strong>
        <span>{t("form.quickArgsHint")}</span>
      </div>
      <div className="quick-arg-grid">
        {RUNTIME_QUICK_ARGS.map((item) => (
          <ToggleField key={item.id} label={item.label} checked={isRuntimeQuickArgEnabled(draft, item.id)} onChange={(enabled) => setDraft(setRuntimeQuickArg(draft, item.id, enabled))} />
        ))}
      </div>
    </section>
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
  return (
    <section className="extension-binding-panel wide">
      <div className="panel-heading">
        <strong>{t("form.extensionLibrary")}</strong>
        <span>{t("tips.extensionLibrary")}</span>
      </div>
      {draftIsNew && (
        <div className="preflight-empty">{t("editor.saveBeforeExtensionBinding")}</div>
      )}
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
            const activeRuntimePath = Boolean(extension.localPath && draft.runtime.extensionPaths.includes(extension.localPath));
            const disabledReason = extension.sourceKind === "chrome-web-store"
              ? t("module.webStoreMetadataOnly")
              : draftIsNew
                ? t("editor.saveBeforeExtensionBinding")
                : t("module.extensionNotInstalled");
            return (
              <div className="extension-binding-row" key={extension.id}>
                <span>
                  <strong>{extension.name}</strong>
                  <small className="mono-cell">{extension.localPath ?? (extension.sourceUrl || t("module.extensionNoPath"))}</small>
                  <small>
                    {extension.version} · {extension.installState}
                    {bound && !activeRuntimePath ? ` · ${t("module.extensionBoundPendingInstall")}` : ""}
                    {extension.permissionRisks.length > 0 ? ` · ${t("module.extensionRisk", { count: extension.permissionRisks.length })}` : ""}
                  </small>
                </span>
                <ToggleField
                  label={bound ? t("actions.unbind") : t("actions.bind")}
                  help={installable ? undefined : disabledReason}
                  checked={bound}
                  disabled={draftIsNew || (!installable && !bound) || busy === `extension-bind-draft:${extension.id}`}
                  onChange={(checked) => {
                    void setDraftExtensionBinding(extension, checked);
                  }}
                />
                {!installable && <span className="binding-disabled-reason">{disabledReason}</span>}
                {busy === `extension-bind-draft:${extension.id}` && <span className="binding-disabled-reason">{t("status.saving")}</span>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
