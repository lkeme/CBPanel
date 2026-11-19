import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "../../i18n";
import { TooltipProvider } from "../ui/tooltip";
import { BrowserCoreLicenseIndicator } from "./BrowserCoreLicenseIndicator";

test("each documented plan retains its own identity and an unknown valid plan remains intact", () => {
  const icons = new Set<string>();
  for (const plan of ["free", "solo", "team", "business", "scale", "future-plan"]) {
    const html = renderToStaticMarkup(React.createElement(TooltipProvider, null,
      React.createElement(BrowserCoreLicenseIndicator, {
        license: { configured: true, active: true, valid: true, plan, checkedAt: "2026-11-06T00:00:00Z", expires: "not-a-date" },
        saving: false,
        t: (key, params) => translate("zh-CN", key, params),
      }),
    ));
    assert.ok(html.includes(`aria-label="许可证计划: ${plan}"`));
    assert.match(html, /data-license-state="valid"/);
    assert.doesNotMatch(html, />\s*(?:FREE|PRO|free|solo|team|business|scale)\s*</);
    icons.add(html.match(/<svg[^>]*class="([^"]*)"/)?.[1] ?? "");
  }
  assert.equal(icons.size, 6);
});

test("editing a saved key immediately suppresses the previous plan and its metadata", () => {
  const html = renderToStaticMarkup(React.createElement(TooltipProvider, null,
    React.createElement(BrowserCoreLicenseIndicator, {
      license: { configured: true, active: true, valid: true, plan: "team", checkedAt: "2026-11-06T00:00:00Z", expires: "2027-01-01" },
      saving: true,
      source: "previous key source",
      t: (key, params) => translate("zh-CN", key, params),
    }),
  ));
  assert.match(html, /data-license-state="saving"/);
  assert.match(html, /aria-busy="true"/);
  assert.equal(html.includes("team"), false);
  assert.equal(html.includes("previous key source"), false);
  assert.equal(html.includes("2027-01-01"), false);
  const unresolved = renderToStaticMarkup(React.createElement(TooltipProvider, null,
    React.createElement(BrowserCoreLicenseIndicator, { saving: false, t: (key, params) => translate("zh-CN", key, params) }),
  ));
  assert.match(unresolved, /data-license-state="validating"/);
});

test("missing keys and uninstalled cores are reflected by a warning in the input suffix", () => {
  for (const license of [{ configured: false, active: false }, { configured: true, active: true, valid: true, plan: "free" }]) {
    const html = renderToStaticMarkup(React.createElement(TooltipProvider, null,
      React.createElement(BrowserCoreLicenseIndicator, { license, installed: false, saving: false, t: (key, params) => translate("zh-CN", key, params) }),
    ));
    assert.match(html, /browser-core-license-indicator warning/);
    if (!license.active) assert.match(html, /lucide-circle-alert/);
  }
});
