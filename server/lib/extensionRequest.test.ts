import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import {
  payloadTooLargeMessage,
  readBindEnvironmentIds,
  readDirectoryMode,
  readExtensionPreferencePatch,
  readImportConflictHeaders,
  readImportConflictOptions,
  readLegacyRemoteExtensionCreateBody,
  readUnbindEnvironmentIds,
  readUploadedArchive,
} from "./extensionRequest";

test("readUploadedArchive accepts non-empty buffers and rejects empty or non-buffer bodies", () => {
  const body = Buffer.from([1, 2, 3]);
  assert.equal(readUploadedArchive(body), body);

  for (const invalid of [undefined, null, {}, Buffer.alloc(0), "bytes"]) {
    assert.throws(
      () => readUploadedArchive(invalid),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.match((error as Error).message, /上传内容为空/);
        return true;
      },
    );
  }
});

test("payloadTooLargeMessage maps body-parser entity.too.large errors to a readable limit", () => {
  assert.equal(payloadTooLargeMessage(new Error("unrelated")), undefined);
  assert.equal(payloadTooLargeMessage({ type: "entity.too.large", limit: 200 * 1024 * 1024 }), "上传内容超过大小限制（200MB）。");
  assert.equal(payloadTooLargeMessage({ type: "entity.too.large" }), "上传内容超过大小限制。");
});

test("readDirectoryMode defaults to copy and rejects unknown values with a coded 400", () => {
  assert.equal(readDirectoryMode(undefined), "copy");
  assert.equal(readDirectoryMode(null), "copy");
  assert.equal(readDirectoryMode("copy"), "copy");
  assert.equal(readDirectoryMode("reference"), "reference");

  for (const invalid of ["Copy", "link", 1, {}]) {
    assert.throws(
      () => readDirectoryMode(invalid),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.equal((error as { code?: string }).code, "EXTENSION_DIRECTORY_MODE_INVALID");
        assert.match((error as Error).message, /must be copy or reference/);
        return true;
      },
    );
  }
});

test("readImportConflictOptions and headers accept reuse/overwrite/create", () => {
  assert.deepEqual(readImportConflictOptions(undefined), {});
  assert.deepEqual(
    readImportConflictOptions({ conflictDisposition: "overwrite", conflictExtensionId: "extension-1" }),
    { conflictDisposition: "overwrite", conflictExtensionId: "extension-1" },
  );
  assert.deepEqual(
    readImportConflictHeaders({
      "x-cbpanel-conflict-disposition": "reuse",
      "x-cbpanel-conflict-extension-id": "extension-2",
    }),
    { conflictDisposition: "reuse", conflictExtensionId: "extension-2" },
  );
  assert.throws(
    () => readImportConflictOptions({ conflictDisposition: "merge" }),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.equal((error as { code?: string }).code, "EXTENSION_IMPORT_DISPOSITION_INVALID");
      return true;
    },
  );
});

test("extension preference patches construct a strict status/update-policy allowlist", () => {
  const body = {
    name: "Renamed",
    status: "disabled",
    updatePolicy: "auto",
    sourceKind: "remote-zip",
    manifestKey: "attacker-key",
    manifestSha256: "f".repeat(64),
    directoryMode: "reference",
    localPath: "C:/elsewhere",
    installState: "installed",
    permissions: ["cookies"],
    hostPermissions: ["<all_urls>"],
    permissionRisks: [],
    manifestVersion: 2,
    lastInstalledAt: "2020-01-01T00:00:00.000Z",
    lastCheckedAt: "2020-01-01T00:00:00.000Z",
    lastError: "spoofed",
  };

  assert.deepEqual(readExtensionPreferencePatch(body), { status: "disabled", updatePolicy: "auto" });
  assert.deepEqual(readExtensionPreferencePatch(undefined), {});
  assert.deepEqual(readExtensionPreferencePatch("nonsense"), {});
  assert.throws(() => readExtensionPreferencePatch({ status: "paused" }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_STATUS_INVALID");
    return true;
  });
  assert.throws(() => readExtensionPreferencePatch({ updatePolicy: "mirror" }), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_UPDATE_POLICY_INVALID");
    return true;
  });
});

test("legacy remote creation has a separate bounded decoder", () => {
  assert.deepEqual(readLegacyRemoteExtensionCreateBody({
    sourceKind: "remote-crx",
    sourceUrl: " https://example.com/extension.crx ",
    sha256: "A".repeat(64),
    storeId: "attacker-store-id",
    provenance: { verification: { level: "cws-publisher-verified" } },
  }), {
    sourceKind: "remote-crx",
    sourceUrl: "https://example.com/extension.crx",
    sha256: "a".repeat(64),
  });
  for (const invalid of [
    {},
    { sourceKind: "local-crx", sourceUrl: "https://example.com/a.crx", sha256: "a".repeat(64) },
    { sourceKind: "remote-crx", sourceUrl: "", sha256: "a".repeat(64) },
    { sourceKind: "remote-crx", sourceUrl: "https://example.com/a.crx", sha256: "bad" },
  ]) {
    assert.throws(() => readLegacyRemoteExtensionCreateBody(invalid), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      return true;
    });
  }
});

test("sanitized PUT bodies cannot rewrite the pinned identity or the copy snapshot", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const extension = await repository.createExtension({
    name: "Pinned Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "source"),
    localPath: path.join(directory, "extensions", "snapshot"),
    manifestKey: "pinned-key",
    manifestSha256: "a".repeat(64),
    directoryMode: "copy",
    installState: "installed",
  });

  const updated = await repository.updateExtension(
    extension.id,
    readExtensionPreferencePatch(
      {
        status: "disabled",
        manifestKey: "attacker-key",
        manifestSha256: "b".repeat(64),
        directoryMode: "reference",
        installState: "local-missing",
        localPath: path.join(directory, "hijacked"),
        sourceKind: "remote-zip",
      },
    ),
  );

  assert.equal(updated.name, "Pinned Extension");
  assert.equal(updated.status, "disabled");
  assert.equal(updated.manifestKey, "pinned-key");
  // A client-writable content fingerprint would let a caller aim the import dedupe layers at an
  // unrelated record, so it is server-owned like the pinned key.
  assert.equal(updated.manifestSha256, "a".repeat(64));
  assert.equal(updated.directoryMode, "copy");
  assert.equal(updated.installState, "installed");
  assert.equal(updated.localPath, path.join(directory, "extensions", "snapshot"));
  assert.equal(updated.sourceKind, "local-directory");

  repository.close();
});

test("bind rejects non-array environmentIds and treats an absent field as empty", () => {
  assert.deepEqual(readBindEnvironmentIds(undefined), []);
  assert.deepEqual(readBindEnvironmentIds(null), []);
  assert.deepEqual(readBindEnvironmentIds(["env-1", 7, "env-2"]), ["env-1", "env-2"]);

  for (const invalid of ["env-1", 7, { id: "env-1" }]) {
    assert.throws(
      () => readBindEnvironmentIds(invalid),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.match((error as Error).message, /must be an array/);
        return true;
      },
    );
  }
});

test("unbind keeps the absent-field 'all' contract but rejects a present non-array field", () => {
  assert.equal(readUnbindEnvironmentIds(undefined), undefined);
  assert.equal(readUnbindEnvironmentIds(null), undefined);
  assert.deepEqual(readUnbindEnvironmentIds([]), []);
  assert.deepEqual(readUnbindEnvironmentIds(["env-1"]), ["env-1"]);

  assert.throws(
    () => readUnbindEnvironmentIds("env-1"),
    (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /must be an array/);
      return true;
    },
  );
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-extension-request-"));
}
