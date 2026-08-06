import assert from "node:assert/strict";
import test from "node:test";

import { COUNTRY_LOCALE_MAP, LAUNCH_GEO_UNRESOLVED_REASONS, launchGeoUnresolvedReasonFrom, localeForCountryCode } from "./launchGeoip";

// The table is a verbatim mirror of upstream's, and its whole value is being identical to what a
// `geoip: true` launch injects. Locking the size makes an accidental half-merge on the next upstream
// sync fail here rather than silently reporting a locale the browser will not use.
test("the mirrored country/locale table has upstream's full coverage", () => {
  assert.equal(Object.keys(COUNTRY_LOCALE_MAP).length, 132);
});

test("country codes map to the locale upstream derives", () => {
  assert.equal(localeForCountryCode("US"), "en-US");
  assert.equal(localeForCountryCode("CN"), "zh-CN");
  assert.equal(localeForCountryCode("HK"), "zh-HK");
  assert.equal(localeForCountryCode("MO"), "zh-MO");
  // Not every country maps to its own language — LU exits speak French, MT English. A "derive the
  // locale from the country code" shortcut would get both wrong.
  assert.equal(localeForCountryCode("LU"), "fr-LU");
  assert.equal(localeForCountryCode("MT"), "en-MT");
});

// Upstream indexes the table with MaxMind's `country.iso_code`, which is always uppercase. CBPanel
// also feeds it values from trace providers, where the casing is not guaranteed, so one lookup
// normalizes instead of every caller guessing.
test("lookup normalizes casing and surrounding whitespace", () => {
  assert.equal(localeForCountryCode("us"), "en-US");
  assert.equal(localeForCountryCode(" Jp "), "ja-JP");
});

// Upstream returns null for an uncovered country and carries on with a null locale; the panel's
// equivalent is undefined, never a guessed fallback like "en-US".
test("an uncovered or absent country code resolves to nothing", () => {
  assert.equal(localeForCountryCode("ZZ"), undefined);
  assert.equal(localeForCountryCode(""), undefined);
  assert.equal(localeForCountryCode("   "), undefined);
  assert.equal(localeForCountryCode(undefined), undefined);
});

// The reason travels through the diagnostics payload as JSON, so it comes back as an unvalidated string.
// Deriving the validator from the same list as the type is what stops a newly added reason from being
// silently dropped on the way in.
test("every declared reason survives a round trip through the payload validator", () => {
  for (const reason of LAUNCH_GEO_UNRESOLVED_REASONS) {
    assert.equal(launchGeoUnresolvedReasonFrom(reason), reason);
  }
});

test("an unknown reason is rejected rather than passed through untranslatable", () => {
  assert.equal(launchGeoUnresolvedReasonFrom("something-new"), undefined);
  assert.equal(launchGeoUnresolvedReasonFrom(""), undefined);
  assert.equal(launchGeoUnresolvedReasonFrom(null), undefined);
  assert.equal(launchGeoUnresolvedReasonFrom(undefined), undefined);
  assert.equal(launchGeoUnresolvedReasonFrom(42), undefined);
});
