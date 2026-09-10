import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  SMOKE_RELEASE_ARGV,
  parseRequireInstaller,
  requiredReleaseArtifacts,
} from "./release-gates.mjs";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));

const ARTIFACT_INPUT = {
  portableDir: path.join("C:", "build", "release", "CBPanel-win-portable"),
  portableZip: path.join("C:", "build", "release", "CBPanel-win-portable.zip"),
  sidecarPath: path.join("C:", "build", "sidecars", "cbpanel-sidecar-x86_64-pc-windows-msvc.exe"),
  installerPath: path.join("C:", "build", "bundle", "nsis", "CBPanel_0.1.0_x64-setup.exe"),
};

/** The five portable layout artifacts, relative to the release smoke's fixture paths. */
const PORTABLE_ARTIFACTS = [
  path.join(ARTIFACT_INPUT.portableDir, "CBPanel.exe"),
  path.join(ARTIFACT_INPUT.portableDir, "WebView2Loader.dll"),
  path.join(ARTIFACT_INPUT.portableDir, "sidecars", path.basename(ARTIFACT_INPUT.sidecarPath)),
  path.join(ARTIFACT_INPUT.portableDir, "portable-data"),
  ARTIFACT_INPUT.portableZip,
];

function artifactPaths(requireInstaller) {
  return requiredReleaseArtifacts({ ...ARTIFACT_INPUT, requireInstaller }).map((artifact) => artifact.path);
}

test("the installer gate turns on for both flag spellings and never off", () => {
  assert.equal(parseRequireInstaller(["--require-installer"]), true);
  assert.equal(parseRequireInstaller(["--require-installer=true"]), true);
  // The value is deliberately not read: `=false` states the caller's intent to gate, not a setting
  // that turns the gate off.
  assert.equal(parseRequireInstaller(["--require-installer=false"]), true);

  assert.equal(parseRequireInstaller([]), false);
  assert.equal(parseRequireInstaller(["node", "scripts/smoke-release.mjs"]), false);
  assert.equal(parseRequireInstaller(["--installer", "--no-require-installer"]), false);
  // A longer flag that merely starts with the same text is not the gate.
  assert.equal(parseRequireInstaller(["--require-installer-extra"]), false);
  assert.equal(parseRequireInstaller(["--other=--require-installer"]), false);
});

test("the installer is required only when the gate asked for it, and it is the only optional artifact", () => {
  const withoutInstaller = artifactPaths(false);
  const withInstaller = artifactPaths(true);

  assert.equal(withoutInstaller.includes(ARTIFACT_INPUT.installerPath), false);
  assert.equal(withInstaller.includes(ARTIFACT_INPUT.installerPath), true);
  // Appended last: the portable layout is checked first, so its failures surface before the installer's.
  assert.deepEqual(withInstaller, [...withoutInstaller, ARTIFACT_INPUT.installerPath]);
  assert.equal(
    requiredReleaseArtifacts({ ...ARTIFACT_INPUT, requireInstaller: true })
      .find((artifact) => artifact.path === ARTIFACT_INPUT.installerPath)?.message,
    "Windows installer is missing. Run npm run release:windows to produce it.",
  );
});

test("the five portable artifacts and the generated sidecar are required in both gate states", () => {
  for (const [label, paths] of [["without", artifactPaths(false)], ["with", artifactPaths(true)]]) {
    for (const artifact of [ARTIFACT_INPUT.sidecarPath, ...PORTABLE_ARTIFACTS]) {
      assert.ok(paths.includes(artifact), `${artifact} must stay required ${label} the installer gate`);
    }
  }
});

test("the Windows release forwards the installer gate through the shared smoke argv", () => {
  assert.deepEqual([...SMOKE_RELEASE_ARGV], ["--require-installer"]);
  assert.equal(parseRequireInstaller(SMOKE_RELEASE_ARGV), true);
});

/**
 * The two CLIs cannot be imported by a test: `release-windows.mjs` starts an npm build on its first
 * statement, and `smoke-release.mjs` spawns the packaged app. Their wiring is therefore pinned at the
 * source level, with each match anchored to the invocation it is about: the spread must sit in the
 * smoke invocation's own argv, and the parser's result must be the value handed to the artifact list.
 * The gate decisions above are executed for real, so both halves of the contract fail on their own
 * mutation: deleting the flag or the artifact checks here fails these assertions, and relaxing the
 * checks inside the module fails the tests above.
 *
 * What this cannot prove: control flow. A call moved under a false branch, or a value passed through
 * another variable, still reads as correct here. It is a wiring-text check, not a behavioural one.
 */
test("the release CLIs wire their smoke invocation to the shared gate module", () => {
  const releaseSource = fs.readFileSync(path.join(scriptsDir, "release-windows.mjs"), "utf8");
  assert.match(
    releaseSource,
    /execFileSync\(\s*"node"\s*,\s*\[\s*"scripts\/smoke-release\.mjs"\s*,\s*\.\.\.SMOKE_RELEASE_ARGV\s*\]/,
    "release-windows.mjs must spread SMOKE_RELEASE_ARGV inside the smoke invocation",
  );
  assert.equal(releaseSource.includes("--require-installer"), false, "the flag must live in release-gates.mjs only");

  const smokeSource = fs.readFileSync(path.join(scriptsDir, "smoke-release.mjs"), "utf8");
  assert.match(
    smokeSource,
    /const requireInstaller = parseRequireInstaller\(process\.argv\);/,
    "smoke-release.mjs must read the gate through the shared parser",
  );
  assert.match(
    smokeSource,
    /requiredReleaseArtifacts\(\{[^}]*\brequireInstaller\b[^}]*\}\)/,
    "smoke-release.mjs must hand the parsed gate to the shared artifact list",
  );
});
