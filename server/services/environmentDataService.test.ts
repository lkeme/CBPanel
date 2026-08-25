import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EnvironmentDataService } from "./environmentDataService";

test("removeEnvironmentData deletes existing directories and tolerates unknown ids", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const service = new EnvironmentDataService({ browserDataDir });
  await writeEnvironmentData(browserDataDir, "profile-alive");
  await writeEnvironmentData(browserDataDir, "profile-doomed");

  const result = await service.removeEnvironmentData(["profile-doomed", "profile-never-launched"]);

  // An environment without a directory is neither a warning nor a removal: it was simply never launched.
  assert.deepEqual(result.removed, ["profile-doomed"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-doomed")), false);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-alive")), true);

  await fs.rm(directory, { recursive: true, force: true });
});

test("runtime-only cleanup does not inflate the browser-data removal count", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const extensionRuntimeDir = path.join(directory, "extension-runtimes");
  await fs.mkdir(path.join(extensionRuntimeDir, "profile-runtime-only", "extension-one"), { recursive: true });
  const service = new EnvironmentDataService({ browserDataDir, extensionRuntimeDir });

  const result = await service.removeEnvironmentData(["profile-runtime-only"]);

  assert.deepEqual(result.removed, []);
  assert.deepEqual(result.warnings, []);
  assert.equal(await pathExists(path.join(extensionRuntimeDir, "profile-runtime-only")), false);
  await fs.rm(directory, { recursive: true, force: true });
});

test("browser-data success remains counted when runtime cleanup fails", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const extensionRuntimeDir = path.join(directory, "extension-runtimes");
  await writeEnvironmentData(browserDataDir, "profile-partial");
  await fs.mkdir(path.join(extensionRuntimeDir, "profile-partial", "extension-one"), { recursive: true });
  class FailingRuntimeCleanupService extends EnvironmentDataService {
    protected override async removeDirectory(target: string): Promise<void> {
      if (target.startsWith(extensionRuntimeDir)) throw new Error("runtime locked");
      await super.removeDirectory(target);
    }
  }
  const service = new FailingRuntimeCleanupService({ browserDataDir, extensionRuntimeDir });

  const result = await service.removeEnvironmentData(["profile-partial"]);

  assert.deepEqual(result.removed, ["profile-partial"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!, /extension runtime data.*runtime locked/);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-partial")), false);
  assert.equal(await pathExists(path.join(extensionRuntimeDir, "profile-partial")), true);
  await fs.rm(directory, { recursive: true, force: true });
});

test("removeEnvironmentData reports a rejected id as a warning without dropping the rest", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const service = new EnvironmentDataService({ browserDataDir });
  await writeEnvironmentData(browserDataDir, "profile-keep");
  await writeEnvironmentData(browserDataDir, "profile-doomed");
  const outsideFile = path.join(directory, "outside.txt");
  await fs.writeFile(outsideFile, "outside", "utf8");

  const result = await service.removeEnvironmentData(["..", "", path.join("..", "outside.txt"), "profile-doomed"]);

  // A refusal must not abort the ids behind it: on Windows a single busy directory would otherwise leave
  // every later environment's data behind.
  assert.deepEqual(result.removed, ["profile-doomed"]);
  assert.equal(result.warnings.length, 3);
  assert.equal(await pathExists(outsideFile), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-keep")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-doomed")), false);

  await fs.rm(directory, { recursive: true, force: true });
});

// What emptying the trash does with a session stuck in an unconfirmed close: the rows all go, so refusing
// the whole batch over one id would leave every other environment's data stranded with nothing left to name
// it. The held directory is skipped instead of attempted — an rm would strip a live browser's profile around
// its locked files — and reported, because a silent skip leaves reclaimable space unaccounted for. The
// browser-data prune takes it once the process is gone.
test("removeEnvironmentData skips an id a browser may still hold and reports it instead of failing the batch", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const service = new EnvironmentDataService({ browserDataDir });
  await writeEnvironmentData(browserDataDir, "profile-held");
  await writeEnvironmentData(browserDataDir, "profile-free");

  const result = await service.removeEnvironmentData(
    ["profile-held", "profile-free"],
    new Set(["profile-held"]),
  );

  assert.deepEqual(result.removed, ["profile-free"]);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /profile-held/);
  // Untouched, not half-deleted: the skip happens before the directory is even resolved.
  assert.equal(await pathExists(path.join(browserDataDir, "profile-held", "Cookies")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-free")), false);

  await fs.rm(directory, { recursive: true, force: true });
});

test("pruneOrphanEnvironmentData removes orphan directories and keeps registered ones", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const service = new EnvironmentDataService({ browserDataDir });
  await writeEnvironmentData(browserDataDir, "profile-active");
  await writeEnvironmentData(browserDataDir, "profile-trashed");
  await writeEnvironmentData(browserDataDir, "profile-orphan");
  await fs.writeFile(path.join(browserDataDir, "notes.txt"), "loose file", "utf8");

  // The trashed id must be part of the known set: restoreEnvironment brings the row back and expects
  // its browser data to still be there.
  const result = await service.pruneOrphanEnvironmentData(async () => ["profile-active", "profile-trashed"]);

  assert.deepEqual(result.removed, ["profile-orphan"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-orphan")), false);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-active", "Cookies")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-trashed", "Cookies")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "notes.txt")), true);

  await fs.rm(directory, { recursive: true, force: true });
});

test("pruneOrphanEnvironmentData succeeds when the browser data directory does not exist", async () => {
  const directory = await makeTempDir();
  const service = new EnvironmentDataService({ browserDataDir: path.join(directory, "browser-data") });

  const result = await service.pruneOrphanEnvironmentData(async () => ["profile-active"]);

  assert.deepEqual(result, { removed: [], warnings: [] });

  await fs.rm(directory, { recursive: true, force: true });
});

// The window that made data loss possible: the route used to read the registered ids and only then let the
// directories be listed, so an environment created and launched in between was missing from the known set
// while its brand new directory was already in the listing — and it was deleted as an orphan. The resolver
// stands in for that create without depending on real timing:
//
// - `profile-appeared-mid-prune` is created *by* the resolver, so it can only be in the listing if the
//   listing happened afterwards — which is exactly the order this pins. Reading the ids first would have
//   put this directory into the following readdir with nothing registered under its name, and that is the
//   assertion that turns red if the two reads are swapped back.
// - `profile-registered-late` is the control the resolver has to be asked about at all: it is on disk and
//   registered, so it survives either way. Its name says where a real create would have landed; only the
//   fixture above distinguishes the two orders.
test("pruneOrphanEnvironmentData reads the known ids after the directory list, so a concurrent create survives", async () => {
  const directory = await makeTempDir();
  const browserDataDir = path.join(directory, "browser-data");
  const service = new EnvironmentDataService({ browserDataDir });
  await writeEnvironmentData(browserDataDir, "profile-active");
  await writeEnvironmentData(browserDataDir, "profile-orphan");
  await writeEnvironmentData(browserDataDir, "profile-registered-late");
  let reads = 0;

  const result = await service.pruneOrphanEnvironmentData(async () => {
    reads += 1;
    await writeEnvironmentData(browserDataDir, "profile-appeared-mid-prune");
    return ["profile-active", "profile-registered-late"];
  });

  assert.equal(reads, 1);
  assert.deepEqual(result.removed, ["profile-orphan"]);
  assert.deepEqual(result.warnings, []);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-registered-late", "Cookies")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-appeared-mid-prune", "Cookies")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-active", "Cookies")), true);
  assert.equal(await pathExists(path.join(browserDataDir, "profile-orphan")), false);

  await fs.rm(directory, { recursive: true, force: true });
});

async function writeEnvironmentData(browserDataDir: string, id: string): Promise<void> {
  await fs.mkdir(path.join(browserDataDir, id, "Default"), { recursive: true });
  await fs.writeFile(path.join(browserDataDir, id, "Cookies"), "cookie-db", "utf8");
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-environment-data-"));
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}
