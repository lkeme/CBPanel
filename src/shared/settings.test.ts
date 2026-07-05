import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_CLOAKBROWSER_ENV_KEYS,
  BUILTIN_GITHUB_MIRROR_PROVIDERS,
  BUILTIN_NETWORK_TRACE_PROVIDERS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_GITHUB_MIRROR_PROVIDER_ID,
  DEFAULT_NETWORK_TRACE_PROVIDER_ID,
  DEFAULT_PROFILE_COLUMNS,
  FORCED_UI_FONT_FAMILY,
  mergeSettings,
  normalizeCloakBrowserEnvKey,
  normalizeNetworkTraceSettings,
  normalizeSettings,
  resolveGithubMirrorPrefix,
  resolveNetworkTraceProvider,
  resolveLanguageMode,
} from "./settings";

test("normalizeSettings returns stable defaults", () => {
  const settings = normalizeSettings();

  assert.equal(settings.storage.primary, "sqlite");
  assert.equal(settings.appearance.theme, "system");
  assert.equal(settings.appearance.language, "system");
  assert.equal(settings.appearance.uiFontFamily, FORCED_UI_FONT_FAMILY);
  assert.equal(settings.desktop.closeBehavior, "ask");
  assert.equal(settings.desktop.closeToTray, false);
  assert.equal(settings.desktop.sidebarMode, "expanded");
  assert.equal(settings.table.pageSize, 25);
  assert.equal(settings.binary.checkForUpdatesOnStartup, true);
  assert.equal(settings.binary.lastUpdateCheck, undefined);
  assert.equal(settings.binary.envSettingsVersion, 1);
  assert.equal(settings.binary.internalAutoUpdate, false);
  assert.equal(settings.binary.cacheDirMode, "auto");
  assert.equal(settings.binary.downloadSourceMode, "official");
  assert.equal(settings.binary.geoipTimeoutSeconds, 12);
  assert.deepEqual(settings.binary.customEnvVars, [
    {
      id: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      value: "12",
      enabled: true,
      sensitive: false,
      description: "",
      valueKind: "number",
    },
  ]);
  assert.equal(settings.networkTrace.providerId, DEFAULT_NETWORK_TRACE_PROVIDER_ID);
  assert.equal(settings.networkTrace.timeoutSeconds, 8);
  assert.equal(settings.networkTrace.githubMirrorProviderId, DEFAULT_GITHUB_MIRROR_PROVIDER_ID);
  assert.equal(settings.networkTrace.customGithubMirrorPrefix, "");
  assert.equal(settings.table.columns.length, DEFAULT_PROFILE_COLUMNS.length);
  assert.deepEqual(
    settings.table.columns.map((column) => column.id),
    DEFAULT_PROFILE_COLUMNS.map((column) => column.id),
  );
});

test("normalizeSettings supports optional GitHub mirror prefixes under network settings", () => {
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "chatgpt",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "ghproxy-vip",
      customGithubMirrorPrefix: " https://gh-proxy.example.com/// ",
    },
  });

  assert.equal(settings.networkTrace.githubMirrorProviderId, "ghproxy-vip");
  assert.equal(settings.networkTrace.customGithubMirrorPrefix, "https://gh-proxy.example.com/");
  assert.equal(resolveGithubMirrorPrefix(settings.networkTrace), "https://ghproxy.vip/");
  assert.ok(BUILTIN_GITHUB_MIRROR_PROVIDERS.some((provider) => provider.id === "ghproxy-vip"));
});

test("resolveGithubMirrorPrefix supports custom and disabled modes", () => {
  assert.equal(resolveGithubMirrorPrefix(normalizeNetworkTraceSettings()), undefined);
  assert.equal(resolveGithubMirrorPrefix({
    providerId: DEFAULT_NETWORK_TRACE_PROVIDER_ID,
    customProviderUrl: "",
    timeoutSeconds: 8,
    githubMirrorProviderId: "auto-best",
    customGithubMirrorPrefix: "",
  }), undefined);
  assert.equal(resolveGithubMirrorPrefix({
    providerId: DEFAULT_NETWORK_TRACE_PROVIDER_ID,
    customProviderUrl: "",
    timeoutSeconds: 8,
    githubMirrorProviderId: "custom",
    customGithubMirrorPrefix: "https://mirror.example.com/",
  }), "https://mirror.example.com/");
});

test("normalizeSettings accepts split-tunnel network trace endpoints", () => {
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "tencent-ip2city",
      customProviderUrl: " https://trace.example.com/cdn-cgi/trace ",
      timeoutSeconds: 99,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "",
    },
  });

  assert.equal(settings.networkTrace.providerId, "tencent-ip2city");
  assert.equal(settings.networkTrace.customProviderUrl, "https://trace.example.com/cdn-cgi/trace");
  assert.equal(settings.networkTrace.timeoutSeconds, 30);
  assert.ok(BUILTIN_NETWORK_TRACE_PROVIDERS.some((provider) => provider.id === "tencent-ip2city"));
  assert.ok(BUILTIN_NETWORK_TRACE_PROVIDERS.some((provider) => provider.id === "alibaba-dns-detect"));
  assert.ok(BUILTIN_NETWORK_TRACE_PROVIDERS.some((provider) => provider.id === "chatgpt"));
});

test("network trace catalog includes visible split-tunnel targets with metadata", () => {
  const domains = new Set(BUILTIN_NETWORK_TRACE_PROVIDERS.map((provider) => provider.actualDomain ?? new URL(provider.url).hostname));
  const requiredDomains = [
    "dns-detect.alicdn.com",
    "necaptcha.nosdn.127.net",
    "perfops.byte-test.com",
    "r.inews.qq.com",
    "perfops.cloudflareperf.com",
    "www.qualcomm.cn",
    "ip.skk.moe",
    "perfops2.byte-test.com",
    "gateway.discord.gg",
    "www.visa.com",
    "x.com",
    "medium.com",
    "chatgpt.com",
    "sora.com",
    "openai.com",
    "claude.ai",
    "grok.com",
    "anthropic.com",
    "www.perplexity.ai",
    "e-hentai.org",
    "missav.ws",
    "missav.ai",
    "missav.live",
    "hanime1.me",
    "hanimeone.me",
    "hanime1.com",
    "javchu.com",
    "av.jkforum.net",
    "javdb.com",
    "coinbase.com",
    "www.okx.com",
    "testingcf.jsdelivr.net",
    "cdnjs.cloudflare.com",
    "cloudflaremirrors.com",
    "registry.npmjs.org",
    "kali.download",
    "app.unpkg.com",
    "crunchyroll.com",
    "nodejs.org",
    "gitlab.com",
  ];

  for (const domain of requiredDomains) assert.equal(domains.has(domain), true, domain);
  assert.ok(BUILTIN_NETWORK_TRACE_PROVIDERS.every((provider) => provider.kind && provider.category && provider.icon));
  assert.notEqual(DEFAULT_NETWORK_TRACE_PROVIDER_ID, "cloudflare-speed");
});

test("resolveNetworkTraceProvider supports custom trace endpoints", () => {
  assert.equal(resolveNetworkTraceProvider(normalizeNetworkTraceSettings()).id, DEFAULT_NETWORK_TRACE_PROVIDER_ID);
  const provider = resolveNetworkTraceProvider({
    providerId: "custom",
    customProviderUrl: "https://example.com/cdn-cgi/trace",
    timeoutSeconds: 8,
  });
  assert.equal(provider.id, "custom");
  assert.equal(provider.name, "Custom");
  assert.equal(provider.url, "https://example.com/cdn-cgi/trace");
  assert.equal(provider.kind, "cloudflare-trace");
});

test("normalizeSettings rejects invalid enums and clamps font sizes", () => {
  const settings = normalizeSettings({
    appearance: {
      ...DEFAULT_APP_SETTINGS.appearance,
      theme: "solarized" as never,
      language: "fr-FR" as never,
      density: "tiny" as never,
      uiFontFamily: '"Inter", system-ui, sans-serif',
      baseFontSize: 99,
      tableFontSize: 1,
      codeFontSize: Number.NaN,
    },
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      pageSize: 10,
    },
    desktop: {
      closeToTray: true,
      sidebarMode: "hidden" as never,
    },
  });

  assert.equal(settings.appearance.theme, "system");
  assert.equal(settings.appearance.language, "system");
  assert.equal(settings.appearance.density, "comfortable");
  assert.equal(
    settings.appearance.uiFontFamily.startsWith(
      '"SarasaUiSC-Regular"',
    ),
    true,
  );
  assert.equal(settings.desktop.sidebarMode, "expanded");
  assert.equal(settings.desktop.closeBehavior, "tray");
  assert.equal(settings.desktop.closeToTray, true);
  assert.equal(settings.appearance.baseFontSize, 22);
  assert.equal(settings.appearance.tableFontSize, 11);
  assert.equal(settings.appearance.codeFontSize, 14);
  assert.equal(settings.table.pageSize, 25);
});

test("normalizeSettings preserves explicit desktop close behavior", () => {
  const settings = normalizeSettings({
    desktop: {
      ...DEFAULT_APP_SETTINGS.desktop,
      closeBehavior: "quit",
      closeToTray: true,
    },
  });

  assert.equal(settings.desktop.closeBehavior, "quit");
  assert.equal(settings.desktop.closeToTray, false);
});

test("mergeSettings migrates legacy close-to-tray patches to close behavior", () => {
  const traySettings = mergeSettings(DEFAULT_APP_SETTINGS, {
    desktop: {
      closeToTray: true,
    },
  });
  assert.equal(traySettings.desktop.closeBehavior, "tray");
  assert.equal(traySettings.desktop.closeToTray, true);

  const askSettings = mergeSettings(traySettings, {
    desktop: {
      closeToTray: false,
    },
  });
  assert.equal(askSettings.desktop.closeBehavior, "ask");
  assert.equal(askSettings.desktop.closeToTray, false);
});

test("mergeSettings keeps explicit close behavior ahead of legacy close-to-tray", () => {
  const settings = mergeSettings(DEFAULT_APP_SETTINGS, {
    desktop: {
      closeBehavior: "quit",
      closeToTray: true,
    },
  });

  assert.equal(settings.desktop.closeBehavior, "quit");
  assert.equal(settings.desktop.closeToTray, false);
});

test("normalizeSettings normalizes browser core settings and custom CloakBrowser env vars", () => {
  const settings = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      checkForUpdatesOnStartup: false,
      customBinaryPathEnabled: true,
      customBinaryPath: " D:/cloak/chrome.exe ",
      cacheDirMode: "custom",
      customCacheDir: " D:/cloak/cache ",
      downloadSourceMode: "custom",
      customDownloadBaseUrl: " https://mirror.example.com/// ",
      internalAutoUpdate: true,
      checksumPolicy: "skip",
      geoipTimeoutSeconds: 999,
      customEnvVars: [
        {
          id: "one",
          key: "cloakbrowser_future_flag",
          value: "enabled",
          enabled: true,
          sensitive: false,
          description: "future",
          valueKind: "text",
        },
        {
          id: "duplicate",
          key: "CLOAKBROWSER_FUTURE_FLAG",
          value: "ignored",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "text",
        },
        {
          id: "fixed",
          key: "CLOAKBROWSER_AUTO_UPDATE",
          value: "true",
          enabled: false,
          sensitive: false,
          description: "fixed policy",
          valueKind: "boolean",
        },
        {
          id: "download-url",
          key: "CLOAKBROWSER_DOWNLOAD_URL",
          value: "https://mirror.example.com/",
          enabled: true,
          sensitive: false,
          description: "download override",
          valueKind: "url",
        },
        {
          id: "geoip-timeout",
          key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
          value: "12",
          enabled: false,
          sensitive: false,
          description: "default timeout",
          valueKind: "number",
        },
        {
          id: "managed",
          key: "CLOAKBROWSER_CACHE_DIR",
          value: "ignored",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "text",
        },
        {
          id: "bad",
          key: "NODE_OPTIONS",
          value: "--inspect",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "text",
        },
      ],
    },
  });

  assert.equal(settings.binary.checkForUpdatesOnStartup, false);
  assert.equal(settings.binary.customBinaryPathEnabled, true);
  assert.equal(settings.binary.customBinaryPath, "D:/cloak/chrome.exe");
  assert.equal(settings.binary.cacheDirMode, "custom");
  assert.equal(settings.binary.customCacheDir, "D:/cloak/cache");
  assert.equal(settings.binary.downloadSourceMode, "custom");
  assert.equal(settings.binary.customDownloadBaseUrl, "https://mirror.example.com");
  assert.equal(settings.binary.internalAutoUpdate, true);
  assert.equal(settings.binary.checksumPolicy, "skip");
  assert.equal(settings.binary.geoipTimeoutSeconds, 60);
  assert.deepEqual(settings.binary.customEnvVars.map((item) => item.key), [
    "CLOAKBROWSER_FUTURE_FLAG",
    "CLOAKBROWSER_DOWNLOAD_URL",
    "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  ]);
  assert.equal(settings.binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS")?.enabled, false);
});

test("normalizeSettings preserves valid browser core update check state", () => {
  const settings = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      lastUpdateCheck: {
        checkedAt: "2026-06-06T00:00:00.000Z",
        currentVersion: "146.0.7680.177.5",
        latestVersion: "147.0.7700.1",
        updateAvailable: true,
        downloadLinks: {
          tier: "free",
          version: "147.0.7700.1",
          platform: "windows-x64",
          primaryUrl: "https://cloakbrowser.dev/chromium-v147.0.7700.1/cloakbrowser-windows-x64.zip",
          fallbackUrl: "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v147.0.7700.1/cloakbrowser-windows-x64.zip",
          checksumUrl: "https://cloakbrowser.dev/chromium-v147.0.7700.1/SHA256SUMS",
          signatureUrl: "https://cloakbrowser.dev/chromium-v147.0.7700.1/SHA256SUMS.sig",
          fallbackChecksumUrl: "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v147.0.7700.1/SHA256SUMS",
          fallbackSignatureUrl: "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v147.0.7700.1/SHA256SUMS.sig",
        },
      },
    },
  });

  assert.equal(settings.binary.lastUpdateCheck?.checkedAt, "2026-06-06T00:00:00.000Z");
  assert.equal(settings.binary.lastUpdateCheck?.latestVersion, "147.0.7700.1");
  assert.equal(settings.binary.lastUpdateCheck?.downloadLinks?.fallbackUrl?.includes("github.com"), true);
});

test("normalizeSettings drops invalid browser core update check state", () => {
  const settings = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      lastUpdateCheck: {
        checkedAt: "not-a-date",
        currentVersion: "",
        updateAvailable: true,
      },
    },
  });

  assert.equal(settings.binary.lastUpdateCheck, undefined);
});

test("normalizeSettings keeps GeoIP timeout as an editable default env row", () => {
  const settings = normalizeSettings();
  const row = settings.binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS");

  assert.equal(row?.value, "12");
  assert.equal(row?.enabled, true);
  assert.equal(row?.valueKind, "number");
});

test("normalizeSettings migrates old empty browser core env list with GeoIP timeout", () => {
  const settings = normalizeSettings({
    binary: {
      customEnvVars: [],
    } as never,
  });

  assert.deepEqual(settings.binary.customEnvVars, [
    {
      id: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      value: "12",
      enabled: true,
      sensitive: false,
      description: "",
      valueKind: "number",
    },
  ]);
});

test("normalizeSettings migrates old GeoIP timeout value into the env row", () => {
  const settings = normalizeSettings({
    binary: {
      geoipTimeoutSeconds: 15,
      customEnvVars: [],
    } as never,
  });

  const row = settings.binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS");

  assert.equal(row?.value, "15");
  assert.equal(row?.enabled, true);
  assert.equal(row?.valueKind, "number");
});

test("normalizeSettings respects deletion after browser core env schema migration", () => {
  const settings = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      envSettingsVersion: 1,
      customEnvVars: [],
    },
  });

  assert.deepEqual(settings.binary.customEnvVars, []);
});

test("normalizeSettings rejects system-managed fixed browser core env vars", () => {
  const settings = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      customEnvVars: [
        {
          id: "cache-dir",
          key: "CLOAKBROWSER_CACHE_DIR",
          value: "D:/cache",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "directory",
        },
        {
          id: "auto-update",
          key: "CLOAKBROWSER_AUTO_UPDATE",
          value: "true",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "boolean",
        },
        {
          id: "skip-checksum",
          key: "CLOAKBROWSER_SKIP_CHECKSUM",
          value: "true",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "boolean",
        },
        {
          id: "download-url",
          key: "CLOAKBROWSER_DOWNLOAD_URL",
          value: "https://mirror.example.com",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "url",
        },
      ],
    },
  });

  assert.deepEqual(settings.binary.customEnvVars.map((item) => item.key), ["CLOAKBROWSER_DOWNLOAD_URL"]);
});

test("normalizeSettings migrates old autoCheckUpdates flag", () => {
  const settings = normalizeSettings({
    binary: {
      autoCheckUpdates: false,
    } as never,
  });

  assert.equal(settings.binary.checkForUpdatesOnStartup, false);
});

test("normalizeCloakBrowserEnvKey accepts only CLOAKBROWSER variables", () => {
  assert.equal(normalizeCloakBrowserEnvKey(" cloakbrowser_new_flag "), "CLOAKBROWSER_NEW_FLAG");
  assert.equal(normalizeCloakBrowserEnvKey("PATH"), undefined);
  assert.equal(normalizeCloakBrowserEnvKey("CLOAK_BROWSER_BAD"), undefined);
});

test("normalizeSettings keeps known columns once and restores missing columns", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "name", visible: false, width: 9999, order: 50 },
        { id: "name", visible: true, width: 10, order: 10 },
        { id: "unknown", visible: true, order: 1 },
      ],
    },
  });

  const name = settings.table.columns.find((column) => column.id === "name");

  assert.equal(settings.table.columns.length, DEFAULT_PROFILE_COLUMNS.length);
  assert.equal(name?.visible, false);
  assert.equal(name?.width, 360);
  assert.equal(settings.table.columns.some((column) => column.id === "unknown"), false);
});

test("normalizeSettings preserves custom profile column order", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "select", visible: true, width: 46, order: 0 },
        { id: "tags", visible: true, width: 126, order: 10 },
        { id: "name", visible: true, width: 220, order: 20 },
        { id: "status", visible: true, width: 72, order: 30 },
        { id: "actions", visible: true, width: 112, order: 999 },
      ],
    },
  });

  assert.deepEqual(
    settings.table.columns.map((column) => column.id).slice(0, 4),
    ["select", "tags", "name", "status"],
  );
  assert.equal(settings.table.columns.at(-1)?.id, "actions");
  assert.equal(settings.table.columns.find((column) => column.id === "status")?.width, 72);
});

test("normalizeSettings pins fixed profile columns at the edges", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "actions", visible: true, width: 112, order: -100 },
        { id: "name", visible: true, width: 220, order: 20 },
        { id: "select", visible: true, width: 46, order: 999 },
        { id: "tags", visible: true, width: 126, order: 10 },
      ],
    },
  });

  assert.equal(settings.table.columns.at(0)?.id, "select");
  assert.equal(settings.table.columns.at(-1)?.id, "actions");
  assert.equal(settings.table.columns.find((column) => column.id === "actions")?.width, 112);
});

test("normalizeSettings migrates old default proxy and ip columns to the merged exit view", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "proxy", visible: true, width: 154, order: 50 },
        { id: "ip", visible: true, width: 112, order: 60 },
      ],
    },
  });

  assert.equal(settings.table.columns.find((column) => column.id === "proxy")?.visible, false);
  assert.equal(settings.table.columns.find((column) => column.id === "proxy")?.width, 180);
  assert.equal(settings.table.columns.find((column) => column.id === "proxy")?.order, 60);
  assert.equal(settings.table.columns.find((column) => column.id === "ip")?.visible, true);
  assert.equal(settings.table.columns.find((column) => column.id === "ip")?.width, 190);
  assert.equal(settings.table.columns.find((column) => column.id === "ip")?.order, 50);
});

test("normalizeSettings migrates old table defaults to the compact workbench defaults", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "status", visible: true, width: 104, order: 20 },
        { id: "mode", visible: true, width: 78, order: 70 },
        { id: "updatedAt", visible: true, width: 96, order: 100 },
      ],
    },
  });

  assert.equal(settings.table.columns.find((column) => column.id === "status")?.width, 56);
  assert.equal(settings.table.columns.find((column) => column.id === "mode")?.width, 56);
  assert.equal(settings.table.columns.find((column) => column.id === "updatedAt")?.width, 118);
});

test("normalizeSettings preserves explicit tag column visibility at the default width", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "tags", visible: true, width: 126, order: 40 },
      ],
    },
  });

  assert.equal(settings.table.columns.find((column) => column.id === "tags")?.visible, true);
});

test("normalizeSettings keeps custom tag visibility and icon column widths", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "status", visible: true, width: 76, order: 20 },
        { id: "tags", visible: true, width: 160, order: 40 },
        { id: "mode", visible: true, width: 68, order: 70 },
        { id: "updatedAt", visible: true, width: 140, order: 100 },
      ],
    },
  });

  assert.equal(settings.table.columns.find((column) => column.id === "status")?.width, 76);
  assert.equal(settings.table.columns.find((column) => column.id === "mode")?.width, 68);
  assert.equal(settings.table.columns.find((column) => column.id === "updatedAt")?.width, 140);
  assert.equal(settings.table.columns.find((column) => column.id === "tags")?.visible, true);
});

test("normalizeSettings migrates old icon column widths independently", () => {
  const settings = normalizeSettings({
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      columns: [
        { id: "status", visible: true, width: 104, order: 20 },
        { id: "mode", visible: true, width: 68, order: 70 },
      ],
    },
  });

  assert.equal(settings.table.columns.find((column) => column.id === "status")?.width, 56);
  assert.equal(settings.table.columns.find((column) => column.id === "mode")?.width, 68);
});

test("mergeSettings applies partial patches without losing sibling groups", () => {
  const settings = mergeSettings(DEFAULT_APP_SETTINGS, {
    appearance: {
      ...DEFAULT_APP_SETTINGS.appearance,
      theme: "dark",
    },
    table: {
      ...DEFAULT_APP_SETTINGS.table,
      showInspector: false,
    },
  });

  assert.equal(settings.appearance.theme, "dark");
  assert.equal(settings.appearance.language, DEFAULT_APP_SETTINGS.appearance.language);
  assert.equal(settings.table.showInspector, false);
  assert.equal(settings.storage.primary, "sqlite");
});

test("mergeSettings applies browser core partial patches without losing sibling settings", () => {
  const settings = mergeSettings(DEFAULT_APP_SETTINGS, {
    binary: {
      tierMode: "pro",
    },
  });

  assert.equal(settings.binary.tierMode, "pro");
  assert.equal(settings.binary.browserVersionMode, DEFAULT_APP_SETTINGS.binary.browserVersionMode);
  assert.equal(settings.binary.cacheDirMode, DEFAULT_APP_SETTINGS.binary.cacheDirMode);
  assert.equal(settings.binary.customEnvVars.length, DEFAULT_APP_SETTINGS.binary.customEnvVars.length);
});

test("resolveLanguageMode maps system language to supported locale", () => {
  assert.equal(resolveLanguageMode("system", "zh-Hans-CN"), "zh-CN");
  assert.equal(resolveLanguageMode("system", "en-GB"), "en-US");
  assert.equal(resolveLanguageMode("zh-CN", "en-US"), "zh-CN");
});
