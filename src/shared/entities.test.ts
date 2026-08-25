import assert from "node:assert/strict";
import test from "node:test";
import { normalizeExtensionBindingMetadata } from "./entities";

test("normalizeExtensionBindingMetadata normalizes valid rows and deduplicates pairs", () => {
  assert.equal(normalizeExtensionBindingMetadata(undefined), undefined);
  assert.deepEqual(normalizeExtensionBindingMetadata([
    { environmentId: " env ", extensionId: " ext ", lifecycleRevision: " first " },
    { environmentId: "env", extensionId: "ext", lifecycleRevision: " second " },
    { environmentId: "env-2", extensionId: "ext-2", lifecycleRevision: "   " },
  ]), [
    { environmentId: "env", extensionId: "ext", lifecycleRevision: "second" },
    { environmentId: "env-2", extensionId: "ext-2", lifecycleRevision: undefined },
  ]);
});

test("normalizeExtensionBindingMetadata rejects malformed archive input with status 400", () => {
  const invalid: Array<{ input: unknown; message: RegExp }> = [
    { input: {}, message: /must be an array/ },
    { input: [null], message: /entries must be objects/ },
    { input: [[]], message: /entries must be objects/ },
    { input: [{}], message: /ids cannot be empty/ },
    { input: [{ environmentId: " ", extensionId: "ext" }], message: /ids cannot be empty/ },
    { input: [{ environmentId: 1, extensionId: "ext" }], message: /ids cannot be empty/ },
    { input: [{ environmentId: "env", extensionId: "ext", lifecycleRevision: 1 }], message: /must be a string/ },
  ];
  for (const item of invalid) {
    assert.throws(
      () => normalizeExtensionBindingMetadata(item.input),
      (error) => {
        assert.equal((error as { status?: number }).status, 400);
        assert.match((error as Error).message, item.message);
        return true;
      },
    );
  }
});
