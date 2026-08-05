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
import type { ExtensionService } from "./extensionService";
import { applyGithubMirrorFetch } from "./githubMirrorFetch";
import { GithubMirrorProbeService } from "./githubMirrorProbeService";

type RuntimeHandle = {
  close: () => Promise<void>;
  pageUrl: () => string | undefined;
  warning?: string;
};

type RunningSession = SessionSummary & {
  runtime?: RuntimeHandle;
  runtimePromise?: Promise<RuntimeHandle>;
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
  on?: (event: "disconnected", handler: () => void) => void;
  once?: (event: "disconnected", handler: () => void) => void;
};

type PuppeteerPage = {
  url: () => string;
  goto: (url: string, options?: GotoOptions) => Promise<unknown>;
  setUserAgent?: (userAgent: string) => Promise<void>;
  setViewport?: (viewport: { width: number; height: number }) => Promise<void>;
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
    return new Set(
      [...this.sessions.values()]
        .filter((session) =>
          session.status === "running"
          || session.status === "launching"
          || session.status === "stopping"
          || session.closeUnconfirmed === true)
        .map((session) => session.profileId),
    );
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
    const session: RunningSession = {
      profileId: profile.id,
      status: "launching",
      startedAt: new Date().toISOString(),
      events: [],
      // Carried over, not dropped: the record it replaces may be one whose close was never confirmed, and
      // that older process can still be holding these files. Dropping it here released the hold the
      // moment the user pressed Launch — and if this launch then failed, every destructive operation
      // would think the files were free.
      closeUnconfirmed: this.sessions.get(profile.id)?.closeUnconfirmed,
    };
    this.sessions.set(profile.id, session);
    pushSessionEvent(session, "info", "创建启动请求", profile.name);

    try {
      const resolved = await this.resolveRuntimeProfile(profile, { install: true });
      const runtimeProfile = resolved.profile;
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
      const userDataDir = this.profileDataDir(runtimeProfile);
      session.launch = buildSessionLaunchPlan(runtimeProfile, userDataDir);
      pushSessionEvent(session, "info", "启动计划已生成", `${session.launch.runtimeLauncher} -> ${session.launch.sdkLauncher}`);
      if (session.status === "stopped") return publicSession(session);

      session.runtimePromise = this.startRuntime(runtimeProfile, session, binary);
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
        this.markCloseUnconfirmed(profileId, `停止超时（${Math.round(this.closeTimeoutMs() / 1000)} 秒）`, "停止超时");
        // The close keeps running, and its late outcome is the only thing that can clear this without a
        // browser event. Resolving means there was nothing left to close — a launch that never produced a
        // runtime — or that the close finally landed; either way the files are free.
        void closing.then(
          () => this.markSessionStopped(profileId, "会话已停止"),
          (error) => this.recordLateCloseFailure(profileId, error),
        );
        return publicSession(session);
      }
      this.markSessionStopped(profileId, "会话已停止");
      return publicSession(session);
    } catch (error) {
      // A close that threw is exactly as unconfirmed as one that ran out of time: the attempt failed, so
      // nothing observed the process exit and it may still hold its files. The diagnosis survives in the
      // event log even after a later close event clears the session.
      this.markCloseUnconfirmed(profileId, `停止失败：${(error as Error).message}`, "停止失败");
      return publicSession(session);
    }
  }

  private markCloseUnconfirmed(profileId: string, reason: string, event: string): void {
    const session = this.sessions.get(profileId);
    // The browser's own close event can land inside the budget and confirm the stop already. Overwriting
    // that confirmation is permanent — no second event will ever arrive — so the session would hold every
    // file-touching service for the rest of the process.
    if (!session || session.status === "stopped") return;
    session.status = "error";
    session.closeUnconfirmed = true;
    delete session.closingByPanel;
    session.lastError = `${reason}：浏览器可能仍在运行。可再次点击停止，或手动结束该浏览器进程。`;
    pushSessionEvent(session, "error", event, session.lastError);
  }

  private recordLateCloseFailure(profileId: string, error: unknown): void {
    if (!this.sessions.get(profileId)?.closeUnconfirmed) return;
    this.markCloseUnconfirmed(profileId, `停止失败：${(error as Error).message}`, "停止失败");
  }

  // Both awaits are inside the budget on purpose: a launch that never finishes leaves runtimePromise
  // pending, which wedged the stop before close() was even reached.
  private async closeSessionRuntime(session: RunningSession): Promise<void> {
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
    options: { install: boolean },
  ): Promise<{
    profile: BrowserProfile;
    extensionErrors: Array<{ name: string; detail: string }>;
    extensionWarnings: Array<{ name: string; detail: string }>;
  }> {
    if (!this.options.extensionService) return { profile, extensionErrors: [], extensionWarnings: [] };
    const environment = await this.options.extensionService.resolveEnvironment(profile.id);
    if (environment.environment.extensionIds.length === 0) return { profile, extensionErrors: [], extensionWarnings: [] };

    try {
      const ensured = await this.options.extensionService.ensureExtensionsInstalled(profile.id);
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
      };
    }
  }

  private profileDataDir(profile: BrowserProfile): string {
    return path.join(this.options.browserDataDir, profile.id);
  }

  // Protected, not private: watchExternalClose routes the browser's own exit through here, and the tests
  // stand in for that event the same way they stand in for startRuntime.
  protected markSessionStopped(profileId: string, detail: string): void {
    const session = this.sessions.get(profileId);
    // A stop that ran out of time is the one error worth overwriting: it recorded that the close was
    // never confirmed, so a disconnect arriving later *is* that confirmation. Without this exception the
    // session would keep every file-touching service blocked until the panel restarted.
    if (!session || session.status === "stopped") return;
    if (session.status === "error" && !session.closeUnconfirmed) return;
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    delete session.runtime;
    delete session.runtimePromise;
    delete session.lastError;
    delete session.closingByPanel;
    delete session.closeUnconfirmed;
    pushSessionEvent(session, "info", detail);
    this.sessions.set(profileId, session);
  }

  private watchExternalClose(profileId: string, target: object, eventName: string): void {
    const source = target as {
      once?: (event: string, handler: () => void) => void;
      on?: (event: string, handler: () => void) => void;
    };
    const onClosed = () => {
      const session = this.sessions.get(profileId);
      this.markSessionStopped(profileId, session?.closingByPanel ? "会话已停止" : "浏览器窗口已关闭");
    };
    if (typeof source.once === "function") {
      source.once(eventName, onClosed);
      return;
    }
    if (typeof source.on === "function") source.on(eventName, onClosed);
  }

  protected async startRuntime(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
  ): Promise<RuntimeHandle> {
    if (profile.runtime.launcher === "puppeteer-browser") {
      return this.startPuppeteerRuntime(profile, session, binary);
    }

    if (profile.runtime.launcher === "playwright-browser") {
      return this.startPlaywrightBrowserRuntime(profile, session, binary);
    }

    return this.startPlaywrightContextRuntime(profile, session, binary);
  }

  private async startPlaywrightContextRuntime(
    profile: BrowserProfile,
    session: RunningSession,
    binary: BrowserCoreRuntimeInfo,
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
    this.watchExternalClose(profile.id, context, "close");

    try {
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
    this.watchExternalClose(profile.id, browser, "disconnected");
    let context: BrowserContext | undefined;

    try {
      context = await browser.newContext(buildPlaywrightContextOptions(profile));
      this.watchExternalClose(profile.id, context, "close");
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
    this.watchExternalClose(profile.id, browser, "disconnected");
    let page: PuppeteerPage | undefined;

    try {
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
