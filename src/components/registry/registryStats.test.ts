import assert from "node:assert/strict";
import test from "node:test";

import type { BrowserEnvironment } from "../../shared/entities";
import type { BrowserProfile } from "../../shared/profile";
import {
  extensionReferenceEnvironments,
  nameExtensionReferenceEnvironments,
} from "./registryStats";

function environment(id: string, extensionIds: string[], deletedAt?: string): BrowserEnvironment {
  return {
    id,
    name: `env-${id}`,
    notes: "",
    mode: "persistent",
    startUrl: "",
    groupId: "",
    tagIds: [],
    extensionIds,
    runtimeProfile: { id, name: id } as BrowserProfile,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt,
  };
}

test("extension references list only live environments that load the extension", () => {
  const environments = [
    environment("a", ["ext-1"]),
    environment("b", ["ext-2"]),
    environment("c", ["ext-1", "ext-2"]),
    environment("trashed", ["ext-1"], "2026-02-01T00:00:00.000Z"),
  ];

  assert.deepEqual(
    extensionReferenceEnvironments(environments, "ext-1").map((reference) => reference.id),
    ["a", "c"],
  );
  assert.deepEqual(extensionReferenceEnvironments(environments, "missing"), []);
});

test("reference names fall back to the id when the profile is gone", () => {
  const profiles = [{ id: "a", name: "Work A" }] as BrowserProfile[];

  assert.deepEqual(
    nameExtensionReferenceEnvironments([{ id: "a" }, { id: "ghost" }], profiles),
    [
      { id: "a", name: "Work A" },
      { id: "ghost", name: "ghost" },
    ],
  );
  assert.deepEqual(nameExtensionReferenceEnvironments([], undefined), []);
});
