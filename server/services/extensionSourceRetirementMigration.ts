import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionEntity,
  ExtensionInstallState,
  ExtensionSourceKind,
} from "../../src/shared/entities";
import {
  CHROME_EXTENSION_ID_PATTERN,
  chromeWebStoreListingUrl,
  normalizeExtensionAuthorityFields,
  type LegacyTransferExtension,
  type ExtensionProvenanceV1,
} from "../../src/shared/extensionAcquisition";

export const EXTENSION_SOURCE_RETIREMENT_MIGRATION_VERSION = 1;
export const EXTENSION_SOURCE_RETIREMENT_MARKER_KEY = "extension_source_retirement_migration";
export const EXTENSION_SOURCE_RETIREMENT_SNAPSHOT_MARKER_KEY = "extension_source_retirement_snapshot";

const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;
const MAX_METADATA_BYTES = 4 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 512 * 1024 * 1024;
const MAX_REPORTED_ISSUES = 5_000;
const MAX_LEGACY_SOURCE_URL_BYTES = 8 * 1024;
const LEGACY_SOURCE_KINDS = new Set<ExtensionSourceKind>(["remote-zip", "remote-crx", "chrome-web-store"]);
const INSTALLED_STATES = new Set<ExtensionInstallState>(["installed", "update-available"]);
const NOT_YET_INSTALLED_STATES = new Set<ExtensionInstallState>([
  "metadata-only",
  "download-pending",
  "downloading",
  "install-failed",
  "invalid-manifest",
]);

export type ExtensionSourceRetirementCategory =
  | "managed-snapshot"
  | "local-missing"
  | "pending-disabled"
  | "metadata-only"
  | "invalid-id";

export type ExtensionSourceRetirementIssueCode =
  | "LEGACY_SOURCE_MIGRATED"
  | "LEGACY_SOURCE_LOCAL_MISSING"
  | "LEGACY_SOURCE_NOT_INSTALLED"
  | "LEGACY_SOURCE_INVALID_ID"
  | "LEGACY_SOURCE_DUPLICATE_STORE_ID"
  | "LEGACY_SOURCE_UNREADABLE_PATH"
  | "LEGACY_SOURCE_UNSUPPORTED_STATE";

export interface ExtensionSourceRetirementIssue {
  extensionId: string;
  code: ExtensionSourceRetirementIssueCode;
  detail?: string;
  storeId?: string;
}

export interface ExtensionSourceRetirementCounts {
  scanned: number;
  migrated: number;
  managedSnapshots: number;
  localMissing: number;
  pendingDisabled: number;
  metadataOnly: number;
  invalidId: number;
  duplicates: number;
  unchanged: number;
  issuesOmitted: number;
}

export interface ExtensionSourceRetirementReport {
  schemaVersion: 1;
  migrationVersion: 1;
  markerKey: typeof EXTENSION_SOURCE_RETIREMENT_MARKER_KEY;
  startedAt: string;
  completedAt: string;
  status: "completed" | "noop";
  counts: ExtensionSourceRetirementCounts;
  issues: ExtensionSourceRetirementIssue[];
  snapshot?: SqliteSnapshotReport;
}

export interface ExtensionSourceRetirementMarker {
  schemaVersion: 1;
  migrationVersion: 1;
  completedAt: string;
  report: ExtensionSourceRetirementReport;
}

export interface LegacyExtensionProbe {
  /** A filesystem-only probe supplied by the caller; it must never fetch sourceUrl. */
  localPackageReadable?: boolean;
  localPathExists?: boolean;
  localPackageError?: string;
}

export interface LegacyExtensionClassification {
  extensionId: string;
  category: ExtensionSourceRetirementCategory;
  isLegacySourceBacked: boolean;
  canonicalStoreId?: string;
  duplicateStoreId: boolean;
  patch: Partial<ExtensionEntity>;
  issues: ExtensionSourceRetirementIssue[];
}

export interface ClassifyLegacyExtensionInput {
  extension: ExtensionEntity;
  probe?: LegacyExtensionProbe;
  duplicateStoreIds?: ReadonlySet<string>;
}

export interface LegacySourceRetirementStore {
  listExtensions(): Promise<ExtensionEntity[]>;
  /** Must execute the callback in one SQLite transaction and roll it back on throw. */
  transaction<T>(operation: () => Promise<T>): Promise<T>;
  updateExtensionExact(extensionId: string, patch: Partial<ExtensionEntity>): Promise<void>;
  readMetadata(key: string): Promise<string | undefined>;
  writeMetadata(key: string, value: string): Promise<void>;
}

export interface ExtensionSourceRetirementMigrationOptions {
  store: LegacySourceRetirementStore;
  now?: () => Date;
  probeLocalPackage?: (extension: ExtensionEntity) => Promise<LegacyExtensionProbe>;
  snapshot?: SqliteSnapshotReport;
}

export interface RunExtensionSourceRetirementOptions extends ExtensionSourceRetirementMigrationOptions {
  databasePath: string;
  snapshotPath: string;
}

export interface SqliteExtensionSourceRetirementOptions {
  database: DatabaseSync;
  now?: () => Date;
  probeLocalPackage?: (extension: ExtensionEntity) => Promise<LegacyExtensionProbe>;
  snapshot?: SqliteSnapshotReport;
}

export interface SqliteSnapshotOptions {
  databasePath: string;
  snapshotPath: string;
  now?: () => Date;
  validate?: (database: DatabaseSync) => void;
}

export interface SqliteSnapshotReport {
  schemaVersion: 1;
  sourcePath: string;
  snapshotPath: string;
  createdAt: string;
  sizeBytes: number;
  sha256: string;
  integrityCheck: "ok";
  foreignKeyViolations: number;
  tables: Record<string, number>;
}

export class ExtensionSourceRetirementMigrationError extends Error {
  readonly status = 409;

  constructor(
    readonly code:
      | "EXTENSION_SOURCE_MIGRATION_MARKER_INVALID"
      | "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED"
      | "EXTENSION_SOURCE_SNAPSHOT_INVALID"
      | "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ExtensionSourceRetirementMigrationError";
  }
}

/**
 * Creates a consistent SQLite snapshot through sqlite3_serialize rather than
 * copying the main database file. `serialize()` includes the connection's
 * current WAL-visible state, so committed rows are present even before a
 * checkpoint. The resulting file is atomically published and independently
 * reopened/validated.
 */
export async function createWalAwareSqliteSnapshot(
  options: SqliteSnapshotOptions,
): Promise<SqliteSnapshotReport> {
  const sourcePath = validateDatabasePath(options.databasePath, "source");
  const snapshotPath = validateDatabasePath(options.snapshotPath, "snapshot");
  if (sourcePath === snapshotPath) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
      "SQLite snapshot path must differ from the live database path.",
    );
  }
  const now = options.now ?? (() => new Date());
  let source: DatabaseSync | undefined;
  let snapshot: DatabaseSync | undefined;
  const tempPath = `${snapshotPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const sourceStat = await fs.lstat(sourcePath).catch(() => undefined);
    const walStat = await fs.lstat(`${sourcePath}-wal`).catch(() => undefined);
    const shmStat = await fs.lstat(`${sourcePath}-shm`).catch(() => undefined);
    const journalStat = await fs.lstat(`${sourcePath}-journal`).catch(() => undefined);
    const sourceBytes = (sourceStat?.size ?? 0)
      + (walStat?.size ?? 0)
      + (shmStat?.size ?? 0)
      + (journalStat?.size ?? 0);
    if (
      !sourceStat?.isFile()
      || sourceStat.isSymbolicLink()
      || (walStat && (!walStat.isFile() || walStat.isSymbolicLink()))
      || (shmStat && (!shmStat.isFile() || shmStat.isSymbolicLink()))
      || (journalStat && (!journalStat.isFile() || journalStat.isSymbolicLink()))
      || sourceBytes > MAX_SNAPSHOT_BYTES
    ) {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_INVALID",
        "The live SQLite database is missing, not a regular file, or exceeds the snapshot limit.",
      );
    }
    const existingSnapshot = await fs.lstat(snapshotPath).catch(() => undefined);
    if (existingSnapshot) {
      if (!existingSnapshot.isFile() || existingSnapshot.isSymbolicLink()) {
        throw new ExtensionSourceRetirementMigrationError(
          "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
          "SQLite snapshot target already exists but is not an ordinary file.",
        );
      }
      // A failed migration may leave its already-validated rollback image in
      // place. Reuse that image rather than replacing the only recovery point.
      return await inspectExistingSnapshot(snapshotPath, sourcePath, now, options.validate);
    }
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    const serialized = Buffer.from(source.serialize("main"));
    if (serialized.byteLength < SQLITE_HEADER.byteLength || !serialized.subarray(0, SQLITE_HEADER.byteLength).equals(SQLITE_HEADER)) {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_INVALID",
        "SQLite serialize() did not return a valid database image.",
      );
    }
    if (serialized.byteLength > MAX_SNAPSHOT_BYTES) {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_INVALID",
        "SQLite snapshot exceeds the bounded migration snapshot size.",
      );
    }
    await ensureRealDirectoryChain(path.dirname(snapshotPath));
    await writeFileDurably(tempPath, serialized);
    snapshot = new DatabaseSync(tempPath, { readOnly: true, timeout: 5_000 });
    snapshot.exec("PRAGMA busy_timeout = 5000");
    const integrity = snapshot.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_INVALID",
        "SQLite snapshot integrity_check did not pass.",
      );
    }
    const foreignKeys = snapshot.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_INVALID",
        "SQLite snapshot contains foreign-key violations.",
      );
    }
    options.validate?.(snapshot);
    const tables = readTableCounts(snapshot);
    const report: SqliteSnapshotReport = {
      schemaVersion: 1,
      sourcePath,
      snapshotPath,
      createdAt: now().toISOString(),
      sizeBytes: serialized.byteLength,
      sha256: createHash("sha256").update(serialized).digest("hex"),
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      tables,
    };
    snapshot.close();
    snapshot = undefined;
    await removeSqliteSidecars(tempPath);
    source.close();
    source = undefined;
    await fs.rename(tempPath, snapshotPath);
    await fsyncDirectory(path.dirname(snapshotPath));
    return Object.freeze(report);
  } catch (error) {
    if (error instanceof ExtensionSourceRetirementMigrationError) throw error;
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_INVALID",
      "Unable to create and validate the SQLite migration snapshot.",
      { cause: error },
    );
  } finally {
    snapshot?.close();
    source?.close();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    await removeSqliteSidecars(tempPath);
  }
}

/**
 * Runs the one-way source retirement projection. All writes are delegated to
 * the injected transactional store; this module never performs network I/O or
 * mutates extension files.
 */
export async function migrateLegacyExtensionSources(
  options: ExtensionSourceRetirementMigrationOptions,
): Promise<ExtensionSourceRetirementReport> {
  const now = options.now ?? (() => new Date());
  const existingMarker = await options.store.readMetadata(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY);
  if (existingMarker) return decodeCompletedMarker(existingMarker).report;

  const startedAt = now().toISOString();
  try {
    return await options.store.transaction(async () => {
      const markerInsideTransaction = await options.store.readMetadata(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY);
      if (markerInsideTransaction) return decodeCompletedMarker(markerInsideTransaction).report;
      const extensions = await options.store.listExtensions();
      const duplicateStoreIds = duplicateCanonicalStoreIds(extensions);
      const counts: ExtensionSourceRetirementCounts = {
        scanned: extensions.length,
        migrated: 0,
        managedSnapshots: 0,
        localMissing: 0,
        pendingDisabled: 0,
        metadataOnly: 0,
        invalidId: 0,
        duplicates: 0,
        unchanged: 0,
        issuesOmitted: 0,
      };
      const issues: ExtensionSourceRetirementIssue[] = [];
      for (const extension of extensions) {
        // Filesystem inspection belongs only to rows that actually carry
        // retired authority. Probing every ordinary local/verified extension
        // would turn a one-way metadata migration into an unrelated startup
        // crawl (and could block on a user-owned reference directory).
        if (!isLegacySourceBacked(extension)) {
          counts.unchanged += 1;
          continue;
        }
        const probe = options.probeLocalPackage
          ? await options.probeLocalPackage(extension)
          : await probeLocalPackage(extension);
        const classification = classifyLegacyExtension({ extension, probe, duplicateStoreIds });
        for (const issue of classification.issues) {
          if (issues.length < MAX_REPORTED_ISSUES) issues.push(issue);
          else counts.issuesOmitted += 1;
        }
        counts.migrated += 1;
        switch (classification.category) {
          case "managed-snapshot":
            counts.managedSnapshots += 1;
            break;
          case "local-missing":
            counts.localMissing += 1;
            break;
          case "pending-disabled":
            counts.pendingDisabled += 1;
            break;
          case "metadata-only":
            counts.metadataOnly += 1;
            break;
          case "invalid-id":
            counts.invalidId += 1;
            break;
        }
        if (classification.duplicateStoreId) counts.duplicates += 1;
        await options.store.updateExtensionExact(extension.id, classification.patch);
      }
      const completedAt = now().toISOString();
      const report: ExtensionSourceRetirementReport = {
        schemaVersion: 1,
        migrationVersion: 1,
        markerKey: EXTENSION_SOURCE_RETIREMENT_MARKER_KEY,
        startedAt,
        completedAt,
        status: "completed",
        counts,
        issues,
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
      };
      const marker: ExtensionSourceRetirementMarker = {
        schemaVersion: 1,
        migrationVersion: 1,
        completedAt,
        report,
      };
      const encodedMarker = JSON.stringify(marker);
      if (Buffer.byteLength(encodedMarker, "utf8") > MAX_METADATA_BYTES) {
        throw new ExtensionSourceRetirementMigrationError(
          "EXTENSION_SOURCE_MIGRATION_MARKER_INVALID",
          "Legacy source retirement report exceeds the metadata limit.",
        );
      }
      if (options.snapshot) {
        await options.store.writeMetadata(
          EXTENSION_SOURCE_RETIREMENT_SNAPSHOT_MARKER_KEY,
          JSON.stringify(options.snapshot),
        );
      }
      await options.store.writeMetadata(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY, encodedMarker);
      return Object.freeze(report);
    });
  } catch (error) {
    if (error instanceof ExtensionSourceRetirementMigrationError) throw error;
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
      "Legacy extension source retirement was rolled back.",
      { cause: error },
    );
  }
}

/** Creates the retained WAL-aware snapshot and then applies the one-way migration. */
export async function runExtensionSourceRetirement(
  options: RunExtensionSourceRetirementOptions,
): Promise<ExtensionSourceRetirementReport> {
  const existingMarker = await options.store.readMetadata(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY);
  if (existingMarker) return decodeCompletedMarker(existingMarker).report;
  // A prior attempt may have committed only its recovery image before the
  // SQLite transaction rolled back. Never compare a post-rollback page image
  // byte-for-byte with that old snapshot (WAL checkpointing can legitimately
  // rewrite pages); retain it as a recovery point and publish a fresh image for
  // this retry under a unique sibling path.
  const requestedSnapshotPath = await pathExists(options.snapshotPath)
    ? `${options.snapshotPath}.retry-${process.pid}-${randomUUID()}`
    : options.snapshotPath;
  const snapshot = await createWalAwareSqliteSnapshot({
    databasePath: options.databasePath,
    snapshotPath: requestedSnapshotPath,
    now: options.now,
    validate: validatePreRetirementDatabase,
  });
  return migrateLegacyExtensionSources({ ...options, snapshot });
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await fs.access(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Adapter for the live SQLite repository. It intentionally works on a
 * DatabaseSync connection rather than importing SqlitePanelRepository, so the
 * repository can invoke it during startup without creating a service cycle.
 * The caller owns the connection and should hold the global data-mutation
 * lease before calling this function.
 */
export async function migrateLegacyExtensionSourcesInDatabase(
  options: SqliteExtensionSourceRetirementOptions,
): Promise<ExtensionSourceRetirementReport> {
  const store = createSqliteRetirementStore(options.database);
  return migrateLegacyExtensionSources({
    store,
    now: options.now,
    probeLocalPackage: options.probeLocalPackage,
    snapshot: options.snapshot,
  });
}

export function createSqliteRetirementStore(database: DatabaseSync): LegacySourceRetirementStore {
  const columns = new Set(
    (database.prepare("PRAGMA table_info(extensions)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const metadataColumns = new Set(
    (database.prepare("PRAGMA table_info(storage_metadata)").all() as Array<{ name: string }>).map((row) => row.name),
  );
  const requiredExtensionColumns = [
    "id",
    "source_kind",
    "source_url",
    "source_id",
    "store_id",
    "store_url",
    "store_namespace",
    "provenance_json",
    "artifact_archive_path",
    "update_provider_id",
    "update_state_json",
    "install_state",
    "update_policy",
    "local_path",
    "last_error",
    "status",
    "created_at",
    "updated_at",
  ] as const;
  const missingExtensionColumns = requiredExtensionColumns.filter((column) => !columns.has(column));
  if (missingExtensionColumns.length > 0) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
      "SQLite extensions table is missing columns required for atomic legacy source retirement.",
    );
  }
  if (!metadataColumns.has("key") || !metadataColumns.has("value")) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
      "SQLite storage metadata table is missing required columns.",
    );
  }

  return {
    async listExtensions(): Promise<ExtensionEntity[]> {
      return database.prepare("SELECT * FROM extensions ORDER BY id ASC").all().map((row) => extensionFromSqlRow(row as Record<string, unknown>));
    },
    async transaction<T>(operation: () => Promise<T>): Promise<T> {
      database.exec("BEGIN IMMEDIATE");
      try {
        const value = await operation();
        database.exec("COMMIT");
        return value;
      } catch (error) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original migration failure; SQLite may already have rolled back.
        }
        throw error;
      }
    },
    async updateExtensionExact(extensionId: string, patch: Partial<ExtensionEntity>): Promise<void> {
      const assignments: string[] = [];
      const values: Array<string | number | null> = [];
      const add = (column: string, value: string | number | null): void => {
        if (!columns.has(column)) return;
        assignments.push(`"${column}" = ?`);
        values.push(value);
      };
      if (Object.prototype.hasOwnProperty.call(patch, "sourceKind")) add("source_kind", patch.sourceKind ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "sourceUrl")) add("source_url", patch.sourceUrl ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "sourceId")) add("source_id", patch.sourceId ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "storeId")) add("store_id", patch.storeId ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "storeUrl")) add("store_url", patch.storeUrl ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "storeIdentity")) {
        add("store_namespace", patch.storeIdentity?.namespace ?? null);
      }
      if (Object.prototype.hasOwnProperty.call(patch, "artifactArchivePath")) add("artifact_archive_path", patch.artifactArchivePath ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "updateProviderId")) add("update_provider_id", patch.updateProviderId ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "updateState")) add("update_state_json", patch.updateState ? JSON.stringify(patch.updateState) : null);
      if (Object.prototype.hasOwnProperty.call(patch, "updatePolicy")) add("update_policy", patch.updatePolicy ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "provenance")) add("provenance_json", patch.provenance ? JSON.stringify(patch.provenance) : null);
      if (Object.prototype.hasOwnProperty.call(patch, "installState")) add("install_state", patch.installState ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "status")) add("status", patch.status ?? null);
      if (Object.prototype.hasOwnProperty.call(patch, "lastError")) add("last_error", patch.lastError ?? null);
      if (assignments.length === 0) return;
      values.push(extensionId);
      const result = database.prepare(`UPDATE extensions SET ${assignments.join(", ")} WHERE id = ?`).run(...values);
      if (Number(result.changes) !== 1) throw new Error(`Legacy extension row ${extensionId} does not exist.`);
    },
    async readMetadata(key: string): Promise<string | undefined> {
      const row = database.prepare("SELECT value FROM storage_metadata WHERE key = ?").get(key) as { value?: unknown } | undefined;
      return typeof row?.value === "string" ? row.value : undefined;
    },
    async writeMetadata(key: string, value: string): Promise<void> {
      database.prepare(`
        INSERT INTO storage_metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `).run(key, value);
    },
  };
}

/**
 * Decodes one legacy SQLite extension row for the retirement classifier. This
 * intentionally performs only tolerant projection; semantic normalization and
 * retirement decisions remain in classifyLegacyExtension().
 */
export function extensionForLegacyRetirementRow(row: Record<string, unknown>): ExtensionEntity {
  return extensionFromSqlRow(row);
}

export function classifyLegacyExtension(
  input: ClassifyLegacyExtensionInput,
): LegacyExtensionClassification {
  const extension = input.extension;
  const legacySourceBacked = isLegacySourceBacked(extension);
  const canonicalStoreId = canonicalStoreIdOf(extension);
  const duplicateStoreId = Boolean(canonicalStoreId && input.duplicateStoreIds?.has(canonicalStoreId));
  const existingStoreIdentity = extension.storeIdentity;
  const retainedStoreIdentity = existingStoreIdentity
    && CHROME_EXTENSION_ID_PATTERN.test(existingStoreIdentity.storeId)
    && existingStoreIdentity.listingUrl === chromeWebStoreListingUrl(existingStoreIdentity.storeId)
    ? existingStoreIdentity
    : undefined;
  if (!legacySourceBacked) {
    return {
      extensionId: extension.id,
      category: "metadata-only",
      isLegacySourceBacked: false,
      canonicalStoreId,
      duplicateStoreId,
      patch: {},
      issues: [],
    };
  }

  const issues: ExtensionSourceRetirementIssue[] = [];
  if (duplicateStoreId) {
    issues.push({
      extensionId: extension.id,
      code: "LEGACY_SOURCE_DUPLICATE_STORE_ID",
      storeId: canonicalStoreId,
      detail: "Multiple extension records share one canonical store id; no records were merged.",
    });
  }
  if (canonicalStoreId === undefined) {
    issues.push({
      extensionId: extension.id,
      code: "LEGACY_SOURCE_INVALID_ID",
      detail: hasStoreLikeIdentity(extension)
        ? "Legacy store metadata is not a canonical Chrome extension id and was not promoted."
        : "Legacy source row has no canonical Chrome extension id and was not promoted.",
    });
  }

  const readable = input.probe?.localPackageReadable ?? false;
  const pathExists = input.probe?.localPathExists ?? Boolean(extension.localPath);
  const sourceUrl = typeof extension.sourceUrl === "string" ? extension.sourceUrl.trim() : "";
  const legacyProvenance = legacyProvenanceFor(extension, sourceUrl);
  const commonPatch: Partial<ExtensionEntity> = {
    sourceKind: "managed-snapshot",
    sourceUrl: "",
    sourceId: undefined,
    artifactArchivePath: undefined,
    updateProviderId: undefined,
    updateState: { status: "provider-disabled" },
    updatePolicy: "pinned",
    provenance: legacyProvenance,
    // Raw/intermediate builds could persist a namespace next to an alias or a
    // noncanonical listing. Keep storeId/storeUrl as legacy metadata, but clear
    // the canonical namespace unless the complete identity is canonical.
    storeIdentity: retainedStoreIdentity,
  };

  if (INSTALLED_STATES.has(extension.installState) && readable) {
    issues.push({ extensionId: extension.id, code: "LEGACY_SOURCE_MIGRATED", storeId: canonicalStoreId });
    return {
      extensionId: extension.id,
      category: "managed-snapshot",
      isLegacySourceBacked: true,
      canonicalStoreId,
      duplicateStoreId,
      patch: {
        ...commonPatch,
        // update-available is still a readable installed snapshot, but its
        // retired source can no longer supply an update. Converge it to the
        // local installed state so no legacy update action remains exposed.
        installState: "installed",
      },
      issues,
    };
  }

  if (INSTALLED_STATES.has(extension.installState) && !readable) {
    issues.push({
      extensionId: extension.id,
      code: pathExists ? "LEGACY_SOURCE_UNREADABLE_PATH" : "LEGACY_SOURCE_LOCAL_MISSING",
      detail: input.probe?.localPackageError,
      storeId: canonicalStoreId,
    });
    return {
      extensionId: extension.id,
      category: "local-missing",
      isLegacySourceBacked: true,
      canonicalStoreId,
      duplicateStoreId,
      patch: { ...commonPatch, installState: "local-missing", lastError: input.probe?.localPackageError ?? "Retired extension source package is missing." },
      issues,
    };
  }

  if (extension.installState === "local-missing") {
    issues.push({
      extensionId: extension.id,
      code: "LEGACY_SOURCE_LOCAL_MISSING",
      detail: input.probe?.localPackageError,
      storeId: canonicalStoreId,
    });
    return {
      extensionId: extension.id,
      category: "local-missing",
      isLegacySourceBacked: true,
      canonicalStoreId,
      duplicateStoreId,
      patch: {
        ...commonPatch,
        installState: "local-missing",
        lastError: input.probe?.localPackageError ?? "Retired extension source package is missing.",
      },
      issues,
    };
  }

  if (extension.installState === "metadata-only" && canonicalStoreId !== undefined) {
    issues.push({ extensionId: extension.id, code: "LEGACY_SOURCE_NOT_INSTALLED", storeId: canonicalStoreId });
    return {
      extensionId: extension.id,
      category: "metadata-only",
      isLegacySourceBacked: true,
      canonicalStoreId,
      duplicateStoreId,
      patch: {
        ...commonPatch,
        sourceKind: "chrome-web-store",
        storeId: canonicalStoreId,
        storeUrl: chromeWebStoreListingUrl(canonicalStoreId),
        storeIdentity: {
          namespace: "chrome-web-store",
          storeId: canonicalStoreId,
          listingUrl: chromeWebStoreListingUrl(canonicalStoreId),
        },
        status: "disabled",
        installState: "metadata-only",
        lastError: "Retired extension source metadata requires a new verified acquisition.",
      },
      issues,
    };
  }

  if (NOT_YET_INSTALLED_STATES.has(extension.installState)) {
    issues.push({
      extensionId: extension.id,
      code: "LEGACY_SOURCE_NOT_INSTALLED",
      storeId: canonicalStoreId,
    });
    return {
      extensionId: extension.id,
      category: canonicalStoreId ? "pending-disabled" : "invalid-id",
      isLegacySourceBacked: true,
      canonicalStoreId,
      duplicateStoreId,
      patch: {
        ...commonPatch,
        status: "disabled",
        installState: "metadata-only",
        lastError: "Retired extension source was not installed; reacquire it through the verified flow.",
      },
      issues,
    };
  }

  issues.push({ extensionId: extension.id, code: "LEGACY_SOURCE_UNSUPPORTED_STATE", storeId: canonicalStoreId });
  return {
    extensionId: extension.id,
    category: canonicalStoreId ? "pending-disabled" : "invalid-id",
    isLegacySourceBacked: true,
    canonicalStoreId,
    duplicateStoreId,
    patch: {
      ...commonPatch,
      status: "disabled",
      installState: "metadata-only",
      lastError: "Retired extension source has an unsupported installation state.",
    },
    issues,
  };
}

/**
 * One-way normalization for schema-v1 backup/environment-package records.
 * Transfer payloads have no live filesystem probe, so they retain their
 * conservative identity/permission facts but never retain executable source
 * or update authority. Both transfer readers call this function to keep the
 * migration semantics identical to the live DB path.
 */
export function retireLegacyTransferredExtension(
  extension: LegacyTransferExtension | ExtensionEntity,
  optionsOrIndex: { stripPaths?: boolean } | number = {},
): ExtensionEntity {
  // The helper is intentionally usable as Array.map(callback), whose second
  // positional argument is a numeric index rather than our options object.
  const options = typeof optionsOrIndex === "number" ? {} : optionsOrIndex;
  if (!isLegacySourceBacked(extension)) {
    if (!options.stripPaths) return { ...extension };
    // Transfer writers must never serialize an exporting-machine path or leave
    // a local source URL as an authority on the receiving machine. Retained
    // verified CRX artifacts take a separate canonical branch in each writer;
    // every other package is represented as an inert managed snapshot.
    const raw = extension as unknown as Record<string, unknown>;
    const provenance = raw.provenance;
    const legacySourceUrl = provenance && typeof provenance === "object" && !Array.isArray(provenance)
      && "artifact" in provenance
      && provenance.artifact
      && typeof provenance.artifact === "object"
      && !Array.isArray(provenance.artifact)
      && typeof (provenance.artifact as Record<string, unknown>).legacySourceUrl === "string"
      ? (provenance.artifact as Record<string, unknown>).legacySourceUrl
      : undefined;
    const hadRemoteAuthority = Boolean(
      typeof raw.updateProviderId === "string"
      || legacySourceUrl,
    );
    return {
      ...extension,
      sourceKind: "managed-snapshot",
      sourceUrl: "",
      sourceId: undefined,
      artifactArchivePath: undefined,
      updateProviderId: undefined,
      updateState: hadRemoteAuthority ? { status: "provider-disabled" } : undefined,
      updatePolicy: "pinned",
      localPath: undefined,
      directoryMode: undefined,
    };
  }
  const canonicalStoreId = canonicalStoreIdOf(extension);
  if (extension.installState === "metadata-only" && canonicalStoreId) {
    const listingUrl = chromeWebStoreListingUrl(canonicalStoreId);
    const retiredMetadata: ExtensionEntity = {
      ...extension,
      sourceKind: "chrome-web-store",
      // The canonical listing remains a display identity in storeIdentity/
      // storeUrl; sourceUrl is executable authority in legacy code and must be
      // blank after retirement.
      sourceUrl: "",
      sourceId: undefined,
      storeId: canonicalStoreId,
      storeUrl: listingUrl,
      storeIdentity: { namespace: "chrome-web-store", storeId: canonicalStoreId, listingUrl },
      artifactArchivePath: undefined,
      updateProviderId: undefined,
      updateState: { status: "provider-disabled" },
      updatePolicy: "pinned",
      status: "disabled",
      lastError: "Retired extension source metadata requires a new verified acquisition.",
      provenance: legacyProvenanceFor(extension, extension.sourceUrl ?? ""),
    };
    return options.stripPaths
      ? { ...retiredMetadata, localPath: undefined, directoryMode: undefined }
      : retiredMetadata;
  }
  const notYetInstalled = NOT_YET_INSTALLED_STATES.has(extension.installState);
  const wasReadableInstalled = INSTALLED_STATES.has(extension.installState);
  const retired: ExtensionEntity = {
    ...extension,
    sourceKind: "managed-snapshot",
    sourceUrl: "",
    sourceId: undefined,
    artifactArchivePath: undefined,
    updateProviderId: undefined,
    updateState: { status: "provider-disabled" },
    updatePolicy: "pinned",
    provenance: legacyProvenanceFor(extension, extension.sourceUrl ?? ""),
    ...(notYetInstalled
      ? {
          status: "disabled" as const,
          installState: "metadata-only" as const,
          lastError: "Retired extension source was not installed; reacquire it through the verified flow.",
        }
      : wasReadableInstalled && extension.installState === "update-available"
        ? { installState: "installed" as const }
        : {}),
  };
  if (!options.stripPaths) return retired;
  return { ...retired, localPath: undefined, directoryMode: undefined };
}

function isLegacySourceBacked(extension: ExtensionEntity): boolean {
  // A completed acquisition is exempt only when the entire persisted authority
  // contract validates: canonical listing/ID, complete publisher proof, retained
  // CRX path, entity/artifact/Manifest fingerprints, source projection, provider
  // state, and absence of legacy source authority. A few trusted-looking enum
  // values are not enough to skip the one-way retirement.
  let authority: ReturnType<typeof normalizeExtensionAuthorityFields> | undefined;
  try {
    authority = normalizeExtensionAuthorityFields(extension);
  } catch {
    // Any malformed server-owned authority field is conservative legacy
    // evidence. Retire it here so the ordinary strict row projection cannot
    // wedge startup after the migration marker has been committed.
    if (hasPersistedAuthorityShape(extension)) return true;
  }
  if (
    authority?.provenance?.verification.level === "cws-publisher-verified"
    || authority?.provenance?.artifact.providerId === "chrome-web-store"
    || authority?.provenance?.artifact.providerId === "crxsoso"
    || authority?.artifactArchivePath
    || authority?.updateProviderId
  ) {
    if (
      authority.provenance?.verification.level === "cws-publisher-verified"
      && authority.storeIdentity?.namespace === "chrome-web-store"
      && authority.artifactArchivePath
      && !/^https?:\/\//i.test(authority.artifactArchivePath)
      && authority.provenance.artifact.retained
      && !extension.sourceId
      && extension.sourceKind === "local-crx"
    ) return false;
    return true;
  }
  const rawSourceId = (extension as unknown as Record<string, unknown>).sourceId;
  if (
    LEGACY_SOURCE_KINDS.has(extension.sourceKind)
    || (rawSourceId !== undefined && rawSourceId !== null
      && (typeof rawSourceId !== "string" || Boolean(rawSourceId.trim())))
  ) return true;
  // Older databases may contain a source kind introduced by an intermediate
  // build. A remote HTTP(S) source URL is still executable legacy authority
  // unless the row is explicitly one of the local/managed kinds.
  const sourceUrl = typeof extension.sourceUrl === "string" ? extension.sourceUrl.trim() : "";
  return /^https?:\/\//i.test(sourceUrl)
    && extension.sourceKind !== "local-directory"
    && extension.sourceKind !== "local-zip"
    && extension.sourceKind !== "local-crx"
    && extension.sourceKind !== "managed-snapshot";
}

function hasPersistedAuthorityShape(extension: ExtensionEntity): boolean {
  const raw = extension as unknown as Record<string, unknown>;
  return [
    "storeIdentity",
    "provenance",
    "artifactArchivePath",
    "updateProviderId",
    "updateState",
  ].some((key) => Object.prototype.hasOwnProperty.call(raw, key) && raw[key] !== undefined && raw[key] !== null);
}

function hasStoreLikeIdentity(extension: ExtensionEntity): boolean {
  return Boolean(
    (typeof extension.storeId === "string" && extension.storeId.trim())
    || (typeof extension.storeUrl === "string" && extension.storeUrl.trim()),
  );
}

function canonicalStoreIdOf(extension: ExtensionEntity): string | undefined {
  const candidates = [extension.storeIdentity?.storeId, extension.storeId];
  return candidates.find((value): value is string => typeof value === "string" && CHROME_EXTENSION_ID_PATTERN.test(value.trim()))?.trim();
}

function duplicateCanonicalStoreIds(extensions: ExtensionEntity[]): ReadonlySet<string> {
  const counts = new Map<string, number>();
  for (const extension of extensions) {
    const storeId = canonicalStoreIdOf(extension);
    if (storeId) counts.set(storeId, (counts.get(storeId) ?? 0) + 1);
  }
  return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([storeId]) => storeId));
}

function legacyProvenanceFor(extension: ExtensionEntity, sourceUrl: string): ExtensionProvenanceV1 {
  const existing = extension.provenance;
  const existingRecord = existing && typeof existing === "object" ? existing as unknown as Record<string, unknown> : undefined;
  const existingArtifact = existingRecord?.artifact && typeof existingRecord.artifact === "object"
    ? existingRecord.artifact as Record<string, unknown>
    : undefined;
  const existingVerification = existingRecord?.verification && typeof existingRecord.verification === "object"
    ? existingRecord.verification as Record<string, unknown>
    : undefined;
  const legacySourceUrl = safeHistoricalUrl(sourceUrl)
    ?? safeHistoricalUrl(typeof existingArtifact?.legacySourceUrl === "string" ? existingArtifact.legacySourceUrl : undefined);
  const artifactSize = existingArtifact?.size;
  const artifactSha256 = typeof existingArtifact?.sha256 === "string" ? existingArtifact.sha256 : undefined;
  const manifestSha256 = existingVerification?.manifestSha256;
  const catalog = normalizeLegacyCatalog(existingRecord?.catalog);
  const transfer = normalizeLegacyTransfer(existingRecord?.transfer);
  return {
    schemaVersion: 1,
    ...(catalog ? { catalog } : {}),
    artifact: {
      providerId: "legacy",
      ...(legacySourceUrl ? { legacySourceUrl } : {}),
      format: "unknown",
      ...(typeof artifactSize === "number" && Number.isSafeInteger(artifactSize) && artifactSize >= 0 && artifactSize <= MAX_SNAPSHOT_BYTES ? { size: artifactSize } : {}),
      ...(artifactSha256 && SHA256_PATTERN.test(artifactSha256) ? { sha256: artifactSha256.toLowerCase() } : {}),
      retained: false,
    },
    verification: {
      level: "legacy-unknown",
      ...(typeof manifestSha256 === "string" && SHA256_PATTERN.test(manifestSha256)
        ? { manifestSha256: manifestSha256.toLowerCase() }
        : {}),
    },
    ...(transfer ? { transfer } : {}),
  };
}

function normalizeLegacyCatalog(value: unknown): ExtensionProvenanceV1["catalog"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.providerId !== "crxsoso" || !isIsoTimestamp(record.observedAt)) return undefined;
  return { providerId: "crxsoso", observedAt: record.observedAt as string };
}

function normalizeLegacyTransfer(value: unknown): ExtensionProvenanceV1["transfer"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (
    (record.kind !== "direct-acquisition" && record.kind !== "full-backup-restore" && record.kind !== "environment-package-import")
    || !isIsoTimestamp(record.at)
  ) return undefined;
  return { kind: record.kind, at: record.at as string };
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 128) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function safeHistoricalUrl(value: string | undefined): string | undefined {
  if (
    typeof value !== "string"
    || Buffer.byteLength(value, "utf8") > MAX_LEGACY_SOURCE_URL_BYTES
    || /[\u0000-\u001f\u007f\s]/.test(value)
    || !/^https?:\/\//i.test(value)
  ) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.username || parsed.password || parsed.hash || parsed.hostname.endsWith(".")) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

async function probeLocalPackage(extension: ExtensionEntity): Promise<LegacyExtensionProbe> {
  const localPath = extension.localPath?.trim();
  if (!localPath) return { localPathExists: false, localPackageReadable: false };
  let localPathExists = false;
  try {
    const stats = await fs.lstat(localPath);
    localPathExists = true;
    if (stats.isSymbolicLink() || !stats.isDirectory()) return { localPathExists: true, localPackageReadable: false, localPackageError: "Legacy extension local path is not a real directory." };
    const canonicalRoot = await fs.realpath(localPath);
    const manifestPath = path.join(localPath, "manifest.json");
    const manifestStats = await fs.lstat(manifestPath);
    if (manifestStats.isSymbolicLink() || !manifestStats.isFile() || manifestStats.size > MAX_METADATA_BYTES) {
      return { localPathExists: true, localPackageReadable: false, localPackageError: "Legacy extension Manifest is missing or exceeds the metadata limit." };
    }
    const canonicalManifest = await fs.realpath(manifestPath);
    const comparableRoot = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
    const comparableManifest = process.platform === "win32" ? canonicalManifest.toLowerCase() : canonicalManifest;
    if (!comparableManifest.startsWith(`${comparableRoot}${path.sep}`)) {
      return { localPathExists: true, localPackageReadable: false, localPackageError: "Legacy extension Manifest resolves outside its package directory." };
    }
    const text = await fs.readFile(manifestPath, "utf8");
    const parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as Record<string, unknown>;
    const readable = Boolean(
      parsed
      && typeof parsed.name === "string"
      && parsed.name.trim()
      && typeof parsed.version === "string"
      && parsed.version.trim()
      && (parsed.manifest_version === 2 || parsed.manifest_version === 3),
    );
    return {
      localPathExists: true,
      localPackageReadable: readable,
      ...(readable ? {} : { localPackageError: "Legacy extension Manifest is invalid." }),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!localPathExists && (code === "ENOENT" || code === "ENOTDIR")) {
      return {
        localPathExists: false,
        localPackageReadable: false,
        localPackageError: "Legacy extension local path is missing.",
      };
    }
    return {
      localPathExists: true,
      localPackageReadable: false,
      // Do not persist OS paths, URLs, or filesystem error text in the
      // migration report; callers can inspect the local row/path separately.
      localPackageError: "Legacy extension package could not be read.",
    };
  }
}

function decodeCompletedMarker(value: string): ExtensionSourceRetirementMarker {
  if (Buffer.byteLength(value, "utf8") > MAX_METADATA_BYTES) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_MIGRATION_MARKER_INVALID",
      "Legacy source retirement marker exceeds the metadata limit.",
    );
  }
  try {
    const parsed = JSON.parse(value) as Partial<ExtensionSourceRetirementMarker>;
    if (
      parsed.schemaVersion !== 1
      || parsed.migrationVersion !== EXTENSION_SOURCE_RETIREMENT_MIGRATION_VERSION
      || !parsed.report
      || parsed.report.markerKey !== EXTENSION_SOURCE_RETIREMENT_MARKER_KEY
      || parsed.report.status !== "completed"
    ) throw new Error("marker shape");
    validateCompletedReport(parsed.report);
    return parsed as ExtensionSourceRetirementMarker;
  } catch (error) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_MIGRATION_MARKER_INVALID",
      "Legacy source retirement marker is invalid.",
      { cause: error },
    );
  }
}

function validateCompletedReport(report: ExtensionSourceRetirementReport): void {
  if (
    report.schemaVersion !== 1
    || report.migrationVersion !== EXTENSION_SOURCE_RETIREMENT_MIGRATION_VERSION
    || report.markerKey !== EXTENSION_SOURCE_RETIREMENT_MARKER_KEY
    || report.status !== "completed"
    || typeof report.startedAt !== "string"
    || typeof report.completedAt !== "string"
    || !report.counts
    || !Array.isArray(report.issues)
    || report.issues.length > MAX_REPORTED_ISSUES
  ) throw new Error("report shape");
  const countKeys: Array<keyof ExtensionSourceRetirementCounts> = [
    "scanned",
    "migrated",
    "managedSnapshots",
    "localMissing",
    "pendingDisabled",
    "metadataOnly",
    "invalidId",
    "duplicates",
    "unchanged",
    "issuesOmitted",
  ];
  for (const key of countKeys) {
    const value = report.counts[key];
    if (!Number.isSafeInteger(value) || value < 0) throw new Error("report counts");
  }
  if (report.counts.scanned !== report.counts.migrated + report.counts.unchanged) throw new Error("report count totals");
  if (
    report.counts.migrated !== report.counts.managedSnapshots
      + report.counts.localMissing
      + report.counts.pendingDisabled
      + report.counts.metadataOnly
      + report.counts.invalidId
  ) throw new Error("report migration categories");
  if (report.counts.duplicates > report.counts.migrated) throw new Error("report duplicate count");
  for (const issue of report.issues) {
    if (!issue || typeof issue !== "object" || typeof issue.extensionId !== "string" || typeof issue.code !== "string") {
      throw new Error("report issue shape");
    }
  }
  if (report.snapshot) {
    if (
      report.snapshot.schemaVersion !== 1
      || typeof report.snapshot.sourcePath !== "string"
      || typeof report.snapshot.snapshotPath !== "string"
      || !SHA256_PATTERN.test(report.snapshot.sha256)
      || !Number.isSafeInteger(report.snapshot.sizeBytes)
      || report.snapshot.sizeBytes < SQLITE_HEADER.byteLength
      || report.snapshot.integrityCheck !== "ok"
      || !report.snapshot.tables
    ) throw new Error("report snapshot shape");
  }
}

function validatePreRetirementDatabase(database: DatabaseSync): void {
  const tables = new Set(
    (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((row) => row.name),
  );
  if (!tables.has("extensions") || !tables.has("storage_metadata")) {
    throw new Error("pre-retirement schema is missing required tables");
  }
  const marker = database.prepare("SELECT value FROM storage_metadata WHERE key = ?").get(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY);
  if (marker) throw new Error("pre-retirement snapshot already contains a completion marker");
}

function validateDatabasePath(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
      `SQLite ${label} path is invalid.`,
    );
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
      `SQLite ${label} path cannot be a filesystem root.`,
    );
  }
  return resolved;
}

async function writeFileDurably(filePath: string, bytes: Uint8Array): Promise<void> {
  const handle = await fs.open(filePath, "wx", 0o600);
  try {
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
      if (bytesWritten <= 0) throw new Error("snapshot write made no progress");
      offset += bytesWritten;
    }
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function ensureRealDirectoryChain(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  const remainder = path.relative(parsed.root, resolved);
  for (const segment of remainder.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stats = await fs.lstat(current).catch(() => undefined);
    if (!stats) {
      await fs.mkdir(current, { mode: 0o700 });
      stats = await fs.lstat(current);
    }
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
        "SQLite snapshot parent contains a linked or non-directory component.",
      );
    }
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Windows does not permit opening directories for fsync. The file itself
    // was fsynced; directory durability is best effort on that platform.
  }
}

async function removeSqliteSidecars(databasePath: string): Promise<void> {
  await Promise.all([
    fs.rm(`${databasePath}-wal`, { force: true }),
    fs.rm(`${databasePath}-shm`, { force: true }),
    fs.rm(`${databasePath}-journal`, { force: true }),
  ]);
}

async function inspectExistingSnapshot(
  snapshotPath: string,
  sourcePath: string,
  now: () => Date,
  validate?: (database: DatabaseSync) => void,
): Promise<SqliteSnapshotReport> {
  const stats = await fs.lstat(snapshotPath);
  if (
    !stats.isFile()
    || stats.isSymbolicLink()
    || stats.size < SQLITE_HEADER.byteLength
    || stats.size > MAX_SNAPSHOT_BYTES
  ) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_INVALID",
      "Existing SQLite migration snapshot is not a bounded database image.",
    );
  }
  const bytes = await fs.readFile(snapshotPath);
  if (
    bytes.byteLength < SQLITE_HEADER.byteLength
    || !bytes.subarray(0, SQLITE_HEADER.byteLength).equals(SQLITE_HEADER)
    || bytes.byteLength > MAX_SNAPSHOT_BYTES
  ) {
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_INVALID",
      "Existing SQLite migration snapshot is not a bounded database image.",
    );
  }
  let database: DatabaseSync | undefined;
  let source: DatabaseSync | undefined;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true, timeout: 5_000 });
    const currentImage = Buffer.from(source.serialize("main"));
    if (
      currentImage.byteLength !== bytes.byteLength
      || createHash("sha256").update(currentImage).digest("hex") !== createHash("sha256").update(bytes).digest("hex")
    ) {
      throw new ExtensionSourceRetirementMigrationError(
        "EXTENSION_SOURCE_SNAPSHOT_INVALID",
        "Existing migration snapshot does not match the current pre-migration database.",
      );
    }
    database = new DatabaseSync(snapshotPath, { readOnly: true, timeout: 5_000 });
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: unknown } | undefined;
    if (integrity?.integrity_check !== "ok") throw new Error("integrity_check");
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeys.length > 0) throw new Error("foreign_key_check");
    validate?.(database);
    return Object.freeze({
      schemaVersion: 1,
      sourcePath,
      snapshotPath,
      createdAt: now().toISOString(),
      sizeBytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      tables: readTableCounts(database),
    });
  } catch (error) {
    if (error instanceof ExtensionSourceRetirementMigrationError) throw error;
    throw new ExtensionSourceRetirementMigrationError(
      "EXTENSION_SOURCE_SNAPSHOT_INVALID",
      "Existing SQLite migration snapshot failed validation.",
      { cause: error },
    );
  } finally {
    database?.close();
    source?.close();
  }
}

function readTableCounts(database: DatabaseSync): Record<string, number> {
  const tables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string }>;
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table.name)) continue;
    const row = database.prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`).get() as { count?: number | bigint };
    counts[table.name] = Number(row.count ?? 0);
  }
  return counts;
}

function extensionFromSqlRow(row: Record<string, unknown>): ExtensionEntity {
  const stringValue = (key: string): string | undefined => {
    const value = row[key];
    return typeof value === "string" ? value : undefined;
  };
  const jsonValue = <T>(key: string, fallback: T): T => {
    const value = stringValue(key);
    if (!value) return fallback;
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  };
  const sourceKind = stringValue("source_kind") as ExtensionSourceKind | undefined;
  const installState = stringValue("install_state") as ExtensionInstallState | undefined;
  const storeNamespace = stringValue("store_namespace");
  const storeId = stringValue("store_id");
  const storeUrl = stringValue("store_url");
  return {
    id: stringValue("id") ?? "",
    name: stringValue("name") ?? "Extension",
    description: stringValue("description") ?? "",
    sourceKind: sourceKind ?? "remote-zip",
    sourceUrl: stringValue("source_url") ?? "",
    sourceId: stringValue("source_id"),
    storeId,
    storeUrl,
    ...(storeNamespace === "chrome-web-store" && storeId && storeUrl
      ? { storeIdentity: { namespace: "chrome-web-store" as const, storeId, listingUrl: storeUrl } }
      : {}),
    provenance: jsonValue<ExtensionEntity["provenance"] | undefined>("provenance_json", undefined),
    artifactArchivePath: stringValue("artifact_archive_path"),
    updateProviderId: stringValue("update_provider_id") as ExtensionEntity["updateProviderId"],
    updateState: jsonValue<ExtensionEntity["updateState"] | undefined>("update_state_json", undefined),
    version: stringValue("version") ?? "0.0.0",
    manifestVersion: typeof row.manifest_version === "number" ? row.manifest_version : undefined,
    permissions: jsonValue<string[]>("permissions_json", []),
    hostPermissions: jsonValue<string[]>("host_permissions_json", []),
    optionalPermissions: jsonValue<string[]>("optional_permissions_json", []),
    optionalHostPermissions: jsonValue<string[]>("optional_host_permissions_json", []),
    permissionRisks: jsonValue("permission_risks_json", []),
    installState: installState ?? "metadata-only",
    updatePolicy: (stringValue("update_policy") as ExtensionEntity["updatePolicy"] | undefined) ?? "pinned",
    sha256: stringValue("sha256"),
    manifestSha256: stringValue("manifest_sha256"),
    localPath: stringValue("local_path"),
    manifestKey: stringValue("manifest_key"),
    lastInstalledAt: stringValue("last_installed_at"),
    lastCheckedAt: stringValue("last_checked_at"),
    lastError: stringValue("last_error"),
    status: stringValue("status") === "disabled" ? "disabled" : "enabled",
    createdAt: stringValue("created_at") ?? "",
    updatedAt: stringValue("updated_at") ?? "",
  };
}
