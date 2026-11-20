import assert from "node:assert/strict";
import test from "node:test";
import {
  BUILTIN_GITHUB_MIRROR_PROVIDERS,
  BUILTIN_NETWORK_TRACE_PROVIDERS,
  CLOAKBROWSER_ENV_SUGGESTION_KEYS,
  DEFAULT_APP_SETTINGS,
  DEFAULT_GITHUB_MIRROR_PROVIDER_ID,
  DEFAULT_NETWORK_TRACE_PROVIDER_ID,
  DEFAULT_PROFILE_COLUMNS,
  FORCED_UI_FONT_FAMILY,
  isManagedCloakBrowserEnvKey,
  isPanelSettingCloakBrowserEnvKey,
  mergeSettings,
  normalizeCloakBrowserEnvKey,
  normalizeNetworkTraceSettings,
  normalizeSettings,
  PREFERRED_GITHUB_MIRROR_PROVIDER_ID,
  resolveGithubMirrorPrefix,
  resolveNetworkTraceProvider,
  resolveLanguageMode,
  type GithubMirrorProviderId,
} from "./settings";

test("normalizeSettings returns stable defaults", () => {
  const settings = normalizeSettings();

  assert.equal(settings.appearance.theme, "system");
  assert.equal(settings.appearance.language, "system");
  assert.equal(settings.appearance.uiFontFamily, FORCED_UI_FONT_FAMILY);
  assert.equal(settings.desktop.closeBehavior, "ask");
  assert.equal(settings.desktop.sidebarMode, "expanded");
  assert.equal(settings.table.pageSize, 25);
  assert.equal(Object.hasOwn(settings.binary, "checkForUpdatesOnStartup"), false);
  assert.equal(Object.hasOwn(settings.binary, "preferExistingCache"), false);
  assert.equal(settings.binary.lastUpdateCheck, undefined);
  assert.equal(settings.binary.cacheDirMode, "auto");
  assert.equal(Object.hasOwn(settings.binary, "licenseKeyEnabled"), false);
  assert.deepEqual(settings.binary.customEnvVars, [
    {
      id: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      value: "20",
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
  assert.deepEqual(settings.extensionAcquisition, {
    artifactProviderId: "crxsoso",
    crxsosoDisclosureVersionAccepted: 0,
  });
  assert.deepEqual(settings.appUpdate, {
    lastUpdateCheck: undefined,
  });
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
      githubMirrorProviderId: "ghproxy-net",
      customGithubMirrorPrefix: " https://gh-proxy.example.com/// ",
    },
  });

  assert.equal(settings.networkTrace.githubMirrorProviderId, "ghproxy-net");
  assert.equal(settings.networkTrace.customGithubMirrorPrefix, "https://gh-proxy.example.com/");
  assert.equal(resolveGithubMirrorPrefix(settings.networkTrace), "https://ghproxy.net/");
  assert.ok(BUILTIN_GITHUB_MIRROR_PROVIDERS.some((provider) => provider.id === "ghproxy-net"));
});

test("retired GitHub mirror ids migrate to the preferred mirror instead of silently disabling it", () => {
  // Stored settings are untrusted input: these ids were valid in earlier releases.
  for (const retired of ["ghproxy-vip", "ghfast-top", "gh-proxy-lipk"] as const) {
    const settings = normalizeNetworkTraceSettings({
      githubMirrorProviderId: retired as GithubMirrorProviderId,
    });

    assert.equal(settings.githubMirrorProviderId, PREFERRED_GITHUB_MIRROR_PROVIDER_ID);
    assert.equal(resolveGithubMirrorPrefix(settings), "https://gh-proxy.com/");
  }
  assert.equal(
    normalizeNetworkTraceSettings({ githubMirrorProviderId: "nonsense" as GithubMirrorProviderId }).githubMirrorProviderId,
    "off",
  );
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
  assert.equal(settings.desktop.closeBehavior, "ask");
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
    },
  });

  assert.equal(settings.desktop.closeBehavior, "quit");
});

test("normalizeSettings normalizes browser core settings and custom CloakBrowser env vars", () => {
  const settings = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      customBinaryPathEnabled: true,
      customBinaryPath: " D:/cloak/chrome.exe ",
      cacheDirMode: "custom",
      customCacheDir: " D:/cloak/cache ",
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
          key: "NODE-OPTIONS",
          value: "--inspect",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "text",
        },
      ],
    },
  });

  assert.equal(settings.binary.customBinaryPathEnabled, true);
  assert.equal(settings.binary.customBinaryPath, "D:/cloak/chrome.exe");
  assert.equal(settings.binary.cacheDirMode, "custom");
  assert.equal(settings.binary.customCacheDir, "D:/cloak/cache");
  assert.deepEqual(settings.binary.customEnvVars.map((item) => item.key), [
    "CLOAKBROWSER_FUTURE_FLAG",
    "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  ]);
  assert.equal(settings.binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS")?.enabled, false);
});

test("normalizeSettings keeps the release channel stable unless preview is chosen", () => {
  assert.equal(normalizeSettings().binary.releaseChannel, "stable");
  assert.equal(
    normalizeSettings({ binary: { ...DEFAULT_APP_SETTINGS.binary, releaseChannel: "preview" } }).binary.releaseChannel,
    "preview",
  );
  assert.equal(
    normalizeSettings({
      binary: { ...DEFAULT_APP_SETTINGS.binary, releaseChannel: "nightly" as never },
    }).binary.releaseChannel,
    "stable",
  );
});

test("normalizeSettings keeps the required key and discards the retired optional-license switch", () => {
  const binary = { licenseKey: " cb_stored ", licenseKeyEnabled: false };
  const settings = normalizeSettings({ binary });
  assert.equal(settings.binary.licenseKey, "cb_stored");
  assert.equal(Object.hasOwn(settings.binary, "licenseKeyEnabled"), false);
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
        targetTier: "pro",
        versionMode: "latest",
        baselineCaveat: "offline-import-tier-mismatch",
      },
    },
  });

  assert.equal(settings.binary.lastUpdateCheck?.checkedAt, "2026-06-06T00:00:00.000Z");
  assert.equal(settings.binary.lastUpdateCheck?.latestVersion, "147.0.7700.1");
  assert.equal(settings.binary.lastUpdateCheck?.targetTier, "pro");
  // The caveat is the reason the panel does not present the verdict as settled, so losing it on restart
  // would restore a confident "up to date" the server never meant.
  assert.equal(settings.binary.lastUpdateCheck?.baselineCaveat, "offline-import-tier-mismatch");
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

  // An unknown caveat code costs only the caveat: the comparison itself is still the last thing the
  // server did, and the panel translates the code, so carrying one it cannot translate is the only loss.
  const unknownCaveat = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      lastUpdateCheck: {
        checkedAt: "2026-06-06T00:00:00.000Z",
        currentVersion: "146.0.7680.177.5",
        updateAvailable: false,
        baselineCaveat: "made-up-code",
      } as never,
    },
  });

  assert.equal(unknownCaveat.binary.lastUpdateCheck?.currentVersion, "146.0.7680.177.5");
  assert.equal(unknownCaveat.binary.lastUpdateCheck?.baselineCaveat, undefined);
});

test("normalizeSettings keeps GeoIP timeout as an editable default env row", () => {
  const settings = normalizeSettings();
  const row = settings.binary.customEnvVars.find((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS");

  assert.equal(row?.value, "20");
  assert.equal(row?.enabled, true);
  assert.equal(row?.valueKind, "number");
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

  assert.deepEqual(settings.binary.customEnvVars.map((item) => item.key), []);
});

test("normalizeSettings drops retired switches without disabling built-in core policies", () => {
  const binary = { licenseKey: "cb_fixture", autoCheckUpdates: false, checkForUpdatesOnStartup: false, preferExistingCache: false };
  const settings = normalizeSettings({ binary });
  assert.equal(settings.binary.licenseKey, "cb_fixture");
  for (const key of ["autoCheckUpdates", "checkForUpdatesOnStartup", "preferExistingCache"]) {
    assert.equal(Object.hasOwn(settings.binary, key), false);
  }
});

// The three variables with dedicated controls used to be accepted as custom rows, and a row outranks
// the control it duplicates — so the panel showed one value and launched with another. New rows are
// refused; a stored row stays visible so the override is at least inspectable.
test("keys owned by a dedicated control are refused as new env rows but kept when stored", () => {
  for (const key of ["CLOAKBROWSER_VERSION", "CLOAKBROWSER_RELEASE_CHANNEL", "CLOAKBROWSER_LICENSE_KEY"] as const) {
    assert.equal(isPanelSettingCloakBrowserEnvKey(key), true, key);
    assert.equal(isManagedCloakBrowserEnvKey(key), false, key);
  }
  assert.equal(isPanelSettingCloakBrowserEnvKey("CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS"), false);

  const stored = normalizeSettings({
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      customEnvVars: [
        {
          id: "license",
          key: "CLOAKBROWSER_LICENSE_KEY",
          value: "cb_stored",
          enabled: true,
          sensitive: true,
          description: "",
          valueKind: "secret",
        },
      ],
    },
  });
  assert.deepEqual(stored.binary.customEnvVars.map((item) => item.key), ["CLOAKBROWSER_LICENSE_KEY"]);

  // The suggestion list only carries keys that are neither managed nor owned by a control.
  for (const key of CLOAKBROWSER_ENV_SUGGESTION_KEYS) {
    assert.equal(isManagedCloakBrowserEnvKey(key), false, key);
    assert.equal(isPanelSettingCloakBrowserEnvKey(key), false, key);
  }
  assert.equal((CLOAKBROWSER_ENV_SUGGESTION_KEYS as readonly string[]).some((key) => key.includes("WIDEVINE")), false);
});

test("normalizeCloakBrowserEnvKey adds the default prefix and rejects removed or malformed keys", () => {
  assert.equal(normalizeCloakBrowserEnvKey(" cloakbrowser_download_url "), undefined);
  assert.equal(normalizeCloakBrowserEnvKey(" cloakbrowser_new_flag "), "CLOAKBROWSER_NEW_FLAG");
  assert.equal(normalizeCloakBrowserEnvKey(" new_flag "), "CLOAKBROWSER_NEW_FLAG");
  for (const key of ["", " ", "DOWNLOAD_URL", "SKIP_CHECKSUM", "CLOAKBROWSER_SKIP_CHECKSUM", "BAD-KEY", "BAD KEY"]) {
    assert.equal(normalizeCloakBrowserEnvKey(key), undefined, key);
  }
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
});

test("extension acquisition settings select one canonical channel", () => {
  const settings = normalizeSettings({
    extensionAcquisition: {
      artifactProviderId: "chrome-web-store",
      crxsosoDisclosureVersionAccepted: 1,
    },
  });
  assert.deepEqual(settings.extensionAcquisition, {
    artifactProviderId: "chrome-web-store",
    crxsosoDisclosureVersionAccepted: 1,
  });

  const merged = mergeSettings(settings, {
    extensionAcquisition: { artifactProviderId: "crxsoso" },
  });
  assert.deepEqual(merged.extensionAcquisition, {
    artifactProviderId: "crxsoso",
    crxsosoDisclosureVersionAccepted: 1,
  });

  assert.equal(normalizeSettings({
    extensionAcquisition: { crxsosoDisclosureVersionAccepted: -1 },
  }).extensionAcquisition.crxsosoDisclosureVersionAccepted, 0);
  assert.equal(normalizeSettings({
    extensionAcquisition: { crxsosoDisclosureVersionAccepted: 1.5 },
  }).extensionAcquisition.crxsosoDisclosureVersionAccepted, 0);
  assert.equal(normalizeSettings({
    extensionAcquisition: { crxsosoDisclosureVersionAccepted: 2 },
  }).extensionAcquisition.crxsosoDisclosureVersionAccepted, 0);
  assert.equal(normalizeSettings({
    extensionAcquisition: { crxsosoDisclosureVersionAccepted: Number.MAX_SAFE_INTEGER },
  }).extensionAcquisition.crxsosoDisclosureVersionAccepted, 0);

  assert.equal(normalizeSettings({
    extensionAcquisition: { artifactProviderId: "unknown" as never },
  }).extensionAcquisition.artifactProviderId, "crxsoso");
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

test("app update checks normalize stored verdicts and drop unusable ones", () => {
  const valid = normalizeSettings({
    appUpdate: {
      lastUpdateCheck: {
        attemptedAt: "2026-11-19T12:00:00.000Z",
        checkedAt: "2026-11-19T12:00:00.000Z",
        currentVersion: "1.0.10",
        latestVersion: "1.0.11",
        updateAvailable: true,
        releaseUrl: "https://github.com/lkeme/CBPanel/releases/tag/v1.0.11",
        download: {
          kind: "windows-installer",
          fileName: "CBPanel_1.0.11_x64-setup.exe",
          url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe",
        },
      },
    },
  });

  assert.equal(valid.appUpdate.lastUpdateCheck?.latestVersion, "1.0.11");
  assert.equal(valid.appUpdate.lastUpdateCheck?.download?.kind, "windows-installer");

  assert.equal(
    normalizeSettings({ appUpdate: { lastUpdateCheck: { attemptedAt: "not-a-date", currentVersion: "1", updateAvailable: true } } })
      .appUpdate.lastUpdateCheck,
    undefined,
  );
  assert.equal(
    normalizeSettings({
      appUpdate: {
        // Missing `updateAvailable`: a stored verdict without a verdict is not one.
        lastUpdateCheck: { attemptedAt: "2026-11-19T12:00:00.000Z", currentVersion: "1" } as never,
      },
    }).appUpdate.lastUpdateCheck,
    undefined,
  );
  assert.equal(
    normalizeSettings({
      appUpdate: {
        lastUpdateCheck: {
          attemptedAt: "2026-11-19T12:00:00.000Z",
          currentVersion: "1.0.10",
          updateAvailable: true,
          releaseUrl: "https://example.test/releases",
          download: { kind: "windows-installer", fileName: "a.exe", url: "https://example.test/a.exe" },
        },
      },
    }).appUpdate.lastUpdateCheck?.download,
    undefined,
    "an untrusted download URL is dropped rather than carried into the panel",
  );
});

test("mergeSettings keeps the stored verdict when another group is written", () => {
  const checked = mergeSettings(DEFAULT_APP_SETTINGS, {
    appUpdate: {
      lastUpdateCheck: {
        attemptedAt: "2026-11-19T12:00:00.000Z",
        currentVersion: "1.0.10",
        updateAvailable: false,
      },
    },
  });

  assert.equal(mergeSettings(checked, { appearance: { ...checked.appearance, theme: "dark" } }).appUpdate.lastUpdateCheck?.currentVersion, "1.0.10");
});

test("resolveLanguageMode maps system language to supported locale", () => {
  assert.equal(resolveLanguageMode("system", "zh-Hans-CN"), "zh-CN");
  assert.equal(resolveLanguageMode("system", "en-GB"), "en-US");
  assert.equal(resolveLanguageMode("zh-CN", "en-US"), "zh-CN");
});
