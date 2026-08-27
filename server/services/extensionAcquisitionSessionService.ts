import { createHash, createPublicKey, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ExtensionEntity } from "../../src/shared/entities";
import {
  chromeWebStoreListingUrl,
  isCanonicalChromeExtensionId,
  type ExtensionAcquisitionConflictCandidate,
  type ExtensionAcquisitionErrorCode,
  type ExtensionAcquisitionSessionConfirmRequest,
  type ExtensionAcquisitionSessionCreateRequest,
  type ExtensionAcquisitionSessionView,
  type ExtensionArtifactProviderId,
  type ExtensionPreflightReport,
} from "../../src/shared/extensionAcquisition";
import { normalizeSettings, type AppSettings } from "../../src/shared/settings";
import type { PanelRepository } from "../storage/types";
import {
  ExtensionArchiveAnalysisError,
  EXTENSION_ARCHIVE_LIMITS,
  type ExtensionArchiveLimits,
} from "./boundedZipAnalyzer";
import {
  type Crx3VerificationFacts,
  Crx3VerificationError,
  verifyChromeWebStoreCrx3File,
} from "./crx3Verifier";
import {
  ExtensionAcquisitionError,
  type ExtensionCatalogObservation,
} from "./extensionAcquisitionService";
import type { ExtensionProviderRegistry } from "./extensionProviders/providerRegistry";
import {
  ExtensionPackagePreflightError,
  preflightExtensionPackage,
  type ExtensionPackagePreflightResult,
} from "./extensionPackagePreflight";
import { ExtensionProviderError } from "./providerHttpClient";

const DEFAULT_SESSION_TTL_MS = 15 * 60_000;
const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_PER_SESSION_TEMP_BYTES = EXTENSION_ARCHIVE_LIMITS.maxArchiveBytes
  + EXTENSION_ARCHIVE_LIMITS.maxTemporaryDiskBytes;
const DEFAULT_GLOBAL_TEMP_BYTES = DEFAULT_PER_SESSION_TEMP_BYTES * 2;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;

type SessionRepository = Pick<PanelRepository, "getExtension" | "listExtensions">;

export interface PreparedExtensionAcquisition {
  sessionId: string;
  purpose: ExtensionAcquisitionSessionCreateRequest["purpose"];
  targetExtensionId?: string;
  targetUpdatedAt?: string;
  storeId: string;
  selectedProviderId: ExtensionArtifactProviderId;
  artifactPath: string;
  stagedRoot: string;
  verification: Crx3VerificationFacts;
  package: ExtensionPackagePreflightResult;
  report: ExtensionPreflightReport;
  catalog?: ExtensionCatalogObservation;
  conflictCandidates: ExtensionAcquisitionConflictCandidate[];
  permissionApprovalToken?: string;
  addedPermissions: string[];
}

export interface ExtensionAcquisitionConfirmationResult {
  session: ExtensionAcquisitionSessionView;
  extension: ExtensionEntity;
}

export interface ExtensionAcquisitionSessionServiceOptions {
  acquisitionRoot: string;
  repository: SessionRepository;
  providerRegistry: Pick<ExtensionProviderRegistry, "artifact">;
  readSettings: () => Promise<AppSettings>;
  resolveCatalogObservation?: (observationId: string, storeId: string) => ExtensionCatalogObservation | undefined;
  commitPrepared: (
    acquisition: PreparedExtensionAcquisition,
    request: ExtensionAcquisitionSessionConfirmRequest,
  ) => Promise<ExtensionEntity>;
  recordUpdateObservation?: (
    targetExtensionId: string,
    providerId: ExtensionArtifactProviderId,
    observation: {
      status: "idle" | "available" | "provider-disabled" | "provider-unavailable" | "takedown";
      availableVersion?: string;
      errorCode?: string;
    },
    expectedUpdatedAt?: string,
  ) => Promise<ExtensionEntity>;
  now?: () => number;
  sessionTtlMs?: number;
  maxSessions?: number;
  perSessionTempBytes?: number;
  maxGlobalTempBytes?: number;
  archiveLimits?: Partial<ExtensionArchiveLimits>;
  verifyFile?: typeof verifyChromeWebStoreCrx3File;
  preflightPackage?: typeof preflightExtensionPackage;
}

type AcquisitionSession = {
  view: ExtensionAcquisitionSessionView;
  targetExtensionId?: string;
  targetVersion?: string;
  targetUpdatedAt?: string;
  permissionApprovalToken?: string;
  addedPermissions: string[];
  cancelRequested?: boolean;
  expiryRequested?: boolean;
  root: string;
  artifactPath: string;
  stagingDir: string;
  reservationBytes: number;
  reservationReleased: boolean;
  controller: AbortController;
  catalog?: ExtensionCatalogObservation;
  verification?: Crx3VerificationFacts;
  package?: ExtensionPackagePreflightResult;
  conflicts?: ExtensionAcquisitionConflictCandidate[];
  lockTail: Promise<void>;
  expiryTimer?: NodeJS.Timeout;
  cleanupPromise?: Promise<void>;
  cleanupRetryTimer?: NodeJS.Timeout;
};

/**
 * Owns disposable remote-acquisition work. Only in-memory session metadata is authoritative;
 * startup removes every prior derived directory before accepting a new request.
 */
export class ExtensionAcquisitionSessionService {
  private readonly acquisitionRoot: string;

  private readonly now: () => number;

  private readonly sessionTtlMs: number;

  private readonly maxSessions: number;

  private readonly perSessionTempBytes: number;

  private readonly maxGlobalTempBytes: number;

  private readonly verifyFile: typeof verifyChromeWebStoreCrx3File;

  private readonly preflightPackage: typeof preflightExtensionPackage;

  private readonly sessions = new Map<string, AcquisitionSession>();

  private reservedTempBytes = 0;

  /** Reservations made before asynchronous settings/target validation completes. */
  private pendingReservations = 0;

  private initialized = false;

  constructor(private readonly options: ExtensionAcquisitionSessionServiceOptions) {
    this.acquisitionRoot = path.resolve(options.acquisitionRoot);
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = positiveInteger(options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS, "session TTL");
    this.maxSessions = positiveInteger(options.maxSessions ?? DEFAULT_MAX_SESSIONS, "session count limit");
    this.perSessionTempBytes = positiveInteger(
      options.perSessionTempBytes ?? DEFAULT_PER_SESSION_TEMP_BYTES,
      "per-session temporary-byte limit",
    );
    this.maxGlobalTempBytes = positiveInteger(
      options.maxGlobalTempBytes ?? DEFAULT_GLOBAL_TEMP_BYTES,
      "global temporary-byte limit",
    );
    if (this.perSessionTempBytes > this.maxGlobalTempBytes) {
      throw new TypeError("Per-session acquisition budget cannot exceed the global budget.");
    }
    this.verifyFile = options.verifyFile ?? verifyChromeWebStoreCrx3File;
    this.preflightPackage = options.preflightPackage ?? preflightExtensionPackage;
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.acquisitionRoot, { recursive: true });
    const rootStats = await fs.lstat(this.acquisitionRoot);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
      throw new Error("Extension acquisition root must be an ordinary directory.");
    }
    const canonicalRoot = await fs.realpath(this.acquisitionRoot);
    if (canonicalRoot !== this.acquisitionRoot) {
      throw new Error("Extension acquisition root must not traverse a linked directory.");
    }
    for (const entry of await fs.readdir(this.acquisitionRoot, { withFileTypes: true })) {
      const candidate = path.join(this.acquisitionRoot, entry.name);
      const stats = await fs.lstat(candidate);
      if (stats.isDirectory() && !stats.isSymbolicLink()) {
        await fs.rm(candidate, { recursive: true, force: true });
      } else {
        await fs.rm(candidate, { force: true });
      }
    }
    this.initialized = true;
  }

  async create(request: ExtensionAcquisitionSessionCreateRequest): Promise<ExtensionAcquisitionSessionView> {
    this.assertInitialized();
    const normalized = normalizeCreateRequest(request);
    this.expireDueSessions();
    this.pruneTerminalSessions();
    if (this.activeSessionCount() + this.pendingReservations >= this.maxSessions) {
      throw new ExtensionAcquisitionError("ACQUISITION_TEMP_BUDGET_EXCEEDED", "Too many extension acquisitions are active.");
    }
    if (
      this.reservedTempBytes
      + (this.pendingReservations * this.perSessionTempBytes)
      + this.perSessionTempBytes
      > this.maxGlobalTempBytes
    ) {
      throw new ExtensionAcquisitionError("ACQUISITION_TEMP_BUDGET_EXCEEDED", "Extension acquisition temporary storage is busy.");
    }

    // Change the quota state before the first await. Without this reservation two concurrent
    // creates can both pass the checks and exceed the global temporary-disk budget.
    this.pendingReservations += 1;
    let reservationAdopted = false;
    let createdRoot: string | undefined;
    try {
      const settings = await this.readSettings();
      assertArtifactProviderEnabled(settings, normalized.artifactProviderId);
      const purposeTarget = await this.assertPurposeTarget(normalized);

      const sessionId = this.allocateSessionId();
      const root = path.join(this.acquisitionRoot, sessionId);
      const artifactPath = path.join(root, "artifact.crx");
      const stagingDir = path.join(root, "unpacked");
      await fs.mkdir(root, { recursive: false });
      createdRoot = root;
      const timestamp = new Date(this.now()).toISOString();
      const expiresAtMs = this.now() + this.sessionTtlMs;
      const catalog = normalized.catalogObservationId
        ? this.options.resolveCatalogObservation?.(normalized.catalogObservationId, normalized.storeId)
        : undefined;
      const session: AcquisitionSession = {
      view: {
        sessionId,
        purpose: normalized.purpose,
        namespace: "chrome-web-store",
        storeId: normalized.storeId,
        selectedProviderId: normalized.artifactProviderId,
        status: "created",
        createdAt: timestamp,
        updatedAt: timestamp,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
      targetExtensionId: normalized.targetExtensionId,
      targetVersion: purposeTarget?.version,
      targetUpdatedAt: purposeTarget?.updatedAt,
      root,
      artifactPath,
      stagingDir,
      reservationBytes: this.perSessionTempBytes,
      reservationReleased: false,
      controller: new AbortController(),
      catalog,
      addedPermissions: [],
      lockTail: Promise.resolve(),
      };
      this.sessions.set(sessionId, session);
      this.pendingReservations -= 1;
      reservationAdopted = true;
      this.reservedTempBytes += session.reservationBytes;
      session.expiryTimer = setTimeout(() => this.expireSession(sessionId), Math.max(1, expiresAtMs - this.now()));
      session.expiryTimer.unref?.();
      void this.runPipeline(session).catch(() => undefined);
      return cloneView(session.view);
    } catch (error) {
      if (!reservationAdopted) this.pendingReservations = Math.max(0, this.pendingReservations - 1);
      if (createdRoot && !reservationAdopted) await fs.rm(createdRoot, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  get(sessionId: string): ExtensionAcquisitionSessionView {
    this.assertInitialized();
    const session = this.requireSession(sessionId);
    this.expireIfDue(session);
    return cloneView(session.view);
  }

  list(): ExtensionAcquisitionSessionView[] {
    this.assertInitialized();
    this.expireDueSessions();
    return [...this.sessions.values()]
      .sort((left, right) => right.view.createdAt.localeCompare(left.view.createdAt))
      .map((session) => cloneView(session.view));
  }

  async cancel(sessionId: string): Promise<ExtensionAcquisitionSessionView> {
    const session = this.requireSession(sessionId);
    return this.withSessionLock(session, async () => {
      if (session.view.status === "committing") {
        throw new ExtensionAcquisitionError("ACQUISITION_SESSION_NOT_READY", "An extension acquisition commit is already in progress.");
      }
      if (session.view.status === "consumed") {
        throw new ExtensionAcquisitionError("ACQUISITION_SESSION_CONSUMED", "This extension acquisition was already consumed.");
      }
      session.cancelRequested = true;
      if (!session.controller.signal.aborted) {
        session.controller.abort(new ExtensionAcquisitionError("ACQUISITION_CANCELLED"));
      }
      if (!isTerminal(session.view.status)) {
        this.transition(session, "cancelled", {
          error: publicSessionError(new ExtensionAcquisitionError("ACQUISITION_CANCELLED")),
        });
        await this.cleanupDerivedSession(session);
      }
      return cloneView(session.view);
    });
  }

  async confirm(
    sessionId: string,
    request: ExtensionAcquisitionSessionConfirmRequest,
  ): Promise<ExtensionAcquisitionConfirmationResult> {
    const session = this.requireSession(sessionId);
    return this.withSessionLock(session, async () => {
      this.expireIfDue(session, true);
      if (session.cancelRequested || session.expiryRequested) {
        const reason = session.expiryRequested
          ? new ExtensionAcquisitionError("ACQUISITION_EXPIRED")
          : new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
        if (!isTerminal(session.view.status) && session.view.status !== "committing") {
          session.controller.abort(reason);
          this.transition(session, session.expiryRequested ? "expired" : "cancelled", {
            error: publicSessionError(reason),
            report: undefined,
          });
          await this.cleanupDerivedSession(session);
        }
        throw reason;
      }
      if (session.view.status === "consumed") {
        throw new ExtensionAcquisitionError("ACQUISITION_SESSION_CONSUMED", "This extension acquisition was already consumed.");
      }
      if (session.view.status !== "ready" || !session.verification || !session.package || !session.conflicts || !session.view.report) {
        throw new ExtensionAcquisitionError("ACQUISITION_SESSION_NOT_READY", "This extension acquisition is not ready to confirm.");
      }
      const normalizedRequest = normalizeConfirmRequest(request);
      if (
        session.view.purpose === "install"
        && normalizedRequest.disposition === "upgrade"
        && normalizedRequest.targetExtensionId
      ) {
        const target = await this.options.repository.getExtension(normalizedRequest.targetExtensionId);
        if (!target) throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The selected extension no longer exists.");
        session.targetUpdatedAt = target.updatedAt;
        session.addedPermissions = target.installState === "metadata-only"
          ? []
          : computeAddedPermissions(target, session.package);
        if (session.addedPermissions.length > 0) {
          session.permissionApprovalToken ??= randomBytes(24).toString("base64url");
          session.view.report = {
            ...session.view.report,
            permissionApproval: {
              token: session.permissionApprovalToken,
              added: [...session.addedPermissions],
            },
          };
        }
      }
      assertServerIssuedTarget(session, normalizedRequest);
      this.transition(session, "committing", { error: undefined });
      const prepared: PreparedExtensionAcquisition = {
        sessionId: session.view.sessionId,
        purpose: session.view.purpose,
        targetExtensionId: session.view.purpose === "update" ? session.targetExtensionId : undefined,
        targetUpdatedAt: session.targetUpdatedAt,
        storeId: session.view.storeId,
        selectedProviderId: session.view.selectedProviderId,
        artifactPath: session.artifactPath,
        stagedRoot: session.package.stagedRoot,
        verification: session.verification,
        package: session.package,
        report: session.view.report,
        catalog: session.catalog,
        conflictCandidates: session.conflicts.map((candidate) => ({ ...candidate })),
        permissionApprovalToken: session.permissionApprovalToken,
        addedPermissions: [...session.addedPermissions],
      };
      try {
        const extension = await this.options.commitPrepared(prepared, normalizedRequest);
        this.transition(session, "consumed", { error: undefined });
        await this.cleanupDerivedSession(session);
        return { session: cloneView(session.view), extension };
      } catch (error) {
        const failure = normalizeSessionFailure(error, "ACQUISITION_COMMIT_FAILED");
        if ((error as { reconciliationRequired?: unknown }).reconciliationRequired) {
          this.transition(session, "committing", { error: publicSessionError(failure) });
        } else {
          this.transition(session, "ready", { error: publicSessionError(failure) });
        }
        throw error;
      }
    });
  }

  settingsChanged(settingsInput: AppSettings): void {
    const settings = normalizeSettings(settingsInput);
    for (const session of this.sessions.values()) {
      if (
        (session.view.status === "created" || session.view.status === "downloading")
        && !artifactProviderEnabled(settings, session.view.selectedProviderId)
        && !session.controller.signal.aborted
      ) {
        session.controller.abort(new ExtensionAcquisitionError("ARTIFACT_PROVIDER_DISABLED"));
      }
    }
  }

  private async runPipeline(session: AcquisitionSession): Promise<void> {
    const startedAt = this.now();
    try {
      this.throwIfStopped(session);
      await this.transitionLocked(session, "downloading");
      assertArtifactProviderEnabled(await this.readSettings(), session.view.selectedProviderId);
      const provider = this.options.providerRegistry.artifact(session.view.selectedProviderId);
      const artifact = await provider.resolveCurrent({
        storeId: session.view.storeId,
        destinationPath: session.artifactPath,
      }, session.controller.signal);
      this.throwIfStopped(session);
      assertArtifactProviderEnabled(await this.readSettings(), session.view.selectedProviderId);
      if (
        artifact.namespace !== "chrome-web-store"
        || artifact.storeId !== session.view.storeId
        || artifact.artifactProviderId !== session.view.selectedProviderId
        || path.resolve(artifact.download.path) !== session.artifactPath
        || artifact.download.size > EXTENSION_ARCHIVE_LIMITS.maxArchiveBytes
      ) {
        throw new ExtensionProviderError("ARTIFACT_UNAVAILABLE", "Artifact provider returned inconsistent package facts.", 502);
      }
      session.view.downloadedBytes = artifact.download.size;
      await this.transitionLocked(session, "verifying");
      const verification = await this.verifyFile(session.artifactPath, session.view.storeId);
      if (
        verification.crxSha256 !== artifact.download.sha256
        || verification.crxSize !== artifact.download.size
      ) {
        throw new Crx3VerificationError("CRX_DEVELOPER_PROOF_INVALID", "Downloaded package facts changed before verification.");
      }
      session.verification = verification;
      this.throwIfStopped(session);
      await this.transitionLocked(session, "analyzing");
      const packageFacts = await this.preflightPackage({
        archivePath: session.artifactPath,
        archiveOffset: verification.zipOffset,
        archiveLength: verification.zipSize,
        stagingDir: session.stagingDir,
        catalog: session.catalog ? { name: session.catalog.name, version: session.catalog.version } : undefined,
        limits: this.options.archiveLimits,
        signal: session.controller.signal,
      });
      if (session.view.purpose === "update" && session.targetVersion) {
        const ordering = compareExtensionVersions(packageFacts.version, session.targetVersion);
        if (ordering < 0) {
          throw new ExtensionAcquisitionError("ARTIFACT_UNAVAILABLE", "The provider returned an older package than the installed extension.");
        }
      }
      session.package = packageFacts;
      this.throwIfStopped(session);
      const conflicts = await this.resolveConflicts(session.view.storeId, verification.developerSpkiSha256);
      session.conflicts = conflicts;
      const target = session.targetExtensionId
        ? await this.options.repository.getExtension(session.targetExtensionId)
        : undefined;
      const addedPermissions = target && target.installState !== "metadata-only"
        ? computeAddedPermissions(target, packageFacts)
        : [];
      session.addedPermissions = addedPermissions;
      if (addedPermissions.length > 0) session.permissionApprovalToken ??= randomBytes(24).toString("base64url");
      if (session.view.purpose === "update" && session.targetExtensionId) {
        const currentTarget = await this.options.repository.getExtension(session.targetExtensionId);
        if (!currentTarget || (session.targetUpdatedAt && currentTarget.updatedAt !== session.targetUpdatedAt)) {
          throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The extension changed while the update was being prepared.");
        }
        const observed = await this.options.recordUpdateObservation?.(
          session.targetExtensionId,
          session.view.selectedProviderId,
          packageFacts.version === session.targetVersion
            ? { status: "idle" }
            : { status: "available", availableVersion: packageFacts.version },
          session.targetUpdatedAt,
        );
        // Recording the provider observation is itself a server-owned row
        // write, so it may advance `updatedAt`. Use the exact revision returned
        // by that write, then prove the row is still at that revision before
        // making the session ready. Blindly adopting a later read would absorb
        // a concurrent edit made between the observation and this check.
        const expectedObservedUpdatedAt = observed?.updatedAt ?? session.targetUpdatedAt;
        const observedTarget = await this.options.repository.getExtension(session.targetExtensionId);
        if (
          !observedTarget
          || (expectedObservedUpdatedAt && observedTarget.updatedAt !== expectedObservedUpdatedAt)
        ) {
          throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "The update target changed while its provider observation was recorded.");
        }
        session.targetUpdatedAt = observedTarget.updatedAt;
      }
      const report = buildReport({
        session,
        artifact: artifact.download,
        verification,
        packageFacts,
        conflicts,
        durationMs: Math.max(0, this.now() - startedAt),
        permissionApprovalToken: session.permissionApprovalToken,
        addedPermissions,
      });
      await this.withSessionLock(session, async () => {
        if (isTerminal(session.view.status) || session.view.status === "committing") return;
        session.view.report = report;
        this.transition(session, "ready", { error: undefined });
      });
    } catch (error) {
      const failure = normalizeSessionFailure(error);
      const status = failure.code === "ACQUISITION_CANCELLED" || failure.code === "ARTIFACT_PROVIDER_DISABLED"
        ? "cancelled"
        : failure.code === "ACQUISITION_EXPIRED"
          ? "expired"
          : "rejected";
      let shouldCleanup = false;
      await this.withSessionLock(session, async () => {
        if (session.view.status !== "consumed" && session.view.status !== "committing" && !isTerminal(session.view.status)) {
          this.transition(session, status, { error: publicSessionError(failure), report: undefined });
          shouldCleanup = true;
        }
      });
      if (shouldCleanup || isTerminal(session.view.status)) await this.cleanupDerivedSession(session);
      if (session.view.purpose === "update" && session.targetExtensionId && failure.code !== "ACQUISITION_CANCELLED") {
        const status = failure.code === "ARTIFACT_PROVIDER_DISABLED"
          ? "provider-disabled" as const
          : "provider-unavailable" as const;
        await this.options.recordUpdateObservation?.(
          session.targetExtensionId,
          session.view.selectedProviderId,
          { status, errorCode: failure.code },
          session.targetUpdatedAt,
        ).catch(() => undefined);
      }
      throw failure;
    }
  }

  private async resolveConflicts(
    storeId: string,
    developerKeySha256: string,
  ): Promise<ExtensionAcquisitionConflictCandidate[]> {
    const extensions = await this.options.repository.listExtensions();
    const candidates: ExtensionAcquisitionConflictCandidate[] = [];
    const knownDifferentDeveloper = extensions.some((extension) => (
      extension.storeIdentity?.namespace === "chrome-web-store"
      && extension.storeIdentity.storeId === storeId
      && Boolean(persistedDeveloperFingerprint(extension))
      && persistedDeveloperFingerprint(extension) !== developerKeySha256
    ));
    for (const extension of extensions) {
      const persistedDeveloperSha = extension.provenance?.verification.developerKeySha256
        ?? fingerprintManifestKey(extension.manifestKey);
      const storeIdentityMatches = extension.storeIdentity?.namespace === "chrome-web-store"
        && extension.storeIdentity.storeId === storeId;
      const storeIdentityConflicts = Boolean(
        persistedDeveloperSha === developerKeySha256
        && (
          extension.storeIdentity?.namespace === "chrome-web-store"
            ? extension.storeIdentity.storeId !== storeId
            : extension.storeId !== undefined && extension.storeId !== storeId
        ),
      );
      const developerMatches = persistedDeveloperSha === developerKeySha256;
      const legacyMetadataMatchesId = !extension.storeIdentity && extension.storeId === storeId;
      if (!storeIdentityMatches && !developerMatches && !legacyMetadataMatchesId) continue;
      const matchBy = storeIdentityMatches
        ? "store-identity" as const
        : developerMatches
          ? "developer-identity" as const
          : "metadata-store-id" as const;
      // A duplicate metadata row has no package/developer authority to merge
      // automatically, but the verified acquisition report names every exact
      // server row. Mark each matching metadata-only row eligible so the user
      // can explicitly choose the one record to upgrade in place. The selected
      // target is rechecked again under the store/developer mutation keys at
      // commit; no rows are silently merged or deleted.
      const metadataOnlyUpgrade = (storeIdentityMatches || legacyMetadataMatchesId)
        && extension.installState === "metadata-only"
        && !persistedDeveloperSha
        && !knownDifferentDeveloper;
      const eligible = !storeIdentityConflicts
        && (metadataOnlyUpgrade || (developerMatches && extension.installState !== "metadata-only"));
      const blockingReason = eligible
        ? undefined
        : storeIdentityConflicts
          ? "developer-identity-mismatch" as const
        : persistedDeveloperSha
          ? "developer-identity-mismatch" as const
          : "installed-identity-missing" as const;
      candidates.push({
        extensionId: extension.id,
        name: extension.name,
        version: extension.version,
        installState: extension.installState,
        matchBy,
        eligible,
        ...(blockingReason ? { blockingReason } : {}),
      });
    }
    return candidates.sort((left, right) => (
      Number(right.eligible) - Number(left.eligible)
      || left.name.localeCompare(right.name)
      || left.extensionId.localeCompare(right.extensionId)
    ));
  }

  private async assertPurposeTarget(request: ExtensionAcquisitionSessionCreateRequest): Promise<ExtensionEntity | undefined> {
    if (request.purpose === "install") {
      if (request.targetExtensionId !== undefined) {
        throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Install acquisition cannot name a target extension.");
      }
      return undefined;
    }
    const targetId = normalizeOptionalId(request.targetExtensionId);
    if (!targetId) throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "Update acquisition requires a target extension.");
    const target = await this.options.repository.getExtension(targetId);
    if (
      !target
      || target.storeIdentity?.storeId !== request.storeId
      || target.provenance?.verification.level !== "cws-publisher-verified"
      || target.updateProviderId !== request.artifactProviderId
    ) {
      throw new ExtensionAcquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID", "The target is not eligible for this exact update provider.");
    }
    return target;
  }

  private async readSettings(): Promise<AppSettings> {
    return normalizeSettings(await this.options.readSettings());
  }

  private transition(
    session: AcquisitionSession,
    status: ExtensionAcquisitionSessionView["status"],
    patch: Pick<ExtensionAcquisitionSessionView, "error" | "report"> | Record<string, never> = {},
  ): void {
    session.view = {
      ...session.view,
      ...patch,
      status,
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  private throwIfStopped(session: AcquisitionSession): void {
    if (session.controller.signal.aborted) {
      const reason = session.controller.signal.reason;
      if (reason instanceof ExtensionAcquisitionError) throw reason;
      throw new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
    }
    this.expireIfDue(session);
    if (session.view.status === "expired") throw new ExtensionAcquisitionError("ACQUISITION_EXPIRED");
  }

  private expireIfDue(session: AcquisitionSession, locked = false): boolean {
    const expiresAt = session.view.expiresAt ? Date.parse(session.view.expiresAt) : Number.POSITIVE_INFINITY;
    if (expiresAt > this.now() || isTerminal(session.view.status) || session.view.status === "committing") return false;
    session.expiryRequested = true;
    if (!session.controller.signal.aborted) {
      session.controller.abort(new ExtensionAcquisitionError("ACQUISITION_EXPIRED"));
    }
    if (locked) {
      this.transition(session, "expired", {
        error: publicSessionError(new ExtensionAcquisitionError("ACQUISITION_EXPIRED")),
        report: undefined,
      });
    } else {
      this.transition(session, "expired", {
        error: publicSessionError(new ExtensionAcquisitionError("ACQUISITION_EXPIRED")),
        report: undefined,
      });
      void this.cleanupDerivedSession(session);
    }
    return true;
  }

  private expireDueSessions(): void {
    for (const session of this.sessions.values()) this.expireIfDue(session);
  }

  private expireSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || isTerminal(session.view.status) || session.view.status === "committing") return;
    session.expiryRequested = true;
    session.controller.abort(new ExtensionAcquisitionError("ACQUISITION_EXPIRED"));
    void this.withSessionLock(session, async () => {
      if (isTerminal(session.view.status) || session.view.status === "committing") return;
      this.transition(session, "expired", {
        error: publicSessionError(new ExtensionAcquisitionError("ACQUISITION_EXPIRED")),
        report: undefined,
      });
      await this.cleanupDerivedSession(session);
    });
  }

  private async cleanupDerivedSession(session: AcquisitionSession): Promise<void> {
    if (session.cleanupPromise) return session.cleanupPromise;
    session.cleanupPromise = this.cleanupDerivedSessionAttempt(session).finally(() => {
      session.cleanupPromise = undefined;
    });
    return session.cleanupPromise;
  }

  private async cleanupDerivedSessionAttempt(session: AcquisitionSession): Promise<void> {
    if (session.expiryTimer) {
      clearTimeout(session.expiryTimer);
      session.expiryTimer = undefined;
    }
    let removed = false;
    try {
      await fs.rm(session.root, { recursive: true, force: true });
      removed = true;
    } catch {
      // Keep the reservation while derived bytes may still exist. A retry is a bounded
      // asynchronous cleanup attempt; releasing the quota here would allow unaccounted
      // session trees to accumulate after Windows handle races.
      if (!session.cleanupRetryTimer) {
        session.cleanupRetryTimer = setTimeout(() => {
          session.cleanupRetryTimer = undefined;
          void this.cleanupDerivedSession(session);
        }, 1_000);
        session.cleanupRetryTimer.unref?.();
      }
    }
    if (!removed) return;
    if (!session.reservationReleased) {
      session.reservationReleased = true;
      this.reservedTempBytes = Math.max(0, this.reservedTempBytes - session.reservationBytes);
    }
    if (isTerminal(session.view.status) && this.sessions.get(session.view.sessionId) === session) {
      session.expiryTimer = setTimeout(() => {
        if (this.sessions.get(session.view.sessionId) === session && isTerminal(session.view.status)) {
          this.sessions.delete(session.view.sessionId);
        }
      }, this.sessionTtlMs);
      session.expiryTimer.unref?.();
    }
  }

  private async transitionLocked(
    session: AcquisitionSession,
    status: ExtensionAcquisitionSessionView["status"],
    patch: Pick<ExtensionAcquisitionSessionView, "error" | "report"> | Record<string, never> = {},
  ): Promise<void> {
    await this.withSessionLock(session, async () => {
      if (isTerminal(session.view.status) || session.view.status === "committing") return;
      this.transition(session, status, patch);
    });
  }

  private pruneTerminalSessions(): void {
    const maximumRetained = this.maxSessions * 4;
    if (this.sessions.size < maximumRetained) return;
    for (const [id, session] of this.sessions) {
      if (!isTerminal(session.view.status) || !session.reservationReleased) continue;
      if (session.expiryTimer) clearTimeout(session.expiryTimer);
      this.sessions.delete(id);
      if (this.sessions.size < maximumRetained) break;
    }
  }

  private async withSessionLock<T>(session: AcquisitionSession, operation: () => Promise<T>): Promise<T> {
    const previous = session.lockTail;
    let release: (() => void) | undefined;
    session.lockTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release?.();
    }
  }

  private activeSessionCount(): number {
    return [...this.sessions.values()].filter((session) => !isTerminal(session.view.status)).length;
  }

  private allocateSessionId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = randomBytes(24).toString("base64url");
      if (!this.sessions.has(id)) return id;
    }
    throw new Error("Could not allocate an extension acquisition session id.");
  }

  private requireSession(sessionId: string): AcquisitionSession {
    if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) {
      throw new ExtensionAcquisitionError("ACQUISITION_SESSION_NOT_FOUND");
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new ExtensionAcquisitionError("ACQUISITION_SESSION_NOT_FOUND");
    return session;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("Extension acquisition sessions have not been initialized.");
  }
}

function normalizeCreateRequest(input: ExtensionAcquisitionSessionCreateRequest): ExtensionAcquisitionSessionCreateRequest {
  if (!input || typeof input !== "object") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Acquisition request must be an object.");
  }
  assertAllowedKeys(input as unknown as Record<string, unknown>, [
    "namespace",
    "storeId",
    "artifactProviderId",
    "purpose",
    "targetExtensionId",
    "catalogObservationId",
  ]);
  if (input.namespace !== "chrome-web-store" || !isCanonicalChromeExtensionId(input.storeId)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Acquisition requires a canonical Chrome Web Store id.");
  }
  if (input.artifactProviderId !== "chrome-web-store" && input.artifactProviderId !== "crxsoso") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Acquisition artifact provider is unsupported.");
  }
  if (input.purpose !== "install" && input.purpose !== "update") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Acquisition purpose is unsupported.");
  }
  const targetExtensionId = normalizeOptionalId(input.targetExtensionId);
  const catalogObservationId = normalizeOptionalOpaqueId(input.catalogObservationId);
  return {
    namespace: "chrome-web-store",
    storeId: input.storeId,
    artifactProviderId: input.artifactProviderId,
    purpose: input.purpose,
    ...(targetExtensionId ? { targetExtensionId } : {}),
    ...(catalogObservationId ? { catalogObservationId } : {}),
  };
}

function normalizeConfirmRequest(input: ExtensionAcquisitionSessionConfirmRequest): ExtensionAcquisitionSessionConfirmRequest {
  if (!input || typeof input !== "object") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Confirmation request must be an object.");
  }
  assertAllowedKeys(input as unknown as Record<string, unknown>, ["disposition", "targetExtensionId", "environmentIds", "permissionApprovalToken"]);
  if (input.disposition !== "create" && input.disposition !== "upgrade" && input.disposition !== "reuse") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Confirmation disposition is unsupported.");
  }
  const targetExtensionId = normalizeOptionalId(input.targetExtensionId);
  const environmentIds = input.environmentIds === undefined
    ? undefined
    : uniqueIds(input.environmentIds, "Environment ids");
  const permissionApprovalToken = input.permissionApprovalToken === undefined
    ? undefined
    : normalizeOptionalOpaqueId(input.permissionApprovalToken);
  return {
    disposition: input.disposition,
    ...(targetExtensionId ? { targetExtensionId } : {}),
    ...(environmentIds ? { environmentIds } : {}),
    ...(permissionApprovalToken ? { permissionApprovalToken } : {}),
  };
}

function assertServerIssuedTarget(
  session: AcquisitionSession,
  request: ExtensionAcquisitionSessionConfirmRequest,
): void {
  const conflicts = session.conflicts ?? [];
  const mismatch = conflicts.some((candidate) => (
    candidate.matchBy === "store-identity"
    && candidate.blockingReason === "developer-identity-mismatch"
  ));
  if (mismatch) {
    throw new ExtensionAcquisitionError("ACQUISITION_IDENTITY_CONFLICT", "The store id is already associated with a different developer identity.");
  }
  if (session.addedPermissions.length > 0) {
    if (!session.permissionApprovalToken || request.permissionApprovalToken !== session.permissionApprovalToken) {
      throw new ExtensionAcquisitionError("ACQUISITION_PERMISSION_INCREASE", "Explicit approval is required for the added permissions shown in the preflight report.");
    }
  } else if (request.permissionApprovalToken !== undefined) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "No permission approval is pending for this acquisition.");
  }
  if (request.disposition === "create") {
    if (request.targetExtensionId) {
      throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "Create disposition cannot name an existing target.");
    }
    if (session.view.purpose === "update") {
      throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "An update acquisition cannot create a separate extension.");
    }
    return;
  }
  const targetId = request.targetExtensionId;
  if (session.view.purpose === "update" && targetId !== session.targetExtensionId) {
    throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "Update confirmation must retain its original target extension.");
  }
  const candidate = conflicts.find((item) => item.extensionId === targetId);
  if (!targetId || !candidate?.eligible) {
    throw new ExtensionAcquisitionError("ACQUISITION_CONFLICT_TARGET_INVALID", "Confirmation target was not issued as an eligible conflict candidate.");
  }
}

function buildReport(input: {
  session: AcquisitionSession;
  artifact: { size: number; sha256: string; finalHost: string; fetchedAt: string };
  verification: Crx3VerificationFacts;
  packageFacts: ExtensionPackagePreflightResult;
  conflicts: ExtensionAcquisitionConflictCandidate[];
  durationMs: number;
  permissionApprovalToken?: string;
  addedPermissions: string[];
}): ExtensionPreflightReport {
  const optionalFacts = input.packageFacts as ExtensionPackagePreflightResult & {
    optionalPermissions?: string[];
    optionalHostPermissions?: string[];
  };
  return {
    sessionId: input.session.view.sessionId,
    expiresAt: input.session.view.expiresAt as string,
    identity: {
      namespace: "chrome-web-store",
      requestedStoreId: input.session.view.storeId,
      proofDerivedStoreId: input.verification.developerDerivedId,
      matches: true,
    },
    package: {
      name: input.packageFacts.name,
      description: input.packageFacts.description,
      version: input.packageFacts.version,
      manifestVersion: input.packageFacts.manifestVersion,
      format: "crx3",
      size: input.artifact.size,
      sha256: input.artifact.sha256,
      manifestSha256: input.packageFacts.manifestSha256,
      treeSha256: input.packageFacts.treeSha256,
      entryCount: input.packageFacts.entryCount,
      filesystemNodeCount: input.packageFacts.filesystemNodeCount,
      fileCount: input.packageFacts.fileCount,
      expandedBytes: input.packageFacts.expandedBytes,
      ...(input.packageFacts.icon ? { icon: { ...input.packageFacts.icon } } : {}),
    },
    transport: {
      selectedProviderId: input.session.view.selectedProviderId,
      finalByteHost: input.artifact.finalHost,
      fetchedAt: input.artifact.fetchedAt,
      durationMs: input.durationMs,
    },
    verification: {
      level: "cws-publisher-verified",
      developerKeySha256: input.verification.developerSpkiSha256,
      publisherTrustRootId: input.verification.publisherTrustRootId,
      publisherTrustRootVersion: input.verification.publisherTrustRootVersion,
      developerProofAlgorithm: input.verification.developerProofAlgorithm,
      publisherProofAlgorithm: input.verification.publisherProofAlgorithm,
    },
    permissions: [...input.packageFacts.permissions],
    hostPermissions: [...input.packageFacts.hostPermissions],
    optionalPermissions: [...(optionalFacts.optionalPermissions ?? [])],
    optionalHostPermissions: [...(optionalFacts.optionalHostPermissions ?? [])],
    permissionRisks: input.packageFacts.permissionRisks.map((risk) => ({ ...risk })),
    discrepancies: input.packageFacts.discrepancies.map((item) => ({ ...item })),
    ...(input.addedPermissions.length > 0 && input.permissionApprovalToken ? {
      permissionApproval: {
        token: input.permissionApprovalToken,
        added: [...input.addedPermissions],
      },
    } : {}),
    ...(input.session.catalog ? {
      catalog: {
        providerId: input.session.catalog.providerId,
        observedAt: input.session.catalog.observedAt,
      },
    } : {}),
    conflicts: input.conflicts.map((candidate) => ({ ...candidate })),
  };
}

function computeAddedPermissions(
  target: ExtensionEntity,
  packageFacts: ExtensionPackagePreflightResult,
): string[] {
  const before = new Set([
    ...target.permissions,
    ...target.hostPermissions,
    ...(target.optionalPermissions ?? []),
    ...(target.optionalHostPermissions ?? []),
  ]);
  return [...new Set([
    ...packageFacts.permissions,
    ...packageFacts.hostPermissions,
    ...packageFacts.optionalPermissions,
    ...packageFacts.optionalHostPermissions,
  ].filter((permission) => !before.has(permission)))].sort();
}

function compareExtensionVersions(left: string, right: string): number {
  const parse = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const av = Number.isFinite(a[index]) ? a[index] : 0;
    const bv = Number.isFinite(b[index]) ? b[index] : 0;
    if (av !== bv) return av - bv;
  }
  return 0;
}

function artifactProviderEnabled(settings: AppSettings, providerId: ExtensionArtifactProviderId): boolean {
  return providerId === "chrome-web-store"
    ? settings.extensionAcquisition.googleArtifactEnabled
    : settings.extensionAcquisition.crxsosoArtifactEnabled;
}

function assertArtifactProviderEnabled(settings: AppSettings, providerId: ExtensionArtifactProviderId): void {
  if (!artifactProviderEnabled(settings, providerId)) {
    throw new ExtensionAcquisitionError("ARTIFACT_PROVIDER_DISABLED");
  }
}

function normalizeSessionFailure(
  error: unknown,
  fallbackCode: ExtensionAcquisitionErrorCode = "ACQUISITION_COMMIT_FAILED",
): ExtensionAcquisitionError {
  if (error instanceof ExtensionAcquisitionError) return error;
  if ((error as { code?: unknown }).code === "ACQUISITION_CANCELLED" || (error instanceof Error && error.name === "AbortError")) {
    return new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
  }
  if ((error as { code?: unknown }).code === "ACQUISITION_RECONCILIATION_REQUIRED") {
    return new ExtensionAcquisitionError("ACQUISITION_RECONCILIATION_REQUIRED", "The extension commit is awaiting durable startup reconciliation.");
  }
  if (error instanceof ExtensionArchiveAnalysisError) {
    const code: ExtensionAcquisitionErrorCode = error.code === "EXTENSION_ARCHIVE_LIMIT_EXCEEDED"
      ? "EXTENSION_ARCHIVE_RESOURCE_LIMIT"
      : error.code === "EXTENSION_ARCHIVE_PATH_UNSAFE"
        || error.code === "EXTENSION_ARCHIVE_PATH_COLLISION"
        || error.code === "EXTENSION_ARCHIVE_LINK_FORBIDDEN"
        ? "EXTENSION_ARCHIVE_UNSAFE_PATH"
        : "EXTENSION_ARCHIVE_INVALID";
    return new ExtensionAcquisitionError(code, error.message);
  }
  if (
    error instanceof ExtensionProviderError
    || error instanceof Crx3VerificationError
    || error instanceof ExtensionPackagePreflightError
  ) {
    return new ExtensionAcquisitionError(error.code, error.message);
  }
  return new ExtensionAcquisitionError(fallbackCode);
}

function publicSessionError(error: ExtensionAcquisitionError): { code: ExtensionAcquisitionErrorCode; message: string } {
  return { code: error.code, message: error.message };
}

function fingerprintManifestKey(manifestKey: string | undefined): string | undefined {
  if (!manifestKey) return undefined;
  try {
    const key = createPublicKey({ key: Buffer.from(manifestKey, "base64"), format: "der", type: "spki" });
    const canonical = key.export({ format: "der", type: "spki" });
    return createHash("sha256").update(canonical).digest("hex");
  } catch {
    return undefined;
  }
}

function persistedDeveloperFingerprint(extension: ExtensionEntity): string | undefined {
  return extension.provenance?.verification.developerKeySha256
    ?? fingerprintManifestKey(extension.manifestKey);
}

function cloneView(view: ExtensionAcquisitionSessionView): ExtensionAcquisitionSessionView {
  return structuredClone(view);
}

function normalizeOptionalId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Extension target id is invalid.");
  }
  return value.trim();
}

function normalizeOptionalOpaqueId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !SESSION_ID_PATTERN.test(value)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Catalog observation id is invalid.");
  }
  return value;
}

function uniqueIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", `${label} must be a bounded array.`);
  }
  const ids = [...new Set(value.map(normalizeOptionalId))];
  if (ids.some((id) => !id)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", `${label} contain an invalid id.`);
  }
  return ids as string[];
}

function isTerminal(status: ExtensionAcquisitionSessionView["status"]): boolean {
  return status === "consumed" || status === "rejected" || status === "cancelled" || status === "expired";
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive integer.`);
  return value;
}

function assertAllowedKeys(input: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Acquisition request contains unsupported fields.");
  }
}

export function canonicalAcquisitionStoreUrl(storeId: string): string {
  return chromeWebStoreListingUrl(storeId);
}
