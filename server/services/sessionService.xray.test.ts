import assert from "node:assert/strict";
import test from "node:test";
import type { NetworkCheckResult } from "../../src/shared/entities";
import { defaultProfile, type BrowserProfile, type ProfilePreflightXrayEngine } from "../../src/shared/profile";
import { SessionService, type SessionXrayBridge, type SessionXrayHandle } from "./sessionService";

const VLESS_LINK = "vless://b831381d-6324-4d53-ad4f-8cda48b30811@node.example.com:443?security=tls&type=ws&path=%2Fws#Node";

type TestRuntimeHandle = {
  close: () => Promise<void>;
  pageUrl: () => string | undefined;
  ready: Promise<{ warning?: string }>;
};

class RecordingSessionService extends SessionService {
  launchedProfiles: BrowserProfile[] = [];
  closeCount = 0;

  protected override async startRuntime(profile: BrowserProfile): Promise<TestRuntimeHandle> {
    this.launchedProfiles.push(profile);
    return {
      close: async () => {
        this.closeCount += 1;
      },
      pageUrl: () => "about:blank",
      ready: Promise.resolve({}),
    };
  }

  browserExited(profileId: string): void {
    this.markSessionStopped(profileId, "浏览器窗口已关闭");
  }
}

type BridgeRecord = {
  bridge: SessionXrayBridge;
  startCalls: Array<{ profileId: string; ownerId: string }>;
  stopCount: number;
  preflightCalls: number;
};

function bridgeStub(options: {
  port?: number;
  startError?: Error;
  preflight?: ProfilePreflightXrayEngine;
} = {}): BridgeRecord {
  const record: BridgeRecord = {
    startCalls: [],
    stopCount: 0,
    preflightCalls: 0,
    bridge: {
      isRequired: (profile) => profile.proxy.enabled && (profile.proxy.scheme === "xray" || Boolean(profile.proxy.preProxyId)),
      start: async (profile, ownerId, onEvent) => {
        record.startCalls.push({ profileId: profile.id, ownerId });
        if (options.startError) throw options.startError;
        const port = options.port ?? 45678;
        onEvent("info", "Xray 引擎已启动", `socks5://127.0.0.1:${port}`);
        const handle: SessionXrayHandle = {
          port,
          localProxyUrl: `socks5://127.0.0.1:${port}`,
          upstream: "vless://****@node.example.com:443#Node",
          preProxy: profile.proxy.preProxyId ? "socks5://front.example.com:1080" : undefined,
          stop: async () => {
            record.stopCount += 1;
          },
        };
        return handle;
      },
      preflight: async () => {
        record.preflightCalls += 1;
        return options.preflight ?? { installed: true, binaryPath: "/data/xray/bin/xray", version: "25.9.1" };
      },
    },
  };
  return record;
}

function xrayProfile(id: string, patch: Partial<BrowserProfile["proxy"]> = {}): BrowserProfile {
  return defaultProfile({
    id,
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      scheme: "xray",
      shareLink: VLESS_LINK,
      bypass: "localhost,127.0.0.1,.internal.example",
      ...patch,
    },
  });
}

function okCheck(): NetworkCheckResult {
  return { checkedAt: "2026-09-06T00:00:00.000Z", ok: true, ip: "203.0.113.9", source: "environment-check" };
}

test("a share-link proxy launches through the Xray engine and the browser sees the local socks port", async () => {
  const record = bridgeStub({ port: 40001 });
  const checkedProfiles: BrowserProfile[] = [];
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async (profile) => {
      checkedProfiles.push(profile);
      return okCheck();
    },
    xray: record.bridge,
  });
  const profile = xrayProfile("xray-launch-test");

  const session = await service.launchProfile(profile);
  assert.equal(session.status, "running");
  assert.deepEqual(record.startCalls, [{ profileId: profile.id, ownerId: profile.id }]);

  // The exit check and the browser launch both use the engine's local inbound, and nothing else.
  assert.equal(checkedProfiles.length, 1);
  assert.equal(checkedProfiles[0].proxy.scheme, "socks5");
  assert.equal(checkedProfiles[0].proxy.host, "127.0.0.1");
  assert.equal(checkedProfiles[0].proxy.port, "40001");
  assert.equal(checkedProfiles[0].proxy.shareLink, "");
  assert.equal(checkedProfiles[0].proxy.bypass, "localhost,127.0.0.1,.internal.example");
  assert.equal(service.launchedProfiles.length, 1);
  assert.equal(service.launchedProfiles[0].proxy.scheme, "socks5");
  assert.equal(service.launchedProfiles[0].proxy.port, "40001");
  assert.equal(service.launchedProfiles[0].proxy.preProxyId, "");
  // The stored profile itself is untouched.
  assert.equal(profile.proxy.scheme, "xray");
  assert.match(session.launch?.proxy ?? "", /vless:\/\/\*\*\*\*@node\.example\.com:443#Node · Xray socks5:\/\/127\.0\.0\.1:40001/);
  assert.equal(session.events?.some((event) => event.message === "Xray 引擎已启动"), true);
  assert.equal(record.stopCount, 0);

  const stopped = await service.stopProfile(profile.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(service.closeCount, 1);
  assert.equal(record.stopCount, 1);
  assert.equal(stopped.events?.some((event) => event.message === "Xray 引擎已停止"), true);
});

test("a chained plain proxy also goes through the engine", async () => {
  const record = bridgeStub({ port: 40002 });
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async () => okCheck(),
    xray: record.bridge,
  });
  const profile = defaultProfile({
    id: "chained-launch-test",
    proxy: { ...defaultProfile().proxy, enabled: true, scheme: "socks5", host: "target.example.com", port: "1081", preProxyId: "proxy-front" },
  });
  const session = await service.launchProfile(profile);
  assert.equal(session.status, "running");
  assert.equal(record.startCalls.length, 1);
  assert.equal(service.launchedProfiles[0].proxy.port, "40002");
  assert.match(session.launch?.proxy ?? "", /socks5:\/\/front\.example\.com:1080 → vless/);
  await service.stopProfile(profile.id);
  assert.equal(record.stopCount, 1);
});

test("profiles that do not need the engine never touch it", async () => {
  const record = bridgeStub();
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async () => okCheck(),
    xray: record.bridge,
  });
  const profile = defaultProfile({
    id: "plain-launch-test",
    proxy: { ...defaultProfile().proxy, enabled: true, scheme: "http", host: "proxy.example.com", port: "8080" },
  });
  await service.launchProfile(profile);
  assert.deepEqual(record.startCalls, []);
  assert.equal(service.launchedProfiles[0].proxy.host, "proxy.example.com");
  await service.stopProfile(profile.id);
  assert.equal(record.stopCount, 0);
});

test("an engine that fails to start fails the launch before any browser is spawned", async () => {
  const record = bridgeStub({
    startError: Object.assign(new Error("Xray 引擎未安装；该代理需要 Xray-core 中转，请先在设置中安装 Xray 引擎。"), {
      status: 409,
      code: "XRAY_ENGINE_MISSING",
    }),
  });
  let checked = 0;
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async () => {
      checked += 1;
      return okCheck();
    },
    xray: record.bridge,
  });
  const profile = xrayProfile("xray-missing-test");
  await assert.rejects(service.launchProfile(profile), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "XRAY_ENGINE_MISSING");
    assert.equal((error as { status?: number }).status, 409);
    return true;
  });
  assert.equal(checked, 0);
  assert.equal(service.launchedProfiles.length, 0);
  const session = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(session?.status, "error");
  assert.match(session?.lastError ?? "", /Xray 引擎未安装/);
});

test("an exit check that fails after the engine started stops the engine again", async () => {
  const record = bridgeStub();
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async () => ({ checkedAt: "2026-09-06T00:00:00.000Z", ok: false, source: "environment-check", error: "代理出口检测超时" }),
    xray: record.bridge,
  });
  const profile = xrayProfile("xray-check-fail-test");
  await assert.rejects(service.launchProfile(profile), (error: unknown) => (error as { code?: string }).code === "PROXY_CHECK_FAILED");
  assert.equal(record.startCalls.length, 1);
  await waitFor(() => record.stopCount === 1);
  assert.equal(service.launchedProfiles.length, 0);
});

test("the browser closing on its own releases the engine", async () => {
  const record = bridgeStub();
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    checkNetwork: async () => okCheck(),
    xray: record.bridge,
  });
  const profile = xrayProfile("xray-external-close-test");
  await service.launchProfile(profile);
  service.browserExited(profile.id);
  await waitFor(() => record.stopCount === 1);
  const session = service.listSessions().find((item) => item.profileId === profile.id);
  assert.equal(session?.status, "stopped");
  assert.equal(session?.events?.some((event) => event.message === "Xray 引擎已停止"), true);
});

test("preflight reports the engine and the front proxy for profiles that need them", async () => {
  const missing = bridgeStub({
    preflight: {
      installed: false,
      binaryPath: "/data/xray/bin/xray",
      preProxy: { id: "proxy-front", ok: false, detail: "前置代理不存在；请在代理设置中重新选择前置代理。" },
    },
  });
  const service = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    xray: missing.bridge,
  });
  const report = await service.preflight(xrayProfile("xray-preflight-test", { preProxyId: "proxy-front" }));
  assert.equal(missing.preflightCalls, 1);
  const engine = report.items.find((item) => item.id === "xray-engine");
  assert.equal(engine?.severity, "fail");
  assert.deepEqual(engine?.actions?.map((action) => action.kind), ["install-xray"]);
  const preProxy = report.items.find((item) => item.id === "xray-pre-proxy");
  assert.equal(preProxy?.severity, "fail");
  assert.match(preProxy?.detail ?? "", /前置代理不存在/);
  assert.equal(report.ok, false);

  const installed = bridgeStub();
  const readyService = new RecordingSessionService({
    browserDataDir: "data/browser-data-test",
    readBinaryInfo: async () => ({ installed: true, binaryPath: "C:/fake/chrome.exe", version: "test" }),
    xray: installed.bridge,
  });
  const readyReport = await readyService.preflight(xrayProfile("xray-preflight-ready-test"));
  const readyEngine = readyReport.items.find((item) => item.id === "xray-engine");
  assert.equal(readyEngine?.severity, "pass");
  assert.match(readyEngine?.detail ?? "", /25\.9\.1/);
  assert.equal(readyReport.items.some((item) => item.id === "xray-pre-proxy"), false);

  const plainReport = await readyService.preflight(defaultProfile({ id: "plain-preflight-test" }));
  assert.equal(plainReport.items.some((item) => item.id === "xray-engine"), false);
  assert.equal(installed.preflightCalls, 1);
});

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
