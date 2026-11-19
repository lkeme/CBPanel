import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_APP_SETTINGS, mergeSettings, normalizeSettings } from "../../src/shared/settings";
import { BinaryService, type CloakBrowserModule } from "./binaryService";
import { applyGithubMirrorFetch, restoreGithubMirrorFetch } from "./githubMirrorFetch";
import { CLOAKBROWSER_GEOIP_DB_URL } from "../../src/shared/githubMirror";
import { normalizeChromeCoreVersion } from "./extensionProviders/chromeWebStoreProvider";

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-upstream-"));
  const env = { ...process.env };
  for (const key of Object.keys(process.env)) if (key.startsWith("CLOAKBROWSER_")) delete process.env[key];
  try {
    await run(directory);
  } finally {
    for (const key of Object.keys(process.env)) if (key.startsWith("CLOAKBROWSER_")) delete process.env[key];
    for (const [key, value] of Object.entries(env)) if (key.startsWith("CLOAKBROWSER_")) process.env[key] = value;
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function runtime(patch: Partial<CloakBrowserModule> = {}): CloakBrowserModule {
  return {
    binaryInfo: () => ({ version: null, binaryPath: null, cacheDir: null, installed: false, platform: "windows-x64", downloadUrl: "https://cloakbrowser.dev/api/download/latest" }),
    ensureBinary: async () => { throw new Error("Unexpected download or interactive claim"); },
    clearCache: () => {},
    validateLicense: async () => ({ valid: true, plan: "free", expires: null }),
    ...patch,
  };
}

test("official offline imports use the effective preview marker and retain the activated import", async () => {
  for (const source of ["custom", "external"] as const) await fixture(async (directory) => {
    const { zipSync } = await import("fflate");
    const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
    const executable = process.platform === "win32" ? "chrome.exe" : process.platform === "darwin" ? "Chromium.app/Contents/MacOS/Chromium" : "chrome";
    const old = "155.0.8059.39.1", next = "156.0.8078.47.1";
    let settings = normalizeSettings({ binary: { releaseChannel: "stable", customEnvVars: source === "custom" ? [{ id: "release-channel", key: "CLOAKBROWSER_RELEASE_CHANNEL", enabled: true, value: "preview", valueKind: "text", sensitive: false, description: "" }] : [] } });
    if (source === "external") process.env.CLOAKBROWSER_RELEASE_CHANNEL = "preview";
    const cache = path.join(directory, "cloakbrowser-cache");
    const oldBinary = path.join(cache, `chromium-${old}-pro`, executable);
    await fs.mkdir(path.dirname(oldBinary), { recursive: true });
    await fs.writeFile(oldBinary, "fixture");
    await fs.chmod(oldBinary, 0o755);
    await fs.writeFile(path.join(cache, `latest_pro_version_${platform}`), old);
    const archive = path.join(directory, `cloakbrowser-${platform}.zip`);
    await fs.writeFile(archive, zipSync({ [`chromium-v${next}/${executable}`]: new TextEncoder().encode("fixture") }));
    const service = new BinaryService({ dataDir: directory, portable: false, readSettings: async () => settings, saveSettings: async (patch) => (settings = mergeSettings(settings, patch)) });
    const imported = await service.installImportZip(archive, { targetChannel: "official" });
    assert.equal(imported.pendingActivation, false);
    assert.equal(imported.info.version, next);
    assert.equal((await service.activateChannel("official", "offline")).info.version, next);
    assert.deepEqual((await fs.readdir(cache)).filter((name) => name.startsWith("chromium-")), [`chromium-${next}-pro`]);
  });
});

test("0.7 fresh installs report an absent build and refuse keyless install and update without invoking the SDK claim flow", async () => fixture(async (directory) => {
  let fetches = 0;
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => DEFAULT_APP_SETTINGS,
    loadCloakBrowser: async () => runtime(),
    fetchImpl: async () => { fetches++; throw new Error("Unexpected metadata request"); },
  });
  const info = await service.readPublicInfo();
  assert.equal(info.installed, false);
  assert.equal(info.version, "");
  assert.equal(info.binaryPath, "");
  assert.equal(info.cacheDir, "");
  assert.equal(info.licenseRequired, true);
  await assert.rejects(service.install(), { code: "BROWSER_CORE_LICENSE_REQUIRED" });
  await assert.rejects(service.update(), { code: "BROWSER_CORE_LICENSE_REQUIRED" });
  const check = await service.checkUpdate();
  assert.equal(check.update.updateAvailable, false);
  assert.equal(check.update.errorCode, "BROWSER_CORE_LICENSE_REQUIRED");
  assert.equal(check.update.error, "CloakBrowser license key is required.");
  assert.equal(fetches, 0);
  assert.deepEqual(await fs.readdir(directory), []);
}));

test("0.7 resolves a saved key from the configured cache and drops a free plan's pin on the preview channel", async () => fixture(async (directory) => {
  const cache = path.join(directory, "custom-cache");
  await fs.mkdir(cache);
  await fs.writeFile(path.join(cache, "license.key"), "cb_saved_free", "utf8");
  const calls: unknown[][] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => normalizeSettings({ binary: { cacheDirMode: "custom", customCacheDir: cache, browserVersionMode: "pinned", pinnedBrowserVersion: "156.0.8078.47.1", releaseChannel: "preview" } }),
    loadCloakBrowser: async () => runtime({
      validateLicense: async (key) => { assert.equal(key, "cb_saved_free"); return { valid: true, plan: "free", expires: null }; },
      ensureBinary: async (...args) => { calls.push(args); return path.join(cache, "chromium-156.0.8078.47.1-pro", "chrome.exe"); },
    }),
  });
  const result = await service.install();
  assert.deepEqual(calls, [["cb_saved_free", undefined, "preview"]]);
  assert.equal(result.info.core.planIsFree, true);
  assert.equal(result.info.core.versionMode, "latest");
  assert.equal(result.info.core.license.plan, "free");
}));

test("0.7 rejects retired free-cache imports instead of publishing an unusable build", async () => fixture(async (directory) => {
  const { zipSync } = await import("fflate");
  const archive = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(archive, zipSync({ "chromium-156.0.8078.47.1/chrome.exe": new Uint8Array([1]) }));
  const service = new BinaryService({ dataDir: directory, portable: false, readSettings: async () => DEFAULT_APP_SETTINGS, loadCloakBrowser: async () => runtime() });
  const analysis = await service.analyzeImportZip(archive);
  assert.equal(analysis.operation, "install");
  assert.equal(analysis.importedVersion, "156.0.8078.47.1");
  await assert.rejects(service.analyzeImportZip(archive, { targetTier: "free" }), /only supports the authenticated/);
}));

for (const channel of ["stable", "preview"] as const) {
  test(`explicit ${channel} update refreshes the real SDK's hourly metadata cache and preserves a reused imported build`, async () => fixture(async (directory) => {
    const sdk = await import("cloakbrowser");
    const cache = path.join(directory, "cache");
    process.env.CLOAKBROWSER_CACHE_DIR = cache;
    const oldVersion = "155.0.8059.39.1";
    const latest = "156.0.8078.47.1";
    const before = sdk.binaryInfo(oldVersion, channel);
    const candidate = sdk.binaryInfo(latest, channel);
    assert.ok(before.binaryPath && candidate.binaryPath && candidate.cacheDir);
    for (const executable of [before.binaryPath, candidate.binaryPath]) {
      await fs.mkdir(path.dirname(executable), { recursive: true });
      await fs.writeFile(executable, "cached fixture, never executed", { mode: 0o755 });
    }
    const suffix = channel === "preview" ? `preview_${before.platform}` : before.platform;
    const siblingSuffix = channel === "preview" ? before.platform : `preview_${before.platform}`;
    const activeMarker = path.join(cache, `latest_pro_version_${suffix}`);
    await fs.writeFile(activeMarker, oldVersion);
    await fs.writeFile(path.join(cache, `.last_pro_version_check_${suffix}`), oldVersion);
    await fs.writeFile(path.join(cache, `.last_pro_version_resolution_${suffix}`), JSON.stringify({ version: oldVersion, requested_channel: channel, resolved_channel: channel, fallback: false }));
    const siblingCheck = path.join(cache, `.last_pro_version_check_${siblingSuffix}`);
    await fs.writeFile(siblingCheck, oldVersion);
    const siblingTime = (await fs.stat(siblingCheck)).mtimeMs;
    const provenance = path.join(candidate.cacheDir, "cbpanel-import.json");
    await fs.writeFile(provenance, JSON.stringify({ source: "offline-import", version: latest, tier: "pro", fileName: "offline.zip", sha256: "a".repeat(64), importedAt: new Date().toISOString() }));
    let sdkChecks = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url === "https://cloakbrowser.dev/api/license/validate") return Response.json({ valid: true, plan: "free", expires: null });
      if (url.startsWith("https://cloakbrowser.dev/api/download/version")) {
        assert.equal(url.endsWith("?channel=preview"), channel === "preview");
        sdkChecks++;
        return Response.json({ version: latest, requested_channel: channel, resolved_channel: channel, fallback: false });
      }
      if (url === "https://registry.npmjs.org/cloakbrowser/latest") return Response.json({ version: "0.7.0" });
      throw new Error(`Unexpected SDK request: ${url}`);
    };
    try {
      const service = new BinaryService({
        dataDir: directory,
        portable: false,
        readSettings: async () => normalizeSettings({ binary: { cacheDirMode: "custom", customCacheDir: cache, licenseKey: "cb_review_free", releaseChannel: channel } }),
        fetchImpl: async () => Response.json({ version: latest }),
        loadCloakBrowser: async () => ({ ...sdk, validateLicense: async () => ({ valid: true, plan: "free", expires: null }) }),
      });
      const result = await service.update();
      assert.equal(result.version, latest);
      assert.equal(result.info.version, latest);
      assert.equal(sdkChecks, 1);
      assert.equal(await fs.readFile(activeMarker, "utf8"), latest);
      assert.equal((await fs.stat(siblingCheck)).mtimeMs, siblingTime);
      assert.equal(result.info.core.importedBuild?.version, latest);
      await fs.access(provenance);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }));
}

test("install keeps provenance when the already-ready cache is reused", async () => fixture(async (directory) => {
  const sdk = await import("cloakbrowser");
  const cache = path.join(directory, "cloakbrowser-cache");
  process.env.CLOAKBROWSER_CACHE_DIR = cache;
  const info = sdk.binaryInfo("156.0.8078.47.1");
  assert.ok(info.binaryPath && info.cacheDir);
  await fs.mkdir(path.dirname(info.binaryPath), { recursive: true });
  await fs.writeFile(info.binaryPath, "cached fixture, never executed", { mode: 0o755 });
  await fs.writeFile(path.join(cache, `latest_pro_version_${info.platform}`), info.version!);
  const marker = path.join(info.cacheDir, "cbpanel-import.json");
  await fs.writeFile(marker, JSON.stringify({ source: "offline-import", version: info.version, tier: "pro", fileName: "offline.zip", sha256: "a".repeat(64), importedAt: new Date().toISOString() }));
  const service = new BinaryService({ dataDir: directory, portable: false,
    readSettings: async () => normalizeSettings({ binary: { licenseKey: "cb_review", } }),
    loadCloakBrowser: async () => runtime({ binaryInfo: sdk.binaryInfo, ensureBinary: async () => { throw new Error("A ready cache must not be downloaded again"); } }),
  });
  const result = await service.install();
  assert.equal(result.info.core.importedBuild?.version, info.version);
  await fs.access(marker);
}));

test("an invalid version response fails an explicit update instead of reporting up to date", async () => fixture(async (directory) => {
  for (const version of [undefined, "", "latest", "156/../../other", "156.0.8078.47.1\nother"]) {
    const service = new BinaryService({ dataDir: directory, portable: false,
      readSettings: async () => normalizeSettings({ binary: { licenseKey: "cb_review" } }),
      fetchImpl: async () => Response.json({ version }),
      loadCloakBrowser: async () => runtime(),
    });
    await assert.rejects(service.update(), /valid Chromium version/);
    assert.equal((await service.readPublicInfo()).core.operation?.status, "failed");
  }
}));

test("reading core state preserves the auto-best mirror installed for a browser launch", async () => fixture(async (directory) => {
  const settings = normalizeSettings({ networkTrace: { githubMirrorProviderId: "auto-best" } });
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => { requests.push(String(input)); return new Response(null); };
  try {
    applyGithubMirrorFetch(settings, "https://mirror.example/");
    const launchFetch = globalThis.fetch;
    const service = new BinaryService({ dataDir: directory, portable: false, readSettings: async () => settings, loadCloakBrowser: async () => runtime() });
    await service.readInfo();
    assert.equal(globalThis.fetch, launchFetch);
    await fetch(CLOAKBROWSER_GEOIP_DB_URL);
    assert.deepEqual(requests, [`https://mirror.example/${CLOAKBROWSER_GEOIP_DB_URL}`]);
  } finally {
    restoreGithubMirrorFetch();
    globalThis.fetch = originalFetch;
  }
}));

test("a custom executable supplies its own version without a managed build and invalidates the cached probe when replaced", async () => fixture(async (directory) => {
  const sdk = await import("cloakbrowser");
  const binaryPath = path.join(directory, "external", "chrome.exe");
  await fs.mkdir(path.dirname(binaryPath));
  await fs.writeFile(binaryPath, "fixture, never executed");
  let probes = 0;
  let version = "156.0.8078.47.1";
  const service = new BinaryService({ dataDir: directory, portable: false,
    readSettings: async () => normalizeSettings({ binary: { customBinaryPathEnabled: true, customBinaryPath: binaryPath } }),
    loadCloakBrowser: async () => ({ ...sdk, validateLicense: runtime().validateLicense }),
    readExecutableVersion: async (filePath) => { assert.equal(filePath, binaryPath); probes++; return version; },
  });
  const info = await service.readInfo();
  assert.equal(info.installed, true);
  assert.equal(info.licenseRequired, false);
  assert.equal(normalizeChromeCoreVersion(info.version), "156.0.8078.47");
  await service.readInfo();
  assert.equal(probes, 1);
  version = "157.0.8100.1";
  await fs.writeFile(binaryPath, "a replaced executable fixture, never executed");
  assert.equal((await service.readInfo()).version, version);
  assert.equal(probes, 2);
}));
