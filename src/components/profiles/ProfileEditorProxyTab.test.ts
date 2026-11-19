import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile, setEnhancedProxy, type BrowserProfile } from "../../shared/profile";
import { TooltipProvider } from "../ui/tooltip";
import { ProfileEditorProxyTab } from "./ProfileEditorProxyTab";

/**
 * Enhanced proxy is a single row above the check panel, not a card: one switch does not need a heading,
 * a hint and a panel of its own.
 */
test("the proxy tab carries the enhanced proxy switch as a row", () => {
  const html = renderProxyTab(defaultProfile());

  assert.match(html, new RegExp(escapeRegExp(t("form.enhancedProxy"))));
  // The master switch rides at the right of the source row.
  assert.match(html, /proxy-source-row/);
  assert.match(html, new RegExp(`aria-label="${escapeRegExp(t("form.proxyEnabled"))}"`));
  // Without a proxy the switch is inert rather than absent.
  const enhancedSwitch = enhancedProxySwitchTag(html);
  assert.ok(enhancedSwitch.includes('disabled=""'), "the enhanced proxy switch is disabled without a proxy");
  // No card heading or per-panel hint is left over.
  assert.equal(html.includes(t("form.quickArgs")), false);
});

test("with a proxy configured the switch becomes usable", () => {
  const base = defaultProfile();
  const html = renderProxyTab(defaultProfile({
    proxy: { ...base.proxy, enabled: true, host: "proxy.example.test", port: "8080" },
  }));

  const switchTag = enhancedProxySwitchTag(html);
  assert.equal(switchTag.includes("disabled"), false);
});

/** The enhanced proxy switch, found by its label so the master enable switch cannot be mistaken for it. */
function enhancedProxySwitchTag(html: string): string {
  const labelId = html.match(new RegExp(`<span id="([^"]+)"[^>]*>\\s*${escapeRegExp(t("form.enhancedProxy"))}`))?.[1] ?? "";
  assert.ok(labelId, "the enhanced proxy row renders its label");
  return html.match(new RegExp(`<button[^>]*role="switch"[^>]*aria-labelledby="${labelId}"[^>]*>`))?.[0] ?? "";
}

// The mode's DNS behavior is fixed at the documented default (Cloudflare DoH through the proxy), so the
// row has one switch and no second input to keep aligned with it.
test("the enhanced proxy has no DNS input of its own", () => {
  const base = defaultProfile({ proxy: { ...defaultProfile().proxy, enabled: true, host: "proxy.example.test", port: "8080" } });
  const html = renderProxyTab(setEnhancedProxy(base, true));

  assert.match(html, new RegExp(escapeRegExp(t("form.enhancedProxy"))));
  assert.equal(/transparent-proxy-dns/.test(html), false);
});

// The URL field is typed text, not a projection of the parsed parts. Re-syncing it from `draft.proxy` on
// every change overwrote anything the parser could not represent — a half-typed host, a rejected scheme —
// so what it renders is the draft's own raw value, verbatim.
test("the proxy URL field renders the stored raw value verbatim", () => {
  const base = defaultProfile();
  const raw = "http://user:pass@proxy.example.test:8080";
  const html = renderProxyTab(defaultProfile({
    proxy: { ...base.proxy, enabled: true, raw, scheme: "http", host: "proxy.example.test", port: "8080", username: "user", password: "pass" },
  }));

  assert.match(html, new RegExp(`value="${escapeRegExp(raw)}"`));
});

function renderProxyTab(draft: BrowserProfile): string {
  const ignore = () => undefined;
  return renderToStaticMarkup(
    React.createElement(
      // The proxy fields use Radix tooltips for their help text, which need the provider under SSR.
      TooltipProvider,
      null,
      React.createElement(ProfileEditorProxyTab, {
        busy: "",
        checkProxy: async () => undefined,
        copyManagedProxyToLocal: ignore,
        draft,
        environments: [],
        localProxyDraftIds: new Set<string>(),
        locale: "zh-CN",
        proxies: [],
        proxyCheck: "",
        proxyLibraryDraftIds: {},
        resolveProxyGeoip: async () => undefined,
        saveDraftProxyToLibrary: async () => undefined,
        setDraft: ignore,
        setDraftProxyLibraryId: ignore,
        setDraftProxyLocal: ignore,
        t,
      }),
    ),
  );
}

/** zh-CN is statically imported, so translate resolves synchronously and the assertions read as user-visible text. */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
