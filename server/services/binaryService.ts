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
import {
  type CloakBrowserDiagnostics,
  type CloakBrowserDiagnosticsGeoIpResolved,
  type CloakBrowserDiagnosticsLicense,
  type BrowserCoreEnvRuntimeValue,
  type BrowserCoreImportAnalysis,
  type BrowserCoreImportedBuild,
  type BrowserCoreInfo,
  type BrowserCoreLicenseState,
  type BrowserCoreOperation,
  type BrowserCoreOperationLog,
  type BrowserCoreOperationType,
  type BrowserCoreTier,
  type BrowserCoreUpdateCheck,
  type BrowserCoreVersionMode,
  maskEnvValue,
} from "../../src/shared/browserCore";
import { launchGeoUnresolvedReasonFrom, type LaunchGeoUnresolvedReason } from "../../src/shared/launchGeoip";
import {
  type AppSettings,
  type AppSettingsPatch,
  type BrowserCoreReleaseChannel,
  type BrowserCoreTierMode,
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
  collectDiagnostics: (quick: boolean, proxy?: string) => Promise<Record<string, unknown>>;
};

/** What a `geoip: true` launch through one proxy would resolve. Injected rather than imported so BinaryService keeps knowing nothing about ProxyService — the exit probe lives there, the GeoLite2 cache path lives here. */
export type LaunchGeoResolver = (proxyUrl: string) => Promise<{
  exitIp?: string;
  timezone?: string;
  locale?: string;
  /** Why the timezone/locale are empty although the exit IP resolved. Carried through so the panel can explain the common "database not downloaded yet" case. */
  unresolvedReason?: LaunchGeoUnresolvedReason;
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
  // Read at call time, never at construction: BinaryService is built before SessionService, and the
  // prune has to know whether a build is being executed right now. Mirrors how ExtensionService
  // receives activeEnvironmentIds in server/index.ts.
  hasActiveSessions?: () => boolean;
};

const UNSAFE_IMPORT_ARCHIVE = "CloakBrowser import archive contains an unsafe path.";
const GITHUB_API_URL = "https://api.github.com/repos/CloakHQ/cloakbrowser/releases";
const GITHUB_API_FALLBACK_URL = `https://gh-proxy.com/${GITHUB_API_URL}`;
const CLOAKBROWSER_DEFAULT_BASE_URL = "https://cloakbrowser.dev";
// Deliberately outside the `chromium-<version>[-pro]` shape listManagedCacheCandidates matches, so
// a staging directory is never mistaken for an installed build.
const IMPORT_STAGING_PREFIX = "import-staging-";
// Provenance lives inside the build it describes, not in settings. Every path that removes a build —
// pruneToSingleBuild, clearCache, an import replacing its target — takes this with it, so there is no
// way to be left claiming a local build that is no longer on disk. A settings field would outlive the
// cache and assert exactly that. The name is outside the wrapper's own vocabulary so it cannot be
// mistaken for something upstream reads.
const IMPORT_PROVENANCE_FILE = "cbpanel-import.json";
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
  customDownloadBaseUrl?: string;
  releaseChannel: BrowserCoreReleaseChannel;
};

// The two things a license decides, kept apart because upstream keys them on different fields of the
// same validation answer.
type BrowserCoreLicenseDerivation = {
  // Which cache layout the current configuration produces. ensureBinary branches on `info.valid`
  // alone (cloakbrowser/dist/download.js), so *any* valid key — the free GitHub key included — is
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
  private exclusiveOperation?: BrowserCoreOperationType;
  private operationAbort?: AbortController;
  private licenseValidation?: { key: string; at: number; info?: { valid: boolean; plan: string; expires: string | null }; error?: string };
  private licenseValidationInFlight?: { key: string; done: Promise<void> };

  constructor(private readonly options: BinaryServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.githubMirrorProbeService = new GithubMirrorProbeService({ fetchImpl: this.fetchImpl });
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
    if (this.exclusiveOperation) {
      throw Object.assign(
        new Error(`A CloakBrowser core operation (${this.exclusiveOperation}) is already running.`),
        { status: 409, code: "BROWSER_CORE_OPERATION_IN_PROGRESS" },
      );
    }
    this.exclusiveOperation = type;
    const abort = new AbortController();
    this.operationAbort = abort;
    let result: T;
    try {
      result = await this.withAbortableFetch(abort.signal, run);
    } catch (error) {
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

  async readInfo(): Promise<CloakBinaryInfo> {
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
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

  async install(): Promise<{ binaryPath: string; info: PublicBinaryInfo }> {
    return this.runExclusively("install", () => this.installExclusive());
  }

  private async installExclusive(): Promise<{ binaryPath: string; info: PublicBinaryInfo }> {
    this.startOperation("install", "preparing", "Installing CloakBrowser Chromium.");
    try {
      await this.refreshLicenseValidation();
      const settings = await this.readManagedSettings();
      const target = this.managedTarget(settings);
      this.setOperationProgress("checking-cache", "Checking existing CloakBrowser cache.");
      const runtime = await this.cloakbrowser();
      const before = await this.withCustomBinaryOverride(await runtime.binaryInfo(target.pinnedVersion));
      if (settings.binary.preferExistingCache && before.installed) {
        this.setOperationProgress("reusing-cache", "Existing CloakBrowser cache is ready.", 100, 100);
        await this.pruneToSingleBuild(managedBuildDirOf(before.binaryPath, before.platform));
        this.finishOperation("succeeded", "Reused existing CloakBrowser Chromium cache.", before.binaryPath);
        return { binaryPath: before.binaryPath, info: await this.readPublicInfo() };
      }

      this.setOperationProgress("installing", "Calling cloakbrowser.ensureBinary().");
      const binaryPath = await this.captureCloakbrowserOperationLogs(() => runtime.ensureBinary(target.licenseKey, target.pinnedVersion));
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      // Same derivation the prune below already keyed on, so the provenance clear lands on exactly the
      // directory this download wrote and on no other. Deliberately after the download rather than
      // before: a failed ensureBinary leaves the previous build in place, and its marker with it.
      const downloadedDir = managedBuildDirOf(binaryPath, before.platform);
      await this.clearImportProvenance(downloadedDir);
      await this.pruneToSingleBuild(downloadedDir);
      this.finishOperation("succeeded", "Installed CloakBrowser Chromium.", binaryPath);
      return { binaryPath, info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium install failed.", (error as Error).message);
      throw error;
    }
  }

  async update(): Promise<{ version: string | null; info: PublicBinaryInfo }> {
    return this.runExclusively("update", () => this.updateExclusive());
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
      if (this.licensedDownloads(settings)) {
        this.setOperationProgress("checking-update", "Checking authenticated CloakBrowser release metadata.");
        const current = await this.withCustomBinaryOverride(await runtime.binaryInfo(target.pinnedVersion));
        const latest = await this.latestProChromiumVersion(current.platform, target.releaseChannel);
        if (latest && compareVersions(latest, current.version) > 0) {
          this.setOperationProgress("installing", `Calling cloakbrowser.ensureBinary() for ${latest}.`);
          const binaryPath = await this.captureCloakbrowserOperationLogs(() => this.runExplicitCloakbrowserUpdate(
            () => runtime.ensureBinary(target.licenseKey, target.tier === "pro" ? latest : undefined),
          ));
          // Keyed off what ensureBinary handed back, not off `version` below: that one stays null when the
          // refreshed report is not newer, while the download still wrote a build here.
          downloadedDir = managedBuildDirOf(binaryPath, current.platform);
          const refreshedVersion = (await this.withCustomBinaryOverride(await runtime.binaryInfo())).version;
          version = compareVersions(refreshedVersion, current.version) > 0 ? refreshedVersion : null;
        }
      } else {
        this.setOperationProgress("checking-update", "Checking CloakBrowser release metadata.");
        version = await this.captureCloakbrowserOperationLogs(() => runtime.checkForUpdate());
        // checkForUpdate both checks and installs, and answers null when the cache was already current —
        // so a null means no build changed hands and there is nothing whose provenance this run
        // invalidated. Only a version says a build was downloaded, and the wrapper then resolves the
        // directory it landed in, which is the same cacheDir importedBuild reads the marker from. Taken
        // raw rather than through withCustomBinaryOverride: that rewrites cacheDir to the override
        // binary's own directory, which is not a managed build at all.
        if (version) downloadedDir = (await runtime.binaryInfo()).cacheDir;
      }
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      if (downloadedDir) await this.clearImportProvenance(downloadedDir);
      await this.pruneToSingleBuild();
      this.finishOperation("succeeded", version ? `Updated to ${version}.` : "No newer Chromium binary is available.");
      await this.markUpdateCheckCurrent(target);
      return { version, info: await this.readPublicInfo() };
    } catch (error) {
      this.finishOperation("failed", "CloakBrowser Chromium update failed.", (error as Error).message);
      throw error;
    }
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
  // - install's preferExistingCache short circuit reuses the cache without downloading, so the build
  //   still is the imported one and its marker is still true.
  // - update's checkForUpdate branch only reaches this once the wrapper returned a version. A null is
  //   "already current": it checked, downloaded nothing, and replaced no build.
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
    const reported = runtime.binaryInfo(target.pinnedVersion);
    const reportedPro = reported.tier === "pro" || reported.cacheDir.endsWith("-pro");
    const executable = managedExecutableRelativePath(reported.platform);
    const keeperDir = await this.launchingBuildDir(target, reported, reportedPro, executable);
    const keepers = keeperDir ? [path.resolve(keeperDir)] : [];
    if (producedDir) keepers.push(path.resolve(producedDir));
    // Keyed on the report, not the keeper: repairCompatibleManagedCache only runs when the *reported*
    // build is missing and renames onto reported.cacheDir, so the shorter-version-string exception
    // below is only needed while that repair is actually pending.
    const repairPending = !(await pathExists(path.join(reported.cacheDir, executable)));
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

  async clearCache(): Promise<{ info: PublicBinaryInfo }> {
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
    return this.runExclusively("clear-cache", () => this.clearCacheExclusive());
  }

  private async clearCacheExclusive(): Promise<{ info: PublicBinaryInfo }> {
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
    await this.refreshLicenseValidation();
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    const current = await this.readInfo();
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
      const latestVersion = this.licensedDownloads(settings)
        ? await this.latestProChromiumVersion(current.platform, target.releaseChannel)
        : await this.latestChromiumVersion(current.platform);
      const updateAvailable = Boolean(latestVersion && compareVersions(latestVersion, current.version) > 0);
      this.updateCheck = {
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
    options: { targetTier?: BrowserCoreTier } = {},
  ): Promise<BrowserCoreImportAnalysis> {
    const resolvedPath = path.resolve(filePath);
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
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
    const targetTier = options.targetTier ?? target.tier;
    const targetCacheDir = importedVersion
      // The managed cache root, not path.dirname(current.cacheDir): an active
      // CLOAKBROWSER_BINARY_PATH rewrites cacheDir to the override binary's own directory, and
      // importing relative to that would extract outside the cache the markers point into.
      ? path.join(this.managedCacheRoot(), `chromium-${importedVersion}${targetTier === "pro" ? "-pro" : ""}`)
      : undefined;
    // The install replaces the target directory outright — fs.rm then rename. If a session is
    // executing that build, the rm strips its resources and then fails on the locked executable, so
    // the import leaves the running browser gutted and reports a raw EPERM. Refused during analysis
    // instead, so the dialog says so before the user commits, with the Import button disabled.
    // Gated on the directory already existing: importing a version that is not on disk removes
    // nothing, which is the common case of importing a newer build while browsing.
    const replacesBuildOnDisk = targetCacheDir ? await pathExists(targetCacheDir) : false;
    const sessionsRunning = replacesBuildOnDisk && Boolean(this.options.hasActiveSessions?.());
    const allowed = operation !== "blocked" && !sessionsRunning;

    return {
      filePath: resolvedPath,
      fileName,
      fileSize: stat.size,
      sha256,
      platform,
      targetTier,
      currentVersion: current.version,
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
    options: { targetTier?: BrowserCoreTier } = {},
  ): Promise<{ analysis: BrowserCoreImportAnalysis; info: PublicBinaryInfo }> {
    return this.runExclusively("import-zip", () => this.installImportZipExclusive(filePath, options));
  }

  private async installImportZipExclusive(
    filePath: string,
    options: { targetTier?: BrowserCoreTier },
  ): Promise<{ analysis: BrowserCoreImportAnalysis; info: PublicBinaryInfo }> {
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
      // Written into the staging directory rather than onto the published build, so the rename below
      // lands the build and its provenance in one step. Writing it afterwards leaves a window — and a
      // crash inside that window — where the build is live and nothing records that it was imported,
      // which is the one state the update guard cannot survive. Both flattenSingleSubdir and the
      // executable search have already run, so this file cannot disturb either.
      await fs.writeFile(
        path.join(stagingDir, IMPORT_PROVENANCE_FILE),
        `${JSON.stringify({
          source: "offline-import",
          version: analysis.importedVersion,
          tier: analysis.targetTier,
          fileName: analysis.fileName,
          sha256: analysis.sha256,
          importedAt: new Date().toISOString(),
        } satisfies BrowserCoreImportedBuild, null, 2)}\n`,
        "utf8",
      );
      this.setOperationProgress("installing", "Moving imported Chromium into the managed cache.");
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
      await fs.rm(analysis.targetCacheDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(analysis.targetCacheDir), { recursive: true });
      await fs.rename(stagingDir, analysis.targetCacheDir);
      // Every import writes the marker. The managed cache holds one build, so there is nothing an
      // import could decline to activate into.
      if (analysis.targetTier === "pro") {
        await this.writeProVersionMarker(analysis.importedVersion, analysis.platform, target.releaseChannel);
      } else {
        await this.writeVersionMarker(analysis.importedVersion, analysis.platform);
      }
      this.setOperationProgress("finalizing", "Refreshing browser core state.", 100, 100);
      await this.pruneToSingleBuild(analysis.targetCacheDir);
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
      return { analysis, info: await this.readPublicInfo() };
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
    if (!info.installed || process.env.CLOAKBROWSER_BINARY_PATH?.trim()) return undefined;
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
    this.updateCheck ??= settings.binary.lastUpdateCheck;
    const env = this.runtimeEnv(settings);
    const status = info.installed ? "installed" : "not-installed";
    const importedBuild = await this.importedBuild(info);
    // Opportunistic: a read never waits on the license server. The panel is polled, so the derived
    // tier and plan appear on a later read instead of making this one hang when offline. Detached, so
    // it also may never reject — a failed settings read here must not become an unhandled rejection.
    void this.refreshLicenseValidation({ background: true }).catch(() => undefined);
    return {
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
        baselineChromiumVersion: info.bundledVersion ?? info.version,
        playwrightCoreVersion: PACKAGE_VERSIONS.playwrightCore,
        puppeteerCoreVersion: PACKAGE_VERSIONS.puppeteerCore,
      },
      license: this.licenseState(settings, target),
      env,
      operation: this.operation,
      update: this.updateCheck,
      importedBuild,
      portable: this.options.portable,
      cacheManagedByCbpanel: isCacheManagedByCbpanel(env),
      restartRequired: this.runtimeRestartRequired(),
      detail: info.installed ? undefined : "CloakBrowser Chromium is not installed.",
    };
  }

  // normalizeSettings plus the one field CBPanel owns rather than the operator: binary.tierMode is
  // the cached copy of the cacheTier derivation, so every consumer keeps reading a single settings
  // field and refreshLicenseValidation is the only writer.
  private async readManagedSettings(): Promise<AppSettings> {
    const settings = normalizeSettings(await this.options.readSettings());
    const tierMode = this.licenseDerivation(settings).cacheTier;
    if (tierMode === settings.binary.tierMode) return settings;
    return { ...settings, binary: { ...settings.binary, tierMode } };
  }

  // The one place a target is built, so no consumer can read a stale plan derivation. Every call site
  // goes through it — a second construction with a different planIsFree would let the reported version
  // mode and the version actually pinned in process.env disagree.
  private managedTarget(settings: AppSettings): BrowserCoreTarget {
    return browserCoreTarget(settings, this.initialBuiltinEnv, this.licenseDerivation(settings).planIsFree);
  }

  // The authenticated download path is for keys the licence server has not rejected — not for keys that
  // merely exist, and not only for keys confirmed Pro. Upstream's ensureBinary routes *any* key through
  // its authenticated download and branches on validity itself, so a key with no verdict yet has to stay
  // authenticated or the update check would describe a different download than the one that will happen.
  // What must change is the rejected case: it used to check the channel endpoint — which needs no auth and
  // so answered — and then hand that version to ensureBinary, which fails on the very key that was
  // rejected. The user was told a new version was available and then watched the update fail.
  private licensedDownloads(settings: AppSettings): boolean {
    // planIsFree only moves pinnedVersion, which this does not read; passing false keeps it off the
    // derivation's own cycle, exactly as licenseDerivation does.
    const target = browserCoreTarget(settings, this.initialBuiltinEnv, false);
    if (!hasLicenseKeyConfigured(target)) return false;
    return this.validationFor(target.licenseKey)?.info?.valid !== false;
  }

  private managedEnvValues(settings: AppSettings): ReturnType<typeof browserCoreEnvValues> {
    return browserCoreEnvValues(settings, this.initialBuiltinEnv, this.licenseDerivation(settings).planIsFree);
  }

  // No key means free. A key means whatever the license server says about it, because the wrapper
  // routes every valid key through its authenticated download path — inferring the tier from a
  // free/pro choice the operator made is what let a free key be marked Pro and fail its downloads.
  //
  // The cache tier keys on `valid`, not on the plan: ensureBinary's whole Pro branch is
  // `if (info?.valid)`, so a valid free-plan key downloads into `chromium-<version>-pro` under the Pro
  // marker exactly like a paid one. Only the version pin follows the plan. Deriving one value from the
  // plan made three things wrong at once — a stale Pro build stayed a prune keeper for ever, the panel
  // reported Free beside a `-pro` executable, and a free key's imports were filed under the tier
  // launches never resolve.
  //
  // A key the server *rejects* is free, and that is not the same as an unconfirmed one: the wrapper
  // logs "License validation failed, using free tier" and takes the free path. An unconfirmed plan
  // keeps the last derivation instead — offline must not silently downgrade a Pro install to free, and
  // it must not claim a plan either, so the pin stands the way the wrapper's fallback path honours it.
  //
  // A validation record only speaks for the key it was produced from. Reading it without that check
  // means a key swap keeps deriving the previous key's plan — and persistDerivedTierMode would then
  // write the stale derivation as the new key's cached tier, which is also the offline fallback.
  private validationFor(key: string | undefined): NonNullable<BinaryService["licenseValidation"]> | undefined {
    const resolved = key?.trim();
    if (!resolved) return undefined;
    return this.licenseValidation?.key === resolved ? this.licenseValidation : undefined;
  }

  private licenseDerivation(settings: AppSettings): BrowserCoreLicenseDerivation {
    // planIsFree only ever changes pinnedVersion / versionMode, and neither is read here, so resolving
    // with the pin left in place breaks what would otherwise be a cycle: the derivation is an input to
    // the target it is derived from.
    const target = browserCoreTarget(settings, this.initialBuiltinEnv, false);
    if (!hasLicenseKeyConfigured(target)) return { cacheTier: "free", planIsFree: false };
    const validation = this.validationFor(target.licenseKey)?.info;
    if (!validation) return { cacheTier: settings.binary.tierMode, planIsFree: false };
    if (!validation.valid) return { cacheTier: "free", planIsFree: false };
    return { cacheTier: "pro", planIsFree: validation.plan.trim().toLowerCase() === "free" };
  }

  private licenseState(settings: AppSettings, target: BrowserCoreTarget): BrowserCoreLicenseState {
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

  // Validation is cached by the wrapper for 24h on disk and by this record in memory, and it is
  // resolved through the same module the launches use so a single key/plan answer serves both.
  // It resolves rather than throws: a license server CBPanel cannot reach must not fail a read, an
  // install, or an update — the tier simply keeps its last known value.
  //
  // A background refresh never loads the module and never re-applies the managed env. It runs after
  // the read that scheduled it has already returned, so writing process.env there would land outside
  // that read's control — and applyBrowserCoreEnv has always been the caller's job, not a
  // side effect of reporting a plan.
  private async refreshLicenseValidation(options: { background?: boolean } = {}): Promise<void> {
    const settings = normalizeSettings(await this.options.readSettings());
    // Not managedTarget: this runs before any derivation exists, and it validates the key even when a
    // custom download source is in play — the key stays "on file and active", it just stops deciding
    // the tier. planIsFree does not reach licenseKey, so resolving with the pin in place is exact.
    const key = browserCoreTarget(settings, this.initialBuiltinEnv, false).licenseKey;
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
    const settings = normalizeSettings(await this.options.readSettings());
    const tierMode = this.licenseDerivation(settings).cacheTier;
    if (tierMode === settings.binary.tierMode) return;
    await this.options.saveSettings({ binary: { ...settings.binary, tierMode } });
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
    const envValues = this.managedEnvValues(settings);

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

  // The one authoritative managed cache root. Deriving it from a resolved binary path instead is
  // how an active CLOAKBROWSER_BINARY_PATH leaked enumeration, deletion and import onto whatever
  // directory happened to be the override's grandparent.
  private managedCacheRoot(): string {
    return process.env.CLOAKBROWSER_CACHE_DIR || this.defaultCacheDir();
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
    const settings = await this.readManagedSettings();
    const target = this.managedTarget(settings);
    // A mirror only helps the free path, which downloads from GitHub releases. Skipping it whenever a key
    // existed meant a rejected key — which now falls back to exactly that free path — lost its mirror and
    // downloaded direct from GitHub. Same derivation as the routing itself, so the two agree.
    const resolution = this.licensedDownloads(settings)
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
    const settings = await this.readManagedSettings();
    const binary = settings.binary;
    const envValues = this.managedEnvValues(settings);
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
      CLOAKBROWSER_RELEASE_CHANNEL: envValues.releaseChannel,
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
        bundled_version: info.bundledVersion ?? info.version,
        path: info.binaryPath,
        installed: info.installed,
        cache_dir: info.cacheDir,
        override: process.env.CLOAKBROWSER_BINARY_PATH ?? null,
        release_channel: target.releaseChannel,
      },
      launch: await collectBinaryLaunchDiagnostics(info.binaryPath, info.installed, quick),
      license: {
        tier: info.tier ?? target.tier,
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
        "puppeteer-core": Boolean(PACKAGE_VERSIONS.puppeteerCore),
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
        unresolved_reason: resolved.unresolvedReason ?? null,
      };
    } catch (error) {
      return { error: diagnosticsErrorMessage(error) };
    }
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

  // The platform comes from the caller, not from runtime.binaryInfo(version): the wrapper's version
  // parser rejects a 3-component version, and an import that resolved one would throw here — after
  // the rename had already published the build.
  private async writeVersionMarker(version: string, platform: string): Promise<void> {
    const cacheRoot = this.managedCacheRoot();
    await fs.mkdir(cacheRoot, { recursive: true });
    await fs.writeFile(path.join(cacheRoot, `latest_version_${platform}`), version, "utf8");
  }

  private async writeProVersionMarker(version: string, platform: string, releaseChannel: BrowserCoreReleaseChannel): Promise<void> {
    const cacheRoot = this.managedCacheRoot();
    await fs.mkdir(cacheRoot, { recursive: true });
    // The wrapper resolves the Pro build from a per-channel marker, so writing the stable one on
    // the preview channel leaves the import with no effect on launches.
    const markerPrefix = releaseChannel === "preview" ? "latest_pro_version_preview" : "latest_pro_version";
    await fs.writeFile(path.join(cacheRoot, `${markerPrefix}_${platform}`), version, "utf8");
  }

  private async latestProChromiumVersion(
    platform: string,
    releaseChannel: BrowserCoreReleaseChannel,
  ): Promise<string | undefined> {
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
  initialBuiltinEnv: Map<string, string | undefined>,
  planIsFree: boolean,
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
    tier: customDownloadBaseUrl ? "free" : binary.tierMode,
    versionMode: pinnedVersion ? "pinned" : "latest",
    pinnedVersion,
    licenseKey,
    customBinaryPath,
    customDownloadBaseUrl,
    releaseChannel: releaseChannel === "preview" ? "preview" : "stable",
  };
}

// Whether a licence key is in play at all — not whether it works. Named for what it tests: as
// `usesLicensedDownloads` it read like a guarantee, and two call sites took it as one, routing a key the
// server had rejected down the authenticated path. Only the tier derivation, which goes on to ask about
// validity, should use this.
function hasLicenseKeyConfigured(target: BrowserCoreTarget): boolean {
  return Boolean(target.licenseKey && !target.customDownloadBaseUrl);
}

function browserCoreEnvValues(
  settings: AppSettings,
  initialBuiltinEnv: Map<string, string | undefined>,
  planIsFree: boolean,
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
    releaseChannel: releaseChannel.value,
    releaseChannelSource: releaseChannel.source,
  };
}

function envStringValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

// Turning the key off is how an operator deliberately runs the free tier while keeping the key on
// file, so the setting drops out of the resolution entirely — an externally-set
// CLOAKBROWSER_LICENSE_KEY still wins, exactly as customBinaryPathEnabled behaves.
function settingsLicenseKey(binary: AppSettings["binary"]): string | undefined {
  return binary.licenseKeyEnabled ? envStringValue(binary.licenseKey) : undefined;
}

function envUrlBaseValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  return trimmed || undefined;
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
  return active === undefined ? undefined : { active };
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
    unresolvedReason: launchGeoUnresolvedReasonFrom(resolved.unresolved_reason),
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
    const match = entry.name.match(/^chromium-(.+?)(-pro)?$/i);
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
