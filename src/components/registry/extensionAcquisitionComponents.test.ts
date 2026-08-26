import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  ExtensionAcquisitionSessionView,
  ExtensionCapabilityView,
  ExtensionPreflightReport,
} from "../../shared/extensionAcquisition";
import { ExtensionArtifactChannelChoice, ExtensionCatalogResults } from "./ExtensionAcquisitionResults";
import {
  buildExtensionAcquisitionConfirmationRequest,
  ExtensionAcquisitionSessionPanel,
  extensionAcquisitionConfirmationChoices,
} from "./ExtensionAcquisitionSessionPanel";
import {
  ExtensionAcquisitionDisclosureDialog,
  ExtensionAcquisitionSourceSettings,
} from "./ExtensionAcquisitionSources";
import type { ExtensionAcquisitionUiTranslator } from "./extensionAcquisitionUi";
import {
  handleExtensionAcquisitionDialogKey,
  restoreExtensionAcquisitionDialogFocus,
} from "./extensionAcquisitionUi";

const t: ExtensionAcquisitionUiTranslator = (key, params) => (
  params ? `${key}:${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(",")}` : key
);

test("source switches expose names, descriptions, health and the all-off remote-only state", () => {
  const capabilities: ExtensionCapabilityView[] = [
    capability("crxsoso-search", "catalog-search", "crxsoso", "third-party", ["search"]),
    capability("google-artifact", "artifact", "chrome-web-store", "google-hosted", ["download-current"]),
    capability("crxsoso-artifact", "artifact", "crxsoso", "third-party", ["download-current"]),
  ];
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSourceSettings, {
    capabilities,
    locale: "en-US",
    onToggle: () => undefined,
    t,
  }));

  assert.equal((html.match(/role="switch"/g) ?? []).length, 3);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.ok(html.includes("extension.acquisition.source.allOff"));
  assert.ok(html.includes("extension.acquisition.source.allOffHelp"));
  assert.ok(html.includes("extension.acquisition.health.notChecked"));
});

test("a capability save locks every source switch until the serialized setting write settles", () => {
  const capabilities: ExtensionCapabilityView[] = [
    capability("crxsoso-search", "catalog-search", "crxsoso", "third-party", ["search"]),
    capability("google-artifact", "artifact", "chrome-web-store", "google-hosted", ["download-current"]),
    capability("crxsoso-artifact", "artifact", "crxsoso", "third-party", ["download-current"]),
  ];
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSourceSettings, {
    busyCapabilityId: "google-artifact",
    capabilities,
    locale: "en-US",
    onToggle: () => undefined,
    t,
  }));

  const switches = html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
  assert.equal(switches.length, 3);
  assert.ok(switches.every((control) => control.includes("disabled=\"\"")));
  assert.ok(html.includes("extension.acquisition.source.saving"));
});

test("third-party disclosure is a named modal whose safe default is Cancel", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionDisclosureDialog, {
    busy: false,
    onAccept: () => undefined,
    onCancel: () => undefined,
    t,
  }));

  const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0] ?? "";
  assert.match(dialog, /aria-modal="true"/);
  const labelledBy = attribute(dialog, "aria-labelledby");
  const describedBy = attribute(dialog, "aria-describedby");
  assert.ok(labelledBy);
  assert.ok(describedBy);
  assert.match(html, new RegExp(`<h2 id="${escapeRegExp(labelledBy)}">`));
  assert.match(html, new RegExp(`<p id="${escapeRegExp(describedBy)}">`));
  assert.match(html, /<button[^>]*data-acquisition-autofocus="true"[^>]*>actions\.cancel<\/button>/);
});

test("acquisition dialogs trap Tab, honor Escape locking, and restore only connected focus", () => {
  const focused: string[] = [];
  const first = { focus: () => focused.push("first") };
  const last = { focus: () => focused.push("last") };
  const panel = { focus: () => focused.push("panel") };
  let prevented = 0;
  let stopped = 0;
  let closed = 0;
  const event = (key: string, shiftKey = false) => ({
    key,
    shiftKey,
    preventDefault: () => { prevented += 1; },
    stopPropagation: () => { stopped += 1; },
  });

  handleExtensionAcquisitionDialogKey({
    activeElement: last,
    closeDisabled: false,
    event: event("Tab"),
    focusable: [first, last],
    onClose: () => { closed += 1; },
    panel,
  });
  handleExtensionAcquisitionDialogKey({
    activeElement: first,
    closeDisabled: false,
    event: event("Tab", true),
    focusable: [first, last],
    onClose: () => { closed += 1; },
    panel,
  });
  handleExtensionAcquisitionDialogKey({
    activeElement: panel,
    closeDisabled: false,
    event: event("Tab"),
    focusable: [],
    onClose: () => { closed += 1; },
    panel,
  });
  handleExtensionAcquisitionDialogKey({
    activeElement: first,
    closeDisabled: true,
    event: event("Escape"),
    focusable: [first, last],
    onClose: () => { closed += 1; },
    panel,
  });
  handleExtensionAcquisitionDialogKey({
    activeElement: first,
    closeDisabled: false,
    event: event("Escape"),
    focusable: [first, last],
    onClose: () => { closed += 1; },
    panel,
  });

  restoreExtensionAcquisitionDialogFocus({ isConnected: true, focus: () => focused.push("return") });
  restoreExtensionAcquisitionDialogFocus({ isConnected: false, focus: () => focused.push("detached") });
  assert.deepEqual(focused, ["first", "last", "panel", "return"]);
  assert.equal(prevented, 5);
  assert.equal(stopped, 2);
  assert.equal(closed, 1);
});

test("catalog rendering announces omitted aliases and requires explicit listing/result actions", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    locale: "en-US",
    onCancel: () => undefined,
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    page: {
      query: "userscript",
      items: [{
        namespace: "chrome-web-store",
        storeId: "a".repeat(32),
        storeUrl: `https://chromewebstore.google.com/detail/${"a".repeat(32)}`,
        catalogProviderId: "crxsoso",
        observedAt: "2026-08-27T00:00:00.000Z",
        name: "Example",
      }],
      excludedNonCanonicalCount: 2,
      hasMore: true,
    },
    status: "ready",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.aliasesExcluded:count=2"));
  assert.ok(html.includes("extension.acquisition.openWebStore"));
  assert.ok(html.includes("extension.acquisition.results.choose"));
  assert.ok(html.includes("extension.acquisition.loadMore"));
  assert.match(html, /role="status"/);
});

test("cancelling pagination retains results but exposes one explicit retry instead of an active load-more path", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    locale: "en-US",
    onCancel: () => undefined,
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    page: {
      query: "userscript",
      items: [{
        namespace: "chrome-web-store",
        storeId: "a".repeat(32),
        storeUrl: `https://chromewebstore.google.com/detail/${"a".repeat(32)}`,
        catalogProviderId: "crxsoso",
        observedAt: "2026-08-27T00:00:00.000Z",
        name: "Example",
      }],
      excludedNonCanonicalCount: 0,
      cursor: "next_cursor",
      hasMore: true,
    },
    status: "cancelled",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.results.cancelled"));
  assert.equal((html.match(/extension\.acquisition\.results\.retry/g) ?? []).length, 1);
  assert.ok(!html.includes("extension.acquisition.loadMore"));
});

test("exact ID resolution failures are announced as acquisition failures rather than search failures", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    discoveryKind: "resolve",
    error: "provider unavailable",
    locale: "en-US",
    onCancel: () => undefined,
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    status: "error",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.error: provider unavailable"));
  assert.ok(!html.includes("extension.acquisition.results.error"));
  assert.match(html, /role="alert"/);
});

test("a Google failure keeps Google selected and exposes mirror only as an explicit action", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionArtifactChannelChoice, {
    onOpenListing: () => undefined,
    onSelect: () => undefined,
    onStart: () => undefined,
    providerFailure: { providerId: "chrome-web-store", message: "offline" },
    resolution: {
      namespace: "chrome-web-store",
      storeId: "b".repeat(32),
      storeUrl: `https://chromewebstore.google.com/detail/${"b".repeat(32)}`,
      offers: [
        { namespace: "chrome-web-store", storeId: "b".repeat(32), artifactProviderId: "chrome-web-store", format: "crx3", providerLabel: "Chrome Web Store" },
        { namespace: "chrome-web-store", storeId: "b".repeat(32), artifactProviderId: "crxsoso", format: "crx3", providerLabel: "CRX搜搜" },
      ],
    },
    selectedProviderId: "chrome-web-store",
    t,
  }));

  assert.match(html, /value="chrome-web-store"[^>]*checked=""|checked=""[^>]*value="chrome-web-store"/);
  assert.doesNotMatch(html, /value="crxsoso"[^>]*checked=""|checked=""[^>]*value="crxsoso"/);
  assert.ok(html.includes("extension.acquisition.channel.mirrorDescription"));
  assert.ok(html.includes("extension.acquisition.channel.tryMirror"));
  assert.match(html, /role="alert"/);
});

test("session creation exposes a safe cancellation action while the chosen channel is starting", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionArtifactChannelChoice, {
    onCancel: () => undefined,
    onOpenListing: () => undefined,
    onSelect: () => undefined,
    onStart: () => undefined,
    resolution: {
      namespace: "chrome-web-store",
      storeId: "b".repeat(32),
      storeUrl: `https://chromewebstore.google.com/detail/${"b".repeat(32)}`,
      offers: [{
        namespace: "chrome-web-store",
        storeId: "b".repeat(32),
        artifactProviderId: "chrome-web-store",
        format: "crx3",
        providerLabel: "Chrome Web Store",
      }],
    },
    selectedProviderId: "chrome-web-store",
    startingProviderId: "chrome-web-store",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.loading"));
  assert.ok(html.includes("actions.cancelOperation"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>extension\.acquisition\.loading<\/button>/);
});

test("confirmation requests can only name server-issued eligible candidates and gate permission tokens", () => {
  const report = preflight({
    conflicts: [{
      extensionId: "extension_existing",
      name: "Example",
      version: "1.0.0",
      installState: "installed",
      matchBy: "developer-identity",
      eligible: true,
    }],
    permissionApproval: { token: "server-token", added: ["tabs"] },
  });
  const session = readySession(report);
  const choices = extensionAcquisitionConfirmationChoices(session);

  assert.deepEqual(choices.map((choice) => choice.request), [
    { disposition: "reuse", targetExtensionId: "extension_existing" },
    { disposition: "upgrade", targetExtensionId: "extension_existing" },
  ]);
  assert.equal(buildExtensionAcquisitionConfirmationRequest(choices[1], report, false), undefined);
  assert.deepEqual(buildExtensionAcquisitionConfirmationRequest(choices[1], report, true), {
    disposition: "upgrade",
    targetExtensionId: "extension_existing",
    permissionApprovalToken: "server-token",
  });
});

test("ready preflight renders package, channel, proof, risk and discrepancy facts before disabled confirmation", () => {
  const report = preflight({
    conflicts: [{
      extensionId: "extension_blocked",
      name: "Conflicting",
      version: "0.9.0",
      installState: "installed",
      matchBy: "store-identity",
      eligible: false,
      blockingReason: "developer-identity-mismatch",
    }],
    discrepancies: [{ field: "name", catalog: "Catalog name", package: "Package name" }],
    permissionRisks: [{ permission: "<all_urls>", level: "high", reason: "all sites", reasonKey: "all-urls" }],
  });
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSessionPanel, {
    locale: "en-US",
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onDone: () => undefined,
    onRetry: () => undefined,
    operation: "idle",
    session: readySession(report),
    t,
  }));

  for (const fact of [
    report.identity.requestedStoreId,
    report.identity.proofDerivedStoreId,
    report.package.sha256,
    report.package.manifestSha256,
    report.package.treeSha256,
    report.transport.finalByteHost,
    report.verification.developerKeySha256,
    report.verification.publisherTrustRootId,
    "&lt;all_urls&gt;",
    "Catalog name",
    "Package name",
    "extension_blocked",
  ]) assert.ok(html.includes(fact), fact);
  assert.ok(html.includes("extension.acquisition.conflict.blocked"));
  assert.match(html, /<button[^>]*disabled=""[^>]*>extension\.acquisition\.actions|<button[^>]*disabled=""/);
  assert.doesNotMatch(html, /\bsafe\b/i);
});

function capability(
  id: ExtensionCapabilityView["id"],
  kind: ExtensionCapabilityView["kind"],
  providerId: ExtensionCapabilityView["providerId"],
  trust: ExtensionCapabilityView["trust"],
  operations: ExtensionCapabilityView["operations"],
): ExtensionCapabilityView {
  return { id, kind, providerId, trust, operations, enabled: false };
}

function readySession(report: ExtensionPreflightReport): ExtensionAcquisitionSessionView {
  return {
    sessionId: report.sessionId,
    purpose: "install",
    namespace: "chrome-web-store",
    storeId: report.identity.requestedStoreId,
    selectedProviderId: "chrome-web-store",
    status: "ready",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:01:00.000Z",
    expiresAt: report.expiresAt,
    report,
  };
}

function preflight(patch: Partial<ExtensionPreflightReport> = {}): ExtensionPreflightReport {
  return {
    sessionId: "session_12345678901234567890123456789012",
    expiresAt: "2026-08-27T00:15:00.000Z",
    identity: { namespace: "chrome-web-store", requestedStoreId: "c".repeat(32), proofDerivedStoreId: "c".repeat(32), matches: true },
    package: {
      name: "Example",
      description: "Package description",
      version: "1.2.3",
      manifestVersion: 3,
      format: "crx3",
      size: 1024,
      sha256: "1".repeat(64),
      manifestSha256: "2".repeat(64),
      treeSha256: "3".repeat(64),
      entryCount: 12,
      filesystemNodeCount: 14,
      fileCount: 10,
      expandedBytes: 4096,
      icon: { relativePath: "icon.png", mimeType: "image/png", size: 128 },
    },
    transport: { selectedProviderId: "chrome-web-store", finalByteHost: "clients2.googleusercontent.com", fetchedAt: "2026-08-27T00:01:00.000Z", durationMs: 1000 },
    verification: {
      level: "cws-publisher-verified",
      developerKeySha256: "4".repeat(64),
      publisherTrustRootId: "chromium-cws",
      publisherTrustRootVersion: 1,
      developerProofAlgorithm: "rsa-sha256",
      publisherProofAlgorithm: "ecdsa-sha256",
    },
    permissions: ["storage"],
    hostPermissions: ["https://example.com/*"],
    optionalPermissions: ["tabs"],
    optionalHostPermissions: [],
    permissionRisks: [],
    discrepancies: [],
    catalog: { providerId: "crxsoso", observedAt: "2026-08-27T00:00:00.000Z" },
    conflicts: [],
    ...patch,
  };
}

function attribute(html: string, name: string): string {
  return html.match(new RegExp(`${name}="([^"]+)"`))?.[1] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
