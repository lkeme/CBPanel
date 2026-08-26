import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { Browser, BrowserContext } from "playwright-core";
import {
  type BrowserProfile,
  type ProfilePreflightEnvironment,
  type ProfilePreflightReport,
  type SessionEvent,
  type SessionSummary,
  buildLaunchPreview,
  browserVersionLaunchHints,
  buildPlaywrightContextOptions,
  buildPuppeteerPageSetup,
  buildSessionLaunchPlan,
  preflightProfile,
} from "../../src/shared/profile";
import type { BrowserEnvironment, NetworkCheckResult } from "../../src/shared/entities";
import { networkCheckSummaryText } from "../../src/shared/networkCheckDisplay";
import type { BrowserCoreTier } from "../../src/shared/browserCore";
import { normalizeSettings, type AppSettings } from "../../src/shared/settings";
import type { ExtensionLaunchRegistration, ExtensionService } from "./extensionService";
import { applyGithubMirrorFetch } from "./githubMirrorFetch";
import { GithubMirrorProbeService } from "./githubMirrorProbeService";

type RuntimeHandle = {
  close: () => Promise<void>;
  pageUrl: () => string | undefined;
  warning?: string;
};

export type ExtensionRegistrationPreflightProcess = RuntimeHandle & {
  clearServiceWorkers: (origins: string[]) => Promise<void>;
  loadUnpackedExtensions: (registrations: ExtensionLaunchRegistration[]) => Promise<void>;
  /** Completes a successful migration only after Browser.close and a natural Chromium exit. */
  finish: () => Promise<void>;
};

type RegistrationPreflightRuntimeHandle = ExtensionRegistrationPreflightProcess;

type RunningSession = SessionSummary & {
  runtime?: RuntimeHandle;
  runtimePromise?: Promise<RuntimeHandle>;
  registrationPreflightRuntime?: RegistrationPreflightRuntimeHandle;
  registrationPreflightPromise?: Promise<RegistrationPreflightRuntimeHandle>;
  closingByPanel?: boolean;
};

// A graceful browser close is one to three seconds' work. When it is not — a renderer that will not exit,
// or a launch that never finished so runtimePromise never settles — an unbounded await left the session in
// "stopping" for ever: that profile could never be launched again, and every managed-cache operation
// stayed blocked behind the session probe with no way out but restarting the panel.
// Kept under the desktop shell's graceful window: src-tauri/src/lib.rs waits 8s after asking the sidecar
// to shut down and then kills it, so a budget above that would have stopAll cut off mid-flight, skipping
// repository.close() and orphaning browsers that were about to exit.
const SESSION_CLOSE_TIMEOUT_MS = 6_000;
const EXTENSION_REGISTRATION_MIGRATION_TIMEOUT_MS = 15_000;
const EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT_MS = 15_000;
const EXTENSION_REGISTRATION_PREFLIGHT_LAUNCH_GRACE_MS = 1_000;
const EXTENSION_REGISTRATION_PREFLIGHT_CLOSE_GRACE_MS = 3_000;

type BrowserCoreRuntimeInfo = {
  installed: boolean;
  binaryPath: string;
  version: string;
  tier?: BrowserCoreTier;
};

type BinaryInfoReader = () => Promise<BrowserCoreRuntimeInfo>;

type SessionServiceOptions = {
  browserDataDir: string;
  readBinaryInfo: BinaryInfoReader;
  extensionService?: ExtensionService;
  readEnvironment?: (id: string) => Promise<BrowserEnvironment | undefined>;
  checkNetwork?: (profile: BrowserProfile) => Promise<NetworkCheckResult>;
  readSettings?: () => Promise<AppSettings>;
  // The cache-mutating browser-core operation in flight, if any. Read at call time: upstream's launch
  // calls ensureBinary itself, and an explicit update unfreezes CLOAKBROWSER_AUTO_UPDATE process-wide, so
  // a launch started inside that window can begin a second download into the cache being written.
  activeCacheOperation?: () => string | undefined;
  // Full backups and environment packages read or replace the same browser-data/extension trees a
  // launch consumes. The callback includes queued work because start* publishes that state
  // synchronously, closing the route-to-launch race before the async worker begins.
  activeDataOperation?: () => string | undefined;
};

type CloakBrowserModule = {
  launch: (options?: Parameters<typeof import("cloakbrowser")["launch"]>[0]) => Promise<Browser>;
  launchPersistentContext: (options: Parameters<typeof import("cloakbrowser")["launchPersistentContext"]>[0]) => Promise<BrowserContext>;
  launchContext: (options?: Parameters<typeof import("cloakbrowser")["launchContext"]>[0]) => Promise<BrowserContext>;
};

type PuppeteerBrowser = {
  close: () => Promise<void>;
  newPage: () => Promise<PuppeteerPage>;
  pages: () => Promise<PuppeteerPage[]>;
  targets?: () => PuppeteerTarget[];
  on?: (event: "disconnected", handler: () => void) => void;
  once?: (event: "disconnected", handler: () => void) => void;
};

export type ExtensionRegistrationPreflightLaunchOptions = {
  userDataDir: string;
  executablePath: string;
  args: string[];
  timeout: number;
  spawnOptions: {
    windowsHide: true;
    shell: false;
    stdio: ["ignore", "pipe", "pipe"];
  };
};

type PuppeteerPage = {
  close?: () => Promise<void>;
  url: () => string;
  goto: (url: string, options?: GotoOptions) => Promise<unknown>;
  setUserAgent?: (userAgent: string) => Promise<void>;
  setViewport?: (viewport: { width: number; height: number }) => Promise<void>;
};

type PuppeteerTarget = {
  type: () => string;
  url: () => string;
  worker?: () => Promise<PuppeteerWorker | null>;
};

type PuppeteerWorker = {
  evaluate: <Result>(pageFunction: () => Result | Promise<Result>) => Promise<Result>;
};

export type ExtensionRegistrationWorker = {
  url: string;
  readRuntimeRevision: () => Promise<string>;
};

export type ExtensionRegistrationManagementInfo = {
  id: string;
  path?: string;
  enabled: boolean;
  mayDisable: boolean;
};

export type ExtensionRegistrationManagementPage = {
  inspect: (extensionId: string) => Promise<ExtensionRegistrationManagementInfo>;
  setEnabled: (extensionId: string, enabled: boolean) => Promise<void>;
  close: () => Promise<void>;
};

export type ExtensionRegistrationMigrationBrowser = {
  listWorkers: () => Promise<ExtensionRegistrationWorker[]>;
  openManagementPage: () => Promise<ExtensionRegistrationManagementPage>;
};

type GotoOptions = {
  waitUntil?: "domcontentloaded";
  timeout?: number;
};

type CloakBrowserPuppeteerModule = {
  launch: (options?: Parameters<typeof import("cloakbrowser/puppeteer")["launch"]>[0]) => Promise<PuppeteerBrowser>;
  launchPersistentContext: (options: Parameters<typeof import("cloakbrowser/puppeteer")["launchPersistentContext"]>[0]) => Promise<PuppeteerBrowser>;
};

export class SessionService {
  private readonly sessions = new Map<string, RunningSession>();
  /** Browser generations whose close was attempted but never confirmed, including replaced records. */
  private readonly unconfirmedCloses = new Set<RunningSession>();
  private readonly githubMirrorProbeService = new GithubMirrorProbeService();
  private stoppingAll = false;

  constructor(private readonly options: SessionServiceOptions) {}

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()].map(publicSession);
  }

  hasActiveSession(profileId: string): boolean {
    const status = this.sessions.get(profileId)?.status;
    return status === "running" || status === "launching" || status === "stopping";
  }

  // Deliberately not hasActiveSession: that answers "may this profile be launched", and a stop that ran
  // out of time must not block a relaunch for ever. This answers the different question the extension,
  // environment and browser-core services ask before they rm or rename something — "might a browser
  // process still have these files open" — for which an unconfirmed close has to count as yes.
  profileIdsHoldingRuntime(): Set<string> {
    const holding = new Set(
      [...this.sessions.values()]
        .filter((session) =>
          session.status === "running"
          || session.status === "launching"
          || session.status === "stopping")
        .map((session) => session.profileId),
    );
    for (const session of this.unconfirmedCloses) holding.add(session.profileId);
    return holding;
  }

  async preflight(profile: BrowserProfile): Promise<ProfilePreflightReport> {
    const resolved = await this.resolveRuntimeProfile(profile, { install: false });
    return preflightProfile(
      resolved.profile,
      await this.buildPreflightEnvironment(resolved.profile, resolved.extensionErrors, resolved.extensionWarnings),
    );
  }

  async launchProfile(profile: BrowserProfile): Promise<SessionSummary> {
    this.assertCanLaunch();
    if (this.hasActiveSession(profile.id)) {
      throw Object.assign(new Error("该配置已经在运行"), { status: 409 });
    }

    // Register before resolving so a concurrent launch sees this environment as active and
    // cannot rm/rename an extension directory under this booting browser.
    const previousCloseUnconfirmed = this.hasUnconfirmedClose(profile.id);
    const session: RunningSession = {
      profileId: profile.id,
      status: "launching",
      startedAt: new Date().toISOString(),
      events: [],
      // Carried over, not dropped: the record it replaces may be one whose close was never confirmed, and
      // that older process can still be holding these files. Dropping it here released the hold the
      // moment the user pressed Launch — and if this launch then failed, every destructive operation
      // would think the files were free.
      closeUnconfirmed: previousCloseUnconfirmed || undefined,
    };
    this.sessions.set(profile.id, session);
    pushSessionEvent(session, "info", "创建启动请求", profile.name);

    try {
      const resolved = await this.resolveRuntimeProfile(profile, {
        install: true,
        allowRuntimeReplacement: !previousCloseUnconfirmed,
      });
      const runtimeProfile = resolved.profile;
      this.assertRegistrationMigrationSupported(runtimeProfile, resolved.extensionRegistrations);
      if (
        previousCloseUnconfirmed
        && resolved.extensionRegistrations.some((registration) => registration.migrationRequired)
      ) {
        throw Object.assign(
          new Error("Pending extension registration migration cannot modify a profile while an older browser close is unconfirmed"),
          { status: 409, code: "EXTENSION_REGISTRATION_MIGRATION_CLOSE_UNCONFIRMED" },
        );
      }
      if (resolved.extensionWarnings.length > 0) {
        pushSessionEvent(
          session,
          "warn",
          "扩展启动警告",
          resolved.extensionWarnings.map((warning) => `${warning.name}: ${warning.detail}`).join("；"),
        );
      }
      this.assertCanLaunch();
      const binary = await this.options.readBinaryInfo();
      this.assertCanLaunch();
      if (!binary.installed) {
        throw Object.assign(new Error("CloakBrowser 内核未安装；请先在运行前检查或设置中安装浏览器内核。"), {
          status: 409,
          code: "BROWSER_CORE_MISSING",
        });
      }

      const networkCheck = await this.checkNetworkBeforeLaunch(runtimeProfile);
      if (networkCheck) {
        pushSessionEvent(
          session,
          networkCheck.ok ? "info" : "warn",
          networkCheck.ok ? "出口检查完成" : "出口检查失败",
          formatNetworkCheckDetail(networkCheck),
        );
        if (!networkCheck.ok) throw proxyCheckLaunchError(networkCheck);
      }
      // Network probing is another await boundary. A restore/import can be queued while it runs; recheck
      // at the final point before a browser process is created.
      this.assertCanLaunch();
      const userDataDir = this.profileDataDir(runtimeProfile);
      session.launch = buildSessionLaunchPlan(runtimeProfile, userDataDir);
      pushSessionEvent(session, "info", "启动计划已生成", `${session.launch.runtimeLauncher} -> ${session.launch.sdkLauncher}`);
      if (resolved.extensionRegistrations.some((registration) => registration.migrationRequired)) {
        await this.preflightPendingExtensionRegistrations(
          runtimeProfile,
          session,
          binary,
          resolved.extensionRegistrations,
        );
        // A restore/import or shutdown can be queued while the isolated preflight owns the profile.
        // Recheck before the formal extension-enabled browser is created.
        this.assertCanLaunch();
      }
      if (session.status !== "launching") return publicSession(session);

      session.runtimePromise = this.startRuntime(
        runtimeProfile,
        session,
        binary,
        resolved.extensionRegistrations,
      );
      const runtime = await session.runtimePromise;
      if (session.status !== "launching") return publicSession(session);
      session.runtime = runtime;
      delete session.runtimePromise;
      session.status = "running";
      // Deliberately the raw read, not readPageUrl: this one is still inside the launch, so a licence denial
      // the wrapper surfaces here belongs in the catch below, where it becomes a 409 naming the core
      // settings. readPageUrl exists for the polled reads afterwards, which must not be able to throw.
      pushSessionEvent(session, "info", "CloakBrowser 已启动", runtime.pageUrl());
      if (runtime.warning) {
        session.lastError = runtime.warning;
        pushSessionEvent(session, "warn", "起始页加载失败", runtime.warning);
      }

      return publicSession(session);
    } catch (error) {
      if (session.status === "stopped") return publicSession(session);
      session.status = "error";
      session.lastError = (error as Error).message;
      pushSessionEvent(session, "error", "启动失败", session.lastError);
      delete session.runtime;
      delete session.runtimePromise;
      throw await licenseDenialError(error);
    }
  }

  async stopProfile(profileId: string): Promise<SessionSummary> {
    const session = this.sessions.get(profileId);
    if (!session) {
      return { profileId, status: "stopped", stoppedAt: new Date().toISOString() };
    }

    session.status = "stopping";
    session.closingByPanel = true;
    pushSessionEvent(session, "info", "停止会话");
    try {
      const closing = this.closeSessionRuntime(session);
      const closed = await raceTimeout(closing, this.closeTimeoutMs());
      if (!closed) {
        // Honest about not knowing rather than optimistic: reporting "stopped" would claim a process exit
        // nobody observed.
        this.markCloseUnconfirmed(
          profileId,
          `停止超时（${Math.round(this.closeTimeoutMs() / 1000)} 秒）`,
          "停止超时",
          session,
        );
        // The close keeps running, and its late outcome is the only thing that can clear this without a
        // browser event. Resolving means there was nothing left to close — a launch that never produced a
        // runtime — or that the close finally landed; either way the files are free.
        void closing.then(
          () => this.markSessionStopped(profileId, "会话已停止", session),
          (error) => this.recordLateCloseFailure(profileId, error, session),
        );
        return publicSession(session);
      }
      this.markSessionStopped(profileId, "会话已停止", session);
      return publicSession(session);
    } catch (error) {
      // A close that threw is exactly as unconfirmed as one that ran out of time: the attempt failed, so
      // nothing observed the process exit and it may still hold its files. The diagnosis survives in the
      // event log even after a later close event clears the session.
      this.markCloseUnconfirmed(profileId, `停止失败：${(error as Error).message}`, "停止失败", session);
      return publicSession(session);
    }
  }

  private markCloseUnconfirmed(
    profileId: string,
    reason: string,
    event: string,
    expectedSession?: RunningSession,
  ): void {
    const session = this.sessions.get(profileId);
    // The browser's own close event can land inside the budget and confirm the stop already. Overwriting
    // that confirmation is permanent — no second event will ever arrive — so the session would hold every
    // file-touching service for the rest of the process.
    if (!session || (expectedSession && session !== expectedSession) || session.status === "stopped") return;
    session.status = "error";
    session.closeUnconfirmed = true;
    this.unconfirmedCloses.add(session);
    delete session.closingByPanel;
    session.lastError = `${reason}：浏览器可能仍在运行。可再次点击停止，或手动结束该浏览器进程。`;
    pushSessionEvent(session, "error", event, session.lastError);
  }

  private recordLateCloseFailure(profileId: string, error: unknown, expectedSession: RunningSession): void {
    if (this.sessions.get(profileId) !== expectedSession || !expectedSession.closeUnconfirmed) return;
    this.markCloseUnconfirmed(profileId, `停止失败：${(error as Error).message}`, "停止失败", expectedSession);
  }

  // Both awaits are inside the budget on purpose: a launch that never finishes leaves runtimePromise
  // pending, which wedged the stop before close() was even reached.
  private async closeSessionRuntime(session: RunningSession): Promise<void> {
    const preflight = session.registrationPreflightRuntime
      ?? (await session.registrationPreflightPromise?.catch(() => undefined));
    if (preflight) {
      await preflight.close();
      return;
    }
    const runtime = session.runtime ?? (await session.runtimePromise?.catch(() => undefined));
    await runtime?.close();
  }

  // A seam, not a setting: the tests already override startRuntime this way, and a real knob for how
  // long to wait on a wedged browser is not something to ask an operator about.
  protected closeTimeoutMs(): number {
    return SESSION_CLOSE_TIMEOUT_MS;
  }

  async stopAll(): Promise<void> {
    this.stoppingAll = true;
    try {
      await Promise.all([...this.sessions.keys()].map((profileId) => this.stopProfile(profileId)));
    } finally {
      this.stoppingAll = false;
    }
  }

  private assertCanLaunch(): void {
    if (this.stoppingAll) {
      throw Object.assign(new Error("CBPanel 正在关闭运行环境，暂不能启动新会话。"), { status: 409 });
    }
    // The mirror image of the cache guards: those refuse to delete a build a browser may be using, and
    // this refuses to start a browser while a build is being written. Called again after each await in
    // launchProfile, so an operation that begins mid-launch is caught before the runtime is created.
    const operation = this.options.activeCacheOperation?.();
    if (operation) {
      throw Object.assign(new Error(`浏览器内核正在${coreOperationText(operation)}，请等它完成后再启动会话。`), {
        status: 409,
        code: "BROWSER_CORE_OPERATION_IN_PROGRESS",
      });
    }
    const dataOperation = this.options.activeDataOperation?.();
    if (dataOperation) {
      throw Object.assign(new Error(`环境数据正在${dataOperation}，请等它完成后再启动会话。`), {
        status: 409,
        code: "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS",
      });
    }
  }

  private async buildPreflightEnvironment(
    profile: BrowserProfile,
    extensionErrors: ProfilePreflightEnvironment["extensionErrors"] = [],
    extensionWarnings: ProfilePreflightEnvironment["extensionWarnings"] = [],
  ): Promise<ProfilePreflightEnvironment> {
    const userDataDir = this.profileDataDir(profile);
    const binary = await this.options.readBinaryInfo();
    const [userDataDirProbe, extensionChecks] = await Promise.all([
      profile.mode === "persistent" ? probeWritableDirectory(userDataDir) : Promise.resolve(undefined),
      Promise.all(profile.runtime.extensionPaths.map((extensionPath) => checkPathExists(extensionPath))),
    ]);
    const environment = await this.options.readEnvironment?.(profile.id);

    return {
      checkedAt: new Date().toISOString(),
      userDataDir,
      binaryInstalled: binary.installed,
      binaryPath: binary.binaryPath,
      binaryDetail: binary.installed ? undefined : "CloakBrowser 内核未安装。",
      userDataDirWritable: userDataDirProbe?.ok,
      userDataDirDetail: userDataDirProbe?.detail,
      extensionChecks,
      extensionErrors,
      extensionWarnings,
      networkCheck: environment?.lastNetworkCheck,
    };
  }

  private async checkNetworkBeforeLaunch(profile: BrowserProfile): Promise<NetworkCheckResult | undefined> {
    if (!profile.proxy.enabled || !this.options.checkNetwork) return undefined;
    try {
      return await this.options.checkNetwork(profile);
    } catch (error) {
      return {
        checkedAt: new Date().toISOString(),
        ok: false,
        source: "environment-check",
        error: (error as Error).message,
      };
    }
  }

  private async resolveRuntimeProfile(
    profile: BrowserProfile,
    options: { install: boolean; allowRuntimeReplacement?: boolean },
  ): Promise<{
    profile: BrowserProfile;
    extensionErrors: Array<{ name: string; detail: string }>;
    extensionWarnings: Array<{ name: string; detail: string }>;
    extensionRegistrations: ExtensionLaunchRegistration[];
  }> {
    if (!this.options.extensionService) {
      return { profile, extensionErrors: [], extensionWarnings: [], extensionRegistrations: [] };
    }
    const environment = await this.options.extensionService.resolveEnvironment(profile.id);
    if (environment.environment.extensionIds.length === 0) {
      return { profile, extensionErrors: [], extensionWarnings: [], extensionRegistrations: [] };
    }

    try {
      const ensured = await this.options.extensionService.ensureExtensionsInstalled(profile.id, {
        allowRuntimeReplacement: options.allowRuntimeReplacement,
      });
      return {
        profile: {
          ...profile,
          runtime: {
            ...profile.runtime,
            extensionPaths: ensured.paths,
          },
        },
        extensionErrors: [],
        extensionWarnings: ensured.warnings.map((warning) => ({ name: warning.name, detail: warning.reason })),
        extensionRegistrations: ensured.registrations ?? [],
      };
    } catch (error) {
      if (options.install) throw error;
      return {
        profile: {
          ...profile,
          runtime: {
            ...profile.runtime,
            extensionPaths: [],
          },
        },
        extensionErrors: [{ name: "Extension", detail: (error as Error).message }],
        extensionWarnings: [],
        extensionRegistrations: [],
      };
    }
  }

  private assertRegistrationMigrationSupported(
    profile: BrowserProfile,
    registrations: ExtensionLaunchRegistration[],
  ): void {
    if (!registrations.some((registration) => registration.migrationRequired)) return;
    if (
      profile.mode === "persistent"
      && (profile.runtime.launcher === "playwright-context" || profile.runtime.launcher === "puppeteer-browser")
    ) return;
    throw Object.assign(
      new Error("Pending extension registration migration requires a supported persistent browser launcher"),
      { status: 409, code: "EXTENSION_REGISTRATION_MIGRATION_UNSUPPORTED" },
    );
  }

  private profileDataDir(profile: BrowserProfile): string {
    return path.join(this.options.browserDataDir, profile.id);
  }

  // Protected, not private: watchExternalClose routes the browser's own exit through here, and the tests
  // stand in for that event the same way they stand in for startRuntime.
  protected markSessionStopped(
    profileId: string,
    detail: string,
    expectedSession?: RunningSession,
  ): void {
    const session = this.sessions.get(profileId);
    const closedSession = expectedSession ?? session;
    if (closedSession) this.unconfirmedCloses.delete(closedSession);
    // A timed-out close and the old browser's disconnect event may settle after the user has relaunched
    // the same profile. Those callbacks belong to the replaced record and must never stop the new one.
    if (expectedSession && session !== expectedSession) {
      if (session) this.reflectUnconfirmedClose(session);
      return;
    }
    // A stop that ran out of time is the one error worth overwriting: it recorded that the close was
    // never confirmed, so a disconnect arriving later *is* that confirmation. Without this exception the
    // session would keep every file-touching service blocked until the panel restarted.
    if (!session || session.status === "stopped") return;
    if (session.status === "error" && !session.closeUnconfirmed) return;
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    delete session.runtime;
    delete session.runtimePromise;
    delete session.registrationPreflightRuntime;
    delete session.registrationPreflightPromise;
    delete session.lastError;
    delete session.closingByPanel;
    this.reflectUnconfirmedClose(session);
    pushSessionEvent(session, "info", detail);
    this.sessions.set(profileId, session);
  }

  private hasUnconfirmedClose(profileId: string): boolean {
    for (const session of this.unconfirmedCloses) {
      if (session.profileId === profileId) return true;
    }
    return false;
  }

  private reflectUnconfirmedClose(session: RunningSession): void {
    if (this.hasUnconfirmedClose(session.profileId)) session.closeUnconfirmed = true;
    else delete session.closeUnconfirmed;
  }

  private watchExternalClose(session: RunningSession, target: object, eventName: string): void {
    const source = target as {
      once?: (event: string, handler: () => void) => void;
      on?: (event: string, handler: () => void) => void;
    };
    const onClosed = () => {
      this.markSessionStopped(
        session.profileId,
        session.closingByPanel ? "会话已停止" : "浏览器窗口已关闭",
        session,
      );
    };
    if (typeof source.once === "function") {
      source.once(eventName, onClosed);
      return;
    }
    if (typeof source.on === "function") source.on(eventName, onClosed);
  }

  protected registrationPreflightTimeoutMs(): number {
    return EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT_MS;
  }

  protected registrationPreflightLaunchGraceMs(): number {
    return EXTENSION_REGISTRATION_PREFLIGHT_LAUNCH_GRACE_MS;
  }

  protected async launchRegistrationPreflightProcess(
    options: ExtensionRegistrationPreflightLaunchOptions,
  ): Promise<ExtensionRegistrationPreflightProcess> {
    await assertRegistrationPreflightBinary(options.executablePath);
    const activePortPath = await prepareExtensionRegistrationPreflightUserDataDir(options.userDataDir);
    const child = spawn(options.executablePath, options.args, options.spawnOptions);
    return rawCdpRegistrationPreflightProcess(child, activePortPath, options.timeout);
  }

  protected async preflightPendingExtensionRegistrations(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
    registrations: ExtensionLaunchRegistration[],
  ): Promise<void> {
    const pending = registrations.filter((registration) => registration.migrationRequired);
    if (pending.length === 0) return;
    const timeoutMs = this.registrationPreflightTimeoutMs();
    const options = buildExtensionRegistrationPreflightLaunchOptions(
      this.profileDataDir(profile),
      binary.binaryPath,
      timeoutMs,
    );
    pushSessionEvent(session, "info", "准备扩展注册迁移", `${pending.length} extension(s)`);
    const launchWork = this.launchRegistrationPreflightProcess(options);
    const preflightPromise = launchWork;
    session.registrationPreflightPromise = preflightPromise;
    let preflight: RegistrationPreflightRuntimeHandle;
    try {
      preflight = await boundedRegistrationPreflightOperation(
        preflightPromise,
        timeoutMs + this.registrationPreflightLaunchGraceMs(),
        "launch",
      );
    } catch (error) {
      if (
        (error as { code?: string }).code !== "EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT"
        && session.registrationPreflightPromise === preflightPromise
      ) {
        delete session.registrationPreflightPromise;
      }
      if ((error as { code?: string }).code === "EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT") {
        this.markCloseUnconfirmed(
          profile.id,
          "Extension registration preflight launch timed out before browser ownership could be confirmed",
          "Extension registration preflight launch timed out",
          session,
        );
        void preflightPromise.then(
          async (latePreflight) => {
            const lateClose = latePreflight.close();
            try {
              await boundedRegistrationPreflightOperation(lateClose, timeoutMs, "late close");
              this.markSessionStopped(profile.id, "Extension registration preflight has stopped", session);
            } catch (lateError) {
              this.recordLateCloseFailure(profile.id, lateError, session);
            }
          },
          () => {
            setImmediate(() => this.markSessionStopped(
              profile.id,
              "Extension registration preflight did not start",
              session,
            ));
          },
        );
      }
      throw error;
    }
    if (session.registrationPreflightPromise === preflightPromise) {
      delete session.registrationPreflightPromise;
    }
    session.registrationPreflightRuntime = preflight;

    let migrationCommandsCompleted = false;
    try {
      if (session.status !== "launching") return;
      await boundedRegistrationPreflightOperation(
        preflight.clearServiceWorkers(
          pending.map((registration) => `chrome-extension://${registration.browserExtensionId}`),
        ),
        timeoutMs,
        "service-worker registration clear",
      );
      if (session.status !== "launching") return;
      await boundedRegistrationPreflightOperation(
        preflight.loadUnpackedExtensions(pending),
        timeoutMs,
        "unpacked extension registration",
      );
      migrationCommandsCompleted = session.status === "launching";
    } finally {
      // Successful clear/load work needs Chromium's own graceful shutdown so its extension registration
      // database and ScriptCache changes are durably flushed. close() is deliberately a different path:
      // it is cancellation/cleanup and may kill the child, which proves the profile is free but never
      // proves the registration write reached disk.
      const finishing = migrationCommandsCompleted && session.status === "launching";
      const shutdownWork = finishing ? preflight.finish() : preflight.close();
      try {
        await boundedRegistrationPreflightOperation(
          shutdownWork,
          finishing ? registrationPreflightFinishBudgetMs(timeoutMs) : timeoutMs,
          finishing ? "graceful finish" : "close",
        );
        if (session.registrationPreflightRuntime === preflight) {
          delete session.registrationPreflightRuntime;
        }
        if (session.closeUnconfirmed && session.status !== "launching") {
          this.markSessionStopped(profile.id, "Extension registration preflight has stopped", session);
        }
      } catch (error) {
        // A failed graceful finish must still terminate the maintenance browser, but a confirmed forced
        // exit is cleanup only: it blocks the formal launch while releasing the profile hold. Retain an
        // unconfirmed generation only when even that cancellation cannot confirm process exit.
        const cleanupWork = finishing ? preflight.close() : shutdownWork;
        try {
          await boundedRegistrationPreflightOperation(
            cleanupWork,
            registrationPreflightCleanupBudgetMs(timeoutMs),
            "forced cleanup",
          );
          if (session.registrationPreflightRuntime === preflight) {
            delete session.registrationPreflightRuntime;
          }
          if (session.closeUnconfirmed && session.status !== "launching") {
            this.markSessionStopped(profile.id, "Extension registration preflight has stopped", session);
          }
        } catch (cleanupError) {
          this.markCloseUnconfirmed(
            profile.id,
            `Extension registration preflight close was not confirmed: ${(cleanupError as Error).message}`,
            "Extension registration preflight close failed",
            session,
          );
          void cleanupWork.then(
            () => this.markSessionStopped(profile.id, "Extension registration preflight has stopped", session),
            (lateError) => this.recordLateCloseFailure(profile.id, lateError, session),
          );
        }
        throw error;
      }
    }
    if (!migrationCommandsCompleted || session.status !== "launching") return;
    pushSessionEvent(session, "info", "扩展注册预迁移完成");
  }

  protected async startRuntime(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
    registrations: ExtensionLaunchRegistration[] = [],
  ): Promise<RuntimeHandle> {
    if (profile.runtime.launcher === "puppeteer-browser") {
      return this.startPuppeteerRuntime(profile, session, binary, registrations);
    }

    if (profile.runtime.launcher === "playwright-browser") {
      return this.startPlaywrightBrowserRuntime(profile, session, binary);
    }

    return this.startPlaywrightContextRuntime(profile, session, binary, registrations);
  }

  private async startPlaywrightContextRuntime(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
    registrations: ExtensionLaunchRegistration[],
  ): Promise<RuntimeHandle> {
    await this.applyGithubMirrorFetch();
    const runtime = await loadCloakBrowser();
    const preview = buildLaunchPreview(profile, this.profileDataDir(profile), browserVersionLaunchHints(binary.version));
    pushSessionEvent(session, "info", "调用 Playwright Context 启动器", preview.launcher);
    const context =
      preview.launcher === "launchPersistentContext"
        ? await runtime.launchPersistentContext(
            preview.options as unknown as Parameters<CloakBrowserModule["launchPersistentContext"]>[0],
          )
        : await runtime.launchContext(preview.options as unknown as Parameters<CloakBrowserModule["launchContext"]>[0]);

    if (!context) throw new Error("CloakBrowser 未返回 BrowserContext");
    this.watchExternalClose(session, context, "close");

    try {
      await this.migrateExtensionRegistrations(
        playwrightRegistrationMigrationBrowser(context),
        registrations,
      );
      const page = await getOrCreatePlaywrightPage(context);
      if (profile.startUrl.trim()) pushSessionEvent(session, "info", "打开起始页", profile.startUrl.trim());
      const warning = await gotoStartUrl(page, profile.startUrl.trim());

      return {
        close: () => context.close(),
        pageUrl: () => context.pages()[0]?.url(),
        warning,
      };
    } catch (error) {
      if (!session.closingByPanel) session.status = "error";
      await context.close().catch(() => {});
      throw error;
    }
  }

  private async startPlaywrightBrowserRuntime(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
  ): Promise<RuntimeHandle> {
    await this.applyGithubMirrorFetch();
    const runtime = await loadCloakBrowser();
    const preview = buildLaunchPreview(profile, this.profileDataDir(profile), browserVersionLaunchHints(binary.version));
    pushSessionEvent(session, "info", "调用 Playwright Browser 启动器", preview.launcher);
    const browser = await runtime.launch(preview.options as unknown as Parameters<CloakBrowserModule["launch"]>[0]);
    this.watchExternalClose(session, browser, "disconnected");
    let context: BrowserContext | undefined;

    try {
      context = await browser.newContext(buildPlaywrightContextOptions(profile));
      this.watchExternalClose(session, context, "close");
      const page = await context.newPage();
      if (profile.startUrl.trim()) pushSessionEvent(session, "info", "打开起始页", profile.startUrl.trim());
      const warning = await gotoStartUrl(page, profile.startUrl.trim());
      return {
        close: () => browser.close(),
        pageUrl: () => context?.pages()[0]?.url(),
        warning,
      };
    } catch (error) {
      if (!session.closingByPanel) session.status = "error";
      await browser.close().catch(() => {});
      throw error;
    }
  }

  private async startPuppeteerRuntime(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
    registrations: ExtensionLaunchRegistration[],
  ): Promise<RuntimeHandle> {
    await this.applyGithubMirrorFetch();
    const runtime = await loadCloakBrowserPuppeteer();
    const preview = buildLaunchPreview(profile, this.profileDataDir(profile), browserVersionLaunchHints(binary.version));
    pushSessionEvent(session, "info", "调用 Puppeteer 启动器", preview.launcher);
    const browser =
      preview.launcher === "puppeteerLaunchPersistentContext"
        ? await runtime.launchPersistentContext(
            preview.options as unknown as Parameters<CloakBrowserPuppeteerModule["launchPersistentContext"]>[0],
          )
        : await runtime.launch(preview.options as unknown as Parameters<CloakBrowserPuppeteerModule["launch"]>[0]);
    this.watchExternalClose(session, browser, "disconnected");
    let page: PuppeteerPage | undefined;

    try {
      await this.migrateExtensionRegistrations(
        puppeteerRegistrationMigrationBrowser(browser),
        registrations,
      );
      const pages = await browser.pages();
      page = pages[0] ?? (profile.startUrl.trim() ? await browser.newPage() : undefined);
      let warning: string | undefined;
      if (page) {
        const setup = buildPuppeteerPageSetup(profile);
        if (setup.userAgent) await page.setUserAgent?.(setup.userAgent);
        if (setup.viewport) await page.setViewport?.(setup.viewport);
        if (profile.startUrl.trim()) pushSessionEvent(session, "info", "打开起始页", profile.startUrl.trim());
        warning = await gotoStartUrl(page, profile.startUrl.trim());
      }
      return {
        close: () => browser.close(),
        pageUrl: () => page?.url(),
        warning,
      };
    } catch (error) {
      if (!session.closingByPanel) session.status = "error";
      await browser.close().catch(() => {});
      throw error;
    }
  }

  protected async migrateExtensionRegistrations(
    browser: ExtensionRegistrationMigrationBrowser,
    registrations: ExtensionLaunchRegistration[],
  ): Promise<void> {
    if (!registrations.some((registration) => registration.migrationRequired)) return;
    const extensionService = this.options.extensionService;
    if (!extensionService) throw new Error("Extension registration migration service is unavailable");
    await migrateExtensionRegistrations(
      browser,
      registrations,
      (registration) => extensionService.markRegistrationReady(registration),
      EXTENSION_REGISTRATION_MIGRATION_TIMEOUT_MS,
    );
  }

  private async applyGithubMirrorFetch(): Promise<void> {
    if (!this.options.readSettings) return;
    const settings = normalizeSettings(await this.options.readSettings());
    const binary = await this.options.readBinaryInfo();
    const resolution = binary.tier === "pro"
      ? undefined
      : await this.githubMirrorProbeService.resolvePrefix(settings, binary.version);
    applyGithubMirrorFetch(settings, resolution?.prefix);
  }
}

export function buildExtensionRegistrationPreflightLaunchOptions(
  userDataDir: string,
  executablePath: string,
  timeoutMs = EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT_MS,
): ExtensionRegistrationPreflightLaunchOptions {
  const resolvedUserDataDir = path.resolve(userDataDir);
  return {
    userDataDir: resolvedUserDataDir,
    executablePath,
    args: [
      `--user-data-dir=${resolvedUserDataDir}`,
      "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0",
      "--disable-extensions",
      "--headless=new",
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    timeout: Math.max(1, timeoutMs),
    spawnOptions: {
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  };
}

async function assertRegistrationPreflightBinary(executablePath: string): Promise<void> {
  if (!path.isAbsolute(executablePath)) {
    throw Object.assign(new Error("Extension registration preflight requires an absolute Chromium binary path"), {
      status: 409,
      code: "BROWSER_CORE_BINARY_INVALID",
    });
  }
  try {
    const stats = await fs.stat(executablePath);
    if (!stats.isFile()) throw new Error("path is not a file");
  } catch (error) {
    throw Object.assign(
      new Error(`Extension registration preflight Chromium binary is unavailable: ${(error as Error).message}`),
      { status: 409, code: "BROWSER_CORE_BINARY_INVALID" },
    );
  }
}

/** @internal Exported for deterministic filesystem contract tests. */
export async function prepareExtensionRegistrationPreflightUserDataDir(userDataDir: string): Promise<string> {
  const resolvedUserDataDir = path.resolve(userDataDir);
  await fs.mkdir(resolvedUserDataDir, { recursive: true });
  const activePortPath = path.join(resolvedUserDataDir, "DevToolsActivePort");
  await fs.rm(activePortPath, { force: true });
  return activePortPath;
}

export type DevToolsActivePort = {
  port: number;
  browserWebSocketPath: string;
};

export function parseDevToolsActivePort(value: string): DevToolsActivePort {
  const lines = value.replace(/^\uFEFF/, "").split(/\r?\n/).map((line) => line.trim());
  const portText = lines[0] ?? "";
  const browserWebSocketPath = lines[1] ?? "";
  if (!/^[0-9]+$/.test(portText)) throw new Error("DevToolsActivePort does not contain a numeric port");
  const port = Number(portText);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("DevToolsActivePort contains an invalid port");
  }
  if (!/^\/devtools\/browser\/[A-Za-z0-9._-]+$/.test(browserWebSocketPath)) {
    throw new Error("DevToolsActivePort contains an invalid browser WebSocket path");
  }
  return { port, browserWebSocketPath };
}

type RawCdpEndpoint = {
  browserWebSocketUrl: string;
  pageWebSocketUrl: string;
};

type ChildExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
};

/** @internal Exported for deterministic child-process lifecycle tests. */
export function rawCdpRegistrationPreflightProcess(
  child: ChildProcess,
  activePortPath: string,
  timeoutMs: number,
): ExtensionRegistrationPreflightProcess {
  let stderrTail = "";
  child.stdout?.resume();
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-8_192);
  });

  let exited: ChildExit | undefined;
  let childError: Error | undefined;
  let confirmExit!: (result: ChildExit) => void;
  const confirmedExitPromise = new Promise<ChildExit>((resolve) => {
    confirmExit = resolve;
  });
  const exitPromise = new Promise<ChildExit>((resolve) => {
    let settled = false;
    const finishOutcome = (result: ChildExit) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error) => {
      childError = error;
      const result = { code: null, signal: null, error };
      finishOutcome(result);
      // Node does not emit `exit` when spawn itself fails. In that one unambiguous case `pid` was never
      // assigned, so no Chromium process can own the profile and cancellation must not retain a false
      // generation hold. Errors from an already-started child keep its numeric pid and still require the
      // real exit event below before the profile is released.
      if (child.pid === undefined) {
        exited = result;
        confirmExit(result);
      }
    });
    child.once("exit", (code, signal) => {
      const result = { code, signal };
      exited = result;
      finishOutcome(result);
      confirmExit(result);
    });
    if (child.exitCode !== null || child.signalCode !== null) {
      const result = { code: child.exitCode, signal: child.signalCode };
      exited = result;
      finishOutcome(result);
      confirmExit(result);
    }
  });

  let endpoint: RawCdpEndpoint | undefined;
  let endpointPromise: Promise<RawCdpEndpoint> | undefined;
  const resolveEndpoint = () => {
    endpointPromise ??= waitForRawCdpEndpoint(
      activePortPath,
      exitPromise,
      () => stderrTail,
      timeoutMs,
    ).then((value) => {
      endpoint = value;
      return value;
    });
    return endpointPromise;
  };

  const cleanupBudgetMs = registrationPreflightCleanupBudgetMs(timeoutMs);
  let cancellationRequested = false;
  let closePromise: Promise<void> | undefined;
  const close = () => {
    cancellationRequested = true;
    closePromise ??= (async () => {
      if (!exited) child.kill();
      // The owning SessionService bounds this promise and retains the generation hold when needed. Keep
      // observing the exact exit event after that bound so a late-but-confirmed forced exit can release the
      // hold instead of leaving the profile falsely busy for the rest of the sidecar process.
      await confirmedExitPromise;
    })();
    return closePromise;
  };

  let finishPromise: Promise<void> | undefined;
  const finish = () => {
    finishPromise ??= (async () => {
      const finishStartedAt = Date.now();
      const failAfterCleanup = async (error: Error): Promise<never> => {
        // close() may force termination. Await it so callers can distinguish a failed flush with a free
        // profile from an unconfirmed process that must retain its generation hold.
        await close();
        throw error;
      };
      if (exited) {
        return failAfterCleanup(registrationPreflightGracefulCloseError(
          "Chromium exited before Browser.close could confirm a registration flush",
          "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_FAILED",
        ));
      }
      if (cancellationRequested) {
        return failAfterCleanup(registrationPreflightGracefulCloseError(
          "Extension registration preflight was cancelled before graceful completion",
          "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_CANCELLED",
        ));
      }
      if (childError) {
        return failAfterCleanup(registrationPreflightGracefulCloseError(
          `Chromium process error: ${childError.message}`,
          "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_FAILED",
          childError,
        ));
      }

      const currentEndpoint = endpoint ?? await resolveEndpoint();
      const commandBudget = cleanupBudgetMs;
      try {
        await boundedRegistrationPreflightOperation(
          withRawCdpConnection(currentEndpoint.browserWebSocketUrl, commandBudget, async (connection) => {
            await connection.send("Browser.close", {});
          }),
          commandBudget,
          "Browser close",
        );
      } catch (error) {
        return failAfterCleanup(registrationPreflightGracefulCloseError(
          `Browser.close failed: ${error instanceof Error ? error.message : String(error)}`,
          "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_FAILED",
          error,
        ));
      }

      const remaining = Math.max(1, timeoutMs - (Date.now() - finishStartedAt));
      const naturallyExited = await raceTimeout(exitPromise, remaining);
      if (naturallyExited && !cancellationRequested) {
        const exit = await exitPromise;
        if (!exit.error && exit.signal === null && exit.code === 0) return;
        return failAfterCleanup(registrationPreflightGracefulCloseError(
          `Chromium exited abnormally after Browser.close: ${childExitDetail(exit)}`,
          "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_FAILED",
          exit.error,
        ));
      }
      return failAfterCleanup(registrationPreflightGracefulCloseError(
        cancellationRequested
          ? "Extension registration preflight was cancelled before graceful completion"
          : "Chromium did not exit naturally after Browser.close within the graceful flush budget",
        cancellationRequested
          ? "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_CANCELLED"
          : "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_TIMEOUT",
      ));
    })();
    return finishPromise;
  };

  return {
    clearServiceWorkers: async (origins) => {
      for (const origin of origins) assertExtensionOrigin(origin);
      const currentEndpoint = await resolveEndpoint();
      await withRawCdpConnection(currentEndpoint.pageWebSocketUrl, timeoutMs, async (connection) => {
        for (const origin of origins) {
          await connection.send("Storage.clearDataForOrigin", {
            origin,
            storageTypes: "service_workers",
          });
        }
      });
    },
    loadUnpackedExtensions: async (registrations) => {
      const currentEndpoint = await resolveEndpoint();
      await withRawCdpConnection(currentEndpoint.browserWebSocketUrl, timeoutMs, async (connection) => {
        await loadUnpackedExtensionRegistrations(connection, registrations);
      });
    },
    finish,
    close,
    pageUrl: () => "about:blank",
  };
}

function registrationPreflightCleanupBudgetMs(timeoutMs: number): number {
  return Math.max(1, Math.min(EXTENSION_REGISTRATION_PREFLIGHT_CLOSE_GRACE_MS, timeoutMs));
}

function registrationPreflightFinishBudgetMs(timeoutMs: number): number {
  return Math.max(1, timeoutMs) + registrationPreflightCleanupBudgetMs(timeoutMs);
}

function registrationPreflightGracefulCloseError(
  message: string,
  code: string,
  cause?: unknown,
): Error {
  return Object.assign(new Error(`Extension registration preflight did not flush registration state: ${message}`, {
    cause,
  }), { status: 409, code });
}

function childExitDetail(exit: ChildExit): string {
  return exit.error?.message
    ?? `exit code ${exit.code ?? "null"}${exit.signal ? `, signal ${exit.signal}` : ""}`;
}

async function waitForRawCdpEndpoint(
  activePortPath: string,
  exitPromise: Promise<ChildExit>,
  stderr: () => string,
  timeoutMs: number,
): Promise<RawCdpEndpoint> {
  const deadline = Date.now() + Math.max(1, timeoutMs);
  let lastError: unknown;
  while (Date.now() < deadline) {
    const exited = await promiseState(exitPromise);
    if (exited.settled) throw childExitedBeforeCdp(exited.value, stderr());
    try {
      const activePort = parseDevToolsActivePort(await fs.readFile(activePortPath, "utf8"));
      const requestTimeout = Math.max(1, Math.min(1_000, deadline - Date.now()));
      const version = await fetchLoopbackJson(
        `http://127.0.0.1:${activePort.port}/json/version`,
        requestTimeout,
      ) as { webSocketDebuggerUrl?: unknown };
      const targets = await fetchLoopbackJson(
        `http://127.0.0.1:${activePort.port}/json/list`,
        requestTimeout,
      );
      const browserWebSocketUrl = loopbackWebSocketUrl(
        version.webSocketDebuggerUrl,
        activePort.port,
        "browser",
      );
      if (new URL(browserWebSocketUrl).pathname !== activePort.browserWebSocketPath) {
        throw new Error("DevTools browser WebSocket path does not match DevToolsActivePort");
      }
      if (!Array.isArray(targets)) throw new Error("DevTools target list is not an array");
      const pageTarget = targets.find((target) => (
        target
        && typeof target === "object"
        && (target as { type?: unknown }).type === "page"
        && typeof (target as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl === "string"
      )) as { webSocketDebuggerUrl: string } | undefined;
      if (!pageTarget) throw new Error("DevTools did not expose a page target");
      const pageWebSocketUrl = loopbackWebSocketUrl(
        pageTarget.webSocketDebuggerUrl,
        activePort.port,
        "page",
      );
      return { browserWebSocketUrl, pageWebSocketUrl };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, deadline - Date.now()))));
  }
  const exited = await promiseState(exitPromise);
  if (exited.settled) throw childExitedBeforeCdp(exited.value, stderr());
  throw Object.assign(new Error(
    `Extension registration preflight DevTools endpoint timed out: ${
      lastError instanceof Error ? lastError.message : String(lastError ?? "endpoint unavailable")
    }${stderr() ? `; chromium=${stderr().trim()}` : ""}`,
  ), {
    status: 409,
    code: "EXTENSION_REGISTRATION_PREFLIGHT_ENDPOINT_TIMEOUT",
  });
}

async function fetchLoopbackJson(url: string, timeoutMs: number): Promise<unknown> {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("DevTools HTTP endpoint must use IPv4 loopback");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetch(parsed, { signal: controller.signal });
    if (!response.ok) throw new Error(`DevTools endpoint returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function loopbackWebSocketUrl(value: unknown, expectedPort: number, kind: string): string {
  if (typeof value !== "string") throw new Error(`DevTools ${kind} WebSocket URL is missing`);
  const parsed = new URL(value);
  if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
    throw new Error(`DevTools ${kind} WebSocket URL uses an invalid protocol`);
  }
  const expectedPath = kind === "browser" ? "browser" : "page";
  if (!(new RegExp(`^/devtools/${expectedPath}/[A-Za-z0-9._-]+$`)).test(parsed.pathname)) {
    throw new Error(`DevTools ${kind} WebSocket URL uses an invalid path`);
  }
  // Never trust the host returned by the debugging endpoint. Preserve only its validated path and force
  // the transport back onto the exact IPv4 loopback port Chromium published in DevToolsActivePort.
  return `ws://127.0.0.1:${expectedPort}${parsed.pathname}${parsed.search}`;
}

export type RawCdpConnection = {
  send: (method: string, params: Record<string, unknown>) => Promise<unknown>;
};

/** @internal Exported for deterministic extension-registration command tests. */
export async function loadUnpackedExtensionRegistrations(
  connection: RawCdpConnection,
  registrations: ExtensionLaunchRegistration[],
): Promise<void> {
  for (const registration of registrations) assertRegistrationPreflightLoad(registration);
  for (const registration of registrations) {
    const result = await connection.send("Extensions.loadUnpacked", { path: registration.runtimePath });
    const loadedId = readLoadedExtensionId(result);
    if (loadedId !== registration.browserExtensionId) {
      throw registrationPreflightLoadError(
        registration,
        `Chromium returned extension ID ${loadedId ?? "<missing>"}`,
      );
    }
  }
}

/** @internal Exported for deterministic WebSocket failure/timeout tests. */
export async function withRawCdpConnection<Result>(
  url: string,
  timeoutMs: number,
  work: (connection: RawCdpConnection) => Promise<Result>,
): Promise<Result> {
  const parsed = new URL(url);
  if (parsed.protocol !== "ws:" || parsed.hostname !== "127.0.0.1") {
    throw new Error("DevTools WebSocket must use IPv4 loopback");
  }
  if (typeof WebSocket !== "function") {
    throw Object.assign(new Error("The Node.js WebSocket API is unavailable"), {
      status: 409,
      code: "EXTENSION_REGISTRATION_PREFLIGHT_WEBSOCKET_UNAVAILABLE",
    });
  }
  const socket = new WebSocket(parsed);
  try {
    await boundedRegistrationPreflightOperation(new Promise<void>((resolve, reject) => {
      const opened = () => {
        cleanup();
        resolve();
      };
      const failed = () => {
        cleanup();
        reject(new Error("DevTools WebSocket failed to open"));
      };
      const closed = () => {
        cleanup();
        reject(new Error("DevTools WebSocket closed before opening"));
      };
      const cleanup = () => {
        socket.removeEventListener("open", opened);
        socket.removeEventListener("error", failed);
        socket.removeEventListener("close", closed);
      };
      socket.addEventListener("open", opened);
      socket.addEventListener("error", failed);
      socket.addEventListener("close", closed);
    }), timeoutMs, "WebSocket open");

    let commandId = 0;
    const connection: RawCdpConnection = {
      send: async (method, params) => {
        const id = ++commandId;
        const response = new Promise<unknown>((resolve, reject) => {
          const message = (event: MessageEvent) => {
            try {
              const payload = JSON.parse(String(event.data)) as {
                id?: unknown;
                result?: unknown;
                error?: { message?: unknown };
              };
              if (payload.id !== id) return;
              cleanup();
              if (payload.error) reject(new Error(
                typeof payload.error.message === "string" ? payload.error.message : `${method} failed`,
              ));
              else resolve(payload.result);
            } catch (error) {
              cleanup();
              reject(error);
            }
          };
          const failed = () => {
            cleanup();
            reject(new Error(`DevTools WebSocket failed during ${method}`));
          };
          const closed = () => {
            cleanup();
            reject(new Error(`DevTools WebSocket closed during ${method}`));
          };
          const cleanup = () => {
            socket.removeEventListener("message", message);
            socket.removeEventListener("error", failed);
            socket.removeEventListener("close", closed);
          };
          socket.addEventListener("message", message);
          socket.addEventListener("error", failed);
          socket.addEventListener("close", closed);
          try {
            socket.send(JSON.stringify({ id, method, params }));
          } catch (error) {
            cleanup();
            reject(error);
          }
        });
        return boundedRegistrationPreflightOperation(response, timeoutMs, `WebSocket command ${method}`);
      },
    };
    return await work(connection);
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close();
  }
}

function assertExtensionOrigin(origin: string): void {
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
    throw new Error(`Invalid extension origin for registration preflight: ${origin}`);
  }
}

function assertRegistrationPreflightLoad(registration: ExtensionLaunchRegistration): void {
  assertExtensionOrigin(`chrome-extension://${registration.browserExtensionId}`);
  if (!path.isAbsolute(registration.runtimePath)) {
    throw registrationPreflightLoadError(registration, "runtime path must be absolute");
  }
}

function readLoadedExtensionId(result: unknown): string | undefined {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const id = (result as { id?: unknown }).id;
  return typeof id === "string" ? id : undefined;
}

function registrationPreflightLoadError(
  registration: ExtensionLaunchRegistration,
  detail: string,
): Error {
  return Object.assign(
    new Error(`Extension ${registration.name} preflight load failed: ${detail}`),
    { status: 409, code: "EXTENSION_REGISTRATION_PREFLIGHT_LOAD_FAILED" },
  );
}

async function promiseState<Value>(promise: Promise<Value>): Promise<
  { settled: false } | { settled: true; value: Value }
> {
  const marker = {};
  const result = await Promise.race([promise, Promise.resolve(marker)]);
  return result === marker
    ? { settled: false }
    : { settled: true, value: result as Value };
}

function childExitedBeforeCdp(exit: ChildExit, stderr: string): Error {
  const detail = childExitDetail(exit);
  return Object.assign(new Error(
    `Extension registration preflight Chromium exited before DevTools was ready: ${detail}${
      stderr ? `; chromium=${stderr.trim()}` : ""
    }`,
  ), {
    status: 409,
    code: "EXTENSION_REGISTRATION_PREFLIGHT_EARLY_EXIT",
  });
}

async function boundedRegistrationPreflightOperation<Result>(
  work: Promise<Result>,
  timeoutMs: number,
  operation: string,
): Promise<Result> {
  const settled = work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    settled,
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(1, timeoutMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "fulfilled") return outcome.value;
  if (outcome.kind === "rejected") throw outcome.error;
  throw Object.assign(new Error(`Extension registration preflight ${operation} timed out`), {
    status: 409,
    code: "EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT",
    operation,
  });
}

export async function migrateExtensionRegistrations(
  browser: ExtensionRegistrationMigrationBrowser,
  registrations: ExtensionLaunchRegistration[],
  markReady: (registration: ExtensionLaunchRegistration) => Promise<void>,
  timeoutMs = EXTENSION_REGISTRATION_MIGRATION_TIMEOUT_MS,
): Promise<void> {
  const pending = registrations.filter((registration) => registration.migrationRequired);
  if (pending.length === 0) return;

  const needingToggle: ExtensionLaunchRegistration[] = [];
  for (const registration of pending) {
    if (!(await isRegistrationCurrent(browser, registration, timeoutMs))) needingToggle.push(registration);
  }

  if (needingToggle.length > 0) {
    const first = needingToggle[0]!;
    const managementPage = await boundedExtensionRegistrationMigrationOperation(
      Promise.resolve().then(() => browser.openManagementPage()),
      timeoutMs,
      first,
      "management page open",
    );
    try {
      for (const registration of needingToggle) {
        const current = await boundedExtensionRegistrationMigrationOperation(
          Promise.resolve().then(() => managementPage.inspect(registration.browserExtensionId)),
          timeoutMs,
          registration,
          "management inspection",
        );
        assertManagedRegistration(current, registration, true);
        if (current.enabled) {
          await boundedExtensionRegistrationMigrationOperation(
            Promise.resolve().then(() => managementPage.setEnabled(registration.browserExtensionId, false)),
            timeoutMs,
            registration,
            "disable",
          );
          const disabled = await boundedExtensionRegistrationMigrationOperation(
            Promise.resolve().then(() => managementPage.inspect(registration.browserExtensionId)),
            timeoutMs,
            registration,
            "disabled-state inspection",
          );
          assertManagedRegistration(disabled, registration, false);
          if (disabled.enabled) throw registrationMigrationError(registration, "extension did not become disabled");
        }
        await boundedExtensionRegistrationMigrationOperation(
          Promise.resolve().then(() => managementPage.setEnabled(registration.browserExtensionId, true)),
          timeoutMs,
          registration,
          "enable",
        );
        const enabled = await boundedExtensionRegistrationMigrationOperation(
          Promise.resolve().then(() => managementPage.inspect(registration.browserExtensionId)),
          timeoutMs,
          registration,
          "enabled-state inspection",
        );
        assertManagedRegistration(enabled, registration, false);
        if (!enabled.enabled) throw registrationMigrationError(registration, "extension did not become enabled");
      }
    } finally {
      await boundedExtensionRegistrationMigrationOperation(
        Promise.resolve().then(() => managementPage.close()),
        timeoutMs,
        first,
        "management page close",
      );
    }
  }

  // Verify every pending registration before persisting any completion marker. If one toggle fails,
  // successful earlier registrations remain pending and the next launch can prove them current without
  // toggling them a second time.
  for (const registration of pending) {
    await waitForRegistrationCurrent(browser, registration, timeoutMs);
  }
  for (const registration of pending) {
    await boundedExtensionRegistrationMigrationOperation(
      Promise.resolve().then(() => markReady(registration)),
      timeoutMs,
      registration,
      "completion marker write",
    );
  }
}

async function isRegistrationCurrent(
  browser: ExtensionRegistrationMigrationBrowser,
  registration: ExtensionLaunchRegistration,
  timeoutMs: number,
): Promise<boolean> {
  const expectedUrl = expectedWorkerUrl(registration);
  const workers = await boundedExtensionRegistrationMigrationOperation(
    Promise.resolve().then(() => browser.listWorkers()),
    timeoutMs,
    registration,
    "service-worker enumeration",
  );
  for (const worker of workers) {
    if (worker.url !== expectedUrl) continue;
    try {
      const revision = await boundedExtensionRegistrationMigrationOperation(
        Promise.resolve().then(() => worker.readRuntimeRevision()),
        timeoutMs,
        registration,
        "service-worker lifecycle-state read",
      );
      if (revision === registration.runtimeRevision) return true;
    } catch (error) {
      if ((error as { registrationMigrationTimedOut?: boolean }).registrationMigrationTimedOut) throw error;
      // A stale/missing lifecycle database is a migration signal. The enable toggle below is the only
      // supported way to replace the old registration without touching the profile's global SW storage.
    }
  }
  return false;
}

async function waitForRegistrationCurrent(
  browser: ExtensionRegistrationMigrationBrowser,
  registration: ExtensionLaunchRegistration,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    const remainingBeforeProbe = deadline - Date.now();
    if (remainingBeforeProbe <= 0) break;
    if (await isRegistrationCurrent(browser, registration, remainingBeforeProbe)) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(100, remaining)));
  } while (Date.now() <= deadline);
  throw registrationMigrationError(
    registration,
    `timed out waiting for ${expectedWorkerUrl(registration)} with runtime revision ${registration.runtimeRevision}`,
  );
}

async function boundedExtensionRegistrationMigrationOperation<Result>(
  work: Promise<Result>,
  timeoutMs: number,
  registration: ExtensionLaunchRegistration,
  operation: string,
): Promise<Result> {
  const settled = work.then(
    (value) => ({ kind: "fulfilled" as const, value }),
    (error: unknown) => ({ kind: "rejected" as const, error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    settled,
    new Promise<{ kind: "timeout" }>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(1, timeoutMs));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (outcome.kind === "fulfilled") return outcome.value;
  if (outcome.kind === "rejected") throw outcome.error;
  throw Object.assign(
    registrationMigrationError(registration, `${operation} timed out`),
    { registrationMigrationTimedOut: true, operation },
  );
}

function assertManagedRegistration(
  actual: ExtensionRegistrationManagementInfo,
  registration: ExtensionLaunchRegistration,
  requireModifiable: boolean,
): void {
  if (actual.id !== registration.browserExtensionId) {
    throw registrationMigrationError(
      registration,
      `management returned extension ID ${actual.id || "<missing>"}`,
    );
  }
  if (!actual.path || !sameRuntimePath(actual.path, registration.runtimePath)) {
    throw registrationMigrationError(
      registration,
      `loaded path ${actual.path || "<missing>"} does not match runtime ${registration.runtimePath}`,
    );
  }
  if (requireModifiable && actual.mayDisable !== true) {
    throw registrationMigrationError(registration, "extension cannot be safely enabled or disabled");
  }
}

function sameRuntimePath(actual: string, expected: string): boolean {
  if (!path.isAbsolute(actual) || !path.isAbsolute(expected)) return false;
  const actualPath = path.normalize(path.resolve(actual));
  const expectedPath = path.normalize(path.resolve(expected));
  return process.platform === "win32"
    ? actualPath.toLocaleLowerCase("en-US") === expectedPath.toLocaleLowerCase("en-US")
    : actualPath === expectedPath;
}

function expectedWorkerUrl(registration: ExtensionLaunchRegistration): string {
  const relativePath = registration.workerRelativePath.replace(/\\/g, "/").replace(/^\/+/, "");
  return new URL(relativePath, `chrome-extension://${registration.browserExtensionId}/`).href;
}

function registrationMigrationError(registration: ExtensionLaunchRegistration, detail: string): Error {
  return Object.assign(new Error(`Extension ${registration.name} registration migration failed: ${detail}`), {
    status: 409,
    code: "EXTENSION_REGISTRATION_MIGRATION_FAILED",
  });
}

/** @internal Exported for the production-faithful Chromium registration migration fixture. */
export function playwrightRegistrationMigrationBrowser(
  context: BrowserContext,
): ExtensionRegistrationMigrationBrowser {
  return {
    listWorkers: async () => context.serviceWorkers().map((worker) => ({
      url: worker.url(),
      readRuntimeRevision: () => worker.evaluate(readLifecycleRuntimeRevisionInWorker),
    })),
    openManagementPage: async () => {
      const page = await context.newPage();
      try {
        await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        const evaluate = page.evaluate.bind(page) as unknown as RegistrationPageEvaluator;
        return registrationManagementPage(
          evaluate,
          () => page.close(),
        );
      } catch (error) {
        await page.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

export function puppeteerRegistrationMigrationBrowser(
  browser: PuppeteerBrowser,
): ExtensionRegistrationMigrationBrowser {
  return {
    listWorkers: async () => {
      if (typeof browser.targets !== "function") {
        throw Object.assign(new Error("Puppeteer launcher does not expose service-worker targets"), {
          status: 409,
          code: "EXTENSION_REGISTRATION_MIGRATION_UNSUPPORTED",
        });
      }
      return browser.targets()
        .filter((target) => target.type() === "service_worker")
        .map((target) => ({
          url: target.url(),
          readRuntimeRevision: async () => {
            if (typeof target.worker !== "function") throw new Error("Puppeteer target does not expose its worker");
            const worker = await target.worker();
            if (!worker) throw new Error("Puppeteer service worker is not ready");
            return worker.evaluate(readLifecycleRuntimeRevisionInWorker);
          },
        }));
    },
    openManagementPage: async () => {
      const page = await browser.newPage();
      const controlPage = page as unknown as {
        evaluate?: RegistrationPageEvaluator;
        close?: () => Promise<void>;
      };
      try {
        if (typeof controlPage.evaluate !== "function" || typeof controlPage.close !== "function") {
          throw Object.assign(new Error("Puppeteer launcher does not expose page evaluation controls"), {
            status: 409,
            code: "EXTENSION_REGISTRATION_MIGRATION_UNSUPPORTED",
          });
        }
        await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded", timeout: 30_000 });
        const evaluate = controlPage.evaluate.bind(page) as RegistrationPageEvaluator;
        const close = controlPage.close.bind(page);
        return registrationManagementPage(
          evaluate,
          close,
        );
      } catch (error) {
        await controlPage.close?.call(page).catch(() => undefined);
        throw error;
      }
    },
  };
}

type RegistrationPageEvaluator = <Result, Argument>(
  pageFunction: (argument: Argument) => Result | Promise<Result>,
  argument: Argument,
) => Promise<Result>;

function registrationManagementPage(
  evaluate: RegistrationPageEvaluator,
  close: () => Promise<void>,
): ExtensionRegistrationManagementPage {
  return {
    inspect: (extensionId) => evaluate(inspectManagedExtensionInBrowser, extensionId),
    setEnabled: (extensionId, enabled) => evaluate(
      setManagedExtensionEnabledInBrowser,
      { extensionId, enabled },
    ),
    close,
  };
}

async function inspectManagedExtensionInBrowser(
  extensionId: string,
): Promise<ExtensionRegistrationManagementInfo> {
  const runtime = globalThis as typeof globalThis & {
    chrome?: {
      management?: {
        get?: (
          id: string,
          callback: (info?: { id?: unknown; enabled?: unknown; mayDisable?: unknown }) => void,
        ) => void;
      };
      developerPrivate?: {
        getExtensionsInfo?: (
          options: { includeDisabled: boolean; includeTerminated: boolean },
          callback: (extensions?: Array<{ id?: unknown; path?: unknown }>) => void,
        ) => void;
      };
      runtime?: { lastError?: { message?: string } };
    };
  };
  const chromeApi = runtime.chrome;
  if (typeof chromeApi?.management?.get !== "function") throw new Error("chrome.management.get is unavailable");
  if (typeof chromeApi.developerPrivate?.getExtensionsInfo !== "function") {
    throw new Error("chrome.developerPrivate.getExtensionsInfo is unavailable");
  }
  const management = await new Promise<{ id?: unknown; enabled?: unknown; mayDisable?: unknown }>((resolve, reject) => {
    chromeApi.management!.get!(extensionId, (info) => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) reject(new Error(message));
      else if (!info) reject(new Error(`Extension ${extensionId} is not managed by Chromium`));
      else resolve(info);
    });
  });
  const extensions = await new Promise<Array<{ id?: unknown; path?: unknown }>>((resolve, reject) => {
    chromeApi.developerPrivate!.getExtensionsInfo!(
      { includeDisabled: true, includeTerminated: true },
      (infos) => {
        const message = chromeApi.runtime?.lastError?.message;
        if (message) reject(new Error(message));
        else resolve(infos ?? []);
      },
    );
  });
  const privateInfo = extensions.find((candidate) => candidate.id === extensionId);
  if (!privateInfo) throw new Error(`Extension ${extensionId} is missing from chrome://extensions`);
  if (
    typeof management.id !== "string"
    || typeof management.enabled !== "boolean"
    || typeof management.mayDisable !== "boolean"
  ) throw new Error(`Extension ${extensionId} returned invalid management metadata`);
  return {
    id: management.id,
    enabled: management.enabled,
    mayDisable: management.mayDisable,
    path: typeof privateInfo.path === "string" ? privateInfo.path : undefined,
  };
}

async function setManagedExtensionEnabledInBrowser(
  input: { extensionId: string; enabled: boolean },
): Promise<void> {
  const runtime = globalThis as typeof globalThis & {
    chrome?: {
      management?: {
        setEnabled?: (extensionId: string, enabled: boolean, callback: () => void) => void;
      };
      runtime?: { lastError?: { message?: string } };
    };
  };
  const chromeApi = runtime.chrome;
  if (typeof chromeApi?.management?.setEnabled !== "function") {
    throw new Error("chrome.management.setEnabled is unavailable");
  }
  await new Promise<void>((resolve, reject) => {
    chromeApi.management!.setEnabled!(input.extensionId, input.enabled, () => {
      const message = chromeApi.runtime?.lastError?.message;
      if (message) reject(new Error(message));
      else resolve();
    });
  });
}

async function readLifecycleRuntimeRevisionInWorker(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const openRequest = indexedDB.open("__cbpanel_extension_lifecycle_v1", 1);
    let missingDatabase = false;
    openRequest.onupgradeneeded = () => {
      missingDatabase = true;
      openRequest.transaction?.abort();
    };
    openRequest.onerror = () => reject(new Error(
      missingDatabase ? "Extension lifecycle database is missing" : "Extension lifecycle database could not be opened",
    ));
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains("lifecycle")) {
        database.close();
        reject(new Error("Extension lifecycle store is missing"));
        return;
      }
      const transaction = database.transaction("lifecycle", "readonly");
      const stateRequest = transaction.objectStore("lifecycle").get("state");
      stateRequest.onerror = () => reject(new Error("Extension lifecycle state could not be read"));
      stateRequest.onsuccess = () => {
        database.close();
        const state = stateRequest.result as { runtimeRevision?: unknown } | undefined;
        if (!state || typeof state.runtimeRevision !== "string") {
          reject(new Error("Extension lifecycle runtime revision is missing"));
          return;
        }
        resolve(state.runtimeRevision);
      };
    };
  });
}

export type BrowserEvaluateCallbackSerializationHealth = {
  name: string;
  ok: boolean;
  error?: string;
};

type BrowserEvaluateCallback = (...args: never[]) => unknown;
type BrowserEvaluateCallbackSourceReader = (callback: BrowserEvaluateCallback) => string;

const REGISTRATION_BROWSER_EVALUATE_CALLBACKS = [
  {
    name: "readLifecycleRuntimeRevisionInWorker",
    callback: readLifecycleRuntimeRevisionInWorker,
  },
  {
    name: "inspectManagedExtensionInBrowser",
    callback: inspectManagedExtensionInBrowser,
  },
  {
    name: "setManagedExtensionEnabledInBrowser",
    callback: setManagedExtensionEnabledInBrowser,
  },
] satisfies ReadonlyArray<{
  name: string;
  callback: BrowserEvaluateCallback;
}>;

/** @internal Release-smoke projection for the exact callbacks passed to browser evaluate APIs. */
export function browserEvaluateCallbackSerializationHealth(
  readSource: BrowserEvaluateCallbackSourceReader = (callback) => Function.prototype.toString.call(callback),
): BrowserEvaluateCallbackSerializationHealth[] {
  return REGISTRATION_BROWSER_EVALUATE_CALLBACKS.map(({ name, callback }) => {
    try {
      const source = readSource(callback);
      new Function(`(${source})`);
      return { name, ok: true };
    } catch (error) {
      return {
        name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}

async function loadCloakBrowser(): Promise<CloakBrowserModule> {
  return await import("cloakbrowser");
}

async function loadCloakBrowserPuppeteer(): Promise<CloakBrowserPuppeteerModule> {
  return await import("cloakbrowser/puppeteer");
}

// Resolves true when the work finished inside the budget, false when the budget ran out. The work is not
// cancelled: a close that is merely slow still lands, and its disconnect handler still clears the
// session. The extra catch is what stops that late outcome from surfacing as an unhandled rejection once
// the race has already been decided against it.
async function raceTimeout(work: Promise<unknown>, ms: number): Promise<boolean> {
  const finished = work.then(() => true);
  finished.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      finished,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function publicSession(session: RunningSession): SessionSummary {
  return {
    profileId: session.profileId,
    status: session.status,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    pageUrl: readPageUrl(session) ?? session.pageUrl,
    lastError: session.lastError,
    closeUnconfirmed: session.closeUnconfirmed,
    launch: session.launch,
    events: session.events,
  };
}

// 0.5.4 wraps every public method of the browser, context and page — the synchronous `pages()` and `url()`
// this read is built from included — so a post-handshake licence denial makes it throw, and keeps throwing:
// the wrapper remembers the observed denial for the rest of the launch. `publicSession` feeds
// `listSessions()`, so one denied session would 500 the whole session list and take every healthy session
// down with it. The browser exits on its own a moment later and `watchExternalClose` closes the record; this
// read only has to stop being the thing that breaks. Falling back to the last known URL beats inventing one.
function readPageUrl(session: RunningSession): string | undefined {
  try {
    return session.runtime?.pageUrl();
  } catch {
    return undefined;
  }
}

function pushSessionEvent(session: RunningSession, level: SessionEvent["level"], message: string, detail?: string): void {
  const event: SessionEvent = {
    at: new Date().toISOString(),
    level,
    message,
    detail,
  };
  session.events = [...(session.events ?? []), event].slice(-40);
}

// Upstream already maps a Pro binary's licence exit codes to a readable reason and throws
// CloakBrowserLicenseError instead of the opaque "target/browser closed" the caller would otherwise see.
// What it cannot do is tell the operator where to fix it, so the error gains a code the panel turns into
// a pointer at the core settings. The import is cached — a launch cannot fail before the module loaded.
async function licenseDenialError(error: unknown): Promise<unknown> {
  if (!(await isLicenseDenial(error))) return error;
  return Object.assign(error as Error, { status: 409, code: "BROWSER_CORE_LICENSE_DENIED" });
}

async function isLicenseDenial(error: unknown): Promise<boolean> {
  if (!(error instanceof Error)) return false;
  try {
    const { CloakBrowserLicenseError } = await import("cloakbrowser");
    return error instanceof CloakBrowserLicenseError;
  } catch {
    return false;
  }
}

// The operation names the panel already uses, in the language of the launch errors around it.
function coreOperationText(operation: string): string {
  if (operation === "install") return "安装";
  if (operation === "update") return "更新";
  if (operation === "import-zip") return "导入";
  if (operation === "clear-cache") return "清理缓存";
  return "执行操作";
}

function proxyCheckLaunchError(check: NetworkCheckResult): Error {
  return Object.assign(new Error(`代理出口检测失败，已阻止启动：${formatNetworkCheckDetail(check)}`), {
    status: 409,
    code: "PROXY_CHECK_FAILED",
  });
}

export function formatNetworkCheckDetail(check: NetworkCheckResult, locale = "zh-CN"): string {
  if (!check.ok) return check.error ?? "出口检查失败";
  return networkCheckSummaryText(check, {
    emptyText: "出口检查通过",
    locale,
    separator: " / ",
  });
}

// launchContext() returns a context without pages, and Playwright's non-persistent launch uses
// --no-startup-window: without an explicit page the browser stays invisible even when headed.
export async function getOrCreatePlaywrightPage(context: Pick<BrowserContext, "pages" | "newPage">) {
  return context.pages()[0] ?? (await context.newPage());
}

export async function gotoStartUrl(
  page: { goto: (url: string, options?: GotoOptions) => Promise<unknown> } | undefined,
  startUrl: string,
): Promise<string | undefined> {
  if (!startUrl || !page) return undefined;
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return undefined;
  } catch (error) {
    // Since 0.5.4 a licence denial that resolves after the CDP handshake — an over-cap seat is the case
    // upstream built this for — surfaces on the first page call, and this goto is usually it. The binary is
    // already on its way out, so degrading that to a start-page warning would report a running session over
    // a browser being killed, and bury the one thing the operator can act on. Every other failure is still a
    // warning: a start page that will not load is not a launch that failed.
    if (await isLicenseDenial(error)) throw error;
    return `启动成功，但起始页加载失败：${(error as Error).message}`;
  }
}

async function probeWritableDirectory(directory: string): Promise<{ ok: boolean; detail?: string }> {
  const probePath = path.join(directory, `.cbpanel-preflight-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`);
  const existed = await pathExists(directory);
  try {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(probePath, "ok", "utf8");
    await fs.unlink(probePath);
    if (!existed) {
      try {
        await fs.rmdir(directory);
      } catch {
        // Keep real user data if anything else appeared while probing.
      }
    }
    return { ok: true };
  } catch (error) {
    try {
      await fs.rm(probePath, { force: true });
    } catch {
      // Best-effort cleanup only.
    }
    return { ok: false, detail: (error as Error).message };
  }
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function checkPathExists(inputPath: string): Promise<{ path: string; exists: boolean; detail?: string }> {
  const resolved = path.resolve(inputPath);
  try {
    await fs.access(resolved);
    return { path: inputPath, exists: true };
  } catch (error) {
    return { path: inputPath, exists: false, detail: (error as Error).message };
  }
}
