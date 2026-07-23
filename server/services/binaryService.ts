import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import * as tar from "tar";
import {
  type CloakBrowserDiagnostics,
  type CloakBrowserDiagnosticsLicense,
  type BrowserCoreDownloadLinks,
  type BrowserCoreEnvRuntimeValue,
  type BrowserCoreImportAnalysis,
  type BrowserCoreInfo,
  type BrowserCoreImportKind,
  type BrowserCoreOperation,
  type BrowserCoreOperationLog,
  type BrowserCoreTier,
  type BrowserCoreUpdateCheck,
  type BrowserCoreVersionMode,
  maskEnvValue,
} from "../../src/shared/browserCore";
import {
  type AppSettings,
  type AppSettingsPatch,
  normalizeSettings,
} from "../../src/shared/settings";
import { applyGithubMirrorFetch } from "./githubMirrorFetch";
import { GithubMirrorProbeService } from "./githubMirrorProbeService";

declare const __CBPANEL_VERSION__: string | undefined;
declare const __CBPANEL_CLOAKBROWSER_VERSION__: string | undefined;
declare const __CBPANEL_PLAYWRIGHT_CORE_VERSION__: string | undefined;
declare const __CBPANEL_PUPPETEER_CORE_VERSION__: string | undefined;

export type CloakBrowserEnvInfo = {
  binaryPath?: string;
  cacheDir?: string;
  downloadUrl?: string;
  autoUpdate?: string;
  skipChecksum?: string;
  geoipTimeoutSeconds?: string;
  version?: string;
  licenseKey?: string;
};

export type CloakBrowserModule = typeof import("cloakbrowser");
type CloakBinaryInfo = ReturnType<CloakBrowserModule["binaryInfo"]>;

export type PublicBinaryInfo = CloakBinaryInfo & {
  env: CloakBrowserEnvInfo;
  core: BrowserCoreInfo;
};

type CloakBrowserCliModule = {
  collectDiagnostics: (quick: boolean) => Promise<Record<string, unknown>>;
};

export type BinaryServiceOptions = {
  dataDir: string;
  portable: boolean;
  readSettings: () => Promise<AppSettings>;
  saveSettings?: (patch: AppSettingsPatch) => Promise<AppSettings>;
  fetchImpl?: typeof fetch;
  loadCloakBrowser?: () => Promise<CloakBrowserModule>;
  loadCloakBrowserDiagnostics?: () => Promise<CloakBrowserCliModule>;
};

const GITHUB_API_URL = "https://api.github.com/repos/CloakHQ/cloakbrowser/releases";
const GITHUB_API_FALLBACK_URL = `https://gh-proxy.com/${GITHUB_API_URL}`;
const GITHUB_DOWNLOAD_BASE_URL = "https://github.com/CloakHQ/cloakbrowser/releases/download";
const CLOAKBROWSER_DEFAULT_BASE_URL = "https://cloakbrowser.dev";
const PACKAGE_VERSIONS = {
  cbpanel: resolvePackageVersion(
    typeof __CBPANEL_VERSION__ === "string" ? __CBPANEL_VERSION__ : undefined,
    "package.json",
  ),
  cloakbrowser: resolvePackageVersion(
    typeof __CBPANEL_CLOAKBROWSER_VERSION__ === "string" ? __CBPANEL_CLOAKBROWSER_VERSION__ : undefined,
    "node_modules/cloakbrowser/package.json",
  ),
  playwrightCore: resolvePackageVersion(
    typeof __CBPANEL_PLAYWRIGHT_CORE_VERSION__ === "string" ? __CBPANEL_PLAYWRIGHT_CORE_VERSION__ : undefined,
    "node_modules/playwright-core/package.json",
  ),
  puppeteerCore: resolvePackageVersion(
    typeof __CBPANEL_PUPPETEER_CORE_VERSION__ === "string" ? __CBPANEL_PUPPETEER_CORE_VERSION__ : undefined,
    "node_modules/puppeteer-core/package.json",
  ),
};
const execFileAsync = promisify(execFile);
const BUILTIN_ENV_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_DOWNLOAD_URL",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_SKIP_CHECKSUM",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_LICENSE_KEY",
] as const;
const BUILTIN_ENV_KEY_SET = new Set<string>(BUILTIN_ENV_KEYS);

type BrowserCoreTarget = {
  tier: BrowserCoreTier;
  versionMode: BrowserCoreVersionMode;
  pinnedVersion?: string;
  licenseKey?: string;
  customBinaryPath?: string;
  customDownloadBaseUrl?: string;
};

type BrowserCoreEnvResolution = {
  value?: string;
  source: BrowserCoreEnvRuntimeValue["source"];
};

export class BinaryService {
  private readonly fetchImpl: typeof fetch;
  private readonly githubMirrorProbeService: GithubMirrorProbeService;
  private readonly initialBuiltinEnv = captureEnv(BUILTIN_ENV_KEYS);
  private readonly initialCustomEnv = new Map<string, string | undefined>();
  private readonly appliedCustomEnvKeys = new Set<string>();
  private loadedBuiltinEnv?: Map<string, string | undefined>;
  private loadedCustomEnv?: Map<string, string | undefined>;
  private cloakbrowserModule?: CloakBrowserModule;
  private operation?: BrowserCoreOperation;
  private updateCheck?: BrowserCoreUpdateCheck;

  constructor(private readonly options: BinaryServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.githubMirrorProbeService = new GithubMirrorProbeService({ fetchImpl: this.fetchImpl });
  }

  async readInfo(): Promise<CloakBinaryInfo> {
    const settings = normalizeSettings(await this.options.readSettings());
    const target = browserCoreTarget(settings, this.initialBuiltinEnv);
    const runtime = await this.cloakbrowser();
    const info = await this.withCustomBinaryOverride(await runtime.binaryInfo(target.pinnedVersion));
    return this.withManagedCacheProbe(info);
  }

  async readPublicInfo(): Promise<PublicBinaryInfo> {
    const info = await this.readInfo();
    return {
      ...info,
      env: this.envInfo(),
      core: await this.coreInfo(info),
    };
  }

  async readWrapperDiagnostics(options: { quick?: boolean } = {}): Promise<CloakBrowserDiagnostics> {
    const checkedAt = new Date().toISOString();
    try {
      await this.applyBrowserCoreEnv();
      const diagnostics = this.options.loadCloakBrowserDiagnostics
        ? await (await this.options.loadCloakBrowserDiagnostics()).collectDiagnostics(Boolean(options.quick))
        : await this.collectWrapperDiagnostics(Boolean(options.quick));
      return normalizeCloakBrowserDiagnostics(diagnostics, checkedAt);
    } catch (error) {
      return {
        checkedAt,
        available: false,
        error: diagnosticsErrorMessage(error),
      };
    }
  }

  async install(): Promise<{ binaryPath: string; info: PublicBinaryInfo }> {
    this.startOperation("install", "preparing", "Installing CloakBrowser Chromium.");
    try {
      const settings = normalizeSettings(await this.options.readSettings());
      const target = browserCoreTarget(settings, this.initialBuiltinEnv);
      if (target.tier === "pro" && !usesLicensedDownloads(target)) {
        throw Object.assign(new Error("CloakBrowser Pro requires CLOAKBROWSER_LICENSE_KEY."), { status: 400 });
      }
      this.setOperationProgress("checking-cache", "Checking existing CloakBrowser cache.");
      const runtime = await this.cloakbrowser();
      const before = await this.withCustomBinaryOverride(await runtime.binaryInfo(target.pinnedVersion));
      if (settings.binary.preferExistingCache && before.installed) {
        this.setOperationProgress("reusing-cache", "Existing CloakBrowser cache is ready.", 100, 100);
        this.finishOperation("succeeded", "Reused existing CloakBrowser Chromium cache.", before.binaryPath);
        return { binaryPath: before.binaryPath, info: await this.readPublicInfo() };
      }

      this.setOperationProgress("installing", "Calling cloakbrowser.ensureBinary().");
      const binaryPath = await this.captureCloakbrowserOperationLogs(() => runtime.ensureBinary(target.licenseKey, target.pinnedVersion));
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      this.finishOperation("succeeded", "Installed CloakBrowser Chromium.", binaryPath);
      return { binaryPath, info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium install failed.", (error as Error).message);
      throw error;
    }
  }

  async update(): Promise<{ version: string | null; info: PublicBinaryInfo }> {
    this.startOperation("update", "preparing", "Updating CloakBrowser Chromium.");
    try {
      const settings = normalizeSettings(await this.options.readSettings());
      const target = browserCoreTarget(settings, this.initialBuiltinEnv);
      if (target.versionMode === "pinned") {
        this.finishOperation("failed", "CloakBrowser Chromium update skipped.", "Pinned browser version is enabled.");
        throw Object.assign(new Error("Pinned browser version is enabled. Change the pinned version or switch back to latest before updating."), { status: 400 });
      }

      const runtime = await this.cloakbrowser();
      let version: string | null = null;
      if (target.tier === "pro" && !usesLicensedDownloads(target)) {
        throw Object.assign(new Error("CloakBrowser Pro requires CLOAKBROWSER_LICENSE_KEY."), { status: 400 });
      }
      if (usesLicensedDownloads(target)) {
        this.setOperationProgress("checking-update", "Checking authenticated CloakBrowser release metadata.");
        const current = await this.withCustomBinaryOverride(await runtime.binaryInfo(target.pinnedVersion));
        const latest = await this.latestProChromiumVersion(current.platform);
        if (latest && compareVersions(latest, current.version) > 0) {
          this.setOperationProgress("installing", `Calling cloakbrowser.ensureBinary() for ${latest}.`);
          await this.captureCloakbrowserOperationLogs(() => this.runExplicitCloakbrowserUpdate(
            () => runtime.ensureBinary(target.licenseKey, target.tier === "pro" ? latest : undefined),
          ));
          const refreshedVersion = (await this.withCustomBinaryOverride(await runtime.binaryInfo())).version;
          version = compareVersions(refreshedVersion, current.version) > 0 ? refreshedVersion : null;
        }
      } else {
        this.setOperationProgress("checking-update", "Checking CloakBrowser release metadata.");
        version = await this.captureCloakbrowserOperationLogs(() => runtime.checkForUpdate());
      }
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      this.finishOperation("succeeded", version ? `Updated to ${version}.` : "No newer Chromium binary is available.");
      await this.markUpdateCheckCurrent(target);
      return { version, info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium update failed.", (error as Error).message);
      throw error;
    }
  }

  async clearCache(): Promise<{ info: PublicBinaryInfo }> {
    this.startOperation("clear-cache", "clearing", "Clearing CloakBrowser Chromium cache.");
    try {
      this.setOperationProgress("clearing", "Removing managed CloakBrowser cache.");
      const runtime = await this.cloakbrowser();
      runtime.clearCache();
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      this.finishOperation("succeeded", "CloakBrowser Chromium cache cleared.");
      return { info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium cache clear failed.", (error as Error).message);
      throw error;
    }
  }

  async checkUpdate(): Promise<{ update: BrowserCoreUpdateCheck; info: PublicBinaryInfo }> {
    const settings = normalizeSettings(await this.options.readSettings());
    const target = browserCoreTarget(settings, this.initialBuiltinEnv);
    const current = await this.readInfo();
    const checkedAt = new Date().toISOString();
    try {
      const authenticatedDownload = usesLicensedDownloads(target);
      if (target.tier === "pro" && !authenticatedDownload) {
        throw Object.assign(new Error("CloakBrowser Pro requires CLOAKBROWSER_LICENSE_KEY."), { status: 400 });
      }
      const latestVersion = authenticatedDownload
        ? await this.latestProChromiumVersion(current.platform)
        : await this.latestChromiumVersion(current.platform);
      const updateAvailable = Boolean(latestVersion && compareVersions(latestVersion, current.version) > 0);
      this.updateCheck = {
        checkedAt,
        targetTier: target.tier,
        versionMode: target.versionMode,
        currentVersion: current.version,
        latestVersion,
        updateAvailable,
        downloadLinks: latestVersion ? this.downloadLinks(current, latestVersion, target.tier, authenticatedDownload) : undefined,
        blockedReason: target.versionMode === "pinned" && updateAvailable
          ? "Pinned browser version is enabled; automatic update will not replace it."
          : undefined,
      };
    } catch (error) {
      this.updateCheck = {
        checkedAt,
        targetTier: target.tier,
        versionMode: target.versionMode,
        currentVersion: current.version,
        updateAvailable: false,
        error: (error as Error).message,
      };
    }
    await this.persistUpdateCheck();
    return { update: this.updateCheck, info: await this.readPublicInfo() };
  }

  async analyzeImportZip(
    filePath: string,
    options: { targetTier?: BrowserCoreTier; setAsDefault?: boolean } = {},
  ): Promise<BrowserCoreImportAnalysis> {
    const resolvedPath = path.resolve(filePath);
    const settings = normalizeSettings(await this.options.readSettings());
    const target = browserCoreTarget(settings, this.initialBuiltinEnv);
    const [stat, archiveBytes, current] = await Promise.all([
      fs.stat(resolvedPath),
      fs.readFile(resolvedPath),
      this.readInfo(),
    ]);
    const fileName = path.basename(resolvedPath);
    const archiveKind = archiveKindFromPath(fileName);
    if (!archiveKind) {
      throw Object.assign(new Error("CloakBrowser import package must be a .zip, .tar.gz, or .tgz archive."), { status: 400 });
    }
    const sha256 = createHash("sha256").update(archiveBytes).digest("hex");
    const platform = archivePlatformFromName(fileName) ?? current.platform;
    const importedVersion = normalizeImportedVersion(await readChromeVersionFromArchive(resolvedPath, archiveBytes, archiveKind), current.version);
    const operation = importOperation(current.version, importedVersion, platform === current.platform);
    const allowed = operation !== "blocked";
    const targetTier = options.targetTier ?? target.tier;
    const setAsDefault = options.setAsDefault ?? target.versionMode !== "pinned";
    const targetCacheDir = importedVersion
      ? path.join(path.dirname(current.cacheDir), `chromium-${importedVersion}${targetTier === "pro" ? "-pro" : ""}`)
      : undefined;

    return {
      filePath: resolvedPath,
      fileName,
      fileSize: stat.size,
      sha256,
      platform,
      targetTier,
      setAsDefault,
      currentVersion: current.version,
      importedVersion,
      operation,
      allowed,
      reason: allowed ? undefined : "Import package platform or version could not be verified.",
      targetCacheDir,
    };
  }

  async installImportZip(
    filePath: string,
    options: { targetTier?: BrowserCoreTier; setAsDefault?: boolean } = {},
  ): Promise<{ analysis: BrowserCoreImportAnalysis; info: PublicBinaryInfo }> {
    const analysis = await this.analyzeImportZip(filePath, options);
    if (!analysis.allowed || !analysis.importedVersion || !analysis.targetCacheDir) {
      throw Object.assign(new Error(analysis.reason ?? "CloakBrowser import package cannot be installed safely."), { status: 400 });
    }
    this.startOperation("import-zip", "preparing", `Importing CloakBrowser Chromium ${analysis.importedVersion}.`);
    const stagingDir = path.join(this.options.dataDir, "tmp", `cloakbrowser-import-${Date.now()}`);
    try {
      this.setOperationProgress("extracting", "Extracting import archive into a staging directory.");
      await fs.rm(stagingDir, { recursive: true, force: true });
      await fs.mkdir(stagingDir, { recursive: true });
      await writeArchiveEntries(await fs.readFile(analysis.filePath), stagingDir, archiveKindFromPath(analysis.fileName), analysis.filePath);
      await flattenSingleSubdir(stagingDir);
      this.setOperationProgress("validating", "Validating imported Chromium executable.");
      const chromePath = await findFile(stagingDir, analysis.platform.startsWith("windows") ? "chrome.exe" : "chrome", 4);
      if (!chromePath) {
        throw Object.assign(new Error("Imported package does not contain a Chromium executable."), { status: 400 });
      }
      await fs.chmod(chromePath, 0o755).catch(() => undefined);
      this.setOperationProgress("installing", "Moving imported Chromium into the managed cache.");
      await fs.rm(analysis.targetCacheDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(analysis.targetCacheDir), { recursive: true });
      await fs.rename(stagingDir, analysis.targetCacheDir);
      if (analysis.setAsDefault) {
        if (analysis.targetTier === "pro") {
          await this.writeProVersionMarker(analysis.importedVersion);
        } else {
          await this.writeVersionMarker(analysis.importedVersion);
        }
      }
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      this.finishOperation("succeeded", `Imported CloakBrowser Chromium ${analysis.importedVersion}.`, analysis.targetCacheDir);
      return { analysis, info: await this.readPublicInfo() };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      this.finishOperation("failed", "CloakBrowser Chromium import failed.", (error as Error).message);
      throw error;
    }
  }

  private async coreInfo(info: CloakBinaryInfo): Promise<BrowserCoreInfo> {
    const settings = normalizeSettings(await this.options.readSettings());
    const target = browserCoreTarget(settings, this.initialBuiltinEnv);
    this.updateCheck ??= settings.binary.lastUpdateCheck;
    const env = this.runtimeEnv(settings);
    const status = info.installed ? "installed" : "not-installed";
    const current = this.downloadLinks(info, info.version, target.tier, usesLicensedDownloads(target));
    return {
      status,
      installed: info.installed,
      tier: info.tier,
      targetTier: target.tier,
      versionMode: target.versionMode,
      pinnedVersion: target.pinnedVersion,
      platform: info.platform,
      binaryPath: info.binaryPath,
      cacheDir: info.cacheDir,
      downloadUrl: info.downloadUrl,
      versions: {
        cbpanelVersion: PACKAGE_VERSIONS.cbpanel,
        wrapperVersion: PACKAGE_VERSIONS.cloakbrowser,
        wrapperVersionDetail: PACKAGE_VERSIONS.cloakbrowser ? "Packaged with CBPanel sidecar." : "Unknown in packaged runtime.",
        chromiumVersion: info.version,
        baselineChromiumVersion: info.bundledVersion ?? info.version,
        playwrightCoreVersion: PACKAGE_VERSIONS.playwrightCore,
        puppeteerCoreVersion: PACKAGE_VERSIONS.puppeteerCore,
      },
      downloads: {
        current,
        latest: this.updateCheck?.downloadLinks,
      },
      env,
      operation: this.operation,
      update: this.updateCheck,
      portable: this.options.portable,
      cacheManagedByCbpanel: isCacheManagedByCbpanel(env),
      restartRequired: this.runtimeRestartRequired(),
      detail: info.installed ? undefined : "CloakBrowser Chromium is not installed.",
    };
  }

  private async persistUpdateCheck(): Promise<void> {
    if (!this.updateCheck || !this.options.saveSettings) return;
    const settings = normalizeSettings(await this.options.readSettings());
    await this.options.saveSettings({
      binary: {
        ...settings.binary,
        lastUpdateCheck: this.updateCheck,
      },
    });
  }

  private async markUpdateCheckCurrent(target: BrowserCoreTarget): Promise<void> {
    const current = await this.readInfo();
    this.updateCheck = {
      checkedAt: new Date().toISOString(),
      targetTier: target.tier,
      versionMode: target.versionMode,
      currentVersion: current.version,
      latestVersion: current.version,
      updateAvailable: false,
      downloadLinks: this.downloadLinks(current, current.version, target.tier, usesLicensedDownloads(target)),
    };
    await this.persistUpdateCheck();
  }

  private runtimeEnv(settings: AppSettings): BrowserCoreEnvRuntimeValue[] {
    const binary = settings.binary;
    const values = new Map<string, BrowserCoreEnvRuntimeValue>();
    const cacheDir =
      binary.cacheDirMode === "custom" && binary.customCacheDir
        ? binary.customCacheDir
        : this.defaultCacheDir();
    const envValues = browserCoreEnvValues(settings, this.initialBuiltinEnv);

    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_BINARY_PATH",
      value: envValues.binaryPath,
      enabled: Boolean(envValues.binaryPath),
      source: envValues.binaryPathSource,
      valueKind: "path",
      detail: envValues.binaryPath ? "Custom binary path bypasses managed binary install/update." : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_CACHE_DIR",
      value: cacheDir,
      enabled: true,
      source: binary.cacheDirMode === "custom" ? "settings" : "cbpanel-default",
      valueKind: "directory",
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_DOWNLOAD_URL",
      value: envValues.downloadUrl,
      enabled: Boolean(envValues.downloadUrl),
      source: envValues.downloadUrlSource,
      valueKind: "url",
      detail: envValues.downloadUrl ? "Custom source disables CloakBrowser's GitHub fallback and authenticated download routing." : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_AUTO_UPDATE",
      value: envValues.autoUpdate,
      enabled: true,
      source: envValues.autoUpdateSource,
      valueKind: "boolean",
      detail: envValues.autoUpdate === "true"
        ? "CloakBrowser may download newer Chromium binaries in the background."
        : "CBPanel controls update checks and does not allow silent binary updates by default.",
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_SKIP_CHECKSUM",
      value: envValues.skipChecksum,
      enabled: true,
      source: envValues.skipChecksumSource,
      valueKind: "boolean",
      detail: envValues.skipChecksum === "true" ? "Checksum verification is disabled." : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      value: envValues.geoipTimeoutSeconds,
      enabled: Boolean(envValues.geoipTimeoutSeconds),
      source: envValues.geoipTimeoutSecondsSource,
      valueKind: "number",
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_VERSION",
      value: envValues.version,
      enabled: Boolean(envValues.version),
      source: envValues.versionSource,
      valueKind: "text",
      detail: envValues.version ? "Pins an exact CloakBrowser Chromium version for launches and binary management." : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_LICENSE_KEY",
      value: envValues.licenseKey,
      enabled: Boolean(envValues.licenseKey),
      source: envValues.licenseKeySource,
      valueKind: "secret",
      sensitive: true,
      detail: envValues.licenseKey ? "Enables authenticated CloakBrowser downloads unless a custom download URL is set." : undefined,
    });

    for (const item of binary.customEnvVars) {
      if (!item.enabled || !item.value.trim() || values.has(item.key)) continue;
      this.setRuntimeEnv(values, {
        key: item.key,
        value: item.value,
        enabled: true,
        source: "custom",
        valueKind: item.valueKind,
        sensitive: item.sensitive,
        detail: item.description,
      });
    }

    return [...values.values()];
  }

  private setRuntimeEnv(
    values: Map<string, BrowserCoreEnvRuntimeValue>,
    input: Omit<BrowserCoreEnvRuntimeValue, "label" | "maskedValue" | "requiresRuntimeRestart" | "sensitive"> & {
      sensitive?: boolean;
    },
  ): void {
    const sensitive = input.sensitive ?? isSensitiveEnv(input.key);
    values.set(input.key, {
      ...input,
      label: input.key,
      maskedValue: maskEnvValue(input.key, input.value, sensitive),
      sensitive,
      requiresRuntimeRestart: this.envValueRequiresRuntimeRestart(input.key, input.enabled ? input.value : undefined),
    });
  }

  private defaultCacheDir(): string {
    return path.join(this.options.dataDir, "cloakbrowser-cache");
  }

  private async cloakbrowser(): Promise<CloakBrowserModule> {
    await this.applyBrowserCoreEnv();
    if (!this.cloakbrowserModule) {
      this.loadedBuiltinEnv = captureEnv(BUILTIN_ENV_KEYS);
      this.loadedCustomEnv = captureCloakBrowserEnv();
      this.cloakbrowserModule = this.options.loadCloakBrowser
        ? await this.options.loadCloakBrowser()
        : await import("cloakbrowser");
    }
    await this.applyGithubMirrorFetch(this.cloakbrowserModule);
    return this.cloakbrowserModule;
  }

  private async applyGithubMirrorFetch(runtime: CloakBrowserModule): Promise<void> {
    const settings = normalizeSettings(await this.options.readSettings());
    const target = browserCoreTarget(settings, this.initialBuiltinEnv);
    const resolution = target.tier === "pro" || usesLicensedDownloads(target)
      ? undefined
      : await this.githubMirrorProbeService.resolvePrefix(settings, runtime.binaryInfo(target.pinnedVersion).version);
    applyGithubMirrorFetch(settings, resolution?.prefix);
  }

  private runtimeRestartRequired(): boolean {
    if (!this.loadedBuiltinEnv) return false;
    if (BUILTIN_ENV_KEYS.some((key) => this.loadedBuiltinEnv?.get(key) !== process.env[key])) return true;
    if (!this.loadedCustomEnv) return false;
    const currentCustom = captureCloakBrowserEnv();
    const keys = new Set([...this.loadedCustomEnv.keys(), ...currentCustom.keys()]);
    for (const key of keys) {
      if (this.loadedCustomEnv.get(key) !== currentCustom.get(key)) return true;
    }
    return false;
  }

  private envValueRequiresRuntimeRestart(key: string, expectedValue: string | undefined): boolean {
    const normalizedExpected = expectedValue === "" ? undefined : expectedValue;
    if (isBuiltinEnvKey(key)) {
      return Boolean(this.loadedBuiltinEnv && this.loadedBuiltinEnv.get(key) !== normalizedExpected);
    }
    return Boolean(this.loadedCustomEnv && this.loadedCustomEnv.get(key) !== normalizedExpected);
  }

  private async applyBrowserCoreEnv(): Promise<void> {
    const settings = normalizeSettings(await this.options.readSettings());
    const binary = settings.binary;
    const envValues = browserCoreEnvValues(settings, this.initialBuiltinEnv);
    const desiredBuiltins: Record<(typeof BUILTIN_ENV_KEYS)[number], string | undefined> = {
      CLOAKBROWSER_BINARY_PATH: envValues.binaryPath,
      CLOAKBROWSER_CACHE_DIR:
        binary.cacheDirMode === "custom" && binary.customCacheDir
          ? binary.customCacheDir
          : this.defaultCacheDir(),
      CLOAKBROWSER_DOWNLOAD_URL: envValues.downloadUrl,
      CLOAKBROWSER_AUTO_UPDATE: envValues.autoUpdate,
      CLOAKBROWSER_SKIP_CHECKSUM: envValues.skipChecksum,
      CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS: envValues.geoipTimeoutSeconds,
      CLOAKBROWSER_VERSION: envValues.version,
      CLOAKBROWSER_LICENSE_KEY: envValues.licenseKey,
    };

    for (const [key, value] of Object.entries(desiredBuiltins)) {
      writeProcessEnv(key, value);
    }

    const desiredCustom = new Map(
      binary.customEnvVars
        .filter((item) => item.enabled && item.value.trim() && !BUILTIN_ENV_KEY_SET.has(item.key))
        .map((item) => [item.key, item.value] as const),
    );
    for (const key of desiredCustom.keys()) {
      if (!this.initialCustomEnv.has(key)) this.initialCustomEnv.set(key, process.env[key]);
    }
    for (const key of this.appliedCustomEnvKeys) {
      if (!desiredCustom.has(key)) writeProcessEnv(key, this.initialCustomEnv.get(key));
    }
    for (const [key, value] of desiredCustom) {
      writeProcessEnv(key, value);
    }
    this.appliedCustomEnvKeys.clear();
    for (const key of desiredCustom.keys()) this.appliedCustomEnvKeys.add(key);
  }

  private async collectWrapperDiagnostics(quick: boolean): Promise<Record<string, unknown>> {
    const settings = normalizeSettings(await this.options.readSettings());
    const target = browserCoreTarget(settings, this.initialBuiltinEnv);
    const info = await this.readInfo();
    const cacheRoot = process.env.CLOAKBROWSER_CACHE_DIR || this.defaultCacheDir();
    const geoipPath = path.join(cacheRoot, "geoip", "GeoLite2-City.mmdb");

    return {
      environment: {
        node: process.version,
        os: os.type(),
        arch: os.arch(),
        platform_tag: info.platform,
      },
      binary: {
        version: info.version,
        tier: info.tier ?? target.tier,
        bundled_version: info.bundledVersion ?? info.version,
        path: info.binaryPath,
        installed: info.installed,
        cache_dir: info.cacheDir,
        override: process.env.CLOAKBROWSER_BINARY_PATH ?? null,
      },
      launch: await collectBinaryLaunchDiagnostics(info.binaryPath, info.installed, quick),
      license: {
        tier: info.tier ?? target.tier,
      },
      geoip: {
        db_present: await pathExists(geoipPath),
        path: geoipPath,
      },
      modules: {
        "playwright-core": Boolean(PACKAGE_VERSIONS.playwrightCore),
        "puppeteer-core": Boolean(PACKAGE_VERSIONS.puppeteerCore),
        "mmdb-lib": true,
      },
    };
  }

  private async withCustomBinaryOverride(info: CloakBinaryInfo): Promise<CloakBinaryInfo> {
    const customBinaryPath = process.env.CLOAKBROWSER_BINARY_PATH;
    if (!customBinaryPath) return info;
    const installed = await pathExists(customBinaryPath);
    return {
      ...info,
      binaryPath: customBinaryPath,
      installed,
      cacheDir: path.dirname(customBinaryPath),
      downloadUrl: process.env.CLOAKBROWSER_DOWNLOAD_URL ?? info.downloadUrl,
    };
  }

  private async withManagedCacheProbe(info: CloakBinaryInfo): Promise<CloakBinaryInfo> {
    if (info.installed || process.env.CLOAKBROWSER_BINARY_PATH) return info;
    if (await pathExists(info.binaryPath)) return { ...info, installed: true };

    const repaired = await this.repairCompatibleManagedCache(info);
    return repaired ?? info;
  }

  private async repairCompatibleManagedCache(info: CloakBinaryInfo): Promise<CloakBinaryInfo | undefined> {
    const executableName = path.basename(info.binaryPath);
    const cacheRoot = path.dirname(info.cacheDir);
    const candidates = await listManagedCacheCandidates(cacheRoot, executableName);
    const isPro = info.tier === "pro" || info.cacheDir.endsWith("-pro");
    const compatible = candidates.find((candidate) =>
      candidate.pro === isPro && versionsShareChromiumBuild(info.version, candidate.version),
    );
    if (!compatible) return undefined;

    await fs.rm(info.cacheDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(info.cacheDir), { recursive: true });
    await fs.rename(compatible.directory, info.cacheDir);
    return {
      ...info,
      installed: true,
    };
  }

  private async writeVersionMarker(version: string): Promise<void> {
    const runtime = await this.cloakbrowser();
    const info = runtime.binaryInfo(version);
    const cacheRoot = process.env.CLOAKBROWSER_CACHE_DIR || this.defaultCacheDir();
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, `latest_version_${info.platform}`), version, "utf8");
  }

  private async writeProVersionMarker(version: string): Promise<void> {
    const runtime = await this.cloakbrowser();
    const info = runtime.binaryInfo(version);
    const cacheRoot = process.env.CLOAKBROWSER_CACHE_DIR || this.defaultCacheDir();
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, `latest_pro_version_${info.platform}`), version, "utf8");
  }

  private downloadLinks(
    info: CloakBinaryInfo,
    version: string,
    tier: BrowserCoreTier,
    authenticatedDownload = false,
  ): BrowserCoreDownloadLinks {
    const customBase = process.env.CLOAKBROWSER_DOWNLOAD_URL?.replace(/\/+$/, "");
    const platform = info.platform;
    const archiveName = archiveNameForPlatform(platform);
    if (authenticatedDownload && !customBase) {
      const manifestBase = `${CLOAKBROWSER_DEFAULT_BASE_URL}/releases/pro/chromium-v${version}`;
      return {
        tier,
        version,
        platform,
        primaryUrl: `${CLOAKBROWSER_DEFAULT_BASE_URL}/api/download/${version}`,
        checksumUrl: `${manifestBase}/SHA256SUMS`,
        signatureUrl: `${manifestBase}/SHA256SUMS.sig`,
        requiresLicense: true,
      };
    }
    const base = customBase || CLOAKBROWSER_DEFAULT_BASE_URL;
    const primaryUrl = `${base}/chromium-v${version}/${archiveName}`;
    const checksumUrl = `${base}/chromium-v${version}/SHA256SUMS`;
    return {
      tier: customBase ? "free" : tier,
      version,
      platform,
      primaryUrl: primaryUrl,
      fallbackUrl: customBase ? undefined : `${GITHUB_DOWNLOAD_BASE_URL}/chromium-v${version}/${archiveName}`,
      checksumUrl: checksumUrl,
      signatureUrl: customBase ? undefined : `${base}/chromium-v${version}/SHA256SUMS.sig`,
      fallbackChecksumUrl: customBase ? undefined : `${GITHUB_DOWNLOAD_BASE_URL}/chromium-v${version}/SHA256SUMS`,
      fallbackSignatureUrl: customBase ? undefined : `${GITHUB_DOWNLOAD_BASE_URL}/chromium-v${version}/SHA256SUMS.sig`,
    };
  }

  private async latestProChromiumVersion(platform: string): Promise<string | undefined> {
    const response = await this.fetchImpl(`${CLOAKBROWSER_DEFAULT_BASE_URL}/api/download/version`, {
      headers: { "X-Platform": platform },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`CloakBrowser authenticated version check failed: HTTP ${response.status}`);
    const data = await response.json() as { version?: unknown };
    return typeof data.version === "string" && data.version.trim() ? data.version.trim() : undefined;
  }

  private async latestChromiumVersion(platform: string): Promise<string | undefined> {
    const response = await this.fetchFirstSuccessfulReleaseMetadata();
    const releases = (await response.json()) as Array<{
      tag_name?: string;
      draft?: boolean;
      assets?: Array<{ name?: string }>;
    }>;
    const archiveName = archiveNameForPlatform(platform);
    for (const release of releases) {
      if (!release.tag_name?.startsWith("chromium-v") || release.draft) continue;
      const assets = new Set((release.assets ?? []).map((asset) => asset.name));
      if (assets.has(archiveName)) return release.tag_name.replace(/^chromium-v/, "");
    }
    return undefined;
  }

  private async fetchFirstSuccessfulReleaseMetadata(): Promise<Response> {
    const urls = [
      `${GITHUB_API_URL}?per_page=10`,
      `${GITHUB_API_FALLBACK_URL}?per_page=10`,
    ];
    const failures: string[] = [];

    for (const url of urls) {
      try {
        const response = await this.fetchImpl(url, {
          signal: AbortSignal.timeout(10_000),
        });
        if (response.ok) return response;
        failures.push(`${url}: HTTP ${response.status}`);
      } catch (error) {
        failures.push(`${url}: ${(error as Error).message}`);
      }
    }

    throw new Error(`GitHub release check failed: ${failures.join("; ")}`);
  }

  private startOperation(type: BrowserCoreOperation["type"], phase: string, message: string): void {
    this.operation = {
      id: `${type}-${Date.now()}`,
      type,
      status: "running",
      phase,
      startedAt: new Date().toISOString(),
      progress: {
        label: message,
      },
      logs: [],
    };
    this.log("info", message);
  }

  private log(level: BrowserCoreOperationLog["level"], message: string, detail?: string): void {
    if (!this.operation) return;
    this.operation.logs = [
      ...this.operation.logs,
      {
        at: new Date().toISOString(),
        level,
        message: sanitizeOperationText(message) ?? message,
        detail: sanitizeOperationText(detail),
      },
    ].slice(-80);
  }

  private setOperationProgress(phase: string, label: string, current?: number, total?: number): void {
    if (!this.operation) return;
    this.operation.phase = phase;
    this.operation.progress = {
      current,
      total,
      label: sanitizeOperationText(label),
    };
    this.log("info", label);
  }

  private finishOperation(status: BrowserCoreOperation["status"], message: string, detail?: string): void {
    if (!this.operation) return;
    this.operation.status = status;
    this.operation.phase = status === "succeeded" ? "complete" : status;
    this.operation.finishedAt = new Date().toISOString();
    if (status === "failed") this.operation.error = detail ?? message;
    this.log(status === "failed" ? "error" : "info", message, detail);
  }

  private async captureCloakbrowserOperationLogs<T>(work: () => Promise<T>): Promise<T> {
    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;
    const capture = (level: BrowserCoreOperationLog["level"], args: unknown[]) => {
      const message = formatConsoleMessage(args);
      if (message) this.ingestCloakbrowserLog(level, message);
    };

    console.log = (...args: unknown[]) => {
      capture("info", args);
      originalLog(...sanitizeConsoleArgs(args));
    };
    console.warn = (...args: unknown[]) => {
      capture("warn", args);
      originalWarn(...sanitizeConsoleArgs(args));
    };
    console.error = (...args: unknown[]) => {
      capture("error", args);
      originalError(...sanitizeConsoleArgs(args));
    };

    try {
      return await work();
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  }

  private async runExplicitCloakbrowserUpdate<T>(work: () => Promise<T>): Promise<T> {
    const previousAutoUpdate = process.env.CLOAKBROWSER_AUTO_UPDATE;
    writeProcessEnv("CLOAKBROWSER_AUTO_UPDATE", "true");
    try {
      return await work();
    } finally {
      writeProcessEnv("CLOAKBROWSER_AUTO_UPDATE", previousAutoUpdate);
    }
  }

  private ingestCloakbrowserLog(level: BrowserCoreOperationLog["level"], message: string): void {
    const normalized = message.trim();
    if (!normalized) return;

    const progress = normalized.match(/Download progress:\s*(\d+)%\s*\((\d+)\/(\d+)\s+MB\)/i);
    if (progress) {
      const percent = clampProgress(Number(progress[1]));
      this.setOperationProgress("downloading", normalized, percent, 100);
      return;
    }

    if (/Downloading from/i.test(normalized)) {
      this.setOperationProgress("downloading", normalized);
    } else if (/Download complete/i.test(normalized)) {
      this.setOperationProgress("verifying", normalized, 100, 100);
    } else if (/Checksum verified/i.test(normalized)) {
      this.setOperationProgress("extracting", normalized, 100, 100);
    } else if (/Extracting to/i.test(normalized)) {
      this.setOperationProgress("extracting", normalized);
    } else if (/Binary ready/i.test(normalized)) {
      this.setOperationProgress("finalizing", normalized, 100, 100);
    } else {
      this.log(level, normalized);
    }
  }

  private envInfo(): CloakBrowserEnvInfo {
    return {
      binaryPath: process.env.CLOAKBROWSER_BINARY_PATH,
      cacheDir: process.env.CLOAKBROWSER_CACHE_DIR,
      downloadUrl: process.env.CLOAKBROWSER_DOWNLOAD_URL,
      autoUpdate: process.env.CLOAKBROWSER_AUTO_UPDATE,
      skipChecksum: process.env.CLOAKBROWSER_SKIP_CHECKSUM,
      geoipTimeoutSeconds: process.env.CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS,
      version: process.env.CLOAKBROWSER_VERSION,
      licenseKey: process.env.CLOAKBROWSER_LICENSE_KEY ? maskEnvValue("CLOAKBROWSER_LICENSE_KEY", process.env.CLOAKBROWSER_LICENSE_KEY, true) : undefined,
    };
  }
}

function isCacheManagedByCbpanel(env: BrowserCoreEnvRuntimeValue[]): boolean {
  const row = env.find((item) => item.key === "CLOAKBROWSER_CACHE_DIR");
  return row?.source === "cbpanel-default" || row?.source === "settings";
}

function browserCoreTarget(
  settings: AppSettings,
  initialBuiltinEnv = new Map<string, string | undefined>(),
): BrowserCoreTarget {
  const binary = settings.binary;
  const customRows = new Map(binary.customEnvVars.map((item) => [item.key, item]));
  const enabledCustom = new Map(binary.customEnvVars.filter((item) => item.enabled).map((item) => [item.key, item]));
  const customDownloadBaseUrl = resolveOptionalEnvValue(
    "CLOAKBROWSER_DOWNLOAD_URL",
    customRows,
    enabledCustom,
    binary.downloadSourceMode === "custom" ? envUrlBaseValue(binary.customDownloadBaseUrl) : undefined,
    initialBuiltinEnv,
    envUrlBaseValue,
  ).value;
  const licenseKeyResolution = resolveOptionalEnvValue(
    "CLOAKBROWSER_LICENSE_KEY",
    customRows,
    enabledCustom,
    envStringValue(binary.licenseKey),
    initialBuiltinEnv,
    envStringValue,
  );
  const licenseKey = licenseKeyResolution.value;
  const configuredPinnedVersion = resolveOptionalEnvValue(
    "CLOAKBROWSER_VERSION",
    customRows,
    enabledCustom,
    binary.browserVersionMode === "pinned" ? envStringValue(binary.pinnedBrowserVersion) : undefined,
    initialBuiltinEnv,
    envStringValue,
  );
  const pinnedVersion = freeKeyForcesLatest(binary.tierMode, licenseKeyResolution, customDownloadBaseUrl)
    ? undefined
    : configuredPinnedVersion.value;
  const customBinaryPath = resolveOptionalEnvValue(
    "CLOAKBROWSER_BINARY_PATH",
    customRows,
    enabledCustom,
    binary.customBinaryPathEnabled ? envStringValue(binary.customBinaryPath) : undefined,
    initialBuiltinEnv,
    envStringValue,
  ).value;
  return {
    tier: customDownloadBaseUrl ? "free" : binary.tierMode,
    versionMode: pinnedVersion ? "pinned" : "latest",
    pinnedVersion,
    licenseKey,
    customBinaryPath,
    customDownloadBaseUrl,
  };
}

function usesLicensedDownloads(target: BrowserCoreTarget): boolean {
  return Boolean(target.licenseKey && !target.customDownloadBaseUrl);
}

function freeKeyForcesLatest(
  tier: BrowserCoreTier,
  licenseKey: BrowserCoreEnvResolution,
  customDownloadBaseUrl: string | undefined,
): boolean {
  return tier === "free"
    && Boolean(licenseKey.value)
    && licenseKey.source !== "external"
    && !customDownloadBaseUrl;
}

function browserCoreEnvValues(
  settings: AppSettings,
  initialBuiltinEnv = new Map<string, string | undefined>(),
): {
  binaryPath: string | undefined;
  binaryPathSource: BrowserCoreEnvRuntimeValue["source"];
  downloadUrl: string | undefined;
  downloadUrlSource: BrowserCoreEnvRuntimeValue["source"];
  autoUpdate: string;
  autoUpdateSource: BrowserCoreEnvRuntimeValue["source"];
  skipChecksum: string;
  skipChecksumSource: BrowserCoreEnvRuntimeValue["source"];
  geoipTimeoutSeconds: string | undefined;
  geoipTimeoutSecondsSource: BrowserCoreEnvRuntimeValue["source"];
  version: string | undefined;
  versionSource: BrowserCoreEnvRuntimeValue["source"];
  licenseKey: string | undefined;
  licenseKeySource: BrowserCoreEnvRuntimeValue["source"];
} {
  const binary = settings.binary;
  const customRows = new Map(settings.binary.customEnvVars.map((item) => [item.key, item]));
  const custom = new Map(settings.binary.customEnvVars.filter((item) => item.enabled).map((item) => [item.key, item]));
  const binaryPath = resolveOptionalEnvValue(
    "CLOAKBROWSER_BINARY_PATH",
    customRows,
    custom,
    binary.customBinaryPathEnabled ? envStringValue(binary.customBinaryPath) : undefined,
    initialBuiltinEnv,
    envStringValue,
  );
  const downloadUrl = resolveOptionalEnvValue(
    "CLOAKBROWSER_DOWNLOAD_URL",
    customRows,
    custom,
    binary.downloadSourceMode === "custom" ? envUrlBaseValue(binary.customDownloadBaseUrl) : undefined,
    initialBuiltinEnv,
    envUrlBaseValue,
  );
  const autoUpdate = "false";
  const skipChecksum = "false";
  const geoipRow = custom.get("CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS");
  const geoipTimeoutSeconds = geoipRow
    ? numberEnvValue(geoipRow.value, 12, 1, 60)
    : undefined;
  const licenseKey = resolveOptionalEnvValue(
    "CLOAKBROWSER_LICENSE_KEY",
    customRows,
    custom,
    envStringValue(binary.licenseKey),
    initialBuiltinEnv,
    envStringValue,
  );
  const configuredVersion = resolveOptionalEnvValue(
    "CLOAKBROWSER_VERSION",
    customRows,
    custom,
    binary.browserVersionMode === "pinned" ? envStringValue(binary.pinnedBrowserVersion) : undefined,
    initialBuiltinEnv,
    envStringValue,
  );
  const version = freeKeyForcesLatest(binary.tierMode, licenseKey, downloadUrl.value)
    ? { source: configuredVersion.source }
    : configuredVersion;

  return {
    binaryPath: binaryPath.value,
    binaryPathSource: binaryPath.source,
    downloadUrl: downloadUrl.value,
    downloadUrlSource: downloadUrl.source,
    autoUpdate,
    autoUpdateSource: "settings",
    skipChecksum,
    skipChecksumSource: "settings",
    geoipTimeoutSeconds,
    geoipTimeoutSecondsSource: geoipRow ? "custom" : "cloakbrowser-default",
    version: version.value,
    versionSource: version.source,
    licenseKey: licenseKey.value,
    licenseKeySource: licenseKey.source,
  };
}

function envStringValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function envUrlBaseValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

function resolveOptionalEnvValue(
  key: string,
  customRows: Map<string, { enabled: boolean; value: string }>,
  enabledCustom: Map<string, { value: string }>,
  settingsValue: string | undefined,
  initialBuiltinEnv: Map<string, string | undefined>,
  normalize: (value: string | undefined) => string | undefined,
): BrowserCoreEnvResolution {
  const custom = enabledCustom.get(key);
  if (custom) {
    return { value: normalize(custom.value), source: "custom" };
  }
  if (customRows.has(key)) {
    return { source: "cloakbrowser-default" };
  }
  if (settingsValue) {
    return { value: settingsValue, source: "settings" };
  }
  const external = normalize(initialBuiltinEnv.get(key));
  if (external) {
    return { value: external, source: "external" };
  }
  return { source: "cloakbrowser-default" };
}

function numberEnvValue(value: string | undefined, fallback: number, min: number, max: number): string {
  const numeric = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isFinite(numeric)) return String(fallback);
  return String(Math.round(Math.min(max, Math.max(min, numeric))));
}

function normalizeCloakBrowserDiagnostics(input: unknown, checkedAt: string): CloakBrowserDiagnostics {
  const root = objectValue(input);
  if (!root) {
    return {
      checkedAt,
      available: false,
      error: "Invalid CloakBrowser diagnostics payload.",
    };
  }

  const environment = objectValue(root.environment);
  const binary = objectValue(root.binary);
  const launch = objectValue(root.launch);
  const license = objectValue(root.license);
  const geoip = objectValue(root.geoip);
  const fonts = objectValue(root.fonts);
  const modules = objectValue(root.modules);

  return {
    checkedAt,
    available: true,
    environment: environment
      ? {
          node: stringValue(environment.node),
          os: stringValue(environment.os),
          arch: stringValue(environment.arch),
          platformTag: stringValue(environment.platform_tag),
        }
      : undefined,
    binary: binary
      ? {
          version: stringValue(binary.version),
          tier: stringValue(binary.tier),
          bundledVersion: stringValue(binary.bundled_version),
          path: stringValue(binary.path),
          installed: booleanValue(binary.installed),
          cacheDir: stringValue(binary.cache_dir),
          override: stringValue(binary.override),
          error: stringValue(binary.error),
        }
      : undefined,
    launch: launch
      ? {
          tested: booleanValue(launch.tested) ?? false,
          ok: booleanValue(launch.ok),
          version: stringValue(launch.version),
          error: stringValue(launch.error),
          reason: stringValue(launch.reason),
          missingLibs: stringArrayValue(launch.missing_libs),
        }
      : undefined,
    license: license
      ? {
          tier: stringValue(license.tier),
          valid: booleanValue(license.valid),
          expires: stringValue(license.expires),
          error: stringValue(license.error),
          sessions: diagnosticsLicenseSessions(license.sessions),
        }
      : undefined,
    geoip: geoip
      ? {
          dbPresent: booleanValue(geoip.db_present),
          path: stringValue(geoip.path),
        }
      : undefined,
    fonts: fonts
      ? {
          windowsFonts: stringValue(fonts.windows_fonts),
        }
      : undefined,
    modules: modules
      ? Object.fromEntries(
          Object.entries(modules)
            .map(([key, value]) => [key, booleanValue(value)])
            .filter((entry): entry is [string, boolean] => typeof entry[1] === "boolean"),
        )
      : undefined,
  };
}

function diagnosticsErrorMessage(error: unknown): string {
  const record = error as {
    message?: string;
    stdout?: Buffer | string;
    stderr?: Buffer | string;
  };
  const stderr = bufferOrString(record.stderr).trim();
  if (stderr) return stderr;
  const stdout = bufferOrString(record.stdout).trim();
  if (stdout) return stdout;
  return record.message ?? String(error);
}

function bufferOrString(value: Buffer | string | undefined): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  return "";
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nullableNumberValue(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function diagnosticsLicenseSessions(value: unknown): CloakBrowserDiagnosticsLicense["sessions"] {
  const sessions = objectValue(value);
  if (!sessions) return undefined;
  const active = nullableNumberValue(sessions.active);
  return active === undefined ? undefined : { active };
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
  return items.length ? items : undefined;
}

async function collectBinaryLaunchDiagnostics(
  binaryPath: string,
  installed: boolean,
  quick: boolean,
): Promise<Record<string, unknown>> {
  if (quick) return { tested: false, reason: "skipped (--quick)" };
  if (!installed || !(await pathExists(binaryPath))) return { tested: false, reason: "binary not installed" };

  try {
    const { stdout } = await execFileAsync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return {
      tested: true,
      ok: true,
      version: stdout.trim(),
      error: "",
    };
  } catch (error) {
    const result: Record<string, unknown> = {
      tested: true,
      ok: false,
      version: "",
      error: diagnosticsErrorMessage(error),
    };
    const missingLibs = await readMissingSharedLibs(binaryPath);
    if (missingLibs.length > 0) result.missing_libs = missingLibs;
    return result;
  }
}

async function readMissingSharedLibs(binaryPath: string): Promise<string[]> {
  if (process.platform !== "linux") return [];
  try {
    const { stdout } = await execFileAsync("ldd", ["--", binaryPath], {
      encoding: "utf8",
      timeout: 10_000,
    });
    return stdout
      .split("\n")
      .filter((line) => line.includes("=> not found"))
      .map((line) => line.split("=>")[0]?.trim())
      .filter((line): line is string => Boolean(line));
  } catch {
    return [];
  }
}

function archiveNameForPlatform(platform: string): string {
  return `cloakbrowser-${platform}${platform.startsWith("windows") ? ".zip" : ".tar.gz"}`;
}

function archivePlatformFromName(fileName: string): string | undefined {
  const match = fileName.match(/cloakbrowser-([a-z0-9-]+)\.(?:zip|tar\.gz|tgz)$/i);
  return match?.[1];
}

type BrowserCoreArchiveKind = "zip" | "tar.gz";

function archiveKindFromPath(filePath: string): BrowserCoreArchiveKind | undefined {
  const normalized = filePath.toLowerCase();
  if (normalized.endsWith(".zip")) return "zip";
  if (normalized.endsWith(".tar.gz") || normalized.endsWith(".tgz")) return "tar.gz";
  return undefined;
}

function normalizeImportedVersion(importedVersion: string | undefined, currentVersion: string): string | undefined {
  if (!importedVersion) return undefined;
  return versionsShareChromiumBuild(currentVersion, importedVersion) ? currentVersion : importedVersion;
}

function versionsShareChromiumBuild(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
}

function importOperation(currentVersion: string, importedVersion: string | undefined, platformOk: boolean): BrowserCoreImportAnalysis["operation"] {
  if (!platformOk || !importedVersion) return "blocked";
  const diff = compareVersions(importedVersion, currentVersion);
  if (diff > 0) return "upgrade";
  if (diff < 0) return "downgrade";
  return "reinstall";
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

async function readChromeVersionFromArchive(
  filePath: string,
  archiveBytes?: Uint8Array,
  archiveKind = archiveKindFromPath(filePath),
): Promise<string | undefined> {
  const pathVersion = versionFromPath(filePath);
  if (pathVersion) return pathVersion;

  const bytes = archiveBytes ?? await fs.readFile(filePath);
  const entryVersion = archiveKind === "zip" ? versionFromZipEntries(bytes) : await versionFromTarEntries(filePath);
  if (entryVersion) return entryVersion;
  if (!archiveKind) return undefined;

  const stagingDir = path.join(path.dirname(filePath), `.cbpanel-version-probe-${Date.now()}`);
  try {
    await fs.mkdir(stagingDir, { recursive: true });
    const executableName = process.platform === "win32" ? "chrome.exe" : "chrome";
    let chromePath: string | undefined;
    if (archiveKind === "zip") {
      const executableBytes = extractChromeExecutable(bytes);
      if (!executableBytes) return undefined;
      chromePath = path.join(stagingDir, executableName);
      await fs.writeFile(chromePath, executableBytes);
    } else {
      await extractTarArchive(filePath, stagingDir);
      await flattenSingleSubdir(stagingDir);
      chromePath = await findFile(stagingDir, executableName, 4);
      if (!chromePath) return undefined;
    }
    await fs.chmod(chromePath, 0o755).catch(() => undefined);
    return await readExecutableVersion(chromePath);
  } catch {
    return undefined;
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function versionFromPath(filePath: string): string | undefined {
  const parentVersion = path.dirname(filePath).match(/chromium-v([0-9.]+)/i)?.[1];
  if (parentVersion) return parentVersion;
  return path.basename(filePath).match(/chromium-v?([0-9]+(?:\.[0-9]+){2,})/i)?.[1];
}

function versionFromZipEntries(zipBytes: Uint8Array): string | undefined {
  const names: string[] = [];
  try {
    unzipSync(zipBytes, {
      filter: (file) => {
        names.push(file.name.replace(/\\/g, "/"));
        return false;
      },
    });
  } catch {
    return undefined;
  }

  for (const name of names) {
    const version = name.match(/(?:^|\/)chromium-v?([0-9]+(?:\.[0-9]+){2,})(?:\/|$)/i)?.[1];
    if (version) return version;
  }
  return undefined;
}

async function versionFromTarEntries(filePath: string): Promise<string | undefined> {
  let found: string | undefined;
  try {
    await tar.list({
      file: filePath,
      onReadEntry: (entry) => {
        found ??= entry.path.match(/(?:^|\/)chromium-v?([0-9]+(?:\.[0-9]+){2,})(?:\/|$)/i)?.[1]
          ?? entry.path.match(/(?:^|\/)chromium-([0-9]+(?:\.[0-9]+){2,})(?:\/|$)/i)?.[1];
      },
    });
  } catch {
    return undefined;
  }
  return found;
}

function extractChromeExecutable(zipBytes: Uint8Array): Uint8Array | undefined {
  const entries = unzipSync(zipBytes, {
    filter: (file) => isChromeExecutableEntry(file.name),
  });
  const sorted = Object.entries(entries)
    .filter(([entryName]) => isChromeExecutableEntry(entryName))
    .sort(([left], [right]) => left.length - right.length);
  return sorted[0]?.[1];
}

function isChromeExecutableEntry(entryName: string): boolean {
  const normalized = entryName.replace(/\\/g, "/").toLowerCase();
  if (!normalized || normalized.endsWith("/")) return false;
  const baseName = path.posix.basename(normalized);
  return baseName === "chrome.exe" || baseName === "chrome";
}

async function readExecutableVersion(executablePath: string): Promise<string | undefined> {
  if (process.platform === "win32") {
    try {
      const escaped = executablePath.replace(/'/g, "''");
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Item -LiteralPath '${escaped}').VersionInfo.ProductVersion`,
        ],
        { timeout: 15_000 },
      );
      const version = stdout.trim().match(/[0-9]+(?:\.[0-9]+){2,}/)?.[0];
      return version;
    } catch {
      return undefined;
    }
  }
  try {
    const { stdout } = await execFileAsync(executablePath, ["--version"], { timeout: 15_000 });
    return stdout.trim().match(/[0-9]+(?:\.[0-9]+){2,}/)?.[0];
  } catch {
    return undefined;
  }
}

async function writeArchiveEntries(
  archiveBytes: Uint8Array,
  outputDir: string,
  archiveKind: BrowserCoreArchiveKind | undefined,
  archivePath: string,
): Promise<void> {
  if (archiveKind === "zip") {
    await writeZipEntries(archiveBytes, outputDir);
    return;
  }
  if (archiveKind === "tar.gz") {
    await extractTarArchive(archivePath, outputDir);
    return;
  }
  throw Object.assign(new Error("Unsupported CloakBrowser import archive type."), { status: 400 });
}

async function writeZipEntries(zipBytes: Uint8Array, outputDir: string): Promise<void> {
  const entries = unzipSync(zipBytes);
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    const normalizedName = entryName.replace(/\\/g, "/");
    if (!normalizedName || normalizedName.endsWith("/")) continue;
    const targetPath = safeJoin(outputDir, normalizedName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entryBytes);
  }
}

async function extractTarArchive(archivePath: string, outputDir: string): Promise<void> {
  await tar.extract({
    file: archivePath,
    cwd: outputDir,
    filter: (entryPath) => isSafeArchivePath(entryPath),
  });
}

async function flattenSingleSubdir(directory: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.length !== 1 || !entries[0]?.isDirectory()) return;
  const subdir = path.join(directory, entries[0].name);
  if (entries[0].name.endsWith(".app")) return;
  const children = await fs.readdir(subdir);
  for (const child of children) {
    await fs.rename(path.join(subdir, child), path.join(directory, child));
  }
  await fs.rmdir(subdir);
}

async function findFile(directory: string, fileName: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return entryPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(path.join(directory, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
}

async function listManagedCacheCandidates(
  cacheRoot: string,
  executableName: string,
): Promise<Array<{ directory: string; version: string; binaryPath: string; pro: boolean }>> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates: Array<{ directory: string; version: string; binaryPath: string; pro: boolean }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const match = entry.name.match(/^chromium-(.+?)(-pro)?$/i);
    if (!match?.[1]) continue;
    const version = match[1];
    const pro = Boolean(match[2]);
    const directory = path.join(cacheRoot, entry.name);
    const binaryPath = path.join(directory, executableName);
    if (await pathExists(binaryPath)) candidates.push({ directory, version, binaryPath, pro });
  }
  return candidates.sort((left, right) => compareVersions(right.version, left.version));
}

function safeJoin(root: string, relativePath: string): string {
  if (!isSafeArchivePath(relativePath)) {
    throw Object.assign(new Error("CloakBrowser import archive contains an unsafe path."), { status: 400 });
  }
  const targetPath = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const comparableRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}${path.sep}`)) {
    throw Object.assign(new Error("CloakBrowser import archive contains an unsafe path."), { status: 400 });
  }
  return targetPath;
}

function isSafeArchivePath(relativePath: string): boolean {
  const normalizedPath = relativePath.replace(/\\/g, "/");
  if (!normalizedPath || normalizedPath.startsWith("/") || path.isAbsolute(normalizedPath)) return false;
  return !normalizedPath.split("/").some((part) => part === "..");
}

function isSensitiveEnv(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(key);
}

function captureEnv(keys: readonly string[]): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, process.env[key]]));
}

function isBuiltinEnvKey(key: string): key is (typeof BUILTIN_ENV_KEYS)[number] {
  return BUILTIN_ENV_KEY_SET.has(key);
}

function captureCloakBrowserEnv(): Map<string, string | undefined> {
  const values = new Map<string, string | undefined>();
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("CLOAKBROWSER_")) values.set(key, process.env[key]);
  }
  return values;
}

function writeProcessEnv(key: string, value: string | undefined): void {
  if (value === undefined || value === "") {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function formatConsoleMessage(args: unknown[]): string {
  return args.map((item) => {
    if (typeof item === "string") return item;
    if (item instanceof Error) return item.message;
    try {
      return JSON.stringify(item);
    } catch {
      return String(item);
    }
  }).join(" ");
}

function sanitizeConsoleArgs(args: unknown[]): unknown[] {
  return args.map((item) => {
    if (typeof item === "string") return sanitizeOperationText(item) ?? "";
    if (item instanceof Error) {
      const sanitized = new Error(sanitizeOperationText(item.message) ?? item.message);
      sanitized.name = item.name;
      sanitized.stack = sanitizeOperationText(item.stack);
      return sanitized;
    }
    return item;
  });
}

function sanitizeOperationText(value: string | undefined): string | undefined {
  if (!value) return value;
  return value.replace(/https?:\/\/[^\s)]+/g, (rawUrl) => maskUrlForLog(rawUrl));
}

function maskUrlForLog(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|password|credential|key/i.test(key)) url.searchParams.set(key, "****");
    }
    return url.toString();
  } catch {
    return rawUrl;
  }
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

export function resolvePackageVersion(compileTimeVersion: string | undefined, relativePath: string, cwd = process.cwd()): string | undefined {
  const normalizedCompileTimeVersion = compileTimeVersion?.trim();
  if (normalizedCompileTimeVersion) return normalizedCompileTimeVersion;
  return readPackageVersion(relativePath, cwd);
}

function readPackageVersion(relativePath: string, cwd = process.cwd()): string | undefined {
  try {
    const packagePath = path.join(cwd, relativePath);
    const raw = readFileSync(packagePath, "utf8");
    return (JSON.parse(raw) as { version?: string }).version;
  } catch {
    return undefined;
  }
}
