import assert from "node:assert/strict";
import test from "node:test";
import type { NetworkCheckResult } from "../../src/shared/entities";
import { defaultProfile, type BrowserProfile } from "../../src/shared/profile";
import { normalizeSettings } from "../../src/shared/settings";
import { restoreGithubMirrorFetch } from "./githubMirrorFetch";
import { formatNetworkCheckDetail, SessionService } from "./sessionService";

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
  await waitFor(() => service.listSessions().some((session) => session.profileId === profile.id && session.status === "launching"));

  const stopAll = service.stopAll();
  await waitFor(() => service.listSessions().some((session) => session.profileId === profile.id && session.status === "stopping"));
  service.releaseRuntime();

  await Promise.all([launch, stopAll]);
  const session = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(service.closeCount, 1);
  assert.equal(session?.status, "stopped");
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

async function waitFor(assertion: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (assertion()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(assertion(), true);
}
