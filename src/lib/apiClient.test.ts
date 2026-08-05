import assert from "node:assert/strict";
import test from "node:test";

import { translate, type TranslationKey } from "../i18n";
import { launchErrorMessage, profileErrorMessage, type ApiError } from "./apiClient";

// Upstream's own sentence, in English whatever the UI locale is. It is the only accurate account of why the
// core refused, so it has to survive into the toast — wrapped with where to act, not replaced by it.
const UPSTREAM_REASON = "Concurrent session limit reached (3 of 3 seats in use).";

test("a licence denial keeps upstream's reason and adds where to fix it", () => {
  const denial: ApiError = Object.assign(new Error(UPSTREAM_REASON), { code: "BROWSER_CORE_LICENSE_DENIED" });

  const message = launchErrorMessage(denial, t);

  assert.ok(message.includes(UPSTREAM_REASON));
  assert.notEqual(message, UPSTREAM_REASON);
  assert.equal(message, t("toast.launchLicenseDenied", { reason: UPSTREAM_REASON }));
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
