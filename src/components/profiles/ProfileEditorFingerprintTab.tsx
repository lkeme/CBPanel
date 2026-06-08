import type { TranslationKey } from "../../i18n";
import { effectiveWebrtcIpMode, type BrowserProfile, type EffectiveWebrtcIpMode } from "../../shared/profile";
import { Field } from "../ui/form-controls";
import { FingerprintNoiseField, FingerprintPlatformField, GeoipLocaleFields, WebrtcFields } from "./ProfileEditorFingerprintFields";

export function ProfileEditorFingerprintTab({
  draft,
  setDraft,
  t,
}: {
  draft: BrowserProfile;
  setDraft: (draft: BrowserProfile) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const fp = draft.fingerprint;
  const geoipEnabled = draft.runtime.geoip;
  const hasGeoipExplicitOverride = Boolean(fp.timezone.trim() || fp.locale.trim());
  const geoipAutoDerived = geoipEnabled && !hasGeoipExplicitOverride;
  const effectiveWebrtcMode = effectiveWebrtcIpMode(draft);
  const webrtcIpInputValue = effectiveWebrtcInputValue(effectiveWebrtcMode, fp.webrtcIpValue);

  function updateWebrtcMode(webrtcIp: BrowserProfile["fingerprint"]["webrtcIp"]) {
    setDraft({
      ...draft,
      fingerprint: {
        ...fp,
        webrtcIp,
        webrtcIpValue: webrtcIp === "custom" ? fp.webrtcIpValue : "",
      },
    });
  }

  function clearGeoipOverrides() {
    setDraft({
      ...draft,
      fingerprint: {
        ...fp,
        timezone: "",
        locale: "",
      },
    });
  }

  return (
    <div className="form-grid two">
      <Field label="Seed">
        <input value={fp.seed} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, seed: event.target.value } })} placeholder={t("placeholder.seed")} />
      </Field>
      <FingerprintPlatformField draft={draft} fp={fp} setDraft={setDraft} t={t} />
      <Field label={t("form.screenSize")}>
        <div className="inline-pair">
          <input min={320} type="number" value={fp.screenWidth} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, screenWidth: Number(event.target.value) } })} />
          <input min={320} type="number" value={fp.screenHeight} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, screenHeight: Number(event.target.value) } })} />
        </div>
      </Field>
      <GeoipLocaleFields
        clearGeoipOverrides={clearGeoipOverrides}
        draft={draft}
        fp={fp}
        geoipAutoDerived={geoipAutoDerived}
        geoipEnabled={geoipEnabled}
        hasGeoipExplicitOverride={hasGeoipExplicitOverride}
        setDraft={setDraft}
        t={t}
      />
      <WebrtcFields
        draft={draft}
        fp={fp}
        setDraft={setDraft}
        t={t}
        updateWebrtcMode={updateWebrtcMode}
        effectiveWebrtcMode={effectiveWebrtcMode}
        webrtcIpInputValue={webrtcIpInputValue}
      />
      <Field label={t("form.hardwareConcurrency")}>
        <input value={fp.hardwareConcurrency} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, hardwareConcurrency: event.target.value } })} placeholder={t("placeholder.hardwareConcurrency")} />
      </Field>
      <Field label={t("form.deviceMemory")}>
        <input value={fp.deviceMemory} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, deviceMemory: event.target.value } })} placeholder={t("placeholder.deviceMemory")} />
      </Field>
      <Field label={t("form.brand")}>
        <input value={fp.brand} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, brand: event.target.value } })} placeholder={t("placeholder.brand")} />
      </Field>
      <Field label={t("form.brandVersion")}>
        <input value={fp.brandVersion} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, brandVersion: event.target.value } })} />
      </Field>
      <Field label={t("form.platformVersion")}>
        <input value={fp.platformVersion} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, platformVersion: event.target.value } })} />
      </Field>
      <Field label={t("form.location")}>
        <input value={fp.location} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, location: event.target.value } })} placeholder={t("placeholder.location")} />
      </Field>
      <FingerprintNoiseField draft={draft} fp={fp} setDraft={setDraft} t={t} />
    </div>
  );
}

function effectiveWebrtcInputValue(mode: EffectiveWebrtcIpMode, customValue: string): string {
  if (mode === "auto") return "auto";
  if (mode === "geoip") return "GeoIP";
  if (mode === "custom") return customValue;
  return "";
}
