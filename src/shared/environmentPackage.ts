import {
  normalizeExtensionBindingMetadata,
  type BrowserEnvironment,
  type ExtensionBindingMetadata,
  type ExtensionEntity,
  type GroupEntity,
} from "./entities";
import {
  extensionForLegacyTransfer,
  normalizeExtensionAuthorityFields,
  downgradeIncompleteExtensionAuthority,
  type LegacyTransferExtension,
} from "./extensionAcquisition";
import {
  validateExtensionArtifactTransfers,
  type ExtensionArtifactTransferEntry,
} from "./appBackup";

export const ENVIRONMENT_PACKAGE_KIND = "cbpanel.environmentPackage";
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1 = 1;
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2 = 2;
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION = ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2;

export type EnvironmentPackageScope = "all" | "selected";
export type EnvironmentPackageOperationType = "export" | "import";
export type EnvironmentPackageOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface EnvironmentPackageCountsV1 {
  environments: number;
  browserData: number;
  groups: number;
  extensions: number;
}

export interface EnvironmentPackageManifestV1 {
  kind: typeof ENVIRONMENT_PACKAGE_KIND;
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1;
  exportedAt: string;
  scope: EnvironmentPackageScope;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: EnvironmentPackageCountsV1;
}

export interface EnvironmentPackageDataV1 {
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1;
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  extensions: LegacyTransferExtension[];
  environmentExtensionBindings?: ExtensionBindingMetadata[];
}

export interface EnvironmentPackageManifestV2 {
  kind: typeof ENVIRONMENT_PACKAGE_KIND;
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2;
  exportedAt: string;
  scope: EnvironmentPackageScope;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: Omit<EnvironmentPackageCountsV1, never> & { retainedExtensionArtifacts: number };
}

export type EnvironmentPackageCountsV2 = EnvironmentPackageManifestV2["counts"];
export type EnvironmentPackageCounts = EnvironmentPackageCountsV2;
export type EnvironmentPackageManifest = EnvironmentPackageManifestV2;
export type EnvironmentPackageData = EnvironmentPackageDataV2;

export interface EnvironmentPackageDataV2 {
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2;
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  extensions: ExtensionEntity[];
  retainedExtensionArtifacts: ExtensionArtifactTransferEntry[];
  environmentExtensionBindings?: ExtensionBindingMetadata[];
}

export type AnyEnvironmentPackageManifest = EnvironmentPackageManifestV1 | EnvironmentPackageManifestV2;
export type AnyEnvironmentPackageData = EnvironmentPackageDataV1 | EnvironmentPackageDataV2;

/** Discriminator used by both package preparation and v1 one-way migration. */
export function decodeEnvironmentPackageData(input: unknown): AnyEnvironmentPackageData {
  const record = packageRecord(input, "Package data");
  if (!Array.isArray(record.environments)) throw packageError("Package data must include environments.");
  if (!Array.isArray(record.groups)) throw packageError("Package data must include groups.");
  if (!Array.isArray(record.extensions)) throw packageError("Package data must include extensions.");
  validatePackageTransferIds(record);
  const environmentExtensionBindings = normalizeExtensionBindingMetadata(record.environmentExtensionBindings);
  if (record.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1) {
    return {
      schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1,
      environments: record.environments as BrowserEnvironment[],
      groups: record.groups as GroupEntity[],
      extensions: record.extensions.map((extension) => extensionForLegacyTransfer(
        packageRecord(extension, "Package extension") as unknown as ExtensionEntity,
      )),
      environmentExtensionBindings,
    };
  }
  if (record.schemaVersion === ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2) {
    if (!Array.isArray(record.retainedExtensionArtifacts)) {
      throw packageError("Package v2 data must include retainedExtensionArtifacts.");
    }
    const extensions = record.extensions.map((extension) => {
      const value = packageRecord(extension, "Package extension");
      const authority = downgradeIncompleteExtensionAuthority(normalizeExtensionAuthorityFields(value, { allowLegacyIncomplete: true }));
      return {
        ...value,
        ...authority,
        storeId: authority.storeIdentity?.storeId ?? (typeof value.storeId === "string" ? value.storeId : undefined),
        storeUrl: authority.storeIdentity?.listingUrl ?? (typeof value.storeUrl === "string" ? value.storeUrl : undefined),
      } as ExtensionEntity;
    });
    const retainedExtensionArtifacts = record.retainedExtensionArtifacts.map(normalizePackageArtifactEntry)
      .filter((entry) => {
        const extension = extensions.find((candidate) => candidate.id === entry.extensionId);
        return !extension || extension.provenance?.artifact.retained !== false;
      });
    validateExtensionArtifactTransfers(extensions, retainedExtensionArtifacts);
    return {
      schemaVersion: ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2,
      environments: record.environments as BrowserEnvironment[],
      groups: record.groups as GroupEntity[],
      extensions,
      retainedExtensionArtifacts,
      environmentExtensionBindings,
    };
  }
  throw packageError("Unsupported environment package data schema version.");
}

function validatePackageTransferIds(record: Record<string, unknown>): void {
  const collections = [
    ...(record.environments as unknown[]).map((value, index) => ({ value, label: `environment ${index}` })),
    ...(record.groups as unknown[]).map((value, index) => ({ value, label: `group ${index}` })),
    ...(record.extensions as unknown[]).map((value, index) => ({ value, label: `extension ${index}` })),
  ];
  for (const item of collections) {
    const value = packageRecord(item.value, `Package ${item.label}`);
    assertSafePackageId(value.id, `Package ${item.label} id`);
    if (Array.isArray(value.extensionIds)) {
      for (const extensionId of value.extensionIds) assertSafePackageId(extensionId, `Package ${item.label} extension id`);
    }
  }
}

function assertSafePackageId(value: unknown, label: string): void {
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
    throw packageError(`${label} is unsafe.`);
  }
}

function normalizePackageArtifactEntry(input: unknown): ExtensionArtifactTransferEntry {
  const record = packageRecord(input, "Retained extension artifact");
  const extensionId = packageString(record.extensionId, "Retained extension artifact id");
  assertSafePackageId(extensionId, "Retained extension artifact id");
  const archivePath = packageString(record.archivePath, "Retained extension artifact path");
  if (
    archivePath.includes("\\")
    || archivePath.startsWith("/")
    || /^[a-z]:/i.test(archivePath)
    || archivePath.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw packageError("Retained extension artifact path is unsafe.");
  }
  const sha256 = packageString(record.sha256, "Retained extension artifact fingerprint").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw packageError("Retained extension artifact fingerprint is invalid.");
  return { extensionId, archivePath, sha256 };
}

function packageRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw packageError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function packageString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) throw packageError(`${label} must be a bounded string.`);
  return value.trim();
}

function packageError(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "ENVIRONMENT_PACKAGE_SCHEMA_INVALID" });
}

export interface EnvironmentPackageOperationResult {
  outputPath?: string;
  inputPath?: string;
  counts: EnvironmentPackageCounts;
  warnings: string[];
  idMap?: {
    environments: Record<string, string>;
    groups: Record<string, string>;
    extensions: Record<string, string>;
  };
}

export interface EnvironmentPackageOperation {
  id: string;
  type: EnvironmentPackageOperationType;
  status: EnvironmentPackageOperationStatus;
  phase: string;
  current: number;
  total: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  result?: EnvironmentPackageOperationResult;
  error?: string;
}
