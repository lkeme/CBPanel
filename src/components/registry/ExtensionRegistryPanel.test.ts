import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TranslationKey } from "../../i18n";
import type { ExtensionEntity } from "../../shared/entities";
import { canAutoCheckExtension } from "../../hooks/useExtensionActions";
import { ExtensionAcquisitionSessionPanel } from "./ExtensionAcquisitionSessionPanel";
import { ExtensionAcquisitionStartError } from "./ExtensionAcquisitionResults";
import {
  browserRuntimeIdFromManifestKey,
  canStartTrustedExtensionAcquisitionUpdate,
  canonicalExtensionListingUrl,
  extensionForSelectedUpdateProvider,
  extensionResolutionForSelectedProvider,
  extensionSessionBlocksOtherStore,
  extensionSessionMatchesResolution,
  restoreExtensionAcquisitionScrollPosition,
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

  assert.ok(html.includes("extension.detail.updateProvider.readOnly"));
  assert.doesNotMatch(html, /<select[^>]*update-provider|extension\.detail\.updateProvider\.select/);
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

test("catalog detail back restores the captured scroll position without allowing invalid values", () => {
  const scroller = { scrollTop: 0 } as HTMLElement;
  restoreExtensionAcquisitionScrollPosition(scroller, 184);
  assert.equal(scroller.scrollTop, 184);
  restoreExtensionAcquisitionScrollPosition(scroller, -20);
  assert.equal(scroller.scrollTop, 0);
  restoreExtensionAcquisitionScrollPosition(scroller, Number.NaN);
  assert.equal(scroller.scrollTop, 0);
  restoreExtensionAcquisitionScrollPosition(null, 10);
});

test("exact selections project a changed built-in channel without inventing an originally empty offer", () => {
  const selection = {
    namespace: "chrome-web-store" as const,
    storeId: STORE_ID,
    storeUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    source: "reference" as const,
    resolution: {
      namespace: "chrome-web-store" as const,
      storeId: STORE_ID,
      storeUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
      offers: [{
        namespace: "chrome-web-store" as const,
        storeId: STORE_ID,
        artifactProviderId: "chrome-web-store" as const,
        format: "crx3" as const,
        providerLabel: "Google",
      }],
    },
  };
  const switched = extensionResolutionForSelectedProvider(selection, "crxsoso", "CRX搜搜");
  assert.deepEqual(switched?.offers.map((offer) => offer.artifactProviderId), ["crxsoso"]);
  assert.equal(switched?.storeId, STORE_ID);

  const empty = extensionResolutionForSelectedProvider({ ...selection, resolution: { ...selection.resolution, offers: [] } }, "crxsoso", "CRX搜搜");
  assert.deepEqual(empty?.offers, []);

  const malformed = extensionResolutionForSelectedProvider({
    ...selection,
    resolution: {
      ...selection.resolution,
      offers: [{ ...selection.resolution.offers[0]!, storeId: "a".repeat(32) }],
    },
  }, "crxsoso", "CRX搜搜");
  assert.deepEqual(malformed?.offers, [], "a malformed nonempty server projection cannot seed a local capability offer");
});

test("failed update session creation exposes source settings and retry recovery", () => {
  const html = renderToStaticMarkup(React.createElement(ExtensionAcquisitionStartError, {
    error: { code: "ARTIFACT_PROVIDER_DISABLED", message: "The provider is disabled." },
    onOpenSources: () => undefined,
    onRetry: () => undefined,
    t,
  }));
  assert.match(html, /role="alert"/);
  assert.ok(html.includes("extension.acquisition.error"));
  assert.ok(html.includes("The provider is disabled."));
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

test("trusted updates transition to the global channel before a new session uses it", async () => {
  const extension = verifiedExtension({ updateProviderId: "chrome-web-store" });
  const transitions: Array<[string, string, string]> = [];
  const transitioned = await extensionForSelectedUpdateProvider({
    extension,
    selectedProviderId: "crxsoso",
    transitionUpdateProvider: async (extensionId, previousProviderId, requestedProviderId) => {
      transitions.push([extensionId, previousProviderId, requestedProviderId]);
      return { ...extension, updateProviderId: requestedProviderId };
    },
  });
  assert.deepEqual(transitions, [[extension.id, "chrome-web-store", "crxsoso"]]);
  assert.equal(transitioned?.updateProviderId, "crxsoso");

  let transitionCalled = false;
  assert.equal((await extensionForSelectedUpdateProvider({
    extension,
    selectedProviderId: "chrome-web-store",
    transitionUpdateProvider: async () => {
      transitionCalled = true;
      return undefined;
    },
  }))?.id, extension.id);
  assert.equal(transitionCalled, false);

  assert.equal(await extensionForSelectedUpdateProvider({
    extension,
    selectedProviderId: "crxsoso",
    transitionUpdateProvider: async () => ({ ...extension, updateProviderId: "chrome-web-store" }),
  }), undefined, "a stale or inconsistent server projection cannot start the update session");
});

test("active acquisition sessions block another detail while terminal history does not", () => {
  const request = {
    namespace: "chrome-web-store" as const,
    storeId: STORE_ID,
    artifactProviderId: "crxsoso" as const,
    purpose: "install" as const,
  };
  const view = {
    sessionId: "session_12345678901234567890123456789012",
    purpose: "install" as const,
    namespace: "chrome-web-store" as const,
    storeId: STORE_ID,
    selectedProviderId: "crxsoso" as const,
    status: "downloading" as const,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:01.000Z",
  };
  assert.equal(extensionSessionBlocksOtherStore({
    sequence: 1,
    operation: "polling",
    lastRequest: request,
    view,
  }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
  assert.equal(extensionSessionBlocksOtherStore({
    sequence: 2,
    operation: "idle",
    lastRequest: request,
    view: { ...view, status: "rejected" },
  }, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), false);
  assert.equal(extensionSessionBlocksOtherStore({
    sequence: 3,
    operation: "polling",
    lastRequest: request,
    view,
  }, STORE_ID), false);

  const otherResolution = {
    namespace: "chrome-web-store" as const,
    storeId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    storeUrl: "https://chromewebstore.google.com/detail/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    offers: [],
  };
  const sessionState = {
    sequence: 4,
    operation: "idle" as const,
    lastRequest: { ...request, purpose: "update" as const },
    error: { message: "stale update error" },
  };
  assert.equal(extensionSessionMatchesResolution(sessionState, otherResolution), false);
  assert.equal(extensionSessionMatchesResolution(sessionState, undefined), true);
});

test("legacy remote source ids never qualify for the old background updater", () => {
  const legacy = verifiedExtension({
    sourceKind: "remote-zip",
    sourceId: "retired-source",
    sourceUrl: "https://legacy.invalid/extension.zip",
    storeIdentity: undefined,
    provenance: undefined,
    updateProviderId: undefined,
    updatePolicy: "auto",
  });
  assert.equal(canAutoCheckExtension(legacy), false);
  assert.equal(canAutoCheckExtension(verifiedExtension({
    sourceKind: "local-zip",
    sourceUrl: "D:/extensions/local.zip",
    storeIdentity: undefined,
    provenance: undefined,
    updateProviderId: undefined,
    updatePolicy: "notify",
  })), true);
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
    updateProviderTransition,
  }));
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
