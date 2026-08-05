import type { TranslationKey } from "../../i18n";
import type { BrowserProfile, EffectiveWebrtcIpMode, FingerprintPlatform } from "../../shared/profile";
import { Field, Segmented } from "../ui/form-controls";
import { Switch } from "../ui/switch";

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
    <Field label={t("form.platform")}>
      <Segmented<FingerprintPlatform>
        value={fp.platform}
        options={[
          { value: "auto", label: t("form.auto") },
          { value: "windows", label: "Win" },
          { value: "macos", label: "Mac" },
          { value: "linux", label: "Linux" },
        ]}
        onChange={(platform) => setDraft({ ...draft, fingerprint: { ...fp, platform } })}
      />
    </Field>
  );
}

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
  // Per field, not per pair: geoipCanProvideExitIp (src/shared/profile.ts) probes the exit whenever
  // *either* of the two is empty, so filling the timezone leaves the locale derived exactly as before.
  // A pair-wide flag switched the still-empty locale box back to its plain format hint the moment a
  // timezone was typed, which reads as "nothing is filling this" about the one field GeoIP is still
  // filling — and typing into one of the two is now the ordinary way in, so that state is easy to reach.
  const timezoneAutoDerived = geoipEnabled && !fp.timezone.trim();
  const localeAutoDerived = geoipEnabled && !fp.locale.trim();
  return (
    <>
      {/*
        Both inputs stay editable while GeoIP is on. An explicit timezone/locale is not an illegal state
        that has to be unlocked first: buildLaunchPreview forwards whichever of the two is non-empty
        alongside geoip=true, and CloakBrowser lets the explicit value win over the derived one. Gating
        them on "GeoIP is deriving this" deadlocked a new profile now that GeoIP ships on — the fields
        were empty, so they were disabled, and only a value could have re-enabled them. The placeholder
        names GeoIP as the source while a field is empty, the label tooltip keeps the full docs wording,
        and the line below explains and undoes the override once a value is actually there.
      */}
      <Field label={t("form.timezone")} help={t("tips.timezoneGeoip")}>
        <input
          value={fp.timezone}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, timezone: event.target.value } })}
          placeholder={timezoneAutoDerived ? t("placeholder.geoipAutoDerived") : t("placeholder.timezone")}
        />
      </Field>
      <Field label={t("form.locale")} help={t("tips.localeGeoip")}>
        <input
          value={fp.locale}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, locale: event.target.value } })}
          placeholder={localeAutoDerived ? t("placeholder.geoipAutoDerived") : t("placeholder.locale")}
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
  effectiveWebrtcMode,
  webrtcIpInputValue,
}: {
  fp: BrowserProfile["fingerprint"];
  setDraft: (draft: BrowserProfile) => void;
  draft: BrowserProfile;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateWebrtcMode: (webrtcIp: BrowserProfile["fingerprint"]["webrtcIp"]) => void;
  effectiveWebrtcMode: EffectiveWebrtcIpMode;
  webrtcIpInputValue: string;
}) {
  return (
    <>
      <Field label="WebRTC">
        <Segmented
          value={fp.webrtcIp}
          options={[
            { value: "off", label: t("form.webrtcOff") },
            { value: "auto", label: t("form.auto") },
            { value: "custom", label: t("form.webrtcCustom") },
          ]}
          onChange={updateWebrtcMode}
        />
      </Field>
      <Field label="WebRTC IP" help={t("tips.webrtcIp")}>
        <input
          disabled={fp.webrtcIp !== "custom"}
          value={webrtcIpInputValue}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, webrtcIpValue: event.target.value } })}
          placeholder={effectiveWebrtcMode === "auto" ? "auto" : effectiveWebrtcMode === "geoip" ? "GeoIP" : t("placeholder.webrtcIp")}
        />
      </Field>
      {effectiveWebrtcMode === "geoip" && <div className="result-line wide">{t("form.webrtcGeoipEffective")}</div>}
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
    <Field label={t("form.noise")}>
      <div className="switch-field-row">
        <Switch checked={fp.noise} className="toggle-switch" onCheckedChange={(noise) => setDraft({ ...draft, fingerprint: { ...fp, noise } })} />
      </div>
    </Field>
  );
}
