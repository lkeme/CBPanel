import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, isLinuxRustTarget, isWindowsRustTarget, releasePlatformForRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sidecarBase = process.env.CBPANEL_SIDECAR_BASE ?? "../sidecars/cbpanel-sidecar";
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const configPath = path.join(root, "src-tauri", "tauri.release.sidecar.conf.json");
const platform = releasePlatformForRustTarget(rustTarget);

await assertExists(sidecarPath, [
  `Missing production sidecar: ${sidecarPath}`,
  "Run npm run sidecar:build before release packaging.",
].join("\n"));

if (!isWindowsRustTarget(rustTarget) && !isLinuxRustTarget(rustTarget)) {
  throw new Error(`Unsupported CBPanel release target: ${rustTarget}`);
}

const config = {
  bundle: {
    externalBin: [sidecarBase],
    targets: platform === "windows" ? ["nsis"] : ["appimage"],
  },
};

await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
console.log(`Release Tauri config for ${platform} written to ${configPath}`);

async function assertExists(inputPath, message) {
  try {
    await fs.access(inputPath);
  } catch {
    throw new Error(message);
  }
}
