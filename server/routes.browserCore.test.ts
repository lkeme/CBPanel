import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { zipSync } from "fflate";
import test, { after, before } from "node:test";
import type { AppSettings } from "../src/shared/settings";
import { startPanelHarness, type PanelHarness } from "./testing/httpHarness";

let panel: PanelHarness;

before(async () => { panel = await startPanelHarness(); });
after(async () => { await panel?.dispose(); });

test("channel activation refuses an uninstalled private core without changing the saved channel", async () => {
  const response = await panel.request("POST", "/api/browser-core/channel/activate", {
    channel: "private", mode: "online",
  });
  assert.equal(response.status, 409);
  const saved = await panel.request("GET", "/api/settings");
  assert.equal((saved.body as AppSettings).binary.coreChannel, "official");
});

test("private credentials are never accepted as ordinary settings or returned in app state", async () => {
  const secret = "private-route-test-secret-not-a-real-token";
  const saved = await panel.request("PUT", "/api/settings", {
    binary: { privateGithubToken: secret, privateToken: secret },
  });
  assert.equal(saved.status, 200);
  assert.ok(!JSON.stringify(saved.body).includes(secret));
  const state = await panel.request("GET", "/api/state");
  assert.ok(!JSON.stringify(state.body).includes(secret));
});

test("clearing an absent private token succeeds without returning a credential", async () => {
  const response = await panel.request("DELETE", "/api/browser-core/private/token");
  assert.equal(response.status, 200);
  assert.ok(!Object.hasOwn(response.body as object, "token"));
});

test("private release queries and failed configuration tests do not overwrite saved repository or credentials", async () => {
  const before = (await panel.request("GET", "/api/settings")).body as AppSettings;
  const queried = await panel.request("GET", "/api/browser-core/private/releases?repositoryUrl=https%3A%2F%2Fexample.invalid%2Fowner%2Frepo");
  assert.equal(queried.status, 400);
  const tested = await panel.request("POST", "/api/browser-core/private/test", {
    repositoryUrl: "https://example.invalid/owner/repo",
    token: "fixture-secret-must-not-be-saved",
  });
  assert.equal(tested.status, 400);
  const after = (await panel.request("GET", "/api/settings")).body as AppSettings;
  assert.equal(after.binary.privateRepositoryUrl, before.binary.privateRepositoryUrl);
  await assert.rejects(fs.stat(path.join(panel.dataDir, "private-github-token")), { code: "ENOENT" });
});

test("invalid activation parameters and direct settings patches cannot change the active channel", async () => {
  const invalid = await panel.request("POST", "/api/browser-core/channel/activate", { channel: "third-party", mode: "online" });
  assert.equal(invalid.status, 400);
  const bypass = await panel.request("PUT", "/api/settings", { binary: { coreChannel: "private" } });
  assert.equal(bypass.status, 409);
  const saved = (await panel.request("GET", "/api/settings")).body as AppSettings;
  assert.equal(saved.binary.coreChannel, "official");
});

test("HTTP offline import carries and validates a full private build revision hint", async () => {
  const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
  const executable = process.platform === "win32" ? "chrome.exe" : process.platform === "darwin" ? "Chromium.app/Contents/MacOS/Chromium" : "chrome";
  const archive = path.join(panel.dataDir, `cloakbrowser-${platform.replace(/^darwin-/, "macos-")}.zip`);
  await fs.writeFile(archive, zipSync({ [`chromium-v156.0.8078.47/${executable}`]: new TextEncoder().encode("fixture never launched") }));
  const first = await panel.request("POST", "/api/browser-core/import/analyze", { path: archive, targetChannel: "private" });
  assert.equal(first.status, 200);
  assert.equal((first.body as { requiresVersionHint: boolean }).requiresVersionHint, true);
  assert.equal((first.body as { allowed: boolean }).allowed, false);
  const wrong = await panel.request("POST", "/api/browser-core/import/install", { path: archive, targetChannel: "private", versionHint: "157.0.8078.47.1" });
  assert.equal(wrong.status, 400);
  const body = { path: archive, targetChannel: "private", versionHint: "156.0.8078.47.3" };
  const analyzed = await panel.request("POST", "/api/browser-core/import/analyze", body);
  assert.equal((analyzed.body as { versionHint: string }).versionHint, body.versionHint);
  const installed = await panel.request("POST", "/api/browser-core/import/install", body);
  assert.equal(installed.status, 200);
  assert.equal((installed.body as { info: { version: string } }).info.version, body.versionHint);
});

test("settings PUT clears an obsolete core check in its response and persisted settings", async () => {
  const oldCheck = { checkedAt: new Date().toISOString(), currentVersion: "155.0.8059.39.1", latestVersion: "156.0.8078.47.1", updateAvailable: true };
  const saved = await panel.request("PUT", "/api/settings", { binary: { privateRepositoryUrl: "https://github.com/owner/changed", lastUpdateCheck: oldCheck } });
  assert.equal(saved.status, 200);
  assert.equal((saved.body as AppSettings).binary.lastUpdateCheck, undefined);
  const stored = await panel.request("GET", "/api/settings");
  assert.equal((stored.body as AppSettings).binary.lastUpdateCheck, undefined);
  const core = await panel.request("GET", "/api/browser-core");
  assert.equal((core.body as { update?: unknown }).update, undefined);
});
