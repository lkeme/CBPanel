import assert from "node:assert/strict";
import test from "node:test";
import { ensureLocaleReady, isLocaleReady, translate } from "./i18n";
import { zhCN } from "./locales/zh-CN";
import { enUS } from "./locales/en-US";

test("i18n dictionaries expose the same keys in the same order", () => {
  const zhKeys = Object.keys(zhCN);
  const enKeys = Object.keys(enUS);

  assert.deepEqual([...enKeys].sort(), [...zhKeys].sort());
  assert.deepEqual(enKeys, zhKeys);
});

test("translate falls back to zh-CN until the locale dictionary is loaded", async () => {
  assert.equal(isLocaleReady("zh-CN"), true);
  assert.equal(isLocaleReady("en-US"), false);
  assert.equal(translate("en-US", "table.selectProfile", { name: "QA" }), "选择 QA");

  await ensureLocaleReady("en-US");

  assert.equal(isLocaleReady("en-US"), true);
  assert.equal(translate("en-US", "table.selectProfile", { name: "QA" }), "Select QA");
});

test("translate interpolates named parameters", async () => {
  await ensureLocaleReady("en-US");

  assert.equal(translate("en-US", "table.selectProfile", { name: "QA" }), "Select QA");
  assert.equal(translate("zh-CN", "table.selectProfile", { name: "QA" }), "选择 QA");
});

test("translate picks the English singular form when the quantity is one", async () => {
  await ensureLocaleReady("en-US");

  assert.equal(translate("en-US", "module.groupSummaryTotal", { total: 1 }), "1 group");
  assert.equal(translate("en-US", "module.groupSummaryTotal", { total: 0 }), "0 groups");
  assert.equal(translate("en-US", "module.groupSummaryTotal", { total: 7 }), "7 groups");
  // `count` wins over `total` so a filtered summary pluralizes on the collection size.
  assert.equal(translate("en-US", "module.proxySummaryFiltered", { shown: 1, total: 5 }), "Showing 1 of 5 proxies");
  assert.equal(translate("en-US", "module.proxySummaryFiltered", { shown: 1, total: 1 }), "Showing 1 of 1 proxy");
  assert.equal(translate("en-US", "module.profileCount", { count: 1 }), "1 profile");
  assert.equal(translate("en-US", "module.profileCount", { count: 2 }), "2 profiles");
});

test("zh-CN needs no plural forms, so its templates carry no separator", () => {
  const withSeparator = Object.entries(zhCN).filter(([, value]) => value.includes("||"));

  assert.deepEqual(withSeparator, []);
  assert.equal(translate("zh-CN", "module.groupSummaryTotal", { total: 1 }), "共 1 个分组");
});

test("every plural template declares both forms and keeps the same placeholders", async () => {
  await ensureLocaleReady("en-US");
  const plurals = Object.entries(enUS).filter(([, value]) => value.includes("||"));

  assert.ok(plurals.length > 0, "expected en-US to declare plural templates");
  for (const [key, value] of plurals) {
    const forms = value.split("||");
    assert.equal(forms.length, 2, `${key} must declare exactly one singular and one plural form`);
    for (const form of forms) {
      assert.notEqual(form.trim(), "", `${key} has an empty plural form`);
    }
    const placeholders = (form: string) => [...form.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    assert.deepEqual(placeholders(forms[0]), placeholders(forms[1]), `${key} forms use different placeholders`);
    // Without a driver the selector falls back to the plural form, which would be a silent bug.
    assert.ok(
      placeholders(forms[0]).includes("count") || placeholders(forms[0]).includes("total"),
      `${key} is a plural template but has no count/total placeholder to drive the choice`,
    );
  }
});

// Each of these messages reports several quantities, and selectPluralForm chooses a form from one of them
// (`count`). A sentence agreeing with `count` therefore read "1 environment permanently deleted, 1
// browser-data dirs removed, 0 warnings" — two nouns disagreeing with their own number. The fix is the
// wording, not the mechanism: counted labels are neutral for every combination, which is what declaring no
// plural form means here.
test("the multi-quantity cleanup messages carry no count-driven plural form", async () => {
  await ensureLocaleReady("en-US");

  for (const key of ["toast.trashCleared", "toast.browserDataPruned"] as const) {
    assert.doesNotMatch(enUS[key], /\|\|/, key);
  }
  assert.equal(
    translate("en-US", "toast.trashCleared", { count: 1, dataRemoved: 1, warnings: 0 }),
    "Environments permanently deleted: 1, browser-data directories removed: 1, warnings: 0",
  );
});

// The row count alone is what hid the bug these messages exist to report: trash rows were deleted while
// `browser-data/<id>` stayed on disk. Both locales must keep naming the directory count and the warnings —
// nothing else fails if a copy edit drops a placeholder, the report just goes quiet.
test("the environment data cleanup messages report directories and warnings in both locales", () => {
  for (const dictionary of [zhCN, enUS]) {
    assert.match(dictionary["toast.trashCleared"], /\{dataRemoved\}/);
    assert.match(dictionary["toast.trashCleared"], /\{warnings\}/);
    assert.match(dictionary["toast.browserDataPruned"], /\{count\}/);
    assert.match(dictionary["toast.browserDataPruned"], /\{warnings\}/);
    assert.match(dictionary["toast.environmentDataWarning"], /\{message\}/);
  }
});
