import assert from "node:assert/strict";
import { createHash, createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { ExtensionService, extractCrxPublicKey } from "./extensionService";

const PRESET_MANIFEST_KEY = "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAcbpanelTestManifestKey";

const UTF8_BOM = String.fromCharCode(0xfeff);

test("local directory import reads manifest and permission risks", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "local-extension", {
    permissions: ["storage", "cookies"],
    host_permissions: ["<all_urls>"],
  });

  const extension = await service.importDirectory(extensionDir, "reference");

  assert.equal(extension.name, "Test Extension");
  assert.equal(extension.version, "1.2.3");
  assert.equal(extension.manifestVersion, 3);
  assert.equal(extension.installState, "installed");
  assert.equal(extension.localPath, extensionDir);
  assert.deepEqual(extension.permissionRisks.map((risk) => risk.permission), ["cookies", "<all_urls>"]);

  repository.close();
});

test("local directory import rejects directories without a manifest", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const parentDirectory = path.join(directory, "Chrome Extensions");
  await fs.mkdir(parentDirectory, { recursive: true });

  await assert.rejects(
    service.importDirectory(parentDirectory),
    assertBadRequest(/must directly contain manifest\.json/),
  );

  repository.close();
});

test("directory preview returns a direct unpacked extension candidate", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "direct-extension", { name: "Direct Extension" });

  const preview = await service.previewDirectory(extensionDir);

  assert.equal(preview.rootPath, extensionDir);
  assert.equal(preview.direct?.name, "Direct Extension");
  assert.equal(preview.direct?.path, extensionDir);
  assert.deepEqual(preview.candidates, []);

  repository.close();
});

test("directory preview scans Chrome top-level Extensions folders", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const chromeRoot = path.join(directory, "Chrome", "User Data", "Default", "Extensions");
  const first = await writeChromeExtensionVersionDirectory(chromeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1.0.0_0", {
    name: "Alpha Extension",
    version: "1.0.0",
  });
  const second = await writeChromeExtensionVersionDirectory(chromeRoot, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2.0.0", {
    name: "Beta Extension",
    version: "2.0.0",
    permissions: ["cookies"],
  });

  const preview = await service.previewDirectory(chromeRoot);

  assert.equal(preview.rootPath, chromeRoot);
  assert.equal(preview.direct, undefined);
  assert.deepEqual(preview.candidates.map((candidate) => candidate.path), [first, second]);
  assert.deepEqual(preview.candidates.map((candidate) => candidate.extensionId), [
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  ]);
  assert.deepEqual(preview.candidates.map((candidate) => candidate.name), ["Alpha Extension", "Beta Extension"]);
  assert.deepEqual(preview.candidates[1]?.permissionRisks.map((risk) => risk.permission), ["cookies"]);

  repository.close();
});

test("selected directory import imports candidates and skips duplicate paths", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const chromeRoot = path.join(directory, "Chrome Extensions");
  const first = await writeChromeExtensionVersionDirectory(chromeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1.0.0_0", {
    name: "Alpha Extension",
    version: "1.0.0",
  });
  const second = await writeChromeExtensionVersionDirectory(chromeRoot, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2.0.0", {
    name: "Beta Extension",
    version: "2.0.0",
  });

  const result = await service.importDirectories([first, first, second], "reference");

  assert.equal(result.imported.length, 2);
  assert.equal(result.failed.length, 0);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.imported.map((extension) => extension.localPath), [first, second]);
  assert.deepEqual((await repository.listExtensions()).map((extension) => extension.name).sort(), ["Alpha Extension", "Beta Extension"]);

  repository.close();
});

test("selected directory import keeps successes when one candidate fails", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const good = await writeExtensionDirectory(directory, "good-extension", { name: "Good Extension" });
  const bad = path.join(directory, "missing-extension");

  const result = await service.importDirectories([good, bad]);

  assert.equal(result.imported.length, 1);
  assert.equal(result.imported[0]?.name, "Good Extension");
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0]?.path, bad);
  assert.match(result.failed[0]?.error ?? "", /must directly contain manifest\.json/);

  repository.close();
});

test("directory preview rejects parent directories without extension candidates", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const parentDirectory = path.join(directory, "Extensions");
  await fs.mkdir(path.join(parentDirectory, "not-an-extension", "empty"), { recursive: true });

  await assert.rejects(
    service.previewDirectory(parentDirectory),
    /directly contain manifest\.json or Chrome extension version folders/,
  );

  repository.close();
});

test("directory preview rejects empty paths instead of scanning the process directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });

  await assert.rejects(
    service.previewDirectory(" "),
    /path cannot be empty/,
  );

  repository.close();
});

test("local ZIP import unpacks into extension cache and reads manifest", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip());

  const extension = await service.importZip(zipPath);

  assert.equal(extension.installState, "installed");
  assert.ok(extension.localPath?.startsWith(path.join(directory, "extensions")));
  assert.equal(await fileExists(path.join(extension.localPath!, "manifest.json")), true);

  repository.close();
});

test("ensureExtensionsInstalled returns only valid unpacked paths", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const profile = await repository.createProfile({ name: "Extension Runtime" });
  const extensionDir = await writeExtensionDirectory(directory, "runtime-extension");
  const extension = await service.importDirectory(extensionDir, "reference");

  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const ensured = await service.ensureExtensionsInstalled(profile.id);

  assert.deepEqual(ensured.paths, [extensionDir]);
  assert.equal(ensured.warnings.length, 1);
  assert.match(ensured.warnings[0]?.reason ?? "", /复制模式/);

  repository.close();
});

test("ensureExtensionsInstalled reports disabled bound extensions instead of dropping them silently", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const profile = await repository.createProfile({ name: "Disabled Extension Runtime" });
  const enabled = await service.importDirectory(await writeExtensionDirectory(directory, "enabled-extension"), "reference");
  const disabled = await service.importDirectory(
    await writeExtensionDirectory(directory, "disabled-extension", { name: "Disabled Extension" }),
    "reference",
  );
  await repository.updateExtension(disabled.id, { status: "disabled" });
  await repository.bindExtensionToEnvironments(enabled.id, [profile.id]);
  await repository.bindExtensionToEnvironments(disabled.id, [profile.id]);

  const ensured = await service.ensureExtensionsInstalled(profile.id);

  assert.deepEqual(ensured.paths, [enabled.localPath]);
  assert.equal(ensured.warnings.length, 2);
  const disabledWarning = ensured.warnings.find((warning) => warning.name === "Disabled Extension");
  assert.match(disabledWarning?.reason ?? "", /扩展已停用/);
  assert.match(disabledWarning?.reason ?? "", /浏览器可能回收未加载扩展的本地数据/);

  repository.close();
});

test("remote checksum mismatch fails without replacing an installed extension", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const bytes = makeExtensionZip();
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(bytes)),
  });
  const installed = await service.importDirectory(await writeExtensionDirectory(directory, "stable-extension"));
  const localPath = installed.localPath;
  await repository.updateExtension(installed.id, {
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: "0".repeat(64),
  });

  await assert.rejects(service.install(installed.id), /checksum mismatch/);
  const after = await repository.getExtension(installed.id);

  assert.equal(after?.installState, "installed");
  assert.equal(after?.localPath, localPath);
  assert.match(after?.lastError ?? "", /checksum mismatch/);

  repository.close();
});

test("metadata-only Web Store extension blocks runtime ensure", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const profile = await repository.createProfile({ name: "Metadata Only" });
  const extension = await repository.createExtension({
    name: "Store Metadata",
    sourceKind: "chrome-web-store",
    sourceUrl: "https://chromewebstore.google.com/detail/example/abcdefghijklmnop",
    storeId: "abcdefghijklmnop",
    installState: "metadata-only",
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);

  await assert.rejects(service.ensureExtensionsInstalled(profile.id), /metadata cannot be installed/);

  repository.close();
});

test("extension source refresh imports remote entries and marks installed updates", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipBytes = makeExtensionZip();
  const zipSha256 = sha256Hex(zipBytes);
  const updatedSha256 = sha256Hex(Buffer.from("updated"));
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(JSON.stringify(makeSourceIndex("1.2.3", zipSha256))),
  });
  const source = await repository.createExtensionSource({ name: "Catalog", url: "https://example.test/source.json" });

  const first = await service.refreshSource(source.id);

  assert.equal(first.imported, 1);
  assert.equal(first.updated, 0);
  assert.equal(first.extensions[0]?.sourceKind, "remote-zip");
  assert.equal(first.extensions[0]?.sourceId, source.id);
  assert.equal(first.extensions[0]?.installState, "download-pending");

  const installed = await repository.updateExtension(first.extensions[0]!.id, {
    installState: "installed",
    localPath: await writeExtensionDirectory(directory, "installed-extension"),
    version: "1.2.3",
  });
  const updateService = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(JSON.stringify(makeSourceIndex("2.0.0", updatedSha256))),
  });

  const second = await updateService.refreshSource(source.id);

  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  assert.equal(second.extensions[0]?.id, installed.id);
  assert.equal(second.extensions[0]?.installState, "update-available");
  assert.equal(second.extensions[0]?.localPath, installed.localPath);
  assert.equal(second.source.lastError, undefined);
  assert.ok(second.source.lastRefreshedAt);

  repository.close();
});

test("extension source refresh rejects missing hashes without creating extensions", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(JSON.stringify(makeSourceIndex("1.2.3", undefined))),
  });
  const source = await repository.createExtensionSource({ name: "Catalog", url: "https://example.test/source.json" });

  await assert.rejects(service.refreshSource(source.id), /sha256 is required/);
  const after = await repository.getExtensionSource(source.id);

  assert.equal((await repository.listExtensions()).length, 0);
  assert.match(after?.lastError ?? "", /sha256 is required/);

  repository.close();
});

test("unsigned extension sources can refresh and install remote assets", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipBytes = makeExtensionZip();
  let requestCount = 0;
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => {
      requestCount += 1;
      return requestCount === 1
        ? new Response(JSON.stringify(makeSourceIndex("1.2.3", undefined)))
        : new Response(Buffer.from(zipBytes));
    },
  });
  const source = await repository.createExtensionSource({
    name: "Unsigned Catalog",
    url: "https://example.test/source.json",
    allowUnsignedAssets: true,
  });

  const refresh = await service.refreshSource(source.id);
  const installed = await service.install(refresh.extensions[0]!.id);

  assert.equal(installed.installState, "installed");
  assert.equal(installed.sha256, sha256Hex(zipBytes));
  assert.ok(installed.localPath);

  repository.close();
});

test("extension update installs remote asset when permissions do not increase", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const oldPath = await writeExtensionDirectory(directory, "old-extension", { version: "1.0.0" });
  const zipBytes = makeExtensionZip({ version: "2.0.0" });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(zipBytes)),
  });
  const source = await repository.createExtensionSource({ name: "Catalog", url: "https://example.test/source.json" });
  const extension = await repository.createExtension({
    name: "Test Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sourceId: source.id,
    sha256: sha256Hex(zipBytes),
    version: "2.0.0",
    permissions: ["storage"],
    hostPermissions: [],
    installState: "update-available",
    localPath: oldPath,
  });

  const updated = await service.update(extension.id);

  assert.equal(updated.installState, "installed");
  assert.equal(updated.version, "2.0.0");
  assert.notEqual(updated.localPath, oldPath);
  assert.equal(await fileExists(path.join(updated.localPath!, "manifest.json")), true);

  repository.close();
});

test("extension update blocks permission increases without replacing installed path", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const oldPath = await writeExtensionDirectory(directory, "old-extension", { version: "1.0.0" });
  const zipBytes = makeExtensionZip({ version: "2.0.0", permissions: ["storage", "cookies"] });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(zipBytes)),
  });
  const source = await repository.createExtensionSource({ name: "Catalog", url: "https://example.test/source.json" });
  const extension = await repository.createExtension({
    name: "Test Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sourceId: source.id,
    sha256: sha256Hex(zipBytes),
    version: "2.0.0",
    permissions: ["storage"],
    hostPermissions: [],
    installState: "update-available",
    localPath: oldPath,
  });

  await assert.rejects(service.update(extension.id), /requires confirmation/);
  const after = await repository.getExtension(extension.id);

  assert.equal(after?.installState, "update-available");
  assert.equal(after?.localPath, oldPath);
  assert.match(after?.lastError ?? "", /cookies/);

  repository.close();
});

test("install and reinstall block permission increases when state is update-available", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const oldPath = await writeExtensionDirectory(directory, "old-extension", { version: "1.0.0" });
  const zipBytes = makeExtensionZip({ version: "2.0.0", permissions: ["storage", "cookies"] });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(zipBytes)),
  });
  const extension = await repository.createExtension({
    name: "Test Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: sha256Hex(zipBytes),
    version: "2.0.0",
    permissions: ["storage"],
    hostPermissions: [],
    installState: "update-available",
    localPath: oldPath,
  });

  await assert.rejects(service.install(extension.id), /requires confirmation/);
  const afterInstall = await repository.getExtension(extension.id);
  assert.equal(afterInstall?.installState, "update-available");
  assert.equal(afterInstall?.localPath, oldPath);
  assert.match(afterInstall?.lastError ?? "", /cookies/);

  await assert.rejects(service.reinstall(extension.id), /requires confirmation/);
  const afterReinstall = await repository.getExtension(extension.id);
  assert.equal(afterReinstall?.installState, "update-available");
  assert.equal(afterReinstall?.localPath, oldPath);
  assert.match(afterReinstall?.lastError ?? "", /cookies/);

  repository.close();
});

test("install applies an update-available package when permissions do not increase", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const oldPath = await writeExtensionDirectory(directory, "old-extension", {
    version: "1.0.0",
    permissions: ["storage"],
  });
  const zipBytes = makeExtensionZip({ version: "2.0.0", permissions: ["storage"] });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(zipBytes)),
  });
  const extension = await repository.createExtension({
    name: "Test Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: sha256Hex(zipBytes),
    version: "2.0.0",
    permissions: ["storage"],
    hostPermissions: [],
    installState: "update-available",
    localPath: oldPath,
  });

  const installed = await service.install(extension.id);

  assert.equal(installed.installState, "installed");
  assert.equal(installed.version, "2.0.0");
  assert.notEqual(installed.localPath, oldPath);
  assert.equal(installed.lastError, undefined);

  repository.close();
});

test("local ZIP import pins a generated manifest key that survives reinstall", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip());

  const imported = await service.importZip(zipPath);

  assert.ok(imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);

  const reinstalled = await service.reinstall(imported.id);

  assert.equal(reinstalled.manifestKey, imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(reinstalled.localPath!), imported.manifestKey);

  repository.close();
});

test("local ZIP import adopts an existing manifest key", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ key: PRESET_MANIFEST_KEY }));

  const imported = await service.importZip(zipPath);

  assert.equal(imported.manifestKey, PRESET_MANIFEST_KEY);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), PRESET_MANIFEST_KEY);

  repository.close();
});

test("uploaded ZIP import persists the archive inside the data directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipBytes = makeExtensionZip();

  const imported = await service.importUploadedArchive(Buffer.from(zipBytes), "zip");

  assert.equal(imported.installState, "installed");
  assert.equal(imported.sourceKind, "local-zip");
  assert.equal(imported.sha256, sha256Hex(zipBytes));
  assert.ok(imported.localPath?.startsWith(path.join(directory, "extensions")));
  assert.equal(imported.sourceUrl, path.join(directory, "extension-archives", `${imported.id}.zip`));
  assert.equal(await fileExists(imported.sourceUrl), true);
  assert.equal(await fileExists(path.join(imported.localPath!, "manifest.json")), true);

  repository.close();
});

test("uploaded ZIP import reinstalls from the persisted archive without changing the manifest key", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });

  const imported = await service.importUploadedArchive(Buffer.from(makeExtensionZip()), "zip");
  await fs.rm(imported.localPath!, { recursive: true, force: true });
  const reinstalled = await service.reinstall(imported.id);

  assert.equal(reinstalled.installState, "installed");
  assert.ok(imported.manifestKey);
  assert.equal(reinstalled.manifestKey, imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(reinstalled.localPath!), imported.manifestKey);

  repository.close();
});

test("uploaded CRX import adopts the verified developer key", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const keyPair = makeCrxDeveloperKeyPair();

  const imported = await service.importUploadedArchive(makeSignedCrx3(keyPair, makeExtensionZip()), "crx");

  assert.equal(imported.sourceKind, "local-crx");
  assert.equal(imported.manifestKey, keyPair.publicKey.toString("base64"));
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);
  assert.equal(imported.sourceUrl, path.join(directory, "extension-archives", `${imported.id}.crx`));
  assert.equal(await fileExists(imported.sourceUrl), true);

  repository.close();
});

test("uploaded archive import removes the persisted copy when the package is invalid", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const archiveDir = path.join(directory, "archives");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir, extensionArchiveDir: archiveDir });

  await assert.rejects(
    service.importUploadedArchive(Buffer.from(makeManifestZip('{ "name": broken')), "zip"),
    assertBadRequest(/Invalid extension manifest/),
  );

  assert.deepEqual(await listDirectoryNames(archiveDir), []);
  assert.deepEqual(await listDirectoryNames(cacheDir), []);
  assert.equal((await repository.listExtensions()).length, 0);

  repository.close();
});

test("CRX3 import adopts the developer public key when its signature verifies", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const keyPair = makeCrxDeveloperKeyPair();
  const crxPath = path.join(directory, "extension.crx");
  await fs.writeFile(crxPath, makeSignedCrx3(keyPair, makeExtensionZip()));

  const imported = await service.importCrx(crxPath);

  assert.equal(imported.manifestKey, keyPair.publicKey.toString("base64"));
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);

  repository.close();
});

test("CRX3 import refuses to adopt a developer key whose signature does not cover the payload", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const keyPair = makeCrxDeveloperKeyPair();
  const crx = makeSignedCrx3(keyPair, makeExtensionZip());
  const payloadOffset = crx.byteLength - makeExtensionZip().byteLength;
  crx[payloadOffset + 20] ^= 0xff;
  const crxPath = path.join(directory, "tampered.crx");
  await fs.writeFile(crxPath, crx);

  const imported = await service.importCrx(crxPath);

  assert.equal(imported.installState, "installed");
  assert.ok(imported.manifestKey);
  assert.notEqual(imported.manifestKey, keyPair.publicKey.toString("base64"));
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);

  repository.close();
});

test("CRX3 ECDSA-only proofs are never adopted", () => {
  const keyPair = makeCrxDeveloperKeyPair();
  const zipBytes = makeExtensionZip();
  const signed = makeSignedCrx3(keyPair, zipBytes);
  const headerLength = signed.readUInt32LE(8);
  const rsaHeader = signed.subarray(12, 12 + headerLength);
  // Re-tag the proof as field 3 (sha256_with_ecdsa) without touching its bytes.
  const ecdsaHeader = Buffer.from(rsaHeader);
  ecdsaHeader[0] = 3 * 8 + 2;

  assert.equal(extractCrxPublicKey(makeCrx3Raw(ecdsaHeader, zipBytes)), undefined);
  assert.equal(extractCrxPublicKey(signed), keyPair.publicKey.toString("base64"));
});

test("CRX2 packages never adopt the header key and still unpack from the right offset", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const publicKey = Buffer.from("cbpanel-test-crx2-developer-public-key", "utf8");
  const zipBytes = makeExtensionZip({ name: "CRX2 Extension" });
  const crxPath = path.join(directory, "legacy.crx");
  await fs.writeFile(crxPath, makeCrx2(publicKey, zipBytes));

  const imported = await service.importCrx(crxPath);

  assert.equal(imported.name, "CRX2 Extension");
  assert.equal(imported.installState, "installed");
  assert.equal(extractCrxPublicKey(makeCrx2(publicKey, zipBytes)), undefined);
  assert.notEqual(imported.manifestKey, publicKey.toString("base64"));
  assert.ok(Buffer.from(imported.manifestKey!, "base64").byteLength > 100);
  assert.equal(await fileExists(path.join(imported.localPath!, "background.js")), true);
  assert.deepEqual(
    Object.keys(unzipSync(zipBytes)).sort(),
    ["background.js", "manifest.json"],
  );

  repository.close();
});

test("CRX import falls back to a generated key when the header cannot be parsed", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const crxPath = path.join(directory, "broken.crx");
  await fs.writeFile(crxPath, makeCrx3Raw(Buffer.alloc(8, 0xff), makeExtensionZip()));

  const imported = await service.importCrx(crxPath);

  assert.equal(imported.installState, "installed");
  assert.ok(imported.manifestKey);
  assert.ok(Buffer.from(imported.manifestKey!, "base64").byteLength > 100);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);

  repository.close();
});

test("remote extensions still acquire a manifest key after a failed first install", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipBytes = makeExtensionZip();
  let attempt = 0;
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => {
      attempt += 1;
      return attempt === 1 ? new Response("unavailable", { status: 502 }) : new Response(Buffer.from(zipBytes));
    },
  });
  const extension = await repository.createExtension({
    name: "Remote Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: sha256Hex(zipBytes),
    installState: "download-pending",
  });

  await assert.rejects(service.install(extension.id), /download failed/);
  assert.equal((await repository.getExtension(extension.id))?.installState, "install-failed");

  const installed = await service.install(extension.id);

  assert.equal(installed.installState, "installed");
  assert.ok(installed.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(installed.localPath!), installed.manifestKey);

  repository.close();
});

test("ZIP import rejects malformed manifests without leaving cache directories behind", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir });
  const zipPath = path.join(directory, "broken-manifest.zip");
  await fs.writeFile(zipPath, makeManifestZip('{ "name": broken'));

  await assert.rejects(service.importZip(zipPath), assertBadRequest(/Invalid extension manifest/));

  assert.deepEqual(await listDirectoryNames(cacheDir), []);
  assert.equal((await repository.listExtensions()).length, 0);

  repository.close();
});

test("imports accept BOM prefixed manifests", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "bom-extension.zip");
  await fs.writeFile(zipPath, makeManifestZip(`${UTF8_BOM}${JSON.stringify(extensionManifest())}`));
  const referenceDirectory = path.join(directory, "bom-directory");
  await fs.mkdir(referenceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(referenceDirectory, "manifest.json"),
    `${UTF8_BOM}${JSON.stringify({ ...extensionManifest(), name: "BOM Directory Extension" }, null, 2)}\n`,
    "utf8",
  );

  const imported = await service.importZip(zipPath);
  const referenced = await service.importDirectory(referenceDirectory, "reference");

  assert.equal(imported.name, "Test Extension");
  assert.equal(imported.installState, "installed");
  assert.ok(imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);
  assert.equal(referenced.name, "BOM Directory Extension");

  repository.close();
});

test("manifest localization resolves __MSG__ placeholders from _locales", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "i18n-extension", {
    name: "__MSG_appName__",
    description: "__MSG_appDescription__",
    default_locale: "en",
  });
  await writeLocaleMessages(extensionDir, "en", {
    appName: { message: "English Name" },
    appDescription: { message: "English Description" },
  });

  const imported = await service.importDirectory(extensionDir, "reference");

  assert.equal(imported.name, "English Name");
  assert.equal(imported.description, "English Description");

  repository.close();
});

test("manifest localization prefers zh_CN and keeps unresolvable placeholders", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "i18n-locale-extension", {
    name: "__MSG_APPNAME__",
    description: "__MSG_unknownMessage__",
    default_locale: "en",
  });
  await writeLocaleMessages(extensionDir, "en", { appName: { message: "English Name" } });
  await writeLocaleMessages(extensionDir, "zh_CN", { appName: { message: "中文名称" } });

  const imported = await service.importDirectory(extensionDir, "reference");

  assert.equal(imported.name, "中文名称");
  assert.equal(imported.description, "__MSG_unknownMessage__");

  repository.close();
});

test("manifest localization normalizes the default locale casing", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "i18n-region-extension", {
    name: "__MSG_appName__",
    default_locale: "pt-br",
  });
  await writeLocaleMessages(extensionDir, "pt_BR", { appName: { message: "Nome em Português" } });

  const imported = await service.importDirectory(extensionDir, "reference");

  assert.equal(imported.name, "Nome em Português");

  repository.close();
});

test("manifest localization ignores corrupt messages.json instead of failing the import", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "i18n-broken-extension", {
    name: "__MSG_appName__",
    default_locale: "en",
  });
  await fs.mkdir(path.join(extensionDir, "_locales", "en"), { recursive: true });
  await fs.writeFile(path.join(extensionDir, "_locales", "en", "messages.json"), "{ broken", "utf8");

  const imported = await service.importDirectory(extensionDir, "reference");

  assert.equal(imported.name, "__MSG_appName__");
  assert.equal(imported.installState, "installed");

  repository.close();
});

test("directory import copies into the extension cache by default", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "copy-extension");

  const imported = await service.importDirectory(extensionDir);

  assert.equal(imported.directoryMode, "copy");
  assert.equal(imported.sourceUrl, extensionDir);
  assert.equal(imported.localPath, path.join(directory, "extensions", imported.id));
  assert.ok(imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(extensionDir), undefined);

  await writeExtensionDirectory(directory, "copy-extension", { version: "9.9.9" });
  const resynced = await service.reinstall(imported.id);

  assert.equal(resynced.version, "9.9.9");
  assert.equal(resynced.localPath, imported.localPath);
  assert.equal(await readManifestKeyFromDirectory(resynced.localPath!), imported.manifestKey);

  await fs.rm(extensionDir, { recursive: true, force: true });
  const checked = await service.check(imported.id);

  assert.equal(checked.installState, "installed");

  repository.close();
});

test("directory import rejects sources inside the extension cache directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir });
  const cachedDirectory = await writeExtensionDirectory(cacheDir, "already-cached");

  await assert.rejects(service.importDirectory(cachedDirectory), assertBadRequest(/cannot be inside the extension cache directory/));

  repository.close();
});

test("directory import rejects sources that contain the extension cache directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(directory, "manifest.json"), `${JSON.stringify(extensionManifest(), null, 2)}\n`, "utf8");

  await assert.rejects(service.importDirectory(directory), assertBadRequest(/cannot contain the extension cache directory/));

  repository.close();
});

test("directory import in reference mode never rewrites the source directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "reference-extension");

  const imported = await service.importDirectory(extensionDir, "reference");

  assert.equal(imported.directoryMode, "reference");
  assert.equal(imported.localPath, extensionDir);
  assert.equal(imported.manifestKey, undefined);
  assert.equal(await readManifestKeyFromDirectory(extensionDir), undefined);

  repository.close();
});

test("permission risk analysis covers all-urls patterns, optional permissions and content scripts", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "risky-extension", {
    permissions: ["storage", "tabs"],
    host_permissions: ["*://*/*"],
    optional_permissions: ["cookies"],
    optional_host_permissions: ["http://*/*", "<all_urls>"],
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  });

  const imported = await service.importDirectory(extensionDir, "reference");
  const risks = new Map(imported.permissionRisks.map((risk) => [risk.permission, risk]));

  assert.equal(risks.has("storage"), false);
  assert.equal(risks.get("tabs")?.level, "medium");
  assert.equal(risks.get("*://*/*")?.level, "high");
  assert.equal(risks.get("*://*/*")?.reason, "可访问所有网站");
  assert.equal(risks.get("cookies")?.level, "high");
  assert.match(risks.get("cookies")?.reason ?? "", /^可选权限：/);
  assert.equal(risks.get("http://*/*")?.level, "high");
  assert.match(risks.get("http://*/*")?.reason ?? "", /^可选权限：/);
  assert.equal(risks.get("<all_urls>")?.level, "high");
  assert.equal(risks.get("<all_urls>")?.reason, "内容脚本注入所有网站");

  repository.close();
});

test("file mutating extension operations are blocked while a bound environment runs", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const activeEnvironmentIds = new Set<string>();
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    activeEnvironmentIds: () => activeEnvironmentIds,
  });
  const profile = await repository.createProfile({ name: "Running Environment" });
  const extension = await service.importDirectory(await writeExtensionDirectory(directory, "in-use-extension"));
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  await repository.updateExtension(extension.id, { manifestKey: undefined });

  activeEnvironmentIds.add(profile.id);

  await assert.rejects(service.install(extension.id), assertConflict(/运行中的环境/));
  await assert.rejects(service.update(extension.id), assertConflict(/运行中的环境/));
  await assert.rejects(service.reinstall(extension.id), assertConflict(/运行中的环境/));
  await assert.rejects(service.migrateIdentity(extension.id), assertConflict(/运行中的环境/));

  activeEnvironmentIds.clear();
  const reinstalled = await service.reinstall(extension.id);
  const installed = await service.install(extension.id);
  const migrated = await service.migrateIdentity(extension.id);

  assert.equal(reinstalled.installState, "installed");
  assert.equal(installed.installState, "installed");
  assert.equal(migrated.installState, "installed");
  assert.ok(migrated.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(migrated.localPath!), migrated.manifestKey);

  repository.close();
});

test("migrateIdentity pins a generated key and reinstalls legacy extensions", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip());
  const imported = await service.importZip(zipPath);
  const legacy = await makeLegacyExtension(repository, imported.id);

  const migrated = await service.migrateIdentity(legacy.id);

  assert.ok(migrated.manifestKey);
  assert.equal(migrated.installState, "installed");
  assert.equal(await readManifestKeyFromDirectory(migrated.localPath!), migrated.manifestKey);

  repository.close();
});

test("migrateIdentity adopts an installed manifest key without reinstalling", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ key: PRESET_MANIFEST_KEY }));
  const imported = await service.importZip(zipPath);
  const stripped = await repository.updateExtension(imported.id, { manifestKey: undefined });

  const migrated = await service.migrateIdentity(stripped.id);

  assert.equal(migrated.manifestKey, PRESET_MANIFEST_KEY);
  assert.equal(migrated.lastInstalledAt, stripped.lastInstalledAt);

  repository.close();
});

test("migrateIdentity rolls back the pinned key when the reinstall fails", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "vanishing-extension");
  const imported = await service.importDirectory(sourceDirectory);
  await makeLegacyExtension(repository, imported.id);
  // Both the source and the cached snapshot must be gone; otherwise copy mode legitimately
  // reinstalls from the snapshot and there is nothing to roll back.
  await fs.rm(sourceDirectory, { recursive: true, force: true });
  await fs.rm(imported.localPath!, { recursive: true, force: true });

  await assert.rejects(service.migrateIdentity(imported.id), /must directly contain manifest\.json/);
  const after = await repository.getExtension(imported.id);

  assert.equal(after?.manifestKey, undefined);
  assert.equal(after?.installState, "installed");
  assert.equal(after?.localPath, imported.localPath);

  repository.close();
});

test("migrateIdentity keeps the pinned key when the failed reinstall already injected it", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip());
  const imported = await service.importZip(zipPath);
  await makeLegacyExtension(repository, imported.id);
  const incompleteZip = makeManifestZip(JSON.stringify({ manifest_version: 3, name: "Test Extension" }));
  await fs.writeFile(zipPath, incompleteZip);
  await repository.updateExtension(imported.id, { sha256: sha256Hex(incompleteZip) });

  await assert.rejects(service.migrateIdentity(imported.id), assertBadRequest(/must include name, version/));
  const after = await repository.getExtension(imported.id);

  assert.ok(after?.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(after!.localPath!), after?.manifestKey);

  repository.close();
});

test("migrateIdentity rejects reference-mode directory extensions", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extension = await service.importDirectory(await writeExtensionDirectory(directory, "reference-extension"), "reference");

  await assert.rejects(service.migrateIdentity(extension.id), assertConflict(/Reference-mode/));
  await assert.rejects(service.migrateIdentity(extension.id), assertCode("EXTENSION_REFERENCE_MODE"));

  repository.close();
});

test("migrateIdentity rejects Web Store metadata and already-pinned extensions", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const storeExtension = await repository.createExtension({
    name: "Store Metadata",
    sourceKind: "chrome-web-store",
    sourceUrl: "https://chromewebstore.google.com/detail/example/abcdefghijklmnop",
    storeId: "abcdefghijklmnop",
    installState: "metadata-only",
  });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip());
  const pinned = await service.importZip(zipPath);

  await assert.rejects(service.migrateIdentity(storeExtension.id), assertConflict(/Chrome Web Store metadata/));
  await assert.rejects(service.migrateIdentity(storeExtension.id), assertCode("EXTENSION_WEB_STORE"));
  await assert.rejects(service.migrateIdentity(pinned.id), assertConflict(/already pinned/));
  await assert.rejects(service.migrateIdentity(pinned.id), assertCode("EXTENSION_IDENTITY_PINNED"));

  repository.close();
});

test("migrateIdentity adopts the verified developer key of a local CRX", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const keyPair = makeCrxDeveloperKeyPair();
  const crxPath = path.join(directory, "extension.crx");
  await fs.writeFile(crxPath, makeSignedCrx3(keyPair, makeExtensionZip()));
  const imported = await service.importCrx(crxPath);
  await makeLegacyExtension(repository, imported.id);

  const migrated = await service.migrateIdentity(imported.id);

  assert.equal(migrated.manifestKey, keyPair.publicKey.toString("base64"));
  assert.equal(await readManifestKeyFromDirectory(migrated.localPath!), migrated.manifestKey);

  repository.close();
});

test("migrateIdentity on a remote CRX recovers the same developer key a first install would extract", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const keyPair = makeCrxDeveloperKeyPair();
  const crxBytes = makeSignedCrx3(keyPair, makeExtensionZip());
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(crxBytes)),
  });
  const extension = await repository.createExtension({
    name: "Remote CRX",
    sourceKind: "remote-crx",
    sourceUrl: "https://example.test/extension.crx",
    sha256: sha256Hex(crxBytes),
    installState: "installed",
    localPath: await writeExtensionDirectory(directory, "remote-crx-snapshot"),
    lastInstalledAt: "2026-01-01T00:00:00.000Z",
  });

  const migrated = await service.migrateIdentity(extension.id);

  assert.equal(migrated.manifestKey, keyPair.publicKey.toString("base64"));
  assert.equal(await readManifestKeyFromDirectory(migrated.localPath!), migrated.manifestKey);

  repository.close();
});

test("reference import rejects directories inside the extension cache", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir });
  const copyImported = await service.importDirectory(await writeExtensionDirectory(directory, "copy-source"));

  await assert.rejects(
    service.importDirectory(copyImported.localPath!, "reference"),
    assertBadRequest(/cannot be inside the extension cache directory/),
  );
  assert.equal((await repository.listExtensions()).length, 1);

  repository.close();
});

test("directory import rejects generated extension runtime copies as canonical sources", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const runtimeDir = path.join(directory, "extension-runtimes");
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    extensionRuntimeDir: runtimeDir,
  });
  const generatedCopy = await writeExtensionDirectory(runtimeDir, "environment-one/extension-one");

  await assert.rejects(service.importDirectory(generatedCopy, "reference"), /inside the extension runtime directory/);
  repository.close();
});

test("directory import rejects comma paths that would split the browser extension list", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const commaDirectory = await writeExtensionDirectory(directory, "comma,extension");

  await assert.rejects(service.importDirectory(commaDirectory), assertBadRequest(/cannot contain a comma/));
  await assert.rejects(service.importDirectory(commaDirectory, "reference"), assertBadRequest(/cannot contain a comma/));
  assert.equal((await repository.listExtensions()).length, 0);

  repository.close();
});

test("cache artifact sweep removes interrupted swap leftovers and keeps real extensions", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir });
  const real = await service.importDirectory(await writeExtensionDirectory(directory, "kept-extension"));
  await fs.mkdir(path.join(cacheDir, `${real.id}.tmp-x`), { recursive: true });
  await fs.mkdir(path.join(cacheDir, `${real.id}.old-y`), { recursive: true });
  await fs.mkdir(path.join(cacheDir, ".preview-z"), { recursive: true });

  await service.sweepCacheArtifacts();

  assert.deepEqual(await listDirectoryNames(cacheDir), [real.id]);
  assert.equal(await fileExists(path.join(real.localPath!, "manifest.json")), true);

  repository.close();
});

test("cache artifact sweep tolerates a missing cache directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "never-created") });

  await service.sweepCacheArtifacts();

  repository.close();
});

test("check keeps the update-available flag so a later update is still offered", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extension = await repository.createExtension({
    name: "Pending Update",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: "c".repeat(64),
    installState: "update-available",
    localPath: await writeExtensionDirectory(directory, "pending-update"),
  });

  const checked = await service.check(extension.id);

  assert.equal(checked.installState, "update-available");
  assert.equal(checked.lastError, undefined);

  repository.close();
});

test("check re-injects a pinned key that is missing from the unpacked manifest", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "extension.zip");
  await fs.writeFile(zipPath, makeExtensionZip());
  const imported = await service.importZip(zipPath);
  await fs.writeFile(
    path.join(imported.localPath!, "manifest.json"),
    `${JSON.stringify(extensionManifest(), null, 2)}\n`,
    "utf8",
  );
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), undefined);

  const checked = await service.check(imported.id);

  assert.equal(checked.installState, "installed");
  assert.equal(checked.manifestKey, imported.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);

  repository.close();
});

test("check never injects a key into a reference-mode source directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "reference-source");
  const referenced = await service.importDirectory(sourceDirectory, "reference");
  // Legacy rows written before server-owned fields were stripped from PUT bodies can still
  // carry a key on a reference-mode entity; the user's directory stays read-only regardless.
  await repository.updateExtension(referenced.id, { manifestKey: PRESET_MANIFEST_KEY });

  const checked = await service.check(referenced.id);

  assert.equal(checked.installState, "installed");
  assert.equal(await readManifestKeyFromDirectory(sourceDirectory), undefined);

  repository.close();
});

test("check backfills a legacy reference manifest key in SQLite and lifecycle-protects a byte-identical source", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    extensionRuntimeDir: path.join(directory, "extension-runtimes"),
    browserDataDir: path.join(directory, "browser-data"),
  });
  const source = await writeExtensionDirectory(directory, "legacy-keyed-reference", {
    name: "Legacy Keyed Reference",
    key: PRESET_MANIFEST_KEY,
    background: { service_worker: "background.js" },
  });
  await fs.writeFile(path.join(source, "background.js"), "globalThis.loaded = true;\n", "utf8");
  const imported = await service.importDirectory(source, "reference");
  await repository.updateExtension(imported.id, { manifestKey: undefined });
  const before = await fs.readFile(path.join(source, "manifest.json"));
  const profile = await repository.createProfile({ name: "Legacy Keyed Runtime" });
  await repository.bindExtensionToEnvironments(imported.id, [profile.id]);

  const checked = await service.check(imported.id);
  const ensured = await service.ensureExtensionsInstalled(profile.id);

  assert.equal(checked.manifestKey, PRESET_MANIFEST_KEY);
  assert.equal((await repository.getExtension(imported.id))?.manifestKey, PRESET_MANIFEST_KEY);
  assert.notEqual(ensured.paths[0], source);
  assert.ok(ensured.paths[0]?.startsWith(path.join(directory, "extension-runtimes", profile.id)));
  assert.deepEqual(await fs.readFile(path.join(source, "manifest.json")), before);
  repository.close();
});

test("failed install keeps the previous snapshot path even when it started from update-available", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipBytes = makeExtensionZip();
  let allowDownload = true;
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => (allowDownload ? new Response(Buffer.from(zipBytes)) : new Response("gone", { status: 502 })),
  });
  const extension = await repository.createExtension({
    name: "Remote Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: sha256Hex(zipBytes),
    installState: "download-pending",
  });
  const installed = await service.install(extension.id);
  await repository.updateExtension(extension.id, { installState: "update-available" });
  allowDownload = false;

  await assert.rejects(service.install(extension.id), /download failed/);
  const afterFailure = await repository.getExtension(extension.id);

  assert.equal(afterFailure?.localPath, installed.localPath);
  assert.equal(afterFailure?.installState, "update-available");
  assert.match(afterFailure?.lastError ?? "", /download failed/);
  assert.equal((await service.check(extension.id)).installState, "update-available");

  repository.close();
});

test("copy mode install falls back to the snapshot when the source directory disappeared", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "copy-source-extension");
  const imported = await service.importDirectory(sourceDirectory);
  await fs.rm(sourceDirectory, { recursive: true, force: true });

  const installed = await service.install(imported.id);

  assert.equal(installed.installState, "installed");
  assert.equal(installed.localPath, imported.localPath);
  assert.equal(installed.version, "1.2.3");
  assert.match(installed.lastError ?? "", /must directly contain manifest\.json/);
  assert.equal(await readManifestKeyFromDirectory(imported.localPath!), imported.manifestKey);

  repository.close();
});

test("copy mode update diffs the source candidate instead of the snapshot", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "diffed-extension");
  const imported = await service.importDirectory(sourceDirectory);
  await writeExtensionDirectory(directory, "diffed-extension", { version: "2.0.0", permissions: ["storage", "cookies"] });
  await repository.updateExtension(imported.id, { installState: "update-available" });

  await assert.rejects(service.update(imported.id), assertConflict(/requires confirmation/));
  const after = await repository.getExtension(imported.id);

  assert.equal(after?.installState, "update-available");
  assert.equal(after?.version, "1.2.3");
  assert.match(after?.lastError ?? "", /cookies/);

  repository.close();
});

test("update keeps the pinned key on the entity and inside the reinstalled manifest", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipBytes = makeExtensionZip({ version: "2.0.0" });
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(zipBytes)),
  });
  const extension = await repository.createExtension({
    name: "Pinned Remote Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: sha256Hex(zipBytes),
    version: "2.0.0",
    permissions: ["storage"],
    manifestKey: PRESET_MANIFEST_KEY,
    installState: "update-available",
    localPath: await writeExtensionDirectory(directory, "pinned-old-snapshot"),
    lastInstalledAt: "2026-01-01T00:00:00.000Z",
  });

  const updated = await service.update(extension.id);

  assert.equal(updated.installState, "installed");
  assert.equal(updated.manifestKey, PRESET_MANIFEST_KEY);
  assert.equal(await readManifestKeyFromDirectory(updated.localPath!), PRESET_MANIFEST_KEY);

  repository.close();
});

test("source refresh does not clobber a pinned manifest key", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipSha256 = sha256Hex(makeExtensionZip());
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(JSON.stringify(makeSourceIndex("2.0.0", zipSha256))),
  });
  const source = await repository.createExtensionSource({ name: "Catalog", url: "https://example.test/source.json" });
  const first = await service.refreshSource(source.id);
  await repository.updateExtension(first.extensions[0]!.id, {
    manifestKey: PRESET_MANIFEST_KEY,
    installState: "installed",
    localPath: await writeExtensionDirectory(directory, "catalog-extension"),
  });

  const second = await service.refreshSource(source.id);

  assert.equal(second.extensions[0]?.manifestKey, PRESET_MANIFEST_KEY);
  assert.equal((await repository.getExtension(first.extensions[0]!.id))?.manifestKey, PRESET_MANIFEST_KEY);

  repository.close();
});

test("a previously installed keyless remote extension stays keyless after a reinstall", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const zipBytes = makeExtensionZip();
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => new Response(Buffer.from(zipBytes)),
  });
  const extension = await repository.createExtension({
    name: "Legacy Remote Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: sha256Hex(zipBytes),
    installState: "installed",
    localPath: await writeExtensionDirectory(directory, "legacy-remote-snapshot"),
    lastInstalledAt: "2026-01-01T00:00:00.000Z",
  });

  const reinstalled = await service.reinstall(extension.id);

  assert.equal(reinstalled.installState, "installed");
  assert.equal(reinstalled.manifestKey, undefined);
  assert.equal(await readManifestKeyFromDirectory(reinstalled.localPath!), undefined);

  repository.close();
});

test("launch loads the current snapshot of an update-available extension and warns instead of installing", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  let downloads = 0;
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    fetchImpl: async () => {
      downloads += 1;
      return new Response(Buffer.from(makeExtensionZip({ version: "2.0.0", permissions: ["storage", "cookies"] })));
    },
  });
  const profile = await repository.createProfile({ name: "Pending Update Runtime" });
  const localPath = await writeExtensionDirectory(directory, "pending-runtime-extension");
  const extension = await repository.createExtension({
    name: "Pending Update Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    sha256: "d".repeat(64),
    installState: "update-available",
    localPath,
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);

  const ensured = await service.ensureExtensionsInstalled(profile.id);

  assert.deepEqual(ensured.paths, [localPath]);
  assert.equal(downloads, 0);
  assert.equal(ensured.warnings.length, 1);
  assert.match(ensured.warnings[0]?.reason ?? "", /有可用更新未安装/);
  assert.equal((await repository.getExtension(extension.id))?.installState, "update-available");

  repository.close();
});

test("launch warns when two bound extensions share the same pinned key", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const profile = await repository.createProfile({ name: "Duplicate Key Runtime" });
  const first = await service.importDirectory(await writeExtensionDirectory(directory, "first-extension", { name: "First Extension" }));
  const second = await service.importDirectory(await writeExtensionDirectory(directory, "second-extension", { name: "Second Extension" }));
  await repository.updateExtension(second.id, { manifestKey: first.manifestKey });
  await repository.bindExtensionToEnvironments(first.id, [profile.id]);
  await repository.bindExtensionToEnvironments(second.id, [profile.id]);

  const ensured = await service.ensureExtensionsInstalled(profile.id);

  assert.equal(ensured.paths.length, 2);
  assert.equal(ensured.warnings.length, 1);
  const [reported, other] = ensured.warnings[0]?.name === "First Extension"
    ? ["First Extension", "Second Extension"]
    : ["Second Extension", "First Extension"];
  assert.equal(ensured.warnings[0]?.name, reported);
  assert.equal(ensured.warnings[0]?.reason, `与 ${other} 使用相同的固定 key，浏览器只会加载其中一个`);

  repository.close();
});

test("launch installs past its own session but still blocks on a sibling running environment", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const activeEnvironmentIds = new Set<string>();
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    activeEnvironmentIds: () => activeEnvironmentIds,
  });
  const launching = await repository.createProfile({ name: "Launching Environment" });
  const sibling = await repository.createProfile({ name: "Sibling Environment" });
  const sourceDirectory = await writeExtensionDirectory(directory, "shared-extension");
  const extension = await service.importDirectory(sourceDirectory);
  await repository.bindExtensionToEnvironments(extension.id, [launching.id, sibling.id]);
  await repository.updateExtension(extension.id, { installState: "install-failed" });

  activeEnvironmentIds.add(launching.id);
  const ensured = await service.ensureExtensionsInstalled(launching.id);
  assert.deepEqual(ensured.paths, [extension.localPath]);

  await repository.updateExtension(extension.id, { installState: "install-failed" });
  activeEnvironmentIds.add(sibling.id);
  await assert.rejects(service.ensureExtensionsInstalled(launching.id), assertConflict(/运行中的环境/));
  await assert.rejects(service.ensureExtensionsInstalled(launching.id), assertCode("EXTENSION_IN_USE"));

  repository.close();
});

test("import conflict matches by sha256 and reuses without creating a second entity", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipBytes = makeExtensionZip({ name: "Dedupe Extension", version: "1.0.0" });
  const zipPath = path.join(directory, "dedupe.zip");
  await fs.writeFile(zipPath, zipBytes);

  const first = await service.importZip(zipPath);
  await assert.rejects(service.importZip(zipPath), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_IMPORT_CONFLICT");
    assert.equal((error as { matchBy?: string }).matchBy, "sha256");
    assert.equal((error as { candidates?: Array<{ id: string }> }).candidates?.[0]?.id, first.id);
    return true;
  });

  const reused = await service.importZip(zipPath, { conflictDisposition: "reuse", conflictExtensionId: first.id });
  assert.equal(reused.id, first.id);
  assert.equal((await repository.listExtensions()).length, 1);

  repository.close();
});

test("import overwrite keeps id and manifestKey while updating package body", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const firstZip = makeExtensionZip({ name: "Overwrite Extension", version: "1.0.0", key: PRESET_MANIFEST_KEY });
  const firstPath = path.join(directory, "first.zip");
  await fs.writeFile(firstPath, firstZip);
  const first = await service.importZip(firstPath);
  const profile = await repository.createProfile({ name: "Bound Profile" });
  await repository.bindExtensionToEnvironments(first.id, [profile.id]);

  const secondZip = makeExtensionZip({ name: "Overwrite Extension", version: "2.0.0", key: "different-key-value-for-overwrite" });
  const secondPath = path.join(directory, "second.zip");
  await fs.writeFile(secondPath, secondZip);

  const overwritten = await service.importZip(secondPath, {
    conflictDisposition: "overwrite",
    conflictExtensionId: first.id,
  });

  assert.equal(overwritten.id, first.id);
  assert.equal(overwritten.manifestKey, first.manifestKey);
  assert.equal(overwritten.version, "2.0.0");
  assert.equal(overwritten.installState, "installed");
  assert.equal(await readManifestKeyFromDirectory(overwritten.localPath!), first.manifestKey);
  assert.deepEqual((await repository.getEnvironment(profile.id))?.extensionIds, [first.id]);
  assert.equal((await repository.listExtensions()).length, 1);

  repository.close();
});

test("import create disposition still creates a second entity", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "create.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Create Disposition", version: "1.0.0" }));
  const first = await service.importZip(zipPath);
  const second = await service.importZip(zipPath, { conflictDisposition: "create" });
  assert.notEqual(second.id, first.id);
  assert.equal((await repository.listExtensions()).length, 2);
  repository.close();
});

test("import conflict matches a zip against the same extension already imported as a directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "soft-match", { name: "Soft Match Extension", version: "3.1.0" });
  const zipPath = path.join(directory, "soft-match.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Soft Match Extension", version: "3.1.0" }));

  const fromDirectory = await service.importDirectory(extensionDir);
  await assert.rejects(service.importZip(zipPath), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_IMPORT_CONFLICT");
    // The content fingerprint layer outranks nameVersion, so identical packages report the exact
    // reason instead of the heuristic one. Asserting the value therefore also pins the priority
    // order: a broken fingerprint would silently degrade this to "nameVersion".
    assert.equal((error as { matchBy?: string }).matchBy, "manifestSha256");
    assert.equal((error as { candidates?: Array<{ id: string }> }).candidates?.[0]?.id, fromDirectory.id);
    return true;
  });
  assert.equal((await repository.listExtensions()).length, 1);

  repository.close();
});

test("name and version conflict still honours the create disposition", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "soft-create", { name: "Soft Create Extension", version: "2.0.0" });
  const zipPath = path.join(directory, "soft-create.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Soft Create Extension", version: "2.0.0" }));

  const fromDirectory = await service.importDirectory(extensionDir);
  const fromZip = await service.importZip(zipPath, { conflictDisposition: "create" });

  assert.notEqual(fromZip.id, fromDirectory.id);
  assert.equal(fromZip.sourceKind, "local-zip");
  assert.equal((await repository.listExtensions()).length, 2);

  repository.close();
});

// Reuse and overwrite may only be resolved implicitly when the match is unambiguous; the content
// and name+version layers both routinely match several rows and must not pick one on the caller's behalf.
test("an ambiguous name and version match refuses to overwrite without an explicit target", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "soft-ambiguous", { name: "Soft Ambiguous Extension", version: "4.2.0" });
  const zipPath = path.join(directory, "soft-ambiguous.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Soft Ambiguous Extension", version: "4.2.0" }));

  const first = await service.importDirectory(extensionDir);
  const second = await service.importDirectory(extensionDir, "copy", { conflictDisposition: "create" });

  await assert.rejects(service.importZip(zipPath, { conflictDisposition: "overwrite" }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_IMPORT_CONFLICT");
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { matchBy?: string }).matchBy, "manifestSha256");
    assert.deepEqual(
      (error as { candidates?: Array<{ id: string }> }).candidates?.map((candidate) => candidate.id).sort(),
      [first.id, second.id].sort(),
    );
    return true;
  });
  // Nothing was touched: both rows are still directory imports.
  assert.deepEqual((await repository.listExtensions()).map((extension) => extension.sourceKind), ["local-directory", "local-directory"]);

  // Naming one of them still works, and only that row changes.
  const overwritten = await service.importZip(zipPath, { conflictDisposition: "overwrite", conflictExtensionId: second.id });
  assert.equal(overwritten.id, second.id);
  assert.equal(overwritten.sourceKind, "local-zip");

  repository.close();
});

test("a different version is not a name and version conflict", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "soft-version", { name: "Soft Version Extension", version: "1.0.0" });
  const zipPath = path.join(directory, "soft-version.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Soft Version Extension", version: "1.1.0" }));

  const fromDirectory = await service.importDirectory(extensionDir);
  const fromZip = await service.importZip(zipPath);

  assert.notEqual(fromZip.id, fromDirectory.id);
  assert.equal((await repository.listExtensions()).length, 2);

  repository.close();
});

test("the manifest fingerprint ignores indentation, key order, and a BOM", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });

  // Identical content, deliberately hostile presentation: four-space indent + trailing newline on
  // one side, compact + BOM + reversed key order on the other. Array order is NOT reordered, because
  // a manifest's arrays are ordered data and the algorithm preserves them on purpose.
  const sourceDirectory = path.join(directory, "canonical-directory");
  await fs.mkdir(sourceDirectory, { recursive: true });
  await fs.writeFile(
    path.join(sourceDirectory, "manifest.json"),
    `${JSON.stringify({
      manifest_version: 3,
      name: "Canonical Extension",
      version: "5.0.0",
      description: "Canonical",
      permissions: ["storage", "cookies"],
      host_permissions: [],
    }, null, 4)}\n`,
    "utf8",
  );
  const zipPath = path.join(directory, "canonical.zip");
  await fs.writeFile(zipPath, makeManifestZip(`${UTF8_BOM}${JSON.stringify({
    host_permissions: [],
    permissions: ["storage", "cookies"],
    description: "Canonical",
    version: "5.0.0",
    name: "Canonical Extension",
    manifest_version: 3,
  })}`));

  const fromDirectory = await service.importDirectory(sourceDirectory, "reference");
  await assert.rejects(service.importZip(zipPath), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_IMPORT_CONFLICT");
    assert.equal((error as { matchBy?: string }).matchBy, "manifestSha256");
    assert.equal((error as { candidates?: Array<{ id: string }> }).candidates?.[0]?.id, fromDirectory.id);
    return true;
  });

  // Direct proof the two digests are byte-identical, not just that some layer matched.
  const fromZip = await service.importZip(zipPath, { conflictDisposition: "create" });
  assert.ok(fromDirectory.manifestSha256);
  assert.equal(fromZip.manifestSha256, fromDirectory.manifestSha256);

  repository.close();
});

test("a package with one extra permission falls past the fingerprint layer to nameVersion", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "content-differs", {
    name: "Content Differs Extension",
    version: "1.0.0",
    permissions: ["storage"],
  });
  const zipPath = path.join(directory, "content-differs.zip");
  await fs.writeFile(zipPath, makeExtensionZip({
    name: "Content Differs Extension",
    version: "1.0.0",
    permissions: ["storage", "cookies"],
  }));

  const fromDirectory = await service.importDirectory(extensionDir);
  await assert.rejects(service.importZip(zipPath), (error: unknown) => {
    // One extra permission is a genuinely different package. The fingerprint must refuse to claim
    // "identical contents" here, otherwise over-normalization would merge unrelated packages behind
    // a promise the digest cannot keep; the soft nameVersion layer is the correct owner.
    assert.equal((error as { matchBy?: string }).matchBy, "nameVersion");
    assert.equal((error as { candidates?: Array<{ id: string }> }).candidates?.[0]?.id, fromDirectory.id);
    return true;
  });

  const fromZip = await service.importZip(zipPath, { conflictDisposition: "create" });
  assert.ok(fromDirectory.manifestSha256);
  assert.ok(fromZip.manifestSha256);
  assert.notEqual(fromZip.manifestSha256, fromDirectory.manifestSha256);

  repository.close();
});

test("the injected manifest key does not move the fingerprint across copy and reference imports", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "key-neutral", { name: "Key Neutral Extension", version: "2.5.0" });

  const copied = await service.importDirectory(sourceDirectory, "copy");
  const referenced = await service.importDirectory(sourceDirectory, "reference", { conflictDisposition: "create" });

  assert.ok(copied.manifestSha256);
  assert.equal(referenced.manifestSha256, copied.manifestSha256);
  // The copy genuinely carries a per-record key in its own snapshot on disk, and the reference
  // source genuinely does not — so the equality above is the "delete key" step actually working,
  // not two reads of the same untouched file.
  assert.ok(copied.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(copied.localPath!), copied.manifestKey);
  assert.equal(await readManifestKeyFromDirectory(sourceDirectory), undefined);
  assert.equal(referenced.localPath, sourceDirectory);

  repository.close();
});

test("check backfills a missing manifest fingerprint and refreshes a stale one", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "backfill-source", { name: "Backfill Extension", version: "1.4.0" });
  const imported = await service.importDirectory(sourceDirectory, "copy");
  const fingerprint = imported.manifestSha256;
  assert.ok(fingerprint);

  // A row imported before fingerprints existed.
  await repository.updateExtension(imported.id, { manifestSha256: undefined });
  assert.equal((await repository.getExtension(imported.id))?.manifestSha256, undefined);

  // check() reads the installed snapshot, which carries the injected key, yet the backfill lands on
  // exactly the digest the import computed from the key-less source. That equality is what makes
  // check() a correct backfill point rather than an approximation.
  assert.ok(await readManifestKeyFromDirectory(imported.localPath!));
  assert.equal((await service.check(imported.id)).manifestSha256, fingerprint);
  // Idempotent for an unchanged package.
  assert.equal((await service.check(imported.id)).manifestSha256, fingerprint);

  // A wrong digest is replaced, not preserved: check() recomputes from disk every run, so any write
  // point that ever forgets the field self-heals instead of lying forever.
  await repository.updateExtension(imported.id, { manifestSha256: "a".repeat(64) });
  assert.equal((await service.check(imported.id)).manifestSha256, fingerprint);

  repository.close();
});

test("check keeps the stored fingerprint when the installed manifest cannot be read", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "missing-source", { name: "Missing Extension", version: "1.0.0" });
  const imported = await service.importDirectory(sourceDirectory, "copy");
  const fingerprint = imported.manifestSha256;
  assert.ok(fingerprint);

  await fs.rm(imported.localPath!, { recursive: true, force: true });
  const checked = await service.check(imported.id);

  // The row goes local-missing, but the digest still describes the last package that was installed;
  // blanking it here would silently drop the record out of the exact-match layer.
  assert.equal(checked.installState, "local-missing");
  assert.equal(checked.manifestSha256, fingerprint);

  repository.close();
});

test("updating a replaced local zip moves the fingerprint onto the new package", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "rebuilt.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Rebuilt Extension", version: "1.0.0", permissions: ["storage"] }));
  const imported = await service.importZip(zipPath);
  const firstFingerprint = imported.manifestSha256;
  assert.ok(firstFingerprint);

  // The same source file is replaced in place by a new build.
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Rebuilt Extension", version: "2.0.0", permissions: ["storage"] }));
  assert.equal((await service.checkUpdate(imported.id)).installState, "update-available");
  const updated = await service.update(imported.id);

  assert.equal(updated.version, "2.0.0");
  assert.ok(updated.manifestSha256);
  assert.notEqual(updated.manifestSha256, firstFingerprint);

  // And the refreshed digest really identifies the NEW package: re-importing that build from a
  // different path is recognized as identical content instead of falling through to nameVersion.
  // The twin is pretty-printed so its archive bytes differ — otherwise the earlier sha256 layer,
  // which outranks this one, would match first and prove nothing about the fingerprint.
  const twinPath = path.join(directory, "rebuilt-twin.zip");
  await fs.writeFile(twinPath, makeManifestZip(JSON.stringify(
    { ...extensionManifest(), name: "Rebuilt Extension", version: "2.0.0", permissions: ["storage"] },
    null,
    2,
  )));
  await assert.rejects(service.importZip(twinPath), (error: unknown) => {
    assert.equal((error as { matchBy?: string }).matchBy, "manifestSha256");
    assert.equal((error as { candidates?: Array<{ id: string }> }).candidates?.[0]?.id, imported.id);
    return true;
  });

  repository.close();
});

test("nameVersion still catches records stored before fingerprints existed", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "legacy-soft", { name: "Legacy Soft Extension", version: "6.0.0" });
  const zipPath = path.join(directory, "legacy-soft.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Legacy Soft Extension", version: "6.0.0" }));

  const fromDirectory = await service.importDirectory(extensionDir);
  await repository.updateExtension(fromDirectory.id, { manifestSha256: undefined });

  // This is why the soft layer is kept rather than replaced by the fingerprint.
  await assert.rejects(service.importZip(zipPath), (error: unknown) => {
    assert.equal((error as { matchBy?: string }).matchBy, "nameVersion");
    assert.equal((error as { candidates?: Array<{ id: string }> }).candidates?.[0]?.id, fromDirectory.id);
    return true;
  });

  repository.close();
});

test("re-importing the same path keeps sourceUrl ahead of an identical package elsewhere", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const firstDirectory = await writeExtensionDirectory(directory, "priority-a", { name: "Priority Extension", version: "1.0.0" });
  const secondDirectory = await writeExtensionDirectory(directory, "priority-b", { name: "Priority Extension", version: "1.0.0" });

  const contentTwin = await service.importDirectory(firstDirectory, "reference");
  const pathOwner = await service.importDirectory(secondDirectory, "reference", { conflictDisposition: "create" });
  assert.equal(pathOwner.manifestSha256, contentTwin.manifestSha256);

  // Both layers match, but the path the user pointed at is the more specific intent, so the content
  // layer must not steal the target from sourceUrl.
  await assert.rejects(service.importDirectory(secondDirectory, "reference"), (error: unknown) => {
    assert.equal((error as { matchBy?: string }).matchBy, "sourceUrl");
    assert.deepEqual(
      (error as { candidates?: Array<{ id: string }> }).candidates?.map((candidate) => candidate.id),
      [pathOwner.id],
    );
    return true;
  });

  repository.close();
});

test("reinstalling a directory extension moves the fingerprint onto the edited source", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });

  // Copy mode reinstalls from sourceUrl into a fresh snapshot; reference mode reloads in place.
  const copySource = await writeExtensionDirectory(directory, "drift-copy", { name: "Drift Copy", version: "1.0.0" });
  const referenceSource = await writeExtensionDirectory(directory, "drift-reference", { name: "Drift Reference", version: "1.0.0" });
  const copied = await service.importDirectory(copySource, "copy");
  const referenced = await service.importDirectory(referenceSource, "reference");
  assert.ok(copied.manifestSha256);
  assert.ok(referenced.manifestSha256);

  await fs.writeFile(
    path.join(copySource, "manifest.json"),
    `${JSON.stringify({ ...extensionManifest(), name: "Drift Copy", version: "1.1.0" }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(referenceSource, "manifest.json"),
    `${JSON.stringify({ ...extensionManifest(), name: "Drift Reference", version: "1.1.0" }, null, 2)}\n`,
    "utf8",
  );

  const reinstalledCopy = await service.reinstall(copied.id);
  const reinstalledReference = await service.reinstall(referenced.id);

  assert.equal(reinstalledCopy.version, "1.1.0");
  assert.equal(reinstalledReference.version, "1.1.0");
  assert.ok(reinstalledCopy.manifestSha256);
  assert.ok(reinstalledReference.manifestSha256);
  assert.notEqual(reinstalledCopy.manifestSha256, copied.manifestSha256);
  assert.notEqual(reinstalledReference.manifestSha256, referenced.manifestSha256);
  // The copy snapshot still carries its injected key, so this equality also re-proves that the key
  // never leaks into the digest.
  assert.equal(await readManifestKeyFromDirectory(reinstalledCopy.localPath!), copied.manifestKey);
  assert.equal((await service.check(reinstalledCopy.id)).manifestSha256, reinstalledCopy.manifestSha256);

  repository.close();
});

test("deleteExtension removes cache and archive but not reference directories", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const cacheDir = path.join(directory, "extensions");
  const archiveDir = path.join(directory, "extension-archives");
  const service = new ExtensionService({ repository, extensionCacheDir: cacheDir, extensionArchiveDir: archiveDir });

  const uploaded = await service.importUploadedArchive(Buffer.from(makeExtensionZip({ name: "Cached" })), "zip");
  assert.equal(await fileExists(uploaded.localPath!), true);
  assert.equal(await fileExists(path.join(archiveDir, `${uploaded.id}.zip`)), true);
  await service.deleteExtension(uploaded.id);
  assert.equal(await fileExists(uploaded.localPath!), false);
  assert.equal(await fileExists(path.join(archiveDir, `${uploaded.id}.zip`)), false);

  const sourceDirectory = await writeExtensionDirectory(directory, "reference-kept");
  const referenced = await service.importDirectory(sourceDirectory, "reference");
  await service.deleteExtension(referenced.id);
  assert.equal(await fileExists(sourceDirectory), true);
  assert.equal(await fileExists(path.join(sourceDirectory, "manifest.json")), true);

  repository.close();
});

test("launch warns when two bound extensions share the same localPath", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const profile = await repository.createProfile({ name: "Duplicate Path Runtime" });
  const sourceDirectory = await writeExtensionDirectory(directory, "shared-path-extension", { name: "Shared Path" });
  const first = await service.importDirectory(sourceDirectory, "reference");
  const second = await service.importDirectory(await writeExtensionDirectory(directory, "other-extension", { name: "Other Path" }), "reference");
  await repository.updateExtension(second.id, { localPath: first.localPath, sourceUrl: first.localPath });
  await repository.bindExtensionToEnvironments(first.id, [profile.id]);
  await repository.bindExtensionToEnvironments(second.id, [profile.id]);

  const ensured = await service.ensureExtensionsInstalled(profile.id);
  assert.equal(ensured.paths.length, 2);
  assert.equal(ensured.warnings.length, 3);
  assert.ok(ensured.warnings.some((warning) => /相同的本地路径，浏览器只会加载其中一个/.test(warning.reason)));

  repository.close();
});

test("checkUpdate marks local zip update-available when source sha changes", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const zipPath = path.join(directory, "local-update.zip");
  await fs.writeFile(zipPath, makeExtensionZip({ name: "Local Update", version: "1.0.0" }));
  const imported = await service.importZip(zipPath);

  await fs.writeFile(zipPath, makeExtensionZip({ name: "Local Update", version: "1.1.0", permissions: ["storage", "cookies"] }));
  const checked = await service.checkUpdate(imported.id);
  assert.equal(checked.installState, "update-available");

  await assert.rejects(service.update(imported.id), (error: unknown) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.ok(Array.isArray((error as { permissions?: string[] }).permissions));
    return true;
  });
  assert.equal((await repository.getExtension(imported.id))?.installState, "update-available");

  repository.close();
});

test("checkUpdate marks local directory copy update-available when source version changes", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const sourceDirectory = await writeExtensionDirectory(directory, "copy-update-source", { name: "Copy Update", version: "1.0.0" });
  const imported = await service.importDirectory(sourceDirectory);
  await fs.writeFile(
    path.join(sourceDirectory, "manifest.json"),
    `${JSON.stringify({ ...extensionManifest(), name: "Copy Update", version: "2.0.0" }, null, 2)}\n`,
    "utf8",
  );

  const checked = await service.checkUpdate(imported.id);
  assert.equal(checked.installState, "update-available");

  repository.close();
});

test("permission risks carry machine-readable reason keys and the optional flag", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "reason-key-extension", {
    permissions: ["tabs", "cookies"],
    host_permissions: ["*://*/*"],
    optional_permissions: ["proxy"],
    content_scripts: [{ matches: ["<all_urls>"], js: ["content.js"] }],
  });

  const imported = await service.importDirectory(extensionDir, "reference");
  const risks = new Map(imported.permissionRisks.map((risk) => [risk.permission, risk]));

  assert.equal(risks.get("tabs")?.reasonKey, "tabs-metadata");
  assert.equal(risks.get("tabs")?.optional, undefined);
  assert.equal(risks.get("cookies")?.reasonKey, "high-privilege");
  assert.equal(risks.get("*://*/*")?.reasonKey, "all-urls");
  assert.equal(risks.get("<all_urls>")?.reasonKey, "content-script-all-urls");
  assert.equal(risks.get("proxy")?.reasonKey, "high-privilege");
  assert.equal(risks.get("proxy")?.optional, true);
  assert.match(risks.get("proxy")?.reason ?? "", /^可选权限：/);

  repository.close();
});

test("readIconAsset returns the manifest icon closest to 128px as base64", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "icon-extension", {
    icons: { "16": "icons/16.png", "128": "icons/128.png", "512": "icons/512.png" },
  });
  await fs.mkdir(path.join(extensionDir, "icons"), { recursive: true });
  await fs.writeFile(path.join(extensionDir, "icons", "16.png"), Buffer.from([0x10]));
  await fs.writeFile(path.join(extensionDir, "icons", "128.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await fs.writeFile(path.join(extensionDir, "icons", "512.png"), Buffer.from([0x02]));
  const imported = await service.importDirectory(extensionDir, "reference");

  const asset = await service.readIconAsset(imported.id);

  assert.ok(asset);
  assert.equal(asset.mime, "image/png");
  assert.deepEqual([...Buffer.from(asset.data, "base64")], [0x89, 0x50, 0x4e, 0x47]);

  repository.close();
});

test("readIconAsset rejects manifest icons resolving outside the extension directory", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "escaping-icon-extension", {
    icons: { "128": "../outside.png" },
  });
  await fs.writeFile(path.join(directory, "outside.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const imported = await service.importDirectory(extensionDir, "reference");

  await assert.rejects(
    service.readIconAsset(imported.id),
    assertBadRequest(/escapes the extension directory/),
  );

  repository.close();
});

// `fs.cp` keeps symlinks verbatim, so a copied package can point an icon at a file outside itself
// while every path segment still looks contained.
test("readIconAsset rejects manifest icons reaching outside through a symlink", async (t) => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const outsideDir = path.join(directory, "outside");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "secret.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const extensionDir = await writeExtensionDirectory(directory, "symlinked-icon-extension", {
    icons: { "128": "link/secret.png" },
  });
  try {
    // Junctions are the one link type Windows creates without elevation, and POSIX ignores the hint.
    await fs.symlink(outsideDir, path.join(extensionDir, "link"), "junction");
  } catch {
    t.skip("this platform does not allow creating links unprivileged");
    repository.close();
    return;
  }
  const imported = await service.importDirectory(extensionDir, "reference");

  await assert.rejects(
    service.readIconAsset(imported.id),
    assertBadRequest(/escapes the extension directory/),
  );

  repository.close();
});

test("readIconAsset resolves to nothing when the manifest declares no icon at all", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "iconless-extension", { name: "Iconless Extension" });
  const imported = await service.importDirectory(extensionDir, "reference");

  // An ordinary state, so it must not throw: the route turns this into 204 rather than a 404 the
  // client would log as an error for every iconless extension.
  assert.equal(await service.readIconAsset(imported.id), undefined);

  repository.close();
});

test("readIconAsset accepts package-root icon paths and falls back to action.default_icon", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const rootPathDir = await writeExtensionDirectory(directory, "root-path-icon-extension", {
    name: "Root Path Icon Extension",
    icons: { "128": "/icons/128.png" },
  });
  await fs.mkdir(path.join(rootPathDir, "icons"), { recursive: true });
  await fs.writeFile(path.join(rootPathDir, "icons", "128.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const actionOnlyDir = await writeExtensionDirectory(directory, "action-icon-extension", {
    name: "Action Icon Extension",
    action: { default_icon: { "48": "toolbar.png" } },
  });
  await fs.writeFile(path.join(actionOnlyDir, "toolbar.png"), Buffer.from([0x01, 0x02]));
  const rootPathExtension = await service.importDirectory(rootPathDir, "reference");
  const actionOnlyExtension = await service.importDirectory(actionOnlyDir, "reference");

  const rootPathAsset = await service.readIconAsset(rootPathExtension.id);
  const actionOnlyAsset = await service.readIconAsset(actionOnlyExtension.id);

  assert.ok(rootPathAsset);
  assert.ok(actionOnlyAsset);
  assert.deepEqual([...Buffer.from(rootPathAsset.data, "base64")], [0x89, 0x50, 0x4e, 0x47]);
  assert.deepEqual([...Buffer.from(actionOnlyAsset.data, "base64")], [0x01, 0x02]);

  repository.close();
});

test("readIconAsset refuses an oversized manifest icon instead of buffering it", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "oversized-icon-extension", {
    icons: { "128": "huge.png" },
  });
  await fs.writeFile(path.join(extensionDir, "huge.png"), Buffer.alloc(600 * 1024, 0x41));
  const imported = await service.importDirectory(extensionDir, "reference");

  await assert.rejects(
    service.readIconAsset(imported.id),
    assertBadRequest(/larger than 512 KB/),
  );

  repository.close();
});

function makeExtensionZip(manifestPatch: Record<string, unknown> = {}): Uint8Array {
  return makeManifestZip(JSON.stringify({ ...extensionManifest(), ...manifestPatch }));
}

function makeManifestZip(manifestContent: string): Uint8Array {
  return zipSync({
    "manifest.json": Buffer.from(manifestContent, "utf8"),
    "background.js": Buffer.from("", "utf8"),
  });
}

function makeSourceIndex(version: string, sha256: string | undefined): Record<string, unknown> {
  return {
    schemaVersion: 1,
    name: "CBPanel Test Source",
    updatedAt: "2026-06-01T00:00:00.000Z",
    extensions: [
      {
        id: "test-extension",
        name: "Test Extension",
        version,
        assetKind: "zip",
        assetUrl: "https://example.test/extension.zip",
        sha256,
        webStoreId: "abcdefghijklmnop",
        storeUrl: "https://chromewebstore.google.com/detail/example/abcdefghijklmnop",
      },
    ],
  };
}

async function writeExtensionDirectory(
  root: string,
  name: string,
  manifestPatch: Record<string, unknown> = {},
): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({ ...extensionManifest(), ...manifestPatch }, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

async function writeChromeExtensionVersionDirectory(
  root: string,
  extensionId: string,
  versionDirectoryName: string,
  manifestPatch: Record<string, unknown> = {},
): Promise<string> {
  const directory = path.join(root, extensionId, versionDirectoryName);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({ ...extensionManifest(), ...manifestPatch }, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function extensionManifest(): Record<string, unknown> {
  return {
    manifest_version: 3,
    name: "Test Extension",
    version: "1.2.3",
    description: "Test manifest",
    permissions: ["storage"],
    host_permissions: [],
  };
}

async function writeLocaleMessages(
  extensionDirectory: string,
  locale: string,
  messages: Record<string, { message: string }>,
): Promise<void> {
  const localeDirectory = path.join(extensionDirectory, "_locales", locale);
  await fs.mkdir(localeDirectory, { recursive: true });
  await fs.writeFile(path.join(localeDirectory, "messages.json"), `${JSON.stringify(messages, null, 2)}\n`, "utf8");
}

async function listDirectoryNames(directory: string): Promise<string[]> {
  try {
    return (await fs.readdir(directory)).sort();
  } catch {
    return [];
  }
}

async function readManifestKeyFromDirectory(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as { key?: unknown };
    return typeof manifest.key === "string" ? manifest.key : undefined;
  } catch {
    return undefined;
  }
}

async function makeLegacyExtension(repository: SqlitePanelRepository, id: string): Promise<{ id: string }> {
  const extension = await repository.updateExtension(id, { manifestKey: undefined });
  await fs.writeFile(
    path.join(extension.localPath!, "manifest.json"),
    `${JSON.stringify(extensionManifest(), null, 2)}\n`,
    "utf8",
  );
  return extension;
}

function assertConflict(pattern: RegExp): (error: unknown) => boolean {
  return assertStatus(409, pattern);
}

function assertBadRequest(pattern: RegExp): (error: unknown) => boolean {
  return assertStatus(400, pattern);
}

function assertCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  };
}

function assertStatus(status: number, pattern: RegExp): (error: unknown) => boolean {
  return (error: unknown) => {
    assert.equal((error as { status?: number }).status, status);
    assert.match((error as Error).message, pattern);
    return true;
  };
}

type CrxDeveloperKeyPair = {
  publicKey: Buffer;
  privateKey: KeyObject;
};

function makeCrxDeveloperKeyPair(): CrxDeveloperKeyPair {
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    publicKey: Buffer.from(pair.publicKey.export({ type: "spki", format: "der" })),
    privateKey: pair.privateKey,
  };
}

/** Builds a CRX3 whose sha256_with_rsa proof actually verifies over the packed payload. */
function makeSignedCrx3(keyPair: CrxDeveloperKeyPair, zipBytes: Uint8Array): Buffer {
  const crxId = createHash("sha256").update(keyPair.publicKey).digest().subarray(0, 16);
  const signedHeaderData = encodeProtobufBytes(1, crxId);
  const prefix = Buffer.alloc("CRX3 SignedData".length + 1 + 4);
  prefix.write("CRX3 SignedData", 0, "ascii");
  prefix.writeUInt8(0, "CRX3 SignedData".length);
  prefix.writeUInt32LE(signedHeaderData.byteLength, "CRX3 SignedData".length + 1);
  const signature = createSign("RSA-SHA256")
    .update(prefix)
    .update(signedHeaderData)
    .update(Buffer.from(zipBytes))
    .sign(keyPair.privateKey);
  const proof = Buffer.concat([
    encodeProtobufBytes(1, keyPair.publicKey),
    encodeProtobufBytes(2, signature),
  ]);
  const header = Buffer.concat([
    encodeProtobufBytes(2, proof),
    encodeProtobufBytes(10000, signedHeaderData),
  ]);
  return makeCrx3Raw(header, zipBytes);
}

function makeCrx2(publicKey: Uint8Array, zipBytes: Uint8Array): Buffer {
  const signature = Buffer.alloc(16, 0x7f);
  const prefix = Buffer.alloc(16);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(2, 4);
  prefix.writeUInt32LE(publicKey.byteLength, 8);
  prefix.writeUInt32LE(signature.byteLength, 12);
  return Buffer.concat([prefix, Buffer.from(publicKey), signature, Buffer.from(zipBytes)]);
}

function makeCrx3Raw(header: Uint8Array, zipBytes: Uint8Array): Buffer {
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "ascii");
  prefix.writeUInt32LE(3, 4);
  prefix.writeUInt32LE(header.byteLength, 8);
  return Buffer.concat([prefix, header, zipBytes]);
}

function encodeProtobufBytes(fieldNumber: number, value: Uint8Array): Buffer {
  return Buffer.concat([encodeVarint(fieldNumber * 8 + 2), encodeVarint(value.byteLength), value]);
}

function encodeVarint(value: number): Buffer {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest % 128) | 0x80);
    rest = Math.floor(rest / 128);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-extension-"));
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}
