import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { currentRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const portableDir = path.join(root, "release", "CBPanel-win-portable");
const portableSidecarPath = path.join(portableDir, "sidecars", path.basename(sidecarPath));
const portableZip = path.join(root, "release", "CBPanel-win-portable.zip");
const packageMetadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
const installerPath = path.join(root, "src-tauri", "target", "release", "bundle", "nsis", `CBPanel_${packageMetadata.version}_x64-setup.exe`);
const smokeDataDir = path.join(portableDir, "portable-data");
const port = process.env.CBPANEL_RELEASE_SMOKE_PORT ? Number(process.env.CBPANEL_RELEASE_SMOKE_PORT) : await findFreePort();
const token = process.env.CBPANEL_RELEASE_SMOKE_TOKEN ?? `smoke-${Date.now()}`;
const tauriOrigin = "https://tauri.localhost";

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid release smoke port: ${process.env.CBPANEL_RELEASE_SMOKE_PORT}`);
}

await assertExists(sidecarPath, "Missing generated sidecar executable.");
await assertExists(path.join(portableDir, "CBPanel.exe"), "Portable CBPanel.exe is missing.");
await assertExists(portableSidecarPath, "Portable sidecar is missing.");
await assertExists(path.join(portableDir, "portable-data"), "Portable data directory is missing.");
await assertExists(portableZip, "Portable ZIP is missing.");
await assertExists(installerPath, "Windows installer is missing.");

await resetSmokeDataDir({ keepPlaceholder: false });

const child = spawn(path.join(portableDir, "CBPanel.exe"), {
  cwd: portableDir,
  env: {
    ...process.env,
    CBPANEL_RELEASE_SMOKE: "1",
    CBPANEL_RELEASE_SMOKE_PORT: String(port),
    CBPANEL_RELEASE_SMOKE_TOKEN: token,
  },
  stdio: "ignore",
  windowsHide: true,
});

try {
  await waitForReady(port, token);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/state`);
  if (unauthorized.status !== 401) {
    throw new Error(`Expected missing token to return 401, got ${unauthorized.status}.`);
  }

  await assertTauriWebViewCors(port, token);

  const runtime = await fetchJson(`http://127.0.0.1:${port}/api/desktop/runtime`, token);
  if (runtime.shell !== "desktop" || runtime.platform !== "windows" || runtime.chrome !== "custom") {
    throw new Error(`Unexpected runtime payload: ${JSON.stringify(runtime)}`);
  }

  const state = await fetchJson(`http://127.0.0.1:${port}/api/state`, token);
  if (!state.settings || state.storage?.kind !== "sqlite" || !Array.isArray(state.profiles)) {
    throw new Error("State payload does not include settings, sqlite storage, and profiles.");
  }

  const binary = await fetchJson(`http://127.0.0.1:${port}/api/binary`, token);
  if (typeof binary.installed !== "boolean" || typeof binary.env !== "object") {
    throw new Error("Binary API payload does not include public binary info and environment metadata.");
  }
  if (typeof binary.core?.versions?.wrapperVersion !== "string" || !binary.core.versions.wrapperVersion.trim()) {
    throw new Error(`Binary API payload does not include packaged CloakBrowser wrapper version: ${JSON.stringify(binary.core?.versions)}`);
  }

  const dependencies = await fetchJson(`http://127.0.0.1:${port}/api/release-smoke/dependencies`, token);
  assertPackagedDependencies(dependencies);

  console.log("Release smoke passed: portable app starts the sidecar, sidecar auth, Tauri WebView CORS, runtime API, binary API, packaged runtime dependencies, SQLite state, installer, and portable layout are present.");
} finally {
  await stopProcessTree(child);
  await resetSmokeDataDir({ keepPlaceholder: true });
}

async function waitForReady(inputPort, inputToken) {
  const deadline = Date.now() + 20_000;
  let lastError;
  while (Date.now() < deadline) {
    try {
      await fetchJson(`http://127.0.0.1:${inputPort}/api/desktop/runtime`, inputToken);
      return;
    } catch (error) {
      lastError = error;
      await sleep(300);
    }
  }
  throw new Error(`Sidecar did not become ready: ${lastError?.message ?? "timeout"}`);
}

async function fetchJson(url, inputToken) {
  const response = await fetch(url, {
    headers: {
      "X-CBPanel-Token": inputToken,
    },
  });
  if (!response.ok) {
    throw new Error(`${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function assertTauriWebViewCors(inputPort, inputToken) {
  const runtimeUrl = `http://127.0.0.1:${inputPort}/api/desktop/runtime`;
  const preflight = await fetch(runtimeUrl, {
    method: "OPTIONS",
    headers: {
      Origin: tauriOrigin,
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "x-cbpanel-token",
    },
  });
  if (preflight.status !== 204) {
    throw new Error(`Expected Tauri WebView CORS preflight to return 204, got ${preflight.status}.`);
  }
  assertCorsHeader(preflight, "access-control-allow-origin", tauriOrigin);
  assertCorsIncludes(preflight, "access-control-allow-methods", "GET");
  assertCorsIncludes(preflight, "access-control-allow-headers", "x-cbpanel-token");

  const authenticated = await fetch(runtimeUrl, {
    headers: {
      Origin: tauriOrigin,
      "X-CBPanel-Token": inputToken,
    },
  });
  if (!authenticated.ok) {
    throw new Error(`Tauri WebView authenticated runtime request returned ${authenticated.status}: ${await authenticated.text()}`);
  }
  assertCorsHeader(authenticated, "access-control-allow-origin", tauriOrigin);
}

function assertCorsHeader(response, headerName, expected) {
  const actual = response.headers.get(headerName);
  if (actual !== expected) {
    throw new Error(`Expected ${headerName} to be ${expected}, got ${actual ?? "<missing>"}.`);
  }
}

function assertCorsIncludes(response, headerName, expected) {
  const actual = response.headers.get(headerName);
  if (!actual || !actual.toLowerCase().split(",").map((value) => value.trim()).includes(expected.toLowerCase())) {
    throw new Error(`Expected ${headerName} to include ${expected}, got ${actual ?? "<missing>"}.`);
  }
}

function assertPackagedDependencies(payload) {
  if (!payload || payload.packaged !== true || !Array.isArray(payload.dependencies)) {
    throw new Error(`Unexpected release dependency health payload: ${JSON.stringify(payload)}`);
  }
  const failed = payload.dependencies.filter((dependency) => !dependency.ok);
  if (failed.length > 0) {
    throw new Error(`Packaged sidecar dependency check failed: ${JSON.stringify(failed)}`);
  }
  const expected = ["playwright-core", "puppeteer-core", "socks-proxy-agent", "undici"];
  const missing = expected.filter((name) => !payload.dependencies.some((dependency) => dependency.name === name && dependency.ok));
  if (missing.length > 0) {
    throw new Error(`Packaged sidecar dependency check missed expected dependencies: ${missing.join(", ")}`);
  }
}

async function assertExists(inputPath, message) {
  try {
    await fs.access(inputPath);
  } catch {
    throw new Error(message);
  }
}

async function resetSmokeDataDir({ keepPlaceholder }) {
  await fs.rm(smokeDataDir, { recursive: true, force: true });
  await fs.mkdir(smokeDataDir, { recursive: true });
  if (keepPlaceholder) {
    await fs.writeFile(path.join(smokeDataDir, ".gitkeep"), "", "utf8");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function stopProcessTree(inputChild) {
  if (!inputChild.pid || inputChild.exitCode !== null || inputChild.signalCode !== null) {
    return;
  }

  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill.exe", ["/PID", String(inputChild.pid), "/T", "/F"], { windowsHide: true });
    } catch {
      // The process may have exited after the final API assertion.
    }
  } else {
    inputChild.kill();
  }

  await sleep(500);
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Could not allocate a release smoke port.")));
        return;
      }
      const allocatedPort = address.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(allocatedPort);
      });
    });
  });
}
