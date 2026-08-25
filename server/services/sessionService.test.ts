import assert from "node:assert/strict";
import test from "node:test";
import type { NetworkCheckResult } from "../../src/shared/entities";
import { defaultProfile, type BrowserProfile } from "../../src/shared/profile";
import { normalizeSettings } from "../../src/shared/settings";
import type { ExtensionService } from "./extensionService";
import { restoreGithubMirrorFetch } from "./githubMirrorFetch";
import { formatNetworkCheckDetail, getOrCreatePlaywrightPage, gotoStartUrl, SessionService } from "./sessionService";

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
