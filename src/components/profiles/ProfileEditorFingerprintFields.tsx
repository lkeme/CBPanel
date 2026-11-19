import type { TranslationKey } from "../../i18n";
import { type BrowserProfile } from "../../shared/profile";
import { BooleanSegmented, Field, Segmented } from "../ui/form-controls";

export function FingerprintPlatformField({
  draft,
  fp,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  fp: BrowserProfile["fingerprint"];
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <>
      <Field label={t("form.platform")}>
        <Segmented
          value={fp.platform}
          options={[
            { value: "auto", label: t("form.auto") },
            { value: "windows", label: "Win" },
            { value: "macos", label: "Mac" },
          ]}
          onChange={(platform) => setDraft({ ...draft, fingerprint: { ...fp, platform: platform as BrowserProfile["fingerprint"]["platform"] } })}
        />
      </Field>
      {fp.platform === "macos" && (
        <div className="result-line wide" role="note">{t("tips.macPersona")}</div>
      )}
    </>
  );
}

/** GeoIP writes both values, so the explicit overrides stay beside each other and keep one way back. */
export function GeoipLocaleFields({
  clearGeoipOverrides,
  draft,
  fp,
  geoipEnabled,
  hasGeoipExplicitOverride,
  setDraft,
  t,
}: {
  clearGeoipOverrides: () => void;
  draft: BrowserProfile;
  fp: BrowserProfile["fingerprint"];
  geoipEnabled: boolean;
  hasGeoipExplicitOverride: boolean;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  // Both inputs stay editable while GeoIP is on: an explicit timezone/locale is a supported
  // configuration, not a state that has to be unlocked first. The placeholder is a plain example in
  // every state — the "GeoIP can fill this" explanation lives in the field tooltip — and the notice
  // below appears only once a value is actually there, so it reads as an exit from the override.
  return (
    <>
      <Field label={t("form.timezone")} help={t("tips.timezoneGeoip")}>
        <input
          value={fp.timezone}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, timezone: event.target.value } })}
          placeholder={t("placeholder.timezone")}
        />
      </Field>
      <Field label={t("form.locale")} help={t("tips.localeGeoip")}>
        <input
          value={fp.locale}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, locale: event.target.value } })}
          placeholder={t("placeholder.locale")}
        />
      </Field>
      {geoipEnabled && hasGeoipExplicitOverride && (
        <div className="result-line warn wide">
          <span>{t("form.geoipExplicitOverride")}</span>
          <button className="command subtle compact" onClick={clearGeoipOverrides} type="button">
            {t("actions.clearGeoipOverride")}
          </button>
        </div>
      )}
    </>
  );
}

export function WebrtcFields({
  fp,
  setDraft,
  draft,
  t,
  updateWebrtcMode,
  webrtcIpInputValue,
}: {
  fp: BrowserProfile["fingerprint"];
  setDraft: (draft: BrowserProfile) => void;
  draft: BrowserProfile;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateWebrtcMode: (webrtcIp: BrowserProfile["fingerprint"]["webrtcIp"]) => void;
  webrtcIpInputValue: string;
}) {
  /*
    Three segments, three stored values — the control and the field say the same thing. The old fourth
    "跟随 GeoIP" segment was a read-out standing in for `off` plus GeoIP, which made a stored mode and
    a derived side effect look like two settings; `off` keeps meaning "emit no flag".

    The derived WebRTC address is described once, in the control's own help tip: what GeoIP injects,
    what `auto` needs, and which of the two wins are all facts about the same pair of fields, and a
    stack of notices under them repeated the tip while pushing the rest of the form down.
  */
  return (
    <>
      <Field label="WebRTC" help={t("tips.webrtcEffective")}>
        <Segmented
          value={fp.webrtcIp}
          options={[
            { value: "off", label: t("form.webrtcOff") },
            { value: "auto", label: t("form.auto") },
            { value: "custom", label: t("form.webrtcCustom") },
          ]}
          onChange={(value) => updateWebrtcMode(value as BrowserProfile["fingerprint"]["webrtcIp"])}
        />
      </Field>
      <Field label="WebRTC IP" help={t("tips.webrtcIp")}>
        <input
          disabled={fp.webrtcIp !== "custom"}
          value={webrtcIpInputValue}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, webrtcIpValue: event.target.value } })}
          placeholder={fp.webrtcIp === "custom" ? t("placeholder.webrtcIp") : ""}
        />
      </Field>
      {/* The one notice worth its own row: it describes a value the operator typed and nothing verifies. */}
      {fp.webrtcIp === "custom" && fp.webrtcIpValue.trim() && (
        <div className="result-line wide" role="note">{t("form.webrtcCustomHint")}</div>
      )}
    </>
  );
}

export function FingerprintNoiseField({
  draft,
  fp,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  fp: BrowserProfile["fingerprint"];
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <Field label={t("form.noise")} help={t("tips.noise")}>
      <BooleanSegmented
        value={fp.noise}
        onLabel={t("form.switchOn")}
        offLabel={t("form.switchOff")}
        onChange={(noise) => setDraft({ ...draft, fingerprint: { ...fp, noise } })}
      />
    </Field>
  );
}
