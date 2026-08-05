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
  assert.equal(restoredExtension?.sourceUrl, path.join(directory, "extensions", extension.id));
  assert.equal(restoredExtension?.localPath, path.join(directory, "extensions", extension.id));
  assert.equal(restoredExtension?.directoryMode, "copy");
  assert.deepEqual(restoredEnvironment?.runtimeProfile.runtime.extensionPaths, [path.join(directory, "extensions", extension.id)]);
  assert.deepEqual(restoredProfile?.runtime.extensionPaths, [path.join(directory, "extensions", extension.id)]);

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

  assert.equal(restoredExtension?.directoryMode, "copy");
  assert.equal(restoredExtension?.localPath, path.join(directory, "extensions", extension.id));
  assert.equal(restored.warnings.some((warning) => warning.includes("Dev Extension")), true);

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
  const restore = service.startRestore({ inputPath: path.join(directory, "missing.cbpb") });
  assert.equal(service.hasRestoreInFlight(), true);

  await settleOperation(service, restore.id);

  assert.equal(service.getOperation(restore.id)?.status, "failed");
  assert.equal(service.hasRestoreInFlight(), false);

  // An export is not reported: it only reads, and only the directories registered environments name, which
  // a prune never treats as candidates. Blocking on it would refuse a cleanup for no reason.
  const exported = service.startExport({ outputPath: path.join(directory, "in-flight.cbpb") });
  assert.equal(service.hasRestoreInFlight(), false);
  await settleOperation(service, exported.id);

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
