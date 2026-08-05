import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isWindowsRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? "x86_64-pc-windows-msvc";
if (!isWindowsRustTarget(rustTarget)) {
  throw new Error(`Unsupported Windows release target: ${rustTarget}`);
}
process.env.CBPANEL_RUST_TARGET = rustTarget;
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const releaseConfigPath = path.join(root, "src-tauri", "tauri.release.sidecar.conf.json");
const npmExecPath = process.env.npm_execpath;

runNpmScript("build");
execFileSync("node", ["scripts/build-sidecar.mjs"], { cwd: root, stdio: "inherit" });
await assertExists(sidecarPath, `Sidecar build did not produce the expected artifact: ${sidecarPath}`);

execFileSync("node", ["scripts/prepare-tauri-release-config.mjs"], { cwd: root, stdio: "inherit" });

const buildArgs = ["tauri", "build", "--config", releaseConfigPath];
if (process.env.CBPANEL_SKIP_SIGNING === "1") {
  buildArgs.push("--no-sign");
}

execFileSync(process.execPath, [path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js"), ...buildArgs.slice(1)], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("node", ["scripts/package-windows-portable.mjs", "--require-sidecar"], {
  cwd: root,
  stdio: "inherit",
});
execFileSync("node", ["scripts/generate-update-manifest.mjs", "--platform=windows"], { cwd: root, stdio: "inherit" });
execFileSync("node", ["scripts/smoke-release.mjs"], { cwd: root, stdio: "inherit" });

console.log("Windows release artifacts are ready under release/ and src-tauri/target/release/bundle/nsis/.");

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
