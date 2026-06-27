import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { ExtensionService } from "./extensionService";

test("local directory import reads manifest and permission risks", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = new ExtensionService({ repository, extensionCacheDir: path.join(directory, "extensions") });
  const extensionDir = await writeExtensionDirectory(directory, "local-extension", {
    permissions: ["storage", "cookies"],
    host_permissions: ["<all_urls>"],
  });

  const extension = await service.importDirectory(extensionDir);

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
  const parentDirectory = path.join(directory, "Extensions");
  await fs.mkdir(parentDirectory, { recursive: true });

  await assert.rejects(
    service.importDirectory(parentDirectory),
    /must directly contain manifest\.json/,
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
  const chromeRoot = path.join(directory, "Extensions");
  const first = await writeChromeExtensionVersionDirectory(chromeRoot, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "1.0.0_0", {
    name: "Alpha Extension",
    version: "1.0.0",
  });
  const second = await writeChromeExtensionVersionDirectory(chromeRoot, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "2.0.0", {
    name: "Beta Extension",
    version: "2.0.0",
  });

  const result = await service.importDirectories([first, first, second]);

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
  const extension = await service.importDirectory(extensionDir);

  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const paths = await service.ensureExtensionsInstalled(profile.id);

  assert.deepEqual(paths, [extensionDir]);

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

function makeExtensionZip(manifestPatch: Record<string, unknown> = {}): Uint8Array {
  return zipSync({
    "manifest.json": Buffer.from(JSON.stringify({ ...extensionManifest(), ...manifestPatch }), "utf8"),
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
