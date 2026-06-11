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
  buildPlaywrightContextOptions,
  buildPuppeteerPageSetup,
  buildSessionLaunchPlan,
  preflightProfile,
} from "../../src/shared/profile";
import type { BrowserEnvironment, NetworkCheckResult } from "../../src/shared/entities";
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

type BinaryInfoReader = () => Promise<{
  installed: boolean;
  binaryPath: string;
  version: string;
}>;

type SessionServiceOptions = {
  browserDataDir: string;
  readBinaryInfo: BinaryInfoReader;
  extensionService?: ExtensionService;
  readEnvironment?: (id: string) => Promise<BrowserEnvironment | undefined>;
  checkNetwork?: (profile: BrowserProfile) => Promise<NetworkCheckResult>;
  readSettings?: () => Promise<AppSettings>;
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

  async preflight(profile: BrowserProfile): Promise<ProfilePreflightReport> {
    const resolved = await this.resolveRuntimeProfile(profile, { install: false });
    return preflightProfile(resolved.profile, await this.buildPreflightEnvironment(resolved.profile, resolved.extensionErrors));
  }

  async launchProfile(profile: BrowserProfile): Promise<SessionSummary> {
    this.assertCanLaunch();
    const runtimeProfile = (await this.resolveRuntimeProfile(profile, { install: true })).profile;
    this.assertCanLaunch();
    if (this.hasActiveSession(runtimeProfile.id)) {
      throw Object.assign(new Error("该配置已经在运行"), { status: 409 });
    }
    const binary = await this.options.readBinaryInfo();
    this.assertCanLaunch();
    if (!binary.installed) {
      throw Object.assign(new Error("CloakBrowser 内核未安装；请先在运行前检查或设置中安装浏览器内核。"), {
        status: 409,
        code: "BROWSER_CORE_MISSING",
      });
    }

    const session: RunningSession = {
      profileId: runtimeProfile.id,
      status: "launching",
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.sessions.set(runtimeProfile.id, session);
    pushSessionEvent(session, "info", "创建启动请求", runtimeProfile.name);

    try {
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

      session.runtimePromise = this.startRuntime(runtimeProfile, session);
      const runtime = await session.runtimePromise;
      if (session.status !== "launching") return publicSession(session);
      session.runtime = runtime;
      delete session.runtimePromise;
      session.status = "running";
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
      throw error;
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
      const runtime = session.runtime ?? (await session.runtimePromise?.catch(() => undefined));
      await runtime?.close();
      this.markSessionStopped(profileId, "会话已停止");
      return publicSession(session);
    } catch (error) {
      session.status = "error";
      delete session.closingByPanel;
      session.lastError = (error as Error).message;
      pushSessionEvent(session, "error", "停止失败", session.lastError);
      return publicSession(session);
    }
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
  }

  private async buildPreflightEnvironment(
    profile: BrowserProfile,
    extensionErrors: ProfilePreflightEnvironment["extensionErrors"] = [],
  ): Promise<ProfilePreflightEnvironment> {
    const userDataDir = this.profileDataDir(profile);
    const binary = await this.options.readBinaryInfo();
    const [userDataDirProbe, extensionChecks, fontsDirCheck] = await Promise.all([
      profile.mode === "persistent" ? probeWritableDirectory(userDataDir) : Promise.resolve(undefined),
      Promise.all(profile.runtime.extensionPaths.map((extensionPath) => checkPathExists(extensionPath))),
      profile.fingerprint.fontsDir.trim()
        ? checkPathExists(profile.fingerprint.fontsDir.trim())
        : Promise.resolve(undefined),
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
      fontsDirCheck,
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
    extensionErrors: ProfilePreflightEnvironment["extensionErrors"];
  }> {
    if (!this.options.extensionService) return { profile, extensionErrors: [] };
    const environment = await this.options.extensionService.resolveEnvironment(profile.id);
    if (environment.environment.extensionIds.length === 0) return { profile, extensionErrors: [] };

    try {
      const extensionPaths = await this.options.extensionService.ensureExtensionsInstalled(profile.id);
      return {
        profile: {
          ...profile,
          runtime: {
            ...profile.runtime,
            extensionPaths,
          },
        },
        extensionErrors: [],
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
      };
    }
  }

  private profileDataDir(profile: BrowserProfile): string {
    return path.join(this.options.browserDataDir, profile.id);
  }

  private markSessionStopped(profileId: string, detail: string): void {
    const session = this.sessions.get(profileId);
    if (!session || session.status === "stopped" || session.status === "error") return;
    session.status = "stopped";
    session.stoppedAt = new Date().toISOString();
    delete session.runtime;
    delete session.runtimePromise;
    delete session.lastError;
    delete session.closingByPanel;
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

  protected async startRuntime(profile: BrowserProfile, session: RunningSession): Promise<RuntimeHandle> {
    if (profile.runtime.launcher === "puppeteer-browser") {
      return this.startPuppeteerRuntime(profile, session);
    }

    if (profile.runtime.launcher === "playwright-browser") {
      return this.startPlaywrightBrowserRuntime(profile, session);
    }

    return this.startPlaywrightContextRuntime(profile, session);
  }

  private async startPlaywrightContextRuntime(profile: BrowserProfile, session: RunningSession): Promise<RuntimeHandle> {
    await this.applyGithubMirrorFetch();
    const runtime = await loadCloakBrowser();
    const preview = buildLaunchPreview(profile, this.profileDataDir(profile));
    pushSessionEvent(session, "info", "调用 Playwright Context 启动器", preview.launcher);
    const context =
      preview.launcher === "launchPersistentContext"
        ? await runtime.launchPersistentContext(
            preview.options as unknown as Parameters<CloakBrowserModule["launchPersistentContext"]>[0],
          )
        : await runtime.launchContext(preview.options as unknown as Parameters<CloakBrowserModule["launchContext"]>[0]);

    if (!context) throw new Error("CloakBrowser 未返回 BrowserContext");
    this.watchExternalClose(profile.id, context, "close");
    const page = await getOrCreatePlaywrightPage(context, profile.startUrl.trim());
    if (profile.startUrl.trim()) pushSessionEvent(session, "info", "打开起始页", profile.startUrl.trim());
    const warning = await gotoStartUrl(page, profile.startUrl.trim());

    return {
      close: () => context.close(),
      pageUrl: () => context.pages()[0]?.url(),
      warning,
    };
  }

  private async startPlaywrightBrowserRuntime(profile: BrowserProfile, session: RunningSession): Promise<RuntimeHandle> {
    await this.applyGithubMirrorFetch();
    const runtime = await loadCloakBrowser();
    const preview = buildLaunchPreview(profile, this.profileDataDir(profile));
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
      await browser.close();
      throw error;
    }
  }

  private async startPuppeteerRuntime(profile: BrowserProfile, session: RunningSession): Promise<RuntimeHandle> {
    await this.applyGithubMirrorFetch();
    const runtime = await loadCloakBrowserPuppeteer();
    const preview = buildLaunchPreview(profile, this.profileDataDir(profile));
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
      await browser.close();
      throw error;
    }
  }

  private async applyGithubMirrorFetch(): Promise<void> {
    if (!this.options.readSettings) return;
    const settings = normalizeSettings(await this.options.readSettings());
    const binary = await this.options.readBinaryInfo();
    const resolution = await this.githubMirrorProbeService.resolvePrefix(settings, binary.version);
    applyGithubMirrorFetch(settings, resolution?.prefix);
  }
}

async function loadCloakBrowser(): Promise<CloakBrowserModule> {
  return await import("cloakbrowser");
}

async function loadCloakBrowserPuppeteer(): Promise<CloakBrowserPuppeteerModule> {
  return await import("cloakbrowser/puppeteer");
}

function publicSession(session: RunningSession): SessionSummary {
  return {
    profileId: session.profileId,
    status: session.status,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    pageUrl: session.runtime?.pageUrl() ?? session.pageUrl,
    lastError: session.lastError,
    launch: session.launch,
    events: session.events,
  };
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

function proxyCheckLaunchError(check: NetworkCheckResult): Error {
  return Object.assign(new Error(`代理出口检测失败，已阻止启动：${formatNetworkCheckDetail(check)}`), {
    status: 409,
    code: "PROXY_CHECK_FAILED",
  });
}

export function formatNetworkCheckDetail(check: NetworkCheckResult): string {
  if (!check.ok) return check.error ?? "出口检查失败";
  const detail = [
    check.ip ? `IP ${check.ip}` : "",
    check.trace?.loc ? `地区 ${check.trace.loc}` : check.geo?.countryCode ? `国家 ${check.geo.countryCode}` : "",
    check.trace?.colo ? `机房 ${check.trace.colo}` : "",
    check.trace?.providerName ? `端点 ${check.trace.providerName}` : "",
    !check.trace?.loc && check.geo?.timezone ? `时区 ${check.geo.timezone}` : "",
    !check.trace?.loc && check.geo?.locale ? `语言 ${check.geo.locale}` : "",
    check.latencyMs !== undefined ? `${check.latencyMs}ms` : "",
  ].filter(Boolean);
  return detail.join(" / ") || "出口检查通过";
}

async function getOrCreatePlaywrightPage(context: BrowserContext, startUrl: string) {
  return context.pages()[0] ?? (startUrl ? await context.newPage() : undefined);
}

async function gotoStartUrl(
  page: { goto: (url: string, options?: GotoOptions) => Promise<unknown> } | undefined,
  startUrl: string,
): Promise<string | undefined> {
  if (!startUrl || !page) return undefined;
  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    return undefined;
  } catch (error) {
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
