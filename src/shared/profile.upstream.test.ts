import assert from "node:assert/strict";
import test from "node:test";
import { auditProfile, buildLaunchPreview, createProfileConfigShareString, defaultProfile, generateLaunchCode, normalizeProfile, parseProfileConfigShareString, preflightProfile, setEnhancedProxy, setRuntimeQuickArg } from "./profile";

test("upstream touch and search options survive sharing while the license route is derived from the proxy", () => {
  for (const mode of ["persistent", "ephemeral"] as const) {
    const base = defaultProfile();
    const profile = defaultProfile({
      mode,
      proxy: { ...base.proxy, enabled: true, host: "proxy.example.test", port: "8080" },
      fingerprint: { ...base.fingerprint, maxTouchPoints: "10" },
      runtime: { ...base.runtime, searchEngine: "duckduckgo" },
    });
    const shared = parseProfileConfigShareString(createProfileConfigShareString(profile)).profile;
    assert.equal(shared.fingerprint.maxTouchPoints, "10");
    assert.equal(shared.runtime.searchEngine, "duckduckgo");
    // No stored routing: a proxied profile sends license traffic through that proxy.
    assert.equal("licenseRoute" in shared.runtime, false);
    const args = buildLaunchPreview(profile).options.args as string[];
    for (const arg of ["--fingerprint-max-touch-points=10", "--fingerprint-search-engine=duckduckgo", "--license-route=proxy"]) {
      assert.ok(args.includes(arg));
      assert.ok(generateLaunchCode(profile).includes(arg));
    }
  }
});

test("the license route follows the proxy instead of a stored control", () => {
  const base = defaultProfile();
  const direct = (buildLaunchPreview(base).options.args as string[] | undefined) ?? [];
  // Direct, not upstream's `auto`: with no proxy there is no retry hop for `auto` to take.
  assert.ok(direct.includes("--license-route=direct"));
  assert.equal(direct.some((arg) => arg.startsWith("--license-route=auto")), false);

  const proxied = defaultProfile({ proxy: { ...base.proxy, enabled: true, host: "proxy.example.test", port: "8080" } });
  assert.ok((buildLaunchPreview(proxied).options.args as string[]).includes("--license-route=proxy"));

  // An enabled-but-incomplete proxy is not a route: the launch fails on the proxy itself.
  const incomplete = defaultProfile({ proxy: { ...base.proxy, enabled: true, host: "", port: "" } });
  assert.throws(() => buildLaunchPreview(incomplete), /代理/);
});

test("a custom search URL is emitted verbatim", () => {
  const base = defaultProfile();
  const profile = defaultProfile({ runtime: { ...base.runtime, searchEngine: "https://example.com/search?q={searchTerms}" } });
  const args = buildLaunchPreview(profile).options.args as string[];
  assert.ok(args.includes("--fingerprint-search-engine=https://example.com/search?q={searchTerms}"));
});

// Humanize runs on the wrapper's own `default` preset: the panel opens, navigates and injects, and
// never drives the element interactions a preset or a humanConfig object would tune. Sending either
// would look configurable while changing nothing, and an unknown preset throws inside the wrapper
// after the browser process already exists.
test("the launch uses the wrapper's humanize defaults with no tuning knobs", () => {
  const options = buildLaunchPreview(defaultProfile()).options;
  assert.equal(options.humanize, true);
  assert.equal("humanPreset" in options, false);
  assert.equal("humanConfig" in options, false);
});

test("invalid upstream options block launch and identify the field in preflight and audit", () => {
  const base = defaultProfile();
  const cases = [
    ...["-1", "1.5", "NaN", "9007199254740992", {}].map((value) => ({ profile: defaultProfile({ fingerprint: { ...base.fingerprint, maxTouchPoints: value as string } }), id: "max-touch-points", target: "fingerprint" })),
    ...["javascript:alert(1)", "example.com", "baidu", {}].map((value) => ({ profile: defaultProfile({ runtime: { ...base.runtime, searchEngine: value as string } }), id: "search-engine", target: "runtime" })),
  ];
  for (const { profile, id, target } of cases) {
    assert.throws(() => buildLaunchPreview(profile));
    const item = preflightProfile(profile).items.find((entry) => entry.id === id);
    assert.equal(item?.severity, "fail");
    assert.equal(item?.actions?.[0]?.target, target);
    assert.equal(auditProfile(profile).items.find((entry) => entry.id === id)?.severity, "fail");
  }
  assert.ok((buildLaunchPreview(defaultProfile({ fingerprint: { ...base.fingerprint, maxTouchPoints: "0" } })).options.args as string[]).includes("--fingerprint-max-touch-points=0"));
});

test("native viewport leaves the option to CloakBrowser so it can maximize", () => {
  const base = defaultProfile();
  const nativeOptions = buildLaunchPreview(defaultProfile({ viewport: { ...base.viewport, mode: "native" } })).options;
  // Upstream adds --start-maximized only when no viewport was passed, and its context builder already
  // defaults to viewport: null. An explicit null here suppressed that default.
  assert.equal("viewport" in nativeOptions, false);

  const fixedOptions = buildLaunchPreview(defaultProfile({
    viewport: { ...base.viewport, mode: "fixed", width: 1440, height: 900 },
  })).options;
  assert.deepEqual(fixedOptions.viewport, { width: 1440, height: 900 });
});

test("the seed-derived overrides are gone from the generated args and from stored rows", () => {
  const base = defaultProfile();
  const defaults = (buildLaunchPreview(base).options.args as string[] | undefined) ?? [];
  // Screen, GPU, CPU and memory come from one seed; the panel no longer writes any of them.
  for (const flag of ["--fingerprint-screen-", "--fingerprint-gpu-vendor", "--fingerprint-hardware-concurrency", "--fingerprint-device-memory", "--fingerprint-platform-version", "--fingerprint-taskbar-height"]) {
    assert.equal(defaults.some((arg) => arg.startsWith(flag)), false, flag);
  }

  // A stored row written by an older build keeps none of the retired values after one normalize pass.
  const legacy = normalizeProfile({
    fingerprint: {
      ...base.fingerprint,
      screenWidth: 1920 as unknown as string,
      screenHeight: 1080 as unknown as string,
      gpuVendor: "Google Inc. (NVIDIA)" as never,
      hardwareConcurrency: "16" as never,
      deviceMemory: "32" as never,
      platformVersion: "15.0.0" as never,
      taskbarHeight: "48" as never,
    },
  } as never);
  for (const retired of ["screenWidth", "screenHeight", "gpuVendor", "hardwareConcurrency", "deviceMemory", "platformVersion", "taskbarHeight"]) {
    assert.equal(retired in legacy.fingerprint, false, retired);
  }
});

test("the sapi voices opt-out is available as a quick arg", () => {
  const profile = setRuntimeQuickArg(defaultProfile(), "sapi-voices-off", true);
  assert.ok((buildLaunchPreview(profile).options.args as string[]).includes("--fingerprint-sapi-voices=false"));
});

test("hand-written args that replace generated flags are reported", () => {
  const base = defaultProfile({ fingerprint: { ...defaultProfile().fingerprint, seed: "42069" } });
  const profile = defaultProfile({ ...base, runtime: { ...base.runtime, extraArgs: ["--fingerprint=12345"] } });
  const item = preflightProfile(profile).items.find((entry) => entry.id === "raw-arg-override");
  assert.equal(item?.severity, "warn");
  assert.equal(textParams(item?.detail)?.flags, "--fingerprint");
  assert.equal(auditProfile(profile).items.find((entry) => entry.id === "raw-arg-override")?.severity, "warn");
});

test("pass-through fingerprint names the tuning that still applies", () => {
  const base = defaultProfile();
  const profile = defaultProfile({
    fingerprint: { ...base.fingerprint, timezone: "UTC", locale: "en-US" },
    runtime: { ...base.runtime, geoip: true, extraArgs: ["--fingerprint=off"] },
  });
  const item = preflightProfile(profile).items.find((entry) => entry.id === "fingerprint-off-mixed");
  assert.equal(item?.severity, "warn");
  assert.equal(textParams(item?.detail)?.sources, "GeoIP, timezone, locale");
});

// launchOptions used to be a free-override layer and every replacing key produced a warning. It is now
// an allowlist, so the same keys fail the JSON field itself and the launch never reaches the wrapper.
test("launchOptions keys that replace panel configuration are refused outright", () => {
  const base = defaultProfile();
  const profile = defaultProfile({
    advanced: { ...base.advanced, launchOptionsJson: '{"args":["--x"],"headless":true,"timeout":1000}' },
  });
  assert.throws(() => buildLaunchPreview(profile), /launchOptions/);
  const item = preflightProfile(profile).items.find((entry) => entry.id === "launch-json");
  assert.equal(item?.severity, "fail");
  assert.match(JSON.stringify(item?.detail), /args/);
});

function textParams(text: unknown): Record<string, unknown> | undefined {
  return text && typeof text === "object" && "key" in text
    ? (text as { params?: Record<string, unknown> }).params
    : undefined;
}

test("the enhanced proxy is one flag with no DNS companion to keep in sync", () => {
  const base = defaultProfile();
  const profile = setEnhancedProxy(base, true);

  // One flag only: sites resolve through Cloudflare DoH via the proxy, which is the documented default
  // for the mode, so there is no stored DNS value and no second flag.
  assert.deepEqual(profile.runtime.extraArgs, ["--fingerprint-transparent-proxy"]);
  const args = buildLaunchPreview(profile).options.args as string[];
  assert.ok(args.includes("--fingerprint-transparent-proxy"));
  assert.equal(args.some((arg) => arg.startsWith("--fingerprint-transparent-proxy-dns")), false);

  // A share string carries the toggle with the rest of the profile.
  const shared = parseProfileConfigShareString(createProfileConfigShareString(profile)).profile;
  assert.deepEqual(shared.runtime.extraArgs, ["--fingerprint-transparent-proxy"]);

  // Turning it off leaves no residue.
  assert.deepEqual(setEnhancedProxy(profile, false).runtime.extraArgs, []);
});

test("the undocumented linux persona normalizes to auto", () => {
  const base = defaultProfile();
  const normalized = normalizeProfile({ fingerprint: { ...base.fingerprint, platform: "linux" as never } });
  assert.equal(normalized.fingerprint.platform, "auto");
});
