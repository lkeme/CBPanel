import assert from "node:assert/strict";
import test from "node:test";
import { decodeAppBackupData } from "./appBackup";
import type { ExtensionEntity } from "./entities";
import { decodeEnvironmentPackageData } from "./environmentPackage";
import { normalizeSettings } from "./settings";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

test("schema-v1 transfer decoders strip acquisition authority instead of accepting hidden trust", () => {
  const extension = verifiedExtension();
  const backup = decodeAppBackupData({
    schemaVersion: 1,
    settings: normalizeSettings(),
    profiles: [],
    environments: [],
    groups: [],
    tags: [],
    proxies: [],
    extensions: [extension],
    extensionSources: [],
  });
  assert.equal(backup.schemaVersion, 1);
  assert.equal("provenance" in backup.extensions[0], false);
  assert.equal("artifactArchivePath" in backup.extensions[0], false);
  assert.equal("updateProviderId" in backup.extensions[0], false);

  const environmentPackage = decodeEnvironmentPackageData({
    schemaVersion: 1,
    environments: [],
    groups: [],
    extensions: [extension],
  });
  assert.equal(environmentPackage.schemaVersion, 1);
  assert.equal("storeIdentity" in environmentPackage.extensions[0], false);
  assert.equal("updateState" in environmentPackage.extensions[0], false);
});

test("schema-v2 transfer decoders retain only internally consistent acquisition authority", () => {
  const extension = verifiedExtension();
  const retainedExtensionArtifacts = [{
    extensionId: extension.id,
    archivePath: `extension-artifacts/${extension.id}/current.crx`,
    sha256: "a".repeat(64),
  }];
  const backup = decodeAppBackupData({
    schemaVersion: 2,
    settings: normalizeSettings(),
    profiles: [],
    environments: [],
    groups: [],
    tags: [],
    proxies: [],
    extensions: [extension],
    retainedExtensionArtifacts,
  });
  assert.equal(backup.schemaVersion, 2);
  assert.equal(backup.extensions[0]?.storeIdentity?.storeId, STORE_ID);
  assert.equal(backup.extensions[0]?.provenance?.verification.level, "cws-publisher-verified");

  const environmentPackage = decodeEnvironmentPackageData({
    schemaVersion: 2,
    environments: [],
    groups: [],
    extensions: [extension],
    retainedExtensionArtifacts,
  });
  assert.equal(environmentPackage.schemaVersion, 2);
  assert.equal(environmentPackage.extensions[0]?.updateProviderId, "chrome-web-store");
});

test("schema-v2 transfer decoders reject unknown trust and unsafe artifact entries", () => {
  const extension = verifiedExtension();
  const invalidProvider = {
    ...extension,
    provenance: {
      ...extension.provenance,
      artifact: { ...extension.provenance!.artifact, providerId: "unknown" },
    },
  };
  assert.throws(() => decodeAppBackupData({
    schemaVersion: 2,
    settings: normalizeSettings(),
    profiles: [],
    environments: [],
    groups: [],
    tags: [],
    proxies: [],
    extensions: [invalidProvider],
    retainedExtensionArtifacts: [],
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_ACQUISITION_CONTRACT_INVALID");
    return true;
  });

  assert.throws(() => decodeEnvironmentPackageData({
    schemaVersion: 2,
    environments: [],
    groups: [],
    extensions: [extension],
    retainedExtensionArtifacts: [{
      extensionId: extension.id,
      archivePath: "../outside.crx",
      sha256: "a".repeat(64),
    }],
  }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "ENVIRONMENT_PACKAGE_SCHEMA_INVALID");
    return true;
  });
});

function verifiedExtension(): ExtensionEntity {
  const artifactArchivePath = "D:/cbpanel/extension-artifacts/extension-store/current.crx";
  return {
    id: "extension-store",
    name: "Verified Extension",
    description: "",
    sourceKind: "local-crx",
    sourceUrl: artifactArchivePath,
    sha256: "a".repeat(64),
    manifestSha256: "c".repeat(64),
    storeId: STORE_ID,
    storeUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    storeIdentity: {
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      listingUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    },
    provenance: {
      schemaVersion: 1,
      artifact: {
        providerId: "chrome-web-store",
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: "2026-08-26T00:00:01.000Z",
        format: "crx3",
        size: 123,
        sha256: "a".repeat(64),
        retained: true,
      },
      verification: {
        level: "cws-publisher-verified",
        verifiedAt: "2026-08-26T00:00:02.000Z",
        proofDerivedStoreId: STORE_ID,
        developerKeySha256: "b".repeat(64),
        publisherTrustRootId: "chromium-cws",
        publisherTrustRootVersion: 1,
        manifestSha256: "c".repeat(64),
      },
    },
    artifactArchivePath,
    updateProviderId: "chrome-web-store",
    updateState: { status: "idle", checkedAt: "2026-08-26T00:00:03.000Z" },
    version: "1.0.0",
    permissions: [],
    hostPermissions: [],
    permissionRisks: [],
    installState: "installed",
    updatePolicy: "notify",
    status: "enabled",
    createdAt: "2026-08-26T00:00:00.000Z",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}
