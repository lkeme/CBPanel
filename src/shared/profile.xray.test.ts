import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLaunchPreview,
  buildProxyOption,
  buildProxyUrl,
  buildSessionLaunchPlan,
  defaultProfile,
  describeXrayProxy,
  maskProfileSecrets,
  normalizeProfile,
  normalizeProxySettings,
  normalizeXrayIpStrategy,
  parseProxyUrlInput,
  preflightProfile,
  proxyRequiresXray,
  proxyUrlFromParts,
  proxyUsesXray,
  withLocalXrayProxy,
  type ProxySettings,
} from "./profile";
import { mergeSettings, normalizeSettings } from "./settings";
import { rewriteGithubDownloadUrl } from "./githubMirror";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_LINK = `vless://${UUID}@node.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=www.microsoft.com&type=tcp#Node`;

function xrayProxy(patch: Partial<ProxySettings> = {}): ProxySettings {
  return { ...defaultProfile().proxy, enabled: true, scheme: "xray", shareLink: VLESS_LINK, ...patch };
}

test("defaultProfile carries the engine fields with safe defaults", () => {
  const proxy = defaultProfile().proxy;
  assert.equal(proxy.shareLink, "");
  assert.equal(proxy.preProxyId, "");
  assert.equal(proxy.ipStrategy, "auto");
  // Profiles stored before the fields existed normalize onto the same defaults.
  const legacy = normalizeProfile({
    proxy: { enabled: true, raw: "", scheme: "socks5", host: "10.0.0.1", port: "1080", username: "", password: "", bypass: "" } as unknown as ProxySettings,
  });
  assert.equal(legacy.proxy.shareLink, "");
  assert.equal(legacy.proxy.preProxyId, "");
  assert.equal(legacy.proxy.ipStrategy, "auto");
});

test("normalizeProxySettings projects an xray link onto host/port and drops URL credentials", () => {
  const normalized = normalizeProxySettings(xrayProxy({ host: "stale", port: "1", username: "u", password: "p", raw: "http://x:1", ipStrategy: "ipv6-only" }));
  assert.equal(normalized.host, "node.example.com");
  assert.equal(normalized.port, "443");
  assert.equal(normalized.username, "");
  assert.equal(normalized.password, "");
  assert.equal(normalized.raw, "");
  assert.equal(normalized.ipStrategy, "ipv6-only");
  assert.equal(normalizeXrayIpStrategy("bogus"), "auto");
  assert.equal(normalizeXrayIpStrategy("ipv4-first"), "ipv4-first");
  // An unparsable link keeps whatever the operator typed so the editor can show it back.
  const broken = normalizeProxySettings(xrayProxy({ shareLink: "vless://nope", host: "typed" }));
  assert.equal(broken.host, "typed");
  assert.equal(broken.shareLink, "vless://nope");
});

test("buildProxyUrl answers xray:// for a parsable node and nothing for a broken one", () => {
  assert.equal(buildProxyUrl(xrayProxy()), "xray://node.example.com:443");
  assert.equal(buildProxyUrl(xrayProxy({ shareLink: `vless://${UUID}@[2001:db8::1]:8443` })), "xray://[2001:db8::1]:8443");
  assert.equal(buildProxyUrl(xrayProxy({ shareLink: "vless://nope" })), undefined);
  assert.equal(buildProxyUrl(xrayProxy({ enabled: false })), undefined);
  // `raw` never overrides the link for an xray proxy.
  assert.equal(buildProxyUrl(xrayProxy({ raw: "http://other.example.com:8080" })), "xray://node.example.com:443");
  assert.equal(proxyUrlFromParts({ scheme: "xray", host: "node.example.com", port: "443", username: "u", password: "p" }), "xray://node.example.com:443");
  assert.deepEqual(parseProxyUrlInput("xray://node.example.com:443"), { scheme: "xray", host: "node.example.com", port: "443", username: "", password: "" });
  assert.deepEqual(buildProxyOption(xrayProxy({ bypass: "" })), "xray://node.example.com:443");
});

test("proxyRequiresXray covers share-link nodes and chained plain proxies", () => {
  assert.equal(proxyRequiresXray(xrayProxy()), true);
  assert.equal(proxyRequiresXray(xrayProxy({ enabled: false })), false);
  const plain = { ...defaultProfile().proxy, enabled: true, scheme: "socks5" as const, host: "10.0.0.1", port: "1080" };
  assert.equal(proxyRequiresXray(plain), false);
  assert.equal(proxyRequiresXray({ ...plain, preProxyId: "proxy-front" }), true);
  assert.equal(proxyRequiresXray({ ...plain, preProxyId: "  " }), false);
});

test("proxyUsesXray applies the native-routing setting on top of the hard requirements", () => {
  const plain = { ...defaultProfile().proxy, enabled: true, scheme: "socks5" as const, host: "10.0.0.1", port: "1080" };
  assert.equal(proxyUsesXray(plain, { nativeProxyRouting: "auto", engineInstalled: true }), true);
  assert.equal(proxyUsesXray(plain, { nativeProxyRouting: "auto", engineInstalled: false }), false);
  assert.equal(proxyUsesXray(plain, { nativeProxyRouting: "always", engineInstalled: false }), true);
  assert.equal(proxyUsesXray(plain, { nativeProxyRouting: "never", engineInstalled: true }), false);
  assert.equal(proxyUsesXray({ ...plain, enabled: false }, { nativeProxyRouting: "always", engineInstalled: true }), false);
  // Nodes and chains never depend on the setting.
  assert.equal(proxyUsesXray(xrayProxy(), { nativeProxyRouting: "never", engineInstalled: false }), true);
  assert.equal(proxyUsesXray({ ...plain, preProxyId: "front" }, { nativeProxyRouting: "never", engineInstalled: false }), true);
  assert.equal(normalizeSettings({ xray: { nativeProxyRouting: "bogus" as never } }).xray.nativeProxyRouting, "auto");
  assert.equal(normalizeSettings({ xray: { nativeProxyRouting: "never" } }).xray.nativeProxyRouting, "never");
});

test("preflight reports the engine for a plain proxy when the environment says it is routed through it", () => {
  const plain = defaultProfile({
    proxy: { ...defaultProfile().proxy, enabled: true, scheme: "socks5", host: "10.0.0.1", port: "1080" },
  });
  const direct = preflightProfile(plain, { binaryInstalled: true });
  assert.equal(direct.items.some((item) => item.id === "xray-engine"), false);
  const routed = preflightProfile(plain, { binaryInstalled: true, xrayEngine: { installed: false, binaryPath: "/x/xray" } });
  const engine = routed.items.find((item) => item.id === "xray-engine");
  assert.equal(engine?.severity, "fail");
  assert.match(engine?.detail ?? "", /原生代理经引擎中转/);
});

test("withLocalXrayProxy points the profile at the engine's inbound and keeps the bypass list", () => {
  const profile = defaultProfile({ id: "p1", proxy: xrayProxy({ bypass: "localhost,.corp", preProxyId: "front" }) });
  const local = withLocalXrayProxy(profile, 41234);
  assert.deepEqual(local.proxy, {
    enabled: true,
    raw: "",
    scheme: "socks5",
    host: "127.0.0.1",
    port: "41234",
    username: "",
    password: "",
    bypass: "localhost,.corp",
    shareLink: "",
    preProxyId: "",
    ipStrategy: "auto",
  });
  assert.equal(profile.proxy.scheme, "xray");
  assert.equal(buildProxyUrl(local.proxy), "socks5://127.0.0.1:41234");
  const preview = buildLaunchPreview(local);
  assert.deepEqual(preview.options.proxy, { server: "socks5://127.0.0.1:41234", bypass: "localhost,.corp" });
});

test("maskProfileSecrets hides the share link and the description stays credential-free", () => {
  const masked = maskProfileSecrets(defaultProfile({ proxy: xrayProxy() }));
  assert.equal(masked.proxy.shareLink, "vless://****@node.example.com:443#Node");
  assert.equal(masked.proxy.shareLink.includes(UUID), false);
  assert.equal(describeXrayProxy(xrayProxy()), "vless · tcp+reality · reality www.microsoft.com");
  assert.equal(describeXrayProxy({ scheme: "socks5", shareLink: "" }), undefined);
});

test("launch preview and preflight explain an unparsable node instead of a generic proxy error", () => {
  const broken = defaultProfile({ proxy: xrayProxy({ shareLink: "vless://nope" }) });
  assert.throws(() => buildLaunchPreview(broken), /Xray 分享链接无法解析/);
  const report = preflightProfile(broken, { binaryInstalled: true });
  const item = report.items.find((candidate) => candidate.id === "proxy-config");
  assert.equal(item?.severity, "fail");
  assert.match(item?.detail ?? "", /Xray 分享链接无法解析/);

  const healthy = defaultProfile({ proxy: xrayProxy() });
  const plan = buildSessionLaunchPlan(healthy);
  assert.equal(plan.proxy, "xray://node.example.com:443");
  const healthyReport = preflightProfile(healthy, { binaryInstalled: true, xrayEngine: { installed: true, version: "25.9.1", binaryPath: "/x/xray" } });
  assert.equal(healthyReport.items.find((candidate) => candidate.id === "proxy-config")?.severity, "pass");
  assert.match(healthyReport.items.find((candidate) => candidate.id === "proxy-config")?.detail ?? "", /vless · tcp\+reality/);
  const engine = healthyReport.items.find((candidate) => candidate.id === "xray-engine");
  assert.equal(engine?.severity, "pass");
  assert.match(engine?.detail ?? "", /25\.9\.1/);
  // Without engine information the item is informational, never a failure the operator cannot act on.
  const unknown = preflightProfile(healthy, { binaryInstalled: true });
  assert.equal(unknown.items.find((candidate) => candidate.id === "xray-engine")?.severity, "info");
});

test("settings normalize and merge the Xray section", () => {
  const defaults = normalizeSettings();
  assert.deepEqual(defaults.xray, {
    customBinaryPath: "",
    nativeProxyRouting: "auto",
    logLevel: "warning",
    utlsFingerprint: "auto",
    autoRestart: true,
    checkForUpdatesOnStartup: false,
    lastUpdateCheck: undefined,
  });
  const normalized = normalizeSettings({
    xray: {
      customBinaryPath: "  /opt/xray/xray  ",
      logLevel: "debug",
      utlsFingerprint: "nope" as never,
      autoRestart: false,
      lastUpdateCheck: { checkedAt: "2026-09-06T00:00:00.000Z", latestVersion: "25.9.1", updateAvailable: true, downloadUrl: "https://example.test/x.zip" },
    },
  });
  assert.equal(normalized.xray.customBinaryPath, "/opt/xray/xray");
  assert.equal(normalized.xray.logLevel, "debug");
  assert.equal(normalized.xray.utlsFingerprint, "auto");
  assert.equal(normalized.xray.autoRestart, false);
  assert.deepEqual(normalized.xray.lastUpdateCheck, {
    checkedAt: "2026-09-06T00:00:00.000Z",
    currentVersion: undefined,
    latestVersion: "25.9.1",
    updateAvailable: true,
    downloadUrl: "https://example.test/x.zip",
    error: undefined,
  });
  assert.equal(normalizeSettings({ xray: { lastUpdateCheck: { checkedAt: "" } as never } }).xray.lastUpdateCheck, undefined);
  const merged = mergeSettings(normalized, { xray: { logLevel: "none" } });
  assert.equal(merged.xray.logLevel, "none");
  assert.equal(merged.xray.customBinaryPath, "/opt/xray/xray");
});

test("the GitHub mirror rewrites Xray-core release downloads and nothing else from that repository", () => {
  const rewrite = rewriteGithubDownloadUrl(
    "https://github.com/XTLS/Xray-core/releases/download/v25.9.1/Xray-linux-64.zip",
    "https://gh-proxy.com/",
  );
  assert.equal(rewrite?.kind, "xray-core");
  assert.equal(rewrite?.rewrittenUrl, "https://gh-proxy.com/https://github.com/XTLS/Xray-core/releases/download/v25.9.1/Xray-linux-64.zip");
  assert.equal(
    rewriteGithubDownloadUrl("https://github.com/XTLS/Xray-core/releases/download/v25.9.1/Xray-linux-64.zip.dgst", "https://gh-proxy.com/")?.kind,
    "xray-core",
  );
  assert.equal(rewriteGithubDownloadUrl("https://github.com/XTLS/Xray-core/archive/main.zip", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://github.com/XTLS/Xray-core/releases/download/v25.9.1/Xray-linux-64.zip", undefined), undefined);
});
