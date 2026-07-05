import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const releaseDir = path.join(root, "release");
const installerPath = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", `CBPanel_${packageJson.version}_x64-setup.exe`);
const portablePath = path.join(releaseDir, "CBPanel-win-portable.zip");
const linuxAppImagePath = path.join(releaseDir, "CBPanel-linux-x64.AppImage");
const macDmgPaths = [
  path.join(releaseDir, "CBPanel-macos-arm64.dmg"),
  path.join(releaseDir, "CBPanel-macos-x64.dmg"),
];
const manifestPath = path.join(releaseDir, "app-update-manifest.json");
const publishBaseUrl = process.env.CBPANEL_RELEASE_BASE_URL ?? "https://example.invalid/cbpanel/releases";
const platformScope = parsePlatformScope(process.argv.slice(2));
const macArchScope = parseMacArchScope(process.argv.slice(2));

const artifactSpecs = [
  {
    platform: "windows",
    kind: "windows-installer",
    filePath: installerPath,
    url: `${publishBaseUrl}/CBPanel_${packageJson.version}_x64-setup.exe`,
  },
  {
    platform: "windows",
    kind: "windows-portable",
    filePath: portablePath,
    url: `${publishBaseUrl}/CBPanel-win-portable.zip`,
  },
  {
    platform: "linux",
    kind: "linux-appimage",
    filePath: linuxAppImagePath,
    url: `${publishBaseUrl}/CBPanel-linux-x64.AppImage`,
  },
  ...macDmgPaths.filter((filePath) => macArchScope.has(macArchFromDmgPath(filePath))).map((filePath) => ({
    platform: "macos",
    kind: "macos-dmg",
    filePath,
    url: `${publishBaseUrl}/${path.basename(filePath)}`,
  })),
];

const artifacts = [];
for (const spec of artifactSpecs.filter((item) => platformScope.has(item.platform))) {
  const artifact = platformScope.size === 1
    ? await artifactInfo(spec.kind, spec.filePath, spec.url)
    : await optionalArtifactInfo(spec.kind, spec.filePath, spec.url);
  if (artifact) artifacts.push(artifact);
}

if (artifacts.length === 0) {
  throw new Error("No release artifacts were found for update manifest generation.");
}

const manifest = {
  version: packageJson.version,
  generatedAt: new Date().toISOString(),
  signing: {
    codeSigned: process.env.CBPANEL_CODE_SIGNED === "1",
    updaterSigned: Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY || process.env.TAURI_PRIVATE_KEY),
  },
  artifacts,
  notes: [
    "This manifest is release metadata for CBPanel's app updater pipeline.",
    "Do not publish unsigned artifacts to a production update channel.",
    "CloakBrowser Chromium binary updates are handled separately by the CloakBrowser package APIs.",
  ],
};

await fs.mkdir(releaseDir, { recursive: true });
await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
console.log(`Update manifest written to ${manifestPath}`);

async function artifactInfo(kind, filePath, url) {
  const bytes = await fs.readFile(filePath);
  return {
    kind,
    fileName: path.basename(filePath),
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    url,
  };
}

async function optionalArtifactInfo(kind, filePath, url) {
  try {
    return await artifactInfo(kind, filePath, url);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

function parsePlatformScope(args) {
  const platformArg = args.find((arg) => arg.startsWith("--platform="));
  const value = platformArg?.slice("--platform=".length) ?? "all";
  if (value === "all") return new Set(["windows", "linux", "macos"]);
  if (value === "windows" || value === "linux" || value === "macos") return new Set([value]);
  throw new Error(`Unsupported update manifest platform scope: ${value}`);
}

function parseMacArchScope(args) {
  const archArg = args.find((arg) => arg.startsWith("--mac-arch="));
  const value = archArg?.slice("--mac-arch=".length) ?? "all";
  if (value === "all") return new Set(["arm64", "x64"]);
  if (value === "arm64" || value === "x64") return new Set([value]);
  throw new Error(`Unsupported macOS artifact arch scope: ${value}`);
}

function macArchFromDmgPath(filePath) {
  const fileName = path.basename(filePath);
  if (fileName.includes("-arm64.")) return "arm64";
  if (fileName.includes("-x64.")) return "x64";
  throw new Error(`Unsupported macOS DMG artifact name: ${fileName}`);
}
