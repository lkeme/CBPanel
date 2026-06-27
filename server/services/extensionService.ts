import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  type BrowserEnvironment,
  type ExtensionEntity,
  type ExtensionPermissionRisk,
  type ExtensionSourceEntity,
  type ExtensionSourceRefreshResult,
  type ExtensionSourceKind,
  type ExtensionUpdatePolicy,
} from "../../src/shared/entities";
import { createId, nowIso } from "../../src/shared/profile";
import type { PanelRepository } from "../storage/types";

type ExtensionServiceOptions = {
  repository: PanelRepository;
  extensionCacheDir: string;
  fetchImpl?: typeof fetch;
};

type ExtensionManifest = {
  name?: string;
  description?: string;
  version?: string;
  manifest_version?: number;
  permissions?: unknown[];
  host_permissions?: unknown[];
};

type ExtensionAssetKind = "zip" | "crx";

type ExtensionSourceIndexEntry = {
  id: string;
  name: string;
  description?: string;
  version: string;
  assetKind: ExtensionAssetKind;
  assetUrl: string;
  sha256?: string;
  webStoreId?: string;
  storeUrl?: string;
};

type ExtensionSourceIndex = {
  name: string;
  extensions: ExtensionSourceIndexEntry[];
};

const HIGH_RISK_PERMISSIONS = new Set([
  "cookies",
  "proxy",
  "tabs",
  "webRequest",
  "declarativeNetRequest",
  "scripting",
  "nativeMessaging",
  "<all_urls>",
]);

export class ExtensionService {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: ExtensionServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async importDirectory(directory: string): Promise<ExtensionEntity> {
    const localPath = path.resolve(directory);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.createExtension({
      ...extensionFieldsFromManifest(manifest),
      sourceKind: "local-directory",
      sourceUrl: localPath,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
    });
  }

  async importZip(filePath: string): Promise<ExtensionEntity> {
    return this.importLocalAsset(filePath, "zip");
  }

  async importCrx(filePath: string): Promise<ExtensionEntity> {
    return this.importLocalAsset(filePath, "crx");
  }

  async createRemote(input: Partial<ExtensionEntity>): Promise<ExtensionEntity> {
    const sourceKind = input.sourceKind === "remote-crx" ? "remote-crx" : "remote-zip";
    if (!input.sourceUrl?.trim()) {
      throw Object.assign(new Error("Remote extension URL cannot be empty"), { status: 400 });
    }
    if (!input.sha256?.trim()) {
      throw Object.assign(new Error("Remote extension sha256 is required"), { status: 400 });
    }
    return this.options.repository.createExtension({
      ...input,
      sourceKind,
      sourceUrl: input.sourceUrl.trim(),
      installState: "download-pending",
      updatePolicy: input.updatePolicy ?? "pinned",
      sha256: input.sha256.trim().toLowerCase(),
    });
  }

  async refreshSource(id: string): Promise<ExtensionSourceRefreshResult> {
    const source = await this.getExtensionSourceOrThrow(id);
    if (source.status === "disabled") {
      throw Object.assign(new Error("Extension source is disabled"), { status: 409 });
    }

    try {
      const index = await this.fetchSourceIndex(source);
      let imported = 0;
      let updated = 0;
      const extensions: ExtensionEntity[] = [];

      for (const entry of index.extensions) {
        const extensionId = extensionIdFromSourceEntry(source.id, entry.id);
        const existing = await this.options.repository.getExtension(extensionId);
        const sourceKind: ExtensionSourceKind = entry.assetKind === "crx" ? "remote-crx" : "remote-zip";
        const basePatch: Partial<ExtensionEntity> = {
          id: extensionId,
          name: entry.name,
          description: entry.description ?? "",
          sourceKind,
          sourceUrl: entry.assetUrl,
          sourceId: source.id,
          storeId: entry.webStoreId,
          storeUrl: entry.storeUrl,
          version: entry.version,
          sha256: entry.sha256,
          updatePolicy: existing?.updatePolicy ?? "pinned",
          status: existing?.status ?? "enabled",
        };

        if (existing) {
          const assetChanged = existing.sourceUrl !== entry.assetUrl || Boolean(entry.sha256 && existing.sha256 !== entry.sha256);
          const installState = existing.installState === "installed" && (existing.version !== entry.version || assetChanged)
            ? "update-available"
            : existing.installState === "installed"
              ? "installed"
              : "download-pending";
          extensions.push(await this.options.repository.updateExtension(extensionId, { ...basePatch, installState }));
          updated += 1;
        } else {
          extensions.push(await this.options.repository.createExtension({ ...basePatch, installState: "download-pending" }));
          imported += 1;
        }
      }

      const refreshedSource = await this.options.repository.updateExtensionSource(source.id, {
        name: index.name || source.name,
        lastRefreshedAt: nowIso(),
        lastError: undefined,
      });

      return { source: refreshedSource, imported, updated, skipped: 0, extensions };
    } catch (error) {
      await this.options.repository.updateExtensionSource(source.id, {
        lastRefreshedAt: nowIso(),
        lastError: (error as Error).message,
      });
      throw error;
    }
  }

  async install(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    const previousInstalledState = extension.installState === "installed" ? "installed" : "install-failed";
    const previousLocalPath = extension.installState === "installed" ? extension.localPath : undefined;
    try {
      if (extension.sourceKind === "local-directory") {
        return await this.refreshLocalDirectory(extension);
      }
      if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
        return await this.installLocalAsset(extension);
      }
      if (extension.sourceKind === "remote-zip" || extension.sourceKind === "remote-crx") {
        return await this.installRemoteAsset(extension);
      }
      throw Object.assign(new Error("Chrome Web Store metadata cannot be installed without a verified asset"), { status: 409 });
    } catch (error) {
      await this.options.repository.updateExtension(id, {
        installState: previousInstalledState,
        localPath: previousLocalPath,
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
      throw error;
    }
  }

  async check(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (!extension.localPath) {
      return this.options.repository.updateExtension(id, {
        installState: extension.sourceKind === "chrome-web-store" ? "metadata-only" : extension.installState,
        lastCheckedAt: nowIso(),
        lastError: "Extension has no local unpacked path",
      });
    }
    try {
      const manifest = await readManifestFromDirectory(extension.localPath);
      return this.options.repository.updateExtension(id, {
        ...extensionFieldsFromManifest(manifest),
        installState: "installed",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      return this.options.repository.updateExtension(id, {
        installState: "local-missing",
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  async checkUpdate(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (!extension.sourceId) {
      return this.options.repository.updateExtension(id, {
        lastCheckedAt: nowIso(),
        lastError: "Extension has no remote source index",
      });
    }
    const source = await this.getExtensionSourceOrThrow(extension.sourceId);
    if (source.status === "disabled") {
      return this.options.repository.updateExtension(id, {
        lastCheckedAt: nowIso(),
        lastError: "Extension source is disabled",
      });
    }
    await this.refreshSource(source.id);
    const refreshed = await this.getExtensionOrThrow(id);
    return this.options.repository.updateExtension(id, {
      lastCheckedAt: nowIso(),
      lastError: undefined,
      installState: refreshed.installState,
    });
  }

  async update(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (extension.installState !== "update-available") {
      throw Object.assign(new Error("Extension update is not available"), { status: 409 });
    }
    const nextManifest = await this.readInstallCandidateManifest(extension);
    const candidate = { ...extension, ...extensionFieldsFromManifest(nextManifest) };
    const addedPermissions = permissionsAdded(extension, candidate);
    if (addedPermissions.length > 0) {
      await this.options.repository.updateExtension(extension.id, {
        installState: "update-available",
        lastCheckedAt: nowIso(),
        lastError: `Extension update adds permissions: ${addedPermissions.join(", ")}`,
      });
      throw Object.assign(new Error("Extension update adds permissions and requires confirmation"), {
        status: 409,
        permissions: addedPermissions,
      });
    }
    return this.install(extension.id);
  }

  async reinstall(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (extension.sourceKind === "chrome-web-store") {
      throw Object.assign(new Error("Chrome Web Store metadata cannot be reinstalled without a verified asset"), { status: 409 });
    }
    return this.install(extension.id);
  }

  async ensureExtensionsInstalled(environmentId: string): Promise<string[]> {
    const environment = await this.options.repository.getEnvironment(environmentId);
    if (!environment) throw Object.assign(new Error("Environment does not exist"), { status: 404 });

    const extensionById = new Map((await this.options.repository.listExtensions()).map((extension) => [extension.id, extension]));
    const extensionPaths: string[] = [];
    for (const extensionId of environment.extensionIds) {
      const extension = extensionById.get(extensionId);
      if (!extension || extension.status === "disabled") continue;
      const installed = extension.installState === "installed" ? await this.check(extension.id) : await this.install(extension.id);
      if (installed.installState !== "installed" || !installed.localPath) {
        throw Object.assign(new Error(`Extension ${installed.name} is not installed`), { status: 409 });
      }
      extensionPaths.push(installed.localPath);
    }
    return extensionPaths;
  }

  async resolveEnvironment(environmentId: string): Promise<{ environment: BrowserEnvironment; profile: BrowserEnvironment["runtimeProfile"] }> {
    const environment = await this.options.repository.getEnvironment(environmentId);
    if (!environment) throw Object.assign(new Error("Environment does not exist"), { status: 404 });
    const extensionById = new Map((await this.options.repository.listExtensions()).map((extension) => [extension.id, extension]));
    const extensionPaths = environment.extensionIds
      .map((id) => extensionById.get(id))
      .filter((extension): extension is ExtensionEntity => Boolean(extension))
      .filter((extension) => extension.status === "enabled" && extension.installState === "installed" && Boolean(extension.localPath))
      .map((extension) => extension.localPath as string);
    return {
      environment,
      profile: {
        ...environment.runtimeProfile,
        runtime: {
          ...environment.runtimeProfile.runtime,
          extensionPaths,
        },
      },
    };
  }

  private async importLocalAsset(filePath: string, assetKind: ExtensionAssetKind): Promise<ExtensionEntity> {
    const sourceUrl = path.resolve(filePath);
    const bytes = await fs.readFile(sourceUrl);
    const sha256 = sha256Hex(bytes);
    const extensionId = createId("extension");
    const localPath = await this.extractAsset(bytes, assetKind, extensionId);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.createExtension({
      ...extensionFieldsFromManifest(manifest),
      id: extensionId,
      sourceKind: assetKind === "zip" ? "local-zip" : "local-crx",
      sourceUrl,
      sha256,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
    });
  }

  private async refreshLocalDirectory(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const localPath = extension.localPath ?? extension.sourceUrl;
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      sourceUrl: localPath,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async installLocalAsset(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const bytes = await fs.readFile(extension.sourceUrl);
    if (extension.sha256 && sha256Hex(bytes) !== extension.sha256.toLowerCase()) {
      throw Object.assign(new Error("Extension checksum mismatch"), { status: 409 });
    }
    const localPath = await this.extractAsset(bytes, extension.sourceKind === "local-crx" ? "crx" : "zip", extension.id);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      sha256: extension.sha256 ?? sha256Hex(bytes),
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async installRemoteAsset(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const allowUnsigned = await this.allowUnsignedRemote(extension);
    if (!extension.sha256 && !allowUnsigned) {
      throw Object.assign(new Error("Remote extension sha256 is required"), { status: 400 });
    }
    const response = await this.fetchImpl(extension.sourceUrl);
    if (!response.ok) {
      throw Object.assign(new Error(`Remote extension download failed: HTTP ${response.status}`), { status: 502 });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualSha256 = sha256Hex(bytes);
    if (extension.sha256 && actualSha256 !== extension.sha256.toLowerCase()) {
      throw Object.assign(new Error("Remote extension checksum mismatch"), { status: 409 });
    }
    const localPath = await this.extractAsset(bytes, extension.sourceKind === "remote-crx" ? "crx" : "zip", extension.id);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      sha256: actualSha256,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async extractAsset(bytes: Uint8Array, assetKind: ExtensionAssetKind, extensionId: string): Promise<string> {
    const zipBytes = assetKind === "crx" ? stripCrxHeader(bytes) : bytes;
    const outputDir = path.join(this.options.extensionCacheDir, extensionId);
    const tempDir = `${outputDir}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    try {
      await writeZipEntries(zipBytes, tempDir);
      const manifestDir = await findManifestDirectory(tempDir);
      await fs.rm(outputDir, { recursive: true, force: true });
      await fs.mkdir(path.dirname(outputDir), { recursive: true });
      await fs.rename(manifestDir, outputDir);
      await fs.rm(tempDir, { recursive: true, force: true });
      return outputDir;
    } catch (error) {
      await fs.rm(tempDir, { recursive: true, force: true });
      throw error;
    }
  }

  private async getExtensionOrThrow(id: string): Promise<ExtensionEntity> {
    const extension = await this.options.repository.getExtension(id);
    if (!extension) throw Object.assign(new Error("Extension does not exist"), { status: 404 });
    return extension;
  }

  private async getExtensionSourceOrThrow(id: string): Promise<ExtensionSourceEntity> {
    const source = await this.options.repository.getExtensionSource(id);
    if (!source) throw Object.assign(new Error("Extension source does not exist"), { status: 404 });
    return source;
  }

  private async fetchSourceIndex(source: ExtensionSourceEntity): Promise<ExtensionSourceIndex> {
    const response = await this.fetchImpl(source.url);
    if (!response.ok) {
      throw Object.assign(new Error(`Extension source refresh failed: HTTP ${response.status}`), { status: 502 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch (error) {
      throw Object.assign(new Error(`Extension source index is not valid JSON: ${(error as Error).message}`), { status: 400 });
    }
    return parseExtensionSourceIndex(parsed, source.allowUnsignedAssets);
  }

  private async allowUnsignedRemote(extension: ExtensionEntity): Promise<boolean> {
    if (!extension.sourceId) return false;
    const source = await this.options.repository.getExtensionSource(extension.sourceId);
    return source?.allowUnsignedAssets === true;
  }

  private async readInstallCandidateManifest(extension: ExtensionEntity): Promise<ExtensionManifest> {
    if (extension.sourceKind === "local-directory") {
      return readManifestFromDirectory(extension.localPath ?? extension.sourceUrl);
    }
    if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
      const bytes = await fs.readFile(extension.sourceUrl);
      if (extension.sha256 && sha256Hex(bytes) !== extension.sha256.toLowerCase()) {
        throw Object.assign(new Error("Extension checksum mismatch"), { status: 409 });
      }
      return this.readManifestFromAsset(bytes, extension.sourceKind === "local-crx" ? "crx" : "zip", extension.id);
    }
    if (extension.sourceKind === "remote-zip" || extension.sourceKind === "remote-crx") {
      const allowUnsigned = await this.allowUnsignedRemote(extension);
      if (!extension.sha256 && !allowUnsigned) {
        throw Object.assign(new Error("Remote extension sha256 is required"), { status: 400 });
      }
      const response = await this.fetchImpl(extension.sourceUrl);
      if (!response.ok) {
        throw Object.assign(new Error(`Remote extension download failed: HTTP ${response.status}`), { status: 502 });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actualSha256 = sha256Hex(bytes);
      if (extension.sha256 && actualSha256 !== extension.sha256.toLowerCase()) {
        throw Object.assign(new Error("Remote extension checksum mismatch"), { status: 409 });
      }
      return this.readManifestFromAsset(bytes, extension.sourceKind === "remote-crx" ? "crx" : "zip", extension.id);
    }
    throw Object.assign(new Error("Chrome Web Store metadata cannot be installed without a verified asset"), { status: 409 });
  }

  private async readManifestFromAsset(bytes: Uint8Array, assetKind: ExtensionAssetKind, extensionId: string): Promise<ExtensionManifest> {
    const zipBytes = assetKind === "crx" ? stripCrxHeader(bytes) : bytes;
    const tempDir = path.join(this.options.extensionCacheDir, `.preview-${extensionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    try {
      await writeZipEntries(zipBytes, tempDir);
      const manifestDir = await findManifestDirectory(tempDir);
      return await readManifestFromDirectory(manifestDir);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function readManifestFromDirectory(directory: string): Promise<ExtensionManifest> {
  const manifestPath = path.join(path.resolve(directory), "manifest.json");
  let manifest: unknown;
  try {
    await fs.access(manifestPath, fsConstants.R_OK);
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    if (isMissingManifestError(error)) {
      throw Object.assign(new Error(`Extension directory must directly contain manifest.json: ${path.resolve(directory)}`), { status: 400 });
    }
    throw Object.assign(new Error(`Invalid extension manifest: ${(error as Error).message}`), { status: 400 });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw Object.assign(new Error("Invalid extension manifest"), { status: 400 });
  }
  const candidate = manifest as ExtensionManifest;
  if (!candidate.name || !candidate.version || !Number.isFinite(candidate.manifest_version)) {
    throw Object.assign(new Error("Extension manifest must include name, version, and manifest_version"), { status: 400 });
  }
  return candidate;
}

function isMissingManifestError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

export function analyzePermissionRisks(permissions: string[], hostPermissions: string[]): ExtensionPermissionRisk[] {
  const risks: ExtensionPermissionRisk[] = [];
  for (const permission of [...permissions, ...hostPermissions]) {
    if (!HIGH_RISK_PERMISSIONS.has(permission)) continue;
    risks.push({
      permission,
      level: "high",
      reason: permission === "<all_urls>" ? "Can access all sites" : "High-privilege browser extension permission",
    });
  }
  return risks;
}

function extensionFieldsFromManifest(manifest: ExtensionManifest): Pick<
  ExtensionEntity,
  "name" | "description" | "version" | "manifestVersion" | "permissions" | "hostPermissions" | "permissionRisks"
> {
  const permissions = stringArray(manifest.permissions);
  const hostPermissions = stringArray(manifest.host_permissions);
  return {
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : "Extension",
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    version: typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : "0.0.0",
    manifestVersion: Number(manifest.manifest_version),
    permissions,
    hostPermissions,
    permissionRisks: analyzePermissionRisks(permissions, hostPermissions),
  };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function permissionsAdded(previous: ExtensionEntity, next: ExtensionEntity): string[] {
  const before = new Set([...previous.permissions, ...previous.hostPermissions]);
  return [...new Set([...next.permissions, ...next.hostPermissions].filter((permission) => !before.has(permission)))];
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionIdFromSourceEntry(sourceId: string, entryId: string): string {
  const digest = sha256Hex(Buffer.from(`${sourceId}:${entryId}`, "utf8")).slice(0, 16);
  return `extension-${digest}`;
}

function parseExtensionSourceIndex(input: unknown, allowUnsignedAssets: boolean): ExtensionSourceIndex {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("Extension source index must be an object"), { status: 400 });
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw Object.assign(new Error("Extension source index schemaVersion must be 1"), { status: 400 });
  }
  if (!Array.isArray(record.extensions)) {
    throw Object.assign(new Error("Extension source index must include extensions array"), { status: 400 });
  }
  return {
    name: readOptionalString(record.name) ?? "Extension Source",
    extensions: record.extensions.map((entry, index) => parseExtensionSourceEntry(entry, index, allowUnsignedAssets)),
  };
}

function parseExtensionSourceEntry(input: unknown, index: number, allowUnsignedAssets: boolean): ExtensionSourceIndexEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error(`Extension source entry ${index + 1} must be an object`), { status: 400 });
  }
  const record = input as Record<string, unknown>;
  const id = readRequiredString(record.id, `Extension source entry ${index + 1} id`);
  const name = readRequiredString(record.name, `Extension source entry ${index + 1} name`);
  const version = readRequiredString(record.version, `Extension source entry ${index + 1} version`);
  const assetKind = readRequiredString(record.assetKind, `Extension source entry ${index + 1} assetKind`);
  if (assetKind !== "zip" && assetKind !== "crx") {
    throw Object.assign(new Error(`Extension source entry ${index + 1} assetKind must be zip or crx`), { status: 400 });
  }
  const assetUrl = readRequiredString(record.assetUrl, `Extension source entry ${index + 1} assetUrl`);
  const sha256 = readOptionalString(record.sha256)?.toLowerCase();
  if (!sha256 && !allowUnsignedAssets) {
    throw Object.assign(new Error(`Extension source entry ${index + 1} sha256 is required`), { status: 400 });
  }
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw Object.assign(new Error(`Extension source entry ${index + 1} sha256 must be 64 hex characters`), { status: 400 });
  }
  return {
    id,
    name,
    description: readOptionalString(record.description),
    version,
    assetKind,
    assetUrl,
    sha256,
    webStoreId: readOptionalString(record.webStoreId),
    storeUrl: readOptionalString(record.storeUrl),
  };
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) throw Object.assign(new Error(`${label} cannot be empty`), { status: 400 });
  return normalized;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stripCrxHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4) return bytes;
  const magic = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
  if (magic !== "Cr24") return bytes;
  if (bytes.byteLength < 12) throw Object.assign(new Error("Invalid CRX header"), { status: 400 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version === 2) {
    if (bytes.byteLength < 16) throw Object.assign(new Error("Invalid CRX2 header"), { status: 400 });
    const publicKeyLength = view.getUint32(8, true);
    const signatureLength = view.getUint32(12, true);
    return bytes.subarray(16 + publicKeyLength + signatureLength);
  }
  if (version === 3) {
    const headerLength = view.getUint32(8, true);
    return bytes.subarray(12 + headerLength);
  }
  throw Object.assign(new Error(`Unsupported CRX version: ${version}`), { status: 400 });
}

async function findManifestDirectory(root: string): Promise<string> {
  const manifestPath = await findFile(root, "manifest.json", 3);
  if (!manifestPath) throw Object.assign(new Error("Extension package does not contain manifest.json"), { status: 400 });
  return path.dirname(manifestPath);
}

async function writeZipEntries(zipBytes: Uint8Array, outputDir: string): Promise<void> {
  const entries = unzipSync(zipBytes);
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    const normalizedName = entryName.replace(/\\/g, "/");
    if (!normalizedName || normalizedName.endsWith("/")) continue;
    const targetPath = safeJoin(outputDir, normalizedName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entryBytes);
  }
}

async function findFile(directory: string, fileName: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return entryPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(path.join(directory, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function safeJoin(root: string, relativePath: string): string {
  const targetPath = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const comparableRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}${path.sep}`)) {
    throw Object.assign(new Error("Extension archive contains an unsafe path"), { status: 400 });
  }
  return targetPath;
}
