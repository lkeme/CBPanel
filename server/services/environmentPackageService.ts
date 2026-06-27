import fs from "node:fs/promises";
import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncZipDeflate, Unzip, UnzipInflate, Zip, type UnzipFile } from "fflate";
import type { BrowserEnvironment, ExtensionEntity, GroupEntity } from "../../src/shared/entities";
import {
  ENVIRONMENT_PACKAGE_KIND,
  ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
  type EnvironmentPackageCounts,
  type EnvironmentPackageData,
  type EnvironmentPackageManifest,
  type EnvironmentPackageOperation,
  type EnvironmentPackageOperationResult,
  type EnvironmentPackageScope,
} from "../../src/shared/environmentPackage";
import { createId, nowIso, proxyUrlFromParts } from "../../src/shared/profile";
import type { PanelRepository } from "../storage/types";

type EnvironmentPackageServiceOptions = {
  repository: PanelRepository;
  browserDataDir: string;
  extensionCacheDir: string;
  activeEnvironmentIds: () => Set<string>;
};

type ExportRequest = {
  environmentIds?: string[];
  outputPath: string;
};

type ImportRequest = {
  inputPath: string;
};

type PackageEntry = {
  archivePath: string;
  filePath?: string;
  bytes?: Uint8Array;
};

type PreparedImport = {
  data: EnvironmentPackageData;
  stagingDir: string;
  environmentIdMap: Record<string, string>;
  extensionIdMap: Record<string, string>;
  reusedExtensionIds: string[];
  extensionLocalPaths: Record<string, string>;
  counts: EnvironmentPackageCounts;
  warnings: string[];
};

const MANIFEST_ENTRY = "manifest.json";
const DATA_ENTRY = "data.json";
const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

export class EnvironmentPackageService {
  private readonly operations = new Map<string, EnvironmentPackageOperation>();

  constructor(private readonly options: EnvironmentPackageServiceOptions) {}

  startExport(request: ExportRequest): EnvironmentPackageOperation {
    const operation = this.createOperation("export", "queued", "Preparing environment export.");
    void this.runExport(operation.id, request);
    return operation;
  }

  startImport(request: ImportRequest): EnvironmentPackageOperation {
    const operation = this.createOperation("import", "queued", "Preparing environment import.");
    void this.runImport(operation.id, request);
    return operation;
  }

  getOperation(id: string): EnvironmentPackageOperation | undefined {
    return this.operations.get(id);
  }

  async exportToPackage(request: ExportRequest, operationId?: string): Promise<EnvironmentPackageOperationResult> {
    const outputPath = ensurePackageExtension(path.resolve(request.outputPath));
    const environments = await this.targetEnvironments(request.environmentIds);
    this.assertNoActiveEnvironment(environments);
    const scope: EnvironmentPackageScope = request.environmentIds?.length ? "selected" : "all";
    const prepared = await this.buildExportEntries(environments, scope, operationId);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await writeZip(outputPath, prepared.entries, (current, total, archivePath) => {
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
    const inputPath = path.resolve(request.inputPath);
    const prepared = await this.prepareImport(inputPath, operationId);
    const copiedEnvironmentIds: string[] = [];
    const copiedExtensionIds: string[] = [];
    try {
      const reusedExtensionIds = new Set(prepared.reusedExtensionIds);
      for (const [oldExtensionId, newExtensionId] of Object.entries(prepared.extensionIdMap)) {
        if (reusedExtensionIds.has(newExtensionId)) continue;
        const sourcePath = path.join(prepared.stagingDir, "extensions", oldExtensionId);
        if (!(await pathExists(sourcePath))) continue;
        const targetPath = path.join(this.options.extensionCacheDir, newExtensionId);
        this.setProgress(operationId, "copying-extensions", copiedExtensionIds.length + 1, Object.keys(prepared.extensionIdMap).length, `Restoring extension ${oldExtensionId}.`);
        await copyDirectory(sourcePath, targetPath);
        prepared.extensionLocalPaths[oldExtensionId] = targetPath;
        copiedExtensionIds.push(newExtensionId);
      }

      for (const [oldEnvironmentId, newEnvironmentId] of Object.entries(prepared.environmentIdMap)) {
        const sourcePath = path.join(prepared.stagingDir, "browser-data", oldEnvironmentId);
        if (!(await pathExists(sourcePath))) continue;
        const targetPath = path.join(this.options.browserDataDir, newEnvironmentId);
        this.setProgress(operationId, "copying-browser-data", copiedEnvironmentIds.length + 1, Object.keys(prepared.environmentIdMap).length, `Restoring browser data ${oldEnvironmentId}.`);
        await copyDirectory(sourcePath, targetPath);
        copiedEnvironmentIds.push(newEnvironmentId);
      }

      this.setProgress(operationId, "importing-database", 0, prepared.data.environments.length, "Writing imported environments.");
      const imported = await this.options.repository.importEnvironmentPackage({
        ...prepared.data,
        environmentIdMap: prepared.environmentIdMap,
        extensionIdMap: prepared.extensionIdMap,
        extensionLocalPaths: prepared.extensionLocalPaths,
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
      ]);
      throw error;
    } finally {
      await fs.rm(prepared.stagingDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async runExport(operationId: string, request: ExportRequest): Promise<void> {
    this.markRunning(operationId, "exporting", "Exporting environment package.");
    try {
      const result = await this.exportToPackage(request, operationId);
      this.finishOperation(operationId, "succeeded", "Environment package exported.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Environment package export failed.", undefined, (error as Error).message);
    }
  }

  private async runImport(operationId: string, request: ImportRequest): Promise<void> {
    this.markRunning(operationId, "importing", "Importing environment package.");
    try {
      const result = await this.importFromPackage(request, operationId);
      this.finishOperation(operationId, "succeeded", "Environment package imported.", result);
    } catch (error) {
      this.finishOperation(operationId, "failed", "Environment package import failed.", undefined, (error as Error).message);
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
    entries: PackageEntry[];
    manifest: EnvironmentPackageManifest;
    warnings: string[];
  }> {
    const warnings: string[] = [];
    const groups = await this.exportGroups(environments);
    const extensions = await this.exportExtensions(environments);
    const exportedEnvironments = await this.materializeEnvironmentDependencies(environments);
    const entries: PackageEntry[] = [];
    const browserDataEntries = await this.browserDataEntries(exportedEnvironments, warnings);
    const extensionEntries = await this.extensionEntries(extensions, warnings);
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
      },
    };
    const data: EnvironmentPackageData = {
      schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
      environments: exportedEnvironments,
      groups,
      extensions,
    };
    entries.push(jsonEntry(MANIFEST_ENTRY, manifest));
    entries.push(jsonEntry(DATA_ENTRY, data));
    entries.push(...browserDataEntries.entries);
    entries.push(...extensionEntries.entries);
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

  private async browserDataEntries(environments: BrowserEnvironment[], warnings: string[]): Promise<{ count: number; entries: PackageEntry[] }> {
    const entries: PackageEntry[] = [];
    let count = 0;
    for (const environment of environments) {
      const directory = path.join(this.options.browserDataDir, environment.id);
      if (!(await pathExists(directory))) {
        warnings.push(`Browser data not found for ${environment.name}.`);
        continue;
      }
      count += 1;
      entries.push(...await directoryEntries(directory, `browser-data/${environment.id}`));
    }
    return { count, entries };
  }

  private async extensionEntries(extensions: ExtensionEntity[], warnings: string[]): Promise<{ count: number; entries: PackageEntry[] }> {
    const entries: PackageEntry[] = [];
    let count = 0;
    for (const extension of extensions) {
      const directory = extension.localPath ?? path.join(this.options.extensionCacheDir, extension.id);
      if (!(await pathExists(directory))) {
        warnings.push(`Extension files not found for ${extension.name}.`);
        continue;
      }
      count += 1;
      entries.push(...await directoryEntries(directory, `extensions/${extension.id}`));
    }
    return { count, entries };
  }

  private async prepareImport(inputPath: string, operationId?: string): Promise<PreparedImport> {
    this.setProgress(operationId, "extracting", 0, 1, "Extracting environment package.");
    const stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-environment-import-"));
    try {
      await extractZip(inputPath, stagingDir);
      const manifest = parseManifest(await readJsonFile(path.join(stagingDir, MANIFEST_ENTRY)));
      const data = parsePackageData(await readJsonFile(path.join(stagingDir, DATA_ENTRY)));
      validateManifestData(manifest, data);
      const environmentIdMap = Object.fromEntries(data.environments.map((environment) => [environment.id, createId()]));
      const { extensionIdMap, reusedExtensionIds } = await this.resolveExtensionIdMap(data.extensions);
      const browserDataCount = await countExistingDirectories(
        data.environments.map((environment) => path.join(stagingDir, "browser-data", environment.id)),
      );
      const extensionFileCount = await countExistingDirectories(
        data.extensions.map((extension) => path.join(stagingDir, "extensions", extension.id)),
      );
      this.setProgress(operationId, "validating", data.environments.length, data.environments.length, "Validated environment package.");
      const warnings = [];
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
        counts: {
          environments: data.environments.length,
          browserData: browserDataCount,
          groups: data.groups.length,
          extensions: data.extensions.length,
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

  private async resolveExtensionIdMap(extensions: ExtensionEntity[]): Promise<{
    extensionIdMap: Record<string, string>;
    reusedExtensionIds: string[];
  }> {
    const installed: ExtensionEntity[] = [];
    for (const extension of await this.options.repository.listExtensions()) {
      if (extension.installState !== "installed" || !extension.localPath) continue;
      if (await pathExists(extension.localPath)) installed.push(extension);
    }
    const bySha = new Map(installed
      .filter((extension) => extension.sha256)
      .map((extension) => [extension.sha256 as string, extension]));
    const byStoreVersion = new Map(installed
      .filter((extension) => extension.storeId)
      .map((extension) => [`${extension.storeId}:${extension.version}`, extension]));
    const extensionIdMap: Record<string, string> = {};
    const reusedExtensionIds: string[] = [];

    for (const extension of extensions) {
      const reusable = extension.sha256
        ? bySha.get(extension.sha256)
        : extension.storeId
          ? byStoreVersion.get(`${extension.storeId}:${extension.version}`)
          : undefined;
      if (reusable) {
        extensionIdMap[extension.id] = reusable.id;
        reusedExtensionIds.push(reusable.id);
      } else {
        extensionIdMap[extension.id] = createId("extension");
      }
    }

    return { extensionIdMap, reusedExtensionIds };
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

function jsonEntry(archivePath: string, value: unknown): PackageEntry {
  return {
    archivePath,
    bytes: TEXT_ENCODER.encode(`${JSON.stringify(value, null, 2)}\n`),
  };
}

async function directoryEntries(root: string, archiveRoot: string): Promise<PackageEntry[]> {
  const entries: PackageEntry[] = [];
  await collectDirectoryEntries(path.resolve(root), normalizeArchivePath(archiveRoot), entries);
  return entries;
}

async function collectDirectoryEntries(root: string, archiveRoot: string, entries: PackageEntry[], current = root): Promise<void> {
  const dirents = await fs.readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    const filePath = path.join(current, dirent.name);
    const relative = path.relative(root, filePath).replace(/\\/g, "/");
    const archivePath = normalizeArchivePath(`${archiveRoot}/${relative}`);
    if (dirent.isDirectory()) {
      await collectDirectoryEntries(root, archiveRoot, entries, filePath);
    } else if (dirent.isFile()) {
      entries.push({ archivePath, filePath });
    }
  }
}

async function writeZip(outputPath: string, entries: PackageEntry[], onProgress: (current: number, total: number, archivePath: string) => void): Promise<void> {
  const tempPath = `${outputPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const output = createWriteStream(tempPath);
  let failed: Error | undefined;
  const zip = new Zip((error, data, final) => {
    if (error) {
      failed = error;
      output.destroy(error);
      return;
    }
    output.write(data, () => {
      if (final) output.end();
    });
  });

  try {
    for (const [index, entry] of entries.entries()) {
      if (failed) throw failed;
      onProgress(index + 1, entries.length, entry.archivePath);
      await addZipEntry(zip, entry);
    }
    zip.end();
    await new Promise<void>((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
    });
    if (failed) throw failed;
    await fs.rename(tempPath, outputPath);
  } catch (error) {
    zip.terminate();
    output.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function addZipEntry(zip: Zip, entry: PackageEntry): Promise<void> {
  const file = new AsyncZipDeflate(entry.archivePath, { level: 6 });
  zip.add(file);
  if (entry.bytes) {
    file.push(entry.bytes, true);
    return;
  }
  if (!entry.filePath) {
    file.push(new Uint8Array(), true);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(entry.filePath as string);
    stream.on("data", (chunk) => file.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)));
    stream.on("end", () => {
      file.push(new Uint8Array(), true);
      resolve();
    });
    stream.on("error", reject);
  });
}

async function extractZip(inputPath: string, outputDir: string): Promise<void> {
  const writes: Promise<void>[] = [];
  const unzip = new Unzip((file) => {
    if (!isSafeArchivePath(file.name)) {
      throw Object.assign(new Error("Environment package contains an unsafe path."), { status: 400 });
    }
    const normalizedName = normalizeArchivePath(file.name);
    if (!normalizedName || normalizedName.endsWith("/")) return;
    const write = writeUnzipFile(file, safeJoin(outputDir, normalizedName));
    writes.push(write);
  });
  unzip.register(UnzipInflate);
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(inputPath);
    input.on("data", (chunk) => {
      try {
        unzip.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk), false);
      } catch (error) {
        input.destroy(error as Error);
      }
    });
    input.once("end", () => {
      try {
        unzip.push(new Uint8Array(), true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    input.once("error", reject);
  });
  await Promise.all(writes);
}

function writeUnzipFile(file: UnzipFile, targetPath: string): Promise<void> {
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const output = createWriteStream(targetPath);
  const done = new Promise<void>((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
  file.ondata = (error, chunk, final) => {
    if (error) {
      output.destroy(error);
      return;
    }
    output.write(chunk, () => {
      if (final) output.end();
    });
  };
  try {
    file.start();
  } catch (error) {
    output.destroy(error as Error);
  }
  return done;
}

async function readJsonFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(TEXT_DECODER.decode(await fs.readFile(filePath)));
  } catch (error) {
    throw Object.assign(new Error(`Invalid package JSON ${path.basename(filePath)}: ${(error as Error).message}`), { status: 400 });
  }
}

function parseManifest(input: unknown): EnvironmentPackageManifest {
  if (!isRecord(input)) throw Object.assign(new Error("Package manifest must be an object."), { status: 400 });
  if (input.kind !== ENVIRONMENT_PACKAGE_KIND) throw Object.assign(new Error("Unsupported environment package kind."), { status: 400 });
  if (input.schemaVersion !== ENVIRONMENT_PACKAGE_SCHEMA_VERSION) throw Object.assign(new Error("Unsupported environment package schema version."), { status: 400 });
  const counts = isRecord(input.counts) ? input.counts : {};
  return {
    kind: ENVIRONMENT_PACKAGE_KIND,
    schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
    exportedAt: readString(input.exportedAt, "manifest.exportedAt"),
    scope: input.scope === "all" ? "all" : "selected",
    containsSecrets: true,
    containsBrowserData: input.containsBrowserData === true,
    containsExtensions: input.containsExtensions === true,
    counts: {
      environments: readNumber(counts.environments, "manifest.counts.environments"),
      browserData: readNumber(counts.browserData, "manifest.counts.browserData"),
      groups: readNumber(counts.groups, "manifest.counts.groups"),
      extensions: readNumber(counts.extensions, "manifest.counts.extensions"),
    },
  };
}

function parsePackageData(input: unknown): EnvironmentPackageData {
  if (!isRecord(input)) throw Object.assign(new Error("Package data must be an object."), { status: 400 });
  if (input.schemaVersion !== ENVIRONMENT_PACKAGE_SCHEMA_VERSION) throw Object.assign(new Error("Unsupported package data schema version."), { status: 400 });
  if (!Array.isArray(input.environments)) throw Object.assign(new Error("Package data must include environments."), { status: 400 });
  if (!Array.isArray(input.groups)) throw Object.assign(new Error("Package data must include groups."), { status: 400 });
  if (!Array.isArray(input.extensions)) throw Object.assign(new Error("Package data must include extensions."), { status: 400 });
  return {
    schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION,
    environments: input.environments as BrowserEnvironment[],
    groups: input.groups as GroupEntity[],
    extensions: input.extensions as ExtensionEntity[],
  };
}

function validateManifestData(manifest: EnvironmentPackageManifest, data: EnvironmentPackageData): void {
  if (manifest.counts.environments !== data.environments.length) {
    throw Object.assign(new Error("Package environment count does not match manifest."), { status: 400 });
  }
  if (manifest.counts.groups !== data.groups.length) {
    throw Object.assign(new Error("Package group count does not match manifest."), { status: 400 });
  }
  if (manifest.counts.extensions !== data.extensions.length) {
    throw Object.assign(new Error("Package extension count does not match manifest."), { status: 400 });
  }
}

async function countExistingDirectories(paths: string[]): Promise<number> {
  let count = 0;
  for (const itemPath of paths) {
    if (await pathExists(itemPath)) count += 1;
  }
  return count;
}

async function copyDirectory(source: string, target: string): Promise<void> {
  if (await pathExists(target)) {
    throw Object.assign(new Error(`Import target already exists: ${target}`), { status: 409 });
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false });
}

async function pathExists(itemPath: string): Promise<boolean> {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

function ensurePackageExtension(filePath: string): string {
  return filePath.toLowerCase().endsWith(".cbpe") ? filePath : `${filePath}.cbpe`;
}

function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

function safeJoin(root: string, relativePath: string): string {
  if (!isSafeArchivePath(relativePath)) {
    throw Object.assign(new Error("Environment package contains an unsafe path."), { status: 400 });
  }
  const targetPath = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const comparableRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}${path.sep}`)) {
    throw Object.assign(new Error("Environment package contains an unsafe path."), { status: 400 });
  }
  return targetPath;
}

function isSafeArchivePath(relativePath: string): boolean {
  const rawPath = relativePath.replace(/\\/g, "/");
  if (rawPath.startsWith("/") || path.isAbsolute(relativePath) || /^[a-z]:\//i.test(rawPath)) return false;
  const normalizedPath = normalizeArchivePath(relativePath);
  if (!normalizedPath || normalizedPath.startsWith("/") || path.isAbsolute(normalizedPath)) return false;
  return !normalizedPath.split("/").some((part) => part === ".." || part === "");
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
