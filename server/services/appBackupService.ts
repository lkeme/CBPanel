import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionEntity } from "../../src/shared/entities";
import {
  APP_BACKUP_KIND,
  APP_BACKUP_SCHEMA_VERSION,
  type AppBackupCounts,
  type AppBackupData,
  type AppBackupManifest,
  type AppBackupOperation,
  type AppBackupOperationResult,
} from "../../src/shared/appBackup";
import { createId, type BrowserProfile, normalizeProfile, nowIso } from "../../src/shared/profile";
import type { PanelRepository } from "../storage/types";
import {
  type ArchiveEntry,
  directoryArchiveEntries,
  extractZipArchive,
  jsonArchiveEntry,
  pathExists,
  readJsonArchiveFile,
  replaceDirectory,
  writeZipArchive,
} from "./archiveUtils";

type AppBackupServiceOptions = {
  repository: PanelRepository;
  browserDataDir: string;
  extensionCacheDir: string;
  activeEnvironmentIds: () => Set<string>;
};

type ExportRequest = {
  outputPath: string;
};

type RestoreRequest = {
  inputPath: string;
};

type PreparedRestore = {
  data: AppBackupData;
  stagingDir: string;
  counts: AppBackupCounts;
  warnings: string[];
};

type RollbackSnapshot = {
  data: AppBackupData;
  directory: string;
  browserDataExisted: boolean;
  extensionCacheExisted: boolean;
};

const MANIFEST_ENTRY = "manifest.json";
const DATA_ENTRY = "data.json";

export class AppBackupService {
  private readonly operations = new Map<string, AppBackupOperation>();

  constructor(private readonly options: AppBackupServiceOptions) {}

  startExport(request: ExportRequest): AppBackupOperation {
    const operation = this.createOperation("export", "queued", "Preparing full backup export.");
    void this.runExport(operation.id, request);
    return operation;
  }

  startRestore(request: RestoreRequest): AppBackupOperation {
    const operation = this.createOperation("restore", "queued", "Preparing full backup restore.");
    void this.runRestore(operation.id, request);
    return operation;
  }

  getOperation(id: string): AppBackupOperation | undefined {
    return this.operations.get(id);
  }

  async exportToBackup(request: ExportRequest, operationId?: string): Promise<AppBackupOperationResult> {
    this.assertNoActiveEnvironment("Stop running environments before exporting a full backup.");
    const outputPath = ensureBackupExtension(path.resolve(request.outputPath));
    const data = await this.options.repository.exportFullBackupData();
    const prepared = await this.buildExportEntries(data, operationId);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await writeZipArchive(outputPath, prepared.entries, (current, total, archivePath) => {
      this.setProgress(operationId, "writing", current, total, `Writing ${archivePath}.`);
    });
    this.setProgress(operationId, "finalizing", prepared.entries.length, prepared.entries.length, "Full backup written.");
    return {
      outputPath,
      counts: prepared.manifest.counts,
      warnings: prepared.warnings,
    };
  }

  async restoreFromBackup(request: RestoreRequest, operationId?: string): Promise<AppBackupOperationResult> {
    this.assertNoActiveEnvironment("Stop running environments before restoring a full backup.");
    const inputPath = path.resolve(request.inputPath);
    const prepared = await this.prepareRestore(inputPath, operationId);
    const rollback = await this.createRollbackSnapshot(operationId);
    try {
      await this.restoreFilesystem(prepared, operationId);
      this.setProgress(operationId, "restoring-database", 0, prepared.data.environments.length, "Replacing app data.");
      await this.options.repository.restoreFullBackupData(prepared.data);
      this.setProgress(operationId, "finalizing", prepared.data.environments.length, prepared.data.environments.length, "Full backup restored.");
      return {
        inputPath,
        counts: prepared.counts,
        warnings: prepared.warnings,
      };
    } catch (error) {
      await this.rollbackRestore(rollback).catch(() => undefined);
      throw error;
    } finally {
      await Promise.all([
        fs.rm(prepared.stagingDir, { recursive: true, force: true }).catch(() => undefined),
        fs.rm(rollback.directory, { recursive: true, force: true }).catch(() => undefined),
      ]);
    }
  }

  private async runExport(operationId: string, request: ExportRequest): Promise<void> {
    this.markRunning(operationId, "exporting", "Exporting full backup.");
    try {
      const result = await this.exportToBackup(request, operationId);
      this.finishOperation(operationId, "succeeded", "Full backup exported.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Full backup export failed.", undefined, (error as Error).message);
    }
  }

  private async runRestore(operationId: string, request: RestoreRequest): Promise<void> {
    this.markRunning(operationId, "restoring", "Restoring full backup.");
    try {
      const result = await this.restoreFromBackup(request, operationId);
      this.finishOperation(operationId, "succeeded", "Full backup restored.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Full backup restore failed.", undefined, (error as Error).message);
    }
  }

  private async buildExportEntries(data: AppBackupData, operationId?: string): Promise<{
    entries: ArchiveEntry[];
    manifest: AppBackupManifest;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const entries: ArchiveEntry[] = [];
    const browserDataEntries = await this.browserDataEntries(data, warnings);
    const extensionEntries = await this.extensionEntries(data.extensions, warnings);
    const manifest: AppBackupManifest = {
      kind: APP_BACKUP_KIND,
      schemaVersion: APP_BACKUP_SCHEMA_VERSION,
      exportedAt: nowIso(),
      containsSecrets: true,
      containsBrowserData: browserDataEntries.count > 0,
      containsExtensions: extensionEntries.count > 0,
      counts: backupCounts(data, browserDataEntries.count, extensionEntries.count),
    };

    entries.push(jsonArchiveEntry(MANIFEST_ENTRY, manifest));
    entries.push(jsonArchiveEntry(DATA_ENTRY, data));
    entries.push(...browserDataEntries.entries);
    entries.push(...extensionEntries.entries);
    this.setProgress(operationId, "collecting", entries.length, entries.length, "Collected full backup entries.");
    return { entries, manifest, warnings };
  }

  private async browserDataEntries(data: AppBackupData, warnings: string[]): Promise<{ count: number; entries: ArchiveEntry[] }> {
    const entries: ArchiveEntry[] = [];
    let count = 0;
    for (const environment of data.environments) {
      const directory = path.join(this.options.browserDataDir, environment.id);
      if (!(await pathExists(directory))) {
        warnings.push(`Browser data not found for ${environment.name}.`);
        continue;
      }
      count += 1;
      entries.push(...await directoryArchiveEntries(directory, `browser-data/${environment.id}`));
    }
    return { count, entries };
  }

  private async extensionEntries(extensions: ExtensionEntity[], warnings: string[]): Promise<{ count: number; entries: ArchiveEntry[] }> {
    const entries: ArchiveEntry[] = [];
    let count = 0;
    for (const extension of extensions) {
      const directory = extension.localPath ?? path.join(this.options.extensionCacheDir, extension.id);
      if (!(await pathExists(directory))) {
        if (extension.installState === "installed") warnings.push(`Extension files not found for ${extension.name}.`);
        continue;
      }
      count += 1;
      entries.push(...await directoryArchiveEntries(directory, `extensions/${extension.id}`));
    }
    return { count, entries };
  }

  private async prepareRestore(inputPath: string, operationId?: string): Promise<PreparedRestore> {
    this.setProgress(operationId, "extracting", 0, 1, "Extracting full backup.");
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-backup-restore-"));
    try {
      await extractZipArchive(inputPath, stagingDir, "App backup contains an unsafe path.");
      const manifest = parseManifest(await readJsonArchiveFile(path.join(stagingDir, MANIFEST_ENTRY)));
      const data = parseBackupData(await readJsonArchiveFile(path.join(stagingDir, DATA_ENTRY)));
      validateManifestData(manifest, data);
      const browserDataCount = await countExistingDirectories(data.environments.map((environment) => path.join(stagingDir, "browser-data", environment.id)));
      const extensionFileCount = await countExistingDirectories(data.extensions.map((extension) => path.join(stagingDir, "extensions", extension.id)));
      const warnings: string[] = [];
      if (manifest.counts.browserData > browserDataCount) {
        warnings.push("Backup metadata references browser data missing from the archive.");
      }
      if (manifest.counts.runtimeExtensions > extensionFileCount) {
        warnings.push("Backup metadata references extension files missing from the archive.");
      }
      const restoredData = this.materializeRestoredExtensionPaths(data, stagingDir);
      this.setProgress(operationId, "validating", restoredData.environments.length, restoredData.environments.length, "Validated full backup.");
      return {
        data: restoredData,
        stagingDir,
        counts: backupCounts(restoredData, browserDataCount, extensionFileCount),
        warnings,
      };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private materializeRestoredExtensionPaths(data: AppBackupData, stagingDir: string): AppBackupData {
    const extensionPaths = new Map<string, string>();
    const extensions = data.extensions.map((extension) => {
      const stagedPath = path.join(stagingDir, "extensions", extension.id);
      const restoredPath = path.join(this.options.extensionCacheDir, extension.id);
      if (fsExistsSyncSafe(stagedPath)) {
        extensionPaths.set(extension.id, restoredPath);
        return {
          ...extension,
          localPath: restoredPath,
          installState: "installed" as const,
          lastError: undefined,
        };
      }
      if (extension.installState !== "installed") return extension;
      return {
        ...extension,
        localPath: undefined,
        installState: "local-missing" as const,
        lastError: "Extension files missing from restored backup.",
      };
    });
    const environments = data.environments.map((environment) => ({
      ...environment,
      runtimeProfile: withRestoredExtensionPaths(
        environment.runtimeProfile,
        environment.extensionIds
          .map((extensionId) => extensionPaths.get(extensionId))
          .filter((value): value is string => Boolean(value)),
      ),
    }));
    const runtimeProfilesById = new Map(environments
      .filter((environment) => !environment.deletedAt)
      .map((environment) => [environment.id, environment.runtimeProfile]));

    return {
      ...data,
      extensions,
      environments,
      profiles: data.profiles.map((profile) => runtimeProfilesById.get(profile.id) ?? normalizeProfile(profile)),
    };
  }

  private async createRollbackSnapshot(operationId?: string): Promise<RollbackSnapshot> {
    this.setProgress(operationId, "snapshot-current", 0, 1, "Snapshotting current app data for rollback.");
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-backup-rollback-"));
    const browserDataExisted = await pathExists(this.options.browserDataDir);
    const extensionCacheExisted = await pathExists(this.options.extensionCacheDir);
    if (browserDataExisted) await fs.cp(this.options.browserDataDir, path.join(directory, "browser-data"), { recursive: true, force: false });
    if (extensionCacheExisted) await fs.cp(this.options.extensionCacheDir, path.join(directory, "extensions"), { recursive: true, force: false });
    return {
      data: await this.options.repository.exportFullBackupData(),
      directory,
      browserDataExisted,
      extensionCacheExisted,
    };
  }

  private async restoreFilesystem(prepared: PreparedRestore, operationId?: string): Promise<void> {
    this.setProgress(operationId, "restoring-files", 0, 2, "Replacing browser data.");
    await replaceManagedDirectory(path.join(prepared.stagingDir, "browser-data"), this.options.browserDataDir);
    this.setProgress(operationId, "restoring-files", 1, 2, "Replacing extension files.");
    await replaceManagedDirectory(path.join(prepared.stagingDir, "extensions"), this.options.extensionCacheDir);
    this.setProgress(operationId, "restoring-files", 2, 2, "Runtime files restored.");
  }

  private async rollbackRestore(snapshot: RollbackSnapshot): Promise<void> {
    await rollbackDirectory(path.join(snapshot.directory, "browser-data"), this.options.browserDataDir, snapshot.browserDataExisted);
    await rollbackDirectory(path.join(snapshot.directory, "extensions"), this.options.extensionCacheDir, snapshot.extensionCacheExisted);
    await this.options.repository.restoreFullBackupData(snapshot.data);
  }

  private assertNoActiveEnvironment(message: string): void {
    if (this.options.activeEnvironmentIds().size === 0) return;
    throw Object.assign(new Error(message), { status: 409 });
  }

  private createOperation(type: "export" | "restore", phase: string, message: string): AppBackupOperation {
    const timestamp = nowIso();
    const operation: AppBackupOperation = {
      id: createId("app-backup-operation"),
      type,
      status: "queued",
      phase,
      current: 0,
      total: 0,
      message,
      startedAt: timestamp,
      updatedAt: timestamp,
    };
    this.operations.set(operation.id, operation);
    return operation;
  }

  private markRunning(id: string, phase: string, message: string): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    Object.assign(operation, {
      status: "running",
      phase,
      message,
      updatedAt: nowIso(),
    });
  }

  private setProgress(id: string | undefined, phase: string, current: number, total: number, message: string): void {
    if (!id) return;
    const operation = this.operations.get(id);
    if (!operation) return;
    Object.assign(operation, {
      phase,
      current,
      total,
      message,
      updatedAt: nowIso(),
    });
  }

  private finishOperation(
    id: string,
    status: "succeeded" | "failed",
    message: string,
    result?: AppBackupOperationResult,
    error?: string,
  ): void {
    const operation = this.operations.get(id);
    if (!operation) return;
    Object.assign(operation, {
      status,
      phase: status,
      message,
      result,
      error,
      updatedAt: nowIso(),
    });
  }
}

function parseManifest(input: unknown): AppBackupManifest {
  if (!isRecord(input)) throw Object.assign(new Error("Backup manifest must be an object."), { status: 400 });
  if (input.kind !== APP_BACKUP_KIND) throw Object.assign(new Error("Unsupported app backup kind."), { status: 400 });
  if (input.schemaVersion !== APP_BACKUP_SCHEMA_VERSION) throw Object.assign(new Error("Unsupported app backup schema version."), { status: 400 });
  const counts = isRecord(input.counts) ? input.counts : {};
  return {
    kind: APP_BACKUP_KIND,
    schemaVersion: APP_BACKUP_SCHEMA_VERSION,
    exportedAt: readString(input.exportedAt, "manifest.exportedAt"),
    containsSecrets: true,
    containsBrowserData: input.containsBrowserData === true,
    containsExtensions: input.containsExtensions === true,
    counts: {
      profiles: readNumber(counts.profiles, "manifest.counts.profiles"),
      environments: readNumber(counts.environments, "manifest.counts.environments"),
      trashEnvironments: readNumber(counts.trashEnvironments, "manifest.counts.trashEnvironments"),
      browserData: readNumber(counts.browserData, "manifest.counts.browserData"),
      groups: readNumber(counts.groups, "manifest.counts.groups"),
      tags: readNumber(counts.tags, "manifest.counts.tags"),
      proxies: readNumber(counts.proxies, "manifest.counts.proxies"),
      extensions: readNumber(counts.extensions, "manifest.counts.extensions"),
      extensionSources: readNumber(counts.extensionSources, "manifest.counts.extensionSources"),
      runtimeExtensions: readNumber(counts.runtimeExtensions, "manifest.counts.runtimeExtensions"),
    },
  };
}

function parseBackupData(input: unknown): AppBackupData {
  if (!isRecord(input)) throw Object.assign(new Error("Backup data must be an object."), { status: 400 });
  if (input.schemaVersion !== APP_BACKUP_SCHEMA_VERSION) throw Object.assign(new Error("Unsupported app backup data schema version."), { status: 400 });
  if (!Array.isArray(input.profiles)) throw Object.assign(new Error("Backup data must include profiles."), { status: 400 });
  if (!Array.isArray(input.environments)) throw Object.assign(new Error("Backup data must include environments."), { status: 400 });
  if (!Array.isArray(input.groups)) throw Object.assign(new Error("Backup data must include groups."), { status: 400 });
  if (!Array.isArray(input.tags)) throw Object.assign(new Error("Backup data must include tags."), { status: 400 });
  if (!Array.isArray(input.proxies)) throw Object.assign(new Error("Backup data must include proxies."), { status: 400 });
  if (!Array.isArray(input.extensions)) throw Object.assign(new Error("Backup data must include extensions."), { status: 400 });
  if (!Array.isArray(input.extensionSources)) throw Object.assign(new Error("Backup data must include extensionSources."), { status: 400 });
  if (!isRecord(input.settings)) throw Object.assign(new Error("Backup data must include settings."), { status: 400 });
  return {
    schemaVersion: APP_BACKUP_SCHEMA_VERSION,
    settings: input.settings as unknown as AppBackupData["settings"],
    profiles: input.profiles as AppBackupData["profiles"],
    environments: input.environments as AppBackupData["environments"],
    groups: input.groups as AppBackupData["groups"],
    tags: input.tags as AppBackupData["tags"],
    proxies: input.proxies as AppBackupData["proxies"],
    extensions: input.extensions as AppBackupData["extensions"],
    extensionSources: input.extensionSources as AppBackupData["extensionSources"],
  };
}

function validateManifestData(manifest: AppBackupManifest, data: AppBackupData): void {
  const counts = backupCounts(data, manifest.counts.browserData, manifest.counts.runtimeExtensions);
  for (const key of ["profiles", "environments", "trashEnvironments", "groups", "tags", "proxies", "extensions", "extensionSources"] as const) {
    if (manifest.counts[key] !== counts[key]) {
      throw Object.assign(new Error(`Backup ${key} count does not match manifest.`), { status: 400 });
    }
  }
}

function backupCounts(data: AppBackupData, browserData: number, runtimeExtensions: number): AppBackupCounts {
  return {
    profiles: data.profiles.length,
    environments: data.environments.filter((environment) => !environment.deletedAt).length,
    trashEnvironments: data.environments.filter((environment) => Boolean(environment.deletedAt)).length,
    browserData,
    groups: data.groups.length,
    tags: data.tags.length,
    proxies: data.proxies.length,
    extensions: data.extensions.length,
    extensionSources: data.extensionSources.length,
    runtimeExtensions,
  };
}

async function countExistingDirectories(paths: string[]): Promise<number> {
  let count = 0;
  for (const itemPath of paths) {
    if (await pathExists(itemPath)) count += 1;
  }
  return count;
}

async function replaceManagedDirectory(source: string, target: string): Promise<void> {
  if (await pathExists(source)) {
    await replaceDirectory(source, target);
  } else {
    await fs.rm(target, { recursive: true, force: true });
    await fs.mkdir(target, { recursive: true });
  }
}

async function rollbackDirectory(source: string, target: string, existed: boolean): Promise<void> {
  if (existed) {
    await replaceDirectory(source, target);
  } else {
    await fs.rm(target, { recursive: true, force: true });
  }
}

function ensureBackupExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith(".cbpb") ? filePath : `${filePath}.cbpb`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${label} must be a non-empty string.`), { status: 400 });
  }
  return value;
}

function readNumber(value: unknown, label: string): number {
  if (!Number.isFinite(value)) {
    throw Object.assign(new Error(`${label} must be a number.`), { status: 400 });
  }
  return Number(value);
}

function fsExistsSyncSafe(itemPath: string): boolean {
  try {
    return Boolean(itemPath) && existsSync(itemPath);
  } catch {
    return false;
  }
}

function withRestoredExtensionPaths(profile: BrowserProfile, extensionPaths: string[]): BrowserProfile {
  return normalizeProfile({
    ...profile,
    runtime: {
      ...profile.runtime,
      extensionPaths,
    },
  });
}
