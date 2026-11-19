import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "../../i18n";
import { RuntimeCheckContent } from "./RuntimeCheckContent";
import type { BrowserCoreInfo } from "../../shared/browserCore";

test("an installed core with a missing or rejected key is not advertised as launchable", () => {
  for (const invalid of [false, true]) {
    const html = renderToStaticMarkup(React.createElement(RuntimeCheckContent, {
      binaryInfo: { installed: true, version: "156.0.8078.47", licenseRequired: !invalid, licenseValid: invalid ? false : undefined },
      browserCoreMissing: false,
      openBrowserCoreSettings: () => {},
      t: (key, params) => translate("zh-CN", key, params),
    }));
    assert.match(html, /runtime-check-hero missing/);
    assert.ok(html.includes(translate("zh-CN", invalid ? "browserCore.licenseInvalidShort" : "browserCore.licenseRequiredShort")));
    const state = translate("zh-CN", invalid ? "browserCore.licenseInvalidShort" : "browserCore.licenseRequiredShort");
    assert.equal(html.split(`>${state}<`).length - 1, 1);
    assert.ok(html.includes(translate("zh-CN", "browserCore.runtimeNotReady")));
    assert.ok(html.includes(translate("zh-CN", "browserCore.installedShort")));
    assert.equal(html.includes(translate("zh-CN", "browserCore.launchReady")), false);
    assert.equal(html.includes(translate("zh-CN", "browserCore.launchReadyDetail")), false);
  }
});

test("a private core without an official license is ready and never polls a license verdict", () => {
  const core = {
    channel: "private",
    licensePolicy: "not-applicable",
    license: { configured: false, active: true, valid: undefined },
    env: [],
  } as unknown as BrowserCoreInfo;
  const html = renderToStaticMarkup(React.createElement(RuntimeCheckContent, {
    binaryInfo: { installed: true, version: "156.0.8078.47.1", licenseRequired: true, licenseValid: false, core },
    browserCoreMissing: false,
    openBrowserCoreSettings: () => {},
    t: (key, params) => translate("zh-CN", key, params),
  }));
  assert.match(html, /runtime-check-hero ready/);
  assert.ok(html.includes(translate("zh-CN", "browserCore.launchReady")));
  assert.equal(html.includes(translate("zh-CN", "browserCore.licensePlanValidating")), false);
  assert.equal(html.includes(translate("zh-CN", "browserCore.licenseRequiredShort")), false);
});

test("an installed official offline core does not wait forever for an online license verdict", () => {
  const core = { channel: "official", channelMode: "offline", licensePolicy: "official", license: { configured: true, active: true }, env: [] } as unknown as BrowserCoreInfo;
  const html = renderToStaticMarkup(React.createElement(RuntimeCheckContent, {
    binaryInfo: { installed: true, version: "156.0.8078.47.1", licenseRequired: false, core },
    browserCoreMissing: false, openBrowserCoreSettings: () => {}, t: (key, params) => translate("zh-CN", key, params),
  }));
  assert.match(html, /runtime-check-hero ready/);
  assert.equal(html.includes(translate("zh-CN", "browserCore.licensePlanValidating")), false);
});

// The operation panel belongs to Settings → Kernel only. Rendering it here too made one download appear
// as two copies of the same progress, each polling on its own.
test("a running core operation is not mirrored on the runtime check page", () => {
  const core = {
    channel: "official",
    channelMode: "online",
    licensePolicy: "official",
    license: { configured: true, active: true, valid: true, plan: "solo" },
    env: [],
    operation: {
      id: "install-1",
      type: "install",
      status: "running",
      phase: "downloading",
      progress: { current: 40, total: 100, label: "Downloading CloakBrowser Chromium." },
      logs: [],
    },
  } as unknown as BrowserCoreInfo;
  const html = renderToStaticMarkup(React.createElement(RuntimeCheckContent, {
    binaryInfo: { installed: true, version: "156.0.8078.47.1", licenseRequired: false, core },
    browserCoreMissing: false, openBrowserCoreSettings: () => {}, t: (key, params) => translate("zh-CN", key, params),
  }));
  assert.equal(html.includes("operation-card"), false);
  assert.equal(html.includes(translate("zh-CN", "browserCore.operation")), false);
  assert.equal(html.includes("role=\"progressbar\""), false);
});
