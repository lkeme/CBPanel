import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const releaseDir = path.join(root, "release");
const packageDir = path.join(releaseDir, "CBPanel-win-portable");
const sourceExe = path.join(root, "src-tauri", "target", "release", "cbpanel.exe");
const sourceSidecar = path.join(root, "sidecars", sidecarFileName(rustTarget));
const targetExe = path.join(packageDir, "CBPanel.exe");
const targetSidecarsDir = path.join(packageDir, "sidecars");
const zipPath = path.join(releaseDir, "CBPanel-win-portable.zip");
const requireSidecar = process.argv.includes("--require-sidecar");

await assertExists(sourceExe, "Desktop executable is missing. Run npm run desktop:build first.");

await fs.rm(packageDir, { recursive: true, force: true });
await fs.rm(zipPath, { force: true });
await fs.mkdir(path.join(packageDir, "portable-data"), { recursive: true });
await fs.writeFile(path.join(packageDir, "portable-data", ".gitkeep"), "", "utf8");
await fs.copyFile(sourceExe, targetExe);

if (await exists(sourceSidecar)) {
  await fs.mkdir(targetSidecarsDir, { recursive: true });
  await fs.copyFile(sourceSidecar, path.join(targetSidecarsDir, path.basename(sourceSidecar)));
} else {
  if (requireSidecar) {
    throw new Error(`Production portable release requires ${sourceSidecar}. Run npm run sidecar:build first.`);
  }
  await fs.mkdir(targetSidecarsDir, { recursive: true });
  await fs.writeFile(
    path.join(targetSidecarsDir, "README.txt"),
    [
      `CBPanel portable expects ${path.basename(sourceSidecar)} in this directory.`,
      "Development builds can validate the shell, but a production portable release needs the generated sidecar binary.",
      "",
    ].join("\r\n"),
    "utf8",
  );
}

await copyIfExists(path.join(root, "src-tauri", "target", "release", "WebView2Loader.dll"), packageDir);

execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -LiteralPath '${escapePowerShellSingleQuoted(packageDir)}' -DestinationPath '${escapePowerShellSingleQuoted(zipPath)}' -Force`,
  ],
  { stdio: "inherit" },
);

console.log(`Portable package written to ${zipPath}`);

async function assertExists(inputPath, message) {
  if (!(await exists(inputPath))) {
    throw new Error(message);
  }
}

async function exists(inputPath) {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(source, targetDirectory) {
  if (!(await exists(source))) return;
  await fs.copyFile(source, path.join(targetDirectory, path.basename(source)));
}

function escapePowerShellSingleQuoted(value) {
  return value.replaceAll("'", "''");
}
