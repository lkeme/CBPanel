import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { currentRustTarget, sidecarFileName } from "./release-target.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rustTarget = process.env.CBPANEL_RUST_TARGET ?? currentRustTarget();
const sidecarPath = path.join(root, "sidecars", sidecarFileName(rustTarget));
const appImagePath = path.join(root, "release", "CBPanel-linux-x64.AppImage");
const smokeDataDir = path.join(root, "release", "linux-smoke-data");
const port = process.env.CBPANEL_RELEASE_SMOKE_PORT ? Number(process.env.CBPANEL_RELEASE_SMOKE_PORT) : await findFreePort();
const token = process.env.CBPANEL_RELEASE_SMOKE_TOKEN ?? `smoke-${Date.now()}`;

if (!Number.isInteger(port) || port <= 0) {
  throw new Error(`Invalid release smoke port: ${process.env.CBPANEL_RELEASE_SMOKE_PORT}`);
}

await assertExists(sidecarPath, "Missing generated Linux sidecar executable.");
await assertExists(appImagePath, "Linux AppImage is missing.");
await fs.chmod(sidecarPath, 0o755).catch(() => undefined);
await fs.rm(smokeDataDir, { recursive: true, force: true });
await fs.mkdir(smokeDataDir, { recursive: true });

const child = spawn(sidecarPath, {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    CBPANEL_SHELL: "desktop",
    CBPANEL_API_ONLY: "1",
    CBPANEL_DESKTOP_TOKEN: token,
    CBPANEL_DATA_DIR: smokeDataDir,
    CBPANEL_RELEASE_SMOKE: "1",
  },
  stdio: "ignore",
});

try {
  await waitForReady(port, token);

  const unauthorized = await fetch(`http://127.0.0.1:${port}/api/state`);
  if (unauthorized.status !== 401) {
    throw new Error(`Expected missing token to return 401, got ${unauthorized.status}.`);
  }

  const runtime = await fetchJson(`http://127.0.0.1:${port}/api/desktop/runtime`, token);
  if (runtime.shell !== "desktop" || runtime.platform !== "linux") {
    throw new Error(`Unexpected Linux runtime payload: ${JSON.stringify(runtime)}`);
  }

  const state = await fetchJson(`http://127.0.0.1:${port}/api/state`, token);
  if (!state.settings || state.storage?.kind !== "sqlite" || !Array.isArray(state.profiles)) {
    throw new Error("State payload does not include settings, sqlite storage, and profiles.");
  }

  const binary = await fetchJson(`http://127.0.0.1:${port}/api/binary`, token);
  if (typeof binary.core?.versions?.wrapperVersion !== "string" || !binary.core.versions.wrapperVersion.trim()) {
    throw new Error(`Binary API payload does not include packaged CloakBrowser wrapper version: ${JSON.stringify(binary.core?.versions)}`);
  }
  if (!String(binary.platform).startsWith("linux")) {
    throw new Error(`Binary API did not report a Linux CloakBrowser platform: ${JSON.stringify(binary)}`);
  }

  const dependencies = await fetchJson(`http://127.0.0.1:${port}/api/release-smoke/dependencies`, token);
  assertPackagedDependencies(dependencies);

  console.log("Linux release smoke passed: sidecar auth, runtime API, binary API, packaged dependencies, SQLite state, and AppImage artifact are present.");
} finally {
  child.kill();
  await sleep(500);
  await fs.rm(smokeDataDir, { recursive: true, force: true }).catch(() => undefined);
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
  throw new Error(`Linux sidecar did not become ready: ${lastError?.message ?? "timeout"}`);
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
    throw new Error(`Packaged sidecar dependency check missed expected dependencies: ${missing.join(", ")}.`);
  }
}

async function assertExists(inputPath, message) {
  try {
    await fs.access(inputPath);
  } catch {
    throw new Error(message);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
