import assert from "node:assert/strict";
import test from "node:test";
import {
  BROWSER_CORE_STARTUP_UPDATE_CHECK_TTL_MS,
  shouldRunStartupBrowserCoreUpdateCheck,
  type BrowserCoreUpdateCheck,
} from "./browserCore";

const BASE_TIME = Date.parse("2026-06-06T12:00:00.000Z");

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
