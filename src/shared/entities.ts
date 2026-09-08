import type { CloakBrowserDiagnostics } from "./browserCore";
import type { BrowserProfile, ProfileMode, ProxyScheme } from "./profile";
import type { XrayIpStrategy, XrayNodeSummary } from "./xray";
import type {
  ExtensionProvenanceV1,
  ExtensionStoreIdentity,
  ExtensionUpdateProviderId,
  ExtensionUpdateState,
} from "./extensionAcquisition";

export type EntityStatus = "enabled" | "disabled";
/** Decode-only values retained for live-DB/v1 retirement; never new network authority. */
export type LegacyExtensionSourceKind = "remote-zip" | "remote-crx";
export type ExtensionSourceKind =
  | "local-directory"
  | "local-zip"
  | "local-crx"
  | "managed-snapshot"
  | LegacyExtensionSourceKind
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
  error?: string;
}

export type ProxyCheckResult = NetworkCheckResult;

/**
 * A "real latency" probe: one round trip through the proxy to a small always-on endpoint, the
 * number v2rayN and GeekEZ show next to a node. Distinct from the exit check, which asks a trace
 * provider who the proxy is and is dominated by that provider's own response time.
 */
export interface ProxyLatencyResult {
  checkedAt: string;
  ok: boolean;
  latencyMs?: number;
  /** The probe endpoint that answered first. */
  target?: string;
  error?: string;
}

export interface ProxyBatchCheckResult {
  id: string;
  result: NetworkCheckResult;
}

export interface ProxyBatchLatencyResult {
  id: string;
  result: ProxyLatencyResult;
}

export interface ProxyBatchDeleteResult {
  deleted: string[];
  /** Proxies still bound to environments; they are kept, with how many environments hold them. */
  blocked: Array<{ id: string; name: string; count: number }>;
}

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
  lastLatency?: ProxyLatencyResult;
  /** Xray share link; a secret like `password`, so "" unless secrets were requested. */
  shareLink: string;
  /** Front proxy (another library entry) for a `[local] -> [front] -> [this] -> [target]` chain, or "". */
  preProxyId: string;
  ipStrategy: XrayIpStrategy;
  /** Server-derived, credential-free view of an xray node so the panel can badge and search it without the link. */
  xrayNode?: XrayNodeSummary;
  /**
   * The remembered subscription this entry came from, or ""/undefined for a standalone proxy. A
   * refresh of that subscription may rename, replace or remove a member; standalone proxies are never
   * touched by a refresh.
   */
  subscriptionId?: string;
  createdAt: string;
  updatedAt: string;
}

/** The outcome of importing pasted share links or a subscription body into the proxy library. */
export interface ProxyImportResult {
  imported: ProxyEntity[];
  /** Masked links, never the pasted ones: a failed line may still carry a credential. Capped; see failedTotal. */
  failed: Array<{ link: string; error: string }>;
  failedTotal: number;
  /** Links already present in the library. */
  skipped: number;
  /** Standalone proxies from an earlier import of the same address that a remembered subscription took over. */
  adopted?: number;
  total: number;
  sourceUrl?: string;
  /** The subscription that was remembered for this import, when the caller asked for one. */
  subscription?: ProxySubscriptionEntity;
}

/** What one refresh of a remembered subscription did to the library. */
export interface ProxySubscriptionRefreshResult {
  checkedAt: string;
  ok: boolean;
  /** Nodes newly created for the subscription. */
  added: number;
  /** Members whose node is still listed; a changed remark renames them in place. */
  kept: number;
  /** Members no longer listed and not in use, so they were deleted. */
  removed: number;
  /** Members bound to an environment or chained by another proxy; they left the subscription as standalone proxies. */
  detached: number;
  /** Listed nodes that already exist as standalone (or another subscription's) proxies and were left alone. */
  skipped: number;
  /** Lines of the body that were not parsable node links. */
  failed: number;
  /** Node links the body contained. */
  total: number;
  error?: string;
}

/**
 * A remembered subscription address. Its members are the proxies whose `subscriptionId` names it;
 * refreshing re-reads the address and makes the members match it.
 */
export interface ProxySubscriptionEntity {
  id: string;
  name: string;
  /** The address itself; it usually carries a token, so it is a secret: "" unless secrets were requested. */
  url: string;
  /** Credential-free `host` of the address for lists and search. */
  urlHost: string;
  status: EntityStatus;
  autoRefresh: boolean;
  refreshIntervalHours: number;
  lastRefresh?: ProxySubscriptionRefreshResult;
  notes: string;
  createdAt: string;
  updatedAt: string;
}

export const PROXY_SUBSCRIPTION_INTERVAL_HOURS = [1, 3, 6, 12, 24, 72, 168] as const;
export const DEFAULT_PROXY_SUBSCRIPTION_INTERVAL_HOURS = 24;

export type XrayEngineOperationType = "install" | "update" | "check-update";

export interface XrayUpdateCheck {
  checkedAt: string;
  currentVersion?: string;
  latestVersion?: string;
  updateAvailable: boolean;
  downloadUrl?: string;
  error?: string;
}

/** One running Xray-core process, owned by exactly one browser session or check. */
export interface XrayEngineInstance {
  ownerId: string;
  /** Loopback SOCKS5 port CloakBrowser (or the exit check) was pointed at. */
  port: number;
  pid?: number;
  startedAt: string;
  /** Masked `protocol://host:port` of the target node. */
  upstream: string;
  /** Masked front proxy when the instance is a chain, otherwise undefined. */
  preProxy?: string;
  restarts: number;
}

export interface XrayEngineStatus {
  installed: boolean;
  /** Where the binary was found: the panel-managed download, an operator path from settings, or nowhere. */
  source: "managed" | "custom" | "missing";
  binaryPath: string;
  binaryDir: string;
  version?: string;
  /** The GitHub release asset this platform downloads, or undefined when Xray ships no build for it. */
  releaseAsset?: string;
  lastUpdateCheck?: XrayUpdateCheck;
  operation?: { type: XrayEngineOperationType; startedAt: string };
  instances: XrayEngineInstance[];
  lastError?: string;
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
  /** Decode-only legacy source relation; migration clears it before normal use. */
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
  extensionCache: ExtensionCacheDiagnostics;
  browserCoreDiagnostics?: CloakBrowserDiagnostics;
  xrayEngine?: XrayEngineStatus;
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
  trash: TrashEnvironment[];
}
