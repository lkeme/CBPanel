import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { extensionAcquisitionEnUS } from "../../locales/extensionAcquisition.en-US";
import { extensionAcquisitionZhCN } from "../../locales/extensionAcquisition.zh-CN";
import type {
  ExtensionAcquisitionSessionView,
  ExtensionPreflightReport,
} from "../../shared/extensionAcquisition";
import {
  ExtensionArtifactChannelChoice,
  ExtensionCatalogResults,
  formatAcquisitionCount,
} from "./ExtensionAcquisitionResults";
import {
  buildExtensionAcquisitionConfirmationRequest,
  ExtensionAcquisitionSessionPanel,
  extensionAcquisitionConfirmationChoices,
} from "./ExtensionAcquisitionSessionPanel";
import {
  ExtensionAcquisitionDisclosureDialog,
  ExtensionAcquisitionSourceSettings,
} from "./ExtensionAcquisitionSources";
import { ExtensionAcquisitionDialogLoading } from "./RegistryDialogs";
import {
  handleExtensionAcquisitionDialogKey,
  restoreExtensionAcquisitionDialogFocus,
} from "./extensionAcquisitionDialogFocus";
import type { ExtensionAcquisitionUiTranslator } from "./extensionAcquisitionUi";
import { formatExtensionAcquisitionError } from "./extensionAcquisitionUi";

const t: ExtensionAcquisitionUiTranslator = (key, params) => (
  params ? `${key}:${Object.entries(params).map(([name, value]) => `${name}=${value}`).join(",")}` : key
);

test("source settings expose exactly two mutually exclusive package channels and no search toggle or health probe", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSourceSettings, {
    onSelectProvider: () => undefined,
    selectedProviderId: "crxsoso",
    t,
  }));

  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.equal((html.match(/checked=""/g) ?? []).length, 1);
  assert.match(html, /aria-labelledby="[^"]+"/);
  assert.match(html, /aria-describedby="[^"]+"/);
  assert.ok(html.includes("extension.acquisition.source.channelLegend"));
  assert.ok(html.includes("extension.acquisition.source.singleChannelHelp"));
  assert.ok(!html.includes("extension.acquisition.source.crxsosoSearchName"));
  assert.ok(!html.includes("extension.acquisition.health.notChecked"));
  assert.ok(!html.includes("actions.refresh"));
});

test("a channel save locks the mutually exclusive radio group until the serialized write settles", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSourceSettings, {
    busyProviderId: "chrome-web-store",
    onSelectProvider: () => undefined,
    selectedProviderId: "crxsoso",
    t,
  }));

  assert.equal((html.match(/type="radio"/g) ?? []).length, 2);
  assert.match(html, /<fieldset[^>]*disabled=""/);
  assert.ok(!html.includes("role=\"switch\""));
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

test("the cold-loading fallback is a named busy dialog with one safe close action", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionDialogLoading, {
    close: () => undefined,
    t,
    title: "Source settings",
  }));

  const dialog = html.match(/<div[^>]*role="dialog"[^>]*>/)?.[0] ?? "";
  assert.match(dialog, /aria-modal="true"/);
  assert.ok(attribute(dialog, "aria-labelledby"));
  assert.ok(attribute(dialog, "aria-describedby"));
  assert.match(html, /<section[^>]*aria-busy="true"/);
  assert.equal((html.match(/<button/g) ?? []).length, 1);
  assert.match(html, /<button[^>]*data-acquisition-autofocus="true"[^>]*>actions\.close<\/button>/);
  assert.ok(html.includes("extension.acquisition.loading"));
});

test("acquisition modal CSS outranks the generic layer and remains inside short viewports", () => {
  const styles = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
  assert.match(
    styles,
    /\.modal-panel\.acquisition-modal-panel\s*\{[^}]*max-height:\s*min\(760px,\s*100%\)/s,
  );
  assert.match(
    styles,
    /\.modal-layer\.acquisition-modal-layer\s*\{[^}]*padding:\s*min\(24px,\s*4dvh\)\s+min\(24px,\s*4dvw\)/s,
  );
  assert.match(styles, /\.acquisition-search-field\s*\{[^}]*border:\s*1px solid/s);
  assert.match(styles, /\.acquisition-search-control input\s*\{[^}]*border:\s*0;[^}]*border-radius:\s*0/s);
  assert.match(
    styles,
    /@media \(max-width:\s*1024px\)\s*\{[\s\S]*?\.acquisition-result-list\.view-four\s*\{[^}]*grid-template-columns:\s*repeat\(2,/,
  );
  const genericFocus = styles.indexOf("input:focus,");
  const compositeFocus = styles.indexOf(".acquisition-search-field input:focus,");
  assert.ok(genericFocus >= 0 && compositeFocus > genericFocus, "composite search focus reset must win the generic input focus rule");
});

test("Get extensions owns the single local-import entry and keeps the redundant search label nonvisual", () => {
  const source = readFileSync(new URL("./ExtensionRegistryPanel.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/t\("actions\.addExtension"\)/g) ?? []).length, 1);
  assert.equal((source.match(/importExtensionDirectory\(\)/g) ?? []).length, 1);
  assert.equal((source.match(/importExtensionArchive\("zip"\)/g) ?? []).length, 1);
  assert.equal((source.match(/importExtensionArchive\("crx"\)/g) ?? []).length, 1);
  assert.ok(source.includes('aria-label={t("extension.acquisition.search.label")}'));
  assert.ok(!source.includes('className="acquisition-search-label"'));
});

test("stable acquisition error codes produce localized primary copy and bounded raw diagnostics", () => {
  const zhT = localeTranslator(extensionAcquisitionZhCN);
  const enT = localeTranslator(extensionAcquisitionEnUS);
  const clientError = {
    code: "ARTIFACT_CHANNEL_DISABLED",
    message: "The package channel changed.",
  };

  assert.deepEqual(formatExtensionAcquisitionError(clientError, zhT), {
    primary: extensionAcquisitionZhCN["extension.acquisition.errorCode.ARTIFACT_CHANNEL_DISABLED"],
  });
  assert.deepEqual(formatExtensionAcquisitionError(clientError, enT), {
    primary: extensionAcquisitionEnUS["extension.acquisition.errorCode.ARTIFACT_CHANNEL_DISABLED"],
  });

  const unknown = formatExtensionAcquisitionError({
    code: "FUTURE_PROVIDER_FAILURE",
    message: `  provider\n${"x".repeat(400)}  `,
  }, zhT);
  assert.equal(unknown.primary, extensionAcquisitionZhCN["extension.acquisition.error"]);
  assert.equal(unknown.detail?.includes("\n"), false);
  assert.equal(unknown.detail?.length, 300);
  assert.ok(unknown.detail?.endsWith("…"));
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

test("catalog rendering announces omitted aliases and exposes whole-card detail activation", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    locale: "en-US",
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenDetail: () => undefined,
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
  assert.ok(html.includes("acquisition-result-card-surface"));
  assert.ok(html.includes("acquisition-result-arrow"));
  assert.ok(html.includes("extension.acquisition.results.summary:query=userscript"));
  assert.ok(!html.includes("Remote results"));
  assert.ok(!html.includes("count=1"));
  assert.ok(!html.includes("extension.acquisition.results.viewList"));
  assert.ok(!html.includes("extension.acquisition.results.details"));
  assert.ok(!html.includes("extension.acquisition.openWebStore"));
  assert.ok(html.includes("extension.acquisition.loadMore"));
  assert.match(html, /role="status"/);
});

test("catalog search loading is a spinner-only status without a cancellation action", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    locale: "en-US",
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    status: "loading",
    t,
  }));
  assert.ok(html.includes("acquisition-loading-spinner"));
  assert.ok(html.includes("acquisition-visually-hidden"));
  assert.ok(!html.includes("actions.cancelOperation"));
});

test("catalog supports four-column cards with Chrome marks and a detail child view without observation timestamps", () => {
  const item = {
    namespace: "chrome-web-store" as const,
    storeId: "a".repeat(32),
    storeUrl: `https://chromewebstore.google.com/detail/${"a".repeat(32)}`,
    catalogProviderId: "crxsoso" as const,
    observedAt: "2026-08-27T00:00:00.000Z",
    name: "Example",
    description: "Useful extension",
    category: "Productivity",
    rating: 4.8,
    userCount: 1_200_000,
    iconUrl: "https://lhimg.crxsoso.com/icon/example.png",
    version: "5.5.0",
    updatedAt: "2026-08-26T00:00:00.000Z",
    size: "1.64MiB",
    manifestVersion: 3,
    developer: "Example Developer",
    overview: "Full extension overview",
  };
  const grid = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    locale: "en-US",
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenDetail: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    onViewModeChange: () => undefined,
    page: { query: "example", items: [item], excludedNonCanonicalCount: 0, hasMore: false },
    status: "ready",
    t,
    viewMode: "four",
    installedStoreIds: new Set([item.storeId]),
  }));

  assert.ok(grid.includes("acquisition-result-list view-four"));
  assert.ok(grid.includes("acquisition-result-glyph"));
  assert.ok(grid.includes("decoding=\"async\""));
  assert.ok(!grid.includes("loading=\"lazy\""));
  assert.ok(grid.includes("lhimg.crxsoso.com/icon/example.png"));
  assert.ok(!grid.includes("extension.acquisition.results.details"));
  assert.ok(!grid.includes("extension.acquisition.openWebStore"));
  assert.ok(grid.includes("extension.acquisition.results.end"));
  assert.ok(grid.includes("extension.acquisition.results.installed"));
  assert.match(grid, /aria-label="extension\.acquisition\.results\.viewFour"[^>]*aria-pressed="true"/);
  assert.ok(!grid.includes(item.observedAt));

  const detail = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    detailItem: item,
    detailFooter: React.createElement("button", { type: "button" }, "channel-action"),
    detailProviderId: "crxsoso",
    installedStoreIds: new Set([item.storeId]),
    locale: "en-US",
    onBackDetail: () => undefined,
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    page: { query: "example", items: [item], excludedNonCanonicalCount: 0, hasMore: false },
    status: "ready",
    t,
  }));
  assert.ok(detail.includes("extension.acquisition.results.back"));
  assert.ok(detail.includes("channel-action"));
  assert.ok(detail.includes("extension.acquisition.results.openProvider"), "the detail hero keeps an external listing action");
  assert.ok(!detail.includes("extension.acquisition.results.choose"));
  assert.ok(detail.includes(item.storeId));
  assert.ok(detail.includes(`href="https://chromewebstore.google.com/detail/${item.storeId}"`));
  assert.ok(detail.includes("extension.acquisition.results.updatedAt"));
  assert.ok(detail.includes("extension.acquisition.results.size"));
  assert.ok(detail.includes("extension.acquisition.results.overview"));
  assert.ok(detail.includes("Full extension overview"));
  assert.ok(detail.includes("extension.acquisition.results.installed"));
  assert.ok(!detail.includes(item.observedAt));
});

test("catalog download counts use stable K/M/B units regardless of locale", () => {
  assert.equal(formatAcquisitionCount(999), "999");
  assert.equal(formatAcquisitionCount(1_200), "1.2K");
  assert.equal(formatAcquisitionCount(12_345), "12.3K");
  assert.equal(formatAcquisitionCount(1_200_000), "1.2M");
  assert.equal(formatAcquisitionCount(2_000_000_000), "2B");
});

test("cancelling pagination retains results but exposes one explicit retry instead of an active load-more path", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionCatalogResults, {
    locale: "en-US",
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
    error: { message: "provider unavailable" },
    locale: "en-US",
    onChoose: () => undefined,
    onLoadMore: () => undefined,
    onOpenListing: () => undefined,
    onRetry: () => undefined,
    status: "error",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.error"));
  assert.ok(html.includes("provider unavailable"));
  assert.ok(!html.includes("extension.acquisition.results.errorTitle"));
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

test("a Google failure still offers an explicit CRX搜搜 action when the server returned only the selected channel", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionArtifactChannelChoice, {
    onOpenListing: () => undefined,
    onSelect: () => undefined,
    onStart: () => undefined,
    providerFailure: { providerId: "chrome-web-store", message: "offline" },
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
    t,
  }));
  assert.ok(html.includes("extension.acquisition.channel.tryMirror"));
});

test("an originally empty exact-resolution offer list never invents a fallback channel", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionArtifactChannelChoice, {
    onOpenListing: () => undefined,
    onSelect: () => undefined,
    onStart: () => undefined,
    providerFailure: { providerId: "chrome-web-store", message: "offline" },
    resolution: {
      namespace: "chrome-web-store",
      storeId: "b".repeat(32),
      storeUrl: `https://chromewebstore.google.com/detail/${"b".repeat(32)}`,
      offers: [],
    },
    selectedProviderId: "chrome-web-store",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.channel.noneTitle"));
  assert.ok(!html.includes("extension.acquisition.channel.tryMirror"));
  assert.ok(!html.includes("extension.acquisition.channel.tryGoogle"));
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

test("an installed result exposes status without another Get-page install action", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionArtifactChannelChoice, {
    installed: true,
    onOpenListing: () => undefined,
    onSelect: () => undefined,
    onStart: () => undefined,
    providerFailure: { providerId: "crxsoso", message: "stale failure" },
    resolution: {
      namespace: "chrome-web-store",
      storeId: "b".repeat(32),
      storeUrl: `https://chromewebstore.google.com/detail/${"b".repeat(32)}`,
      offers: [{
        namespace: "chrome-web-store",
        storeId: "b".repeat(32),
        artifactProviderId: "crxsoso",
        format: "crx3",
        providerLabel: "CRX搜搜",
      }],
    },
    selectedProviderId: "crxsoso",
    t,
  }));

  assert.ok(html.includes("extension.acquisition.results.installed"));
  assert.ok(!html.includes("extension.acquisition.channel.start"));
  assert.ok(!html.includes("extension.acquisition.channel.tryGoogle"));
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

test("a confirming ready update replaces review details with compact installation progress", () => {
  const report = preflight({
    conflicts: [{
      extensionId: "extension_existing",
      name: "Example",
      version: "1.0.0",
      installState: "installed",
      matchBy: "store-identity",
      eligible: true,
    }],
  });
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSessionPanel, {
    locale: "en-US",
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onDone: () => undefined,
    onRetry: () => undefined,
    operation: "confirming",
    session: { ...readySession(report), purpose: "update" },
    t,
    targetExtensionId: "extension_existing",
  }));

  assert.ok(html.includes("extension.acquisition.progress.committing"));
  assert.ok(!html.includes("extension.acquisition.confirm.technicalDetails"));
  assert.ok(!html.includes("actions.cancel"));
});

test("ready review keeps package, channel, proof, risk and discrepancy facts behind technical details", () => {
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

test("consumed acquisition keeps success visible while refresh failure offers an explicit retry", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSessionPanel, {
    confirmedExtension: { id: "extension-1", name: "Example", version: "1.2.3" },
    locale: "en-US",
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onDone: () => undefined,
    onRetry: () => undefined,
    onRetryStateRefresh: () => undefined,
    operation: "idle",
    refreshError: { code: "ACQUISITION_STATE_REFRESH_FAILED", message: "state unavailable" },
    session: {
      sessionId: "session_12345678901234567890123456789012",
      purpose: "install",
      namespace: "chrome-web-store",
      storeId: "c".repeat(32),
      selectedProviderId: "chrome-web-store",
      status: "consumed",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:01:00.000Z",
    },
    t: localeTranslator(extensionAcquisitionEnUS),
  }));

  assert.ok(html.includes(extensionAcquisitionEnUS["extension.acquisition.success.title"]));
  assert.ok(html.includes(extensionAcquisitionEnUS["extension.acquisition.errorCode.ACQUISITION_STATE_REFRESH_FAILED"]));
  assert.ok(!html.includes("state unavailable"));
  assert.ok(html.includes(extensionAcquisitionEnUS["extension.acquisition.success.retryRefresh"]));
  assert.match(html, /role="alert"/);
});

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

function localeTranslator(
  dictionary: Readonly<Record<string, string>>,
): ExtensionAcquisitionUiTranslator {
  return (key) => dictionary[key] ?? key;
}
