import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_WORKBENCH_VIEW, workbenchViewFromHash, workbenchViewHash } from "./workbenchNavigation";

test("known workbench hashes resolve to their view", () => {
  assert.equal(workbenchViewFromHash("#groups"), "groups");
  assert.equal(workbenchViewFromHash("system"), "system");
  assert.equal(workbenchViewHash("extensions"), "#extensions");
});

test("missing or unknown hashes fall back to the environment view", () => {
  assert.equal(workbenchViewFromHash(""), DEFAULT_WORKBENCH_VIEW);
  assert.equal(workbenchViewFromHash("#"), DEFAULT_WORKBENCH_VIEW);
  assert.equal(workbenchViewFromHash("#not-a-view"), DEFAULT_WORKBENCH_VIEW);
});
