import { KeyRound } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import {
  type BrowserProfile,
  clearStoredSeed,
  identitySource,
} from "../../shared/profile";
import { InfoTip } from "../ui/form-controls";

/**
 * The identity read-out lives at the foot of the editor's own tab column, beside the tabs it belongs
 * to rather than inside a form section: it is a property of the environment as a whole, and it stays
 * visible whichever tab is open.
 *
 * A stored seed is an action, not a caption: the button shows the seed id at rest and swaps its own
 * label to "use the automatic identity" on hover or keyboard focus, so the value and the way out of
 * it occupy the same row and neither is a second line of explanatory text. The other sources are
 * plain read-outs — an arg is something the operator wrote, a per-launch random identity has nothing
 * to clear, and the wrapper's own seed file is rotated by the button beneath it.
 */
export function ProfileEditorIdentityPanel({
  draft,
  draftIsNew,
  identityRotationBlocked,
  rotateIdentity,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  draftIsNew: boolean;
  identityRotationBlocked: boolean;
  rotateIdentity?: () => void;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const identity = identitySource(draft);
  // Only a stored seed can be dropped from here; every other source either has nothing to clear or
  // belongs to a different action, so the element stays a read-out in those states.
  const droppable = identity.kind === "stored";
  const value =
    identity.kind === "arg" || identity.kind === "stored"
      ? identity.value
      : identity.kind === "passthrough"
        ? "--fingerprint=off"
        : t(`form.identityValue.${identity.kind}` as TranslationKey);
  const canRotate =
    Boolean(rotateIdentity) && draft.mode === "persistent" && !draftIsNew && identity.kind === "persistent-file";
  // The persistent file is the wrapper's own default and the value already reads "Automatic", so it
  // carries no caption; a stored seed's caption ("fixed seed") only restated what the button shows, so
  // it is gone too — the remaining sources are the ones a caption still distinguishes.
  const source = identity.kind === "stored" || identity.kind === "persistent-file"
    ? undefined
    : t(`form.identitySource.${identity.kind}` as TranslationKey);
  return (
    <section className="editor-identity" aria-label={t("form.seed")}>
      <span className="editor-identity-label">
        <KeyRound size={13} aria-hidden="true" />
        {t("form.seed")}
        <InfoTip text={t("tips.seed")} />
      </span>
      {droppable ? (
        /*
          Two labels in one button: the id at rest, the action on hover/focus. Both occupy the same
          line box, so the control never changes height or reflows the panel when the pointer lands.
        */
        <button
          className="editor-identity-value editor-identity-button"
          onClick={() => setDraft(clearStoredSeed(draft))}
          title={t("form.identityUseAutomatic")}
          type="button"
        >
          <span className="editor-identity-idle">{value}</span>
          <span className="editor-identity-hover">{t("form.identityUseAutomatic")}</span>
        </button>
      ) : (
        <code className="editor-identity-value" title={value}>{value}</code>
      )}
      {source && <small className="editor-identity-source">{source}</small>}
      {canRotate && (
        <button
          className="command subtle compact"
          disabled={identityRotationBlocked}
          onClick={rotateIdentity}
          title={identityRotationBlocked ? t("form.rotateIdentityBlocked") : undefined}
          type="button"
        >
          {t("form.rotateIdentityAction")}
        </button>
      )}
      {canRotate && identityRotationBlocked && <small className="editor-identity-note">{t("form.rotateIdentityBlocked")}</small>}
    </section>
  );
}
