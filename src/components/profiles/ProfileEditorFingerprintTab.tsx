import type { TranslationKey } from "../../i18n";
import type { BrowserProfile } from "../../shared/profile";
import { BooleanSegmented, Field, FormSection } from "../ui/form-controls";
import {
  FingerprintNoiseField,
  FingerprintPlatformField,
  GeoipLocaleFields,
  WebrtcFields,
} from "./ProfileEditorFingerprintFields";

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
  // The custom IP is the only value the launch reads from this field, so the input shows exactly that —
  // no derived "auto" / "GeoIP" text standing in for a value the profile does not hold.
  const webrtcIpInputValue = fp.webrtcIpValue;

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
    <div className="editor-form">
      <FormSection title={t("editor.section.fingerprintOptions")}>
        {/*
          Ordered by how often a value changes a launch: platform and GeoIP derive the rest, the two
          explicit overrides sit under the switch that writes them, WebRTC follows because GeoIP drives
          its exit IP, and the two per-page injections close the common block. The rarely edited
          overrides are grouped last under their own heading.
        */}
        <FingerprintPlatformField draft={draft} fp={fp} setDraft={setDraft} t={t} />
        <Field label={t("form.geoip")} help={t("tips.geoip")}>
          <BooleanSegmented
            value={draft.runtime.geoip}
            onLabel={t("form.switchOn")}
            offLabel={t("form.switchOff")}
            onChange={(geoip) => setDraft({ ...draft, runtime: { ...draft.runtime, geoip } })}
          />
        </Field>
        <GeoipLocaleFields
          clearGeoipOverrides={clearGeoipOverrides}
          draft={draft}
          fp={fp}
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
          webrtcIpInputValue={webrtcIpInputValue}
        />
        {/*
          Voices shaping and noise are the two per-page injections this panel adds on top of the seed:
          both default on and both touch every page, so they close the common block as a pair.
        */}
        <Field label={t("form.voices")} help={t("tips.voices")}>
          <BooleanSegmented
            value={draft.runtime.voices}
            onLabel={t("form.switchOn")}
            offLabel={t("form.switchOff")}
            onChange={(voices) => setDraft({ ...draft, runtime: { ...draft.runtime, voices } })}
          />
        </Field>
        <FingerprintNoiseField draft={draft} fp={fp} setDraft={setDraft} t={t} />

        <div className="form-group-heading wide">{t("editor.groupAdvanced")}</div>
        <Field label="User Agent" help={t("tips.userAgent")} wide>
          <input value={draft.viewport.userAgent} onChange={(event) => setDraft({ ...draft, viewport: { ...draft.viewport, userAgent: event.target.value } })} placeholder={t("placeholder.userAgent")} />
        </Field>
        <Field label={t("form.maxTouchPoints")} help={t("tips.maxTouchPoints")}>
          <input type="number" min={0} step={1} value={fp.maxTouchPoints} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, maxTouchPoints: event.target.value } })} placeholder="0" />
        </Field>
        <Field label={t("form.storageMb")} help={t("tips.storageQuota")}>
          <input inputMode="numeric" value={fp.storageQuotaMb} onChange={(event) => setDraft({ ...draft, fingerprint: { ...fp, storageQuotaMb: event.target.value } })} placeholder={t("placeholder.storageQuota")} />
        </Field>
      </FormSection>
    </div>
  );
}
