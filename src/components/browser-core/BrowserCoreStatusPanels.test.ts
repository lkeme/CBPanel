import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import type { BrowserCoreOperation } from "../../shared/browserCore";
import { TooltipProvider } from "../ui/tooltip";
import { BrowserCoreOperationPanel } from "./BrowserCoreStatusPanels";

// Cancelling aborts the in-flight requests, so there is nothing to abort once the operation has ended —
// offering the button then would be a control that cannot do anything.
test("a running operation offers cancel", () => {
  const html = renderPanel(operation("running"));

  assert.ok(html.includes(t("actions.cancelOperation")));
});

test("a finished operation does not offer cancel", () => {
  const succeeded = renderPanel(operation("succeeded"));
  const failed = renderPanel(operation("failed"));

  assert.equal(succeeded.includes(t("actions.cancelOperation")), false);
  assert.equal(failed.includes(t("actions.cancelOperation")), false);
});

// The panel is also rendered by embedders that pass no handler; a dead button would be worse than none.
test("no cancel handler means no cancel button, even while running", () => {
  const html = renderPanel(operation("running"), { withHandler: false });

  assert.equal(html.includes(t("actions.cancelOperation")), false);
});

function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}

function operation(status: BrowserCoreOperation["status"]): BrowserCoreOperation {
  return {
    id: "op-1",
    type: "update",
    status,
    phase: status === "running" ? "downloading" : status,
    startedAt: "2026-08-04T00:00:00.000Z",
    logs: [],
  };
}

function renderPanel(value: BrowserCoreOperation, options: { withHandler?: boolean } = {}): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(BrowserCoreOperationPanel, {
        busy: "",
        cancelOperation: options.withHandler === false ? undefined : () => undefined,
        operation: value,
        t,
      }),
    ),
  );
}
