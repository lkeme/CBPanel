import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync, zipSync } from "fflate";
import { DEFAULT_APP_SETTINGS, type AppSettings, normalizeSettings } from "../../src/shared/settings";
import { BinaryService, resolvePackageVersion, type BinaryServiceOptions, type CloakBrowserModule } from "./binaryService";

const CLOAK_ENV_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_DOWNLOAD_URL",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_SKIP_CHECKSUM",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_LICENSE_KEY",
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
    assert.equal(info.core.downloads.current.primaryUrl, "https://mirror.example.test/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip");
    assert.equal(info.core.downloads.current.fallbackUrl, undefined);
    assert.equal(info.core.restartRequired, false);
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
    assert.equal(result.info.core.downloads.current.requiresLicense, true);
  } finally {
    restoreEnv(originalEnv);
  }
});

test("BinaryService preserves external Pro license and version env when settings are empty", async () => {
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
    assert.equal(result.core.targetTier, "pro");
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
    assert.equal(result.geoip?.dbPresent, true);
    assert.equal(result.modules?.["mmdb-lib"], false);
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
    assert.equal(result.info.core.downloads.current.primaryUrl, "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-linux-x64.tar.gz");
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
    assert.equal(analysis.setAsDefault, true);
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
    assert.equal(
      result.update.downloadLinks?.fallbackUrl,
      "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v147.0.7700.1/cloakbrowser-windows-x64.zip",
    );
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
    assert.equal(
      result.update.downloadLinks?.fallbackUrl,
      "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v147.0.7700.1/cloakbrowser-linux-x64.tar.gz",
    );
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
    assert.equal(result.update.downloadLinks?.primaryUrl, "https://cloakbrowser.dev/api/download/147.0.7700.1");
    assert.equal(result.update.downloadLinks?.checksumUrl, "https://cloakbrowser.dev/releases/pro/chromium-v147.0.7700.1/SHA256SUMS");
    assert.equal(result.update.downloadLinks?.signatureUrl, "https://cloakbrowser.dev/releases/pro/chromium-v147.0.7700.1/SHA256SUMS.sig");
    assert.equal(result.update.downloadLinks?.fallbackUrl, undefined);
    assert.equal(result.update.downloadLinks?.requiresLicense, true);
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
    assert.equal(info.core.downloads.latest, undefined);
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
      ...binaryPatch,
    },
  });
}

function fakeCloakBrowserModule(patch: {
  binaryPath?: string;
  cacheDir?: string;
  downloadUrl?: string;
  installed?: boolean;
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
