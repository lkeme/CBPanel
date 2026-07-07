import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const releaseDir = path.join(root, "release");
const packageDir = path.join(releaseDir, "CBPanel-win-portable");
const stagingRoot = path.join(releaseDir, ".portable-staging");
const stagingPackageDir = path.join(stagingRoot, "CBPanel-win-portable");
const sourceExe = path.join(root, "src-tauri", "target", "release", "cbpanel.exe");
const sourceSidecar = path.join(root, "sidecars", sidecarFileName(rustTarget));
const zipPath = path.join(releaseDir, "CBPanel-win-portable.zip");
const requireSidecar = process.argv.includes("--require-sidecar");

await assertExists(sourceExe, "Desktop executable is missing. Run npm run desktop:build first.");

await fs.rm(stagingRoot, { recursive: true, force: true });
await fs.rm(zipPath, { force: true });
await preparePortableDirectory(stagingPackageDir, { clean: true });

execFileSync(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    `Compress-Archive -LiteralPath '${escapePowerShellSingleQuoted(stagingPackageDir)}' -DestinationPath '${escapePowerShellSingleQuoted(zipPath)}' -Force`,
  ],
  { stdio: "inherit" },
);

await preparePortableDirectory(packageDir, { clean: false });
await fs.rm(stagingRoot, { recursive: true, force: true });

console.log(`Portable package written to ${zipPath}`);
console.log(`Extracted portable app refreshed at ${packageDir}`);

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

async function preparePortableDirectory(targetDirectory, { clean }) {
  if (clean) {
    await fs.rm(targetDirectory, { recursive: true, force: true });
  } else {
    await removeGeneratedPortableFiles(targetDirectory);
  }

  const targetExe = path.join(targetDirectory, "CBPanel.exe");
  const targetSidecarsDir = path.join(targetDirectory, "sidecars");

  await fs.mkdir(path.join(targetDirectory, "portable-data"), { recursive: true });
  await fs.writeFile(path.join(targetDirectory, "portable-data", ".gitkeep"), "", "utf8");
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

  await copyWebView2Loader(targetDirectory);
}

async function copyWebView2Loader(targetDirectory) {
  const source = await resolveWebView2Loader();
  if (!source) {
    const targetArch = webView2LoaderArchForRustTarget(rustTarget);
    throw new Error(
      [
        `Windows portable release requires WebView2Loader.dll for ${rustTarget}.`,
        `Expected it at src-tauri/target/release/WebView2Loader.dll or in a webview2-com-sys build output ${targetArch} directory.`,
        "Run a clean Tauri release build and ensure the webview2-com-sys crate artifacts are available before packaging.",
      ].join(" "),
    );
  }
  await fs.copyFile(source, path.join(targetDirectory, "WebView2Loader.dll"));
}

async function resolveWebView2Loader() {
  const directOutput = path.join(root, "src-tauri", "target", "release", "WebView2Loader.dll");
  if (await exists(directOutput)) return directOutput;

  const targetArch = webView2LoaderArchForRustTarget(rustTarget);
  const buildDir = path.join(root, "src-tauri", "target", "release", "build");
  let entries;
  try {
    entries = await fs.readdir(buildDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("webview2-com-sys-")) continue;
    const candidate = path.join(buildDir, entry.name, "out", targetArch, "WebView2Loader.dll");
    if (await exists(candidate)) {
      const stat = await fs.stat(candidate);
      candidates.push({ path: candidate, mtimeMs: stat.mtimeMs });
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return candidates[0]?.path ?? null;
}

function webView2LoaderArchForRustTarget(inputRustTarget) {
  if (inputRustTarget.startsWith("x86_64-")) return "x64";
  if (inputRustTarget.startsWith("i686-")) return "x86";
  if (inputRustTarget.startsWith("aarch64-")) return "arm64";
  throw new Error(`Unsupported Windows WebView2Loader target: ${inputRustTarget}`);
}

async function removeGeneratedPortableFiles(targetDirectory) {
  await fs.mkdir(targetDirectory, { recursive: true });
  await fs.rm(path.join(targetDirectory, "CBPanel.exe"), { force: true });
  await fs.rm(path.join(targetDirectory, "WebView2Loader.dll"), { force: true });
  await fs.rm(path.join(targetDirectory, "sidecars"), { recursive: true, force: true });
}

function escapePowerShellSingleQuoted(value) {
  return value.replaceAll("'", "''");
}
