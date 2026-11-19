import assert from "node:assert/strict";
import test from "node:test";

import { translate, type TranslationKey } from "../i18n";
import { browserCoreErrorMessage, browserCoreUpdateErrorMessage, launchErrorMessage, profileErrorMessage, type ApiError } from "./apiClient";
import { normalizeSettings } from "../shared/settings";

// Upstream's own sentence, in English whatever the UI locale is. It is the only accurate account of why the
// core refused, so it has to survive into the toast — wrapped with where to act, not replaced by it.
const UPSTREAM_REASON = "Concurrent session limit reached (3 of 3 seats in use).";

test("license setup errors and incomplete updates use translated actionable messages", () => {
  for (const [code, key] of Object.entries({ BROWSER_CORE_LICENSE_REQUIRED: "error.browserCoreLicenseRequired", BROWSER_CORE_LICENSE_INVALID: "error.browserCoreLicenseInvalid", BROWSER_CORE_UPDATE_INCOMPLETE: "error.browserCoreUpdateIncomplete" })) {
    const error = Object.assign(new Error("Unlocalized server detail"), { code });
    assert.equal(browserCoreErrorMessage(error, t), t(key as TranslationKey));
    if (code !== "BROWSER_CORE_UPDATE_INCOMPLETE") assert.equal(launchErrorMessage(error, t), t(key as TranslationKey));
  }
});

test("update-check errors retain their code through storage and translate in the selected locale", () => {
  const update = { checkedAt: new Date().toISOString(), currentVersion: "", updateAvailable: false, error: "CloakBrowser license key is required.", errorCode: "BROWSER_CORE_LICENSE_REQUIRED" };
  const restored = normalizeSettings({ binary: { lastUpdateCheck: JSON.parse(JSON.stringify(update)) } }).binary.lastUpdateCheck!;
  assert.equal(browserCoreUpdateErrorMessage(restored, t), t("error.browserCoreLicenseRequired"));
  assert.equal(browserCoreUpdateErrorMessage({ ...restored, errorCode: "UNKNOWN" }, t), update.error);
});

test("private repository, credentials and integrity failures provide localized recovery messages", () => {
  for (const [code, key] of Object.entries({
    PRIVATE_REPOSITORY_INVALID: "error.privateRepositoryInvalid",
    PRIVATE_TOKEN_REQUIRED: "error.privateTokenRequired",
    PRIVATE_TOKEN_STORAGE_UNAVAILABLE: "error.privateTokenStorageUnavailable",
    PRIVATE_RELEASES_HTTP_ERROR: "error.privateReleasesHttp",
    PRIVATE_RELEASE_CHECKSUM_MISMATCH: "error.privateReleaseChecksumMismatch",
    PRIVATE_RELEASE_VERSION_MISMATCH: "error.privateReleaseVersionMismatch",
    PRIVATE_CORE_NOT_INSTALLED: "error.privateCoreNotInstalled",
    BROWSER_CORE_OFFLINE_MODE: "browserCore.offlineModeHint",
  })) {
    const message = browserCoreErrorMessage(Object.assign(new Error("Server-only detail"), { code }), t);
    assert.equal(message, t(key as TranslationKey));
    assert.notEqual(message, "Server-only detail");
  }
});

test("a licence denial keeps upstream's reason and adds where to fix it", () => {
  const denial: ApiError = Object.assign(new Error(UPSTREAM_REASON), { code: "BROWSER_CORE_LICENSE_DENIED" });

  const message = launchErrorMessage(denial, t);

  assert.ok(message.includes(UPSTREAM_REASON));
  assert.notEqual(message, UPSTREAM_REASON);
  assert.equal(message, t("toast.launchLicenseDenied", { reason: UPSTREAM_REASON }));
});

// An over-cap seat is not a key problem: pointing at the licence field sends the operator to a setting that
// is already correct, so the session-limit code carries its own guidance.
test("an over-cap licence denial points at the running sessions instead of the key", () => {
  const denial: ApiError = Object.assign(new Error(UPSTREAM_REASON), { code: "BROWSER_CORE_LICENSE_SESSION_LIMIT" });

  const message = launchErrorMessage(denial, t);

  assert.ok(message.includes(UPSTREAM_REASON));
  assert.equal(message, t("toast.launchLicenseSessionLimit", { reason: UPSTREAM_REASON }));
  assert.notEqual(message, t("toast.launchLicenseDenied", { reason: UPSTREAM_REASON }));
});

test("any other launch failure is shown as it stands", () => {
  const refusal = new Error("代理出口检测失败，已阻止启动");

  assert.equal(launchErrorMessage(refusal, t), "代理出口检测失败，已阻止启动");
});

// A code this build does not map must not lose the message it arrived with.
test("an unmapped code falls back to the error's own message", () => {
  const unmapped = Object.assign(new Error("内核未安装"), { code: "SOMETHING_NEW" });

  assert.equal(launchErrorMessage(unmapped, t), "内核未安装");
});

// Launching a brand-new draft saves it first, so the store's name 409 arrives on the launch path. Its body
// is a Chinese literal, which an en-US panel must never be shown. The launch map is still consulted first —
// the licence test above is what holds that order.
test("a launch that saves first translates the store's name conflict", () => {
  const conflict: ApiError = Object.assign(new Error("该名称被回收站中的环境占用，请改名或先清空回收站"), {
    code: "PROFILE_NAME_DUPLICATE_IN_TRASH",
  });

  assert.equal(launchErrorMessage(conflict, t), t("form.profileNameDuplicateInTrash"));
  assert.equal(launchErrorMessage(conflict, t), profileErrorMessage(conflict, t));
});

// The panel checks the same name rule before it sends, and throws an already-translated Error with no code.
// The fallback chain must hand that through untouched instead of mapping it to a generic sentence.
test("the panel's own validation message survives the whole fallback chain", () => {
  const local = new Error(t("form.profileNameDuplicate"));

  assert.equal(launchErrorMessage(local, t), t("form.profileNameDuplicate"));
  assert.equal(launchErrorMessage(new Error("起始网址无效"), t), "起始网址无效");
});

// zh-CN is the dictionary that is loaded from the start, so this asserts the mapping rather than the
// lazy-loading behaviour i18n.test.ts already covers.
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}
