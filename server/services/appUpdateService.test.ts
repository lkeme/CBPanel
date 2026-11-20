import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_APP_SETTINGS, mergeSettings, type AppSettings, type AppSettingsPatch } from "../../src/shared/settings";
import { AppUpdateService } from "./appUpdateService";

const MANIFEST_URL = "https://updates.example.test/app-update-manifest.json";
const NOW = "2026-11-19T12:00:00.000Z";

function manifestBody(version: string, fileName = `CBPanel_${version}_x64-setup.exe`): string {
  return JSON.stringify({
    version,
    generatedAt: NOW,
    signing: { codeSigned: false, updaterSigned: false },
    artifacts: [
      {
        kind: "windows-installer",
        fileName,
        size: 2048,
        sha256: "b".repeat(64),
        url: `https://github.com/lkeme/CBPanel/releases/download/v${version}/${fileName}`,
      },
      {
        kind: "windows-portable",
        fileName: "CBPanel-win-portable.zip",
        url: `https://github.com/lkeme/CBPanel/releases/download/v${version}/CBPanel-win-portable.zip`,
      },
    ],
  });
}

function jsonResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function createHarness(options: {
  responses?: Array<Response | Error>;
  settings?: AppSettings;
  portable?: boolean;
} = {}) {
  let settings = options.settings ?? DEFAULT_APP_SETTINGS;
  const queue = [...(options.responses ?? [])];
  const requests: string[] = [];
  const saved: AppSettingsPatch[] = [];
  const service = new AppUpdateService({
    currentVersion: "1.0.10",
    manifestUrl: MANIFEST_URL,
    readSettings: async () => settings,
    saveSettings: async (patch) => {
      saved.push(patch);
      settings = mergeSettings(settings, patch);
      return settings;
    },
    fetchImpl: async (input) => {
      requests.push(String(input));
      const next = queue.shift();
      if (!next) throw new Error("no queued response");
      if (next instanceof Error) throw next;
      return next;
    },
    platform: "win32",
    arch: "x64",
    portable: options.portable ?? false,
    now: () => new Date(NOW),
  });
  return {
    service,
    requests,
    saved,
    settings: () => settings,
    push: (response: Response | Error) => queue.push(response),
  };
}

test("a newer manifest reports an update and stores the matching artifact", async () => {
  const harness = createHarness({ responses: [jsonResponse(manifestBody("1.0.11"))] });

  const check = await harness.service.check();

  assert.equal(check.updateAvailable, true);
  assert.equal(check.currentVersion, "1.0.10");
  assert.equal(check.latestVersion, "1.0.11");
  assert.equal(check.checkedAt, NOW);
  assert.equal(check.attemptedAt, NOW);
  assert.equal(check.error, undefined);
  assert.equal(check.releaseUrl, "https://github.com/lkeme/CBPanel/releases/tag/v1.0.11");
  assert.equal(check.download?.kind, "windows-installer");
  assert.equal(check.download?.fileName, "CBPanel_1.0.11_x64-setup.exe");
  assert.equal(
    check.download?.url,
    "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe",
  );
  assert.deepEqual(harness.requests, [MANIFEST_URL]);
  assert.equal(harness.settings().appUpdate.lastUpdateCheck?.latestVersion, "1.0.11");
});

test("the portable build selects the portable asset", async () => {
  const harness = createHarness({ responses: [jsonResponse(manifestBody("1.0.11"))], portable: true });

  const check = await harness.service.check();

  assert.equal(check.download?.kind, "windows-portable");
  assert.equal(check.download?.fileName, "CBPanel-win-portable.zip");
});

test("an equal or older manifest reports no update", async () => {
  const harness = createHarness({
    responses: [jsonResponse(manifestBody("1.0.10")), jsonResponse(manifestBody("1.0.9"))],
  });

  assert.equal((await harness.service.check()).updateAvailable, false);
  assert.equal((await harness.service.check()).updateAvailable, false);
});

test("a failed attempt keeps the previous verdict and records the error", async () => {
  const harness = createHarness({
    responses: [jsonResponse(manifestBody("1.0.11")), jsonResponse("gone", 404)],
  });
  await harness.service.check();

  const check = await harness.service.check();

  assert.equal(check.updateAvailable, true);
  assert.equal(check.latestVersion, "1.0.11");
  assert.equal(check.download?.kind, "windows-installer");
  assert.equal(check.checkedAt, NOW, "the successful check time is retained");
  assert.equal(check.errorCode, "APP_UPDATE_HTTP_404");
  assert.ok(check.error);
});

test("a first-ever failure reports no update and no stale fields", async () => {
  const harness = createHarness({ responses: [new Error("network down")] });

  const check = await harness.service.check();

  assert.equal(check.updateAvailable, false);
  assert.equal(check.latestVersion, undefined);
  assert.equal(check.checkedAt, undefined);
  assert.equal(check.attemptedAt, NOW);
  assert.equal(check.errorCode, "APP_UPDATE_FETCH_FAILED");
  assert.equal(check.error, "network down");
});

test("a malformed manifest and an oversized body are refused", async () => {
  const harness = createHarness({
    responses: [
      jsonResponse("not json"),
      jsonResponse(JSON.stringify({ version: "1.0.11", artifacts: [] })),
      jsonResponse(JSON.stringify({ version: "1.0.11", artifacts: [], padding: "x".repeat(300 * 1024) })),
    ],
  });

  assert.equal((await harness.service.check()).errorCode, "APP_UPDATE_MANIFEST_INVALID");
  assert.equal((await harness.service.check()).errorCode, "APP_UPDATE_MANIFEST_INVALID");
  assert.equal((await harness.service.check()).errorCode, "APP_UPDATE_MANIFEST_TOO_LARGE");
});

test("a timeout is reported as such", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });
  const harness = createHarness({ responses: [timeout] });

  const check = await harness.service.check();

  assert.equal(check.errorCode, "APP_UPDATE_TIMEOUT");
});

test("concurrent checks share one request", async () => {
  const harness = createHarness({ responses: [jsonResponse(manifestBody("1.0.11"))] });

  const [first, second] = await Promise.all([harness.service.check(), harness.service.check()]);

  assert.equal(harness.requests.length, 1);
  assert.equal(first.latestVersion, second.latestVersion);
});

test("the check writes only lastUpdateCheck", async () => {
  const harness = createHarness({ responses: [jsonResponse(manifestBody("1.0.11"))] });

  await harness.service.check();

  assert.deepEqual(Object.keys(harness.saved[0].appUpdate ?? {}), ["lastUpdateCheck"]);
});

test("a non-HTTPS manifest URL is refused before any request", async () => {
  const service = new AppUpdateService({
    currentVersion: "1.0.10",
    manifestUrl: "http://updates.example.test/app-update-manifest.json",
    readSettings: async () => DEFAULT_APP_SETTINGS,
    fetchImpl: async () => {
      throw new Error("must not be called");
    },
    platform: "win32",
    arch: "x64",
    now: () => new Date(NOW),
  });

  const check = await service.check();

  assert.equal(check.errorCode, "APP_UPDATE_MANIFEST_URL_UNSUPPORTED");
});

test("a configured mirror prefixes the public manifest request only", async () => {
  const requests: string[] = [];
  const service = new AppUpdateService({
    currentVersion: "1.0.10",
    readSettings: async () => DEFAULT_APP_SETTINGS,
    fetchImpl: async (input) => {
      requests.push(String(input));
      return jsonResponse(manifestBody("1.0.11"));
    },
    resolveMirrorPrefix: async () => "https://gh-proxy.com",
    platform: "win32",
    arch: "x64",
    now: () => new Date(NOW),
  });

  const check = await service.check();

  assert.deepEqual(requests, [
    "https://gh-proxy.com/https://github.com/lkeme/CBPanel/releases/latest/download/app-update-manifest.json",
  ]);
  assert.equal(check.updateAvailable, true);

  // The asset URL stored for the operator stays canonical: the shell rebuilds it from version+name.
  assert.equal(
    check.download?.url,
    "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe",
  );
});

test("a manifest URL override ignores the mirror prefix", async () => {
  const requests: string[] = [];
  const service = new AppUpdateService({
    currentVersion: "1.0.10",
    manifestUrl: MANIFEST_URL,
    readSettings: async () => DEFAULT_APP_SETTINGS,
    fetchImpl: async (input) => {
      requests.push(String(input));
      return jsonResponse(manifestBody("1.0.11"));
    },
    resolveMirrorPrefix: async () => "https://gh-proxy.com/",
    platform: "win32",
    arch: "x64",
    now: () => new Date(NOW),
  });

  await service.check();

  assert.deepEqual(requests, [MANIFEST_URL]);
});

test("read returns the stored check without touching the network", async () => {
  const harness = createHarness({ responses: [jsonResponse(manifestBody("1.0.11"))] });
  await harness.service.check();
  harness.requests.length = 0;

  const info = await harness.service.read();

  assert.equal(info.currentVersion, "1.0.10");
  assert.equal(info.check?.latestVersion, "1.0.11");
  assert.deepEqual(harness.requests, []);
});
