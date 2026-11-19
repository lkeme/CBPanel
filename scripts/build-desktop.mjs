/**
 * Guard for `npm run desktop:build`, which invokes `tauri build` directly.
 *
 * The Rust target is the host's, and this machine has two Rust installations: scoop's `rust-gnu`
 * and `rust`. Whichever shim comes first on PATH wins, so a build could silently compile the shell
 * for `x86_64-pc-windows-gnu` while the docs — and the sidecar lookup order — promise MSVC.
 *
 * This script resolves and pins the MSVC toolchain, then fails loudly instead of producing an
 * artifact that will not match its sidecar. `CBPANEL_ALLOW_NON_MSVC=1` opts out for a local build.
 */
import { execFileSync } from "node:child_process";

import { applySelectedWindowsToolchain, assertWindowsReleaseTarget, currentRustTarget, isWindowsReleaseBuild } from "./release-target.mjs";

if (!isWindowsReleaseBuild()) {
  console.log("CBPANEL_ALLOW_NON_MSVC=1: skipping the MSVC toolchain check (local build only).");
  process.exit(0);
}

applySelectedWindowsToolchain();
const rustTarget = currentRustTarget();
assertWindowsReleaseTarget(rustTarget);

// Tauri runs `cargo` from PATH; keep the exported environment so the shell and the sidecar agree.
console.log(`Building the desktop shell for ${rustTarget}.`);
execFileSync(process.execPath, ["node_modules/@tauri-apps/cli/tauri.js", "build", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
