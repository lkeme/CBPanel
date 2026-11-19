import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExtensionAcquisitionCommitJournal,
  ExtensionCommitJournalCreateError,
  normalizeExtensionCommitJournal,
  type ExtensionCommitJournalRecord,
} from "./extensionAcquisitionCommitJournal";

test("create exposes a canonical journal that was renamed before directory sync failed", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-extension-journal-sync-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const journalRoot = path.join(root, "journals");
  const artifactRoot = path.join(root, "managed", "artifacts");
  const treeRoot = path.join(root, "managed", "trees");
  const sessionRoot = path.join(root, "sessions");
  let failSync = true;
  const journal = new ExtensionAcquisitionCommitJournal({
    journalRoot,
    allowedRoots: [artifactRoot, treeRoot, sessionRoot],
    syncDirectoryForTesting: async () => {
      if (!failSync) return;
      failSync = false;
      throw new Error("injected directory sync failure");
    },
  });
  await journal.initialize();
  const fixture = {
    root,
    journalRoot,
    managedRoot: path.join(root, "managed"),
    artifactRoot,
    treeRoot,
    sessionRoot,
    journal,
  };
  let published: ExtensionCommitJournalCreateError | undefined;
  await assert.rejects(
    journal.create(journalInput(fixture)),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionCommitJournalCreateError);
      published = error;
      return true;
    },
  );
  assert.ok(published);
  assert.equal(published.record.phase, "prepared");
  assert.deepEqual(await journal.list(), [published.record]);
});

test("commit journal persists strict ordered phases and removes complete records", async (context) => {
  const fixture = await makeFixture(context);
  let record = await fixture.journal.create(journalInput(fixture));
  assert.equal(record.phase, "prepared");
  assert.equal((await fixture.journal.list()).length, 1);
  record = await fixture.journal.advance(record, "files-published");
  record = await fixture.journal.advance(record, "database-committed");
  record = await fixture.journal.advance(record, "complete");
  await fixture.journal.remove(record);
  assert.deepEqual(await fixture.journal.list(), []);
});

test("journal rejects skipped phases, path escapes, linked roots, and malformed evidence", async (context) => {
  const fixture = await makeFixture(context);
  const record = await fixture.journal.create(journalInput(fixture));
  await assert.rejects(fixture.journal.advance(record, "database-committed"), /transition/);
  await assert.rejects(fixture.journal.create({
    ...journalInput(fixture),
    publications: [
      { ...journalInput(fixture).publications[0], livePath: path.resolve(fixture.root, "..", "outside") },
      journalInput(fixture).publications[1],
    ],
  }), /escapes managed roots/);
  assert.throws(() => normalizeExtensionCommitJournal({ ...record, newEntityFingerprint: "bad" }), /SHA-256/);

  const linked = path.join(fixture.root, "linked-root");
  await fs.symlink(fixture.managedRoot, linked, process.platform === "win32" ? "junction" : "dir");
  const linkedJournal = new ExtensionAcquisitionCommitJournal({
    journalRoot: path.join(fixture.root, "linked-journal"),
    allowedRoots: [linked],
  });
  await assert.rejects(linkedJournal.initialize(), /ordinary directories/);
});

test("startup reconciliation rolls pre-DB files back and finalizes committed files", async (context) => {
  const fixture = await makeFixture(context);
  const prepared = await fixture.journal.create(journalInput(fixture));
  const published = await fixture.journal.advance(
    await fixture.journal.create(journalInput(fixture, "abcdefghijklmnopqrstuvwxyzABCDEG")),
    "files-published",
  );
  const committed = await fixture.journal.advance(
    await fixture.journal.advance(
      await fixture.journal.create(journalInput(fixture, "abcdefghijklmnopqrstuvwxyzABCDEH")),
      "files-published",
    ),
    "database-committed",
  );
  const events: string[] = [];
  await fixture.journal.reconcileAll({
    databaseState: async (record) => record.id === published.id ? "new" : record.id === committed.id ? "new" : "old",
    rollbackFiles: async (record) => { events.push(`rollback:${record.id}`); },
    finalizeFiles: async (record) => { events.push(`finalize:${record.id}`); },
    cleanupSession: async (record) => { events.push(`cleanup:${record.id}`); },
  });
  assert.deepEqual(events, [
    `rollback:${prepared.id}`, `cleanup:${prepared.id}`,
    `finalize:${published.id}`, `cleanup:${published.id}`,
    `finalize:${committed.id}`, `cleanup:${committed.id}`,
  ]);
  assert.deepEqual(await fixture.journal.list(), []);
});

test("files-published journal whose DB stayed old rolls back and reconciliation is idempotent", async (context) => {
  const fixture = await makeFixture(context);
  let record = await fixture.journal.create(journalInput(fixture));
  record = await fixture.journal.advance(record, "files-published");
  let rollbacks = 0;
  const reconciler = {
    databaseState: async (): Promise<"old"> => "old",
    rollbackFiles: async (): Promise<void> => { rollbacks += 1; },
    finalizeFiles: async (): Promise<void> => { throw new Error("must not finalize"); },
  };
  await fixture.journal.reconcileAll(reconciler);
  await fixture.journal.reconcileAll(reconciler);
  assert.equal(rollbacks, 1);
});

test("atomic-write debris is reclaimed but unexpected journal entries fail closed", async (context) => {
  const fixture = await makeFixture(context);
  await fs.writeFile(path.join(fixture.journalRoot, "orphan.tmp-deadbeef"), "partial", "utf8");
  assert.deepEqual(await fixture.journal.list(), []);
  await fs.mkdir(path.join(fixture.journalRoot, "unexpected"));
  await assert.rejects(fixture.journal.list(), /Unexpected/);
});

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function makeFixture(context: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-extension-journal-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const journalRoot = path.join(root, "journals");
  const managedRoot = path.join(root, "managed");
  const artifactRoot = path.join(managedRoot, "artifacts");
  const treeRoot = path.join(managedRoot, "trees");
  const sessionRoot = path.join(root, "sessions");
  const journal = new ExtensionAcquisitionCommitJournal({ journalRoot, allowedRoots: [artifactRoot, treeRoot, sessionRoot] });
  await journal.initialize();
  return { root, journalRoot, managedRoot, artifactRoot, treeRoot, sessionRoot, journal };
}

function journalInput(
  fixture: Fixture,
  sessionId = "abcdefghijklmnopqrstuvwxyzABCDEF",
): Omit<ExtensionCommitJournalRecord, "schemaVersion" | "id" | "phase" | "createdAt" | "updatedAt"> {
  const fingerprint = "a".repeat(64);
  return {
    sessionId,
    targetExtensionId: "extension-one",
    newEntityFingerprint: "b".repeat(64),
    publications: [
      {
        kind: "artifact",
        stagedPath: path.join(fixture.sessionRoot, sessionId, "artifact.crx"),
        livePath: path.join(fixture.artifactRoot, "extension-one", "current.crx"),
        asidePath: path.join(fixture.artifactRoot, "extension-one", `.old-${sessionId}`),
        newFingerprint: fingerprint,
      },
      {
        kind: "tree",
        stagedPath: path.join(fixture.sessionRoot, sessionId, "unpacked"),
        livePath: path.join(fixture.treeRoot, "extension-one"),
        asidePath: path.join(fixture.treeRoot, `.old-extension-one-${sessionId}`),
        newFingerprint: fingerprint,
      },
    ],
  };
}
