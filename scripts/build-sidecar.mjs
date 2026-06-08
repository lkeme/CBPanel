import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { currentRustTarget, pkgTargetForRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const buildDir = path.join(root, "release", "sidecar-build");
const bundledEntry = path.join(buildDir, "server.cjs");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const target = process.env.CBPANEL_SIDECAR_TARGET ?? pkgTargetForRustTarget(rustTarget);
const sidecarName = process.env.CBPANEL_SIDECAR_NAME ?? "cbpanel-sidecar";
const output = path.join(root, "sidecars", sidecarFileName(rustTarget, sidecarName));
const pkgConfigPath = path.join(root, ".cbpanel-sidecar.pkg.config.json");
const packageVersions = {
  "__CBPANEL_VERSION__": await readPackageVersion("package.json"),
  "__CBPANEL_CLOAKBROWSER_VERSION__": await readPackageVersion("node_modules/cloakbrowser/package.json"),
  "__CBPANEL_PLAYWRIGHT_CORE_VERSION__": await readPackageVersion("node_modules/playwright-core/package.json"),
  "__CBPANEL_PUPPETEER_CORE_VERSION__": await readPackageVersion("node_modules/puppeteer-core/package.json"),
};
const pkgRuntimeAssets = [
  "dist/**/*",
  "node_modules/playwright-core/browsers.json",
  "node_modules/playwright-core/package.json",
  "node_modules/playwright-core/lib/server/deviceDescriptorsSource.json",
  "node_modules/playwright-core/lib/tools/cli-client/help.json",
  "node_modules/puppeteer-core/package.json",
  "node_modules/@puppeteer/browsers/package.json",
];

await fs.rm(buildDir, { recursive: true, force: true });
await fs.mkdir(buildDir, { recursive: true });
await fs.mkdir(path.dirname(output), { recursive: true });

await build({
  entryPoints: [path.join(root, "server", "index.ts")],
  bundle: true,
  platform: "node",
  target: "node26",
  format: "cjs",
  outfile: bundledEntry,
  banner: {
    js: "const import_meta_url = require('url').pathToFileURL(__filename).href;",
  },
  define: {
    "import.meta.url": "import_meta_url",
    ...Object.fromEntries(
      Object.entries(packageVersions).map(([key, value]) => [key, JSON.stringify(value)]),
    ),
  },
  supported: {
    "dynamic-import": false,
  },
  external: [
    "vite",
    "node:sqlite",
    "playwright-core",
    "socks-proxy-agent",
    "undici",
  ],
});

await assertNoPackagedDynamicImports(bundledEntry);
await writePkgConfig(pkgConfigPath);

try {
  execFileSync(
    process.execPath,
    [
      path.join(root, "node_modules", "@yao-pkg", "pkg", "lib-es5", "bin.js"),
      bundledEntry,
      "--config",
      pkgConfigPath,
      "--targets",
      target,
      "--output",
      output,
      "--public-packages",
      "*",
      "--fallback-to-source",
    ],
    { cwd: root, stdio: "inherit" },
  );
} finally {
  await fs.rm(pkgConfigPath, { force: true });
}

await assertExists(output, "Sidecar executable was not generated.");
console.log(`Sidecar written to ${output}`);

async function assertExists(inputPath, message) {
  try {
    await fs.access(inputPath);
  } catch {
    throw new Error(message);
  }
}

async function writePkgConfig(outputPath) {
  await assertPkgEntriesExist(pkgRuntimeAssets, "asset");

  await fs.writeFile(
    outputPath,
    `${JSON.stringify({ pkg: { assets: pkgRuntimeAssets } }, null, 2)}\n`,
    "utf8",
  );
}

async function assertPkgEntriesExist(entries, label) {
  for (const entry of entries) {
    if (entry.includes("*")) {
      const requiredPath = entry.slice(0, entry.indexOf("*")).replace(/[\\/]+$/, "");
      await assertExists(path.join(root, requiredPath), `Sidecar pkg runtime ${label} directory is missing: ${entry}`);
    } else {
      await assertExists(path.join(root, entry), `Sidecar pkg runtime ${label} is missing: ${entry}`);
    }
  }
}

async function assertNoPackagedDynamicImports(inputPath) {
  const bundle = await fs.readFile(inputPath, "utf8");
  const forbiddenImports = [
    "import(\"cloakbrowser\")",
    "import(\"cloakbrowser/puppeteer\")",
    "import(\"playwright-core\")",
    "import(\"puppeteer-core\")",
    "import(\"socks-proxy-agent\")",
    "import(\"mmdb-lib\")",
  ];
  const remaining = forbiddenImports.filter((pattern) => bundle.includes(pattern));
  if (remaining.length > 0) {
    throw new Error(
      `Sidecar bundle still contains pkg-unsafe dynamic imports: ${remaining.join(", ")}. ` +
        "Bundle the dependency or force esbuild to lower dynamic import before packaging.",
    );
  }
}

async function readPackageVersion(relativePath) {
  const packagePath = path.join(root, relativePath);
  const raw = await fs.readFile(packagePath, "utf8");
  const version = JSON.parse(raw).version;
  if (typeof version !== "string" || !version.trim()) {
    throw new Error(`Package version is missing: ${relativePath}`);
  }
  return version;
}
