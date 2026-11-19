import assert from "node:assert/strict";
import test from "node:test";
import {
  DETECTION_TARGETS,
  DEFAULT_START_URL,
  START_URL_PRESETS,
  RUNTIME_QUICK_ARGS,
  applyProfilePreset,
  auditProfile,
  buildProxyUrl,
  buildProxyOption,
  buildLaunchPreview,
  buildEffectiveArgPreview,
  buildSessionLaunchPlan,
  validWebrtcIp,
  applyProfileConfigShare,
  createProfileConfigShareString,
  createProfileSnapshot,
  defaultProfile,
  effectiveWebrtcIpMode,
  generateLaunchCode,
  generateLaunchSnippets,
  isPortableCookiesEnabled,
  isRuntimeQuickArgEnabled,
  isEnhancedProxyEnabled,
  maskProfileSecrets,
  maskProxyUrl,
  maskProxyUrlForDisplay,
  mergeProfile,
  normalizeProfile,
  parseProfileConfigShareString,
  parseProxyUrlInput,
  parseOptionalJsonObject,
  preflightProfile,
  proxyUrlFromParts,
  setPortableCookies,
  setRuntimeQuickArg,
  setEnhancedProxy,
  snapshotToMarkdown,
  updateDetectionCheck,
  validateStartUrl,
  viewportRewritesScreen,
} from "./profile";
import type { BrowserProfile, LocalizedText } from "./profile";
import { buildWatermarkScript } from "./watermark";
import { buildVoicesScript, voicesSeed } from "./voices";
import { translate } from "../i18n";
import type { TranslationKey } from "../i18n";

const tZh = (key: TranslationKey, params?: Record<string, string | number>) => translate("zh-CN", key, params);

/** The dictionary key an item's text resolves to, or undefined for the external-message arm. */
function textKey(text: LocalizedText | undefined): string | undefined {
  return text && "key" in text ? text.key : undefined;
}

function textParams(text: LocalizedText | undefined): Record<string, unknown> | undefined {
  return text && "key" in text ? text.params : undefined;
}

test("defaultProfile starts on CreepJS for first-run fingerprint inspection", () => {
  assert.equal(defaultProfile().startUrl, DEFAULT_START_URL);
});

test("defaultProfile uses native viewport for new headed profiles", () => {
  const profile = defaultProfile();

  assert.equal(profile.runtime.headless, false);
  assert.equal(profile.viewport.mode, "native");
});

test("geoip is on for new profiles while stored opt-outs survive rehydration", () => {
  assert.equal(defaultProfile().runtime.geoip, true);

  // Stored rows always carry runtime.geoip, and mergeProfile only drops undefined, so a persisted
  // false must never be flipped by the new default — neither on load nor on a partial update.
  const stored = {
    ...defaultProfile({ name: "Stored" }),
    runtime: { ...defaultProfile().runtime, geoip: false },
  };
  const partialRuntimePatch = { ...stored.runtime, geoip: undefined } as unknown as BrowserProfile["runtime"];

  assert.equal(normalizeProfile(stored).runtime.geoip, false);
  assert.equal(mergeProfile(stored, { name: "Renamed" }).runtime.geoip, false);
  assert.equal(mergeProfile(stored, { runtime: partialRuntimePatch }).runtime.geoip, false);

  // Only sources that omit the field entirely (share strings, old backups) land on the new default.
  assert.equal(normalizeProfile({ name: "Field missing" }).runtime.geoip, true);
});

// Why the fingerprint editor leaves timezone and locale editable while GeoIP is on: an explicit value is
// a supported configuration, not a state that has to be unlocked first. Both are forwarded next to
// geoip=true and CloakBrowser lets the explicit one win. Disabling the inputs whenever GeoIP was deriving
// them deadlocked a new profile — GeoIP on and both fields empty — because only a value could have
// re-enabled them.
test("an explicit timezone or locale ships alongside geoip so it can win over the derived value", () => {
  const explicit = buildLaunchPreview(defaultProfile({
    fingerprint: {
      ...defaultProfile().fingerprint,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  }));

  assert.equal(explicit.options.geoip, true);
  assert.equal(explicit.options.timezone, "Asia/Shanghai");
  assert.equal(explicit.options.locale, "zh-CN");

  // The other half of the same rule: left empty, neither option is sent at all, so nothing competes with
  // the derivation and the placeholder that names GeoIP as the source is telling the truth.
  const derived = buildLaunchPreview(defaultProfile());

  assert.equal(derived.options.geoip, true);
  assert.equal("timezone" in derived.options, false);
  assert.equal("locale" in derived.options, false);
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

test("the launch plan reports the profile's own headless value", () => {
  const base = defaultProfile();
  assert.equal(buildSessionLaunchPlan(base).headless, false);
  // launchOptions can no longer turn a launch headless, so the plan and the audit have one source.
  const audit = auditProfile(base).items.find((item) => item.id === "headless");
  assert.equal(audit?.severity, "pass");
  assert.equal(textKey(audit?.detail), "profileAudit.headless.detail.headed");
});

test("documented numeric and format flags are validated before launch", () => {
  const base = defaultProfile();
  const cases = [
    { patch: { storageQuotaMb: "-1" }, id: "numeric-storageQuotaMb", target: "fingerprint" },
    { patch: { webrtcIp: "custom", webrtcIpValue: "example.com" }, id: "webrtc-ip-format", target: "fingerprint" },
    { patch: { timezone: "Asia Shanghai" }, id: "timezone-format", target: "fingerprint" },
    { patch: { locale: "not a tag" }, id: "locale-format", target: "fingerprint" },
  ] as const;

  for (const item of cases) {
    const profile = defaultProfile({ fingerprint: { ...base.fingerprint, ...item.patch } });
    assert.throws(() => buildLaunchPreview(profile), `${item.id} must block the launch`);
    const preflight = preflightProfile(profile).items.find((entry) => entry.id === item.id);
    assert.equal(preflight?.severity, "fail", item.id);
    assert.equal(preflight?.actions?.[0]?.target, item.target, item.id);
  }

  // Valid values stay silent.
  const valid = defaultProfile({
    fingerprint: {
      ...base.fingerprint,
      storageQuotaMb: "10240",
      webrtcIp: "custom",
      webrtcIpValue: "203.0.113.9",
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
    },
  });
  assert.doesNotThrow(() => buildLaunchPreview(valid));
  for (const id of ["numeric-storageQuotaMb", "webrtc-ip-format", "timezone-format", "locale-format"]) {
    assert.equal(preflightProfile(valid).items.some((entry) => entry.id === id), false, id);
  }
});

test("WebRTC custom IP accepts IPv4 and IPv6 literals only", () => {
  for (const value of ["203.0.113.9", "2001:db8::1", "[2001:db8::1]"]) {
    assert.equal(validWebrtcIp(value), true, value);
  }
  for (const value of ["", "example.com", "203.0.113.999", "1.2.3", "fe80::1%eth0", "not-an-ip"]) {
    assert.equal(validWebrtcIp(value), false, value);
  }
});

test("the 156+ gate reports fingerprint flags an older core ignores", () => {
  const base = defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, maxTouchPoints: "10" },
    runtime: { ...defaultProfile().runtime, searchEngine: "duckduckgo" },
  });

  // An unknown host platform keeps the stricter floor: only Linux is documented lower.
  const old = preflightProfile(base, { browserVersion: "155.0.8059.39.2" }).items.find((item) => item.id === "version-gated-flags");
  assert.equal(old?.severity, "warn");
  assert.deepEqual(textParams(old?.detail)?.flags, "--fingerprint-max-touch-points, --fingerprint-search-engine");

  // 156+ and an unknown version both stay silent: the flag may well apply, so guessing would be noise.
  for (const browserVersion of ["156.0.8123.10.1", undefined]) {
    assert.equal(
      preflightProfile(base, { browserVersion }).items.some((item) => item.id === "version-gated-flags"),
      false,
      String(browserVersion),
    );
  }
});

test("the search-engine floor is lower on Linux and the touch-point floor is not", () => {
  const searchOnly = defaultProfile({ runtime: { ...defaultProfile().runtime, searchEngine: "duckduckgo" } });
  const flagsFor = (browserVersion: string, hostPlatform: "linux" | "windows" | "macos" | "unknown") =>
    textParams(preflightProfile(searchOnly, { browserVersion, hostPlatform }).items.find((item) => item.id === "version-gated-flags")?.detail)?.flags;

  // "155.0.8059.39.2+ on Linux, 156+ on all platforms" is the documented split.
  assert.equal(flagsFor("155.0.8059.39.2", "linux"), undefined);
  assert.equal(flagsFor("155.0.8059.39.1", "linux"), "--fingerprint-search-engine");
  assert.equal(flagsFor("155.0.8059.39.2", "windows"), "--fingerprint-search-engine");
  assert.equal(flagsFor("156.0.0.0", "linux"), undefined);

  // Touch points have one floor for every platform, so Linux does not lower it.
  const touchOnly = defaultProfile({ fingerprint: { ...defaultProfile().fingerprint, maxTouchPoints: "10" } });
  assert.equal(
    textParams(preflightProfile(touchOnly, { browserVersion: "155.0.8059.39.2", hostPlatform: "linux" }).items.find((item) => item.id === "version-gated-flags")?.detail)?.flags,
    "--fingerprint-max-touch-points",
  );
});

test("the effective argv merges two sources, keeps one row per flag and names the winner", () => {
  const base = defaultProfile();
  const profile = defaultProfile({
    fingerprint: { ...base.fingerprint, seed: "42069", maxTouchPoints: "5" },
    runtime: { ...base.runtime, extraArgs: ["--fingerprint=12345", "--disable-http2"] },
  });

  const preview = buildEffectiveArgPreview(profile);
  const occurrences = (key: string) => preview.argv.filter((arg) => arg.split("=", 1)[0] === key);

  // A later occurrence of the same flag wins, so the preview shows exactly one row for each.
  assert.deepEqual(occurrences("--fingerprint"), ["--fingerprint=12345"]);
  assert.deepEqual(occurrences("--disable-http2"), ["--disable-http2"]);
  assert.equal(preview.sources["--fingerprint"], "chromium-args");
  assert.equal(preview.sources["--disable-http2"], "chromium-args");
  // Generated flags that nothing overrides still name the panel as their source.
  assert.equal(preview.sources["--fingerprint-max-touch-points"], "generated");
  assert.ok(preview.argv.includes("--fingerprint-max-touch-points=5"));

  // The preflight report carries the same projection so the panel can render it read-only.
  assert.deepEqual(preflightProfile(profile).argPreview, preview);
});

test("the preflight names host font gaps, a macOS persona and a missed portable-cookies window", () => {
  const base = defaultProfile();

  const fonts = preflightProfile(base, { fontCheck: { missing: ["Noto Color Emoji"] } })
    .items.find((item) => item.id === "host-fonts");
  assert.equal(fonts?.severity, "warn");
  assert.deepEqual(textParams(fonts?.detail)?.fonts, "Noto Color Emoji");

  const macos = preflightProfile(
    defaultProfile({ fingerprint: { ...base.fingerprint, platform: "macos" } }),
    {},
  ).items.find((item) => item.id === "macos-persona");
  assert.equal(macos?.severity, "info");

  const portable = setPortableCookies(base, true);
  const missed = preflightProfile(portable, { userDataDir: "D:/profiles/x", userDataDirExists: true })
    .items.find((item) => item.id === "portable-cookies-timing");
  assert.equal(missed?.severity, "warn");
  // A fresh profile has not written cookies yet, so there is nothing to warn about.
  assert.equal(
    preflightProfile(portable, { userDataDir: "D:/profiles/x", userDataDirExists: false })
      .items.some((item) => item.id === "portable-cookies-timing"),
    false,
  );
});

test("a stored profile written by an older build normalizes onto the single launch path", () => {
  const stored = defaultProfile();
  // The values an older build could persist: a retired launcher, a headless profile, the retired
  // fingerprint fields, and the undocumented linux persona.
  for (const launcher of ["playwright-browser", "puppeteer-browser"]) {
    const profile = normalizeProfile({
      ...stored,
      runtime: { ...stored.runtime, launcher: launcher as never, headless: true },
      fingerprint: {
        ...stored.fingerprint,
        platform: "linux" as never,
        gpuVendor: "Google Inc. (NVIDIA)" as never,
        hardwareConcurrency: "16" as never,
        ...({ brand: "Chrome", brandVersion: "130", gpuRenderer: "ANGLE (NVIDIA, ...)" } as object),
      },
    } as never);

    assert.equal(profile.runtime.launcher, "playwright-context", `${launcher} normalizes to the context path`);
    assert.equal(profile.runtime.headless, false, `${launcher} normalizes to headed`);
    assert.equal(profile.fingerprint.platform, "auto", `${launcher} drops the linux persona`);
    for (const retired of ["brand", "brandVersion", "gpuRenderer", "gpuVendor", "hardwareConcurrency"]) {
      assert.equal(retired in profile.fingerprint, false, `${launcher} drops the retired ${retired} field`);
    }

    // A persistent profile now really persists: the user data dir is part of the launch options.
    const preview = buildLaunchPreview(profile);
    assert.equal(preview.launcher, "launchPersistentContext");
    assert.equal(typeof preview.options.userDataDir, "string");
  }

  // The retired fields also leave a share string, so importing one cannot resurrect them.
  const shared = parseProfileConfigShareString(createProfileConfigShareString(stored));
  assert.equal("brand" in shared.profile.fingerprint, false);
  assert.equal("gpuRenderer" in shared.profile.fingerprint, false);
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
    /does not contain an CBPanel profile config string/,
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

  const fingerprintOff = setRuntimeQuickArg(enabledAgain, "fingerprint-off", true);
  const thirdPartyCookies = setRuntimeQuickArg(fingerprintOff, "allow-3p-cookies", true);
  const licenseProxy = thirdPartyCookies;

  assert.deepEqual(licenseProxy.runtime.extraArgs, [
    "--foo=bar",
    "--disable-http2",
    "--fingerprint=off",
    "--fingerprint-allow-3p-cookies",
  ]);
  assert.equal(isRuntimeQuickArgEnabled(licenseProxy, "fingerprint-off"), true);
  assert.equal(isRuntimeQuickArgEnabled(licenseProxy, "allow-3p-cookies"), true);
});

test("fingerprint args omit retired Windows font metrics and other removed flags", () => {
  const base = defaultProfile();
  const profile = defaultProfile({
    fingerprint: {
      ...base.fingerprint,
      seed: "42069",
      platform: "windows",
      timezone: "America/New_York",
      locale: "en-US",
    },
  });

  const args = buildLaunchPreview(profile).options.args as string[];

  assert.equal(args.some((arg) => arg.startsWith("--fingerprint-location")), false);
  assert.equal(args.some((arg) => arg.startsWith("--fingerprint-fonts-dir")), false);

  assert.equal(RUNTIME_QUICK_ARGS.some((item) => item.flag === "--fingerprint-windows-font-metrics"), false);
});

test("the enhanced proxy and portable cookies opt-ins stay off by default and survive sharing, launch previews and generated code", () => {
  const base = defaultProfile();
  assert.equal(isEnhancedProxyEnabled(base), false);
  assert.equal(isPortableCookiesEnabled(base), false);
  {
    for (const mode of ["persistent", "ephemeral"] as const) {
      let profile = defaultProfile({ mode });
      profile = setPortableCookies(setEnhancedProxy(profile, true), true);
      const shared = parseProfileConfigShareString(createProfileConfigShareString(profile));
      assert.deepEqual(shared.profile.runtime.extraArgs, profile.runtime.extraArgs);
      const preview = buildLaunchPreview(profile);
      const code = generateLaunchCode(profile);
      for (const flag of ["--fingerprint-transparent-proxy", "--fingerprint-portable-cookies"]) {
        assert.ok((preview.options.args as string[]).includes(flag));
        assert.ok(code.includes(flag));
      }
      const disabled = setPortableCookies(setEnhancedProxy(profile, false), false);
      assert.deepEqual(disabled.runtime.extraArgs, []);
    }
  }
});

test("empty persistent seeds are delegated to the wrapper only for actual persistent launches", () => {
  const base = defaultProfile();
  {
    for (const mode of ["persistent", "ephemeral"] as const) {
      const profile = defaultProfile({ mode });
      const args = (buildLaunchPreview(profile).options.args as string[] | undefined) ?? [];
      assert.equal(args.some((arg) => arg.startsWith("--fingerprint=")), false);
      const persisted = mode === "persistent";
      const seedAudit = auditProfile(profile).items.find((item) => item.id === "fingerprint-seed");
      assert.equal(textKey(seedAudit?.detail), `profileAudit.fingerprintSeed.detail.${persisted ? "persisted" : "random"}`);
      const explicit = defaultProfile({ ...profile, fingerprint: { ...profile.fingerprint, seed: "42069" } });
      assert.ok((buildLaunchPreview(explicit).options.args as string[]).includes("--fingerprint=42069"));
      assert.ok(generateLaunchCode(explicit).includes("--fingerprint=42069"));
    }
  }
  const passThrough = defaultProfile({ runtime: { ...base.runtime, extraArgs: ["--fingerprint=off"] } });
  assert.equal(textKey(auditProfile(passThrough).items.find((item) => item.id === "fingerprint-seed")?.detail), "profileAudit.fingerprintSeed.detail.disabled");
  const overridden = defaultProfile({
    fingerprint: { ...base.fingerprint, seed: "42069" },
    runtime: { ...base.runtime, extraArgs: ["--fingerprint=off"] },
  });
  assert.equal(textKey(auditProfile(overridden).items.find((item) => item.id === "fingerprint-seed")?.detail), "profileAudit.fingerprintSeed.detail.disabled");
  const extraSeed = defaultProfile({ runtime: { ...base.runtime, extraArgs: ["--fingerprint=12345"] } });
  assert.equal(textKey(auditProfile(extraSeed).items.find((item) => item.id === "fingerprint-seed")?.detail), "profileAudit.fingerprintSeed.detail.set");
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

test("launch preview accepts numeric browser version runtime hints only", () => {
  const profile = defaultProfile();

  assert.equal(
    buildLaunchPreview(profile, undefined, { browserVersion: "148.0.7778.215.5" }).options.browserVersion,
    "148.0.7778.215.5",
  );
  assert.equal(
    "browserVersion" in buildLaunchPreview(profile, undefined, { browserVersion: "test" }).options,
    false,
  );
});

test("advanced json options are merged into context launch preview", () => {
  const profile = defaultProfile({
    advanced: {
      launchOptionsJson: '{ "timeout": 60000 }',
      contextOptionsJson: '{ "permissions": ["geolocation"] }',
    },
  });

  const preview = buildLaunchPreview(profile, "D:/profiles/profile-test");

  assert.deepEqual(preview.options.launchOptions, { timeout: 60000 });
  assert.deepEqual(preview.options.contextOptions, { permissions: ["geolocation"] });
  // Humanize runs on the wrapper's own preset, with no overrides: the panel never drives element
  // interactions, so both knobs would tune code paths this launch does not run.
  assert.equal("humanPreset" in preview.options, false);
  assert.equal("humanConfig" in preview.options, false);
});

test("launchOptions accepts only the keys the panel has no control for", () => {
  const base = defaultProfile();
  for (const mode of ["persistent", "ephemeral"] as const) {
    // Kept: the panel has no timeout / slowMo / downloadsPath / tracesDir control.
    const kept = buildLaunchPreview(defaultProfile({
      mode,
      advanced: { ...base.advanced, launchOptionsJson: '{ "timeout": 1234, "slowMo": 50 }' },
    }));
    assert.deepEqual(kept.options.launchOptions, { timeout: 1234, slowMo: 50 });

    // Refused: every one of these replaces what the panel computed.
    for (const key of ["args", "headless", "proxy", "executablePath", "ignoreDefaultArgs", "env", "defaultViewport", "chromiumSandbox"]) {
      const profile = defaultProfile({
        mode,
        advanced: { ...base.advanced, launchOptionsJson: JSON.stringify({ [key]: key === "args" ? ["--x"] : true }) },
      });
      assert.throws(() => buildLaunchPreview(profile), /launchOptions/, key);
      const item = preflightProfile(profile).items.find((entry) => entry.id === "launch-json");
      assert.equal(item?.severity, "fail", key);
      assert.equal(auditProfile(profile).items.find((entry) => entry.id === "launch-json")?.severity, "fail", key);
    }
  }
});

test("panel-owned Chromium args are still stripped from the generated list", () => {
  const base = defaultProfile();
  const profile = defaultProfile({
    runtime: { ...base.runtime, extraArgs: ["--no-sandbox", "--disable-http2"] },
  });
  const args = buildLaunchPreview(profile, "D:/profiles/profile-test").options.args as string[];
  assert.equal(args.includes("--no-sandbox"), false);
  assert.equal(args.includes("--disable-http2"), true);
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
      contextOptionsJson: "{\"token\":\"abc\",\"safe\":true}",
    },
  });

  const maskedProfile = maskProfileSecrets(profile);
  const masked = JSON.stringify(maskedProfile);
  const maskedContextOptions = parseOptionalJsonObject("contextOptions", maskedProfile.advanced.contextOptionsJson);

  assert.match(masked, /alice/);
  assert.doesNotMatch(masked, /secret/);
  assert.deepEqual(maskedContextOptions, { token: "****", safe: true });
  assert.doesNotMatch(maskedProfile.advanced.contextOptionsJson, /abc/);
  assert.match(masked, /\*\*\*\*/);
});

test("contextOptions stay a forwardable option on the single launch path", () => {
  const profile = defaultProfile({
    viewport: {
      ...defaultProfile().viewport,
      mode: "native",
      userAgent: "Custom UA",
    },
    advanced: {
      ...defaultProfile().advanced,
      contextOptionsJson: '{ "permissions": ["clipboard-read"], "extraHTTPHeaders": { "x-test": "1" } }',
    },
  });

  const preview = buildLaunchPreview(profile);

  assert.equal(preview.launcher, "launchPersistentContext");
  assert.equal(preview.resultType, "context");
  assert.equal(preview.options.userAgent, "Custom UA");
  assert.deepEqual(preview.options.contextOptions, { permissions: ["clipboard-read"], extraHTTPHeaders: { "x-test": "1" } });
});

// The panel writes viewport / userAgent / colorScheme from its own fields, and the wrapper strips
// locale / timezoneId (they route through detectable CDP emulation). Accepting any of them would look
// like the value applied when it never does.
test("contextOptions rejects panel-owned and wrapper-stripped keys", () => {
  for (const key of ["viewport", "userAgent", "colorScheme", "locale", "timezoneId"]) {
    const profile = defaultProfile({
      advanced: { ...defaultProfile().advanced, contextOptionsJson: JSON.stringify({ [key]: key === "viewport" ? { width: 640, height: 480 } : "x" }) },
    });
    assert.throws(() => buildLaunchPreview(profile), /contextOptions/, key);
    const item = preflightProfile(profile).items.find((entry) => entry.id === "context-json");
    assert.equal(item?.severity, "fail", key);
  }

  // Everything else is forwarded whole.
  const forwarded = defaultProfile({
    advanced: {
      ...defaultProfile().advanced,
      contextOptionsJson: '{ "permissions": ["geolocation"], "screen": { "width": 2560, "height": 1440 }, "bypassCSP": true }',
    },
  });
  assert.deepEqual(buildLaunchPreview(forwarded).options.contextOptions, {
    permissions: ["geolocation"],
    screen: { width: 2560, height: 1440 },
    bypassCSP: true,
  });
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
      // Opposite of the default so the plan proves it mirrors the profile flag, not defaultProfile().
      geoip: false,
    },
  });

  const plan = buildSessionLaunchPlan(profile, "D:/profiles/profile-session");

  assert.equal(plan.profileMode, "persistent");
  assert.equal(plan.runtimeLauncher, "playwright-context");
  assert.equal(plan.sdkLauncher, "launchPersistentContext");
  assert.equal(plan.userDataDir, "D:/profiles/profile-session");
  assert.equal(plan.proxy, "http://alice:****@proxy.example.com:8080");
  assert.equal(JSON.stringify(plan).includes("secret"), false);
  assert.equal(plan.geoip, false);
});

test("invalid advanced json fails before launch", () => {
  assert.throws(() => parseOptionalJsonObject("contextOptions", "[]"), /必须是 JSON 对象/);
  assert.throws(() => parseOptionalJsonObject("launchOptions", "{"), /不是有效 JSON/);
});

test("profile audit reports risky runtime settings without throwing", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      geoip: false,
    },
    advanced: {
      ...defaultProfile().advanced,
      launchOptionsJson: "[1]",
    },
  });

  const report = auditProfile(profile);

  assert.ok(report.score < 100);
  assert.ok(report.summary.fail >= 1);
  assert.equal(report.items.find((item) => item.id === "launch-json")?.severity, "fail");
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
    },
  });

  const report = auditProfile(profile);

  assert.equal(report.summary.fail, 0);
  assert.equal(report.items.find((item) => item.id === "launch-json")?.severity, "pass");
  assert.equal(report.items.find((item) => item.id === "context-json")?.severity, "pass");
});

test("profile audit warns only when a watermark is injected", () => {
  const off = defaultProfile();
  assert.equal(auditProfile(off).items.find((item) => item.id === "watermark"), undefined);

  for (const watermark of ["banner", "enhanced"] as const) {
    const profile = defaultProfile({ runtime: { ...defaultProfile().runtime, watermark } });
    const report = auditProfile(profile);
    const item = report.items.find((candidate) => candidate.id === "watermark");

    assert.ok(item, `${watermark} must be audited`);
    assert.equal(item.category, "runtime");
    assert.equal(item.severity, "warn");
    assert.deepEqual(item.detail, { key: "profileAudit.watermark.detail.enabled", params: { watermark } });
    // The warning has to move the score, or the audit would read as if the extra DOM node were free.
    assert.ok(report.score < auditProfile(off).score);
  }
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
    extensionErrors: [{ name: "Missing", detail: "D:/missing-extension: not found" }],
  });

  assert.equal(report.ok, false);
  assert.equal(report.items.find((item) => item.id === "binary")?.severity, "fail");
  assert.deepEqual(report.items.find((item) => item.id === "binary")?.actions?.[0], {
    id: "install-binary",
    kind: "install-binary",
    label: { key: "preflightItem.action.installBinary" },
  });
  assert.equal(report.items.find((item) => item.id === "user-data-dir")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "proxy-config")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "proxy-config")?.actions?.[0]?.target, "proxy");
  // The failure now arrives as one service-reported extension error rather than a per-path probe.
  assert.equal(report.items.find((item) => item.id === "extension-error-0")?.severity, "fail");
  assert.equal(report.items.find((item) => item.id === "extension-error-0")?.actions?.[0]?.target, "runtime");
});

test("profile preflight reports registry extension installation failures", () => {
  const profile = defaultProfile({ name: "Extension Fail" });
  const report = preflightProfile(profile, {
    extensionErrors: [{ name: "Store Metadata", detail: "Chrome Web Store metadata cannot be installed without a verified asset" }],
  });

  const item = report.items.find((entry) => entry.id === "extension-error-0");
  assert.equal(item?.severity, "fail");
  assert.equal(textParams(item?.detail)?.name, "Store Metadata");
  assert.equal(report.ok, false);
});

test("profile preflight warns about bound extensions that will not be loaded", () => {
  const profile = defaultProfile({ name: "Extension Skipped" });
  const report = preflightProfile(profile, {
    extensionWarnings: [{ name: "Disabled Extension", detail: "扩展已停用，本次启动不会加载" }],
  });

  const item = report.items.find((entry) => entry.id === "extension-warning-0");
  assert.equal(item?.severity, "warn");
  assert.equal(item?.category, "runtime");
  // The reason arrives fully worded from the service; preflight must not append its own suffix.
  assert.deepEqual(item?.detail, {
    key: "preflightItem.extensionWarning.detail",
    params: { name: "Disabled Extension", detail: "扩展已停用，本次启动不会加载" },
  });
  assert.equal(item?.actions?.[0]?.target, "runtime");
  assert.deepEqual(profile.runtime.extensionPaths, []);
  assert.equal(report.items.find((entry) => entry.id === "extensions"), undefined);
});

test("profile preflight reports extension errors and warnings side by side", () => {
  const profile = defaultProfile({ name: "Extension Mixed" });
  const report = preflightProfile(profile, {
    extensionErrors: [{ name: "Broken Extension", detail: "Extension Broken Extension is not installed" }],
    extensionWarnings: [{ name: "Pending Extension", detail: "有可用更新未安装，本次启动仍使用当前版本" }],
  });

  assert.equal(report.items.find((entry) => entry.id === "extension-error-0")?.severity, "fail");
  assert.equal(report.items.find((entry) => entry.id === "extension-warning-0")?.severity, "warn");
  assert.equal(report.items.find((entry) => entry.id === "extensions"), undefined);
  assert.equal(report.ok, false);
});

test("profile preflight blocks extensions in throwaway contexts instead of warning", () => {
  const base = defaultProfile({ name: "Extension Persistence" });
  // Bound extensions are what put directories on a launch; the profile itself stores none, so a resolved
  // runtime profile is what carries them into the check.
  const persistentContext = {
    ...base,
    mode: "persistent" as const,
    runtime: { ...base.runtime, launcher: "playwright-context" as const, extensionPaths: ["D:/extension"] },
  };
  const ephemeralContext = { ...persistentContext, mode: "ephemeral" as const };

  const persistentReport = preflightProfile(persistentContext);
  const ephemeralReport = preflightProfile(ephemeralContext);

  assert.equal(persistentReport.items.find((item) => item.id === "extension-persistence"), undefined);
  const ephemeralItem = ephemeralReport.items.find((item) => item.id === "extension-persistence");
  // The ephemeral launcher was measured to load neither the worker nor the content scripts, so this is
  // a launch blocker rather than a persistence caveat.
  assert.equal(ephemeralItem?.severity, "fail");
  assert.equal(ephemeralReport.ok, false);
  assert.equal(ephemeralItem?.category, "runtime");
  assert.equal(textKey(ephemeralItem?.title), "preflightItem.extensionPersistence.title");
  assert.equal(textKey(ephemeralItem?.detail), "preflightItem.extensionPersistence.detail.ephemeral");
  assert.equal(
    preflightProfile({ ...ephemeralContext, runtime: { ...ephemeralContext.runtime, extensionPaths: [] } }, {})
      .items.find((item) => item.id === "extension-persistence"),
    undefined,
  );
});

test("extension directories become the switch pair the Chromium 137+ loader actually reads", () => {
  const base = defaultProfile();
  const paths = ["D:/ext-a", " D:/ext-b "];

  // Directories are a launch input now, so they arrive through the hints rather than a profile field.
  const args = buildLaunchPreview(base, undefined, { extensionPaths: paths }).options.args as string[];
  const loader = args.filter((arg) => arg.includes("extension"));
  // --load-extension alone is ignored by the shipped kernel; the allow-list flag is what loads unpacked
  // directories, so both must be emitted with the same comma-joined value.
  assert.deepEqual(loader, [
    "--load-extension=D:/ext-a,D:/ext-b",
    "--disable-extensions-except=D:/ext-a,D:/ext-b",
  ]);
  // The wrapper option is no longer used: the launch shape must be identical with and without it.
  assert.equal(Object.hasOwn(buildLaunchPreview(base, undefined, { extensionPaths: paths }).options, "extensionPaths"), false);
  const noExtensions = (buildLaunchPreview(defaultProfile()).options.args as string[] | undefined) ?? [];
  assert.equal(noExtensions.some((arg) => arg.includes("extension")), false);

  // The preview shows the pair, so the effective argv matches what the browser receives.
  const preview = buildEffectiveArgPreview(base, paths);
  assert.ok(preview.argv.includes("--load-extension=D:/ext-a,D:/ext-b"));
  assert.ok(preview.argv.includes("--disable-extensions-except=D:/ext-a,D:/ext-b"));
  assert.equal(preview.sources["--load-extension"], "generated");

  // The profile no longer stores directories: a profile that still carries one from an older build
  // drops it on the way in, and the comma rule lives on the import path instead.
  const stored = normalizeProfile({
    ...base,
    runtime: { ...base.runtime, extensionPaths: ["D:/ext,with-comma"] },
  });
  assert.deepEqual(stored.runtime.extensionPaths, []);
  assert.equal(preflightProfile(stored).items.some((item) => item.id === "extension-path-comma"), false);
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
  const networkCheckDetail = withCheck.items.find((item) => item.id === "network-check")?.detail;
  assert.equal(textKey(networkCheckDetail), "preflightItem.networkCheck.detail.pass");
  // The builder carries the region as a code: only the renderer knows the reader's language.
  assert.deepEqual(textParams(networkCheckDetail), {
    head: "203.0.113.42 · ",
    region: { region: "US" },
    tail: " · LAX · 88ms",
  });
  assert.equal(JSON.stringify(textParams(networkCheckDetail)).includes("Cloudflare"), false);
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
  assert.equal(textKey(webrtc?.detail), "profileAudit.webrtc.detail.geoipProxy");

  const report = preflightProfile(profile, { binaryInstalled: true });
  assert.equal(report.items.find((item) => item.id === "webrtc-geoip-effective")?.severity, "pass");
  assert.equal(report.items.some((item) => item.id === "webrtc-auto-without-proxy"), false);
  assert.equal(report.items.some((item) => item.id === "webrtc-custom-empty"), false);
});

// The precedence the launch applies, in one place: a stored literal wins outright, the GeoIP append
// beats a stored `auto` (it runs after the wrapper has already resolved or dropped `auto`), and `auto`
// only stands on its own when GeoIP injects nothing.
test("the effective WebRTC mode follows the order the launch applies", () => {
  const withGeoip = (fingerprint: Partial<BrowserProfile["fingerprint"]>) => defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, ...fingerprint },
    runtime: { ...defaultProfile().runtime, geoip: true },
  });
  const proxied = (fingerprint: Partial<BrowserProfile["fingerprint"]>) => defaultProfile({
    proxy: { ...defaultProfile().proxy, enabled: true, host: "proxy.example.test", port: "8080" },
    fingerprint: { ...defaultProfile().fingerprint, ...fingerprint },
    runtime: { ...defaultProfile().runtime, geoip: true },
  });

  // A literal outranks everything, GeoIP included.
  assert.equal(effectiveWebrtcIpMode(withGeoip({ webrtcIp: "custom", webrtcIpValue: "203.0.113.9" })), "custom");
  // GeoIP injects from a derived pair, so a stored `auto` never runs.
  assert.equal(effectiveWebrtcIpMode(withGeoip({ webrtcIp: "auto" })), "geoip");
  // With an explicit pair and no proxy the GeoIP lookup is a no-op for WebRTC, leaving `auto` on its own
  // — where it still has no proxy to resolve, which is the state the warning covers.
  assert.equal(effectiveWebrtcIpMode(withGeoip({ webrtcIp: "auto", timezone: "Asia/Shanghai", locale: "zh-CN" })), "auto");
  // The same explicit pair with a proxy resolves the exit IP for WebRTC, so GeoIP wins again.
  assert.equal(effectiveWebrtcIpMode(proxied({ webrtcIp: "auto", timezone: "Asia/Shanghai", locale: "zh-CN" })), "geoip");
  // Nothing stored and GeoIP off is honestly off.
  assert.equal(effectiveWebrtcIpMode(defaultProfile({ runtime: { ...defaultProfile().runtime, geoip: false } })), "off");
});

test("geoip without proxy follows the current public exit instead of warning", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      timezone: "",
      locale: "",
      webrtcIp: "off",
      webrtcIpValue: "",
    },
  });

  assert.equal(effectiveWebrtcIpMode(profile), "geoip");

  const report = preflightProfile(profile, { binaryInstalled: true });
  const geoip = report.items.find((item) => item.id === "geoip-without-proxy");
  const webrtc = report.items.find((item) => item.id === "webrtc-geoip-effective");

  assert.equal(geoip?.severity, "pass");
  assert.equal(textKey(geoip?.detail), "preflightItem.geoipWithoutProxy.detail");
  assert.equal(webrtc?.severity, "pass");
  assert.equal(report.items.some((item) => item.id === "webrtc-auto-without-network-anchor"), false);
});

test("geoip without proxy and explicit timezone locale does not claim WebRTC injection", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      geoip: true,
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      webrtcIp: "off",
      webrtcIpValue: "",
    },
  });

  assert.equal(effectiveWebrtcIpMode(profile), "off");

  const report = preflightProfile(profile, { binaryInstalled: true });
  const override = report.items.find((item) => item.id === "geoip-explicit-overrides");

  assert.equal(report.items.find((item) => item.id === "geoip-without-proxy")?.severity, "pass");
  assert.equal(report.items.some((item) => item.id === "webrtc-geoip-effective"), false);
  assert.equal(override?.severity, "warn");
  assert.equal(override?.actions?.[0]?.target, "fingerprint");
});

test("webrtc auto warns without a proxy, because the wrapper resolves it from the proxy exit only", () => {
  const profile = defaultProfile({
    runtime: {
      ...defaultProfile().runtime,
      // GeoIP on and timezone/locale explicit is the case where GeoIP does *not* produce an exit IP
      // without a proxy, so only `auto` itself is left — and it needs one too.
      geoip: true,
    },
    fingerprint: {
      ...defaultProfile().fingerprint,
      timezone: "Asia/Shanghai",
      locale: "zh-CN",
      webrtcIp: "auto",
      webrtcIpValue: "",
    },
  });

  assert.equal(effectiveWebrtcIpMode(profile), "auto");

  const audit = auditProfile(profile);
  const report = preflightProfile(profile, { binaryInstalled: true });
  const webrtc = audit.items.find((item) => item.id === "webrtc");
  const preflight = report.items.find((item) => item.id === "webrtc-auto-without-proxy");

  assert.equal(webrtc?.severity, "warn");
  assert.equal(textKey(webrtc?.detail), "profileAudit.webrtc.detail.autoWithoutProxy");
  assert.equal(preflight?.severity, "warn");
  assert.equal(textKey(preflight?.detail), "preflightItem.webrtcAutoWithoutProxy.detail");
  assert.equal(report.items.some((item) => item.id === "webrtc-geoip-effective"), false);
});

test("profile snapshot masks proxy credentials and sensitive context options", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
    },
    advanced: {
      ...defaultProfile().advanced,
      contextOptionsJson: '{ "extraHTTPHeaders": { "x-token": "token" } }',
    },
  });

  const snapshot = createProfileSnapshot(profile, tZh, "zh-CN", "2026-05-30T00:00:00.000Z");
  const serialized = JSON.stringify(snapshot);
  const markdown = snapshotToMarkdown(snapshot, tZh);

  assert.equal(snapshot.profile.proxy, "http://alice:****@proxy.example.com:8080");
  assert.equal(serialized.includes("alice:secret"), false);
  assert.equal(snapshot.launchCode.includes("secret"), false);
  assert.equal(markdown.includes("alice:secret"), false);
  assert.match(markdown, /体检快照/);
  // A header name the mask classifies as secret is masked in the snapshot as well.
  assert.deepEqual(
    (snapshot.launchPreview.options.contextOptions as { extraHTTPHeaders: Record<string, string> }).extraHTTPHeaders,
    { "x-token": "****" },
  );
});

test("launch snippets include masked launch preview and binary utilities", () => {
  const profile = defaultProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      raw: "http://alice:secret@proxy.example.com:8080",
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
  assert.deepEqual(preview.options.proxy, {
    server: "http://proxy.example.com:8080",
    bypass: "localhost,127.0.0.1",
    username: "alice",
    password: "****",
  });
  assert.ok(snippets.find((snippet) => snippet.id === "binary-tools")?.code.includes("ensureBinary"));
});

test("launch code injects the watermark init script in both profile modes", () => {
  const expectedCall = "await context.addInitScript(";

  {
    for (const mode of ["persistent", "ephemeral"] as const) {
      for (const watermark of ["banner", "enhanced"] as const) {
        const profile = defaultProfile({
          mode,
          runtime: { ...defaultProfile().runtime, watermark },
        });
        const code = generateLaunchCode(profile);
        const label = `${mode}/${watermark}`;

        assert.ok(code.includes(expectedCall), `${label} must inject the watermark`);
        assert.ok(code.includes("cbpanel-watermark"), `${label} must carry the script body`);
        // The init script has to be installed before the first navigation, or the start page misses it.
        const callIndex = code.indexOf(expectedCall);
        const gotoIndex = code.indexOf("page.goto(");
        assert.ok(gotoIndex === -1 || callIndex < gotoIndex, `${label} must inject before goto`);
      }
    }
  }
});

test("launch code omits the watermark injection when the style is off", () => {
  // Voices shaping is on by default and is an injection of its own, so it is turned off here to
  // keep this test about the watermark: no script at all means no injection call at all.
  const profile = defaultProfile({
    runtime: { ...defaultProfile().runtime, watermark: "off", voices: false },
  });
  const code = generateLaunchCode(profile);

  assert.equal(code.includes("addInitScript"), false, "the snippet must not inject");
  assert.equal(code.includes("evaluateOnNewDocument"), false, "the snippet must not inject");
  assert.equal(code.includes("cbpanel-watermark"), false, "the snippet must not carry the script");
});

test("a profile name cannot break out of the generated watermark literal", () => {
  const profile = defaultProfile({
    name: "a`b${process.exit(1)}c",
    runtime: { ...defaultProfile().runtime, watermark: "banner" },
  });
  const code = generateLaunchCode(profile);

  // Backticks and `${` are escaped, so the copied snippet can neither end nor interpolate the literal.
  assert.ok(code.includes("a\\`b\\${process.exit(1)}c"));
  assert.equal(code.includes("a`b${process.exit"), false);
});

/**
 * Runs the generated snippet against stub launchers and returns every script it registered. The
 * snippet is parsed (so an incomplete escape throws here) and the argument is compared to what the
 * launcher itself builds, which a substring assertion cannot prove.
 */
async function captureInjectedScripts(code: string): Promise<string[]> {
  const scripts: string[] = [];
  const page = {
    url: () => "about:blank",
    goto: async () => undefined,
    setUserAgent: async () => undefined,
    setViewport: async () => undefined,
    evaluateOnNewDocument: async (script: string) => {
      scripts.push(script);
    },
  };
  const universal: Record<string, unknown> = {
    addInitScript: async (script: string) => {
      scripts.push(script);
    },
    newPage: async () => page,
    pages: () => [],
    newContext: async () => universal,
    close: async () => undefined,
    on: () => undefined,
    once: () => undefined,
  };
  const body = code
    .split("\n")
    .filter((line) => !/^import .* from .*;$/.test(line))
    .join("\n");
  const imported = [...code.matchAll(/^import \{ ([^}]+) \} from/gm)].map((match) => match[1].trim());
  const factory = new Function(...imported, `return (async () => {\n${body}\n})();`);
  await factory(...imported.map(() => async () => universal));
  return scripts;
}

test("a hostile profile name round-trips into the generated watermark script", async () => {
  const names = [
    "a`b${process.exit(1)}c",
    "back\\slash",
    "trailing\\",
    "line\nbreak",
    // U+2028/U+2029: JSON.stringify leaves these raw, so they must survive the template literal.
    "  ",
    "${`${`}`}",
    "\\`${x}\\`",
  ];

  for (const name of names) {
    for (const mode of ["persistent", "ephemeral"] as const) {
      const profile = defaultProfile({
        name,
        mode,
        // Voices shaping off: this test is about the watermark literal, and captureInjectedScripts
        // compares the whole list of injected scripts.
        runtime: { ...defaultProfile().runtime, watermark: "banner", voices: false },
      });
      const scripts = await captureInjectedScripts(generateLaunchCode(profile));

      assert.deepEqual(
        scripts,
        [buildWatermarkScript(name, "banner")],
        `${mode} with name ${JSON.stringify(name)}`,
      );
    }
  }
});

test("launch code mirrors the voices shaping injection in both profile modes", () => {
  const expectedCall = "await context.addInitScript(";

  {
    for (const mode of ["persistent", "ephemeral"] as const) {
      const profile = defaultProfile({
        mode,
        fingerprint: { ...defaultProfile().fingerprint, seed: "42069", locale: "zh-CN" },
        runtime: { ...defaultProfile().runtime, voices: true },
      });
      const code = generateLaunchCode(profile);
      const label = mode;

      assert.ok(code.includes(expectedCall), `${label} must inject the voices script`);
      assert.ok(code.includes("SpeechSynthesis"), `${label} must carry the script body`);
      // Ahead of the first navigation, or the start page is read before the shaping runs.
      const callIndex = code.indexOf(expectedCall);
      const gotoIndex = code.indexOf("page.goto(");
      assert.ok(gotoIndex === -1 || callIndex < gotoIndex, `${label} must inject before goto`);
    }
  }
});

test("launch code omits the voices injection when the profile turns it off", () => {
  const profile = defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, seed: "42069", locale: "zh-CN" },
    runtime: { ...defaultProfile().runtime, voices: false },
  });
  const code = generateLaunchCode(profile);

  assert.equal(code.includes("SpeechSynthesis"), false, "the snippet must not carry the script");
  assert.equal(code.includes("addInitScript"), false, "the snippet must not inject");
  assert.equal(code.includes("evaluateOnNewDocument"), false, "the snippet must not inject");
});

test("the generated launch code round-trips the voices script exactly", async () => {
  const base = defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, seed: "42069", locale: "zh-CN" },
  });
  const expected = buildVoicesScript(voicesSeed("42069", base.id), "zh-CN", true);

  for (const mode of ["persistent", "ephemeral"] as const) {
    const profile: BrowserProfile = { ...base, mode };
    const scripts = await captureInjectedScripts(generateLaunchCode(profile));

    assert.deepEqual(scripts, [expected], mode);
  }
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
    runtime: {
      ...defaultProfile().runtime,
      // Starts off so the geoip assertion below proves the preset switches it on by itself.
      geoip: false,
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
  // A persistent profile stores its own seed; an explicit one would override that stored identity.
  assert.equal(returning.fingerprint.seed, "");
  // A fixed viewport suppresses --start-maximized, which is the opposite of what a returning account
  // wants; the preset keeps the wrapper's own window behavior.
  assert.equal(returning.viewport.mode, "native");
  assert.equal(throwaway.mode, "ephemeral");
  assert.equal(throwaway.startUrl, DEFAULT_START_URL);
  assert.equal(throwaway.runtime.headless, false);
  // A disposable context opts out of GeoIP on purpose, so it must stay off against the new default.
  assert.equal(throwaway.runtime.geoip, false);
  assert.equal(throwaway.viewport.mode, "native");
  assert.equal(throwaway.fingerprint.seed, "");
});

test("every preset leaves the identity to the wrapper", () => {
  // 42069 and 99887 were README sample values pinned as factory defaults, which handed every local QA
  // environment the same public seed. The templates no longer touch the field at all.
  for (const preset of ["local-qa", "residential-proxy", "returning-session"] as const) {
    const applied = applyProfilePreset(defaultProfile({ fingerprint: { ...defaultProfile().fingerprint, seed: "12345" } }), preset);
    assert.equal(applied.fingerprint.seed, "12345", `${preset} keeps a stored seed instead of rewriting it`);
    const fresh = applyProfilePreset(defaultProfile(), preset);
    assert.equal(fresh.fingerprint.seed, "", preset);
  }
  // The disposable template is the one that clears: a pinned identity would defeat its purpose.
  const throwaway = applyProfilePreset(defaultProfile({ fingerprint: { ...defaultProfile().fingerprint, seed: "12345" } }), "throwaway-session");
  assert.equal(throwaway.fingerprint.seed, "");
});

test("a fixed viewport is reported as screen-rewriting, native is not", () => {
  const base = defaultProfile();
  assert.equal(viewportRewritesScreen({ mode: "native" }), false);
  assert.equal(viewportRewritesScreen({ mode: "fixed" }), true);

  // Any size is launchable: the notice describes device-metrics emulation, it is not a validation rule.
  const big = defaultProfile({ viewport: { ...base.viewport, mode: "fixed", width: 8000, height: 1080 } });
  assert.doesNotThrow(() => buildLaunchPreview(big));
  assert.equal(preflightProfile(big).items.find((item) => item.id === "viewport")?.severity, "pass");
});

test("a new profile's fixed viewport starts at a current full-HD geometry", () => {
  const profile = defaultProfile();
  assert.equal(profile.viewport.mode, "native");
  // 1920x947 was the headless viewport upstream removed in 0.7.0; switching to fixed must not land on it.
  assert.equal(profile.viewport.width, 1920);
  assert.equal(profile.viewport.height, 1080);
});
