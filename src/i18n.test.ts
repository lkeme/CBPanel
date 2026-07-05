import assert from "node:assert/strict";
import test from "node:test";
import { dictionaries, translate, type Locale } from "./i18n";

test("i18n dictionaries expose the same keys", () => {
  const locales = Object.keys(dictionaries) as Locale[];
  const [baseLocale, ...otherLocales] = locales;
  const baseKeys = Object.keys(dictionaries[baseLocale]).sort();

  for (const locale of otherLocales) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), baseKeys);
  }
});

test("translate interpolates named parameters", () => {
  assert.equal(translate("en-US", "table.selectProfile", { name: "QA" }), "Select QA");
  assert.equal(translate("zh-CN", "table.selectProfile", { name: "QA" }), "选择 QA");
});
