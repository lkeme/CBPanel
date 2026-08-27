import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { SqlitePanelRepository } from "../storage/sqliteStore";

test("retired rows keep local lifecycle operations fetch-free after migration", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-retired-integration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const repository = new SqlitePanelRepository({ dataDir, seed: () => [] });
  const packageDir = path.join(dataDir, "legacy-package");
  await fs.mkdir(packageDir, { recursive: true });
  await fs.writeFile(
    path.join(packageDir, "manifest.json"),
    JSON.stringify({ name: "Retired local package", version: "1.0.0", manifest_version: 3 }),
    "utf8",
  );
  const environment = await repository.createProfile({ name: "Retired runtime" });
  const installed = await repository.createExtension({
    id: "extension-retired-installed",
    name: "Retired installed",
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.invalid/installed.zip",
    sourceId: "legacy-source",
    storeId: "dhdgffkkebhmkfjojejmpbldmpobfkfo",
    localPath: packageDir,
    installState: "installed",
  });
  await repository.bindExtensionToEnvironments(installed.id, [environment.id]);
  await repository.retireLegacyExtensionSources(
    path.join(dataDir, "migration-backups", "before-retirement.sqlite"),
  );

  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("retired source must never be fetched");
  }) as typeof fetch;
  try {
    const service = new (await import("./extensionService")).ExtensionService({
      repository,
      extensionCacheDir: path.join(dataDir, "extensions"),
      activeEnvironmentIds: () => new Set<string>(),
    });
    const checked = await service.check(installed.id);
    assert.equal(checked.installState, "installed");
    assert.equal((await service.install(installed.id)).installState, "installed");
    assert.equal((await service.reinstall(installed.id)).installState, "installed");
    const updateCheck = await service.checkUpdate(installed.id);
    assert.equal(updateCheck.updateState?.status, "provider-disabled");
    const ensured = await service.ensureExtensionsInstalled(environment.id);
    assert.deepEqual(ensured.paths, [packageDir]);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    repository.close();
  }
});

test("retired not-installed rows fail closed without network access", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-retired-pending-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const repository = new SqlitePanelRepository({ dataDir, seed: () => [] });
  const pending = await repository.createExtension({
    id: "extension-retired-pending",
    name: "Retired pending",
    sourceKind: "remote-crx",
    sourceUrl: "https://legacy.invalid/pending.crx",
    sourceId: "legacy-source",
    storeId: "dhdgffkkebhmkfjojejmpbldmpobfkfo",
    installState: "download-pending",
  });
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    throw new Error("retired pending source must never be fetched");
  }) as typeof fetch;
  try {
    await repository.retireLegacyExtensionSources(
      path.join(dataDir, "migration-backups", "before-retirement.sqlite"),
    );
    const service = new (await import("./extensionService")).ExtensionService({
      repository,
      extensionCacheDir: path.join(dataDir, "extensions"),
    });
    await assert.rejects(service.install(pending.id), (error: unknown) => (
      (error as { code?: string }).code === "EXTENSION_WEB_STORE"
      || (error as { code?: string }).code === "EXTENSION_LEGACY_SOURCE_RETIRED"
    ));
    const checked = await service.checkUpdate(pending.id);
    assert.equal(checked.updateState?.status, "provider-disabled");
    assert.equal((await repository.getExtension(pending.id))?.status, "disabled");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    repository.close();
  }
});
