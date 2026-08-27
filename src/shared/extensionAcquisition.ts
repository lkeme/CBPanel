import type { ExtensionEntity, ExtensionPermissionRisk } from "./entities";

export const CHROME_EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
export const EXTENSION_ACQUISITION_DISCLOSURE_VERSION = 1;

export type ExtensionStoreNamespace = "chrome-web-store";
export type ExtensionCatalogProviderId = "crxsoso";
export type ExtensionArtifactProviderId = "chrome-web-store" | "crxsoso";
export type ExtensionUpdateProviderId = ExtensionArtifactProviderId;
export type ExtensionVerificationLevel =
  | "cws-publisher-verified"
  | "developer-signed"
  | "unsigned-or-repacked"
  | "legacy-unknown";

export type ExtensionAcquisitionCapabilityId =
  | "crxsoso-search"
  | "google-artifact"
  | "crxsoso-artifact";

export type ExtensionCapabilityOperation =
  | "search"
  | "resolve-id"
  | "download-current"
  | "open-listing";

export interface ExtensionCapabilityDefinition {
  id: ExtensionAcquisitionCapabilityId;
  kind: "catalog-search" | "artifact";
  providerId: ExtensionCatalogProviderId | ExtensionArtifactProviderId;
  trust: "google-hosted" | "third-party";
  operations: readonly ExtensionCapabilityOperation[];
}

export interface ExtensionCapabilityDescriptor extends ExtensionCapabilityDefinition {
  enabled: boolean;
}

export interface ExtensionCapabilityHealth {
  status: "healthy" | "unavailable";
  checkedAt: string;
  errorCode?: ExtensionAcquisitionErrorCode;
}

export interface ExtensionCapabilityView extends ExtensionCapabilityDescriptor {
  health?: ExtensionCapabilityHealth;
}

export type ExtensionAcquisitionSettingsLike = {
  /** The one canonical artifact channel; legacy switches never enter runtime services. */
  artifactProviderId: ExtensionArtifactProviderId;
};

/** Resolve the one authoritative runtime artifact channel, failing safe to the approved default. */
export function selectedExtensionArtifactProvider(
  settings: ExtensionAcquisitionSettingsLike,
): ExtensionArtifactProviderId {
  return settings.artifactProviderId === "chrome-web-store" ? "chrome-web-store" : "crxsoso";
}

export const EXTENSION_CAPABILITY_DEFINITIONS: readonly ExtensionCapabilityDefinition[] = Object.freeze([
  Object.freeze({
    id: "crxsoso-search",
    kind: "catalog-search",
    providerId: "crxsoso",
    trust: "third-party",
    operations: Object.freeze(["search"] as const),
  }),
  Object.freeze({
    id: "google-artifact",
    kind: "artifact",
    providerId: "chrome-web-store",
    trust: "google-hosted",
    operations: Object.freeze(["resolve-id", "download-current", "open-listing"] as const),
  }),
  Object.freeze({
    id: "crxsoso-artifact",
    kind: "artifact",
    providerId: "crxsoso",
    trust: "third-party",
    operations: Object.freeze(["resolve-id", "download-current", "open-listing"] as const),
  }),
]);

export function extensionCapabilityDescriptors(
  settings: ExtensionAcquisitionSettingsLike,
): ExtensionCapabilityDescriptor[] {
  const selected = selectedExtensionArtifactProvider(settings);
  return EXTENSION_CAPABILITY_DEFINITIONS.map((definition) => ({
    ...definition,
    operations: [...definition.operations],
    // Catalog search is a built-in capability, not a user toggle.  The
    // selected artifact channel is the only package capability enabled.
    enabled: definition.id === "crxsoso-search"
      || definition.providerId === selected,
  }));
}

export interface ExtensionStoreIdentity {
  namespace: ExtensionStoreNamespace;
  storeId: string;
  listingUrl: string;
}

export interface ExtensionProvenanceV1 {
  schemaVersion: 1;
  catalog?: {
    providerId: ExtensionCatalogProviderId;
    observedAt: string;
  };
  artifact: {
    providerId: ExtensionArtifactProviderId | "manual-local" | "legacy";
    /** Historical provenance only; never executable network or filesystem authority. */
    legacySourceUrl?: string;
    finalByteHost?: string;
    fetchedAt?: string;
    format: "crx3" | "crx2" | "zip" | "directory" | "unknown";
    size?: number;
    sha256?: string;
    retained: boolean;
  };
  verification: {
    level: ExtensionVerificationLevel;
    verifiedAt?: string;
    proofDerivedStoreId?: string;
      developerKeySha256?: string;
      publisherKeySha256?: string;
    publisherTrustRootId?: string;
      publisherTrustRootVersion?: number;
      manifestSha256?: string;
      /** Fingerprint of the committed unpacked tree after the exact developer key is applied. */
      treeSha256?: string;
  };
  transfer?: {
    kind: "direct-acquisition" | "full-backup-restore" | "environment-package-import";
    at: string;
  };
}

export interface ExtensionUpdateState {
  status: "idle" | "available" | "provider-disabled" | "provider-unavailable" | "takedown";
  checkedAt?: string;
  availableVersion?: string;
  errorCode?: string;
}

export type ExtensionAuthorityFields = Pick<
  ExtensionEntity,
  "storeIdentity" | "provenance" | "artifactArchivePath" | "updateProviderId" | "updateState"
>;

export interface ExtensionCatalogItem {
  /** Opaque server-side handle for optional catalog facts; never a provider token. */
  observationId?: string;
  namespace: ExtensionStoreNamespace;
  storeId: string;
  storeUrl: string;
  catalogProviderId: ExtensionCatalogProviderId;
  observedAt: string;
  name: string;
  description?: string;
  category?: string;
  rating?: number;
  userCount?: number;
}

export interface ExtensionArtifactOffer {
  namespace: ExtensionStoreNamespace;
  storeId: string;
  artifactProviderId: ExtensionArtifactProviderId;
  format: "crx3";
  providerLabel: string;
}

export interface ExtensionCatalogSearchRequest {
  query: string;
  cursor?: string;
}

export interface ExtensionCatalogSearchPage {
  query: string;
  items: ExtensionCatalogItem[];
  excludedNonCanonicalCount: number;
  cursor?: string;
  hasMore: boolean;
}

export interface ExtensionReferenceResolveRequest {
  input: string;
}

export interface ExtensionReferenceResolution {
  namespace: ExtensionStoreNamespace;
  storeId: string;
  /** Canonical Chrome Web Store identity URL, not the selected provider's UI URL. */
  storeUrl: string;
  offers: ExtensionArtifactOffer[];
}

export type ExtensionReference =
  | {
      kind: "canonical";
      source: "id" | "chrome-web-store-url" | "crxsoso-url";
      storeId: string;
      storeUrl: string;
    }
  | { kind: "keyword"; query: string }
  | {
      kind: "invalid";
      code: "ACQUISITION_INPUT_EMPTY" | "ACQUISITION_INPUT_UNSUPPORTED";
      message: string;
    };

export type ExtensionAcquisitionErrorCode =
  | "ACQUISITION_INPUT_EMPTY"
  | "ACQUISITION_INPUT_UNSUPPORTED"
  | "CATALOG_PROVIDER_DISABLED"
  | "CATALOG_DISCLOSURE_REQUIRED"
  | "EXTENSION_CATALOG_RATE_LIMITED"
  | "EXTENSION_CATALOG_TIMEOUT"
  | "EXTENSION_CATALOG_NETWORK"
  | "EXTENSION_CATALOG_HTTP_ERROR"
  | "EXTENSION_CATALOG_RESPONSE_TOO_LARGE"
  | "EXTENSION_CATALOG_REDIRECT_REJECTED"
  | "EXTENSION_CATALOG_SCHEMA_CHANGED"
  | "EXTENSION_CATALOG_CURSOR_INVALID"
  | "EXTENSION_CATALOG_CURSOR_EXPIRED"
  | "ARTIFACT_PROVIDER_DISABLED"
  | "ARTIFACT_PROVIDER_HTTP_ERROR"
  | "ARTIFACT_UNAVAILABLE"
  | "ARTIFACT_TIMEOUT"
  | "ARTIFACT_NETWORK"
  | "ARTIFACT_REDIRECT_LOOP"
  | "ARTIFACT_REDIRECT_REJECTED"
  | "ARTIFACT_TOO_LARGE"
  | "BROWSER_CORE_VERSION_REQUIRED"
  | "STORE_CRX3_REQUIRED"
  | "CRX_DEVELOPER_PROOF_INVALID"
  | "CRX_ID_MISMATCH"
  | "CWS_PUBLISHER_PROOF_REQUIRED"
  | "EXTENSION_ARCHIVE_INVALID"
  | "EXTENSION_ARCHIVE_UNSAFE_PATH"
  | "EXTENSION_ARCHIVE_RESOURCE_LIMIT"
  | "EXTENSION_MANIFEST_INVALID"
  | "ACQUISITION_TEMP_BUDGET_EXCEEDED"
  | "ACQUISITION_SESSION_NOT_FOUND"
  | "ACQUISITION_SESSION_NOT_READY"
  | "ACQUISITION_SESSION_CONSUMED"
  | "ACQUISITION_CONFLICT_TARGET_INVALID"
  | "ACQUISITION_IDENTITY_CONFLICT"
  | "ACQUISITION_PERMISSION_INCREASE"
  | "ACQUISITION_UPDATE_PROVIDER_INVALID"
  | "ACQUISITION_RECONCILIATION_REQUIRED"
  | "ACQUISITION_COMMIT_FAILED"
  | "ACQUISITION_CANCELLED"
  | "ACQUISITION_EXPIRED";

export interface ExtensionPreflightReport {
  sessionId: string;
  expiresAt: string;
  identity: {
    namespace: ExtensionStoreNamespace;
    requestedStoreId: string;
    proofDerivedStoreId: string;
    matches: true;
  };
  package: {
    name: string;
    description: string;
    version: string;
    manifestVersion: number;
    format: "crx3";
    size: number;
    sha256: string;
    manifestSha256: string;
    treeSha256: string;
    entryCount: number;
    filesystemNodeCount: number;
    fileCount: number;
    expandedBytes: number;
    icon?: {
      relativePath: string;
      mimeType: string;
      size: number;
    };
  };
  transport: {
    selectedProviderId: ExtensionArtifactProviderId;
    finalByteHost: string;
    fetchedAt: string;
    durationMs: number;
  };
  verification: {
    level: "cws-publisher-verified";
    developerKeySha256: string;
    publisherTrustRootId: string;
    publisherTrustRootVersion: number;
    developerProofAlgorithm: "rsa-sha256" | "ecdsa-sha256";
    publisherProofAlgorithm: "rsa-sha256" | "ecdsa-sha256";
  };
  permissions: string[];
  hostPermissions: string[];
  optionalPermissions: string[];
  optionalHostPermissions: string[];
  permissionRisks: ExtensionPermissionRisk[];
  discrepancies: Array<{ field: "name" | "version"; catalog?: string; package: string }>;
  permissionApproval?: {
    token: string;
    added: string[];
  };
  catalog?: {
    providerId: ExtensionCatalogProviderId;
    observedAt: string;
  };
  conflicts: ExtensionAcquisitionConflictCandidate[];
}

export type ExtensionAcquisitionPurpose = "install" | "update";
export type ExtensionAcquisitionSessionStatus =
  | "created"
  | "downloading"
  | "verifying"
  | "analyzing"
  | "ready"
  | "committing"
  | "consumed"
  | "rejected"
  | "cancelled"
  | "expired";

export interface ExtensionAcquisitionConflictCandidate {
  extensionId: string;
  name: string;
  version: string;
  installState: ExtensionEntity["installState"];
  matchBy: "store-identity" | "developer-identity" | "metadata-store-id";
  eligible: boolean;
  blockingReason?: "developer-identity-mismatch" | "ambiguous-metadata" | "installed-identity-missing";
}

export interface ExtensionAcquisitionSessionError {
  code: ExtensionAcquisitionErrorCode;
  message: string;
}

export interface ExtensionAcquisitionSessionView {
  sessionId: string;
  purpose: ExtensionAcquisitionPurpose;
  namespace: ExtensionStoreNamespace;
  storeId: string;
  selectedProviderId: ExtensionArtifactProviderId;
  status: ExtensionAcquisitionSessionStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  downloadedBytes?: number;
  report?: ExtensionPreflightReport;
  error?: ExtensionAcquisitionSessionError;
}

export interface ExtensionAcquisitionSessionCreateRequest {
  namespace: ExtensionStoreNamespace;
  storeId: string;
  artifactProviderId: ExtensionArtifactProviderId;
  purpose: ExtensionAcquisitionPurpose;
  targetExtensionId?: string;
  catalogObservationId?: string;
}

export interface ExtensionAcquisitionSessionConfirmRequest {
  disposition: "create" | "upgrade" | "reuse";
  targetExtensionId?: string;
  environmentIds?: string[];
  permissionApprovalToken?: string;
}

export function isCanonicalChromeExtensionId(value: unknown): value is string {
  return typeof value === "string" && CHROME_EXTENSION_ID_PATTERN.test(value);
}

export function chromeWebStoreListingUrl(storeId: string): string {
  if (!isCanonicalChromeExtensionId(storeId)) {
    throw contractError("Chrome extension id must contain exactly 32 letters from a to p.");
  }
  return `https://chromewebstore.google.com/detail/${storeId}`;
}

export function classifyExtensionReference(input: unknown): ExtensionReference {
  const value = typeof input === "string" ? input.trim() : "";
  if (!value) {
    return { kind: "invalid", code: "ACQUISITION_INPUT_EMPTY", message: "Enter a keyword, Chrome Web Store URL, or extension id." };
  }
  if (isCanonicalChromeExtensionId(value)) {
    return canonicalReference(value, "id");
  }
  if (/^[a-z]{32}$/i.test(value)) {
    return unsupportedReference("Chrome extension ids must use lowercase letters from a to p.");
  }
  if (hasUnsafeRawUrlPath(value)) {
    return unsupportedReference("Extension detail URLs must use an exact, normalized path.");
  }

  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch {
    if (looksLikeAbsoluteUrl(value)) return unsupportedReference("This URL is not a supported extension detail URL.");
    return { kind: "keyword", query: value };
  }

  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) {
    return unsupportedReference("Only supported HTTPS extension detail URLs without credentials or custom ports can be used.");
  }
  const rawAuthority = rawUrlAuthority(value);
  if (!rawAuthority || rawAuthority.toLowerCase() !== parsed.hostname) {
    return unsupportedReference("Extension detail URLs must use an exact ASCII hostname.");
  }
  if (/%(?:2f|5c)/i.test(parsed.pathname)) {
    return unsupportedReference("Encoded path separators are not allowed in extension detail URLs.");
  }

  // Keep empty segments visible: trailing or repeated slashes are not an exact supported detail path.
  const segments = parsed.pathname.split("/").slice(1);
  if (parsed.hostname === "chromewebstore.google.com") {
    const id = detailPathId(segments, ["detail"]);
    return id ? canonicalReference(id, "chrome-web-store-url") : unsupportedReference("Use a Chrome Web Store extension detail URL.");
  }
  if (parsed.hostname === "chrome.google.com") {
    const id = detailPathId(segments, ["webstore", "detail"]);
    return id ? canonicalReference(id, "chrome-web-store-url") : unsupportedReference("Use a legacy Chrome Web Store extension detail URL.");
  }
  if (parsed.hostname === "www.crxsoso.com") {
    const id = detailPathId(segments, ["webstore", "detail"]);
    return id ? canonicalReference(id, "crxsoso-url") : unsupportedReference("Use a CRX搜搜 Chrome extension detail URL with a canonical id.");
  }
  return unsupportedReference("This website is not a supported extension source.");
}

export function normalizeExtensionStoreIdentity(input: unknown): ExtensionStoreIdentity | undefined {
  if (input === undefined || input === null) return undefined;
  const record = requiredRecord(input, "Extension store identity");
  if (record.namespace !== "chrome-web-store") throw contractError("Unsupported extension store namespace.");
  const storeId = requiredCanonicalId(record.storeId, "Extension store id");
  const listingUrl = chromeWebStoreListingUrl(storeId);
  if (record.listingUrl !== listingUrl) throw contractError("Extension store listing URL does not match its canonical id.");
  return { namespace: "chrome-web-store", storeId, listingUrl };
}

export function normalizeExtensionProvenance(input: unknown): ExtensionProvenanceV1 | undefined {
  if (input === undefined || input === null) return undefined;
  const record = requiredRecord(input, "Extension provenance");
  if (record.schemaVersion !== 1) throw contractError("Unsupported extension provenance schema version.");
  const artifact = requiredRecord(record.artifact, "Extension artifact provenance");
  const verification = requiredRecord(record.verification, "Extension verification provenance");
  const providerId = enumField(
    artifact.providerId,
    ["chrome-web-store", "crxsoso", "manual-local", "legacy"] as const,
    "Extension artifact provider",
  );
  const format = enumField(artifact.format, ["crx3", "crx2", "zip", "directory", "unknown"] as const, "Extension artifact format");
  if (typeof artifact.retained !== "boolean") throw contractError("Extension artifact retained must be boolean.");
  const level = enumField(
    verification.level,
    ["cws-publisher-verified", "developer-signed", "unsigned-or-repacked", "legacy-unknown"] as const,
    "Extension verification level",
  );
  if (
    (providerId === "chrome-web-store" || providerId === "crxsoso")
    && level !== "cws-publisher-verified"
  ) {
    throw contractError("Remote store artifact provenance requires Chrome Web Store publisher verification.");
  }

  let catalog: ExtensionProvenanceV1["catalog"];
  if (record.catalog !== undefined) {
    const value = requiredRecord(record.catalog, "Extension catalog provenance");
    if (value.providerId !== "crxsoso") throw contractError("Unsupported extension catalog provider.");
    catalog = { providerId: "crxsoso", observedAt: requiredIsoTimestamp(value.observedAt, "Catalog observation time") };
  }
  let transfer: ExtensionProvenanceV1["transfer"];
  if (record.transfer !== undefined) {
    const value = requiredRecord(record.transfer, "Extension transfer provenance");
    transfer = {
      kind: enumField(
        value.kind,
        ["direct-acquisition", "full-backup-restore", "environment-package-import"] as const,
        "Extension transfer kind",
      ),
      at: requiredIsoTimestamp(value.at, "Extension transfer time"),
    };
  }

  const normalized: ExtensionProvenanceV1 = {
    schemaVersion: 1,
    catalog,
    artifact: {
      providerId,
      legacySourceUrl: optionalString(artifact.legacySourceUrl, "Legacy artifact source URL"),
      finalByteHost: optionalHostname(artifact.finalByteHost, "Artifact byte host"),
      fetchedAt: optionalIsoTimestamp(artifact.fetchedAt, "Artifact fetch time"),
      format,
      size: optionalNonNegativeNumber(artifact.size, "Artifact size"),
      sha256: optionalSha256(artifact.sha256, "Artifact fingerprint"),
      retained: artifact.retained,
    },
    verification: {
      level,
      verifiedAt: optionalIsoTimestamp(verification.verifiedAt, "Verification time"),
      proofDerivedStoreId: optionalCanonicalId(verification.proofDerivedStoreId, "Proof-derived store id"),
      developerKeySha256: optionalSha256(verification.developerKeySha256, "Developer key fingerprint"),
      publisherKeySha256: optionalSha256(verification.publisherKeySha256, "Publisher key fingerprint"),
      publisherTrustRootId: optionalString(verification.publisherTrustRootId, "Publisher trust root id"),
      publisherTrustRootVersion: optionalNonNegativeNumber(
        verification.publisherTrustRootVersion,
        "Publisher trust root version",
      ),
      manifestSha256: optionalSha256(verification.manifestSha256, "Manifest fingerprint"),
      treeSha256: optionalSha256(verification.treeSha256, "Extension tree fingerprint"),
    },
    transfer,
  };
  assertProvenanceInvariants(normalized);
  return normalized;
}

export function normalizeExtensionUpdateProviderId(input: unknown): ExtensionUpdateProviderId | undefined {
  if (input === undefined || input === null) return undefined;
  return enumField(input, ["chrome-web-store", "crxsoso"] as const, "Extension update provider");
}

export function normalizeExtensionUpdateState(input: unknown): ExtensionUpdateState | undefined {
  if (input === undefined || input === null) return undefined;
  const record = requiredRecord(input, "Extension update state");
  const status = enumField(
      record.status,
      ["idle", "available", "provider-disabled", "provider-unavailable", "takedown"] as const,
      "Extension update status",
    );
  const availableVersion = optionalString(record.availableVersion, "Available extension version");
  if (status === "available" && !availableVersion) {
    throw contractError("An available extension update must include its version.");
  }
  if (status !== "available" && availableVersion) {
    throw contractError("Only an available extension update can include an available version.");
  }
  return {
    status,
    checkedAt: optionalIsoTimestamp(record.checkedAt, "Extension update check time"),
    availableVersion,
    errorCode: optionalString(record.errorCode, "Extension update error code"),
  };
}

export function normalizeExtensionAuthorityFields(
  input: unknown,
  options: { allowLegacyIncomplete?: boolean } = {},
): ExtensionAuthorityFields {
  const record = requiredRecord(input, "Extension authority fields");
  const storeIdentity = normalizeExtensionStoreIdentity(record.storeIdentity);
  const provenance = normalizeExtensionProvenance(record.provenance);
  const artifactArchivePath = optionalString(record.artifactArchivePath, "Extension artifact archive path");
  const updateProviderId = normalizeExtensionUpdateProviderId(record.updateProviderId);
  const updateState = normalizeExtensionUpdateState(record.updateState);
  if (
    !options.allowLegacyIncomplete
    && provenance?.verification.level === "cws-publisher-verified"
    && (!provenance.verification.publisherKeySha256 || !provenance.verification.treeSha256)
  ) {
    throw contractError("Fresh Web Store publisher verification requires publisher and tree fingerprints.");
  }

  if (storeIdentity) {
    if (record.storeId !== undefined && record.storeId !== storeIdentity.storeId) {
      throw contractError("Extension store id projection disagrees with store identity.");
    }
    if (record.storeUrl !== undefined && record.storeUrl !== storeIdentity.listingUrl) {
      throw contractError("Extension store URL projection disagrees with store identity.");
    }
  }
  if (
    provenance
    && (provenance.artifact.providerId === "chrome-web-store" || provenance.artifact.providerId === "crxsoso")
    && provenance.verification.level !== "cws-publisher-verified"
  ) {
    throw contractError("Persisted remote store artifacts require Chrome Web Store publisher verification.");
  }
  if (provenance?.verification.level === "cws-publisher-verified") {
    if (!storeIdentity || provenance.verification.proofDerivedStoreId !== storeIdentity.storeId) {
      throw contractError("Verified publisher evidence must match canonical store identity.");
    }
    if (record.sourceKind !== "local-crx") {
      throw contractError("Verified Web Store packages must use the app-managed local CRX source kind.");
    }
    if (record.sourceId !== undefined && record.sourceId !== null && record.sourceId !== "") {
      throw contractError("Verified Web Store packages cannot retain legacy source authority.");
    }
    if (!artifactArchivePath || record.sourceUrl !== artifactArchivePath) {
      throw contractError("Verified Web Store source URL must project the retained artifact path.");
    }
    if (record.sha256 !== provenance.artifact.sha256) {
      throw contractError("Verified Web Store entity fingerprint must match retained artifact provenance.");
    }
    if (record.manifestSha256 !== provenance.verification.manifestSha256) {
      throw contractError("Verified Web Store Manifest fingerprint must match verification provenance.");
    }
  }
  if (artifactArchivePath && !provenance?.artifact.retained) {
    throw contractError("An artifact archive path requires retained artifact provenance.");
  }
  if (provenance?.artifact.retained && !artifactArchivePath) {
    throw contractError("Retained artifact provenance requires an app-managed artifact path.");
  }
  if (updateProviderId) {
    if (!storeIdentity || provenance?.verification.level !== "cws-publisher-verified") {
      throw contractError("A remote update provider requires verified canonical store identity.");
    }
  }
  return { storeIdentity, provenance, artifactArchivePath, updateProviderId, updateState };
}

/** Converts pre-tree-fingerprint verified claims into non-authoritative legacy evidence. */
export function downgradeIncompleteExtensionAuthority(
  authority: ExtensionAuthorityFields,
): ExtensionAuthorityFields {
  const provenance = authority.provenance;
  if (
    !provenance
    || provenance.verification.level !== "cws-publisher-verified"
    || (provenance.verification.publisherKeySha256 && provenance.verification.treeSha256)
  ) return authority;
  return {
    storeIdentity: undefined,
    provenance: {
      schemaVersion: 1,
      artifact: {
        providerId: "legacy",
        legacySourceUrl: provenance.artifact.legacySourceUrl,
        format: provenance.artifact.format,
        sha256: provenance.artifact.sha256,
        retained: false,
      },
      verification: {
        level: "legacy-unknown",
        manifestSha256: provenance.verification.manifestSha256,
      },
      transfer: provenance.transfer,
    },
    artifactArchivePath: undefined,
    updateProviderId: undefined,
    updateState: { status: "provider-disabled" },
  };
}

export type LegacyTransferExtension = Omit<
  ExtensionEntity,
  "storeIdentity" | "provenance" | "artifactArchivePath" | "updateProviderId" | "updateState"
>;

/** Schema-v1 archives predate acquisition authority. Keep new fields out until v2 writers activate. */
export function extensionForLegacyTransfer(extension: ExtensionEntity): LegacyTransferExtension {
  const {
    storeIdentity: _storeIdentity,
    provenance: _provenance,
    artifactArchivePath: _artifactArchivePath,
    updateProviderId: _updateProviderId,
    updateState: _updateState,
    ...legacy
  } = extension;
  return legacy;
}

function canonicalReference(
  storeId: string,
  source: Extract<ExtensionReference, { kind: "canonical" }>["source"],
): Extract<ExtensionReference, { kind: "canonical" }> {
  return { kind: "canonical", source, storeId, storeUrl: chromeWebStoreListingUrl(storeId) };
}

function unsupportedReference(message: string): Extract<ExtensionReference, { kind: "invalid" }> {
  return { kind: "invalid", code: "ACQUISITION_INPUT_UNSUPPORTED", message };
}

function detailPathId(segments: string[], prefix: string[]): string | undefined {
  if (segments.length !== prefix.length + 1 && segments.length !== prefix.length + 2) return undefined;
  if (!prefix.every((part, index) => segments[index] === part)) return undefined;
  const storeId = segments.at(-1);
  if (!isCanonicalChromeExtensionId(storeId)) return undefined;
  const canonicalSegments = segments.filter((segment) => isCanonicalChromeExtensionId(segment));
  return canonicalSegments.length === 1 ? storeId : undefined;
}

function looksLikeAbsoluteUrl(value: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(value)
    || value.startsWith("//")
    || /^[a-z0-9.-]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(value);
}

function hasUnsafeRawUrlPath(value: string): boolean {
  if (value.includes("\\")) return true;
  const withoutControls = value.replace(/[\u0000-\u001f\u007f]/g, "");
  if (withoutControls !== value && looksLikeAbsoluteUrl(withoutControls)) return true;
  if (/^https:/i.test(value) && !/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) return true;
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(value);
  if (!match) return false;
  const rawAuthority = match[1] ?? "";
  const rawPath = match[2] ?? "";
  if (
    rawAuthority.includes("%")
    || rawAuthority.includes(":")
    || rawAuthority.includes("@")
    || /[^\x21-\x7e]/.test(rawAuthority)
  ) return true;
  if (rawPath.includes("\\") || /%(?:2f|5c)/i.test(rawPath)) return true;
  if (rawPath.includes("//")) return true;
  return rawPath.split("/").some((segment) => /^(?:\.|%2e|\.\.|%2e\.|\.%2e|%2e%2e)$/i.test(segment));
}

function rawUrlAuthority(value: string): string | undefined {
  return /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(value)?.[1];
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw contractError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096) {
    throw contractError(`${label} must be a non-empty bounded string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredString(value, label);
}

function requiredIsoTimestamp(value: unknown, label: string): string {
  const input = requiredString(value, label);
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input)) {
    throw contractError(`${label} must be an ISO timestamp with a timezone.`);
  }
  return new Date(timestamp).toISOString();
}

function optionalIsoTimestamp(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredIsoTimestamp(value, label);
}

function optionalHostname(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  const input = requiredString(value, label).toLowerCase();
  if (input.includes(":")) throw contractError(`${label} must not include a port.`);
  let parsed: URL;
  try {
    parsed = new URL(`https://${input}`);
  } catch {
    throw contractError(`${label} must be a hostname.`);
  }
  if (parsed.username || parsed.password || parsed.port || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw contractError(`${label} must be a hostname.`);
  }
  if (parsed.hostname !== input || input.endsWith(".")) throw contractError(`${label} must be a canonical hostname.`);
  return input;
}

function requiredCanonicalId(value: unknown, label: string): string {
  if (!isCanonicalChromeExtensionId(value)) throw contractError(`${label} is not a canonical Chrome extension id.`);
  return value;
}

function optionalCanonicalId(value: unknown, label: string): string | undefined {
  return value === undefined || value === null ? undefined : requiredCanonicalId(value, label);
}

function optionalSha256(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) throw contractError(`${label} must be a SHA-256 hex digest.`);
  return value.toLowerCase();
}

function optionalNonNegativeNumber(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw contractError(`${label} must be a non-negative integer.`);
  return Number(value);
}

function assertProvenanceInvariants(provenance: ExtensionProvenanceV1): void {
  const { artifact, verification } = provenance;
  if (artifact.retained && !artifact.sha256) {
    throw contractError("Retained artifact provenance requires a file fingerprint.");
  }
  if (artifact.legacySourceUrl && artifact.providerId !== "legacy") {
    throw contractError("Only legacy provenance can retain a historical source URL.");
  }
  if (artifact.providerId === "legacy" && verification.level !== "legacy-unknown") {
    throw contractError("Legacy artifact provenance cannot claim a fresh verification level.");
  }
  if (verification.level === "developer-signed") {
    if (
      artifact.format !== "crx3"
      || !artifact.sha256
      || !verification.verifiedAt
      || !verification.proofDerivedStoreId
      || !verification.developerKeySha256
    ) {
      throw contractError("Developer-signed verification requires complete CRX3 developer proof evidence.");
    }
    if (verification.publisherTrustRootId || verification.publisherTrustRootVersion !== undefined) {
      throw contractError("Developer-only verification cannot carry publisher trust-root evidence.");
    }
    return;
  }
  if (verification.level !== "cws-publisher-verified") {
    if (
      verification.proofDerivedStoreId
      || verification.developerKeySha256
      || verification.publisherTrustRootId
      || verification.publisherTrustRootVersion !== undefined
      || verification.publisherKeySha256
      || verification.treeSha256
    ) {
      throw contractError("Unverified artifact provenance cannot carry cryptographic identity evidence.");
    }
    return;
  }
  if (artifact.providerId !== "chrome-web-store" && artifact.providerId !== "crxsoso") {
    throw contractError("Web Store publisher verification requires a built-in store artifact provider.");
  }
  if (artifact.format !== "crx3" || !artifact.retained || artifact.size === undefined || !artifact.sha256) {
    throw contractError("Web Store publisher verification requires a retained fingerprinted CRX3 artifact.");
  }
  if (!artifact.finalByteHost || !artifact.fetchedAt) {
    throw contractError("Web Store publisher verification requires transport host and fetch time.");
  }
  if (
    !verification.verifiedAt
    || !verification.proofDerivedStoreId
    || !verification.developerKeySha256
    || !verification.publisherTrustRootId
    || verification.publisherTrustRootVersion === undefined
    || !verification.manifestSha256
  ) {
    throw contractError("Web Store publisher verification evidence is incomplete.");
  }
}

function enumField<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw contractError(`${label} is unsupported.`);
  }
  return value as Values[number];
}

function contractError(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "EXTENSION_ACQUISITION_CONTRACT_INVALID" });
}
