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
// derivation), so the controls stay live and the plain example placeholder stays on both regardless of
// what GeoIP is deriving; the tooltip, not the placeholder, carries the derivation wording.
test("a new profile can type a timezone and locale while GeoIP is on", () => {
  const html = renderTab(defaultProfile());

  for (const label of ["form.timezone", "form.locale"] as const) {
    const input = inputForLabel(html, t(label));
    assert.doesNotMatch(input, /disabled/, label);
  }
  assert.match(inputForLabel(html, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.timezone"))));
  assert.match(inputForLabel(html, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.locale"))));
});

// The reverse direction is what the notice below the pair is for, and it only appears once a value is
// actually there — so it is an exit from the override, never the way to get into one.
test("filled timezone and locale values keep a way back to the GeoIP derivation", () => {
  const html = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, timezone: "Asia/Shanghai", locale: "zh-CN" },
  }));

  assert.match(html, new RegExp(escapeRegExp(t("form.geoipExplicitOverride"))));
  assert.match(html, new RegExp(escapeRegExp(t("actions.clearGeoipOverride"))));
});

test("GeoIP switched off leaves the plain format hints on both fields", () => {
  const html = renderTab(defaultProfile({ runtime: { ...defaultProfile().runtime, geoip: false } }));

  assert.match(inputForLabel(html, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.timezone"))));
  assert.match(inputForLabel(html, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.locale"))));
  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("form.geoipExplicitOverride"))));
});

// Typing into one of the two is the ordinary way in now that they are editable, so the half-filled state is
// the common one rather than a corner. Both fields keep the plain example placeholder in every state, and
// the override notice appears as soon as either one holds a value.
test("filling one of the pair keeps both example placeholders and offers the way back", () => {
  const timezoneOnly = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, timezone: "Asia/Shanghai" },
  }));

  assert.match(inputForLabel(timezoneOnly, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.locale"))));
  assert.match(inputForLabel(timezoneOnly, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.timezone"))));
  // One explicit value is already an override, so the way back appears with the first of the two.
  assert.match(timezoneOnly, new RegExp(escapeRegExp(t("form.geoipExplicitOverride"))));

  const localeOnly = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, locale: "zh-CN" },
  }));

  assert.match(inputForLabel(localeOnly, t("form.timezone")), new RegExp(escapeRegExp(t("placeholder.timezone"))));
  assert.match(inputForLabel(localeOnly, t("form.locale")), new RegExp(escapeRegExp(t("placeholder.locale"))));
});

test("the seed-derived override fields are gone from the tab", () => {
  const html = renderTab(defaultProfile());
  for (const label of ["GPU 厂商", "屏幕宽高", "硬件线程", "内存 GB", "平台版本", "Taskbar PX", "手动覆盖（不推荐）", "高级指纹参数"]) {
    assert.equal(html.includes(`>${label}<`), false, label);
  }
});

// The folded "special cases and diagnostics" group is gone: its four controls are on the same page as
// everything else, with the rarely edited ones under a quiet "advanced" heading instead.
test("the rarely edited overrides sit under one heading instead of a fold", () => {
  const html = renderTab(defaultProfile());
  const headingIndex = html.indexOf(`<div class="form-group-heading wide">${t("editor.groupAdvanced")}</div>`);
  assert.ok(headingIndex > 0, "the advanced heading is rendered");
  assert.equal(html.includes("<details"), false);
  for (const label of ["User Agent", t("form.maxTouchPoints"), t("form.storageMb")]) {
    assert.ok(html.indexOf(label) > headingIndex, `${label} belongs under the advanced heading`);
  }
  // The everyday controls stay above it.
  for (const label of [t("form.platform"), t("form.geoip"), t("form.timezone"), t("form.locale"), "WebRTC", t("form.voices"), t("form.noise")]) {
    assert.ok(html.indexOf(label) < headingIndex, `${label} belongs above the advanced heading`);
  }
});

// Voices used to appear twice, once in the common block and once inside the fold, bound to the same
// field. With the fold gone there must be exactly one control. The tooltip text also names the list, so
// the count is of the label element itself.
test("the voice list is rendered once", () => {
  const html = renderTab(defaultProfile());
  const occurrences = html.split(`>${t("form.voices")}<`).length - 1;
  assert.equal(occurrences, 1);
});

// The WebRTC control used to carry a fourth "Follow GeoIP" segment that was not a stored value: it
// stood in for `off` plus GeoIP, so the segmented control disagreed with the field it edited and the
// same state had two names. The control now has exactly the three stored modes, and every derived
// state is a sentence under the pair instead.
test("the WebRTC segment offers only the stored modes", () => {
  const geoipDerived = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, timezone: "", locale: "" },
    runtime: { ...defaultProfile().runtime, geoip: true },
  }));

  for (const label of ["form.webrtcOff", "form.auto", "form.webrtcCustom"] as const) {
    assert.match(geoipDerived, new RegExp(escapeRegExp(`>${t(label)}</button>`)), label);
  }
  assert.doesNotMatch(geoipDerived, /跟随 GeoIP<\/button>/, "the synthetic GeoIP segment is gone");
});

// What GeoIP injects, what `auto` needs and which one wins are facts about the same pair of fields, so
// they live in the control's help tip instead of a stack of notices that pushed the rest of the form
// down. None of the three derived-state notices is rendered any more.
test("the derived WebRTC states are explained by the tip, not by notices", () => {
  const geoipDerived = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, webrtcIp: "auto", timezone: "", locale: "" },
    runtime: { ...defaultProfile().runtime, geoip: true },
  }));
  const autoWithoutProxy = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, webrtcIp: "auto" },
    runtime: { ...defaultProfile().runtime, geoip: false },
  }));

  for (const html of [geoipDerived, autoWithoutProxy]) {
    assert.doesNotMatch(html, /<div class="result-line wide" role="note">/, "no derived-state notice");
    // The tip is attached to the WebRTC control, so the facts are one hover away rather than gone.
    const tip = t("tips.webrtcEffective");
    assert.ok(html.includes(tip), "the WebRTC help tip carries the derived rules");
  }
  // The tip names both rules the notices used to carry.
  assert.match(t("tips.webrtcEffective"), /移除/);
  assert.match(t("tips.webrtcEffective"), /优先于 auto/);
});

// The IP input shows the stored custom value and nothing else: the old derived "auto" / "GeoIP" text
// put a string in the field that no launch ever reads.
test("the WebRTC IP input is empty unless a custom value is stored", () => {
  const auto = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, webrtcIp: "auto" },
  }));
  assert.equal(inputForLabel(auto, t("form.webrtcIp")).includes('value="auto"'), false);

  const custom = renderTab(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, webrtcIp: "custom", webrtcIpValue: "203.0.113.9" },
  }));
  assert.match(inputForLabel(custom, t("form.webrtcIp")), /value="203\.0\.113\.9"/);
  assert.match(custom, new RegExp(escapeRegExp(t("form.webrtcCustomHint"))));
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
