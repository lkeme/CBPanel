import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import type net from "node:net";
import path from "node:path";
import test, { after, before } from "node:test";
import type { BrowserEnvironment, TrashEnvironment } from "../src/shared/entities";
import type { SessionSummary } from "../src/shared/profile";
import { startPanelHarness, type PanelHarness } from "./testing/httpHarness";

/**
 * Route-level contracts of environment deletion, asserted against the real entry point over HTTP.
 *
 * What lives here and nowhere else is the *wiring*: which guard runs before which write, and which ids the
 * prune's resolver is asked about. `environmentDataService.test.ts` already pins the filesystem behaviour
 * of the same service in isolation; it cannot see that `server/index.ts` deletes the row before the
 * directory, or that the prune resolver includes trashed ids — and getting either wrong loses user data.
 *
 * One shared child process for the whole file: a boot is ~700ms, and every test below creates its own
 * environments, so a clean instance per test would buy nothing. The two exceptions say why in place.
 */

let panel: PanelHarness;

before(async () => {
  panel = await startPanelHarness();
});

after(async () => {
  await panel?.dispose();
});

// The precondition for restoreEnvironment, and the reason this is its own case rather than a line inside a
// bigger one: a soft delete that also removed the directory would look completely correct from the API —
// the row is in the trash, restore answers 200 — and the loss would only surface the next time that
// profile launched, with no browser data and nothing to point at. The permanent-delete case further down
// is what shows this directory is reachable by an rm at all.
test("a soft delete keeps the environment's browser data on disk", async () => {
  const environment = await createEnvironment("Soft Deleted Env");
  await writeBrowserData(environment.id);

  const response = await panel.request("DELETE", `/api/environments/${environment.id}`);

  assert.equal(response.status, 204);
  assert.equal(response.body, undefined);
  assert.equal(await pathExists(browserDataPath(environment.id, "Cookies")), true);
  assert.ok((await trashedIds()).includes(environment.id));

  await emptyTrash();
});

test("the prune keeps a trashed environment's browser data, and a restore finds it again", async () => {
  const environment = await createEnvironment("Restorable Env");
  await writeBrowserData(environment.id);
  // A directory the prune must take, in the same call: it is what proves the prune actually ran and does
  // delete what it does not recognise, so the trashed directory surviving is a decision and not a no-op.
  await writeBrowserData("orphan-alongside-a-restore");
  assert.equal((await panel.request("DELETE", `/api/environments/${environment.id}`)).status, 204);

  const pruned = await panel.request("POST", "/api/storage/browser-data/prune");

  assert.equal(pruned.status, 200);
  assert.ok(cleanupResult(pruned).removed.includes("orphan-alongside-a-restore"));
  // The trashed id has to reach the resolver's known set. A prune that only knew the active ids would see
  // this directory as an orphan — nothing registered is named after it — and delete exactly the data the
  // restore below depends on.
  assert.ok(!cleanupResult(pruned).removed.includes(environment.id));
  assert.equal(await pathExists(browserDataPath(environment.id, "Cookies")), true);

  const restored = await panel.request("POST", `/api/trash/environments/${environment.id}/restore`);

  assert.equal(restored.status, 200);
  assert.equal((restored.body as BrowserEnvironment).id, environment.id);
  assert.equal(await pathExists(browserDataPath(environment.id, "Cookies")), true);
});

test("the prune deletes orphan directories, keeps registered and trashed ones, and leaves loose files alone", async () => {
  const live = await createEnvironment("Prune Live Env");
  const trashed = await createEnvironment("Prune Trashed Env");
  await writeBrowserData(live.id);
  await writeBrowserData(trashed.id);
  await writeBrowserData("orphan-with-no-row");
  // Only directories are environment data. A file sitting next to them belongs to whatever wrote it, and
  // deleting it because no environment is named after it would be guesswork.
  const looseFile = browserDataPath("prune-notes.txt");
  await fs.writeFile(looseFile, "loose", "utf8");
  assert.equal((await panel.request("DELETE", `/api/environments/${trashed.id}`)).status, 204);

  const response = await panel.request("POST", "/api/storage/browser-data/prune");

  assert.equal(response.status, 200);
  const removed = cleanupResult(response).removed;
  assert.ok(removed.includes("orphan-with-no-row"));
  assert.ok(!removed.includes(live.id));
  assert.ok(!removed.includes(trashed.id));
  assert.deepEqual(cleanupResult(response).warnings, []);
  assert.equal(await pathExists(browserDataPath("orphan-with-no-row")), false);
  assert.equal(await pathExists(browserDataPath(live.id, "Cookies")), true);
  assert.equal(await pathExists(browserDataPath(trashed.id, "Cookies")), true);
  assert.equal(await pathExists(looseFile), true);

  await fs.rm(looseFile, { force: true });
  await emptyTrash();
});

// The order the permanent delete has to follow: rows first, and the directory only once that committed. A
// route that rm'd first — or rm'd regardless of the outcome — would answer this same 404 while the data was
// already gone, which is why both ids below keep a staged directory.
test("a permanent delete that finds no trashed row answers 404 and removes no browser data", async () => {
  const unknownId = "profile-never-registered";
  await writeBrowserData(unknownId);
  const live = await createEnvironment("Still Live Env");
  await writeBrowserData(live.id);

  const unknown = await panel.request("DELETE", `/api/trash/environments/${unknownId}`);
  // A registered environment that was never deleted is not in the trash either, and this is the case where
  // an rm ahead of the row delete would take data a user can still see in the panel.
  const notTrashed = await panel.request("DELETE", `/api/trash/environments/${live.id}`);

  assert.equal(unknown.status, 404);
  assert.equal(notTrashed.status, 404);
  assert.equal(await pathExists(browserDataPath(unknownId, "Cookies")), true);
  assert.equal(await pathExists(browserDataPath(live.id, "Cookies")), true);
  assert.equal((await panel.request("GET", `/api/environments/${live.id}`)).status, 200);

  await fs.rm(browserDataPath(unknownId), { recursive: true, force: true });
});

test("a permanent delete drops the trashed row and then the browser data", async () => {
  const environment = await createEnvironment("Doomed Env");
  await writeBrowserData(environment.id);
  assert.equal((await panel.request("DELETE", `/api/environments/${environment.id}`)).status, 204);

  const response = await panel.request("DELETE", `/api/trash/environments/${environment.id}`);

  assert.equal(response.status, 204);
  assert.equal(response.body, undefined);
  assert.ok(!(await trashedIds()).includes(environment.id));
  assert.equal((await panel.request("GET", `/api/environments/${environment.id}`)).status, 404);
  assert.equal(await pathExists(browserDataPath(environment.id)), false);
});

test("emptying the trash answers exactly { deleted, dataRemoved, warnings }", async () => {
  await emptyTrash();
  const withData = await createEnvironment("Trashed With Data");
  const neverLaunched = await createEnvironment("Trashed Without Data");
  await writeBrowserData(withData.id);
  for (const id of [withData.id, neverLaunched.id]) {
    assert.equal((await panel.request("DELETE", `/api/environments/${id}`)).status, 204);
  }

  const response = await panel.request("DELETE", "/api/trash/environments");

  assert.equal(response.status, 200);
  // Exactly these three keys, and no more: the trash view reads `deleted` for its count and the toast
  // reads `dataRemoved` / `warnings` to say how much space came back and what was skipped. `deepEqual` is
  // strict here, so an extra field fails — the shape is the contract.
  // `dataRemoved` counts directories, not rows: the environment that was never launched has none, and
  // reporting it as reclaimed would inflate the number the user is shown.
  assert.deepEqual(response.body, { deleted: 2, dataRemoved: 1, warnings: [] });
  assert.equal(await pathExists(browserDataPath(withData.id)), false);
  assert.deepEqual(await trashedIds(), []);
});

test("the browser-data prune refuses with 409 while an environment package import is in flight", async () => {
  const orphanId = "orphan-during-import";
  await writeBrowserData(orphanId);
  // An import whose window is wide enough to send a request into. `extractZipArchive` streams the whole
  // input through the unzip in chunks, yielding to the event loop between them, so a file of this size
  // keeps the operation "running" for hundreds of milliseconds — against a single loopback round trip for
  // the prune below. The archive is invalid and the import is expected to fail; what is pinned is the
  // window, exactly as in `environmentPackageService.test.ts`, not the outcome.
  const archivePath = path.join(panel.dataDir, "never-a-valid-package.cbpe");
  await writeZeroFile(archivePath, 32 * 1024 * 1024);

  const started = await panel.request("POST", "/api/environment-packages/import", { inputPath: archivePath });
  const refused = await panel.request("POST", "/api/storage/browser-data/prune");

  assert.equal(started.status, 202);
  assert.equal(refused.status, 409);
  assert.equal((refused.body as { code?: string }).code, "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS");
  // The point of the refusal: an import copies `browser-data/<new id>` into place before the rows that
  // name it exist, so in that window every directory it has laid down looks exactly like this orphan.
  assert.equal(await pathExists(browserDataPath(orphanId, "Cookies")), true);

  await settlePackageOperation(String((started.body as { operationId?: unknown }).operationId));
  const pruned = await panel.request("POST", "/api/storage/browser-data/prune");

  // The guard was the only thing holding the cleanup back, not a missing directory or a rejected id.
  assert.equal(pruned.status, 200);
  assert.ok(cleanupResult(pruned).removed.includes(orphanId));

  await fs.rm(archivePath, { force: true });
});

// The refusal a single permanent delete owes the user, as against the batch above, which drops every row
// and only reports the directories it had to skip.
//
// The environment stays out of the trash on purpose, and this is the limit of what can be pinned from
// outside: `getProfile` filters soft-deleted rows, so a trashed environment cannot be launched, and no route
// puts an environment into the trash while a session is up — `DELETE /api/environments/:id` refuses that
// itself. So what runs here is the guard *ahead of* the row lookup, read off the difference between the two
// identical requests: 404 while nothing holds the runtime, 409 once something does.
//
// Its own instance, because the session this test wedges in "launching" can only be cleared by ending the
// process, and until then every later prune and delete would treat that id as held.
test("a permanent delete refuses with 409 while a session still holds the environment's runtime", async () => {
  const held = await startPanelHarness();
  // Opened inside the try, not beside the harness above: a listen that failed out here would skip the
  // finally and leave that harness's child process and temp directory behind for the rest of the run.
  let stalled: StalledDownload | undefined;
  // Fired and deliberately not awaited: it stays open for as long as the download does. The catch is for
  // the rejection that arrives when the child is killed.
  let launching: Promise<unknown> = Promise.resolve();
  try {
    stalled = await startStalledDownload();
    const environment = jsonBody<BrowserEnvironment>(await held.request("POST", "/api/environments", { name: "Held Env" }));
    await fs.mkdir(path.join(held.dataDir, "browser-data", environment.id), { recursive: true });
    await fs.writeFile(path.join(held.dataDir, "browser-data", environment.id, "Cookies"), "cookie-db", "utf8");
    const extension = jsonBody<{ id: string }>(await held.request("POST", "/api/extensions", {
      name: "Stalled Extension",
      sourceKind: "remote-zip",
      sourceUrl: stalled.url,
      sha256: "b".repeat(64),
    }));
    assert.equal((await held.request("POST", `/api/extensions/${extension.id}/bind-environments`, {
      environmentIds: [environment.id],
    })).status, 200);

    // Nothing holds the runtime yet, so the same request answers 404 — which is what makes the 409 below
    // attributable to the guard and not to the row lookup behind it.
    const beforeLaunch = await held.request("DELETE", `/api/trash/environments/${environment.id}`);
    assert.equal(beforeLaunch.status, 404);

    launching = held.request("POST", `/api/environments/${environment.id}/launch`).catch(() => undefined);
    await waitForSessionStatus(held, environment.id, "launching");

    const refused = await held.request("DELETE", `/api/trash/environments/${environment.id}`);

    assert.equal(refused.status, 409);
    // Refused before anything was touched, not reported afterwards.
    assert.equal(await pathExists(path.join(held.dataDir, "browser-data", environment.id, "Cookies")), true);
    assert.equal((await held.request("GET", `/api/environments/${environment.id}`)).status, 200);
  } finally {
    await stalled?.close();
    await held.dispose();
    await launching;
  }
});

async function createEnvironment(name: string): Promise<BrowserEnvironment> {
  const response = await panel.request("POST", "/api/environments", { name });
  assert.equal(response.status, 201);
  return jsonBody<BrowserEnvironment>(response);
}

/** What a launched environment leaves behind, and what every assertion here is really about. */
async function writeBrowserData(id: string): Promise<void> {
  await fs.mkdir(browserDataPath(id, "Default"), { recursive: true });
  await fs.writeFile(browserDataPath(id, "Cookies"), "cookie-db", "utf8");
}

function browserDataPath(...segments: string[]): string {
  return path.join(panel.dataDir, "browser-data", ...segments);
}

async function trashedIds(): Promise<string[]> {
  const response = await panel.request("GET", "/api/trash/environments");
  assert.equal(response.status, 200);
  return jsonBody<TrashEnvironment[]>(response).map((item) => item.environment.id);
}

async function emptyTrash(): Promise<void> {
  assert.equal((await panel.request("DELETE", "/api/trash/environments")).status, 200);
}

function cleanupResult(response: { body: unknown }): { removed: string[]; warnings: string[] } {
  const body = response.body as { removed?: unknown; warnings?: unknown };
  assert.ok(Array.isArray(body.removed), `expected a removed array, got ${JSON.stringify(response.body)}`);
  assert.ok(Array.isArray(body.warnings));
  return { removed: body.removed as string[], warnings: body.warnings as string[] };
}

function jsonBody<T>(response: { status: number; body: unknown }): T {
  assert.ok(response.body && typeof response.body === "object", `expected a JSON body, got ${JSON.stringify(response.body)}`);
  return response.body as T;
}

async function settlePackageOperation(operationId: string): Promise<void> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const response = await panel.request("GET", `/api/environment-packages/operations/${operationId}`);
    const status = (response.body as { status?: string }).status;
    if (status === "succeeded" || status === "failed") return;
    await delay(20);
  }
  throw new Error(`Environment package operation ${operationId} did not settle.`);
}

async function waitForSessionStatus(harness: PanelHarness, profileId: string, status: SessionSummary["status"]): Promise<void> {
  let seen: string | undefined;
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const response = await harness.request("GET", "/api/sessions");
    seen = (response.body as SessionSummary[]).find((session) => session.profileId === profileId)?.status;
    if (seen === status) return;
    await delay(20);
  }
  throw new Error(`Session ${profileId} never reached "${status}" (last seen: ${seen ?? "no session"}).`);
}

type StalledDownload = {
  url: string;
  close(): Promise<void>;
};

/**
 * A download that accepts the connection and then never answers, which is the only way to hold a launch
 * open from outside the process: `ensureExtensionsInstalled` fetches a remote asset with no timeout, so a
 * launch whose environment is bound to one stays registered as "launching" — the state
 * `profileIdsHoldingRuntime` reports — until this server is closed. No real browser core is needed, and no
 * product code is stubbed.
 */
async function startStalledDownload(): Promise<StalledDownload> {
  const sockets = new Set<net.Socket>();
  const server = http.createServer(() => {
    // Deliberately never responds.
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}/stalled-extension.zip`,
    close: async () => {
      // The sockets have to go first: `close` only stops new connections, and a held one would keep the
      // test process alive after the last assertion.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** `truncate` rather than a written buffer: the file is only ever read, and the zeros never hit the disk. */
async function writeZeroFile(filePath: string, bytes: number): Promise<void> {
  const handle = await fs.open(filePath, "w");
  try {
    await handle.truncate(bytes);
  } finally {
    await handle.close();
  }
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
