import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionEntity } from "../../src/shared/entities";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import {
  EXTENSION_SOURCE_RETIREMENT_MARKER_KEY,
  ExtensionSourceRetirementMigrationError,
  classifyLegacyExtension,
  createWalAwareSqliteSnapshot,
  migrateLegacyExtensionSources,
  migrateLegacyExtensionSourcesInDatabase,
  retireLegacyTransferredExtension,
  runExtensionSourceRetirement,
  type LegacySourceRetirementStore,
} from "./extensionSourceRetirementMigration";

const CANONICAL_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

test("classifies installed, missing, pending, metadata, duplicate, and invalid-id legacy rows without network authority", async (t) => {
  const directory = await temporaryDirectory(t);
  const installedPath = await writePackage(directory, "installed");
  const rows = [
    extensionFixture("installed", {
      sourceKind: "remote-crx",
      sourceUrl: "https://legacy.example/installed.crx",
      sourceId: "legacy-source",
      storeId: CANONICAL_ID,
      localPath: installedPath,
      installState: "update-available",
      updatePolicy: "auto",
    }),
    extensionFixture("missing", {
      sourceKind: "remote-zip",
      sourceUrl: "https://legacy.example/missing.zip",
      storeId: CANONICAL_ID,
      localPath: path.join(directory, "does-not-exist"),
      installState: "installed",
    }),
    extensionFixture("pending", {
      sourceKind: "remote-zip",
      sourceUrl: "https://legacy.example/pending.zip",
      storeId: CANONICAL_ID,
      installState: "download-pending",
      status: "enabled",
    }),
    extensionFixture("metadata", {
      sourceKind: "chrome-web-store",
      sourceUrl: "https://chromewebstore.google.com/detail/legacy/${CANONICAL_ID}",
      storeId: CANONICAL_ID,
      installState: "metadata-only",
      status: "enabled",
    }),
    extensionFixture("duplicate", {
      sourceKind: "remote-crx",
      sourceUrl: "https://legacy.example/duplicate.crx",
      storeId: CANONICAL_ID,
      installState: "metadata-only",
    }),
    extensionFixture("alias", {
      sourceKind: "remote-zip",
      sourceUrl: "https://legacy.example/alias.zip",
      storeId: "youxiaohoubox",
      storeUrl: "https://chromewebstore.google.com/detail/youxiaohoubox",
      storeIdentity: {
        namespace: "chrome-web-store",
        storeId: "youxiaohoubox",
        listingUrl: "https://chromewebstore.google.com/detail/youxiaohoubox",
      },
      installState: "metadata-only",
    }),
  ];
  const duplicateIds = new Set([CANONICAL_ID]);

  const installed = classifyLegacyExtension({
    extension: rows[0]!,
    probe: { localPathExists: true, localPackageReadable: true },
    duplicateStoreIds: duplicateIds,
  });
  assert.equal(installed.category, "managed-snapshot");
  assert.equal(installed.patch.sourceKind, "managed-snapshot");
  assert.equal(installed.patch.sourceUrl, "");
  assert.equal(installed.patch.sourceId, undefined);
  assert.equal(installed.patch.updatePolicy, "pinned");
  assert.equal(installed.patch.updateProviderId, undefined);
  assert.equal(installed.patch.provenance?.artifact.providerId, "legacy");
  assert.equal(installed.patch.provenance?.artifact.legacySourceUrl, "https://legacy.example/installed.crx");
  assert.equal(installed.patch.provenance?.artifact.format, "unknown");

  const missing = classifyLegacyExtension({
    extension: rows[1]!,
    probe: { localPathExists: false, localPackageReadable: false, localPackageError: "missing" },
    duplicateStoreIds: duplicateIds,
  });
  assert.equal(missing.category, "local-missing");
  assert.equal(missing.patch.installState, "local-missing");
  assert.equal(missing.patch.sourceKind, "managed-snapshot");

  const pending = classifyLegacyExtension({
    extension: rows[2]!,
    probe: { localPathExists: false, localPackageReadable: false },
    duplicateStoreIds: duplicateIds,
  });
  assert.equal(pending.category, "pending-disabled");
  assert.equal(pending.patch.status, "disabled");
  assert.equal(pending.patch.installState, "metadata-only");

  const metadata = classifyLegacyExtension({
    extension: rows[3]!,
    probe: { localPathExists: false, localPackageReadable: false },
    duplicateStoreIds: duplicateIds,
  });
  assert.equal(metadata.category, "metadata-only");
  assert.equal(metadata.patch.sourceKind, "chrome-web-store");
  assert.equal(metadata.patch.status, "disabled");
  assert.ok(metadata.issues.some((issue) => issue.code === "LEGACY_SOURCE_DUPLICATE_STORE_ID"));

  const alias = classifyLegacyExtension({
    extension: rows[5]!,
    probe: { localPathExists: false, localPackageReadable: false },
  });
  assert.equal(alias.category, "invalid-id");
  assert.equal(alias.canonicalStoreId, undefined);
  assert.equal(alias.patch.storeIdentity, undefined);
  assert.equal(alias.patch.storeId, undefined);
  assert.ok(alias.issues.some((issue) => issue.code === "LEGACY_SOURCE_INVALID_ID"));
});

test("only a fully consistent retained Web Store acquisition is exempt from retirement", () => {
  const archivePath = "C:/cbpanel/extension-artifacts/verified/current.crx";
  const verified = extensionFixture("verified", {
    sourceKind: "local-crx",
    sourceUrl: archivePath,
    sourceId: undefined,
    storeId: CANONICAL_ID,
    storeUrl: `https://chromewebstore.google.com/detail/${CANONICAL_ID}`,
    storeIdentity: {
      namespace: "chrome-web-store",
      storeId: CANONICAL_ID,
      listingUrl: `https://chromewebstore.google.com/detail/${CANONICAL_ID}`,
    },
    provenance: {
      schemaVersion: 1,
      artifact: {
        providerId: "chrome-web-store",
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: "2026-08-27T00:00:00.000Z",
        format: "crx3",
        size: 123,
        sha256: "a".repeat(64),
        retained: true,
      },
      verification: {
        level: "cws-publisher-verified",
        verifiedAt: "2026-08-27T00:00:01.000Z",
        proofDerivedStoreId: CANONICAL_ID,
        developerKeySha256: "b".repeat(64),
        publisherKeySha256: "c".repeat(64),
        publisherTrustRootId: "chromium-cws",
        publisherTrustRootVersion: 1,
        manifestSha256: "d".repeat(64),
        treeSha256: "e".repeat(64),
      },
    },
    artifactArchivePath: archivePath,
    updateProviderId: "chrome-web-store",
    updateState: { status: "idle", checkedAt: "2026-08-27T00:00:02.000Z" },
    sha256: "a".repeat(64),
    manifestSha256: "d".repeat(64),
    installState: "installed",
  });

  const complete = classifyLegacyExtension({
    extension: verified,
    probe: { localPathExists: true, localPackageReadable: true },
  });
  assert.equal(complete.isLegacySourceBacked, false);
  assert.deepEqual(complete.patch, {});

  const malformed = classifyLegacyExtension({
    extension: { ...verified, sourceUrl: "https://legacy.example/looks-verified.crx" },
    probe: { localPathExists: true, localPackageReadable: true },
  });
  assert.equal(malformed.isLegacySourceBacked, true);
  assert.equal(malformed.patch.sourceKind, "managed-snapshot");
  assert.equal(malformed.patch.sourceUrl, "");
  assert.equal(malformed.patch.updateProviderId, undefined);
  assert.equal(malformed.patch.provenance?.verification.level, "legacy-unknown");

  const remoteArtifactPath = "https://legacy.example/retained.crx";
  const remoteArtifact = classifyLegacyExtension({
    extension: {
      ...verified,
      sourceUrl: remoteArtifactPath,
      artifactArchivePath: remoteArtifactPath,
    },
    probe: { localPathExists: true, localPackageReadable: true },
  });
  assert.equal(remoteArtifact.isLegacySourceBacked, true);
  assert.equal(remoteArtifact.patch.sourceUrl, "");
  assert.equal(remoteArtifact.patch.artifactArchivePath, undefined);

  const incomplete = classifyLegacyExtension({
    extension: {
      ...verified,
      provenance: {
        schemaVersion: 1,
        artifact: verified.provenance!.artifact,
        verification: {},
      } as never,
    },
    probe: { localPathExists: true, localPackageReadable: true },
  });
  assert.equal(incomplete.isLegacySourceBacked, true);
  assert.equal(incomplete.patch.provenance?.verification.level, "legacy-unknown");

  const malformedManualAuthority = classifyLegacyExtension({
    extension: {
      ...extensionFixture("malformed-manual-authority", {
        sourceKind: "local-crx",
        sourceUrl: "C:/local/manual.crx",
      }),
      provenance: { schemaVersion: 99, artifact: { providerId: "unknown" } } as never,
    },
    probe: { localPathExists: false, localPackageReadable: false },
  });
  assert.equal(malformedManualAuthority.isLegacySourceBacked, true);
  assert.equal(malformedManualAuthority.patch.provenance?.verification.level, "legacy-unknown");

  const validManual = classifyLegacyExtension({
    extension: extensionFixture("valid-manual", {
      sourceKind: "local-crx",
      sourceUrl: "C:/local/manual.crx",
      provenance: {
        schemaVersion: 1,
        artifact: { providerId: "manual-local", format: "crx3", retained: false },
        verification: { level: "unsigned-or-repacked" },
      },
    }),
    probe: { localPathExists: false, localPackageReadable: false },
  });
  assert.equal(validManual.isLegacySourceBacked, false);
  assert.deepEqual(validManual.patch, {});
});

test("migration is transactional, idempotent, preserves files and bindings, and performs zero fetches", async (t) => {
  const directory = await temporaryDirectory(t);
  const packagePath = await writePackage(directory, "package");
  const originalBytes = await fs.readFile(path.join(packagePath, "manifest.json"));
  const first = extensionFixture("installed", {
    sourceKind: "remote-crx",
    sourceUrl: "https://legacy.example/package.crx",
    sourceId: "source-1",
    storeId: CANONICAL_ID,
    localPath: packagePath,
    installState: "installed",
    manifestKey: "browser-key",
    lastInstalledAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-02T00:00:00.000Z",
  });
  const metadata = extensionFixture("metadata", {
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/meta.zip",
    storeId: CANONICAL_ID,
    installState: "metadata-only",
  });
  const ordinary = extensionFixture("ordinary-local", {
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "user-owned-reference"),
    localPath: path.join(directory, "user-owned-reference"),
    installState: "installed",
  });
  const store = new FakeRetirementStore([first, metadata, ordinary]);
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  const probedIds: string[] = [];
  globalThis.fetch = (async () => {
    fetchCount += 1;
    throw new Error("source retirement must never fetch");
  }) as typeof fetch;
  let report: Awaited<ReturnType<typeof migrateLegacyExtensionSources>>;
  try {
    report = await migrateLegacyExtensionSources({
      store,
      probeLocalPackage: async (extension) => {
        probedIds.push(extension.id);
        return extension.id === first.id
          ? { localPathExists: true, localPackageReadable: true }
          : { localPathExists: false, localPackageReadable: false };
      },
      now: monotonicClock(),
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetchCount, 0);
  assert.deepEqual(probedIds, [first.id, metadata.id]);
  assert.equal(report.status, "completed");
  assert.equal(report.counts.scanned, 3);
  assert.equal(report.counts.migrated, 2);
  assert.equal(report.counts.unchanged, 1);
  assert.equal(report.counts.managedSnapshots, 1);
  assert.equal(report.counts.metadataOnly, 1);
  assert.equal(store.writes.length, 2);
  const migrated = store.rows.find((row) => row.id === first.id)!;
  assert.equal(migrated.sourceKind, "managed-snapshot");
  assert.equal(migrated.sourceUrl, "");
  assert.equal(migrated.sourceId, undefined);
  assert.equal(migrated.manifestKey, "browser-key");
  assert.equal(migrated.lastInstalledAt, "2025-01-01T00:00:00.000Z");
  assert.equal(migrated.updatedAt, "2025-01-02T00:00:00.000Z");
  assert.equal(migrated.provenance?.artifact.legacySourceUrl, "https://legacy.example/package.crx");
  assert.deepEqual(await fs.readFile(path.join(packagePath, "manifest.json")), originalBytes);

  const second = await migrateLegacyExtensionSources({ store, now: monotonicClock() });
  assert.deepEqual(second, report);
  assert.equal(store.writes.length, 2);
});

test("default filesystem probe distinguishes a missing package from an unreadable existing path", async (t) => {
  const directory = await temporaryDirectory(t);
  const missingPath = path.join(directory, "missing-package");
  const store = new FakeRetirementStore([
    extensionFixture("missing-default-probe", {
      sourceKind: "remote-zip",
      sourceUrl: "https://legacy.example/missing.zip",
      localPath: missingPath,
      installState: "installed",
    }),
  ]);

  const report = await migrateLegacyExtensionSources({ store, now: monotonicClock() });

  assert.equal(report.counts.localMissing, 1);
  assert.ok(report.issues.some((issue) => issue.code === "LEGACY_SOURCE_LOCAL_MISSING"));
  assert.equal(report.issues.some((issue) => issue.code === "LEGACY_SOURCE_UNREADABLE_PATH"), false);
  assert.equal(store.rows[0]?.installState, "local-missing");
});

test("legacy transfer normalization converges update-available to a local installed snapshot and disables pending rows", () => {
  const updateAvailable = extensionFixture("transferred-update", {
    sourceKind: "remote-crx",
    sourceUrl: "https://legacy.example/update.crx",
    installState: "update-available",
    updatePolicy: "auto",
  });
  const pending = extensionFixture("transferred-pending", {
    sourceKind: "remote-crx",
    sourceUrl: "https://legacy.example/pending.crx",
    installState: "download-pending",
    status: "enabled",
  });
  const normalizedUpdate = retireLegacyTransferredExtension(updateAvailable as never);
  const normalizedPending = retireLegacyTransferredExtension(pending as never);
  assert.equal(normalizedUpdate.sourceKind, "managed-snapshot");
  assert.equal(normalizedUpdate.installState, "installed");
  assert.equal(normalizedUpdate.status, "enabled");
  assert.equal(normalizedPending.sourceKind, "managed-snapshot");
  assert.equal(normalizedPending.installState, "metadata-only");
  assert.equal(normalizedPending.status, "disabled");
});

test("migration failure after a prior row write rolls back every row and the completion marker", async () => {
  const first = extensionFixture("failure-first", {
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/failure-first.zip",
    installState: "metadata-only",
  });
  const second = extensionFixture("failure-second", {
    sourceKind: "remote-crx",
    sourceUrl: "https://legacy.example/failure-second.crx",
    installState: "download-pending",
  });
  const store = new FakeRetirementStore([first, second], { failAfterWrites: 1 });
  await assert.rejects(
    migrateLegacyExtensionSources({ store, now: monotonicClock() }),
    (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
      && error.code === "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
  );
  assert.equal(store.rows[0]!.sourceKind, "remote-zip");
  assert.equal(store.rows[0]!.sourceUrl, "https://legacy.example/failure-first.zip");
  assert.equal(store.rows[1]!.sourceKind, "remote-crx");
  assert.equal(store.rows[1]!.sourceUrl, "https://legacy.example/failure-second.crx");
  assert.equal(store.writes.length, 0);
  assert.equal(await store.readMetadata(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY), undefined);
});

test("completion-marker failure rolls back already classified rows", async () => {
  const row = extensionFixture("marker-failure", {
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/marker-failure.zip",
    installState: "metadata-only",
  });
  const store = new FakeRetirementStore([row], { failOnMarkerWrite: true });
  await assert.rejects(
    migrateLegacyExtensionSources({ store, now: monotonicClock() }),
    (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
      && error.code === "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
  );
  assert.equal(store.rows[0]!.sourceKind, "remote-zip");
  assert.equal(store.rows[0]!.sourceUrl, "https://legacy.example/marker-failure.zip");
  assert.equal(store.writes.length, 0);
  assert.equal(await store.readMetadata(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY), undefined);
});

test("SQLite retirement refuses a partial schema instead of committing a partial authority cleanup", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE extensions (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_url TEXT NOT NULL
    );
    CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  try {
    await assert.rejects(
      migrateLegacyExtensionSourcesInDatabase({ database }),
      (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
        && error.code === "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
    );
    assert.equal(
      database.prepare("SELECT value FROM storage_metadata WHERE key = ?").get(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY),
      undefined,
    );
  } finally {
    database.close();
  }
});

test("SQLite adapter commits row projection and marker together without touching dormant sources or bindings", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE extensions (
      id TEXT PRIMARY KEY, name TEXT, description TEXT, source_kind TEXT NOT NULL,
      source_url TEXT NOT NULL, source_id TEXT, store_id TEXT, store_url TEXT,
      store_namespace TEXT, provenance_json TEXT, artifact_archive_path TEXT,
      update_provider_id TEXT, update_state_json TEXT, version TEXT,
      manifest_version INTEGER, permissions_json TEXT, host_permissions_json TEXT,
      optional_permissions_json TEXT, optional_host_permissions_json TEXT,
      permission_risks_json TEXT, install_state TEXT, update_policy TEXT,
      sha256 TEXT, manifest_sha256 TEXT, local_path TEXT, manifest_key TEXT,
      last_installed_at TEXT, last_checked_at TEXT, last_error TEXT, status TEXT,
      created_at TEXT, updated_at TEXT
    );
    CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE extension_sources (id TEXT PRIMARY KEY, url TEXT NOT NULL);
    CREATE TABLE environment_extensions (
      environment_id TEXT NOT NULL, extension_id TEXT NOT NULL,
      lifecycle_revision TEXT, PRIMARY KEY(environment_id, extension_id)
    );
    INSERT INTO extension_sources VALUES ('source-1', 'https://legacy.example/index.json');
    INSERT INTO environment_extensions VALUES ('environment-1', 'extension-1', 'binding-revision');
  `);
  database.prepare(`
    INSERT INTO extensions (
      id, name, description, source_kind, source_url, source_id, store_id, version,
      manifest_version, permissions_json, host_permissions_json, optional_permissions_json,
      optional_host_permissions_json, permission_risks_json, install_state, update_policy,
      local_path, manifest_key, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "extension-1", "Legacy", "", "remote-crx", "https://legacy.example/current.crx",
    "source-1", CANONICAL_ID, "1.0.0", 3, "[]", "[]", "[]", "[]", "[]",
    "installed", "auto", "C:/legacy/package", "browser-key", "enabled",
    "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z",
  );
  database.prepare(`
    INSERT INTO extensions (
      id, name, description, source_kind, source_url, store_id, store_url,
      store_namespace, install_state, update_policy, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "extension-alias", "Legacy alias", "", "remote-zip", "https://legacy.example/alias.zip",
    "youxiaohoubox", "https://chromewebstore.google.com/detail/youxiaohoubox",
    "chrome-web-store", "metadata-only", "auto", "enabled",
    "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z",
  );
  try {
    const report = await migrateLegacyExtensionSourcesInDatabase({
      database,
      probeLocalPackage: async () => ({ localPathExists: true, localPackageReadable: true }),
      now: monotonicClock(),
    });
    assert.equal(report.counts.managedSnapshots, 1);
    assert.equal(report.counts.invalidId, 1);
    const row = database.prepare(`
      SELECT source_kind, source_url, source_id, provenance_json, update_provider_id,
             update_state_json, install_state, update_policy, manifest_key, updated_at
      FROM extensions WHERE id = 'extension-1'
    `).get() as Record<string, unknown>;
    assert.equal(row.source_kind, "managed-snapshot");
    assert.equal(row.source_url, "");
    assert.equal(row.source_id, null);
    assert.equal(row.install_state, "installed");
    assert.equal(row.update_policy, "pinned");
    assert.equal(row.manifest_key, "browser-key");
    assert.equal(row.updated_at, "2025-01-02T00:00:00.000Z");
    assert.equal(JSON.parse(row.provenance_json as string).artifact.legacySourceUrl, "https://legacy.example/current.crx");
    const alias = database.prepare(`
      SELECT source_kind, source_url, store_id, store_url, store_namespace, status
      FROM extensions WHERE id = 'extension-alias'
    `).get() as Record<string, unknown>;
    assert.equal(alias.source_kind, "managed-snapshot");
    assert.equal(alias.source_url, "");
    assert.equal(alias.store_id, "youxiaohoubox");
    assert.equal(alias.store_url, "https://chromewebstore.google.com/detail/youxiaohoubox");
    assert.equal(alias.store_namespace, null);
    assert.equal(alias.status, "disabled");
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM extension_sources").get() as { count: number }).count, 1);
    const binding = database.prepare("SELECT * FROM environment_extensions").get() as Record<string, unknown>;
    assert.deepEqual(
      { ...binding },
      { environment_id: "environment-1", extension_id: "extension-1", lifecycle_revision: "binding-revision" },
    );
    assert.ok(database.prepare("SELECT value FROM storage_metadata WHERE key = ?").get(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY));
  } finally {
    database.close();
  }
});

test("WAL-aware SQLite snapshot includes committed WAL state, reopens, validates, and is reusable", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "live.sqlite");
  const snapshotPath = path.join(directory, "snapshots", "before-retirement.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL; CREATE TABLE records(id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO records VALUES ('one', 'before');");
  database.prepare("INSERT INTO records VALUES (?, ?)").run("two", "wal-visible");
  const report = await createWalAwareSqliteSnapshot({ databasePath, snapshotPath, now: monotonicClock() });
  assert.equal(report.integrityCheck, "ok");
  assert.equal(report.tables.records, 2);
  assert.match(report.sha256, /^[0-9a-f]{64}$/);
  const snapshotDirectoryEntries = await fs.readdir(path.dirname(snapshotPath));
  assert.equal(snapshotDirectoryEntries.some((file) => file.startsWith("before-retirement.sqlite.tmp-")), false);
  const reopened = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    assert.equal((reopened.prepare("SELECT value FROM records WHERE id = 'two'").get() as { value: string }).value, "wal-visible");
    assert.equal((reopened.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  } finally {
    reopened.close();
  }
  const reused = await createWalAwareSqliteSnapshot({ databasePath, snapshotPath, now: monotonicClock() });
  assert.equal(reused.sha256, report.sha256);
  database.prepare("INSERT INTO records VALUES (?, ?)").run("three", "changed-after-snapshot");
  await assert.rejects(
    createWalAwareSqliteSnapshot({ databasePath, snapshotPath, now: monotonicClock() }),
    (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
      && error.code === "EXTENSION_SOURCE_SNAPSHOT_INVALID",
  );
  database.close();
});

test("snapshot rejects a live-path overwrite and invalid databases without leaving temp files", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "live.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE records(id TEXT PRIMARY KEY)");
  database.close();
  await assert.rejects(
    createWalAwareSqliteSnapshot({ databasePath, snapshotPath: databasePath }),
    (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
      && error.code === "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
  );
  const invalidPath = path.join(directory, "invalid.sqlite");
  await fs.writeFile(invalidPath, "not sqlite");
  await assert.rejects(
    createWalAwareSqliteSnapshot({ databasePath: invalidPath, snapshotPath: path.join(directory, "invalid-snapshot.sqlite") }),
    ExtensionSourceRetirementMigrationError,
  );
  const files = await fs.readdir(directory);
  assert.equal(files.some((file) => file.includes(".tmp-")), false);
});

test("snapshot refuses a symlinked parent instead of publishing outside the data root", async (t) => {
  const directory = await temporaryDirectory(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-snapshot-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const databasePath = path.join(directory, "live.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE records(id TEXT PRIMARY KEY)");
  database.close();
  const linkedParent = path.join(directory, "linked-backups");
  try {
    await fs.symlink(outside, linkedParent, "junction");
  } catch {
    // Some Windows configurations deny junction creation; the platform's
    // regular path checks remain covered by the preceding snapshot tests.
    return;
  }
  await assert.rejects(
    createWalAwareSqliteSnapshot({
      databasePath,
      snapshotPath: path.join(linkedParent, "before.sqlite"),
    }),
    (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
      && error.code === "EXTENSION_SOURCE_SNAPSHOT_PATH_INVALID",
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test("a failed retirement retains its rollback image and a retry publishes a distinct snapshot", async (t) => {
  const directory = await temporaryDirectory(t);
  const databasePath = path.join(directory, "live.sqlite");
  const snapshotPath = path.join(directory, "migration-backups", "before-retirement.sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE extensions (
      id TEXT PRIMARY KEY, source_kind TEXT NOT NULL, source_url TEXT NOT NULL
    );
    CREATE TABLE storage_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  database.close();
  const row = extensionFixture("retry", {
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/retry.zip",
    installState: "metadata-only",
  });

  await assert.rejects(
    runExtensionSourceRetirement({
      databasePath,
      snapshotPath,
      store: new FakeRetirementStore([row], { failOnWrite: true }),
      probeLocalPackage: async () => ({ localPathExists: false, localPackageReadable: false }),
      now: monotonicClock(),
    }),
    (error: unknown) => error instanceof ExtensionSourceRetirementMigrationError
      && error.code === "EXTENSION_SOURCE_MIGRATION_TRANSACTION_FAILED",
  );
  const firstImage = await fs.readFile(snapshotPath);

  const succeeded = await runExtensionSourceRetirement({
    databasePath,
    snapshotPath,
    store: new FakeRetirementStore([row]),
    probeLocalPackage: async () => ({ localPathExists: false, localPackageReadable: false }),
    now: monotonicClock(),
  });

  assert.equal(succeeded.status, "completed");
  assert.ok(succeeded.snapshot?.snapshotPath.startsWith(`${snapshotPath}.retry-`));
  assert.deepEqual(await fs.readFile(snapshotPath), firstImage);
  assert.equal(await fs.stat(succeeded.snapshot!.snapshotPath).then((stats) => stats.isFile()), true);
});

test("live SQLite adapter retires a legacy row without changing files, bindings, or timestamps", async (t) => {
  const directory = await temporaryDirectory(t);
  const packagePath = await writePackage(directory, "live-package");
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const environment = await repository.createProfile({ name: "Retirement Binding" });
  const extension = await repository.createExtension({
    id: "extension-live-legacy",
    name: "Live Legacy",
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/live.zip",
    sourceId: "legacy-source",
    storeId: CANONICAL_ID,
    localPath: packagePath,
    installState: "update-available",
    updatePolicy: "auto",
    manifestKey: "browser-key",
    updatedAt: "2025-02-03T00:00:00.000Z",
  });
  const originalUpdatedAt = extension.updatedAt;
  await repository.bindExtensionToEnvironments(extension.id, [environment.id]);
  const beforeBinding = await repository.listEnvironmentExtensionBindings(environment.id);
  repository.close();
  const databasePath = path.join(directory, "cbpanel.sqlite");
  const raw = new DatabaseSync(databasePath);
  raw.prepare(`
    INSERT INTO extension_sources (
      id, name, url, status, allow_unsigned_assets, last_refreshed_at,
      last_error, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "legacy-source", "Legacy source", "https://legacy.example/index.json", "enabled", 0,
    null, null, "2025-01-01T00:00:00.000Z", "2025-01-02T00:00:00.000Z",
  );
  raw.close();

  const migratedRepository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const snapshotPath = path.join(directory, "migration-backups", "before-retirement.sqlite");
  const report = await migratedRepository.retireLegacyExtensionSources(
    snapshotPath,
  );
  const migrated = await migratedRepository.getExtension(extension.id);
  assert.equal(report.counts.managedSnapshots, 1);
  assert.equal(migrated?.sourceKind, "managed-snapshot");
  assert.equal(migrated?.sourceUrl, "");
  assert.equal(migrated?.sourceId, undefined);
  assert.equal(migrated?.installState, "installed");
  assert.equal(migrated?.updatePolicy, "pinned");
  assert.equal(migrated?.localPath, packagePath);
  assert.equal(migrated?.manifestKey, "browser-key");
  assert.equal(migrated?.updatedAt, originalUpdatedAt);
  assert.equal(migrated?.provenance?.artifact.legacySourceUrl, "https://legacy.example/live.zip");
  assert.deepEqual(await migratedRepository.listEnvironmentExtensionBindings(environment.id), beforeBinding);
  assert.deepEqual(await fs.readFile(path.join(packagePath, "manifest.json")), Buffer.from(JSON.stringify({ name: "Legacy package", version: "1.0.0", manifest_version: 3 })));
  assert.equal(await fs.stat(snapshotPath).then(() => true), true);

  const rollback = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const rollbackExtension = rollback.prepare(`
      SELECT source_kind, source_url, source_id, updated_at
      FROM extensions WHERE id = ?
    `).get(extension.id) as Record<string, unknown>;
    assert.deepEqual({ ...rollbackExtension }, {
      source_kind: "remote-zip",
      source_url: "https://legacy.example/live.zip",
      source_id: "legacy-source",
      updated_at: originalUpdatedAt,
    });
    assert.deepEqual(
      { ...rollback.prepare("SELECT id, url FROM extension_sources WHERE id = 'legacy-source'").get() as Record<string, unknown> },
      { id: "legacy-source", url: "https://legacy.example/index.json" },
    );
    assert.deepEqual(
      { ...rollback.prepare("SELECT environment_id, extension_id, lifecycle_revision FROM environment_extensions").get() as Record<string, unknown> },
      {
        environment_id: environment.id,
        extension_id: extension.id,
        lifecycle_revision: beforeBinding[0]?.lifecycleRevision,
      },
    );
    assert.equal(
      rollback.prepare("SELECT value FROM storage_metadata WHERE key = ?").get(EXTENSION_SOURCE_RETIREMENT_MARKER_KEY),
      undefined,
    );
  } finally {
    rollback.close();
  }

  const second = await migratedRepository.retireLegacyExtensionSources(
    path.join(directory, "migration-backups", "ignored-on-noop.sqlite"),
  );
  assert.deepEqual(second, report);
  assert.equal(await fs.stat(path.join(directory, "migration-backups", "ignored-on-noop.sqlite")).then(() => true).catch(() => false), false);
  migratedRepository.close();
});

function extensionFixture(id: string, overrides: Partial<ExtensionEntity> = {}): ExtensionEntity {
  const timestamp = "2025-01-01T00:00:00.000Z";
  return {
    id: `extension-${id}`,
    name: `Legacy ${id}`,
    description: "legacy",
    sourceKind: "remote-zip",
    sourceUrl: "https://legacy.example/default.zip",
    version: "1.0.0",
    manifestVersion: 3,
    permissions: [],
    hostPermissions: [],
    permissionRisks: [],
    installState: "metadata-only",
    updatePolicy: "pinned",
    status: "enabled",
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

async function writePackage(root: string, name: string): Promise<string> {
  const directory = path.join(root, name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "manifest.json"),
    JSON.stringify({ name: "Legacy package", version: "1.0.0", manifest_version: 3 }),
  );
  return directory;
}

class FakeRetirementStore implements LegacySourceRetirementStore {
  rows: ExtensionEntity[];

  readonly writes: Array<{ id: string; patch: Partial<ExtensionEntity> }> = [];

  private metadata = new Map<string, string>();

  constructor(
    initialRows: ExtensionEntity[],
    private readonly options: {
      failOnWrite?: boolean;
      failAfterWrites?: number;
      failOnMarkerWrite?: boolean;
    } = {},
  ) {
    this.rows = initialRows.map((row) => cloneExtension(row));
  }

  async listExtensions(): Promise<ExtensionEntity[]> {
    return this.rows.map((row) => cloneExtension(row));
  }

  async transaction<T>(operation: () => Promise<T>): Promise<T> {
    const rows = this.rows.map((row) => cloneExtension(row));
    const metadata = new Map(this.metadata);
    const writesLength = this.writes.length;
    try {
      return await operation();
    } catch (error) {
      this.rows = rows;
      this.metadata = metadata;
      this.writes.length = writesLength;
      throw error;
    }
  }

  async updateExtensionExact(id: string, patch: Partial<ExtensionEntity>): Promise<void> {
    if (
      this.options.failOnWrite
      || (this.options.failAfterWrites !== undefined && this.writes.length >= this.options.failAfterWrites)
    ) throw new Error("injected migration write failure");
    const index = this.rows.findIndex((row) => row.id === id);
    if (index < 0) throw new Error("missing extension");
    this.writes.push({ id, patch: cloneExtension(patch as ExtensionEntity) });
    this.rows[index] = cloneExtension({ ...this.rows[index]!, ...patch });
  }

  async readMetadata(key: string): Promise<string | undefined> {
    return this.metadata.get(key);
  }

  async writeMetadata(key: string, value: string): Promise<void> {
    if (this.options.failOnWrite || this.options.failOnMarkerWrite) throw new Error("injected marker write failure");
    this.metadata.set(key, value);
  }
}

function cloneExtension<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function monotonicClock(): () => Date {
  let value = 1_700_000_000_000;
  return () => new Date(value += 1_000);
}

async function temporaryDirectory(t: test.TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-source-retirement-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
