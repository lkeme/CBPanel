import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, isMacRustTarget, macArtifactArchForRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();

if (!isMacRustTarget(rustTarget)) {
  throw new Error(`macOS release only supports apple-darwin targets. Current target: ${rustTarget}`);
}

const artifactArch = macArtifactArchForRustTarget(rustTarget);
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const releaseConfigPath = path.join(root, "src-tauri", "tauri.release.sidecar.conf.json");
const releaseDir = path.join(root, "release");
const outputDmg = path.join(releaseDir, `CBPanel-macos-${artifactArch}.dmg`);
const npmExecPath = process.env.npm_execpath;

process.env.CBPANEL_RUST_TARGET = rustTarget;
runNpmScript("build");
execFileSync("node", ["scripts/build-sidecar.mjs"], { cwd: root, stdio: "inherit" });
await assertExists(sidecarPath, `Sidecar build did not produce the expected artifact: ${sidecarPath}`);

execFileSync("node", ["scripts/prepare-tauri-release-config.mjs"], { cwd: root, stdio: "inherit" });

execFileSync(process.execPath, [
  path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"),
  "build",
  "--config",
  releaseConfigPath,
  "--no-sign",
], {
  cwd: root,
  stdio: "inherit",
});

await collectDmg(outputDmg);
execFileSync("node", ["scripts/generate-update-manifest.mjs", "--platform=macos", `--mac-arch=${artifactArch}`], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/smoke-mac-release.mjs"], { cwd: root, stdio: "inherit" });

console.log(`macOS DMG release artifact is ready: ${outputDmg}`);

async function collectDmg(outputPath) {
  const dmgDir = path.join(root, "src-tauri", "target", "release", "bundle", "dmg");
  const entries = await fs.readdir(dmgDir).catch(() => []);
  const dmgs = entries.filter((entry) => entry.endsWith(".dmg"));
  if (dmgs.length !== 1) {
    throw new Error(`Expected one DMG under ${dmgDir}, found ${dmgs.length}.`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.copyFile(path.join(dmgDir, dmgs[0]), outputPath);
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
