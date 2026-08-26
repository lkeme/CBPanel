import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ExtensionEntity } from "../../src/shared/entities";
import type { LegacyTransferExtension } from "../../src/shared/extensionAcquisition";
import {
  APP_BACKUP_KIND,
  APP_BACKUP_SCHEMA_VERSION,
  APP_BACKUP_SCHEMA_VERSION_V1,
  APP_BACKUP_SCHEMA_VERSION_V2,
  decodeAppBackupData,
  type AnyAppBackupData,
  type AnyAppBackupManifest,
  type AppBackupCounts,
  type AppBackupData,
  type AppBackupManifest,
  type AppBackupManifestV1,
  type AppBackupManifestV2,
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
import {
  DataMutationCoordinator,
  type DataMutationLease,
} from "./dataMutationCoordinator";
import {
  verifyChromeWebStoreCrx3File,
} from "./crx3Verifier";
import {
  preflightExtensionPackage,
} from "./extensionPackagePreflight";
import { validateTransferredExtensionArtifact } from "./extensionArtifactTransferVerifier";

type AppBackupServiceOptions = {
  repository: PanelRepository;
  browserDataDir: string;
  extensionCacheDir: string;
  extensionRuntimeDir?: string;
  extensionArtifactDir?: string;
  activeEnvironmentIds: () => Set<string>;
  /** Runs synchronously after a restore/rollback commits settings so in-flight derived work can abort. */
  settingsChanged?: (settings: AppBackupData["settings"]) => void;
  mutationCoordinator?: DataMutationCoordinator;
  verifyStoreCrxFileForTesting?: typeof verifyChromeWebStoreCrx3File;
  preflightPackageForTesting?: typeof preflightExtensionPackage;
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
  extensionArtifactExisted: boolean;
};

const MANIFEST_ENTRY = "manifest.json";
const DATA_ENTRY = "data.json";

export class AppBackupService {
  private readonly operations = new Map<string, AppBackupOperation>();

  private readonly mutationCoordinator: DataMutationCoordinator;

  private readonly extensionArtifactDir: string;

  private readonly verifyStoreCrxFile: typeof verifyChromeWebStoreCrx3File;

  private readonly preflightPackage: typeof preflightExtensionPackage;

  constructor(private readonly options: AppBackupServiceOptions) {
    this.mutationCoordinator = options.mutationCoordinator ?? new DataMutationCoordinator();
    this.extensionArtifactDir = options.extensionArtifactDir
      ?? path.join(path.dirname(path.resolve(options.extensionCacheDir)), "extension-artifacts");
    this.verifyStoreCrxFile = options.verifyStoreCrxFileForTesting ?? verifyChromeWebStoreCrx3File;
    this.preflightPackage = options.preflightPackageForTesting ?? preflightExtensionPackage;
  }

  startExport(request: ExportRequest): AppBackupOperation {
    const lease = this.mutationCoordinator.enter("app-backup");
    const operation = this.createOperation("export", "queued", "Preparing full backup export.");
    void this.runExport(operation.id, request, lease);
    return operation;
  }

  startRestore(request: RestoreRequest): AppBackupOperation {
    const lease = this.mutationCoordinator.enter("app-backup");
    const operation = this.createOperation("restore", "queued", "Preparing full backup restore.");
    void this.runRestore(operation.id, request, lease);
    return operation;
  }

  getOperation(id: string): AppBackupOperation | undefined {
    return this.operations.get(id);
  }

  hasOperationInFlight(): boolean {
    return [...this.operations.values()].some((operation) =>
      operation.status === "queued" || operation.status === "running");
  }

  /**
   * Whether a restore may already have written into the managed directories. `restoreFilesystem` replaces
   * `browser-data` wholesale before `restoreFullBackupData` commits the rows, so between those two steps
   * every directory the restore laid down matches the browser-data prune's definition of an orphan — a
   * prune running then deletes exactly the data being restored. The prune route reads this to refuse.
   *
   * Exports are deliberately absent: they only read, and only the directories registered environments
   * name, which a prune never considers a candidate.
   */
  hasRestoreInFlight(): boolean {
    return [...this.operations.values()].some((operation) =>
      operation.type === "restore" && (operation.status === "queued" || operation.status === "running"));
  }

  async exportToBackup(request: ExportRequest, operationId?: string): Promise<AppBackupOperationResult> {
    const lease = this.mutationCoordinator.enter("app-backup");
    try {
      return await this.exportToBackupInternal(request, operationId);
    } finally {
      lease.release();
    }
  }

  private async exportToBackupInternal(request: ExportRequest, operationId?: string): Promise<AppBackupOperationResult> {
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
    const lease = this.mutationCoordinator.enter("app-backup");
    try {
      return await this.restoreFromBackupInternal(request, operationId);
    } finally {
      lease.release();
    }
  }

  private async restoreFromBackupInternal(request: RestoreRequest, operationId?: string): Promise<AppBackupOperationResult> {
    this.assertNoActiveEnvironment("Stop running environments before restoring a full backup.");
    const inputPath = path.resolve(request.inputPath);
    const prepared = await this.prepareRestore(inputPath, operationId);
    const rollback = await this.createRollbackSnapshot(operationId);
    let publicationStarted = false;
    let rollbackFailed = false;
    try {
      // Preparation and rollback snapshotting are both asynchronous. Re-read the runtime hold at the
      // publication boundary so a browser that appeared in that interval cannot have its files replaced.
      this.assertNoActiveEnvironment("Stop running environments before restoring a full backup.");
      publicationStarted = true;
      await this.restoreFilesystem(prepared, operationId);
      this.setProgress(operationId, "restoring-database", 0, prepared.data.environments.length, "Replacing app data.");
      await this.options.repository.restoreFullBackupData(prepared.data);
      this.options.settingsChanged?.(prepared.data.settings);
      this.setProgress(operationId, "finalizing", prepared.data.environments.length, prepared.data.environments.length, "Full backup restored.");
      return {
        inputPath,
        counts: prepared.counts,
        warnings: prepared.warnings,
      };
    } catch (error) {
      // The boundary recheck can fail before a single managed path was touched. Rolling back in that case
      // is itself a destructive publication under the browser that just appeared.
      if (publicationStarted) {
        try {
          await this.rollbackRestore(rollback);
        } catch {
          rollbackFailed = true;
        }
      }
      if (rollbackFailed) {
        throw backupInvalid("Full backup restore needs recovery from its preserved rollback snapshot.");
      }
      throw error;
    } finally {
      await Promise.all([
        fs.rm(prepared.stagingDir, { recursive: true, force: true }).catch(() => undefined),
        ...(rollbackFailed ? [] : [fs.rm(rollback.directory, { recursive: true, force: true }).catch(() => undefined)]),
      ]);
    }
  }

  private async runExport(operationId: string, request: ExportRequest, lease: DataMutationLease): Promise<void> {
    this.markRunning(operationId, "exporting", "Exporting full backup.");
    try {
      const result = await this.exportToBackupInternal(request, operationId);
      this.finishOperation(operationId, "succeeded", "Full backup exported.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Full backup export failed.", undefined, (error as Error).message);
    } finally {
      lease.release();
    }
  }

  private async runRestore(operationId: string, request: RestoreRequest, lease: DataMutationLease): Promise<void> {
    this.markRunning(operationId, "restoring", "Restoring full backup.");
    try {
      const result = await this.restoreFromBackupInternal(request, operationId);
      this.finishOperation(operationId, "succeeded", "Full backup restored.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Full backup restore failed.", undefined, (error as Error).message);
    } finally {
      lease.release();
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
    const artifactEntries = await this.retainedArtifactEntries(data);
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
    entries.push(jsonArchiveEntry(DATA_ENTRY, portableBackupData(data)));
    entries.push(...browserDataEntries.entries);
    entries.push(...extensionEntries.entries);
    entries.push(...artifactEntries);
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
      const directory = extension.localPath
        ?? (extension.provenance?.artifact.retained ? undefined : path.join(this.options.extensionCacheDir, extension.id));
      if (!directory || !(await pathExists(directory))) {
        if (extension.installState === "installed") warnings.push(`Extension files not found for ${extension.name}.`);
        continue;
      }
      count += 1;
      entries.push(...await directoryArchiveEntries(directory, `extensions/${extension.id}`));
    }
    return { count, entries };
  }

  private async retainedArtifactEntries(data: AppBackupData): Promise<ArchiveEntry[]> {
    const extensionById = new Map(data.extensions.map((extension) => [extension.id, extension]));
    const entries: ArchiveEntry[] = [];
    for (const artifact of data.retainedExtensionArtifacts) {
      const extension = extensionById.get(artifact.extensionId);
      if (!extension) throw backupInvalid("Retained extension artifact references an unknown extension.");
      const canonicalPath = path.join(this.extensionArtifactDir, extension.id, "current.crx");
      if (extension.artifactArchivePath !== canonicalPath || extension.sourceUrl !== canonicalPath) {
        throw backupInvalid(`Retained extension path is not canonical for ${extension.name}.`);
      }
      const stats = await fs.lstat(canonicalPath).catch(() => undefined);
      if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
        throw backupInvalid(`Retained extension artifact is missing or linked for ${extension.name}.`);
      }
      const fingerprint = await sha256File(canonicalPath);
      if (fingerprint !== artifact.sha256 || fingerprint !== extension.provenance?.artifact.sha256) {
        throw backupInvalid(`Retained extension artifact fingerprint changed for ${extension.name}.`);
      }
      const validationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-backup-artifact-verify-"));
      await validateTransferredExtensionArtifact({
        extension,
        artifactPath: canonicalPath,
        expectedSha256: artifact.sha256,
        validationDir: path.join(validationRoot, "unpacked"),
        unpackedRoot: extension.localPath,
        verifyFile: this.verifyStoreCrxFile,
        preflightPackage: this.preflightPackage,
      }).finally(() => fs.rm(validationRoot, { recursive: true, force: true }).catch(() => undefined));
      entries.push({ archivePath: artifact.archivePath, filePath: canonicalPath });
    }
    return entries;
  }

  private async prepareRestore(inputPath: string, operationId?: string): Promise<PreparedRestore> {
    this.setProgress(operationId, "extracting", 0, 1, "Extracting full backup.");
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-backup-restore-"));
    try {
      await extractZipArchive(inputPath, stagingDir, "App backup contains an unsafe path.");
      const manifest = parseManifest(await readJsonArchiveFile(path.join(stagingDir, MANIFEST_ENTRY), 1 * 1024 * 1024));
      const decodedData = parseBackupData(await readJsonArchiveFile(path.join(stagingDir, DATA_ENTRY), 16 * 1024 * 1024));
      validateManifestData(manifest, decodedData);
      const data = migrateBackupDataToCurrent(decodedData);
      const browserDataCount = await countExistingDirectories(data.environments.map((environment) => path.join(stagingDir, "browser-data", environment.id)));
      const extensionFileCount = await countExistingDirectories(data.extensions.map((extension) => path.join(stagingDir, "extensions", extension.id)));
      const warnings: string[] = [];
      if (manifest.counts.browserData > browserDataCount) {
        warnings.push("Backup metadata references browser data missing from the archive.");
      }
      if (manifest.counts.runtimeExtensions > extensionFileCount) {
        warnings.push("Backup metadata references extension files missing from the archive.");
      }
      await validateStagedRetainedArtifacts(
        data,
        stagingDir,
        this.verifyStoreCrxFile,
        this.preflightPackage,
      );
      const restoredData = await this.materializeRestoredExtensionPaths(data, stagingDir, warnings);
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

  private async materializeRestoredExtensionPaths(data: AppBackupData, stagingDir: string, warnings: string[]): Promise<AppBackupData> {
    const extensionPaths = new Map<string, string>();
    const retainedIds = new Set(data.retainedExtensionArtifacts.map((artifact) => artifact.extensionId));
    const extensions = data.extensions.map((extension) => {
      const stagedPath = path.join(stagingDir, "extensions", extension.id);
      const restoredPath = path.join(this.options.extensionCacheDir, extension.id);
      if (fsExistsSyncSafe(stagedPath)) {
        extensionPaths.set(extension.id, restoredPath);
        const hasRetainedArtifact = retainedIds.has(extension.id);
        const restoredDirectory = !hasRetainedArtifact;
        if (restoredDirectory && extension.localPath !== restoredPath) {
          // Re-homing into the cache severs a reference-mode dev link and changes the
          // path-derived browser ID, so extension data from before the backup is orphaned.
          warnings.push(
            `Extension ${extension.name} now loads from the restored cache copy instead of ${extension.localPath ?? extension.sourceUrl}.`,
          );
        }
        return {
          ...extension,
          sourceKind: restoredDirectory ? ("managed-snapshot" as const) : ("local-crx" as const),
          sourceUrl: restoredDirectory
            ? ""
            : path.join(this.extensionArtifactDir, extension.id, "current.crx"),
          localPath: restoredPath,
          artifactArchivePath: restoredDirectory
            ? undefined
            : path.join(this.extensionArtifactDir, extension.id, "current.crx"),
          provenance: !restoredDirectory && extension.provenance
            ? {
                ...extension.provenance,
                transfer: { kind: "full-backup-restore" as const, at: nowIso() },
              }
            : extension.provenance,
          directoryMode: undefined,
          installState: "installed" as const,
          lastError: undefined,
        };
      }
      if (retainedIds.has(extension.id)) {
        const artifactArchivePath = path.join(this.extensionArtifactDir, extension.id, "current.crx");
        return {
          ...extension,
          sourceKind: "local-crx" as const,
          sourceUrl: artifactArchivePath,
          artifactArchivePath,
          localPath: undefined,
          installState: "local-missing" as const,
          provenance: extension.provenance
            ? {
                ...extension.provenance,
                transfer: { kind: "full-backup-restore" as const, at: nowIso() },
              }
            : undefined,
          lastError: "Extension unpacked files are missing from the restored backup.",
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
    const extensionArtifactExisted = await pathExists(this.extensionArtifactDir);
    if (browserDataExisted) await fs.cp(this.options.browserDataDir, path.join(directory, "browser-data"), { recursive: true, force: false });
    if (extensionCacheExisted) await fs.cp(this.options.extensionCacheDir, path.join(directory, "extensions"), { recursive: true, force: false });
    if (extensionArtifactExisted) {
      await fs.cp(this.extensionArtifactDir, path.join(directory, "extension-artifacts"), { recursive: true, force: false });
    }
    return {
      data: await this.options.repository.exportFullBackupData(),
      directory,
      browserDataExisted,
      extensionCacheExisted,
      extensionArtifactExisted,
    };
  }

  private async restoreFilesystem(prepared: PreparedRestore, operationId?: string): Promise<void> {
    this.setProgress(operationId, "restoring-files", 0, 3, "Replacing browser data.");
    await replaceManagedDirectory(path.join(prepared.stagingDir, "browser-data"), this.options.browserDataDir);
    this.setProgress(operationId, "restoring-files", 1, 3, "Replacing extension files.");
    await replaceManagedDirectory(path.join(prepared.stagingDir, "extensions"), this.options.extensionCacheDir);
    this.setProgress(operationId, "restoring-files", 2, 3, "Replacing retained extension artifacts.");
    await replaceManagedDirectory(path.join(prepared.stagingDir, "extension-artifacts"), this.extensionArtifactDir);
    await fs.rm(
      this.options.extensionRuntimeDir ?? path.join(path.dirname(this.options.extensionCacheDir), "extension-runtimes"),
      { recursive: true, force: true },
    );
    this.setProgress(operationId, "restoring-files", 3, 3, "Runtime files restored.");
  }

  private async rollbackRestore(snapshot: RollbackSnapshot): Promise<void> {
    await rollbackDirectory(path.join(snapshot.directory, "browser-data"), this.options.browserDataDir, snapshot.browserDataExisted);
    await rollbackDirectory(path.join(snapshot.directory, "extensions"), this.options.extensionCacheDir, snapshot.extensionCacheExisted);
    await rollbackDirectory(
      path.join(snapshot.directory, "extension-artifacts"),
      this.extensionArtifactDir,
      snapshot.extensionArtifactExisted,
    );
    await this.options.repository.restoreFullBackupData(snapshot.data);
    this.options.settingsChanged?.(snapshot.data.settings);
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

function parseManifest(input: unknown): AnyAppBackupManifest {
  if (!isRecord(input)) throw Object.assign(new Error("Backup manifest must be an object."), { status: 400 });
  if (input.kind !== APP_BACKUP_KIND) throw Object.assign(new Error("Unsupported app backup kind."), { status: 400 });
  const counts = isRecord(input.counts) ? input.counts : {};
  const common = {
    kind: APP_BACKUP_KIND,
    exportedAt: readString(input.exportedAt, "manifest.exportedAt"),
    containsSecrets: true,
    containsBrowserData: input.containsBrowserData === true,
    containsExtensions: input.containsExtensions === true,
  } as const;
  const baseCounts = {
      profiles: readNumber(counts.profiles, "manifest.counts.profiles"),
      environments: readNumber(counts.environments, "manifest.counts.environments"),
      trashEnvironments: readNumber(counts.trashEnvironments, "manifest.counts.trashEnvironments"),
      browserData: readNumber(counts.browserData, "manifest.counts.browserData"),
      groups: readNumber(counts.groups, "manifest.counts.groups"),
      tags: readNumber(counts.tags, "manifest.counts.tags"),
      proxies: readNumber(counts.proxies, "manifest.counts.proxies"),
      extensions: readNumber(counts.extensions, "manifest.counts.extensions"),
      runtimeExtensions: readNumber(counts.runtimeExtensions, "manifest.counts.runtimeExtensions"),
  };
  if (input.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V1) {
    return {
      ...common,
      schemaVersion: APP_BACKUP_SCHEMA_VERSION_V1,
      counts: {
        ...baseCounts,
      extensionSources: readNumber(counts.extensionSources, "manifest.counts.extensionSources"),
      },
    } satisfies AppBackupManifestV1;
  }
  if (input.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V2) {
    return {
      ...common,
      schemaVersion: APP_BACKUP_SCHEMA_VERSION_V2,
      counts: {
        ...baseCounts,
        retainedExtensionArtifacts: readNumber(
          counts.retainedExtensionArtifacts,
          "manifest.counts.retainedExtensionArtifacts",
        ),
      },
    } satisfies AppBackupManifestV2;
  }
  throw Object.assign(new Error("Unsupported app backup schema version."), { status: 400 });
}

function parseBackupData(input: unknown): AnyAppBackupData {
  return decodeAppBackupData(input);
}

function migrateBackupDataToCurrent(data: AnyAppBackupData): AppBackupData {
  const current: AppBackupData = data.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V2
    ? data
    : {
    schemaVersion: APP_BACKUP_SCHEMA_VERSION_V2,
    settings: data.settings,
    profiles: data.profiles,
    environments: data.environments,
    groups: data.groups,
    tags: data.tags,
    proxies: data.proxies,
    extensions: data.extensions.map(migrateLegacyBackupExtension),
    retainedExtensionArtifacts: [],
    environmentExtensionBindings: data.environmentExtensionBindings,
  };
  return {
    ...current,
    profiles: current.profiles.map(withoutSerializedExtensionPaths),
    environments: current.environments.map((environment) => ({
      ...environment,
      runtimeProfile: withoutSerializedExtensionPaths(environment.runtimeProfile),
    })),
    extensions: current.extensions.map(sanitizeTransferredExtension),
  };
}

function migrateLegacyBackupExtension(extension: LegacyTransferExtension): ExtensionEntity {
  const remote = extension.sourceKind === "remote-zip"
    || extension.sourceKind === "remote-crx"
    || Boolean(extension.sourceId);
  if (!remote) return { ...extension };
  const format = extension.sourceKind === "remote-zip" ? "zip" : "unknown";
  return {
    ...extension,
    sourceKind: "managed-snapshot",
    sourceUrl: "",
    sourceId: undefined,
    updatePolicy: "pinned",
    artifactArchivePath: undefined,
    updateProviderId: undefined,
    updateState: { status: "provider-disabled" },
    provenance: {
      schemaVersion: 1,
      artifact: {
        providerId: "legacy",
        legacySourceUrl: extension.sourceUrl || undefined,
        format,
        sha256: extension.sha256,
        retained: false,
      },
      verification: {
        level: "legacy-unknown",
        manifestSha256: extension.manifestSha256,
      },
    },
  };
}

function portableBackupData(data: AppBackupData): AppBackupData {
  return {
    ...data,
    profiles: data.profiles.map(withoutSerializedExtensionPaths),
    environments: data.environments.map((environment) => ({
      ...environment,
      runtimeProfile: withoutSerializedExtensionPaths(environment.runtimeProfile),
    })),
    extensions: data.extensions.map(sanitizeTransferredExtension),
  };
}

function sanitizeTransferredExtension(extension: ExtensionEntity): ExtensionEntity {
  if (extension.provenance?.artifact.retained) {
    const archivePath = `extension-artifacts/${extension.id}/current.crx`;
    return {
      ...extension,
      sourceKind: "local-crx",
      sourceUrl: archivePath,
      sourceId: undefined,
      artifactArchivePath: archivePath,
      localPath: undefined,
      directoryMode: undefined,
    };
  }
  const hadRemoteAuthority = extension.sourceKind === "remote-zip"
    || extension.sourceKind === "remote-crx"
    || Boolean(extension.sourceId)
    || Boolean(extension.updateProviderId)
    || Boolean(extension.provenance?.artifact.legacySourceUrl);
  return {
    ...extension,
    sourceKind: "managed-snapshot",
    sourceUrl: "",
    sourceId: undefined,
    artifactArchivePath: undefined,
    updateProviderId: undefined,
    updateState: hadRemoteAuthority ? { status: "provider-disabled" } : undefined,
    updatePolicy: "pinned",
    localPath: undefined,
    directoryMode: undefined,
  };
}

function withoutSerializedExtensionPaths(profile: BrowserProfile): BrowserProfile {
  return {
    ...profile,
    runtime: {
      ...profile.runtime,
      extensionPaths: [],
    },
  };
}

function validateManifestData(manifest: AnyAppBackupManifest, data: AnyAppBackupData): void {
  if (manifest.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V1) {
    if (data.schemaVersion !== APP_BACKUP_SCHEMA_VERSION_V1) throw schemaVersionMismatch();
    const counts = backupCountsForDecoded(
      data,
      manifest.counts.browserData,
      manifest.counts.runtimeExtensions,
    ) as AppBackupManifestV1["counts"];
    for (const key of ["profiles", "environments", "trashEnvironments", "groups", "tags", "proxies", "extensions", "extensionSources"] as const) {
      if (manifest.counts[key] !== counts[key]) throw backupCountMismatch(key);
    }
    return;
  }
  if (data.schemaVersion !== APP_BACKUP_SCHEMA_VERSION_V2) throw schemaVersionMismatch();
  const counts = backupCountsForDecoded(
    data,
    manifest.counts.browserData,
    manifest.counts.runtimeExtensions,
  ) as AppBackupManifestV2["counts"];
  for (const key of ["profiles", "environments", "trashEnvironments", "groups", "tags", "proxies", "extensions", "retainedExtensionArtifacts"] as const) {
    if (manifest.counts[key] !== counts[key]) throw backupCountMismatch(key);
  }
}

function schemaVersionMismatch(): Error {
  return Object.assign(new Error("Backup manifest and data schema versions disagree."), { status: 400 });
}

function backupCountMismatch(key: string): Error {
  return Object.assign(new Error(`Backup ${key} count does not match manifest.`), { status: 400 });
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
    retainedExtensionArtifacts: data.retainedExtensionArtifacts.length,
    runtimeExtensions,
  };
}

function backupCountsForDecoded(
  data: AnyAppBackupData,
  browserData: number,
  runtimeExtensions: number,
): AppBackupManifestV1["counts"] | AppBackupManifestV2["counts"] {
  const base = {
    profiles: data.profiles.length,
    environments: data.environments.filter((environment) => !environment.deletedAt).length,
    trashEnvironments: data.environments.filter((environment) => Boolean(environment.deletedAt)).length,
    browserData,
    groups: data.groups.length,
    tags: data.tags.length,
    proxies: data.proxies.length,
    extensions: data.extensions.length,
    runtimeExtensions,
  };
  return data.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V1
    ? { ...base, extensionSources: data.extensionSources.length }
    : { ...base, retainedExtensionArtifacts: data.retainedExtensionArtifacts.length };
}

async function countExistingDirectories(paths: string[]): Promise<number> {
  let count = 0;
  for (const itemPath of paths) {
    if (await pathExists(itemPath)) count += 1;
  }
  return count;
}

async function validateStagedRetainedArtifacts(
  data: AppBackupData,
  stagingDir: string,
  verifyFile: typeof verifyChromeWebStoreCrx3File,
  preflightPackage: typeof preflightExtensionPackage,
): Promise<void> {
  const extensionById = new Map(data.extensions.map((extension) => [extension.id, extension]));
  for (const artifact of data.retainedExtensionArtifacts) {
    const extension = extensionById.get(artifact.extensionId);
    if (!extension?.storeIdentity || !extension.provenance || !extension.manifestKey) {
      throw backupInvalid(`Retained extension evidence is incomplete for ${artifact.extensionId}.`);
    }
    if (extension.artifactArchivePath !== artifact.archivePath || extension.sourceUrl !== artifact.archivePath) {
      throw backupInvalid(`Retained extension path disagrees with its portable archive entry for ${artifact.extensionId}.`);
    }
    const stagedPath = path.join(stagingDir, ...artifact.archivePath.split("/"));
    const stats = await fs.lstat(stagedPath).catch(() => undefined);
    if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
      throw backupInvalid(`Retained extension artifact is missing or linked for ${artifact.extensionId}.`);
    }
    if (await sha256File(stagedPath) !== artifact.sha256) {
      throw backupInvalid(`Retained extension artifact fingerprint is invalid for ${artifact.extensionId}.`);
    }
    const validationDir = path.join(stagingDir, ".artifact-validation", artifact.extensionId);
    const unpackedRoot = path.join(stagingDir, "extensions", extension.id);
    await validateTransferredExtensionArtifact({
      extension,
      artifactPath: stagedPath,
      expectedSha256: artifact.sha256,
      validationDir,
      unpackedRoot: await pathExists(unpackedRoot) ? unpackedRoot : undefined,
      verifyFile,
      preflightPackage,
    });
  }
}

async function sha256File(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function backupInvalid(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "APP_BACKUP_SCHEMA_INVALID" });
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
