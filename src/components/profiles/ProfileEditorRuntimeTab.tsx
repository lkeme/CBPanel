import type { TranslationKey } from "../../i18n";
import {
  PROFILE_PRESETS,
  type BrowserProfile,
  type ColorScheme,
  type LauncherKind,
  type ProfileMode,
  type ViewportMode,
  applyProfilePreset,
} from "../../shared/profile";
import type { GroupEntity, TagEntity } from "../../shared/entities";
import { Field, FormSection, OptionControl, Segmented } from "../ui/form-controls";
import { Switch } from "../ui/switch";
import { GroupPicker, TagPicker } from "./ProfileEditorIdentityPickers";
import { profileStartUrlValidationError } from "./profileWorkbenchHelpers";
import { StartUrlCombobox } from "./StartUrlCombobox";

export function ProfileEditorRuntimeTab({
  draft,
  groups,
  nameError,
  setDraft,
  tags,
  t,
}: {
  draft: BrowserProfile;
  groups: GroupEntity[];
  nameError: string;
  setDraft: (draft: BrowserProfile) => void;
  tags: TagEntity[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="editor-form">
      <section className="preset-panel wide">
        <div className="preset-heading">
          <strong>{t("form.profilePresets")}</strong>
          <span>{t("form.profilePresetsHint")}</span>
        </div>
        <div className="preset-grid">
          {PROFILE_PRESETS.map((preset) => (
            <button className="preset-button" key={preset.id} onClick={() => setDraft(applyProfilePreset(draft, preset.id))} type="button">
              <strong>{preset.name}</strong>
              <span>{preset.summary}</span>
            </button>
          ))}
        </div>
      </section>
      <FormSection title={t("editor.section.identity")} description={t("tips.profileIdentity")}>
        <Field label={t("form.profileName")} wide error={nameError}>
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder={t("placeholder.profileName")} />
        </Field>
        <Field label={t("table.group")} wide>
          <GroupPicker
            groups={groups}
            value={draft.group}
            onChange={(group) => setDraft({ ...draft, group })}
            t={t}
          />
        </Field>
        <Field label={t("table.tags")} wide>
          <TagPicker
            tags={tags}
            value={draft.tags}
            onChange={(nextTags) => setDraft({ ...draft, tags: nextTags })}
            t={t}
          />
        </Field>
        <Field label={t("form.notes")} wide>
          <textarea rows={4} value={draft.notes} onChange={(event) => setDraft({ ...draft, notes: event.target.value })} placeholder={t("placeholder.notes")} />
        </Field>
      </FormSection>

      <FormSection title={t("editor.section.runtime")} description={t("tips.launcher")}>
        <Field label={t("table.startUrl")} wide help={t("tips.startUrl")} error={profileStartUrlValidationError(draft, t)}>
          <StartUrlCombobox
            customLabel={t("form.startUrlCustom")}
            onChange={(startUrl) => setDraft({ ...draft, startUrl })}
            placeholder={t("placeholder.startUrl")}
            presetLabel={t("form.startUrlPreset")}
            value={draft.startUrl}
          />
        </Field>
        <Field label={t("table.launcher")} wide help={t("tips.launcher")}>
          <Segmented<LauncherKind>
            value={draft.runtime.launcher}
            options={[
              { value: "playwright-context", label: "PW Context" },
              { value: "playwright-browser", label: "PW Browser" },
              { value: "puppeteer-browser", label: "Puppeteer" },
            ]}
            onChange={(launcher) => setDraft({ ...draft, runtime: { ...draft.runtime, launcher } })}
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
        <Field label={t("form.window")} help={t("tips.headless")}>
          <Segmented
            value={draft.runtime.headless ? "headless" : "headed"}
            options={[
              { value: "headed", label: t("form.windowHeaded") },
              { value: "headless", label: t("form.windowHeadless") },
            ]}
            onChange={(value) =>
              setDraft({
                ...draft,
                runtime: { ...draft.runtime, headless: value === "headless" },
              })
            }
          />
        </Field>
      </FormSection>

      <FormSection title={t("editor.section.viewport")} description={t("tips.viewport")}>
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
        <Field label={t("form.windowSize")}>
          <div className="inline-pair">
            <input
              min={320}
              type="number"
              disabled={draft.viewport.mode === "native"}
              value={draft.viewport.width}
              onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, width: Number(event.target.value) } })}
            />
            <input
              min={320}
              type="number"
              disabled={draft.viewport.mode === "native"}
              value={draft.viewport.height}
              onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, height: Number(event.target.value) } })}
            />
          </div>
        </Field>
        <Field label={t("form.colorMode")}>
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
      </FormSection>

      <FormSection title={t("editor.section.behavior")} description={t("tips.behavior")}>
        <OptionControl label={t("form.stealthArgs")} help={t("tips.stealthArgs")}>
          <Switch checked={draft.runtime.stealthArgs} className="toggle-switch" onCheckedChange={(stealthArgs) => setDraft({ ...draft, runtime: { ...draft.runtime, stealthArgs } })} />
        </OptionControl>
        <OptionControl label={t("form.geoip")} help={t("tips.geoip")}>
          <Switch
            checked={draft.runtime.geoip}
            className="toggle-switch"
            onCheckedChange={(geoip) =>
              setDraft({
                ...draft,
                runtime: { ...draft.runtime, geoip },
              })
            }
          />
        </OptionControl>
        <OptionControl label={t("form.humanize")} help={t("tips.humanize")}>
          <Switch checked={draft.runtime.humanize} className="toggle-switch" onCheckedChange={(humanize) => setDraft({ ...draft, runtime: { ...draft.runtime, humanize } })} />
        </OptionControl>
        <OptionControl label={t("form.humanPreset")} help={t("tips.humanPreset")}>
          <Segmented
            value={draft.runtime.humanPreset}
            options={[
              { value: "default", label: t("form.default") },
              { value: "careful", label: t("form.careful") },
            ]}
            onChange={(humanPreset) => setDraft({ ...draft, runtime: { ...draft.runtime, humanPreset } })}
          />
        </OptionControl>
      </FormSection>
    </div>
  );
}
