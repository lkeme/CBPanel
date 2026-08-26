import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TranslationKey } from "../../i18n";
import type { ExtensionEntity } from "../../shared/entities";
import type { ExtensionAcquisitionSettings } from "../../shared/settings";
import { ExtensionAcquisitionSessionPanel } from "./ExtensionAcquisitionSessionPanel";
import {
  allExtensionRemoteCapabilitiesDisabled,
  browserRuntimeIdFromManifestKey,
  canStartTrustedExtensionAcquisitionUpdate,
  canonicalExtensionListingUrl,
  ExtensionAcquisitionStartError,
  ExtensionLocalImportActions,
  ExtensionRemoteDisabledNotice,
  usesTrustedExtensionAcquisitionUpdate,
} from "./ExtensionRegistryPanel";
import {
  displayedExtensionUpdateProviderId,
  ExtensionRowDetail,
} from "./ExtensionRegistryDetail";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";
const t = (key: TranslationKey, params?: Record<string, string | number>) => (
  params ? `${key}:${Object.values(params).join(",")}` : key
);

test("library details distinguish all identities and retain verified provenance facts", () => {
  const extension = verifiedExtension();
  const html = renderDetail(extension, {
    sequence: 1,
    status: "error",
    extensionId: extension.id,
    previousProviderId: "chrome-web-store",
    requestedProviderId: "crxsoso",
    error: { message: "transition refused" },
  });

  for (const fact of [
    "extension.detail.extensionId",
    "extension.detail.webStoreId",
    "extension.detail.browserRuntimeId",
    extension.id,
    STORE_ID,
    "clients2.googleusercontent.com",
    "chromium-cws",
    "extension.detail.provider.crxsoso",
    "extension.detail.provider.google",
    "extension.detail.verification.cws-publisher-verified",
    "extension.detail.updateState.available",
  ]) assert.ok(html.includes(fact), fact);

  assert.match(html, /<option value="chrome-web-store" selected="">/);
  assert.doesNotMatch(html, /<option[^>]*value="crxsoso"[^>]*selected=""/);
  assert.ok(html.includes("extension.detail.updateProvider.failed:transition refused"));
  assert.match(html, /role="alert"/);
  const updatePolicyControlId = html.match(/<label for="([^"]+)">module\.extensionUpdatePolicy<\/label>/)?.[1];
  assert.ok(updatePolicyControlId);
  assert.ok(html.includes(`id="${updatePolicyControlId}"`));
});

test("failed update-provider display stays on the prior provider while success uses the server entity", () => {
  const extension = verifiedExtension();
  assert.equal(displayedExtensionUpdateProviderId(extension, {
    sequence: 1,
    status: "error",
    extensionId: extension.id,
    previousProviderId: "chrome-web-store",
    requestedProviderId: "crxsoso",
    error: { message: "no" },
  }), "chrome-web-store");
  assert.equal(displayedExtensionUpdateProviderId(extension, {
    sequence: 2,
    status: "success",
    extensionId: extension.id,
    previousProviderId: "chrome-web-store",
    requestedProviderId: "crxsoso",
    extension: { ...extension, updateProviderId: "crxsoso" },
  }), "crxsoso");
});

test("Manifest keys derive the same browser runtime ID as Chromium", async () => {
  const keyBytes = Buffer.from("CBPanel fixed extension identity", "utf8");
  const digest = createHash("sha256").update(keyBytes).digest().subarray(0, 16);
  const expected = [...digest]
    .map((octet) => String.fromCharCode(0x61 + (octet >> 4), 0x61 + (octet & 0x0f)))
    .join("");
  assert.equal(await browserRuntimeIdFromManifestKey(keyBytes.toString("base64")), expected);
});

test("external listing navigation ignores provider URLs and rebuilds from the canonical ID", () => {
  const providerValue = {
    storeId: STORE_ID,
    storeUrl: "https://attacker.invalid/package.crx",
  };
  assert.equal(
    canonicalExtensionListingUrl(providerValue),
    `https://chromewebstore.google.com/detail/${STORE_ID}`,
  );
  assert.throws(() => canonicalExtensionListingUrl({ storeId: "not-canonical" }));
});

test("all-off is the only combination that disables remote acquisition and local imports stay enabled", () => {
  assert.equal(allExtensionRemoteCapabilitiesDisabled(settings()), true);
  assert.equal(allExtensionRemoteCapabilitiesDisabled(settings({ crxsosoSearchEnabled: true })), false);
  assert.equal(allExtensionRemoteCapabilitiesDisabled(settings({ googleArtifactEnabled: true })), false);
  assert.equal(allExtensionRemoteCapabilitiesDisabled(settings({ crxsosoArtifactEnabled: true })), false);

  const html = renderToStaticMarkup(React.createElement(React.Fragment, null,
    React.createElement(ExtensionRemoteDisabledNotice, { onOpenSources: () => undefined, t }),
    React.createElement(ExtensionLocalImportActions, {
      importExtensionArchive: () => undefined,
      importExtensionDirectory: () => undefined,
      t,
    }),
  ));
  assert.ok(html.includes("extension.acquisition.source.allOffHelp"));
  for (const label of ["actions.importDirectory", "actions.importZip", "actions.importCrx"]) {
    assert.match(html, new RegExp(`<button(?:(?!disabled)[^>])*>${label}</button>`));
  }
});

test("failed update session creation exposes source settings and retry recovery", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionStartError, {
    message: "ARTIFACT_PROVIDER_DISABLED",
    onOpenSources: () => undefined,
    onRetry: () => undefined,
    t,
  }));
  assert.match(html, /role="alert"/);
  assert.ok(html.includes("ARTIFACT_PROVIDER_DISABLED"));
  assert.ok(html.includes("extension.acquisition.sources.open"));
  assert.ok(html.includes("extension.acquisition.results.retry"));
});

test("verified rows always route updates through acquisition and success exposes bind-next", () => {
  const extension = verifiedExtension({ installState: "update-available", updateState: { status: "idle" } });
  assert.equal(usesTrustedExtensionAcquisitionUpdate(extension), true);
  assert.equal(canStartTrustedExtensionAcquisitionUpdate(extension), true);
  assert.equal(usesTrustedExtensionAcquisitionUpdate({
    ...extension,
    storeIdentity: undefined,
    updateProviderId: undefined,
  }), false);
  const missingProvider = { ...extension, updateProviderId: undefined };
  const missingIdentity = { ...extension, storeIdentity: undefined };
  assert.equal(usesTrustedExtensionAcquisitionUpdate(missingProvider), true);
  assert.equal(usesTrustedExtensionAcquisitionUpdate(missingIdentity), true);
  assert.equal(canStartTrustedExtensionAcquisitionUpdate(missingProvider), false);
  assert.equal(canStartTrustedExtensionAcquisitionUpdate(missingIdentity), false);

  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionSessionPanel, {
    confirmedExtension: extension,
    locale: "en-US",
    onBindNext: () => undefined,
    onCancel: () => undefined,
    onConfirm: () => undefined,
    onDone: () => undefined,
    onRetry: () => undefined,
    operation: "idle",
    session: {
      sessionId: "session_12345678901234567890123456789012",
      purpose: "install",
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      selectedProviderId: "chrome-web-store",
      status: "consumed",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:01:00.000Z",
    },
    t,
  }));
  assert.ok(html.includes("extension.acquisition.bindNext"));
});

function renderDetail(
  extension: ExtensionEntity,
  updateProviderTransition: Parameters<typeof ExtensionRowDetail>[0]["updateProviderTransition"],
): string {
  return renderToStaticMarkup(React.createElement(ExtensionRowDetail, {
    browserRuntimeIdentity: { status: "known", id: STORE_ID },
    busy: "",
    extension,
    identityPinned: true,
    kindLabel: "Local CRX",
    locale: "en-US",
    setExtensionUpdatePolicy: async () => undefined,
    t,
    toast: () => undefined,
    transitionUpdateProvider: async () => undefined,
    updateProviderSettings: { googleArtifactEnabled: true, crxsosoArtifactEnabled: true },
    updateProviderTransition,
  }));
}

function settings(patch: Partial<ExtensionAcquisitionSettings> = {}): ExtensionAcquisitionSettings {
  return {
    crxsosoSearchEnabled: false,
    googleArtifactEnabled: false,
    crxsosoArtifactEnabled: false,
    crxsosoDisclosureVersionAccepted: 0,
    ...patch,
  };
}

function verifiedExtension(patch: Partial<ExtensionEntity> = {}): ExtensionEntity {
  return {
    id: "extension-record-1",
    name: "Tampermonkey",
    description: "Userscript manager",
    sourceKind: "local-crx",
    sourceUrl: "D:/extensions/current.crx",
    storeIdentity: {
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      listingUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    },
    provenance: {
      schemaVersion: 1,
      catalog: { providerId: "crxsoso", observedAt: "2026-08-27T00:00:00.000Z" },
      artifact: {
        providerId: "chrome-web-store",
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: "2026-08-27T00:01:00.000Z",
        format: "crx3",
        retained: true,
      },
      verification: {
        level: "cws-publisher-verified",
        verifiedAt: "2026-08-27T00:02:00.000Z",
        proofDerivedStoreId: STORE_ID,
        publisherTrustRootId: "chromium-cws",
        publisherTrustRootVersion: 1,
      },
    },
    updateProviderId: "chrome-web-store",
    updateState: {
      status: "available",
      checkedAt: "2026-08-27T00:03:00.000Z",
      availableVersion: "2.0.0",
    },
    version: "1.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    hostPermissions: [],
    permissionRisks: [],
    installState: "installed",
    updatePolicy: "auto",
    localPath: "D:/extensions/unpacked",
    manifestKey: Buffer.from("key").toString("base64"),
    status: "enabled",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:04:00.000Z",
    ...patch,
  };
}
