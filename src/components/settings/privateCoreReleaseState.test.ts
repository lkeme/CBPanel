import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserCorePrivateRelease } from "../../shared/browserCore";
import {
  emptyPrivateCoreCatalog,
  privateCoreConfigurationDirty,
  receivePrivateCoreCatalog,
} from "./privateCoreReleaseState";

const REPOSITORY_A = "https://github.com/example/channel-a";
const REPOSITORY_B = "https://github.com/example/channel-b";
const older = release(1, "155.0.8059.39.1");
const latest = release(2, "156.0.8078.47.1");

test("editing repository or token blocks release actions", () => {
  assert.equal(privateCoreConfigurationDirty(REPOSITORY_A, REPOSITORY_A, ""), false);
  assert.equal(privateCoreConfigurationDirty(REPOSITORY_A, REPOSITORY_B, ""), true);
  assert.equal(privateCoreConfigurationDirty(REPOSITORY_A, REPOSITORY_A, "new-token-not-yet-tested"), true);
});

// Every row carries its own install control, so there is no selection state to keep or invalidate: the
// catalog is only ever the list the repository returned, tagged with the repository it came from.
test("a catalog is replaced whole and keeps the repository it belongs to", () => {
  let catalog = receivePrivateCoreCatalog(REPOSITORY_A, [latest, older]);
  assert.equal(catalog.repositoryUrl, REPOSITORY_A);
  assert.deepEqual(catalog.releases.map((item) => item.id), [latest.id, older.id]);
  catalog = receivePrivateCoreCatalog(REPOSITORY_B, [older]);
  assert.equal(catalog.repositoryUrl, REPOSITORY_B);
  assert.deepEqual(catalog.releases.map((item) => item.id), [older.id]);
  assert.equal(receivePrivateCoreCatalog(REPOSITORY_A, []).loaded, true);
  assert.equal(emptyPrivateCoreCatalog().loaded, false);
});

function release(id: number, version: string): BrowserCorePrivateRelease {
  return { id, version, title: `CloakBrowser ${version} VERIFIED`, assets: [], verified: true };
}
