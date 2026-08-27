import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import {
  PRESERVE_LIFECYCLE_REVISION_PREFIX,
  isPreserveLifecycleRevision,
  type BrowserEnvironment,
  type ExtensionEntity,
  type GroupEntity,
} from "../../src/shared/entities";
import {
  ENVIRONMENT_PACKAGE_KIND,
  ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
  ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1,
  ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2,
  decodeEnvironmentPackageData,
  type AnyEnvironmentPackageData,
  type AnyEnvironmentPackageManifest,
  type EnvironmentPackageCounts,
  type EnvironmentPackageData,
  type EnvironmentPackageManifest,
  type EnvironmentPackageManifestV1,
  type EnvironmentPackageManifestV2,
  type EnvironmentPackageOperation,
  type EnvironmentPackageOperationResult,
  type EnvironmentPackageScope,
} from "../../src/shared/environmentPackage";
import { createId, nowIso, proxyUrlFromParts } from "../../src/shared/profile";
import type { PanelRepository } from "../storage/types";
import {
  type ArchiveEntry,
  copyDirectory,
  directoryArchiveEntries,
  extractZipArchive,
  jsonArchiveEntry,
  pathExists,
  readJsonArchiveFile,
  writeZipArchive,
} from "./archiveUtils";
import {
  DataMutationCoordinator,
  type DataMutationLease,
} from "./dataMutationCoordinator";
import { verifyChromeWebStoreCrx3File } from "./crx3Verifier";
import { preflightExtensionPackage } from "./extensionPackagePreflight";
import { validateTransferredExtensionArtifact } from "./extensionArtifactTransferVerifier";
import { fingerprintStagedExtensionTree } from "./boundedZipAnalyzer";
import { retireLegacyTransferredExtension } from "./extensionSourceRetirementMigration";

type EnvironmentPackageServiceOptions = {
  repository: PanelRepository;
  browserDataDir: string;
  extensionCacheDir: string;
  extensionArtifactDir?: string;
  activeEnvironmentIds: () => Set<string>;
  mutationCoordinator?: DataMutationCoordinator;
  verifyStoreCrxFileForTesting?: typeof verifyChromeWebStoreCrx3File;
  preflightPackageForTesting?: typeof preflightExtensionPackage;
};

type ExportRequest = {
  environmentIds?: string[];
  outputPath: string;
};

type ImportRequest = {
  inputPath: string;
};

type PreparedImport = {
  data: EnvironmentPackageData;
  stagingDir: string;
  environmentIdMap: Record<string, string>;
  extensionIdMap: Record<string, string>;
  reusedExtensionIds: string[];
  extensionLocalPaths: Record<string, string>;
  extensionArtifactPaths: Record<string, string>;
  extensionManifestKeys: Record<string, string>;
  counts: EnvironmentPackageCounts;
  warnings: string[];
};

const MANIFEST_ENTRY = "manifest.json";
const DATA_ENTRY = "data.json";

export class EnvironmentPackageService {
  private readonly operations = new Map<string, EnvironmentPackageOperation>();

  private readonly mutationCoordinator: DataMutationCoordinator;

  private readonly extensionArtifactDir: string;

  private readonly verifyStoreCrxFile: typeof verifyChromeWebStoreCrx3File;

  private readonly preflightPackage: typeof preflightExtensionPackage;

  constructor(private readonly options: EnvironmentPackageServiceOptions) {
    this.mutationCoordinator = options.mutationCoordinator ?? new DataMutationCoordinator();
    this.extensionArtifactDir = options.extensionArtifactDir
      ?? path.join(path.dirname(path.resolve(options.extensionCacheDir)), "extension-artifacts");
    this.verifyStoreCrxFile = options.verifyStoreCrxFileForTesting ?? verifyChromeWebStoreCrx3File;
    this.preflightPackage = options.preflightPackageForTesting ?? preflightExtensionPackage;
  }

  startExport(request: ExportRequest): EnvironmentPackageOperation {
    const lease = this.mutationCoordinator.enter("environment-package");
    const operation = this.createOperation("export", "queued", "Preparing environment export.");
    void this.runExport(operation.id, request, lease);
    return operation;
  }

  startImport(request: ImportRequest): EnvironmentPackageOperation {
    const lease = this.mutationCoordinator.enter("environment-package");
    const operation = this.createOperation("import", "queued", "Preparing environment import.");
    void this.runImport(operation.id, request, lease);
    return operation;
  }

  getOperation(id: string): EnvironmentPackageOperation | undefined {
    return this.operations.get(id);
  }

  hasOperationInFlight(): boolean {
    return [...this.operations.values()].some((operation) =>
      operation.status === "queued" || operation.status === "running");
  }

  /**
   * Whether an import may already have copied browser data into place. `importFromPackage` copies every
   * `browser-data/<new id>` before `importEnvironmentPackage` writes the rows that name them, so in that
   * window the copies are indistinguishable from orphans and a browser-data prune deletes the data the
   * import is still assembling. The prune route reads this to refuse.
   *
   * Exports are deliberately absent: they only read, and only the directories registered environments
   * name, which a prune never considers a candidate.
   */
  hasImportInFlight(): boolean {
    return [...this.operations.values()].some((operation) =>
      operation.type === "import" && (operation.status === "queued" || operation.status === "running"));
  }

  async exportToPackage(request: ExportRequest, operationId?: string): Promise<EnvironmentPackageOperationResult> {
    const lease = this.mutationCoordinator.enter("environment-package");
    try {
      return await this.exportToPackageInternal(request, operationId);
    } finally {
      lease.release();
    }
  }

  private async exportToPackageInternal(request: ExportRequest, operationId?: string): Promise<EnvironmentPackageOperationResult> {
    const outputPath = ensurePackageExtension(path.resolve(request.outputPath));
    const environments = await this.targetEnvironments(request.environmentIds);
    this.assertNoActiveEnvironment(environments);
    const scope: EnvironmentPackageScope = request.environmentIds?.length ? "selected" : "all";
    const prepared = await this.buildExportEntries(environments, scope, operationId);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await writeZipArchive(outputPath, prepared.entries, (current, total, archivePath) => {
      this.setProgress(operationId, "writing", current, total, `Writing ${archivePath}.`);
    });
    this.setProgress(operationId, "finalizing", prepared.entries.length, prepared.entries.length, "Environment package written.");
    return {
      outputPath,
      counts: prepared.manifest.counts,
      warnings: prepared.warnings,
    };
  }

  async importFromPackage(request: ImportRequest, operationId?: string): Promise<EnvironmentPackageOperationResult> {
    const lease = this.mutationCoordinator.enter("environment-package");
    try {
      return await this.importFromPackageInternal(request, operationId);
    } finally {
      lease.release();
    }
  }

  private async importFromPackageInternal(request: ImportRequest, operationId?: string): Promise<EnvironmentPackageOperationResult> {
    const inputPath = path.resolve(request.inputPath);
    const prepared = await this.prepareImport(inputPath, operationId);
    const copiedEnvironmentIds: string[] = [];
    const copiedExtensionIds: string[] = [];
    const copiedArtifactIds: string[] = [];
    try {
      const reusedExtensionIds = new Set(prepared.reusedExtensionIds);
      for (const [oldExtensionId, newExtensionId] of Object.entries(prepared.extensionIdMap)) {
        if (reusedExtensionIds.has(newExtensionId)) continue;
        const sourcePath = path.join(prepared.stagingDir, "extensions", oldExtensionId);
        if (!(await pathExists(sourcePath))) continue;
        const targetPath = path.join(this.options.extensionCacheDir, newExtensionId);
        this.setProgress(operationId, "copying-extensions", copiedExtensionIds.length + 1, Object.keys(prepared.extensionIdMap).length, `Restoring extension ${oldExtensionId}.`);
        const targetExisted = await pathExists(targetPath);
        try {
          await copyDirectory(sourcePath, targetPath);
        } catch (error) {
          if (!targetExisted) await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        prepared.extensionLocalPaths[oldExtensionId] = targetPath;
        copiedExtensionIds.push(newExtensionId);
      }

      for (const artifact of prepared.data.retainedExtensionArtifacts) {
        const newExtensionId = prepared.extensionIdMap[artifact.extensionId];
        if (!newExtensionId || reusedExtensionIds.has(newExtensionId)) continue;
        const sourcePath = path.join(prepared.stagingDir, ...artifact.archivePath.split("/"));
        if (!(await pathExists(sourcePath))) throw packageInvalid(`Retained artifact is missing for ${artifact.extensionId}.`);
        const targetPath = path.join(this.extensionArtifactDir, newExtensionId, "current.crx");
        const targetExisted = await pathExists(targetPath);
        if (targetExisted) {
          throw Object.assign(new Error("Environment package artifact target already exists."), {
            status: 409,
            code: "ENVIRONMENT_PACKAGE_TARGET_EXISTS",
          });
        }
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        try {
          await fs.copyFile(sourcePath, targetPath);
        } catch (error) {
          if (!targetExisted) await fs.rm(targetPath, { force: true }).catch(() => undefined);
          throw error;
        }
        prepared.extensionArtifactPaths[artifact.extensionId] = targetPath;
        copiedArtifactIds.push(newExtensionId);
      }

      for (const [oldEnvironmentId, newEnvironmentId] of Object.entries(prepared.environmentIdMap)) {
        const sourcePath = path.join(prepared.stagingDir, "browser-data", oldEnvironmentId);
        if (!(await pathExists(sourcePath))) continue;
        const targetPath = path.join(this.options.browserDataDir, newEnvironmentId);
        this.setProgress(operationId, "copying-browser-data", copiedEnvironmentIds.length + 1, Object.keys(prepared.environmentIdMap).length, `Restoring browser data ${oldEnvironmentId}.`);
        const targetExisted = await pathExists(targetPath);
        try {
          await copyDirectory(sourcePath, targetPath);
        } catch (error) {
          if (!targetExisted) await fs.rm(targetPath, { recursive: true, force: true }).catch(() => undefined);
          throw error;
        }
        copiedEnvironmentIds.push(newEnvironmentId);
      }

      this.setProgress(operationId, "importing-database", 0, prepared.data.environments.length, "Writing imported environments.");
      const restoredBrowserState = new Set(copiedEnvironmentIds);
      const importedBindings = (prepared.data.environmentExtensionBindings ?? []).map((binding) => {
        const hasRestoredBrowserState = restoredBrowserState.has(prepared.environmentIdMap[binding.environmentId] ?? "");
        const reusesLocalPackage = reusedExtensionIds.has(prepared.extensionIdMap[binding.extensionId] ?? "");
        return {
          ...binding,
          // The imported browser state describes the exported package revision, while a reused local
          // entity may have an unrelated reinstall timestamp. Give that pair a fresh, persistent token
          // whose prefix asks the first protected launch to adopt the existing browser state. A null/
          // "legacy" revision cannot express a second import after the stored state is already legacy.
          lifecycleRevision: hasRestoredBrowserState && reusesLocalPackage
            ? `${PRESERVE_LIFECYCLE_REVISION_PREFIX}${createId("binding")}`
            // A preserve token exported without its browser state must not suppress this genuinely new
            // installation. Rebase it to an ordinary new binding revision.
            : !hasRestoredBrowserState && isPreserveLifecycleRevision(binding.lifecycleRevision)
              ? createId("binding")
              : binding.lifecycleRevision,
        };
      });
      const importedBindingPairs = new Set(importedBindings.map((binding) =>
        `${binding.environmentId}\0${binding.extensionId}`));
      // Old packages omitted binding metadata. Reused extensions still need an explicit token: otherwise
      // a copied browser profile whose stored lifecycle state is already "legacy" cannot distinguish this
      // import's one-time preserve rebase from an actual package update.
      for (const environment of prepared.data.environments) {
        for (const extensionId of environment.extensionIds) {
          const mappedExtensionId = prepared.extensionIdMap[extensionId];
          const pair = `${environment.id}\0${extensionId}`;
          const hasRestoredBrowserState = restoredBrowserState.has(prepared.environmentIdMap[environment.id] ?? "");
          if (!hasRestoredBrowserState || !reusedExtensionIds.has(mappedExtensionId ?? "") || importedBindingPairs.has(pair)) continue;
          importedBindings.push({
            environmentId: environment.id,
            extensionId,
            lifecycleRevision: `${PRESERVE_LIFECYCLE_REVISION_PREFIX}${createId("binding")}`,
          });
          importedBindingPairs.add(pair);
        }
      }
      const imported = await this.options.repository.importEnvironmentPackage({
        ...prepared.data,
        environmentExtensionBindings: importedBindings,
        environmentIdMap: prepared.environmentIdMap,
        extensionIdMap: prepared.extensionIdMap,
        extensionLocalPaths: prepared.extensionLocalPaths,
        extensionArtifactPaths: prepared.extensionArtifactPaths,
        extensionManifestKeys: prepared.extensionManifestKeys,
      });
      this.setProgress(operationId, "finalizing", prepared.data.environments.length, prepared.data.environments.length, "Environment import completed.");
      return {
        inputPath,
        counts: prepared.counts,
        warnings: prepared.warnings,
        idMap: imported.idMap,
      };
    } catch (error) {
      await Promise.all([
        ...copiedEnvironmentIds.map((id) => fs.rm(path.join(this.options.browserDataDir, id), { recursive: true, force: true })),
        ...copiedExtensionIds.map((id) => fs.rm(path.join(this.options.extensionCacheDir, id), { recursive: true, force: true })),
        ...copiedArtifactIds.map((id) => fs.rm(path.join(this.extensionArtifactDir, id), { recursive: true, force: true })),
      ]);
      throw error;
    } finally {
      await fs.rm(prepared.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runExport(operationId: string, request: ExportRequest, lease: DataMutationLease): Promise<void> {
    this.markRunning(operationId, "exporting", "Exporting environment package.");
    try {
      const result = await this.exportToPackageInternal(request, operationId);
      this.finishOperation(operationId, "succeeded", "Environment package exported.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Environment package export failed.", undefined, (error as Error).message);
    } finally {
      lease.release();
    }
  }

  private async runImport(operationId: string, request: ImportRequest, lease: DataMutationLease): Promise<void> {
    this.markRunning(operationId, "importing", "Importing environment package.");
    try {
      const result = await this.importFromPackageInternal(request, operationId);
      this.finishOperation(operationId, "succeeded", "Environment package imported.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Environment package import failed.", undefined, (error as Error).message);
    } finally {
      lease.release();
    }
  }

  private async targetEnvironments(environmentIds: string[] | undefined): Promise<BrowserEnvironment[]> {
    const all = await this.options.repository.listEnvironments();
    if (!environmentIds || environmentIds.length === 0) return all;
    const requested = new Set(environmentIds.map((id) => id.trim()).filter(Boolean));
    const selected = all.filter((environment) => requested.has(environment.id));
    if (selected.length !== requested.size) {
      throw Object.assign(new Error("Some selected environments do not exist or are not active."), { status: 404 });
    }
    return selected;
  }

  private assertNoActiveEnvironment(environments: BrowserEnvironment[]): void {
    const activeIds = this.options.activeEnvironmentIds();
    const blocked = environments.filter((environment) => activeIds.has(environment.id));
    if (blocked.length === 0) return;
    const names = blocked.map((environment) => environment.name).slice(0, 5).join(", ");
    throw Object.assign(new Error(`Stop running environments before export: ${names}`), { status: 409 });
  }

  private async buildExportEntries(environments: BrowserEnvironment[], scope: EnvironmentPackageScope, operationId?: string): Promise<{
    entries: ArchiveEntry[];
    manifest: EnvironmentPackageManifest;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const groups = await this.exportGroups(environments);
    const extensions = await this.exportExtensions(environments);
    const environmentExtensionBindings = (await Promise.all(
      environments.map((environment) => this.options.repository.listEnvironmentExtensionBindings(environment.id)),
    )).flat();
    const exportedEnvironments = await this.materializeEnvironmentDependencies(environments);
    const entries: ArchiveEntry[] = [];
    const browserDataEntries = await this.browserDataEntries(exportedEnvironments, warnings);
    const extensionEntries = await this.extensionEntries(extensions, warnings);
    const retainedArtifacts = await this.retainedArtifactEntries(extensions);
    const manifest: EnvironmentPackageManifest = {
      kind: ENVIRONMENT_PACKAGE_KIND,
      schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
      exportedAt: nowIso(),
      scope,
      containsSecrets: true,
      containsBrowserData: browserDataEntries.count > 0,
      containsExtensions: extensionEntries.count > 0,
      counts: {
        environments: exportedEnvironments.length,
        browserData: browserDataEntries.count,
        groups: groups.length,
        extensions: extensions.length,
        retainedExtensionArtifacts: retainedArtifacts.data.length,
      },
    };
    const data: EnvironmentPackageData = {
      schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
      environments: exportedEnvironments,
      groups,
      extensions,
      retainedExtensionArtifacts: retainedArtifacts.data,
      environmentExtensionBindings,
    };
    entries.push(jsonArchiveEntry(MANIFEST_ENTRY, manifest));
    entries.push(jsonArchiveEntry(DATA_ENTRY, portablePackageData(data)));
    entries.push(...browserDataEntries.entries);
    entries.push(...extensionEntries.entries);
    entries.push(...retainedArtifacts.entries);
    this.setProgress(operationId, "collecting", entries.length, entries.length, "Collected environment package entries.");
    return { entries, manifest, warnings };
  }

  private async exportGroups(environments: BrowserEnvironment[]): Promise<GroupEntity[]> {
    const groupIds = new Set(environments.map((environment) => environment.groupId));
    return (await this.options.repository.listGroups()).filter((group) => groupIds.has(group.id));
  }

  private async exportExtensions(environments: BrowserEnvironment[]): Promise<ExtensionEntity[]> {
    const extensionIds = new Set(environments.flatMap((environment) => environment.extensionIds));
    return (await this.options.repository.listExtensions()).filter((extension) => extensionIds.has(extension.id));
  }

  private async materializeEnvironmentDependencies(environments: BrowserEnvironment[]): Promise<BrowserEnvironment[]> {
    const proxies = new Map((await this.options.repository.listProxies({ includeSecrets: true })).map((proxy) => [proxy.id, proxy]));
    return environments.map((environment) => {
      const proxy = environment.proxyId ? proxies.get(environment.proxyId) : undefined;
      const runtimeProfile = proxy
        ? {
            ...environment.runtimeProfile,
            proxy: {
              enabled: proxy.status === "enabled",
              raw: "",
              scheme: proxy.scheme,
              host: proxy.host,
              port: proxy.port,
              username: proxy.username,
              password: proxy.password,
              bypass: proxy.bypass,
            },
            runtime: {
              ...environment.runtimeProfile.runtime,
              extensionPaths: [],
            },
          }
        : {
            ...environment.runtimeProfile,
            runtime: {
              ...environment.runtimeProfile.runtime,
              extensionPaths: [],
            },
          };
      if (proxy) {
        runtimeProfile.proxy.raw = proxyUrlFromParts(runtimeProfile.proxy);
      }
      return {
        ...environment,
        proxyId: undefined,
        runtimeProfile,
      };
    });
  }

  private async browserDataEntries(environments: BrowserEnvironment[], warnings: string[]): Promise<{ count: number; entries: ArchiveEntry[] }> {
    const entries: ArchiveEntry[] = [];
    let count = 0;
    for (const environment of environments) {
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
        warnings.push(`Extension files not found for ${extension.name}.`);
        continue;
      }
      count += 1;
      entries.push(...await directoryArchiveEntries(directory, `extensions/${extension.id}`));
    }
    return { count, entries };
  }

  private async retainedArtifactEntries(extensions: ExtensionEntity[]): Promise<{
    data: EnvironmentPackageData["retainedExtensionArtifacts"];
    entries: ArchiveEntry[];
  }> {
    const data: EnvironmentPackageData["retainedExtensionArtifacts"] = [];
    const entries: ArchiveEntry[] = [];
    for (const extension of extensions) {
      if (!extension.provenance?.artifact.retained) continue;
      const canonicalPath = path.join(this.extensionArtifactDir, extension.id, "current.crx");
      if (extension.artifactArchivePath !== canonicalPath || extension.sourceUrl !== canonicalPath) {
        throw packageInvalid(`Retained artifact path is not canonical for ${extension.name}.`);
      }
      const artifactStats = await fs.lstat(canonicalPath).catch(() => undefined);
      if (!artifactStats?.isFile() || artifactStats.isSymbolicLink() || artifactStats.nlink !== 1) {
        throw packageInvalid(`Retained artifact is missing or linked for ${extension.name}.`);
      }
      const fingerprint = await sha256File(canonicalPath).catch(() => undefined);
      if (!fingerprint || fingerprint !== extension.provenance.artifact.sha256) {
        throw packageInvalid(`Retained artifact fingerprint changed for ${extension.name}.`);
      }
      const validationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-package-artifact-verify-"));
      await validateTransferredExtensionArtifact({
        extension,
        artifactPath: canonicalPath,
        expectedSha256: fingerprint,
        validationDir: path.join(validationRoot, "unpacked"),
        unpackedRoot: extension.localPath && await pathExists(extension.localPath)
          ? extension.localPath
          : undefined,
        verifyFile: this.verifyStoreCrxFile,
        preflightPackage: this.preflightPackage,
      }).finally(() => fs.rm(validationRoot, { recursive: true, force: true }).catch(() => undefined));
      const archivePath = `extension-artifacts/${extension.id}/current.crx`;
      data.push({ extensionId: extension.id, archivePath, sha256: fingerprint });
      entries.push({ archivePath, filePath: canonicalPath });
    }
    return { data, entries };
  }

  private async prepareImport(inputPath: string, operationId?: string): Promise<PreparedImport> {
    this.setProgress(operationId, "extracting", 0, 1, "Extracting environment package.");
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-environment-import-"));
    try {
      await extractZipArchive(inputPath, stagingDir, "Environment package contains an unsafe path.");
      const manifest = parseManifest(await readJsonArchiveFile(path.join(stagingDir, MANIFEST_ENTRY), 1 * 1024 * 1024));
      const decoded = parsePackageData(await readJsonArchiveFile(path.join(stagingDir, DATA_ENTRY), 16 * 1024 * 1024));
      validateManifestData(manifest, decoded);
      const data = migratePackageDataToCurrent(decoded);
      await validateStagedRetainedArtifacts(
        data,
        stagingDir,
        this.verifyStoreCrxFile,
        this.preflightPackage,
      );
      const environmentIdMap = Object.fromEntries(data.environments.map((environment) => [environment.id, createId()]));
      const { extensionIdMap, reusedExtensionIds, warnings: identityWarnings } =
        await this.resolveExtensionIdMap(data.extensions, stagingDir);
      validatePackageExtensionReferences(data);
      const browserDataCount = await countExistingDirectories(
        data.environments.map((environment) => path.join(stagingDir, "browser-data", environment.id)),
      );
      const extensionFileCount = await countExistingDirectories(
        data.extensions.map((extension) => path.join(stagingDir, "extensions", extension.id)),
      );
      this.setProgress(operationId, "validating", data.environments.length, data.environments.length, "Validated environment package.");
      const warnings = [...identityWarnings];
      if (manifest.counts.browserData > browserDataCount) {
        warnings.push("Package metadata references browser data that is missing from the archive.");
      }
      if (data.extensions.length > extensionFileCount) {
        warnings.push("Package metadata references extension files that are missing from the archive.");
      }
      return {
        data,
        stagingDir,
        environmentIdMap,
        extensionIdMap,
        reusedExtensionIds,
        extensionLocalPaths: {},
        extensionArtifactPaths: {},
        extensionManifestKeys: await readPackageManifestKeys(data.extensions, stagingDir),
        counts: {
          environments: data.environments.length,
          browserData: browserDataCount,
          groups: data.groups.length,
          extensions: data.extensions.length,
          retainedExtensionArtifacts: data.retainedExtensionArtifacts.length,
        },
        warnings,
      };
    } catch (error) {
      await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private createOperation(type: "export" | "import", phase: string, message: string): EnvironmentPackageOperation {
    const timestamp = nowIso();
    const operation: EnvironmentPackageOperation = {
      id: createId("environment-package-operation"),
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

  private async resolveExtensionIdMap(extensions: ExtensionEntity[], stagingDir: string): Promise<{
    extensionIdMap: Record<string, string>;
    reusedExtensionIds: string[];
    warnings: string[];
  }> {
    const installed: Array<{ extension: ExtensionEntity; diskManifestKey: string }> = [];
    for (const extension of await this.options.repository.listExtensions()) {
      if (extension.installState !== "installed" || !extension.localPath) continue;
      if (!(await pathExists(extension.localPath))) continue;
      const diskManifestKey = await readManifestKey(extension.localPath);
      if (!diskManifestKey) continue;
      const current = extension.manifestKey
        ? extension
        : { ...extension, manifestKey: diskManifestKey };
      if (current.manifestKey !== diskManifestKey) continue;
      installed.push({ extension: current, diskManifestKey });
    }
    const bySha = new Map(installed
      .filter(({ extension }) => extension.sha256)
      .map((candidate) => [candidate.extension.sha256 as string, candidate]));
    const byStoreVersion = new Map(installed
      .filter(({ extension }) => extension.storeId)
      .map((candidate) => [`${candidate.extension.storeId}:${candidate.extension.version}`, candidate]));
    const extensionIdMap: Record<string, string> = {};
    const reusedExtensionIds: string[] = [];
    const warnings: string[] = [];

    for (const extension of extensions) {
      const packageDiskManifestKey = await readManifestKey(path.join(stagingDir, "extensions", extension.id));
      const candidate = extension.sha256
        ? bySha.get(extension.sha256)
        : extension.storeId
          ? byStoreVersion.get(`${extension.storeId}:${extension.version}`)
          : undefined;
      // Portable reuse is an identity decision, not merely a package-content match. Require the archive
      // entity, archive bytes, local entity and local bytes to agree on one nonempty browser key.
      let sameTree = false;
      if (candidate?.extension.localPath && packageDiskManifestKey) {
        const [packageTree, candidateTree] = await Promise.all([
          fingerprintStagedExtensionTree(path.join(stagingDir, "extensions", extension.id), {
            maxFiles: 20_000,
            maxFilesystemNodes: 50_000,
            maxExpandedBytes: 512 * 1024 * 1024,
          }).catch(() => undefined),
          fingerprintStagedExtensionTree(candidate.extension.localPath, {
            maxFiles: 20_000,
            maxFilesystemNodes: 50_000,
            maxExpandedBytes: 512 * 1024 * 1024,
          }).catch(() => undefined),
        ]);
        sameTree = Boolean(packageTree && candidateTree && packageTree.sha256 === candidateTree.sha256);
      }
      const reusable = extension.manifestKey
        && packageDiskManifestKey === extension.manifestKey
        && candidate?.extension.manifestKey === extension.manifestKey
        && candidate.diskManifestKey === extension.manifestKey
        && sameTree
        && (!extension.storeId || !candidate.extension.storeId || extension.storeId === candidate.extension.storeId)
        ? candidate.extension
        : undefined;
      if (reusable) {
        extensionIdMap[extension.id] = reusable.id;
        reusedExtensionIds.push(reusable.id);
      } else {
        extensionIdMap[extension.id] = createId("extension");
        if (!extension.manifestKey || !packageDiskManifestKey) {
          warnings.push(`Extension ${extension.name} has no pinned portable identity and will be imported as a separate copy.`);
        } else if (packageDiskManifestKey !== extension.manifestKey) {
          warnings.push(`Extension ${extension.name} has mismatched package identity and will not reuse a local extension.`);
        }
      }
    }

    return { extensionIdMap, reusedExtensionIds, warnings };
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
    result?: EnvironmentPackageOperationResult,
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

function parseManifest(input: unknown): AnyEnvironmentPackageManifest {
  if (!isRecord(input)) throw Object.assign(new Error("Package manifest must be an object."), { status: 400 });
  if (input.kind !== ENVIRONMENT_PACKAGE_KIND) throw Object.assign(new Error("Unsupported environment package kind."), { status: 400 });
  const counts = isRecord(input.counts) ? input.counts : {};
  const base = {
    kind: ENVIRONMENT_PACKAGE_KIND,
    exportedAt: readString(input.exportedAt, "manifest.exportedAt"),
    scope: input.scope === "all" ? "all" : "selected",
    containsSecrets: true,
    containsBrowserData: input.containsBrowserData === true,
    containsExtensions: input.containsExtensions === true,
  } as const;
  const baseCounts = {
    environments: readNumber(counts.environments, "manifest.counts.environments"),
    browserData: readNumber(counts.browserData, "manifest.counts.browserData"),
    groups: readNumber(counts.groups, "manifest.counts.groups"),
    extensions: readNumber(counts.extensions, "manifest.counts.extensions"),
  };
  if (input.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1) {
    return { ...base, schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1, counts: baseCounts } satisfies EnvironmentPackageManifestV1;
  }
  if (input.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2) {
    return {
      ...base,
      schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2,
      counts: {
        ...baseCounts,
        retainedExtensionArtifacts: readNumber(counts.retainedExtensionArtifacts, "manifest.counts.retainedExtensionArtifacts"),
      },
    } satisfies EnvironmentPackageManifestV2;
  }
  throw Object.assign(new Error("Unsupported environment package schema version."), { status: 400 });
}

function parsePackageData(input: unknown): AnyEnvironmentPackageData {
  return decodeEnvironmentPackageData(input);
}

function validateManifestData(manifest: AnyEnvironmentPackageManifest, data: AnyEnvironmentPackageData): void {
  if (manifest.schemaVersion !== data.schemaVersion) throw Object.assign(new Error("Package manifest and data schema versions disagree."), { status: 400 });
  if (manifest.counts.environments !== data.environments.length) throw Object.assign(new Error("Package environment count does not match manifest."), { status: 400 });
  if (manifest.counts.groups !== data.groups.length) throw Object.assign(new Error("Package group count does not match manifest."), { status: 400 });
  if (manifest.counts.extensions !== data.extensions.length) throw Object.assign(new Error("Package extension count does not match manifest."), { status: 400 });
  if (manifest.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2 && data.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2) {
    if (manifest.counts.retainedExtensionArtifacts !== data.retainedExtensionArtifacts.length) throw Object.assign(new Error("Package retained artifact count does not match manifest."), { status: 400 });
  }
}

function migratePackageDataToCurrent(data: AnyEnvironmentPackageData): EnvironmentPackageData {
  const current: EnvironmentPackageData = data.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2
    ? data
    : {
        schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2,
        environments: data.environments,
        groups: data.groups,
        extensions: data.extensions.map(retireLegacyTransferredExtension),
        retainedExtensionArtifacts: [],
        environmentExtensionBindings: data.environmentExtensionBindings,
      };
  return {
    ...current,
    environments: current.environments.map(withoutPackageExtensionPaths),
    extensions: current.extensions.map(sanitizeTransferredPackageExtension),
  };
}

function portablePackageData(data: EnvironmentPackageData): EnvironmentPackageData {
  return {
    ...data,
    environments: data.environments.map(withoutPackageExtensionPaths),
    extensions: data.extensions.map(sanitizeTransferredPackageExtension),
  };
}

function withoutPackageExtensionPaths(environment: BrowserEnvironment): BrowserEnvironment {
  return {
    ...environment,
    runtimeProfile: {
      ...environment.runtimeProfile,
      runtime: {
        ...environment.runtimeProfile.runtime,
        extensionPaths: [],
      },
    },
  };
}

function sanitizeTransferredPackageExtension(extension: ExtensionEntity): ExtensionEntity {
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
  return retireLegacyTransferredExtension(extension, { stripPaths: true });
}

async function validateStagedRetainedArtifacts(
  data: EnvironmentPackageData,
  stagingDir: string,
  verifyFile: typeof verifyChromeWebStoreCrx3File,
  preflightPackage: typeof preflightExtensionPackage,
): Promise<void> {
  const extensionById = new Map(data.extensions.map((extension) => [extension.id, extension]));
  for (const artifact of data.retainedExtensionArtifacts) {
    const extension = extensionById.get(artifact.extensionId);
    if (!extension) throw packageInvalid(`Retained artifact references an unknown extension ${artifact.extensionId}.`);
    if (extension.artifactArchivePath !== artifact.archivePath || extension.sourceUrl !== artifact.archivePath) {
      throw packageInvalid(`Retained artifact path disagrees with extension ${artifact.extensionId}.`);
    }
    const stagedPath = path.join(stagingDir, ...artifact.archivePath.split("/"));
    const unpackedRoot = path.join(stagingDir, "extensions", extension.id);
    await validateTransferredExtensionArtifact({
      extension,
      artifactPath: stagedPath,
      expectedSha256: artifact.sha256,
      validationDir: path.join(stagingDir, ".artifact-validation", artifact.extensionId),
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

function packageInvalid(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "ENVIRONMENT_PACKAGE_SCHEMA_INVALID" });
}

function validatePackageExtensionReferences(data: EnvironmentPackageData): void {
  const extensionIds = new Set(data.extensions.map((extension) => extension.id));
  for (const environment of data.environments) {
    for (const extensionId of environment.extensionIds) {
      if (!extensionIds.has(extensionId)) {
        throw packageInvalid(`Environment ${environment.id} references unknown extension ${extensionId}.`);
      }
    }
  }
  const bindingPairs = new Set<string>();
  for (const binding of data.environmentExtensionBindings ?? []) {
    if (!data.environments.some((environment) => environment.id === binding.environmentId)) {
      throw packageInvalid(`Binding references unknown environment ${binding.environmentId}.`);
    }
    if (!extensionIds.has(binding.extensionId)) {
      throw packageInvalid(`Binding references unknown extension ${binding.extensionId}.`);
    }
    const pair = `${binding.environmentId}\0${binding.extensionId}`;
    if (bindingPairs.has(pair)) throw packageInvalid("Package contains duplicate extension bindings.");
    bindingPairs.add(pair);
    if (!data.environments.find((environment) => environment.id === binding.environmentId)?.extensionIds.includes(binding.extensionId)) {
      throw packageInvalid("Package binding metadata references an unbound entity pair.");
    }
  }
}

async function countExistingDirectories(paths: string[]): Promise<number> {
  let count = 0;
  for (const itemPath of paths) {
    if (await pathExists(itemPath)) count += 1;
  }
  return count;
}

async function readPackageManifestKeys(
  extensions: ExtensionEntity[],
  stagingDir: string,
): Promise<Record<string, string>> {
  const entries = await Promise.all(extensions.map(async (extension) => {
    const key = await readManifestKey(path.join(stagingDir, "extensions", extension.id));
    return key ? ([extension.id, key] as const) : undefined;
  }));
  return Object.fromEntries(entries.filter((entry): entry is [string, string] => Boolean(entry)));
}

async function readManifestKey(directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(directory, "manifest.json"), "utf8")) as { key?: unknown };
    return typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function ensurePackageExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith(".cbpe") ? filePath : `${filePath}.cbpe`;
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
