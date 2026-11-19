import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, isLinuxRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const releaseConfigPath = path.join(root, "src-tauri", "tauri.release.sidecar.conf.json");
const releaseDir = path.join(root, "release");
const outputAppImage = path.join(releaseDir, "CBPanel-linux-x64.AppImage");
const npmExecPath = process.env.npm_execpath;

if (!isLinuxRustTarget(rustTarget)) {
  throw new Error(`Linux release only supports x86_64-unknown-linux-gnu. Current target: ${rustTarget}`);
}

runNpmScript("build");
execFileSync("node", ["scripts/build-sidecar.mjs"], { cwd: root, stdio: "inherit" });
await assertExists(sidecarPath, `Sidecar build did not produce the expected artifact: ${sidecarPath}`);

execFileSync("node", ["scripts/prepare-tauri-release-config.mjs"], { cwd: root, stdio: "inherit" });

const tauriArgs = ["build", "--config", releaseConfigPath];
if (process.env.CBPANEL_SKIP_SIGNING === "1") {
  tauriArgs.push("--no-sign");
}

execFileSync(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...tauriArgs], {
  cwd: root,
  stdio: "inherit",
});

await collectAppImage(outputAppImage);
execFileSync("node", ["scripts/generate-update-manifest.mjs", "--platform=linux"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/smoke-linux-release.mjs"], { cwd: root, stdio: "inherit" });

console.log(`Linux AppImage release artifact is ready: ${outputAppImage}`);

async function collectAppImage(outputPath) {
  const appImageDir = path.join(root, "src-tauri", "target", "release", "bundle", "appimage");
  const entries = await fs.readdir(appImageDir).catch(() => []);
  const appImages = entries.filter((entry) => entry.endsWith(".AppImage"));
  if (appImages.length !== 1) {
    throw new Error(`Expected one AppImage under ${appImageDir}, found ${appImages.length}.`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(path.join(appImageDir, appImages[0]), outputPath);
  await fs.chmod(outputPath, 0o755);
}

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

  execFileSync("npm", ["run", scriptName], { cwd: root, stdio: "inherit" });
}
