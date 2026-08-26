import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import test from "node:test";
import type { ExtensionEntity } from "../../src/shared/entities";
import type { ExtensionLaunchRegistration } from "./extensionService";
import {
  EXTENSION_LIFECYCLE_INJECTOR_VERSION,
  EXTENSION_LIFECYCLE_NAMESPACE,
  ExtensionRuntimeService,
  assertWindowsExtensionRuntimePathBudget,
} from "./extensionRuntimeService";
import {
  buildExtensionRegistrationPreflightLaunchOptions,
  migrateExtensionRegistrations,
  playwrightRegistrationMigrationBrowser,
  prepareExtensionRegistrationPreflightUserDataDir,
  rawCdpRegistrationPreflightProcess,
} from "./sessionService";

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
  const sourceWorkerBefore = await fs.readFile(path.join(source, "background", "sw.js"));
  const sourceTreeBefore = await fingerprintTestTree(source);
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
  const layout = await readMv3Layout(result.path);
  assert.equal(runtimeManifest.background.service_worker, layout.wrapper);
  assert.notEqual(layout.wrapper, "background/sw.js");
  assert.equal(path.posix.dirname(layout.wrapper), "background");
  assert.deepEqual(await fs.readFile(path.join(result.path, "background", "sw.js")), sourceWorkerBefore);
  const wrapper = await fs.readFile(toRuntimePath(result.path, layout.wrapper), "utf8");
  assert.match(wrapper, new RegExp(escapeRegExp(layout.config)));
  assert.match(wrapper, new RegExp(escapeRegExp(layout.bootstrap)));
  assert.match(wrapper, /background\/sw\.js/);
  const config = await fs.readFile(toRuntimePath(result.path, layout.config), "utf8");
  assert.match(config, /"initialBehavior":"install"/);
  const bootstrap = await fs.readFile(toRuntimePath(result.path, layout.bootstrap), "utf8");
  assert.match(bootstrap, /rollbackInstalled/);
  assert.match(bootstrap, /reason: "update"/);
  assert.equal(await fingerprintTestTree(source), sourceTreeBefore);

  await fs.rm(root, { recursive: true, force: true });
});

test("generated lifecycle path segments avoid Chromium-reserved leading underscores", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "reserved-path-source", {
    manifest_version: 3,
    name: "Reserved Path",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.reservedPathLoaded = true;\n" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-reserved-path",
    extension: extensionEntity("extension-reserved-path", source, "reference"),
    lifecycleRevision: "binding-reserved-path",
  });
  const layout = await readMv3Layout(runtime.path);
  const namespaceEntries = await fs.readdir(path.join(runtime.path, EXTENSION_LIFECYCLE_NAMESPACE));
  const lifecyclePaths = [
    EXTENSION_LIFECYCLE_NAMESPACE,
    layout.config,
    layout.bootstrap,
    layout.wrapper,
    ...namespaceEntries.map((name) => `${EXTENSION_LIFECYCLE_NAMESPACE}/${name}`),
  ];

  for (const lifecyclePath of lifecyclePaths) {
    for (const segment of lifecyclePath.split("/")) {
      assert.equal(segment.startsWith("_"), false, `Chromium rejects reserved path segment ${segment}`);
    }
  }
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
  const firstLayout = await readMv3Layout(first.path);
  const firstConfig = parseGeneratedLifecycleConfig(await readConfig(first.path));
  assert.match(await fs.readFile(path.join(first.path, "sw.js"), "utf8"), /revision = 1/);
  await fs.writeFile(path.join(source, "sw.js"), "globalThis.revision = 2;\n", "utf8");
  const second = await service.materialize(input);
  const secondLayout = await readMv3Layout(second.path);
  const secondConfig = parseGeneratedLifecycleConfig(await readConfig(second.path));

  assert.equal(second.path, first.path);
  assert.notEqual(secondLayout.wrapper, firstLayout.wrapper);
  assert.notEqual(second.registration?.runtimeRevision, first.registration?.runtimeRevision);
  assert.notEqual(secondConfig.packageRevision, firstConfig.packageRevision);
  assert.match(await fs.readFile(path.join(second.path, "sw.js"), "utf8"), /revision = 2/);
  await fs.rm(root, { recursive: true, force: true });
});

test("MV3 registration URLs are deterministic for production-length IDs", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "long-registration-source", {
    manifest_version: 3,
    name: "Long Registration",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "nested/worker.js" },
  }, { "nested/worker.js": "globalThis.longRegistration = true;\n" });
  const environmentId = "profile-12345678-1234-1234-1234-123456789abc";
  const extensionId = "extension-12345678-1234-1234-1234-123456789abc";
  const service = runtimeService(root);
  const entity = extensionEntity(extensionId, source, "reference");
  const input = { environmentId, extension: entity, lifecycleRevision: "binding-long" } as const;

  const first = await service.materialize(input);
  const firstLayout = await readMv3Layout(first.path);
  const reused = await service.materialize(input);
  assert.equal(reused.registration?.signature, first.registration?.signature);
  assert.equal(reused.registration?.workerRelativePath, firstLayout.wrapper);
  assert.match(
    path.posix.basename(firstLayout.wrapper),
    new RegExp(`^${EXTENSION_LIFECYCLE_NAMESPACE}-worker-v${EXTENSION_LIFECYCLE_INJECTOR_VERSION}-[A-Za-z0-9_-]{22}\\.js$`),
  );
  assert.equal(path.posix.dirname(firstLayout.wrapper), "nested");

  const changed = await service.materialize({
    ...input,
    lifecycleRevision: "binding-long-rebound",
  });
  assert.notEqual(changed.registration?.signature, first.registration?.signature);
  assert.notEqual(changed.registration?.runtimeRevision, first.registration?.runtimeRevision);
  assert.notEqual(changed.registration?.workerRelativePath, first.registration?.workerRelativePath);
  await fs.rm(root, { recursive: true, force: true });
});

test("Windows runtime path budget accepts the real portable root and rejects the long packaged root", () => {
  const environmentId = "profile-e506462b-6e5f-4c2d-b4ff-7c0e5a4aae6b";
  const extensionId = "extension-87f3e24e-630b-413d-9a85-e57216851c6f";
  const revision = "A".repeat(22);
  const generatedPaths = [
    `${EXTENSION_LIFECYCLE_NAMESPACE}/config-v4-${revision}.js`,
    `${EXTENSION_LIFECYCLE_NAMESPACE}/bootstrap-v4-${revision}.js`,
    `${EXTENSION_LIFECYCLE_NAMESPACE}-worker-v4-${revision}.js`,
  ];
  const realOutputDir = path.win32.join(
    "E:\\PortableApps\\Browsers\\CBPanel\\portable-data\\extension-runtimes",
    environmentId,
    extensionId,
  );

  assert.doesNotThrow(() => assertWindowsExtensionRuntimePathBudget(
    "OneTab",
    realOutputDir,
    generatedPaths,
    "win32",
  ));
  assert.equal(
    generatedPaths.every((relativePath) => path.win32.resolve(
      realOutputDir,
      relativePath.replaceAll("/", "\\"),
    ).length <= 259),
    true,
  );

  const longOutputDir = path.win32.join(
    "C:\\Users\\PortableUser\\AppData\\Local\\Temp\\cbpanel-packaged-onetab-t92rj" +
      "\\CBPanel-win-portable\\portable-data\\extension-runtimes",
    "profile-0f60553-073b-493e-82d5-160cbb4ca874",
    "extension-8ffa05c0-3f0b-4810-98d6-bca6f801b164",
  );
  const offendingPath = generatedPaths
    .map((relativePath) => path.win32.resolve(longOutputDir, relativePath.replaceAll("/", "\\")))
    .sort((left, right) => right.length - left.length)[0]!;
  assert.equal(offendingPath.length > 259, true);
  assert.throws(
    () => assertWindowsExtensionRuntimePathBudget("OneTab", longOutputDir, generatedPaths, "win32"),
    (error: unknown) => {
      const typed = error as { status?: unknown; code?: unknown; message?: unknown };
      assert.equal(typed.status, 409);
      assert.equal(typed.code, "EXTENSION_RUNTIME_PATH_TOO_LONG");
      assert.equal(typeof typed.message, "string");
      assert.match(typed.message as string, /OneTab/);
      assert.match(typed.message as string, new RegExp(`当前 ${offendingPath.length} 个字符，上限 259 个字符`));
      assert.equal((typed.message as string).includes(offendingPath), true);
      assert.match(typed.message as string, /C:\\CBPanel|E:\\CBPanel/);
      return true;
    },
  );
  assert.doesNotThrow(() => assertWindowsExtensionRuntimePathBudget(
    "OneTab",
    longOutputDir,
    generatedPaths,
    "linux",
  ));
});

test("overlong Windows runtime fails before materialization publishes any files", {
  skip: process.platform !== "win32",
}, async () => {
  const root = await makeTempDir();
  try {
    const source = await writeExtension(root, "overlong-runtime-source", {
      manifest_version: 3,
      name: "Overlong Runtime",
      version: "1.0.0",
      key: MANIFEST_KEY,
      background: { service_worker: "nested/worker.js" },
    }, { "nested/worker.js": "globalThis.overlongRuntime = true;\n" });
    const runtimeDir = path.join(root, "portable-data", "r".repeat(120), "extension-runtimes");
    const service = new ExtensionRuntimeService({
      runtimeDir,
      browserDataDir: path.join(root, "browser-data"),
    });

    await assert.rejects(service.materialize({
      environmentId: "profile-12345678-1234-1234-1234-123456789abc",
      extension: extensionEntity(
        "extension-12345678-1234-1234-1234-123456789abc",
        source,
        "reference",
      ),
      lifecycleRevision: "binding-overlong-runtime",
    }), hasErrorCode("EXTENSION_RUNTIME_PATH_TOO_LONG"));
    assert.equal(await exists(runtimeDir), false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent materialization of one environment extension shares one complete runtime copy", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "concurrent-source", {
    manifest_version: 3,
    name: "Concurrent",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.concurrentLoaded = true;\n" });
  const service = runtimeService(root);
  const input = {
    environmentId: "environment-concurrent",
    extension: extensionEntity("extension-concurrent", source, "reference"),
    lifecycleRevision: "binding-concurrent",
  } as const;

  const results = await Promise.all(Array.from({ length: 8 }, () => service.materialize(input)));

  assert.equal(new Set(results.map((result) => result.path)).size, 1);
  assert.equal(results.every((result) => result.protected), true);
  const runtimePath = results[0]!.path;
  assert.equal(await exists(path.join(runtimePath, "manifest.json")), true);
  assert.equal(await exists(path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE, "materialization.json")), true);
  assert.deepEqual(
    (await fs.readdir(path.dirname(runtimePath))).filter((name) => name.includes(".tmp-") || name.includes(".old-")),
    [],
  );
  await fs.rm(root, { recursive: true, force: true });
});

test("signature reuse verifies every runtime file and rebuilds missing or corrupted output", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "integrity-source", {
    manifest_version: 3,
    name: "Integrity",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.integrity = 'original';\n", "asset.txt": "canonical\n" });
  const service = runtimeService(root);
  const input = {
    environmentId: "environment-integrity",
    extension: extensionEntity("extension-integrity", source, "reference"),
    lifecycleRevision: "binding-integrity",
  } as const;
  const first = await service.materialize(input);
  const layout = await readMv3Layout(first.path);
  await fs.rm(toRuntimePath(first.path, layout.bootstrap));
  await fs.writeFile(path.join(first.path, "asset.txt"), "corrupted\n", "utf8");

  const second = await service.materialize(input);

  assert.equal(second.path, first.path);
  assert.equal(await exists(toRuntimePath(second.path, layout.bootstrap)), true);
  assert.equal(await fs.readFile(path.join(second.path, "asset.txt"), "utf8"), "canonical\n");
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
        const layout = await readMv3Layout(runtimePath);
        assert.equal(manifest.background.service_worker, layout.wrapper);
        assert.equal(manifest.background.type, "module");
        assert.equal(path.posix.dirname(layout.wrapper), "module");
        assert.equal(
          await fs.readFile(path.join(runtimePath, "module", "sw.js"), "utf8"),
          "export const loaded = true;\n",
        );
        const wrapper = await fs.readFile(toRuntimePath(runtimePath, layout.wrapper), "utf8");
        assert.match(wrapper, new RegExp(`\\.\\./${escapeRegExp(layout.config)}`));
        assert.match(wrapper, new RegExp(`\\.\\./${escapeRegExp(layout.bootstrap)}`));
        assert.match(wrapper, /\.\/sw\.js/);
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
        "pages/background.html": "<html><head><base href=\"/redirected/\"><!-- <script src=\"ignored.js\"></script> --><meta content=\"<script>\"><style>x{content:\"<script>\"}</style><SCRIPT defer src=\"original.js\"></SCRIPT></head></html>",
        "pages/original.js": "",
      },
      verify: async (runtimePath) => {
        const page = await fs.readFile(path.join(runtimePath, "pages", "background.html"), "utf8");
        const realScript = page.indexOf("<SCRIPT defer");
        assert.ok(page.indexOf("config.js") > page.indexOf("</style>") && page.indexOf("config.js") < realScript);
        assert.ok(page.indexOf("bootstrap.js") > page.indexOf("</style>") && page.indexOf("bootstrap.js") < realScript);
        assert.match(page, /src="\/cbpanel_lifecycle\/config\.js"/);
        assert.match(page, /src="\/cbpanel_lifecycle\/bootstrap\.js"/);
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

test("an explicit preserve override keeps a unique non-legacy binding token", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "imported-source", {
    manifest_version: 3,
    name: "Imported",
    version: "2.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });

  const service = runtimeService(root);
  const entity = extensionEntity("extension-imported", source, "reference");
  const runtime = await service.materialize({
    environmentId: "environment-imported",
    extension: entity,
    lifecycleRevision: "import-binding-token",
    initialBehavior: "preserve",
  });

  const config = await readConfig(runtime.path);
  const firstLayout = await readMv3Layout(runtime.path);
  assert.match(config, /"bindingRevision":"import-binding-token"/);
  assert.match(config, /"initialBehavior":"preserve"/);
  assert.match(config, /"preserveMissingState":true/);
  assert.equal(runtime.registration?.migrationRequired, false);
  await fs.mkdir(path.join(root, "browser-data", "environment-imported", "Default"), { recursive: true });
  await fs.writeFile(
    path.join(root, "browser-data", "environment-imported", "Default", "Secure Preferences"),
    JSON.stringify({ extensions: { settings: { [runtime.registration!.browserExtensionId]: {} } } }),
    "utf8",
  );

  const rebound = await service.materialize({
    environmentId: "environment-imported",
    extension: entity,
    lifecycleRevision: "replacement-binding-token",
    initialBehavior: "preserve",
  });
  const reboundLayout = await readMv3Layout(rebound.path);
  assert.notEqual(reboundLayout.wrapper, firstLayout.wrapper);
  assert.notEqual(reboundLayout.config, firstLayout.config);
  assert.notEqual(reboundLayout.bootstrap, firstLayout.bootstrap);
  assert.notEqual(rebound.registration?.runtimeRevision, runtime.registration?.runtimeRevision);
  assert.equal(rebound.registration?.migrationRequired, true);
  const stillPending = await service.materialize({
    environmentId: "environment-imported",
    extension: entity,
    lifecycleRevision: "replacement-binding-token",
    initialBehavior: "preserve",
  });
  assert.equal(stillPending.registration?.migrationRequired, true);
  await assert.rejects(
    service.markRegistrationReady(rebound.path, "0".repeat(64)),
    hasErrorCode("EXTENSION_RUNTIME_REGISTRATION_STALE"),
  );
  await service.markRegistrationReady(rebound.path, rebound.registration!.signature);
  const ready = await service.materialize({
    environmentId: "environment-imported",
    extension: entity,
    lifecycleRevision: "replacement-binding-token",
    initialBehavior: "preserve",
  });
  assert.equal(ready.registration?.migrationRequired, false);
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

test("materialization and cleanup reject runtime junction escapes without touching outside data", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "runtime-link-source", {
    manifest_version: 3,
    name: "Runtime Link",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtimeDir = path.join(root, "extension-runtimes");
  const outsideEnvironment = path.join(root, "outside-environment");
  const outsideOutput = path.join(root, "outside-output");
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.mkdir(outsideEnvironment, { recursive: true });
  await fs.mkdir(outsideOutput, { recursive: true });
  await fs.writeFile(path.join(outsideEnvironment, "sentinel.txt"), "environment", "utf8");
  await fs.writeFile(path.join(outsideOutput, "sentinel.txt"), "output", "utf8");
  const linkedEnvironment = path.join(runtimeDir, "environment-linked-runtime");
  try {
    await fs.symlink(outsideEnvironment, linkedEnvironment, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Symbolic links are not available in this test environment");
      await fs.rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const service = runtimeService(root);
  const linkedEnvironmentInput = {
    environmentId: "environment-linked-runtime",
    extension: extensionEntity("extension-linked-runtime", source, "reference"),
    lifecycleRevision: "binding-linked-runtime",
  } as const;

  await assert.rejects(service.materialize(linkedEnvironmentInput), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  await assert.rejects(service.removeEnvironment("environment-linked-runtime"), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  assert.equal(await fs.readFile(path.join(outsideEnvironment, "sentinel.txt"), "utf8"), "environment");
  await fs.rm(linkedEnvironment, { recursive: true, force: true });

  const safeEnvironment = path.join(runtimeDir, "environment-safe");
  await fs.mkdir(safeEnvironment, { recursive: true });
  await fs.symlink(outsideOutput, path.join(safeEnvironment, "extension-linked-output"), process.platform === "win32" ? "junction" : "dir");
  const linkedOutputInput = {
    environmentId: "environment-safe",
    extension: extensionEntity("extension-linked-output", source, "reference"),
    lifecycleRevision: "binding-linked-output",
  } as const;
  await assert.rejects(service.materialize(linkedOutputInput), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  await assert.rejects(service.removeEnvironment("environment-safe"), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  await assert.rejects(
    service.sweepBindings(new Map([["environment-safe", new Set<string>()]])),
    hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"),
  );
  await assert.rejects(service.removeExtension("extension-linked-output"), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  assert.equal(await fs.readFile(path.join(outsideOutput, "sentinel.txt"), "utf8"), "output");

  await fs.rm(path.join(safeEnvironment, "extension-linked-output"), { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("a linked runtime root is rejected by destructive sweeps", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "linked-root-source", {
    manifest_version: 3,
    name: "Linked Root",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const outside = path.join(root, "outside-runtime-root");
  const linkedRuntime = path.join(root, "linked-runtime-root");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "sentinel.txt"), "outside", "utf8");
  try {
    await fs.symlink(outside, linkedRuntime, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      context.skip("Symbolic links are not available in this test environment");
      await fs.rm(root, { recursive: true, force: true });
      return;
    }
    throw error;
  }
  const service = new ExtensionRuntimeService({ runtimeDir: linkedRuntime, browserDataDir: path.join(root, "browser-data") });

  await assert.rejects(service.materialize({
    environmentId: "environment-linked-root",
    extension: extensionEntity("extension-linked-root", source, "reference"),
    lifecycleRevision: "binding-linked-root",
  }), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  await assert.rejects(service.sweepArtifacts(), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  await assert.rejects(service.sweepBindings(new Map()), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  assert.equal(await fs.readFile(path.join(outside, "sentinel.txt"), "utf8"), "outside");

  await fs.rm(linkedRuntime, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("replacement can be forbidden without blocking first creation or valid reuse", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "replacement-source", {
    manifest_version: 3,
    name: "Replacement",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.replacement = 1;\n" });
  const service = runtimeService(root);
  const input = {
    environmentId: "environment-replacement",
    extension: extensionEntity("extension-replacement", source, "reference"),
    lifecycleRevision: "binding-replacement",
    allowReplaceExisting: false,
  } as const;

  const first = await service.materialize(input);
  const reused = await service.materialize(input);
  assert.equal(reused.path, first.path);
  await fs.writeFile(path.join(source, "sw.js"), "globalThis.replacement = 2;\n", "utf8");
  await assert.rejects(service.materialize(input), hasErrorCode("EXTENSION_RUNTIME_REPLACEMENT_FORBIDDEN"));
  assert.match(await fs.readFile(path.join(first.path, "sw.js"), "utf8"), /replacement = 1/);

  const replaced = await service.materialize({ ...input, allowReplaceExisting: true });
  assert.match(await fs.readFile(path.join(replaced.path, "sw.js"), "utf8"), /replacement = 2/);
  await fs.rm(root, { recursive: true, force: true });
});

test("reference materialization fails if the source changes after it is copied", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "changing-source", {
    manifest_version: 3,
    name: "Changing",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.sourceRevision = 1;\n" });
  const originalCopy = fs.cp.bind(fs);
  context.mock.method(fs, "cp", async (from: string, to: string, options: { recursive?: boolean }) => {
    await originalCopy(from, to, options);
    await fs.writeFile(path.join(source, "sw.js"), "globalThis.sourceRevision = 2;\n", "utf8");
  });

  await assert.rejects(runtimeService(root).materialize({
    environmentId: "environment-changing",
    extension: extensionEntity("extension-changing", source, "reference"),
    lifecycleRevision: "binding-changing",
  }), hasErrorCode("EXTENSION_RUNTIME_SOURCE_CHANGED"));
  assert.equal(await exists(path.join(root, "extension-runtimes", "environment-changing", "extension-changing")), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("reference reuse fails if the source changes during runtime integrity verification", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "reuse-changing-source", {
    manifest_version: 3,
    name: "Reuse Changing",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.sourceRevision = 1;\n" });
  const service = runtimeService(root);
  const input = {
    environmentId: "environment-reuse-changing",
    extension: extensionEntity("extension-reuse-changing", source, "reference"),
    lifecycleRevision: "binding-reuse-changing",
  } as const;
  const first = await service.materialize(input);
  const originalReadFile = fs.readFile.bind(fs);
  let changed = false;
  context.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const candidate = typeof args[0] === "string" ? args[0] : args[0].toString();
    if (!changed && candidate === path.join(first.path, "sw.js")) {
      changed = true;
      await fs.writeFile(path.join(source, "sw.js"), "globalThis.sourceRevision = 2;\n", "utf8");
    }
    return originalReadFile(...args);
  });

  await assert.rejects(service.materialize(input), hasErrorCode("EXTENSION_RUNTIME_SOURCE_CHANGED"));
  assert.equal(changed, true);
  assert.match(await originalReadFile(path.join(first.path, "sw.js"), "utf8"), /sourceRevision = 1/);
  await fs.rm(root, { recursive: true, force: true });
});

test("copied mutation paths are revalidated before lifecycle files are written", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "copied-link-source", {
    manifest_version: 3,
    name: "Copied Link",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "background/sw.js" },
  }, { "background/sw.js": "globalThis.original = true;\n" });
  const outside = path.join(root, "outside-background");
  await fs.mkdir(outside, { recursive: true });
  await fs.writeFile(path.join(outside, "sw.js"), "outside sentinel\n", "utf8");
  const originalCopy = fs.cp.bind(fs);
  context.mock.method(fs, "cp", async (from: string, to: string, options: { recursive?: boolean }) => {
    await originalCopy(from, to, options);
    await fs.rm(path.join(to, "background"), { recursive: true, force: true });
    await fs.symlink(outside, path.join(to, "background"), process.platform === "win32" ? "junction" : "dir");
  });

  await assert.rejects(runtimeService(root).materialize({
    environmentId: "environment-copied-link",
    extension: extensionEntity("extension-copied-link", source, "reference"),
    lifecycleRevision: "binding-copied-link",
  }), hasErrorCode("EXTENSION_RUNTIME_UNSAFE_PATH"));
  assert.equal(await fs.readFile(path.join(outside, "sw.js"), "utf8"), "outside sentinel\n");
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

test("cleanup operations do not remove an actively materializing runtime key", async (context) => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "active-source", {
    manifest_version: 3,
    name: "Active",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.active = true;\n" });
  const service = runtimeService(root);
  const originalCopy = fs.cp.bind(fs);
  let notifyCopied: (() => void) | undefined;
  let releaseCopy: (() => void) | undefined;
  const copied = new Promise<void>((resolve) => { notifyCopied = resolve; });
  const copyCanFinish = new Promise<void>((resolve) => { releaseCopy = resolve; });
  context.mock.method(fs, "cp", async (from: string, to: string, options: { recursive?: boolean }) => {
    await originalCopy(from, to, options);
    notifyCopied?.();
    await copyCanFinish;
  });

  const materializing = service.materialize({
    environmentId: "environment-active",
    extension: extensionEntity("extension-active", source, "reference"),
    lifecycleRevision: "binding-active",
  });
  await copied;

  assert.equal(await service.removeEnvironment("environment-active"), false);
  await service.removeExtension("extension-active");
  await service.sweepArtifacts();
  await service.sweepBindings(new Map());
  releaseCopy?.();
  const runtime = await materializing;

  assert.equal(await exists(path.join(runtime.path, "manifest.json")), true);
  assert.equal(await exists(path.join(runtime.path, EXTENSION_LIFECYCLE_NAMESPACE, "materialization.json")), true);
  await fs.rm(root, { recursive: true, force: true });
});

test("materialization waits for an environment cleanup that already crossed its active probe", async (context) => {
  const root = await makeTempDir();
  const runtimeDir = path.join(root, "extension-runtimes");
  const environmentDir = path.join(runtimeDir, "environment-cleanup-race");
  await fs.mkdir(path.join(environmentDir, "stale-extension"), { recursive: true });
  const source = await writeExtension(root, "cleanup-race-source", {
    manifest_version: 3,
    name: "Cleanup Race",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "globalThis.cleanupRace = true;\n" });
  const service = new ExtensionRuntimeService({ runtimeDir, browserDataDir: path.join(root, "browser-data") });
  const originalRemove = fs.rm.bind(fs);
  const originalCopy = fs.cp.bind(fs);
  let notifyRemove: (() => void) | undefined;
  let releaseRemove: (() => void) | undefined;
  let copyStarted = false;
  const removeStarted = new Promise<void>((resolve) => { notifyRemove = resolve; });
  const removeCanFinish = new Promise<void>((resolve) => { releaseRemove = resolve; });
  context.mock.method(fs, "rm", async (candidate: string, options?: { recursive?: boolean; force?: boolean }) => {
    if (candidate === environmentDir) {
      notifyRemove?.();
      await removeCanFinish;
    }
    return originalRemove(candidate, options);
  });
  context.mock.method(fs, "cp", async (from: string, to: string, options: { recursive?: boolean }) => {
    copyStarted = true;
    return originalCopy(from, to, options);
  });

  const removing = service.removeEnvironment("environment-cleanup-race");
  await removeStarted;
  const materializing = service.materialize({
    environmentId: "environment-cleanup-race",
    extension: extensionEntity("extension-cleanup-race", source, "reference"),
    lifecycleRevision: "binding-cleanup-race",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(copyStarted, false);

  releaseRemove?.();
  assert.equal(await removing, true);
  const runtime = await materializing;
  assert.equal(await exists(path.join(runtime.path, "manifest.json")), true);
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
  const bootstrap = await readBootstrap(runtime.path);
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

test("missing lifecycle state suppresses native update only while adopting preserved browser state", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "missing-native-update", {
    manifest_version: 3,
    name: "Missing Native Update",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-missing-native-update",
    extension: extensionEntity("extension-missing-native-update", source, "reference"),
    lifecycleRevision: "binding-missing-native-update",
  });
  const bootstrap = await readBootstrap(runtime.path);
  const updateDetails = { reason: "update", previousVersion: "0.9.0" };

  const preservedStore = new Map<string, unknown>();
  const preserved = await runBootstrap(bootstrap, {
    ...lifecycleConfig(),
    preserveMissingState: true,
  }, preservedStore);
  preserved.nativeInstalled.emit(updateDetails);
  await settleEvents();
  assert.deepEqual(preserved.installed, []);
  assert.equal(preserved.startups, 1);
  assert.equal(JSON.stringify(preservedStore.get("state")), JSON.stringify(currentLifecycleState()));

  const freshStore = new Map<string, unknown>();
  const fresh = await runBootstrap(bootstrap, lifecycleConfig(), freshStore);
  fresh.nativeInstalled.emit(updateDetails);
  await settleEvents();
  assert.deepEqual(fresh.installed, [updateDetails]);
  assert.equal(fresh.startups, 0);
  assert.equal(JSON.stringify(freshStore.get("state")), JSON.stringify(currentLifecycleState()));

  for (const reason of ["chrome_update", "shared_module_update"]) {
    const nativeStore = new Map<string, unknown>();
    const native = await runBootstrap(bootstrap, {
      ...lifecycleConfig(),
      preserveMissingState: true,
    }, nativeStore);
    const details = { reason, marker: reason };
    native.nativeInstalled.emit(details);
    await settleEvents();
    assert.deepEqual(native.installed, [details]);
    assert.equal(native.startups, 0);
    assert.equal(JSON.stringify(nativeStore.get("state")), JSON.stringify(currentLifecycleState()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("native update noise cannot escape for an unchanged or injector-only registration refresh", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "native-runtime-update-noise", {
    manifest_version: 3,
    name: "Native Runtime Update Noise",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-native-runtime-update-noise",
    extension: extensionEntity("extension-native-runtime-update-noise", source, "reference"),
    lifecycleRevision: "binding-native-runtime-update-noise",
  });
  const bootstrap = await readBootstrap(runtime.path);

  for (const runtimeRevision of ["runtime-zero", lifecycleConfig().runtimeRevision]) {
    const store = new Map<string, unknown>([["state", {
      ...currentLifecycleState(),
      runtimeRevision,
    }]]);
    const result = await runBootstrap(bootstrap, lifecycleConfig(), store);
    result.nativeInstalled.emit({ reason: "update", previousVersion: "1.0.0", marker: "cdp-load" });
    await settleEvents();

    assert.deepEqual(result.installed, []);
    assert.equal(result.startups, 1);
    assert.equal(JSON.stringify(store.get("state")), JSON.stringify(currentLifecycleState()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("native startup alone synthesizes a pending semantic update exactly once", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "startup-semantic-update", {
    manifest_version: 3,
    name: "Startup Semantic Update",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-startup-semantic-update",
    extension: extensionEntity("extension-startup-semantic-update", source, "reference"),
    lifecycleRevision: "binding-startup-semantic-update",
  });
  const bootstrap = await readBootstrap(runtime.path);
  const store = new Map<string, unknown>([["state", {
    ...currentLifecycleState(),
    version: "0.9.0",
    packageRevision: "package-zero",
  }]]);
  const result = await runBootstrap(bootstrap, lifecycleConfig(), store);

  result.nativeStartup.emit();
  await settleEvents();

  assert.equal(
    JSON.stringify(result.installed),
    JSON.stringify([{ reason: "update", previousVersion: "0.9.0" }]),
  );
  assert.equal(result.startups, 0);
  assert.equal(JSON.stringify(store.get("state")), JSON.stringify(currentLifecycleState()));
  await fs.rm(root, { recursive: true, force: true });
});

test("activation fallback runs once only when persisted lifecycle semantics need adoption", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "activation-fallback", {
    manifest_version: 3,
    name: "Activation Fallback",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-activation-fallback",
    extension: extensionEntity("extension-activation-fallback", source, "reference"),
    lifecycleRevision: "binding-activation-fallback",
  });
  const bootstrap = await readBootstrap(runtime.path);

  const adoptedStore = new Map<string, unknown>();
  const adopted = await runBootstrap(bootstrap, {
    ...lifecycleConfig(),
    preserveMissingState: true,
  }, adoptedStore);
  await settleEvents();
  assert.deepEqual(adopted.installed, []);
  assert.equal(adopted.startups, 1);
  assert.equal(JSON.stringify(adoptedStore.get("state")), JSON.stringify(currentLifecycleState()));

  const currentStore = new Map<string, unknown>([["state", currentLifecycleState()]]);
  const current = await runBootstrap(bootstrap, lifecycleConfig(), currentStore);
  await settleEvents();
  assert.deepEqual(current.installed, []);
  assert.equal(current.startups, 0);

  const runtimeUpgradeStore = new Map<string, unknown>([["state", {
    ...currentLifecycleState(),
    runtimeRevision: "runtime-zero",
  }]]);
  const runtimeUpgrade = await runBootstrap(bootstrap, lifecycleConfig(), runtimeUpgradeStore);
  await settleEvents();
  assert.deepEqual(runtimeUpgrade.installed, []);
  assert.equal(runtimeUpgrade.startups, 1);
  assert.equal(JSON.stringify(runtimeUpgradeStore.get("state")), JSON.stringify(currentLifecycleState()));

  const semanticUpdateStore = new Map<string, unknown>([["state", {
    schemaVersion: 1,
    version: "0.9.0",
    packageRevision: "package-zero",
    bindingRevision: "binding-one",
    runtimeRevision: "runtime-zero",
  }]]);
  const semanticUpdate = await runBootstrap(bootstrap, lifecycleConfig(), semanticUpdateStore);
  await settleEvents();
  assert.equal(
    JSON.stringify(semanticUpdate.installed),
    JSON.stringify([{ reason: "update", previousVersion: "0.9.0" }]),
  );
  assert.equal(semanticUpdate.startups, 0);
  assert.equal(JSON.stringify(semanticUpdateStore.get("state")), JSON.stringify(currentLifecycleState()));

  const reboundStore = new Map<string, unknown>([["state", {
    ...currentLifecycleState(),
    bindingRevision: "binding-zero",
    runtimeRevision: "runtime-zero",
  }]]);
  const rebound = await runBootstrap(bootstrap, {
    ...lifecycleConfig(),
    preserveMissingState: true,
  }, reboundStore);
  await settleEvents();
  assert.equal(
    JSON.stringify(rebound.installed),
    JSON.stringify([{ reason: "update", previousVersion: "1.0.0" }]),
  );
  assert.equal(rebound.startups, 0);
  assert.equal(JSON.stringify(reboundStore.get("state")), JSON.stringify(currentLifecycleState()));

  const freshStore = new Map<string, unknown>();
  const fresh = await runBootstrap(bootstrap, lifecycleConfig(), freshStore);
  await settleEvents();
  assert.deepEqual(fresh.installed, []);
  assert.equal(fresh.startups, 0);
  assert.equal(freshStore.has("state"), false);
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
  const bootstrap = await readBootstrap(runtime.path);
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

test("bootstrap distinguishes a failed state read from a missing state and never installs or updates", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "read-failure", {
    manifest_version: 3,
    name: "Read Failure",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-read-failure",
    extension: extensionEntity("extension-read-failure", source, "reference"),
    lifecycleRevision: "binding-read-failure",
  });
  const bootstrap = await readBootstrap(runtime.path);
  const errors: string[] = [];
  const result = await runBootstrap(bootstrap, lifecycleConfig(), new Map(), { readFails: true, errors });

  result.nativeInstalled.emit({ reason: "install" });
  await settleEvents();

  assert.deepEqual(result.installed, []);
  assert.equal(result.startups, 1);
  assert.ok(errors.some((message) => message.includes("could not read state")));
  assert.ok(errors.some((message) => message.includes("suppressed install/update")));

  const nativeUpdate = await runBootstrap(bootstrap, lifecycleConfig(), new Map(), { readFails: true });
  nativeUpdate.nativeInstalled.emit({ reason: "chrome_update" });
  await settleEvents();
  assert.deepEqual(nativeUpdate.installed, []);
  assert.equal(nativeUpdate.startups, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test("bootstrap forwards native non-install reasons exactly and latches startup", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "native-reasons", {
    manifest_version: 3,
    name: "Native Reasons",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-native-reasons",
    extension: extensionEntity("extension-native-reasons", source, "reference"),
    lifecycleRevision: "binding-native-reasons",
  });
  const bootstrap = await readBootstrap(runtime.path);

  for (const reason of ["update", "chrome_update", "shared_module_update"]) {
    const store = new Map<string, unknown>([["state", {
      schemaVersion: 1,
      version: "0.9.0",
      packageRevision: "old-package",
      bindingRevision: "old-binding",
    }]]);
    const result = await runBootstrap(bootstrap, lifecycleConfig(), store);
    const details = { reason, previousVersion: "0.9.0", marker: reason };
    result.nativeInstalled.emit(details);
    result.nativeStartup.emit();
    await settleEvents();

    assert.equal(result.installed.length, 1);
    assert.equal(result.installed[0]?.reason, reason);
    assert.equal(result.installed[0]?.previousVersion, "0.9.0");
    assert.equal(result.installed[0]?.marker, reason);
    assert.equal(result.startups, 0);
    assert.equal(JSON.stringify(store.get("state")), JSON.stringify(currentLifecycleState()));
  }
  await fs.rm(root, { recursive: true, force: true });
});

test("patched lifecycle events implement add, remove, hasListener, and hasListeners", async () => {
  const root = await makeTempDir();
  const source = await writeExtension(root, "event-methods", {
    manifest_version: 3,
    name: "Event Methods",
    version: "1.0.0",
    key: MANIFEST_KEY,
    background: { service_worker: "sw.js" },
  }, { "sw.js": "" });
  const runtime = await runtimeService(root).materialize({
    environmentId: "environment-event-methods",
    extension: extensionEntity("extension-event-methods", source, "reference"),
    lifecycleRevision: "binding-event-methods",
  });
  const bootstrap = await readBootstrap(runtime.path);
  const result = await runBootstrap(bootstrap, lifecycleConfig(), new Map(), { captureListeners: false });
  const installedListener = () => undefined;
  const startupListener = () => undefined;

  assert.equal(result.installedEvent.hasListeners(), false);
  assert.equal(result.startupEvent.hasListeners(), false);
  result.installedEvent.addListener(installedListener);
  result.startupEvent.addListener(startupListener);
  assert.equal(result.installedEvent.hasListener(installedListener), true);
  assert.equal(result.startupEvent.hasListener(startupListener), true);
  assert.equal(result.installedEvent.hasListeners(), true);
  assert.equal(result.startupEvent.hasListeners(), true);
  result.installedEvent.removeListener(installedListener);
  result.startupEvent.removeListener(startupListener);
  assert.equal(result.installedEvent.hasListener(installedListener), false);
  assert.equal(result.startupEvent.hasListener(startupListener), false);
  assert.equal(result.installedEvent.hasListeners(), false);
  assert.equal(result.startupEvent.hasListeners(), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("a preserve-mode import token rebases legacy restored state once before normal updates resume", async () => {
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
  const bootstrap = await readBootstrap(runtime.path);
  const store = new Map<string, unknown>([["state", {
    schemaVersion: 1,
    version: "1.0.0",
    packageRevision: "old-package",
    bindingRevision: "legacy",
  }]]);
  const legacyConfig = {
    schemaVersion: 1,
    version: "2.0.0",
    packageRevision: "restored-package",
    bindingRevision: "import-rebase-token",
    initialBehavior: "preserve",
    preserveMissingState: true,
    runtimeRevision: "runtime-restored",
  };

  const restored = await runBootstrap(bootstrap, legacyConfig, store);
  restored.nativeInstalled.emit({ reason: "install" });
  await settleEvents();
  assert.deepEqual(restored.installed, []);
  assert.equal(restored.startups, 1);
  assert.equal((store.get("state") as { bindingRevision: string }).bindingRevision, "import-rebase-token");

  const updated = await runBootstrap(bootstrap, { ...legacyConfig, version: "3.0.0" }, store);
  updated.nativeInstalled.emit({ reason: "install" });
  await settleEvents();
  assert.equal(updated.installed[0]?.reason, "update");
  assert.equal(updated.installed[0]?.previousVersion, "2.0.0");
  assert.equal(updated.startups, 0);
  await fs.rm(root, { recursive: true, force: true });
});

test("real Chromium keeps MV3 classic and module lifecycle state across two persistent launches", async (context) => {
  const launchFixture = await resolveBrowserFixtureLauncher();
  if (!launchFixture) {
    context.skip("Neither CloakBrowser nor Playwright Chromium is installed");
    return;
  }
  context.diagnostic(`Chromium fixture source: ${launchFixture.description}`);
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
          "nested/helper.js": "globalThis.fixtureHelperLoaded = true;\n",
        });
        const entity = extensionEntity(`extension-${kind}`, source, "reference");
        entity.manifestKey = manifestKey;
        const runtime = await runtimeService(root).materialize({
          environmentId: `environment-${kind}`,
          extension: entity,
          lifecycleRevision: `binding-${kind}`,
        });
        const layout = await readMv3Layout(runtime.path);
        const userDataDir = path.join(root, "browser-data", `environment-${kind}`);

        let first: import("playwright-core").BrowserContext | undefined;
        try {
          first = await launchFixture(userDataDir, runtime.path);
          const firstState = await waitForBrowserFixtureState(first, (state) => (
            state.installCount === 1
            && state.welcomeCount === 1
            && state.helperLoaded === true
            && JSON.stringify(state.events) === JSON.stringify(["installed:install"])
          ));
          const welcome = await waitForWelcomePage(first);
          assert.equal(firstState.installCount, 1);
          assert.equal(firstState.startupCount ?? 0, 0);
          assert.equal(firstState.helperLoaded, true);
          assert.deepEqual(firstState.events, ["installed:install"]);
          assert.match(
            typeof firstState.workerLocation === "string" ? firstState.workerLocation : "",
            new RegExp(`${escapeRegExp(layout.wrapper)}$`),
          );
          await welcome.close();
        } finally {
          await first?.close().catch(() => undefined);
        }

        let second: import("playwright-core").BrowserContext | undefined;
        try {
          second = await launchFixture(userDataDir, runtime.path);
          const secondState = await waitForBrowserFixtureState(second, (state) => (
            state.startupCount === 1
            && JSON.stringify(state.events) === JSON.stringify(["installed:install", "startup"])
          ));
          assert.equal(secondState.installCount, 1);
          assert.equal(secondState.startupCount, 1);
          assert.equal(secondState.welcomeCount, 1);
          assert.deepEqual(secondState.events, ["installed:install", "startup"]);
          assert.equal(second.pages().some((page) => page.url().endsWith("welcome.html")), false);
        } finally {
          await second?.close().catch(() => undefined);
        }
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("real Chromium migrates an existing canonical MV3 worker registration to the protected wrapper", async (context) => {
  const launchFixture = await resolveBrowserFixtureLauncher();
  if (!launchFixture) {
    context.skip("Neither CloakBrowser nor Playwright Chromium is installed");
    return;
  }
  context.diagnostic(`Chromium fixture source: ${launchFixture.description}`);
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const manifestKey = Buffer.from(keyPair.publicKey.export({ type: "spki", format: "der" })).toString("base64");
  for (const [kind, module] of [["classic", false], ["module", true]] as const) {
    await context.test(kind, async () => {
      const root = await makeTempDir();
      try {
        const environmentId = `environment-canonical-migration-${kind}`;
        const workerPath = "nested/worker.js";
        const workerSource = browserFixtureWorker(module);
        const source = await writeExtension(root, "canonical-browser-source", {
          manifest_version: 3,
          name: `Canonical migration ${kind}`,
          version: "1.0.0",
          key: manifestKey,
          permissions: ["storage", "tabs"],
          background: { service_worker: workerPath, ...(module ? { type: "module" } : {}) },
        }, {
          [workerPath]: workerSource,
          "welcome.html": "<!doctype html><title>Welcome</title>",
          "nested/helper.js": "globalThis.fixtureHelperLoaded = true;\n",
        });
        const entity = extensionEntity(`extension-canonical-migration-${kind}`, source, "reference");
        entity.manifestKey = manifestKey;
        const userDataDir = path.join(root, "browser-data", environmentId);
        const legacyRuntimePath = path.join(root, "extension-runtimes", environmentId, entity.id);
        await fs.mkdir(path.dirname(legacyRuntimePath), { recursive: true });
        await fs.cp(source, legacyRuntimePath, { recursive: true });

        let canonical: import("playwright-core").BrowserContext | undefined;
        let canonicalWorkerLocation = "";
        try {
          canonical = await launchFixture(userDataDir, legacyRuntimePath);
          const state = await waitForBrowserFixtureState(canonical, (candidate) => (
            candidate.installCount === 1
            && candidate.welcomeCount === 1
            && candidate.helperLoaded === true
            && JSON.stringify(candidate.events) === JSON.stringify(["installed:install"])
          ));
          canonicalWorkerLocation = typeof state.workerLocation === "string" ? state.workerLocation : "";
          assert.match(canonicalWorkerLocation, /nested\/worker\.js$/);
          assert.deepEqual(await readBrowserFixtureScripts(canonical), expectedBrowserFixtureScripts());
          await (await waitForWelcomePage(canonical)).close();
        } finally {
          await canonical?.close().catch(() => undefined);
        }
        if (!module) {
          await assertBrowserFixtureDestructiveInstallBranchReachable(
            launchFixture,
            path.join(root, "browser-data", "destructive-install-control"),
            legacyRuntimePath,
          );
        }

        const service = runtimeService(root);
        const materializeInput = {
          environmentId,
          extension: entity,
          lifecycleRevision: `binding-canonical-migration-${kind}`,
        } as const;
        const runtime = await service.materialize(materializeInput);
        assert.equal(runtime.path, legacyRuntimePath);
        assert.equal(runtime.registration?.migrationRequired, true);
        const layout = await readMv3Layout(runtime.path);
        const migrationConfig = await readConfig(runtime.path);
        const parsedMigrationConfig = parseGeneratedLifecycleConfig(migrationConfig);
        assert.match(migrationConfig, /"initialBehavior":"install"/);
        assert.match(migrationConfig, /"preserveMissingState":true/);
        assert.equal(await fs.readFile(path.join(runtime.path, ...workerPath.split("/")), "utf8"), workerSource);
        const extensionId = new URL(canonicalWorkerLocation).host;
        assert.equal(runtime.registration?.browserExtensionId, extensionId);
        assert.equal(runtime.registration?.workerRelativePath, layout.wrapper);
        const launchRegistration = {
          ...runtime.registration!,
          name: `Canonical migration ${kind}`,
          runtimePath: runtime.path,
        };
        await runRawRegistrationPreflight(
          launchFixture.executablePath,
          userDataDir,
          launchRegistration,
        );

        let migrated: import("playwright-core").BrowserContext | undefined;
        try {
          migrated = await launchFixture(userDataDir, runtime.path);
          await migrateExtensionRegistrations(
            playwrightRegistrationMigrationBrowser(migrated),
            [launchRegistration],
            () => service.markRegistrationReady(runtime.path, runtime.registration!.signature),
          );
          let state: Record<string, unknown>;
          try {
            state = await waitForBrowserFixtureState(migrated, (candidate) => (
              candidate.installCount === 1
              && candidate.startupCount === 1
              && candidate.welcomeCount === 1
              && JSON.stringify(candidate.events) === JSON.stringify(["installed:install", "startup"])
            ));
          } catch (error) {
            const preferenceDiagnostics = await readExtensionPreferenceDiagnostics(userDataDir, extensionId);
            throw new Error(`${error instanceof Error ? error.message : String(error)}; preferences=${JSON.stringify(preferenceDiagnostics)}`);
          }
          const migratedWorkerLocation = typeof state.workerLocation === "string" ? state.workerLocation : "";
          assert.match(migratedWorkerLocation, new RegExp(`${escapeRegExp(layout.wrapper)}$`));
          assert.notEqual(migratedWorkerLocation, canonicalWorkerLocation);
          assert.equal(new URL(migratedWorkerLocation).host, new URL(canonicalWorkerLocation).host);
          assert.equal(migrated.pages().some((page) => page.url().endsWith("welcome.html")), false);
          assert.deepEqual(await readBrowserLifecycleState(migrated), {
            schemaVersion: 1,
            version: "1.0.0",
            packageRevision: parsedMigrationConfig.packageRevision,
            bindingRevision: `binding-canonical-migration-${kind}`,
            runtimeRevision: runtime.registration?.runtimeRevision,
          });
          await assertBrowserFixtureScriptsSurviveQuietWindow(migrated);
        } finally {
          await migrated?.close().catch(() => undefined);
        }

        const readyRuntime = await service.materialize(materializeInput);
        assert.equal(readyRuntime.registration?.migrationRequired, false);

        let steady: import("playwright-core").BrowserContext | undefined;
        try {
          steady = await launchFixture(userDataDir, runtime.path);
          const state = await waitForBrowserFixtureState(steady, (candidate) => (
            candidate.installCount === 1
            && candidate.startupCount === 2
            && candidate.welcomeCount === 1
            && JSON.stringify(candidate.events) === JSON.stringify(["installed:install", "startup", "startup"])
          ));
          assert.equal(state.installCount, 1);
          await assertBrowserFixtureScriptsSurviveQuietWindow(steady);
          assert.equal(steady.pages().some((page) => page.url().endsWith("welcome.html")), false);
        } finally {
          await steady?.close().catch(() => undefined);
        }
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

async function runRawRegistrationPreflight(
  executablePath: string,
  userDataDir: string,
  registration: ExtensionLaunchRegistration,
): Promise<void> {
  const options = buildExtensionRegistrationPreflightLaunchOptions(userDataDir, executablePath);
  const activePortPath = await prepareExtensionRegistrationPreflightUserDataDir(userDataDir);
  const child = spawn(options.executablePath, options.args, options.spawnOptions);
  const preflight = rawCdpRegistrationPreflightProcess(child, activePortPath, options.timeout);
  try {
    await preflight.clearServiceWorkers([`chrome-extension://${registration.browserExtensionId}`]);
    await preflight.loadUnpackedExtensions([registration]);
    await preflight.finish();
  } catch (error) {
    await preflight.close();
    throw error;
  }
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

type Mv3RuntimeLayout = {
  config: string;
  bootstrap: string;
  wrapper: string;
};

async function readMv3Layout(runtimePath: string): Promise<Mv3RuntimeLayout> {
  const manifest = JSON.parse(await fs.readFile(path.join(runtimePath, "manifest.json"), "utf8")) as {
    background?: { service_worker?: unknown };
  };
  const metadata = JSON.parse(await fs.readFile(
    path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE, "materialization.json"),
    "utf8",
  )) as { injectorVersion?: unknown; signature?: unknown };
  assert.equal(metadata.injectorVersion, EXTENSION_LIFECYCLE_INJECTOR_VERSION);
  assert.equal(typeof metadata.signature, "string");
  assert.match(metadata.signature as string, /^[a-f0-9]{64}$/);
  const revision = Buffer.from((metadata.signature as string).slice(0, 32), "hex").toString("base64url");
  const suffix = `v${EXTENSION_LIFECYCLE_INJECTOR_VERSION}-${revision}`;
  const layout = {
    config: `${EXTENSION_LIFECYCLE_NAMESPACE}/config-${suffix}.js`,
    bootstrap: `${EXTENSION_LIFECYCLE_NAMESPACE}/bootstrap-${suffix}.js`,
    wrapper: manifest.background?.service_worker,
  };
  assert.equal(typeof layout.wrapper, "string");
  assert.match(
    path.posix.basename(layout.wrapper as string),
    new RegExp(`^${EXTENSION_LIFECYCLE_NAMESPACE}-worker-${escapeRegExp(suffix)}\\.js$`),
  );
  assert.equal(await exists(toRuntimePath(runtimePath, layout.wrapper as string)), true);
  return layout as Mv3RuntimeLayout;
}

function toRuntimePath(runtimePath: string, relativePath: string): string {
  return path.join(runtimePath, ...relativePath.split("/"));
}

async function readConfig(runtimePath: string): Promise<string> {
  const layout = await readMv3Layout(runtimePath);
  return fs.readFile(toRuntimePath(runtimePath, layout.config), "utf8");
}

function parseGeneratedLifecycleConfig(source: string): { packageRevision: string } {
  const match = /^globalThis\.__CBPANEL_LIFECYCLE_CONFIG__ = (.+);\r?\n?$/.exec(source);
  assert.ok(match?.[1], "generated lifecycle config must remain a single JSON assignment");
  const parsed = JSON.parse(match[1]) as { packageRevision?: unknown };
  assert.equal(typeof parsed.packageRevision, "string");
  return parsed as { packageRevision: string };
}

async function readBootstrap(runtimePath: string): Promise<string> {
  const layout = await readMv3Layout(runtimePath);
  return fs.readFile(toRuntimePath(runtimePath, layout.bootstrap), "utf8");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function fingerprintTestTree(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update("\0");
      } else {
        hash.update(`o\0${relative}\0`);
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

function hasErrorCode(code: string): (error: unknown) => boolean {
  return (error) => (error as { code?: unknown }).code === code;
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
    preserveMissingState: false,
    runtimeRevision: "runtime-one",
  };
}

function currentLifecycleState(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    version: "1.0.0",
    packageRevision: "package-one",
    bindingRevision: "binding-one",
    runtimeRevision: "runtime-one",
  };
}

async function runBootstrap(
  source: string,
  config: Record<string, unknown>,
  state: Map<string, unknown>,
  options: { writeFails?: boolean; readFails?: boolean; errors?: string[]; captureListeners?: boolean } = {},
): Promise<{
  nativeInstalled: FakeNativeEvent;
  nativeStartup: FakeNativeEvent;
  installedEvent: FakeNativeEvent;
  startupEvent: FakeNativeEvent;
  installed: Array<Record<string, unknown>>;
  startups: number;
  errors: string[];
}> {
  const nativeInstalled = fakeNativeEvent();
  const nativeStartup = fakeNativeEvent();
  const indexedDB = fakeIndexedDb(state, {
    readFails: options.readFails === true,
    writeFails: options.writeFails === true,
  });
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
  if (options.captureListeners !== false) {
    context.chrome.runtime.onInstalled.addListener((details) => installed.push(details as Record<string, unknown>));
    context.chrome.runtime.onStartup.addListener(() => { startups += 1; });
  }
  return {
    nativeInstalled,
    nativeStartup,
    installedEvent: context.chrome.runtime.onInstalled,
    startupEvent: context.chrome.runtime.onStartup,
    installed,
    get startups() { return startups; },
    errors,
  };
}

function fakeIndexedDb(
  state: Map<string, unknown>,
  failures: { readFails: boolean; writeFails: boolean },
): { open: () => Record<string, unknown> } {
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
            error: failures.writeFails && mode === "readwrite" ? new Error("write failed") : undefined,
          };
          transaction.objectStore = () => ({
            get(key: string) {
              const readRequest: Record<string, unknown> = {};
              setTimeout(() => {
                if (failures.readFails) {
                  readRequest.error = new Error("read failed");
                  (readRequest.onerror as (() => void) | undefined)?.();
                  return;
                }
                readRequest.result = state.get(key);
                (readRequest.onsuccess as (() => void) | undefined)?.();
              }, 0);
              return readRequest;
            },
            put(value: unknown, key: string) {
              setTimeout(() => {
                if (failures.writeFails) {
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

type BrowserFixtureLauncher = ((
  userDataDir: string,
  runtimePath: string,
) => Promise<import("playwright-core").BrowserContext>) & {
  description: string;
  executablePath: string;
};

async function resolveBrowserFixtureLauncher(): Promise<BrowserFixtureLauncher | undefined> {
  const cloakbrowser = await import("cloakbrowser");
  const explicitBinaryPath = process.env.CLOAKBROWSER_BINARY_PATH?.trim();
  if (explicitBinaryPath) {
    if (!path.isAbsolute(explicitBinaryPath)) {
      throw new Error("CLOAKBROWSER_BINARY_PATH must be an absolute executable path for the Chromium fixture");
    }
    const stat = await fs.stat(explicitBinaryPath).catch(() => undefined);
    if (!stat?.isFile()) {
      throw new Error(`CLOAKBROWSER_BINARY_PATH does not name an existing file: ${explicitBinaryPath}`);
    }
    return Object.assign(
      (userDataDir: string, runtimePath: string) => cloakbrowser.launchPersistentContext({
        userDataDir,
        extensionPaths: [runtimePath],
        headless: true,
        stealthArgs: false,
        geoip: false,
      }),
      {
        description: `explicit CLOAKBROWSER_BINARY_PATH (${explicitBinaryPath})`,
        executablePath: explicitBinaryPath,
      },
    );
  }
  const info = await cloakbrowser.binaryInfo();
  if (info.installed) {
    return Object.assign(
      (userDataDir: string, runtimePath: string) => cloakbrowser.launchPersistentContext({
        userDataDir,
        extensionPaths: [runtimePath],
        headless: true,
        stealthArgs: false,
        geoip: false,
      }),
      { description: `CloakBrowser managed binary (${info.binaryPath})`, executablePath: info.binaryPath },
    );
  }
  const { chromium } = await import("playwright-core");
  const executablePath = chromium.executablePath();
  if (!(await exists(executablePath))) return undefined;
  return Object.assign(
    (userDataDir: string, runtimePath: string) => chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      args: [
        `--disable-extensions-except=${runtimePath}`,
        `--load-extension=${runtimePath}`,
      ],
    }),
    { description: `Playwright fallback binary (${executablePath})`, executablePath },
  );
}

function browserFixtureWorker(module: boolean): string {
  return `${module ? 'import "./helper.js";\n' : 'importScripts("./helper.js");\n'}
const fixtureBusinessDatabaseName = "tampermonkey_fixture_business_v1";
const fixtureBusinessStoreName = "scripts";
let fixtureQueue = Promise.resolve();
function enqueueFixture(task) {
  fixtureQueue = fixtureQueue.then(task, task);
  return fixtureQueue;
}
function openFixtureBusinessDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(fixtureBusinessDatabaseName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(fixtureBusinessStoreName, { keyPath: "id" });
    };
    request.onerror = () => reject(request.error || new Error("fixture business database open failed"));
    request.onsuccess = () => resolve(request.result);
  });
}
async function readFixtureBusinessScripts() {
  const database = await openFixtureBusinessDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(fixtureBusinessStoreName, "readonly");
    const request = transaction.objectStore(fixtureBusinessStoreName).getAll();
    transaction.oncomplete = () => {
      database.close();
      resolve(request.result || []);
    };
    transaction.onerror = () => {
      database.close();
      reject(transaction.error || new Error("fixture business read failed"));
    };
    transaction.onabort = transaction.onerror;
  });
}
async function writeFixtureBusinessScripts(scripts) {
  const database = await openFixtureBusinessDatabase();
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(fixtureBusinessStoreName, "readwrite");
    const store = transaction.objectStore(fixtureBusinessStoreName);
    for (const script of scripts) store.put(script);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error || new Error("fixture business write failed"));
    transaction.onabort = transaction.onerror;
  });
  database.close();
}
async function foistEnabledFixtureScript() {
  const scripts = await readFixtureBusinessScripts();
  const enabled = scripts.find((script) => script.id === "explicitly-enabled");
  if (!enabled) return;
  await writeFixtureBusinessScripts([{ ...enabled, enabled: false, foisted: true }]);
}
async function recordFixture(event) {
  const state = await chrome.storage.local.get(["events", "installCount", "startupCount", "welcomeCount"]);
  await chrome.storage.local.set({
    events: [...(state.events || []), event],
    installCount: (state.installCount || 0) + (event === "installed:install" ? 1 : 0),
    startupCount: (state.startupCount || 0) + (event === "startup" ? 1 : 0),
    helperLoaded: globalThis.fixtureHelperLoaded === true,
    workerLocation: self.location.href,
  });
}
chrome.runtime.onInstalled.addListener((details) => {
  void enqueueFixture(async () => {
    await recordFixture("installed:" + details.reason);
    if (details.reason === "install") {
      const scripts = await readFixtureBusinessScripts();
      if (scripts.length === 0) {
        await writeFixtureBusinessScripts([
          { id: "explicitly-enabled", enabled: true, foisted: false },
          { id: "user-disabled", enabled: false, foisted: false },
        ]);
      } else {
        setTimeout(() => { void enqueueFixture(foistEnabledFixtureScript); }, 500);
      }
      await chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
      const state = await chrome.storage.local.get("welcomeCount");
      await chrome.storage.local.set({ welcomeCount: (state.welcomeCount || 0) + 1 });
    }
  });
});
chrome.runtime.onStartup.addListener(() => { void enqueueFixture(() => recordFixture("startup")); });
`;
}

async function waitForWelcomePage(
  browserContext: import("playwright-core").BrowserContext,
): Promise<import("playwright-core").Page> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = browserContext.pages().find((candidate) => candidate.url().endsWith("welcome.html"));
    if (page) return page;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for extension welcome page");
}

async function waitForBrowserFixtureState(
  browserContext: import("playwright-core").BrowserContext,
  predicate: (state: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 15_000;
  let lastState: Record<string, unknown> | undefined;
  let lastError: unknown;
  while (Date.now() < deadline) {
    const worker = browserContext.serviceWorkers()[0];
    if (worker) {
      try {
        const state = await worker.evaluate(async () => {
          const runtime = globalThis as typeof globalThis & {
            chrome: { storage: { local: { get: (keys: null) => Promise<Record<string, unknown>> } } };
          };
          return runtime.chrome.storage.local.get(null);
        }) as Record<string, unknown>;
        lastState = state;
        if (predicate(state)) return state;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for extension lifecycle fixture state: ${JSON.stringify({
    workerUrls: browserContext.serviceWorkers().map((worker) => worker.url()),
    pageUrls: browserContext.pages().map((page) => page.url()),
    lastState,
    lastError: lastError instanceof Error ? lastError.message : String(lastError ?? ""),
  })}`);
}

type BrowserFixtureScript = {
  id: "explicitly-enabled" | "user-disabled";
  enabled: boolean;
  foisted: boolean;
};

function expectedBrowserFixtureScripts(): BrowserFixtureScript[] {
  return [
    { id: "explicitly-enabled", enabled: true, foisted: false },
    { id: "user-disabled", enabled: false, foisted: false },
  ];
}

async function assertBrowserFixtureScriptsSurviveQuietWindow(
  browserContext: import("playwright-core").BrowserContext,
): Promise<void> {
  // The business fixture intentionally mutates the enabled record 500ms after any repeated install.
  // Read only after that timer and its IndexedDB transaction would have completed; absence of onboarding
  // or an early state read is not evidence that Tampermonkey-style business data stayed enabled.
  await new Promise((resolve) => setTimeout(resolve, 800));
  assertBrowserFixtureScriptsPreserved(await readBrowserFixtureScripts(browserContext));
  await new Promise((resolve) => setTimeout(resolve, 300));
  assertBrowserFixtureScriptsPreserved(await readBrowserFixtureScripts(browserContext));
}

function assertBrowserFixtureScriptsPreserved(scripts: BrowserFixtureScript[]): void {
  assert.deepEqual(scripts, expectedBrowserFixtureScripts());
  assert.deepEqual(
    scripts.find((script) => script.id === "explicitly-enabled"),
    { id: "explicitly-enabled", enabled: true, foisted: false },
  );
  assert.deepEqual(
    scripts.find((script) => script.id === "user-disabled"),
    { id: "user-disabled", enabled: false, foisted: false },
  );
}

async function assertBrowserFixtureDestructiveInstallBranchReachable(
  launchFixture: BrowserFixtureLauncher,
  userDataDir: string,
  runtimePath: string,
): Promise<void> {
  let first: import("playwright-core").BrowserContext | undefined;
  try {
    first = await launchFixture(userDataDir, runtimePath);
    await waitForBrowserFixtureState(first, (state) => (
      state.installCount === 1
      && state.welcomeCount === 1
      && JSON.stringify(state.events) === JSON.stringify(["installed:install"])
    ));
    assertBrowserFixtureScriptsPreserved(await readBrowserFixtureScripts(first));
  } finally {
    await first?.close().catch(() => undefined);
  }

  let repeated: import("playwright-core").BrowserContext | undefined;
  try {
    repeated = await launchFixture(userDataDir, runtimePath);
    await waitForBrowserFixtureState(repeated, (state) => (
      state.installCount === 2
      && state.welcomeCount === 2
      && JSON.stringify(state.events) === JSON.stringify(["installed:install", "installed:install"])
    ));
    await new Promise((resolve) => setTimeout(resolve, 800));
    const scripts = await readBrowserFixtureScripts(repeated);
    assert.deepEqual(
      scripts.find((script) => script.id === "explicitly-enabled"),
      { id: "explicitly-enabled", enabled: false, foisted: true },
    );
    assert.deepEqual(
      scripts.find((script) => script.id === "user-disabled"),
      { id: "user-disabled", enabled: false, foisted: false },
    );
  } finally {
    await repeated?.close().catch(() => undefined);
  }
}

async function readBrowserFixtureScripts(
  browserContext: import("playwright-core").BrowserContext,
): Promise<BrowserFixtureScript[]> {
  const worker = browserContext.serviceWorkers()[0];
  if (!worker) throw new Error("Extension business-state worker is not running");
  const scripts = await worker.evaluate(async () => new Promise<Array<{
    id: string;
    enabled: boolean;
    foisted: boolean;
  }>>((resolve, reject) => {
    const request = indexedDB.open("tampermonkey_fixture_business_v1", 1);
    let missingDatabase = false;
    request.onupgradeneeded = () => {
      missingDatabase = true;
      request.transaction?.abort();
    };
    request.onerror = () => reject(new Error(
      missingDatabase ? "Extension business database is missing" : "Extension business database could not be opened",
    ));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("scripts")) {
        database.close();
        reject(new Error("Extension business scripts store is missing"));
        return;
      }
      const transaction = database.transaction("scripts", "readonly");
      const stateRequest = transaction.objectStore("scripts").getAll();
      stateRequest.onerror = () => {
        database.close();
        reject(new Error("Extension business scripts could not be read"));
      };
      stateRequest.onsuccess = () => {
        database.close();
        resolve(stateRequest.result as Array<{ id: string; enabled: boolean; foisted: boolean }>);
      };
    };
  }));
  return scripts
    .map((script) => ({
      id: script.id,
      enabled: script.enabled,
      foisted: script.foisted,
    }))
    .sort((left, right) => left.id.localeCompare(right.id)) as BrowserFixtureScript[];
}

async function readBrowserLifecycleState(
  browserContext: import("playwright-core").BrowserContext,
): Promise<Record<string, unknown>> {
  const worker = browserContext.serviceWorkers()[0];
  if (!worker) throw new Error("Extension lifecycle worker is not running");
  return worker.evaluate(async () => new Promise<Record<string, unknown>>((resolve, reject) => {
    const openRequest = indexedDB.open("__cbpanel_extension_lifecycle_v1", 1);
    let missingDatabase = false;
    openRequest.onupgradeneeded = () => {
      missingDatabase = true;
      openRequest.transaction?.abort();
    };
    openRequest.onerror = () => reject(new Error(
      missingDatabase ? "Extension lifecycle database is missing" : "Extension lifecycle database could not be opened",
    ));
    openRequest.onsuccess = () => {
      const database = openRequest.result;
      if (!database.objectStoreNames.contains("lifecycle")) {
        database.close();
        reject(new Error("Extension lifecycle store is missing"));
        return;
      }
      const transaction = database.transaction("lifecycle", "readonly");
      const stateRequest = transaction.objectStore("lifecycle").get("state");
      stateRequest.onerror = () => reject(new Error("Extension lifecycle state could not be read"));
      stateRequest.onsuccess = () => {
        database.close();
        if (!stateRequest.result || typeof stateRequest.result !== "object") {
          reject(new Error("Extension lifecycle state is missing"));
          return;
        }
        resolve(stateRequest.result as Record<string, unknown>);
      };
    };
  }));
}

async function readExtensionPreferenceDiagnostics(
  userDataDir: string,
  extensionId: string,
): Promise<Record<string, unknown>> {
  const diagnostics: Record<string, unknown> = {};
  for (const fileName of ["Preferences", "Secure Preferences"]) {
    try {
      const parsed = JSON.parse(await fs.readFile(path.join(userDataDir, "Default", fileName), "utf8")) as {
        extensions?: { settings?: Record<string, Record<string, unknown>> };
      };
      const entry = parsed.extensions?.settings?.[extensionId];
      diagnostics[fileName] = entry ? {
        state: entry.state,
        path: entry.path,
        location: entry.location,
        disableReasons: entry.disable_reasons,
        manifest: entry.manifest,
      } : "missing";
    } catch (error) {
      diagnostics[fileName] = error instanceof Error ? error.message : String(error);
    }
  }
  return diagnostics;
}
