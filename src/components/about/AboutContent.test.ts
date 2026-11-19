import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type Locale, type TranslationKey } from "../../i18n";
import { ABOUT_LINKS, openSidecarEndpoint } from "../../lib/aboutExternalNavigation";
import type { BinaryInfo } from "../../shared/browserCore";
import type { SystemDiagnostics } from "../../shared/entities";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";
import { AboutContent, type AboutContentProps } from "./AboutContent";

/**
 * The About page answers three questions: which build this is, what machine it runs on, and where its
 * data lives. Two contracts matter here because both regress silently:
 *
 * - The page carries no duplicated identity. The brand name, the versions and the distribution form
 *   each appear once — in the hero — and never again in the cards or the footer.
 * - A control that cannot act is disabled rather than hidden, so a web build still shows where the
 *   desktop-only action lives and why it is unavailable.
 */

const t = (key: TranslationKey): string => translate("zh-CN", key);
const tp = (key: TranslationKey, params: Record<string, string | number>): string => translate("zh-CN", key, params);

test("the hero names the build, its versions and the sidecar endpoint once", () => {
  const html = renderPanel();

  assert.ok(html.includes("CBPanel"));
  assert.ok(html.includes("1.0.10"));
  assert.ok(html.includes("0.7.0"));
  assert.ok(html.includes(t("about.sidecar")));
  assert.ok(html.includes("127.0.0.1:43210"));
});

test("the hero no longer reports a license requirement it cannot act on", () => {
  const html = renderPanel();

  for (const gone of ["需要许可证", "密钥无效"]) {
    assert.equal(html.includes(gone), false, `expected no "${gone}" badge`);
  }
});

test("there is no whole-page refresh control", () => {
  const html = renderPanel();

  assert.equal(enabledButtonLabels(html).includes(t("actions.refresh")), false);
});

test("Chromium is gone from the hero while the four at-a-glance chips remain", () => {
  const html = renderPanel();

  assert.equal(html.includes("Chromium"), false);
  for (const label of [t("about.summary.platform"), t("about.summary.distribution"), t("about.summary.architecture"), t("about.summary.channel")]) {
    assert.ok(html.includes(label));
  }
});

// The cards were the source of the duplication: runtime rows repeated the hero, and the core, runtime
// and GeoIP cards reported operational state that belongs to Settings → Core and Settings → Network.
test("only storage and support cards remain", () => {
  const html = renderPanel();

  // Literal titles, because these keys no longer exist: the cards were removed, not renamed.
  for (const gone of ["运行环境", "浏览器内核", "运行时状态", "GeoIP"]) {
    assert.equal(sectionTitles(html).includes(gone), false, `expected no "${gone}" card`);
  }
  assert.ok(sectionTitles(html).includes(t("about.storage")));
  assert.ok(sectionTitles(html).includes(t("about.support")));
});

test("the storage card shows the data directory only, with the folder action in place of a copy button", () => {
  const html = renderPanel();

  assert.ok(html.includes("D:/data"));
  // Removed rows, named literally: the database lives inside the directory shown above, and the
  // extension-cache count and portable flag repeat what the hero already reports.
  for (const gone of ["数据库", "扩展缓存", "便携数据目录"]) {
    assert.equal(html.includes(gone), false, `expected no "${gone}" row`);
  }
  assert.ok(html.includes(`aria-label="${t("about.openDataDirectory")}"`));
  assert.equal(html.includes(`aria-label="${t("actions.copy")}"`), false);
});

test("the support card links to the issue tracker", () => {
  const html = renderPanel();

  assert.ok(html.includes(t("about.issues")));
  // The destination stays out of the rendered label; it is only reachable through the whitelist.
  assert.equal(html.includes("github.com"), false);
});

test("the footer carries only the copyright and the two licence chips", () => {
  const html = renderPanel();
  const footer = html.slice(html.indexOf('class="about-footer"'));

  // The brand mark, the brand name and the version label belong to the hero; the footer repeated all three.
  assert.equal(footer.includes("about-footer-mark"), false);
  assert.equal(footer.includes("1.0.10"), false);
  assert.equal(footer.includes("app-icon-mark"), false);
  assert.ok(footer.includes("MIT License"));
  assert.ok(footer.includes(t("about.thirdParty")));
  assert.ok(footer.includes("©"));
});

test("no card ends in an explanatory sentence", () => {
  const html = renderPanel();
  const notes = [...html.matchAll(/class="about-note"[^>]*>([^<]*)</g)].map((match) => match[1]);

  // Every trailing description was removed, including the recent-errors empty state: a card either has
  // content or renders nothing below its actions.
  assert.deepEqual(notes, []);
});

test("an empty recent-errors list renders nothing at all", () => {
  const html = renderPanel();

  assert.equal(html.includes(t("system.recentErrors")), false);
});

test("the folder action is disabled in a web build, where there is no directory to reveal", () => {
  const html = renderPanel();

  assert.match(html, new RegExp(`aria-label="${escapeRegExp(t("about.openDataDirectory"))}"[^>]*disabled`));
});

// The two shells have different targets: the desktop build opens its loopback sidecar through a shell
// command, the web build opens the origin it is already served from.
test("the sidecar endpoint opens the origin on the web and a validated port on the desktop", async () => {
  const calls: Array<[string, unknown]> = [];
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { origin: "http://127.0.0.1:4173" },
        open: (...args: unknown[]) => {
          calls.push(["open", args[0]]);
          return null;
        },
        __TAURI_INTERNALS__: {
          invoke: async (...args: unknown[]) => {
            calls.push(["invoke", args[0]]);
          },
        },
      },
    });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    await openSidecarEndpoint(43210);
    assert.deepEqual(calls, [["open", "http://127.0.0.1:4173"]]);

    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    await openSidecarEndpoint(43210);
    // An unbound sidecar has no address: nothing is opened rather than a wrong port.
    await openSidecarEndpoint(0);
    await openSidecarEndpoint(undefined);
    assert.deepEqual(calls, [["open", "http://127.0.0.1:4173"], ["invoke", "cbpanel_open_sidecar_endpoint"]]);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

test("every outbound link the page can reach is on the whitelist", () => {
  assert.deepEqual(Object.keys(ABOUT_LINKS).sort(), ["issues", "license", "releases", "repository", "upstream"]);
  assert.ok(ABOUT_LINKS.issues.endsWith("/issues"));
});

test("the update card before any check offers only the check and the release page", () => {
  const html = renderPanel();

  assert.ok(sectionTitles(html).includes(t("about.update.title")));
  assert.equal(html.includes(t("about.update.download")), false, "nothing to download before a check");
  assert.ok(html.includes(t("about.update.check")));
  assert.ok(html.includes(t("about.update.releasePage")));
});

test("an available update adds the download action and names the version", () => {
  const html = renderPanel({
    appUpdate: {
      check: {
        attemptedAt: "2026-11-19T12:00:00.000Z",
        checkedAt: "2026-11-19T12:00:00.000Z",
        currentVersion: "1.0.10",
        latestVersion: "1.0.11",
        updateAvailable: true,
        download: {
          kind: "windows-installer",
          fileName: "CBPanel_1.0.11_x64-setup.exe",
          url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe",
        },
      },
    },
  });

  assert.ok(html.includes(tp("about.update.available", { version: "1.0.11" })));
  assert.ok(html.includes(t("about.update.download")));
  assert.ok(html.includes("1.0.11"));
});

test("an update with no artifact for this platform keeps the release page and drops the download", () => {
  const html = renderPanel({
    appUpdate: {
      check: {
        attemptedAt: "2026-11-19T12:00:00.000Z",
        currentVersion: "1.0.10",
        latestVersion: "1.0.11",
        updateAvailable: true,
      },
    },
  });

  assert.equal(html.includes(t("about.update.download")), false);
  assert.ok(html.includes(t("about.update.releasePage")));
});

test("an up-to-date check says nothing beyond the versions and offers no download", () => {
  const html = renderPanel({
    appUpdate: {
      check: {
        attemptedAt: "2026-11-19T12:00:00.000Z",
        checkedAt: "2026-11-19T12:00:00.000Z",
        currentVersion: "1.0.10",
        latestVersion: "1.0.10",
        updateAvailable: false,
      },
    },
  });

  assert.equal(html.includes("about-update-status"), false);
  assert.equal(html.includes(t("about.update.download")), false);
});

test("a failed check shows the message", () => {
  const html = renderPanel({
    appUpdate: {
      check: {
        attemptedAt: "2026-11-19T12:00:00.000Z",
        currentVersion: "1.0.10",
        updateAvailable: false,
        error: "HTTP 404",
        errorCode: "APP_UPDATE_HTTP_404",
      },
    },
  });

  assert.ok(html.includes(tp("about.update.error", { message: "HTTP 404" })));
});

test("the portable hint appears only for a portable build with a downloadable update", () => {
  const check = {
    attemptedAt: "2026-11-19T12:00:00.000Z",
    currentVersion: "1.0.10",
    latestVersion: "1.0.11",
    updateAvailable: true,
    download: {
      kind: "windows-portable" as const,
      fileName: "CBPanel-win-portable.zip",
      url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel-win-portable.zip",
    },
  };

  assert.equal(renderPanel({ appUpdate: { check } }).includes(t("about.update.portableHint")), false);
  assert.ok(renderPanel({ appUpdate: { check, portable: true } }).includes(t("about.update.portableHint")));
  assert.equal(
    renderPanel({ appUpdate: { check: { ...check, updateAvailable: false }, portable: true } }).includes(t("about.update.portableHint")),
    false,
  );
});

test("the update card carries no startup toggle", () => {
  const html = renderPanel();

  assert.equal(html.includes("toggle-field"), false);
});

function sectionTitles(html: string): string[] {
  return [...html.matchAll(/<section\b[^>]*class="settings-section[^"]*"[^>]*>[\s\S]*?<h2>([^<]+)<\/h2>/g)].map((match) => match[1]);
}

function enabledButtonLabels(html: string): string[] {
  return [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)]
    .filter(([, attributes]) => !attributes.includes("disabled="))
    .map(([, , body]) => body.replace(/<[^>]*>/g, "").trim());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderPanel(
  options: {
    diagnostics?: SystemDiagnostics | null;
    locale?: Locale;
    runtime?: DesktopRuntimeInfo | null;
    storage?: StorageInfo;
    binaryInfo?: BinaryInfo | null;
    appUpdate?: Partial<AboutContentProps["appUpdate"]>;
  } = {},
): string {
  const locale = options.locale ?? "zh-CN";
  const props: AboutContentProps = {
    appUpdate: {
      check: undefined,
      checking: false,
      currentVersion: "1.0.10",
      onCheck: () => {},
      onDownload: () => {},
      onOpenReleasePage: () => {},
      portable: false,
      ...options.appUpdate,
    },
    binaryInfo: options.binaryInfo === undefined ? binaryInfoFixture() : options.binaryInfo,
    copyDiagnostics: async () => {},
    diagnostics: options.diagnostics === undefined ? diagnosticsFixture() : options.diagnostics,
    exportDiagnostics: () => {},
    locale,
    openDataDirectory: async () => {},
    openLink: async () => {},
    openSidecarEndpoint: async () => {},
    renderMark: (className) => React.createElement("span", { className }),
    runtime: options.runtime === undefined ? runtimeFixture() : options.runtime,
    storage: options.storage ?? { kind: "sqlite", databasePath: "D:/data/panel.db", portable: true },
    t: (key, params) => translate(locale, key, params),
    versions: { app: "1.0.10", wrapper: "0.7.0" },
  };
  return renderToStaticMarkup(React.createElement(AboutContent, props));
}

function diagnosticsFixture(
  host: SystemDiagnostics["host"] = { os: "Windows_NT", arch: "x64", node: "v26.0.0", osName: "Windows 11 Enterprise", osVersion: "10.0.26300" },
): SystemDiagnostics {
  return {
    checkedAt: "2026-08-06T00:00:00.000Z",
    schemaVersion: 5,
    dataDir: "D:/data",
    databasePath: "D:/data/panel.db",
    portable: true,
    host,
    sessions: { total: 0, running: 0, launching: 0, stopping: 0, error: 0, unconfirmed: 0 },
    networkTrace: { providerId: "cloudflare-www", providerName: "Cloudflare", providerUrl: "https://example.test", timeoutSeconds: 8 },
    extensionCache: { directory: "D:/data/extensions", installedCount: 3 },
    browserCoreDiagnostics: { checkedAt: "2026-08-06T00:00:00.000Z", available: true },
    xrayEngine: { installed: false, source: "missing", binaryPath: "", binaryDir: "", instances: [] },
    recentErrors: [],
  };
}

function binaryInfoFixture(): BinaryInfo {
  return {
    version: "0.7.0",
    platform: "windows-x64",
    binaryPath: "D:/data/core/chrome.exe",
    installed: true,
    cacheDir: "D:/data/core",
    downloadUrl: "https://example.test/core.zip",
    core: {
      channel: "official",
      channelMode: "online",
      status: "installed",
      installed: true,
      targetTier: "pro",
      planIsFree: false,
      versionMode: "latest",
      platform: "windows-x64",
      binaryPath: "D:/data/core/chrome.exe",
      cacheDir: "D:/data/core",
      downloadUrl: "https://example.test/core.zip",
      versions: {
        cbpanelVersion: "1.0.10",
        wrapperVersion: "0.7.0",
        chromiumVersion: "156.0.8078.47.1",
        playwrightCoreVersion: "1.64.1",
      },
      license: { configured: true, active: true, valid: true, plan: "team" },
      channels: { official: { installed: true, version: "0.7.0" }, private: { installed: false } },
      officialLicense: { configured: true, valid: true },
      env: [],
      portable: true,
      cacheManagedByCBPanel: true,
      restartRequired: false,
    },
  };
}

function runtimeFixture(): DesktopRuntimeInfo {
  return {
    shell: "desktop",
    platform: "windows",
    chrome: "custom",
    portable: true,
    versions: { app: "1.0.10" },
    api: { host: "127.0.0.1", port: 43210, tokenRequired: true },
    sidecar: { status: "ready", detail: "ok" },
  };
}
