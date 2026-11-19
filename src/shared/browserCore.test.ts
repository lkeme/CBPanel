import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CORE_STARTUP_UPDATE_CHECK_TTL_MS,
  binaryPathOverrideFrom,
  browserCorePinIssue,
  shouldRunStartupBrowserCoreUpdateCheck,
  type BrowserCoreEnvRuntimeValue,
  type BrowserCoreUpdateCheck,
} from "./browserCore";

const BASE_TIME = Date.parse("2026-06-06T12:00:00.000Z");

test("the version editor distinguishes a Chromium version from a complete CloakBrowser build", () => {
  assert.equal(browserCorePinIssue("156.0.8078.47.1"), undefined);
  assert.equal(browserCorePinIssue(" 156.0.8078.47.2 "), undefined);
  assert.equal(browserCorePinIssue("156.0.8078.47"), "chromium-only");
  assert.equal(browserCorePinIssue(""), "required");
  for (const value of ["156.0.8078", "156.0.8078.47.1.2", "156.0.8078.47.-1", "156.0.8078.47.x", "156.0.8078.47.9007199254740992", "156/../../other"]) {
    assert.equal(browserCorePinIssue(value), "invalid", value);
  }
});

test("startup browser core update checks run when there is no prior result", () => {
  assert.equal(shouldRunStartupBrowserCoreUpdateCheck(undefined, BASE_TIME), true);
});

test("startup browser core update checks reuse recent results inside the TTL", () => {
  assert.equal(
    shouldRunStartupBrowserCoreUpdateCheck(updateAt(BASE_TIME - BROWSER_CORE_STARTUP_UPDATE_CHECK_TTL_MS + 1), BASE_TIME),
    false,
  );
});

test("startup browser core update checks run after the TTL expires", () => {
  assert.equal(
    shouldRunStartupBrowserCoreUpdateCheck(updateAt(BASE_TIME - BROWSER_CORE_STARTUP_UPDATE_CHECK_TTL_MS), BASE_TIME),
    true,
  );
});

test("startup browser core update checks run when the stored timestamp is invalid", () => {
  assert.equal(
    shouldRunStartupBrowserCoreUpdateCheck({ ...updateAt(BASE_TIME), checkedAt: "invalid-date" }, BASE_TIME),
    true,
  );
});

function updateAt(checkedAt: number): BrowserCoreUpdateCheck {
  return {
    checkedAt: new Date(checkedAt).toISOString(),
    currentVersion: "146.0.7680.177.5",
    updateAvailable: false,
  };
}

test("binaryPathOverrideFrom reports the path only while the override row is enabled", () => {
  function row(patch: Partial<BrowserCoreEnvRuntimeValue>): BrowserCoreEnvRuntimeValue {
    return {
      key: "CLOAKBROWSER_BINARY_PATH",
      label: "CLOAKBROWSER_BINARY_PATH",
      enabled: true,
      source: "settings",
      sensitive: false,
      valueKind: "path",
      requiresRuntimeRestart: false,
      ...patch,
    };
  }

  assert.equal(binaryPathOverrideFrom([row({ value: "D:/chrome/chrome.exe" })]), "D:/chrome/chrome.exe");
  assert.equal(binaryPathOverrideFrom([row({ value: "D:/private/chrome.exe", source: "cbpanel-default" })]), undefined);
  // A disabled row is what the panel shows for "configured but off" — it must not warn.
  assert.equal(binaryPathOverrideFrom([row({ value: "D:/chrome/chrome.exe", enabled: false })]), undefined);
  assert.equal(binaryPathOverrideFrom([row({ value: "   " })]), undefined);
  assert.equal(binaryPathOverrideFrom([row({ value: undefined })]), undefined);
  assert.equal(binaryPathOverrideFrom([]), undefined);
  assert.equal(
    binaryPathOverrideFrom([row({ key: "CLOAKBROWSER_CACHE_DIR", value: "D:/cache" })]),
    undefined,
  );
});
