import {
  normalizeExtensionBindingMetadata,
  type BrowserEnvironment,
  type ExtensionEntity,
  type ExtensionBindingMetadata,
  type GroupEntity,
  type ProxyEntity,
  type TagEntity,
} from "./entities";
import {
  extensionForLegacyTransfer,
  normalizeExtensionAuthorityFields,
  downgradeIncompleteExtensionAuthority,
  type LegacyTransferExtension,
} from "./extensionAcquisition";
import type { BrowserProfile } from "./profile";
import type { AppSettings } from "./settings";

export const APP_BACKUP_KIND = "cbpanel.appBackup";
export const APP_BACKUP_SCHEMA_VERSION_V1 = 1;
export const APP_BACKUP_SCHEMA_VERSION_V2 = 2;
export const APP_BACKUP_SCHEMA_VERSION = APP_BACKUP_SCHEMA_VERSION_V2;

export type AppBackupOperationType = "export" | "restore";
export type AppBackupOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface AppBackupCountsV1 {
  profiles: number;
  environments: number;
  trashEnvironments: number;
  browserData: number;
  groups: number;
  tags: number;
  proxies: number;
  extensions: number;
  extensionSources: number;
  runtimeExtensions: number;
}

/** V1 compatibility payload only; never exposed as a live source authority. */
export interface LegacyExtensionSourceRecord {
  id: string;
  name: string;
  url: string;
  status: "enabled" | "disabled";
  allowUnsignedAssets: boolean;
  lastRefreshedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AppBackupManifestV1 {
  kind: typeof APP_BACKUP_KIND;
  schemaVersion: typeof APP_BACKUP_SCHEMA_VERSION_V1;
  exportedAt: string;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: AppBackupCountsV1;
}

export interface AppBackupDataV1 {
  schemaVersion: typeof APP_BACKUP_SCHEMA_VERSION_V1;
  settings: AppSettings;
  profiles: BrowserProfile[];
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  tags: TagEntity[];
  proxies: ProxyEntity[];
  extensions: LegacyTransferExtension[];
  extensionSources: LegacyExtensionSourceRecord[];
  environmentExtensionBindings?: ExtensionBindingMetadata[];
}

export interface ExtensionArtifactTransferEntry {
  extensionId: string;
  archivePath: string;
  sha256: string;
}

export type AppBackupCountsV2 = Omit<AppBackupCountsV1, "extensionSources"> & {
  retainedExtensionArtifacts: number;
};

export interface AppBackupManifestV2 {
  kind: typeof APP_BACKUP_KIND;
  schemaVersion: typeof APP_BACKUP_SCHEMA_VERSION_V2;
  exportedAt: string;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: AppBackupCountsV2;
}

export interface AppBackupDataV2 {
  schemaVersion: typeof APP_BACKUP_SCHEMA_VERSION_V2;
  settings: AppSettings;
  profiles: BrowserProfile[];
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  tags: TagEntity[];
  proxies: ProxyEntity[];
  extensions: ExtensionEntity[];
  retainedExtensionArtifacts: ExtensionArtifactTransferEntry[];
  environmentExtensionBindings?: ExtensionBindingMetadata[];
}

export type AppBackupCounts = AppBackupCountsV2;
export type AppBackupManifest = AppBackupManifestV2;
export type AppBackupData = AppBackupDataV2;

export type AnyAppBackupManifest = AppBackupManifestV1 | AppBackupManifestV2;
export type AnyAppBackupData = AppBackupDataV1 | AppBackupDataV2;

/** Discriminates the one-way legacy reader from the current portable schema. */
export function decodeAppBackupData(input: unknown): AnyAppBackupData {
  const record = backupRecord(input, "Backup data");
  const common = decodeBackupCollections(record);
  if (record.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V1) {
    if (!Array.isArray(record.extensionSources)) throw backupError("Backup data must include extensionSources.");
    return {
      schemaVersion: APP_BACKUP_SCHEMA_VERSION_V1,
      ...common,
      extensions: common.extensions.map((extension) => extensionForLegacyTransfer(extension)),
      extensionSources: record.extensionSources as LegacyExtensionSourceRecord[],
      environmentExtensionBindings: normalizeExtensionBindingMetadata(record.environmentExtensionBindings),
    };
  }
  if (record.schemaVersion === APP_BACKUP_SCHEMA_VERSION_V2) {
    if (!Array.isArray(record.retainedExtensionArtifacts)) {
      throw backupError("Backup v2 data must include retainedExtensionArtifacts.");
    }
    const extensions = common.extensions.map(normalizeV2Extension);
    const retainedExtensionArtifacts = record.retainedExtensionArtifacts.map(normalizeArtifactTransferEntry)
      .filter((entry) => {
        const extension = extensions.find((candidate) => candidate.id === entry.extensionId);
        return !extension || extension.provenance?.artifact.retained !== false;
      });
    validateExtensionArtifactTransfers(extensions, retainedExtensionArtifacts);
    return {
      schemaVersion: APP_BACKUP_SCHEMA_VERSION_V2,
      ...common,
      extensions,
      retainedExtensionArtifacts,
      environmentExtensionBindings: normalizeExtensionBindingMetadata(record.environmentExtensionBindings),
    };
  }
  throw backupError("Unsupported app backup data schema version.");
}

export function validateExtensionArtifactTransfers(
  extensions: ExtensionEntity[],
  entries: ExtensionArtifactTransferEntry[],
): void {
  const extensionsById = new Map(extensions.map((extension) => [extension.id, extension]));
  const entryByExtensionId = new Map<string, ExtensionArtifactTransferEntry>();
  for (const entry of entries) {
    if (entryByExtensionId.has(entry.extensionId)) throw backupError("Retained extension artifacts contain a duplicate id.");
    const extension = extensionsById.get(entry.extensionId);
    if (!extension) throw backupError("Retained extension artifact references an unknown extension.");
    if (!extension.provenance?.artifact.retained || !extension.artifactArchivePath) {
      throw backupError("Retained extension artifact lacks retained provenance.");
    }
    if (
      (!isRelativePortableArtifactPath(extension.artifactArchivePath) && extension.artifactArchivePath !== entry.archivePath)
      || (!isRelativePortableArtifactPath(extension.sourceUrl) && extension.sourceUrl !== entry.archivePath)
    ) {
      throw backupError("Retained extension artifact path disagrees with its portable archive entry.");
    }
    if (entry.sha256 !== extension.provenance.artifact.sha256) {
      throw backupError("Retained extension artifact fingerprint disagrees with provenance.");
    }
    if (entry.archivePath !== `extension-artifacts/${extension.id}/current.crx`) {
      throw backupError("Retained extension artifact path does not match its extension id.");
    }
    entryByExtensionId.set(entry.extensionId, entry);
  }
  for (const extension of extensions) {
    if (extension.provenance?.artifact.retained && !entryByExtensionId.has(extension.id)) {
      throw backupError("Retained extension provenance is missing its packaged artifact.");
    }
  }
}

function isRelativePortableArtifactPath(value: string | undefined): boolean {
  return typeof value === "string" && /^extension-artifacts\/[A-Za-z0-9_-]{1,256}\/current\.crx$/.test(value);
}

function decodeBackupCollections(record: Record<string, unknown>): Omit<
  AppBackupDataV2,
  "schemaVersion" | "retainedExtensionArtifacts" | "environmentExtensionBindings"
> {
  for (const field of ["profiles", "environments", "groups", "tags", "proxies", "extensions"] as const) {
    if (!Array.isArray(record[field])) throw backupError(`Backup data must include ${field}.`);
  }
  if (!backupIsRecord(record.settings)) throw backupError("Backup data must include settings.");
  validateBackupTransferIds(record);
  return {
    settings: record.settings as unknown as AppSettings,
    profiles: record.profiles as BrowserProfile[],
    environments: record.environments as BrowserEnvironment[],
    groups: record.groups as GroupEntity[],
    tags: record.tags as TagEntity[],
    proxies: record.proxies as ProxyEntity[],
    extensions: record.extensions as ExtensionEntity[],
  };
}

function validateBackupTransferIds(record: Record<string, unknown>): void {
  const collections: Array<{ value: unknown; label: string }> = [];
  for (const [index, value] of (record.profiles as unknown[]).entries()) collections.push({ value, label: `profile ${index}` });
  for (const [index, value] of (record.environments as unknown[]).entries()) collections.push({ value, label: `environment ${index}` });
  for (const [index, value] of (record.groups as unknown[]).entries()) collections.push({ value, label: `group ${index}` });
  for (const [index, value] of (record.tags as unknown[]).entries()) collections.push({ value, label: `tag ${index}` });
  for (const [index, value] of (record.proxies as unknown[]).entries()) collections.push({ value, label: `proxy ${index}` });
  for (const [index, value] of (record.extensions as unknown[]).entries()) collections.push({ value, label: `extension ${index}` });
  for (const item of collections) {
    const value = backupRecord(item.value, `Backup ${item.label}`);
    assertSafeTransferId(value.id, `Backup ${item.label} id`);
    if (Array.isArray(value.extensionIds)) {
      for (const extensionId of value.extensionIds) assertSafeTransferId(extensionId, `Backup ${item.label} extension id`);
    }
  }
}

function assertSafeTransferId(value: unknown, label: string): void {
  if (
    typeof value !== "string"
    || !value.trim()
    || value.length > 256
    || /[\\/\u0000-\u001f\u007f]/.test(value)
    || value === "."
    || value === ".."
    || /^[a-z]:/i.test(value)
    || value.startsWith("\\\\")
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
  ) {
    throw backupError(`${label} is unsafe.`);
  }
}

function normalizeV2Extension(input: ExtensionEntity): ExtensionEntity {
  const record = backupRecord(input, "Backup extension");
  const authority = downgradeIncompleteExtensionAuthority(normalizeExtensionAuthorityFields(record, { allowLegacyIncomplete: true }));
  return {
    ...record,
    ...authority,
    storeId: authority.storeIdentity?.storeId ?? (typeof record.storeId === "string" ? record.storeId : undefined),
    storeUrl: authority.storeIdentity?.listingUrl ?? (typeof record.storeUrl === "string" ? record.storeUrl : undefined),
  } as ExtensionEntity;
}

function normalizeArtifactTransferEntry(input: unknown): ExtensionArtifactTransferEntry {
  const record = backupRecord(input, "Retained extension artifact");
  const extensionId = backupString(record.extensionId, "Retained extension artifact id");
  assertSafeTransferId(extensionId, "Retained extension artifact id");
  const archivePath = backupString(record.archivePath, "Retained extension artifact path");
  if (archivePath.includes("\\") || archivePath.startsWith("/") || /^[a-z]:/i.test(archivePath)) {
    throw backupError("Retained extension artifact path must be relative.");
  }
  const segments = archivePath.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw backupError("Retained extension artifact path is unsafe.");
  }
  const sha256 = backupString(record.sha256, "Retained extension artifact fingerprint").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw backupError("Retained extension artifact fingerprint is invalid.");
  return { extensionId, archivePath, sha256 };
}

function backupRecord(value: unknown, label: string): Record<string, unknown> {
  if (!backupIsRecord(value)) throw backupError(`${label} must be an object.`);
  return value;
}

function backupIsRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function backupString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw backupError(`${label} must be a bounded string.`);
  return value.trim();
}

function backupError(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "APP_BACKUP_SCHEMA_INVALID" });
}

export interface AppBackupOperationResult {
  outputPath?: string;
  inputPath?: string;
  counts: AppBackupCounts;
  warnings: string[];
}

export interface AppBackupOperation {
  id: string;
  type: AppBackupOperationType;
  status: AppBackupOperationStatus;
  phase: string;
  current: number;
  total: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  result?: AppBackupOperationResult;
  error?: string;
}
