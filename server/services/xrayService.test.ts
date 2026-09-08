import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { defaultProfile, type ProxySettings } from "../../src/shared/profile";
import { type AppSettings, type AppSettingsPatch, mergeSettings, normalizeSettings } from "../../src/shared/settings";
import { isLocalPortListening } from "./xrayLocalPort";
import { XrayService, compareVersions, engineLogHint, parseSha256Digest } from "./xrayService";
import { writeFakeXrayEngine, type FakeXrayEngine } from "../testing/fakeXrayEngine";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_LINK = `vless://${UUID}@node.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=www.microsoft.com&type=tcp#Node`;

type Harness = {
  dataDir: string;
  engine: FakeXrayEngine;
  service: XrayService;
  settings: () => AppSettings;
  dispose: () => Promise<void>;
};

async function createHarness(patch: AppSettingsPatch = {}, options: { withBinary?: boolean } = {}): Promise<Harness> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-xray-"));
  const engine = await writeFakeXrayEngine(dataDir);
  let settings = normalizeSettings(mergeSettings(normalizeSettings(), patch));
  if (options.withBinary !== false) {
    settings = mergeSettings(settings, { xray: { customBinaryPath: engine.scriptPath } });
  }
  const service = new XrayService({
    dataDir,
    readSettings: async () => settings,
    saveSettings: async (nextPatch) => {
      settings = mergeSettings(settings, nextPatch);
      return settings;
    },
    spawnImpl: engine.spawnImpl,
    execFileImpl: engine.execFileImpl,
    platform: "linux",
    arch: "x64",
    log: () => undefined,
  });
  return {
    dataDir,
    engine,
    service,
    settings: () => settings,
    dispose: async () => {
      await service.stopAll();
      await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function xrayProxy(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return { ...defaultProfile().proxy, enabled: true, scheme: "xray", shareLink: VLESS_LINK, ...overrides };
}

function socksProxy(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return { ...defaultProfile().proxy, enabled: true, scheme: "socks5", host: "front.example.com", port: "1080", ...overrides };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("readStatus reports a missing engine until a binary is available", async () => {
  const harness = await createHarness({}, { withBinary: false });
  try {
    const missing = await harness.service.readStatus();
    assert.equal(missing.installed, false);
    assert.equal(missing.source, "missing");
    assert.equal(missing.binaryPath, path.join(harness.dataDir, "xray", "bin", "linux-x64", "xray"));
    assert.equal(missing.releaseAsset, "Xray-linux-64.zip");
    assert.deepEqual(missing.instances, []);

    await harness.service["options"].saveSettings?.({ xray: { customBinaryPath: harness.engine.scriptPath } });
    const installed = await harness.service.readStatus();
    assert.equal(installed.installed, true);
    assert.equal(installed.source, "custom");
    assert.equal(installed.version, "9.9.9-test");
  } finally {
    await harness.dispose();
  }
});

test("start spawns an engine on a free loopback port and stop tears it down", async () => {
  const harness = await createHarness();
  const events: string[] = [];
  try {
    const handle = await harness.service.start({
      ownerId: "profile-1",
      proxy: xrayProxy({ ipStrategy: "ipv4-first" }),
      fingerprint: { brand: "Microsoft Edge" },
      onEvent: (level, message, detail) => events.push(`${level}:${message}:${detail ?? ""}`),
    });
    assert.equal(handle.localProxyUrl, `socks5://127.0.0.1:${handle.port}`);
    assert.equal(handle.upstream, "vless://****@node.example.com:443#Node");
    assert.equal(handle.preProxy, undefined);
    assert.equal(await isLocalPortListening(handle.port), true);

    const status = await harness.service.readStatus();
    assert.equal(status.instances.length, 1);
    assert.equal(status.instances[0].ownerId, "profile-1");
    assert.equal(status.instances[0].port, handle.port);
    assert.equal(status.instances[0].restarts, 0);

    const config = JSON.parse(await fs.readFile(path.join(harness.dataDir, "xray", "instances", "profile-1", "config.json"), "utf8")) as {
      log: { loglevel: string };
      inbounds: Array<{ port: number; protocol: string }>;
      outbounds: Array<{ tag: string; protocol: string; streamSettings?: { sockopt?: { domainStrategy?: string }; realitySettings?: { fingerprint?: string } } }>;
    };
    assert.equal(config.inbounds[0].port, handle.port);
    assert.equal(config.inbounds[0].protocol, "socks");
    assert.equal(config.log.loglevel, "warning");
    assert.equal(config.outbounds[0].protocol, "vless");
    assert.deepEqual(config.outbounds[0].streamSettings?.sockopt, { domainStrategy: "UseIPv4v6" });
    // "auto" uTLS follows the profile's brand.
    assert.equal(config.outbounds[0].streamSettings?.realitySettings?.fingerprint, "edge");
    assert.ok(events.some((event) => event.startsWith("info:Xray 引擎已启动")));

    await handle.stop();
    assert.equal(await isLocalPortListening(handle.port), false);
    assert.deepEqual((await harness.service.readStatus()).instances, []);
  } finally {
    await harness.dispose();
  }
});

test("start chains a native proxy behind a front proxy and masks both", async () => {
  const harness = await createHarness();
  try {
    const handle = await harness.service.start({
      ownerId: "profile-chain",
      proxy: socksProxy({ host: "target.example.com", port: "1081", preProxyId: "proxy-front" }),
      preProxy: xrayProxy(),
    });
    assert.equal(handle.upstream, "socks5://target.example.com:1081");
    assert.equal(handle.preProxy, "vless://****@node.example.com:443#Node");
    const config = JSON.parse(await fs.readFile(path.join(harness.dataDir, "xray", "instances", "profile-chain", "config.json"), "utf8")) as {
      outbounds: Array<{ tag: string; protocol: string; proxySettings?: { tag: string; transportLayer: boolean } }>;
    };
    assert.equal(config.outbounds[0].protocol, "socks");
    assert.deepEqual(config.outbounds[0].proxySettings, { tag: "proxy-pre", transportLayer: true });
    assert.equal(config.outbounds[1].tag, "proxy-pre");
    assert.equal(config.outbounds[1].protocol, "vless");
  } finally {
    await harness.dispose();
  }
});

test("start retries on another port when the engine reports a bind failure", async () => {
  const harness = await createHarness();
  try {
    harness.engine.plans.push({ failBind: true });
    const handle = await harness.service.start({ ownerId: "profile-bind", proxy: xrayProxy() });
    assert.equal(harness.engine.spawnCount, 2);
    assert.equal(await isLocalPortListening(handle.port), true);
  } finally {
    await harness.dispose();
  }
});

test("start fails with XRAY_STARTUP_FAILED and leaves no instance when the engine exits", async () => {
  const harness = await createHarness();
  try {
    harness.engine.plans.push({ exitCode: 5 });
    await assert.rejects(
      harness.service.start({ ownerId: "profile-dead", proxy: xrayProxy() }),
      (error: unknown) => (error as { code?: string }).code === "XRAY_STARTUP_FAILED" && /fake failure/.test((error as Error).message),
    );
    assert.equal(harness.engine.spawnCount, 1);
    assert.deepEqual((await harness.service.readStatus()).instances, []);
    assert.match((await harness.service.readStatus()).lastError ?? "", /Xray 引擎启动失败/);
  } finally {
    await harness.dispose();
  }
});

test("start refuses without a binary and rejects an unparsable share link", async () => {
  const harness = await createHarness({}, { withBinary: false });
  try {
    await assert.rejects(
      harness.service.start({ ownerId: "profile-none", proxy: xrayProxy() }),
      (error: unknown) => (error as { code?: string }).code === "XRAY_ENGINE_MISSING",
    );
  } finally {
    await harness.dispose();
  }
  const withBinary = await createHarness();
  try {
    await assert.rejects(withBinary.service.start({ ownerId: "profile-bad", proxy: xrayProxy({ shareLink: "vless://broken" }) }));
    assert.equal(withBinary.engine.spawnCount, 0);
  } finally {
    await withBinary.dispose();
  }
});

test("a crashed engine is restarted on the same port while the session runs", async () => {
  const harness = await createHarness();
  const events: string[] = [];
  try {
    harness.engine.plans.push({ crashAfterMs: 200 });
    const handle = await harness.service.start({
      ownerId: "profile-crash",
      proxy: xrayProxy(),
      onEvent: (level, message) => events.push(`${level}:${message}`),
    });
    await waitFor(() => events.includes("info:Xray 引擎已恢复"));
    assert.equal(harness.engine.spawnCount, 2);
    assert.equal(await isLocalPortListening(handle.port), true);
    const status = await harness.service.readStatus();
    assert.equal(status.instances[0]?.restarts, 1);
    assert.equal(status.instances[0]?.port, handle.port);
  } finally {
    await harness.dispose();
  }
});

test("auto restart can be switched off in settings", async () => {
  const harness = await createHarness({ xray: { autoRestart: false } });
  const events: string[] = [];
  try {
    harness.engine.plans.push({ crashAfterMs: 150 });
    await harness.service.start({
      ownerId: "profile-no-restart",
      proxy: xrayProxy(),
      onEvent: (level, message) => events.push(`${level}:${message}`),
    });
    await waitFor(() => events.includes("error:Xray 引擎未自动重启"));
    assert.equal(harness.engine.spawnCount, 1);
  } finally {
    await harness.dispose();
  }
});

test("withTemporaryProxy always stops the check instance", async () => {
  const harness = await createHarness();
  try {
    let seenPort = 0;
    const result = await harness.service.withTemporaryProxy({ proxy: xrayProxy() }, async (localProxyUrl) => {
      seenPort = Number(new URL(localProxyUrl).port);
      assert.equal(await isLocalPortListening(seenPort), true);
      assert.equal((await harness.service.readStatus()).instances.length, 1);
      return "ok";
    });
    assert.equal(result, "ok");
    assert.equal(await isLocalPortListening(seenPort), false);
    assert.deepEqual((await harness.service.readStatus()).instances, []);

    await assert.rejects(
      harness.service.withTemporaryProxy({ proxy: xrayProxy() }, async () => {
        throw new Error("probe failed");
      }),
      /probe failed/,
    );
    assert.deepEqual((await harness.service.readStatus()).instances, []);
  } finally {
    await harness.dispose();
  }
});

test("install downloads, verifies and unpacks the release for this platform", async () => {
  const harness = await createHarness({}, { withBinary: false });
  const archive = zipSync({
    "Xray-linux-64/xray": new TextEncoder().encode("#!/bin/sh\necho fake\n"),
    "geoip.dat": new TextEncoder().encode("geoip"),
    "geosite.dat": new TextEncoder().encode("geosite"),
    "README.md": new TextEncoder().encode("readme"),
  });
  const digest = await sha256Hex(archive);
  const requested: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    requested.push(url);
    if (url === "https://api.github.com/repos/XTLS/Xray-core/releases/latest") {
      return new Response(JSON.stringify({ tag_name: "v25.9.1" }), { status: 200 });
    }
    if (url === "https://mirror.example.test/https://github.com/XTLS/Xray-core/releases/download/v25.9.1/Xray-linux-64.zip") {
      return new Response(archive, { status: 200 });
    }
    if (url === "https://mirror.example.test/https://github.com/XTLS/Xray-core/releases/download/v25.9.1/Xray-linux-64.zip.dgst") {
      return new Response(`MD5= abc\nSHA1= def\nSHA2-256= ${digest}\nSHA2-512= ghi\n`, { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const service = new XrayService({
    dataDir: harness.dataDir,
    readSettings: async () => harness.settings(),
    saveSettings: (patch) => harness.service["options"].saveSettings!(patch),
    fetchImpl,
    resolveMirrorPrefix: async () => "https://mirror.example.test/",
    spawnImpl: harness.engine.spawnImpl,
    execFileImpl: harness.engine.execFileImpl,
    platform: "linux",
    arch: "x64",
    log: () => undefined,
  });
  try {
    const status = await service.install();
    assert.equal(status.installed, true);
    assert.equal(status.source, "managed");
    assert.equal(status.version, "9.9.9-test");
    const binaryDir = path.join(harness.dataDir, "xray", "bin", "linux-x64");
    assert.equal(await fs.readFile(path.join(binaryDir, "xray"), "utf8"), "#!/bin/sh\necho fake\n");
    assert.equal(await fs.readFile(path.join(binaryDir, "geoip.dat"), "utf8"), "geoip");
    assert.equal(await fs.readFile(path.join(binaryDir, "geosite.dat"), "utf8"), "geosite");
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(binaryDir, "xray"))).mode & 0o111, 0o111);
    assert.equal(harness.settings().xray.lastUpdateCheck?.latestVersion, "25.9.1");
    assert.equal(harness.settings().xray.lastUpdateCheck?.updateAvailable, false);
    assert.ok(requested.some((url) => url.startsWith("https://mirror.example.test/")), "the mirror prefix is applied to the download");

    // A second install over the existing directory replaces it cleanly.
    await service.install();
    assert.equal(await fs.readFile(path.join(binaryDir, "geosite.dat"), "utf8"), "geosite");
    assert.deepEqual(
      (await fs.readdir(path.join(harness.dataDir, "xray", "bin"))).sort(),
      ["linux-x64"],
    );
  } finally {
    await harness.dispose();
  }
});

test("install rejects a checksum mismatch and a running engine", async () => {
  const harness = await createHarness();
  const archive = zipSync({ xray: new TextEncoder().encode("fake") });
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/releases/latest")) return new Response(JSON.stringify({ tag_name: "v25.9.1" }), { status: 200 });
    if (url.endsWith(".zip.dgst")) return new Response(`SHA2-256= ${"0".repeat(64)}\n`, { status: 200 });
    if (url.endsWith(".zip")) return new Response(archive, { status: 200 });
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const service = new XrayService({
    dataDir: harness.dataDir,
    readSettings: async () => normalizeSettings(),
    fetchImpl,
    spawnImpl: harness.engine.spawnImpl,
    execFileImpl: harness.engine.execFileImpl,
    platform: "linux",
    arch: "x64",
    log: () => undefined,
  });
  try {
    await assert.rejects(service.install(), (error: unknown) => (error as { code?: string }).code === "XRAY_CHECKSUM_MISMATCH");
    assert.equal((await service.readStatus()).installed, false);

    await harness.service.start({ ownerId: "profile-busy", proxy: xrayProxy() });
    await assert.rejects(harness.service.install(), (error: unknown) => (error as { code?: string }).code === "XRAY_INSTANCES_RUNNING");
  } finally {
    await harness.dispose();
  }
});

test("checkUpdate compares the installed version with the latest release and persists the answer", async () => {
  const harness = await createHarness();
  const fetchImpl = (async () => new Response(JSON.stringify({ tag_name: "v99.0.0" }), { status: 200 })) as typeof fetch;
  const service = new XrayService({
    dataDir: harness.dataDir,
    readSettings: async () => harness.settings(),
    saveSettings: (patch) => harness.service["options"].saveSettings!(patch),
    fetchImpl,
    spawnImpl: harness.engine.spawnImpl,
    execFileImpl: harness.engine.execFileImpl,
    platform: "linux",
    arch: "x64",
    log: () => undefined,
  });
  try {
    const check = await service.checkUpdate();
    assert.equal(check.currentVersion, "9.9.9-test");
    assert.equal(check.latestVersion, "99.0.0");
    assert.equal(check.updateAvailable, true);
    assert.equal(check.downloadUrl, "https://github.com/XTLS/Xray-core/releases/download/v99.0.0/Xray-linux-64.zip");
    assert.equal(harness.settings().xray.lastUpdateCheck?.latestVersion, "99.0.0");
    assert.equal((await service.readStatus()).lastUpdateCheck?.updateAvailable, true);
  } finally {
    await harness.dispose();
  }
});

test("checkUpdate records a lookup failure instead of throwing", async () => {
  const harness = await createHarness();
  const fetchImpl = (async () => new Response("rate limited", { status: 403 })) as typeof fetch;
  const service = new XrayService({
    dataDir: harness.dataDir,
    readSettings: async () => harness.settings(),
    saveSettings: (patch) => harness.service["options"].saveSettings!(patch),
    fetchImpl,
    spawnImpl: harness.engine.spawnImpl,
    execFileImpl: harness.engine.execFileImpl,
    platform: "linux",
    arch: "x64",
    log: () => undefined,
  });
  try {
    const check = await service.checkUpdate();
    assert.equal(check.updateAvailable, false);
    assert.match(check.error ?? "", /HTTP 403/);
  } finally {
    await harness.dispose();
  }
});

test("engineLogHint keeps the engine's own explanation and drops the log noise", () => {
  const log = [
    "Xray 26.3.27 (Xray, Penetrates Everything.)",
    "2026/09/08 01:22:18.992190 [Info] infra/conf/serial: Reading config: &{Name:config.json Format:json}",
    "2026/09/08 01:22:19.001 [Warning] core: Xray 26.3.27 started",
    "2026/09/08 01:22:20.120 from tcp:127.0.0.1:52768 accepted tcp:ip.example:443 [socks-in -> proxy-main]",
    "2026/09/08 01:22:20.320 [Warning] [1234] app/proxyman/outbound: failed to process outbound traffic > proxy/vless/outbound: failed to find an available destination > dial tcp: lookup hk.example.invalid: no such host",
  ].join("\n");
  assert.equal(
    engineLogHint(log),
    "[1234] app/proxyman/outbound: failed to process outbound traffic > proxy/vless/outbound: failed to find an available destination > dial tcp: lookup hk.example.invalid: no such host",
  );
  assert.equal(engineLogHint("Xray started\nall good"), undefined);
  assert.equal(engineLogHint(""), undefined);
});

test("version and digest helpers", () => {
  assert.equal(compareVersions("25.9.1", "25.9.0"), 1);
  assert.equal(compareVersions("v25.9.1", "25.9.1"), 0);
  assert.equal(compareVersions("1.8.24", "1.8.3"), 1);
  assert.equal(compareVersions("1.8.3", "1.10.0"), -1);
  assert.equal(parseSha256Digest(`MD5= x\nSHA2-256= ${"a".repeat(64)}\n`), "a".repeat(64));
  assert.equal(parseSha256Digest("SHA256: " + "b".repeat(64)), "b".repeat(64));
  assert.equal(parseSha256Digest("nothing here"), undefined);
});

async function sha256Hex(data: Uint8Array): Promise<string> {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(data).digest("hex");
}
