import { createHash, createPublicKey, createVerify, generateKeyPairSync, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  type BrowserEnvironment,
  type ExtensionDirectoryCandidate,
  type ExtensionDirectoryImportResult,
  type ExtensionDirectoryMode,
  type ExtensionDirectoryPreviewResult,
  type ExtensionEntity,
  type ExtensionIconAsset,
  type ExtensionPermissionRisk,
  type ExtensionPermissionRiskLevel,
  type ExtensionPermissionRiskReasonKey,
  isPreserveLifecycleRevision,
} from "../../src/shared/entities";
import {
  chromeWebStoreListingUrl,
  selectedExtensionArtifactProvider,
} from "../../src/shared/extensionAcquisition";
import { createId, nowIso } from "../../src/shared/profile";
import { normalizeSettings, type AppSettings } from "../../src/shared/settings";
import type { PanelRepository } from "../storage/types";
import { fingerprintStagedExtensionTree } from "./boundedZipAnalyzer";
import { verifyChromeWebStoreCrx3File } from "./crx3Verifier";
import { ExtensionRuntimeService, type ExtensionRuntimeMaterializeResult } from "./extensionRuntimeService";
import { validateTransferredExtensionArtifact } from "./extensionArtifactTransferVerifier";
import { preflightExtensionPackage } from "./extensionPackagePreflight";
import { extensionPermissionIncreases } from "./extensionPermissionDiff";
import { DataMutationCoordinator } from "./dataMutationCoordinator";
import {
  ExtensionAcquisitionCommitJournal,
  ExtensionCommitJournalCreateError,
  type ExtensionCommitJournalRecord,
  type ExtensionCommitPublication,
} from "./extensionAcquisitionCommitJournal";
import type {
  PreparedExtensionAcquisition,
} from "./extensionAcquisitionSessionService";
import type { ExtensionAcquisitionSessionConfirmRequest } from "../../src/shared/extensionAcquisition";
import type { ResolvedArtifact } from "./extensionProviders/types";

type ExtensionServiceOptions = {
  repository: PanelRepository;
  extensionCacheDir: string;
  extensionRuntimeDir?: string;
  browserDataDir?: string;
  /** Where uploaded archives are persisted so `sourceUrl` stays readable for reinstall/update. */
  extensionArchiveDir?: string;
  /** Exact retained store CRX artifacts, separate from manual uploaded archives. */
  extensionArtifactDir?: string;
  extensionAcquisitionDir?: string;
  mutationCoordinator?: DataMutationCoordinator;
  readSettings?: () => Promise<AppSettings>;
  probeArtifactProvider?: (
    providerId: "chrome-web-store" | "crxsoso",
    storeId: string,
    destinationPath: string,
    signal: AbortSignal,
  ) => Promise<ResolvedArtifact>;
  /** Offline tests only; production omits this and uses Chromium's pinned publisher root. */
  verifyStoreCrxFileForTesting?: typeof verifyChromeWebStoreCrx3File;
  acquisitionCommitFaultForTesting?: (
    phase: "prepared" | "files-published" | "database-written" | "database-committed" | "complete",
  ) => void | Promise<void>;
  commitJournalSyncDirectoryForTesting?: (directory: string) => Promise<void>;
  activeEnvironmentIds?: () => Set<string>;
};

type ActiveProviderProbe = {
  providerId: "chrome-web-store" | "crxsoso";
  controller: AbortController;
};

type ExtensionManifest = {
  name?: string;
  description?: string;
  version?: string;
  manifest_version?: number;
  key?: unknown;
  default_locale?: unknown;
  icons?: unknown;
  action?: unknown;
  browser_action?: unknown;
  permissions?: unknown[];
  host_permissions?: unknown[];
  optional_permissions?: unknown[];
  optional_host_permissions?: unknown[];
  content_scripts?: unknown[];
};

type PermissionRiskInput = {
  permissions?: string[];
  hostPermissions?: string[];
  optionalPermissions?: string[];
  optionalHostPermissions?: string[];
  contentScriptMatches?: string[];
};

export type ExtensionLaunchWarning = {
  name: string;
  reason: string;
};

export type ExtensionLaunchRegistration = NonNullable<ExtensionRuntimeMaterializeResult["registration"]> & {
  name: string;
  runtimePath: string;
};

export type EnsureExtensionsResult = {
  paths: string[];
  warnings: ExtensionLaunchWarning[];
  registrations: ExtensionLaunchRegistration[];
};

export type EnsureExtensionsOptions = {
  /** False when an older browser close was not confirmed and may still hold the published runtime. */
  allowRuntimeReplacement?: boolean;
};

type InUseGuardOptions = {
  exemptEnvironmentId?: string;
};

type ExtensionAssetKind = "zip" | "crx";

export type ExtensionImportConflictDisposition = "reuse" | "overwrite" | "create";
export type ExtensionImportConflictMatchBy = "manifestKey" | "sha256" | "sourceUrl" | "manifestSha256" | "nameVersion";

export type ExtensionImportOptions = {
  conflictDisposition?: ExtensionImportConflictDisposition;
  conflictExtensionId?: string;
};

type ImportCandidateIdentity = {
  manifestKey?: string;
  sha256?: string;
  sourceUrl?: string;
  manifestSha256?: string;
  name?: string;
  version?: string;
};

type ExtensionImportConflict = {
  matchBy: ExtensionImportConflictMatchBy;
  candidates: ExtensionEntity[];
};

const HIGH_RISK_PERMISSIONS = new Set([
  "cookies",
  "proxy",
  "webRequest",
  "declarativeNetRequest",
  "scripting",
  "nativeMessaging",
]);

const MEDIUM_RISK_PERMISSIONS: Record<string, { reason: string; reasonKey: ExtensionPermissionRiskReasonKey }> = {
  tabs: { reason: "可读取标签页 URL 与标题", reasonKey: "tabs-metadata" },
};

const ALL_URLS_PATTERNS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*"]);

// Crash leftovers from the extract/copy temp-dir swaps; they are never valid extension roots.
const CACHE_ARTIFACT_MARKERS = [".tmp-", ".old-"];

const CACHE_PREVIEW_PREFIX = ".preview-";

const CRX3_SIGNED_DATA_MAGIC = "CRX3 SignedData";

const MESSAGE_PLACEHOLDER_PATTERN = /__MSG_([A-Za-z0-9_@]+)__/;

const PREFERRED_MESSAGE_LOCALES = ["zh_CN", "zh"];

const FALLBACK_MESSAGE_LOCALES = ["en", "en_US"];

/** Only raster/vector formats a browser can render inline; anything else is refused. */
const ICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** Real extension icons are a few KB; the cap only exists to stop a crafted manifest from OOMing us. */
const MAX_ICON_ASSET_BYTES = 512 * 1024;

export class ExtensionService {
  private readonly extensionArchiveDir: string;

  private readonly extensionArtifactDir: string;

  private readonly mutationCoordinator: DataMutationCoordinator;

  private readonly extensionAcquisitionDir: string;

  private readonly commitJournal: ExtensionAcquisitionCommitJournal;

  private readonly verifyStoreCrxFile: typeof verifyChromeWebStoreCrx3File;

  private providerProbeReservations = 0;

  private readonly activeProviderProbes = new Set<ActiveProviderProbe>();

  private readonly runtimeService: ExtensionRuntimeService;

  constructor(private readonly options: ExtensionServiceOptions) {
    this.extensionArchiveDir = options.extensionArchiveDir
      ?? path.join(path.dirname(path.resolve(options.extensionCacheDir)), "extension-archives");
    this.extensionArtifactDir = options.extensionArtifactDir
      ?? path.join(path.dirname(path.resolve(options.extensionCacheDir)), "extension-artifacts");
    this.extensionAcquisitionDir = options.extensionAcquisitionDir
      ?? path.join(path.dirname(path.resolve(options.extensionCacheDir)), "extension-acquisitions");
    this.mutationCoordinator = options.mutationCoordinator ?? new DataMutationCoordinator();
    this.verifyStoreCrxFile = options.verifyStoreCrxFileForTesting ?? verifyChromeWebStoreCrx3File;
    const dataDir = path.dirname(path.resolve(options.extensionCacheDir));
    this.commitJournal = new ExtensionAcquisitionCommitJournal({
      journalRoot: path.join(dataDir, "extension-acquisition-journal"),
      allowedRoots: [
        path.resolve(options.extensionCacheDir),
        path.resolve(this.extensionArtifactDir),
        path.resolve(this.extensionAcquisitionDir),
      ],
      syncDirectoryForTesting: options.commitJournalSyncDirectoryForTesting,
    });
    this.runtimeService = new ExtensionRuntimeService({
      runtimeDir: options.extensionRuntimeDir ?? path.join(dataDir, "extension-runtimes"),
      browserDataDir: options.browserDataDir ?? path.join(dataDir, "browser-data"),
    });
  }

  /** Startup barrier: recover any interrupted acquisition before launch or API mutations become reachable. */
  async initialize(): Promise<void> {
    for (const probe of this.activeProviderProbes) probe.controller.abort();
    this.activeProviderProbes.clear();
    await this.commitJournal.initialize();
    await this.commitJournal.reconcileAll({
      databaseState: (record) => this.commitDatabaseState(record),
      rollbackFiles: (record) => this.rollbackCommitFiles(record),
      finalizeFiles: (record) => this.finalizeCommitFiles(record),
      cleanupSession: (record) => fs.rm(path.join(this.extensionAcquisitionDir, record.sessionId), {
        recursive: true,
        force: true,
      }),
    });
    this.providerProbeReservations = 0;
    await this.sweepCacheArtifacts();
  }

  settingsChanged(settingsInput: AppSettings): void {
    const settings = normalizeSettings(settingsInput);
    for (const probe of this.activeProviderProbes) {
      if (!isArtifactProviderEnabled(settings, probe.providerId) && !probe.controller.signal.aborted) {
        probe.controller.abort(acquisitionError(
          "ARTIFACT_PROVIDER_DISABLED",
          "The selected update provider was disabled during verification.",
        ));
      }
    }
  }

  async importDirectory(
    directory: string,
    mode: ExtensionDirectoryMode = "copy",
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionEntity> {
    return this.withExtensionMutation(["extension-import"], () => (
      this.importDirectoryInternal(directory, mode, options)
    ));
  }

  private async importDirectoryInternal(
    directory: string,
    mode: ExtensionDirectoryMode,
    options: ExtensionImportOptions,
  ): Promise<ExtensionEntity> {
    const sourcePath = path.resolve(directory);
    assertPathHasNoComma(sourcePath);
    // Both modes are guarded: reference-importing a copy extension's cache dir would create two
    // entities sharing one injected key, so the browser resolves both to the same ID.
    this.assertOutsideExtensionCache(sourcePath);
    const manifest = await readManifestFromDirectory(sourcePath);
    const manifestFields = extensionFieldsFromManifest(manifest);
    // Fingerprint the source directory, not the snapshot: copy mode injects a key into the snapshot,
    // and hashing the source keeps both modes on the same digest for the same package.
    const manifestSha256 = await readManifestFingerprint(sourcePath);
    const identity: ImportCandidateIdentity = {
      manifestKey: typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined,
      sourceUrl: sourcePath,
      manifestSha256,
      name: manifestFields.name,
      version: manifestFields.version,
    };
    const conflict = await this.resolveImportDisposition(identity, options);
    if (conflict?.disposition === "reuse") {
      return conflict.target;
    }
    if (conflict?.disposition === "overwrite") {
      return this.overwriteFromDirectory(conflict.target, sourcePath, mode, manifestFields, manifestSha256);
    }

    if (mode === "reference") {
      return this.options.repository.createExtension({
        ...manifestFields,
        sourceKind: "local-directory",
        sourceUrl: sourcePath,
        localPath: sourcePath,
        manifestKey: identity.manifestKey,
        manifestSha256,
        directoryMode: "reference",
        installState: "installed",
        lastInstalledAt: nowIso(),
      });
    }

    const extensionId = createId("extension");
    const localPath = await this.copyDirectoryIntoCache(sourcePath, extensionId);
    const manifestKey = await this.acquireManifestKey(localPath);
    return this.options.repository.createExtension({
      ...manifestFields,
      id: extensionId,
      sourceKind: "local-directory",
      sourceUrl: sourcePath,
      localPath,
      manifestKey,
      manifestSha256,
      directoryMode: "copy",
      installState: "installed",
      lastInstalledAt: nowIso(),
    });
  }

  /** Best-effort removal of interrupted extract/copy swap leftovers in the extension cache. */
  async sweepCacheArtifacts(): Promise<void> {
    return this.withExtensionMutation(["extension-cache-sweep"], () => this.sweepCacheArtifactsInternal());
  }

  private async sweepCacheArtifactsInternal(): Promise<void> {
    await this.runtimeService.sweepArtifacts();
    const environments = [
      ...await this.options.repository.listEnvironments(),
      ...(await this.options.repository.listTrashEnvironments()).map((item) => item.environment),
    ];
    const bindings = new Map<string, ReadonlySet<string>>();
    for (const environment of environments) {
      bindings.set(
        environment.id,
        new Set((await this.options.repository.listEnvironmentExtensionBindings(environment.id)).map((binding) => binding.extensionId)),
      );
    }
    await this.runtimeService.sweepBindings(bindings, this.options.activeEnvironmentIds?.());
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.options.extensionCacheDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!isCacheArtifactName(entry.name)) continue;
      await fs.rm(path.join(this.options.extensionCacheDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async previewDirectory(directory: string): Promise<ExtensionDirectoryPreviewResult> {
    if (!directory.trim()) {
      throw Object.assign(new Error("Extension directory path cannot be empty"), { status: 400 });
    }
    const rootPath = path.resolve(directory.trim());
    const direct = await readDirectManifestCandidate(rootPath);
    if (direct) {
      return { rootPath, direct, candidates: [] };
    }

    const candidates = await discoverChromeExtensionCandidates(rootPath);
    if (candidates.length === 0) {
      throw Object.assign(new Error(`Extension directory must directly contain manifest.json or Chrome extension version folders: ${rootPath}`), { status: 400 });
    }
    return { rootPath, candidates };
  }

  async importDirectories(
    paths: string[],
    mode: ExtensionDirectoryMode = "copy",
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionDirectoryImportResult> {
    const requestedPaths = paths.filter((input) => typeof input === "string" && input.trim());
    const uniquePaths = uniqueResolvedPaths(requestedPaths);
    if (uniquePaths.length === 0) {
      throw Object.assign(new Error("No extension directories selected"), { status: 400 });
    }
    const imported: ExtensionEntity[] = [];
    const failed: ExtensionDirectoryImportResult["failed"] = [];

    for (const directory of uniquePaths) {
      try {
        imported.push(await this.importDirectory(directory, mode, options));
      } catch (error) {
        failed.push({ path: directory, error: (error as Error).message });
      }
    }

    return {
      imported,
      failed,
      skipped: requestedPaths.length - uniquePaths.length,
    };
  }

  async importZip(filePath: string, options: ExtensionImportOptions = {}): Promise<ExtensionEntity> {
    return this.withExtensionMutation(["extension-import"], () => this.importLocalAsset(filePath, "zip", options));
  }

  async importCrx(filePath: string, options: ExtensionImportOptions = {}): Promise<ExtensionEntity> {
    return this.withExtensionMutation(["extension-import"], () => this.importLocalAsset(filePath, "crx", options));
  }

  /**
   * Uploaded archives have no server-side source file, so the bytes are persisted inside the data
   * directory first: reinstall and update checks read `sourceUrl` and would break without a copy.
   */
  async importUploadedArchive(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionEntity> {
    return this.withExtensionMutation(["extension-import"], () => (
      this.importUploadedArchiveInternal(bytes, assetKind, options)
    ));
  }

  async commitPreparedAcquisition(
    acquisition: PreparedExtensionAcquisition,
    request: ExtensionAcquisitionSessionConfirmRequest,
  ): Promise<ExtensionEntity> {
    const targetId = request.disposition === "create"
      ? createId("extension")
      : request.targetExtensionId?.trim();
    if (!targetId) throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "Acquisition target is missing.");
    assertServerExtensionId(targetId);
    if (request.disposition !== "create") {
      const candidate = acquisition.conflictCandidates.find((item) => item.extensionId === targetId);
      if (!candidate?.eligible) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "Acquisition target was not issued as an eligible server candidate.");
      }
    }
    const developerMutationKey = `developer:${acquisition.verification.developerSpkiSha256}`;
    if (
      request.disposition === "create"
      && acquisition.conflictCandidates.some((item) => item.matchBy === "store-identity" && item.blockingReason === "developer-identity-mismatch")
    ) {
      throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The canonical store id is already associated with another developer identity.");
    }
    return this.withExtensionMutation([
      targetId,
      `store:chrome-web-store:${acquisition.storeId}`,
      developerMutationKey,
      "extension-bindings",
    ], () => (
      this.commitPreparedAcquisitionInternal(acquisition, request, targetId)
    ));
  }

  private async commitPreparedAcquisitionInternal(
    acquisition: PreparedExtensionAcquisition,
    request: ExtensionAcquisitionSessionConfirmRequest,
    targetId: string,
  ): Promise<ExtensionEntity> {
    await assertPreparedAcquisitionPaths(acquisition, this.extensionAcquisitionDir);
    // The selected download channel is a single global choice. Reject a ready
    // session if the choice changed, then enforce the same expectation inside
    // the SQLite transaction below so a concurrent settings write cannot race
    // a stale package into persistence after this asynchronous check.
    // Remote acquisition confirmation always has a settings source. Fall back
    // to the repository itself for embedded/test constructions so the final
    // SQLite CAS can never be skipped merely because the optional service
    // callback was omitted. (The separate retained-artifact reinstall path
    // intentionally does not use this remote-channel gate.)
    const settings = normalizeSettings(await (this.options.readSettings?.() ?? this.options.repository.getSettings()));
    if (!isArtifactProviderEnabled(settings, acquisition.selectedProviderId)) {
      throw acquisitionError("ARTIFACT_PROVIDER_DISABLED", "The selected extension download channel changed before confirmation.");
    }

    const currentExtensions = await this.options.repository.listExtensions();
    const existing = request.disposition === "create"
      ? undefined
      : currentExtensions.find((extension) => extension.id === targetId);
    if (request.disposition !== "create" && !existing) {
      throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The selected extension no longer exists.");
    }
    if (request.disposition === "create" && currentExtensions.some((extension) => extension.id === targetId)) {
      throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The generated extension target already exists.");
    }
    if (request.disposition === "create") {
      if (currentExtensions.some((extension) => (
        extension.storeIdentity?.namespace === "chrome-web-store"
        && extension.storeIdentity.storeId === acquisition.storeId
      ))) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "An existing canonical store record must be explicitly upgraded or reused.");
      }
      if (currentExtensions.some((extension) => (
        extension.storeId === acquisition.storeId && !extension.storeIdentity
      ))) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "An existing legacy store record must be explicitly upgraded.");
      }
      if (currentExtensions.some((extension) => (
        extension.id !== targetId && persistedDeveloperFingerprint(extension) === acquisition.verification.developerSpkiSha256
      ))) {
        throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The verified developer identity is already used by another extension.");
      }
    }

    const mismatchedStoreIdentity = currentExtensions.some((extension) => (
      extension.storeIdentity?.namespace === "chrome-web-store"
      && extension.storeIdentity.storeId === acquisition.storeId
      && persistedDeveloperFingerprint(extension) !== undefined
      && persistedDeveloperFingerprint(extension) !== acquisition.verification.developerSpkiSha256
    ));
    if (mismatchedStoreIdentity) {
      throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The canonical store id is already bound to another developer identity.");
    }
    if (existing) {
      if (request.disposition !== "create" && acquisition.targetUpdatedAt && existing.updatedAt !== acquisition.targetUpdatedAt) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The extension changed after this update session was created.");
      }
      if (request.disposition === "upgrade" && compareExtensionVersions(acquisition.package.version, existing.version) < 0) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The verified package is older than the installed extension.");
      }
      const developerFingerprint = persistedDeveloperFingerprint(existing);
      if (
        request.disposition === "upgrade"
        && existing.provenance?.verification.level === "cws-publisher-verified"
        && (
          existing.provenance.verification.publisherTrustRootId !== acquisition.verification.publisherTrustRootId
          || (existing.provenance.verification.publisherTrustRootVersion ?? 0) > acquisition.verification.publisherTrustRootVersion
          || (
            existing.provenance.verification.publisherKeySha256 !== undefined
            && existing.provenance.verification.publisherKeySha256 !== acquisition.verification.publisherSpkiSha256
          )
        )
      ) {
        throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The update would weaken or change publisher verification evidence.");
      }
      const metadataOnlyWithoutIdentity = existing.installState === "metadata-only"
        && (
          existing.storeIdentity?.namespace === "chrome-web-store"
            ? existing.storeIdentity.storeId === acquisition.storeId
            : !existing.storeIdentity && existing.storeId === acquisition.storeId
        )
        && developerFingerprint === undefined;
      if (developerFingerprint !== acquisition.verification.developerSpkiSha256 && !metadataOnlyWithoutIdentity) {
        throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The selected extension developer identity changed.");
      }
      if (
        existing.storeIdentity
        && (existing.storeIdentity.namespace !== "chrome-web-store" || existing.storeIdentity.storeId !== acquisition.storeId)
      ) {
        throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The selected extension has a different canonical store identity.");
      }
      if (
        request.disposition === "upgrade"
        && !metadataOnlyWithoutIdentity
        && (existing.updateProviderId !== acquisition.selectedProviderId || existing.storeIdentity?.storeId !== acquisition.storeId)
      ) {
        throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The update provider or canonical id changed.");
      }
      await this.assertNotInUse(existing.id);
    }
    const environmentIds = uniqueBoundedIds(request.environmentIds ?? []);
    const activeEnvironmentIds = this.options.activeEnvironmentIds?.() ?? new Set<string>();
    const existingBindings = existing
      ? await this.options.repository.listExtensionEnvironmentBindings(existing.id)
      : [];
    if (existingBindings.some((binding) => activeEnvironmentIds.has(binding.environmentId))) {
      throw Object.assign(new Error("Stop environments using this extension before applying the verified package."), {
        status: 409,
        code: "EXTENSION_IN_USE",
      });
    }
    if (environmentIds.some((environmentId) => activeEnvironmentIds.has(environmentId))) {
      throw Object.assign(new Error("Stop the selected environment before binding a newly acquired extension."), {
        status: 409,
        code: "EXTENSION_IN_USE",
      });
    }

    const verification = await this.verifyStoreCrxFile(acquisition.artifactPath, acquisition.storeId);
    assertSameVerificationFacts(acquisition.verification, verification);
    const stagedFingerprint = await fingerprintStagedExtensionTree(acquisition.stagedRoot, {
      maxFiles: 20_000,
      maxExpandedBytes: 512 * 1024 * 1024,
    });
    if (
      stagedFingerprint.sha256 !== acquisition.package.treeSha256
      || stagedFingerprint.fileCount !== acquisition.package.stagedFileCount
      || stagedFingerprint.expandedBytes !== acquisition.package.stagedExpandedBytes
    ) {
      throw acquisitionError("ACQUISITION_COMMIT_FAILED", "Staged extension files changed after preflight.");
    }

    const addedPermissions = existing && existing.installState !== "metadata-only"
      ? permissionsAdded(existing, {
          ...existing,
          permissions: acquisition.package.permissions,
          hostPermissions: acquisition.package.hostPermissions,
          optionalPermissions: acquisition.package.optionalPermissions,
          optionalHostPermissions: acquisition.package.optionalHostPermissions,
        })
      : [];
    if (addedPermissions.length > 0) {
      if (
        !acquisition.permissionApprovalToken
        || !safeTokenEquals(request.permissionApprovalToken, acquisition.permissionApprovalToken)
        || !sameStringSet(addedPermissions, acquisition.addedPermissions)
      ) {
        throw Object.assign(
          acquisitionError("ACQUISITION_PERMISSION_INCREASE", "The verified update adds permissions and requires explicit approval."),
          { permissions: addedPermissions },
        );
      }
    }

    if (request.disposition === "reuse") {
      if (
        !existing?.localPath
        || !isLoadableInstallState(existing.installState)
        || (existing.storeIdentity?.storeId ?? existing.storeId) !== acquisition.storeId
      ) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The reusable extension is not locally loadable.");
      }
      await readManifestFromDirectory(existing.localPath);
      if (environmentIds.length > 0) {
        await this.options.repository.bindExtensionToEnvironments(existing.id, environmentIds);
      }
      return (await this.options.repository.getExtension(existing.id)) ?? existing;
    }

    // The package Manifest may omit `key`; only then may the exact verified CRX developer
    // SPKI be added for the unpacked browser copy. A conflicting signed key is never
    // silently rewritten because the original Manifest bytes are covered by CRX3 proofs.
    const signedManifestKey = await readManifestKeyExact(acquisition.stagedRoot);
    if (signedManifestKey && signedManifestKey !== verification.developerSpkiBase64) {
      throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The signed Manifest key conflicts with the verified developer identity.");
    }
    if (!signedManifestKey) await applyManifestKey(acquisition.stagedRoot, verification.developerSpkiBase64);
    const publishedTreeFingerprint = await fingerprintStagedExtensionTree(acquisition.stagedRoot, {
      maxFiles: 20_000,
      maxExpandedBytes: 512 * 1024 * 1024,
    });
    const timestamp = nowIso();
    const artifactLivePath = path.resolve(this.extensionArtifactDir, targetId, "current.crx");
    const treeLivePath = path.resolve(this.options.extensionCacheDir, targetId);
    const storeUrl = chromeWebStoreListingUrl(acquisition.storeId);
    const entity: ExtensionEntity = {
      ...(existing ?? {
        id: targetId,
        createdAt: timestamp,
        status: "enabled" as const,
      }),
      id: targetId,
      name: acquisition.package.name,
      description: acquisition.package.description,
      sourceKind: "local-crx",
      sourceUrl: artifactLivePath,
      storeId: acquisition.storeId,
      storeUrl,
      storeIdentity: {
        namespace: "chrome-web-store",
        storeId: acquisition.storeId,
        listingUrl: storeUrl,
      },
      provenance: {
        schemaVersion: 1,
        ...(acquisition.catalog ? {
          catalog: {
            providerId: acquisition.catalog.providerId,
            observedAt: acquisition.catalog.observedAt,
          },
        } : {}),
        artifact: {
          providerId: acquisition.selectedProviderId,
          finalByteHost: acquisition.report.transport.finalByteHost,
          fetchedAt: acquisition.report.transport.fetchedAt,
          format: "crx3",
          size: verification.crxSize,
          sha256: verification.crxSha256,
          retained: true,
        },
        verification: {
          level: "cws-publisher-verified",
          verifiedAt: timestamp,
          proofDerivedStoreId: verification.developerDerivedId,
          developerKeySha256: verification.developerSpkiSha256,
          publisherKeySha256: verification.publisherSpkiSha256,
          publisherTrustRootId: verification.publisherTrustRootId,
          publisherTrustRootVersion: verification.publisherTrustRootVersion,
          manifestSha256: acquisition.package.manifestSha256,
          treeSha256: publishedTreeFingerprint.sha256,
        },
        transfer: {
          kind: "direct-acquisition",
          at: timestamp,
        },
      },
      artifactArchivePath: artifactLivePath,
      updateProviderId: acquisition.selectedProviderId,
      updateState: { status: "idle", checkedAt: timestamp },
      version: acquisition.package.version,
      manifestVersion: acquisition.package.manifestVersion,
      permissions: [...acquisition.package.permissions],
      hostPermissions: [...acquisition.package.hostPermissions],
      optionalPermissions: [...acquisition.package.optionalPermissions],
      optionalHostPermissions: [...acquisition.package.optionalHostPermissions],
      permissionRisks: acquisition.package.permissionRisks.map((risk) => ({ ...risk })),
      installState: "installed",
      updatePolicy: existing?.updatePolicy
        ?? (acquisition.selectedProviderId === "chrome-web-store" ? "auto" : "notify"),
      sha256: verification.crxSha256,
      manifestSha256: acquisition.package.manifestSha256,
      localPath: treeLivePath,
      manifestKey: verification.developerSpkiBase64,
      directoryMode: undefined,
      lastInstalledAt: timestamp,
      lastCheckedAt: timestamp,
      lastError: undefined,
      status: existing?.status ?? "enabled",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    const newBindings = [...existingBindings];
    const existingBindingIds = new Set(existingBindings.map((binding) => binding.environmentId));
    for (const environmentId of environmentIds) {
      if (existingBindingIds.has(environmentId)) continue;
      newBindings.push({
        environmentId,
        extensionId: targetId,
        lifecycleRevision: createId("binding"),
      });
    }
    newBindings.sort((left, right) => left.environmentId.localeCompare(right.environmentId));
    const oldDatabaseFingerprint = existing
      ? extensionDatabaseProjectionFingerprint(existing, existingBindings)
      : undefined;
    const newDatabaseFingerprint = extensionDatabaseProjectionFingerprint(entity, newBindings);
    const artifactOldFingerprint = await fingerprintPublishedPath("artifact", artifactLivePath);
    const treeOldFingerprint = await fingerprintPublishedPath("tree", treeLivePath);
    const publications: [ExtensionCommitPublication, ExtensionCommitPublication] = [
      {
        kind: "artifact",
        stagedPath: path.resolve(acquisition.artifactPath),
        livePath: artifactLivePath,
        asidePath: path.resolve(this.extensionArtifactDir, targetId, `.old-${acquisition.sessionId}`),
        oldFingerprint: artifactOldFingerprint,
        newFingerprint: verification.crxSha256,
      },
      {
        kind: "tree",
        stagedPath: path.resolve(acquisition.stagedRoot),
        livePath: treeLivePath,
        asidePath: path.resolve(this.options.extensionCacheDir, `.old-${targetId}-${acquisition.sessionId}`),
        oldFingerprint: treeOldFingerprint,
        newFingerprint: publishedTreeFingerprint.sha256,
      },
    ];

    let journal: ExtensionCommitJournalRecord | undefined;
    try {
      await syncPublishedTree(acquisition.stagedRoot);
      await syncFile(acquisition.artifactPath);
      journal = await this.commitJournal.create({
        sessionId: acquisition.sessionId,
        targetExtensionId: targetId,
        oldEntityFingerprint: oldDatabaseFingerprint,
        newEntityFingerprint: newDatabaseFingerprint,
        publications,
      });
      await this.options.acquisitionCommitFaultForTesting?.("prepared");
      await this.publishCommitFiles(journal);
      journal = await this.commitJournal.advance(journal, "files-published");
      await this.options.acquisitionCommitFaultForTesting?.("files-published");
      await this.options.repository.commitExtensionAcquisition({
        extension: entity,
        expectedArtifactProviderId: acquisition.selectedProviderId,
        expectedExistingUpdatedAt: existing?.updatedAt,
        expectedEnvironmentBindings: existingBindings,
        environmentBindings: newBindings,
      });
      await this.options.acquisitionCommitFaultForTesting?.("database-written");
      journal = await this.commitJournal.advance(journal, "database-committed");
      await this.options.acquisitionCommitFaultForTesting?.("database-committed");
      await this.finalizeCommitFiles(journal);
      journal = await this.commitJournal.advance(journal, "complete");
      await this.options.acquisitionCommitFaultForTesting?.("complete");
      await this.commitJournal.remove(journal);
      return entity;
    } catch (error) {
      if (!journal && error instanceof ExtensionCommitJournalCreateError) journal = error.record;
      if (!journal) throw error;
      const databaseState = await this.commitDatabaseState(journal).catch(() => undefined);
      try {
        await this.commitJournal.reconcile(journal, {
          databaseState: (record) => this.commitDatabaseState(record),
          rollbackFiles: (record) => this.rollbackCommitFiles(record),
          finalizeFiles: (record) => this.finalizeCommitFiles(record),
        });
      } catch (reconciliationError) {
        throw Object.assign(
          acquisitionError("ACQUISITION_RECONCILIATION_REQUIRED", "The extension commit is awaiting durable startup reconciliation."),
          { reconciliationRequired: true, cause: reconciliationError },
        );
      }
      if (databaseState === "new") {
        const committed = await this.options.repository.getExtension(targetId);
        if (committed) return committed;
      }
      if ((error as { code?: unknown }).code === "ARTIFACT_PROVIDER_DISABLED") throw error;
      throw acquisitionError("ACQUISITION_COMMIT_FAILED", "The extension commit was rolled back safely.", error);
    }
  }

  private async importUploadedArchiveInternal(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    options: ExtensionImportOptions,
  ): Promise<ExtensionEntity> {
    const identity = await this.identityFromArchiveBytes(bytes, assetKind);
    const conflict = await this.resolveImportDisposition(identity, options);
    if (conflict?.disposition === "reuse") {
      return conflict.target;
    }
    if (conflict?.disposition === "overwrite") {
      const existing = conflict.target;
      await fs.mkdir(this.extensionArchiveDir, { recursive: true });
      const archivePath = path.join(this.extensionArchiveDir, `${existing.id}.${assetKind}`);
      await fs.writeFile(archivePath, bytes);
      try {
        return await this.overwriteFromArchive(existing, bytes, assetKind, archivePath);
      } catch (error) {
        // Keep any previous archive for the same id; only remove a brand-new write when overwrite fails
        // after the entity still points at a different sourceUrl.
        if (existing.sourceUrl !== archivePath) {
          await fs.rm(archivePath, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    }

    const extensionId = createId("extension");
    const archivePath = path.join(this.extensionArchiveDir, `${extensionId}.${assetKind}`);
    await fs.mkdir(this.extensionArchiveDir, { recursive: true });
    await fs.writeFile(archivePath, bytes);
    try {
      return await this.createFromArchiveBytes(bytes, assetKind, extensionId, archivePath);
    } catch (error) {
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes the DB row (and bindings) then best-effort cleans panel-owned cache/archive files. */
  async deleteExtension(id: string): Promise<void> {
    return this.withExtensionMutation([id], () => this.deleteExtensionInternal(id));
  }

  private async deleteExtensionInternal(id: string): Promise<void> {
    const extension = await this.getExtensionOrThrow(id);
    await this.options.repository.deleteExtension(id);
    await this.cleanupExtensionFiles(extension);
    await this.cleanupRuntimeBindingsInternal(id);
  }

  /** Best-effort cleanup after the repository has removed one or more bindings. */
  async cleanupRuntimeBindings(extensionId: string, environmentIds?: string[]): Promise<void> {
    return this.withExtensionMutation([extensionId], () => (
      this.cleanupRuntimeBindingsInternal(extensionId, environmentIds)
    ));
  }

  private async cleanupRuntimeBindingsInternal(extensionId: string, environmentIds?: string[]): Promise<void> {
    const held = this.options.activeEnvironmentIds?.() ?? new Set<string>();
    const removable = environmentIds?.filter((environmentId) => !held.has(environmentId));
    if (environmentIds && removable?.length === 0) return;
    if (!environmentIds && held.size > 0) {
      await this.runtimeService.removeExtension(extensionId, undefined, held);
      return;
    }
    await this.runtimeService.removeExtension(extensionId, removable);
  }

  /** New bindings require a package that CBPanel can load now; historical bindings stay untouched. */
  async bindToEnvironments(id: string, environmentIds: string[]): Promise<BrowserEnvironment[]> {
    return this.withExtensionMutation([id], () => this.bindToEnvironmentsInternal(id, environmentIds));
  }

  async updatePreferences(
    id: string,
    patch: Partial<Pick<ExtensionEntity, "status" | "updatePolicy">>,
  ): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], () => this.options.repository.updateExtension(id, patch));
  }

  async unbindFromEnvironments(id: string, environmentIds?: string[]): Promise<BrowserEnvironment[]> {
    return this.withExtensionMutation([id], async () => {
      const environments = await this.options.repository.unbindExtensionFromEnvironments(id, environmentIds);
      await this.cleanupRuntimeBindingsInternal(id, environments.map((environment) => environment.id));
      return environments;
    });
  }

  private async bindToEnvironmentsInternal(id: string, environmentIds: string[]): Promise<BrowserEnvironment[]> {
    const extension = await this.getExtensionOrThrow(id);
    if (!isLoadableInstallState(extension.installState) || !extension.localPath) {
      throw bindPackageRequiredError();
    }
    assertPathHasNoComma(extension.localPath);
    const checked = await this.checkInternal(id);
    if (!isLoadableInstallState(checked.installState) || !checked.localPath) {
      throw bindPackageRequiredError(checked.lastError);
    }
    return this.options.repository.bindExtensionToEnvironments(id, environmentIds);
  }

  async install(id: string, options: InUseGuardOptions = {}): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], () => this.installInternal(id, options));
  }

  private async installInternal(id: string, options: InUseGuardOptions = {}): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    await this.assertNotInUse(extension.id, options);
    if (extension.provenance?.verification.level === "cws-publisher-verified") {
      return this.ensureVerifiedStoreSnapshot(extension);
    }
    // Preserve update-available on rollback so the UI Update action and B16 check()
    // path stay available; collapsing to install-failed would hide the pending update.
    const previousInstalledState =
      extension.installState === "installed" || extension.installState === "update-available"
        ? extension.installState
        : "install-failed";
    // Keep the on-disk snapshot reachable even when the failed install started from
    // update-available; nulling localPath wedges check() and the next launch.
    const previousLocalPath = extension.localPath;
    try {
      // Defense-in-depth for B9/R3: launch and UI no longer auto-apply updates, but direct
      // install/reinstall API calls must still refuse silent permission increases. Inside the
      // try so candidate-manifest download failures still record lastError like other install errors.
      if (extension.installState === "update-available") {
        await this.assertNoAddedPermissionsForUpdate(extension);
      }
      if (extension.sourceKind === "local-directory") {
        return await this.refreshLocalDirectory(extension);
      }
      if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
        return await this.installLocalAsset(extension);
      }
      if (extension.sourceKind === "managed-snapshot") {
        if (extension.localPath && isLoadableInstallState(extension.installState)) {
          return await this.checkInternal(extension.id);
        }
        throw Object.assign(new Error("Retired extension source has no local package; reacquire it through Get extensions."), {
          status: 409,
          code: "EXTENSION_LEGACY_SOURCE_RETIRED",
        });
      }
      throw Object.assign(new Error("Chrome Web Store metadata cannot be installed without a verified asset"), {
        status: 409,
        code: "EXTENSION_WEB_STORE",
      });
    } catch (error) {
      // Permission-gate 409 already persisted update-available + a detailed lastError; rewriting
      // here would clobber "adds permissions: cookies" with the generic confirmation message.
      if (isPermissionConfirmationError(error)) throw error;
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
    return this.withExtensionMutation([id], () => this.checkInternal(id));
  }

  private async checkInternal(id: string): Promise<ExtensionEntity> {
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
      const manifestKey = typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined;
      if (
        extension.directoryMode === "reference"
        && extension.manifestKey
        && manifestKey !== extension.manifestKey
      ) {
        const message = "Reference extension manifest.key does not match its pinned browser identity";
        await this.options.repository.updateExtension(id, {
          lastCheckedAt: nowIso(),
          lastError: message,
        });
        throw Object.assign(new Error(message), {
          status: 409,
          code: "EXTENSION_REFERENCE_IDENTITY_MISMATCH",
        });
      }
      // The entity may claim a pinned identity that a half-finished install never wrote to
      // disk; check() runs before every launch, so heal the manifest here. Reference mode is
      // excluded because localPath is the user's own directory and must stay untouched.
      if (extension.manifestKey && extension.directoryMode !== "reference" && manifest.key !== extension.manifestKey) {
        await applyManifestKey(extension.localPath, extension.manifestKey);
      }
      // `manifestSha256` means "the digest of the package currently installed at localPath", which is
      // exactly what this line reads. check() already rewrites the whole row (manifest fields plus
      // lastCheckedAt), so refreshing costs nothing extra, and refreshing rather than only filling a
      // gap makes every missed install write-point self-heal instead of relying on a list of write
      // points staying complete forever. Falling back to the stored value is a hard requirement: a
      // manifest that cannot be read must never blank an established digest.
      const manifestSha256 = (await readManifestFingerprint(extension.localPath)) ?? extension.manifestSha256;
      if (
        extension.provenance?.verification.level === "cws-publisher-verified"
        && extension.provenance.verification.treeSha256
      ) {
        const treeFingerprint = await fingerprintStagedExtensionTree(extension.localPath, {
          maxFiles: 20_000,
          maxExpandedBytes: 512 * 1024 * 1024,
        }).catch(() => undefined);
        if (!treeFingerprint || treeFingerprint.sha256 !== extension.provenance.verification.treeSha256) {
          const message = "Verified extension files no longer match the retained CRX evidence";
          return this.options.repository.updateExtension(id, {
            installState: "local-missing",
            lastCheckedAt: nowIso(),
            lastError: message,
          });
        }
      }
      const diskManifestKey = !extension.manifestKey
        && manifestKey
        ? manifestKey
        : undefined;
      return this.options.repository.updateExtension(id, {
        ...extensionFieldsFromManifest(manifest),
        // Backups/packages can re-home a formerly unkeyed reference as a managed copy. If its files do
        // contain a key, recover that identity for every directory mode; this is metadata-only and never
        // mutates a user's reference directory.
        ...(diskManifestKey ? { manifestKey: diskManifestKey } : {}),
        manifestSha256,
        installState: extension.installState === "update-available" ? "update-available" : "installed",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      if ((error as { code?: string }).code === "EXTENSION_REFERENCE_IDENTITY_MISMATCH") throw error;
      // No manifestSha256 in this patch on purpose: the failure branch must not carry the field at
      // all, otherwise an unreadable directory would clear the digest on its way to local-missing.
      return this.options.repository.updateExtension(id, {
        installState: "local-missing",
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  /**
   * Reads the best icon declared by the extension's own manifest on demand.
   * Nothing is persisted: freshness is controlled by the caller keying on `updatedAt`.
   * Resolves to `undefined` when the manifest simply declares no icon — a normal state for many
   * packages, so it must not surface as an error the client logs.
   */
  async readIconAsset(id: string): Promise<ExtensionIconAsset | undefined> {
    const extension = await this.getExtensionOrThrow(id);
    if (!extension.localPath) {
      throw Object.assign(new Error("Extension has no local path"), { status: 404 });
    }
    const root = path.resolve(extension.localPath);
    const manifest = await readManifestFromDirectory(root);
    const iconRelPath = pickManifestIcon(manifest);
    if (!iconRelPath) return undefined;
    const iconPath = path.resolve(root, iconRelPath);
    // `icons` is attacker-controlled data inside the package; refuse anything resolving outside.
    // Lexical containment is not enough: `fs.cp` keeps symlinks verbatim, so a copied package can
    // hold `icon.png -> ~/.ssh/id_rsa`, which resolves inside the directory but reads outside it.
    // Both sides are canonicalized or neither is, otherwise a symlinked data dir (macOS
    // /tmp -> /private/tmp) would reject every legitimate icon.
    const [canonicalIconPath, canonicalRoot] = await realpathPair(iconPath, root);
    if (canonicalIconPath === canonicalRoot || !isPathInsideDir(canonicalIconPath, canonicalRoot)) {
      throw Object.assign(new Error(`Extension icon path escapes the extension directory: ${iconRelPath}`), { status: 400 });
    }
    const mime = ICON_MIME_TYPES[path.extname(iconPath).toLowerCase()];
    if (!mime) {
      throw Object.assign(new Error(`Unsupported extension icon type: ${iconRelPath}`), { status: 400 });
    }
    const stats = await fs.stat(iconPath).catch(() => undefined);
    if (!stats?.isFile()) {
      throw Object.assign(new Error(`Extension icon is not a readable file: ${iconRelPath}`), { status: 404 });
    }
    // The manifest picks the file, so a crafted package could point at a huge asset; this ships
    // base64 inside JSON and the client keeps it in memory, so cap it instead of buffering it.
    if (stats.size > MAX_ICON_ASSET_BYTES) {
      throw Object.assign(new Error(`Extension icon is larger than ${MAX_ICON_ASSET_BYTES / 1024} KB: ${iconRelPath}`), { status: 400 });
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(iconPath);
    } catch (error) {
      throw Object.assign(new Error(`Extension icon is not readable: ${(error as Error).message}`), { status: 404 });
    }
    return { mime, data: bytes.toString("base64") };
  }

  async checkUpdate(id: string): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], () => this.checkUpdateInternal(id));
  }

  private async checkUpdateInternal(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);

    if (extension.updateProviderId && extension.storeIdentity?.namespace === "chrome-web-store") {
      return this.options.repository.updateExtension(id, {
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    }

    if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
      return this.checkLocalArchiveUpdate(extension);
    }
    if (extension.sourceKind === "local-directory") {
      return this.checkLocalDirectoryUpdate(extension);
    }
    if (extension.sourceKind === "managed-snapshot") {
      return this.options.repository.updateExtension(id, {
        updateState: { status: "provider-disabled", checkedAt: nowIso() },
        lastCheckedAt: nowIso(),
        lastError: "Managed snapshot has no remote update provider",
      });
    }

    return this.options.repository.updateExtension(id, {
      lastCheckedAt: nowIso(),
      lastError: "Extension has no checkable update source",
    });
  }

  async update(id: string): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], () => this.updateInternal(id));
  }

  private async updateInternal(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    await this.assertNotInUse(extension.id);
    if (extension.installState !== "update-available") {
      throw Object.assign(new Error("Extension update is not available"), { status: 409 });
    }
    // Permission increases are gated inside install() for every entry that can apply a package
    // (install / reinstall / update), so scripts cannot bypass the UI-only R3 disable.
    return this.installInternal(extension.id);
  }

  async reinstall(id: string): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], () => this.reinstallInternal(id));
  }

  private async reinstallInternal(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    await this.assertNotInUse(extension.id);
    if (extension.sourceKind === "chrome-web-store") {
      throw Object.assign(new Error("Chrome Web Store metadata cannot be reinstalled without a verified asset"), {
        status: 409,
        code: "EXTENSION_WEB_STORE",
      });
    }
    if (extension.provenance?.verification.level === "cws-publisher-verified") {
      return this.ensureVerifiedStoreSnapshot(extension);
    }
    if (extension.sourceKind === "managed-snapshot") {
      if (extension.localPath && isLoadableInstallState(extension.installState)) return this.checkInternal(id);
      throw Object.assign(new Error("Retired extension source has no local package; reacquire it through Get extensions."), {
        status: 409,
        code: "EXTENSION_LEGACY_SOURCE_RETIRED",
      });
    }
    return this.installInternal(extension.id);
  }

  async migrateIdentity(id: string): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], () => this.migrateIdentityInternal(id));
  }

  private async migrateIdentityInternal(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (extension.sourceKind === "chrome-web-store") {
      throw Object.assign(new Error("Chrome Web Store metadata cannot be pinned without a verified asset"), {
        status: 409,
        code: "EXTENSION_WEB_STORE",
      });
    }
    if (extension.sourceKind === "local-directory" && extension.directoryMode !== "copy") {
      throw Object.assign(
        new Error("Reference-mode extension directories cannot be pinned; re-import the directory as a snapshot copy"),
        { status: 409, code: "EXTENSION_REFERENCE_MODE" },
      );
    }
    if (extension.manifestKey) {
      throw Object.assign(new Error("Extension identity is already pinned"), {
        status: 409,
        code: "EXTENSION_IDENTITY_PINNED",
      });
    }
    await this.assertNotInUse(extension.id);

    const installedKey = extension.installState === "installed" && extension.localPath
      ? await readManifestKey(extension.localPath)
      : undefined;
    if (installedKey) {
      return this.options.repository.updateExtension(extension.id, { manifestKey: installedKey });
    }

    const localCrxKey = extension.sourceKind === "local-crx"
      ? await fs.readFile(extension.sourceUrl).then((bytes) => extractCrxPublicKey(bytes)).catch(() => undefined)
      : undefined;
    const manifestKey = localCrxKey ?? generateManifestKey();
    await this.options.repository.updateExtension(extension.id, { manifestKey });
    try {
      return await this.installInternal(extension.id);
    } catch (error) {
      // A failed install may still have injected the key into the unpacked manifest; clearing the
      // persisted key then would desync entity and disk and flip the browser-side ID a second time.
      const injectedKey = extension.localPath ? await readManifestKey(extension.localPath) : undefined;
      if (injectedKey !== manifestKey) {
        await this.options.repository.updateExtension(extension.id, { manifestKey: undefined });
      }
      throw error;
    }
  }

  async ensureExtensionsInstalled(
    environmentId: string,
    options: EnsureExtensionsOptions = {},
  ): Promise<EnsureExtensionsResult> {
    const lease = this.mutationCoordinator.enter("extension-cache-commit");
    try {
      const environment = await this.options.repository.getEnvironment(environmentId);
      if (!environment) throw Object.assign(new Error("Environment does not exist"), { status: 404 });
      const mutationKeys = environment.extensionIds.length > 0
        ? environment.extensionIds
        : [`environment-launch-${environmentId}`];
      return await lease.runWithExtensions(mutationKeys, () => (
        this.ensureExtensionsInstalledInternal(environment, options)
      ));
    } finally {
      lease.release();
    }
  }

  private async ensureExtensionsInstalledInternal(
    environment: BrowserEnvironment,
    options: EnsureExtensionsOptions,
  ): Promise<EnsureExtensionsResult> {
    const environmentId = environment.id;
    const extensionById = new Map((await this.options.repository.listExtensions()).map((extension) => [extension.id, extension]));
    const bindingByExtensionId = new Map(
      (await this.options.repository.listEnvironmentExtensionBindings(environmentId))
        .map((binding) => [binding.extensionId, binding] as const),
    );
    const protectsLifecycle = environment.runtimeProfile.mode === "persistent"
      && environment.runtimeProfile.runtime.launcher !== "playwright-browser";
    const paths: string[] = [];
    const warnings: ExtensionLaunchWarning[] = [];
    const registrations: ExtensionLaunchRegistration[] = [];
    const loaded: ExtensionEntity[] = [];
    for (const extensionId of environment.extensionIds) {
      const extension = extensionById.get(extensionId);
      if (!extension) {
        warnings.push({ name: extensionId, reason: "扩展记录不存在（浏览器可能回收未加载扩展的本地数据）" });
        continue;
      }
      if (extension.status === "disabled") {
        warnings.push({ name: extension.name, reason: "扩展已停用，本次启动不会加载（浏览器可能回收未加载扩展的本地数据）" });
        continue;
      }
      // update-available must never auto-install here: update() owns the permission-diff gate,
      // and install() would apply added permissions without the 409 confirmation.
      const installed = isLoadableInstallState(extension.installState)
        ? await this.checkInternal(extension.id)
        : await this.installInternal(extension.id, { exemptEnvironmentId: environmentId });
      if (!isLoadableInstallState(installed.installState) || !installed.localPath) {
        throw Object.assign(new Error(`Extension ${installed.name} is not installed`), { status: 409 });
      }
      if (installed.installState === "update-available") {
        warnings.push({ name: installed.name, reason: "有可用更新未安装，本次启动仍使用当前版本" });
      }
      if (protectsLifecycle) {
        if (!installed.manifestKey) {
          paths.push(path.resolve(installed.localPath));
          warnings.push({
            name: installed.name,
            reason: installed.directoryMode === "reference"
              ? "引用模式扩展缺少稳定 manifest.key，无法启用启动生命周期保护；请重新以复制模式导入。"
              : "扩展缺少稳定 manifest.key，启动生命周期保护已禁用，重复初始化仍可能发生；请先停止相关环境，再执行“固定身份”以固定插件身份。此操作会改变插件 ID，并可能使已有插件数据不可见。",
          });
          if (!this.options.activeEnvironmentIds?.().has(environmentId)) {
            await this.runtimeService.removeExtension(installed.id, [environmentId]);
          }
          loaded.push(installed);
          continue;
        }
        const runtime = await this.runtimeService.materialize({
          environmentId,
          extension: installed,
          lifecycleRevision: bindingByExtensionId.get(installed.id)?.lifecycleRevision,
          initialBehavior: isPreserveLifecycleRevision(bindingByExtensionId.get(installed.id)?.lifecycleRevision)
            ? "preserve"
            : undefined,
          allowReplaceExisting: options.allowRuntimeReplacement,
        });
        paths.push(runtime.path);
        if (runtime.registration) {
          registrations.push({
            ...runtime.registration,
            name: installed.name,
            runtimePath: runtime.path,
          });
        }
        if (runtime.warning) warnings.push({ name: installed.name, reason: runtime.warning });
        if (!runtime.protected && !this.options.activeEnvironmentIds?.().has(environmentId)) {
          await this.runtimeService.removeExtension(installed.id, [environmentId]);
        }
      } else {
        paths.push(installed.localPath);
      }
      loaded.push(installed);
    }
    warnings.push(...duplicateIdentityWarnings(loaded));
    return { paths, warnings, registrations };
  }

  async transitionUpdateProvider(
    id: string,
    providerId: "chrome-web-store" | "crxsoso",
    callerSignal?: AbortSignal,
  ): Promise<ExtensionEntity> {
    if (providerId !== "chrome-web-store" && providerId !== "crxsoso") {
      throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The requested update provider is unsupported.");
    }
    return this.withExtensionMutation([id], async () => {
      const extension = await this.getExtensionOrThrow(id);
      if (
        extension.sourceKind !== "local-crx"
        || extension.storeIdentity?.namespace !== "chrome-web-store"
        || extension.provenance?.verification.level !== "cws-publisher-verified"
        || extension.provenance.verification.proofDerivedStoreId !== extension.storeIdentity.storeId
        || persistedDeveloperFingerprint(extension) !== extension.provenance.verification.developerKeySha256
        || !extension.provenance.artifact.retained
        || extension.artifactArchivePath !== this.canonicalArtifactPath(extension.id)
      ) {
        throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "This extension lacks portable verified store evidence.");
      }
      const retainedStats = await fs.lstat(extension.artifactArchivePath).catch(() => undefined);
      if (!retainedStats?.isFile() || retainedStats.isSymbolicLink() || retainedStats.nlink !== 1) {
        throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The retained package is missing or linked.");
      }
      const retainedVerification = await this.verifyStoreCrxFile(
        extension.artifactArchivePath,
        extension.storeIdentity.storeId,
      );
      if (
        retainedVerification.crxSha256 !== extension.provenance.artifact.sha256
        || retainedVerification.crxSize !== extension.provenance.artifact.size
        || retainedVerification.developerSpkiSha256 !== extension.provenance.verification.developerKeySha256
        || retainedVerification.developerDerivedId !== extension.provenance.verification.proofDerivedStoreId
        || retainedVerification.publisherSpkiSha256 !== extension.provenance.verification.publisherKeySha256
        || retainedVerification.publisherTrustRootId !== extension.provenance.verification.publisherTrustRootId
        || retainedVerification.publisherTrustRootVersion !== extension.provenance.verification.publisherTrustRootVersion
      ) {
        throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The retained package no longer matches its verified evidence.");
      }
      const settings = normalizeSettings(await (
        this.options.readSettings?.() ?? this.options.repository.getSettings()
      ));
      if (!isArtifactProviderEnabled(settings, providerId)) {
        throw acquisitionError("ARTIFACT_PROVIDER_DISABLED", "Enable the selected package provider before switching updates.");
      }
      if (extension.updateProviderId === providerId) return extension;
      if (!this.options.probeArtifactProvider) {
        throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The selected update provider cannot be verified right now.");
      }
      if (this.providerProbeReservations >= 2) {
        throw acquisitionError("ACQUISITION_TEMP_BUDGET_EXCEEDED", "Provider transition probes are using their temporary storage budget.");
      }
      this.providerProbeReservations += 1;
      let probeRoot: string | undefined;
      const activeProbe: ActiveProviderProbe = { providerId, controller: new AbortController() };
      this.activeProviderProbes.add(activeProbe);
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, activeProbe.controller.signal])
        : activeProbe.controller.signal;
      try {
        throwIfProviderProbeAborted(signal);
        probeRoot = await fs.mkdtemp(path.join(this.extensionAcquisitionDir, ".provider-probe-"));
        const probePath = path.join(probeRoot, "artifact.crx");
        const probe = await this.options.probeArtifactProvider(providerId, extension.storeIdentity.storeId, probePath, signal);
        throwIfProviderProbeAborted(signal);
        if (
          probe.storeId !== extension.storeIdentity.storeId
          || probe.artifactProviderId !== providerId
          || path.resolve(probe.download.path) !== path.resolve(probePath)
        ) {
          throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The provider returned inconsistent identity facts.");
        }
        const verified = await this.verifyStoreCrxFile(probePath, extension.storeIdentity.storeId);
        throwIfProviderProbeAborted(signal);
        if (
          verified.crxSha256 !== probe.download.sha256
          || verified.crxSize !== probe.download.size
          || verified.developerSpkiSha256 !== extension.provenance.verification.developerKeySha256
          || verified.developerDerivedId !== extension.provenance.verification.proofDerivedStoreId
          || verified.publisherSpkiSha256 !== extension.provenance.verification.publisherKeySha256
          || verified.publisherTrustRootId !== extension.provenance.verification.publisherTrustRootId
          || verified.publisherTrustRootVersion !== extension.provenance.verification.publisherTrustRootVersion
        ) {
          throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The provider probe failed its CRX3 verification.");
        }
        const latestSettings = normalizeSettings(await (
          this.options.readSettings?.() ?? this.options.repository.getSettings()
        ));
        throwIfProviderProbeAborted(signal);
        if (!isArtifactProviderEnabled(latestSettings, providerId)) {
          throw acquisitionError("ARTIFACT_PROVIDER_DISABLED", "The selected update provider was disabled during verification.");
        }
        // Await inside the try so the registered probe remains cancellable
        // until the repository's synchronous pre-write guard has run.
        return await this.options.repository.updateExtension(
          id,
          {
            updateProviderId: providerId,
            updateState: { status: "idle", checkedAt: nowIso() },
            updatePolicy: providerId === "chrome-web-store" ? "auto" : "notify",
          },
          () => throwIfProviderProbeAborted(signal),
        );
      } finally {
        this.activeProviderProbes.delete(activeProbe);
        try {
          if (probeRoot) await fs.rm(probeRoot, { recursive: true, force: true });
          this.providerProbeReservations = Math.max(0, this.providerProbeReservations - 1);
        } catch {
          // Keep the reservation until startup sweep can reclaim the debt.
        }
      }
    });
  }

  async recordRemoteUpdateObservation(
    id: string,
    providerId: "chrome-web-store" | "crxsoso",
    observation: { status: "idle" | "available" | "provider-disabled" | "provider-unavailable" | "takedown"; availableVersion?: string; errorCode?: string },
    expectedUpdatedAt?: string,
  ): Promise<ExtensionEntity> {
    return this.withExtensionMutation([id], async () => {
      const extension = await this.getExtensionOrThrow(id);
      if (expectedUpdatedAt !== undefined && extension.updatedAt !== expectedUpdatedAt) {
        throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The extension changed while its update was being checked.");
      }
      if (extension.updateProviderId !== providerId || extension.storeIdentity?.namespace !== "chrome-web-store") {
        throw acquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The update observation no longer matches the extension provider.");
      }
      return this.options.repository.updateExtension(id, {
        updateState: {
          ...observation,
          checkedAt: nowIso(),
        },
      });
    });
  }

  async markRegistrationReady(
    registration: Pick<ExtensionLaunchRegistration, "runtimePath" | "signature">,
  ): Promise<void> {
    const key = `runtime-registration-${createHash("sha256").update(path.resolve(registration.runtimePath)).digest("hex")}`;
    await this.withExtensionMutation([key], () => (
      this.runtimeService.markRegistrationReady(registration.runtimePath, registration.signature)
    ));
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

  private async importLocalAsset(
    filePath: string,
    assetKind: ExtensionAssetKind,
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionEntity> {
    const sourceUrl = path.resolve(filePath);
    const bytes = await fs.readFile(sourceUrl);
    const identity = await this.identityFromArchiveBytes(bytes, assetKind, sourceUrl);
    const conflict = await this.resolveImportDisposition(identity, options);
    if (conflict?.disposition === "reuse") {
      return conflict.target;
    }
    if (conflict?.disposition === "overwrite") {
      return this.overwriteFromArchive(conflict.target, bytes, assetKind, sourceUrl);
    }
    return this.createFromArchiveBytes(bytes, assetKind, createId("extension"), sourceUrl);
  }

  private async createFromArchiveBytes(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    extensionId: string,
    sourceUrl: string,
  ): Promise<ExtensionEntity> {
    const sha256 = sha256Hex(bytes);
    const localPath = await this.extractAsset(bytes, assetKind, extensionId);
    try {
      // Before acquireManifestKey so the digest comes from the package's untouched manifest.
      // (The algorithm drops `key` anyway, but reading first keeps the intent obvious.)
      const manifestSha256 = await readManifestFingerprint(localPath);
      const manifestKey = await this.acquireManifestKey(localPath, assetKind === "crx" ? bytes : undefined);
      const manifest = await readManifestFromDirectory(localPath);
      return await this.options.repository.createExtension({
        ...extensionFieldsFromManifest(manifest),
        id: extensionId,
        sourceKind: assetKind === "zip" ? "local-zip" : "local-crx",
        sourceUrl,
        sha256,
        manifestSha256,
        localPath,
        manifestKey,
        installState: "installed",
        lastInstalledAt: nowIso(),
      });
    } catch (error) {
      await fs.rm(localPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async identityFromArchiveBytes(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    sourceUrl?: string,
  ): Promise<ImportCandidateIdentity> {
    const sha256 = sha256Hex(bytes);
    const previewId = `preview-${sha256.slice(0, 12)}`;
    let manifestKey: string | undefined;
    let manifestSha256: string | undefined;
    let name: string | undefined;
    let version: string | undefined;
    try {
      const { manifest, rawManifestText } = await this.readAssetManifestSources(bytes, assetKind, previewId);
      if (typeof manifest.key === "string" && manifest.key.trim()) {
        manifestKey = manifest.key.trim();
      } else if (assetKind === "crx") {
        manifestKey = extractCrxPublicKey(bytes) || undefined;
      }
      // Same normalization as the directory path so the nameVersion layer compares like with like.
      const manifestFields = extensionFieldsFromManifest(manifest);
      name = manifestFields.name;
      version = manifestFields.version;
      manifestSha256 = manifestFingerprint(rawManifestText);
    } catch {
      // Match still works via sha256/sourceUrl when the archive is valid enough to install later.
    }
    return { manifestKey, sha256, sourceUrl, manifestSha256, name, version };
  }

  private async findImportConflict(identity: ImportCandidateIdentity): Promise<ExtensionImportConflict | undefined> {
    const extensions = await this.options.repository.listExtensions();
    const byKey = identity.manifestKey
      ? extensions.filter((extension) => extension.manifestKey && extension.manifestKey === identity.manifestKey)
      : [];
    if (byKey.length > 0) {
      return { matchBy: "manifestKey", candidates: await this.rankConflictCandidates(byKey) };
    }

    const bySha = identity.sha256
      ? extensions.filter((extension) => extension.sha256 && extension.sha256.toLowerCase() === identity.sha256!.toLowerCase())
      : [];
    if (bySha.length > 0) {
      return { matchBy: "sha256", candidates: await this.rankConflictCandidates(bySha) };
    }

    const normalizedSource = normalizeComparableSourceUrl(identity.sourceUrl);
    const bySource = normalizedSource
      ? extensions.filter((extension) => normalizeComparableSourceUrl(extension.sourceUrl) === normalizedSource)
      : [];
    if (bySource.length > 0) {
      return { matchBy: "sourceUrl", candidates: await this.rankConflictCandidates(bySource) };
    }

    // Content identity, deliberately placed AFTER sourceUrl: re-importing the same path means the
    // user is aiming at the record that owns that path, even when a package with identical content
    // sits in another row. Being a stronger identity does not make it the more specific intent.
    const byManifestSha = identity.manifestSha256
      ? extensions.filter((extension) =>
        extension.manifestSha256 && extension.manifestSha256.toLowerCase() === identity.manifestSha256!.toLowerCase())
      : [];
    if (byManifestSha.length > 0) {
      return { matchBy: "manifestSha256", candidates: await this.rankConflictCandidates(byManifestSha) };
    }

    // Softest layer, deliberately last: a zip and its extracted directory share no key, no sha256,
    // and no path, so without this the same extension lands twice and each copy gets its own
    // injected key — two isolated extension IDs in the browser that nothing else warns about.
    // Still required alongside the fingerprint above: it covers rows stored before fingerprints
    // existed, and packages whose manifest was re-serialized between the two imports.
    const comparableName = normalizeComparableName(identity.name);
    const comparableVersion = identity.version?.trim();
    if (!comparableName || !comparableVersion) return undefined;
    const byNameVersion = extensions.filter((extension) =>
      normalizeComparableName(extension.name) === comparableName && extension.version.trim() === comparableVersion);
    if (byNameVersion.length === 0) return undefined;
    return { matchBy: "nameVersion", candidates: await this.rankConflictCandidates(byNameVersion) };
  }

  private async rankConflictCandidates(candidates: ExtensionEntity[]): Promise<ExtensionEntity[]> {
    if (candidates.length <= 1) return candidates;
    const environments = await this.options.repository.listEnvironments();
    const bindingCount = new Map<string, number>();
    for (const environment of environments) {
      for (const extensionId of environment.extensionIds) {
        bindingCount.set(extensionId, (bindingCount.get(extensionId) ?? 0) + 1);
      }
    }
    return [...candidates].sort((left, right) => {
      const bindingDelta = (bindingCount.get(right.id) ?? 0) - (bindingCount.get(left.id) ?? 0);
      if (bindingDelta !== 0) return bindingDelta;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  /**
   * First import without disposition throws 409 with candidates.
   * Retry may force a target id (reuse/overwrite) even if the new package no longer
   * matches by key/sha/source — the user already confirmed the conflict dialog.
   */
  private async resolveImportDisposition(
    identity: ImportCandidateIdentity,
    options: ExtensionImportOptions,
  ): Promise<{ disposition: "reuse" | "overwrite"; target: ExtensionEntity } | undefined> {
    const disposition = options.conflictDisposition;
    if (disposition === "create") return undefined;

    if ((disposition === "reuse" || disposition === "overwrite") && options.conflictExtensionId) {
      const target = await this.options.repository.getExtension(options.conflictExtensionId);
      if (!target) {
        throw Object.assign(new Error("conflictExtensionId does not exist"), {
          status: 404,
          code: "EXTENSION_IMPORT_CONFLICT_TARGET",
        });
      }
      return { disposition, target };
    }

    const conflict = await this.findImportConflict(identity);
    if (!conflict) return undefined;

    if (disposition === "reuse" || disposition === "overwrite") {
      // Only an unambiguous match may be resolved implicitly. The name+version layer routinely
      // matches several records at once, and silently overwriting whichever one ranked first is the
      // wrong default for a destructive action, so the caller has to name its target.
      if (conflict.candidates.length > 1) {
        throw Object.assign(new Error("Several extensions match; pass conflictExtensionId to choose one"), {
          status: 409,
          code: "EXTENSION_IMPORT_CONFLICT",
          matchBy: conflict.matchBy,
          candidates: conflict.candidates,
        });
      }
      return { disposition, target: conflict.candidates[0]! };
    }

    throw Object.assign(new Error("Extension already exists; choose reuse, overwrite, or create"), {
      status: 409,
      code: "EXTENSION_IMPORT_CONFLICT",
      matchBy: conflict.matchBy,
      candidates: conflict.candidates,
    });
  }

  private async overwriteFromDirectory(
    existing: ExtensionEntity,
    sourcePath: string,
    mode: ExtensionDirectoryMode,
    manifestFields: ExtensionManifestFields,
    manifestSha256: string | undefined,
  ): Promise<ExtensionEntity> {
    await this.assertNotInUse(existing.id);
    if (mode === "reference") {
      // Overwrite never writes into a user directory; keep the entity as a live reference.
      // Clear archive checksums — a previous zip/crx overwrite must not keep a stale sha256.
      return this.options.repository.updateExtension(existing.id, {
        ...manifestFields,
        sourceKind: "local-directory",
        sourceUrl: sourcePath,
        localPath: sourcePath,
        manifestKey: await readManifestKey(sourcePath),
        directoryMode: "reference",
        sha256: undefined,
        manifestSha256,
        installState: "installed",
        lastInstalledAt: nowIso(),
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    }

    const localPath = await this.copyDirectoryIntoCache(sourcePath, existing.id);
    const manifestKey = await this.resolveOverwriteManifestKey(existing, localPath);
    return this.options.repository.updateExtension(existing.id, {
      ...manifestFields,
      sourceKind: "local-directory",
      sourceUrl: sourcePath,
      localPath,
      manifestKey,
      directoryMode: "copy",
      sha256: undefined,
      manifestSha256,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async overwriteFromArchive(
    existing: ExtensionEntity,
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    sourceUrl: string,
  ): Promise<ExtensionEntity> {
    await this.assertNotInUse(existing.id);
    const sha256 = sha256Hex(bytes);
    const localPath = await this.extractAsset(bytes, assetKind, existing.id);
    // Read before the key is forced back on: the record must carry the NEW package's fingerprint,
    // because keeping the replaced package's digest would make the row answer for content it no
    // longer holds.
    const manifestSha256 = await readManifestFingerprint(localPath);
    const manifestKey = await this.resolveOverwriteManifestKey(
      existing,
      localPath,
      assetKind === "crx" ? bytes : undefined,
    );
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(existing.id, {
      ...extensionFieldsFromManifest(manifest),
      sourceKind: assetKind === "zip" ? "local-zip" : "local-crx",
      sourceUrl,
      sha256,
      manifestSha256,
      localPath,
      manifestKey,
      directoryMode: undefined,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  /**
   * Overwrite keeps the browser-side extension ID stable: force the previous key back onto disk
   * even when the incoming package carries a different developer key.
   */
  private async resolveOverwriteManifestKey(
    existing: ExtensionEntity,
    localPath: string,
    crxBytes?: Uint8Array,
  ): Promise<string | undefined> {
    if (existing.manifestKey) {
      await applyManifestKey(localPath, existing.manifestKey);
      return existing.manifestKey;
    }
    return this.acquireManifestKey(localPath, crxBytes);
  }

  private async cleanupExtensionFiles(extension: ExtensionEntity): Promise<void> {
    const cacheDir = path.resolve(this.options.extensionCacheDir);
    const localPath = extension.localPath ? path.resolve(extension.localPath) : undefined;
    const isReference = extension.sourceKind === "local-directory" && extension.directoryMode === "reference";
    if (localPath && !isReference && isPathInsideDir(localPath, cacheDir) && path.basename(localPath) === extension.id) {
      await fs.rm(localPath, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const assetKind of ["zip", "crx"] as const) {
      const archivePath = path.join(this.extensionArchiveDir, `${extension.id}.${assetKind}`);
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
    }
    const artifactDirectory = path.dirname(this.canonicalArtifactPath(extension.id));
    const artifactStats = await fs.lstat(artifactDirectory).catch(() => undefined);
    if (artifactStats) {
      if (artifactStats.isSymbolicLink() || !artifactStats.isDirectory()) {
        // Remove only the unexpected managed entry itself; never traverse a
        // linked extension-id directory during deletion.
        await fs.rm(artifactDirectory, { force: true }).catch(() => undefined);
      } else {
        try {
          const [canonicalDirectory, canonicalRoot] = await Promise.all([
            fs.realpath(artifactDirectory),
            fs.realpath(this.extensionArtifactDir),
          ]);
          if (
            isPathInsideDir(canonicalDirectory, canonicalRoot)
            && path.basename(canonicalDirectory) === extension.id
          ) {
            await fs.rm(artifactDirectory, { recursive: true, force: true }).catch(() => undefined);
          }
        } catch {
          // The row is already deleted and every other owned-file cleanup is
          // best effort. A concurrent disappearance must not turn a committed
          // delete into an API failure or skip runtime cleanup.
        }
      }
    }
  }

  private async checkLocalArchiveUpdate(extension: ExtensionEntity): Promise<ExtensionEntity> {
    if (!extension.sourceUrl) {
      return this.options.repository.updateExtension(extension.id, {
        lastCheckedAt: nowIso(),
        lastError: "Extension has no local archive source",
      });
    }
    try {
      const bytes = await fs.readFile(extension.sourceUrl);
      const nextSha = sha256Hex(bytes);
      const assetKind: ExtensionAssetKind = extension.sourceKind === "local-crx" ? "crx" : "zip";
      let nextVersion = extension.version;
      try {
        const manifest = await this.readManifestFromAsset(bytes, assetKind, extension.id);
        nextVersion = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : nextVersion;
      } catch {
        // Version compare is best-effort; sha256 alone is enough to mark update-available.
      }
      const changed = (extension.sha256 && extension.sha256.toLowerCase() !== nextSha)
        || (nextVersion !== extension.version);
      if (!changed) {
        return this.options.repository.updateExtension(extension.id, {
          lastCheckedAt: nowIso(),
          lastError: undefined,
        });
      }
      return this.options.repository.updateExtension(extension.id, {
        installState: "update-available",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      return this.options.repository.updateExtension(extension.id, {
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  private async checkLocalDirectoryUpdate(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const sourcePath = extension.directoryMode === "copy"
      ? path.resolve(extension.sourceUrl)
      : path.resolve(extension.localPath ?? extension.sourceUrl);
    try {
      const manifest = await readManifestFromDirectory(sourcePath);
      const nextVersion = typeof manifest.version === "string" && manifest.version.trim()
        ? manifest.version.trim()
        : extension.version;
      if (nextVersion === extension.version) {
        // Reference mode still refreshes metadata from the live directory on check-update.
        if (extension.directoryMode === "reference") {
          return this.options.repository.updateExtension(extension.id, {
            ...extensionFieldsFromManifest(manifest),
            lastCheckedAt: nowIso(),
            lastError: undefined,
          });
        }
        return this.options.repository.updateExtension(extension.id, {
          lastCheckedAt: nowIso(),
          lastError: undefined,
        });
      }
      return this.options.repository.updateExtension(extension.id, {
        installState: "update-available",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      return this.options.repository.updateExtension(extension.id, {
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  private async refreshLocalDirectory(extension: ExtensionEntity): Promise<ExtensionEntity> {
    if (extension.directoryMode === "copy") {
      const sourcePath = path.resolve(extension.sourceUrl);
      let manifest: ExtensionManifest;
      try {
        manifest = await readManifestFromDirectory(sourcePath);
      } catch (error) {
        return await this.keepCopySnapshot(extension, error as Error);
      }
      const localPath = await this.copyDirectoryIntoCache(sourcePath, extension.id);
      // Taken from the fresh snapshot after the copy and before the stored key is re-injected:
      // that is the exact content this record now loads into the browser.
      const manifestSha256 = await readManifestFingerprint(localPath);
      if (extension.manifestKey) await applyManifestKey(localPath, extension.manifestKey);
      return this.options.repository.updateExtension(extension.id, {
        ...extensionFieldsFromManifest(manifest),
        manifestSha256,
        localPath,
        installState: "installed",
        lastInstalledAt: nowIso(),
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    }

    const localPath = extension.localPath ?? extension.sourceUrl;
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      manifestSha256: await readManifestFingerprint(localPath),
      sourceUrl: localPath,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  /**
   * Copy mode promises the extension survives losing its source directory. When the source is
   * unreadable but the cached snapshot still holds a valid manifest, stay installed on that
   * snapshot instead of failing the reinstall/launch path.
   *
   * The fingerprint is deliberately left untouched: this path installs nothing, it keeps the
   * previous snapshot, so the stored digest already describes what is on disk.
   */
  private async keepCopySnapshot(extension: ExtensionEntity, sourceError: Error): Promise<ExtensionEntity> {
    if (!extension.localPath) throw sourceError;
    const snapshot = await readManifestFromDirectory(extension.localPath).catch(() => undefined);
    if (!snapshot) throw sourceError;
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(snapshot),
      installState: "installed",
      lastCheckedAt: nowIso(),
      lastError: sourceError.message,
    });
  }

  private async installLocalAsset(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const bytes = await fs.readFile(extension.sourceUrl);
    const actualSha256 = sha256Hex(bytes);
    // update-available means checkUpdate already detected a source change; reinstall from the
    // current local file. Other states still verify the stored checksum for integrity.
    if (
      extension.installState !== "update-available"
      && extension.sha256
      && actualSha256 !== extension.sha256.toLowerCase()
    ) {
      throw Object.assign(new Error("Extension checksum mismatch"), { status: 409 });
    }
    const localPath = await this.extractAsset(bytes, extension.sourceKind === "local-crx" ? "crx" : "zip", extension.id);
    // Before the stored key is forced back on. A local archive replaced in place lands here, so
    // skipping the fingerprint would leave the row describing the package it no longer holds.
    const manifestSha256 = await readManifestFingerprint(localPath);
    if (extension.manifestKey) await applyManifestKey(localPath, extension.manifestKey);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      sha256: actualSha256,
      manifestSha256,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async assertNotInUse(extensionId: string, options: InUseGuardOptions = {}): Promise<void> {
    const activeEnvironmentIds = this.options.activeEnvironmentIds?.();
    if (!activeEnvironmentIds || activeEnvironmentIds.size === 0) return;
    const environments = await this.options.repository.listEnvironments();
    const blocked = environments.filter(
      (environment) =>
        environment.id !== options.exemptEnvironmentId
        && environment.extensionIds.includes(extensionId)
        && activeEnvironmentIds.has(environment.id),
    );
    if (blocked.length === 0) return;
    throw Object.assign(new Error("扩展正在被运行中的环境使用，请先停止相关会话再执行此操作。"), {
      status: 409,
      code: "EXTENSION_IN_USE",
    });
  }

  private assertOutsideExtensionCache(sourcePath: string): void {
    const cacheDir = path.resolve(this.options.extensionCacheDir);
    const runtimeDir = path.resolve(
      this.options.extensionRuntimeDir ?? path.join(path.dirname(cacheDir), "extension-runtimes"),
    );
    const comparableSource = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
    for (const [managedDir, label] of [[cacheDir, "extension cache"], [runtimeDir, "extension runtime"]] as const) {
      const comparableManaged = process.platform === "win32" ? managedDir.toLowerCase() : managedDir;
      if (comparableSource === comparableManaged || comparableSource.startsWith(`${comparableManaged}${path.sep}`)) {
        throw Object.assign(
          new Error(`Extension directory cannot be inside the ${label} directory: ${sourcePath}`),
          { status: 400 },
        );
      }
      if (comparableManaged.startsWith(`${comparableSource}${path.sep}`)) {
        throw Object.assign(
          new Error(`Extension directory cannot contain the ${label} directory: ${sourcePath}`),
          { status: 400 },
        );
      }
    }
  }

  private async ensureVerifiedStoreSnapshot(extension: ExtensionEntity): Promise<ExtensionEntity> {
    let candidate = extension;
    if (candidate.localPath && isLoadableInstallState(candidate.installState)) {
      candidate = await this.checkInternal(candidate.id);
      if (candidate.localPath && isLoadableInstallState(candidate.installState)) return candidate;
    }
    try {
      return await this.restoreVerifiedStoreSnapshot(candidate);
    } catch (error) {
      if ((error as { reconciliationRequired?: unknown }).reconciliationRequired) throw error;
      await this.options.repository.updateExtension(candidate.id, {
        installState: "local-missing",
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      }).catch(() => undefined);
      throw error;
    }
  }

  /**
   * Rebuilds the app-managed unpacked tree from the exact retained Web Store CRX.
   * This path is deliberately local-only: it re-establishes trust from the bytes
   * and stored evidence, then publishes only the tree while keeping the retained
   * artifact immutable. It never consults the update provider or a legacy URL.
   */
  private async restoreVerifiedStoreSnapshot(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const artifactPath = this.canonicalArtifactPath(extension.id);
    if (
      extension.sourceKind !== "local-crx"
      || extension.storeIdentity?.namespace !== "chrome-web-store"
      || !extension.provenance
      || !extension.provenance.artifact.retained
      || extension.provenance.verification.level !== "cws-publisher-verified"
      || extension.artifactArchivePath !== artifactPath
      || extension.sourceUrl !== artifactPath
      || !extension.provenance.artifact.sha256
      || !extension.provenance.verification.treeSha256
      || !extension.manifestKey
    ) {
      throw Object.assign(new Error("Verified store extension lacks a complete retained local package."), {
        status: 409,
        code: "EXTENSION_STORE_REACQUISITION_REQUIRED",
      });
    }

    const recoverySessionId = `reinstall-${randomBytes(24).toString("base64url")}`;
    const recoveryRoot = path.join(this.extensionAcquisitionDir, recoverySessionId);
    const artifactLink = path.join(recoveryRoot, "artifact.crx");
    const stagedRoot = path.join(recoveryRoot, "unpacked");
    await fs.mkdir(recoveryRoot, { recursive: false });
    let journalPending = false;
    try {
      await validateTransferredExtensionArtifact({
        extension,
        artifactPath,
        expectedSha256: extension.provenance.artifact.sha256,
        validationDir: stagedRoot,
        verifyFile: this.verifyStoreCrxFile,
      });
      // The validator owns validationDir cleanup for transfer callers. Re-run the
      // same bounded staging once more as the publication candidate so validated
      // bytes never cross from an external path and no generic CRX unzip path is used.
      const verification = await this.verifyStoreCrxFile(artifactPath, extension.storeIdentity.storeId);
      const packageFacts = await preflightExtensionPackage({
        archivePath: artifactPath,
        archiveOffset: verification.zipOffset,
        archiveLength: verification.zipSize,
        stagingDir: stagedRoot,
      });
      const signedManifestKey = await readManifestKeyExact(packageFacts.stagedRoot);
      if (signedManifestKey && signedManifestKey !== verification.developerSpkiBase64) {
        throw acquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The retained signed Manifest key conflicts with its verified developer identity.");
      }
      if (!signedManifestKey) await applyManifestKey(packageFacts.stagedRoot, verification.developerSpkiBase64);
      const publishedTreeFingerprint = await fingerprintStagedExtensionTree(packageFacts.stagedRoot, {
        maxFiles: 20_000,
        maxExpandedBytes: 512 * 1024 * 1024,
      });
      if (
        verification.crxSha256 !== extension.provenance.artifact.sha256
        || verification.crxSize !== extension.provenance.artifact.size
        || verification.developerDerivedId !== extension.storeIdentity.storeId
        || verification.developerSpkiSha256 !== extension.provenance.verification.developerKeySha256
        || verification.publisherSpkiSha256 !== extension.provenance.verification.publisherKeySha256
        || verification.publisherTrustRootId !== extension.provenance.verification.publisherTrustRootId
        || verification.publisherTrustRootVersion !== extension.provenance.verification.publisherTrustRootVersion
        || verification.developerSpkiBase64 !== extension.manifestKey
        || packageFacts.manifestSha256 !== extension.manifestSha256
        || packageFacts.name !== extension.name
        || packageFacts.version !== extension.version
        || packageFacts.manifestVersion !== extension.manifestVersion
        || !sameStringSet(packageFacts.permissions, extension.permissions)
        || !sameStringSet(packageFacts.hostPermissions, extension.hostPermissions)
        || !sameStringSet(packageFacts.optionalPermissions, extension.optionalPermissions ?? [])
        || !sameStringSet(packageFacts.optionalHostPermissions, extension.optionalHostPermissions ?? [])
        || publishedTreeFingerprint.sha256 !== extension.provenance.verification.treeSha256
      ) {
        throw acquisitionError("ACQUISITION_COMMIT_FAILED", "The retained extension package no longer matches its verified installed evidence.");
      }

      // The two-publication journal also protects tree-only recovery. Its artifact
      // publication is a same-byte temporary hard-free copy, allowing the existing
      // crash reconciliation state machine to remain the single publication owner.
      await fs.copyFile(artifactPath, artifactLink, fsConstants.COPYFILE_EXCL);
      const timestamp = nowIso();
      const bindings = await this.options.repository.listExtensionEnvironmentBindings(extension.id);
      const restoredEntity: ExtensionEntity = {
        ...extension,
        localPath: path.resolve(this.options.extensionCacheDir, extension.id),
        installState: "installed",
        lastInstalledAt: timestamp,
        lastCheckedAt: timestamp,
        lastError: undefined,
        updatedAt: timestamp,
      };
      const liveTreePath = restoredEntity.localPath as string;
      const oldDatabaseFingerprint = extensionDatabaseProjectionFingerprint(extension, bindings);
      const newDatabaseFingerprint = extensionDatabaseProjectionFingerprint(restoredEntity, bindings);
      const publications: [ExtensionCommitPublication, ExtensionCommitPublication] = [
        {
          kind: "artifact",
          stagedPath: artifactLink,
          livePath: artifactPath,
          asidePath: path.join(path.dirname(artifactPath), `.old-${recoverySessionId}`),
          oldFingerprint: extension.provenance.artifact.sha256,
          newFingerprint: extension.provenance.artifact.sha256,
        },
        {
          kind: "tree",
          stagedPath: packageFacts.stagedRoot,
          livePath: liveTreePath,
          asidePath: path.join(this.options.extensionCacheDir, `.old-${extension.id}-${recoverySessionId}`),
          oldFingerprint: await fingerprintPublishedPath("tree", liveTreePath),
          newFingerprint: publishedTreeFingerprint.sha256,
        },
      ];

      let journal: ExtensionCommitJournalRecord | undefined;
      try {
        await syncPublishedTree(packageFacts.stagedRoot);
        await syncFile(artifactLink);
        journal = await this.commitJournal.create({
          sessionId: recoverySessionId,
          targetExtensionId: extension.id,
          oldEntityFingerprint: oldDatabaseFingerprint,
          newEntityFingerprint: newDatabaseFingerprint,
          publications,
        });
        journalPending = true;
        await this.options.acquisitionCommitFaultForTesting?.("prepared");
        await this.publishCommitFiles(journal);
        journal = await this.commitJournal.advance(journal, "files-published");
        await this.options.acquisitionCommitFaultForTesting?.("files-published");
        await this.options.repository.commitExtensionAcquisition({
          extension: restoredEntity,
          expectedExistingUpdatedAt: extension.updatedAt,
          expectedEnvironmentBindings: bindings,
          environmentBindings: bindings,
        });
        await this.options.acquisitionCommitFaultForTesting?.("database-written");
        journal = await this.commitJournal.advance(journal, "database-committed");
        await this.options.acquisitionCommitFaultForTesting?.("database-committed");
        await this.finalizeCommitFiles(journal);
        journal = await this.commitJournal.advance(journal, "complete");
        await this.options.acquisitionCommitFaultForTesting?.("complete");
        await this.commitJournal.remove(journal);
        journalPending = false;
        return restoredEntity;
      } catch (error) {
        if (!journal && error instanceof ExtensionCommitJournalCreateError) {
          journal = error.record;
          journalPending = true;
        }
        if (!journal) throw error;
        const databaseState = await this.commitDatabaseState(journal).catch(() => undefined);
        try {
          await this.commitJournal.reconcile(journal, {
            databaseState: (record) => this.commitDatabaseState(record),
            rollbackFiles: (record) => this.rollbackCommitFiles(record),
            finalizeFiles: (record) => this.finalizeCommitFiles(record),
          });
          journalPending = false;
        } catch (reconciliationError) {
          throw Object.assign(
            acquisitionError("ACQUISITION_RECONCILIATION_REQUIRED", "The local reinstall is awaiting durable startup reconciliation."),
            { reconciliationRequired: true, cause: reconciliationError },
          );
        }
        if (databaseState === "new") {
          const committed = await this.options.repository.getExtension(extension.id);
          if (committed) return committed;
        }
        throw acquisitionError("ACQUISITION_COMMIT_FAILED", "The local reinstall was rolled back safely.", error);
      }
    } finally {
      // A surviving journal owns these staging files. Startup reconciliation
      // needs them after a secondary in-process recovery failure.
      if (!journalPending) {
        await fs.rm(recoveryRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async copyDirectoryIntoCache(sourcePath: string, extensionId: string): Promise<string> {
    const outputDir = path.join(this.options.extensionCacheDir, extensionId);
    const swapSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempDir = `${outputDir}.tmp-${swapSuffix}`;
    const asideDir = `${outputDir}.old-${swapSuffix}`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    let movedAside = false;
    try {
      await fs.cp(sourcePath, tempDir, { recursive: true });
      movedAside = await renameIfExists(outputDir, asideDir);
      await fs.rename(tempDir, outputDir);
      await fs.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
      return outputDir;
    } catch (error) {
      if (movedAside) await fs.rename(asideDir, outputDir).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractAsset(bytes: Uint8Array, assetKind: ExtensionAssetKind, extensionId: string): Promise<string> {
    const zipBytes = assetKind === "crx" ? stripCrxHeader(bytes) : bytes;
    const outputDir = path.join(this.options.extensionCacheDir, extensionId);
    const swapSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempDir = `${outputDir}.tmp-${swapSuffix}`;
    const asideDir = `${outputDir}.old-${swapSuffix}`;
    const unpackDir = `${tempDir}-unpack`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(unpackDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    let movedAside = false;
    try {
      // Unpack into a throwaway tree first, then promote the manifest root into tempDir so
      // the live swap renames one directory (mirrors copyDirectoryIntoCache).
      await fs.mkdir(unpackDir, { recursive: true });
      await writeZipEntries(zipBytes, unpackDir);
      const manifestDir = await findManifestDirectory(unpackDir);
      await fs.rename(manifestDir, tempDir);
      await fs.rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
      movedAside = await renameIfExists(outputDir, asideDir);
      await fs.rename(tempDir, outputDir);
      await fs.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
      return outputDir;
    } catch (error) {
      if (movedAside) await fs.rename(asideDir, outputDir).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async getExtensionOrThrow(id: string): Promise<ExtensionEntity> {
    const extension = await this.options.repository.getExtension(id);
    if (!extension) throw Object.assign(new Error("Extension does not exist"), { status: 404 });
    return extension;
  }

  private async assertNoAddedPermissionsForUpdate(extension: ExtensionEntity): Promise<void> {
    const nextManifest = await this.readInstallCandidateManifest(extension);
    const candidate = { ...extension, ...extensionFieldsFromManifest(nextManifest) };
    const addedPermissions = permissionsAdded(extension, candidate);
    if (addedPermissions.length === 0) return;
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

  private async readInstallCandidateManifest(extension: ExtensionEntity): Promise<ExtensionManifest> {
    if (extension.sourceKind === "local-directory") {
      // Copy mode installs FROM sourceUrl; diffing localPath would compare the snapshot with
      // itself and turn the added-permission gate into a no-op.
      return extension.directoryMode === "copy"
        ? readManifestFromDirectory(extension.sourceUrl)
        : readManifestFromDirectory(extension.localPath ?? extension.sourceUrl);
    }
    if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
      const bytes = await fs.readFile(extension.sourceUrl);
      // Permission-diff for an available update must read the new package even when sha differs.
      if (
        extension.installState !== "update-available"
        && extension.sha256
        && sha256Hex(bytes) !== extension.sha256.toLowerCase()
      ) {
        throw Object.assign(new Error("Extension checksum mismatch"), { status: 409 });
      }
      return this.readManifestFromAsset(bytes, extension.sourceKind === "local-crx" ? "crx" : "zip", extension.id);
    }
    throw Object.assign(new Error("Chrome Web Store metadata cannot be installed without a verified asset"), {
      status: 409,
      code: "EXTENSION_WEB_STORE",
    });
  }

  private async readManifestFromAsset(bytes: Uint8Array, assetKind: ExtensionAssetKind, extensionId: string): Promise<ExtensionManifest> {
    return (await this.readAssetManifestSources(bytes, assetKind, extensionId)).manifest;
  }

  /**
   * Both views of an archive's manifest from a single extraction: the resolved object for entity
   * fields, and the raw text the fingerprint must hash (see `manifestFingerprint`, reason 2).
   */
  private async readAssetManifestSources(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    extensionId: string,
  ): Promise<{ manifest: ExtensionManifest; rawManifestText: string }> {
    const zipBytes = assetKind === "crx" ? stripCrxHeader(bytes) : bytes;
    const tempDir = path.join(this.options.extensionCacheDir, `.preview-${extensionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    try {
      await writeZipEntries(zipBytes, tempDir);
      const manifestDir = await findManifestDirectory(tempDir);
      const manifest = await readManifestFromDirectory(manifestDir);
      const rawManifestText = await fs.readFile(path.join(manifestDir, "manifest.json"), "utf8");
      return { manifest, rawManifestText };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  private async acquireManifestKey(localPath: string, crxBytes?: Uint8Array): Promise<string> {
    const existing = await readManifestKey(localPath);
    if (existing) return existing;
    // Local imports may be CRX3 packages with a verifiable developer key. Legacy
    // remote URLs are intentionally never read here; their source authority has
    // been retired and cannot influence browser identity.
    const manifestKey = (crxBytes && extractCrxPublicKey(crxBytes)) || generateManifestKey();
    await applyManifestKey(localPath, manifestKey);
    return manifestKey;
  }

  canonicalArtifactPath(extensionId: string): string {
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(extensionId)) {
      throw Object.assign(new Error("Extension id cannot select a managed artifact path"), {
        status: 400,
        code: "EXTENSION_ARTIFACT_ID_INVALID",
      });
    }
    return path.join(this.extensionArtifactDir, extensionId, "current.crx");
  }

  private async publishCommitFiles(record: ExtensionCommitJournalRecord): Promise<void> {
    for (const publication of record.publications) {
      await fs.mkdir(path.dirname(publication.livePath), { recursive: true });
      await fs.rm(publication.asidePath, { recursive: true, force: true });
      if (await pathExists(publication.livePath)) {
        await fs.rename(publication.livePath, publication.asidePath);
      }
      try {
        await fs.rename(publication.stagedPath, publication.livePath);
      } catch (error) {
        if (await pathExists(publication.asidePath)) {
          await fs.rename(publication.asidePath, publication.livePath).catch(() => undefined);
        }
        throw error;
      }
      if (await fingerprintPublishedPath(publication.kind, publication.livePath) !== publication.newFingerprint) {
        throw acquisitionError("ACQUISITION_COMMIT_FAILED", "Published extension files failed their fingerprint check.");
      }
      await syncNearestManagedDirectory(path.dirname(publication.livePath));
    }
  }

  private async rollbackCommitFiles(record: ExtensionCommitJournalRecord): Promise<void> {
    for (const publication of [...record.publications].reverse()) {
      const liveFingerprint = await fingerprintPublishedPath(publication.kind, publication.livePath);
      const asideExists = await pathExists(publication.asidePath);
      const stagedExists = await pathExists(publication.stagedPath);
      if (publication.oldFingerprint === publication.newFingerprint) {
        // A same-byte publication (retained CRX during tree-only reinstall)
        // has no old/new distinction. Keep a valid live copy in place and never
        // infer publication merely because staging is absent.
        if (liveFingerprint !== publication.oldFingerprint) {
          const asideFingerprint = asideExists
            ? await fingerprintPublishedPath(publication.kind, publication.asidePath)
            : undefined;
          const stagedFingerprint = stagedExists
            ? await fingerprintPublishedPath(publication.kind, publication.stagedPath)
            : undefined;
          const recoveryPath = asideFingerprint === publication.oldFingerprint
            ? publication.asidePath
            : stagedFingerprint === publication.oldFingerprint
              ? publication.stagedPath
              : undefined;
          if (!recoveryPath) throw new Error("Could not recover the unchanged extension publication.");
          await fs.rm(publication.livePath, { recursive: true, force: true });
          await fs.mkdir(path.dirname(publication.livePath), { recursive: true });
          await fs.rename(recoveryPath, publication.livePath);
        }
        await Promise.all([
          fs.rm(publication.asidePath, { recursive: true, force: true }),
          fs.rm(publication.stagedPath, { recursive: true, force: true }),
        ]);
        if (await fingerprintPublishedPath(publication.kind, publication.livePath) !== publication.oldFingerprint) {
          throw new Error("Could not restore the unchanged extension publication exactly.");
        }
        await syncNearestManagedDirectory(path.dirname(publication.livePath));
        continue;
      }
      // In the prepared phase a same-byte live file may be the old publication, so only
      // move it back when an aside proves we already displaced it, or when the staged
      // source is gone (a crash immediately after the final rename for a new target).
      if (liveFingerprint === publication.newFingerprint && (asideExists || !stagedExists)) {
        await fs.mkdir(path.dirname(publication.stagedPath), { recursive: true });
        if (stagedExists) await fs.rm(publication.stagedPath, { recursive: true, force: true });
        await fs.rename(publication.livePath, publication.stagedPath);
      }
      if (asideExists) {
        await fs.rm(publication.livePath, { recursive: true, force: true });
        await fs.rename(publication.asidePath, publication.livePath);
      }
      const restoredFingerprint = await fingerprintPublishedPath(publication.kind, publication.livePath);
      if (restoredFingerprint !== publication.oldFingerprint) {
        throw new Error("Could not restore the previous extension publication exactly.");
      }
      await syncNearestManagedDirectory(path.dirname(publication.livePath));
    }
  }

  private async finalizeCommitFiles(record: ExtensionCommitJournalRecord): Promise<void> {
    for (const publication of record.publications) {
      let liveFingerprint = await fingerprintPublishedPath(publication.kind, publication.livePath);
      if (liveFingerprint !== publication.newFingerprint) {
        const stagedFingerprint = await fingerprintPublishedPath(publication.kind, publication.stagedPath);
        if (stagedFingerprint !== publication.newFingerprint) {
          throw new Error("Committed extension publication is missing its verified new bytes.");
        }
        await fs.rm(publication.livePath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(publication.livePath), { recursive: true });
        await fs.rename(publication.stagedPath, publication.livePath);
        liveFingerprint = await fingerprintPublishedPath(publication.kind, publication.livePath);
      }
      if (liveFingerprint !== publication.newFingerprint) {
        throw new Error("Committed extension publication fingerprint is invalid.");
      }
      await Promise.all([
        fs.rm(publication.asidePath, { recursive: true, force: true }),
        fs.rm(publication.stagedPath, { recursive: true, force: true }),
      ]);
      await syncNearestManagedDirectory(path.dirname(publication.livePath));
    }
  }

  private async commitDatabaseState(record: ExtensionCommitJournalRecord): Promise<"old" | "new"> {
    const extension = await this.options.repository.getExtension(record.targetExtensionId);
    if (!extension) {
      if (!record.oldEntityFingerprint) return "old";
      throw new Error("Extension commit database state matches neither journal projection.");
    }
    const bindings = await this.options.repository.listExtensionEnvironmentBindings(extension.id);
    const fingerprint = extensionDatabaseProjectionFingerprint(
      extension,
      bindings,
    );
    if (fingerprint === record.newEntityFingerprint) return "new";
    if (fingerprint === record.oldEntityFingerprint) return "old";
    throw new Error("Extension commit database state matches neither journal projection.");
  }

  private async withExtensionMutation<T>(
    extensionIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<T> {
    const lease = this.mutationCoordinator.enter("extension-cache-commit");
    try {
      return await lease.runWithExtensions(extensionIds, operation);
    } finally {
      lease.release();
    }
  }
}

export async function readManifestFromDirectory(directory: string): Promise<ExtensionManifest> {
  const manifestPath = path.join(path.resolve(directory), "manifest.json");
  let manifest: unknown;
  try {
    await fs.access(manifestPath, fsConstants.R_OK);
    manifest = JSON.parse(stripBom(await fs.readFile(manifestPath, "utf8")));
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
  return resolveManifestI18n(path.resolve(directory), candidate);
}

/** Chrome keys `icons` by pixel size; prefer 128, else the largest up to 256, else the largest. */
function pickManifestIcon(manifest: ExtensionManifest): string | undefined {
  return pickIconFromSizeMap(manifest.icons)
    ?? pickActionIcon(manifest.action)
    ?? pickActionIcon(manifest.browser_action);
}

/** Toolbar-only extensions often declare no top-level `icons`, just `action.default_icon`. */
function pickActionIcon(action: unknown): string | undefined {
  if (typeof action === "string") return normalizeIconPath(action);
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const defaultIcon = (action as { default_icon?: unknown }).default_icon;
  if (typeof defaultIcon === "string") return normalizeIconPath(defaultIcon);
  return pickIconFromSizeMap(defaultIcon);
}

function pickIconFromSizeMap(icons: unknown): string | undefined {
  if (!icons || typeof icons !== "object" || Array.isArray(icons)) return undefined;
  const entries: { size: number; value: string }[] = [];
  for (const [key, value] of Object.entries(icons as Record<string, unknown>)) {
    const normalized = normalizeIconPath(value);
    if (!normalized) continue;
    const size = Number.parseInt(key, 10);
    if (!Number.isFinite(size) || size <= 0) continue;
    entries.push({ size, value: normalized });
  }
  if (entries.length === 0) return undefined;
  entries.sort((left, right) => right.size - left.size);
  return (
    entries.find((entry) => entry.size === 128)
    ?? entries.find((entry) => entry.size <= 256)
    ?? entries[0]
  )?.value;
}

/** Manifests may write package-root paths like "/icons/128.png"; Chrome resolves those inside the package. */
function normalizeIconPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^[\\/]+/, "");
  return trimmed || undefined;
}

export async function resolveManifestI18n(directory: string, manifest: ExtensionManifest): Promise<ExtensionManifest> {
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const description = typeof manifest.description === "string" ? manifest.description : "";
  if (!MESSAGE_PLACEHOLDER_PATTERN.test(name) && !MESSAGE_PLACEHOLDER_PATTERN.test(description)) return manifest;

  try {
    const locales = messageLocaleCandidates(manifest.default_locale);
    const cache = new Map<string, Map<string, string> | undefined>();
    return {
      ...manifest,
      name: await resolveMessagePlaceholders(name, directory, locales, cache),
      description: await resolveMessagePlaceholders(description, directory, locales, cache),
    };
  } catch {
    return manifest;
  }
}

function messageLocaleCandidates(defaultLocale: unknown): string[] {
  return [...new Set([...PREFERRED_MESSAGE_LOCALES, normalizeLocaleTag(defaultLocale), ...FALLBACK_MESSAGE_LOCALES].filter(Boolean))];
}

function normalizeLocaleTag(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().replace(/-/g, "_") : "";
  if (!normalized) return "";
  const segments = normalized.split("_");
  if (segments.length === 1) return normalized.toLowerCase();
  if (segments.length !== 2) return normalized;
  return `${segments[0].toLowerCase()}_${segments[1].toUpperCase()}`;
}

async function resolveMessagePlaceholders(
  value: string,
  directory: string,
  locales: string[],
  cache: Map<string, Map<string, string> | undefined>,
): Promise<string> {
  if (!MESSAGE_PLACEHOLDER_PATTERN.test(value)) return value;
  let resolved = value;
  for (const token of new Set(value.match(/__MSG_([A-Za-z0-9_@]+)__/g) ?? [])) {
    const messageName = token.slice("__MSG_".length, -"__".length);
    const message = await readLocalizedMessage(directory, locales, cache, messageName);
    if (message === undefined) continue;
    resolved = resolved.split(token).join(message);
  }
  return resolved;
}

async function readLocalizedMessage(
  directory: string,
  locales: string[],
  cache: Map<string, Map<string, string> | undefined>,
  messageName: string,
): Promise<string | undefined> {
  for (const locale of locales) {
    const messages = await readLocaleMessages(directory, locale, cache);
    const message = messages?.get(messageName.toLowerCase());
    if (typeof message === "string") return message;
  }
  return undefined;
}

async function readLocaleMessages(
  directory: string,
  locale: string,
  cache: Map<string, Map<string, string> | undefined>,
): Promise<Map<string, string> | undefined> {
  if (cache.has(locale)) return cache.get(locale);
  let messages: Map<string, string> | undefined;
  try {
    const raw = stripBom(await fs.readFile(path.join(directory, "_locales", locale, "messages.json"), "utf8"));
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      messages = new Map<string, string>();
      for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const message = (entry as { message?: unknown } | null)?.message;
        if (typeof message === "string") messages.set(key.toLowerCase(), message);
      }
    }
  } catch {
    messages = undefined;
  }
  cache.set(locale, messages);
  return messages;
}

function isCacheArtifactName(name: string): boolean {
  return name.startsWith(CACHE_PREVIEW_PREFIX) || CACHE_ARTIFACT_MARKERS.some((marker) => name.includes(marker));
}

/**
 * cloakbrowser joins `--load-extension` paths with commas, so a path containing one silently
 * splits into two bogus paths and the extension never loads while preflight still passes.
 */
function assertPathHasNoComma(sourcePath: string): void {
  if (!sourcePath.includes(",")) return;
  throw Object.assign(
    new Error(`Extension directory path cannot contain a comma because the browser separates extension paths with commas: ${sourcePath}`),
    { status: 400 },
  );
}

function isLoadableInstallState(state: ExtensionEntity["installState"]): boolean {
  return state === "installed" || state === "update-available";
}

async function assertPreparedAcquisitionPaths(
  acquisition: PreparedExtensionAcquisition,
  acquisitionRoot: string,
): Promise<void> {
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(acquisition.sessionId)) {
    throw acquisitionError("ACQUISITION_COMMIT_FAILED", "Acquisition session identity is invalid.");
  }
  const sessionRoot = path.resolve(acquisitionRoot, acquisition.sessionId);
  const artifactPath = path.resolve(acquisition.artifactPath);
  const stagedRoot = path.resolve(acquisition.stagedRoot);
  if (
    artifactPath !== path.join(sessionRoot, "artifact.crx")
    || !isPathInsideDir(stagedRoot, sessionRoot)
    || stagedRoot === sessionRoot
  ) {
    throw acquisitionError("ACQUISITION_COMMIT_FAILED", "Acquisition paths escaped their disposable session root.");
  }
  const [sessionStats, artifactStats, stagedStats] = await Promise.all([
    fs.lstat(sessionRoot).catch(() => undefined),
    fs.lstat(artifactPath).catch(() => undefined),
    fs.lstat(stagedRoot).catch(() => undefined),
  ]);
  if (
    !sessionStats?.isDirectory() || sessionStats.isSymbolicLink()
    || !artifactStats?.isFile() || artifactStats.isSymbolicLink() || artifactStats.nlink !== 1
    || !stagedStats?.isDirectory() || stagedStats.isSymbolicLink()
  ) {
    throw acquisitionError("ACQUISITION_COMMIT_FAILED", "Acquisition files are missing or linked outside the managed session root.");
  }
  const [canonicalAcquisitionRoot, canonicalSession, canonicalArtifact, canonicalStaged] = await Promise.all([
    fs.realpath(path.resolve(acquisitionRoot)),
    fs.realpath(sessionRoot),
    fs.realpath(artifactPath),
    fs.realpath(stagedRoot),
  ]);
  if (
    !isPathInsideDir(canonicalSession, canonicalAcquisitionRoot)
    || path.basename(canonicalSession) !== acquisition.sessionId
    || !isPathInsideDir(canonicalArtifact, canonicalSession)
    || !isPathInsideDir(canonicalStaged, canonicalSession)
  ) {
    throw acquisitionError("ACQUISITION_COMMIT_FAILED", "Acquisition files traverse a linked filesystem component.");
  }
}

function assertSameVerificationFacts(
  expected: PreparedExtensionAcquisition["verification"],
  actual: PreparedExtensionAcquisition["verification"],
): void {
  for (const key of [
    "requestedId",
    "declaredId",
    "developerDerivedId",
    "developerSpkiBase64",
    "developerSpkiSha256",
    "publisherSpkiSha256",
    "publisherTrustRootId",
    "publisherTrustRootVersion",
    "zipOffset",
    "zipSize",
    "crxSize",
    "crxSha256",
  ] as const) {
    if (expected[key] !== actual[key]) {
      throw acquisitionError("ACQUISITION_COMMIT_FAILED", "CRX3 verification evidence changed after preflight.");
    }
  }
}

function persistedDeveloperFingerprint(extension: ExtensionEntity): string | undefined {
  return extension.provenance?.verification.developerKeySha256
    ?? manifestKeyFingerprint(extension.manifestKey);
}

function manifestKeyFingerprint(manifestKey: string | undefined): string | undefined {
  if (!manifestKey) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(manifestKey, "base64"), format: "der", type: "spki" });
    return createHash("sha256")
      .update(key.export({ format: "der", type: "spki" }))
      .digest("hex");
  } catch {
    return undefined;
  }
}

function extensionDatabaseProjectionFingerprint(
  extension: ExtensionEntity,
  bindings: Array<{ environmentId: string; extensionId: string; lifecycleRevision?: string }>,
): string {
  return createHash("sha256")
    .update(stableJson({
      extension,
      bindings: [...bindings]
        .map((binding) => ({
          environmentId: binding.environmentId,
          extensionId: binding.extensionId,
          lifecycleRevision: binding.lifecycleRevision,
        }))
        .sort((left, right) => (
          left.environmentId.localeCompare(right.environmentId)
          || left.extensionId.localeCompare(right.extensionId)
        )),
    }), "utf8")
    .digest("hex");
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value));
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, item]) => [key, sortJsonValue(item)]));
}

async function fingerprintPublishedPath(
  kind: ExtensionCommitPublication["kind"],
  candidate: string,
): Promise<string | undefined> {
  const stats = await fs.lstat(candidate).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stats) return undefined;
  if (kind === "tree") {
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Extension tree publication is not an ordinary directory.");
    return (await fingerprintStagedExtensionTree(candidate, {
      maxFiles: 20_000,
      maxExpandedBytes: 512 * 1024 * 1024,
    })).sha256;
  }
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error("Extension artifact publication is not an ordinary file.");
  }
  const handle = await fs.open(candidate, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

async function syncManagedDirectory(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(directory, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (process.platform !== "win32" || (code !== "EISDIR" && code !== "EPERM" && code !== "EINVAL")) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function syncFile(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, "r");
  try {
    try {
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform !== "win32" || (code !== "EPERM" && code !== "EINVAL" && code !== "ENOTSUP")) throw error;
    }
  } finally {
    await handle.close();
  }
}

async function syncPublishedTree(root: string): Promise<void> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    const stats = await fs.lstat(child);
    if (stats.isSymbolicLink()) throw acquisitionError("ACQUISITION_COMMIT_FAILED", "The staged extension tree contains a linked path.");
    if (stats.isDirectory()) {
      await syncPublishedTree(child);
      await syncManagedDirectory(child);
    } else if (stats.isFile()) {
      await syncFile(child);
    } else {
      throw acquisitionError("ACQUISITION_COMMIT_FAILED", "The staged extension tree contains a special path.");
    }
  }
  await syncManagedDirectory(root);
}

async function syncNearestManagedDirectory(directory: string): Promise<void> {
  let candidate = path.resolve(directory);
  for (;;) {
    const stats = await fs.lstat(candidate).catch(() => undefined);
    if (stats?.isDirectory() && !stats.isSymbolicLink()) {
      await syncManagedDirectory(candidate);
      return;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return;
    candidate = parent;
  }
}

async function pathExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

function uniqueBoundedIds(values: readonly string[]): string[] {
  if (values.length > 10_000) throw acquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Too many environment bindings were requested.");
  const ids = [...new Set(values.map((value) => value.trim()))];
  if (ids.some((value) => !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw acquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "An environment binding id is invalid.");
  }
  return ids;
}

function safeTokenEquals(actual: string | undefined, expected: string): boolean {
  if (!actual) return false;
  const left = Buffer.from(actual, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function compareExtensionVersions(left: string, right: string): number {
  const a = left.split(".").map((part) => Number.parseInt(part, 10));
  const b = right.split(".").map((part) => Number.parseInt(part, 10));
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = Number.isFinite(a[index]) ? a[index] : 0;
    const bv = Number.isFinite(b[index]) ? b[index] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function assertServerExtensionId(value: string): void {
  if (
    !/^[A-Za-z0-9_-]{1,256}$/.test(value)
    || value === "."
    || value === ".."
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(value)
  ) {
    throw acquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The server extension target id is invalid.");
  }
}

function isArtifactProviderEnabled(
  settings: AppSettings,
  providerId: PreparedExtensionAcquisition["selectedProviderId"],
): boolean {
  return selectedExtensionArtifactProvider(settings.extensionAcquisition) === providerId;
}

function acquisitionError(code: string, message: string, cause?: unknown): Error {
  const status = code === "ACQUISITION_COMMIT_FAILED" ? 500 : code === "ARTIFACT_PROVIDER_DISABLED" ? 409 : 409;
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { status, code });
}

function bindPackageRequiredError(detail?: string): Error {
  return Object.assign(
    new Error(detail ? `Extension cannot be bound until its local package is valid: ${detail}` : "Extension cannot be bound until it has a valid installed package"),
    { status: 409, code: "EXTENSION_BIND_PACKAGE_REQUIRED" },
  );
}

/** Chromium derives one ID per key/path, so a shared identity means one of the two never loads. */
function duplicateIdentityWarnings(extensions: ExtensionEntity[]): ExtensionLaunchWarning[] {
  const warnings: ExtensionLaunchWarning[] = [];
  const firstByKey = new Map<string, ExtensionEntity>();
  const firstByPath = new Map<string, ExtensionEntity>();

  for (const extension of extensions) {
    if (extension.manifestKey) {
      const first = firstByKey.get(extension.manifestKey);
      if (!first) {
        firstByKey.set(extension.manifestKey, extension);
      } else {
        warnings.push({ name: extension.name, reason: `与 ${first.name} 使用相同的固定 key，浏览器只会加载其中一个` });
      }
    }

    const normalizedPath = normalizeComparablePath(extension.localPath);
    if (!normalizedPath) continue;
    const firstPath = firstByPath.get(normalizedPath);
    if (!firstPath) {
      firstByPath.set(normalizedPath, extension);
      continue;
    }
    warnings.push({
      name: extension.name,
      reason: `与 ${firstPath.name} 使用相同的本地路径，浏览器只会加载其中一个`,
    });
  }
  return warnings;
}

function normalizeComparableSourceUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
  return normalizeComparablePath(trimmed);
}

function normalizeComparablePath(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const resolved = path.resolve(value.trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Display names differ only in case/padding across import paths, so both are ignored when matching. */
function normalizeComparableName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function isPathInsideDir(targetPath: string, parentDir: string): boolean {
  const parent = process.platform === "win32" ? path.resolve(parentDir).toLowerCase() : path.resolve(parentDir);
  const target = process.platform === "win32" ? path.resolve(targetPath).toLowerCase() : path.resolve(targetPath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

/**
 * Canonicalizes a target and its containing directory together so a symlink cannot pass a lexical
 * containment check. Either both sides are canonical or neither is: resolving only the target would
 * reject every icon under a symlinked data directory. A missing target (or a platform that refuses
 * realpath) falls back to the lexical paths, which is exactly the previous behaviour.
 */
async function realpathPair(targetPath: string, parentDir: string): Promise<[string, string]> {
  try {
    return [await fs.realpath(targetPath), await fs.realpath(parentDir)];
  } catch {
    return [targetPath, parentDir];
  }
}

function isMissingManifestError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function renameIfExists(from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function analyzePermissionRisks(input: PermissionRiskInput): ExtensionPermissionRisk[] {
  const risks = new Map<string, ExtensionPermissionRisk>();
  const addRisk = (risk: ExtensionPermissionRisk): void => {
    const existing = risks.get(risk.permission);
    if (existing) {
      const moreSpecificContentScriptRisk = risk.reasonKey === "content-script-all-urls"
        && existing.reasonKey !== "content-script-all-urls";
      if (!moreSpecificContentScriptRisk && (existing.level === "high" || risk.level !== "high")) return;
    }
    risks.set(risk.permission, risk);
  };

  for (const permission of [...(input.permissions ?? []), ...(input.hostPermissions ?? [])]) {
    const risk = classifyPermission(permission);
    if (risk) addRisk({ permission, ...risk });
  }
  for (const match of input.contentScriptMatches ?? []) {
    if (!ALL_URLS_PATTERNS.has(match)) continue;
    addRisk({ permission: match, level: "high", reason: "内容脚本注入所有网站", reasonKey: "content-script-all-urls" });
  }
  for (const permission of [...(input.optionalPermissions ?? []), ...(input.optionalHostPermissions ?? [])]) {
    const risk = classifyPermission(permission);
    if (risk) addRisk({ permission, ...risk, reason: `可选权限：${risk.reason}`, optional: true });
  }

  return [...risks.values()];
}

function classifyPermission(
  permission: string,
): { level: ExtensionPermissionRiskLevel; reason: string; reasonKey: ExtensionPermissionRiskReasonKey } | undefined {
  if (ALL_URLS_PATTERNS.has(permission)) return { level: "high", reason: "可访问所有网站", reasonKey: "all-urls" };
  if (HIGH_RISK_PERMISSIONS.has(permission)) {
    return { level: "high", reason: "High-privilege browser extension permission", reasonKey: "high-privilege" };
  }
  const medium = MEDIUM_RISK_PERMISSIONS[permission];
  return medium ? { level: "medium", reason: medium.reason, reasonKey: medium.reasonKey } : undefined;
}

/** The subset of an entity that is derived purely from a resolved manifest. */
type ExtensionManifestFields = Pick<
  ExtensionEntity,
  | "name"
  | "description"
  | "version"
  | "manifestVersion"
  | "permissions"
  | "hostPermissions"
  | "optionalPermissions"
  | "optionalHostPermissions"
  | "permissionRisks"
>;

function extensionFieldsFromManifest(manifest: ExtensionManifest): ExtensionManifestFields {
  const permissions = stringArray(manifest.permissions);
  const contentMatches = contentScriptMatches(manifest.content_scripts);
  const hostPermissions = [...new Set([...stringArray(manifest.host_permissions), ...contentMatches])];
  const optionalPermissions = stringArray(manifest.optional_permissions);
  const optionalHostPermissions = stringArray(manifest.optional_host_permissions);
  return {
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : "Extension",
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    version: typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : "0.0.0",
    manifestVersion: Number(manifest.manifest_version),
    permissions,
    hostPermissions,
    optionalPermissions,
    optionalHostPermissions,
    permissionRisks: analyzePermissionRisks({
      permissions,
      hostPermissions,
      optionalPermissions,
      optionalHostPermissions,
      contentScriptMatches: contentMatches,
    }),
  };
}

function contentScriptMatches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const matches: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    matches.push(...stringArray((entry as { matches?: unknown }).matches));
  }
  return [...new Set(matches)];
}

async function discoverChromeExtensionCandidates(rootPath: string): Promise<ExtensionDirectoryCandidate[]> {
  const extensionDirectories = await listDirectories(rootPath);
  const byPath = new Map<string, ExtensionDirectoryCandidate>();

  for (const extensionDirectory of extensionDirectories) {
    const extensionId = path.basename(extensionDirectory);
    const versionDirectories = await listDirectories(extensionDirectory);
    for (const versionDirectory of versionDirectories) {
      const candidate = await readManifestCandidate(versionDirectory, extensionId);
      if (candidate) byPath.set(candidate.path, candidate);
    }
  }

  return [...byPath.values()].sort((left, right) =>
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.extensionId.localeCompare(right.extensionId) ||
    left.path.localeCompare(right.path),
  );
}

async function readDirectManifestCandidate(directory: string): Promise<ExtensionDirectoryCandidate | undefined> {
  if (!(await manifestFileExists(directory))) return undefined;
  const manifest = await readManifestFromDirectory(directory);
  return manifestCandidateFromManifest(directory, inferExtensionId(directory), manifest);
}

async function readManifestCandidate(directory: string, extensionId: string): Promise<ExtensionDirectoryCandidate | undefined> {
  try {
    const manifest = await readManifestFromDirectory(directory);
    return manifestCandidateFromManifest(directory, extensionId, manifest);
  } catch {
    return undefined;
  }
}

function manifestCandidateFromManifest(directory: string, extensionId: string, manifest: ExtensionManifest): ExtensionDirectoryCandidate {
  const fields = extensionFieldsFromManifest(manifest);
  const resolvedPath = path.resolve(directory);
  return {
    id: sha256Hex(Buffer.from(resolvedPath, "utf8")).slice(0, 16),
    extensionId,
    name: fields.name,
    version: fields.version,
    manifestVersion: fields.manifestVersion,
    path: resolvedPath,
    permissionRisks: fields.permissionRisks,
  };
}

async function manifestFileExists(directory: string): Promise<boolean> {
  try {
    await fs.access(path.join(path.resolve(directory), "manifest.json"), fsConstants.R_OK);
    return true;
  } catch (error) {
    if (isMissingManifestError(error)) return false;
    throw Object.assign(new Error(`Cannot read extension manifest: ${(error as Error).message}`), { status: 400 });
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingManifestError(error)) return [];
    throw Object.assign(new Error(`Cannot read extension directory: ${(error as Error).message}`), { status: 400 });
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

function inferExtensionId(directory: string): string {
  return path.basename(path.resolve(directory));
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const input of paths) {
    if (typeof input !== "string" || !input.trim()) continue;
    const resolved = path.resolve(input.trim());
    const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    uniquePaths.push(resolved);
  }
  return uniquePaths;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function permissionsAdded(previous: ExtensionEntity, next: ExtensionEntity): string[] {
  return extensionPermissionIncreases(previous, next);
}

function isPermissionConfirmationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { status?: unknown }).status === 409 &&
    Array.isArray((error as { permissions?: unknown }).permissions)
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Adopting a CRX developer key inherits that extension's browser-side ID and therefore its
 * stored data in every profile, so the key is only adopted when the CRX3 `sha256_with_rsa`
 * proof actually verifies over this exact payload. CRX2 (dead format) and ECDSA proofs are
 * never adopted; callers fall back to a generated key.
 */
export function extractCrxPublicKey(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.byteLength < 16) return undefined;
    if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "Cr24") return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) !== 3) return undefined;

    const headerLength = view.getUint32(8, true);
    if (headerLength === 0 || 12 + headerLength > bytes.byteLength) return undefined;
    const headerFields = readProtobufFields(bytes.subarray(12, 12 + headerLength));
    if (!headerFields) return undefined;
    const signedHeaderData = headerFields.find((field) => field.field === 10000)?.value;
    if (!signedHeaderData) return undefined;
    const crxId = readProtobufFields(signedHeaderData)?.find((field) => field.field === 1)?.value;
    if (!crxId || crxId.byteLength !== 16) return undefined;
    const crxIdHex = Buffer.from(crxId).toString("hex");
    const zipPayload = bytes.subarray(12 + headerLength);

    for (const proof of headerFields.filter((field) => field.field === 2)) {
      const proofFields = readProtobufFields(proof.value);
      const publicKey = proofFields?.find((field) => field.field === 1)?.value;
      const signature = proofFields?.find((field) => field.field === 2)?.value;
      if (!publicKey || publicKey.byteLength === 0 || !signature || signature.byteLength === 0) continue;
      if (sha256Hex(publicKey).slice(0, 32) !== crxIdHex) continue;
      if (!verifyCrx3Signature(publicKey, signature, signedHeaderData, zipPayload)) continue;
      return Buffer.from(publicKey).toString("base64");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function verifyCrx3Signature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  signedHeaderData: Uint8Array,
  zipPayload: Uint8Array,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey), format: "der", type: "spki" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(crx3SignedDataPrefix(signedHeaderData.byteLength));
    verifier.update(signedHeaderData);
    verifier.update(zipPayload);
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

function crx3SignedDataPrefix(signedHeaderLength: number): Buffer {
  const prefix = Buffer.alloc(CRX3_SIGNED_DATA_MAGIC.length + 1 + 4);
  prefix.write(CRX3_SIGNED_DATA_MAGIC, 0, "ascii");
  prefix.writeUInt8(0, CRX3_SIGNED_DATA_MAGIC.length);
  prefix.writeUInt32LE(signedHeaderLength, CRX3_SIGNED_DATA_MAGIC.length + 1);
  return prefix;
}

export function generateManifestKey(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
}

export async function applyManifestKey(directory: string, key: string): Promise<void> {
  const manifestPath = path.join(path.resolve(directory), "manifest.json");
  const manifest = parseManifestJson(stripBom(await fs.readFile(manifestPath, "utf8"))) as Record<string, unknown>;
  if (manifest.key === key) return;
  manifest.key = key;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readManifestKey(directory: string): Promise<string | undefined> {
  try {
    const manifestPath = path.join(path.resolve(directory), "manifest.json");
    const manifest = parseManifestJson(stripBom(await fs.readFile(manifestPath, "utf8"))) as { key?: unknown };
    return typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined;
  } catch {
    return undefined;
  }
}

function throwIfProviderProbeAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw acquisitionError("ACQUISITION_CANCELLED", "The update-provider verification was cancelled.");
}

async function readManifestKeyExact(directory: string): Promise<string | undefined> {
  try {
    const manifestPath = path.join(path.resolve(directory), "manifest.json");
    const manifest = parseManifestJson(stripBom(await fs.readFile(manifestPath, "utf8"))) as { key?: unknown };
    return typeof manifest.key === "string" && manifest.key ? manifest.key : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fingerprints the `manifest.json` sitting in `directory`.
 * Best-effort by design: an unreadable or invalid manifest yields `undefined` so a missing
 * fingerprint never fails an import or a check — the softer `nameVersion` layer still covers
 * those records.
 */
async function readManifestFingerprint(directory: string): Promise<string | undefined> {
  try {
    return manifestFingerprint(await fs.readFile(path.join(path.resolve(directory), "manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Content identity of one extension package, derived from its RAW manifest text.
 *
 * Three properties, each load-bearing — do not simplify any of them:
 *
 * 1. The top-level `key` is dropped. Copy imports get a per-record key injected into their snapshot
 *    (`acquireManifestKey`), so keeping it would make two imports of the SAME package hash
 *    differently and defeat this layer entirely. Packages that ship their own `key` lose nothing:
 *    the earlier `manifestKey` layer already catches those.
 * 2. The input is the package's own text, never the object `readManifestFromDirectory` returns —
 *    that one ran through `resolveManifestI18n`, whose result depends on the `_locales` message
 *    files and on the order of `PREFERRED_MESSAGE_LOCALES`. Hashing it would silently invalidate
 *    every already-stored digest the day that preference list changes: no error, records just stop
 *    matching.
 * 3. The value is re-serialized key-sorted instead of hashing the raw bytes. A manifest inside a ZIP
 *    and a copy the user unpacked by hand routinely differ in indentation, newlines, BOM and key
 *    order, and none of those differences mean a different package.
 */
function manifestFingerprint(rawManifestText: string): string {
  const parsed = JSON.parse(stripBom(rawManifestText)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Invalid extension manifest"), { status: 400 });
  }
  const withoutKey = { ...(parsed as Record<string, unknown>) };
  delete withoutKey.key;
  return sha256Hex(Buffer.from(canonicalJsonText(withoutKey), "utf8"));
}

/** Key-sorted re-serialization; array order is preserved because a manifest's arrays are ordered data. */
function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // Code-unit order, never `localeCompare`: a locale-sensitive sort would make the digest depend
      // on the host's locale, so the same package would hash differently on two machines.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonText(item)}`).join(",")}}`;
  }
  // Only reached for JSON scalars (null / string / finite number / boolean), which always stringify.
  return JSON.stringify(value);
}

function parseManifestJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`Invalid extension manifest: ${(error as Error).message}`), { status: 400 });
  }
}

function readProtobufFields(bytes: Uint8Array): Array<{ field: number; value: Uint8Array }> | undefined {
  const fields: Array<{ field: number; value: Uint8Array }> = [];
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const tag = readVarint(bytes, cursor);
    if (!tag) return undefined;
    cursor = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (!length) return undefined;
      const end = length.next + length.value;
      if (end > bytes.byteLength) return undefined;
      fields.push({ field: fieldNumber, value: bytes.subarray(length.next, end) });
      cursor = end;
      continue;
    }
    if (wireType === 0) {
      const skipped = readVarint(bytes, cursor);
      if (!skipped) return undefined;
      cursor = skipped.next;
      continue;
    }
    if (wireType === 1 || wireType === 5) {
      cursor += wireType === 1 ? 8 : 4;
      if (cursor > bytes.byteLength) return undefined;
      continue;
    }
    return undefined;
  }
  return fields;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.byteLength) {
    const byte = bytes[cursor];
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    if (shift > 49) return undefined;
  }
  return undefined;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
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
