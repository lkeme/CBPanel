import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeSettings } from "../../src/shared/settings";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import {
  createSyntheticCrx3SigningKeys,
  createSyntheticStoreCrx3,
} from "../testing/crx3Fixture";
import { createCrx3VerifierForTesting } from "./crx3Verifier";
import type { PreparedExtensionAcquisition } from "./extensionAcquisitionSessionService";
import { preflightExtensionPackage } from "./extensionPackagePreflight";
import { ExtensionService } from "./extensionService";

for (const phase of [
  "prepared",
  "files-published",
  "database-written",
  "database-committed",
  "complete",
] as const) {
  test(`verified acquisition commit converges after a ${phase} fault`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-acquisition-commit-"));
    const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
    const fixture = createSyntheticStoreCrx3({ name: "Atomic Extension", version: "2.0.0" });
    const verifier = createCrx3VerifierForTesting(fixture.publisherSpkiSha256);
    const prepared = await prepareAcquisition(directory, fixture.bytes, fixture.storeId, verifier.verifyFile);
    let injected = false;
    const service = new ExtensionService({
      repository,
      extensionCacheDir: path.join(directory, "extensions"),
      extensionArchiveDir: path.join(directory, "extension-archives"),
      extensionArtifactDir: path.join(directory, "extension-artifacts"),
      extensionAcquisitionDir: path.join(directory, "extension-acquisitions"),
      readSettings: async () => normalizeSettings(),
      verifyStoreCrxFileForTesting: verifier.verifyFile,
      acquisitionCommitFaultForTesting: (current) => {
        if (!injected && current === phase) {
          injected = true;
          throw new Error(`fault:${phase}`);
        }
      },
      activeEnvironmentIds: () => new Set(),
    });
    await service.initialize();

    const commitsDatabase = phase === "database-written" || phase === "database-committed" || phase === "complete";
    if (commitsDatabase) {
      const extension = await service.commitPreparedAcquisition(prepared, { disposition: "create" });
      assert.equal(extension.storeIdentity?.storeId, fixture.storeId);
      assert.equal(extension.provenance?.verification.level, "cws-publisher-verified");
      assert.equal(extension.manifestKey, fixture.developerSpkiBase64);
      assert.equal(await exists(path.join(directory, "extension-artifacts", extension.id, "current.crx")), true);
      assert.equal(await exists(path.join(directory, "extensions", extension.id, "manifest.json")), true);
      const manifest = JSON.parse(await fs.readFile(path.join(directory, "extensions", extension.id, "manifest.json"), "utf8"));
      assert.equal(manifest.key, fixture.developerSpkiBase64);
    } else {
      await assert.rejects(
        service.commitPreparedAcquisition(prepared, { disposition: "create" }),
        (error: unknown) => (error as { code?: string }).code === "ACQUISITION_COMMIT_FAILED",
      );
      assert.equal((await repository.listExtensions()).length, 0);
      assert.equal(await exists(prepared.artifactPath), true);
      assert.equal(await exists(prepared.stagedRoot), true);
    }
    assert.deepEqual(await fs.readdir(path.join(directory, "extension-acquisition-journal")), []);
    repository.close();
  });
}

test("verified metadata upgrade preserves identity and bindings while added permissions fail closed", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-acquisition-upgrade-"));
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const environment = await repository.createProfile({ name: "Persistent Upgrade Environment" });
  const signingKeys = createSyntheticCrx3SigningKeys();
  const initialFixture = createSyntheticStoreCrx3({
    name: "Upgradeable Extension",
    version: "1.0.0",
    permissions: ["storage"],
    signingKeys,
  });
  const verifier = createCrx3VerifierForTesting(initialFixture.publisherSpkiSha256);
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    extensionArchiveDir: path.join(directory, "extension-archives"),
    extensionArtifactDir: path.join(directory, "extension-artifacts"),
    extensionAcquisitionDir: path.join(directory, "extension-acquisitions"),
    readSettings: async () => normalizeSettings(),
    verifyStoreCrxFileForTesting: verifier.verifyFile,
    activeEnvironmentIds: () => new Set(),
  });
  await service.initialize();
  const initial = await service.commitPreparedAcquisition(
    await prepareAcquisition(
      directory,
      initialFixture.bytes,
      initialFixture.storeId,
      verifier.verifyFile,
      "abcdefghijklmnopqrstuvwxyzABCDEF",
    ),
    { disposition: "create", environmentIds: [environment.id] },
  );
  const originalBinding = (await repository.listEnvironmentExtensionBindings(environment.id))[0];
  assert.ok(originalBinding?.lifecycleRevision);
  await fs.mkdir(path.join(directory, "browser-data", environment.id), { recursive: true });
  await fs.writeFile(path.join(directory, "browser-data", environment.id, "sentinel"), "browser-state", "utf8");

  const updateFixture = createSyntheticStoreCrx3({
    name: "Upgradeable Extension",
    version: "2.0.0",
    permissions: ["storage"],
    signingKeys,
  });
  const updatePrepared = await prepareAcquisition(
      directory,
      updateFixture.bytes,
      updateFixture.storeId,
      verifier.verifyFile,
      "abcdefghijklmnopqrstuvwxyzABCDEG",
    );
  updatePrepared.conflictCandidates = [{
    extensionId: initial.id,
    name: initial.name,
    version: initial.version,
    installState: initial.installState,
    matchBy: "store-identity",
    eligible: true,
  }];
  const updated = await service.commitPreparedAcquisition(
    updatePrepared,
    { disposition: "upgrade", targetExtensionId: initial.id, environmentIds: [environment.id] },
  );
  assert.equal(updated.id, initial.id);
  assert.equal(updated.createdAt, initial.createdAt);
  assert.equal(updated.manifestKey, initial.manifestKey);
  assert.equal(updated.version, "2.0.0");
  assert.equal(
    (await repository.listEnvironmentExtensionBindings(environment.id))[0]?.lifecycleRevision,
    originalBinding.lifecycleRevision,
  );
  assert.equal(await fs.readFile(path.join(directory, "browser-data", environment.id, "sentinel"), "utf8"), "browser-state");

  const riskyFixture = createSyntheticStoreCrx3({
    name: "Upgradeable Extension",
    version: "3.0.0",
    permissions: ["storage", "cookies"],
    signingKeys,
  });
  const risky = await prepareAcquisition(
    directory,
    riskyFixture.bytes,
    riskyFixture.storeId,
    verifier.verifyFile,
    "abcdefghijklmnopqrstuvwxyzABCDEH",
  );
  risky.conflictCandidates = [{
    extensionId: initial.id,
    name: initial.name,
    version: updated.version,
    installState: updated.installState,
    matchBy: "store-identity",
    eligible: true,
  }];
  risky.purpose = "update";
  risky.targetExtensionId = initial.id;
  risky.targetUpdatedAt = updated.updatedAt;
  risky.permissionApprovalToken = "abcdefghijklmnopqrstuvwxyzABCDEJ";
  risky.addedPermissions = ["cookies"];
  await assert.rejects(
    service.commitPreparedAcquisition(risky, {
      disposition: "upgrade",
      targetExtensionId: initial.id,
    }),
    (error: unknown) => (error as { code?: string }).code === "ACQUISITION_PERMISSION_INCREASE",
  );
  assert.equal((await repository.getExtension(initial.id))?.version, "2.0.0");
  assert.equal(await exists(risky.artifactPath), true);
  const approved = await service.commitPreparedAcquisition(risky, {
    disposition: "upgrade",
    targetExtensionId: initial.id,
    permissionApprovalToken: risky.permissionApprovalToken,
  });
  assert.equal(approved.version, "3.0.0");
  assert.deepEqual(approved.permissions.sort(), ["cookies", "storage"]);
  repository.close();
});

test("one canonical metadata-only row upgrades in place after verified acquisition", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-acquisition-metadata-"));
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const fixture = createSyntheticStoreCrx3({ name: "Metadata Extension", version: "1.0.0" });
  const metadata = await repository.createExtension({
    id: "metadata-extension",
    name: "Metadata Extension",
    sourceKind: "chrome-web-store",
    sourceUrl: "",
    storeId: fixture.storeId,
    storeUrl: `https://chromewebstore.google.com/detail/${fixture.storeId}`,
    storeIdentity: {
      namespace: "chrome-web-store",
      storeId: fixture.storeId,
      listingUrl: `https://chromewebstore.google.com/detail/${fixture.storeId}`,
    },
    installState: "metadata-only",
  });
  const verifier = createCrx3VerifierForTesting(fixture.publisherSpkiSha256);
  const service = new ExtensionService({
    repository,
    extensionCacheDir: path.join(directory, "extensions"),
    extensionArtifactDir: path.join(directory, "extension-artifacts"),
    extensionAcquisitionDir: path.join(directory, "extension-acquisitions"),
    readSettings: async () => normalizeSettings(),
    verifyStoreCrxFileForTesting: verifier.verifyFile,
    activeEnvironmentIds: () => new Set(),
  });
  await service.initialize();
  const prepared = await prepareAcquisition(directory, fixture.bytes, fixture.storeId, verifier.verifyFile);
  prepared.conflictCandidates = [{
    extensionId: metadata.id,
    name: metadata.name,
    version: metadata.version,
    installState: "metadata-only",
    matchBy: "store-identity",
    eligible: true,
  }];
  const installed = await service.commitPreparedAcquisition(prepared, {
    disposition: "upgrade",
    targetExtensionId: metadata.id,
  });
  assert.equal(installed.id, metadata.id);
  assert.equal(installed.createdAt, metadata.createdAt);
  assert.equal(installed.installState, "installed");
  assert.equal(installed.updateProviderId, "chrome-web-store");
  assert.equal(installed.provenance?.verification.developerKeySha256, fixture.developerSpkiSha256);
  repository.close();
});

async function prepareAcquisition(
  directory: string,
  bytes: Uint8Array,
  storeId: string,
  verifyFile: ReturnType<typeof createCrx3VerifierForTesting>["verifyFile"],
  sessionId = "abcdefghijklmnopqrstuvwxyzABCDEF",
): Promise<PreparedExtensionAcquisition> {
  const root = path.join(directory, "extension-acquisitions", sessionId);
  const artifactPath = path.join(root, "artifact.crx");
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(artifactPath, bytes);
  const verification = await verifyFile(artifactPath, storeId);
  const packageFacts = await preflightExtensionPackage({
    archivePath: artifactPath,
    archiveOffset: verification.zipOffset,
    archiveLength: verification.zipSize,
    stagingDir: path.join(root, "unpacked"),
  });
  const timestamp = new Date().toISOString();
  return {
    sessionId,
    purpose: "install",
    storeId,
    selectedProviderId: "chrome-web-store",
    artifactPath,
    stagedRoot: packageFacts.stagedRoot,
    verification,
    package: packageFacts,
    conflictCandidates: [],
    addedPermissions: [],
    report: {
      sessionId,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      identity: {
        namespace: "chrome-web-store",
        requestedStoreId: storeId,
        proofDerivedStoreId: storeId,
        matches: true,
      },
      package: {
        name: packageFacts.name,
        description: packageFacts.description,
        version: packageFacts.version,
        manifestVersion: packageFacts.manifestVersion,
        format: "crx3",
        size: verification.crxSize,
        sha256: verification.crxSha256,
        manifestSha256: packageFacts.manifestSha256,
        treeSha256: packageFacts.treeSha256,
        entryCount: packageFacts.entryCount,
        filesystemNodeCount: packageFacts.filesystemNodeCount,
        fileCount: packageFacts.fileCount,
        expandedBytes: packageFacts.expandedBytes,
      },
      transport: {
        selectedProviderId: "chrome-web-store",
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: timestamp,
        durationMs: 1,
      },
      verification: {
        level: "cws-publisher-verified",
        developerKeySha256: verification.developerSpkiSha256,
        publisherTrustRootId: verification.publisherTrustRootId,
        publisherTrustRootVersion: verification.publisherTrustRootVersion,
        developerProofAlgorithm: verification.developerProofAlgorithm,
        publisherProofAlgorithm: verification.publisherProofAlgorithm,
      },
      permissions: packageFacts.permissions,
      hostPermissions: packageFacts.hostPermissions,
      optionalPermissions: packageFacts.optionalPermissions,
      optionalHostPermissions: packageFacts.optionalHostPermissions,
      permissionRisks: packageFacts.permissionRisks,
      discrepancies: packageFacts.discrepancies,
      conflicts: [],
    },
  };
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
