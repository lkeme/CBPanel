import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, zipSync } from "fflate";
import { DEFAULT_APP_SETTINGS, type AppSettings, normalizeSettings } from "../../src/shared/settings";
import { BinaryService, resolvePackageVersion, type BinaryServiceOptions, type CloakBrowserModule } from "./binaryService";
import { restoreGithubMirrorFetch } from "./githubMirrorFetch";

const CLOAK_ENV_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_DOWNLOAD_URL",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_SKIP_CHECKSUM",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_LICENSE_KEY",
  "CLOAKBROWSER_RELEASE_CHANNEL",
] as const;

test("BinaryService applies browser core settings before loading CloakBrowser", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const customBinary = path.join(directory, "chrome.exe");
  await fs.writeFile(customBinary, "");
  const loadSnapshots: Array<Record<string, string | undefined>> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      customBinaryPathEnabled: true,
      customBinaryPath: customBinary,
      cacheDirMode: "custom",
      customCacheDir: path.join(directory, "cache"),
      downloadSourceMode: "custom",
      customDownloadBaseUrl: "https://mirror.example.test///",
      internalAutoUpdate: true,
      checksumPolicy: "skip",
      geoipTimeoutSeconds: 12,
      customEnvVars: [
        {
          id: "binary-path",
          key: "CLOAKBROWSER_BINARY_PATH",
          value: customBinary,
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "path",
        },
        {
          id: "download-url",
          key: "CLOAKBROWSER_DOWNLOAD_URL",
          value: "https://mirror.example.test///",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "url",
        },
        {
          id: "geoip-timeout",
          key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
          value: "15",
          enabled: true,
          sensitive: false,
          description: "",
          valueKind: "number",
        },
      ],
    }),
    loadCloakBrowser: async () => {
      loadSnapshots.push(captureEnv());
      return fakeCloakBrowserModule({ binaryPath: customBinary, cacheDir: path.join(directory, "cache") });
    },
  });

  try {
    const info = await service.readPublicInfo();

    assert.equal(loadSnapshots.length, 1);
    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_BINARY_PATH, customBinary);
    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_CACHE_DIR, path.join(directory, "cache"));
    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_DOWNLOAD_URL, "https://mirror.example.test");
    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_AUTO_UPDATE, "false");
    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_SKIP_CHECKSUM, "false");
    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS, "15");
    assert.equal(info.installed, true);
    assert.equal(info.binaryPath, customBinary);
    assert.equal(info.core.restartRequired, false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService exports the preview release channel to CloakBrowser", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadSnapshots: Array<Record<string, string | undefined>> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ releaseChannel: "preview" }),
    loadCloakBrowser: async () => {
      loadSnapshots.push(captureEnv());
      return fakeCloakBrowserModule({});
    },
  });

  try {
    const info = await service.readPublicInfo();
    const row = info.core.env.find((item) => item.key === "CLOAKBROWSER_RELEASE_CHANNEL");

    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_RELEASE_CHANNEL, "preview");
    assert.equal(process.env.CLOAKBROWSER_RELEASE_CHANNEL, "preview");
    assert.equal(row?.enabled, true);
    assert.equal(row?.value, "preview");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService leaves the release channel env unset on stable", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadSnapshots: Array<Record<string, string | undefined>> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ releaseChannel: "stable" }),
    loadCloakBrowser: async () => {
      loadSnapshots.push(captureEnv());
      return fakeCloakBrowserModule({});
    },
  });

  try {
    const info = await service.readPublicInfo();
    const row = info.core.env.find((item) => item.key === "CLOAKBROWSER_RELEASE_CHANNEL");

    assert.equal(loadSnapshots[0]?.CLOAKBROWSER_RELEASE_CHANNEL, undefined);
    assert.equal(process.env.CLOAKBROWSER_RELEASE_CHANNEL, undefined);
    assert.equal(row?.enabled, false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService reports missing custom binary path as not installed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const missingBinary = path.join(directory, "missing.exe");
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      customBinaryPathEnabled: true,
      customBinaryPath: missingBinary,
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({ binaryPath: missingBinary }),
  });

  try {
    const info = await service.readPublicInfo();

    assert.equal(info.installed, false);
    assert.equal(info.binaryPath, missingBinary);
    assert.equal(info.core.status, "not-installed");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService marks restart only for env values changed after CloakBrowser load", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let customDownloadBaseUrl = "https://mirror-one.example.test";
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      downloadSourceMode: "custom",
      customDownloadBaseUrl,
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule(),
  });

  try {
    const first = await service.readPublicInfo();
    const firstDownloadUrl = first.core.env.find((item) => item.key === "CLOAKBROWSER_DOWNLOAD_URL");
    assert.equal(first.core.restartRequired, false);
    assert.equal(firstDownloadUrl?.requiresRuntimeRestart, false);

    customDownloadBaseUrl = "https://mirror-two.example.test";
    const second = await service.readPublicInfo();
    const secondDownloadUrl = second.core.env.find((item) => item.key === "CLOAKBROWSER_DOWNLOAD_URL");
    assert.equal(second.core.restartRequired, true);
    assert.equal(secondDownloadUrl?.requiresRuntimeRestart, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService ignores disabled optional browser core env rows", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  process.env.CLOAKBROWSER_LICENSE_KEY = "external-license";
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      downloadSourceMode: "custom",
      customDownloadBaseUrl: "https://legacy-mirror.example.test",
      customEnvVars: [
        {
          id: "download-url",
          key: "CLOAKBROWSER_DOWNLOAD_URL",
          value: "https://disabled-mirror.example.test",
          enabled: false,
          sensitive: false,
          description: "",
          valueKind: "url",
        },
        {
          id: "geoip-timeout",
          key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
          value: "30",
          enabled: false,
          sensitive: false,
          description: "",
          valueKind: "number",
        },
        {
          id: "license",
          key: "CLOAKBROWSER_LICENSE_KEY",
          value: "disabled-license",
          enabled: false,
          sensitive: true,
          description: "",
          valueKind: "secret",
        },
      ],
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule(),
  });

  try {
    const info = await service.readPublicInfo();
    const downloadUrl = info.core.env.find((item) => item.key === "CLOAKBROWSER_DOWNLOAD_URL");
    const geoipTimeout = info.core.env.find((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS");
    const license = info.core.env.find((item) => item.key === "CLOAKBROWSER_LICENSE_KEY");

    assert.equal(process.env.CLOAKBROWSER_DOWNLOAD_URL, undefined);
    assert.equal(process.env.CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS, undefined);
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, undefined);
    assert.equal(downloadUrl?.enabled, false);
    assert.equal(downloadUrl?.value, undefined);
    assert.equal(downloadUrl?.source, "cloakbrowser-default");
    assert.equal(geoipTimeout?.enabled, false);
    assert.equal(geoipTimeout?.value, undefined);
    assert.equal(geoipTimeout?.source, "cloakbrowser-default");
    assert.equal(license?.enabled, false);
    assert.equal(license?.value, undefined);
    assert.equal(license?.source, "cloakbrowser-default");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService install reuses an installed cache when preferExistingCache is enabled", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let ensureCalls = 0;
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ preferExistingCache: true }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ binaryPath: "C:/cache/chrome.exe", installed: true }),
      ensureBinary: async () => {
        ensureCalls += 1;
        return "C:/cache/chrome.exe";
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.install();

    assert.equal(ensureCalls, 0);
    assert.equal(result.binaryPath, "C:/cache/chrome.exe");
    assert.equal(result.info.core.operation?.status, "succeeded");
    assert.equal(result.info.core.operation?.phase, "complete");
    assert.equal(result.info.core.operation?.progress?.current, 100);
    assert.match(result.info.core.operation?.logs.at(-1)?.message ?? "", /Reused existing/);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService passes Pro license and pinned version to CloakBrowser install", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const calls: Array<{ licenseKey?: string; browserVersion?: string }> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      preferExistingCache: false,
      tierMode: "pro",
      licenseKey: "license-secret",
      browserVersionMode: "pinned",
      pinnedBrowserVersion: "147.0.7700.1",
    }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ version: "147.0.7700.1", tier: "pro" }),
      binaryInfo: (browserVersion?: string) => fakeBinaryInfo({
        version: browserVersion ?? "146.0.7680.177.5",
        tier: "pro",
        cacheDir: `C:/cache/chromium-${browserVersion ?? "146.0.7680.177.5"}-pro`,
        binaryPath: `C:/cache/chromium-${browserVersion ?? "146.0.7680.177.5"}-pro/chrome.exe`,
      }),
      ensureBinary: async (licenseKey?: string, browserVersion?: string) => {
        calls.push({ licenseKey, browserVersion });
        return `C:/cache/chromium-${browserVersion}-pro/chrome.exe`;
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.install();

    assert.deepEqual(calls, [{ licenseKey: "license-secret", browserVersion: "147.0.7700.1" }]);
    assert.equal(process.env.CLOAKBROWSER_VERSION, "147.0.7700.1");
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, "license-secret");
    assert.equal(result.info.core.targetTier, "pro");
    assert.equal(result.info.core.versionMode, "pinned");
    assert.equal(result.info.core.pinnedVersion, "147.0.7700.1");
    assert.equal(result.info.core.license.configured, true);
    assert.equal(result.info.core.license.active, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps a version pin while a license key's plan is unconfirmed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const calls: Array<{ licenseKey?: string; browserVersion?: string }> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      preferExistingCache: false,
      tierMode: "free",
      licenseKey: "free-license",
      browserVersionMode: "pinned",
      pinnedBrowserVersion: "149.0.0.0",
    }),
    loadCloakBrowser: async () => ({
      // validateLicense answers null — the wrapper's "could not validate". ensureBinary then falls
      // through to its free path, which honours requestedVersion, so dropping the pin here was a guess
      // about a key nobody had confirmed. Only a confirmed free *plan* drops it.
      ...fakeCloakBrowserModule({ tier: "free" }),
      ensureBinary: async (licenseKey?: string, browserVersion?: string) => {
        calls.push({ licenseKey, browserVersion });
        return "C:/cache/chromium-149.0.0.0/chrome.exe";
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.install();

    assert.deepEqual(calls, [{ licenseKey: "free-license", browserVersion: "149.0.0.0" }]);
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, "free-license");
    assert.equal(process.env.CLOAKBROWSER_VERSION, "149.0.0.0");
    assert.equal(result.info.core.targetTier, "free");
    assert.equal(result.info.core.planIsFree, false);
    assert.equal(result.info.core.versionMode, "pinned");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService derives the free tier when no license key is configured", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let ensureCalls = 0;
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    // A stale Pro tierMode with no key can no longer refuse the install: the tier is derived from the
    // license, so "marked Pro with no key" is not a state the operator can get into any more.
    readSettings: async () => settings({ tierMode: "pro", preferExistingCache: false }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule(),
      ensureBinary: async () => {
        ensureCalls += 1;
        return "C:/cache/chrome.exe";
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.install();

    assert.equal(ensureCalls, 1);
    assert.equal(result.info.core.targetTier, "free");
    assert.equal(result.info.core.license.configured, false);
    assert.equal(result.info.core.license.active, false);
    assert.equal(result.info.core.license.plan, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService derives the Pro tier from a paid license plan and caches it in settings", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let stored = settings({
    preferExistingCache: false,
    licenseKey: "paid-license",
    browserVersionMode: "pinned",
    pinnedBrowserVersion: "147.0.7700.1",
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => stored,
    saveSettings: async (patch) => {
      stored = normalizeSettings({ ...stored, ...patch });
      return stored;
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      license: { valid: true, plan: "team", expires: "2027-01-01" },
      tier: "pro",
    }),
  });

  try {
    const result = await service.install();

    assert.equal(result.info.core.targetTier, "pro");
    assert.equal(result.info.core.license.plan, "team");
    assert.equal(result.info.core.license.valid, true);
    assert.equal(result.info.core.license.expires, "2027-01-01");
    // A paid plan keeps the pin, and the derivation is written back so nothing downstream has to
    // re-derive it.
    assert.equal(result.info.core.versionMode, "pinned");
    assert.equal(stored.binary.tierMode, "pro");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService derives the Pro cache tier from a valid free plan and still drops the pin", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  let stored = settings({
    preferExistingCache: false,
    tierMode: "free",
    cacheDirMode: "custom",
    customCacheDir: cacheRoot,
    licenseKey: "free-license",
    browserVersionMode: "pinned",
    pinnedBrowserVersion: "147.0.7700.1",
  });
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));
  const calls: Array<string | undefined> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => stored,
    saveSettings: async (patch) => {
      stored = normalizeSettings({ ...stored, ...patch });
      return stored;
    },
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ license: { valid: true, plan: "free", expires: null } }),
      ensureBinary: async (_licenseKey?: string, browserVersion?: string) => {
        calls.push(browserVersion);
        return "C:/cache/chrome.exe";
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.install();

    // ensureBinary branches on info.valid alone, so this key downloads through ensureProBinary into
    // chromium-<version>-pro under the Pro marker — the plan changes only the version pin
    // (proVersion = plan === "free" ? undefined : requestedVersion) and the welcome banner. Deriving
    // the layout from the plan filed every import under chromium-<version>, where launches never look.
    assert.deepEqual(calls, [undefined]);
    assert.equal(result.info.core.targetTier, "pro");
    assert.equal(result.info.core.planIsFree, true);
    assert.equal(result.info.core.versionMode, "latest");
    assert.equal(result.info.core.license.plan, "free");
    assert.equal(stored.binary.tierMode, "pro");

    const analysis = await service.analyzeImportZip(zipPath);
    assert.equal(analysis.targetTier, "pro");
    assert.equal(analysis.targetCacheDir, path.join(cacheRoot, "chromium-146.0.7680.177.5-pro"));
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService derives the free tier from a license key the server rejects", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let stored = settings({
    preferExistingCache: false,
    tierMode: "pro",
    licenseKey: "revoked-license",
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => stored,
    saveSettings: async (patch) => {
      stored = normalizeSettings({ ...stored, ...patch });
      return stored;
    },
    // The live server answers a bogus key with valid:false and a plan name of its own choosing
    // ("unknown"), and the wrapper then logs "using free tier" and takes the free path. Deriving Pro
    // from that plan name would file every build under a tier launches never resolve.
    loadCloakBrowser: async () => fakeCloakBrowserModule({ license: { valid: false, plan: "unknown", expires: null } }),
  });

  try {
    const result = await service.install();

    assert.equal(result.info.core.targetTier, "free");
    assert.equal(result.info.core.planIsFree, false);
    assert.equal(result.info.core.license.valid, false);
    assert.equal(result.info.core.license.plan, "unknown");
    assert.equal(stored.binary.tierMode, "free");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps the cached tier and reports an unknown plan when validation fails", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      preferExistingCache: false,
      tierMode: "pro",
      licenseKey: "paid-license",
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({ license: null, tier: "pro" }),
  });

  try {
    const result = await service.install();

    // An unreachable license server must not downgrade a Pro install to free, and it must not claim a
    // plan it could not confirm.
    assert.equal(result.info.core.targetTier, "pro");
    assert.equal(result.info.core.planIsFree, false);
    assert.equal(result.info.core.license.plan, undefined);
    assert.equal(result.info.core.license.active, true);
    assert.match(result.info.core.license.error ?? "", /unavailable/);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService preserves an external license and version env when settings are empty", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  process.env.CLOAKBROWSER_VERSION = "147.0.7700.1";
  process.env.CLOAKBROWSER_LICENSE_KEY = "external-license";
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      version: "147.0.7700.1",
      tier: "pro",
      cacheDir: "C:/cache/chromium-147.0.7700.1-pro",
      binaryPath: "C:/cache/chromium-147.0.7700.1-pro/chrome.exe",
    }),
  });

  try {
    const result = await service.readPublicInfo();
    const version = result.core.env.find((item) => item.key === "CLOAKBROWSER_VERSION");
    const license = result.core.env.find((item) => item.key === "CLOAKBROWSER_LICENSE_KEY");

    assert.equal(process.env.CLOAKBROWSER_VERSION, "147.0.7700.1");
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, "external-license");
    assert.equal(result.core.targetTier, "free");
    assert.equal(result.core.versionMode, "pinned");
    assert.equal(result.core.pinnedVersion, "147.0.7700.1");
    assert.equal(version?.source, "external");
    assert.equal(version?.value, "147.0.7700.1");
    assert.equal(license?.source, "external");
    assert.equal(license?.value, "external-license");
    assert.equal(license?.maskedValue, "****");
    assert.equal(result.env.licenseKey, "****");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService reads wrapper diagnostics through the upstream CLI with managed env", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const envSnapshots: Array<{ license?: string; version?: string }> = [];
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async () => {
      envSnapshots.push({
        license: process.env.CLOAKBROWSER_LICENSE_KEY,
        version: process.env.CLOAKBROWSER_VERSION,
      });
      return {
        environment: {
          node: "v26.2.0",
          os: "Windows_NT",
          arch: "x64",
          platform_tag: "windows-x64",
        },
        binary: {
          version: "147.0.7700.1",
          tier: "pro",
          bundled_version: "146.0.7680.177.5",
          path: "C:/cache/chrome.exe",
          installed: true,
          cache_dir: "C:/cache",
          override: null,
        },
        launch: {
          tested: true,
          ok: true,
          version: "Chromium 147.0.7700.1",
          error: "",
        },
        license: {
          tier: "team",
          valid: true,
          sessions: {
            active: 2,
            limit: 5,
            state: "ok",
            reason: null,
          },
        },
        geoip: {
          db_present: true,
          path: "C:/cache/geoip/GeoLite2-City.mmdb",
        },
        modules: {
          "playwright-core": true,
          "puppeteer-core": true,
          "mmdb-lib": false,
        },
      };
    },
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      tierMode: "pro",
      licenseKey: "license-secret",
      browserVersionMode: "pinned",
      pinnedBrowserVersion: "147.0.7700.1",
    }),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics();

    assert.equal(envSnapshots.length, 1);
    assert.equal(envSnapshots[0]?.license, "license-secret");
    assert.equal(envSnapshots[0]?.version, "147.0.7700.1");
    assert.equal(result.available, true);
    assert.equal(result.binary?.tier, "pro");
    assert.equal(result.binary?.version, "147.0.7700.1");
    assert.equal(result.license?.tier, "team");
    assert.equal(result.license?.sessions?.active, 2);
    assert.equal(result.license?.sessions?.limit, 5);
    assert.equal(result.license?.sessions?.state, "ok");
    assert.equal(result.license?.sessions?.reason, null);
    assert.equal(result.geoip?.dbPresent, true);
    assert.equal(result.modules?.["mmdb-lib"], false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService preserves null wrapper diagnostics active session counts", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async () => ({
      license: {
        tier: "team",
        valid: true,
        sessions: {
          active: null,
        },
      },
    }),
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics();

    assert.equal(result.license?.sessions?.active, null);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService returns a stable error payload when wrapper diagnostics fail", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async () => {
      throw new Error("diagnostics unavailable");
    },
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics();

    assert.equal(result.available, false);
    assert.equal(result.error, "diagnostics unavailable");
  } finally {
    restoreEnv(originalEnv);
  }
});

// Upstream keys the payload `exit_ip`; every other diagnostics field is camelCased on the way in and
// this one is no different. A UI reading `exit_ip` straight off the payload is exactly what the
// normalizer exists to prevent.
test("BinaryService camelCases the resolved GeoIP payload from the upstream CLI", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const proxiesSeen: Array<string | undefined> = [];
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async (_quick, proxy) => {
      proxiesSeen.push(proxy);
      return {
        geoip: {
          db_present: true,
          path: "C:/cache/geoip/GeoLite2-City.mmdb",
          resolved: { exit_ip: "203.0.113.42", timezone: "Asia/Tokyo", locale: "ja-JP" },
        },
      };
    },
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics({ proxy: "http://proxy.example.test:8080" });

    assert.deepEqual(proxiesSeen, ["http://proxy.example.test:8080"]);
    assert.equal(result.geoip?.resolved?.exitIp, "203.0.113.42");
    assert.equal(result.geoip?.resolved?.timezone, "Asia/Tokyo");
    assert.equal(result.geoip?.resolved?.locale, "ja-JP");
    assert.equal(result.geoip?.resolved?.error, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

// Upstream keeps the key with null fields when it resolves nothing and prints `(unknown)` for each.
// Collapsing it to absent would tell the panel "no proxy was given", so an operator who just clicked
// resolve would see an unchanged view with nothing explaining it.
test("BinaryService keeps a resolved GeoIP payload whose fields all came back null", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async () => ({
      geoip: {
        db_present: false,
        resolved: { exit_ip: null, timezone: null, locale: null },
      },
    }),
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics({ proxy: "http://proxy.example.test:8080" });

    assert.equal(result.geoip?.dbPresent, false);
    assert.ok(result.geoip?.resolved, "resolved must survive a payload of nulls");
    assert.equal(result.geoip?.resolved?.exitIp, undefined);
    assert.equal(result.geoip?.resolved?.timezone, undefined);
    assert.equal(result.geoip?.resolved?.locale, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

// Still absent when no proxy was supplied — that is the distinction the key carries.
test("BinaryService reports no resolved GeoIP key at all when the wrapper wrote none", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async () => ({ geoip: { db_present: true, path: "C:/cache/geoip/GeoLite2-City.mmdb" } }),
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics();

    assert.equal(result.geoip?.dbPresent, true);
    assert.equal(result.geoip?.resolved, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

// The panel's own diagnostics path, not the injected CLI. Without a proxy it must resolve nothing and
// call nothing — upstream keeps plain `info` free of network calls and so does this.
test("BinaryService resolves launch GeoIP only when a proxy is supplied", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const resolverCalls: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    resolveLaunchGeo: async (proxyUrl) => {
      resolverCalls.push(proxyUrl);
      return { exitIp: "198.51.100.7", timezone: "Europe/Berlin", locale: "de-DE" };
    },
  });

  try {
    const withoutProxy = await service.readWrapperDiagnostics({ quick: true });
    assert.equal(withoutProxy.geoip?.resolved, undefined);
    assert.deepEqual(resolverCalls, []);

    const withProxy = await service.readWrapperDiagnostics({ quick: true, proxy: "socks5://proxy.example.test:1080" });
    assert.deepEqual(resolverCalls, ["socks5://proxy.example.test:1080"]);
    assert.equal(withProxy.geoip?.resolved?.exitIp, "198.51.100.7");
    assert.equal(withProxy.geoip?.resolved?.timezone, "Europe/Berlin");
    assert.equal(withProxy.geoip?.resolved?.locale, "de-DE");
    assert.equal(withProxy.geoip?.resolved?.unresolvedReason, undefined);
    // The database row is independent of the resolution and keeps reporting the cache as it stands.
    assert.match(withProxy.geoip?.path ?? "", /GeoLite2-City\.mmdb$/);
  } finally {
    restoreEnv(originalEnv);
  }
});

// The reason is not part of upstream's payload, and it has to survive anyway: CBPanel never downloads the
// database, so "not downloaded yet" is the outcome an operator will hit most often and the one that would
// otherwise show as an exit IP beside two unexplained blanks.
test("BinaryService carries the unresolved reason into the diagnostics payload", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    resolveLaunchGeo: async () => ({ exitIp: "203.0.113.9", unresolvedReason: "geoip-db-missing" }),
  });

  try {
    const result = await service.readWrapperDiagnostics({ quick: true, proxy: "http://proxy.example.test:8080" });

    assert.equal(result.geoip?.resolved?.exitIp, "203.0.113.9");
    assert.equal(result.geoip?.resolved?.timezone, undefined);
    assert.equal(result.geoip?.resolved?.unresolvedReason, "geoip-db-missing");
    // Not an error: the exit IP resolved. The two must never be reported together.
    assert.equal(result.geoip?.resolved?.error, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

// A reason the panel cannot translate would render as a blank note, so an unknown value is dropped rather
// than passed through to a lookup that has no key for it.
test("BinaryService ignores an unrecognized unresolved reason", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const loadCloakBrowserDiagnostics: NonNullable<BinaryServiceOptions["loadCloakBrowserDiagnostics"]> = async () => ({
    collectDiagnostics: async () => ({
      geoip: { db_present: true, resolved: { exit_ip: "203.0.113.9", unresolved_reason: "something-new" } },
    }),
  });
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    loadCloakBrowserDiagnostics,
  });

  try {
    const result = await service.readWrapperDiagnostics({ proxy: "http://proxy.example.test:8080" });

    assert.equal(result.geoip?.resolved?.exitIp, "203.0.113.9");
    assert.equal(result.geoip?.resolved?.unresolvedReason, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

// A proxy that cannot be reached must not blank the binary, launch and license sections alongside it —
// the resolution is one row, and upstream isolates its failure to `{ error }` for the same reason.
test("BinaryService keeps the rest of the diagnostics when launch GeoIP resolution fails", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    resolveLaunchGeo: async () => {
      throw new Error("代理连接已关闭，出口检测失败。");
    },
  });

  try {
    const result = await service.readWrapperDiagnostics({ quick: true, proxy: "http://proxy.example.test:8080" });

    assert.equal(result.available, true);
    assert.equal(result.geoip?.resolved?.error, "代理连接已关闭，出口检测失败。");
    assert.equal(result.geoip?.resolved?.exitIp, undefined);
    assert.ok(result.environment?.node);
  } finally {
    restoreEnv(originalEnv);
  }
});

// The path both the diagnostics row and the launch-geoip lookup read. If they ever disagree the panel
// reports on a file the browser does not use. Async on purpose: nothing applies the managed env at boot,
// so a caller arriving before the first browser-core read has to get the configured cache root, not the
// default one.
test("BinaryService resolves the GeoLite2 cache path from the configured cache dir", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const customCacheDir = path.join(directory, "elsewhere", "core-cache");
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir }),
  });

  try {
    // Deliberately the very first call on a fresh service: this is the cold path POST /api/proxy/geoip
    // takes, and reading process.env before anything wrote it returned the default cache dir.
    const dbPath = await service.resolveGeoipDbPath();

    assert.equal(dbPath, path.join(customCacheDir, "geoip", "GeoLite2-City.mmdb"));
    assert.equal((await service.readWrapperDiagnostics({ quick: true })).geoip?.path, dbPath);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService falls back to the managed cache root for the GeoLite2 path", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
  });

  try {
    const dbPath = await service.resolveGeoipDbPath();

    assert.equal(dbPath, path.join(directory, "cloakbrowser-cache", "geoip", "GeoLite2-City.mmdb"));
    assert.equal((await service.readWrapperDiagnostics({ quick: true })).geoip?.path, dbPath);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService resolves target tier and version mode from updated settings", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let currentSettings = settings({});
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => currentSettings,
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule(),
      binaryInfo: (browserVersion?: string) => fakeBinaryInfo({
        version: browserVersion ?? "146.0.7680.177.5",
      }),
    } as CloakBrowserModule),
  });

  try {
    const first = await service.readPublicInfo();
    assert.equal(first.core.targetTier, "free");
    assert.equal(first.core.versionMode, "latest");

    currentSettings = settings({
      tierMode: "pro",
      licenseKey: "license-secret",
      browserVersionMode: "pinned",
      pinnedBrowserVersion: "147.0.7700.1",
    });

    const second = await service.readPublicInfo();
    assert.equal(second.core.targetTier, "pro");
    assert.equal(second.core.versionMode, "pinned");
    assert.equal(second.core.pinnedVersion, "147.0.7700.1");
    assert.equal(second.version, "147.0.7700.1");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService does not empty the cache when an update resolves a build that is not there", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The state a below-baseline downgrade import leaves: the only build on disk is older than the
  // wrapper's baseline, so the free marker resolution is clamped and binaryInfo names a directory that
  // does not exist. A no-op update must not treat the one real build as superseded.
  const onlyDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  await fs.mkdir(onlyDir, { recursive: true });
  await fs.writeFile(path.join(onlyDir, "chrome.exe"), "x");
  await fs.writeFile(path.join(cacheRoot, "latest_version_windows-x64"), "145.0.7632.109.2");
  const absentBaselineDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        version: "146.0.7680.177.5",
        binaryPath: path.join(absentBaselineDir, "chrome.exe"),
        cacheDir: absentBaselineDir,
        installed: false,
      }),
      // Offline: upstream swallows the network error and reports no newer build without throwing.
      checkForUpdate: async () => null,
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.equal(result.version, null);
    assert.equal(await exists(path.join(onlyDir, "chrome.exe")), true);
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "145.0.7632.109.2",
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService blocks automatic update while browser version is pinned", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let ensureCalls = 0;
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      browserVersionMode: "pinned",
      pinnedBrowserVersion: "146.0.7680.177.5",
    }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true }),
      ensureBinary: async () => {
        ensureCalls += 1;
        return "C:/cache/chrome.exe";
      },
    } as CloakBrowserModule),
  });

  try {
    await assert.rejects(() => service.update(), /Pinned browser version is enabled/);
    assert.equal(ensureCalls, 0);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService refreshes cached update state after a successful update", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const oldUpdateCheck = {
    checkedAt: "2026-06-06T00:00:00.000Z",
    currentVersion: "146.0.7680.177.5",
    latestVersion: "147.0.7700.1",
    updateAvailable: true,
  };
  let currentSettings = settings({ lastUpdateCheck: oldUpdateCheck });
  let runtimeVersion = "146.0.7680.177.5";
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => currentSettings,
    saveSettings: async (patch) => {
      currentSettings = normalizeSettings({
        ...currentSettings,
        binary: {
          ...currentSettings.binary,
          ...(patch.binary ?? {}),
        },
      });
      return currentSettings;
    },
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true }),
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        version: runtimeVersion,
        binaryPath: `C:/cache/chromium-${runtimeVersion}/chrome.exe`,
        cacheDir: `C:/cache/chromium-${runtimeVersion}`,
      }),
      checkForUpdate: async () => {
        runtimeVersion = "147.0.7700.1";
        return runtimeVersion;
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.equal(result.version, "147.0.7700.1");
    assert.equal(result.info.version, "147.0.7700.1");
    assert.equal(result.info.core.update?.currentVersion, "147.0.7700.1");
    assert.equal(result.info.core.update?.latestVersion, "147.0.7700.1");
    assert.equal(result.info.core.update?.updateAvailable, false);
    assert.equal(result.info.core.update?.blockedReason, undefined);
    assert.equal(currentSettings.binary.lastUpdateCheck?.currentVersion, "147.0.7700.1");
    assert.equal(currentSettings.binary.lastUpdateCheck?.updateAvailable, false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService updates a Free GitHub key through ensureBinary without a version pin", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const ensureCalls: Array<{ licenseKey?: string; browserVersion?: string; autoUpdate?: string }> = [];
  let checkForUpdateCalls = 0;
  let runtimeVersion = "146.0.7680.177.5";
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "free", licenseKey: "free-license" }),
    fetchImpl: async () => Response.json({ version: "150.0.0.0" }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true }),
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        version: runtimeVersion,
        tier: "pro",
        binaryPath: `C:/cache/chromium-${runtimeVersion}-pro/chrome.exe`,
        cacheDir: `C:/cache/chromium-${runtimeVersion}-pro`,
      }),
      ensureBinary: async (licenseKey?: string, browserVersion?: string) => {
        ensureCalls.push({ licenseKey, browserVersion, autoUpdate: process.env.CLOAKBROWSER_AUTO_UPDATE });
        runtimeVersion = "150.0.0.0";
        return `C:/cache/chromium-${runtimeVersion}-pro/chrome.exe`;
      },
      checkForUpdate: async () => {
        checkForUpdateCalls += 1;
        return null;
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.deepEqual(ensureCalls, [{ licenseKey: "free-license", browserVersion: undefined, autoUpdate: "true" }]);
    assert.equal(checkForUpdateCalls, 0);
    assert.equal(result.version, "150.0.0.0");
    assert.equal(result.info.core.targetTier, "free");
    assert.equal(process.env.CLOAKBROWSER_AUTO_UPDATE, "false");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService passes the checked version to explicit Pro updates", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const ensureCalls: Array<{ licenseKey?: string; browserVersion?: string; autoUpdate?: string }> = [];
  let runtimeVersion = "146.0.7680.177.5";
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "pro", licenseKey: "pro-license" }),
    fetchImpl: async () => Response.json({ version: "150.0.0.0" }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true }),
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        version: runtimeVersion,
        tier: "pro",
        binaryPath: `C:/cache/chromium-${runtimeVersion}-pro/chrome.exe`,
        cacheDir: `C:/cache/chromium-${runtimeVersion}-pro`,
      }),
      ensureBinary: async (licenseKey?: string, browserVersion?: string) => {
        ensureCalls.push({ licenseKey, browserVersion, autoUpdate: process.env.CLOAKBROWSER_AUTO_UPDATE });
        runtimeVersion = "150.0.0.0";
        return `C:/cache/chromium-${runtimeVersion}-pro/chrome.exe`;
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.deepEqual(ensureCalls, [{ licenseKey: "pro-license", browserVersion: "150.0.0.0", autoUpdate: "true" }]);
    assert.equal(result.version, "150.0.0.0");
    assert.equal(process.env.CLOAKBROWSER_AUTO_UPDATE, "false");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService asks for the preview build when checking authenticated updates on that channel", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const requestedUrls: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "pro", licenseKey: "pro-license", releaseChannel: "preview" }),
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      return Response.json({ version: "150.0.0.0" });
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true, tier: "pro" }),
  });

  try {
    await service.checkUpdate();

    assert.deepEqual(requestedUrls, ["https://cloakbrowser.dev/api/download/version?channel=preview"]);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService checks authenticated updates without a channel on stable", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const requestedUrls: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "pro", licenseKey: "pro-license", releaseChannel: "stable" }),
    fetchImpl: async (input) => {
      requestedUrls.push(String(input));
      return Response.json({ version: "150.0.0.0" });
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true, tier: "pro" }),
  });

  try {
    await service.checkUpdate();

    assert.deepEqual(requestedUrls, ["https://cloakbrowser.dev/api/download/version"]);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService does not report an authenticated update when the cached binary remains current", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "free", licenseKey: "free-license" }),
    fetchImpl: async () => Response.json({ version: "150.0.0.0" }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true }),
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        version: "146.0.7680.177.5",
        tier: "pro",
        binaryPath: "C:/cache/chromium-146.0.7680.177.5-pro/chrome.exe",
        cacheDir: "C:/cache/chromium-146.0.7680.177.5-pro",
      }),
      ensureBinary: async () => "C:/cache/chromium-146.0.7680.177.5-pro/chrome.exe",
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.equal(result.version, null);
    assert.equal(result.info.core.operation?.logs.at(-1)?.message, "No newer Chromium binary is available.");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService repairs a compatible managed cache directory and reports installed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const importedCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177");
  await fs.mkdir(importedCacheDir, { recursive: true });
  await fs.writeFile(path.join(importedCacheDir, "chrome.exe"), "");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: false,
    }),
  });

  try {
    const info = await service.readPublicInfo();

    assert.equal(info.installed, true);
    assert.equal(info.binaryPath, path.join(wrapperCacheDir, "chrome.exe"));
    assert.ok(await exists(path.join(wrapperCacheDir, "chrome.exe")));
    assert.equal(await exists(path.join(importedCacheDir, "chrome.exe")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService imports local ZIP into the wrapper-compatible cache and reports installed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: false,
    }),
  });

  try {
    const analysis = await service.analyzeImportZip(zipPath);
    assert.equal(analysis.importedVersion, "146.0.7680.177.5");
    assert.equal(analysis.targetCacheDir, wrapperCacheDir);
    assert.equal(analysis.allowed, true);

    const result = await service.installImportZip(zipPath);
    assert.equal(result.info.installed, true);
    assert.equal(result.info.binaryPath, path.join(wrapperCacheDir, "chrome.exe"));
    assert.ok(await exists(path.join(wrapperCacheDir, "chrome.exe")));
    assert.equal(result.info.core.operation?.status, "succeeded");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService stages an import inside the cache root and clears stale staging dirs", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const staleStaging = path.join(cacheRoot, "import-staging-stale");
  const liveStaging = path.join(cacheRoot, "import-staging-live");
  await fs.mkdir(staleStaging, { recursive: true });
  await fs.writeFile(path.join(staleStaging, "leftover.bin"), "x");
  // Backdate past the stale floor; a concurrent import's directory is fresh and must survive.
  const longAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
  await fs.utimes(staleStaging, longAgo, longAgo);
  await fs.mkdir(liveStaging, { recursive: true });
  await fs.writeFile(path.join(liveStaging, "in-flight.bin"), "x");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const result = await service.installImportZip(zipPath);

    assert.equal(result.info.installed, true);
    assert.equal(await exists(staleStaging), false);
    // A live concurrent staging directory is left alone, and the import leaves none of its own.
    assert.equal(await exists(path.join(liveStaging, "in-flight.bin")), true);
    const leftovers = (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("import-staging-"));
    assert.deepEqual(leftovers, ["import-staging-live"]);
    // dataDir/tmp is no longer used for staging at all.
    assert.equal(await exists(path.join(directory, "tmp")), false);
    // A free import registers the build where the wrapper's free resolution looks for it.
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService records an imported build's provenance inside the build directory", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const result = await service.installImportZip(zipPath);

    // Inside the build it describes, so every path that removes a build takes the claim with it and no
    // settings field can outlive the cache still saying "local".
    const marker = JSON.parse(await fs.readFile(path.join(wrapperCacheDir, "cbpanel-import.json"), "utf8")) as Record<string, unknown>;
    assert.equal(marker.source, "offline-import");
    assert.equal(marker.version, "146.0.7680.177.5");
    assert.equal(marker.tier, "free");
    assert.equal(marker.fileName, "cloakbrowser-windows-x64.zip");
    assert.equal(marker.sha256, result.analysis.sha256);

    const imported = result.info.core.importedBuild;
    assert.equal(imported?.source, "offline-import");
    assert.equal(imported?.version, "146.0.7680.177.5");
    assert.equal(imported?.tier, "free");
    assert.equal(imported?.fileName, "cloakbrowser-windows-x64.zip");
    assert.ok(Number.isFinite(Date.parse(imported?.importedAt ?? "")));
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService drops import provenance once the imported build is pruned away", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const importedDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const downloadedDir = path.join(cacheRoot, "chromium-147.0.7700.1");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));
  const importSettings = async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot });

  const importer = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: importSettings,
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(importedDir, "chrome.exe"),
      cacheDir: importedDir,
      installed: true,
    }),
  });

  try {
    assert.equal((await importer.installImportZip(zipPath)).info.core.importedBuild?.version, "146.0.7680.177.5");

    // The state a later install leaves: a newer build downloaded, so the wrapper resolves that one and the
    // imported build is superseded. Built after the import on purpose — a directory sitting there first
    // would be the build *that* import supersedes, which is the opposite case.
    await fs.mkdir(downloadedDir, { recursive: true });
    await fs.writeFile(path.join(downloadedDir, "chrome.exe"), "x");
    const installer = new BinaryService({
      dataDir: directory,
      portable: true,
      readSettings: importSettings,
      loadCloakBrowser: async () => fakeCloakBrowserModule({
        binaryPath: path.join(downloadedDir, "chrome.exe"),
        cacheDir: downloadedDir,
        installed: true,
        version: "147.0.7700.1",
      }),
    });

    const installed = await installer.install();

    // pruneToSingleBuild removed the directory, so the claim went with it — nothing had to remember to
    // clear a flag.
    assert.equal(await exists(importedDir), false);
    assert.equal(installed.info.core.importedBuild, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService drops import provenance when the managed cache is cleared", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
        cacheDir: wrapperCacheDir,
        installed: true,
      }),
      // Upstream's clearCache removes the managed cache root, which is the whole reason the provenance
      // lives inside a build in it: nothing has to remember to clear it separately.
      clearCache: () => rmSync(cacheRoot, { recursive: true, force: true }),
    } as CloakBrowserModule),
  });

  try {
    assert.equal((await service.installImportZip(zipPath)).info.core.importedBuild?.version, "146.0.7680.177.5");

    const cleared = await service.clearCache();

    assert.equal(await exists(wrapperCacheDir), false);
    assert.equal(cleared.info.core.importedBuild, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps import provenance across a compatible cache repair but not across another build", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const markerPath = path.join(wrapperCacheDir, "cbpanel-import.json");
  await fs.mkdir(wrapperCacheDir, { recursive: true });
  await fs.writeFile(path.join(wrapperCacheDir, "chrome.exe"), "x");
  const marker = (version: string) => JSON.stringify({
    source: "offline-import",
    version,
    tier: "free",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "a".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  });

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    // What a repaired cache looks like: repairCompatibleManagedCache renamed chromium-146.0.7680.177 —
    // marker and all — onto the resolved chromium-146.0.7680.177.5, so the marker's own version is now
    // shorter than the reported one. Demanding the exact string dropped the badge *and* the update guard
    // at exactly that point, which is the guard the marker exists for. The archive's version is what comes
    // back, and the badge's tooltip labels it as the archive's.
    await fs.writeFile(markerPath, marker("146.0.7680.177"));
    assert.equal((await service.readPublicInfo()).core.importedBuild?.version, "146.0.7680.177");

    // The discrimination the relaxation must not cost: a marker naming a genuinely different build is still
    // no provenance. Only the repair ever moves a marker, and it removes the destination first, so a marker
    // for another build is stale or hand-edited — vouching for it would be a guess.
    await fs.writeFile(markerPath, marker("145.0.7632.109.2"));
    assert.equal((await service.readPublicInfo()).core.importedBuild, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService clears stale import provenance from a build it just downloaded", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The one shape that could still have the badge vouch for a downloaded build: the wrapper extracts a
  // download into a directory an import already marked. It needs the resolved version to equal the
  // imported one and the build there to be broken enough to force the download — which is what
  // installed: false against an existing directory is.
  const buildDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const markerPath = path.join(buildDir, "cbpanel-import.json");
  await fs.mkdir(buildDir, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    source: "offline-import",
    version: "146.0.7680.177.5",
    tier: "free",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "c".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(buildDir, "chrome.exe"),
        cacheDir: buildDir,
        installed: false,
      }),
      // The download landing: upstream extracts into the resolved build directory and leaves whatever
      // else already sat in it.
      ensureBinary: async () => {
        await fs.writeFile(path.join(buildDir, "chrome.exe"), "x");
        return path.join(buildDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.install();

    // A downloaded build is not an offline import, whatever the directory used to hold — so the badge and
    // the update guard cannot end up speaking for it.
    assert.equal(await exists(markerPath), false);
    assert.equal(result.info.core.importedBuild, undefined);
    // Only the marker goes. The build the download just wrote has to survive intact.
    assert.equal(await exists(path.join(buildDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService clears stale import provenance from a build an authenticated update downloaded", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The download's target directory already carries a marker, left by an earlier import of that same
  // version whose build is long gone. The authenticated path resolves the version itself, so this pins the
  // ensureBinary branch of update rather than install's.
  const downloadedDir = path.join(cacheRoot, "chromium-150.0.0.0-pro");
  const markerPath = path.join(downloadedDir, "cbpanel-import.json");
  await fs.mkdir(downloadedDir, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    source: "offline-import",
    version: "150.0.0.0",
    tier: "pro",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "d".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  }));
  let runtimeVersion = "146.0.7680.177.5";

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      tierMode: "pro",
      licenseKey: "pro-license",
    }),
    fetchImpl: async () => Response.json({ version: "150.0.0.0" }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true, tier: "pro" }),
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        tier: "pro",
        version: runtimeVersion,
        binaryPath: path.join(cacheRoot, `chromium-${runtimeVersion}-pro`, "chrome.exe"),
        cacheDir: path.join(cacheRoot, `chromium-${runtimeVersion}-pro`),
      }),
      ensureBinary: async () => {
        runtimeVersion = "150.0.0.0";
        await fs.writeFile(path.join(downloadedDir, "chrome.exe"), "x");
        return path.join(downloadedDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.equal(result.version, "150.0.0.0");
    assert.equal(await exists(markerPath), false);
    assert.equal(result.info.core.importedBuild, undefined);
    assert.equal(await exists(path.join(downloadedDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService clears stale import provenance from an authenticated download that reports no newer version", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The case that decides where the authenticated branch reads its build directory from. The release
  // metadata is ahead of what the wrapper resolves off disk, so ensureBinary downloads — but the refreshed
  // report is no newer than the one before it, and `version` therefore comes back null. Keying the clear
  // off that null would leave the marker on a build this run downloaded, which is the whole shape the
  // clear exists to rule out; keying it off what ensureBinary handed back does not.
  const downloadedDir = path.join(cacheRoot, "chromium-150.0.0.0-pro");
  const markerPath = path.join(downloadedDir, "cbpanel-import.json");
  await fs.mkdir(downloadedDir, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    source: "offline-import",
    version: "150.0.0.0",
    tier: "pro",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "1".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      tierMode: "pro",
      licenseKey: "pro-license",
    }),
    fetchImpl: async () => Response.json({ version: "150.0.0.0" }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true, tier: "pro" }),
      // Never moves: the wrapper keeps resolving the build it resolved before the download, so the
      // comparison against it yields null.
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        tier: "pro",
        binaryPath: path.join(cacheRoot, "chromium-146.0.7680.177.5-pro", "chrome.exe"),
        cacheDir: path.join(cacheRoot, "chromium-146.0.7680.177.5-pro"),
      }),
      ensureBinary: async () => {
        await fs.writeFile(path.join(downloadedDir, "chrome.exe"), "x");
        return path.join(downloadedDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    // Reported as "nothing newer", because nothing the wrapper resolves is newer — and the marker is gone
    // all the same, because a build was downloaded over it.
    assert.equal(result.version, null);
    assert.equal(await exists(markerPath), false);
    assert.equal(await exists(path.join(downloadedDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService clears stale import provenance when an update check downloads a build", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // No license key, so update goes through checkForUpdate — which both checks and installs. A version
  // back from it means a build was downloaded, and here it lands in a directory a stale marker already
  // claims.
  const downloadedDir = path.join(cacheRoot, "chromium-147.0.7700.1");
  const markerPath = path.join(downloadedDir, "cbpanel-import.json");
  await fs.mkdir(downloadedDir, { recursive: true });
  await fs.writeFile(markerPath, JSON.stringify({
    source: "offline-import",
    version: "147.0.7700.1",
    tier: "free",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "e".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  }));
  let runtimeVersion = "146.0.7680.177.5";

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ installed: true }),
      binaryInfo: () => fakeBinaryInfo({
        installed: true,
        version: runtimeVersion,
        binaryPath: path.join(cacheRoot, `chromium-${runtimeVersion}`, "chrome.exe"),
        cacheDir: path.join(cacheRoot, `chromium-${runtimeVersion}`),
      }),
      checkForUpdate: async () => {
        runtimeVersion = "147.0.7700.1";
        await fs.writeFile(path.join(downloadedDir, "chrome.exe"), "x");
        return runtimeVersion;
      },
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.equal(result.version, "147.0.7700.1");
    assert.equal(await exists(markerPath), false);
    assert.equal(result.info.core.importedBuild, undefined);
    assert.equal(await exists(path.join(downloadedDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps import provenance when an update check downloads nothing", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The other side of the coin: checkForUpdate answers null when the cache is already current, so no
  // build changed hands and the build on disk still is the imported one. Treating "checked and found
  // nothing" as a download would strip the badge and the update guard off a build nobody replaced.
  const importedDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const markerPath = path.join(importedDir, "cbpanel-import.json");
  await fs.mkdir(importedDir, { recursive: true });
  await fs.writeFile(path.join(importedDir, "chrome.exe"), "x");
  await fs.writeFile(markerPath, JSON.stringify({
    source: "offline-import",
    version: "146.0.7680.177.5",
    tier: "free",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "f".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(importedDir, "chrome.exe"),
        cacheDir: importedDir,
        installed: true,
      }),
      checkForUpdate: async () => null,
    } as CloakBrowserModule),
  });

  try {
    const result = await service.update();

    assert.equal(result.version, null);
    assert.equal(await exists(markerPath), true);
    assert.equal(result.info.core.importedBuild?.version, "146.0.7680.177.5");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService reads a corrupted import marker as no provenance rather than failing the read", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  await fs.mkdir(wrapperCacheDir, { recursive: true });
  await fs.writeFile(path.join(wrapperCacheDir, "chrome.exe"), "x");
  // A process killed mid-write, or an operator with an editor. readPublicInfo backs the polled
  // GET /api/browser-core and every session launch check, so a decorative badge must not be able to 500 it.
  await fs.writeFile(path.join(wrapperCacheDir, "cbpanel-import.json"), "{\"source\": \"offline-imp");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const info = await service.readPublicInfo();

    assert.equal(info.installed, true);
    assert.equal(info.core.importedBuild, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService says an update check is unsound when its baseline is an import from another tier", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // A Pro package imported while the licence was in play, read back with the licence switched off: the
  // wrapper still reports the Pro build (its tier comes off disk), but downloads now come from the free
  // GitHub feed, whose tags carry four segments against the Pro build's five. compareVersions then rates
  // the local build newer for ever, so the check answers "up to date" and can never say anything else.
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  const markerPath = path.join(wrapperCacheDir, "cbpanel-import.json");
  await fs.mkdir(wrapperCacheDir, { recursive: true });
  await fs.writeFile(path.join(wrapperCacheDir, "chrome.exe"), "x");
  const marker = {
    source: "offline-import",
    version: "146.0.7680.177.5",
    tier: "pro",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "b".repeat(64),
    importedAt: "2026-08-01T09:30:00.000Z",
  };
  await fs.writeFile(markerPath, JSON.stringify(marker));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    fetchImpl: async () => Response.json([
      {
        tag_name: "chromium-v146.0.7680.177",
        draft: false,
        assets: [{ name: "cloakbrowser-windows-x64.zip" }],
      },
    ]),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
      tier: "pro",
    }),
  });

  try {
    const mismatched = await service.checkUpdate();

    assert.equal(mismatched.update.updateAvailable, false);
    assert.equal(mismatched.update.targetTier, "free");
    assert.equal(mismatched.update.baselineCaveat, "offline-import-tier-mismatch");

    // The caveat is about the tiers disagreeing, not about the build being imported at all: an import
    // filed under the tier this configuration downloads for is compared against its own feed, so that
    // verdict stands. Only the marker's tier moves — it is the field the check reads.
    await fs.writeFile(markerPath, JSON.stringify({ ...marker, tier: "free" }));

    assert.equal((await service.checkUpdate()).update.baselineCaveat, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService cancels an in-flight operation and frees the guard for the next one", async () => {
  const originalEnv = captureEnv();
  const originalFetch = globalThis.fetch;
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  let downloadStarted: () => void = () => undefined;
  const downloadReached = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
        cacheDir: wrapperCacheDir,
        installed: false,
      }),
      // Downloads the way upstream does: bare fetch, which resolves globalThis.fetch at call time and is
      // therefore the layer the cancel wraps.
      ensureBinary: async () => {
        downloadStarted();
        await fetch("https://cloakbrowser.dev/api/download/146.0.7680.177.5");
        return path.join(wrapperCacheDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  // A request that only ends when its signal is aborted, standing in for a long download.
  globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;

  try {
    const install = service.install();
    await downloadReached;

    assert.deepEqual(service.cancelOperation(), { cancelled: true, operation: "install" });

    const cancelled = await install.then(() => undefined, (error: Error & { status?: number; code?: string }) => error);
    assert.equal(cancelled?.status, 409);
    assert.equal(cancelled?.code, "BROWSER_CORE_OPERATION_CANCELLED");
    // The guard is released by runExclusively's own finally, so the next operation is accepted rather
    // than 409'd for ever by an operation nobody can see any more.
    assert.equal(service.activeCacheOperation(), undefined);
    assert.equal(service.cancelOperation().cancelled, false);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps upstream's own abort signal when it wraps fetch for cancelling", async () => {
  const originalEnv = captureEnv();
  const originalFetch = globalThis.fetch;
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
        cacheDir: wrapperCacheDir,
        installed: false,
      }),
      ensureBinary: async () => {
        // Upstream passes its own controller on the binary download, and that is what carries its
        // ten-minute bound — replacing the signal instead of combining it would silently remove it.
        const own = new AbortController();
        setTimeout(() => own.abort(new Error("upstream timeout")), 5);
        await fetch("https://cloakbrowser.dev/api/download/146.0.7680.177.5", { signal: own.signal });
        return path.join(wrapperCacheDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  globalThis.fetch = ((_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    })) as typeof fetch;

  try {
    const failure = await service.install().then(() => undefined, (error: Error & { code?: string }) => error);

    // Aborted by upstream's own signal, so it is a failure and not a cancellation.
    assert.ok(failure);
    assert.notEqual(failure?.code, "BROWSER_CORE_OPERATION_CANCELLED");
    assert.equal(service.activeCacheOperation(), undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restoreEnv(originalEnv);
  }
});

test("BinaryService reports no cancellation when nothing is running", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({}),
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true }),
  });

  try {
    assert.deepEqual(service.cancelOperation(), { cancelled: false });
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService never prunes a staging directory as if it were an installed build", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // A concurrent import's staging directory, fresh so the stale sweep leaves it alone. The prune that
  // follows must not match it either — the staging prefix is deliberately outside the
  // `chromium-<version>[-pro]` shape the enumeration accepts.
  const liveStaging = path.join(cacheRoot, "import-staging-123");
  for (const dir of [wrapperCacheDir, liveStaging]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chrome.exe"), "x");
  }
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    await service.installImportZip(zipPath);

    assert.equal(await exists(path.join(liveStaging, "chrome.exe")), true);
    assert.equal(await exists(path.join(wrapperCacheDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps the managed cache root when a custom binary path is active", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // The override lives two levels up from the cache root; dirname(info.cacheDir) as the root would
  // enumerate this directory, so the prune would delete unrelated siblings and keep nothing.
  const overrideDir = path.join(directory, "external");
  const decoy = path.join(directory, "chromium-999.0.0.0");
  await fs.mkdir(overrideDir, { recursive: true });
  await fs.mkdir(decoy, { recursive: true });
  await fs.writeFile(path.join(overrideDir, "chrome.exe"), "x");
  await fs.writeFile(path.join(decoy, "chrome.exe"), "x");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      customBinaryPathEnabled: true,
      customBinaryPath: path.join(overrideDir, "chrome.exe"),
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    await service.installImportZip(zipPath);

    // withCustomBinaryOverride rewrites info.cacheDir to the override's own directory, so a prune
    // keyed off it would delete the build the import just landed. The keeper is the build the
    // unoverridden resolution names.
    assert.equal(await exists(path.join(wrapperCacheDir, "chrome.exe")), true);
    assert.equal(await exists(path.join(decoy, "chrome.exe")), true);
    assert.equal(await exists(path.join(overrideDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService writes the preview Pro marker when importing on the preview channel", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      tierMode: "pro",
      licenseKey: "pro-license",
      releaseChannel: "preview",
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: false,
      tier: "pro",
    }),
  });

  try {
    await service.installImportZip(zipPath, { targetTier: "pro" });

    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_pro_version_preview_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
    assert.equal(await exists(path.join(cacheRoot, "latest_pro_version_windows-x64")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService writes the stable Pro marker when importing on the stable channel", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      tierMode: "pro",
      licenseKey: "pro-license",
      releaseChannel: "stable",
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: false,
      tier: "pro",
    }),
  });

  try {
    await service.installImportZip(zipPath, { targetTier: "pro" });

    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_pro_version_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
    assert.equal(await exists(path.join(cacheRoot, "latest_pro_version_preview_windows-x64")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService leaves the free marker on the stable name even on the preview channel", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      releaseChannel: "preview",
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    await service.installImportZip(zipPath, { targetTier: "free" });

    // Upstream's free resolution ignores the channel, so a channel-suffixed free marker would be
    // written where nothing reads it.
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
    assert.equal(await exists(path.join(cacheRoot, "latest_version_preview_windows-x64")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService prunes a stale Pro build that no license key derives any more", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // A former Pro user whose key is gone. binaryInfo still reports tier "pro" here because its tier is
  // proBinaryReady(...) — read off disk with no license check — so keying the prune's keeper off it made
  // this directory a keeper on every later operation and several hundred MB never came back.
  const staleProDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  await fs.mkdir(staleProDir, { recursive: true });
  await fs.writeFile(path.join(staleProDir, "chrome.exe"), "x");
  await fs.writeFile(path.join(cacheRoot, "latest_pro_version_windows-x64"), "146.0.7680.177.5");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-147.0.7700.1/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      // What the wrapper reports while the stale Pro build is on disk: the Pro resolution, even with no
      // key configured at all.
      tier: "pro",
      version: "146.0.7680.177.5",
      binaryPath: path.join(staleProDir, "chrome.exe"),
      cacheDir: staleProDir,
      installed: true,
    }),
  });

  try {
    const result = await service.installImportZip(zipPath);

    assert.equal(result.analysis.targetTier, "free");
    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")),
      ["chromium-147.0.7700.1"],
    );
    // The pruned build's own marker goes with it, so nothing points at a directory that is gone.
    assert.equal(await exists(path.join(cacheRoot, "latest_pro_version_windows-x64")), false);
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "147.0.7700.1",
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps exactly one build after an import and clears the pruned build's marker", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const supersededDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  for (const dir of [supersededDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chrome.exe"), "x");
  }
  // The marker names the build the import supersedes; left behind it would point at nothing.
  await fs.writeFile(path.join(cacheRoot, "latest_version_windows-x64"), "145.0.7632.109.2");
  await fs.writeFile(path.join(cacheRoot, "latest_version"), "145.0.7632.109.2");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const result = await service.installImportZip(zipPath);

    assert.equal(result.info.installed, true);
    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")),
      ["chromium-146.0.7680.177.5"],
    );
    // The import's own marker replaced the pruned build's, so the pointer still names a build on disk.
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
    assert.equal(await exists(path.join(cacheRoot, "latest_version")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService defers pruning while a browser session is running", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // The build a session would be executing. Deleting it means fs.rm removing its resources and then
  // failing on the locked chrome.exe, which leaves the running browser with a gutted install.
  const inUseDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  await fs.mkdir(inUseDir, { recursive: true });
  await fs.writeFile(path.join(inUseDir, "chrome.exe"), "x");
  await fs.writeFile(path.join(cacheRoot, "latest_version_windows-x64"), "145.0.7632.109.2");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    hasActiveSessions: () => true,
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const result = await service.installImportZip(zipPath);

    assert.equal(result.info.installed, true);
    // Both builds survive: the single-build invariant yields to not corrupting a build in use.
    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")).sort(),
      ["chromium-145.0.7632.109.2", "chromium-146.0.7680.177.5"],
    );
    // The extra build is explained, so a user expecting one does not read it as a leak.
    assert.match(
      result.info.core.operation?.logs.map((entry) => entry.message).join("\n") ?? "",
      /a browser session is running/,
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService prunes to one build after an install and clears the marker it leaves dangling", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const keptDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  const supersededDir = path.join(cacheRoot, "chromium-145.0.7632.109.2-pro");
  for (const dir of [keptDir, supersededDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chrome.exe"), "x");
  }
  // Active on preview; the stable Pro marker still names the build the install supersedes. Clearing
  // it has to stay tier- and channel-scoped, so the preview pointer must survive untouched.
  await fs.writeFile(path.join(cacheRoot, "latest_pro_version_preview_windows-x64"), "146.0.7680.177.5");
  await fs.writeFile(path.join(cacheRoot, "latest_pro_version_windows-x64"), "145.0.7632.109.2");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      tierMode: "pro",
      licenseKey: "pro-license",
      releaseChannel: "preview",
      preferExistingCache: true,
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(keptDir, "chrome.exe"),
      cacheDir: keptDir,
      installed: true,
      tier: "pro",
    }),
  });

  try {
    await service.install();

    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")),
      ["chromium-146.0.7680.177.5-pro"],
    );
    assert.equal(await exists(path.join(cacheRoot, "latest_pro_version_windows-x64")), false);
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_pro_version_preview_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService leaves the surviving tier's marker alone when pruning the other tier's build", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const keptDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const proDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  for (const dir of [keptDir, proDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chrome.exe"), "x");
  }
  // Both tiers of one version are cached and both markers name it. Free and Pro coexist by design,
  // so clearing markers by version alone would strand the free pointer the kept build needs.
  await fs.writeFile(path.join(cacheRoot, "latest_version_windows-x64"), "146.0.7680.177.5");
  await fs.writeFile(path.join(cacheRoot, "latest_pro_version_windows-x64"), "146.0.7680.177.5");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(keptDir, "chrome.exe"),
      cacheDir: keptDir,
      installed: true,
    }),
  });

  try {
    await service.install();

    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")),
      ["chromium-146.0.7680.177.5"],
    );
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
    assert.equal(await exists(path.join(cacheRoot, "latest_pro_version_windows-x64")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps a downgrade import the free baseline clamp would otherwise strand", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The wrapper honours a free marker only when the version is newer than its bundled baseline, so a
  // downgrade import resolves to the baseline directory. Re-deriving the keeper from that resolution
  // deletes the build the import just wrote.
  const baselineDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const importedDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  const archivePath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(archivePath, zipSync({
    "chromium-145.0.7632.109.2/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      // Reports the clamped baseline, exactly as the real wrapper does for a below-baseline marker.
      version: "146.0.7680.177.5",
      binaryPath: path.join(baselineDir, "chrome.exe"),
      cacheDir: baselineDir,
      installed: false,
    }),
  });

  try {
    const result = await service.installImportZip(archivePath);

    assert.equal(result.analysis.importedVersion, "145.0.7632.109.2");
    assert.equal(await exists(path.join(importedDir, "chrome.exe")), true);
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "145.0.7632.109.2",
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService does not derive the tier from a license key that has been replaced", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let licenseKey = "paid-key";
  const validated: string[] = [];

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ tierMode: "free", licenseKey }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({}),
      validateLicense: async (key: string) => {
        validated.push(key);
        return key === "paid-key" ? { valid: true, plan: "pro", expires: null } : { valid: true, plan: "free", expires: null };
      },
    } as unknown as CloakBrowserModule),
  });

  try {
    await service.checkUpdate().catch(() => undefined);
    const asPaid = await service.readPublicInfo();
    assert.equal(asPaid.core.license.plan, "pro");
    assert.equal(asPaid.core.targetTier, "pro");

    // Swap the key. The previous record must not speak for the new one.
    licenseKey = "free-key";
    const afterSwap = await service.readPublicInfo();
    assert.equal(afterSwap.core.license.plan, undefined);
    assert.equal(afterSwap.core.license.checkedAt, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService prunes a compatible sibling once the resolved build is installed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const resolvedDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // Shares the Chromium build prefix. While a repair is pending it must survive; once the resolved
  // build exists no repair will ever consolidate it, so keeping it would retain two builds forever.
  const siblingDir = path.join(cacheRoot, "chromium-146.0.7680.177");
  for (const dir of [resolvedDir, siblingDir]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chrome.exe"), "x");
  }

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot, preferExistingCache: true }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(resolvedDir, "chrome.exe"),
      cacheDir: resolvedDir,
      installed: true,
    }),
  });

  try {
    await service.install();

    assert.equal(await exists(path.join(resolvedDir, "chrome.exe")), true);
    assert.equal(await exists(siblingDir), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService clears a marker naming a build that is not in the cache at all", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const keepDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  await fs.mkdir(keepDir, { recursive: true });
  await fs.writeFile(path.join(keepDir, "chrome.exe"), "x");
  // Names a Pro build that does not exist. Tier-scoped cleanup only touches markers naming a build
  // this run pruned, so without a dangling sweep this survives — and Pro resolution then returns null
  // and an offline launch fails outright.
  await fs.writeFile(path.join(cacheRoot, "latest_pro_version_windows-x64"), "145.0.7632.109.2");
  await fs.writeFile(path.join(cacheRoot, "latest_version_windows-x64"), "146.0.7680.177.5");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot, preferExistingCache: true }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(keepDir, "chrome.exe"),
      cacheDir: keepDir,
      installed: true,
    }),
  });

  try {
    await service.install();

    assert.equal(await exists(path.join(cacheRoot, "latest_pro_version_windows-x64")), false);
    // The marker naming the surviving build is left alone.
    assert.equal(
      await fs.readFile(path.join(cacheRoot, "latest_version_windows-x64"), "utf8"),
      "146.0.7680.177.5",
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService imports into the managed cache even when a custom binary path is active", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const overrideDir = path.join(directory, "external", "nested");
  await fs.mkdir(overrideDir, { recursive: true });
  await fs.writeFile(path.join(overrideDir, "chrome.exe"), "x");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      customBinaryPathEnabled: true,
      customBinaryPath: path.join(overrideDir, "chrome.exe"),
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const analysis = await service.analyzeImportZip(zipPath);
    // The destination must be the managed cache, not a directory derived from the override.
    assert.equal(analysis.targetCacheDir, wrapperCacheDir);

    const result = await service.installImportZip(zipPath);

    assert.equal(await exists(path.join(wrapperCacheDir, "chrome.exe")), true);
    assert.equal(await exists(path.join(directory, "external", "chromium-146.0.7680.177.5")), false);
    // The success is qualified: the override still wins at launch.
    assert.match(result.info.core.operation?.logs.map((entry) => entry.message).join("\n") ?? "", /custom binary path is active/);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService finds cached macOS builds inside the app bundle", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const activeDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  const bundled = path.join(activeDir, "Chromium.app", "Contents", "MacOS");
  await fs.mkdir(bundled, { recursive: true });
  await fs.writeFile(path.join(bundled, "Chromium"), "x");
  const supersededDir = path.join(cacheRoot, "chromium-144.0.0.0");
  const supersededBundle = path.join(supersededDir, "Chromium.app", "Contents", "MacOS");
  await fs.mkdir(supersededBundle, { recursive: true });
  await fs.writeFile(path.join(supersededBundle, "Chromium"), "x");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      platform: "darwin-arm64",
      version: "145.0.7632.109.2",
      binaryPath: path.join(bundled, "Chromium"),
      cacheDir: activeDir,
      installed: true,
    }),
  });

  try {
    // The macOS executable is nested in the app bundle, so a bare basename probe finds nothing and the
    // prune would report an empty cache and delete the build in use. Keyed on the platform the wrapper
    // reports, so this holds from any host.
    await service.install();

    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")),
      ["chromium-145.0.7632.109.2"],
    );
    assert.equal(await exists(path.join(bundled, "Chromium")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService imports a macOS package whose executable lives in the app bundle", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  const archivePath = path.join(directory, "cloakbrowser-darwin-arm64.tar.gz");
  await fs.writeFile(archivePath, makeTarGz({
    "chromium-145.0.7632.109.2/Chromium.app/Contents/MacOS/Chromium": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      platform: "darwin-arm64",
      version: "145.0.7632.109.2",
      binaryPath: path.join(wrapperCacheDir, "Chromium.app", "Contents", "MacOS", "Chromium"),
      cacheDir: wrapperCacheDir,
      installed: false,
    }),
  });

  try {
    // Searching for a Linux "chrome" here is what made every macOS import fail outright.
    const result = await service.installImportZip(archivePath);

    assert.equal(result.info.core.operation?.status, "succeeded");
    assert.equal(
      await exists(path.join(wrapperCacheDir, "Chromium.app", "Contents", "MacOS", "Chromium")),
      true,
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService refuses a second mutating operation while one is in flight", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  let releaseInstall: () => void = () => undefined;
  const installReached = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  let installEntered: () => void = () => undefined;
  const installStarted = new Promise<void>((resolve) => {
    installEntered = resolve;
  });

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
        cacheDir: wrapperCacheDir,
        installed: false,
      }),
      // Park inside the operation so a second call arrives while the guard is held.
      ensureBinary: async () => {
        installEntered();
        await installReached;
        await fs.mkdir(wrapperCacheDir, { recursive: true });
        await fs.writeFile(path.join(wrapperCacheDir, "chrome.exe"), "x");
        return path.join(wrapperCacheDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  try {
    const install = service.install();
    await installStarted;

    const conflict = await service.clearCache().then(() => undefined, (error: Error & { status?: number; code?: string }) => error);
    assert.equal(conflict?.status, 409);
    assert.equal(conflict?.code, "BROWSER_CORE_OPERATION_IN_PROGRESS");
    assert.match(conflict?.message ?? "", /install/);

    // check-update mutates no cache content, so it stays available.
    const check = await service.checkUpdate();
    assert.ok(check.update.checkedAt);

    releaseInstall();
    const result = await install;
    assert.equal(result.info.installed, true);

    // The guard is released, so the next operation goes through.
    const cleared = await service.clearCache();
    assert.equal(cleared.info.core.operation?.type, "clear-cache");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService refuses an import that would replace a build while a session is running", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  // The archive's version normalizes onto the installed one, so the target directory is already on
  // disk and the install would fs.rm it before renaming staging into place — the case that guts a
  // running browser.
  const inUseDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  await fs.mkdir(inUseDir, { recursive: true });
  await fs.writeFile(path.join(inUseDir, "chrome.exe"), "x");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    hasActiveSessions: () => true,
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(inUseDir, "chrome.exe"),
      cacheDir: inUseDir,
      installed: true,
    }),
  });

  try {
    // Refused during analysis, so the dialog disables Import and shows why before anything is deleted.
    const analysis = await service.analyzeImportZip(zipPath);
    assert.equal(analysis.allowed, false);
    assert.equal(analysis.reasonCode, "sessions-running");
    assert.match(analysis.reason ?? "", /browser session is running/);

    const refusal = await service.installImportZip(zipPath).then(() => undefined, (error: Error & { status?: number; code?: string }) => error);
    assert.equal(refusal?.status, 400);
    // Coded, so the toast is translated rather than echoing the English sentence.
    assert.equal(refusal?.code, "BROWSER_CORE_IMPORT_SESSIONS_RUNNING");
    assert.equal(await exists(path.join(inUseDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService imports a version that is not on disk even while a session is running", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // A different version, so the install's fs.rm has nothing to remove and no running build is at risk.
  const inUseDir = path.join(cacheRoot, "chromium-145.0.7632.109.2");
  await fs.mkdir(inUseDir, { recursive: true });
  await fs.writeFile(path.join(inUseDir, "chrome.exe"), "x");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    hasActiveSessions: () => true,
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: true,
    }),
  });

  try {
    const result = await service.installImportZip(zipPath);

    assert.equal(result.analysis.allowed, true);
    assert.equal(await exists(path.join(wrapperCacheDir, "chrome.exe")), true);
    // The build the import supersedes survives too, because the prune defers while a session is active.
    assert.equal(await exists(path.join(inUseDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService refuses to clear the cache while a browser session is running", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const inUseDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  await fs.mkdir(inUseDir, { recursive: true });
  await fs.writeFile(path.join(inUseDir, "chrome.exe"), "x");
  let cacheCleared = false;

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    hasActiveSessions: () => true,
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(inUseDir, "chrome.exe"),
        cacheDir: inUseDir,
        installed: true,
      }),
      clearCache: () => {
        cacheCleared = true;
      },
    } as CloakBrowserModule),
  });

  try {
    const refusal = await service.clearCache().then(() => undefined, (error: Error & { status?: number; code?: string }) => error);

    // Loud, not silent: a clear is what the user asked for, so refuse it with a code the panel can
    // translate rather than reporting success over a browser whose files were half deleted.
    assert.equal(refusal?.status, 409);
    assert.equal(refusal?.code, "BROWSER_CORE_SESSIONS_RUNNING");
    assert.equal(cacheCleared, false);
    assert.equal(await exists(path.join(inUseDir, "chrome.exe")), true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService releases the operation guard after a failure", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      preferExistingCache: false,
    }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({}),
      ensureBinary: async () => {
        throw new Error("download refused by mirror");
      },
    } as CloakBrowserModule),
  });

  try {
    // The failure happens inside the guarded section, so the guard has to be released in a finally.
    await assert.rejects(() => service.install(), /download refused by mirror/);

    const cleared = await service.clearCache();
    assert.equal(cleared.info.core.operation?.status, "succeeded");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService does not repair the managed cache while a browser session is running", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const expectedDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // The build a session is executing. The repair would rename it onto expectedDir, moving the running
  // browser's files out from under it — or throwing on the locked executable, which nothing on the read
  // path catches, turning the polled read and the launch preflight into a 500 while the session is live.
  const compatibleDir = path.join(cacheRoot, "chromium-146.0.7680.177");
  await fs.mkdir(compatibleDir, { recursive: true });
  await fs.writeFile(path.join(compatibleDir, "chrome.exe"), "x");

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    hasActiveSessions: () => true,
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(expectedDir, "chrome.exe"),
      cacheDir: expectedDir,
      installed: false,
    }),
  });

  try {
    const duringSession = await service.readInfo();

    assert.equal(duringSession.installed, false);
    assert.equal(await exists(path.join(compatibleDir, "chrome.exe")), true);
    assert.equal(await exists(expectedDir), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService aborts an import when a session appears while it is extracting", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const targetDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(targetDir, "chrome.exe"), "x");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));
  // The pre-flight analysis asks first and sees nothing running, so the import is allowed to start;
  // every later answer stands for a session that launched while the archive was being extracted.
  // installed:true keeps the cache probe from consulting it, so the count is exactly these two asks.
  let probeCalls = 0;

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    hasActiveSessions: () => {
      probeCalls += 1;
      return probeCalls > 1;
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(targetDir, "chrome.exe"),
      cacheDir: targetDir,
      installed: true,
    }),
  });

  try {
    const aborted = await service.installImportZip(zipPath).then(() => undefined, (error: Error & { status?: number; code?: string }) => error);

    // Refused at the last instant before the directory would stop existing, so the running build is
    // whole: the analysis-time verdict is not trusted across the extraction.
    assert.equal(aborted?.status, 409);
    assert.equal(aborted?.code, "BROWSER_CORE_SESSIONS_RUNNING");
    assert.equal(await fs.readFile(path.join(targetDir, "chrome.exe"), "utf8"), "x");
    // The abort still cleans up after itself.
    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("import-staging-")),
      [],
    );
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService does not repair the managed cache while an operation is in flight", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const expectedDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  // A same-build directory the repair would otherwise rename onto expectedDir.
  const compatibleDir = path.join(cacheRoot, "chromium-146.0.7680.177");
  await fs.mkdir(compatibleDir, { recursive: true });
  await fs.writeFile(path.join(compatibleDir, "chrome.exe"), "x");
  let releaseInstall: () => void = () => undefined;
  const installReached = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  let installEntered: () => void = () => undefined;
  const installStarted = new Promise<void>((resolve) => {
    installEntered = resolve;
  });

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({
        binaryPath: path.join(expectedDir, "chrome.exe"),
        cacheDir: expectedDir,
        installed: false,
      }),
      // Parks inside the guarded section and installs nothing, so the only thing that could create
      // expectedDir during the window is the repair this test forbids.
      ensureBinary: async () => {
        installEntered();
        await installReached;
        return path.join(expectedDir, "chrome.exe");
      },
    } as CloakBrowserModule),
  });

  try {
    const installing = service.install();
    await installStarted;

    const duringOperation = await service.readInfo();
    assert.equal(duringOperation.installed, false);
    assert.equal(await exists(path.join(compatibleDir, "chrome.exe")), true);
    assert.equal(await exists(expectedDir), false);

    releaseInstall();
    const result = await installing;

    // The operation's own response is refreshed after the guard is released, so the suppression
    // cannot leak a not-installed state to the client that gates its launch button on it.
    assert.equal(result.info.installed, true);
    assert.equal(result.info.core.status, "installed");

    // Once the guard is free the repair runs as before.
    const afterOperation = await service.readInfo();
    assert.equal(afterOperation.installed, true);
    assert.equal(await exists(path.join(expectedDir, "chrome.exe")), true);
    assert.equal(await exists(compatibleDir), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService prunes every superseded build and reports the survivor as installed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const keptDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  for (const dir of [
    keptDir,
    path.join(cacheRoot, "chromium-145.0.7632.109.2"),
    path.join(cacheRoot, "chromium-146.0.7680.177.5-pro"),
  ]) {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "chrome.exe"), "x");
  }

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(keptDir, "chrome.exe"),
      cacheDir: keptDir,
      installed: true,
    }),
  });

  try {
    const result = await service.install();

    // Case folding matters on win32: path.resolve is case-sensitive while the filesystem is not, so
    // without it the build in use would not match itself and the prune would delete it.
    assert.deepEqual(
      (await fs.readdir(cacheRoot)).filter((name) => name.startsWith("chromium-")),
      ["chromium-146.0.7680.177.5"],
    );
    assert.equal(await exists(path.join(keptDir, "chrome.exe")), true);
    assert.equal(result.info.installed, true);
    assert.equal(result.info.core.operation?.status, "succeeded");
  } finally {
    restoreEnv(originalEnv);
  }
});


test("BinaryService imports local Linux tar.gz into the wrapper-compatible cache and reports installed", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5");
  const archivePath = path.join(directory, "cloakbrowser-linux-x64.tar.gz");
  await fs.writeFile(archivePath, makeTarGz({
    "chromium-146.0.7680.177/chrome": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({ cacheDirMode: "custom", customCacheDir: cacheRoot }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      platform: "linux-x64",
      binaryPath: path.join(wrapperCacheDir, "chrome"),
      cacheDir: wrapperCacheDir,
      installed: false,
      downloadUrl: "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz",
    }),
  });

  try {
    const analysis = await service.analyzeImportZip(archivePath);
    assert.equal(analysis.platform, "linux-x64");
    assert.equal(analysis.importedVersion, "146.0.7680.177.5");
    assert.equal(analysis.targetCacheDir, wrapperCacheDir);
    assert.equal(analysis.allowed, true);

    const result = await service.installImportZip(archivePath);
    assert.equal(result.info.installed, true);
    assert.equal(result.info.binaryPath, path.join(wrapperCacheDir, "chrome"));
    assert.ok(await exists(path.join(wrapperCacheDir, "chrome")));
    assert.equal(result.info.downloadUrl, "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService imports local ZIP into a Pro cache without changing the Free marker", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const cacheRoot = path.join(directory, "cache");
  const wrapperCacheDir = path.join(cacheRoot, "chromium-146.0.7680.177.5-pro");
  const zipPath = path.join(directory, "cloakbrowser-windows-x64.zip");
  await fs.writeFile(zipPath, zipSync({
    "chromium-146.0.7680.177/chrome.exe": new Uint8Array([1, 2, 3]),
  }));

  const service = new BinaryService({
    dataDir: directory,
    portable: true,
    readSettings: async () => settings({
      cacheDirMode: "custom",
      customCacheDir: cacheRoot,
      tierMode: "pro",
      licenseKey: "license-secret",
    }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      binaryPath: path.join(wrapperCacheDir, "chrome.exe"),
      cacheDir: wrapperCacheDir,
      installed: false,
      tier: "pro",
    }),
  });

  try {
    const analysis = await service.analyzeImportZip(zipPath, { targetTier: "pro" });
    assert.equal(analysis.targetTier, "pro");
    assert.equal(analysis.targetCacheDir, wrapperCacheDir);

    await service.installImportZip(zipPath, { targetTier: "pro" });

    assert.ok(await exists(path.join(wrapperCacheDir, "chrome.exe")));
    assert.equal(await fs.readFile(path.join(cacheRoot, "latest_pro_version_windows-x64"), "utf8"), "146.0.7680.177.5");
    assert.equal(await exists(path.join(cacheRoot, "latest_version_windows-x64")), false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService captures CloakBrowser download progress logs during install", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ preferExistingCache: false }),
    loadCloakBrowser: async () => ({
      ...fakeCloakBrowserModule({ binaryPath: "C:/cache/chrome.exe" }),
      ensureBinary: async () => {
        console.log("[cloakbrowser] Downloading from https://example.test/chromium-v1/file.zip?token=secret");
        console.log("[cloakbrowser] Download progress: 30% (30/100 MB)");
        console.log("[cloakbrowser] Download progress: 100% (100/100 MB)");
        console.log("[cloakbrowser] Binary ready: C:/cache/chrome.exe");
        return "C:/cache/chrome.exe";
      },
    } as CloakBrowserModule),
  });

  const originalLog = console.log;
  const forwardedLogs: unknown[][] = [];
  try {
    console.log = (...args: unknown[]) => {
      forwardedLogs.push(args);
    };
    const result = await service.install();

    const operation = result.info.core.operation;
    assert.equal(operation?.status, "succeeded");
    assert.equal(operation?.progress?.current, 100);
    assert.equal(operation?.progress?.total, 100);
    assert.ok(operation?.logs.some((log) => log.message.includes("Download progress: 30%")));
    assert.ok(operation?.logs.every((log) => !log.message.includes("token=secret")));
    assert.ok(forwardedLogs.every((args) => args.every((arg) => !String(arg).includes("token=secret"))));
    assert.ok(forwardedLogs.every((args) => !Array.isArray(args[0])));
  } finally {
    console.log = originalLog;
    restoreEnv(originalEnv);
  }
});

test("BinaryService falls back to gh-proxy for GitHub release metadata checks", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const seenUrls: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    fetchImpl: async (input) => {
      const url = String(input);
      seenUrls.push(url);
      if (url.startsWith("https://api.github.com/")) {
        return new Response("rate limited", { status: 403 });
      }
      return Response.json([
        {
          tag_name: "chromium-v147.0.7700.1",
          draft: false,
          assets: [{ name: "cloakbrowser-windows-x64.zip" }],
        },
      ]);
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true }),
  });

  try {
    const result = await service.checkUpdate();

    assert.deepEqual(seenUrls, [
      "https://api.github.com/repos/CloakHQ/cloakbrowser/releases?per_page=10",
      "https://gh-proxy.com/https://api.github.com/repos/CloakHQ/cloakbrowser/releases?per_page=10",
    ]);
    assert.equal(result.update.latestVersion, "147.0.7700.1");
    assert.equal(result.update.updateAvailable, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService persists browser core update checks into settings", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  let currentSettings = settings({});
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => currentSettings,
    saveSettings: async (patch) => {
      currentSettings = normalizeSettings({
        ...currentSettings,
        binary: {
          ...currentSettings.binary,
          ...(patch.binary ?? {}),
        },
      });
      return currentSettings;
    },
    fetchImpl: async () => Response.json([
      {
        tag_name: "chromium-v147.0.7700.1",
        draft: false,
        assets: [{ name: "cloakbrowser-windows-x64.zip" }],
      },
    ]),
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true }),
  });

  try {
    const result = await service.checkUpdate();

    assert.equal(result.update.latestVersion, "147.0.7700.1");
    assert.equal(currentSettings.binary.lastUpdateCheck?.latestVersion, "147.0.7700.1");
    assert.equal(currentSettings.binary.lastUpdateCheck?.updateAvailable, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService checks Linux tar.gz release assets", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({}),
    fetchImpl: async () => Response.json([
      {
        tag_name: "chromium-v147.0.7700.1",
        draft: false,
        assets: [{ name: "cloakbrowser-linux-x64.tar.gz" }],
      },
    ]),
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      platform: "linux-x64",
      binaryPath: "/cache/chromium-146.0.7680.177.5/chrome",
      cacheDir: "/cache/chromium-146.0.7680.177.5",
      installed: true,
      downloadUrl: "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz",
    }),
  });

  try {
    const result = await service.checkUpdate();

    assert.equal(result.update.latestVersion, "147.0.7700.1");
    assert.equal(result.update.updateAvailable, true);
    // The Linux archive name decides whether a release counts as available for this platform.
    assert.equal(result.update.currentVersion, "146.0.7680.177.5");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService checks Free GitHub key releases through the authenticated API", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const seen: Array<{ url: string; platform?: string }> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "free", licenseKey: "free-license" }),
    fetchImpl: async (input, init) => {
      seen.push({
        url: String(input),
        platform: init?.headers instanceof Headers
          ? init.headers.get("X-Platform") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.["X-Platform"],
      });
      return Response.json({ version: "150.0.0.0" });
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      installed: true,
      tier: "pro",
      platform: "linux-x64",
      version: "146.0.7680.177.5",
      binaryPath: "/cache/chromium-146.0.7680.177.5-pro/chrome",
      cacheDir: "/cache/chromium-146.0.7680.177.5-pro",
    }),
  });

  try {
    const result = await service.checkUpdate();

    assert.deepEqual(seen, [{ url: "https://cloakbrowser.dev/api/download/version", platform: "linux-x64" }]);
    assert.equal(result.update.targetTier, "free");
    assert.equal(result.update.latestVersion, "150.0.0.0");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService checks GitHub releases for a key the license server rejected", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const seen: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    // tierMode is the persisted Pro tier from when this key still worked, so nothing but the verdict
    // itself can tell the routing that the key is dead.
    readSettings: async () => settings({ tierMode: "pro", licenseKey: "revoked-license" }),
    fetchImpl: async (input) => {
      seen.push(String(input));
      return Response.json([]);
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      installed: true,
      license: { valid: false, plan: "unknown", expires: null },
    }),
  });

  try {
    const result = await service.checkUpdate();

    // Not the authenticated channel endpoint: it needs no auth and would happily name a version this
    // installation cannot download, and the update that followed would fail on the rejected key.
    assert.equal(seen.some((url) => url.includes("cloakbrowser.dev/api/download/version")), false);
    assert.equal(seen.some((url) => url.includes("api.github.com")), true);
    assert.equal(result.info.core.license.valid, false);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService keeps the authenticated check for a key the license server accepted", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const seen: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ tierMode: "pro", licenseKey: "good-license" }),
    fetchImpl: async (input) => {
      seen.push(String(input));
      return Response.json({ version: "150.0.0.0" });
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      installed: true,
      license: { valid: true, plan: "team", expires: null },
    }),
  });

  try {
    const result = await service.checkUpdate();

    assert.deepEqual(seen, ["https://cloakbrowser.dev/api/download/version"]);
    assert.equal(result.update.latestVersion, "150.0.0.0");
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService probes for a GitHub mirror once a rejected key drops it to the free path", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const requested: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => ({
      ...settings({ tierMode: "pro", licenseKey: "revoked-license" }),
      networkTrace: {
        ...DEFAULT_APP_SETTINGS.networkTrace,
        // auto-best is the case that needs the probe: every other mode has a static prefix that
        // applyGithubMirrorFetch resolves from settings on its own, so only this one can tell whether the
        // probe was skipped.
        githubMirrorProviderId: "auto-best",
      },
    }),
    fetchImpl: async (input) => {
      requested.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      return Response.json([]);
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      installed: true,
      license: { valid: false, plan: "unknown", expires: null },
    }),
  });

  try {
    await service.checkUpdate();

    // The free path downloads from GitHub releases, so this is exactly when a mirror matters. Skipping the
    // probe whenever a key existed left the fallback download going direct.
    assert.equal(requested.some((url) => url.includes("SHA256SUMS")), true);
  } finally {
    restoreGithubMirrorFetch();
    restoreEnv(originalEnv);
  }
});

test("BinaryService checks GitHub releases when a license key is switched off", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const seen: string[] = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    // The key stays on file; only the toggle decides whether it reaches the wrapper, so the update
    // check has to fall back to the unauthenticated GitHub path.
    readSettings: async () => settings({ licenseKey: "free-license", licenseKeyEnabled: false }),
    fetchImpl: async (input) => {
      seen.push(String(input));
      return Response.json([]);
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true }),
  });

  try {
    const result = await service.checkUpdate();

    assert.deepEqual(seen, ["https://api.github.com/repos/CloakHQ/cloakbrowser/releases?per_page=10"]);
    assert.equal(result.update.targetTier, "free");
    assert.equal(result.info.core.license.configured, true);
    assert.equal(result.info.core.license.active, false);
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, undefined);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService checks Pro releases through the CloakBrowser Pro API", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const seen: Array<{ url: string; platform?: string }> = [];
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({
      tierMode: "pro",
      licenseKey: "license-secret",
      browserVersionMode: "latest",
    }),
    fetchImpl: async (input, init) => {
      seen.push({
        url: String(input),
        platform: init?.headers instanceof Headers
          ? init.headers.get("X-Platform") ?? undefined
          : (init?.headers as Record<string, string> | undefined)?.["X-Platform"],
      });
      return Response.json({ version: "147.0.7700.1" });
    },
    loadCloakBrowser: async () => fakeCloakBrowserModule({
      installed: true,
      tier: "pro",
      platform: "linux-x64",
      version: "146.0.7680.177.5",
      binaryPath: "/cache/chromium-146.0.7680.177.5-pro/chrome",
      cacheDir: "/cache/chromium-146.0.7680.177.5-pro",
    }),
  });

  try {
    const result = await service.checkUpdate();

    assert.deepEqual(seen, [{ url: "https://cloakbrowser.dev/api/download/version", platform: "linux-x64" }]);
    assert.equal(result.update.targetTier, "pro");
    assert.equal(result.update.latestVersion, "147.0.7700.1");
    assert.equal(result.update.updateAvailable, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService restores the last browser core update check from settings", async () => {
  const originalEnv = captureEnv();
  const directory = await makeTempDir();
  const lastUpdateCheck = {
    checkedAt: "2026-06-06T00:00:00.000Z",
    currentVersion: "146.0.7680.177.5",
    latestVersion: "147.0.7700.1",
    updateAvailable: true,
  };
  const service = new BinaryService({
    dataDir: directory,
    portable: false,
    readSettings: async () => settings({ lastUpdateCheck }),
    loadCloakBrowser: async () => fakeCloakBrowserModule({ installed: true }),
  });

  try {
    const info = await service.readPublicInfo();

    assert.equal(info.core.update?.checkedAt, lastUpdateCheck.checkedAt);
    assert.equal(info.core.update?.latestVersion, lastUpdateCheck.latestVersion);
    assert.equal(info.core.update?.updateAvailable, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("resolvePackageVersion prefers compile-time sidecar versions when node_modules metadata is unavailable", async () => {
  const missingCwd = path.join(await makeTempDir(), "portable");

  assert.equal(resolvePackageVersion("0.3.31", "node_modules/cloakbrowser/package.json", missingCwd), "0.3.31");
  assert.equal(resolvePackageVersion("", "node_modules/cloakbrowser/package.json", missingCwd), undefined);
});

function settings(binaryPatch: Partial<AppSettings["binary"]>): AppSettings {
  return normalizeSettings({
    ...DEFAULT_APP_SETTINGS,
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      // The shipped default is off — a fresh install has no key to enable. Every fixture that puts a key
      // on file here means it to be in play, and the switch is what hands it to the wrapper, so the key
      // implies the switch. The test about a key that stays on file while switched off passes
      // licenseKeyEnabled explicitly and still wins, because the patch is spread after this.
      licenseKeyEnabled: Boolean(binaryPatch.licenseKey?.trim()),
      ...binaryPatch,
    },
  });
}

function fakeCloakBrowserModule(patch: {
  binaryPath?: string;
  cacheDir?: string;
  downloadUrl?: string;
  installed?: boolean;
  license?: { valid: boolean; plan: string; expires: string | null } | null;
  platform?: string;
  tier?: "free" | "pro";
  version?: string;
} = {}): CloakBrowserModule {
  const info = fakeBinaryInfo(patch);
  return {
    binaryInfo: () => info,
    ensureBinary: async () => info.binaryPath,
    checkForUpdate: async () => null,
    clearCache: () => undefined,
    // Defaults to null — the wrapper's "could not validate" answer — so most tests exercise the
    // offline state the panel has to survive without claiming a plan.
    // Declared with the key parameter so the real module type stays assignable to this shape, which is
    // what makes the `as CloakBrowserModule` assertion below legal.
    validateLicense: async (_licenseKey: string) => patch.license ?? null,
  } as CloakBrowserModule;
}

function fakeBinaryInfo(patch: {
  binaryPath?: string;
  cacheDir?: string;
  downloadUrl?: string;
  installed?: boolean;
  platform?: string;
  tier?: "free" | "pro";
  version?: string;
} = {}) {
  return {
    version: patch.version ?? "146.0.7680.177.5",
    bundledVersion: patch.version ?? "146.0.7680.177.5",
    platform: patch.platform ?? "windows-x64",
    binaryPath: patch.binaryPath ?? "C:/cache/chromium-146.0.7680.177.5/chrome.exe",
    installed: patch.installed ?? false,
    cacheDir: patch.cacheDir ?? "C:/cache/chromium-146.0.7680.177.5",
    downloadUrl: patch.downloadUrl ?? "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
    tier: patch.tier ?? "free",
  };
}

function captureEnv(): Record<string, string | undefined> {
  return Object.fromEntries(CLOAK_ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const key of CLOAK_ENV_KEYS) {
    if (snapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = snapshot[key];
    }
  }
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-binary-"));
}

async function exists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

function makeTarGz(entries: Record<string, Uint8Array>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [entryName, bytes] of Object.entries(entries)) {
    const header = new Uint8Array(512);
    writeTarString(header, 0, 100, entryName);
    writeTarString(header, 100, 8, "0000777");
    writeTarString(header, 108, 8, "0000000");
    writeTarString(header, 116, 8, "0000000");
    writeTarOctal(header, 124, 12, bytes.length);
    writeTarString(header, 136, 12, "00000000000");
    header.fill(32, 148, 156);
    writeTarString(header, 156, 1, "0");
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");
    writeTarOctal(header, 148, 8, checksum(header));
    parts.push(header, bytes, new Uint8Array((512 - (bytes.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  return gzipSync(concatBytes(parts));
}

function writeTarString(target: Uint8Array, offset: number, length: number, value: string): void {
  target.set(Buffer.from(value).subarray(0, length), offset);
}

function writeTarOctal(target: Uint8Array, offset: number, length: number, value: number): void {
  const octal = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeTarString(target, offset, length, `${octal}\0`);
}

function checksum(header: Uint8Array): number {
  return header.reduce((sum, byte) => sum + byte, 0);
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}
