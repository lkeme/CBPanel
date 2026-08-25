import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import type { ExtensionEntity } from "../../src/shared/entities";
import {
  EXTENSION_LIFECYCLE_NAMESPACE,
  ExtensionRuntimeService,
} from "./extensionRuntimeService";

const MANIFEST_KEY = "stable-test-manifest-key";

test("materializes an MV3 classic worker without changing its reference source", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "source", {
    manifest_version: 3,
    name: "Classic",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "background/sw.js" },
  }, { "background/sw.js": "globalThis.originalLoaded = true;\n" });
  const sourceManifestBefore = await fs.readFile(path.join(source, "manifest.json"));
  const service = runtimeService(root);

  const result = await service.materialize({
    environmentId: "environment-one",
    extension: extensionEntity("extension-one", source, "reference"),
    lifecycleRevision: "binding-one",
  });

  assert.equal(result.protected, true);
  assert.notEqual(result.path, source);
  assert.deepEqual(await fs.readFile(path.join(source, "manifest.json")), sourceManifestBefore);
  assert.equal(await exists(path.join(source, EXTENSION_LIFECYCLE_NAMESPACE)), false);
  const runtimeManifest = JSON.parse(await fs.readFile(path.join(result.path, "manifest.json"), "utf8")) as {
    key: string;
    background: { service_worker: string };
  };
  assert.equal(runtimeManifest.key, MANIFEST_KEY);
  assert.equal(runtimeManifest.background.service_worker, "background/sw.js");
  const wrapper = await fs.readFile(path.join(result.path, "background", "sw.js"), "utf8");
  assert.match(wrapper, /background\/__cbpanel_lifecycle_original__\.js/);
  assert.match(
    await fs.readFile(path.join(result.path, "background", "__cbpanel_lifecycle_original__.js"), "utf8"),
    /originalLoaded/,
  );
  const config = await fs.readFile(path.join(result.path, EXTENSION_LIFECYCLE_NAMESPACE, "config.js"), "utf8");
  assert.match(config, /"initialBehavior":"install"/);
  const bootstrap = await fs.readFile(path.join(result.path, EXTENSION_LIFECYCLE_NAMESPACE, "bootstrap.js"), "utf8");
  assert.match(bootstrap, /rollbackInstalled/);
  assert.match(bootstrap, /reason: "update"/);

  await fs.rm(root, { recursive: true, force: true });
});

test("reference materialization refreshes when source code changes without a version change", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "live-source", {
    manifest_version: 3,
    name: "Live Reference",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.revision = 1;\n" });
  const service = runtimeService(root);
  const input = {
    environmentId: "environment-live",
    extension: extensionEntity("extension-live", source, "reference"),
    lifecycleRevision: "binding-live",
  } as const;

  const first = await service.materialize(input);
  assert.match(await fs.readFile(path.join(first.path, "__cbpanel_lifecycle_original__.js"), "utf8"), /revision = 1/);
  await fs.writeFile(path.join(source, "sw.js"), "globalThis.revision = 2;\n", "utf8");
  const second = await service.materialize(input);

  assert.equal(second.path, first.path);
  assert.match(await fs.readFile(path.join(second.path, "__cbpanel_lifecycle_original__.js"), "utf8"), /revision = 2/);
  await fs.rm(root, { recursive: true, force: true });
});

test("adapts MV3 modules and both supported MV2 background forms", async (context) => {
  const root = await makeTempDir();
  const service = runtimeService(root);
  const cases: Array<{
    name: string;
    manifest: Record<string, unknown>;
    files: Record<string, string>;
    verify: (runtimePath: string) => Promise<void>;
  }> = [
    {
      name: "mv3-module",
      manifest: {
        manifest_version: 3,
        name: "Module",
        version: "1.0.0",
        key: MANIFEST_KEY,
        background: { service_worker: "module/sw.js", type: "module" },
      },
      files: { "module/sw.js": "export const loaded = true;\n" },
      verify: async (runtimePath) => {
        const manifest = JSON.parse(await fs.readFile(path.join(runtimePath, "manifest.json"), "utf8")) as {
          background: { service_worker: string; type: string };
        };
        assert.equal(manifest.background.service_worker, "module/sw.js");
        assert.equal(manifest.background.type, "module");
        const worker = await fs.readFile(path.join(runtimePath, "module", "sw.js"), "utf8");
        assert.match(worker, /\.\.\/__cbpanel_lifecycle__\/config\.js/);
        assert.match(worker, /export const loaded = true/);
      },
    },
    {
      name: "mv2-scripts",
      manifest: {
        manifest_version: 2,
        name: "Scripts",
        version: "1.0.0",
        key: MANIFEST_KEY,
        background: { scripts: ["first.js", "second.js"], persistent: false },
      },
      files: { "first.js": "", "second.js": "" },
      verify: async (runtimePath) => {
        const manifest = JSON.parse(await fs.readFile(path.join(runtimePath, "manifest.json"), "utf8")) as {
          background: { scripts: string[]; persistent: boolean };
        };
        assert.deepEqual(manifest.background.scripts, [
          `${EXTENSION_LIFECYCLE_NAMESPACE}/config.js`,
          `${EXTENSION_LIFECYCLE_NAMESPACE}/bootstrap.js`,
          "first.js",
          "second.js",
        ]);
        assert.equal(manifest.background.persistent, false);
      },
    },
    {
      name: "mv2-page",
      manifest: {
        manifest_version: 2,
        name: "Page",
        version: "1.0.0",
        key: MANIFEST_KEY,
        background: { page: "pages/background.html" },
      },
      files: {
        "pages/background.html": "<html><head><!-- <script src=\"ignored.js\"></script> --><meta content=\"<script>\"><style>x{content:\"<script>\"}</style><SCRIPT defer src=\"original.js\"></SCRIPT></head></html>",
        "pages/original.js": "",
      },
      verify: async (runtimePath) => {
        const page = await fs.readFile(path.join(runtimePath, "pages", "background.html"), "utf8");
        const realScript = page.indexOf("<SCRIPT defer");
        assert.ok(page.indexOf("config.js") > page.indexOf("</style>") && page.indexOf("config.js") < realScript);
        assert.ok(page.indexOf("bootstrap.js") > page.indexOf("</style>") && page.indexOf("bootstrap.js") < realScript);
      },
    },
  ];

  for (const [index, item] of cases.entries()) {
    await context.test(item.name, async () => {
      const source = await writeExtension(root, item.name, item.manifest, item.files);
      const result = await service.materialize({
        environmentId: `environment-${index}`,
        extension: extensionEntity(`extension-${index}`, source, "reference"),
        lifecycleRevision: `binding-${index}`,
      });
      await item.verify(result.path);
    });
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("legacy bindings preserve environments with real browser state and install into unused ones", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "legacy-source", {
    manifest_version: 3,
    name: "Legacy",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  await fs.mkdir(path.join(root, "browser-data", "used", "Default"), { recursive: true });
  await fs.writeFile(path.join(root, "browser-data", "used", "Default", "Preferences"), "{}", "utf8");
  const service = runtimeService(root);

  const used = await service.materialize({ environmentId: "used", extension: extensionEntity("extension-used", source, "reference") });
  const unused = await service.materialize({ environmentId: "unused", extension: extensionEntity("extension-unused", source, "reference") });

  assert.match(await readConfig(used.path), /"initialBehavior":"preserve"/);
  assert.match(await readConfig(unused.path), /"initialBehavior":"install"/);
  await fs.rm(root, { recursive: true, force: true });
});

test("a reference without a stable key stays on its source path and returns an actionable warning", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "unkeyed", {
    manifest_version: 3,
    name: "Unkeyed",
    version: "1.0.0",
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const before = await fs.readFile(path.join(source, "manifest.json"));
  const extension = extensionEntity("extension-unkeyed", source, "reference");
  extension.manifestKey = undefined;

  const result = await runtimeService(root).materialize({
    environmentId: "environment-unkeyed",
    extension,
    lifecycleRevision: "binding-unkeyed",
  });

  assert.equal(result.path, source);
  assert.equal(result.protected, false);
  assert.match(result.warning ?? "", /复制模式/);
  assert.deepEqual(await fs.readFile(path.join(source, "manifest.json")), before);
  assert.equal(await exists(path.join(source, EXTENSION_LIFECYCLE_NAMESPACE)), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("rejects commas in the final runtime path before copying", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "comma-source", {
    manifest_version: 3,
    name: "Comma",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const service = new ExtensionRuntimeService({
    runtimeDir: path.join(root, "runtime,invalid"),
    browserDataDir: path.join(root, "browser-data"),
  });

  await assert.rejects(service.materialize({
    environmentId: "environment-comma",
    extension: extensionEntity("extension-comma", source, "reference"),
    lifecycleRevision: "binding-comma",
  }), /cannot contain a comma/);
  assert.equal(await exists(path.join(root, "runtime,invalid")), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("rejects absolute manifest background paths instead of silently rebasing them", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "absolute-worker", {
    manifest_version: 3,
    name: "Absolute Worker",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "/sw.js" },
  }, { "sw.js": "globalThis.loaded = true;\n" });

  await assert.rejects(runtimeService(root).materialize({
    environmentId: "environment-absolute",
    extension: extensionEntity("extension-absolute", source, "reference"),
    lifecycleRevision: "binding-absolute",
  }), /must be relative to the extension directory/);
  assert.equal(await exists(path.join(root, "extension-runtimes")), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("rejects a linked reference root before lifecycle adaptation can mutate its target", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "real-source", {
    manifest_version: 3,
    name: "Linked Source",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.loaded = true;\n" });
  const linkedSource = path.join(root, "linked-source");
  try {
    await fs.symlink(source, linkedSource, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Symbolic links are not available in this test environment");
      await fs.rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const manifestBefore = await fs.readFile(path.join(source, "manifest.json"));

  await assert.rejects(runtimeService(root).materialize({
    environmentId: "environment-linked",
    extension: extensionEntity("extension-linked", linkedSource, "reference"),
    lifecycleRevision: "binding-linked",
  }), /cannot contain a symbolic link/);
  assert.deepEqual(await fs.readFile(path.join(source, "manifest.json")), manifestBefore);
  assert.equal(await exists(path.join(source, EXTENSION_LIFECYCLE_NAMESPACE)), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("extension runtime cleanup skips held environments and a later binding sweep reclaims them", async () => {
  const root = await makeTempDir();
  const runtimeDir = path.join(root, "extension-runtimes");
  const service = new ExtensionRuntimeService({ runtimeDir, browserDataDir: path.join(root, "browser-data") });
  await fs.mkdir(path.join(runtimeDir, "environment-free", "extension-target"), { recursive: true });
  await fs.mkdir(path.join(runtimeDir, "environment-held", "extension-target"), { recursive: true });

  await service.removeExtension("extension-target", undefined, new Set(["environment-held"]));

  assert.equal(await exists(path.join(runtimeDir, "environment-free", "extension-target")), false);
  assert.equal(await exists(path.join(runtimeDir, "environment-held", "extension-target")), true);
  await service.sweepBindings(new Map([["environment-held", new Set<string>()]]));
  assert.equal(await exists(path.join(runtimeDir, "environment-held", "extension-target")), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("bootstrap delivers one install, then one startup, and suppresses startup beside install or update", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "state-machine", {
    manifest_version: 3,
    name: "State Machine",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-state",
    extension: extensionEntity("extension-state", source, "reference"),
    lifecycleRevision: "binding-state",
  });
  const bootstrap = await fs.readFile(path.join(runtime.path, EXTENSION_LIFECYCLE_NAMESPACE, "bootstrap.js"), "utf8");
  const store = new Map<string, unknown>();
  const config = lifecycleConfig();

  const first = await runBootstrap(bootstrap, config, store);
  first.nativeInstalled.emit({ reason: "install" });
  first.nativeStartup.emit();
  await settleEvents();
  assert.deepEqual(first.installed, [{ reason: "install" }]);
  assert.equal(first.startups, 0);

  const second = await runBootstrap(bootstrap, config, store);
  second.nativeInstalled.emit({ reason: "install" });
  second.nativeStartup.emit();
  await settleEvents();
  assert.deepEqual(second.installed, []);
  assert.equal(second.startups, 1);

  const updated = await runBootstrap(bootstrap, { ...config, packageRevision: "package-two" }, store);
  updated.nativeStartup.emit();
  updated.nativeInstalled.emit({ reason: "install" });
  await settleEvents();
  assert.equal(updated.installed.length, 1);
  assert.equal(updated.installed[0]?.reason, "update");
  assert.equal(updated.installed[0]?.previousVersion, "1.0.0");
  assert.equal(updated.startups, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("bootstrap fails safe when lifecycle state cannot be persisted", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "write-failure", {
    manifest_version: 3,
    name: "Write Failure",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-write-failure",
    extension: extensionEntity("extension-write-failure", source, "reference"),
    lifecycleRevision: "binding-write-failure",
  });
  const bootstrap = await fs.readFile(path.join(runtime.path, EXTENSION_LIFECYCLE_NAMESPACE, "bootstrap.js"), "utf8");
  const errors: string[] = [];
  const result = await runBootstrap(bootstrap, lifecycleConfig(), new Map(), {
    writeFails: true,
    errors,
  });

  result.nativeInstalled.emit({ reason: "install" });
  await settleEvents();

  assert.deepEqual(result.installed, []);
  assert.equal(result.startups, 0);
  assert.ok(errors.some((message) => message.includes("suppressed install")));
  await fs.rm(root, { recursive: true, force: true });
});

test("a preserve-mode legacy binding rebases restored state once before normal updates resume", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "legacy-rebase", {
    manifest_version: 3,
    name: "Legacy Rebase",
    version: "2.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-rebase",
    extension: extensionEntity("extension-rebase", source, "reference"),
    lifecycleRevision: "binding-rebase",
  });
  const bootstrap = await fs.readFile(path.join(runtime.path, EXTENSION_LIFECYCLE_NAMESPACE, "bootstrap.js"), "utf8");
  const store = new Map<string, unknown>([["state", {
    schemaVersion: 1,
    version: "1.0.0",
    packageRevision: "old-package",
    bindingRevision: "old-binding",
  }]]);
  const legacyConfig = {
    schemaVersion: 1,
    version: "2.0.0",
    packageRevision: "restored-package",
    bindingRevision: "legacy",
    initialBehavior: "preserve",
  };

  const restored = await runBootstrap(bootstrap, legacyConfig, store);
  restored.nativeInstalled.emit({ reason: "install" });
  await settleEvents();
  assert.deepEqual(restored.installed, []);
  assert.equal(restored.startups, 1);
  assert.equal((store.get("state") as { bindingRevision: string }).bindingRevision, "legacy");

  const updated = await runBootstrap(bootstrap, { ...legacyConfig, version: "3.0.0" }, store);
  updated.nativeInstalled.emit({ reason: "install" });
  await settleEvents();
  assert.equal(updated.installed[0]?.reason, "update");
  assert.equal(updated.installed[0]?.previousVersion, "2.0.0");
  assert.equal(updated.startups, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("real CloakBrowser keeps MV3 classic and module lifecycle state across two persistent launches", async (context) => {
  const cloakbrowser = await import("cloakbrowser");
  const info = await cloakbrowser.binaryInfo();
  if (!info.installed) {
    context.skip(`CloakBrowser binary is not installed at ${info.binaryPath}`);
    return;
  }
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifestKey = Buffer.from(keyPair.publicKey.export({ type: "spki", format: "der" })).toString("base64");
  for (const [kind, module] of [["classic", false], ["module", true]] as const) {
    await context.test(kind, async () => {
      const root = await makeTempDir();
      try {
        const workerPath = module ? "nested/worker.js" : "nested/worker.js";
        const source = await writeExtension(root, "browser-source", {
          manifest_version: 3,
          name: `Browser ${kind}`,
          version: "1.0.0",
          key: manifestKey,
          permissions: ["storage", "tabs"],
          background: { service_worker: workerPath, ...(module ? { type: "module" } : {}) },
        }, {
          [workerPath]: browserFixtureWorker(module),
          "welcome.html": "<!doctype html><title>Welcome</title>",
          ...(module ? { "nested/helper.js": "globalThis.fixtureHelperLoaded = true;\n" } : {}),
        });
        const entity = extensionEntity(`extension-${kind}`, source, "reference");
        entity.manifestKey = manifestKey;
        const runtime = await runtimeService(root).materialize({
          environmentId: `environment-${kind}`,
          extension: entity,
          lifecycleRevision: `binding-${kind}`,
        });
        const userDataDir = path.join(root, "browser-data", `environment-${kind}`);

        const first = await cloakbrowser.launchPersistentContext({
          userDataDir,
          extensionPaths: [runtime.path],
          headless: true,
          stealthArgs: false,
          geoip: false,
        });
        const firstState = await waitForBrowserFixtureState(first, (state) => state.installCount === 1);
        assert.equal(firstState.installCount, 1);
        assert.equal(firstState.startupCount ?? 0, 0);
        assert.equal(firstState.persistedValue, "kept");
        assert.match(typeof firstState.workerLocation === "string" ? firstState.workerLocation : "", /nested\/worker\.js$/);
        for (const page of first.pages()) {
          if (page.url().endsWith("welcome.html")) await page.close();
        }
        await first.close();

        const second = await cloakbrowser.launchPersistentContext({
          userDataDir,
          extensionPaths: [runtime.path],
          headless: true,
          stealthArgs: false,
          geoip: false,
        });
        const secondState = await waitForBrowserFixtureState(second, (state) => state.startupCount === 1);
        assert.equal(secondState.installCount, 1);
        assert.equal(secondState.startupCount, 1);
        assert.equal(secondState.persistedValue, "kept");
        assert.equal(second.pages().some((page) => page.url().endsWith("welcome.html")), false);
        await second.close();
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

function runtimeService(root: string): ExtensionRuntimeService {
  return new ExtensionRuntimeService({
    runtimeDir: path.join(root, "extension-runtimes"),
    browserDataDir: path.join(root, "browser-data"),
  });
}

function extensionEntity(id: string, localPath: string, directoryMode: "copy" | "reference"): ExtensionEntity {
  return {
    id,
    name: id,
    description: "",
    sourceKind: "local-directory",
    sourceUrl: localPath,
    version: "1.0.0",
    manifestVersion: 3,
    permissions: [],
    hostPermissions: [],
    permissionRisks: [],
    installState: "installed",
    updatePolicy: "pinned",
    localPath,
    manifestKey: MANIFEST_KEY,
    directoryMode,
    lastInstalledAt: "2026-08-25T00:00:00.000Z",
    status: "enabled",
    createdAt: "2026-08-25T00:00:00.000Z",
    updatedAt: "2026-08-25T00:00:00.000Z",
  };
}

async function writeExtension(
  root: string,
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string>,
): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(directory, ...relativePath.split("/"));
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  }
  return directory;
}

async function readConfig(runtimePath: string): Promise<string> {
  return fs.readFile(path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE, "config.js"), "utf8");
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-extension-runtime-"));
}

async function exists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

type FakeNativeEvent = {
  addListener: (listener: (...args: unknown[]) => void) => void;
  removeListener: (listener: (...args: unknown[]) => void) => void;
  hasListener: (listener: (...args: unknown[]) => void) => boolean;
  hasListeners: () => boolean;
  emit: (...args: unknown[]) => void;
};

function fakeNativeEvent(): FakeNativeEvent {
  const listeners = new Set<(...args: unknown[]) => void>();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    hasListener(listener) { return listeners.has(listener); },
    hasListeners() { return listeners.size > 0; },
    emit(...args) { for (const listener of [...listeners]) listener(...args); },
  };
}

function lifecycleConfig(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: "1.0.0",
    packageRevision: "package-one",
    bindingRevision: "binding-one",
    initialBehavior: "install",
  };
}

async function runBootstrap(
  source: string,
  config: Record<string, unknown>,
  state: Map<string, unknown>,
  options: { writeFails?: boolean; errors?: string[] } = {},
): Promise<{
  nativeInstalled: FakeNativeEvent;
  nativeStartup: FakeNativeEvent;
  installed: Array<Record<string, unknown>>;
  startups: number;
  errors: string[];
}> {
  const nativeInstalled = fakeNativeEvent();
  const nativeStartup = fakeNativeEvent();
  const indexedDB = fakeIndexedDb(state, options.writeFails === true);
  const errors = options.errors ?? [];
  const context = {
    __CBPANEL_LIFECYCLE_CONFIG__: config,
    chrome: { runtime: { onInstalled: nativeInstalled, onStartup: nativeStartup } },
    indexedDB,
    console: {
      error: (...values: unknown[]) => errors.push(values.map(String).join(" ")),
    },
    setTimeout,
    clearTimeout,
  };
  vm.runInNewContext(source, context);
  const installed: Array<Record<string, unknown>> = [];
  let startups = 0;
  context.chrome.runtime.onInstalled.addListener((details) => installed.push(details as Record<string, unknown>));
  context.chrome.runtime.onStartup.addListener(() => { startups += 1; });
  return {
    nativeInstalled,
    nativeStartup,
    installed,
    get startups() { return startups; },
    errors,
  };
}

function fakeIndexedDb(state: Map<string, unknown>, writeFails: boolean): { open: () => Record<string, unknown> } {
  return {
    open() {
      const request: Record<string, unknown> = {};
      const objectStoreNames = { contains: () => true };
      const database = {
        objectStoreNames,
        createObjectStore() {},
        close() {},
        transaction(_name: string, mode: string) {
          const transaction: Record<string, unknown> = {
            error: writeFails && mode === "readwrite" ? new Error("write failed") : undefined,
          };
          transaction.objectStore = () => ({
            get(key: string) {
              const readRequest: Record<string, unknown> = {};
              setTimeout(() => {
                readRequest.result = state.get(key);
                (readRequest.onsuccess as (() => void) | undefined)?.();
              }, 0);
              return readRequest;
            },
            put(value: unknown, key: string) {
              setTimeout(() => {
                if (writeFails) {
                  (transaction.onerror as (() => void) | undefined)?.();
                  return;
                }
                state.set(key, value);
                (transaction.oncomplete as (() => void) | undefined)?.();
              }, 0);
            },
          });
          return transaction;
        },
      };
      setTimeout(() => {
        request.result = database;
        (request.onupgradeneeded as (() => void) | undefined)?.();
        (request.onsuccess as (() => void) | undefined)?.();
      }, 0);
      return request;
    },
  };
}

async function settleEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 250));
}

function browserFixtureWorker(module: boolean): string {
  return `${module ? 'import "./helper.js";\n' : ""}
async function updateFixture(kind) {
  const state = await chrome.storage.local.get(["installCount", "startupCount", "persistedValue"]);
  await chrome.storage.local.set({
    installCount: (state.installCount || 0) + (kind === "install" ? 1 : 0),
    startupCount: (state.startupCount || 0) + (kind === "startup" ? 1 : 0),
    persistedValue: state.persistedValue || "kept",
    workerLocation: self.location.href,
  });
}
chrome.runtime.onInstalled.addListener((details) => {
  void updateFixture(details.reason === "install" ? "install" : details.reason);
  if (details.reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
chrome.runtime.onStartup.addListener(() => { void updateFixture("startup"); });
`;
}

async function waitForBrowserFixtureState(
  browserContext: import("playwright-core").BrowserContext,
  predicate: (state: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const worker = browserContext.serviceWorkers()[0];
    if (worker) {
      const state = await worker.evaluate(async () => {
        const runtime = globalThis as typeof globalThis & {
          chrome: { storage: { local: { get: (keys: null) => Promise<Record<string, unknown>> } } };
        };
        return runtime.chrome.storage.local.get(null);
      }) as Record<string, unknown>;
      if (predicate(state)) return state;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for extension lifecycle fixture state");
}
