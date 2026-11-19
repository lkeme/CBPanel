import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ProxyAddDialog } from "./RegistryDialogs";
import { TooltipProvider } from "../ui/tooltip";

test("the add-proxy dialog opens on the single-proxy form", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ProxyAddDialog, {
        busy: "",
        close: () => undefined,
        importLinks: async () => ({}),
        proxies: [],
        saveProxy: async () => true,
        t: (key: string) => key,
      }),
    ),
  );

  assert.ok(html.includes("proxy.add.single"));
  assert.ok(html.includes("proxy.add.batch"));
  assert.ok(html.includes("proxy.editor.name"), "the former new-proxy form is the first tab");
  assert.equal(html.includes("proxy.import.linksPlaceholder"), false, "the bulk textarea waits for its tab");
  assert.ok(html.includes("actions.save"));
  assert.equal(html.includes("proxy.import.run"), false);
});
