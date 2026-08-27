import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";
import { APP_BACKUP_KIND } from "../../src/shared/appBackup";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { createSyntheticStoreCrx3 } from "../testing/crx3Fixture";
import { AppBackupService } from "./appBackupService";
import { createCrx3VerifierForTesting } from "./crx3Verifier";
import { ExtensionAcquisitionService } from "./extensionAcquisitionService";
import type { ExtensionProviderRegistry } from "./extensionProviders/providerRegistry";
import type { CatalogSearchPage, CatalogSearchProvider } from "./extensionProviders/types";
import { ExtensionService } from "./extensionService";
import { fingerprintManifest } from "./extensionPackagePreflight";
import { fingerprintStagedExtensionTree } from "./boundedZipAnalyzer";

test("schema-v2 backup round-trips retained verified CRX evidence with receiving-root paths", async () => {
  const sourceDirectory = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDirectory, seed: () => [] });
  const fixture = createSyntheticStoreCrx3({
    name: "Portable Backup Extension",
    version: "4.0.0",
    permissions: ["storage"],
    hostPermissions: [],
  });
  const manifest = {
    manifest_version: 3,
    name: "Portable Backup Extension",
    version: "4.0.0",
    permissions: ["storage"],
    host_permissions: [],
    background: { service_worker: "worker.js" },
  };
  const extensionId = "portable-backup-extension";
  const extensionRoot = path.join(sourceDirectory, "extensions", extensionId);
  await fs.mkdir(extensionRoot, { recursive: true });
  await fs.writeFile(
    path.join(extensionRoot, "manifest.json"),
    `${JSON.stringify({ ...manifest, key: fixture.developerSpkiBase64 }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(extensionRoot, "worker.js"), "chrome.runtime.onInstalled.addListener(() => undefined);", "utf8");
  const artifactPath = path.join(sourceDirectory, "extension-artifacts", extensionId, "current.crx");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, fixture.bytes);
  const sha256 = createHash("sha256").update(fixture.bytes).digest("hex");
  const manifestSha256 = fingerprintManifest(manifest);
  const treeSha256 = (await fingerprintStagedExtensionTree(extensionRoot)).sha256;
  const verifier = createCrx3VerifierForTesting(fixture.publisherSpkiSha256);
  await sourceRepository.createExtension({
    id: extensionId,
    name: manifest.name,
    sourceKind: "local-crx",
    sourceUrl: artifactPath,
    storeId: fixture.storeId,
    storeUrl: `https://chromewebstore.google.com/detail/${fixture.storeId}`,
    storeIdentity: {
      namespace: "chrome-web-store",
      storeId: fixture.storeId,
      listingUrl: `https://chromewebstore.google.com/detail/${fixture.storeId}`,
    },
    provenance: {
      schemaVersion: 1,
      artifact: {
        providerId: "chrome-web-store",
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: "2026-08-26T00:00:01.000Z",
        format: "crx3",
        size: fixture.bytes.byteLength,
        sha256,
        retained: true,
      },
      verification: {
        level: "cws-publisher-verified",
        verifiedAt: "2026-08-26T00:00:02.000Z",
        proofDerivedStoreId: fixture.storeId,
        developerKeySha256: fixture.developerSpkiSha256,
        publisherKeySha256: fixture.publisherSpkiSha256,
        publisherTrustRootId: "cbpanel-test-only-cws",
        publisherTrustRootVersion: 0,
        manifestSha256,
        treeSha256,
      },
    },
    artifactArchivePath: artifactPath,
    updateProviderId: "chrome-web-store",
    updateState: { status: "idle" },
    version: manifest.version,
    manifestVersion: 3,
    permissions: ["storage"],
    hostPermissions: [],
    optionalPermissions: [],
    optionalHostPermissions: [],
    permissionRisks: [],
    installState: "installed",
    updatePolicy: "auto",
    sha256,
    manifestSha256,
    localPath: extensionRoot,
    manifestKey: fixture.developerSpkiBase64,
  });
  const backupPath = path.join(sourceDirectory, "portable.cbpb");
  await makeService(sourceDirectory, sourceRepository, new Set(), undefined, verifier.verifyFile)
    .exportToBackup({ outputPath: backupPath });
  const archive = unzipSync(await fs.readFile(backupPath));
  const serialized = JSON.parse(Buffer.from(archive["data.json"]).toString("utf8"));
  assert.equal(serialized.schemaVersion, 2);
  assert.equal(serialized.extensions[0].artifactArchivePath, `extension-artifacts/${extensionId}/current.crx`);
  assert.equal(serialized.extensions[0].localPath, undefined);
  assert.equal(JSON.stringify(serialized.extensions[0]).includes(sourceDirectory), false);
  sourceRepository.close();

  const targetDirectory = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDirectory, seed: () => [] });
  await makeService(targetDirectory, targetRepository, new Set(), undefined, verifier.verifyFile)
    .restoreFromBackup({ inputPath: backupPath });
  const restored = await targetRepository.getExtension(extensionId);
  assert.equal(restored?.artifactArchivePath, path.join(targetDirectory, "extension-artifacts", extensionId, "current.crx"));
  assert.equal(restored?.sourceUrl, restored?.artifactArchivePath);
  assert.equal(restored?.localPath, path.join(targetDirectory, "extensions", extensionId));
  assert.equal(restored?.provenance?.verification.developerKeySha256, fixture.developerSpkiSha256);
  assert.equal(JSON.stringify(restored).includes(sourceDirectory), false);
  targetRepository.close();
});

test("schema-v1 backup restores legacy remote rows only through inert retirement provenance", async () => {
  const sourceDirectory = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDirectory, seed: () => [] });
  const extensionRoot = await writeExtensionDirectory(sourceDirectory, "legacy-v1-extension");
  const extension = await sourceRepository.createExtension({
    id: "legacy-v1-extension",
    name: "Legacy V1 Extension",
    sourceKind: "local-directory",
    sourceUrl: extensionRoot,
    localPath: extensionRoot,
    installState: "installed",
    updatePolicy: "auto",
    manifestKey: "legacy-browser-key",
  });
  const backupPath = path.join(sourceDirectory, "legacy-v1.cbpb");
  await makeService(sourceDirectory, sourceRepository).exportToBackup({ outputPath: backupPath });

  const entries = unzipSync(await fs.readFile(backupPath));
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  const data = JSON.parse(Buffer.from(entries["data.json"]).toString("utf8"));
  manifest.schemaVersion = 1;
  manifest.counts.extensionSources = 1;
  delete manifest.counts.retainedExtensionArtifacts;
  data.schemaVersion = 1;
  data.extensionSources = [{
    id: "legacy-source",
    name: "Legacy source",
    url: "https://legacy.example/index.json",
    status: "enabled",
    allowUnsignedAssets: false,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  }];
  delete data.retainedExtensionArtifacts;
  Object.assign(data.extensions[0], {
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/extension.zip",
    sourceId: "legacy-source",
    updatePolicy: "auto",
    installState: "installed",
  });
  entries["manifest.json"] = Buffer.from(JSON.stringify(manifest));
  entries["data.json"] = Buffer.from(JSON.stringify(data));
  await fs.writeFile(backupPath, zipSync(entries));
  sourceRepository.close();

  const targetDirectory = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDirectory, seed: () => [] });
  await makeService(targetDirectory, targetRepository).restoreFromBackup({ inputPath: backupPath });
  const restored = await targetRepository.getExtension(extension.id);

  assert.equal(restored?.id, extension.id);
  assert.equal(restored?.sourceKind, "managed-snapshot");
  assert.equal(restored?.sourceUrl, "");
  assert.equal(restored?.sourceId, undefined);
  assert.equal(restored?.updateProviderId, undefined);
  assert.equal(restored?.updatePolicy, "pinned");
  assert.equal(restored?.localPath, path.join(targetDirectory, "extensions", extension.id));
  assert.equal(restored?.manifestKey, "legacy-browser-key");
  assert.equal(restored?.provenance?.verification.level, "legacy-unknown");
  assert.equal(restored?.provenance?.artifact.legacySourceUrl, "https://legacy.example/extension.zip");
  targetRepository.close();
});

test("app backup export and restore replaces app data, browser data, and extension files", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);
  const profile = await repository.createProfile({
    name: "Backup Env",
    group: "Backup Group",
    tags: ["backup"],
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "local.example.test",
      port: "8800",
    },
  });
  const proxy = await repository.createProxy({
    name: "Library Proxy",
    scheme: "http",
    host: "proxy.example.test",
    port: "8080",
    username: "user",
    password: "secret",
  });
  await repository.updateEnvironment(profile.id, { proxyId: proxy.id });
  const extensionDir = await writeExtensionDirectory(directory, "source-extension");
  const extension = await repository.createExtension({
    name: "Backup Extension",
    sourceKind: "local-directory",
    sourceUrl: extensionDir,
    version: "1.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: extensionDir,
    sha256: "b".repeat(64),
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const lifecycleRevision = (await repository.listEnvironmentExtensionBindings(profile.id))[0]?.lifecycleRevision;
  assert.ok(lifecycleRevision);
  await fs.mkdir(path.join(directory, "browser-data", profile.id), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", profile.id, "Cookies"), "cookie-db", "utf8");
  await fs.mkdir(path.join(directory, "extension-runtimes", profile.id, extension.id), { recursive: true });
  await fs.writeFile(path.join(directory, "extension-runtimes", profile.id, extension.id, "sentinel"), "derived", "utf8");
  const backupPath = path.join(directory, "backup.cbpb");

  const exported = await service.exportToBackup({ outputPath: backupPath });
  assert.equal(exported.counts.environments, 1);
  assert.equal(exported.counts.browserData, 1);
  assert.equal(exported.counts.runtimeExtensions, 1);
  const exportedEntries = unzipSync(await fs.readFile(backupPath));
  assert.equal(Object.keys(exportedEntries).some((entry) => entry.startsWith("extension-runtimes/")), false);
  const exportedData = JSON.parse(Buffer.from(exportedEntries["data.json"]).toString("utf8")) as {
    extensions: Array<{ sourceKind?: string; sourceUrl?: string; localPath?: string; directoryMode?: string }>;
  };
  assert.equal(exportedData.extensions[0]?.sourceKind, "managed-snapshot");
  assert.equal(exportedData.extensions[0]?.sourceUrl, "");
  assert.equal(exportedData.extensions[0]?.localPath, undefined);
  assert.equal(exportedData.extensions[0]?.directoryMode, undefined);

  await repository.createProfile({ name: "Will Be Removed" });
  await fs.rm(path.join(directory, "browser-data", profile.id), { recursive: true, force: true });
  await fs.rm(extensionDir, { recursive: true, force: true });
  await fs.mkdir(path.join(directory, "browser-data", "junk"), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", "junk", "file"), "junk", "utf8");
  await fs.mkdir(path.join(directory, "extension-runtimes", "stale-environment", "stale-extension"), { recursive: true });

  const restored = await service.restoreFromBackup({ inputPath: backupPath });

  assert.equal(restored.counts.environments, 1);
  assert.equal(await fileExists(path.join(directory, "browser-data", profile.id, "Cookies")), true);
  assert.equal(await fileExists(path.join(directory, "browser-data", "junk", "file")), false);
  assert.equal(await fileExists(path.join(directory, "extensions", extension.id, "manifest.json")), true);
  const restoredProfiles = await repository.listProfiles();
  const restoredEnvironment = await repository.getEnvironment(profile.id);
  const restoredProfile = await repository.getProfile(profile.id);
  const restoredProxy = (await repository.listProxies({ includeSecrets: true })).find((item) => item.id === proxy.id);
  const restoredExtension = (await repository.listExtensions()).find((item) => item.id === extension.id);
  assert.deepEqual(restoredProfiles.map((item) => item.name), ["Backup Env"]);
  assert.equal(restoredEnvironment?.proxyId, proxy.id);
  assert.equal(restoredProxy?.password, "secret");
  assert.equal(restoredExtension?.localPath, path.join(directory, "extensions", extension.id));
  assert.equal(restoredExtension?.sourceKind, "managed-snapshot");
  assert.equal(restoredExtension?.sourceUrl, "");
  assert.equal(restoredExtension?.directoryMode, undefined);
  assert.deepEqual(restoredEnvironment?.runtimeProfile.runtime.extensionPaths, [path.join(directory, "extensions", extension.id)]);
  assert.deepEqual(restoredProfile?.runtime.extensionPaths, [path.join(directory, "extensions", extension.id)]);
  assert.equal(
    (await repository.listEnvironmentExtensionBindings(profile.id))[0]?.lifecycleRevision,
    lifecycleRevision,
  );
  assert.equal(await fileExists(path.join(directory, "extension-runtimes", "stale-environment")), false);

  repository.close();
});

test("app backup restore warns that a reference-mode extension is re-homed into the cache", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);
  const profile = await repository.createProfile({ name: "Reference Env" });
  const extensionDir = path.join(directory, "dev-extension");
  await fs.mkdir(extensionDir, { recursive: true });
  await fs.writeFile(
    path.join(extensionDir, "manifest.json"),
    `${JSON.stringify({ manifest_version: 3, name: "Dev Extension", version: "1.0.0" }, null, 2)}\n`,
    "utf8",
  );
  const extension = await repository.createExtension({
    name: "Dev Extension",
    sourceKind: "local-directory",
    sourceUrl: extensionDir,
    localPath: extensionDir,
    directoryMode: "reference",
    installState: "installed",
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const backupPath = path.join(directory, "reference.cbpb");
  await service.exportToBackup({ outputPath: backupPath });

  const restored = await service.restoreFromBackup({ inputPath: backupPath });
  const restoredExtension = (await repository.listExtensions()).find((item) => item.id === extension.id);

  assert.equal(restoredExtension?.sourceKind, "managed-snapshot");
  assert.equal(restoredExtension?.sourceUrl, "");
  assert.equal(restoredExtension?.directoryMode, undefined);
  assert.equal(restoredExtension?.localPath, path.join(directory, "extensions", extension.id));
  assert.equal(restored.warnings.some((warning) => warning.includes("Dev Extension")), true);
  const extensionService = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    browserDataDir: path.join(directory, "browser-data"),
  });
  const ensured = await extensionService.ensureExtensionsInstalled(profile.id);
  assert.deepEqual(ensured.paths, [path.join(directory, "extensions", extension.id)]);
  assert.match(ensured.warnings[0]?.reason ?? "", /固定插件身份/);

  repository.close();
});

test("app backup restore publishes replaced settings to in-flight acquisition gates", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await repository.saveSettings({
    extensionAcquisition: {
      crxsosoSearchEnabled: false,
      googleArtifactEnabled: true,
      crxsosoArtifactEnabled: true,
      crxsosoDisclosureVersionAccepted: 0,
    },
  });
  const backupPath = path.join(directory, "disabled-search.cbpb");
  await makeService(directory, repository).exportToBackup({ outputPath: backupPath });
  await repository.saveSettings({
    extensionAcquisition: {
      crxsosoSearchEnabled: true,
      googleArtifactEnabled: true,
      crxsosoArtifactEnabled: true,
      crxsosoDisclosureVersionAccepted: 1,
    },
  });
  let notifySearchStarted: (() => void) | undefined;
  const searchStarted = new Promise<void>((resolve) => {
    notifySearchStarted = resolve;
  });
  const catalogProvider: CatalogSearchProvider = {
    id: "crxsoso",
    search: async (_input, signal): Promise<CatalogSearchPage> => {
      notifySearchStarted?.();
      return await new Promise<CatalogSearchPage>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const providerRegistry: Pick<ExtensionProviderRegistry, "catalog" | "artifactOffers"> = {
    catalog: () => catalogProvider,
    artifactOffers: () => [],
  };
  const acquisition = new ExtensionAcquisitionService({
    readSettings: () => repository.getSettings(),
    providerRegistry,
  });
  const notifications: boolean[] = [];
  const restore = makeService(directory, repository, new Set(), (settings) => {
    notifications.push(settings.extensionAcquisition.crxsosoSearchEnabled);
    acquisition.settingsChanged(settings);
  });

  const searchRejected = assert.rejects(
    acquisition.search({ query: "tampermonkey" }),
    (error: unknown) => (error as { code?: string }).code === "CATALOG_PROVIDER_DISABLED",
  );
  await searchStarted;

  await restore.restoreFromBackup({ inputPath: backupPath });
  await searchRejected;

  assert.deepEqual(notifications, [false]);
  assert.equal((await repository.getSettings()).extensionAcquisition.crxsosoSearchEnabled, false);
  repository.close();
});

test("app backup export blocks active environments", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Running Backup Env" });
  const service = makeService(directory, repository, new Set([profile.id]));

  await assert.rejects(
    service.exportToBackup({ outputPath: path.join(directory, "blocked.cbpb") }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /running environments/i);
      return true;
    },
  );

  repository.close();
});

test("app backup restore rejects unsafe archive paths", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);
  const backupPath = path.join(directory, "unsafe.cbpb");
  await fs.writeFile(backupPath, zipSync({
    "/absolute-path.txt": Buffer.from("unsafe"),
    "manifest.json": Buffer.from(JSON.stringify({
      kind: APP_BACKUP_KIND,
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      containsSecrets: true,
      containsBrowserData: false,
      containsExtensions: false,
      counts: {
        profiles: 0,
        environments: 0,
        trashEnvironments: 0,
        browserData: 0,
        groups: 0,
        tags: 0,
        proxies: 0,
        extensions: 0,
        extensionSources: 0,
        runtimeExtensions: 0,
      },
    })),
    "data.json": Buffer.from(JSON.stringify({
      schemaVersion: 1,
      settings: {},
      profiles: [],
      environments: [],
      groups: [],
      tags: [],
      proxies: [],
      extensions: [],
      extensionSources: [],
    })),
  }));

  await assert.rejects(
    service.restoreFromBackup({ inputPath: backupPath }),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /unsafe path/);
      return true;
    },
  );

  repository.close();
});

test("app backup restore rechecks runtime holds immediately before publishing restored files", async (context) => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Restore Publication Race" });
  await fs.mkdir(path.join(directory, "browser-data", profile.id), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", profile.id, "sentinel"), "backup", "utf8");
  const backupPath = path.join(directory, "race.cbpb");
  await makeService(directory, repository).exportToBackup({ outputPath: backupPath });
  await fs.writeFile(path.join(directory, "browser-data", profile.id, "sentinel"), "current", "utf8");
  let holdReads = 0;
  const restore = new AppBackupService({
    repository,
    browserDataDir: path.join(directory, "browser-data"),
    extensionCacheDir: path.join(directory, "extensions"),
    extensionRuntimeDir: path.join(directory, "extension-runtimes"),
    activeEnvironmentIds: () => (++holdReads >= 2 ? new Set([profile.id]) : new Set()),
  });
  let databaseRestoreCalls = 0;
  context.mock.method(repository, "restoreFullBackupData", async () => {
    databaseRestoreCalls += 1;
  });

  await assert.rejects(
    restore.restoreFromBackup({ inputPath: backupPath }),
    (error) => (error as { status?: number }).status === 409,
  );
  assert.equal(databaseRestoreCalls, 0);
  assert.equal(await fs.readFile(path.join(directory, "browser-data", profile.id, "sentinel"), "utf8"), "current");
  repository.close();
});

// What the browser-data prune has to be able to see. restoreFilesystem replaces `browser-data` while the
// rows still describe the old data, so a prune running in that window finds every restored directory
// unaccounted for and deletes it. The window opens before the first await, which is why the assertion sits
// immediately after startRestore returns — the restore itself is allowed to fail on the missing archive,
// because what is pinned is when the predicate answers yes and when it stops.
test("a restore is in flight from the moment it starts until it settles, which is what the prune guard reads", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);

  assert.equal(service.hasRestoreInFlight(), false);
  assert.equal(service.hasOperationInFlight(), false);
  const restore = service.startRestore({ inputPath: path.join(directory, "missing.cbpb") });
  assert.equal(service.hasRestoreInFlight(), true);
  assert.equal(service.hasOperationInFlight(), true);

  await settleOperation(service, restore.id);

  assert.equal(service.getOperation(restore.id)?.status, "failed");
  assert.equal(service.hasRestoreInFlight(), false);
  assert.equal(service.hasOperationInFlight(), false);

  // An export is not reported: it only reads, and only the directories registered environments name, which
  // a prune never treats as candidates. Blocking on it would refuse a cleanup for no reason.
  const exported = service.startExport({ outputPath: path.join(directory, "in-flight.cbpb") });
  assert.equal(service.hasRestoreInFlight(), false);
  assert.equal(service.hasOperationInFlight(), true);
  await settleOperation(service, exported.id);
  assert.equal(service.hasOperationInFlight(), false);

  repository.close();
});

async function writeExtensionDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, "extensions", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({
      manifest_version: 3,
      name: "Backup Extension",
      version: "1.0.0",
      permissions: ["storage"],
    }, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function makeService(
  directory: string,
  repository: SqlitePanelRepository,
  activeIds = new Set<string>(),
  settingsChanged?: ConstructorParameters<typeof AppBackupService>[0]["settingsChanged"],
  verifyStoreCrxFileForTesting?: ReturnType<typeof createCrx3VerifierForTesting>["verifyFile"],
): AppBackupService {
  return new AppBackupService({
    repository,
    browserDataDir: path.join(directory, "browser-data"),
    extensionCacheDir: path.join(directory, "extensions"),
    extensionRuntimeDir: path.join(directory, "extension-runtimes"),
    extensionArtifactDir: path.join(directory, "extension-artifacts"),
    activeEnvironmentIds: () => activeIds,
    settingsChanged,
    verifyStoreCrxFileForTesting,
  });
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-backup-"));
}

/** startExport / startRestore hand back a queued operation and run it detached, so waiting is the test's job. */
async function settleOperation(service: AppBackupService, id: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = service.getOperation(id)?.status;
    if (status === "succeeded" || status === "failed") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`App backup operation ${id} did not settle.`);
}

async function fileExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}
