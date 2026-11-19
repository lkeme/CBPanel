import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionEntity } from "../shared/entities";
import type {
  ExtensionAcquisitionSessionView,
  ExtensionCapabilityView,
  ExtensionCatalogItem,
  ExtensionCatalogSearchPage,
  ExtensionReferenceResolution,
} from "../shared/extensionAcquisition";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../shared/settings";
import {
  createExtensionAcquisitionClient,
  type ExtensionAcquisitionConfirmationResult,
  type ExtensionAcquisitionRequest,
} from "./extensionAcquisitionClient";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

test("the acquisition client sends only normalized feature payloads to fixed routes", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const responses: unknown[] = [
    [] satisfies ExtensionCapabilityView[],
    searchPage(),
    detailItem() satisfies ExtensionCatalogItem,
    resolution(),
    session("created"),
    session("ready"),
    session("cancelled"),
    { session: session("consumed"), extension: extension() } satisfies ExtensionAcquisitionConfirmationResult,
    settingsResponse(),
    extension(),
  ];
  const request: ExtensionAcquisitionRequest = async <Response>(url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return responses.shift() as Response;
  };
  const client = createExtensionAcquisitionClient(request);
  const signal = new AbortController().signal;

  await client.capabilities(signal);
  await client.search({ query: "privacy", cursor: "opaque_cursor" }, signal);
  await client.detail!(STORE_ID, signal);
  await client.resolve({ input: STORE_ID }, signal);
  await client.createSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
    catalogObservationId: "abcdefghijklmnopqrstuvwxyzABCDEJ",
  }, signal);
  await client.getSession("session/unsafe", signal);
  await client.cancelSession("session/unsafe", signal);
  await client.confirmSession("session/unsafe", {
    disposition: "create",
    environmentIds: ["environment-1"],
  }, signal);
  await client.saveSettings({ artifactProviderId: "crxsoso" }, signal);
  await client.transitionUpdateProvider("extension/unsafe", "crxsoso", signal);

  assert.deepEqual(calls.map((call) => [call.url, call.init?.method]), [
    ["/api/extension-acquisition/capabilities", "GET"],
    ["/api/extension-acquisition/search", "POST"],
    [`/api/extension-acquisition/detail/${STORE_ID}`, "GET"],
    ["/api/extension-acquisition/resolve", "POST"],
    ["/api/extension-acquisition/sessions", "POST"],
    ["/api/extension-acquisition/sessions/session%2Funsafe", "GET"],
    ["/api/extension-acquisition/sessions/session%2Funsafe", "DELETE"],
    ["/api/extension-acquisition/sessions/session%2Funsafe/confirm", "POST"],
    ["/api/settings", "PUT"],
    ["/api/extension-acquisition/extensions/extension%2Funsafe/update-provider", "PUT"],
  ]);
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { query: "privacy", cursor: "opaque_cursor" });
  assert.deepEqual(calls[2]?.url, `/api/extension-acquisition/detail/${STORE_ID}`);
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body)), { input: STORE_ID });
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body)), {
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
    catalogObservationId: "abcdefghijklmnopqrstuvwxyzABCDEJ",
  });
  assert.deepEqual(JSON.parse(String(calls[7]?.init?.body)), {
    disposition: "create",
    environmentIds: ["environment-1"],
  });
  assert.deepEqual(JSON.parse(String(calls[8]?.init?.body)), {
    extensionAcquisition: { artifactProviderId: "crxsoso" },
  });
  assert.deepEqual(JSON.parse(String(calls[9]?.init?.body)), { providerId: "crxsoso" });
  assert.equal(calls.every((call) => call.init?.signal === signal), true);
});

function searchPage(): ExtensionCatalogSearchPage {
  return { query: "privacy", items: [], excludedNonCanonicalCount: 0, hasMore: false };
}

function detailItem(): ExtensionCatalogItem {
  return {
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    storeUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    catalogProviderId: "crxsoso",
    observedAt: "2026-08-27T00:00:00.000Z",
    name: "Extension",
  };
}

function resolution(): ExtensionReferenceResolution {
  return {
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    storeUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    offers: [],
  };
}

function session(status: ExtensionAcquisitionSessionView["status"]): ExtensionAcquisitionSessionView {
  return {
    sessionId: "abcdefghijklmnopqrstuvwxyzABCDEJ",
    purpose: "install",
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    selectedProviderId: "chrome-web-store",
    status,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:01.000Z",
  };
}

function extension(): ExtensionEntity {
  return {
    id: "extension-1",
    name: "Extension",
    description: "",
    sourceKind: "local-crx",
    sourceUrl: "artifact.crx",
    version: "1.0.0",
    permissions: [],
    hostPermissions: [],
    permissionRisks: [],
    installState: "installed",
    updatePolicy: "notify",
    status: "enabled",
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:01.000Z",
  };
}

function settingsResponse(): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    extensionAcquisition: {
      artifactProviderId: "crxsoso",
      crxsosoDisclosureVersionAccepted: 1,
    },
  };
}
