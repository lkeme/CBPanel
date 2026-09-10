// Release gates as a side-effect-free module: `npm test` runs `scripts/**/*.test.ts`, and the CLIs
// that consume this file cannot be imported by a test (their first statement starts a build), so the
// gate decisions live here where they can be executed and the CLIs keep only the wiring.

import path from "node:path";

/** The release-smoke flag that makes the NSIS installer a required artifact. */
export const SMOKE_REQUIRE_INSTALLER_FLAG = "--require-installer";

/**
 * Accepts `--require-installer` and the valued form `--require-installer=true` alike. The value is
 * deliberately not read: the flag states the caller's intent, not a setting, and treating `=false` as
 * "off" would turn "I asked for the gate" into "I thought I asked for the gate".
 */
export function parseRequireInstaller(argv) {
  return argv.some((arg) => arg === SMOKE_REQUIRE_INSTALLER_FLAG || arg.startsWith(`${SMOKE_REQUIRE_INSTALLER_FLAG}=`));
}

/**
 * The argv `scripts/release-windows.mjs` uses to invoke `scripts/smoke-release.mjs`. Windows releases
 * are the pipeline that ships the installer, so the flag belongs to that invocation and not to the
 * smoke script's happy path: `npm run release:smoke` stays runnable against a portable-only build.
 */
export const SMOKE_RELEASE_ARGV = [SMOKE_REQUIRE_INSTALLER_FLAG];

/**
 * Every artifact `scripts/smoke-release.mjs` must find before it starts the packaged app, in check
 * order, as `{ path, message }` pairs.
 *
 * The five portable artifacts and the generated sidecar are unconditional: the portable layout is
 * what the smoke exercises, so no flag can turn any of them off. Only the installer is gated, through
 * `parseRequireInstaller` — a gate is an extra requirement, never a relaxation of the base ones.
 */
export function requiredReleaseArtifacts({ portableDir, portableZip, sidecarPath, installerPath, requireInstaller }) {
  const artifacts = [
    { path: sidecarPath, message: "Missing generated sidecar executable." },
    { path: path.join(portableDir, "CBPanel.exe"), message: "Portable CBPanel.exe is missing." },
    { path: path.join(portableDir, "WebView2Loader.dll"), message: "Portable WebView2Loader.dll is missing." },
    { path: path.join(portableDir, "sidecars", path.basename(sidecarPath)), message: "Portable sidecar is missing." },
    { path: path.join(portableDir, "portable-data"), message: "Portable data directory is missing." },
    { path: portableZip, message: "Portable ZIP is missing." },
  ];
  if (requireInstaller) {
    artifacts.push({ path: installerPath, message: "Windows installer is missing. Run npm run release:windows to produce it." });
  }
  return artifacts;
}
