import type { TranslationKey } from "../../i18n";
import {
  PROFILE_PRESETS,
  type BrowserProfile,
  type ColorScheme,
  type ProfileMode,
  type ViewportMode,
  applyProfilePreset,
  isPortableCookiesEnabled,
  setPortableCookies,
} from "../../shared/profile";
import type { ExtensionEntity, GroupEntity, TagEntity } from "../../shared/entities";
import type { WatermarkStyle } from "../../shared/watermark";
import { BooleanSegmented, Field, FormSection, Segmented } from "../ui/form-controls";
import { ExtensionBindingPanel } from "./ProfileEditorAdvancedPanels";
import { GroupPicker, TagPicker } from "./ProfileEditorIdentityPickers";
import { profileStartUrlValidationError } from "./profileWorkbenchHelpers";
import { StartUrlCombobox } from "./StartUrlCombobox";
import { CreatableCombobox } from "../ui/CreatableCombobox";

/** The values CloakBrowser documents; anything else in the field is a custom search URL. */
const SEARCH_ENGINE_OPTIONS = ["google", "bing", "duckduckgo", "none"];

export function ProfileEditorRuntimeTab({
  boundExtensionIds,
  busy,
  draft,
  draftIsNew,
  extensions,
  groups,
  nameError,
  setDraft,
  setDraftExtensionBinding,
  tags,
  t,
}: {
  boundExtensionIds: string[];
  busy: string;
  draft: BrowserProfile;
  draftIsNew: boolean;
  extensions: ExtensionEntity[];
  groups: GroupEntity[];
  nameError: string;
  setDraft: (draft: BrowserProfile) => void;
  setDraftExtensionBinding: (extension: ExtensionEntity, bound: boolean) => Promise<void>;
  tags: TagEntity[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="editor-form">
      {/*
        Presets read as templates by shape, not by a caption: each card carries its own badge in the
        top-right corner. The badge sits out of the text flow there, so a card whose summary wraps to
        a second line keeps the title, the body and the card height aligned with its neighbours in the
        row instead of pushing the title down under a stacked badge.
      */}
      <section className="preset-panel wide" aria-label={t("form.profilePresets")}>
        <div className="preset-grid">
          {PROFILE_PRESETS.map((preset) => (
            <button className="preset-button" key={preset.id} onClick={() => setDraft(applyProfilePreset(draft, preset.id))} type="button">
              <span className="preset-badge">{t("form.profilePresetBadge")}</span>
              <strong>{preset.name}</strong>
              <span className="preset-summary">{preset.summary}</span>
            </button>
          ))}
        </div>
      </section>

      <FormSection title={t("editor.section.profileInfo")}>
        <Field label={t("form.profileName")} wide error={nameError}>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("placeholder.profileName")} />
        </Field>
        <Field label={t("table.group")} wide help={t("tips.group")}>
          <GroupPicker
            groups={groups}
            value={draft.group}
            onChange={(group) => setDraft({ ...draft, group })}
            t={t}
          />
        </Field>
        <Field label={t("table.tags")} wide help={t("tips.tags")}>
          <TagPicker
            tags={tags}
            value={draft.tags}
            onChange={(nextTags) => setDraft({ ...draft, tags: nextTags })}
            t={t}
          />
        </Field>
        <Field label={t("form.notes")} wide>
          <textarea rows={3} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder={t("placeholder.notes")} />
        </Field>
      </FormSection>

      <FormSection title={t("editor.section.runtime")}>
        <Field label={t("table.startUrl")} wide help={t("tips.startUrl")} error={profileStartUrlValidationError(draft, t)}>
          <StartUrlCombobox
            customLabel={t("form.startUrlCustom")}
            onChange={(startUrl) => setDraft({ ...draft, startUrl })}
            placeholder={t("placeholder.startUrl")}
            presetLabel={t("form.startUrlPreset")}
            value={draft.startUrl}
          />
        </Field>
        <Field label={t("table.mode")} help={t("tips.mode")}>
          <Segmented<ProfileMode>
            value={draft.mode}
            options={[
              { value: "persistent", label: t("mode.persistent") },
              { value: "ephemeral", label: t("mode.ephemeral") },
            ]}
            onChange={(mode) => setDraft({ ...draft, mode })}
          />
        </Field>
        {/*
          Portable cookies belong beside the mode that decides whether cookies are written to disk at
          all: the flag has to be on before the first write, so an ephemeral profile can never use it.
        */}
        <Field label={t("form.portableCookies")} help={t("tips.portableCookies")}>
          <BooleanSegmented
            disabled={draft.mode !== "persistent"}
            value={isPortableCookiesEnabled(draft)}
            onLabel={t("form.switchOn")}
            offLabel={t("form.switchOff")}
            onChange={(enabled) => setDraft(setPortableCookies(draft, enabled))}
          />
        </Field>
        <Field label={t("form.searchEngine")} help={t("tips.searchEngine")} wide>
          {/*
            A combo box, not a `<datalist>`: the native popup ignores every theme token and was the one
            dropdown in the editor that did not look like the others. `createLabel` is omitted on
            purpose — a custom search URL is an ordinary value, not a catalogue entry.
          */}
          <CreatableCombobox
            value={draft.runtime.searchEngine}
            options={SEARCH_ENGINE_OPTIONS}
            placeholder={t("placeholder.searchEngine")}
            emptyLabel={t("form.searchEngine")}
            createLabel={undefined}
            onChange={(searchEngine) => setDraft({ ...draft, runtime: { ...draft.runtime, searchEngine } })}
          />
        </Field>
        {/*
          Viewport, color scheme and watermark all decide what this launch looks like, so they share the
          launch section. The section names they used to sit under each held one or two rows once their
          neighbours moved here.
        */}
        <Field label={t("form.viewportMode")} help={t("tips.viewport")}>
          <Segmented<ViewportMode>
            value={draft.viewport.mode}
            options={[
              { value: "fixed", label: t("form.viewportFixed") },
              { value: "native", label: t("form.viewportNative") },
            ]}
            onChange={(mode) => setDraft({ ...draft, viewport: { ...draft.viewport, mode } })}
          />
        </Field>
        {/* The size only exists in fixed mode: native passes no viewport at all, so an editable pair
            there would suggest a window geometry that nothing reads. */}
        {draft.viewport.mode === "fixed" && (
          <Field label={t("form.windowSize")} help={t("tips.windowSize")}>
            <div className="inline-pair">
              <input
                min={320}
                type="number"
                value={draft.viewport.width}
                onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, width: Number(event.target.value) } })}
              />
              <input
                min={320}
                type="number"
                value={draft.viewport.height}
                onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, height: Number(event.target.value) } })}
              />
            </div>
          </Field>
        )}
        <Field label={t("form.colorMode")} help={t("tips.colorScheme")}>
          <Segmented<ColorScheme>
            value={draft.viewport.colorScheme}
            options={[
              { value: "light", label: t("settings.light") },
              { value: "dark", label: t("settings.dark") },
              { value: "no-preference", label: t("form.follow") },
            ]}
            onChange={(colorScheme) => setDraft({ ...draft, viewport: { ...draft.viewport, colorScheme } })}
          />
        </Field>
        <Field label={t("form.watermark")} help={t("tips.watermark")}>
          <Segmented<WatermarkStyle>
            value={draft.runtime.watermark}
            options={[
              { value: "off", label: t("watermark.off") },
              { value: "banner", label: t("watermark.banner") },
              { value: "enhanced", label: t("watermark.enhanced") },
            ]}
            onChange={(watermark) => setDraft({ ...draft, runtime: { ...draft.runtime, watermark } })}
          />
        </Field>
      </FormSection>

      {/*
        The extension surface is one block, not two: the library and the manual path list are both
        "extensions" to an operator, so an unsaved draft masks them together under one note. Splitting
        the mask would leave the second half of the same concept looking usable.
      */}
      <div className="extension-surface wide">
        <div className="extension-surface-content" inert={draftIsNew || undefined}>
          <ExtensionBindingPanel
            busy={busy}
            draft={draft}
            draftIsNew={draftIsNew}
            extensions={extensions}
            boundExtensionIds={boundExtensionIds}
            setDraftExtensionBinding={setDraftExtensionBinding}
            t={t}
          />
        </div>
        {draftIsNew && (
          <div className="extension-surface-mask" role="note">{t("editor.saveBeforeExtensionBinding")}</div>
        )}
      </div>
    </div>
  );
}
