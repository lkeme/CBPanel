import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { TooltipProvider } from "../ui/tooltip";
import { UtlsPreferenceField, utlsInheritLabel } from "./XrayProxyFields";

// "Inherit global" was a dead end for an operator: the entry stores "", but the ClientHello actually sent is
// whatever Settings holds, which the editor never showed. Naming the inherited value on the option itself is
// the only place that resolution is visible without leaving the proxy editor.
test("the inherit option names the global fingerprint it currently resolves to", () => {
  const html = renderField({ globalUtls: "firefox", value: "" });

  assert.equal(triggerLabel(html), "继承全局（当前：firefox）");
});

// "auto" cannot be resolved here: the concrete ClientHello depends on the profile's brand, which the proxy
// editor — reachable from the library with no profile in scope — has no way to know.
test("a global auto is described rather than resolved on the inherit option", () => {
  const html = renderField({ globalUtls: "auto", value: "" });

  assert.equal(triggerLabel(html), "继承全局（当前：自动（跟随环境品牌））");
});

test("the inherit option stays plain when the global value is not supplied", () => {
  const html = renderField({ value: "" });

  assert.equal(triggerLabel(html), t("utls.inherit"));
});

// An explicit choice must not advertise the global value it overrides, and the helper behind the label is
// what both pickers read, so pin it directly too.
test("an explicit fingerprint keeps its own label", () => {
  const html = renderField({ globalUtls: "firefox", value: "qq" });

  assert.equal(triggerLabel(html), "qq");
  assert.equal(utlsInheritLabel("qq", "firefox", t), t("utls.inherit"));
});

function renderField({ globalUtls, value }: { globalUtls?: "auto" | "firefox"; value: "" | "qq" }): string {
  return renderToStaticMarkup(
    React.createElement(
      // Field's help tip is a Radix tooltip, which throws "must be used within TooltipProvider" under
      // renderToStaticMarkup exactly as in the browser.
      TooltipProvider,
      null,
      React.createElement(UtlsPreferenceField, { globalUtls, onChange: () => undefined, t, value }),
    ),
  );
}

/** The selected value on the SelectMenu trigger; the option list only exists while the menu is open. */
function triggerLabel(html: string): string {
  const label = html.match(/<strong>([^<]*)<\/strong>/)?.[1];
  assert.ok(label, "no select-menu trigger label");
  return label;
}

/** zh-CN is statically imported, so translate resolves synchronously and the assertions read as user-visible text. */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}
