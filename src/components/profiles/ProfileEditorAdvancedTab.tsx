import type { TranslationKey } from "../../i18n";
import {
  type BrowserProfile,
  textFromLines,
} from "../../shared/profile";
import type { ExtensionEntity } from "../../shared/entities";
import type { RuntimePlatform } from "../../shared/settings";
import { Field } from "../ui/form-controls";
import { SelectMenu } from "../ui/SelectMenu";
import { applyGpuEntry, gpuCatalogOptions, gpuSelectionValue } from "./gpuCatalog";
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
  hostPlatform,
  stealthArgs,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  busy: string;
  extensions: ExtensionEntity[];
  boundExtensionIds: string[];
  setDraftExtensionBinding: (extension: ExtensionEntity, bound: boolean) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  draftIsNew: boolean;
  // Required so the prop chain cannot be severed silently; `undefined` still means "host unknown",
  // which is what main.tsx passes before the runtime bridge answers.
  hostPlatform: RuntimePlatform | undefined;
  stealthArgs: boolean;
}) {
  const fp = draft.fingerprint;
  const hasBoundExtensions = boundExtensionIds.length > 0;
  // The picker has no state of its own: a pair that matches no entry simply has no selected option,
  // so the menu falls back to its placeholder. That keeps it correct across profile switches, which
  // do not remount the tab.
  // `stealthArgs` reaches the host rule: with stealth args off nothing spoofs the platform, so `auto`
  // must offer the host's own entries instead of the ones CloakBrowser would otherwise spoof.
  const gpuOptions = gpuCatalogOptions(fp.platform, hostPlatform, stealthArgs, fp.gpuVendor, fp.gpuRenderer);
  return (
    <div className="form-grid two">
      <Field label="User Agent" wide>
        <input value={draft.viewport.userAgent} onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, userAgent: event.target.value } })} placeholder={t("placeholder.userAgent")} />
      </Field>
      <Field label={t("form.gpuProfile")} help={t("tips.gpuProfile")} wide>
        <SelectMenu
          value={gpuSelectionValue(fp.gpuVendor, fp.gpuRenderer)}
          placeholder={t("placeholder.gpuProfile")}
          options={gpuOptions.map((entry) => ({ value: entry.id, label: entry.label, meta: entry.platform }))}
          onChange={(id) => {
            const entry = gpuOptions.find((candidate) => candidate.id === id);
            if (entry) setDraft({ ...draft, fingerprint: { ...fp, ...applyGpuEntry(entry) } });
          }}
        />
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
      {hasBoundExtensions && <div className="result-line wide">{t("form.extensionPathsIgnoredHint")}</div>}
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
