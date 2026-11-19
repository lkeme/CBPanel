import type { TranslationKey } from "../../i18n";
import type { BrowserProfile } from "../../shared/profile";
import { Field } from "../ui/form-controls";
import { QuickArgsPanel } from "./ProfileEditorAdvancedPanels";

export function ProfileEditorAdvancedTab({
  draft,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="editor-grid">
      <QuickArgsPanel draft={draft} setDraft={setDraft} t={t} />
      <Field label={t("form.launchOptionsJson")} help={t("tips.launchOptionsJson")} wide>
        <textarea rows={4} spellCheck={false} value={draft.advanced.launchOptionsJson} onChange={(event) => setDraft({ ...draft, advanced: { ...draft.advanced, launchOptionsJson: event.target.value } })} placeholder={t("placeholder.launchOptionsJson")} />
      </Field>
      <Field label={t("form.contextOptionsJson")} help={t("tips.contextOptionsJson")} wide>
        <textarea rows={4} spellCheck={false} value={draft.advanced.contextOptionsJson} onChange={(event) => setDraft({ ...draft, advanced: { ...draft.advanced, contextOptionsJson: event.target.value } })} placeholder={t("placeholder.contextOptionsJson")} />
      </Field>
    </div>
  );
}
