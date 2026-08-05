import type { BrowserEnvironment, ExtensionEntity, GroupEntity } from "./entities";

export const ENVIRONMENT_PACKAGE_KIND = "cbpanel.environmentPackage";
export const ENVIRONMENT_PACKAGE_SCHEMA_VERSION = 1;

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
  extensions: ExtensionEntity[];
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
