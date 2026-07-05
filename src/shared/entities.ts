import type { CloakBrowserDiagnostics } from "./browserCore";
import type { BrowserProfile, ProfileMode, ProxyScheme } from "./profile";

export type EntityStatus = "enabled" | "disabled";
export type ExtensionSourceKind =
  | "local-directory"
  | "local-zip"
  | "local-crx"
  | "remote-zip"
  | "remote-crx"
  | "chrome-web-store";
export type ExtensionInstallState =
  | "metadata-only"
  | "download-pending"
  | "downloading"
  | "installed"
  | "update-available"
  | "local-missing"
  | "invalid-manifest"
  | "install-failed";
export type ExtensionUpdatePolicy = "pinned" | "notify" | "auto";
export type ExtensionPermissionRiskLevel = "low" | "medium" | "high";
export type SecretExportMode = "masked" | "full";

export interface ReferenceUsage {
  entityId: string;
  entityKind: "group" | "tag" | "proxy" | "extension";
  environmentIds: string[];
  count: number;
}

export interface ReferenceConflict {
  error: string;
  code: "REFERENCE_CONFLICT";
  usage: ReferenceUsage;
}

export interface GroupEntity {
  id: string;
  name: string;
  color: string;
  description: string;
  order: number;
  status: EntityStatus;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TagEntity {
  id: string;
  name: string;
  color: string;
  description: string;
  order: number;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NetworkGeoResult {
  countryCode?: string;
  countryName?: string;
  cityName?: string;
  timezone?: string;
  locale?: string;
}

export interface NetworkTraceResult {
  providerId: string;
  providerName: string;
  providerUrl: string;
  host?: string;
  loc?: string;
  colo?: string;
  http?: string;
  tls?: string;
  warp?: string;
  gateway?: string;
  raw?: Record<string, string>;
}

export interface NetworkCheckResult {
  checkedAt: string;
  ok: boolean;
  ip?: string;
  latencyMs?: number;
  geo?: NetworkGeoResult;
  trace?: NetworkTraceResult;
  source?: "proxy-check" | "environment-check" | "launch-geoip";
  error?: string;
}

export type ProxyCheckResult = NetworkCheckResult;

export interface ProxyEntity {
  id: string;
  name: string;
  scheme: ProxyScheme;
  host: string;
  port: string;
  username: string;
  password: string;
  bypass: string;
  notes: string;
  status: EntityStatus;
  lastCheck?: ProxyCheckResult;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionPermissionRisk {
  permission: string;
  level: ExtensionPermissionRiskLevel;
  reason: string;
}

export interface ExtensionEntity {
  id: string;
  name: string;
  description: string;
  sourceKind: ExtensionSourceKind;
  sourceUrl: string;
  sourceId?: string;
  storeId?: string;
  storeUrl?: string;
  version: string;
  manifestVersion?: number;
  permissions: string[];
  hostPermissions: string[];
  permissionRisks: ExtensionPermissionRisk[];
  installState: ExtensionInstallState;
  updatePolicy: ExtensionUpdatePolicy;
  sha256?: string;
  localPath?: string;
  lastInstalledAt?: string;
  lastCheckedAt?: string;
  lastError?: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionSourceEntity {
  id: string;
  name: string;
  url: string;
  status: EntityStatus;
  allowUnsignedAssets: boolean;
  lastRefreshedAt?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExtensionSourceRefreshResult {
  source: ExtensionSourceEntity;
  imported: number;
  updated: number;
  skipped: number;
  extensions: ExtensionEntity[];
}

export interface ExtensionDirectoryCandidate {
  id: string;
  extensionId: string;
  name: string;
  version: string;
  manifestVersion?: number;
  path: string;
  permissionRisks: ExtensionPermissionRisk[];
}

export interface ExtensionDirectoryPreviewResult {
  rootPath: string;
  direct?: ExtensionDirectoryCandidate;
  candidates: ExtensionDirectoryCandidate[];
}

export interface ExtensionDirectoryImportFailure {
  path: string;
  error: string;
}

export interface ExtensionDirectoryImportResult {
  imported: ExtensionEntity[];
  failed: ExtensionDirectoryImportFailure[];
  skipped: number;
}

export interface BrowserEnvironment {
  id: string;
  name: string;
  notes: string;
  mode: ProfileMode;
  startUrl: string;
  groupId: string;
  tagIds: string[];
  proxyId?: string;
  extensionIds: string[];
  runtimeProfile: BrowserProfile;
  lastNetworkCheck?: NetworkCheckResult;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string;
  deleteReason?: string;
}

export interface ResolvedEnvironment {
  environment: BrowserEnvironment;
  profile: BrowserProfile;
  group?: GroupEntity;
  tags: TagEntity[];
  proxy?: ProxyEntity;
  extensions: ExtensionEntity[];
  extensionPaths: string[];
  warnings: string[];
}

export interface TrashEnvironment {
  environment: BrowserEnvironment;
  deletedAt: string;
  deleteReason?: string;
}

export interface ExtensionCacheDiagnostics {
  directory: string;
  installedCount: number;
  bytes?: number;
  lastError?: string;
}

export interface SystemDiagnostics {
  checkedAt: string;
  schemaVersion: number;
  dataDir: string;
  databasePath?: string;
  portable: boolean;
  storage: {
    kind: "sqlite";
    migratedFromJson: boolean;
    migrationError?: string;
  };
  sessions: {
    total: number;
    running: number;
    launching: number;
    error: number;
  };
  networkTrace: {
    providerId: string;
    providerName: string;
    providerUrl: string;
    timeoutSeconds: number;
  };
  extensionSources: {
    total: number;
    enabled: number;
    lastError?: string;
  };
  extensionCache: ExtensionCacheDiagnostics;
  browserCoreDiagnostics?: CloakBrowserDiagnostics;
  recentErrors: Array<{
    at: string;
    source: string;
    message: string;
  }>;
}

export interface RegistryState {
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  tags: TagEntity[];
  proxies: ProxyEntity[];
  extensions: ExtensionEntity[];
  extensionSources: ExtensionSourceEntity[];
  trash: TrashEnvironment[];
}
