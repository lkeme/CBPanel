import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile, type BrowserProfile } from "../../shared/profile";
import { TooltipProvider } from "../ui/tooltip";
import { ProfileEditorFingerprintTab } from "./ProfileEditorFingerprintTab";

// GeoIP ships on, so a new profile reaches this tab with GeoIP enabled and both fields empty. Disabling the
// inputs while GeoIP was deriving their values turned that into a dead end: only a value re-enabled them,
// and a disabled input is precisely what stops one being typed — the sole way in was to switch GeoIP off,
// type, and switch it back on. An explicit value is a supported configuration (it wins over the
// derivation), so the controls stay live and the placeholder says where the effective value comes from
// while they are empty.
test("a new profile can type a timezone and locale while GeoIP is on", () => {
  const html = renderTab(defaultProfile());

  for (const label of ["form.timezone", "form.locale"] as const) {
    const input = inputForLabel(html, t(label));
    assert.match(input, new RegExp(escapeRegExp(t("placeholder.geoipAutoDerived"))), label);
    assert.doesNotMatch(input, /disabled/, label);
  }
});

// The reverse direction is what the notice below the pair is for, and it only appears once a value is
// actually there — so it is an exit from the override, never the way to get into one.
test("filled timezone and locale values keep a way back to the GeoIP derivation", () => {
  const html = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, timezone: "Asia/Shanghai", locale: "zh-CN" },
  }));

  assert.match(html, new RegExp(escapeRegExp(t("form.geoipExplicitOverride"))));
  assert.match(html, new RegExp(escapeRegExp(t("actions.clearGeoipOverride"))));
  // Nothing is being derived any more, so the placeholder that names GeoIP as the source is gone with it.
  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("placeholder.geoipAutoDerived"))));
});

test("GeoIP switched off leaves the plain format hints on both fields", () => {
  const html = renderTab(defaultProfile({ runtime: { ...defaultProfile().runtime, geoip: false } }));

  assert.match(inputForLabel(html, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.timezone"))));
  assert.match(inputForLabel(html, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.locale"))));
  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("form.geoipExplicitOverride"))));
});

// Typing into one of the two is the ordinary way in now that they are editable, so the half-filled state is
// the common one rather than a corner. GeoIP still derives the field that is empty — geoipCanProvideExitIp
// probes whenever *either* is blank — so a pair-wide "is GeoIP deriving these" flag mislabelled exactly the
// box GeoIP was still filling.
test("filling one of the pair leaves the other still labelled as derived by GeoIP", () => {
  const timezoneOnly = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, timezone: "Asia/Shanghai" },
  }));

  assert.match(inputForLabel(timezoneOnly, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.geoipAutoDerived"))));
  // The filled one stops claiming a derivation that no longer applies to it.
  assert.doesNotMatch(inputForLabel(timezoneOnly, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.geoipAutoDerived"))));
  // One explicit value is already an override, so the way back appears with the first of the two.
  assert.match(timezoneOnly, new RegExp(escapeRegExp(t("form.geoipExplicitOverride"))));

  const localeOnly = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, locale: "zh-CN" },
  }));

  assert.match(inputForLabel(localeOnly, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.geoipAutoDerived"))));
  assert.doesNotMatch(inputForLabel(localeOnly, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.geoipAutoDerived"))));
});

function renderTab(draft: BrowserProfile): string {
  return renderToStaticMarkup(
    React.createElement(
      // main.tsx wraps the whole app in one, and the Field help tips are Radix tooltips, which throw
      // "must be used within TooltipProvider" under renderToStaticMarkup exactly as in the browser.
      TooltipProvider,
      null,
      React.createElement(ProfileEditorFingerprintTab, { draft, setDraft: () => undefined, t }),
    ),
  );
}

/**
 * The `<input>` a Field's label points at, so an assertion is about the control a user sees under that
 * label rather than about any input in the document — and a label whose control went missing fails here
 * instead of passing an empty string to the next matcher.
 */
function inputForLabel(html: string, label: string): string {
  const controlId = html.match(new RegExp(`<label for="([^"]+)"[^>]*>${escapeRegExp(label)}</label>`))?.[1];
  assert.ok(controlId, `no field labelled ${label}`);
  const input = html.match(new RegExp(`<input[^>]*id="${escapeRegExp(controlId)}"[^>]*>`))?.[0];
  assert.ok(input, `no input for field ${label}`);
  return input;
}

/** zh-CN is statically imported, so translate resolves synchronously and the assertions read as user-visible text. */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
