import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import * as tar from "tar";
import { safeJoin } from "./archiveUtils";
import { PrivateCoreReleaseService, parsePrivateRepositoryUrl } from "./privateCoreReleaseService";
import {
  type CloakBrowserDiagnostics,
  type CloakBrowserDiagnosticsGeoIpResolved,
  type CloakBrowserDiagnosticsLicense,
  type CloakBrowserDiagnosticsSessionState,
  type BrowserCoreEnvRuntimeValue,
  type BrowserCoreImportAnalysis,
  type BrowserCoreImportedBuild,
  type BrowserCoreInfo,
  type BrowserCoreLicenseState,
  type BrowserCoreOperation,
  type BrowserCoreOperationLog,
  type BrowserCoreOperationType,
  type BrowserCoreTargetVersion,
  type BrowserCoreTier,
  type BrowserCoreUpdateCheck,
  type BrowserCoreVersionMode,
  type BrowserCorePrivateRelease,
  type BrowserCoreChannelStates,
  type BrowserCoreOfficialLicenseState,
  maskEnvValue,
} from "../../src/shared/browserCore";
import {
  type AppSettings,
  type AppSettingsPatch,
  type BrowserCoreReleaseChannel,
  type BrowserCoreChannel,
  type BrowserCoreChannelMode,
  type BrowserCoreTierMode,
  normalizeSettings,
} from "../../src/shared/settings";

declare const __CBPANEL_VERSION__: string | undefined;
declare const __CBPANEL_CLOAKBROWSER_VERSION__: string | undefined;
declare const __CBPANEL_PLAYWRIGHT_CORE_VERSION__: string | undefined;
declare const __CBPANEL_PUPPETEER_CORE_VERSION__: string | undefined;

export type CloakBrowserModule = Pick<typeof import("cloakbrowser"), "binaryInfo" | "ensureBinary" | "clearCache" | "validateLicense">;
// The panel uses empty display values until the SDK has a cached build.
type CloakBinaryInfo = Omit<ReturnType<CloakBrowserModule["binaryInfo"]>, "version" | "binaryPath" | "cacheDir"> & {
  version: string;
  binaryPath: string;
  cacheDir: string;
  tier?: BrowserCoreTier;
  licenseRequired?: boolean;
  licenseValid?: boolean;
};

export type PublicBinaryInfo = CloakBinaryInfo & {
  core: BrowserCoreInfo;
};

/**
 * The channel an operation was aimed at, read from that channel's own settings. It is deliberately not
 * a `PublicBinaryInfo`: the running channel is what launches, what the panel polls, and what every other
 * endpoint describes, so an operation that lands a build somewhere else must not hand its caller a
 * snapshot the caller could install as the global state.
 */
export type BrowserCoreTargetInfo = {
  channel: BrowserCoreChannel;
  channelMode: BrowserCoreChannelMode;
  installed: boolean;
  version?: string;
  cacheDir?: string;
};

type CloakBrowserCliModule = {
  collectDiagnostics: (quick: boolean, proxy?: string) => Promise<Record<string, unknown>>;
};

/** What a `geoip: true` launch through one proxy would resolve. Injected rather than imported so BinaryService keeps knowing nothing about ProxyService — the exit probe lives there, the GeoLite2 cache path lives here. */
export type LaunchGeoResolver = (proxyUrl: string) => Promise<{
  exitIp?: string;
  timezone?: string;
  locale?: string;
  error?: string;
}>;

export type BinaryServiceOptions = {
  dataDir: string;
  portable: boolean;
  readSettings: () => Promise<AppSettings>;
  saveSettings?: (patch: AppSettingsPatch) => Promise<AppSettings>;
  fetchImpl?: typeof fetch;
  loadCloakBrowser?: () => Promise<CloakBrowserModule>;
  loadCloakBrowserDiagnostics?: () => Promise<CloakBrowserCliModule>;
  resolveLaunchGeo?: LaunchGeoResolver;
  readExecutableVersion?: (binaryPath: string) => Promise<string | undefined>;
  removeQuarantine?: (dirPath: string) => Promise<void>;
  // Read at call time, never at construction: BinaryService is built before SessionService, and the
  // prune has to know whether a build is being executed right now. Mirrors how ExtensionService
  // receives activeEnvironmentIds in server/index.ts.
  hasActiveSessions?: () => boolean;
  readPrivateToken?: () => Promise<string | undefined>;
  savePrivateToken?: (token: string) => Promise<void>;
};

const UNSAFE_IMPORT_ARCHIVE = "CloakBrowser import archive contains an unsafe path.";
const CLOAKBROWSER_DEFAULT_BASE_URL = "https://cloakbrowser.dev";
// Deliberately outside the `chromium-<version>[-pro]` shape listManagedCacheCandidates matches, so
// a staging directory is never mistaken for an installed build.
const IMPORT_STAGING_PREFIX = "import-staging-";
// Provenance lives inside the build it describes, not in settings. Every path that removes a build —
// pruneToSingleBuild, clearCache, an import replacing its target — takes this with it, so there is no
// way to be left claiming a local build that is no longer on disk. A settings field would outlive the
// cache and assert exactly that. The name is outside the wrapper's own vocabulary so it cannot be
// mistaken for something upstream reads.
export const PACKAGE_VERSIONS = {
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
  "CLOAKBROWSER_RELEASE_CHANNEL",
] as const;
const BUILTIN_ENV_KEY_SET = new Set<string>(BUILTIN_ENV_KEYS);
// The wrapper caches a successful validation on disk for 24h and falls back to the stale copy when
// the server is unreachable, so this only bounds how often CBPanel asks the wrapper again.
const LICENSE_REFRESH_TTL_MS = 60 * 60 * 1000;

type BrowserCoreTarget = {
  // The cache layout this configuration produces — the cached `cacheTier` derivation, never the
  // reported plan. See licenseDerivation for why the two cannot be one value.
  tier: BrowserCoreTier;
  versionMode: BrowserCoreVersionMode;
  pinnedVersion?: string;
  licenseKey?: string;
  customBinaryPath?: string;
  releaseChannel: BrowserCoreReleaseChannel;
  channel: BrowserCoreChannel;
  channelMode: BrowserCoreChannelMode;
};

// The two things a license decides, kept apart because upstream keys them on different fields of the
// same validation answer.
type BrowserCoreLicenseDerivation = {
  // Which cache layout the current configuration produces. ensureBinary branches on `info.valid`
  // alone (cloakbrowser/dist/download.js), so *any* valid key — a free email key included — is
  // served by ensureProBinary, downloads into `chromium-<version>-pro` and writes the Pro marker.
  cacheTier: BrowserCoreTierMode;
  // Whether upstream drops the version pin: `proVersion = info.plan === "free" ? undefined :
  // requestedVersion`. That plus the welcome banner is all `plan === "free"` changes, so a valid
  // free-plan key is a Pro *layout* with a free *plan*. Reading the plan as the layout filed those
  // imports under `chromium-<version>` where launches never look.
  planIsFree: boolean;
};

type BrowserCoreEnvResolution = {
  value?: string;
  source: BrowserCoreEnvRuntimeValue["source"];
};

const IMPORT_PROVENANCE_FILE = "cbpanel-import.json";

export class BinaryService {
  private readonly fetchImpl: typeof fetch;
  private readonly initialBuiltinEnv = captureEnv(BUILTIN_ENV_KEYS);
  private readonly initialCustomEnv = captureCloakBrowserEnv();
  private readonly appliedCustomEnvKeys = new Set<string>();
  private loadedBuiltinEnv?: Map<string, string | undefined>;
  private loadedCustomEnv?: Map<string, string | undefined>;
  private cloakbrowserModule?: CloakBrowserModule;
  private operation?: BrowserCoreOperation;
  private updateCheck?: BrowserCoreUpdateCheck;
  private updateCheckLoaded = false;
  private exclusiveOperation?: BrowserCoreOperationType;
  private operationAbort?: AbortController;
  // The previous progress sample of the transfer in flight, used to measure its rate.
  private downloadSample?: { at: number; received: number; rate?: number };
  private licenseValidation?: { key: string; at: number; info?: { valid: boolean; plan: string; expires: string | null }; error?: string };
  private licenseValidationInFlight?: { key: string; done: Promise<void> };
  private customBinaryVersion?: { identity: string; value: Promise<string> };
  private lastChannelIdentity?: string;
  // The settings an operation is being run against when it targets a channel other than the active one.
  // Async-scoped rather than an instance field: reads and background polls that arrive while the
  // operation is in flight belong to other request contexts, and an instance field would hand them the
  // target channel's cache, license and env as if it were the running one.
  private readonly targetSettingsScope = new AsyncLocalStorage<AppSettings>();
  private privateConfigurationQueue: Promise<void> = Promise.resolve();
  private configurationRevision = 0;

  constructor(private readonly options: BinaryServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  // Every operation that writes into the managed cache runs alone. Two of them interleaving is
  // destructive, not merely confusing: concurrent imports rm and rename the same target, clearCache
  // wipes the root under a running extraction, and the second finishOperation overwrites the first
  // one's record. The panel disables its buttons, but nothing at the API layer did.
  //
  // Rejecting beats queueing here — the UI already prevents the ordinary case, so a conflict means
  // something unexpected is calling, and waiting minutes behind an install would look like a hang.
  // The guard is per instance, hence per server process; two processes sharing one custom cache
  // directory are still on their own.
  private async runExclusively<T extends { info: PublicBinaryInfo }>(
    type: BrowserCoreOperationType,
    run: () => Promise<T>,
  ): Promise<T> {
    let acquired = false;
    try {
      await this.mutateConfiguration(async () => { this.exclusiveOperation = type; acquired = true; }, () => this.assertPrivateConfigurationMutable());
    } catch (error) {
      if (acquired) this.exclusiveOperation = undefined;
      throw error;
    }
    const abort = new AbortController();
    this.operationAbort = abort;
    let result: T;
    try {
      result = await this.withAbortableFetch(abort.signal, run);
    } catch (error) {
      if (this.operation?.status === "running") this.finishOperation("failed", "CloakBrowser core operation failed.", (error as Error).message);
      if (abort.signal.aborted) {
        // The inner handler already marked the operation failed, with the abort's own message. Say what
        // actually happened instead, and report it as a conflict rather than a fault.
        if (this.operation) {
          this.operation.error = "Cancelled by the operator.";
          this.log("info", "CloakBrowser core operation cancelled.");
        }
        throw Object.assign(new Error("CloakBrowser core operation was cancelled."), {
          status: 409,
          code: "BROWSER_CORE_OPERATION_CANCELLED",
        });
      }
      throw error;
    } finally {
      this.exclusiveOperation = undefined;
      this.operationAbort = undefined;
    }
    // The guard suppresses cache repair for every read, including the operation's own closing one,
    // so the state it captured can say not-installed where a repair was due. Re-read now that the
    // guard is free: a sequential read by the operation that just finished is safe, and the client
    // gates its launch button on this very field.
    return { ...result, info: await this.readPublicInfo() };
  }

  // Wraps globalThis.fetch for the operation's lifetime so a cancel actually stops the work. Upstream's
  // downloads go through bare fetch, which resolves this at call time — the same interception point
  // applyGithubMirrorFetch uses. The signal is *combined*, never replaced: upstream passes its own on the
  // binary download and that is what carries its ten-minute bound.
  private async withAbortableFetch<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    const base = globalThis.fetch;
    globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => base(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, signal]) : signal,
    })) as typeof fetch;
    try {
      return await work();
    } finally {
      // Unwinds only this layer. applyGithubMirrorFetch may have stacked on top during the operation; it
      // re-installs itself on the next cloakbrowser() call, whose guard notices globalThis.fetch moved.
      globalThis.fetch = base;
    }
  }

  // Aborts the in-flight operation's requests rather than just releasing the guard: releasing while
  // upstream keeps writing gives two writers in one cache directory, which is the corruption the guards
  // exist to prevent. The abort makes ensureBinary reject, and runExclusively's own finally releases the
  // guard exactly as it does for any other failure — no second release path.
  cancelOperation(): { cancelled: boolean; operation?: BrowserCoreOperationType } {
    const operation = this.exclusiveOperation;
    if (!operation || !this.operationAbort) return { cancelled: false };
    this.operationAbort.abort(new Error("CloakBrowser core operation cancelled by the operator."));
    return { cancelled: true, operation };
  }

  // The cache-mutating operation in flight, if any. runExclusively guards exactly install, update,
  // import-zip and clear-cache — checkUpdate deliberately is not among them — so this is precisely
  // "the managed cache is being written to right now". Sessions read it before launching: upstream's
  // launch calls ensureBinary itself, and an explicit update unfreezes CLOAKBROWSER_AUTO_UPDATE
  // process-wide, so a launch inside that window can start a second download into the same cache.
  activeCacheOperation(): BrowserCoreOperationType | undefined {
    return this.exclusiveOperation;
  }

  private assertNoActiveSessions(): void {
    if (this.options.hasActiveSessions?.()) throw Object.assign(new Error("Stop all browser sessions before replacing or switching the active CloakBrowser core."), { status: 409, code: "BROWSER_CORE_SESSIONS_RUNNING" });
  }

  private async publishPrivateBuild(input: { root: string; stagingDir: string; executable: string; version: string; mode: BrowserCoreChannelMode; activate: boolean }): Promise<void> {
    const before = normalizeSettings(await this.options.readSettings());
    if (before.binary.coreChannel === "private" || input.activate) this.assertNoActiveSessions();
    this.operationAbort?.signal.throwIfAborted();
    const currentPath = path.join(input.root, "current.json");
    const oldPointer = await fs.readFile(currentPath).catch(() => undefined);
    const targetDir = path.join(input.root, input.version);
    const backupDir = path.join(input.root, `replacing-${randomUUID()}`);
    const hadTarget = await pathExists(targetDir);
    const temporaryPointer = path.join(input.root, `current-${randomUUID()}.json`);
    let published = false;
    let movedOld = false;
    try {
      if (hadTarget) { await fs.rename(targetDir, backupDir); movedOld = true; }
      await fs.rename(input.stagingDir, targetDir);
      published = true;
      const executablePath = path.join(input.version, path.relative(input.stagingDir, input.executable));
      await fs.writeFile(temporaryPointer, `${JSON.stringify({ channel: "private", mode: input.mode, version: input.version, executablePath }, null, 2)}\n`, "utf8");
      this.operationAbort?.signal.throwIfAborted();
      await fs.rename(temporaryPointer, currentPath);
      await this.options.saveSettings?.({ binary: {
        privateReleaseVersion: input.version,
        ...(input.activate ? { coreChannel: "private", coreChannelMode: input.mode } : {}),
        lastUpdateCheck: undefined,
      } });
      this.updateCheck = undefined;
      if (input.activate) await this.applyBrowserCoreEnv();
    } catch (error) {
      if (oldPointer) await fs.writeFile(currentPath, oldPointer);
      else await fs.rm(currentPath, { force: true });
      if (published) await fs.rm(targetDir, { recursive: true, force: true });
      if (movedOld) await fs.rename(backupDir, targetDir);
      throw error;
    } finally { await fs.rm(temporaryPointer, { force: true }).catch(() => undefined); }
    // Cleanup follows publication. A cleanup failure must not turn a valid active build into a failure.
    for (const entry of await fs.readdir(input.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === input.version || entry.name.startsWith("private-staging-") || entry.name.startsWith(IMPORT_STAGING_PREFIX)) continue;
      if (!/^\d+(?:\.\d+){3,4}$/.test(entry.name) && !/^chromium-\d+(?:\.\d+){3,4}-pro$/.test(entry.name) && !entry.name.startsWith("replacing-")) continue;
      await fs.rm(path.join(input.root, entry.name), { recursive: true, force: true }).catch(() => this.log("warn", "Could not remove a superseded private core directory."));
    }
  }

  async readInfo(): Promise<CloakBinaryInfo> {
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const runtime = await this.cloakbrowser();
    if ((target.channel === "private" || target.channelMode === "offline") && !target.customBinaryPath) {
      const root = this.channelCacheRoot(settings);
      const selected = target.channel === "private" ? await this.readPrivateBuild(settings) : await this.readOfficialBuild(settings);
      const baseline = this.sdkBinaryInfo(runtime, undefined, "stable");
      return { ...baseline, version: selected?.version ?? "", platform: runtimePlatformTag(), binaryPath: selected?.executablePath ?? path.join(root, "not-installed", path.basename(managedExecutableRelativePath(runtimePlatformTag()))), cacheDir: selected?.directory ?? root, installed: Boolean(selected), tier: selected ? "pro" : undefined, downloadUrl: "", licenseRequired: target.channel === "official" && !target.licenseKey, licenseValid: target.channel === "official" ? this.validationFor(target.licenseKey)?.info?.valid : undefined };
    }
    const info = await this.withCustomBinaryOverride(this.sdkBinaryInfo(runtime, target.pinnedVersion, target.releaseChannel));
    return {
      ...await this.withManagedCacheProbe(info),
      licenseRequired: target.channel === "official" && !target.customBinaryPath && !target.licenseKey,
      licenseValid: target.channel === "private" || target.customBinaryPath
        ? undefined
        : this.validationFor(target.licenseKey)?.info?.valid,
    };
  }

  async readPublicInfo(): Promise<PublicBinaryInfo> {
    const info = await this.readInfo();
    return {
      ...info,
      core: await this.coreInfo(info),
    };
  }

  // `proxy` mirrors upstream's `info --proxy <url>`: given one, the timezone and locale a launch would
  // apply are resolved live. Without one nothing is resolved and no network call is made, exactly as
  // upstream leaves plain `info`.
  async readWrapperDiagnostics(options: { quick?: boolean; proxy?: string } = {}): Promise<CloakBrowserDiagnostics> {
    const checkedAt = new Date().toISOString();
    try {
      await this.applyBrowserCoreEnv();
      const diagnostics = this.options.loadCloakBrowserDiagnostics
        ? await (await this.options.loadCloakBrowserDiagnostics()).collectDiagnostics(Boolean(options.quick), options.proxy)
        : await this.collectWrapperDiagnostics(Boolean(options.quick), options.proxy);
      return normalizeCloakBrowserDiagnostics(diagnostics, checkedAt);
    } catch (error) {
      return {
        checkedAt,
        available: false,
        error: diagnosticsErrorMessage(error),
      };
    }
  }

  // `targetChannel` lets the panel act on the channel it is showing rather than on whichever one is
  // running. Everything the action touches — license, release channel, cache root — is derived from the
  // target, so the two channels never share a download path. Once the build is in place the target is
  // activated, because an install the operator cannot use is not an install they asked for.
  //
  // `info` always describes the running channel. `target` describes the channel this call was aimed at,
  // which is the only channel whose build the operation changed.
  async install(options: { targetChannel?: BrowserCoreChannel } = {}): Promise<{ binaryPath: string; info: PublicBinaryInfo; target: BrowserCoreTargetInfo; activated: boolean }> {
    const active = normalizeSettings(await this.options.readSettings());
    const channel = options.targetChannel ?? active.binary.coreChannel;
    this.assertChannelOnline(active, channel);
    // A configured or external executable is what launches; a managed install for this channel would
    // download into a cache nothing reads, and the operator's own file is not ours to replace.
    if (this.managedTarget(channelSettings(active, channel, "online")).customBinaryPath) {
      throw Object.assign(new Error(`Disable the custom binary path before installing the ${channel} core.`), { status: 409, code: "BROWSER_CORE_CUSTOM_BINARY_ACTIVE" });
    }
    if (channel === "private") {
      const result = await this.installPrivateRelease(undefined, {}, { activate: true });
      return { binaryPath: result.target.cacheDir ?? "", info: result.info, target: result.target, activated: result.activated };
    }
    const result = await this.withTargetSettings(channelSettings(active, channel, "online"), () =>
      this.runExclusively("install", () => this.installExclusive()));
    const activated = await this.activateTarget(channel, "online");
    return { binaryPath: result.binaryPath, info: await this.readPublicInfo(), target: await this.readTargetInfo(channel, "online"), activated };
  }

  private async installExclusive(): Promise<{ binaryPath: string; info: PublicBinaryInfo }> {
    this.startOperation("install", "preparing", "Installing CloakBrowser Chromium.");
    try {
      await this.refreshLicenseValidation();
      const settings = await this.readManagedSettings();
      const target = this.managedTarget(settings);
      if (!target.customBinaryPath) this.requireLicenseKey(target);
      this.setOperationProgress("checking-cache", "Checking existing CloakBrowser cache.");
      const runtime = await this.cloakbrowser();
      const before = await this.withCustomBinaryOverride(this.sdkBinaryInfo(runtime, target.pinnedVersion, target.releaseChannel));
      if (before.installed) {
        this.setOperationProgress("reusing-cache", "Existing CloakBrowser cache is ready.", 100, 100);
        await this.pruneToSingleBuild(managedBuildDirOf(before.binaryPath, before.platform));
        this.finishOperation("succeeded", "Reused existing CloakBrowser Chromium cache.", before.binaryPath);
        return { binaryPath: before.binaryPath, info: await this.readPublicInfo() };
      }

      const readyBuilds = await this.readyManagedBuildDirs(runtime, before);
      this.setOperationProgress("installing", "Calling cloakbrowser.ensureBinary().");
      const binaryPath = await this.captureCloakbrowserOperationLogs(() => runtime.ensureBinary(target.licenseKey, target.pinnedVersion, target.releaseChannel));
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      // Same derivation the prune below already keyed on, so the provenance clear lands on exactly the
      // directory this download wrote and on no other. Deliberately after the download rather than
      // before: a failed ensureBinary leaves the previous build in place, and its marker with it.
      const downloadedDir = managedBuildDirOf(binaryPath, before.platform);
      if (!readyBuilds.some((directory) => isSameDirectory(directory, downloadedDir))) {
        await this.clearImportProvenance(downloadedDir);
      }
      await this.pruneToSingleBuild(downloadedDir);
      this.finishOperation("succeeded", "Installed CloakBrowser Chromium.", binaryPath);
      return { binaryPath, info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium install failed.", (error as Error).message);
      throw error;
    }
  }

  async update(options: { targetChannel?: BrowserCoreChannel } = {}): Promise<{ version: string | null; info: PublicBinaryInfo; target: BrowserCoreTargetInfo; activated: boolean }> {
    const active = normalizeSettings(await this.options.readSettings());
    const channel = options.targetChannel ?? active.binary.coreChannel;
    this.assertChannelOnline(active, channel);
    if (channel === "private") {
      // The private channel updates by installing the latest VERIFIED release; there is no separate
      // update feed, which is also why the private panel hides the official update controls.
      const result = await this.installPrivateRelease(undefined, {}, { activate: true });
      return { version: result.version, info: result.info, target: result.target, activated: result.activated };
    }
    const result = await this.withTargetSettings(channelSettings(active, channel, "online"), () =>
      this.runExclusively("update", () => this.updateExclusive()));
    const activated = await this.activateTarget(channel, "online");
    return { version: result.version, info: await this.readPublicInfo(), target: await this.readTargetInfo(channel, "online"), activated };
  }

  // Offline suspends the network service of the channel that declared it. Acting on that same channel
  // is what offline forbids; acting on the other one is exactly how the operator leaves that state.
  private assertChannelOnline(settings: AppSettings, channel: BrowserCoreChannel): void {
    if (settings.binary.coreChannel === channel && settings.binary.coreChannelMode === "offline") {
      throw Object.assign(new Error("Offline mode is active; import a package manually or switch to online mode."), { status: 409, code: "BROWSER_CORE_OFFLINE_MODE" });
    }
  }

  // Returns whether the target is the active channel when this finishes. A running session is executing
  // a build from the channel being replaced: the install is allowed to land, switching what launches
  // under it is not, and the caller must not report a switch that did not happen.
  private async activateTarget(channel: BrowserCoreChannel, mode: BrowserCoreChannelMode): Promise<boolean> {
    const active = normalizeSettings(await this.options.readSettings());
    if (active.binary.coreChannel === channel && active.binary.coreChannelMode === mode) return true;
    if (this.options.hasActiveSessions?.()) return false;
    await this.activateChannel(channel, mode);
    return true;
  }

  // What the channel an operation was aimed at now has on disk. The running channel is described by
  // `readPublicInfo` instead: a target snapshot is never a substitute for it, because the target is not
  // what launches and not what every other endpoint reports.
  //
  // Read straight from that channel's build directories rather than through `readInfo`: this runs after
  // the exclusive guard is released, and `readInfo` would load the wrapper and re-apply the managed env
  // for the target channel — a process-wide write that a launch arriving in that window would inherit.
  private async readTargetInfo(channel: BrowserCoreChannel, mode: BrowserCoreChannelMode): Promise<BrowserCoreTargetInfo> {
    const active = normalizeSettings(await this.options.readSettings());
    const settings = channelSettings(active, channel, mode);
    if (channel === "private") {
      const build = await this.readPrivateBuild(settings);
      return { channel, channelMode: mode, installed: Boolean(build), version: build?.version, cacheDir: build?.directory };
    }
    const root = this.channelCacheRoot(settings);
    let prepared: { version?: string } = {};
    try { prepared = JSON.parse(await fs.readFile(path.join(root, "cbpanel-prepared.json"), "utf8")); } catch { /* Optional. */ }
    const candidates = (await listManagedCacheCandidates(root, managedExecutableRelativePath(runtimePlatformTag()))).filter((build) => build.pro);
    // Same selection an activation performs, so "installed" here means "this is the build enabling the
    // channel would launch" — the pin is only a selector in online mode.
    const selected = this.selectOfficialBuild(candidates, mode === "online" ? this.managedTarget(settings).pinnedVersion : undefined, prepared.version);
    return { channel, channelMode: mode, installed: Boolean(selected), version: selected?.version, cacheDir: selected?.directory };
  }

  // Runs an operation against a channel other than the active one. Every consumer of
  // `readManagedSettings` — target derivation, cache root, license, env — then sees the target channel,
  // so nothing has to be threaded through individually.
  //
  // The scope is async-local, so a poll or an unrelated request that arrives while the operation is in
  // flight keeps reading the running channel. The process env is derived from the running settings again
  // afterwards: nothing that launches may observe the target channel's executable or key.
  private async withTargetSettings<T>(settings: AppSettings, run: () => Promise<T>): Promise<T> {
    try {
      return await this.targetSettingsScope.run(settings, run);
    } finally {
      await this.applyBrowserCoreEnv().catch(() => undefined);
    }
  }

  // The managed env follows the settings the current operation runs against. That is required, not
  // incidental: the wrapper's `ensureBinary` returns `CLOAKBROWSER_BINARY_PATH` verbatim when it is set,
  // so an official download aimed at the other channel would hand back the running private executable
  // instead of fetching a build. Launches cannot observe the window — every cache-writing operation holds
  // `exclusiveOperation`, which `assertCanLaunch` refuses — and `withTargetSettings` re-derives the
  // running channel's env in its `finally`.
  private async applyBrowserCoreEnv(): Promise<void> {
    const settings = await this.readManagedSettings();
    const binary = settings.binary;
    const envValues = this.managedEnvValues(settings);
    const target = this.managedTarget(settings);
    const privateExecutable = await this.activeChannelExecutable(settings);
    const officialOfflineExecutable = target.channel === "official" && target.channelMode === "offline" ? (await this.readOfficialBuild(settings))?.executablePath : undefined;
    const desiredBuiltins: Record<(typeof BUILTIN_ENV_KEYS)[number], string | undefined> = {
      CLOAKBROWSER_BINARY_PATH: envValues.binaryPath ?? (target.channel === "private" || target.channelMode === "offline" ? privateExecutable ?? officialOfflineExecutable ?? path.join(this.channelCacheRoot(settings), "not-installed", path.basename(managedExecutableRelativePath(runtimePlatformTag()))) : undefined),
      CLOAKBROWSER_CACHE_DIR:
        this.officialSharedCacheRoot(settings),
      CLOAKBROWSER_DOWNLOAD_URL: undefined,
      CLOAKBROWSER_AUTO_UPDATE: envValues.autoUpdate,
      CLOAKBROWSER_SKIP_CHECKSUM: undefined,
      CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS: envValues.geoipTimeoutSeconds,
      CLOAKBROWSER_VERSION: target.channel === "private" || target.channelMode === "offline" ? undefined : envValues.version,
      CLOAKBROWSER_LICENSE_KEY: target.channel === "private" ? undefined : envValues.licenseKey,
      CLOAKBROWSER_RELEASE_CHANNEL: envValues.releaseChannel,
    };

    for (const [key, value] of Object.entries(desiredBuiltins)) {
      writeProcessEnv(key, value);
    }

    const desiredCustom = new Map(
      binary.customEnvVars
        .filter((item) => !BUILTIN_ENV_KEY_SET.has(item.key))
        .map((item) => [item.key, item.enabled ? envStringValue(item.value) : undefined] as const),
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

  private async updateExclusive(): Promise<{ version: string | null; info: PublicBinaryInfo }> {
    this.startOperation("update", "preparing", "Updating CloakBrowser Chromium.");
    try {
      await this.refreshLicenseValidation();
      const settings = await this.readManagedSettings();
      const target = this.managedTarget(settings);
      if (target.versionMode === "pinned") {
        this.finishOperation("failed", "CloakBrowser Chromium update skipped.", "Pinned browser version is enabled.");
        throw Object.assign(new Error("Pinned browser version is enabled. Change the pinned version or switch back to latest before updating."), { status: 400 });
      }

      const runtime = await this.cloakbrowser();
      let version: string | null = null;
      // The build directory a download actually landed in, when one did. Left undefined by a check that
      // downloaded nothing, so the provenance clear below can never fire on a build this run did not
      // replace.
      let downloadedDir: string | undefined;
      this.requireLicenseKey(target);
      this.setOperationProgress("checking-update", "Checking authenticated CloakBrowser release metadata.");
      const current = await this.withCustomBinaryOverride(this.sdkBinaryInfo(runtime, undefined, target.releaseChannel));
      const latest = await this.latestProChromiumVersion(current.platform, target.releaseChannel);
      // An explicit update aimed at the channel that is not running compares a build nothing launches
      // from. The verdict still goes to the caller and still drives this update, but it does not become
      // the running channel's badge or the stored check — same rule as checkUpdateExclusive.
      const scoped = this.targetSettingsScope.getStore();
      const running = normalizeSettings(await this.options.readSettings());
      const describesRunningChannel = !scoped || scoped.binary.coreChannel === running.binary.coreChannel;
      if (describesRunningChannel) {
        this.updateCheck = {
          checkedAt: new Date().toISOString(),
          targetTier: target.tier,
          versionMode: target.versionMode,
          currentVersion: current.version,
          latestVersion: latest,
          updateAvailable: compareVersions(latest, current.version) > 0,
        };
        await this.persistUpdateCheck();
      }
      if (!current.installed || compareVersions(latest, current.version) > 0) {
        const readyBuilds = await this.readyManagedBuildDirs(runtime, current);
        this.setOperationProgress("installing", `Calling cloakbrowser.ensureBinary() for ${latest}.`);
        const binaryPath = await this.captureCloakbrowserOperationLogs(() => this.runExplicitCloakbrowserUpdate(
          current.platform,
          target.releaseChannel,
          () => runtime.ensureBinary(target.licenseKey, target.pinnedVersion, target.releaseChannel),
        ));
        const refreshed = this.sdkBinaryInfo(runtime, undefined, target.releaseChannel);
        // ensureBinary is a launch helper: network failures may return the old cached build.
        // An explicit update must not turn that fallback into an "up to date" verdict or
        // remove the imported build's provenance.
        if (!refreshed.installed || compareVersions(refreshed.version, latest) < 0 || !isSameDirectory(binaryPath, refreshed.binaryPath)) {
          throw Object.assign(new Error(`CloakBrowser update did not activate ${latest}; the cached build is still ${refreshed.version || "unavailable"}.`), {
            status: 502,
            code: "BROWSER_CORE_UPDATE_INCOMPLETE",
          });
        }
        const resolvedDir = managedBuildDirOf(binaryPath, current.platform);
        if (!readyBuilds.some((directory) => isSameDirectory(directory, resolvedDir))) downloadedDir = resolvedDir;
        version = compareVersions(refreshed.version, current.version) > 0 ? refreshed.version : null;
      }
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      if (downloadedDir) await this.clearImportProvenance(downloadedDir);
      await this.pruneToSingleBuild();
      this.finishOperation("succeeded", version ? `Updated to ${version}.` : "No newer Chromium binary is available.");
      if (describesRunningChannel) await this.markUpdateCheckCurrent(target);
      return { version, info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium update failed.", (error as Error).message);
      throw error;
    }
  }

  private async readyManagedBuildDirs(runtime: CloakBrowserModule, resolved: CloakBinaryInfo): Promise<string[]> {
    const candidates = await listManagedCacheCandidates(this.managedCacheRoot(), managedExecutableRelativePath(resolved.platform));
    const ready = candidates.filter((candidate) => {
      if (!candidate.pro) return false;
      try {
        const info = this.sdkBinaryInfo(runtime, candidate.version);
        return info.installed && isSameDirectory(info.cacheDir, candidate.directory);
      } catch {
        return false;
      }
    }).map((candidate) => candidate.directory);
    // A marker may resolve an imported three-component version that the SDK's pin parser
    // rejects. Its current installed report is still proof that this build is ready.
    if (resolved.installed && resolved.cacheDir) ready.push(resolved.cacheDir);
    return ready;
  }

  // A downloaded build is by definition not an offline import, so a provenance marker sitting in the
  // directory a download just landed in is a leftover — and an active one: the panel badges that build
  // "local" and puts the import guard in front of its next update, both vouching for a build nobody
  // imported. Enumerating the ways one could get there leaves a single shape, the wrapper re-extracting
  // a download over a directory that already holds a marker, which needs the resolved version to equal
  // the imported one *and* the existing build to be broken enough to force a re-download. Rather than
  // argue that shape is unreachable, the download paths make it impossible.
  //
  // Three neighbours deliberately do not call this:
  //
  // - repairCompatibleManagedCache renames an existing build onto the resolved directory, marker and
  //   all. Nothing was downloaded, and the marker still describes the very build it travelled with —
  //   carrying it along is the point of keeping it inside the build directory.
  // - install's cache short circuit reuses the cache without downloading, so the build
  //   still is the imported one and its marker is still true.
  // - An update that activates an already-ready cache keeps that build's provenance too.
  //
  // Best effort. A marker that will not delete is not worth failing an install or update that otherwise
  // landed — the outcome is the stale claim the panel would have shown anyway, not a broken cache.
  private async clearImportProvenance(buildDir: string): Promise<void> {
    try {
      await fs.rm(path.join(buildDir, IMPORT_PROVENANCE_FILE), { force: true });
    } catch {
      this.log("warn", "Could not remove a stale import marker from the downloaded build directory.");
    }
  }

  // A marker left naming a directory that no longer exists is worse than no marker: the wrapper's
  // Pro resolution has no free fallback, so getEffectiveVersion returns null and an offline launch
  // fails outright instead of resolving another cached build. The kept build cannot reach here,
  // so removing these pointers never changes what currently launches.
  //
  // Scoped to the deleted build's own tier. Free and Pro builds of one version coexist by design
  // (chromium-X and chromium-X-pro), so clearing by version alone would destroy the surviving
  // tier's pointer to a build that is still on disk.
  private async clearMarkersNaming(version: string, platform: string, pro: boolean): Promise<string[]> {
    const cacheRoot = this.managedCacheRoot();
    // The wrapper's free resolution also honours a legacy unsuffixed marker.
    const names = pro
      ? [`latest_pro_version_${platform}`, `latest_pro_version_preview_${platform}`]
      : [`latest_version_${platform}`, "latest_version"];
    const cleared: string[] = [];
    for (const name of names) {
      const marker = path.join(cacheRoot, name);
      try {
        if ((await fs.readFile(marker, "utf8")).trim() !== version) continue;
        await fs.rm(marker, { force: true });
        cleared.push(name);
      } catch {
        continue;
      }
    }
    return cleared;
  }

  // The managed cache holds exactly one build. Every retained extra costs a few hundred MB and buys
  // nothing: rollback is not a workflow here, and re-running a version means downloading or importing
  // it again either way.
  //
  // The keeper is what ensureBinary would return, never what binaryInfo reports. binaryInfo derives
  // its tier from disk with no license check (`tier` is `proBinaryReady(...)` in download.js), so with
  // no effective key it keeps naming a stale `chromium-<version>-pro` as the current build — and
  // keying the keeper off it made that build a keeper on every later operation, so "exactly one build"
  // was never reached and the space never came back. The tier therefore comes from the license
  // derivation and the version from the markers the wrapper itself resolves.
  //
  // It is also never info.cacheDir: withCustomBinaryOverride rewrites that to the override binary's own
  // directory, so keying off it would delete the build the operation just installed and keep nothing. A
  // marker naming a pruned build is cleared with it, tier-scoped, or Pro resolution returns null and an
  // offline launch fails outright instead of falling back.
  // `producedDir` is the directory the calling operation just wrote. It is passed in rather than
  // re-derived because the free tier's marker resolution is baseline-clamped: the wrapper only honours
  // a free marker when versionNewer(version, base) (config.js), so importing a build older than the
  // platform's hardcoded baseline resolves to the baseline and re-deriving the keeper would delete the
  // build the import just created. Keeping both the produced and the resolved directory means exactly
  // one survives whenever they agree or one is absent, and in the free-downgrade case the build that
  // actually launches is never the casualty — the operation already reports that the import is inert.
  private async pruneToSingleBuild(producedDir?: string): Promise<string[]> {
    // A running session is executing a build's chrome.exe. fs.rm(recursive) deletes what it can before
    // failing on the locked executable, so a build in use would be left with its executable intact and
    // its resources gone — and the per-candidate catch below swallows that, after which
    // clearMarkersNamingNothing sees the executable and keeps the marker pointed at the wreck. Deferring
    // is coarse (any session, not just one on a superseded build) because a session record does not
    // carry the build it launched from; the next operation with nothing running prunes as normal.
    if (this.options.hasActiveSessions?.()) {
      this.log("info", "Skipped pruning: a browser session is running, so a superseded build may be in use.");
      return [];
    }
    const runtime = await this.cloakbrowser();
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const offlineBuild = target.channel === "official" && target.channelMode === "offline" ? await this.readOfficialBuild(settings) : undefined;
    const reported = offlineBuild
      ? { ...this.sdkBinaryInfo(runtime, undefined, target.releaseChannel), version: offlineBuild.version, cacheDir: offlineBuild.directory, binaryPath: offlineBuild.executablePath, installed: true }
      : this.sdkBinaryInfo(runtime, target.pinnedVersion, target.releaseChannel);
    const reportedPro = reported.tier === "pro" || reported.cacheDir.endsWith("-pro");
    const executable = managedExecutableRelativePath(reported.platform);
    const keeperDir = offlineBuild?.directory ?? await this.launchingBuildDir(target, reported, reportedPro, executable);
    const keepers = keeperDir ? [path.resolve(keeperDir)] : [];
    if (producedDir) keepers.push(path.resolve(producedDir));
    // Keyed on the report, not the keeper: repairCompatibleManagedCache only runs when the *reported*
    // build is missing and renames onto reported.cacheDir, so the shorter-version-string exception
    // below is only needed while that repair is actually pending.
    const repairPending = Boolean(reported.cacheDir) && !(await pathExists(path.join(reported.cacheDir, executable)));
    const candidates = await listManagedCacheCandidates(this.managedCacheRoot(), executable);

    const pruned: string[] = [];
    // Never prune when no keeper is actually on disk. The free marker resolution is baseline-clamped,
    // so a cache left below the baseline by a downgrade import resolves to a directory that does not
    // exist — and a no-op update would then delete the only build there is and report success. If
    // nothing was kept, nothing is superseded.
    const keeperPresent = await keepersOnDisk(keepers, executable);
    if (!keeperPresent) {
      this.log("info", "Skipped pruning: no resolved build is present, so nothing is superseded.");
      return pruned;
    }
    for (const candidate of candidates) {
      if (keepers.some((keeper) => isSameDirectory(candidate.directory, keeper))) continue;
      // The same Chromium build can sit under a shorter version string than the one the wrapper
      // reports (chromium-146.0.7680.177 against ...177.5). repairCompatibleManagedCache renames it
      // onto the resolved directory on the next read, so pruning it while that repair is pending would
      // destroy the build the operation just produced.
      if (repairPending && candidate.pro === reportedPro && versionsShareChromiumBuild(reported.version, candidate.version)) continue;
      try {
        await fs.rm(candidate.directory, { recursive: true, force: true });
        await this.clearMarkersNaming(candidate.version, reported.platform, candidate.pro);
        pruned.push(`${candidate.version}${candidate.pro ? "-pro" : ""}`);
      } catch {
        // A build we could not remove is not worth failing the operation that produced the new one.
        continue;
      }
    }
    if (pruned.length) this.log("info", `Pruned ${pruned.length} superseded build(s): ${pruned.join(", ")}.`);
    const orphaned = await this.clearMarkersNamingNothing(reported.platform);
    if (orphaned.length) this.log("info", `Cleared ${orphaned.length} marker(s) naming a build that is gone: ${orphaned.join(", ")}.`);
    return pruned;
  }

  // The build directory ensureBinary would hand back, resolved for the tier the license derives rather
  // than the tier binaryInfo found on disk. Undefined means nothing is resolvable for that tier — the
  // same null the wrapper's Pro resolution returns — and the caller then leaves the cache alone rather
  // than guessing which build supersedes which.
  private async launchingBuildDir(
    target: BrowserCoreTarget,
    reported: CloakBinaryInfo,
    reportedPro: boolean,
    executable: string,
  ): Promise<string | undefined> {
    const pro = target.tier === "pro";
    // A pin skips resolution in both of the wrapper's paths: getBinaryPath(requestedVersion, pro).
    if (target.pinnedVersion) return this.managedBuildDir(target.pinnedVersion, pro);
    // binaryInfo already resolved this tier, so its answer is used verbatim and the platform's own
    // baseline clamp is honoured without CBPanel restating it (the bundled baseline it reports is not
    // the per-platform one — they differ on macOS).
    if (reportedPro === pro) return reported.cacheDir;
    return this.markerResolvedBuildDir(reported.platform, pro, target.releaseChannel, executable);
  }

  // Mirrors getEffectiveVersion's marker lookup for one tier, for the case binaryInfo answered for the
  // other one. Free also honours the wrapper's legacy unsuffixed marker; Pro is per channel.
  private async markerResolvedBuildDir(
    platform: string,
    pro: boolean,
    releaseChannel: BrowserCoreReleaseChannel,
    executable: string,
  ): Promise<string | undefined> {
    const names = pro
      ? [releaseChannel === "preview" ? `latest_pro_version_preview_${platform}` : `latest_pro_version_${platform}`]
      : [`latest_version_${platform}`, "latest_version"];
    for (const name of names) {
      try {
        const version = (await fs.readFile(path.join(this.managedCacheRoot(), name), "utf8")).trim();
        if (!version) continue;
        const directory = this.managedBuildDir(version, pro);
        if (await pathExists(path.join(directory, executable))) return directory;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  private managedBuildDir(version: string, pro: boolean): string {
    return path.join(this.managedCacheRoot(), `chromium-${version}${pro ? "-pro" : ""}`);
  }

  // Tier-scoped cleanup only clears a marker naming a build this run pruned, so a marker that already
  // pointed at nothing survives it. Pro resolution has no free fallback, so such a pointer makes an
  // offline launch fail outright — worth clearing once the cache is down to its single build.
  private async clearMarkersNamingNothing(platform: string): Promise<string[]> {
    const cacheRoot = this.managedCacheRoot();
    const executable = managedExecutableRelativePath(platform);
    const markers: Array<{ name: string; pro: boolean }> = [
      { name: `latest_version_${platform}`, pro: false },
      { name: "latest_version", pro: false },
      { name: `latest_pro_version_${platform}`, pro: true },
      { name: `latest_pro_version_preview_${platform}`, pro: true },
    ];
    const cleared: string[] = [];
    for (const marker of markers) {
      const markerPath = path.join(cacheRoot, marker.name);
      try {
        const version = (await fs.readFile(markerPath, "utf8")).trim();
        if (!version) continue;
        const directory = path.join(cacheRoot, `chromium-${version}${marker.pro ? "-pro" : ""}`);
        if (await pathExists(path.join(directory, executable))) continue;
        await fs.rm(markerPath, { force: true });
        cleared.push(marker.name);
      } catch {
        continue;
      }
    }
    return cleared;
  }

  async clearCache(options: { targetChannel?: BrowserCoreChannel } = {}): Promise<{ info: PublicBinaryInfo }> {
    // Same hazard as the prune, opposite remedy: this deletes the whole managed cache, and a running
    // session's chrome.exe is locked, so fs.rm strips the resources around a browser that is still
    // executing. The prune defers silently because it is a side effect the user never asked for; a
    // clear is the explicit request, so refuse it loudly instead of reporting success over a
    // half-deleted cache. Same 409 shape as the in-progress guard above.
    if (this.options.hasActiveSessions?.()) {
      throw Object.assign(
        new Error("Cannot clear the CloakBrowser cache while a browser session is running."),
        { status: 409, code: "BROWSER_CORE_SESSIONS_RUNNING" },
      );
    }
    const active = normalizeSettings(await this.options.readSettings());
    const channel = options.targetChannel ?? active.binary.coreChannel;
    return this.runExclusively("clear-cache", () => this.withTargetSettings(channelSettings(active, channel, active.binary.coreChannelMode), () => this.clearCacheExclusive()));
  }

  // Clearing keeps the build that is in use and removes every other build the target channel owns.
  // A channel with no build on disk has nothing to keep, so the clear is a no-op rather than a way to
  // leave the channel pointing at nothing — the wrapper's Pro resolution has no fallback, and an
  // offline launch would fail outright with no cached build.
  //
  // The shared root holds more than binaries — GeoIP/Widevine live there, and the private channel's
  // tree is a sibling of it. Neither is the target's own build, so neither is touched; the wrapper's
  // own clearCache is never called, because it deletes the root wholesale.
  private async clearCacheExclusive(): Promise<{ info: PublicBinaryInfo }> {
    this.startOperation("clear-cache", "clearing", "Clearing CloakBrowser Chromium cache.");
    try {
      this.setOperationProgress("clearing", "Removing managed CloakBrowser cache.");
      const settings = await this.readManagedSettings();
      const channel = settings.binary.coreChannel;
      const removed = channel === "private"
        ? await this.clearPrivateBuilds(settings)
        : await this.clearOfficialBuilds(settings);
      this.log("info", removed.length
        ? `Cleared ${removed.length} superseded ${channel} build(s): ${removed.join(", ")}.`
        : `No superseded ${channel} build was on disk; the build in use is kept.`);
      this.updateCheck = undefined;
      if (this.options.saveSettings) {
        await this.options.saveSettings({ binary: { lastUpdateCheck: undefined } });
      }
      await this.applyBrowserCoreEnv();
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      this.finishOperation("succeeded", "CloakBrowser Chromium cache cleared.");
      return { info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium cache clear failed.", (error as Error).message);
      throw error;
    }
  }

  // Official builds live under the shared root as `chromium-<version>[-pro]`. The keeper is the build an
  // activation would select — the same selection `channelStates` and `activateChannel` use, so a pinned
  // build is never treated as a superseded one — computed before anything is removed.
  private async clearOfficialBuilds(settings: AppSettings): Promise<string[]> {
    const official = channelSettings(settings, "official", "online");
    const root = this.channelCacheRoot(official);
    const executable = managedExecutableRelativePath(runtimePlatformTag());
    let prepared: { version?: string } = {};
    try { prepared = JSON.parse(await fs.readFile(path.join(root, "cbpanel-prepared.json"), "utf8")); } catch { /* Optional. */ }
    const candidates = await listManagedCacheCandidates(root, executable);
    // 0.7 only writes the Pro layout, so a Pro build is the keeper whenever one exists. A legacy cache
    // holding nothing but a free build still has a build in use, and that one is not superseded either.
    const keeper = this.selectOfficialBuild(candidates.filter((build) => build.pro), this.managedTarget(official).pinnedVersion, prepared.version)
      ?? this.selectOfficialBuild(candidates, undefined, prepared.version);
    const removed: string[] = [];
    for (const candidate of candidates) {
      // With no resolvable build there is nothing to keep, and removing everything would be the
      // all-or-nothing clear this deliberately replaces.
      if (!keeper || isSameDirectory(candidate.directory, keeper.directory)) continue;
      try {
        await fs.rm(candidate.directory, { recursive: true, force: true });
        await this.clearMarkersNaming(candidate.version, runtimePlatformTag(), candidate.pro);
        removed.push(`${candidate.version}${candidate.pro ? "-pro" : ""}`);
      } catch {
        // A build we could not remove is not worth failing the clear over.
        continue;
      }
    }
    if (removed.length) await this.clearMarkersNamingNothing(runtimePlatformTag());
    return removed;
  }

  // The private channel keeps one build per release directory under its own root, and its pointer
  // (`current.json`) names the one in use. Anything else there is superseded.
  private async clearPrivateBuilds(settings: AppSettings): Promise<string[]> {
    const root = this.channelCacheRoot({ ...settings, binary: { ...settings.binary, coreChannel: "private" } });
    const keeper = await this.readPrivateBuild({ ...settings, binary: { ...settings.binary, coreChannel: "private" } });
    if (!keeper) return [];
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const removed: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+(?:\.\d+){3,4}$/.test(entry.name) || entry.name === path.basename(keeper.directory)) continue;
      try {
        await fs.rm(path.join(root, entry.name), { recursive: true, force: true });
        removed.push(entry.name);
      } catch {
        continue;
      }
    }
    return removed;
  }

  async readTargetVersion(): Promise<BrowserCoreTargetVersion> {
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const { platform } = await this.readInfo();
    if (target.channelMode === "offline") {
      const current = await this.readInfo();
      return { version: current.version, versionMode: "latest", releaseChannel: target.releaseChannel, platform };
    }
    if (target.channel === "private") {
      const releases = await this.listPrivateReleases();
      const version = releases.releases[0]?.version ?? "";
      return { version, versionMode: "latest", releaseChannel: target.releaseChannel, platform };
    }
    const version = target.versionMode === "pinned" && target.pinnedVersion
      ? target.pinnedVersion
      : await this.latestProChromiumVersion(platform, target.releaseChannel);
    return { version, versionMode: target.versionMode, releaseChannel: target.releaseChannel, platform };
  }

  async listPrivateReleases(repositoryUrl?: string): Promise<{ releases: BrowserCorePrivateRelease[]; platform: string }> {
    const { provider } = await this.privateReleaseSnapshot(repositoryUrl);
    const platform = runtimePlatformTag();
    const releases = await provider.list(platform);
    return { releases, platform };
  }

  private withPrivateConfiguration<T>(run: () => Promise<T>): Promise<T> {
    const result = this.privateConfigurationQueue.then(run);
    this.privateConfigurationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  // Settings, activation and credential publication share this boundary. The epoch changes before
  // any write, including a restore that later rolls back, so work started before it cannot publish.
  private mutateConfiguration<T>(run: () => Promise<T>, validate?: () => void | Promise<void>): Promise<T> {
    return this.withPrivateConfiguration(async () => {
      await validate?.();
      this.configurationRevision += 1;
      this.updateCheckLoaded = true;
      this.updateCheck = undefined;
      const result = await run();
      if (this.options.saveSettings && normalizeSettings(await this.options.readSettings()).binary.lastUpdateCheck) {
        await this.options.saveSettings({ binary: { lastUpdateCheck: undefined } });
      }
      // Polling reads may have reloaded the old persisted verdict while this mutation awaited I/O.
      this.updateCheck = undefined;
      return result;
    });
  }

  async runExternalSettingsMutation<T>(run: () => Promise<T>): Promise<T> {
    return this.mutateConfiguration(run, () => this.assertPrivateConfigurationMutable());
  }

  private assertPrivateConfigurationMutable(): void {
    if (this.exclusiveOperation) throw Object.assign(new Error(`A CloakBrowser core operation (${this.exclusiveOperation}) is already running.`), { status: 409, code: "BROWSER_CORE_OPERATION_IN_PROGRESS" });
  }

  private privateReleaseSnapshot(repositoryUrl?: string, onDownloadProgress?: (received: number, total: number | undefined) => void): Promise<{ settings: AppSettings; provider: PrivateCoreReleaseService }> {
    return this.withPrivateConfiguration(async () => {
      let settings = await this.readManagedSettings();
      if (repositoryUrl !== undefined) settings = { ...settings, binary: { ...settings.binary, privateRepositoryUrl: `https://github.com/${parsePrivateRepositoryUrl(repositoryUrl)}` } };
      this.assertPrivateNetworkAllowed(settings);
      const token = await this.privateToken();
      if (!token) throw Object.assign(new Error("Private GitHub token is not configured."), { status: 401, code: "PRIVATE_TOKEN_REQUIRED" });
      return { settings, provider: new PrivateCoreReleaseService({ token, repositoryUrl: settings.binary.privateRepositoryUrl, fetchImpl: this.fetchImpl, signal: this.operationAbort?.signal, onDownloadProgress }) };
    });
  }

  // Offline is a mode of the *active* channel, not a global network switch. Only a private + offline
  // activation suspends private repository access; an official offline install leaves the private
  // channel free to browse and install, which is the only way to leave that state by switching.
  private assertPrivateNetworkAllowed(settings: AppSettings): void {
    if (settings.binary.coreChannel === "private" && settings.binary.coreChannelMode === "offline") {
      throw Object.assign(new Error("Offline mode disables private release checks."), { status: 409, code: "BROWSER_CORE_OFFLINE_MODE" });
    }
  }

  async testPrivateRepository(): Promise<{ ok: true; platform: string; releases: number }> {
    const result = await this.listPrivateReleases();
    return { ok: true, platform: result.platform, releases: result.releases.length };
  }

  async testPrivateConfiguration(repositoryUrl: string, token?: string): Promise<{ ok: true; configured: boolean; repositoryUrl: string; platform: string; releases: number }> {
    const normalizedUrl = `https://github.com/${parsePrivateRepositoryUrl(repositoryUrl)}`;
    const candidate = await this.withPrivateConfiguration(async () => {
      const settings = normalizeSettings(await this.options.readSettings());
      this.assertPrivateNetworkAllowed(settings);
      return { token: token?.trim() || await this.privateToken(), revision: this.configurationRevision };
    });
    const candidateToken = candidate.token;
    if (!candidateToken) throw Object.assign(new Error("Private GitHub token is not configured."), { status: 401, code: "PRIVATE_TOKEN_REQUIRED" });
    if (candidateToken.length > 1024 || /[\r\n\0]/.test(candidateToken)) throw Object.assign(new Error("The GitHub token has an invalid format."), { status: 400, code: "PRIVATE_TOKEN_INVALID" });
    const platform = runtimePlatformTag();
    const releases = await new PrivateCoreReleaseService({ repositoryUrl: normalizedUrl, token: candidateToken, fetchImpl: this.fetchImpl }).list(platform);
    await this.mutateConfiguration(async () => {
      const previousToken = await this.privateToken();
      const tokenChanged = previousToken !== candidateToken;
      try {
        if (tokenChanged) {
          if (!this.options.savePrivateToken) throw Object.assign(new Error("Private token storage is unavailable in this runtime."), { status: 503, code: "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" });
          await this.options.savePrivateToken(candidateToken);
        }
        await this.options.saveSettings?.({ binary: { privateRepositoryUrl: normalizedUrl, lastUpdateCheck: undefined } });
      } catch (error) {
        if (tokenChanged) await this.options.savePrivateToken?.(previousToken ?? "");
        throw error;
      }
    }, async () => {
      if (candidate.revision !== this.configurationRevision) throw Object.assign(new Error("The private repository configuration changed while it was being tested. Test the connection again."), { status: 409, code: "PRIVATE_CONFIGURATION_CHANGED" });
      this.assertPrivateConfigurationMutable();
      await this.assertSettingsPatchAllowed({ binary: { privateRepositoryUrl: normalizedUrl } });
    });
    return { ok: true, configured: true, repositoryUrl: normalizedUrl, platform, releases: releases.length };
  }

  async savePrivateRepositoryToken(token: string): Promise<{ configured: boolean }> {
    return this.mutateConfiguration(async () => {
      if (!this.options.savePrivateToken) throw Object.assign(new Error("Private token storage is unavailable in this runtime."), { status: 503, code: "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" });
      const normalized = token.trim();
      await this.options.savePrivateToken(normalized);
      return { configured: Boolean(normalized) };
    }, () => this.assertPrivateConfigurationMutable());
  }

  async installPrivateRelease(version?: string, source: { repositoryUrl?: string; releaseId?: number } = {}, options: { activate?: boolean } = {}): Promise<{ version: string; info: PublicBinaryInfo; target: BrowserCoreTargetInfo; release: BrowserCorePrivateRelease; activated: boolean }> {
    const result = await this.runExclusively("install", async () => {
      const { settings, provider } = await this.privateReleaseSnapshot(undefined, (received, total) => this.recordPrivateDownloadProgress(received, total));
      if (source.repositoryUrl !== undefined && parsePrivateRepositoryUrl(source.repositoryUrl).toLowerCase() !== parsePrivateRepositoryUrl(settings.binary.privateRepositoryUrl).toLowerCase()) throw Object.assign(new Error("The private release repository changed. Refresh the version list before installing."), { status: 409, code: "PRIVATE_RELEASE_SOURCE_CHANGED" });
      if (settings.binary.coreChannel === "private") this.assertNoActiveSessions();
      this.startOperation("install", "checking-release", "Checking private CloakBrowser releases.");
      const platform = runtimePlatformTag();
      const releases = await provider.list(platform);
      const release = releases.find((item) => (!version || item.version === version) && (source.releaseId === undefined || item.id === source.releaseId));
      if (!release) throw Object.assign(new Error(version ? `Private VERIFIED release ${version} was not found.` : "No verified private release is available for this platform."), { status: 404, code: "PRIVATE_RELEASE_NOT_FOUND" });
      this.setOperationProgress("downloading", `Downloading private CloakBrowser ${release.version}.`);
      // The private archive is read by this process, so the panel gets the byte count and rate it can
      // actually observe; `download` reports them as the body is read.
      const { bytes, archive, sha256 } = await provider.download(release, platform);
      const root = this.channelCacheRoot({ ...settings, binary: { ...settings.binary, coreChannel: "private" } }, platform);
      const archiveKind = archiveKindFromPath(archive.name);
      await fs.mkdir(root, { recursive: true });
      const stagingDir = await fs.mkdtemp(path.join(root, "private-staging-"));
      const archivePath = path.join(root, `${path.basename(archive.name)}.${process.pid}.${Date.now()}.download`);
      try {
        this.operationAbort?.signal.throwIfAborted();
        await fs.writeFile(archivePath, bytes);
        const embeddedVersion = await readChromeVersionFromArchive(archivePath, bytes, archiveKind, true);
        if (embeddedVersion && !releaseVersionMatches(release.version, embeddedVersion)) throw Object.assign(new Error("The private archive version does not match its verified release title."), { status: 400, code: "PRIVATE_RELEASE_VERSION_MISMATCH" });
        this.setOperationProgress("extracting", "Extracting and validating the private CloakBrowser archive.");
        await writeArchiveEntries(bytes, stagingDir, archiveKind, archivePath);
        await flattenSingleSubdir(stagingDir);
        const executable = await findFile(stagingDir, path.basename(managedExecutableRelativePath(platform)), 5);
        if (!executable) throw Object.assign(new Error("Private release does not contain a Chromium executable."), { status: 400, code: "PRIVATE_RELEASE_EXECUTABLE_MISSING" });
        await fs.chmod(executable, 0o755).catch(() => undefined);
        await (this.options.removeQuarantine ?? removeMacQuarantine)(stagingDir);
        const executableVersion = await (this.options.readExecutableVersion ?? readExecutableVersion)(executable);
        if ((executableVersion && !releaseVersionMatches(release.version, executableVersion)) || (!executableVersion && !embeddedVersion)) throw Object.assign(new Error("The private executable version does not match its verified release title."), { status: 400, code: "PRIVATE_RELEASE_VERSION_MISMATCH" });
        await fs.writeFile(path.join(stagingDir, "cbpanel-build.json"), `${JSON.stringify({ channel: "private", source: "private-github", version: release.version, sha256, fileName: archive.name, releaseId: release.id })}\n`, "utf8");
        await this.publishPrivateBuild({ root, stagingDir, executable, version: release.version, mode: "online", activate: false });
        this.finishOperation("succeeded", `Prepared private CloakBrowser ${release.version}.`);
      } catch (error) {
        this.finishOperation("failed", "Private CloakBrowser installation failed.", (error as Error).message);
        throw error;
      } finally {
        await fs.rm(archivePath, { force: true }).catch(() => undefined);
        await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      }
      return { version: release.version, release, info: await this.readPublicInfo() };
    });
    // Activation happens after the exclusive block: activateChannel takes the same guard, and a nested
    // acquisition would reject against itself. Opt-in rather than always: a direct caller may want the
    // build published without a switch, and only the caller knows whether it asked for one.
    const activated = options.activate ? await this.activateTarget("private", "online") : false;
    // `info` is the running channel, re-read after the activation, so it describes what launches now.
    // The build this call created is reported through `target` instead: when the switch was declined (a
    // session is running) the private build is on disk but nothing launches from it, and folding that
    // snapshot into `info` would describe the running channel as the one it just replaced.
    return { ...result, info: await this.readPublicInfo(), target: await this.readTargetInfo("private", "online"), activated };
  }

  // The panel shows one channel at a time; activating it is what makes the other one stop being used.
  // The build's own cache is left in place, so switching back does not re-download, and `coreChannel`
  // remains the single field that decides what launches.
  async activateChannel(channel: BrowserCoreChannel, mode: BrowserCoreChannelMode, expectedVersion?: string): Promise<{ info: PublicBinaryInfo }> {
    return this.runExclusively("check-update", () => this.withPrivateConfiguration(async () => {
      this.assertNoActiveSessions();
      const current = normalizeSettings(await this.options.readSettings());
      const candidate = { ...current, binary: { ...current.binary, coreChannel: channel, coreChannelMode: mode } };
      const restoringNetwork = channel === current.binary.coreChannel && mode === "online";
      let marker: { file: string; previous?: Buffer; version: string } | undefined;
      let selectedVersion: string | undefined;
      if (channel === "private") {
        const build = await this.readPrivateBuild(candidate);
        selectedVersion = build?.version;
        if (!restoringNetwork && !build) throw Object.assign(new Error("Install a private core before activating the private channel."), { status: 409, code: "PRIVATE_CORE_NOT_INSTALLED" });
      }
      if (channel === "official") {
        const root = this.channelCacheRoot(candidate);
        const candidates = (await listManagedCacheCandidates(root, managedExecutableRelativePath(runtimePlatformTag()))).filter((build) => build.pro);
        const target = this.managedTarget(candidate);
        let prepared: { version?: string } = {};
        try { prepared = JSON.parse(await fs.readFile(path.join(root, "cbpanel-prepared.json"), "utf8")); } catch { /* Corrupted or absent prepared metadata falls back to cached builds. */ }
        // Offline activation suspends the pin, so it is only a selector in online mode — the one place
        // this differs from `channelStates`, which always describes the online configuration.
        const pinnedVersion = mode === "online" ? target.pinnedVersion : undefined;
        const selected = this.selectOfficialBuild(candidates, pinnedVersion, prepared.version);
        if (!selected && !target.customBinaryPath && !restoringNetwork) throw Object.assign(new Error("Prepare an official core before activating the official channel."), { status: 409, code: "BROWSER_CORE_MISSING" });
        if (selected) {
          selectedVersion = selected.version;
          const file = path.join(root, `${target.releaseChannel === "preview" ? "latest_pro_version_preview" : "latest_pro_version"}_${runtimePlatformTag()}`);
          marker = { file, version: selected.version, previous: await fs.readFile(file).catch(() => undefined) };
        }
      }
      if (expectedVersion !== undefined && selectedVersion !== expectedVersion) throw Object.assign(new Error("The prepared browser core changed. Refresh the core status before activating it."), { status: 409, code: "BROWSER_CORE_ACTIVATION_CONTEXT_CHANGED" });
      this.assertNoActiveSessions();
      try {
        if (marker) await fs.writeFile(marker.file, marker.version, "utf8");
        await this.options.saveSettings?.({ binary: { coreChannel: channel, coreChannelMode: mode, lastUpdateCheck: undefined } });
      } catch (error) {
        if (marker?.previous) await fs.writeFile(marker.file, marker.previous); else if (marker) await fs.rm(marker.file, { force: true });
        throw error;
      }
      this.updateCheck = undefined;
      await this.applyBrowserCoreEnv();
      if (channel === "official") await this.pruneToSingleBuild();
      return { info: await this.readPublicInfo() };
    }));
  }

  async checkUpdate(options: { targetChannel?: BrowserCoreChannel } = {}): Promise<{ update: BrowserCoreUpdateCheck; info: PublicBinaryInfo }> {
    const active = normalizeSettings(await this.options.readSettings());
    const channel = options.targetChannel ?? active.binary.coreChannel;
    // The running channel keeps its own mode — an offline channel answers without a network request.
    // A channel that is not running is asked about its online configuration, which is what enabling it
    // would install.
    const mode = active.binary.coreChannel === channel ? active.binary.coreChannelMode : "online";
    const result = await this.withTargetSettings(channelSettings(active, channel, mode), () => this.checkUpdateExclusive());
    // `info` is what the panel installs as its global state, so it always describes the running channel.
    // The verdict for the other channel is returned to the caller and is not the stored badge.
    return { update: result.update, info: await this.readPublicInfo() };
  }

  private async checkUpdateExclusive(): Promise<{ update: BrowserCoreUpdateCheck; info: PublicBinaryInfo }> {
    await this.refreshLicenseValidation();
    const snapshot = await this.withPrivateConfiguration(async () => {
      this.assertPrivateConfigurationMutable();
      const settings = await this.readManagedSettings();
      return { settings, target: this.managedTarget(settings), current: await this.readInfo(), revision: this.configurationRevision, identity: this.updateContextIdentity(settings) };
    });
    const { target, current } = snapshot;
    let update: BrowserCoreUpdateCheck;
    if (target.channelMode === "offline") {
      update = {
        checkedAt: new Date().toISOString(),
        currentVersion: current.version,
        updateAvailable: false,
        blockedReason: "Offline mode is enabled; import a package manually to change the binary.",
      };
    } else if (target.channel === "private") {
      try {
        const releases = await this.listPrivateReleases();
        const latest = releases.releases[0]?.version;
        update = {
          checkedAt: new Date().toISOString(),
          currentVersion: current.version,
          latestVersion: latest,
          updateAvailable: Boolean(latest && compareVersions(latest, current.version) > 0),
        };
      } catch (error) {
        update = {
          checkedAt: new Date().toISOString(),
          currentVersion: current.version,
          updateAvailable: false,
          error: (error as Error).message,
          errorCode: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined,
        };
      }
    } else {
      const checkedAt = new Date().toISOString();
      // A comparison is only as good as the version it starts from. An offline-imported build filed under
      // the other tier than the one this configuration downloads for puts the two sides of that comparison
      // on different feeds — a five-segment Pro version against a four-segment GitHub tag — and
      // compareVersions then rates the local build newer for ever, so "up to date" is reported with total
      // confidence and can never change. Named rather than silently produced: the panel says the baseline
      // is unsound instead of vouching for it.
      const imported = await this.importedBuild(current);
      const baselineCaveat = imported && imported.tier !== target.tier ? "offline-import-tier-mismatch" as const : undefined;
      try {
        this.requireLicenseKey(target);
        const latestVersion = await this.latestProChromiumVersion(current.platform, target.releaseChannel);
        const updateAvailable = Boolean(latestVersion && compareVersions(latestVersion, current.version) > 0);
        update = {
          checkedAt,
          targetTier: target.tier,
          versionMode: target.versionMode,
          currentVersion: current.version,
          latestVersion,
          updateAvailable,
          blockedReason: target.versionMode === "pinned" && updateAvailable
            ? "Pinned browser version is enabled; automatic update will not replace it."
            : undefined,
          baselineCaveat,
        };
      } catch (error) {
        // No caveat here: nothing was compared, and the error already says the check produced no verdict.
        update = {
          checkedAt,
          targetTier: target.tier,
          versionMode: target.versionMode,
          currentVersion: current.version,
          updateAvailable: false,
          error: (error as Error).message,
          errorCode: typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : undefined,
        };
      }
    }
    return this.withPrivateConfiguration(async () => {
      if (snapshot.revision !== this.configurationRevision) throw this.staleUpdateContext();
      const latestSettings = await this.readManagedSettings();
      const latest = await this.readInfo();
      if (snapshot.identity !== this.updateContextIdentity(latestSettings) || current.version !== latest.version || current.binaryPath !== latest.binaryPath) {
        throw this.staleUpdateContext();
      }
      this.updateCheckLoaded = true;
      // Same rule as persistUpdateCheck: only the running channel's answer becomes the panel's badge.
      const target = this.targetSettingsScope.getStore();
      const active = normalizeSettings(await this.options.readSettings());
      if (!target || target.binary.coreChannel === active.binary.coreChannel) this.updateCheck = update;
      await this.persistUpdateCheck();
      return { update, info: await this.readPublicInfo() };
    });
  }

  private updateContextIdentity(settings: AppSettings): string {
    return JSON.stringify({ target: this.managedTarget(settings), cacheRoot: this.channelCacheRoot(settings), repositoryUrl: settings.binary.privateRepositoryUrl });
  }

  private staleUpdateContext(): Error {
    return Object.assign(new Error("The browser core changed while checking for updates. Check again."), { status: 409, code: "BROWSER_CORE_UPDATE_CONTEXT_CHANGED" });
  }

  async analyzeImportZip(
    filePath: string,
    options: { targetTier?: BrowserCoreTier; targetChannel?: BrowserCoreChannel; versionHint?: string } = {},
  ): Promise<BrowserCoreImportAnalysis> {
    const resolvedPath = path.resolve(filePath);
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const targetChannel = options.targetChannel ?? settings.binary.coreChannel;
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
    // Imports target the selected channel's managed cache, even when another channel or a separate executable is active.
    const currentChannelBuild = targetChannel === "private"
      ? await this.readPrivateBuild({ ...settings, binary: { ...settings.binary, coreChannel: "private" } }, platform)
      : await this.readOfficialBuild({ ...settings, binary: { ...settings.binary, coreChannel: "official" } }, platform);
    const currentVersion = targetChannel !== target.channel
      ? currentChannelBuild?.version ?? ""
      : target.customBinaryPath
        ? this.sdkBinaryInfo(await this.cloakbrowser(), target.pinnedVersion, target.releaseChannel).version
        : current.version;
    const discoveredVersion = await readChromeVersionFromArchive(resolvedPath, archiveBytes, archiveKind, targetChannel === "private");
    const versionHint = options.versionHint?.trim() || undefined;
    const completeHint = versionHint && /^\d+(?:\.\d+){4}$/.test(versionHint) && versionHint.split(".").every((part) => Number.isSafeInteger(Number(part))) ? versionHint : undefined;
    const embeddedParts = discoveredVersion?.split(".").length;
    const requiresVersionHint = targetChannel === "private" && embeddedParts === 4;
    const importedVersion = targetChannel === "private"
      ? discoveredVersion && embeddedParts === 5 && (!versionHint || completeHint === discoveredVersion)
        ? discoveredVersion
        : discoveredVersion && embeddedParts === 4 && completeHint && releaseVersionMatches(completeHint, discoveredVersion) ? completeHint : undefined
      : normalizeImportedVersion(discoveredVersion, currentVersion);
    const operation = importOperation(currentVersion, importedVersion, platform === current.platform);
    if (options.targetTier === "free") throw Object.assign(new Error("CloakBrowser 0.7 only supports the authenticated -pro cache layout."), { status: 400 });
    const targetTier = target.tier;
    const targetRoot = targetChannel === "private" ? this.channelCacheRoot({ ...settings, binary: { ...settings.binary, coreChannel: "private" } }, platform) : this.channelCacheRoot({ ...settings, binary: { ...settings.binary, coreChannel: "official" } }, platform);
    const targetCacheDir = importedVersion
      // The managed cache root, not path.dirname(current.cacheDir): an active
      // CLOAKBROWSER_BINARY_PATH rewrites cacheDir to the override binary's own directory, and
      // importing relative to that would extract outside the cache the markers point into.
      ? path.join(targetRoot, targetChannel === "private" ? importedVersion : `chromium-${importedVersion}${targetTier === "pro" ? "-pro" : ""}`)
      : undefined;
    // The install replaces the target directory outright — fs.rm then rename. If a session is
    // executing that build, the rm strips its resources and then fails on the locked executable, so
    // the import leaves the running browser gutted and reports a raw EPERM. Refused during analysis
    // instead, so the dialog says so before the user commits, with the Import button disabled.
    // Gated on the directory already existing: importing a version that is not on disk removes
    // nothing, which is the common case of importing a newer build while browsing.
    const replacesBuildOnDisk = targetCacheDir ? await pathExists(targetCacheDir) : false;
    const sessionsRunning = Boolean(this.options.hasActiveSessions?.()) && (replacesBuildOnDisk || (targetChannel === "private" && settings.binary.coreChannel === "private"));
    const allowed = operation !== "blocked" && !sessionsRunning;

    return {
      filePath: resolvedPath,
      fileName,
      fileSize: stat.size,
      sha256,
      platform,
      targetTier,
      targetChannel,
      versionHint: targetChannel === "private" && importedVersion && completeHint ? completeHint : undefined,
      embeddedVersion: discoveredVersion,
      requiresVersionHint,
      currentVersion,
      importedVersion,
      operation,
      allowed,
      reason: allowed
        ? undefined
        : sessionsRunning
          ? "A browser session is running. Stop it first — importing this version replaces the build it may be using."
          : "Import package platform or version could not be verified.",
      reasonCode: allowed ? undefined : sessionsRunning ? "sessions-running" : "unverified-package",
      targetCacheDir,
    };
  }

  async installImportZip(
    filePath: string,
    options: { targetTier?: BrowserCoreTier; targetChannel?: BrowserCoreChannel; versionHint?: string } = {},
  ): Promise<{ analysis: BrowserCoreImportAnalysis; info: PublicBinaryInfo; pendingActivation?: boolean }> {
    return this.runExclusively("import-zip", () => this.installImportZipExclusive(filePath, options));
  }

  private async installImportZipExclusive(
    filePath: string,
    options: { targetTier?: BrowserCoreTier; targetChannel?: BrowserCoreChannel; versionHint?: string },
  ): Promise<{ analysis: BrowserCoreImportAnalysis; info: PublicBinaryInfo; pendingActivation?: boolean }> {
    const analysis = await this.analyzeImportZip(filePath, options);
    if (!analysis.allowed || !analysis.importedVersion || !analysis.targetCacheDir) {
      // Carries the code as well as the sentence: a direct API caller reads the message, the panel
      // translates the code. Without it a zh-CN user got an English toast for a refusal the dialog
      // was already showing in Chinese.
      throw Object.assign(new Error(analysis.reason ?? "CloakBrowser import package cannot be installed safely."), {
        status: 400,
        code: analysis.reasonCode === "sessions-running"
          ? "BROWSER_CORE_IMPORT_SESSIONS_RUNNING"
          : analysis.reasonCode === "unverified-package"
            ? "BROWSER_CORE_IMPORT_UNVERIFIED"
            : undefined,
      });
    }
    this.startOperation("import-zip", "preparing", `Importing CloakBrowser Chromium ${analysis.importedVersion}.`);
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const targetChannel = analysis.targetChannel ?? settings.binary.coreChannel;
    // Staging lives in the cache root, next to the directory it is renamed onto: a custom cache
    // directory on another volume would make a rename out of dataDir fail with EXDEV.
    const cacheRoot = path.dirname(analysis.targetCacheDir);
    // Unique per run: two imports starting in the same millisecond would otherwise share a staging
    // directory and delete each other's extraction.
    const stagingDir = path.join(cacheRoot, `${IMPORT_STAGING_PREFIX}${process.pid}-${randomUUID()}`);
    try {
      this.setOperationProgress("extracting", "Extracting import archive into a staging directory.");
      await removeStaleImportStagingDirs(cacheRoot, stagingDir);
      await fs.mkdir(stagingDir, { recursive: true });
      await writeArchiveEntries(await fs.readFile(analysis.filePath), stagingDir, archiveKindFromPath(analysis.fileName), analysis.filePath);
      await flattenSingleSubdir(stagingDir);
      this.setOperationProgress("validating", "Validating imported Chromium executable.");
      // The macOS executable is named Chromium inside the app bundle, not chrome — searching for the
      // Linux name there made every macOS import fail as "no Chromium executable".
      const chromePath = await findFile(stagingDir, path.basename(managedExecutableRelativePath(analysis.platform)), 4);
      if (!chromePath) {
        throw Object.assign(new Error("Imported package does not contain a Chromium executable."), { status: 400 });
      }
      await fs.chmod(chromePath, 0o755).catch(() => undefined);
      await (this.options.removeQuarantine ?? removeMacQuarantine)(stagingDir);
      if (targetChannel === "private") {
        const executableVersion = await (this.options.readExecutableVersion ?? readExecutableVersion)(chromePath);
        if (executableVersion && !releaseVersionMatches(analysis.importedVersion, executableVersion)) {
          throw Object.assign(new Error("The private executable version conflicts with the selected build version."), { status: 400, code: "PRIVATE_RELEASE_VERSION_MISMATCH" });
        }
      }
      // Written into the staging directory rather than onto the published build, so the rename below
      // lands the build and its provenance in one step. Writing it afterwards leaves a window — and a
      // crash inside that window — where the build is live and nothing records that it was imported,
      // which is the one state the update guard cannot survive. Both flattenSingleSubdir and the
      // executable search have already run, so this file cannot disturb either.
      await fs.writeFile(
        path.join(stagingDir, IMPORT_PROVENANCE_FILE),
        `${JSON.stringify({
          source: "offline-import",
          channel: targetChannel,
          version: analysis.importedVersion,
          tier: analysis.targetTier,
          fileName: analysis.fileName,
          sha256: analysis.sha256,
          importedAt: new Date().toISOString(),
        }, null, 2)}\n`,
        "utf8",
      );
      this.setOperationProgress("installing", "Moving imported Chromium into the managed cache.");
      if (targetChannel === "private") {
        const shouldActivate = !this.options.hasActiveSessions?.() && !target.customBinaryPath;
        this.operationAbort?.signal.throwIfAborted();
        await this.publishPrivateBuild({ root: cacheRoot, stagingDir, executable: chromePath, version: analysis.importedVersion, mode: "offline", activate: shouldActivate });
        this.finishOperation("succeeded", `Imported private CloakBrowser ${analysis.importedVersion}.`);
        return { analysis, info: await this.readPublicInfo(), pendingActivation: !shouldActivate };
      }
      // Re-asserted here, not just in the analysis: extracting a Chromium archive takes seconds to
      // minutes, and a profile launch is not serialized against core operations, so a session can
      // appear after the analysis found the target free to replace. This is the last instant before
      // the directory stops existing. Still gated on the directory being there — a target that is
      // absent makes the rm below a no-op that can harm nothing.
      if (this.options.hasActiveSessions?.() && await pathExists(analysis.targetCacheDir)) {
        throw Object.assign(
          new Error("A browser session started while the import was extracting, and it may be using the build this import replaces."),
          { status: 409, code: "BROWSER_CORE_SESSIONS_RUNNING" },
        );
      }
      const backupDir = `${analysis.targetCacheDir}.replacing-${randomUUID()}`;
      const hadTarget = await pathExists(analysis.targetCacheDir);
      const shouldActivate = !this.options.hasActiveSessions?.() && !target.customBinaryPath;
      const markerPath = path.join(cacheRoot, `${target.releaseChannel === "preview" ? "latest_pro_version_preview" : "latest_pro_version"}_${analysis.platform}`);
      const previousMarker = await fs.readFile(markerPath).catch(() => undefined);
      const preparedPath = path.join(cacheRoot, "cbpanel-prepared.json");
      const previousPrepared = await fs.readFile(preparedPath).catch(() => undefined);
      let published = false;
      let movedOld = false;
      try {
        this.operationAbort?.signal.throwIfAborted();
        if (hadTarget) { await fs.rename(analysis.targetCacheDir, backupDir); movedOld = true; }
        await fs.rename(stagingDir, analysis.targetCacheDir);
        published = true;
        await fs.writeFile(preparedPath, `${JSON.stringify({ channel: "official", mode: "offline", version: analysis.importedVersion })}\n`, "utf8");
        if (shouldActivate) {
          await fs.writeFile(markerPath, analysis.importedVersion, "utf8");
          await this.options.saveSettings?.({ binary: { coreChannel: "official", coreChannelMode: "offline", lastUpdateCheck: undefined } });
          this.updateCheck = undefined;
        }
      } catch (error) {
        if (previousMarker) await fs.writeFile(markerPath, previousMarker); else await fs.rm(markerPath, { force: true });
        if (previousPrepared) await fs.writeFile(preparedPath, previousPrepared); else await fs.rm(preparedPath, { force: true });
        if (published) await fs.rm(analysis.targetCacheDir, { recursive: true, force: true });
        if (movedOld) await fs.rename(backupDir, analysis.targetCacheDir);
        throw error;
      }
      await fs.rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      // Every import writes the marker. The managed cache holds one build, so there is nothing an
      // import could decline to activate into.
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      if (!shouldActivate && this.options.hasActiveSessions?.()) this.log("info", "Skipped activation and pruning: a browser session is running.");
      if (shouldActivate) {
        await this.applyBrowserCoreEnv();
        await this.pruneToSingleBuild(analysis.targetCacheDir);
      }
      const info = await this.readPublicInfo();
      // An import that lands correctly can still fail to become the build that launches. The override
      // is checked directly because it never changes the reported version — the wrapper ignores the
      // managed cache entirely when it is set. Otherwise compare the resolved build *directory*, not
      // the version: an import filed under the other tier keeps the same version string while a
      // different build launches, so a version comparison alone reports that case as a clean success.
      const override = process.env.CLOAKBROWSER_BINARY_PATH?.trim();
      const effective = override
        ? `Imported, but a custom binary path is active (${override}), so launches use that file instead of the managed cache.`
        : !isSameDirectory(info.cacheDir, analysis.targetCacheDir)
          // Hedged on purpose: the wrapper reports the installed tier from what is on disk, not from
          // a valid license, so a stale Pro build can be reported as current while launches
          // correctly fall through to the free build this import just registered.
          ? `Imported, but the core still resolves ${info.version}${info.tier === "pro" ? " (Pro)" : ""}. Check the import tier, or a version older than the wrapper baseline.`
          : undefined;
      if (effective) this.log("warn", effective);
      this.finishOperation(
        "succeeded",
        `Imported CloakBrowser Chromium ${analysis.importedVersion}.`,
        effective ?? analysis.targetCacheDir,
      );
      return { analysis, info: await this.readPublicInfo(), pendingActivation: !shouldActivate };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      this.finishOperation("failed", "CloakBrowser Chromium import failed.", (error as Error).message);
      throw error;
    }
  }

  // The provenance of the build that actually resolves, or undefined when nothing proves one. A badge
  // and the update guard hang off this, so three things have to hold before it says "imported":
  //
  // - The marker sits in the build directory the wrapper just resolved. Without an override that is
  //   info.cacheDir, and a marker anywhere else describes a build that does not launch — the free
  //   tier's baseline clamp strands a downgrade import in exactly that shape.
  // - Its version names the same Chromium build the wrapper reports. Not the identical string: the marker
  //   lives inside the build, so repairCompatibleManagedCache carries it along with its own build when it
  //   renames one onto info.cacheDir — and it removes the destination first, so a surviving marker cannot
  //   be describing some other build. Containment therefore already rules out the mix-up an exact match
  //   was guarding against, while the exact match cost the badge *and* the update guard in the one case
  //   the repair exists for: the resolved directory name (chromium-146.0.7680.177.5) is longer than the
  //   imported build's own version (146.0.7680.177). Same predicate the repair keys off, so the two agree
  //   on which version strings are one build; a genuinely different build is still refused.
  // - No CLOAKBROWSER_BINARY_PATH override is active. withCustomBinaryOverride rewrites cacheDir to the
  //   override binary's own directory, so the marker cannot be read from there at all, and nothing here
  //   can confirm that the managed build this version names is the file that launches. Saying nothing
  //   beats an unchecked assertion.
  //
  // A missing, unreadable or malformed marker is simply no provenance: this decorates a read that must
  // not start failing because of it.
  private async importedBuild(info: CloakBinaryInfo): Promise<BrowserCoreImportedBuild | undefined> {
    if (!info.installed) return undefined;
    const settings = await this.readManagedSettings();
    if (this.managedTarget(settings).customBinaryPath) return undefined;
    try {
      const raw = await fs.readFile(path.join(info.cacheDir, IMPORT_PROVENANCE_FILE), "utf8");
      return importedBuildFrom(JSON.parse(raw), info.version);
    } catch {
      return undefined;
    }
  }

  private async coreInfo(info: CloakBinaryInfo): Promise<BrowserCoreInfo> {
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    if (!this.updateCheckLoaded) {
      this.updateCheck ??= settings.binary.lastUpdateCheck;
      this.updateCheckLoaded = true;
    }
    const env = this.runtimeEnv(settings);
    const status = info.installed ? "installed" : "not-installed";
    const importedBuild = await this.importedBuild(info);
    // Opportunistic: a read never waits on the license server. The panel is polled, so the derived
    // tier and plan appear on a later read instead of making this one hang when offline. Detached, so
    // it also may never reject — a failed settings read here must not become an unhandled rejection.
    void this.refreshLicenseValidation({ background: true }).catch(() => undefined);
    return {
      channel: target.channel,
      channelMode: target.channelMode,
      status,
      installed: info.installed,
      tier: info.tier,
      targetTier: target.tier,
      // Sent alongside the tier rather than folded into it: the panel has to hide a version pin the
      // free plan cannot honour while still reporting the Pro cache layout that plan downloads into.
      planIsFree: this.licenseDerivation(settings).planIsFree,
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
        playwrightCoreVersion: PACKAGE_VERSIONS.playwrightCore,
      },
      license: this.licenseState(settings, target),
      licensePolicy: target.channel === "private" ? "not-applicable" : "official",
      privateTokenConfigured: Boolean(await this.privateToken().catch(() => undefined)),
      // Both channels' caches, so a gesture can decide whether the channel it is switching to can be
      // activated right now without asking the server first. The official side is read through
      // `readOfficialBuild`, which is what an offline activation would resolve.
      channels: await this.channelStates(settings),
      // Read from the official channel's own configuration rather than from `license` above: with the
      // private channel running, validation is suspended and `license` is the private placeholder, which
      // would tell the official card its key is missing when one is configured.
      officialLicense: this.officialLicenseState(settings),
      env,
      operation: this.operation,
      update: this.updateCheck,
      importedBuild,
      portable: this.options.portable,
      cacheManagedByCBPanel: isCacheManagedByCbpanel(env),
      restartRequired: this.runtimeRestartRequired(),
      detail: info.installed ? undefined : target.channel === "private"
        ? "Private CloakBrowser Chromium is not installed."
        : "CloakBrowser Chromium is not installed.",
    };
  }

  // normalizeSettings plus the one field CBPanel owns rather than the operator: binary.tierMode is
  // the cached copy of the cacheTier derivation, so every consumer keeps reading a single settings
  // field and refreshLicenseValidation is the only writer.
  private async readManagedSettings(): Promise<AppSettings> {
    let settings = this.targetSettingsScope.getStore() ?? normalizeSettings(await this.options.readSettings());
    // Identity tracking describes the running channel's badge, so a scoped read must not feed it: the
    // target channel would look like a channel change and clear the verdict the running channel just
    // stored. The scoped settings themselves are already complete, so nothing here applies to them.
    if (!this.targetSettingsScope.getStore()) {
      const identity = `${settings.binary.coreChannel}:${settings.binary.coreChannelMode}`;
      if (this.lastChannelIdentity && this.lastChannelIdentity !== identity) {
        this.updateCheck = undefined;
        settings = { ...settings, binary: { ...settings.binary, lastUpdateCheck: undefined } };
      }
      this.lastChannelIdentity = identity;
    }
    const tierMode = this.licenseDerivation(settings).cacheTier;
    if (tierMode === settings.binary.tierMode) return settings;
    return { ...settings, binary: { ...settings.binary, tierMode } };
  }

  async assertSettingsPatchAllowed(patch: AppSettingsPatch): Promise<void> {
    if (!patch.binary) return;
    const current = normalizeSettings(await this.options.readSettings()).binary;
    if ((patch.binary.coreChannel !== undefined && patch.binary.coreChannel !== current.coreChannel) || (patch.binary.coreChannelMode !== undefined && patch.binary.coreChannelMode !== current.coreChannelMode)) {
      throw Object.assign(new Error("Use the core activation operation to change the active channel or mode."), { status: 409, code: "BROWSER_CORE_ACTIVATION_REQUIRED" });
    }
    const runtimeFields = ["cacheDirMode", "customCacheDir", "customBinaryPath", "customBinaryPathEnabled", "licenseKey", "browserVersionMode", "pinnedBrowserVersion", "releaseChannel", "customEnvVars", "privateRepositoryUrl", "privateReleaseVersion"] as const;
    const runtimeChanged = runtimeFields.some((key) => patch.binary?.[key] !== undefined && JSON.stringify(patch.binary[key]) !== JSON.stringify(current[key]));
    if (runtimeChanged && this.exclusiveOperation) throw Object.assign(new Error("A core operation is running; wait before changing runtime settings."), { status: 409, code: "BROWSER_CORE_OPERATION_IN_PROGRESS" });
    if (runtimeChanged) this.assertNoActiveSessions();
  }

  async saveSettingsPatch(patch: AppSettingsPatch): Promise<AppSettings> {
    const save = async () => {
      if (!this.options.saveSettings) throw Object.assign(new Error("Settings storage is unavailable."), { status: 503 });
      return this.options.saveSettings(patch.binary ? { ...patch, binary: { ...patch.binary, lastUpdateCheck: undefined } } : patch);
    };
    return patch.binary
      ? this.mutateConfiguration(save, () => this.assertSettingsPatchAllowed(patch))
      : this.withPrivateConfiguration(save);
  }

  // The one place a target is built, so no consumer can read a stale plan derivation. Every call site
  // goes through it — a second construction with a different planIsFree would let the reported version
  // mode and the version actually pinned in process.env disagree.
  private managedTarget(settings: AppSettings): BrowserCoreTarget {
    return this.resolvedTarget(settings, this.licenseDerivation(settings).planIsFree);
  }

  private resolvedTarget(settings: AppSettings, planIsFree: boolean): BrowserCoreTarget {
    const target = browserCoreTarget(settings, this.initialBuiltinEnv, planIsFree);
    if (target.channel === "official" && !target.licenseKey) {
      const root = settings.binary.cacheDirMode === "custom" && settings.binary.customCacheDir ? settings.binary.customCacheDir : this.defaultCacheDir();
      try { target.licenseKey = readFileSync(path.join(root, "license.key"), "utf8").trim() || undefined; } catch { /* No saved key. */ }
    }
    return target;
  }

  private managedEnvValues(settings: AppSettings): ReturnType<typeof browserCoreEnvValues> {
    const values = browserCoreEnvValues(settings, this.initialBuiltinEnv, this.licenseDerivation(settings).planIsFree);
    const key = this.managedTarget(settings).licenseKey;
    return { ...values, licenseKey: key, licenseKeySource: values.licenseKey ? values.licenseKeySource : "cloakbrowser-default" };
  }

  // License validation is scoped to the resolved key; changing keys invalidates the cached verdict.
  private validationFor(key: string | undefined): NonNullable<BinaryService["licenseValidation"]> | undefined {
    const resolved = key?.trim();
    if (!resolved) return undefined;
    return this.licenseValidation?.key === resolved ? this.licenseValidation : undefined;
  }

  private licenseDerivation(settings: AppSettings): BrowserCoreLicenseDerivation {
    if (settings.binary.coreChannel === "private") return { cacheTier: "pro", planIsFree: false };
    // planIsFree only ever changes pinnedVersion / versionMode, and neither is read here, so resolving
    // with the pin left in place breaks what would otherwise be a cycle: the derivation is an input to
    // the target it is derived from.
    const target = this.resolvedTarget(settings, false);
    if (!hasLicenseKeyConfigured(target)) return { cacheTier: "pro", planIsFree: false };
    const validation = this.validationFor(target.licenseKey)?.info;
    if (!validation) return { cacheTier: "pro", planIsFree: false };
    if (!validation.valid) return { cacheTier: "pro", planIsFree: false };
    return { cacheTier: "pro", planIsFree: validation.plan.trim().toLowerCase() === "free" };
  }

  private licenseState(settings: AppSettings, target: BrowserCoreTarget): BrowserCoreLicenseState {
    if (target.channel === "private") {
      return {
        configured: false,
        active: false,
        valid: undefined,
        plan: "private",
      };
    }
    const cached = this.validationFor(target.licenseKey);
    const active = Boolean(target.licenseKey);
    return {
      configured: Boolean(settings.binary.licenseKey.trim()) || active,
      active,
      checkedAt: cached?.at ? new Date(cached.at).toISOString() : undefined,
      valid: cached?.info?.valid,
      plan: cached?.info?.plan,
      expires: cached?.info?.expires ?? undefined,
      error: cached?.error,
    };
  }

  // The official card's key state, read from the official channel's own configuration. Unlike
  // `licenseState` this never consults the running channel, so it still answers while the private
  // channel has validation suspended.
  private officialLicenseState(settings: AppSettings): BrowserCoreOfficialLicenseState {
    const official = channelSettings(settings, "official", settings.binary.coreChannel === "official" ? settings.binary.coreChannelMode : "online");
    const key = this.resolvedTarget(official, false).licenseKey;
    const cached = this.validationFor(key);
    return {
      configured: Boolean(settings.binary.licenseKey.trim()) || Boolean(key),
      valid: cached?.info?.valid,
      plan: cached?.info?.plan,
    };
  }

  private async privateToken(): Promise<string | undefined> {
    const fromOptions = await this.options.readPrivateToken?.();
    const fromEnv = process.env.CBPANEL_PRIVATE_GITHUB_TOKEN?.trim();
    return (fromOptions ?? fromEnv)?.trim() || undefined;
  }

  // Validation is cached by the wrapper for 24h on disk and by this record in memory, and it is
  // resolved through the same module the launches use so a single key/plan answer serves both.
  // It resolves rather than throws because reads and update checks still report the validation state.
  // Install and launch pass the configured key to ensureBinary, whose 0.5.10 contract performs the hard
  // failure for an invalid or unvalidatable key.
  //
  // A background refresh never loads the module and never re-applies the managed env. It runs after
  // the read that scheduled it has already returned, so writing process.env there would land outside
  // that read's control — and applyBrowserCoreEnv has always been the caller's job, not a
  // side effect of reporting a plan.
  private async refreshLicenseValidation(options: { background?: boolean } = {}): Promise<void> {
    const settings = this.targetSettingsScope.getStore() ?? normalizeSettings(await this.options.readSettings());
    if (settings.binary.coreChannel === "private" || settings.binary.coreChannelMode === "offline") return;
    // Resolve the key before deriving its plan, including license.key in the configured cache.
    const key = this.resolvedTarget(settings, false).licenseKey;
    if (!key) {
      this.licenseValidation = undefined;
      return;
    }
    // Keyed on the request: awaiting an in-flight refresh for a key that has since been replaced
    // would report the old key's plan as the new one's.
    if (this.licenseValidationInFlight?.key === key) {
      if (options.background) return;
      await this.licenseValidationInFlight.done;
      return;
    }
    const cached = this.licenseValidation;
    if (cached?.key === key && Date.now() - cached.at < LICENSE_REFRESH_TTL_MS) return;
    const runtime = options.background ? this.cloakbrowserModule : await this.cloakbrowser();
    if (!runtime) return;

    const done = this.validateLicenseKey(key, runtime).finally(() => {
      if (this.licenseValidationInFlight?.key === key) this.licenseValidationInFlight = undefined;
    });
    this.licenseValidationInFlight = { key, done };
    await done;
  }

  private async validateLicenseKey(key: string, runtime: CloakBrowserModule): Promise<void> {
    try {
      const info = await runtime.validateLicense(key);
      this.licenseValidation = info
        ? { key, at: Date.now(), info }
        : { key, at: Date.now(), error: "CloakBrowser license validation is unavailable right now." };
    } catch (error) {
      this.licenseValidation = { key, at: Date.now(), error: (error as Error).message };
    }
    // Outside the try on purpose: a settings-write failure must not overwrite a successful validation
    // with a storage error, which would also drop the tier back to the cached value.
    await this.persistDerivedTierMode().catch(() => undefined);
  }

  private async persistDerivedTierMode(): Promise<void> {
    if (!this.options.saveSettings) return;
    await this.withPrivateConfiguration(async () => {
      const settings = normalizeSettings(await this.options.readSettings());
      const tierMode = this.licenseDerivation(settings).cacheTier;
      if (tierMode === settings.binary.tierMode) return;
      await this.options.saveSettings!({ binary: { tierMode } });
    });
  }

  // One stored check describes one channel. A check aimed at the channel that is not running answers a
  // question about a build nothing launches from, so it is returned to the caller and dropped here —
  // persisting it would make the running channel's badge describe a comparison it never ran.
  private async persistUpdateCheck(): Promise<void> {
    if (!this.updateCheck || !this.options.saveSettings) return;
    const scoped = this.targetSettingsScope.getStore();
    if (scoped) {
      const active = normalizeSettings(await this.options.readSettings());
      if (active.binary.coreChannel !== scoped.binary.coreChannel) return;
    }
    await this.options.saveSettings({
      binary: {
        lastUpdateCheck: this.updateCheck,
      },
    });
  }

  private async markUpdateCheckCurrent(target: BrowserCoreTarget): Promise<void> {
    const current = await this.readInfo();
    this.updateCheckLoaded = true;
    this.updateCheck = {
      checkedAt: new Date().toISOString(),
      targetTier: target.tier,
      versionMode: target.versionMode,
      currentVersion: current.version,
      latestVersion: current.version,
      updateAvailable: false,
    };
    await this.persistUpdateCheck();
  }

  private runtimeEnv(settings: AppSettings): BrowserCoreEnvRuntimeValue[] {
    const binary = settings.binary;
    const values = new Map<string, BrowserCoreEnvRuntimeValue>();
    const cacheDir = this.officialSharedCacheRoot(settings);
    const envValues = this.managedEnvValues(settings);
    const activeBinaryPath = settings.binary.coreChannel === "private" || settings.binary.coreChannelMode === "offline"
      ? process.env.CLOAKBROWSER_BINARY_PATH
      : envValues.binaryPath;

    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_BINARY_PATH",
      value: activeBinaryPath,
      enabled: Boolean(activeBinaryPath),
      source: (settings.binary.coreChannel === "private" || settings.binary.coreChannelMode === "offline") && !envValues.binaryPath ? "cbpanel-default" : envValues.binaryPathSource,
      valueKind: "path",
      detail: activeBinaryPath
        ? settings.binary.coreChannel === "private"
          ? "Private channel executable selected for the active runtime."
          : "Custom binary path bypasses managed binary install/update."
        : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_CACHE_DIR",
      value: cacheDir,
      enabled: true,
      source: binary.cacheDirMode === "custom" ? "settings" : "cbpanel-default",
      valueKind: "directory",
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
      key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
      value: envValues.geoipTimeoutSeconds,
      enabled: Boolean(envValues.geoipTimeoutSeconds),
      source: envValues.geoipTimeoutSecondsSource,
      valueKind: "number",
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_VERSION",
      value: settings.binary.coreChannel === "private" || settings.binary.coreChannelMode === "offline" ? undefined : envValues.version,
      enabled: settings.binary.coreChannel === "official" && settings.binary.coreChannelMode === "online" && Boolean(envValues.version),
      source: envValues.versionSource,
      valueKind: "text",
      detail: envValues.version ? "Pins an exact CloakBrowser Chromium version for launches and binary management." : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_LICENSE_KEY",
      value: settings.binary.coreChannel === "private" ? undefined : envValues.licenseKey,
      enabled: settings.binary.coreChannel === "official" && Boolean(envValues.licenseKey),
      source: envValues.licenseKeySource,
      valueKind: "secret",
      sensitive: true,
      detail: envValues.licenseKey ? "License key for CloakBrowser downloads and sessions." : undefined,
    });
    this.setRuntimeEnv(values, {
      key: "CLOAKBROWSER_RELEASE_CHANNEL",
      value: envValues.releaseChannel,
      enabled: Boolean(envValues.releaseChannel),
      source: envValues.releaseChannelSource,
      valueKind: "text",
      detail: envValues.releaseChannel
        ? "Tracks the newest preview build for this platform, falling back to stable where none exists."
        : undefined,
    });

    // Include supported optional variables and externally supplied/custom variables alike.
    const customRows = new Map(binary.customEnvVars.map((item) => [item.key, item]));
    const optionalKeys = new Set([
      "CLOAKBROWSER_WIDEVINE_CDM",
      "CLOAKBROWSER_WIDEVINE",
      ...this.initialCustomEnv.keys(),
      ...customRows.keys(),
    ]);
    for (const key of optionalKeys) {
      if (values.has(key) || key === "CLOAKBROWSER_DOWNLOAD_URL" || key === "CLOAKBROWSER_SKIP_CHECKSUM") continue;
      const item = customRows.get(key);
      const value = item ? (item.enabled ? envStringValue(item.value) : undefined) : envStringValue(this.initialCustomEnv.get(key));
      this.setRuntimeEnv(values, {
        key,
        value,
        enabled: Boolean(value),
        source: item ? "custom" : value ? "external" : "cloakbrowser-default",
        valueKind: item?.valueKind ?? (key === "CLOAKBROWSER_WIDEVINE_CDM" ? "directory" : key === "CLOAKBROWSER_WIDEVINE" ? "boolean" : "text"),
        sensitive: item?.sensitive,
        detail: item?.description || undefined,
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

  // The one authoritative managed cache root. Deriving it from a resolved binary path instead is
  // how an active CLOAKBROWSER_BINARY_PATH leaked enumeration, deletion and import onto whatever
  // directory happened to be the override's grandparent.
  private managedCacheRoot(): string {
    return process.env.CLOAKBROWSER_CACHE_DIR || this.defaultCacheDir();
  }

  private officialSharedCacheRoot(settings: AppSettings): string {
    return settings.binary.cacheDirMode === "custom" && settings.binary.customCacheDir
      ? settings.binary.customCacheDir
      : this.defaultCacheDir();
  }

  private channelCacheRoot(settings: AppSettings, platform = runtimePlatformTag()): string {
    const base = this.officialSharedCacheRoot(settings);
    if (settings.binary.coreChannel !== "private") return base;
    // A sibling, never a child: upstream clearCache deletes the entire official root recursively.
    const normalized = path.resolve(base);
    if (path.dirname(normalized) === normalized) throw Object.assign(new Error("A filesystem root cannot be used as a browser cache directory."), { status: 400, code: "BROWSER_CORE_CACHE_ROOT_INVALID" });
    return path.join(`${normalized}-private`, platform);
  }

  private async activeChannelExecutable(settings: AppSettings, platform = runtimePlatformTag()): Promise<string | undefined> {
    if (settings.binary.coreChannel !== "private") return undefined;
    return (await this.readPrivateBuild(settings, platform))?.executablePath;
  }

  private async readPrivateBuild(settings: AppSettings, platform = runtimePlatformTag()): Promise<{ executablePath: string; version: string; directory: string; mode?: BrowserCoreChannelMode } | undefined> {
    const root = path.resolve(this.channelCacheRoot(settings, platform));
    try {
      const raw = JSON.parse(await fs.readFile(path.join(root, "current.json"), "utf8")) as { executablePath?: unknown; version?: unknown; mode?: unknown };
      if (typeof raw.version !== "string" || !/^\d+(?:\.\d+){4}$/.test(raw.version)) return undefined;
      const executablePath = typeof raw.executablePath === "string" ? raw.executablePath.trim() : "";
      if (!executablePath || path.isAbsolute(executablePath)) return undefined;
      const resolved = path.resolve(root, executablePath);
      const withinRoot = resolved === root || resolved.startsWith(`${root}${path.sep}`);
      if (!withinRoot || !(await pathExists(resolved))) return undefined;
      const realRoot = await fs.realpath(root);
      const realExecutable = await fs.realpath(resolved);
      if (!realExecutable.startsWith(`${realRoot}${path.sep}`) || !(await fs.stat(realExecutable)).isFile()) return undefined;
      return { executablePath: resolved, version: raw.version, directory: path.join(root, raw.version), mode: raw.mode === "online" || raw.mode === "offline" ? raw.mode : undefined };
    } catch {
      return undefined;
    }
  }

  // What each channel has on disk right now, answered with the same selection an activation performs.
  // "Installed" therefore means "this can be activated now", not merely "a directory exists".
  //
  // The official side is deliberately the *online* selection even when the running channel is offline:
  // a card showing the other channel is always looked at in its online configuration, and that is what
  // enabling it would install. The pin is honoured unconditionally for the same reason — the pin policy
  // is a property of the online official channel, not of whichever mode happens to be running.
  private async channelStates(settings: AppSettings): Promise<BrowserCoreChannelStates> {
    const officialSettings = channelSettings(settings, "official", "online");
    const officialRoot = this.channelCacheRoot(officialSettings);
    const target = this.managedTarget(officialSettings);
    let prepared: { version?: string } = {};
    try { prepared = JSON.parse(await fs.readFile(path.join(officialRoot, "cbpanel-prepared.json"), "utf8")); } catch { /* Optional. */ }
    const candidates = (await listManagedCacheCandidates(officialRoot, managedExecutableRelativePath(runtimePlatformTag()))).filter((build) => build.pro);
    const official = this.selectOfficialBuild(candidates, target.pinnedVersion, prepared.version);
    const privateBuild = await this.readPrivateBuild({ ...settings, binary: { ...settings.binary, coreChannel: "private" } }).catch(() => undefined);
    return {
      official: official ? { installed: true, version: official.version } : { installed: false },
      private: privateBuild ? { installed: true, version: privateBuild.version } : { installed: false },
    };
  }

  // The official build an activation would select: the pinned version, otherwise the prepared one,
  // otherwise the newest. Shared with `activateChannel` so "can this be enabled" and "enable it" cannot
  // disagree about which build that is.
  private selectOfficialBuild<T extends { version: string }>(candidates: T[], pinnedVersion: string | undefined, preparedVersion: string | undefined): T | undefined {
    return candidates.find((build) => build.version === (pinnedVersion ?? preparedVersion))
      ?? (pinnedVersion ? undefined : [...candidates].sort((a, b) => compareVersions(b.version, a.version))[0]);
  }

  private async readOfficialBuild(settings: AppSettings, platform = runtimePlatformTag()): Promise<{ executablePath: string; version: string; directory: string } | undefined> {
    const root = this.channelCacheRoot({ ...settings, binary: { ...settings.binary, coreChannel: "official" } }, platform);
    const executable = managedExecutableRelativePath(platform);
    const candidates = await listManagedCacheCandidates(root, executable);
    let prepared: { version?: string } = {};
    try { prepared = JSON.parse(await fs.readFile(path.join(root, "cbpanel-prepared.json"), "utf8")); } catch { /* Metadata is optional on legacy caches. */ }
    const markerName = this.managedTarget(settings).releaseChannel === "preview" ? "latest_pro_version_preview" : "latest_pro_version";
    const marker = await fs.readFile(path.join(root, `${markerName}_${platform}`), "utf8").catch(() => "");
    const selected = candidates.find((item) => item.version === marker.trim()) ?? candidates.find((item) => item.version === prepared.version) ?? candidates.sort((a, b) => compareVersions(b.version, a.version))[0];
    return selected ? { executablePath: path.join(selected.directory, executable), version: selected.version, directory: selected.directory } : undefined;
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
    return this.cloakbrowserModule;
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

  private async collectWrapperDiagnostics(quick: boolean, proxy?: string): Promise<Record<string, unknown>> {
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const info = await this.readInfo();
    const geoipPath = await this.resolveGeoipDbPath();

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
        path: info.binaryPath,
        installed: info.installed,
        cache_dir: info.cacheDir,
        override: target.customBinaryPath ?? null,
        release_channel: target.releaseChannel,
      },
      launch: await collectBinaryLaunchDiagnostics(info.binaryPath, info.installed, quick),
      license: {
        tier: target.channel === "private" ? "not-applicable" : info.tier ?? target.tier,
      },
      geoip: {
        db_present: await pathExists(geoipPath),
        path: geoipPath,
        // Snake case and the `exit_ip` key are upstream's, not a slip: normalizeCloakBrowserDiagnostics
        // parses the wrapper's own payload too, so both producers have to speak the same shape.
        resolved: proxy ? await this.resolveLaunchGeoForDiagnostics(proxy) : undefined,
      },
      modules: {
        "playwright-core": Boolean(PACKAGE_VERSIONS.playwrightCore),
        "mmdb-lib": true,
      },
    };
  }

  // The GeoLite2 cache the wrapper itself downloads into and reads at launch. Everything that reports
  // on it — the diagnostics row and the launch-geoip resolution — derives the path here, so a change to
  // the cache layout cannot leave one of them pointing somewhere else.
  //
  // Async because managedCacheRoot() reads CLOAKBROWSER_CACHE_DIR, and nothing applies the managed env
  // at boot: a caller that arrives before the first browser-core read would otherwise get the default
  // cache dir while the operator has a custom one configured, and report the database as missing.
  async resolveGeoipDbPath(): Promise<string> {
    await this.applyBrowserCoreEnv();
    return path.join(this.managedCacheRoot(), "geoip", "GeoLite2-City.mmdb");
  }

  // A resolution failure is reported inside the payload, never thrown: the rest of the diagnostics is
  // still worth returning, and upstream's own `catch` writes `{ error }` here for the same reason.
  private async resolveLaunchGeoForDiagnostics(proxy: string): Promise<Record<string, unknown>> {
    if (!this.options.resolveLaunchGeo) {
      return { error: "Launch GeoIP resolution is unavailable in this runtime." };
    }
    try {
      const resolved = await this.options.resolveLaunchGeo(proxy);
      if (resolved.error) return { error: resolved.error };
      return {
        exit_ip: resolved.exitIp ?? null,
        timezone: resolved.timezone ?? null,
        locale: resolved.locale ?? null,
      };
    } catch (error) {
      return { error: diagnosticsErrorMessage(error) };
    }
  }

  private sdkBinaryInfo(runtime: CloakBrowserModule, version?: string, channel?: BrowserCoreReleaseChannel): CloakBinaryInfo {
    const info = runtime.binaryInfo(version, channel);
    return { ...info, version: info.version ?? "", binaryPath: info.binaryPath ?? "", cacheDir: info.cacheDir ?? "", tier: info.installed ? "pro" : undefined };
  }

  private requireLicenseKey(target: BrowserCoreTarget): void {
    if (!target.licenseKey) throw Object.assign(new Error("CloakBrowser license key is required."), { status: 409, code: "BROWSER_CORE_LICENSE_REQUIRED" });
    if (this.validationFor(target.licenseKey)?.info?.valid === false) throw Object.assign(new Error("CloakBrowser license key is invalid or expired."), { status: 409, code: "BROWSER_CORE_LICENSE_INVALID" });
  }

  private async withCustomBinaryOverride(info: CloakBinaryInfo): Promise<CloakBinaryInfo> {
    const customBinaryPath = process.env.CLOAKBROWSER_BINARY_PATH;
    if (!customBinaryPath) return info;
    const installed = await pathExists(customBinaryPath);
    return {
      ...info,
      version: installed ? await this.customExecutableVersion(customBinaryPath) : "",
      binaryPath: customBinaryPath,
      installed,
      cacheDir: path.dirname(customBinaryPath),
      downloadUrl: info.downloadUrl,
    };
  }

  private async customExecutableVersion(binaryPath: string): Promise<string> {
    const stat = await fs.stat(binaryPath).catch(() => undefined);
    if (!stat) return "";
    const identity = `${path.resolve(binaryPath)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    if (this.customBinaryVersion?.identity !== identity) {
      const value = (this.options.readExecutableVersion ?? readExecutableVersion)(binaryPath)
        .then((version) => version?.match(/\b\d+(?:\.\d+){3,4}\b/)?.[0] ?? "")
        .catch(() => "")
        .then((version) => {
          if (!version && this.customBinaryVersion?.identity === identity) this.customBinaryVersion = undefined;
          return version;
        });
      this.customBinaryVersion = { identity, value };
    }
    return this.customBinaryVersion.value;
  }

  private async withManagedCacheProbe(info: CloakBinaryInfo): Promise<CloakBinaryInfo> {
    if (info.installed || !info.binaryPath || !info.cacheDir || process.env.CLOAKBROWSER_BINARY_PATH) return info;
    if (await pathExists(info.binaryPath)) return { ...info, installed: true };
    // The repair renames a cached build onto info.cacheDir, and readInfo() runs on the polled
    // GET /api/browser-core — so without this a plain read could move a build out from under a
    // running import, or a delete that ends in 404 could still have renamed an unrelated one.
    // Reporting the state as it stands is honest; the next read after the operation repairs it.
    if (this.exclusiveOperation) return info;
    // Same reasoning, other concurrency source: the repair renames the build directory, and a session
    // is executing an executable inside one of them. A rename either moves the running browser's files
    // out from under it or throws — and nothing on this path catches, so a throw turns the polled read
    // and sessionService.readBinaryInfo() into a 500 while the session is live. Reporting the
    // unrepaired state is honest; the read after the sessions stop repairs it.
    if (this.options.hasActiveSessions?.()) return info;

    const repaired = await this.repairCompatibleManagedCache(info);
    return repaired ?? info;
  }

  private async repairCompatibleManagedCache(info: CloakBinaryInfo): Promise<CloakBinaryInfo | undefined> {
    const candidates = await listManagedCacheCandidates(this.managedCacheRoot(), managedExecutableRelativePath(info.platform));
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

  private async latestProChromiumVersion(
    platform: string,
    releaseChannel: BrowserCoreReleaseChannel,
  ): Promise<string> {
    // The endpoint is channel-addressed, unlike the version-addressed api/download/<version>.
    // Mirrors the wrapper's own query string so a preview install and a preview update check
    // resolve the same build.
    const versionUrl = releaseChannel === "preview"
      ? `${CLOAKBROWSER_DEFAULT_BASE_URL}/api/download/version?channel=preview`
      : `${CLOAKBROWSER_DEFAULT_BASE_URL}/api/download/version`;
    const response = await this.fetchImpl(versionUrl, {
      headers: { "X-Platform": platform },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`CloakBrowser authenticated version check failed: HTTP ${response.status}`);
    const data = await response.json() as { version?: unknown };
    const version = typeof data.version === "string" ? data.version.trim() : "";
    if (!/^[0-9]+(?:\.[0-9]+){3,4}$/.test(version)) {
      throw new Error("CloakBrowser version response did not include a valid Chromium version.");
    }
    return version;
  }

  private startOperation(type: BrowserCoreOperation["type"], phase: string, message: string): void {
    this.downloadSample = undefined;
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

  // The private archive is read here rather than by the SDK, so its byte count and rate are measured
  // here: the CDN sends a content length, and the delta between reports over the elapsed time is the
  // only speed figure anyone actually observed. A report is a state update, not a log line — the log
  // would otherwise grow by dozens of entries per download. The phase label is the one
  // `setOperationProgress` wrote before the download started; only what the transfer reports is added.
  private recordPrivateDownloadProgress(received: number, total: number | undefined): void {
    if (!this.operation) return;
    const totalBytes = total ?? (this.operation.progress?.totalBytes || undefined);
    this.operation.phase = "downloading";
    this.operation.progress = {
      ...this.operation.progress,
      current: totalBytes ? clampProgress((received / totalBytes) * 100) : undefined,
      total: totalBytes ? 100 : undefined,
      receivedBytes: received,
      totalBytes,
      bytesPerSecond: this.downloadRate(received),
    };
  }

  // The rate is measured between samples at least a quarter second apart. A delta over a shorter window
  // is dominated by chunking noise, and no other figure in this process observed the transfer at all.
  private downloadRate(received: number): number | undefined {
    const now = Date.now();
    const last = this.downloadSample;
    if (!last) {
      this.downloadSample = { at: now, received };
      return undefined;
    }
    const elapsed = now - last.at;
    if (elapsed < 250) return last.rate;
    const rate = received > last.received ? Math.round((received - last.received) / (elapsed / 1000)) : last.rate;
    this.downloadSample = { at: now, received, rate };
    return rate;
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

  private async runExplicitCloakbrowserUpdate<T>(platform: string, channel: BrowserCoreReleaseChannel, work: () => Promise<T>): Promise<T> {
    // The SDK normally caches release metadata for one hour. An explicit update already
    // checked the server, so expire only this channel's timestamp to avoid reusing an old
    // version. Keep the cached value for the SDK's offline fallback, which is checked above.
    const suffix = channel === "preview" ? `preview_${platform}` : platform;
    try {
      await fs.utimes(path.join(this.managedCacheRoot(), `.last_pro_version_check_${suffix}`), 0, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
      const receivedBytes = Number(progress[2]) * 1024 * 1024;
      const totalBytes = Number(progress[3]) * 1024 * 1024;
      this.setOperationProgress("downloading", normalized, percent, 100);
      // The SDK reports whole megabytes and logs one line per ten percent, which is all the rate can be
      // measured from; the sample is taken from those lines, never invented between them.
      if (this.operation) {
        this.operation.progress = {
          ...this.operation.progress,
          current: percent,
          total: 100,
          receivedBytes,
          totalBytes: totalBytes > 0 ? totalBytes : undefined,
          bytesPerSecond: this.downloadRate(receivedBytes),
        };
      }
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
    } else if (/^\[cloakbrowser\] Preview channel requested, but no preview build is available for .+; using the stable build\.$/.test(normalized)) {
      this.log("warn", normalized);
    } else if (/^(?:CloakBrowser - stealth Chromium for automation|https:\/\/github\.com\/CloakHQ\/CloakBrowser|CloakBrowser Pro active \(v\d+\) - latest binary, newest patches\.|Pro support -> support@cloakbrowser\.dev|CloakBrowser free \(v\d+\): the latest binary, 1 concurrent session\.|Running the free binary \(v\d+\)\. The latest binary \(v\d+\) is free too, with 1 concurrent session\.|Get your key: run  cloakbrowser login  or visit https:\/\/cloakbrowser\.dev\/free|For more than one concurrent session -> https:\/\/cloakbrowser\.dev|Star us if CloakBrowser helps your project!)$/.test(normalized)) {
      this.log("info", normalized);
    } else if (/^\[cloakbrowser\] (?:SHA256SUMS signature verified:|Using local binary override:|Cache cleared:|Downloading (?:Pro )?Chromium |Stealth Chromium .* not found\. Downloading|Downloading GeoIP database|GeoIP database ready:|Newer Chromium available:|Background update complete:)/.test(normalized)) {
      // Since 0.6, status output uses stderr to leave stdout clean for JSON/IPC.
      // The stream is not a severity: only known status messages are downgraded.
      this.log("info", normalized);
    } else {
      this.log(level, normalized);
    }
  }

}

function isCacheManagedByCbpanel(env: BrowserCoreEnvRuntimeValue[]): boolean {
  const row = env.find((item) => item.key === "CLOAKBROWSER_CACHE_DIR");
  return row?.source === "cbpanel-default" || row?.source === "settings";
}

function runtimePlatformTag(): string {
  const platform = process.platform;
  const arch = process.arch;
  const osName = platform === "win32" ? "windows" : platform;
  const architecture = arch === "ia32" ? "x86" : arch;
  return `${osName}-${architecture}`;
}

function browserCoreTarget(
  settings: AppSettings,
  initialBuiltinEnv: Map<string, string | undefined>,
  planIsFree: boolean,
): BrowserCoreTarget {
  const binary = settings.binary;
  const customRows = new Map(binary.customEnvVars.map((item) => [item.key, item]));
  const enabledCustom = new Map(binary.customEnvVars.filter((item) => item.enabled).map((item) => [item.key, item]));
  const licenseKeyResolution = resolveOptionalEnvValue(
    "CLOAKBROWSER_LICENSE_KEY",
    customRows,
    enabledCustom,
    settingsLicenseKey(binary),
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
  const pinnedVersion = planIsFree ? undefined : configuredPinnedVersion.value;
  const customBinaryPath = resolveOptionalEnvValue(
    "CLOAKBROWSER_BINARY_PATH",
    customRows,
    enabledCustom,
    binary.customBinaryPathEnabled ? envStringValue(binary.customBinaryPath) : undefined,
    initialBuiltinEnv,
    envStringValue,
  ).value;
  const releaseChannel = resolveOptionalEnvValue(
    "CLOAKBROWSER_RELEASE_CHANNEL",
    customRows,
    enabledCustom,
    releaseChannelEnvValue(binary.releaseChannel),
    initialBuiltinEnv,
    releaseChannelEnvValue,
  ).value;
  return {
    tier: "pro",
    versionMode: binary.coreChannel === "private" || binary.coreChannelMode === "offline" ? "latest" : pinnedVersion ? "pinned" : "latest",
    pinnedVersion: binary.coreChannel === "private" || binary.coreChannelMode === "offline" ? undefined : pinnedVersion,
    licenseKey: binary.coreChannel === "private" ? undefined : licenseKey,
    customBinaryPath,
    releaseChannel: releaseChannel === "preview" ? "preview" : "stable",
    channel: binary.coreChannel,
    channelMode: binary.coreChannelMode,
  };
}

// Whether a licence key is in play at all — not whether it works. Named for what it tests: as
// `usesLicensedDownloads` it read like a guarantee, and two call sites took it as one, routing a key the
// server had rejected down the authenticated path. Only the tier derivation, which goes on to ask about
// validity, should use this.
function hasLicenseKeyConfigured(target: BrowserCoreTarget): boolean {
  return Boolean(target.licenseKey);
}

function browserCoreEnvValues(
  settings: AppSettings,
  initialBuiltinEnv: Map<string, string | undefined>,
  planIsFree: boolean,
): {
  binaryPath: string | undefined;
  binaryPathSource: BrowserCoreEnvRuntimeValue["source"];
  autoUpdate: string;
  autoUpdateSource: BrowserCoreEnvRuntimeValue["source"];
  geoipTimeoutSeconds: string | undefined;
  geoipTimeoutSecondsSource: BrowserCoreEnvRuntimeValue["source"];
  version: string | undefined;
  versionSource: BrowserCoreEnvRuntimeValue["source"];
  licenseKey: string | undefined;
  licenseKeySource: BrowserCoreEnvRuntimeValue["source"];
  releaseChannel: string | undefined;
  releaseChannelSource: BrowserCoreEnvRuntimeValue["source"];
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
  const autoUpdate = "false";
  const geoipRow = custom.get("CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS");
  const geoipTimeoutSeconds = geoipRow
    ? numberEnvValue(geoipRow.value, 12, 1, 60)
    : undefined;
  const licenseKey = resolveOptionalEnvValue(
    "CLOAKBROWSER_LICENSE_KEY",
    customRows,
    custom,
    settingsLicenseKey(binary),
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
  const version = planIsFree
    ? { source: configuredVersion.source }
    : configuredVersion;
  const releaseChannel = resolveOptionalEnvValue(
    "CLOAKBROWSER_RELEASE_CHANNEL",
    customRows,
    custom,
    releaseChannelEnvValue(binary.releaseChannel),
    initialBuiltinEnv,
    releaseChannelEnvValue,
  );

  return {
    binaryPath: binaryPath.value,
    binaryPathSource: binaryPath.source,
    autoUpdate,
    autoUpdateSource: "settings",
    geoipTimeoutSeconds,
    geoipTimeoutSecondsSource: geoipRow ? "custom" : "cloakbrowser-default",
    version: version.value,
    versionSource: version.source,
    licenseKey: licenseKey.value,
    licenseKeySource: licenseKey.source,
    releaseChannel: releaseChannel.value,
    releaseChannelSource: releaseChannel.source,
  };
}

function envStringValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function settingsLicenseKey(binary: AppSettings["binary"]): string | undefined {
  return envStringValue(binary.licenseKey);
}

// Mirrors the wrapper's own normalizeReleaseChannel: anything but "preview" is stable, and stable
// is expressed by leaving the variable unset rather than writing it.
function releaseChannelEnvValue(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() === "preview" ? "preview" : undefined;
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
          resolved: diagnosticsGeoIpResolved(geoip.resolved),
        }
      : undefined,
    fonts: fonts
      ? {
          windows: diagnosticsFontCount(fonts.windows),
          office: diagnosticsFontCount(fonts.office),
          macos: diagnosticsFontCount(fonts.macos),
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

function diagnosticsFontCount(value: unknown): [number, number] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [present, total] = value;
  if (!Number.isSafeInteger(present) || !Number.isSafeInteger(total)
    || present < 0 || total <= 0 || present > total) return undefined;
  return [present, total];
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

// Validates a build's own import marker against the version the wrapper reports for that build. Every
// field is required: a half-written marker cannot be told apart from a hand-edited one, and the badge it
// feeds claims a specific archive on a specific date. `reportedVersion` keeps the marker's location
// meaningful, but same-build rather than same-string: repairCompatibleManagedCache renames a build (marker
// included) onto a longer version's directory name, and the returned `version` is the marker's own — the
// archive's version — which the badge's tooltip names as such. See BinaryService.importedBuild.
function importedBuildFrom(value: unknown, reportedVersion: string): BrowserCoreImportedBuild | undefined {
  const input = objectValue(value);
  if (!input || input.source !== "offline-import") return undefined;
  const version = stringValue(input.version);
  if (!version || !versionsShareChromiumBuild(version, reportedVersion)) return undefined;
  const tier = input.tier === "pro" || input.tier === "free" ? input.tier : undefined;
  const fileName = stringValue(input.fileName);
  const sha256 = stringValue(input.sha256);
  const importedAt = stringValue(input.importedAt);
  if (!tier || !fileName || !sha256 || !importedAt || !Number.isFinite(Date.parse(importedAt))) return undefined;
  return { source: "offline-import", version, tier, fileName, sha256, importedAt };
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
  const limit = nullableNumberValue(sessions.limit);
  const state = diagnosticsSessionState(sessions.state);
  const reason = sessions.reason === null ? null : stringValue(sessions.reason);
  if (active === undefined && limit === undefined && state === undefined && reason === undefined) return undefined;
  return { active, limit, state, reason };
}

function diagnosticsSessionState(value: unknown): CloakBrowserDiagnosticsSessionState | undefined {
  return value === "ok" || value === "unreachable" || value === "denied" || value === "unknown" ? value : undefined;
}

// Upstream writes this key only when the caller passed a proxy, and writes `exit_ip` in snake case like
// the rest of its payload. The key is kept even when every field came back null: upstream does the same
// and prints `(unknown)` for each, so collapsing it would turn "asked and got nothing" into "never
// asked" — and leave an operator who just clicked resolve looking at an unchanged panel.
function diagnosticsGeoIpResolved(value: unknown): CloakBrowserDiagnosticsGeoIpResolved | undefined {
  const resolved = objectValue(value);
  if (!resolved) return undefined;
  return {
    exitIp: stringValue(resolved.exit_ip),
    timezone: stringValue(resolved.timezone),
    locale: stringValue(resolved.locale),
    error: stringValue(resolved.error),
  };
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
  if (process.platform === "win32") {
    const manifest = (await fs.readdir(path.dirname(binaryPath))).find((name) => name.endsWith(".manifest"));
    return { tested: false, reason: `not launched on Windows (it would take a license seat)${manifest ? `; binary ${manifest.slice(0, -".manifest".length)}` : ""}` };
  }

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

function archivePlatformFromName(fileName: string): string | undefined {
  const match = fileName.match(/cloakbrowser-([a-z0-9-]+)\.(?:zip|tar\.gz|tgz)$/i);
  return match?.[1].replace(/^macos-/, "darwin-");
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
  if (!currentVersion) return "install";
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

function releaseVersionMatches(release: string, embedded: string): boolean {
  return embedded.split(".").length === 5 ? embedded === release : embedded.split(".").length === 4 && release.split(".").slice(0, 4).join(".") === embedded;
}

async function readChromeVersionFromArchive(
  filePath: string,
  archiveBytes?: Uint8Array,
  archiveKind = archiveKindFromPath(filePath),
  ignoreOuterPath = false,
): Promise<string | undefined> {
  const pathVersion = ignoreOuterPath ? undefined : versionFromPath(filePath);
  if (pathVersion) return pathVersion;

  const bytes = archiveBytes ?? await fs.readFile(filePath);
  const entryVersion = archiveKind === "zip" ? versionFromZipEntries(bytes) : await versionFromTarEntries(filePath);
  if (entryVersion) return entryVersion;
  if (!archiveKind) return undefined;

  const stagingDir = path.join(path.dirname(filePath), `.cbpanel-version-probe-${Date.now()}`);
  try {
    await fs.mkdir(stagingDir, { recursive: true });
    const executableName = process.platform === "win32" ? "chrome.exe" : process.platform === "darwin" ? "Chromium" : "chrome";
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
  return baseName === "chrome.exe" || baseName === "chrome" || baseName === "chromium";
}

async function removeMacQuarantine(dirPath: string): Promise<void> {
  if (process.platform !== "darwin") return;
  try {
    await execFileAsync("xattr", ["-cr", dirPath], { timeout: 30_000 });
  } catch {
    // Non-fatal: matches upstream download.js removeQuarantine().
  }
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
        { timeout: 15_000, windowsHide: true },
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
    const targetPath = safeJoin(outputDir, normalizedName, UNSAFE_IMPORT_ARCHIVE);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entryBytes);
  }
}

async function extractTarArchive(archivePath: string, outputDir: string): Promise<void> {
  // This filter is the only guard on the tar path, so it resolves each entry and proves containment
  // rather than leaning on tar's own name normalization. It must return false rather than throw:
  // tar calls the filter synchronously from a stream write, so a throw escapes as an uncaught
  // exception instead of rejecting this promise. The refusal is raised afterwards so a tampered
  // archive fails the import outright — half-installing a core is worse than refusing it.
  let unsafeEntry: string | undefined;
  await tar.extract({
    file: archivePath,
    cwd: outputDir,
    filter: (entryPath) => {
      try {
        safeJoin(outputDir, entryPath.replace(/\/+$/, "") || ".", UNSAFE_IMPORT_ARCHIVE);
        return true;
      } catch {
        unsafeEntry ??= entryPath;
        return false;
      }
    },
  });
  if (unsafeEntry !== undefined) {
    throw Object.assign(new Error(UNSAFE_IMPORT_ARCHIVE), { status: 400 });
  }
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

// Import staging is renamed onto its target, so nothing should survive a completed run. A process
// killed between mkdir and rename would otherwise leave a full extracted Chromium behind forever;
// clearing the cache root's leftovers keeps that self-healing. The age floor and the current-run
// exclusion matter: a concurrent import's staging directory is live, and deleting it mid-extraction
// would either strand a half-written build or destroy the version it is replacing. The floor is
// generous because a directory's own mtime stops moving once extraction descends into subdirectories,
// so elapsed time is not a reliable measure of how long an import has been running — and a leftover
// simply waits for a later import instead.
const IMPORT_STAGING_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

async function removeStaleImportStagingDirs(cacheRoot: string, currentStagingDir: string): Promise<void> {
  let entries: Array<import("node:fs").Dirent>;
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const current = path.resolve(currentStagingDir);
  const staleBefore = Date.now() - IMPORT_STAGING_STALE_AFTER_MS;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(IMPORT_STAGING_PREFIX)) continue;
    const directory = path.join(cacheRoot, entry.name);
    if (path.resolve(directory) === current) continue;
    try {
      const stat = await fs.stat(directory);
      if (stat.mtimeMs > staleBefore) continue;
    } catch {
      continue;
    }
    await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
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

async function keepersOnDisk(keepers: string[], executableRelativePath: string): Promise<boolean> {
  for (const keeper of keepers) {
    if (await pathExists(path.join(keeper, executableRelativePath))) return true;
  }
  return false;
}

// The settings one channel's operation runs against. Only the two fields an operation derives its
// target from are overridden: the cache root, the license and the release channel all come from
// `coreChannel`/`coreChannelMode`, so switching those is enough to make the whole derivation point at
// the other channel. Nothing else — the operator's repository, env rows, pins — is touched.
function channelSettings(settings: AppSettings, channel: BrowserCoreChannel, mode: BrowserCoreChannelMode): AppSettings {
  return { ...settings, binary: { ...settings.binary, coreChannel: channel, coreChannelMode: mode } };
}

// The build directory of a resolved executable. Not path.dirname: on macOS the binary is nested at
// Chromium.app/Contents/MacOS/Chromium, so dirname would name a directory three levels inside the
// build rather than the build itself.
function managedBuildDirOf(binaryPath: string, platform: string): string {
  const suffix = path.sep + managedExecutableRelativePath(platform);
  return binaryPath.endsWith(suffix) ? binaryPath.slice(0, -suffix.length) : path.dirname(binaryPath);
}

// Mirrors the wrapper's getBinaryPath. Keyed on the platform the wrapper reports, not the host's
// process.platform: withCustomBinaryOverride leaves info.platform alone, so this stays correct under
// an override, and it keeps the enumeration testable for every platform from any host.
function managedExecutableRelativePath(platform: string): string {
  if (platform.startsWith("darwin")) return path.join("Chromium.app", "Contents", "MacOS", "Chromium");
  return platform.startsWith("windows") ? "chrome.exe" : "chrome";
}

// Windows filesystems are case-insensitive while path.resolve is not, so a cache directory whose
// name differs only in case from the resolved one must still count as the active build — otherwise
// the panel would offer to delete the build actually in use.
function isSameDirectory(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function listManagedCacheCandidates(
  cacheRoot: string,
  executableRelativePath: string,
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
    // 0.6 extracts alongside the destination in .partial-UUID / .stale-UUID
    // directories. They can already contain chrome.exe while another process
    // is still working; never repair, select or prune them as completed builds.
    const match = entry.name.match(/^chromium-([0-9]+(?:\.[0-9]+){2,})(-pro)?$/i);
    if (!match?.[1]) continue;
    const version = match[1];
    const pro = Boolean(match[2]);
    const directory = path.join(cacheRoot, entry.name);
    const binaryPath = path.join(directory, executableRelativePath);
    if (await pathExists(binaryPath)) candidates.push({ directory, version, binaryPath, pro });
  }
  return candidates.sort((left, right) => compareVersions(right.version, left.version));
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
