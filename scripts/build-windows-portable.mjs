import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, isWindowsRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
if (!isWindowsRustTarget(rustTarget)) {
  throw new Error(`Unsupported Windows portable target: ${rustTarget}`);
}

process.env.CBPANEL_RUST_TARGET = rustTarget;

const npmExecPath = process.env.npm_execpath;
const releaseConfigPath = path.join(root, "src-tauri", "tauri.release.sidecar.conf.json");
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const desktopExePath = path.join(root, "src-tauri", "target", "release", "cbpanel.exe");
const desktopPdbPath = path.join(root, "src-tauri", "target", "release", "cbpanel.pdb");

runNpmScript("build");
execFileSync("node", ["scripts/build-sidecar.mjs"], { cwd: root, stdio: "inherit" });
await assertExists(sidecarPath, `Sidecar build did not produce the expected artifact: ${sidecarPath}`);

execFileSync("node", ["scripts/prepare-tauri-release-config.mjs"], { cwd: root, stdio: "inherit" });
await fs.rm(desktopExePath, { force: true });
await fs.rm(desktopPdbPath, { force: true });
execFileSync(process.execPath, [
  path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  "build",
  "--config",
  releaseConfigPath,
  "--no-bundle",
  "--no-sign",
], {
  cwd: root,
  stdio: "inherit",
});

await assertExists(desktopExePath, `Desktop executable was not built: ${desktopExePath}`);
execFileSync("node", ["scripts/package-windows-portable.mjs", "--require-sidecar"], {
  cwd: root,
  stdio: "inherit",
});

console.log("Windows portable artifacts are ready under release/.");

async function assertExists(inputPath, message) {
  try {
    await fs.access(inputPath);
  } catch {
    throw new Error(message);
  }
}

function runNpmScript(scriptName) {
  if (npmExecPath) {
    execFileSync(process.execPath, [npmExecPath, "run", scriptName], { cwd: root, stdio: "inherit" });
    return;
  }

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  execFileSync(npmCommand, ["run", scriptName], { cwd: root, stdio: "inherit" });
}
