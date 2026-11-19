import assert from "node:assert/strict";
import test from "node:test";

import {
  APP_UPDATE_STARTUP_CHECK_TTL_MS,
  type AppUpdateCheck,
  appUpdateAssetUrl,
  compareAppVersions,
  parseAppUpdateManifest,
  selectAppUpdateArtifact,
  shouldRunStartupAppUpdateCheck,
} from "./appUpdate";

const BASE_TIME = Date.parse("2026-11-19T12:00:00.000Z");

function check(attemptedAt: string, checkedAt?: string): AppUpdateCheck {
  return {
    attemptedAt,
    checkedAt,
    currentVersion: "1.0.10",
    updateAvailable: false,
  };
}

test("compareAppVersions orders numeric segments and treats a prerelease as older", () => {
  assert.equal(compareAppVersions("1.0.10", "1.0.9"), 1);
  assert.equal(compareAppVersions("1.0.10", "1.0.10.1"), -1);
  assert.equal(compareAppVersions("v1.0.10", "1.0.10"), 0);
  assert.equal(compareAppVersions("1.0.11-rc.1", "1.0.11"), -1);
  assert.equal(compareAppVersions("1.0.11", "1.0.11-rc.1"), 1);
});

test("shouldRunStartupAppUpdateCheck measures the TTL from the last attempt", () => {
  assert.equal(shouldRunStartupAppUpdateCheck(undefined, BASE_TIME), true);
  assert.equal(
    shouldRunStartupAppUpdateCheck(check(new Date(BASE_TIME - APP_UPDATE_STARTUP_CHECK_TTL_MS + 1).toISOString()), BASE_TIME),
    false,
  );
  assert.equal(
    shouldRunStartupAppUpdateCheck(check(new Date(BASE_TIME - APP_UPDATE_STARTUP_CHECK_TTL_MS).toISOString()), BASE_TIME),
    true,
  );
  assert.equal(shouldRunStartupAppUpdateCheck({ ...check(""), attemptedAt: "invalid-date" }, BASE_TIME), true);
  // A failed attempt still counts: the TTL must not let an offline machine retry on every launch.
  assert.equal(
    shouldRunStartupAppUpdateCheck(
      { ...check(new Date(BASE_TIME - 1000).toISOString()), error: "offline", errorCode: "APP_UPDATE_FETCH_FAILED" },
      BASE_TIME,
    ),
    false,
  );
});

test("parseAppUpdateManifest keeps well-formed artifacts and drops the rest", () => {
  const manifest = parseAppUpdateManifest({
    version: "1.0.11",
    generatedAt: "2026-11-19T00:00:00.000Z",
    signing: { codeSigned: true },
    artifacts: [
      {
        kind: "windows-installer",
        fileName: "CBPanel_1.0.11_x64-setup.exe",
        size: 1024,
        sha256: "a".repeat(64),
        url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe",
      },
      { kind: "unknown-kind", fileName: "x.zip", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/x.zip" },
      { kind: "windows-portable", fileName: "../evil.zip", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/evil.zip" },
      { kind: "linux-appimage", fileName: "CBPanel.AppImage", url: "http://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel.AppImage" },
      { kind: "macos-dmg", fileName: "CBPanel-macos-arm64.dmg", url: "https://example.test/CBPanel-macos-arm64.dmg" },
    ],
  });

  assert.ok(manifest);
  assert.equal(manifest.version, "1.0.11");
  assert.equal(manifest.signing?.codeSigned, true);
  assert.deepEqual(manifest.artifacts.map((artifact) => artifact.kind), ["windows-installer"]);
});

test("parseAppUpdateManifest refuses a manifest with no usable artifact", () => {
  assert.equal(parseAppUpdateManifest({ version: "1.0.11", artifacts: [] }), undefined);
  assert.equal(parseAppUpdateManifest({ version: "", artifacts: [] }), undefined);
  assert.equal(parseAppUpdateManifest({ version: "1.0.11", artifacts: "nope" }), undefined);
  assert.equal(parseAppUpdateManifest(null), undefined);
  assert.equal(parseAppUpdateManifest("manifest"), undefined);
});

test("selectAppUpdateArtifact picks the asset the running build can install", () => {
  const artifacts = parseAppUpdateManifest({
    version: "1.0.11",
    artifacts: [
      { kind: "windows-installer", fileName: "CBPanel_1.0.11_x64-setup.exe", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe" },
      { kind: "windows-portable", fileName: "CBPanel-win-portable.zip", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel-win-portable.zip" },
      { kind: "linux-appimage", fileName: "CBPanel-linux-x64.AppImage", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel-linux-x64.AppImage" },
      { kind: "macos-dmg", fileName: "CBPanel-macos-arm64.dmg", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel-macos-arm64.dmg" },
      { kind: "macos-dmg", fileName: "CBPanel-macos-x64.dmg", url: "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel-macos-x64.dmg" },
    ],
  })?.artifacts ?? [];

  assert.equal(selectAppUpdateArtifact(artifacts, { platform: "windows", portable: false })?.kind, "windows-installer");
  assert.equal(selectAppUpdateArtifact(artifacts, { platform: "windows", portable: true })?.kind, "windows-portable");
  assert.equal(selectAppUpdateArtifact(artifacts, { platform: "linux", portable: false })?.kind, "linux-appimage");
  assert.equal(selectAppUpdateArtifact(artifacts, { platform: "macos", arch: "arm64", portable: false })?.fileName, "CBPanel-macos-arm64.dmg");
  assert.equal(selectAppUpdateArtifact(artifacts, { platform: "macos", arch: "x64", portable: false })?.fileName, "CBPanel-macos-x64.dmg");
  assert.equal(selectAppUpdateArtifact(artifacts, { platform: "unknown", portable: false }), undefined);
  assert.equal(selectAppUpdateArtifact([], { platform: "windows", portable: false }), undefined);
});

test("appUpdateAssetUrl rebuilds the release download URL and refuses anything path-like", () => {
  assert.equal(
    appUpdateAssetUrl("1.0.11", "CBPanel_1.0.11_x64-setup.exe"),
    "https://github.com/lkeme/CBPanel/releases/download/v1.0.11/CBPanel_1.0.11_x64-setup.exe",
  );
  assert.equal(appUpdateAssetUrl("1.0.11", "../evil.zip"), undefined);
  assert.equal(appUpdateAssetUrl("1.0.11", "a/b.zip"), undefined);
  assert.equal(appUpdateAssetUrl("1.0.11", "..zip"), undefined);
  assert.equal(appUpdateAssetUrl("1.0.11", ".hidden"), undefined);
  assert.equal(appUpdateAssetUrl("1.0.11/../../x", "a.zip"), undefined);
  assert.equal(appUpdateAssetUrl("", "a.zip"), undefined);
});
