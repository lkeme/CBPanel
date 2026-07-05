import assert from "node:assert/strict";
import test from "node:test";
import {
  DETECTION_TARGETS,
  DEFAULT_START_URL,
  START_URL_PRESETS,
  applyProfilePreset,
  auditProfile,
  buildProxyUrl,
  buildProxyOption,
  buildPlaywrightContextOptions,
  buildLaunchPreview,
  buildSessionLaunchPlan,
  applyProfileConfigShare,
  createProfileConfigShareString,
  createProfileSnapshot,
  defaultProfile,
  effectiveWebrtcIpMode,
  generateLaunchSnippets,
  isRuntimeQuickArgEnabled,
  maskProfileSecrets,
  maskProxyUrl,
  maskProxyUrlForDisplay,
  normalizeProfile,
  parseProfileConfigShareString,
  parseProxyUrlInput,
  parseOptionalJsonObject,
  preflightProfile,
  proxyUrlFromParts,
  setRuntimeQuickArg,
  snapshotToMarkdown,
  updateDetectionCheck,
  validateStartUrl,
} from "./profile";

test("defaultProfile starts on CreepJS for first-run fingerprint inspection", () => {
  assert.equal(defaultProfile().startUrl, DEFAULT_START_URL);
});

test("defaultProfile uses native viewport for new headed profiles", () => {
  const profile = defaultProfile();

  assert.equal(profile.runtime.headless, false);
  assert.equal(profile.viewport.mode, "native");
});

test("start URL presets include the legacy detection targets", () => {
  const urls = START_URL_PRESETS.map((preset) => preset.url);

  assert.equal(urls.includes(DEFAULT_START_URL), true);
  assert.equal(urls.includes("about:blank"), true);
  assert.equal(urls.includes("https://demo.fingerprint.com/playground"), true);
  for (const target of DETECTION_TARGETS) {
    assert.equal(urls.includes(target), true);
  }
});

test("start URL validation allows web URLs and approved system pages only", () => {
  assert.deepEqual(validateStartUrl(""), { ok: true, kind: "empty", value: "" });
  assert.deepEqual(validateStartUrl(" about:blank "), { ok: true, kind: "system", value: "about:blank", protocol: "about:" });
  assert.deepEqual(validateStartUrl("https://example.com/path"), { ok: true, kind: "web", value: "https://example.com/path", protocol: "https:" });

  assert.equal(validateStartUrl("example.com").ok, false);
  assert.equal(validateStartUrl("ftp://example.com").ok, false);
});

test("preflight applies start URL validation rules", () => {
  const blankReport = preflightProfile(defaultProfile({ startUrl: "about:blank" }), { binaryInstalled: true });
  assert.equal(blankReport.items.find((item) => item.id === "start-url")?.severity, "pass");

  const invalidReport = preflightProfile(defaultProfile({ startUrl: "ftp://example.com" }), { binaryInstalled: true });
  const startUrl = invalidReport.items.find((item) => item.id === "start-url");
  assert.equal(startUrl?.severity, "fail");
  assert.equal(startUrl?.actions?.[0]?.target, "runtime");
});

test("normalizeProfile does not let undefined overwrite generated identity", () => {
  const profile = normalizeProfile({
    id: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    name: "Copy",
  });

  assert.equal(profile.name, "Copy");
  assert.match(profile.id, /^profile-/);
  assert.ok(profile.createdAt);
  assert.ok(profile.updatedAt);
});

test("normalizeProfile treats blank ids as missing identity", () => {
  const profile = normalizeProfile({
    id: "   ",
    name: "Blank ID",
  });

  assert.equal(profile.name, "Blank ID");
  assert.match(profile.id, /^profile-/);
});

test("profile config share string round-trips portable config without identity or extension paths", () => {
  const profile = defaultProfile({
    id: "profile-source",
    name: "Shared Template",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
    runtime: {
      ...defaultProfile().runtime,
      extensionPaths: ["D:/extensions/local-only"],
      extraArgs: ["--disable-http2"],
    },
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "proxy.example.test",
      port: "8080",
      username: "alice",
      password: "secret",
    },
  });

  const shareString = createProfileConfigShareString(profile, "2026-06-27T00:00:00.000Z");
  assert.match(shareString, /^CBPANEL_PROFILE_CONFIG_V1\./);

  const parsed = parseProfileConfigShareString(shareString);
  const serialized = JSON.stringify(parsed);
  assert.equal(parsed.kind, "cbpanel.profileConfig");
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.exportedAt, "2026-06-27T00:00:00.000Z");
  assert.equal(parsed.profile.name, "Shared Template");
  assert.equal(parsed.profile.proxy.password, "secret");
  assert.deepEqual(parsed.profile.runtime.extensionPaths, []);
  assert.deepEqual(parsed.profile.runtime.extraArgs, ["--disable-http2"]);
  assert.equal(serialized.includes("profile-source"), false);
  assert.equal(serialized.includes("2026-01-01T00:00:00.000Z"), false);
});

test("profile config share apply keeps current draft identity", () => {
  const current = defaultProfile({
    id: "profile-current",
    name: "Current",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });
  const incoming = parseProfileConfigShareString(createProfileConfigShareString(defaultProfile({
    id: "profile-template",
    name: "Imported Template",
    createdAt: "2025-01-01T00:00:00.000Z",
    group: "Templates",
  })));

  const applied = applyProfileConfigShare(current, incoming);

  assert.equal(applied.id, "profile-current");
  assert.equal(applied.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(applied.name, "Imported Template");
  assert.equal(applied.group, "Templates");
  assert.notEqual(applied.updatedAt, "2026-01-02T00:00:00.000Z");
});

test("profile config share parser rejects invalid clipboard strings", () => {
  assert.throws(
    () => parseProfileConfigShareString("not a cbpanel config"),
    /does not contain a CBPanel profile config string/,
  );
  assert.throws(
    () => parseProfileConfigShareString("CBPANEL_PROFILE_CONFIG_V1.not-base64"),
    /Invalid CBPanel profile config string/,
  );
});

test("normalizeProfile trims and deduplicates tags", () => {
  const profile = normalizeProfile({
    tags: [" qa ", "client-a", "", "qa", " client-a "],
  });

  assert.deepEqual(profile.tags, ["qa", "client-a"]);
});

test("normalizeProfile preserves stored timestamps while hydrating from disk", () => {
  const profile = normalizeProfile({
    ...defaultProfile({ name: "Stored" }),
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-02T00:00:00.000Z",
  });

  assert.equal(profile.createdAt, "2026-01-01T00:00:00.000Z");
  assert.equal(profile.updatedAt, "2026-01-02T00:00:00.000Z");
});

test("normalizeProfile hydrates manual detection checks from current targets", () => {
  const profile = normalizeProfile({
    ...defaultProfile({ name: "Stored" }),
    verification: {
      detectionChecks: [
        {
          target: DETECTION_TARGETS[1],
          status: "pass",
          checkedAt: "2026-05-30T00:00:00.000Z",
          notes: "WebRTC ok",
        },
        {
          target: "https://removed.example.com/",
          status: "fail",
          notes: "old",
        },
      ],
    },
  });

  assert.equal(profile.verification.detectionChecks.length, DETECTION_TARGETS.length);
  assert.deepEqual(
    profile.verification.detectionChecks.map((record) => record.target),
    [...DETECTION_TARGETS],
  );
  assert.equal(profile.verification.detectionChecks[1].status, "pass");
  assert.equal(profile.verification.detectionChecks[1].notes, "WebRTC ok");
  assert.equal(profile.verification.detectionChecks.some((record) => record.target.includes("removed")), false);
});

test("runtime quick args update extraArgs without duplicates", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      extraArgs: ["--foo=bar", "--disable-http2", "--disable-http2", "  "],
    },
  });

  const disabled = setRuntimeQuickArg(profile, "disable-http2", false);
  assert.deepEqual(disabled.runtime.extraArgs, ["--foo=bar"]);
  assert.equal(isRuntimeQuickArgEnabled(disabled, "disable-http2"), false);

  const enabled = setRuntimeQuickArg(disabled, "disable-http2", true);
  const enabledAgain = setRuntimeQuickArg(enabled, "disable-http2", true);

  assert.deepEqual(enabledAgain.runtime.extraArgs, ["--foo=bar", "--disable-http2"]);
  assert.equal(isRuntimeQuickArgEnabled(enabledAgain, "disable-http2"), true);
});

test("manual detection check updates status, notes, and timestamp", () => {
  const checkedAt = "2026-05-30T00:00:00.000Z";
  const profile = updateDetectionCheck(defaultProfile(), DETECTION_TARGETS[0], {
    status: "warn",
    checkedAt,
    notes: "Canvas hash changed",
  });
  const record = profile.verification.detectionChecks[0];

  assert.equal(record.status, "warn");
  assert.equal(record.notes, "Canvas hash changed");
  assert.equal(record.checkedAt, checkedAt);

  const cleared = updateDetectionCheck(profile, DETECTION_TARGETS[0], {
    status: "untested",
    notes: "",
  });

  assert.equal(cleared.verification.detectionChecks[0].status, "untested");
  assert.equal(cleared.verification.detectionChecks[0].checkedAt, undefined);
});

test("persistent launch preview always includes userDataDir", () => {
  const profile = defaultProfile({
    id: "profile-test",
    mode: "persistent",
  });

  const preview = buildLaunchPreview(profile, "D:/profiles/profile-test");

  assert.equal(preview.launcher, "launchPersistentContext");
  assert.equal(preview.options.userDataDir, "D:/profiles/profile-test");
});

test("advanced json options are merged into context launch preview", () => {
  const profile = defaultProfile({
    advanced: {
      launchOptionsJson: '{ "timeout": 60000 }',
      contextOptionsJson: '{ "permissions": ["geolocation"], "locale": "en-US" }',
      humanConfigJson: '{ "typing_delay": 100 }',
    },
  });

  const preview = buildLaunchPreview(profile, "D:/profiles/profile-test");

  assert.deepEqual(preview.options.launchOptions, { chromiumSandbox: true, timeout: 60000 });
  assert.deepEqual(preview.options.humanConfig, { typing_delay: 100 });
  assert.deepEqual(preview.options.contextOptions, { permissions: ["geolocation"], locale: "en-US" });
});

test("launch preview strips unsafe chromium sandbox overrides", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      extraArgs: ["--no-sandbox", "--disable-http2"],
    },
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: '{ "chromiumSandbox": false, "args": ["--no-sandbox", "--remote-debugging-port=0"] }',
    },
  });

  const preview = buildLaunchPreview(profile, "D:/profiles/profile-test");

  assert.ok(Array.isArray(preview.options.args));
  assert.equal((preview.options.args as string[]).includes("--no-sandbox"), false);
  assert.equal((preview.options.args as string[]).includes("--disable-http2"), true);
  assert.deepEqual(preview.options.launchOptions, {
    chromiumSandbox: true,
    args: ["--remote-debugging-port=0"],
  });
  const report = preflightProfile(profile);
  assert.equal(report.items.find((item) => item.id === "chromium-sandbox")?.severity, "warn");
});

test("display proxy mask preserves username without exposing password", () => {
  const masked = maskProxyUrlForDisplay("http://alice:secret@proxy.example.com:8080");

  assert.equal(masked, "http://alice:****@proxy.example.com:8080");
  assert.equal(masked.includes("secret"), false);
});

test("launch proxy mask preserves username without exposing password", () => {
  const masked = maskProxyUrl("http://alice:secret@proxy.example.com:8080");

  assert.equal(masked, "http://alice:****@proxy.example.com:8080");
  assert.equal(masked.includes("secret"), false);
});

test("parseProxyUrlInput reads proxy URL parts", () => {
  assert.deepEqual(parseProxyUrlInput("http://alice:secret@proxy.example.com:8080"), {
    scheme: "http",
    host: "proxy.example.com",
    port: "8080",
    username: "alice",
    password: "secret",
  });

  assert.deepEqual(parseProxyUrlInput("https://proxy.example.com:8443"), {
    scheme: "https",
    host: "proxy.example.com",
    port: "8443",
    username: "",
    password: "",
  });
});

test("parseProxyUrlInput rejects unsupported or incomplete proxy URLs", () => {
  assert.equal(parseProxyUrlInput("ftp://proxy.example.com:21"), undefined);
  assert.equal(parseProxyUrlInput("http://proxy.example.com"), undefined);
  assert.equal(parseProxyUrlInput("socks4://proxy.example.com:1080"), undefined);
  assert.equal(parseProxyUrlInput("socks5h://proxy.example.com:1080"), undefined);
  assert.equal(parseProxyUrlInput(""), undefined);
});

test("proxyUrlFromParts builds canonical proxy URLs", () => {
  assert.equal(
    proxyUrlFromParts({
      scheme: "socks5",
      host: "proxy.example.com",
      port: "1080",
      username: "alice",
      password: "p@ss word",
    }),
    "socks5://alice:p%40ss%20word@proxy.example.com:1080",
  );

  assert.equal(
    proxyUrlFromParts({
      scheme: "https",
      host: "proxy.example.com",
      port: "8443",
      username: "",
      password: "",
    }),
    "https://proxy.example.com:8443",
  );
});

test("runtime proxy option preserves bypass for CloakBrowser launch", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      scheme: "http",
      host: "proxy.example.com",
      port: "8080",
      username: "alice",
      password: "secret",
      bypass: ".google.com,localhost,127.0.0.1",
    },
  });

  const proxyOption = buildProxyOption(profile.proxy);
  const preview = buildLaunchPreview(profile);

  assert.deepEqual(proxyOption, {
    server: "http://proxy.example.com:8080",
    bypass: ".google.com,localhost,127.0.0.1",
    username: "alice",
    password: "secret",
  });
  assert.deepEqual(preview.options.proxy, proxyOption);
  assert.equal(buildProxyUrl(profile.proxy), "http://alice:secret@proxy.example.com:8080");
});

test("runtime proxy option stays string when no bypass or credentials are configured", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      scheme: "https",
      host: "proxy.example.com",
      port: "8443",
      bypass: "",
    },
  });

  assert.equal(buildProxyOption(profile.proxy), "https://proxy.example.com:8443");
  assert.equal(buildLaunchPreview(profile).options.proxy, "https://proxy.example.com:8443");
});

test("launch preview rejects enabled proxies with unsupported schemes", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "socks5h://user:p%40ss@127.0.0.1:1080",
    },
  });

  assert.equal(buildProxyUrl(profile.proxy), undefined);
  assert.throws(() => buildLaunchPreview(profile), /协议不受支持/);

  const report = preflightProfile(profile);
  assert.equal(report.ok, false);
  assert.equal(report.items.find((item) => item.id === "proxy-config")?.severity, "fail");
});

test("maskProfileSecrets removes proxy passwords and advanced secrets for JSON export", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
      host: "proxy.example.com",
      port: "8080",
      username: "alice",
      password: "secret",
    },
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: "{\"token\":\"abc\",\"safe\":true}",
    },
  });

  const masked = JSON.stringify(maskProfileSecrets(profile));

  assert.match(masked, /alice/);
  assert.doesNotMatch(masked, /secret/);
  assert.doesNotMatch(masked, /abc/);
  assert.match(masked, /\*\*\*\*/);
});

test("playwright browser mode keeps context options outside launch options", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      launcher: "playwright-browser",
    },
    viewport: {
      ...defaultProfile().viewport,
      mode: "native",
      userAgent: "Custom UA",
    },
    advanced: {
      ...defaultProfile().advanced,
      contextOptionsJson: '{ "permissions": ["clipboard-read"], "timezoneId": "UTC" }',
    },
  });

  const preview = buildLaunchPreview(profile);
  const contextOptions = buildPlaywrightContextOptions(profile);

  assert.equal(preview.launcher, "launch");
  assert.equal(preview.resultType, "browser");
  assert.equal("contextOptions" in preview.options, false);
  assert.equal(contextOptions.viewport, null);
  assert.equal(contextOptions.userAgent, "Custom UA");
  assert.deepEqual(contextOptions.permissions, ["clipboard-read"]);
  assert.equal("timezoneId" in contextOptions, false);
});

test("session launch plan exposes runtime diagnostics without proxy secrets", () => {
  const profile = defaultProfile({
    id: "profile-session",
    mode: "persistent",
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
    },
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
  });

  const plan = buildSessionLaunchPlan(profile, "D:/profiles/profile-session");

  assert.equal(plan.profileMode, "persistent");
  assert.equal(plan.runtimeLauncher, "playwright-context");
  assert.equal(plan.sdkLauncher, "launchPersistentContext");
  assert.equal(plan.userDataDir, "D:/profiles/profile-session");
  assert.equal(plan.proxy, "http://alice:****@proxy.example.com:8080");
  assert.equal(JSON.stringify(plan).includes("secret"), false);
  assert.equal(plan.geoip, true);
});

test("invalid advanced json fails before launch", () => {
  assert.throws(() => parseOptionalJsonObject("humanConfig", "[]"), /必须是 JSON 对象/);
  assert.throws(() => parseOptionalJsonObject("launchOptions", "{"), /不是有效 JSON/);
});

test("profile audit reports risky runtime settings without throwing", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      stealthArgs: false,
      extraArgs: [],
    },
    advanced: {
      ...defaultProfile().advanced,
      humanConfigJson: "[1]",
    },
  });

  const report = auditProfile(profile);

  assert.ok(report.score < 100);
  assert.ok(report.summary.fail >= 2);
  assert.equal(report.items.find((item) => item.id === "stealth-args-disabled")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "human-json")?.severity, "fail");
});

test("profile audit accepts valid advanced json", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "socks5://proxy.example.com:1080",
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      webrtcIp: "auto",
    },
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: '{ "timeout": 60000 }',
      contextOptionsJson: '{ "permissions": ["geolocation"] }',
      humanConfigJson: '{ "typing_delay": 90 }',
    },
  });

  const report = auditProfile(profile);

  assert.equal(report.summary.fail, 0);
  assert.equal(report.items.find((item) => item.id === "launch-json")?.severity, "pass");
  assert.equal(report.items.find((item) => item.id === "context-json")?.severity, "pass");
  assert.equal(report.items.find((item) => item.id === "human-json")?.severity, "pass");
});

test("profile preflight fails invalid launch json before startup", () => {
  const profile = defaultProfile({
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: "{",
    },
  });

  const report = preflightProfile(profile, {
    binaryInstalled: true,
    userDataDir: "D:/profiles/profile-test",
    userDataDirWritable: true,
    networkCheck: {
      checkedAt: "2026-06-03T00:00:00.000Z",
      ok: true,
      ip: "203.0.113.42",
      source: "environment-check",
    },
  });

  assert.equal(report.ok, false);
  assert.equal(report.items.find((item) => item.id === "launch-json")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "launch-preview")?.severity, "fail");
});

test("profile preflight includes environment failures without launching", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "",
      port: "",
    },
    runtime: {
      ...defaultProfile().runtime,
      extensionPaths: ["D:/missing-extension"],
    },
  });

  const report = preflightProfile(profile, {
    binaryInstalled: false,
    binaryPath: "D:/cloak/chrome.exe",
    userDataDir: "D:/profiles/profile-test",
    userDataDirWritable: false,
    userDataDirDetail: "access denied",
    extensionChecks: [{ path: "D:/missing-extension", exists: false, detail: "not found" }],
  });

  assert.equal(report.ok, false);
  assert.equal(report.items.find((item) => item.id === "binary")?.severity, "fail");
  assert.deepEqual(report.items.find((item) => item.id === "binary")?.actions?.[0], {
    id: "install-binary",
    kind: "install-binary",
    label: "安装内核",
  });
  assert.equal(report.items.find((item) => item.id === "user-data-dir")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "proxy-config")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "proxy-config")?.actions?.[0]?.target, "proxy");
  assert.equal(report.items.find((item) => item.id === "extension-D:/missing-extension")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "extension-D:/missing-extension")?.actions?.[0]?.target, "advanced");
});

test("profile preflight reports registry extension installation failures", () => {
  const profile = defaultProfile({ name: "Extension Fail" });
  const report = preflightProfile(profile, {
    extensionErrors: [{ name: "Store Metadata", detail: "Chrome Web Store metadata cannot be installed without a verified asset" }],
  });

  const item = report.items.find((entry) => entry.id === "extension-error-0");
  assert.equal(item?.severity, "fail");
  assert.match(item?.detail ?? "", /Store Metadata/);
  assert.equal(report.ok, false);
});

test("profile preflight masks proxy credentials in report and preview", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
    },
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
  });

  const report = preflightProfile(profile, {
    binaryInstalled: true,
    userDataDir: "D:/profiles/profile-test",
    userDataDirWritable: true,
  });
  const serialized = JSON.stringify(report);

  assert.equal(report.ok, true);
  assert.equal(report.launch?.proxy, "http://alice:****@proxy.example.com:8080");
  assert.equal(serialized.includes("secret"), false);
  assert.match(serialized, /"username":"alice"/);
  assert.match(serialized, /"password":"\*\*\*\*"/);
});

test("profile preflight reports proxy exit trace checks", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
    },
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
  });

  const withoutCheck = preflightProfile(profile, {
    binaryInstalled: true,
  });
  assert.equal(withoutCheck.items.find((item) => item.id === "network-check")?.severity, "warn");
  assert.equal(withoutCheck.items.some((item) => item.id === "geoip-database"), false);

  const withCheck = preflightProfile(profile, {
    networkCheck: {
      checkedAt: "2026-06-03T00:00:00.000Z",
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
    },
  });
  assert.equal(withCheck.items.find((item) => item.id === "network-check")?.severity, "pass");
  const networkCheckDetail = withCheck.items.find((item) => item.id === "network-check")?.detail ?? "";
  assert.match(networkCheckDetail, /203\.0\.113\.42/);
  assert.match(networkCheckDetail, /US/);
  assert.match(networkCheckDetail, /LAX/);
  assert.doesNotMatch(networkCheckDetail, /Cloudflare/);
  assert.equal(withCheck.items.some((item) => item.id === "geoip-database"), false);
});

test("profile preflight warns when explicit timezone or locale overrides GeoIP", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "proxy.example.test",
      port: "8080",
    },
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  });

  const report = preflightProfile(profile, {
    networkCheck: {
      checkedAt: "2026-06-03T00:00:00.000Z",
      ok: true,
      ip: "203.0.113.42",
      source: "environment-check",
    },
  });

  const item = report.items.find((entry) => entry.id === "geoip-explicit-overrides");
  assert.equal(item?.severity, "warn");
  assert.equal(item?.actions?.[0]?.target, "fingerprint");
});

test("geoip proxy makes WebRTC effectively protected without persisting an explicit WebRTC flag", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "proxy.example.test",
      port: "8080",
    },
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      webrtcIp: "off",
      webrtcIpValue: "",
    },
  });

  assert.equal(effectiveWebrtcIpMode(profile), "geoip");

  const audit = auditProfile(profile);
  const webrtc = audit.items.find((item) => item.id === "webrtc");
  assert.equal(webrtc?.severity, "pass");
  assert.match(webrtc?.detail ?? "", /GeoIP/);

  const report = preflightProfile(profile, { binaryInstalled: true });
  assert.equal(report.items.find((item) => item.id === "webrtc-geoip-effective")?.severity, "pass");
  assert.equal(report.items.some((item) => item.id === "webrtc-auto-without-network-anchor"), false);
  assert.equal(report.items.some((item) => item.id === "webrtc-custom-empty"), false);
});

test("profile snapshot masks proxy credentials and sensitive launch options", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
    },
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: '{ "password": "secret", "nested": { "apiToken": "token" } }',
    },
  });

  const snapshot = createProfileSnapshot(profile, "2026-05-30T00:00:00.000Z");
  const serialized = JSON.stringify(snapshot);
  const markdown = snapshotToMarkdown(snapshot);

  assert.equal(snapshot.profile.proxy, "http://alice:****@proxy.example.com:8080");
  assert.equal((snapshot.launchPreview.options.launchOptions as { password: string }).password, "****");
  assert.equal(
    ((snapshot.launchPreview.options.launchOptions as { nested: { apiToken: string } }).nested.apiToken),
    "****",
  );
  assert.equal(serialized.includes("alice:secret"), false);
  assert.equal(serialized.includes("\"password\":\"secret\""), false);
  assert.equal(snapshot.launchCode.includes("secret"), false);
  assert.equal(snapshot.launchCode.includes("token"), false);
  assert.equal(markdown.includes("alice:secret"), false);
  assert.match(markdown, /体检快照/);
});

test("launch snippets include masked launch preview and binary utilities", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
    },
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: '{ "password": "secret", "nested": { "apiToken": "token" } }',
    },
  });

  const snippets = generateLaunchSnippets(profile);
  const serialized = JSON.stringify(snippets);
  const previewSnippet = snippets.find((snippet) => snippet.id === "launch-preview-json");
  assert.ok(previewSnippet);
  const preview = JSON.parse(previewSnippet.code);

  assert.deepEqual(
    snippets.map((snippet) => snippet.id),
    ["current-launch", "launch-preview-json", "binary-tools"],
  );
  assert.equal(serialized.includes("secret"), false);
  assert.equal(serialized.includes("token"), false);
  assert.deepEqual(preview.options.proxy, {
    server: "http://proxy.example.com:8080",
    bypass: "localhost,127.0.0.1",
    username: "alice",
    password: "****",
  });
  assert.ok(snippets.find((snippet) => snippet.id === "binary-tools")?.code.includes("ensureBinary"));
});

test("residential proxy preset preserves existing proxy credentials", () => {
  const profile = defaultProfile({
    tags: ["qa", "custom-a"],
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "proxy.example.com",
      port: "8080",
      username: "alice",
      password: "secret",
    },
  });

  const next = applyProfilePreset(profile, "residential-proxy");

  assert.equal(next.group, "代理");
  assert.equal(next.proxy.enabled, true);
  assert.equal(next.proxy.host, "proxy.example.com");
  assert.equal(next.proxy.port, "8080");
  assert.equal(next.proxy.username, "alice");
  assert.equal(next.proxy.password, "secret");
  assert.equal(next.runtime.geoip, true);
  assert.equal(next.fingerprint.webrtcIp, "auto");
  assert.deepEqual(next.tags, ["custom-a", "proxy", "geoip"]);
});

test("profile presets replace preset-owned tags while preserving user tags", () => {
  const profile = defaultProfile({
    tags: ["client-a", "local", "qa", "client-a"],
  });

  const next = applyProfilePreset(profile, "residential-proxy");

  assert.deepEqual(next.tags, ["client-a", "proxy", "geoip"]);
});

test("switching profile presets does not accumulate stale preset tags", () => {
  const base = defaultProfile({
    tags: ["client-a"],
  });

  const proxy = applyProfilePreset(base, "residential-proxy");
  const throwaway = applyProfilePreset(proxy, "throwaway-session");
  const returning = applyProfilePreset(throwaway, "returning-session");

  assert.deepEqual(proxy.tags, ["client-a", "proxy", "geoip"]);
  assert.deepEqual(throwaway.tags, ["client-a", "ephemeral", "throwaway"]);
  assert.deepEqual(returning.tags, ["client-a", "persistent", "returning"]);
});

test("returning and throwaway presets set lifecycle defaults", () => {
  const returning = applyProfilePreset(defaultProfile(), "returning-session");
  const throwaway = applyProfilePreset(defaultProfile(), "throwaway-session");

  assert.equal(returning.mode, "persistent");
  assert.equal(returning.startUrl, DEFAULT_START_URL);
  assert.equal(returning.runtime.humanPreset, "careful");
  assert.ok(returning.fingerprint.seed);
  assert.equal(throwaway.mode, "ephemeral");
  assert.equal(throwaway.startUrl, DEFAULT_START_URL);
  assert.equal(throwaway.runtime.headless, true);
  assert.equal(throwaway.runtime.humanize, false);
  assert.equal(throwaway.viewport.mode, "native");
  assert.equal(throwaway.fingerprint.seed, "");
});
