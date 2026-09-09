import assert from "node:assert/strict";
import test from "node:test";
import { WATERMARK_STYLES, buildWatermarkScript, sanitizeWatermarkLabel } from "./watermark";
import { defaultProfile, mergeProfile, normalizeProfile, type BrowserProfile } from "./profile";

test("watermark styles stay limited to the three documented modes", () => {
  assert.deepEqual([...WATERMARK_STYLES], ["off", "banner", "enhanced"]);
});

test("off builds no script so callers can skip the injection API entirely", () => {
  assert.equal(buildWatermarkScript("QA", "off"), "");
  assert.equal(buildWatermarkScript("<script>alert(1)</script>", "off"), "");
});

test("sanitizeWatermarkLabel strips characters that could escape the textContent write", () => {
  assert.equal(sanitizeWatermarkLabel('<img src=x onerror="alert(1)">'), "img src=x onerror=alert(1)");
  assert.equal(sanitizeWatermarkLabel("A & B"), "A  B");
  assert.equal(sanitizeWatermarkLabel("  padded  "), "padded");
  assert.equal(sanitizeWatermarkLabel(""), "");
});

test("the script guards sub-frames and the three Google auth paths", () => {
  const script = buildWatermarkScript("QA", "banner");

  assert.match(script, /window\.self !== window\.top/);
  assert.match(script, /accounts\.google\.com/);
  assert.match(script, /accounts\.youtube\.com/);
  assert.match(script, /\/recaptcha\//);
  assert.match(script, /ancestorOrigins/);
  assert.match(script, /document\.referrer/);
  assert.match(script, /MutationObserver/);
});

test("banner renders a dismissible bar and enhanced a non-interactive badge", () => {
  const banner = buildWatermarkScript("QA", "banner");
  const enhanced = buildWatermarkScript("QA", "enhanced");

  assert.match(banner, /data-cbpanel-watermark-close/);
  assert.doesNotMatch(enhanced, /data-cbpanel-watermark-close/);
  assert.match(enhanced, /pointer-events:none/);
  assert.doesNotMatch(banner, /pointer-events:none/);
  assert.match(banner, /bottom:0/);
  assert.match(enhanced, /bottom:12px/);
});

test("the label is embedded as a JSON string literal, never as markup", () => {
  const script = buildWatermarkScript('<img src=x onerror="alert(1)">', "enhanced");

  assert.ok(script.includes(JSON.stringify("img src=x onerror=alert(1)")));
  assert.doesNotMatch(script, /<img/);
});

test("backslashes in a profile name stay inside the string literal", () => {
  const script = buildWatermarkScript("a\\b\"c", "banner");

  assert.ok(script.includes(JSON.stringify(sanitizeWatermarkLabel("a\\b\"c"))));
});

test("profiles default to the off watermark and normalize unknown values back to off", () => {
  assert.equal(defaultProfile().runtime.watermark, "off");

  const stored = defaultProfile();
  stored.runtime.watermark = "banner";
  assert.equal(normalizeProfile(stored).runtime.watermark, "banner");
  assert.equal(mergeProfile(stored, { name: "Renamed" }).runtime.watermark, "banner");

  // A stored row written before this field existed keeps working: mergeProfile fills the default.
  const legacyRuntime: Record<string, unknown> = { ...defaultProfile().runtime };
  delete legacyRuntime.watermark;
  const legacy = { ...defaultProfile(), runtime: legacyRuntime } as unknown as BrowserProfile;
  assert.equal(normalizeProfile(legacy).runtime.watermark, "off");

  const tampered = defaultProfile();
  (tampered.runtime as { watermark: string }).watermark = "fullscreen";
  assert.equal(normalizeProfile(tampered).runtime.watermark, "off");
});
