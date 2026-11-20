import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ExtensionEntity } from "../../shared/entities";
import { ExtensionReferenceDialog } from "./RegistryDialogs";

const extension = {
  id: "extension-1",
  name: "Ref Fixture",
  version: "1.2.3",
} as ExtensionEntity;

function render(environments: Array<{ id: string; name: string }>) {
  return renderToStaticMarkup(
    React.createElement(ExtensionReferenceDialog, {
      busy: "",
      close: () => undefined,
      environments,
      extension,
      showProfiles: () => undefined,
      t: (key: string) => key,
      unbindAndDelete: async () => undefined,
      unbindOnly: async () => undefined,
    }),
  );
}

test("the extension reference dialog names every environment and both resolutions", () => {
  const html = render([
    { id: "profile-a", name: "Work A" },
    { id: "profile-b", name: "Work B" },
  ]);

  assert.ok(html.includes("extension.references.title"));
  assert.ok(html.includes("extension.references.body"));
  assert.ok(html.includes("Work A"));
  assert.ok(html.includes("Work B"));
  assert.ok(html.includes("extension.references.unbindAndDelete"));
  assert.ok(html.includes("extension.references.unbindOnly"));
  assert.ok(html.includes("extension.references.viewProfiles"));
  // The data-deletion consequence is not optional copy: unbinding is this panel's uninstall.
  assert.ok(html.includes("extension.references.cleanupNote"));
});

test("the dialog still renders for a single reference", () => {
  const html = render([{ id: "profile-a", name: "Work A" }]);

  assert.ok(html.includes("Work A"));
  assert.equal(html.includes("Work B"), false);
});
