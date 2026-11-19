import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExtensionProfileDataService } from "./extensionProfileDataService";

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const OTHER_ID = "ponmlkjihgfedcbaponmlkjihgfedcba";

async function makeProfile(root: string, environmentId: string): Promise<string> {
  const defaultDir = path.join(root, environmentId, "Default");
  await fs.mkdir(defaultDir, { recursive: true });
  return defaultDir;
}

async function tempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cbp-ext-profile-data-"));
}

test("removes the extension-keyed stores Chrome deletes on uninstall", async () => {
  const root = await tempRoot();
  const defaultDir = await makeProfile(root, "env-1");
  const service = new ExtensionProfileDataService({ browserDataDir: root });

  const keyed = [
    "Local Extension Settings",
    "Sync Extension Settings",
    "Extension State",
    "Extension Rules",
    "Extension Scripts",
    "Session Storage",
    "WebStorage",
    "blob_storage",
    "Local Storage/leveldb",
  ];
  for (const relative of keyed) {
    await fs.mkdir(path.join(defaultDir, ...relative.split("/"), EXTENSION_ID), { recursive: true });
    await fs.writeFile(path.join(defaultDir, ...relative.split("/"), EXTENSION_ID, "state"), "x");
  }
  await fs.mkdir(path.join(defaultDir, "IndexedDB", `chrome-extension_${EXTENSION_ID}_0.indexeddb.leveldb`), { recursive: true });
  await fs.mkdir(path.join(defaultDir, "IndexedDB", `chrome-extension_${EXTENSION_ID}_1.indexeddb.leveldb`), { recursive: true });
  await fs.mkdir(path.join(defaultDir, "Service Worker", "CacheStorage", `chrome-extension_${EXTENSION_ID}_0`), { recursive: true });

  const [result] = await service.removeExtensionData(EXTENSION_ID, ["env-1"]);

  assert.equal(result.environmentId, "env-1");
  assert.ok(result.removed.length >= keyed.length + 3, `removed: ${result.removed.join(", ")}`);
  for (const relative of keyed) {
    await assert.rejects(
      fs.access(path.join(defaultDir, ...relative.split("/"), EXTENSION_ID)),
      `${relative} must be gone`,
    );
  }
  const indexedDb = await fs.readdir(path.join(defaultDir, "IndexedDB"));
  assert.deepEqual(indexedDb, []);
  const cacheStorage = await fs.readdir(path.join(defaultDir, "Service Worker", "CacheStorage"));
  assert.deepEqual(cacheStorage, []);
  await fs.rm(root, { recursive: true, force: true });
});

// The whole point is that the *next* install starts empty. Anything keyed by another ID, by no ID, or
// belonging to the profile itself has to survive untouched.
test("leaves other extensions and unrelated profile state alone", async () => {
  const root = await tempRoot();
  const defaultDir = await makeProfile(root, "env-1");
  const service = new ExtensionProfileDataService({ browserDataDir: root });

  const otherDir = path.join(defaultDir, "Local Extension Settings", OTHER_ID);
  await fs.mkdir(otherDir, { recursive: true });
  await fs.writeFile(path.join(otherDir, "data"), "keep");
  const leveldb = path.join(defaultDir, "Local Storage", "leveldb");
  await fs.mkdir(leveldb, { recursive: true });
  await fs.writeFile(path.join(leveldb, "000003.log"), "other origin");
  const otherIndexedDb = path.join(defaultDir, "IndexedDB", `chrome-extension_${OTHER_ID}_0.indexeddb.leveldb`);
  await fs.mkdir(otherIndexedDb, { recursive: true });

  await service.removeExtensionData(EXTENSION_ID, ["env-1"]);

  assert.equal(await fs.readFile(path.join(otherDir, "data"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(leveldb, "000003.log"), "utf8"), "other origin");
  await fs.access(otherIndexedDb);
  await fs.rm(root, { recursive: true, force: true });
});

test("a running environment is reported as skipped and keeps its data", async () => {
  const root = await tempRoot();
  const defaultDir = await makeProfile(root, "env-1");
  const service = new ExtensionProfileDataService({ browserDataDir: root });
  const target = path.join(defaultDir, "Local Extension Settings", EXTENSION_ID);
  await fs.mkdir(target, { recursive: true });

  const [result] = await service.removeExtensionData(EXTENSION_ID, ["env-1"], new Set(["env-1"]));

  assert.deepEqual(result.removed, []);
  assert.equal(result.skipped.length, 1);
  await fs.access(target);
  await fs.rm(root, { recursive: true, force: true });
});

test("removes the registry entry so the next load is a fresh install", async () => {
  const root = await tempRoot();
  const defaultDir = await makeProfile(root, "env-1");
  const service = new ExtensionProfileDataService({ browserDataDir: root });
  const securePreferences = {
    extensions: { settings: { [EXTENSION_ID]: { path: "D:/old", location: 8 }, [OTHER_ID]: { path: "D:/other" } } },
    otherSection: { keep: true },
  };
  await fs.writeFile(path.join(defaultDir, "Secure Preferences"), JSON.stringify(securePreferences), "utf8");

  const [result] = await service.removeExtensionData(EXTENSION_ID, ["env-1"]);

  assert.ok(result.removed.includes("Secure Preferences"));
  const parsed = JSON.parse(await fs.readFile(path.join(defaultDir, "Secure Preferences"), "utf8")) as {
    extensions: { settings: Record<string, unknown> };
    otherSection: unknown;
  };
  assert.deepEqual(Object.keys(parsed.extensions.settings), [OTHER_ID]);
  assert.deepEqual(parsed.otherSection, { keep: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("an unparseable preferences file is skipped instead of corrupted", async () => {
  const root = await tempRoot();
  const defaultDir = await makeProfile(root, "env-1");
  const service = new ExtensionProfileDataService({ browserDataDir: root });
  const filePath = path.join(defaultDir, "Secure Preferences");
  await fs.writeFile(filePath, "{not json", "utf8");

  const [result] = await service.removeExtensionData(EXTENSION_ID, ["env-1"]);

  assert.match(result.skipped.join(" "), /无法解析/);
  assert.equal(await fs.readFile(filePath, "utf8"), "{not json");
  await fs.rm(root, { recursive: true, force: true });
});

test("a profile that never saw the extension is a no-op", async () => {
  const root = await tempRoot();
  await makeProfile(root, "env-1");
  const service = new ExtensionProfileDataService({ browserDataDir: root });

  const [result] = await service.removeExtensionData(EXTENSION_ID, ["env-1"]);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.skipped, []);
  await fs.rm(root, { recursive: true, force: true });
});
