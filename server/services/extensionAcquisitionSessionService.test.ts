import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { normalizeSettings } from "../../src/shared/settings";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { createCrx3VerifierForTesting } from "./crx3Verifier";
import { ExtensionAcquisitionError } from "./extensionAcquisitionService";
import { ExtensionAcquisitionSessionService } from "./extensionAcquisitionSessionService";
import type { ArtifactProvider } from "./extensionProviders/types";
import { createSyntheticStoreCrx3 } from "../testing/crx3Fixture";

test("acquisition session exposes only verified facts and is consumed exactly once", async () => {
  const directory = await makeTempDir();
  const fixture = createSyntheticStoreCrx3({
    name: "Verified Test Extension",
    permissions: ["storage"],
    hostPermissions: ["https://example.test/*"],
  });
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const verifier = createCrx3VerifierForTesting(fixture.publisherSpkiSha256);
  let committedSessionId: string | undefined;
  const service = new ExtensionAcquisitionSessionService({
    acquisitionRoot: path.join(directory, "extension-acquisitions"),
    repository,
    providerRegistry: registryFor(providerFor(fixture.bytes, "chrome-web-store")),
    readSettings: async () => normalizeSettings(),
    verifyFile: verifier.verifyFile,
    commitPrepared: async (acquisition) => {
      committedSessionId = acquisition.sessionId;
      return repository.createExtension({
        name: acquisition.package.name,
        sourceKind: "local-crx",
        sourceUrl: acquisition.artifactPath,
        version: acquisition.package.version,
        manifestVersion: acquisition.package.manifestVersion,
        permissions: acquisition.package.permissions,
        hostPermissions: acquisition.package.hostPermissions,
        optionalPermissions: acquisition.package.optionalPermissions,
        optionalHostPermissions: acquisition.package.optionalHostPermissions,
        permissionRisks: acquisition.package.permissionRisks,
        installState: "installed",
        localPath: acquisition.stagedRoot,
      });
    },
  });
  await service.initialize();

  const created = await service.create({
    namespace: "chrome-web-store",
    storeId: fixture.storeId,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  assert.ok(created.status === "created" || created.status === "downloading");
  const ready = await waitForStatus(service, created.sessionId, "ready");
  assert.equal(ready.report?.identity.matches, true);
  assert.equal(ready.report?.identity.proofDerivedStoreId, fixture.storeId);
  assert.equal(ready.report?.verification.developerKeySha256, fixture.developerSpkiSha256);
  assert.equal(ready.report?.package.name, "Verified Test Extension");
  assert.deepEqual(ready.report?.permissions, ["storage"]);
  assert.deepEqual(ready.report?.hostPermissions, ["https://example.test/*"]);
  assert.equal(JSON.stringify(ready).includes(directory), false);
  assert.equal(JSON.stringify(ready).includes("artifact.crx"), false);

  const confirmed = await service.confirm(created.sessionId, {
    disposition: "create",
    environmentIds: [],
  });
  assert.equal(confirmed.session.status, "consumed");
  assert.equal(committedSessionId, created.sessionId);
  await assert.rejects(
    service.confirm(created.sessionId, { disposition: "create" }),
    (error: unknown) => error instanceof ExtensionAcquisitionError && error.code === "ACQUISITION_SESSION_CONSUMED",
  );
  assert.equal(await exists(path.join(directory, "extension-acquisitions", created.sessionId)), false);
  repository.close();
});

test("provider disablement cancels an active download and reclaims its reservation", async () => {
  const directory = await makeTempDir();
  const fixture = createSyntheticStoreCrx3();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  let downloadStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    downloadStarted = resolve;
  });
  const provider: ArtifactProvider = {
    id: "crxsoso",
    offer: (storeId) => ({
      namespace: "chrome-web-store",
      storeId,
      artifactProviderId: "crxsoso",
      format: "crx3",
      providerLabel: "CRX搜搜",
    }),
    resolveCurrent: async (_input, signal) => {
      downloadStarted?.();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    },
  };
  const service = new ExtensionAcquisitionSessionService({
    acquisitionRoot: path.join(directory, "extension-acquisitions"),
    repository,
    providerRegistry: registryFor(provider),
    readSettings: async () => normalizeSettings(),
    maxGlobalTempBytes: 1024,
    perSessionTempBytes: 1024,
    commitPrepared: async () => {
      throw new Error("not used");
    },
  });
  await service.initialize();
  const created = await service.create({
    namespace: "chrome-web-store",
    storeId: fixture.storeId,
    artifactProviderId: "crxsoso",
    purpose: "install",
  });
  await started;
  service.settingsChanged(normalizeSettings({
    extensionAcquisition: { crxsosoArtifactEnabled: false },
  }));
  const cancelled = await waitForStatus(service, created.sessionId, "cancelled");
  assert.equal(cancelled.error?.code, "ARTIFACT_PROVIDER_DISABLED");
  assert.equal(await exists(path.join(directory, "extension-acquisitions", created.sessionId)), false);
  repository.close();
});

test("startup sweep treats disk sessions as non-authoritative derived work", async () => {
  const directory = await makeTempDir();
  const root = path.join(directory, "extension-acquisitions");
  await fs.mkdir(path.join(root, "stale-session"), { recursive: true });
  await fs.writeFile(path.join(root, "stale-session", "artifact.crx"), "stale", "utf8");
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const fixture = createSyntheticStoreCrx3();
  const service = new ExtensionAcquisitionSessionService({
    acquisitionRoot: root,
    repository,
    providerRegistry: registryFor(providerFor(fixture.bytes, "chrome-web-store")),
    readSettings: async () => normalizeSettings(),
    commitPrepared: async () => {
      throw new Error("not used");
    },
  });
  await service.initialize();
  assert.deepEqual(await fs.readdir(root), []);
  assert.deepEqual(service.list(), []);
  repository.close();
});

function providerFor(bytes: Uint8Array, id: "chrome-web-store" | "crxsoso"): ArtifactProvider {
  return {
    id,
    offer: (storeId) => ({
      namespace: "chrome-web-store",
      storeId,
      artifactProviderId: id,
      format: "crx3",
      providerLabel: id,
    }),
    resolveCurrent: async (input, signal) => {
      if (signal.aborted) throw signal.reason;
      await fs.mkdir(path.dirname(input.destinationPath), { recursive: true });
      await fs.writeFile(input.destinationPath, bytes);
      return {
        namespace: "chrome-web-store",
        storeId: input.storeId,
        artifactProviderId: id,
        format: "crx3",
        download: {
          path: input.destinationPath,
          size: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
          finalHost: id === "chrome-web-store" ? "clients2.googleusercontent.com" : "c2.crxsoso.com",
          fetchedAt: new Date().toISOString(),
        },
      };
    },
  };
}

function registryFor(provider: ArtifactProvider): { artifact: (id: "chrome-web-store" | "crxsoso") => ArtifactProvider } {
  return {
    artifact: (id) => {
      assert.equal(id, provider.id);
      return provider;
    },
  };
}

async function waitForStatus(
  service: ExtensionAcquisitionSessionService,
  sessionId: string,
  status: "ready" | "cancelled",
): Promise<ReturnType<ExtensionAcquisitionSessionService["get"]>> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const session = service.get(sessionId);
    if (session.status === status) return session;
    if (session.status === "rejected" || session.status === "expired") {
      throw new Error(`Session ended as ${session.status}: ${session.error?.code}`);
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${status}.`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-acquisition-session-"));
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}
