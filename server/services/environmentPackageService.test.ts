import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync, unzipSync } from "fflate";
import { ENVIRONMENT_PACKAGE_KIND } from "../../src/shared/environmentPackage";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { createSyntheticStoreCrx3 } from "../testing/crx3Fixture";
import { createCrx3VerifierForTesting } from "./crx3Verifier";
import { fingerprintManifest } from "./extensionPackagePreflight";
import { fingerprintStagedExtensionTree } from "./boundedZipAnalyzer";
import { ExtensionService } from "./extensionService";
import { EnvironmentPackageService } from "./environmentPackageService";

test("environment package export includes dependency closure and materializes proxy references", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Exported Env", group: "Export Group", tags: ["portable"] });
  const proxy = await repository.createProxy({
    name: "Managed Proxy",
    scheme: "http",
    host: "proxy.example.test",
    port: "8080",
    username: "user",
    password: "secret",
  });
  await repository.updateEnvironment(profile.id, { proxyId: proxy.id });
  const fixture = createSyntheticStoreCrx3({
    name: "Portable Extension",
    version: "1.2.3",
    permissions: ["storage"],
    hostPermissions: [],
  });
  const verifier = createCrx3VerifierForTesting(fixture.publisherSpkiSha256);
  const service = makeService(directory, repository, new Set(), verifier.verifyFile);
  const fixtureManifest = {
    manifest_version: 3,
    name: "Portable Extension",
    version: "1.2.3",
    permissions: ["storage"],
    host_permissions: [],
    background: { service_worker: "worker.js" },
  };
  const extensionDir = await writeExtensionDirectory(directory, "source-extension", {
    ...fixtureManifest,
    key: fixture.developerSpkiBase64,
  });
  await fs.writeFile(path.join(extensionDir, "worker.js"), "chrome.runtime.onInstalled.addListener(() => undefined);", "utf8");
  const treeSha256 = (await fingerprintStagedExtensionTree(extensionDir)).sha256;
  const artifactPath = path.join(directory, "extension-artifacts", "portable-store-extension", "current.crx");
  await fs.mkdir(path.dirname(artifactPath), { recursive: true });
  await fs.writeFile(artifactPath, fixture.bytes);
  const extension = await repository.createExtension({
    id: "portable-store-extension",
    name: "Portable Extension",
    version: "1.2.3",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: extensionDir,
    ...verifiedAuthority(directory, "portable-store-extension", fixture, fingerprintManifest(fixtureManifest), treeSha256),
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  await fs.mkdir(path.join(directory, "browser-data", profile.id), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", profile.id, "Cookies"), "cookie-db", "utf8");
  await fs.mkdir(path.join(directory, "extension-runtimes", profile.id, extension.id), { recursive: true });
  await fs.writeFile(path.join(directory, "extension-runtimes", profile.id, extension.id, "sentinel"), "derived", "utf8");
  const outputPath = path.join(directory, "export.cbpe");

  const result = await service.exportToPackage({ outputPath });

  assert.equal(result.counts.environments, 1);
  assert.equal(result.counts.browserData, 1);
  assert.equal(result.counts.groups, 1);
  assert.equal(result.counts.extensions, 1);
  const entries = unzipSync(await fs.readFile(outputPath));
  const manifest = JSON.parse(Buffer.from(entries["manifest.json"]).toString("utf8"));
  const data = JSON.parse(Buffer.from(entries["data.json"]).toString("utf8"));
  assert.equal(manifest.kind, ENVIRONMENT_PACKAGE_KIND);
  assert.ok(entries[`browser-data/${profile.id}/Cookies`]);
  assert.ok(entries[`extensions/${extension.id}/manifest.json`]);
  assert.equal(Object.keys(entries).some((entry) => entry.startsWith("extension-runtimes/")), false);
  assert.equal(data.environments[0].proxyId, undefined);
  assert.equal(data.environments[0].runtimeProfile.proxy.password, "secret");
  assert.equal(data.environments[0].runtimeProfile.proxy.raw, "http://user:secret@proxy.example.test:8080");
  assert.deepEqual(data.environments[0].runtimeProfile.runtime.extensionPaths, []);
  assert.equal(data.schemaVersion, 2);
  assert.equal(data.extensions[0].storeIdentity.storeId, fixture.storeId);
  assert.equal(data.extensions[0].artifactArchivePath, `extension-artifacts/${extension.id}/current.crx`);
  assert.equal(data.extensions[0].sourceUrl, `extension-artifacts/${extension.id}/current.crx`);
  assert.equal(data.extensions[0].localPath, undefined);
  assert.equal(data.retainedExtensionArtifacts[0].extensionId, extension.id);
  assert.ok(entries[`extension-artifacts/${extension.id}/current.crx`]);
  assert.equal(JSON.stringify(data.extensions[0]).includes(directory), false);

  const importedDirectory = await makeTempDir();
  const importedRepository = new SqlitePanelRepository({ dataDir: importedDirectory, seed: () => [] });
  const importedService = makeService(importedDirectory, importedRepository, new Set(), verifier.verifyFile);
  const imported = await importedService.importFromPackage({ inputPath: outputPath });
  const importedExtensionId = imported.idMap?.extensions[extension.id];
  assert.ok(importedExtensionId);
  const importedExtension = await importedRepository.getExtension(importedExtensionId);
  assert.equal(importedExtension?.artifactArchivePath, path.join(importedDirectory, "extension-artifacts", importedExtensionId, "current.crx"));
  assert.equal(importedExtension?.sourceUrl, importedExtension?.artifactArchivePath);
  assert.equal(importedExtension?.provenance?.verification.developerKeySha256, fixture.developerSpkiSha256);
  assert.equal(JSON.stringify(importedExtension).includes(directory), false);
  importedRepository.close();

  repository.close();
});

test("environment package export blocks active environments", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Running Env" });
  const service = makeService(directory, repository, new Set([profile.id]));

  await assert.rejects(
    service.exportToPackage({ outputPath: path.join(directory, "blocked.cbpe") }),
    (error) => {
      assert.equal((error as { status?: number }).status, 409);
      assert.match((error as Error).message, /Running Env/);
      return true;
    },
  );

  repository.close();
});

test("environment package import creates new environments and restores browser data and extensions", async () => {
  const sourceDir = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDir, seed: () => [] });
  const sourceService = makeService(sourceDir, sourceRepository);
  const sourceProfile = await sourceRepository.createProfile({
    name: "Portable Account",
    group: "Accounts",
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "local-proxy.example.test",
      port: "9000",
      username: "local",
      password: "secret",
    },
  });
  const sourceExtensionDir = await writeExtensionDirectory(sourceDir, "extension");
  const extension = await sourceRepository.createExtension({
    name: "Synced Extension",
    sourceKind: "local-directory",
    sourceUrl: sourceExtensionDir,
    version: "3.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: sourceExtensionDir,
    sha256: sha256Hex(Buffer.from("same-extension")),
  });
  await sourceRepository.bindExtensionToEnvironments(extension.id, [sourceProfile.id]);
  const sourceLifecycleRevision = (await sourceRepository.listEnvironmentExtensionBindings(sourceProfile.id))[0]?.lifecycleRevision;
  assert.ok(sourceLifecycleRevision);
  await fs.mkdir(path.join(sourceDir, "browser-data", sourceProfile.id), { recursive: true });
  await fs.writeFile(path.join(sourceDir, "browser-data", sourceProfile.id, "Preferences"), "prefs", "utf8");
  const packagePath = path.join(sourceDir, "portable.cbpe");
  await sourceService.exportToPackage({ outputPath: packagePath });
  const legacyEntries = unzipSync(await fs.readFile(packagePath));
  const legacyManifest = JSON.parse(Buffer.from(legacyEntries["manifest.json"]).toString("utf8"));
  const legacyData = JSON.parse(Buffer.from(legacyEntries["data.json"]).toString("utf8"));
  legacyManifest.schemaVersion = 1;
  delete legacyManifest.counts.retainedExtensionArtifacts;
  legacyData.schemaVersion = 1;
  delete legacyData.retainedExtensionArtifacts;
  Object.assign(legacyData.extensions[0], {
    storeIdentity: { namespace: "attacker", storeId: "forged", listingUrl: "https://evil.test" },
    provenance: { schemaVersion: 99, verification: { level: "cws-publisher-verified" } },
    artifactArchivePath: "C:/exporting-machine/forged.crx",
    updateProviderId: "attacker",
    updateState: { status: "available", availableVersion: "999" },
  });
  legacyEntries["data.json"] = Buffer.from(JSON.stringify(legacyData));
  legacyEntries["manifest.json"] = Buffer.from(JSON.stringify(legacyManifest));
  await fs.writeFile(packagePath, zipSync(legacyEntries));
  sourceRepository.close();

  const targetDir = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDir, seed: () => [] });
  await targetRepository.createGroup({ name: "Accounts", color: "#123456" });
  const targetService = makeService(targetDir, targetRepository);

  const result = await targetService.importFromPackage({ inputPath: packagePath });
  const newEnvironmentId = result.idMap?.environments[sourceProfile.id];
  const newExtensionId = result.idMap?.extensions[extension.id];
  assert.ok(newEnvironmentId);
  assert.ok(newExtensionId);
  assert.notEqual(newEnvironmentId, sourceProfile.id);
  assert.notEqual(newExtensionId, extension.id);
  assert.equal(await fileExists(path.join(targetDir, "browser-data", newEnvironmentId, "Preferences")), true);
  assert.equal(await fileExists(path.join(targetDir, "extensions", newExtensionId, "manifest.json")), true);

  const imported = await targetRepository.getEnvironment(newEnvironmentId);
  const importedProfile = await targetRepository.getProfile(newEnvironmentId);
  const groups = await targetRepository.listGroups();
  const proxies = await targetRepository.listProxies({ includeSecrets: true });
  assert.equal(imported?.proxyId, undefined);
  assert.equal(importedProfile?.proxy.host, "local-proxy.example.test");
  assert.equal(importedProfile?.proxy.password, "secret");
  assert.equal(groups.filter((group) => group.name === "Accounts").length, 1);
  assert.equal(proxies.length, 0);
  assert.deepEqual(importedProfile?.runtime.extensionPaths, [path.join(targetDir, "extensions", newExtensionId)]);
  const importedExtension = await targetRepository.getExtension(newExtensionId);
  assert.equal(importedExtension?.storeIdentity, undefined);
  assert.equal(importedExtension?.provenance, undefined);
  assert.equal(importedExtension?.artifactArchivePath, undefined);
  assert.equal(importedExtension?.updateProviderId, undefined);
  assert.equal(importedExtension?.updateState, undefined);
  assert.equal(
    (await targetRepository.listEnvironmentExtensionBindings(newEnvironmentId))[0]?.lifecycleRevision,
    sourceLifecycleRevision,
  );
  const extensionService = new ExtensionService({
    repository: targetRepository,
    extensionCacheDir: path.join(targetDir, "extensions"),
    browserDataDir: path.join(targetDir, "browser-data"),
  });
  const ensured = await extensionService.ensureExtensionsInstalled(newEnvironmentId);
  assert.deepEqual(ensured.paths, [path.join(targetDir, "extensions", newExtensionId)]);
  assert.match(ensured.warnings[0]?.reason ?? "", /固定插件身份/);

  targetRepository.close();
});

test("environment package import reuses only a package with matching pinned on-disk identity", async () => {
  const sourceDir = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDir, seed: () => [] });
  const sourceService = makeService(sourceDir, sourceRepository);
  const sourceProfile = await sourceRepository.createProfile({ name: "Source Env", group: "Extensions" });
  const extensionHash = sha256Hex(Buffer.from("reusable-extension"));
  const portableKey = "portable-manifest-key";
  const sourceExtensionDir = await writeExtensionDirectory(sourceDir, "source-extension", { key: portableKey });
  const extension = await sourceRepository.createExtension({
    name: "Reusable Extension",
    sourceKind: "local-directory",
    sourceUrl: sourceExtensionDir,
    version: "5.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: sourceExtensionDir,
    sha256: extensionHash,
    manifestKey: portableKey,
  });
  await sourceRepository.bindExtensionToEnvironments(extension.id, [sourceProfile.id]);
  await fs.mkdir(path.join(sourceDir, "browser-data", sourceProfile.id), { recursive: true });
  await fs.writeFile(path.join(sourceDir, "browser-data", sourceProfile.id, "Preferences"), "state", "utf8");
  const packagePath = path.join(sourceDir, "reusable.cbpe");
  await sourceService.exportToPackage({ outputPath: packagePath });
  sourceRepository.close();

  const targetDir = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDir, seed: () => [] });
  const existingExtensionDir = await writeExtensionDirectory(targetDir, "existing-extension", { key: portableKey });
  const existingExtension = await targetRepository.createExtension({
    name: "Reusable Extension",
    sourceKind: "local-directory",
    sourceUrl: existingExtensionDir,
    version: "5.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: existingExtensionDir,
    sha256: extensionHash,
  });
  const targetService = makeService(targetDir, targetRepository);

  const result = await targetService.importFromPackage({ inputPath: packagePath });
  const importedEnvironmentId = result.idMap?.environments[sourceProfile.id];
  assert.equal(result.idMap?.extensions[extension.id], existingExtension.id);
  assert.ok(importedEnvironmentId);
  assert.equal(await fileExists(path.join(targetDir, "extensions", existingExtension.id, "manifest.json")), false);

  const importedProfile = await targetRepository.getProfile(importedEnvironmentId);
  assert.deepEqual(importedProfile?.runtime.extensionPaths, [existingExtensionDir]);
  const importedRevision = (await targetRepository.listEnvironmentExtensionBindings(importedEnvironmentId))[0]?.lifecycleRevision;
  assert.match(importedRevision ?? "", /^preserve:binding-/);
  assert.equal((await targetRepository.getExtension(existingExtension.id))?.manifestKey, portableKey);

  targetRepository.close();
});

test("environment package import does not claim portable reuse for matching keyless packages", async () => {
  const sourceDir = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDir, seed: () => [] });
  const sourceProfile = await sourceRepository.createProfile({ name: "Keyless Source" });
  const packageHash = sha256Hex(Buffer.from("same-keyless-package"));
  const sourceExtensionDir = await writeExtensionDirectory(sourceDir, "keyless-source");
  const sourceExtension = await sourceRepository.createExtension({
    name: "Keyless Extension",
    sourceKind: "local-directory",
    sourceUrl: sourceExtensionDir,
    localPath: sourceExtensionDir,
    installState: "installed",
    sha256: packageHash,
  });
  await sourceRepository.bindExtensionToEnvironments(sourceExtension.id, [sourceProfile.id]);
  const packagePath = path.join(sourceDir, "keyless.cbpe");
  await makeService(sourceDir, sourceRepository).exportToPackage({ outputPath: packagePath });
  sourceRepository.close();

  const targetDir = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDir, seed: () => [] });
  const localPath = await writeExtensionDirectory(targetDir, "keyless-local");
  const localExtension = await targetRepository.createExtension({
    name: "Keyless Extension",
    sourceKind: "local-directory",
    sourceUrl: localPath,
    localPath,
    installState: "installed",
    sha256: packageHash,
  });

  const imported = await makeService(targetDir, targetRepository).importFromPackage({ inputPath: packagePath });
  const importedExtensionId = imported.idMap?.extensions[sourceExtension.id];

  assert.ok(importedExtensionId);
  assert.notEqual(importedExtensionId, localExtension.id);
  assert.equal(imported.warnings.some((warning) => /no pinned portable identity/.test(warning)), true);
  assert.equal(await fileExists(path.join(targetDir, "extensions", importedExtensionId, "manifest.json")), true);
  targetRepository.close();
});

test("environment package import does not reuse a local extension pinned to a different key", async () => {
  const sourceDir = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDir, seed: () => [] });
  const sourceService = makeService(sourceDir, sourceRepository);
  const sourceProfile = await sourceRepository.createProfile({ name: "Keyed Env", group: "Extensions" });
  const extensionHash = sha256Hex(Buffer.from("same-bytes-different-identity"));
  const sourceExtensionDir = await writeExtensionDirectory(sourceDir, "packaged-extension");
  const extension = await sourceRepository.createExtension({
    name: "Keyed Extension",
    sourceKind: "local-directory",
    sourceUrl: sourceExtensionDir,
    version: "5.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: sourceExtensionDir,
    sha256: extensionHash,
    manifestKey: "packaged-key-one",
  });
  await sourceRepository.bindExtensionToEnvironments(extension.id, [sourceProfile.id]);
  const packagePath = path.join(sourceDir, "keyed.cbpe");
  await sourceService.exportToPackage({ outputPath: packagePath });
  sourceRepository.close();

  const targetDir = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDir, seed: () => [] });
  const existingExtensionDir = await writeExtensionDirectory(targetDir, "existing-extension");
  const existingExtension = await targetRepository.createExtension({
    name: "Keyed Extension",
    sourceKind: "local-directory",
    sourceUrl: existingExtensionDir,
    version: "5.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: existingExtensionDir,
    sha256: extensionHash,
    manifestKey: "local-key-two",
  });
  const targetService = makeService(targetDir, targetRepository);

  const result = await targetService.importFromPackage({ inputPath: packagePath });
  const importedExtensionId = result.idMap?.extensions[extension.id];

  assert.ok(importedExtensionId);
  assert.notEqual(importedExtensionId, existingExtension.id);
  const imported = (await targetRepository.listExtensions()).find((item) => item.id === importedExtensionId);
  assert.equal(imported?.manifestKey, "packaged-key-one");
  assert.equal(await fileExists(path.join(targetDir, "extensions", importedExtensionId, "manifest.json")), true);
  assert.equal((await targetRepository.getExtension(existingExtension.id))?.manifestKey, "local-key-two");

  targetRepository.close();
});

test("environment package import rolls back copied files when metadata names an unbound pair without a revision", async () => {
  const sourceDir = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDir, seed: () => [] });
  const environment = await sourceRepository.createEnvironment({ name: "Invalid Binding Package" });
  const extensionPath = await writeExtensionDirectory(sourceDir, "invalid-binding-extension");
  const extension = await sourceRepository.createExtension({
    name: "Invalid Binding Extension",
    sourceKind: "local-directory",
    sourceUrl: extensionPath,
    localPath: extensionPath,
    installState: "installed",
  });
  await sourceRepository.bindExtensionToEnvironments(extension.id, [environment.id]);
  await fs.mkdir(path.join(sourceDir, "browser-data", environment.id), { recursive: true });
  await fs.writeFile(path.join(sourceDir, "browser-data", environment.id, "sentinel"), "browser", "utf8");
  const packagePath = path.join(sourceDir, "invalid-binding.cbpe");
  await makeService(sourceDir, sourceRepository).exportToPackage({ outputPath: packagePath });
  sourceRepository.close();

  const entries = unzipSync(await fs.readFile(packagePath));
  const data = JSON.parse(Buffer.from(entries["data.json"]).toString("utf8"));
  data.environments[0].extensionIds = [];
  delete data.environmentExtensionBindings[0].lifecycleRevision;
  entries["data.json"] = Buffer.from(JSON.stringify(data));
  await fs.writeFile(packagePath, zipSync(entries));

  const targetDir = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDir, seed: () => [] });
  const targetService = makeService(targetDir, targetRepository);

  await assert.rejects(targetService.importFromPackage({ inputPath: packagePath }), /unbound entity pair/);

  assert.deepEqual(await fs.readdir(path.join(targetDir, "browser-data")).catch(() => []), []);
  assert.deepEqual(await fs.readdir(path.join(targetDir, "extensions")).catch(() => []), []);
  assert.deepEqual(await targetRepository.listEnvironments(), []);
  assert.deepEqual(await targetRepository.listExtensions(), []);
  targetRepository.close();
});

test("environment package import rejects unsafe archive paths", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);
  const packagePath = path.join(directory, "unsafe.cbpe");
  await fs.writeFile(packagePath, zipSync({
    "/absolute-path.txt": Buffer.from("unsafe"),
    "manifest.json": Buffer.from("{}"),
    "data.json": Buffer.from("{}"),
  }));

  await assert.rejects(
    service.importFromPackage({ inputPath: packagePath }),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /unsafe path/);
      return true;
    },
  );

  repository.close();
});

// What the browser-data prune has to be able to see. importFromPackage copies every `browser-data/<new id>`
// before importEnvironmentPackage writes the rows naming them, so a prune running in that window finds the
// copies unaccounted for and deletes them. The window opens before the first await, which is why the
// assertion sits immediately after startImport returns — the import itself is allowed to fail on the missing
// archive, because what is pinned is when the predicate answers yes and when it stops.
test("an import is in flight from the moment it starts until it settles, which is what the prune guard reads", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);

  assert.equal(service.hasImportInFlight(), false);
  assert.equal(service.hasOperationInFlight(), false);
  const imported = service.startImport({ inputPath: path.join(directory, "missing.cbpe") });
  assert.equal(service.hasImportInFlight(), true);
  assert.equal(service.hasOperationInFlight(), true);

  await settleOperation(service, imported.id);

  assert.equal(service.getOperation(imported.id)?.status, "failed");
  assert.equal(service.hasImportInFlight(), false);
  assert.equal(service.hasOperationInFlight(), false);

  // An export is not reported: it only reads, and only the directories registered environments name, which
  // a prune never treats as candidates. Blocking on it would refuse a cleanup for no reason.
  const exported = service.startExport({ outputPath: path.join(directory, "in-flight.cbpe") });
  assert.equal(service.hasImportInFlight(), false);
  assert.equal(service.hasOperationInFlight(), true);
  await settleOperation(service, exported.id);
  assert.equal(service.hasOperationInFlight(), false);

  repository.close();
});

async function writeExtensionDirectory(
  root: string,
  name: string,
  manifestPatch: Record<string, unknown> = {},
): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({
      manifest_version: 3,
      name: "Test Extension",
      version: "1.0.0",
      permissions: ["storage"],
      ...manifestPatch,
    }, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function verifiedAuthority(
  root: string,
  entityId: string,
  fixture: ReturnType<typeof createSyntheticStoreCrx3>,
  manifestSha256: string,
  treeSha256: string,
) {
  const storeId = fixture.storeId;
  const artifactArchivePath = path.join(root, "extension-artifacts", entityId, "current.crx");
  return {
    sourceKind: "local-crx" as const,
    sourceUrl: artifactArchivePath,
    sha256: sha256Hex(fixture.bytes),
    manifestSha256,
    manifestKey: fixture.developerSpkiBase64,
    storeIdentity: {
      namespace: "chrome-web-store" as const,
      storeId,
      listingUrl: `https://chromewebstore.google.com/detail/${storeId}`,
    },
    provenance: {
      schemaVersion: 1 as const,
      artifact: {
        providerId: "chrome-web-store" as const,
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: "2026-08-26T00:00:01.000Z",
        format: "crx3" as const,
        size: fixture.bytes.byteLength,
        sha256: sha256Hex(fixture.bytes),
        retained: true,
      },
      verification: {
        level: "cws-publisher-verified" as const,
        verifiedAt: "2026-08-26T00:00:02.000Z",
        proofDerivedStoreId: storeId,
        developerKeySha256: fixture.developerSpkiSha256,
        publisherKeySha256: fixture.publisherSpkiSha256,
        publisherTrustRootId: "cbpanel-test-only-cws",
        publisherTrustRootVersion: 0,
        manifestSha256,
        treeSha256,
      },
    },
    artifactArchivePath,
    updateProviderId: "chrome-web-store" as const,
    updateState: { status: "idle" as const, checkedAt: "2026-08-26T00:00:03.000Z" },
  };
}

function makeService(
  directory: string,
  repository: SqlitePanelRepository,
  activeIds = new Set<string>(),
  verifyStoreCrxFileForTesting?: ReturnType<typeof createCrx3VerifierForTesting>["verifyFile"],
): EnvironmentPackageService {
  return new EnvironmentPackageService({
    repository,
    browserDataDir: path.join(directory, "browser-data"),
    extensionCacheDir: path.join(directory, "extensions"),
    extensionArtifactDir: path.join(directory, "extension-artifacts"),
    verifyStoreCrxFileForTesting,
    activeEnvironmentIds: () => activeIds,
  });
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-package-"));
}

/** startExport / startImport hand back a queued operation and run it detached, so waiting is the test's job. */
async function settleOperation(service: EnvironmentPackageService, id: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const status = service.getOperation(id)?.status;
    if (status === "succeeded" || status === "failed") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Environment package operation ${id} did not settle.`);
}

async function fileExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
