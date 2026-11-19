import assert from "node:assert/strict";
import test from "node:test";
import { APP_BRAND, formatAppBrandLabel, formatAppTitle, formatAppVersionLabel, resolveAppVersions } from "./appVersion";

test("the version label lists the app before the wrapper and skips unknown halves", () => {
  assert.equal(formatAppVersionLabel({ wrapper: "0.7.0", app: "1.0.10" }), "1.0.10 | 0.7.0");
  assert.equal(formatAppVersionLabel({ app: "1.0.10" }), "1.0.10");
  assert.equal(formatAppVersionLabel({ wrapper: "0.7.0" }), "0.7.0");
  assert.equal(formatAppVersionLabel({}), "");
  assert.equal(formatAppVersionLabel(undefined), "");
});

test("the brand label carries the app version and leaves the wrapper out", () => {
  assert.equal(formatAppBrandLabel({ wrapper: "0.7.0", app: "1.0.10" }), `${APP_BRAND} 1.0.10`);
  assert.equal(formatAppBrandLabel({ wrapper: "0.7.0" }), APP_BRAND);
  assert.equal(formatAppBrandLabel(undefined), APP_BRAND);
});

test("the title reads brand, app version and wrapper in that order", () => {
  assert.equal(formatAppTitle({ wrapper: "0.7.0", app: "1.0.10" }), `${APP_BRAND} 1.0.10 | 0.7.0`);
  assert.equal(formatAppTitle({ app: "1.0.10" }), `${APP_BRAND} 1.0.10`);
  // A missing app version must not hand the wrapper's number to the brand slot.
  assert.equal(formatAppTitle({ wrapper: "0.7.0" }), `${APP_BRAND} | 0.7.0`);
  assert.equal(formatAppTitle(undefined), APP_BRAND);
});

test("each version half is taken from whichever source reports it", () => {
  assert.deepEqual(
    resolveAppVersions({ app: "1.0.10" }, { wrapper: "0.7.0", app: "9.9.9" }),
    { wrapper: "0.7.0", app: "1.0.10" },
  );
  assert.deepEqual(
    resolveAppVersions({ wrapper: "0.7.0", app: "1.0.10" }, undefined),
    { wrapper: "0.7.0", app: "1.0.10" },
  );
  assert.deepEqual(resolveAppVersions(undefined, undefined), { wrapper: undefined, app: undefined });
  assert.deepEqual(resolveAppVersions({}, {}), { wrapper: undefined, app: undefined });
});
