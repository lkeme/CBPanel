import type { TranslationKey } from "../../i18n";
import {
  type BrowserProfile,
  textFromLines,
} from "../../shared/profile";
import type { ExtensionEntity } from "../../shared/entities";
import { Field } from "../ui/form-controls";
import { ExtensionBindingPanel, QuickArgsPanel } from "./ProfileEditorAdvancedPanels";

export function ProfileEditorAdvancedTab({
  draft,
  setDraft,
  busy,
  extensions,
  boundExtensionIds,
  setDraftExtensionBinding,
  t,
  draftIsNew,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  busy: string;
  extensions: ExtensionEntity[];
  boundExtensionIds: string[];
  setDraftExtensionBinding: (extension: ExtensionEntity, bound: boolean) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  draftIsNew: boolean;
}) {
  const fp = draft.fingerprint;
  return (
    <div className="form-grid two">
      <Field label="User Agent" wide>
        <input value={draft.viewport.userAgent} onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, userAgent: event.target.value } })} placeholder={t("placeholder.userAgent")} />
      </Field>
      <Field label={t("form.gpuVendor")}>
        <input value={fp.gpuVendor} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, gpuVendor: event.target.value } })} placeholder={t("placeholder.gpuVendor")} />
      </Field>
      <Field label={t("form.gpuRenderer")}>
        <input value={fp.gpuRenderer} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, gpuRenderer: event.target.value } })} placeholder={t("placeholder.gpuRenderer")} />
      </Field>
      <Field label={t("form.storageMb")}>
        <input value={fp.storageQuotaMb} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, storageQuotaMb: event.target.value } })} placeholder={t("placeholder.storageQuota")} />
      </Field>
      <Field label={t("form.taskbarPx")}>
        <input value={fp.taskbarHeight} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, taskbarHeight: event.target.value } })} placeholder={t("placeholder.taskbarHeight")} />
      </Field>
      <Field label={t("form.fontsDir")} wide>
        <input value={fp.fontsDir} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, fontsDir: event.target.value } })} placeholder={t("placeholder.fontsDir")} />
      </Field>
      <Field label={t("form.extensionPaths")} wide>
        <textarea
          rows={4}
          placeholder={t("placeholder.extensionPaths")}
          value={textFromLines(draft.runtime.extensionPaths)}
          onChange={(event) =>
            setDraft({
              ...draft,
              runtime: {
                ...draft.runtime,
                extensionPaths: event.target.value
                  .split(/\r?\n/)
                  .map((line) => line.trim())
                  .filter(Boolean),
              },
            })
          }
        />
      </Field>
      <ExtensionBindingPanel
        busy={busy}
        draft={draft}
        draftIsNew={draftIsNew}
        extensions={extensions}
        boundExtensionIds={boundExtensionIds}
        setDraftExtensionBinding={setDraftExtensionBinding}
        t={t}
      />
      <Field label={t("form.chromiumArgs")} wide>
        <textarea
          rows={6}
          placeholder={t("placeholder.chromiumArgs")}
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
      <QuickArgsPanel draft={draft} setDraft={setDraft} t={t} />
      <Field label={t("form.launchOptionsJson")} wide>
        <textarea rows={5} spellCheck={false} value={draft.advanced.launchOptionsJson} onChange={(event) => setDraft({ ...draft, advanced: { ...draft.advanced, launchOptionsJson: event.target.value } })} placeholder={t("placeholder.launchOptionsJson")} />
      </Field>
      <Field label={t("form.contextOptionsJson")} wide>
        <textarea rows={5} spellCheck={false} value={draft.advanced.contextOptionsJson} onChange={(event) => setDraft({ ...draft, advanced: { ...draft.advanced, contextOptionsJson: event.target.value } })} placeholder={t("placeholder.contextOptionsJson")} />
      </Field>
      <Field label={t("form.humanConfigJson")} wide>
        <textarea rows={5} spellCheck={false} value={draft.advanced.humanConfigJson} onChange={(event) => setDraft({ ...draft, advanced: { ...draft.advanced, humanConfigJson: event.target.value } })} placeholder={t("placeholder.humanConfigJson")} />
      </Field>
    </div>
  );
}
