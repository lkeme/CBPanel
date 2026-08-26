import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { NetworkCheckResult } from "../../src/shared/entities";
import { defaultProfile, type BrowserProfile } from "../../src/shared/profile";
import { normalizeSettings } from "../../src/shared/settings";
import type { ExtensionLaunchRegistration, ExtensionService } from "./extensionService";
import { restoreGithubMirrorFetch } from "./githubMirrorFetch";
import {
  type ExtensionRegistrationMigrationBrowser,
  type ExtensionRegistrationPreflightLaunchOptions,
  type ExtensionRegistrationPreflightProcess,
  buildExtensionRegistrationPreflightLaunchOptions,
  formatNetworkCheckDetail,
  getOrCreatePlaywrightPage,
  gotoStartUrl,
  loadUnpackedExtensionRegistrations,
  migrateExtensionRegistrations,
  parseDevToolsActivePort,
  prepareExtensionRegistrationPreflightUserDataDir,
  puppeteerRegistrationMigrationBrowser,
  rawCdpRegistrationPreflightProcess,
  SessionService,
  withRawCdpConnection,
} from "./sessionService";

type TestRuntimeHandle = {
  close: () => Promise<void>;
  pageUrl: () => string | undefined;
};

class ControlledRuntimeSessionService extends SessionService {
  closeCount = 0;
  private resolveRuntime!: (runtime: TestRuntimeHandle) => void;
  private readonly runtimeReady = new Promise<TestRuntimeHandle>((resolve) => {
    this.resolveRuntime = resolve;
  });

  protected override async startRuntime(_profile: BrowserProfile): Promise<TestRuntimeHandle> {
    return this.runtimeReady;
  }

  releaseRuntime(): void {
    this.resolveRuntime({
      close: async () => {
        this.closeCount += 1;
      },
      pageUrl: () => "about:blank",
    });
  }
}

test("formatNetworkCheckDetail prefers trace exit facts over legacy geo fields", () => {
  const detail = formatNetworkCheckDetail({
    checkedAt: "2026-06-03T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.42",
    latencyMs: 88,
    geo: {
      countryCode: "JP",
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    },
    trace: {
      providerId: "cloudflare-www",
      providerName: "Cloudflare",
      providerUrl: "https://www.cloudflare.com/cdn-cgi/trace",
      loc: "SG",
      colo: "SIN",
    },
    source: "environment-check",
  } satisfies NetworkCheckResult);

  assert.equal(detail, "203.0.113.42 / 新加坡 (SG) / SIN / 88ms");
  assert.equal(detail.includes("Cloudflare"), false);
});

test("launchProfile blocks launch when enabled proxy check fails", async () => {
  const base = defaultProfile();
  const profile = {
    ...base,
    proxy: {
      ...base.proxy,
      enabled: true,
      scheme: "http" as const,
      host: "127.0.0.1",
      port: "9",
    },
  };
  const service = new SessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
    checkNetwork: async () => ({
      checkedAt: "2026-06-03T00:00:00.000Z",
      ok: false,
      source: "environment-check",
      error: "代理连接已关闭，出口检测失败。请确认代理仍可用后重试。",
    }),
  });

  await assert.rejects(
    service.launchProfile(profile),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.equal((error as { code?: string }).code, "PROXY_CHECK_FAILED");
      assert.match((error as Error).message, /已阻止启动/);
      return true;
    },
  );

  const session = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(session?.status, "error");
  assert.match(session?.lastError ?? "", /已阻止启动/);
  assert.equal(session?.events?.some((event) => event.level === "warn"), true);
});

// The mirror image of the cache guards: those refuse to delete a build a browser may be using, this
// refuses to start a browser while a build is being written. Upstream's launch calls ensureBinary itself,
// and an explicit update unfreezes CLOAKBROWSER_AUTO_UPDATE process-wide, so a launch inside that window
// starts a second download into the cache the update is writing.
test("launching is refused while the browser core cache is being written", async () => {
  // A service whose startRuntime resolves, so a regression fails an assertion instead of hanging on a
  // runtime the test never releases.
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
    activeCacheOperation: () => "update",
  });
  const profile = defaultProfile({ id: "launch-during-update-test" });

  const refusal = await service.launchProfile(profile).then(() => undefined, (error: Error & { status?: number; code?: string }) => error);

  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "BROWSER_CORE_OPERATION_IN_PROGRESS");
  assert.match(refusal?.message ?? "", /更新/);
  // Refused before anything was registered, so no half-session is left behind for the probes to see.
  assert.deepEqual(service.listSessions(), []);
});

test("launching is refused while an environment data operation is queued or running", async () => {
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    activeDataOperation: () => "导入或导出环境包",
  });

  const refusal = await service.launchProfile(defaultProfile({ id: "launch-during-data-operation" }))
    .then(() => undefined, (error: Error & { status?: number; code?: string }) => error);

  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS");
  assert.match(refusal?.message ?? "", /环境包/);
  assert.deepEqual(service.listSessions(), []);
});

test("an operation that starts mid-launch still stops the runtime being created", async () => {
  let operation: string | undefined;
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => {
      // Stands in for an update that begins while the launch is resolving its extensions and binary info:
      // assertCanLaunch runs again right after this read.
      operation = "install";
      return { installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" };
    },
    activeCacheOperation: () => operation,
  });
  const profile = defaultProfile({ id: "operation-mid-launch-test" });

  const refusal = await service.launchProfile(profile).then(() => undefined, (error: Error & { status?: number }) => error);

  assert.equal(refusal?.status, 409);
  assert.match(refusal?.message ?? "", /安装/);
  assert.equal(service.closeCalls, 0);
  assert.equal(service.listSessions().find((item) => item.profileId === profile.id)?.status, "error");
});

test("a data operation that starts mid-launch is rechecked before runtime creation", async () => {
  let operation: string | undefined;
  const base = defaultProfile({ id: "data-operation-mid-launch-test" });
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async () => {
      operation = "恢复应用备份";
      return { checkedAt: new Date().toISOString(), ok: true, source: "environment-check" };
    },
    activeDataOperation: () => operation,
  });
  const profile = {
    ...base,
    proxy: { ...base.proxy, enabled: true, host: "127.0.0.1", port: "8080" },
  };

  const refusal = await service.launchProfile(profile)
    .then(() => undefined, (error: Error & { status?: number; code?: string }) => error);

  assert.equal(refusal?.status, 409);
  assert.equal(refusal?.code, "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS");
  assert.equal(service.closeCalls, 0);
  assert.equal(service.listSessions().find((item) => item.profileId === profile.id)?.status, "error");
});

test("stopAll waits for a launching runtime before closing it", async () => {
  const service = new ControlledRuntimeSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
  });
  const profile = defaultProfile({ id: "launching-stop-test" });

  const launch = service.launchProfile(profile);
  // The session is registered before the runtime resolves (parallel-launch guard), so wait for
  // the launch plan too: it is written in the same synchronous block that starts the runtime.
  await waitFor(() => service.listSessions().some((session) =>
    session.profileId === profile.id && session.status === "launching" && Boolean(session.launch)));

  const stopAll = service.stopAll();
  await waitFor(() => service.listSessions().some((session) => session.profileId === profile.id && session.status === "stopping"));
  service.releaseRuntime();

  await Promise.all([launch, stopAll]);
  const session = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(service.closeCount, 1);
  assert.equal(session?.status, "stopped");
});

test("launchProfile surfaces extension launch warnings as a warn session event", async () => {
  const profile = defaultProfile({ id: "extension-warning-launch-test" });
  const service = new ControlledRuntimeSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
    extensionService: {
      resolveEnvironment: async () => ({
        environment: { extensionIds: ["extension-1"] },
        profile: profile.runtime,
      }),
      ensureExtensionsInstalled: async () => ({
        paths: ["D:/extensions/loaded"],
        warnings: [{ name: "Pending Extension", reason: "有可用更新未安装，本次启动仍使用当前版本" }],
      }),
    } as unknown as ExtensionService,
  });

  const launch = service.launchProfile(profile);
  await waitFor(() => service.listSessions().some((session) => session.profileId === profile.id && Boolean(session.launch)));
  service.releaseRuntime();
  const session = await launch;

  const warnEvent = session.events?.find((event) => event.level === "warn");
  assert.equal(warnEvent?.message, "扩展启动警告");
  assert.match(warnEvent?.detail ?? "", /Pending Extension: 有可用更新未安装/);
  assert.equal(session.status, "running");
});

test("launchProfile propagates ensured registration records into runtime startup", async () => {
  const profile = defaultProfile({ id: "registration-propagation-launch-test" });
  const registration = extensionRegistration({ migrationRequired: false });
  const service = new RegistrationCaptureSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: {
      resolveEnvironment: async () => ({
        environment: { extensionIds: ["extension-1"] },
        profile: profile.runtime,
      }),
      ensureExtensionsInstalled: async () => ({
        paths: [registration.runtimePath],
        warnings: [],
        registrations: [registration],
      }),
    } as unknown as ExtensionService,
  });

  const launched = await service.launchProfile(profile);

  assert.equal(launched.status, "running");
  assert.deepEqual(service.registrations, [registration]);
});

test("a pending registration fails instead of silently using an unsupported launcher", async () => {
  const base = defaultProfile({ id: "unsupported-registration-launch-test" });
  const profile = {
    ...base,
    runtime: { ...base.runtime, launcher: "playwright-browser" as const },
  };
  const registration = extensionRegistration();
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: {
      resolveEnvironment: async () => ({
        environment: { extensionIds: ["extension-1"] },
        profile: profile.runtime,
      }),
      ensureExtensionsInstalled: async () => ({
        paths: [registration.runtimePath],
        warnings: [],
        registrations: [registration],
      }),
    } as unknown as ExtensionService,
  });

  await assert.rejects(
    service.launchProfile(profile),
    (error) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_MIGRATION_UNSUPPORTED");
      return true;
    },
  );
  assert.equal(service.closeCalls, 0);
});

test("launchProfile does not probe or install GitHub mirrors for Pro binaries", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    seenUrls.push(url);
    return new Response("unexpected mirror probe", { status: 500 });
  }) as typeof fetch;

  const service = new ControlledRuntimeSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "147.0.7700.1",
      tier: "pro",
    }),
    readSettings: async () => normalizeSettings({
      networkTrace: {
        providerId: "cloudflare-www",
        customProviderUrl: "",
        timeoutSeconds: 8,
        githubMirrorProviderId: "auto-best",
        customGithubMirrorPrefix: "",
      },
    }),
  });
  const profile = defaultProfile({ id: "pro-no-mirror-test" });

  try {
    const launch = service.launchProfile(profile);
    await waitFor(() => service.listSessions().some((session) => session.profileId === profile.id && session.status === "launching"));
    service.releaseRuntime();
    await launch;

    assert.deepEqual(seenUrls, []);
  } finally {
    restoreGithubMirrorFetch();
    globalThis.fetch = originalFetch;
  }
});

// Fails the way a real runtime start fails, so the launch catch sees the error a browser would raise.
class FailingRuntimeSessionService extends SessionService {
  constructor(options: ConstructorParameters<typeof SessionService>[0], private readonly failure: Error) {
    super(options);
  }

  protected override async startRuntime(): Promise<TestRuntimeHandle> {
    throw this.failure;
  }
}

// A browser whose licence was denied after the handshake. The wrapper's guard makes the reads pageUrl() is
// built from throw from that point on, so the fake reproduces the state rather than the mechanism.
class ThrowingPageUrlSessionService extends SessionService {
  private deniedProfileId?: string;

  protected override async startRuntime(profile: BrowserProfile): Promise<TestRuntimeHandle> {
    const profileId = profile.id;
    return {
      close: async () => undefined,
      pageUrl: () => {
        if (this.deniedProfileId === profileId) throw new Error("并发会话数已达上限");
        return "about:blank";
      },
    };
  }

  denyPageUrl(profileId: string): void {
    this.deniedProfileId = profileId;
  }
}

// A browser that will not exit: close() never settles, which is the realistic wedge on Windows when a
// renderer refuses to go. The budget is shortened so the test does not sit out the real one.
class WedgedCloseSessionService extends SessionService {
  closeCalls = 0;
  private readonly rejectClose: boolean;

  constructor(options: ConstructorParameters<typeof SessionService>[0], rejectClose = false) {
    super(options);
    this.rejectClose = rejectClose;
  }

  protected override closeTimeoutMs(): number {
    return 40;
  }

  protected override async startRuntime(): Promise<TestRuntimeHandle> {
    return {
      close: () => {
        this.closeCalls += 1;
        return this.rejectClose
          ? Promise.reject(new Error("关闭失败"))
          : new Promise<void>(() => undefined);
      },
      pageUrl: () => "about:blank",
    };
  }

  // Stands in for watchExternalClose: the browser finally exiting, or the operator ending the process.
  simulateExternalClose(profileId: string): void {
    this.markSessionStopped(profileId, "浏览器窗口已关闭");
  }
}

class RegistrationCaptureSessionService extends SessionService {
  registrations: ExtensionLaunchRegistration[] = [];

  protected override async startRuntime(
    _profile: BrowserProfile,
    _session: unknown,
    _binary: unknown,
    registrations: ExtensionLaunchRegistration[],
  ): Promise<TestRuntimeHandle> {
    this.registrations = registrations;
    return {
      close: async () => undefined,
      pageUrl: () => "about:blank",
    };
  }
}

class RegistrationPreflightSessionService extends SessionService {
  formalStarts = 0;
  preflightLaunches = 0;
  preflightOptions?: ExtensionRegistrationPreflightLaunchOptions;
  readonly order: string[] = [];

  constructor(
    options: ConstructorParameters<typeof SessionService>[0],
    private readonly launchPreflight: (
      options: ExtensionRegistrationPreflightLaunchOptions,
    ) => Promise<ExtensionRegistrationPreflightProcess>,
    private readonly formalBrowser?: ExtensionRegistrationMigrationBrowser,
    private readonly preflightTimeoutMs = 8,
  ) {
    super(options);
  }

  protected override registrationPreflightTimeoutMs(): number {
    return this.preflightTimeoutMs;
  }

  protected override registrationPreflightLaunchGraceMs(): number {
    return 2;
  }

  protected override closeTimeoutMs(): number {
    return 30;
  }

  protected override async launchRegistrationPreflightProcess(
    options: ExtensionRegistrationPreflightLaunchOptions,
  ): Promise<ExtensionRegistrationPreflightProcess> {
    this.preflightLaunches += 1;
    this.preflightOptions = options;
    this.order.push("preflight-launch");
    return this.launchPreflight(options);
  }

  protected override async startRuntime(
    _profile: BrowserProfile,
    _session: unknown,
    _binary: unknown,
    registrations: ExtensionLaunchRegistration[],
  ): Promise<TestRuntimeHandle> {
    this.formalStarts += 1;
    this.order.push("formal-start");
    if (this.formalBrowser) await this.migrateExtensionRegistrations(this.formalBrowser, registrations);
    return {
      close: async () => undefined,
      pageUrl: () => "about:blank",
    };
  }
}

function registrationPreflightProcess(options: {
  onSend?: (command: string, params: Record<string, unknown>) => Promise<unknown>;
  onFinish?: () => Promise<void>;
  onClose?: () => Promise<void>;
  order?: string[];
} = {}) {
  const commands: Array<{ command: string; params: Record<string, unknown> }> = [];
  let finishCalls = 0;
  let closeCalls = 0;
  let finishPromise: Promise<void> | undefined;
  let closePromise: Promise<void> | undefined;
  const process: ExtensionRegistrationPreflightProcess = {
    clearServiceWorkers: async (origins) => {
      for (const origin of origins) {
        const command = "Storage.clearDataForOrigin";
        const params = { origin, storageTypes: "service_workers" };
        commands.push({ command, params });
        options.order?.push("preflight-clear");
        await options.onSend?.(command, params);
      }
    },
    loadUnpackedExtensions: async (registrations) => {
      await loadUnpackedExtensionRegistrations({
        send: async (command, params) => {
          commands.push({ command, params });
          options.order?.push("preflight-load");
          if (!options.onSend) {
            const registration = registrations.find((candidate) => candidate.runtimePath === params.path);
            return { id: registration?.browserExtensionId };
          }
          return options.onSend(command, params);
        },
      }, registrations);
    },
    finish: () => {
      finishPromise ??= (async () => {
        finishCalls += 1;
        options.order?.push("preflight-finish");
        await options.onFinish?.();
      })();
      return finishPromise;
    },
    close: () => {
      closePromise ??= (async () => {
        closeCalls += 1;
        options.order?.push("preflight-close");
        await options.onClose?.();
      })();
      return closePromise;
    },
    pageUrl: () => "about:blank",
  };
  return { process, commands, finishCalls: () => finishCalls, closeCalls: () => closeCalls };
}

function extensionServiceWithRegistrations(
  profile: BrowserProfile,
  registrations: ExtensionLaunchRegistration[],
  marked: ExtensionLaunchRegistration[],
): ExtensionService {
  return {
    resolveEnvironment: async () => ({
      environment: { extensionIds: registrations.map((_, index) => `extension-${index + 1}`) },
      profile: profile.runtime,
    }),
    ensureExtensionsInstalled: async () => ({
      paths: registrations.map((registration) => registration.runtimePath),
      warnings: [],
      registrations,
    }),
    markRegistrationReady: async (registration: ExtensionLaunchRegistration) => {
      marked.push(registration);
    },
  } as unknown as ExtensionService;
}

function extensionRegistration(
  overrides: Partial<ExtensionLaunchRegistration> = {},
): ExtensionLaunchRegistration {
  return {
    name: "Migration Extension",
    runtimePath: path.resolve("data/extension-runtimes/migration-test/extension-test"),
    browserExtensionId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workerRelativePath: "cbpanel_lifecycle/worker-test.js",
    runtimeRevision: "runtime-revision-test",
    signature: "a".repeat(64),
    migrationRequired: true,
    ...overrides,
  };
}

function migrationHarness(
  registration: ExtensionLaunchRegistration,
  options: {
    enabled?: boolean;
    managementId?: string;
    managementPath?: string;
    mayDisable?: boolean;
    workerRevision?: string;
    workerUrl?: string;
    publishWorkerOnEnable?: boolean;
    failEnableCount?: number;
  } = {},
) {
  let enabled = options.enabled ?? true;
  let workerRevision = options.workerRevision;
  let workerUrl = options.workerUrl ?? (workerRevision ? registrationWorkerUrl(registration) : undefined);
  let failEnableCount = options.failEnableCount ?? 0;
  const toggles: boolean[] = [];
  let openCount = 0;
  let closeCount = 0;
  let inspectCount = 0;
  const browser: ExtensionRegistrationMigrationBrowser = {
    listWorkers: async () => workerUrl ? [{
      url: workerUrl,
      readRuntimeRevision: async () => workerRevision ?? "",
    }] : [],
    openManagementPage: async () => {
      openCount += 1;
      return {
        inspect: async () => {
          inspectCount += 1;
          return {
            id: options.managementId ?? registration.browserExtensionId,
            path: options.managementPath ?? registration.runtimePath,
            enabled,
            mayDisable: options.mayDisable ?? true,
          };
        },
        setEnabled: async (_extensionId, nextEnabled) => {
          toggles.push(nextEnabled);
          if (nextEnabled && failEnableCount > 0) {
            failEnableCount -= 1;
            throw new Error("enable failed");
          }
          enabled = nextEnabled;
          if (nextEnabled && options.publishWorkerOnEnable !== false) {
            workerUrl = registrationWorkerUrl(registration);
            workerRevision = registration.runtimeRevision;
          }
          if (!nextEnabled) {
            workerUrl = undefined;
            workerRevision = undefined;
          }
        },
        close: async () => {
          closeCount += 1;
        },
      };
    },
  };
  return {
    browser,
    toggles,
    enabled: () => enabled,
    openCount: () => openCount,
    closeCount: () => closeCount,
    inspectCount: () => inspectCount,
  };
}

function registrationWorkerUrl(registration: ExtensionLaunchRegistration): string {
  return new URL(
    registration.workerRelativePath,
    `chrome-extension://${registration.browserExtensionId}/`,
  ).href;
}

test("ready registrations are a no-op", async () => {
  const registration = extensionRegistration({ migrationRequired: false });
  let marks = 0;
  await migrateExtensionRegistrations({
    listWorkers: async () => {
      throw new Error("workers must not be inspected");
    },
    openManagementPage: async () => {
      throw new Error("management page must not be opened");
    },
  }, [registration], async () => {
    marks += 1;
  });
  assert.equal(marks, 0);
});

test("a pending current worker is verified and marked without toggling", async () => {
  const registration = extensionRegistration();
  const harness = migrationHarness(registration, { workerRevision: registration.runtimeRevision });
  const marked: ExtensionLaunchRegistration[] = [];

  await migrateExtensionRegistrations(harness.browser, [registration], async (ready) => {
    marked.push(ready);
  });

  assert.deepEqual(marked, [registration]);
  assert.equal(harness.openCount(), 0);
  assert.deepEqual(harness.toggles, []);
});

test("a stale worker registration is disabled, enabled, verified, and marked", async () => {
  const registration = extensionRegistration();
  const harness = migrationHarness(registration, { workerRevision: "old-runtime-revision" });
  const marked: ExtensionLaunchRegistration[] = [];

  await migrateExtensionRegistrations(harness.browser, [registration], async (ready) => {
    marked.push(ready);
  });

  assert.deepEqual(harness.toggles, [false, true]);
  assert.equal(harness.enabled(), true);
  assert.equal(harness.openCount(), 1);
  assert.equal(harness.closeCount(), 1);
  assert.ok(harness.inspectCount() >= 3);
  assert.deepEqual(marked, [registration]);
});

test("registration migration rejects an ID, path, or modifiability mismatch before toggling or marking", async (context) => {
  const registration = extensionRegistration();
  const cases = [
    { name: "ID", options: { managementId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" } },
    { name: "path", options: { managementPath: path.resolve("data/extension-runtimes/wrong") } },
    { name: "modifiability", options: { mayDisable: false } },
  ] as const;
  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      const harness = migrationHarness(registration, candidate.options);
      let marks = 0;
      await assert.rejects(
        migrateExtensionRegistrations(harness.browser, [registration], async () => {
          marks += 1;
        }),
        (error) => {
          assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_MIGRATION_FAILED");
          return true;
        },
      );
      assert.deepEqual(harness.toggles, []);
      assert.equal(harness.closeCount(), 1);
      assert.equal(marks, 0);
    });
  }
});

test("registration migration times out without marking when the expected worker never appears", async () => {
  const registration = extensionRegistration();
  const harness = migrationHarness(registration, { publishWorkerOnEnable: false });
  let marks = 0;

  await assert.rejects(
    migrateExtensionRegistrations(harness.browser, [registration], async () => {
      marks += 1;
    }, 5),
    (error) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_MIGRATION_FAILED");
      assert.match((error as Error).message, /timed out waiting/);
      return true;
    },
  );

  assert.deepEqual(harness.toggles, [false, true]);
  assert.equal(harness.closeCount(), 1);
  assert.equal(marks, 0);
});

test("registration migration bounds every browser-facing operation and keeps completion pending", async (context) => {
  const registration = extensionRegistration();
  const never = <Value>() => new Promise<Value>(() => undefined);
  const managementInfo = (enabled: boolean) => ({
    id: registration.browserExtensionId,
    path: registration.runtimePath,
    enabled,
    mayDisable: true,
  });
  const currentWorker = {
    url: registrationWorkerUrl(registration),
    readRuntimeRevision: async () => registration.runtimeRevision,
  };
  const cases: Array<{
    name: string;
    expectedOperation: string;
    browser: ExtensionRegistrationMigrationBrowser;
    markReady?: () => Promise<void>;
  }> = [
    {
      name: "worker enumeration",
      expectedOperation: "service-worker enumeration",
      browser: { listWorkers: () => never(), openManagementPage: () => never() },
    },
    {
      name: "worker state read",
      expectedOperation: "service-worker lifecycle-state read",
      browser: {
        listWorkers: async () => [{ ...currentWorker, readRuntimeRevision: () => never() }],
        openManagementPage: () => never(),
      },
    },
    {
      name: "management page open",
      expectedOperation: "management page open",
      browser: { listWorkers: async () => [], openManagementPage: () => never() },
    },
    {
      name: "management inspection",
      expectedOperation: "management inspection",
      browser: {
        listWorkers: async () => [],
        openManagementPage: async () => ({
          inspect: () => never(),
          setEnabled: async () => undefined,
          close: async () => undefined,
        }),
      },
    },
    {
      name: "disable",
      expectedOperation: "disable",
      browser: {
        listWorkers: async () => [],
        openManagementPage: async () => ({
          inspect: async () => managementInfo(true),
          setEnabled: () => never(),
          close: async () => undefined,
        }),
      },
    },
    {
      name: "enable",
      expectedOperation: "enable",
      browser: {
        listWorkers: async () => [],
        openManagementPage: async () => ({
          inspect: async () => managementInfo(false),
          setEnabled: () => never(),
          close: async () => undefined,
        }),
      },
    },
    {
      name: "management page close",
      expectedOperation: "management page close",
      browser: {
        listWorkers: async () => [],
        openManagementPage: async () => {
          let enabled = true;
          return {
            inspect: async () => managementInfo(enabled),
            setEnabled: async (_extensionId, nextEnabled) => { enabled = nextEnabled; },
            close: () => never(),
          };
        },
      },
    },
    {
      name: "completion marker",
      expectedOperation: "completion marker write",
      browser: { listWorkers: async () => [currentWorker], openManagementPage: () => never() },
      markReady: () => never(),
    },
  ];

  for (const candidate of cases) {
    await context.test(candidate.name, async () => {
      let marks = 0;
      await assert.rejects(
        migrateExtensionRegistrations(candidate.browser, [registration], async () => {
          await candidate.markReady?.();
          marks += 1;
        }, 5),
        (error) => {
          assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_MIGRATION_FAILED");
          assert.equal((error as { operation?: string }).operation, candidate.expectedOperation);
          return true;
        },
      );
      assert.equal(marks, 0);
    });
  }
});

test("a failed enable stays pending and the next launch enables an already-disabled extension only", async () => {
  const registration = extensionRegistration();
  const harness = migrationHarness(registration, { failEnableCount: 1 });
  let marks = 0;

  await assert.rejects(
    migrateExtensionRegistrations(harness.browser, [registration], async () => {
      marks += 1;
    }),
    /enable failed/,
  );
  assert.deepEqual(harness.toggles, [false, true]);
  assert.equal(harness.enabled(), false);
  assert.equal(marks, 0);

  await migrateExtensionRegistrations(harness.browser, [registration], async () => {
    marks += 1;
  });
  assert.deepEqual(harness.toggles, [false, true, true]);
  assert.equal(harness.enabled(), true);
  assert.equal(marks, 1);
});

test("the Puppeteer migration adapter binds page evaluation and close methods", async () => {
  const registration = extensionRegistration();
  const toggles: boolean[] = [];
  let closed = false;
  const page = {
    url: () => "chrome://extensions/",
    goto: async () => undefined,
    evaluate: async function (this: unknown, _pageFunction: unknown, argument: unknown) {
      assert.equal(this, page);
      if (typeof argument === "string") {
        return {
          id: registration.browserExtensionId,
          path: registration.runtimePath,
          enabled: true,
          mayDisable: true,
        };
      }
      toggles.push((argument as { enabled: boolean }).enabled);
      return undefined;
    },
    close: async function (this: unknown) {
      assert.equal(this, page);
      closed = true;
    },
  };
  const browser = {
    close: async () => undefined,
    newPage: async () => page,
    pages: async () => [page],
    targets: () => [],
  } as unknown as Parameters<typeof puppeteerRegistrationMigrationBrowser>[0];

  const management = await puppeteerRegistrationMigrationBrowser(browser).openManagementPage();
  assert.equal((await management.inspect(registration.browserExtensionId)).id, registration.browserExtensionId);
  await management.setEnabled(registration.browserExtensionId, false);
  await management.close();

  assert.deepEqual(toggles, [false]);
  assert.equal(closed, true);
});

test("registration preflight launch options are minimal and never include extension paths", () => {
  const userDataDir = path.resolve("data/browser-data/preflight-options-test");
  const executablePath = path.resolve("browser-cache/chromium-151/chrome.exe");
  const options = buildExtensionRegistrationPreflightLaunchOptions(
    userDataDir,
    executablePath,
    1234,
  );

  assert.equal(options.userDataDir, userDataDir);
  assert.equal(options.executablePath, executablePath);
  assert.deepEqual(options.args, [
    `--user-data-dir=${userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--disable-extensions",
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  assert.equal(options.timeout, 1234);
  assert.deepEqual(options.spawnOptions, {
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(Object.hasOwn(options, "extensionPaths"), false);
});

test("registration preflight keeps paths containing spaces as one argv entry without a shell", () => {
  const userDataDir = path.resolve("data/browser data/profile with spaces");
  const executablePath = path.resolve("browser cache/chromium/chrome.exe");
  const options = buildExtensionRegistrationPreflightLaunchOptions(userDataDir, executablePath);

  assert.equal(options.executablePath, executablePath);
  assert.equal(options.args[0], `--user-data-dir=${userDataDir}`);
  assert.equal(options.args.filter((argument) => argument.includes("profile with spaces")).length, 1);
  assert.equal(options.spawnOptions.shell, false);
});

test("registration preflight removes a stale DevToolsActivePort before spawning Chromium", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-preflight-active-port-"));
  try {
    const activePortPath = path.join(root, "DevToolsActivePort");
    await fs.writeFile(activePortPath, "9222\n/devtools/browser/stale\n", "utf8");

    const prepared = await prepareExtensionRegistrationPreflightUserDataDir(root);

    assert.equal(prepared, activePortPath);
    await assert.rejects(fs.access(activePortPath), (error) => {
      assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
      return true;
    });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("DevToolsActivePort parser accepts only a bounded port and browser target path", () => {
  assert.deepEqual(parseDevToolsActivePort("43127\n/devtools/browser/browser-id\n"), {
    port: 43127,
    browserWebSocketPath: "/devtools/browser/browser-id",
  });
  for (const value of [
    "",
    "zero\n/devtools/browser/id\n",
    "0\n/devtools/browser/id\n",
    "65536\n/devtools/browser/id\n",
    "9222\nws://remote.example/devtools/browser/id\n",
    "9222\n/devtools/page/id\n",
    "9222\n/devtools/browser/../../escape\n",
  ]) assert.throws(() => parseDevToolsActivePort(value));
});

test("raw registration preflight reports a Chromium child that exits before CDP is ready", async () => {
  const child = new EventEmitter() as EventEmitter & {
    stdout: undefined;
    stderr: undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.stdout = undefined;
  child.stderr = undefined;
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => true;
  const process = rawCdpRegistrationPreflightProcess(
    child as unknown as ChildProcess,
    path.resolve("data/nonexistent-preflight/DevToolsActivePort"),
    50,
  );
  queueMicrotask(() => child.emit("exit", 18, null));

  await assert.rejects(
    process.clearServiceWorkers(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
    (error) => {
      assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_EARLY_EXIT");
      assert.match((error as Error).message, /exit code 18/);
      return true;
    },
  );
  await process.close();
});

test("raw registration preflight releases only child errors that prove spawn never created a process", async (context) => {
  const createChild = (pid: number | undefined) => {
    let killCalls = 0;
    const child = new EventEmitter() as EventEmitter & {
      stdout: undefined;
      stderr: undefined;
      pid: number | undefined;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: () => boolean;
    };
    child.stdout = undefined;
    child.stderr = undefined;
    child.pid = pid;
    child.exitCode = null;
    child.signalCode = null;
    child.kill = () => {
      killCalls += 1;
      return true;
    };
    return { child, killCalls: () => killCalls };
  };

  await context.test("spawn failure has no process or false profile hold", async () => {
    const fixture = createChild(undefined);
    const process = rawCdpRegistrationPreflightProcess(
      fixture.child as unknown as ChildProcess,
      path.resolve("data/nonexistent-preflight/DevToolsActivePort"),
      50,
    );
    fixture.child.emit("error", new Error("spawn EACCES"));

    await assert.rejects(
      process.clearServiceWorkers(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
      (error) => {
        assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_EARLY_EXIT");
        assert.match((error as Error).message, /spawn EACCES/);
        return true;
      },
    );
    await process.close();
    assert.equal(fixture.killCalls(), 0, "a child that never received a pid cannot own the profile");
  });

  await context.test("an error from a started child still requires its real exit", async () => {
    const fixture = createChild(42_424);
    const process = rawCdpRegistrationPreflightProcess(
      fixture.child as unknown as ChildProcess,
      path.resolve("data/nonexistent-preflight/DevToolsActivePort"),
      50,
    );
    fixture.child.emit("error", new Error("started child process error"));
    await assert.rejects(
      process.clearServiceWorkers(["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]),
      { code: "EXTENSION_REGISTRATION_PREFLIGHT_EARLY_EXIT" },
    );

    let closed = false;
    const closing = process.close().then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(fixture.killCalls(), 1);
    assert.equal(closed, false, "a numeric pid means an error alone cannot confirm process exit");
    fixture.child.exitCode = 1;
    fixture.child.emit("exit", 1, null);
    await closing;
    assert.equal(closed, true);
  });
});

test("raw registration preflight clears on the page target and loads unpacked runtimes on the browser target", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-preflight-cdp-targets-"));
  const activePortPath = path.join(root, "DevToolsActivePort");
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const port = 43127;
  const registration = extensionRegistration();
  const commands: Array<{ url: string; method: string; params: Record<string, unknown> }> = [];
  let killCalls = 0;
  const child = new EventEmitter() as EventEmitter & {
    stdout: undefined;
    stderr: undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.stdout = undefined;
  child.stderr = undefined;
  child.exitCode = null;
  child.signalCode = null;
  const confirmExit = () => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
  };
  child.kill = () => {
    killCalls += 1;
    queueMicrotask(confirmExit);
    return true;
  };

  class CommandWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = CommandWebSocket.CONNECTING;
    readonly url: string;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      queueMicrotask(() => {
        this.readyState = CommandWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(value: string): void {
      const payload = JSON.parse(value) as {
        id: number;
        method: string;
        params: Record<string, unknown>;
      };
      commands.push({ url: this.url, method: payload.method, params: payload.params });
      const result = payload.method === "Extensions.loadUnpacked"
        ? { id: registration.browserExtensionId }
        : {};
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", {
          data: JSON.stringify({ id: payload.id, result }),
        }));
        if (payload.method === "Browser.close") setTimeout(confirmExit, 10);
      });
    }

    close(): void {
      this.readyState = CommandWebSocket.CLOSED;
    }
  }

  try {
    await fs.writeFile(activePortPath, `${port}\n/devtools/browser/browser-id\n`, "utf8");
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => url.endsWith("/json/version")
          ? { webSocketDebuggerUrl: `ws://untrusted.invalid:${port}/devtools/browser/browser-id` }
          : [{
              type: "page",
              webSocketDebuggerUrl: `ws://untrusted.invalid:${port}/devtools/page/page-id`,
            }],
      } as Response;
    }) as typeof fetch;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: CommandWebSocket,
    });

    const process = rawCdpRegistrationPreflightProcess(
      child as unknown as ChildProcess,
      activePortPath,
      100,
    );
    await process.clearServiceWorkers([`chrome-extension://${registration.browserExtensionId}`]);
    await process.loadUnpackedExtensions([registration]);
    await process.finish();

    assert.deepEqual(commands, [
      {
        url: `ws://127.0.0.1:${port}/devtools/page/page-id`,
        method: "Storage.clearDataForOrigin",
        params: {
          origin: `chrome-extension://${registration.browserExtensionId}`,
          storageTypes: "service_workers",
        },
      },
      {
        url: `ws://127.0.0.1:${port}/devtools/browser/browser-id`,
        method: "Extensions.loadUnpacked",
        params: { path: registration.runtimePath },
      },
      {
        url: `ws://127.0.0.1:${port}/devtools/browser/browser-id`,
        method: "Browser.close",
        params: {},
      },
    ]);
    assert.equal(killCalls, 0, "a successful Browser.close must get a grace period to flush the profile");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
    await fs.rm(root, { recursive: true, force: true });
  }
});

type RawPreflightCloseMode =
  | "spawn-error"
  | "command-error"
  | "natural-timeout"
  | "delayed-natural-exit"
  | "signaled-exit"
  | "forced-exit-unconfirmed";

async function withRawPreflightCloseHarness<Result>(
  mode: RawPreflightCloseMode,
  timeoutMs: number,
  work: (harness: {
    process: ExtensionRegistrationPreflightProcess;
    killCalls: () => number;
    confirmExit: (signal?: NodeJS.Signals | null) => void;
  }) => Promise<Result>,
): Promise<Result> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-preflight-close-"));
  const activePortPath = path.join(root, "DevToolsActivePort");
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;
  const port = 43128;
  const registration = extensionRegistration();
  let killCalls = 0;
  let exitEmitted = false;
  const child = new EventEmitter() as EventEmitter & {
    stdout: undefined;
    stderr: undefined;
    pid: number | undefined;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: () => boolean;
  };
  child.stdout = undefined;
  child.stderr = undefined;
  child.pid = mode === "spawn-error" ? undefined : 42_428;
  child.exitCode = null;
  child.signalCode = null;
  const confirmExit = (signal: NodeJS.Signals | null = null) => {
    if (exitEmitted) return;
    exitEmitted = true;
    child.exitCode = signal ? null : 0;
    child.signalCode = signal;
    child.emit("exit", child.exitCode, signal);
  };
  child.kill = () => {
    killCalls += 1;
    if (mode !== "forced-exit-unconfirmed") queueMicrotask(() => confirmExit("SIGTERM"));
    return true;
  };

  class CloseWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = CloseWebSocket.CONNECTING;

    constructor(_url: string | URL) {
      super();
      queueMicrotask(() => {
        this.readyState = CloseWebSocket.OPEN;
        this.dispatchEvent(new Event("open"));
      });
    }

    send(value: string): void {
      const payload = JSON.parse(value) as { id: number; method: string };
      const response = payload.method === "Browser.close" && mode === "command-error"
        ? { id: payload.id, error: { message: "Browser.close rejected" } }
        : {
            id: payload.id,
            result: payload.method === "Extensions.loadUnpacked"
              ? { id: registration.browserExtensionId }
              : {},
          };
      queueMicrotask(() => {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(response) }));
        if (payload.method === "Browser.close" && mode === "delayed-natural-exit") {
          setTimeout(() => confirmExit(), 30);
        }
        if (payload.method === "Browser.close" && mode === "signaled-exit") {
          setTimeout(() => confirmExit("SIGTERM"), 10);
        }
      });
    }

    close(): void {
      this.readyState = CloseWebSocket.CLOSED;
    }
  }

  try {
    await fs.writeFile(activePortPath, `${port}\n/devtools/browser/browser-id\n`, "utf8");
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => url.endsWith("/json/version")
          ? { webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/browser-id` }
          : [{
              type: "page",
              webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/page/page-id`,
            }],
      } as Response;
    }) as typeof fetch;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: CloseWebSocket,
    });
    const process = rawCdpRegistrationPreflightProcess(
      child as unknown as ChildProcess,
      activePortPath,
      timeoutMs,
    );
    if (mode === "spawn-error") queueMicrotask(() => child.emit("error", new Error("spawn ENOENT")));
    return await work({ process, killCalls: () => killCalls, confirmExit });
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("registration preflight requires Browser.close plus natural exit before formal launch", async (context) => {
  await context.test("spawn failure releases the profile without starting or marking", async () => withRawPreflightCloseHarness(
    "spawn-error",
    50,
    async (raw) => {
      const profile = defaultProfile({ id: "raw-preflight-spawn-failure" });
      const registration = extensionRegistration();
      const marked: ExtensionLaunchRegistration[] = [];
      const service = new RegistrationPreflightSessionService({
        browserDataDir: "data/browser-data-test",
        readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
        extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
      }, async () => raw.process, undefined, 100);

      await assert.rejects(service.launchProfile(profile), (error) => {
        assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_EARLY_EXIT");
        assert.match((error as Error).message, /spawn ENOENT/);
        return true;
      });

      assert.equal(raw.killCalls(), 0, "spawn failure has no process to terminate");
      assert.equal(service.formalStarts, 0);
      assert.deepEqual(marked, []);
      assert.equal(registration.migrationRequired, true);
      assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
      assert.equal(service.listSessions()[0]?.closeUnconfirmed, undefined);
    },
  ));

  const cases = [
    {
      name: "Browser.close command error",
      mode: "command-error",
      rawTimeoutMs: 60,
      expectedCode: "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_FAILED",
    },
    {
      name: "natural exit timeout",
      mode: "natural-timeout",
      rawTimeoutMs: 40,
      expectedCode: "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_TIMEOUT",
    },
  ] as const;
  for (const [index, candidate] of cases.entries()) {
    await context.test(candidate.name, async () => withRawPreflightCloseHarness(
      candidate.mode,
      candidate.rawTimeoutMs,
      async (raw) => {
        const profile = defaultProfile({ id: `raw-preflight-fail-closed-${index}` });
        const registration = extensionRegistration();
        const marked: ExtensionLaunchRegistration[] = [];
        const service = new RegistrationPreflightSessionService({
          browserDataDir: "data/browser-data-test",
          readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
          extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
        }, async () => raw.process, undefined, 120);

        await assert.rejects(service.launchProfile(profile), (error) => {
          assert.equal((error as { code?: string }).code, candidate.expectedCode);
          return true;
        });

        assert.equal(raw.killCalls(), 1, "failed graceful completion must force cleanup");
        assert.equal(service.formalStarts, 0);
        assert.deepEqual(marked, [], "registration completion marker must stay pending");
        assert.equal(registration.migrationRequired, true);
        assert.deepEqual([...service.profileIdsHoldingRuntime()], [], "confirmed forced exit must release the profile");
      },
    ));
  }

  await context.test("forced exit remains unconfirmed", async () => withRawPreflightCloseHarness(
    "forced-exit-unconfirmed",
    30,
    async (raw) => {
      const profile = defaultProfile({ id: "raw-preflight-forced-exit-unconfirmed" });
      const registration = extensionRegistration();
      const marked: ExtensionLaunchRegistration[] = [];
      const service = new RegistrationPreflightSessionService({
        browserDataDir: "data/browser-data-test",
        readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
        extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
      }, async () => raw.process, undefined, 100);

      await assert.rejects(service.launchProfile(profile), (error) => {
        assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT");
        assert.equal((error as { operation?: string }).operation, "graceful finish");
        return true;
      });

      assert.ok(raw.killCalls() >= 1);
      assert.equal(service.formalStarts, 0);
      assert.deepEqual(marked, []);
      assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
      assert.equal(service.listSessions()[0]?.closeUnconfirmed, true);
      raw.confirmExit("SIGTERM");
      await waitFor(() => service.profileIdsHoldingRuntime().size === 0);
      assert.equal(service.listSessions()[0]?.closeUnconfirmed, undefined);
    },
  ));

  await context.test("Browser.close followed by a signaled exit", async () => withRawPreflightCloseHarness(
    "signaled-exit",
    80,
    async (raw) => {
      const profile = defaultProfile({ id: "raw-preflight-signaled-exit" });
      const registration = extensionRegistration();
      const marked: ExtensionLaunchRegistration[] = [];
      const service = new RegistrationPreflightSessionService({
        browserDataDir: "data/browser-data-test",
        readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
        extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
      }, async () => raw.process, undefined, 140);

      await assert.rejects(service.launchProfile(profile), (error) => {
        assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_GRACEFUL_CLOSE_FAILED");
        assert.match((error as Error).message, /signal SIGTERM/);
        return true;
      });

      assert.equal(raw.killCalls(), 0, "an already-confirmed abnormal exit needs no second termination");
      assert.equal(service.formalStarts, 0);
      assert.deepEqual(marked, []);
      assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
    },
  ));

  await context.test("delayed natural exit", async () => withRawPreflightCloseHarness(
    "delayed-natural-exit",
    120,
    async (raw) => {
      const profile = defaultProfile({ id: "raw-preflight-delayed-natural-exit" });
      const registration = extensionRegistration();
      const marked: ExtensionLaunchRegistration[] = [];
      const formalBrowser: ExtensionRegistrationMigrationBrowser = {
        listWorkers: async () => [{
          url: registrationWorkerUrl(registration),
          readRuntimeRevision: async () => registration.runtimeRevision,
        }],
        openManagementPage: async () => {
          throw new Error("the current worker must not be toggled");
        },
      };
      const service = new RegistrationPreflightSessionService({
        browserDataDir: "data/browser-data-test",
        readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
        extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
      }, async () => raw.process, formalBrowser, 200);

      const launched = await service.launchProfile(profile);

      assert.equal(launched.status, "running");
      assert.equal(raw.killCalls(), 0, "a natural exit inside the full budget must never be killed");
      assert.equal(service.formalStarts, 1);
      assert.deepEqual(marked, [registration]);
      await service.stopProfile(profile.id);
    },
  ));
});

test("raw CDP WebSocket open errors and timeouts are bounded", async (context) => {
  const originalWebSocket = globalThis.WebSocket;
  class FakeWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static mode: "error" | "timeout" = "timeout";
    readyState = FakeWebSocket.CONNECTING;

    constructor(_url: string | URL) {
      super();
      if (FakeWebSocket.mode === "error") {
        queueMicrotask(() => this.dispatchEvent(new Event("error")));
      }
    }

    send(): void {}

    close(): void {
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, writable: true, value: FakeWebSocket });
  try {
    await context.test("error", async () => {
      FakeWebSocket.mode = "error";
      await assert.rejects(
        withRawCdpConnection("ws://127.0.0.1:43127/devtools/page/id", 10, async () => undefined),
        /failed to open/,
      );
    });
    await context.test("timeout", async () => {
      FakeWebSocket.mode = "timeout";
      await assert.rejects(
        withRawCdpConnection("ws://127.0.0.1:43127/devtools/page/id", 5, async () => undefined),
        (error) => {
          assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_TIMEOUT");
          return true;
        },
      );
    });
  } finally {
    Object.defineProperty(globalThis, "WebSocket", {
      configurable: true,
      writable: true,
      value: originalWebSocket,
    });
  }
});

test("unpacked registration loading sends exact absolute paths and requires each returned extension ID", async (context) => {
  const first = extensionRegistration();
  const second = extensionRegistration({
    name: "Second Migration Extension",
    runtimePath: path.resolve("data/extension-runtimes/migration-test/extension-2"),
    browserExtensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  });

  await context.test("multiple exact registrations", async () => {
    const commands: Array<{ method: string; params: Record<string, unknown> }> = [];
    await loadUnpackedExtensionRegistrations({
      send: async (method, params) => {
        commands.push({ method, params });
        const registration = [first, second].find((candidate) => candidate.runtimePath === params.path);
        return { id: registration?.browserExtensionId };
      },
    }, [first, second]);

    assert.deepEqual(commands, [first, second].map((registration) => ({
      method: "Extensions.loadUnpacked",
      params: { path: registration.runtimePath },
    })));
  });

  await context.test("all paths are validated before the first command", async () => {
    let sends = 0;
    await assert.rejects(
      loadUnpackedExtensionRegistrations({
        send: async () => {
          sends += 1;
          return { id: first.browserExtensionId };
        },
      }, [first, { ...second, runtimePath: "relative/runtime" }]),
      (error) => {
        assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_LOAD_FAILED");
        assert.match((error as Error).message, /runtime path must be absolute/);
        return true;
      },
    );
    assert.equal(sends, 0);
  });

  for (const [name, response] of [
    ["mismatched ID", { id: second.browserExtensionId }],
    ["missing ID", {}],
  ] as const) {
    await context.test(name, async () => {
      await assert.rejects(
        loadUnpackedExtensionRegistrations({
          send: async () => response,
        }, [first]),
        (error) => {
          assert.equal((error as { code?: string }).code, "EXTENSION_REGISTRATION_PREFLIGHT_LOAD_FAILED");
          assert.match((error as Error).message, /Chromium returned extension ID/);
          return true;
        },
      );
    });
  }

  await context.test("CDP command error", async () => {
    await assert.rejects(
      loadUnpackedExtensionRegistrations({
        send: async () => {
          throw new Error("load command failed");
        },
      }, [first]),
      /load command failed/,
    );
  });
});

test("pending registrations are cleared in a closed preflight before formal launch and then marked from the current worker", async () => {
  const profile = defaultProfile({ id: "registration-preflight-sequence-test" });
  const first = extensionRegistration();
  const second = extensionRegistration({
    name: "Second Migration Extension",
    runtimePath: path.resolve("data/extension-runtimes/migration-test/extension-2"),
    browserExtensionId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    workerRelativePath: "cbpanel_lifecycle/worker-second.js",
    runtimeRevision: "runtime-revision-second",
    signature: "b".repeat(64),
  });
  const registrations = [first, second];
  const marked: ExtensionLaunchRegistration[] = [];
  const formalBrowser: ExtensionRegistrationMigrationBrowser = {
    listWorkers: async () => registrations.map((registration) => ({
      url: registrationWorkerUrl(registration),
      readRuntimeRevision: async () => registration.runtimeRevision,
    })),
    openManagementPage: async () => {
      throw new Error("current workers must not be toggled");
    },
  };
  let preflightProcess!: ExtensionRegistrationPreflightProcess;
  const service = new RegistrationPreflightSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "E:/fake/chromium-151/chrome.exe",
      version: "151.0.7922.108",
    }),
    extensionService: extensionServiceWithRegistrations(profile, registrations, marked),
  }, async () => preflightProcess, formalBrowser);
  const harness = registrationPreflightProcess({
    order: service.order,
    onFinish: async () => {
      assert.deepEqual(marked, []);
    },
  });
  preflightProcess = harness.process;

  const launched = await service.launchProfile(profile);

  assert.equal(launched.status, "running");
  assert.equal(service.preflightLaunches, 1);
  assert.equal(service.formalStarts, 1);
  assert.equal(harness.finishCalls(), 1);
  assert.equal(harness.closeCalls(), 0);
  assert.deepEqual(service.order, [
    "preflight-launch",
    "preflight-clear",
    "preflight-clear",
    "preflight-load",
    "preflight-load",
    "preflight-finish",
    "formal-start",
  ]);
  assert.deepEqual(harness.commands, [
    ...registrations.map((registration) => ({
      command: "Storage.clearDataForOrigin",
      params: {
        origin: `chrome-extension://${registration.browserExtensionId}`,
        storageTypes: "service_workers",
      },
    })),
    ...registrations.map((registration) => ({
      command: "Extensions.loadUnpacked",
      params: { path: registration.runtimePath },
    })),
  ]);
  assert.equal(
    harness.commands
      .filter(({ command }) => command === "Storage.clearDataForOrigin")
      .every(({ params }) => "origin" in params && !params.origin.endsWith("/")),
    true,
  );
  assert.equal(service.preflightOptions?.userDataDir, path.resolve("data/browser-data-test", profile.id));
  assert.equal(service.preflightOptions?.executablePath, "E:/fake/chromium-151/chrome.exe");
  assert.deepEqual(service.preflightOptions?.args, [
    `--user-data-dir=${path.resolve("data/browser-data-test", profile.id)}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--disable-extensions",
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);
  assert.equal(Object.hasOwn(service.preflightOptions ?? {}, "extensionPaths"), false);
  assert.deepEqual(marked, registrations);
});

test("ready registrations skip the isolated preflight", async () => {
  const profile = defaultProfile({ id: "registration-preflight-ready-skip-test" });
  const ready = extensionRegistration({ migrationRequired: false });
  const marked: ExtensionLaunchRegistration[] = [];
  const service = new RegistrationPreflightSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: extensionServiceWithRegistrations(profile, [ready], marked),
  }, async () => {
    throw new Error("preflight must not launch");
  });

  const launched = await service.launchProfile(profile);

  assert.equal(launched.status, "running");
  assert.equal(service.preflightLaunches, 0);
  assert.equal(service.formalStarts, 1);
  assert.deepEqual(marked, []);
});

test("preflight launch, command, and close failures never start the formal browser or mark ready", async (context) => {
  const cases = [
    {
      name: "launch timeout",
      launch: async () => new Promise<ExtensionRegistrationPreflightProcess>(() => undefined),
    },
    {
      name: "launch error",
      launch: async () => Promise.reject(new Error("preflight launch failed")),
    },
    {
      name: "clear command timeout",
      context: () => registrationPreflightProcess({
        onSend: async () => new Promise<never>(() => undefined),
      }),
    },
    {
      name: "clear command error",
      context: () => registrationPreflightProcess({
        onSend: async () => Promise.reject(new Error("preflight command failed")),
      }),
    },
    {
      name: "load command timeout",
      context: () => registrationPreflightProcess({
        onSend: async (command) => command === "Extensions.loadUnpacked"
          ? new Promise<never>(() => undefined)
          : undefined,
      }),
    },
    {
      name: "load command error",
      context: () => registrationPreflightProcess({
        onSend: async (command) => {
          if (command === "Extensions.loadUnpacked") throw new Error("preflight load failed");
          return undefined;
        },
      }),
    },
    {
      name: "load ID mismatch",
      context: () => registrationPreflightProcess({
        onSend: async (command) => command === "Extensions.loadUnpacked"
          ? { id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }
          : undefined,
      }),
    },
    {
      name: "relative runtime path",
      registration: () => extensionRegistration({ runtimePath: "relative/runtime" }),
      context: () => registrationPreflightProcess(),
    },
    {
      name: "graceful finish timeout",
      context: () => registrationPreflightProcess({
        onFinish: async () => new Promise<void>(() => undefined),
      }),
    },
    {
      name: "graceful finish error",
      context: () => registrationPreflightProcess({
        onFinish: async () => Promise.reject(new Error("preflight finish failed")),
      }),
    },
  ] as const;

  for (const [index, candidate] of cases.entries()) {
    await context.test(candidate.name, async () => {
      const profile = defaultProfile({ id: `registration-preflight-failure-${index}` });
      const registration = "registration" in candidate
        ? candidate.registration()
        : extensionRegistration();
      const marked: ExtensionLaunchRegistration[] = [];
      const harness = "context" in candidate ? candidate.context() : undefined;
      const launch = "launch" in candidate
        ? candidate.launch
        : async () => harness!.process;
      const service = new RegistrationPreflightSessionService({
        browserDataDir: "data/browser-data-test",
        readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
        extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
      }, launch);

      await assert.rejects(service.launchProfile(profile));

      assert.equal(service.formalStarts, 0);
      assert.deepEqual(marked, []);
      if (harness) {
        const finishExpected = candidate.name.startsWith("graceful finish");
        assert.equal(harness.finishCalls(), finishExpected ? 1 : 0);
        assert.equal(harness.closeCalls(), 1);
      }
    });
  }
});

test("stopProfile during registration preflight closes that exact generation and prevents formal launch", async () => {
  const profile = defaultProfile({ id: "stop-during-registration-preflight-test" });
  const registration = extensionRegistration();
  const marked: ExtensionLaunchRegistration[] = [];
  let releaseCommand!: () => void;
  const commandGate = new Promise<void>((resolve) => {
    releaseCommand = resolve;
  });
  const harness = registrationPreflightProcess({
    onSend: async () => commandGate,
    onClose: async () => releaseCommand(),
  });
  const service = new RegistrationPreflightSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
  }, async () => harness.process, undefined, 200);

  const launching = service.launchProfile(profile);
  await waitFor(() => harness.commands.length >= 1);
  const stopping = service.stopProfile(profile.id);
  const [launched, stopped] = await Promise.all([launching, stopping]);

  assert.equal(launched.status, "stopped");
  assert.equal(stopped.status, "stopped");
  assert.equal(harness.finishCalls(), 0);
  assert.equal(harness.closeCalls(), 1);
  assert.equal(service.formalStarts, 0);
  assert.deepEqual(marked, []);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
});

test("a stop timeout during registration preflight retains the generation-specific runtime hold", async () => {
  const profile = defaultProfile({ id: "stop-timeout-registration-preflight-test" });
  const registration = extensionRegistration();
  const marked: ExtensionLaunchRegistration[] = [];
  const harness = registrationPreflightProcess({
    onSend: async () => new Promise<void>(() => undefined),
    onClose: async () => new Promise<void>(() => undefined),
  });
  const service = new RegistrationPreflightSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: extensionServiceWithRegistrations(profile, [registration], marked),
  }, async () => harness.process, undefined, 80);

  const launching = service.launchProfile(profile);
  await waitFor(() => harness.commands.length >= 1);
  const stopped = await service.stopProfile(profile.id);

  assert.equal(stopped.status, "error");
  assert.equal(stopped.closeUnconfirmed, true);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
  assert.equal(service.formalStarts, 0);
  assert.deepEqual(marked, []);
  await launching.catch(() => undefined);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
});

class DelayedCloseSessionService extends SessionService {
  private readonly closeResolvers: Array<() => void> = [];

  protected override closeTimeoutMs(): number {
    return 40;
  }

  protected override async startRuntime(): Promise<TestRuntimeHandle> {
    return {
      close: () => new Promise<void>((resolve) => this.closeResolvers.push(resolve)),
      pageUrl: () => "about:blank",
    };
  }

  resolveClose(index: number): void {
    this.closeResolvers[index]?.();
  }

  simulateCurrentClose(profileId: string): void {
    this.markSessionStopped(profileId, "浏览器窗口已关闭");
  }
}

function wedgedService(rejectClose = false): WedgedCloseSessionService {
  return new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
  }, rejectClose);
}

test("a stop that never completes ends in a terminal state instead of hanging in stopping", async () => {
  const service = wedgedService();
  const profile = defaultProfile({ id: "wedged-close-test" });
  await service.launchProfile(profile);

  const stopped = await service.stopProfile(profile.id);

  // Not "stopped": nobody observed the process exit, and claiming otherwise is the lie that made the
  // panel's own state useless. Not "stopping" either — that is what wedged for ever.
  assert.equal(stopped.status, "error");
  assert.match(stopped.lastError ?? "", /停止超时/);
  assert.equal(stopped.events?.some((event) => event.message === "停止超时"), true);
  assert.equal(service.closeCalls, 1);
});

test("a stop that never completes still lets the profile be launched again", async () => {
  const service = wedgedService();
  const profile = defaultProfile({ id: "wedged-relaunch-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);

  // The launch gate asks a different question from the file-safety probe, and must answer no here:
  // a browser nobody can confirm is gone cannot block that profile for the rest of the session.
  assert.equal(service.hasActiveSession(profile.id), false);
});

test("a relaunch after an unconfirmed close forbids replacing an existing extension runtime", async () => {
  const profile = defaultProfile({ id: "unconfirmed-runtime-replacement-test" });
  const allowReplacement: Array<boolean | undefined> = [];
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: {
      resolveEnvironment: async () => ({ environment: { extensionIds: ["extension-1"] }, profile: profile.runtime }),
      ensureExtensionsInstalled: async (_environmentId: string, options?: { allowRuntimeReplacement?: boolean }) => {
        allowReplacement.push(options?.allowRuntimeReplacement);
        return { paths: ["D:/extensions/runtime"], warnings: [] };
      },
    } as unknown as ExtensionService,
  });

  await service.launchProfile(profile);
  await service.stopProfile(profile.id);
  await service.launchProfile(profile);

  assert.deepEqual(allowReplacement, [true, false]);
  assert.equal(service.listSessions().find((item) => item.profileId === profile.id)?.closeUnconfirmed, true);
});

test("a pending registration preflight cannot mutate a profile held by an unconfirmed older generation", async () => {
  const profile = defaultProfile({ id: "unconfirmed-registration-preflight-test" });
  const registration = extensionRegistration();
  let ensureCalls = 0;
  const service = new WedgedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    extensionService: {
      resolveEnvironment: async () => ({ environment: { extensionIds: ["extension-1"] }, profile: profile.runtime }),
      ensureExtensionsInstalled: async () => ({
        paths: [registration.runtimePath],
        warnings: [],
        registrations: ensureCalls++ === 0 ? [] : [registration],
      }),
    } as unknown as ExtensionService,
  });

  await service.launchProfile(profile);
  await service.stopProfile(profile.id);
  await assert.rejects(
    service.launchProfile(profile),
    (error) => {
      assert.equal(
        (error as { code?: string }).code,
        "EXTENSION_REGISTRATION_MIGRATION_CLOSE_UNCONFIRMED",
      );
      return true;
    },
  );
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
});

test("a stop that never completes keeps the profile counted as holding its files", async () => {
  const service = wedgedService();
  const profile = defaultProfile({ id: "wedged-files-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);

  // The process may still be alive with the build, the extension directories and the user data
  // directory open, so every service that rm's or renames must keep treating it as in use.
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
});

test("the browser exiting after a stop timeout clears the session and releases its files", async () => {
  const service = wedgedService();
  const profile = defaultProfile({ id: "wedged-then-exit-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);

  service.simulateExternalClose(profile.id);

  // Without this the timed-out session held every file-touching service until the panel restarted.
  assert.equal(service.listSessions().find((item) => item.profileId === profile.id)?.status, "stopped");
  assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
});

test("a close that throws also keeps the profile counted as holding its files", async () => {
  const service = wedgedService(true);
  const profile = defaultProfile({ id: "failed-close-test" });
  await service.launchProfile(profile);

  const failed = await service.stopProfile(profile.id);

  // The attempt failed, so nothing observed the process exit — exactly as unconfirmed as a timeout.
  // Before this the rejection released the hold immediately and a destructive operation could run
  // against a browser that was still alive.
  assert.equal(failed.status, "error");
  assert.equal(failed.closeUnconfirmed, true);
  assert.match(failed.lastError ?? "", /关闭失败/);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
});

test("the failure diagnosis survives in the event log after a close event clears the session", async () => {
  const service = wedgedService(true);
  const profile = defaultProfile({ id: "failed-close-history-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);

  service.simulateExternalClose(profile.id);

  // A close event proves the browser is gone, so releasing the hold is right. The reason the stop failed
  // is not lost with it: markSessionStopped never rewrites the event log.
  const session = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(session?.status, "stopped");
  assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
  assert.equal(session?.events?.some((event) => event.message === "停止失败" && /关闭失败/.test(event.detail ?? "")), true);
});

// The other half of the wedge: the stop blocks on runtimePromise before close() is even reached, so a
// launch that never resolves used to pin the session just as hard.
class WedgedLaunchSessionService extends SessionService {
  private rejectLaunch!: (error: Error) => void;
  private readonly neverReady = new Promise<TestRuntimeHandle>((_resolve, reject) => {
    this.rejectLaunch = reject;
  });

  protected override closeTimeoutMs(): number {
    return 40;
  }

  protected override async startRuntime(): Promise<TestRuntimeHandle> {
    return this.neverReady;
  }

  failLaunch(): void {
    this.rejectLaunch(new Error("Timeout 30000ms exceeded."));
  }
}

test("a stop that times out on an unfinished launch is released when that launch finally fails", async () => {
  const service = new WedgedLaunchSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
  });
  const profile = defaultProfile({ id: "wedged-launch-stop-test" });
  const launch = service.launchProfile(profile);
  await waitFor(() => service.listSessions().some((item) => item.profileId === profile.id && Boolean(item.launch)));

  const stopped = await service.stopProfile(profile.id);
  assert.equal(stopped.closeUnconfirmed, true);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);

  service.failLaunch();
  await launch.catch(() => undefined);

  // There is now definitively no browser process, and no close event will ever arrive to say so. The
  // late outcome of the close is the only thing that can release the hold — nothing else observes it.
  await waitFor(() => service.profileIdsHoldingRuntime().size === 0);
  assert.equal(service.listSessions().find((item) => item.profileId === profile.id)?.status, "stopped");
});

test("a close event inside the budget stands, and the timeout does not overwrite it", async () => {
  const service = wedgedService();
  const profile = defaultProfile({ id: "early-close-event-test" });
  await service.launchProfile(profile);

  const stopping = service.stopProfile(profile.id);
  // What playwright does: the context close event fires well before the process finishes exiting.
  service.simulateExternalClose(profile.id);
  const stopped = await stopping;

  // Overwriting this confirmation was permanent: no second event ever arrives, so the session would
  // have held every file-touching service for the rest of the process.
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.closeUnconfirmed, undefined);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
});

test("relaunching after an unconfirmed stop keeps the old process counted as holding its files", async () => {
  const service = wedgedService();
  const profile = defaultProfile({ id: "relaunch-after-wedge-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);

  await service.launchProfile(profile);

  // Pressing Launch is the one action the panel offers here, and it replaces the session record. Losing
  // the flag with it meant a failed relaunch reported the files as free while the old browser lived.
  assert.equal(service.listSessions().find((item) => item.profileId === profile.id)?.closeUnconfirmed, true);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);
});

test("a late close from a replaced session cannot stop the relaunched browser", async () => {
  const service = new DelayedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
  });
  const profile = defaultProfile({ id: "late-close-after-relaunch-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);
  await service.launchProfile(profile);

  service.resolveClose(0);
  await new Promise((resolve) => setImmediate(resolve));

  const relaunched = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(relaunched?.status, "running");
  assert.equal(relaunched?.closeUnconfirmed, undefined);
});

test("closing a relaunched browser does not release an older unconfirmed generation", async () => {
  const service = new DelayedCloseSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
  });
  const profile = defaultProfile({ id: "new-close-old-hold-test" });
  await service.launchProfile(profile);
  await service.stopProfile(profile.id);
  await service.launchProfile(profile);

  service.simulateCurrentClose(profile.id);
  let current = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(current?.status, "stopped");
  assert.equal(current?.closeUnconfirmed, true);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], [profile.id]);

  service.resolveClose(0);
  await new Promise((resolve) => setImmediate(resolve));

  current = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(current?.status, "stopped");
  assert.equal(current?.closeUnconfirmed, undefined);
  assert.deepEqual([...service.profileIdsHoldingRuntime()], []);
});

test("stopAll stays bounded when every session is wedged", async () => {
  const service = wedgedService();
  const first = defaultProfile({ id: "stop-all-wedged-1" });
  const second = defaultProfile({ id: "stop-all-wedged-2" });
  await service.launchProfile(first);
  await service.launchProfile(second);

  const startedAt = process.hrtime.bigint();
  await service.stopAll();
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  // Racing in parallel, not in sequence: the desktop shell kills the sidecar a fixed time after asking
  // it to shut down, so N wedged sessions must cost one budget rather than N.
  assert.ok(elapsedMs < 40 * 3, `stopAll took ${Math.round(elapsedMs)}ms`);
  assert.equal(service.listSessions().every((item) => item.status === "error"), true);
});

test("formatNetworkCheckDetail keeps legacy geo fallback for stored old checks", () => {
  const detail = formatNetworkCheckDetail({
    checkedAt: "2026-06-03T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.42",
    geo: {
      countryCode: "JP",
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    },
  } satisfies NetworkCheckResult);

  assert.equal(detail, "203.0.113.42 / 日本 (JP)");
});

test("getOrCreatePlaywrightPage always creates a page for a context without pages", async () => {
  // launchContext() (ephemeral mode) returns a context with zero pages: without this fallback an
  // empty start URL left the browser running with no window at all.
  const createdPage = { id: "created" };
  let newPageCalls = 0;
  const context = {
    pages: () => [],
    newPage: async () => {
      newPageCalls += 1;
      return createdPage;
    },
  } as unknown as Parameters<typeof getOrCreatePlaywrightPage>[0];

  const page = await getOrCreatePlaywrightPage(context);

  assert.equal(newPageCalls, 1);
  assert.equal(page, createdPage);
});

test("getOrCreatePlaywrightPage reuses the first existing page", async () => {
  const existingPage = { id: "existing" };
  let newPageCalls = 0;
  const context = {
    pages: () => [existingPage, { id: "second" }],
    newPage: async () => {
      newPageCalls += 1;
      return { id: "created" };
    },
  } as unknown as Parameters<typeof getOrCreatePlaywrightPage>[0];

  const page = await getOrCreatePlaywrightPage(context);

  assert.equal(newPageCalls, 0);
  assert.equal(page, existingPage);
});

// Upstream already maps a Pro binary's licence exit codes to a readable reason and throws
// CloakBrowserLicenseError rather than the opaque "target/browser closed". The code is what lets the panel
// say where to fix it instead of showing the reason as a generic launch failure.
test("a launch refused for a licence reason carries the licence code", async () => {
  const { CloakBrowserLicenseError } = await import("cloakbrowser");
  const service = new FailingRuntimeSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
  }, new CloakBrowserLicenseError("许可证已过期"));
  const profile = defaultProfile({ id: "license-denied-launch-test" });

  const denied = await service.launchProfile(profile).then(() => undefined, (error: Error & { code?: string }) => error);

  assert.equal(denied?.code, "BROWSER_CORE_LICENSE_DENIED");
  assert.equal(denied?.message, "许可证已过期");
});

test("any other launch failure keeps its own error untouched", async () => {
  const service = new FailingRuntimeSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
  }, new Error("Target page, context or browser has been closed"));
  const profile = defaultProfile({ id: "generic-failed-launch-test" });

  const failed = await service.launchProfile(profile).then(() => undefined, (error: Error & { code?: string }) => error);

  assert.equal(failed?.code, undefined);
  assert.equal(failed?.message, "Target page, context or browser has been closed");
});

// 0.5.4 surfaces a licence denial that resolves after the CDP handshake on the first page call, and for a
// profile with a start URL that call is this goto. Degrading it to a warning reported a running session over
// a browser the licence server was killing.
test("a licence denial during the start-page load fails the launch instead of warning", async () => {
  const { CloakBrowserLicenseError } = await import("cloakbrowser");
  const denial = new CloakBrowserLicenseError("并发会话数已达上限");

  await assert.rejects(
    gotoStartUrl({ goto: async () => { throw denial; } }, "https://example.com"),
    (error) => {
      assert.equal(error, denial);
      return true;
    },
  );
});

test("a start page that merely fails to load stays a warning", async () => {
  const warning = await gotoStartUrl(
    { goto: async () => { throw new Error("net::ERR_NAME_NOT_RESOLVED"); } },
    "https://example.invalid",
  );

  assert.match(warning ?? "", /^启动成功，但起始页加载失败：/);
  assert.match(warning ?? "", /ERR_NAME_NOT_RESOLVED/);
});

// The licence guard 0.5.4 installs wraps the synchronous pages() and url() that pageUrl() is built from, and
// remembers an observed denial for the rest of the launch — so that read throws on every poll from then on.
// listSessions() maps every session through publicSession, so an unguarded read took the whole list down,
// healthy sessions included.
test("a session whose page URL read throws does not break the session list", async () => {
  const service = new ThrowingPageUrlSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({
      installed: true,
      binaryPath: "C:/fake/chrome.exe",
      version: "test",
    }),
  });
  const denied = defaultProfile({ id: "page-url-throws-test" });
  const healthy = defaultProfile({ id: "page-url-healthy-test" });

  await service.launchProfile(denied);
  await service.launchProfile(healthy);
  service.denyPageUrl(denied.id);

  const sessions = service.listSessions();

  assert.equal(sessions.length, 2);
  assert.equal(sessions.find((item) => item.profileId === denied.id)?.pageUrl, undefined);
  assert.equal(sessions.find((item) => item.profileId === denied.id)?.status, "running");
  assert.equal(sessions.find((item) => item.profileId === healthy.id)?.pageUrl, "about:blank");
});

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(assertion(), true);
}
