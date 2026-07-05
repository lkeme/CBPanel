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
  geoipAutoDerived,
  geoipEnabled,
  hasGeoipExplicitOverride,
  setDraft,
  t,
}: {
  clearGeoipOverrides: () => void;
  draft: BrowserProfile;
  fp: BrowserProfile["fingerprint"];
  geoipAutoDerived: boolean;
  geoipEnabled: boolean;
  hasGeoipExplicitOverride: boolean;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <>
      <Field label={t("form.timezone")} help={t("tips.timezoneGeoip")}>
        <input
          disabled={geoipAutoDerived}
          value={fp.timezone}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, timezone: event.target.value } })}
          placeholder={geoipAutoDerived ? t("placeholder.geoipAutoDerived") : t("placeholder.timezone")}
        />
      </Field>
      <Field label={t("form.locale")} help={t("tips.localeGeoip")}>
        <input
          disabled={geoipAutoDerived}
          value={fp.locale}
          onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, locale: event.target.value } })}
          placeholder={geoipAutoDerived ? t("placeholder.geoipAutoDerived") : t("placeholder.locale")}
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
      {geoipAutoDerived && <div className="result-line wide">{t("form.geoipAutoDerived")}</div>}
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
