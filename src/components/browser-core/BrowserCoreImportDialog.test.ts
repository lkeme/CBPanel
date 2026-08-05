import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import type { BrowserCoreImportAnalysis } from "../../shared/browserCore";
import { TooltipProvider } from "../ui/tooltip";
import {
  BrowserCoreImportDialog,
  importStateForTier,
  type BrowserCoreImportDialogState,
} from "./BrowserCoreImportDialog";

// The refusal sentence the server sends for direct API consumers. It is English whatever the UI locale
// is, so no rendered state may show it while a translated reason code is available.
const SERVER_SENTENCE = "A browser session is running. Stop it first — importing this version replaces the build it may be using.";

test("a refusal shows the translated reason, not the server's English sentence", () => {
  const html = renderDialog({
    allowed: false,
    reason: SERVER_SENTENCE,
    reasonCode: "sessions-running",
  });

  assert.ok(html.includes(t("browserCore.importRefusalSessionsRunning")));
  assert.equal(html.includes(SERVER_SENTENCE), false);
});

// A code this build does not know must still say something: the English sentence beats an empty dash.
test("a refusal code the panel does not know falls back to the server's sentence", () => {
  const html = renderDialog({
    allowed: false,
    reason: SERVER_SENTENCE,
    reasonCode: undefined,
  });

  assert.ok(html.includes(SERVER_SENTENCE));
});

test("a refusal disables the import button", () => {
  const html = renderDialog({ allowed: false, reasonCode: "unverified-package" });

  assert.match(html, new RegExp(`<button[^>]*disabled[^>]*>${t("browserCore.confirmImport")}</button>`));
});

test("an allowed analysis enables the import button", () => {
  const html = renderDialog({ allowed: true });

  assert.match(html, new RegExp(`<button(?:(?!disabled)[^>])*>${t("browserCore.confirmImport")}</button>`));
});

// The cache row is the server's targetCacheDir verbatim. It used to be rewritten client-side when the
// tier control moved, which is how a path the analysis had never judged reached the panel.
test("the cache row shows the directory the server judged", () => {
  const html = renderDialog({ allowed: true, targetCacheDir: "D:/cache/chromium-146.0.7680.177.5-pro" });

  assert.ok(html.includes("D:/cache/chromium-146.0.7680.177.5-pro"));
});

// Pins the fix for the tier control: allowed, reason and targetCacheDir are all tier-dependent, so
// switching tiers must throw the verdict away and ask the server again. Patching targetTier into the
// cached analysis kept a verdict computed for the other tier — the dialog said "allowed" for a
// directory a running session may be executing, and left Import enabled until the server refused it.
test("switching the import tier discards the analysis so the server judges the new tier", () => {
  const state: BrowserCoreImportDialogState = {
    filePath: "D:/downloads/cloakbrowser-windows-x64.zip",
    targetTier: "free",
    analysis: analysis({ allowed: true, targetTier: "free" }),
  };

  const next = importStateForTier(state, "pro");

  assert.equal(next?.targetTier, "pro");
  assert.equal(next?.analysis, undefined);
});

// The analysis reports these as API tokens. Rendered verbatim they read as "导入类型：reinstall" and a
// tier cell of "free" — the panel's own vocabulary is right there.
test("the operation kind and the tier are translated, never printed as raw tokens", () => {
  const html = renderDialog({ allowed: true, operation: "reinstall", targetTier: "pro" });

  assert.ok(html.includes(t("browserCore.importAllowed", { operation: t("browserCore.importKindReinstall") })));
  assert.equal(html.includes(">reinstall<"), false);
  assert.equal(html.includes(">pro<"), false);
  assert.ok(html.includes(t("browserCore.tierPro")));
});

function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("en-US", key, params);
}

function analysis(patch: Partial<BrowserCoreImportAnalysis> = {}): BrowserCoreImportAnalysis {
  return {
    filePath: "D:/downloads/cloakbrowser-windows-x64.zip",
    fileName: "cloakbrowser-windows-x64.zip",
    fileSize: 1024,
    sha256: "a".repeat(64),
    platform: "windows-x64",
    targetTier: "free",
    currentVersion: "146.0.7680.177.5",
    importedVersion: "146.0.7680.177.5",
    operation: "reinstall",
    allowed: true,
    targetCacheDir: "D:/cache/chromium-146.0.7680.177.5",
    ...patch,
  };
}

function renderDialog(patch: Partial<BrowserCoreImportAnalysis> = {}): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(BrowserCoreImportDialog, {
        analyzeImport: async () => analysis(patch),
        busy: "",
        close: () => undefined,
        installImport: async () => undefined,
        setState: () => undefined,
        state: {
          filePath: "D:/downloads/cloakbrowser-windows-x64.zip",
          analysis: analysis(patch),
        },
        t,
      }),
    ),
  );
}
