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
import { EnvironmentPackageService } from "./environmentPackageService";

test("environment package export includes dependency closure and materializes proxy references", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const service = makeService(directory, repository);
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
  const extensionDir = await writeExtensionDirectory(directory, "source-extension");
  const extension = await repository.createExtension({
    name: "Portable Extension",
    sourceKind: "local-directory",
    sourceUrl: extensionDir,
    version: "1.2.3",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: extensionDir,
    sha256: "a".repeat(64),
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  await fs.mkdir(path.join(directory, "browser-data", profile.id), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", profile.id, "Cookies"), "cookie-db", "utf8");
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
  assert.equal(data.environments[0].proxyId, undefined);
  assert.equal(data.environments[0].runtimeProfile.proxy.password, "secret");
  assert.equal(data.environments[0].runtimeProfile.proxy.raw, "http://user:secret@proxy.example.test:8080");
  assert.deepEqual(data.environments[0].runtimeProfile.runtime.extensionPaths, []);

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
  await fs.mkdir(path.join(sourceDir, "browser-data", sourceProfile.id), { recursive: true });
  await fs.writeFile(path.join(sourceDir, "browser-data", sourceProfile.id, "Preferences"), "prefs", "utf8");
  const packagePath = path.join(sourceDir, "portable.cbpe");
  await sourceService.exportToPackage({ outputPath: packagePath });
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

  targetRepository.close();
});

test("environment package import reuses installed extensions without copying orphan directories", async () => {
  const sourceDir = await makeTempDir();
  const sourceRepository = new SqlitePanelRepository({ dataDir: sourceDir, seed: () => [] });
  const sourceService = makeService(sourceDir, sourceRepository);
  const sourceProfile = await sourceRepository.createProfile({ name: "Source Env", group: "Extensions" });
  const extensionHash = sha256Hex(Buffer.from("reusable-extension"));
  const sourceExtensionDir = await writeExtensionDirectory(sourceDir, "source-extension");
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
  });
  await sourceRepository.bindExtensionToEnvironments(extension.id, [sourceProfile.id]);
  const packagePath = path.join(sourceDir, "reusable.cbpe");
  await sourceService.exportToPackage({ outputPath: packagePath });
  sourceRepository.close();

  const targetDir = await makeTempDir();
  const targetRepository = new SqlitePanelRepository({ dataDir: targetDir, seed: () => [] });
  const existingExtensionDir = await writeExtensionDirectory(targetDir, "existing-extension");
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

async function writeExtensionDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify({
      manifest_version: 3,
      name: "Test Extension",
      version: "1.0.0",
      permissions: ["storage"],
    }, null, 2)}\n`,
    "utf8",
  );
  return directory;
}

function makeService(directory: string, repository: SqlitePanelRepository, activeIds = new Set<string>()): EnvironmentPackageService {
  return new EnvironmentPackageService({
    repository,
    browserDataDir: path.join(directory, "browser-data"),
    extensionCacheDir: path.join(directory, "extensions"),
    activeEnvironmentIds: () => activeIds,
  });
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-package-"));
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
