import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import type { CloakBrowserDiagnosticsGeoIpResolved, CloakBrowserDiagnosticsLicense } from "../../shared/browserCore";
import type { ProxyEntity, SystemDiagnostics } from "../../shared/entities";
import type { StorageInfo } from "../../shared/settings";
import { TooltipProvider } from "../ui/tooltip";
import { SystemStatusContent } from "./SystemStatusContent";

/**
 * The launch-GeoIP block of the system diagnostics — CBPanel's `cloakbrowser info --proxy` surface.
 *
 * What is worth pinning here is the distinction between no requested resolution, a complete result,
 * and an error. CloakBrowser 0.5.10 no longer returns a partial launch result.
 */

// A proxy was never asked about, so nothing may claim otherwise — this is the state of every routine
// diagnostics load, which deliberately makes no network call.
test("no resolved payload means no exit IP block at all", () => {
  const html = renderPanel(undefined);

  assert.equal(hasRow(html, t("system.exitIp")), false);
  assert.equal(hasRow(html, t("system.timezone")), false);
  assert.equal(hasRow(html, t("system.locale")), false);
});

test("a resolved payload shows the exit IP, timezone and locale a launch would inject", () => {
  const html = renderPanel({ exitIp: "203.0.113.42", timezone: "Asia/Tokyo", locale: "ja-JP" });

  assert.ok(hasRow(html, t("system.exitIp")));
  assert.ok(html.includes("203.0.113.42"));
  assert.ok(html.includes("Asia/Tokyo"));
  assert.ok(html.includes("ja-JP"));
});

// Upstream keeps the key with null fields and prints `(unknown)` for each; the panel's equivalent is a
// dash per row. Rendering the block is what tells the operator the resolution ran.
test("a payload of nulls still renders the block, with dashes", () => {
  const html = renderPanel({});

  assert.ok(hasRow(html, t("system.exitIp")));
  assert.ok(hasRow(html, t("system.timezone")));
  assert.ok(hasRow(html, t("system.locale")));
});

test("wrapper seat diagnostics preserve a bounded count and limit", () => {
  const html = renderPanel(undefined, [proxy()], undefined, { tier: "team", sessions: { active: 2, limit: 5, state: "ok" } });

  assert.ok(html.includes("2/5"));
});

// An empty library leaves the picker with nothing to pick, so the action must not look available.
test("the resolve action is unavailable when the proxy library is empty", () => {
  const html = renderPanel(undefined, []);

  assert.ok(html.includes(t("system.geoipResolveProxy")));
  // The picker's own placeholder is the "do not resolve" option, never the first proxy in the library.
  assert.ok(html.includes(t("system.geoipNoProxySelected")));
  assert.equal(enabledButtonLabels(html).includes(t("system.geoipResolveProxy")), false);
});

// Nothing is selected by default even with a library present: resolving costs a live probe through a
// proxy, so it stays an explicit action.
test("the resolve action is unavailable until a proxy is selected", () => {
  const html = renderPanel(undefined);
  const enabled = enabledButtonLabels(html);

  // Guards the two negative assertions above and below: if the helper matched nothing at all they would
  // pass on an empty list regardless of what the panel rendered.
  assert.ok(enabled.includes(t("actions.refresh")), "expected the refresh action to read as enabled");
  assert.equal(enabled.includes(t("system.geoipResolveProxy")), false);
});

test("legacy source retirement evidence exposes both migrated records and issue totals", () => {
  const storage: StorageInfo = {
    kind: "sqlite",
    databasePath: "D:/data/cbpanel.sqlite",
    legacyJsonPath: "D:/data/profiles.json",
    extensionSourceRetirement: {
      migrationVersion: 1,
      completedAt: "2026-08-27T00:00:00.000Z",
      snapshotPath: "D:/data/migration-backups/before-extension-source-retirement.sqlite",
      migrated: 4,
      issues: 2,
    },
    portable: false,
    migratedFromJson: false,
  };
  const html = renderPanel(undefined, [proxy()], storage);

  assert.ok(hasRow(html, t("system.extensionSourceRetirementCount")));
  assert.ok(hasRow(html, t("system.extensionSourceRetirementIssues")));
  assert.ok(html.includes("before-extension-source-retirement.sqlite"));
});

function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}

/** A KeyValueList row, matched on its `<dt>` so a label that also appears inside a tooltip does not count. */
function hasRow(html: string, label: string): boolean {
  return html.includes(`<dt>${label}</dt>`);
}

function enabledButtonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attributes]) => !attributes.includes("disabled="))
    .map(([, , body]) => body.replace(/<[^>]*>/g, "").trim());
}

function renderPanel(
  resolved: CloakBrowserDiagnosticsGeoIpResolved | undefined,
  proxies: ProxyEntity[] = [proxy()],
  storage?: StorageInfo,
  license?: CloakBrowserDiagnosticsLicense,
): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(SystemStatusContent, {
        binaryInfo: null,
        busy: "",
        copyDiagnostics: async () => {},
        diagnostics: diagnostics(resolved, license),
        exportDiagnostics: () => {},
        proxies,
        pruneBrowserData: async () => {},
        refreshBinary: async () => {},
        refreshDiagnostics: async () => {},
        runtime: null,
        state: null,
        storage,
        t,
      }),
    ),
  );
}

function diagnostics(resolved: CloakBrowserDiagnosticsGeoIpResolved | undefined, license?: CloakBrowserDiagnosticsLicense): SystemDiagnostics {
  const base: SystemDiagnostics = {
    checkedAt: "2026-08-06T00:00:00.000Z",
    schemaVersion: 3,
    dataDir: "D:/data",
    databasePath: "D:/data/panel.db",
    portable: false,
    storage: { kind: "sqlite", migratedFromJson: false },
    sessions: { total: 0, running: 0, launching: 0, error: 0 },
    networkTrace: { providerId: "cloudflare-www", providerName: "Cloudflare", providerUrl: "https://example.test", timeoutSeconds: 8 },
    extensionCache: { directory: "D:/data/extensions", installedCount: 0 },
    browserCoreDiagnostics: {
      checkedAt: "2026-08-06T00:00:00.000Z",
      available: true,
      license,
      geoip: { dbPresent: false, path: "D:/data/cloakbrowser-cache/geoip/GeoLite2-City.mmdb", resolved },
    },
    recentErrors: [],
  };
  return base;
}

function proxy(): ProxyEntity {
  return {
    id: "proxy-1",
    name: "Tokyo exit",
    scheme: "http",
    host: "proxy.example.test",
    port: "8080",
    username: "",
    password: "",
    bypass: "",
    notes: "",
    status: "enabled",
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}
