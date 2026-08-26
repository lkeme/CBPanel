import type { CloakBrowserDiagnostics } from "./browserCore";
import type { LaunchGeoUnresolvedReason } from "./launchGeoip";
import type { BrowserProfile, ProfileMode, ProxyScheme } from "./profile";
import type {
  ExtensionProvenanceV1,
  ExtensionStoreIdentity,
  ExtensionUpdateProviderId,
  ExtensionUpdateState,
} from "./extensionAcquisition";

export type EntityStatus = "enabled" | "disabled";
export type ExtensionSourceKind =
  | "local-directory"
  | "local-zip"
  | "local-crx"
  | "managed-snapshot"
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
export type ExtensionDirectoryMode = "copy" | "reference";
export type ExtensionPermissionRiskLevel = "low" | "medium" | "high";
export type ExtensionPermissionRiskReasonKey =
  | "all-urls"
  | "content-script-all-urls"
  | "high-privilege"
  | "tabs-metadata";
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
  // `launch-geoip` is not another exit probe: it reports what a `geoip: true` launch would inject,
  // read from the browser core's own GeoLite2 database. `proxy-check` reports what the configured
  // trace provider sees. The two can legitimately disagree, so the source is never inferred from
  // the shape of the result.
  source?: "proxy-check" | "environment-check" | "launch-geoip";
  /** Set only when `source === "launch-geoip"` and an exit IP resolved but the GeoIP database could not supply the timezone/locale. `ok` stays true — the exit IP is a real answer, and upstream's resolver returns it with a missing database too. Same value as `CloakBrowserDiagnosticsGeoIpResolved.unresolvedReason`. */
  geoUnresolvedReason?: LaunchGeoUnresolvedReason;
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
  /** Human-readable reason kept for compatibility with rows stored before reasonKey existed. */
  reason: string;
  /** Machine-readable reason so the UI can localize the tooltip; absent on legacy rows. */
  reasonKey?: ExtensionPermissionRiskReasonKey;
  optional?: boolean;
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
  /** Canonical store identity. Legacy storeId/storeUrl remain compatibility projections. */
  storeIdentity?: ExtensionStoreIdentity;
  /** Server-derived catalog, transport, verification, and transfer facts. */
  provenance?: ExtensionProvenanceV1;
  /** App-managed retained package used for reinstall/backup; never client-owned. */
  artifactArchivePath?: string;
  /** Remote update authority, independent from catalog and initial transport. */
  updateProviderId?: ExtensionUpdateProviderId;
  /** Last remote update outcome; local install health remains in installState. */
  updateState?: ExtensionUpdateState;
  version: string;
  manifestVersion?: number;
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions?: string[];
  optionalHostPermissions?: string[];
  permissionRisks: ExtensionPermissionRisk[];
  installState: ExtensionInstallState;
  updatePolicy: ExtensionUpdatePolicy;
  sha256?: string;
  /**
   * Canonical digest of the `manifest.json` of the package currently installed at `localPath`
   * (top-level `key` removed), so the same extension imported as an archive and as an unpacked
   * directory resolves to one identity. Server-owned; `check()` recomputes it on every successful
   * run, which both backfills rows written before it existed and keeps it honest after an update.
   */
  manifestSha256?: string;
  localPath?: string;
  manifestKey?: string;
  directoryMode?: ExtensionDirectoryMode;
  lastInstalledAt?: string;
  lastCheckedAt?: string;
  lastError?: string;
  status: EntityStatus;
  createdAt: string;
  updatedAt: string;
}

/** Optional lifecycle metadata carried by new backups/packages; old archives omit it safely. */
export interface ExtensionBindingMetadata {
  environmentId: string;
  extensionId: string;
  lifecycleRevision?: string;
}

/** A nonempty one-time binding token whose first materialization must adopt existing browser state. */
export const PRESERVE_LIFECYCLE_REVISION_PREFIX = "preserve:";

export function isPreserveLifecycleRevision(revision: string | undefined): boolean {
  return Boolean(revision?.startsWith(PRESERVE_LIFECYCLE_REVISION_PREFIX)
    && revision.length > PRESERVE_LIFECYCLE_REVISION_PREFIX.length);
}

export function normalizeExtensionBindingMetadata(input: unknown): ExtensionBindingMetadata[] | undefined {
  if (input === undefined) return undefined;
  if (!Array.isArray(input)) throw invalidExtensionBindingMetadata("Extension binding metadata must be an array");
  const bindings = new Map<string, ExtensionBindingMetadata>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw invalidExtensionBindingMetadata("Extension binding metadata entries must be objects");
    }
    const record = value as Record<string, unknown>;
    const environmentId = typeof record.environmentId === "string" ? record.environmentId.trim() : "";
    const extensionId = typeof record.extensionId === "string" ? record.extensionId.trim() : "";
    if (!environmentId || !extensionId) throw invalidExtensionBindingMetadata("Extension binding metadata ids cannot be empty");
    if (record.lifecycleRevision !== undefined && typeof record.lifecycleRevision !== "string") {
      throw invalidExtensionBindingMetadata("Extension binding lifecycle revision must be a string");
    }
    const lifecycleRevision = typeof record.lifecycleRevision === "string" && record.lifecycleRevision.trim()
      ? record.lifecycleRevision.trim()
      : undefined;
    bindings.set(`${environmentId}\0${extensionId}`, { environmentId, extensionId, lifecycleRevision });
  }
  return [...bindings.values()];
}

function invalidExtensionBindingMetadata(message: string): Error {
  return Object.assign(new Error(message), { status: 400 });
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

/** Base64 icon payload read on demand from the extension's own manifest; never persisted. */
export interface ExtensionIconAsset {
  mime: string;
  data: string;
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
