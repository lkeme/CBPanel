import assert from "node:assert/strict";
import http from "node:http";
import test, { after, before } from "node:test";
import type { AppUpdateCheck } from "../src/shared/appUpdate";
import type { AppSettings } from "../src/shared/settings";
import { startPanelHarness, type PanelHarness } from "./testing/httpHarness";

/**
 * The two app-update routes against the real entry point. The manifest is served by a local fixture so
 * the test never reaches GitHub; `CBPANEL_APP_UPDATE_MANIFEST_URL` is the documented override for that.
 */

let panel: PanelHarness;
let manifestServer: http.Server;
let manifestUrl: string;
let manifestBody = "";

before(async () => {
  manifestServer = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(manifestBody);
  });
  await new Promise<void>((resolve) => manifestServer.listen(0, "127.0.0.1", resolve));
  const address = manifestServer.address();
  if (typeof address !== "object" || address === null) throw new Error("fixture server did not bind");
  manifestUrl = `http://127.0.0.1:${address.port}/app-update-manifest.json`;

  panel = await startPanelHarness({ env: { CBPANEL_APP_UPDATE_MANIFEST_URL: manifestUrl } });
});

after(async () => {
  await panel?.dispose();
  await new Promise<void>((resolve) => manifestServer?.close(() => resolve()));
});

function setManifest(version: string): void {
  manifestBody = JSON.stringify({
    version,
    artifacts: [
      {
        kind: "windows-installer",
        fileName: `CBPanel_${version}_x64-setup.exe`,
        url: `https://github.com/lkeme/CBPanel/releases/download/v${version}/CBPanel_${version}_x64-setup.exe`,
      },
      {
        kind: "windows-portable",
        fileName: "CBPanel-win-portable.zip",
        url: `https://github.com/lkeme/CBPanel/releases/download/v${version}/CBPanel-win-portable.zip`,
      },
      {
        kind: "linux-appimage",
        fileName: "CBPanel-linux-x64.AppImage",
        url: `https://github.com/lkeme/CBPanel/releases/download/v${version}/CBPanel-linux-x64.AppImage`,
      },
      {
        kind: "macos-dmg",
        fileName: "CBPanel-macos-arm64.dmg",
        url: `https://github.com/lkeme/CBPanel/releases/download/v${version}/CBPanel-macos-arm64.dmg`,
      },
    ],
  });
}

test("the panel starts with no stored app update check", async () => {
  const info = await panel.request("GET", "/api/app-update");

  assert.equal(info.status, 200);
  const body = info.body as { currentVersion: string; check?: AppUpdateCheck };
  assert.equal(typeof body.currentVersion, "string");
  assert.ok(body.currentVersion.length > 0);
  assert.equal(body.check, undefined);
});

test("a check against a newer manifest is stored in settings", async () => {
  setManifest("999.0.0");

  const response = await panel.request("POST", "/api/app-update/check");

  assert.equal(response.status, 200);
  const check = response.body as AppUpdateCheck;
  assert.equal(check.updateAvailable, true);
  assert.equal(check.latestVersion, "999.0.0");
  assert.ok(check.download, "the platform's artifact is selected");
  assert.equal(check.error, undefined);

  const stored = (await panel.request("GET", "/api/settings")).body as AppSettings;
  assert.equal(stored.appUpdate.lastUpdateCheck?.latestVersion, "999.0.0");
  assert.equal(stored.appUpdate.lastUpdateCheck?.updateAvailable, true);
});

test("the stored check is what GET returns", async () => {
  const info = (await panel.request("GET", "/api/app-update")).body as { check?: AppUpdateCheck };

  assert.equal(info.check?.latestVersion, "999.0.0");
});

test("a manifest at the running version reports no update", async () => {
  const current = ((await panel.request("GET", "/api/app-update")).body as { currentVersion: string }).currentVersion;
  setManifest(current);

  const check = (await panel.request("POST", "/api/app-update/check")).body as AppUpdateCheck;

  assert.equal(check.updateAvailable, false);
  assert.equal(check.latestVersion, current);
});

test("writing another settings group keeps the stored check", async () => {
  const before = ((await panel.request("GET", "/api/app-update")).body as { check?: AppUpdateCheck }).check;

  const saved = await panel.request("PUT", "/api/settings", { appearance: { ...((await panel.request("GET", "/api/settings")).body as AppSettings).appearance, theme: "dark" } });

  assert.equal(saved.status, 200);
  assert.equal((saved.body as AppSettings).appUpdate.lastUpdateCheck?.latestVersion, before?.latestVersion);
});
