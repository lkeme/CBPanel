import assert from "node:assert/strict";
import test from "node:test";

import { ensureLocaleReady, translate } from "../i18n";
import type { Locale, TranslationKey } from "../i18n";
import { enUS } from "../locales/en-US";
import { zhCN } from "../locales/zh-CN";
import {
  auditProfile,
  createProfileSnapshot,
  defaultProfile,
  generateLaunchSnippets,
  preflightProfile,
  profileScore,
  snapshotToMarkdown,
  type BrowserProfile,
  type LocalizedText,
  type ProfilePreflightEnvironment,
} from "./profile";
import { resolveLocalizedText } from "./reportText";

const VLESS_LINK =
  "vless://b831381d-6324-4d53-ad4f-8cda48b30811@node.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=www.microsoft.com&type=tcp#Node";

/** Every namespace this file is responsible for; the builders must emit exactly these keys. */
const REPORT_KEY_PREFIXES = ["profileAudit.", "preflightItem.", "profileScore.", "launchSnippet.", "snapshot."];

type Scenario = {
  label: string;
  profile: BrowserProfile;
  environment: ProfilePreflightEnvironment;
};

function base(patch: Partial<BrowserProfile> = {}): BrowserProfile {
  return defaultProfile({ id: "profile-i18n", name: "i18n", ...patch });
}

function plainProxy(): BrowserProfile["proxy"] {
  return { ...base().proxy, enabled: true, scheme: "http", host: "proxy.example.test", port: "8080" };
}

function xrayProxy(shareLink = VLESS_LINK): BrowserProfile["proxy"] {
  return { ...base().proxy, enabled: true, scheme: "xray", shareLink };
}

function healthyNetworkCheck(): ProfilePreflightEnvironment["networkCheck"] {
  return {
    checkedAt: "2026-09-10T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.42",
    latencyMs: 88,
    trace: {
      providerId: "cloudflare-www",
      providerName: "Cloudflare",
      providerUrl: "https://www.cloudflare.com/cdn-cgi/trace",
      loc: "US",
      colo: "LAX",
    },
    source: "environment-check",
  };
}

/**
 * One profile/environment pair per branch of both builders. The coverage assertion below turns a
 * missing pair into a failure, so a new branch has to bring its own scenario with it.
 */
function scenarios(): Scenario[] {
  const scenarios: Scenario[] = [
    {
      label: "defaults",
      profile: base(),
      environment: { binaryInstalled: true },
    },
    {
      label: "ephemeral puppeteer with explicit identity",
      profile: base({
        mode: "ephemeral",
        runtime: {
          ...base().runtime,
          launcher: "puppeteer-browser",
          watermark: "banner",
          stealthArgs: false,
          extraArgs: [],
          humanize: false,
          geoip: false,
          headless: true,
        },
        fingerprint: {
          ...base().fingerprint,
          seed: "42069",
          timezone: "Asia/Shanghai",
          locale: "zh-CN",
          webrtcIp: "custom",
          webrtcIpValue: "203.0.113.9",
        },
        viewport: { ...base().viewport, mode: "fixed", width: 1920, height: 947 },
        advanced: {
          ...base().advanced,
          contextOptionsJson: '{ "permissions": [] }',
          humanConfigJson: '{ "typing_delay": 100 }',
        },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "persistent playwright-browser with a sandbox override",
      profile: base({
        runtime: { ...base().runtime, launcher: "playwright-browser", extensionPaths: ["D:/ext"] },
        advanced: { ...base().advanced, launchOptionsJson: '{ "chromiumSandbox": true }' },
      }),
      environment: {
        binaryInstalled: true,
        binaryPath: "C:/cloak/chrome.exe",
        userDataDir: "D:/profiles/i18n",
        userDataDirWritable: true,
        extensionChecks: [{ path: "D:/ext", exists: true }],
      },
    },
    {
      label: "puppeteer sandbox override",
      profile: base({
        runtime: { ...base().runtime, launcher: "puppeteer-browser" },
        advanced: { ...base().advanced, launchOptionsJson: '{ "chromiumSandbox": true }' },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "xray node with a healthy engine and exit check",
      profile: base({ proxy: xrayProxy() }),
      environment: {
        binaryInstalled: true,
        networkCheck: healthyNetworkCheck(),
        xrayEngine: { installed: true, version: "25.9.1", binaryPath: "/x/xray" },
      },
    },
    {
      label: "xray node whose share link does not parse",
      profile: base({ proxy: xrayProxy("vless://nope") }),
      environment: { binaryInstalled: true },
    },
    {
      label: "plain proxy without an exit check",
      profile: base({ proxy: plainProxy() }),
      environment: { binaryInstalled: true },
    },
    {
      label: "plain proxy with a failed exit check",
      profile: base({ proxy: plainProxy() }),
      environment: { binaryInstalled: true, networkCheck: { checkedAt: "2026-09-10T00:00:00.000Z", ok: false, error: "boom" } },
    },
    {
      label: "plain proxy with an unexplained failed exit check",
      profile: base({ proxy: plainProxy() }),
      environment: { binaryInstalled: true, networkCheck: { checkedAt: "2026-09-10T00:00:00.000Z", ok: false } },
    },
    {
      label: "plain proxy with an exit check that has no parts",
      profile: base({ proxy: plainProxy() }),
      environment: { binaryInstalled: true, networkCheck: { checkedAt: "2026-09-10T00:00:00.000Z", ok: true } },
    },
    {
      label: "enabled but incomplete proxy",
      profile: base({ proxy: { ...base().proxy, enabled: true, host: "", port: "" } }),
      environment: { binaryInstalled: true },
    },
    {
      label: "geoip with explicit timezone and locale",
      profile: base({
        proxy: plainProxy(),
        fingerprint: { ...base().fingerprint, timezone: "Asia/Shanghai", locale: "zh-CN" },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "webrtc auto without a network anchor",
      profile: base({
        runtime: { ...base().runtime, geoip: false },
        fingerprint: { ...base().fingerprint, webrtcIp: "auto", webrtcIpValue: "" },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "webrtc auto anchored by geoip",
      profile: base({
        fingerprint: { ...base().fingerprint, webrtcIp: "auto", timezone: "", locale: "" },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "webrtc auto behind a proxy",
      profile: base({
        proxy: plainProxy(),
        fingerprint: { ...base().fingerprint, webrtcIp: "auto" },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "webrtc off without geoip",
      profile: base({
        runtime: { ...base().runtime, geoip: false },
        fingerprint: { ...base().fingerprint, webrtcIp: "off", timezone: "", locale: "" },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "webrtc custom without a value",
      profile: base({
        runtime: { ...base().runtime, geoip: false },
        fingerprint: { ...base().fingerprint, webrtcIp: "custom", webrtcIpValue: "" },
      }),
      environment: { binaryInstalled: true },
    },
    {
      label: "persistent directory reported without a probe",
      profile: base(),
      environment: { binaryInstalled: true, userDataDir: "D:/profiles/i18n" },
    },
    {
      label: "persistent directory that is not writable",
      profile: base(),
      environment: { binaryInstalled: true, userDataDirWritable: false },
    },
    {
      label: "core missing",
      profile: base(),
      environment: { binaryInstalled: false },
    },
    {
      label: "core status not reported",
      profile: base(),
      environment: {},
    },
    {
      label: "ephemeral profile with extension paths",
      profile: base({
        mode: "ephemeral",
        runtime: { ...base().runtime, extensionPaths: ["D:/ext"] },
      }),
      environment: { binaryInstalled: true, extensionChecks: [{ path: "D:/ext", exists: true }] },
    },
    {
      label: "extensions with a warning and a missing path",
      profile: base({ runtime: { ...base().runtime, extensionPaths: ["D:/ext-a"] } }),
      environment: {
        binaryInstalled: true,
        extensionWarnings: [{ name: "Disabled Extension", detail: "扩展已停用，本次启动不会加载" }],
        extensionChecks: [
          { path: "D:/ext-a", exists: false },
          { path: "D:/ext-b", exists: false, detail: "not found" },
        ],
      },
    },
    {
      label: "extensions with an installation error",
      profile: base({ runtime: { ...base().runtime, extensionPaths: ["D:/ext"] } }),
      environment: {
        binaryInstalled: true,
        extensionErrors: [{ name: "Store Metadata", detail: "Chrome Web Store metadata cannot be installed" }],
      },
    },
    {
      label: "extension paths that were never verified",
      profile: base({ runtime: { ...base().runtime, extensionPaths: ["D:/ext"] } }),
      environment: { binaryInstalled: true },
    },
    {
      label: "chained proxy whose front proxy fails",
      profile: base({ proxy: { ...plainProxy(), preProxyId: "proxy-front" } }),
      environment: {
        binaryInstalled: true,
        xrayEngine: { installed: false, binaryPath: "/x/xray", preProxy: { id: "proxy-front", ok: false } },
      },
    },
    {
      label: "chained proxy with a resolved front proxy",
      profile: base({ proxy: { ...plainProxy(), preProxyId: "proxy-front" } }),
      environment: {
        binaryInstalled: true,
        xrayEngine: {
          installed: true,
          version: "25.9.1",
          binaryPath: "/x/xray",
          preProxy: { id: "proxy-front", name: "Front", ok: true },
        },
      },
    },
    {
      label: "chained proxy with an unresolved front proxy",
      profile: base({ proxy: { ...plainProxy(), preProxyId: "proxy-front" } }),
      environment: { binaryInstalled: true, xrayEngine: { installed: false, binaryPath: "/x/xray" } },
    },
    {
      label: "native proxy routed through the engine",
      profile: base({ proxy: plainProxy() }),
      environment: { binaryInstalled: true, xrayEngine: { installed: false, binaryPath: "/x/xray" } },
    },
    {
      label: "engine installed without a path",
      profile: base({ proxy: xrayProxy() }),
      environment: { binaryInstalled: true, xrayEngine: { installed: true, version: "25.9.1" } },
    },
    {
      label: "empty start url",
      profile: base({ startUrl: "" }),
      environment: { binaryInstalled: true },
    },
    {
      label: "system start url",
      profile: base({ startUrl: "about:blank" }),
      environment: { binaryInstalled: true },
    },
    {
      label: "unsupported start url protocol",
      profile: base({ startUrl: "ftp://example.com" }),
      environment: { binaryInstalled: true },
    },
    {
      label: "invalid start url",
      profile: base({ startUrl: "example.com" }),
      environment: { binaryInstalled: true },
    },
    {
      label: "invalid viewport",
      profile: base({ viewport: { ...base().viewport, mode: "fixed", width: 100, height: 100 } }),
      environment: { binaryInstalled: true },
    },
  ];
  return scenarios;
}

function collectKeys(text: LocalizedText | undefined, keys: string[]): void {
  if (!text || "text" in text) return;
  keys.push(text.key);
  for (const value of Object.values(text.params ?? {})) {
    if (typeof value === "string" || typeof value === "number") continue;
    if ("region" in value) continue;
    collectKeys(value, keys);
  }
}

/** A translator that also records every key it is asked for. */
function recordingTranslator(locale: Locale): { keys: string[]; t: (key: TranslationKey, params?: Record<string, string | number>) => string } {
  const keys: string[] = [];
  return {
    keys,
    t: (key, params) => {
      keys.push(key);
      return translate(locale, key, params);
    },
  };
}

function collectReportKeys(keys: string[]): void {
  for (const scenario of scenarios()) {
    for (const item of auditProfile(scenario.profile).items) {
      collectKeys(item.title, keys);
      collectKeys(item.detail, keys);
    }
    for (const item of preflightProfile(scenario.profile, scenario.environment).items) {
      collectKeys(item.title, keys);
      collectKeys(item.detail, keys);
      for (const action of item.actions ?? []) collectKeys(action.label, keys);
    }
    for (const entry of profileScore(scenario.profile)) {
      collectKeys(entry.label, keys);
      collectKeys(entry.detail, keys);
    }
    try {
      for (const snippet of generateLaunchSnippets(scenario.profile)) collectKeys(snippet.title, keys);
    } catch {
      // A profile whose launch preview cannot be built has no snippets; the panel renders the
      // `error.config` fallback instead, which is a UI-chrome key of its own.
    }
  }

  const recorder = recordingTranslator("zh-CN");
  const snapshot = createProfileSnapshot(defaultProfile({ id: "profile-snapshot", name: "snapshot" }), recorder.t, "zh-CN");
  snapshotToMarkdown(snapshot, recorder.t);
  keys.push(...recorder.keys);
}

/**
 * The scenario list above is the only thing standing between a builder branch and a missing
 * dictionary entry — `translate()` falls back to the key name, so a typo would render as
 * `profileAudit.foo.title` in the panel instead of failing anything. Comparing the emitted key set
 * with the dictionary in both directions keeps the two in step.
 */
test("every report key the builders can emit exists in both dictionaries", () => {
  const keys: string[] = [];
  collectReportKeys(keys);
  const emitted = [...new Set(keys)].sort();

  for (const key of emitted) {
    assert.ok(key in zhCN, `${key} is emitted but missing from zh-CN`);
    assert.ok(key in enUS, `${key} is emitted but missing from en-US`);
  }

  const dictionaryKeys = Object.keys(zhCN)
    .filter((key) => REPORT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .sort();
  assert.deepEqual(
    emitted.filter((key) => REPORT_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))),
    dictionaryKeys,
    "the scenarios must reach every report key and the dictionaries must not carry orphans",
  );
});

test("report text resolves to the panel's language", async () => {
  await ensureLocaleReady("en-US");

  const profile = base({
    proxy: plainProxy(),
    runtime: { ...base().runtime, watermark: "banner" },
  });
  const report = preflightProfile(profile, {
    binaryInstalled: true,
    networkCheck: healthyNetworkCheck(),
  });
  const networkCheck = report.items.find((item) => item.id === "network-check");
  const proxyConfig = report.items.find((item) => item.id === "proxy-config");
  const audit = auditProfile(profile);
  const watermark = audit.items.find((item) => item.id === "watermark");

  // Region names are formatted at render time, so the same report reads in either language.
  assert.equal(resolveLocalizedText(networkCheck?.detail as LocalizedText, translate.bind(null, "zh-CN"), "zh-CN"), "203.0.113.42 · 美国 (US) · LAX · 88ms");
  assert.equal(resolveLocalizedText(networkCheck?.detail as LocalizedText, translate.bind(null, "en-US"), "en-US"), "203.0.113.42 · United States (US) · LAX · 88ms");
  assert.equal(resolveLocalizedText(proxyConfig?.detail as LocalizedText, translate.bind(null, "en-US"), "en-US"), "Configured http://proxy.example.test:8080.");
  assert.equal(resolveLocalizedText(watermark?.title as LocalizedText, translate.bind(null, "en-US"), "en-US"), "Environment watermark");
  assert.equal(
    resolveLocalizedText(watermark?.detail as LocalizedText, translate.bind(null, "zh-CN"), "zh-CN"),
    "已启用 banner 水印：每个页面都会注入一个可检测的 DOM 节点，可能成为跨环境关联信号。",
  );

  // A role embedded in an engine detail is itself a key, so it follows the same language.
  const engineProfile = base({ proxy: { ...plainProxy(), preProxyId: "proxy-front" } });
  const engineReport = preflightProfile(engineProfile, {
    binaryInstalled: true,
    xrayEngine: { installed: false, binaryPath: "/x/xray" },
  });
  const engine = engineReport.items.find((item) => item.id === "xray-engine");
  assert.equal(
    resolveLocalizedText(engine?.detail as LocalizedText, translate.bind(null, "en-US"), "en-US"),
    "This proxy needs the Xray engine (chained proxy (front proxy → target proxy)), but Xray-core is not installed.",
  );
  assert.equal(
    resolveLocalizedText(engine?.detail as LocalizedText, translate.bind(null, "zh-CN"), "zh-CN"),
    "该代理需要 Xray 引擎中转（链式代理（前置代理 → 目标代理）），但 Xray-core 尚未安装。",
  );
});

test("snapshots freeze the language they were exported in", async () => {
  await ensureLocaleReady("en-US");

  const profile = defaultProfile({ id: "profile-snapshot", name: "Snapshot" });
  const english = createProfileSnapshot(profile, translate.bind(null, "en-US"), "en-US", "2026-09-10T00:00:00.000Z");
  const chinese = createProfileSnapshot(profile, translate.bind(null, "zh-CN"), "zh-CN", "2026-09-10T00:00:00.000Z");

  assert.equal(english.audit.items[0].title, "Persistent profile");
  assert.equal(chinese.audit.items[0].title, "持久化 Profile");
  // No keys survive into the export: a JSON snapshot carries the text of the moment it was taken.
  assert.equal(JSON.stringify(english.audit).includes(".detail."), false);

  const englishMarkdown = snapshotToMarkdown(english, translate.bind(null, "en-US"));
  const chineseMarkdown = snapshotToMarkdown(chinese, translate.bind(null, "zh-CN"));

  assert.match(englishMarkdown, /^# Snapshot audit snapshot$/m);
  assert.match(englishMarkdown, /^## Audit items$/m);
  assert.match(englishMarkdown, /- \[pass\] Persistent profile: Uses a real user data directory/);
  assert.match(chineseMarkdown, /^# Snapshot 体检快照$/m);
  assert.match(chineseMarkdown, /^## 体检项$/m);
  assert.match(chineseMarkdown, /- \[pass\] 持久化 Profile：使用真实用户数据目录/);
});

test("the exit check summary joins only the parts the probe reported", async () => {
  await ensureLocaleReady("en-US");

  const profile = base({ proxy: plainProxy() });
  const detailFor = (networkCheck: ProfilePreflightEnvironment["networkCheck"]) =>
    preflightProfile(profile, { binaryInstalled: true, networkCheck }).items.find((item) => item.id === "network-check")?.detail as LocalizedText;
  const trace = { providerId: "custom", providerName: "Custom", providerUrl: "https://trace.example.test" };
  const checkedAt = "2026-09-10T00:00:00.000Z";

  // A region is optional: without one the IP and the colo must still join with a single separator.
  assert.equal(
    resolveLocalizedText(
      detailFor({ checkedAt, ok: true, ip: "203.0.113.42", trace: { ...trace, colo: "LAX" } }),
      translate.bind(null, "en-US"),
      "en-US",
    ),
    "203.0.113.42 · LAX",
  );
  assert.equal(
    resolveLocalizedText(detailFor({ checkedAt, ok: true, ip: "203.0.113.42" }), translate.bind(null, "zh-CN"), "zh-CN"),
    "203.0.113.42",
  );
  assert.equal(
    resolveLocalizedText(detailFor({ checkedAt, ok: true }), translate.bind(null, "zh-CN"), "zh-CN"),
    "出口检查通过",
  );
  // When the probe reports no usable region code, the raw name keeps its place in the summary — as a
  // `region` param the renderer treats as an opaque string. A blank name must not shadow the trace
  // value behind it: the fallback chain is per-entry, not all-or-nothing.
  assert.equal(
    resolveLocalizedText(detailFor({ checkedAt, ok: true, geo: { countryName: "United States" } }), translate.bind(null, "zh-CN"), "zh-CN"),
    "United States",
  );
  assert.equal(
    resolveLocalizedText(
      detailFor({ checkedAt, ok: true, geo: { countryName: "  " }, trace: { ...trace, loc: "Somewhere" } }),
      translate.bind(null, "zh-CN"),
      "zh-CN",
    ),
    "Somewhere",
  );
});

test("an unknown key falls back to the key name instead of breaking the panel", () => {
  const resolveWithMissingKey = (key: string) => resolveLocalizedText({ key }, translate.bind(null, "en-US"), "en-US");

  assert.equal(resolveWithMissingKey("profileAudit.notAKey.title"), "profileAudit.notAKey.title");
});
