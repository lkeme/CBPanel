import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { APP_BACKUP_KIND } from "../../src/shared/appBackup";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { AppBackupService } from "./appBackupService";

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
  await fs.mkdir(path.join(directory, "browser-data", profile.id), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", profile.id, "Cookies"), "cookie-db", "utf8");
  const backupPath = path.join(directory, "backup.cbpb");

  const exported = await service.exportToBackup({ outputPath: backupPath });
  assert.equal(exported.counts.environments, 1);
  assert.equal(exported.counts.browserData, 1);
  assert.equal(exported.counts.runtimeExtensions, 1);

  await repository.createProfile({ name: "Will Be Removed" });
  await fs.rm(path.join(directory, "browser-data", profile.id), { recursive: true, force: true });
  await fs.rm(extensionDir, { recursive: true, force: true });
  await fs.mkdir(path.join(directory, "browser-data", "junk"), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", "junk", "file"), "junk", "utf8");

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
  assert.equal(restoredExtension?.sourceKind, "local-directory");
  assert.equal(restoredExtension?.sourceUrl, extensionDir);
  assert.equal(restoredExtension?.localPath, path.join(directory, "extensions", extension.id));
  assert.deepEqual(restoredEnvironment?.runtimeProfile.runtime.extensionPaths, [path.join(directory, "extensions", extension.id)]);
  assert.deepEqual(restoredProfile?.runtime.extensionPaths, [path.join(directory, "extensions", extension.id)]);

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

function makeService(directory: string, repository: SqlitePanelRepository, activeIds = new Set<string>()): AppBackupService {
  return new AppBackupService({
    repository,
    browserDataDir: path.join(directory, "browser-data"),
    extensionCacheDir: path.join(directory, "extensions"),
    activeEnvironmentIds: () => activeIds,
  });
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-backup-"));
}

async function fileExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}
