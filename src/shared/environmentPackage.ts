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
  type LegacyTransferExtension,
} from "./extensionAcquisition";
import {
  validateExtensionArtifactTransfers,
  type ExtensionArtifactTransferEntry,
} from "./appBackup";

export const ENVIRONMENT_PACKAGE_KIND = "cbpanel.environmentPackage";
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1 = 1;
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2 = 2;
/** Production writers remain v1 until Child 3 can transport and re-verify retained artifacts. */
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION = ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V1;

export type EnvironmentPackageScope = "all" | "selected";
export type EnvironmentPackageOperationType = "export" | "import";
export type EnvironmentPackageOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface EnvironmentPackageCounts {
  environments: number;
  browserData: number;
  groups: number;
  extensions: number;
}

export interface EnvironmentPackageManifest {
  kind: typeof ENVIRONMENT_PACKAGE_KIND;
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION;
  exportedAt: string;
  scope: EnvironmentPackageScope;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: EnvironmentPackageCounts;
}

export interface EnvironmentPackageData {
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION;
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  extensions: LegacyTransferExtension[];
  environmentExtensionBindings?: ExtensionBindingMetadata[];
}

export type EnvironmentPackageManifestV1 = EnvironmentPackageManifest;
export type EnvironmentPackageDataV1 = EnvironmentPackageData;

export interface EnvironmentPackageManifestV2 {
  kind: typeof ENVIRONMENT_PACKAGE_KIND;
  schemaVersion: typeof ENVIRONMENT_PACKAGE_SCHEMA_VERSION_V2;
  exportedAt: string;
  scope: EnvironmentPackageScope;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: EnvironmentPackageCounts & { retainedExtensionArtifacts: number };
}

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

/** Pure v1/v2 discriminator; production package services remain v1 until Child 3. */
export function decodeEnvironmentPackageData(input: unknown): AnyEnvironmentPackageData {
  const record = packageRecord(input, "Package data");
  if (!Array.isArray(record.environments)) throw packageError("Package data must include environments.");
  if (!Array.isArray(record.groups)) throw packageError("Package data must include groups.");
  if (!Array.isArray(record.extensions)) throw packageError("Package data must include extensions.");
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
      const authority = normalizeExtensionAuthorityFields(value);
      return {
        ...value,
        ...authority,
        storeId: authority.storeIdentity?.storeId ?? (typeof value.storeId === "string" ? value.storeId : undefined),
        storeUrl: authority.storeIdentity?.listingUrl ?? (typeof value.storeUrl === "string" ? value.storeUrl : undefined),
      } as ExtensionEntity;
    });
    const retainedExtensionArtifacts = record.retainedExtensionArtifacts.map(normalizePackageArtifactEntry);
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

function normalizePackageArtifactEntry(input: unknown): ExtensionArtifactTransferEntry {
  const record = packageRecord(input, "Retained extension artifact");
  const extensionId = packageString(record.extensionId, "Retained extension artifact id");
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
