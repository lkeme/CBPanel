import assert from "node:assert/strict";
import test from "node:test";

import { extensionPermissionIncreases } from "./extensionPermissionDiff";

test("permission diff treats optional-to-required promotion as a privilege increase", () => {
  const previous = {
    permissions: ["storage", "tabs"],
    hostPermissions: ["https://required.test/*"],
    optionalPermissions: ["cookies", "bookmarks"],
    optionalHostPermissions: ["https://optional.test/*"],
  };
  assert.deepEqual(extensionPermissionIncreases(previous, {
    permissions: ["storage", "cookies"],
    hostPermissions: ["https://required.test/*", "https://optional.test/*"],
    optionalPermissions: ["tabs", "bookmarks", "history"],
    optionalHostPermissions: [],
  }), ["cookies", "history", "https://optional.test/*"]);
});

test("permission diff does not flag unchanged or required-to-optional reductions", () => {
  assert.deepEqual(extensionPermissionIncreases({
    permissions: ["cookies"],
    hostPermissions: ["https://example.test/*"],
    optionalPermissions: ["history"],
    optionalHostPermissions: ["https://optional.test/*"],
  }, {
    permissions: [],
    hostPermissions: [],
    optionalPermissions: ["cookies", "history"],
    optionalHostPermissions: ["https://example.test/*", "https://optional.test/*"],
  }), []);
});
