import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAcquisitionClient, ExtensionAcquisitionConfirmationResult } from "../lib/extensionAcquisitionClient";
import type { ExtensionEntity } from "../shared/entities";
import {
  chromeWebStoreListingUrl,
  extensionCapabilityDescriptors,
  type ExtensionAcquisitionSessionView,
  type ExtensionCatalogItem,
  type ExtensionCatalogSearchPage,
} from "../shared/extensionAcquisition";
import { DEFAULT_APP_SETTINGS, type ExtensionAcquisitionSettings } from "../shared/settings";
import {
  createInitialExtensionAcquisitionState,
  extensionAcquisitionReducer,
} from "./extensionAcquisitionState";
import { createExtensionAcquisitionController } from "./useExtensionAcquisition";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";
const SECOND_STORE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

test("typing and disclosure dismissal make no catalog request, and acceptance persists first", async () => {
  const persistence = deferred<void>();
  const events: string[] = [];
  const client = stubClient({
    search: async ({ query }) => {
      events.push(`search:${query}`);
      return page(query, []);
    },
  });
  const controller = createExtensionAcquisitionController({
    settings: settings({ crxsosoDisclosureVersionAccepted: 0 }),
    client,
    reloadState: async () => undefined,
    persistSettings: async (patch) => {
      events.push(`persist:${patch.crxsosoDisclosureVersionAccepted}`);
      await persistence.promise;
    },
  });

  controller.setInput("privacy tools");
  assert.equal(events.length, 0);
  await controller.submit();
  assert.equal(controller.getState().disclosure.open, true);
  assert.equal(events.length, 0);
  controller.dismissDisclosure();
  assert.equal(events.length, 0);

  await controller.submit();
  const accepting = controller.acceptDisclosure();
  await flush();
  assert.deepEqual(events, ["persist:1"]);
  persistence.resolve();
  assert.equal(await accepting, true);
  assert.deepEqual(events, ["persist:1", "search:privacy tools"]);
  assert.equal(controller.getState().settings.crxsosoDisclosureVersionAccepted, 1);
  assert.equal(controller.getState().disclosure.open, false);
});

test("unsupported URLs and locally disabled remote combinations fail without an API request", async () => {
  let searchCalls = 0;
  let resolveCalls = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({
      crxsosoSearchEnabled: false,
      googleArtifactEnabled: false,
      crxsosoArtifactEnabled: false,
      crxsosoDisclosureVersionAccepted: 1,
    }),
    client: stubClient({
      search: async () => {
        searchCalls += 1;
        return page("unused", []);
      },
      resolve: async () => {
        resolveCalls += 1;
        throw new Error("must not resolve");
      },
    }),
    reloadState: async () => undefined,
  });

  controller.setInput(`https://example.test/detail/${STORE_ID}`);
  await controller.submit();
  assert.equal(controller.getState().discovery.error?.code, "ACQUISITION_INPUT_UNSUPPORTED");

  controller.setInput("privacy");
  await controller.submit();
  assert.equal(controller.getState().discovery.error?.code, "CATALOG_SEARCH_DISABLED");

  controller.setInput(STORE_ID);
  await controller.submit();
  assert.equal(controller.getState().discovery.error?.code, "REMOTE_ACQUISITION_DISABLED");
  assert.deepEqual({ searchCalls, resolveCalls }, { searchCalls: 0, resolveCalls: 0 });
});

test("all eight capability combinations gate keyword search and exact resolution independently", async () => {
  for (let mask = 0; mask < 8; mask += 1) {
    const crxsosoSearchEnabled = Boolean(mask & 1);
    const googleArtifactEnabled = Boolean(mask & 2);
    const crxsosoArtifactEnabled = Boolean(mask & 4);
    let searchCalls = 0;
    let resolveCalls = 0;
    const controller = createExtensionAcquisitionController({
      settings: settings({
        crxsosoSearchEnabled,
        googleArtifactEnabled,
        crxsosoArtifactEnabled,
      }),
      client: stubClient({
        search: async ({ query }) => {
          searchCalls += 1;
          return page(query, []);
        },
        resolve: async () => {
          resolveCalls += 1;
          return {
            namespace: "chrome-web-store",
            storeId: STORE_ID,
            storeUrl: chromeWebStoreListingUrl(STORE_ID),
            offers: [],
          };
        },
      }),
      reloadState: async () => undefined,
    });

    controller.setInput("privacy tools");
    await controller.submit();
    controller.setInput(STORE_ID);
    await controller.submit();

    assert.equal(searchCalls, crxsosoSearchEnabled ? 1 : 0, `search mask ${mask}`);
    assert.equal(
      resolveCalls,
      googleArtifactEnabled || crxsosoArtifactEnabled ? 1 : 0,
      `resolve mask ${mask}`,
    );
  }
});

test("a disabled artifact channel retains the attempted request for an explicit retry after enablement", async () => {
  let createCalls = 0;
  const request = {
    namespace: "chrome-web-store" as const,
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store" as const,
    purpose: "update" as const,
    targetExtensionId: "extension-1",
  };
  const controller = createExtensionAcquisitionController({
    settings: settings({ googleArtifactEnabled: false }),
    client: stubClient({
      createSession: async (input) => {
        createCalls += 1;
        return { ...session("rejected", input.artifactProviderId), purpose: input.purpose };
      },
    }),
    reloadState: async () => undefined,
  });

  assert.equal(await controller.startSession(request), undefined);
  assert.equal(controller.getState().session.error?.code, "ARTIFACT_CHANNEL_DISABLED");
  assert.deepEqual(controller.getState().session.lastRequest, request);
  assert.equal(createCalls, 0);

  assert.equal(await controller.setCapabilityEnabled("google-artifact", true), true);
  await controller.retrySession();
  assert.equal(createCalls, 1);
});

test("a newer explicit submission aborts and rejects a late stale search response", async () => {
  const searches = new Map<string, ReturnType<typeof deferred<ExtensionCatalogSearchPage>>>();
  const signals = new Map<string, AbortSignal | undefined>();
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      search: (request, signal) => {
        const pending = deferred<ExtensionCatalogSearchPage>();
        searches.set(request.query, pending);
        signals.set(request.query, signal);
        return pending.promise;
      },
    }),
    reloadState: async () => undefined,
  });

  controller.setInput("first");
  const first = controller.submit();
  controller.setInput("second");
  const second = controller.submit();
  assert.equal(signals.get("first")?.aborted, true);

  searches.get("second")?.resolve(page("second", [catalogItem(SECOND_STORE_ID, "Second")]));
  await second;
  searches.get("first")?.resolve(page("first", [catalogItem(STORE_ID, "First")]));
  await first;

  assert.equal(controller.getState().discovery.page?.query, "second");
  assert.deepEqual(controller.getState().discovery.page?.items.map((item) => item.name), ["Second"]);
});

test("pagination accumulates canonical results and reducer sequencing rejects stale pages", async () => {
  let call = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      search: async ({ query, cursor }) => {
        call += 1;
        return cursor
          ? {
              query,
              items: [catalogItem(STORE_ID, "Updated"), catalogItem(SECOND_STORE_ID, "Second")],
              excludedNonCanonicalCount: 3,
              hasMore: false,
            }
          : {
              query,
              items: [catalogItem(STORE_ID, "First")],
              excludedNonCanonicalCount: 2,
              cursor: "next_cursor",
              hasMore: true,
            };
      },
    }),
    reloadState: async () => undefined,
  });

  controller.setInput("privacy");
  await controller.submit();
  await controller.loadMore();
  const result = controller.getState().discovery.page;
  assert.equal(call, 2);
  assert.equal(result?.items.length, 2);
  assert.equal(result?.items[0]?.name, "Updated");
  assert.equal(result?.excludedNonCanonicalCount, 5);

  const initial = createInitialExtensionAcquisitionState(settings());
  const pending = extensionAcquisitionReducer(initial, {
    type: "discovery-requested",
    sequence: 2,
    kind: "search",
    submittedInput: "new",
    append: false,
  });
  const stale = extensionAcquisitionReducer(pending, {
    type: "search-loaded",
    sequence: 1,
    page: page("old", []),
    append: false,
  });
  assert.equal(stale, pending);
});

test("Google remains selected after failure and mirror acquisition starts only after an explicit switch", async () => {
  const providers: string[] = [];
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      createSession: async (request) => {
        providers.push(request.artifactProviderId);
        return session("created", request.artifactProviderId, `session-${providers.length}`);
      },
      getSession: async (sessionId) => session("rejected", providers.at(-1) as "chrome-web-store" | "crxsoso", sessionId, {
        code: "ARTIFACT_UNAVAILABLE",
        message: "provider unavailable",
      }),
    }),
    reloadState: async () => undefined,
    pollDelay: async () => undefined,
  });

  await controller.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  await until(() => controller.getState().session.view?.status === "rejected");
  assert.equal(controller.getState().selectedProviderId, "chrome-web-store");

  await controller.retrySession();
  await until(() => providers.length === 2 && controller.getState().session.view?.status === "rejected");
  assert.deepEqual(providers, ["chrome-web-store", "chrome-web-store"]);

  assert.equal(controller.selectProvider("crxsoso"), true);
  await controller.restartWithSelectedProvider();
  await until(() => providers.length === 3 && controller.getState().session.view?.status === "rejected");
  assert.deepEqual(providers, ["chrome-web-store", "chrome-web-store", "crxsoso"]);
});

test("session polling reaches preflight and duplicate confirmation refreshes global state exactly once", async () => {
  let confirmCalls = 0;
  let reloadCalls = 0;
  const confirmation = deferred<ExtensionAcquisitionConfirmationResult>();
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      createSession: async (request) => session("created", request.artifactProviderId),
      getSession: async (sessionId) => session("ready", "chrome-web-store", sessionId),
      confirmSession: async () => {
        confirmCalls += 1;
        return confirmation.promise;
      },
    }),
    reloadState: async () => {
      reloadCalls += 1;
    },
    pollDelay: async () => undefined,
  });

  await controller.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  await until(() => controller.getState().session.view?.status === "ready");

  const first = controller.confirm({ disposition: "create" });
  const duplicate = controller.confirm({ disposition: "create" });
  assert.equal(confirmCalls, 1);
  confirmation.resolve({ session: session("consumed", "chrome-web-store"), extension: extension() });
  const [firstResult, duplicateResult] = await Promise.all([first, duplicate]);

  assert.equal(firstResult?.extension.id, "extension-1");
  assert.equal(duplicateResult?.extension.id, "extension-1");
  assert.equal(confirmCalls, 1);
  assert.equal(reloadCalls, 1);
  assert.equal(controller.getState().session.view?.status, "consumed");
});

test("a post-confirm state refresh failure preserves acquisition success as a separate outcome", async () => {
  const result = { session: session("consumed", "chrome-web-store"), extension: extension() };
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      createSession: async () => session("ready", "chrome-web-store"),
      confirmSession: async () => result,
    }),
    reloadState: async () => {
      throw new Error("state unavailable");
    },
  });
  await controller.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  const confirmed = await controller.confirm({ disposition: "create" });

  assert.equal(confirmed?.extension.id, "extension-1");
  assert.equal(controller.getState().session.confirmation?.extension.id, "extension-1");
  assert.equal(controller.getState().session.refreshError?.code, "ACQUISITION_STATE_REFRESH_FAILED");
  assert.equal(controller.getState().session.error, undefined);
});

test("disabling catalog search aborts the active request and discards its late response", async () => {
  const pending = deferred<ExtensionCatalogSearchPage>();
  let searchSignal: AbortSignal | undefined;
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      search: async (_request, signal) => {
        searchSignal = signal;
        return pending.promise;
      },
    }),
    persistSettings: async () => undefined,
    reloadState: async () => undefined,
  });
  controller.setInput("privacy");
  const searching = controller.submit();
  const disabling = controller.setCapabilityEnabled("crxsoso-search", false);
  await disabling;
  assert.equal(searchSignal?.aborted, true);
  pending.resolve(page("privacy", [catalogItem(STORE_ID, "Late")]));
  await searching;

  assert.equal(controller.getState().settings.crxsosoSearchEnabled, false);
  assert.equal(controller.getState().discovery.status, "cancelled");
  assert.equal(controller.getState().discovery.page, undefined);
});

test("retry and pagination recheck disclosure and current capability settings before every request", async () => {
  let searchCalls = 0;
  let resolveCalls = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({
      crxsosoSearchEnabled: false,
      crxsosoDisclosureVersionAccepted: 0,
    }),
    client: stubClient({
      search: async ({ query }) => {
        searchCalls += 1;
        return {
          ...page(query, [catalogItem(STORE_ID, "First")]),
          cursor: "next_cursor",
          hasMore: true,
        };
      },
      resolve: async () => {
        resolveCalls += 1;
        throw new Error("provider unavailable");
      },
    }),
    persistSettings: async () => undefined,
    reloadState: async () => undefined,
  });

  controller.setInput("privacy");
  await controller.submit();
  assert.equal(controller.getState().discovery.error?.code, "CATALOG_SEARCH_DISABLED");
  await controller.setCapabilityEnabled("crxsoso-search", true);
  await controller.retryDiscovery();
  assert.equal(searchCalls, 0);
  assert.equal(controller.getState().disclosure.open, true);

  controller.syncSettings(settings({ crxsosoDisclosureVersionAccepted: 1 }));
  await controller.retryDiscovery();
  assert.equal(searchCalls, 1);
  const retainedPage = controller.getState().discovery.page;
  await controller.setCapabilityEnabled("crxsoso-search", false);
  await controller.loadMore();
  assert.equal(searchCalls, 1);
  assert.equal(controller.getState().discovery.error?.code, "CATALOG_SEARCH_DISABLED");
  assert.equal(controller.getState().discovery.page, retainedPage);

  controller.setInput(STORE_ID);
  await controller.submit();
  assert.equal(resolveCalls, 1);
  await controller.setCapabilityEnabled("google-artifact", false);
  await controller.setCapabilityEnabled("crxsoso-artifact", false);
  await controller.retryDiscovery();
  assert.equal(resolveCalls, 1);
  assert.equal(controller.getState().discovery.error?.code, "REMOTE_ACQUISITION_DISABLED");
});

test("failed update-provider transition retains the prior provider projection", async () => {
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      transitionUpdateProvider: async () => {
        throw Object.assign(new Error("transition refused"), { code: "ACQUISITION_UPDATE_PROVIDER_INVALID" });
      },
    }),
    reloadState: async () => undefined,
  });

  const result = await controller.transitionUpdateProvider("extension-1", "chrome-web-store", "crxsoso");
  assert.equal(result, undefined);
  assert.equal(controller.getState().updateProvider.status, "error");
  assert.equal(controller.getState().updateProvider.previousProviderId, "chrome-web-store");
  assert.equal(controller.getState().updateProvider.requestedProviderId, "crxsoso");
  assert.equal(controller.getState().updateProvider.extension, undefined);
});

function stubClient(overrides: Partial<ExtensionAcquisitionClient> = {}): ExtensionAcquisitionClient {
  const base: ExtensionAcquisitionClient = {
    capabilities: async () => extensionCapabilityDescriptors(settings()),
    search: async ({ query }) => page(query, []),
    resolve: async () => ({
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      storeUrl: chromeWebStoreListingUrl(STORE_ID),
      offers: [],
    }),
    createSession: async (request) => session("created", request.artifactProviderId),
    getSession: async (sessionId) => session("ready", "chrome-web-store", sessionId),
    cancelSession: async (sessionId) => session("cancelled", "chrome-web-store", sessionId),
    confirmSession: async () => ({ session: session("consumed", "chrome-web-store"), extension: extension() }),
    saveSettings: async () => ({ ...DEFAULT_APP_SETTINGS }),
    transitionUpdateProvider: async (_extensionId, providerId) => ({ ...extension(), updateProviderId: providerId }),
  };
  return { ...base, ...overrides };
}

function settings(
  patch: Partial<ExtensionAcquisitionSettings> = {},
): ExtensionAcquisitionSettings {
  return {
    ...DEFAULT_APP_SETTINGS.extensionAcquisition,
    crxsosoDisclosureVersionAccepted: 1,
    ...patch,
  };
}

function catalogItem(storeId: string, name: string): ExtensionCatalogItem {
  return {
    observationId: `observation-${storeId}`,
    namespace: "chrome-web-store",
    storeId,
    storeUrl: chromeWebStoreListingUrl(storeId),
    catalogProviderId: "crxsoso",
    observedAt: "2026-08-27T00:00:00.000Z",
    name,
  };
}

function page(query: string, items: ExtensionCatalogItem[]): ExtensionCatalogSearchPage {
  return { query, items, excludedNonCanonicalCount: 0, hasMore: false };
}

function session(
  status: ExtensionAcquisitionSessionView["status"],
  selectedProviderId: "chrome-web-store" | "crxsoso",
  sessionId = "abcdefghijklmnopqrstuvwxyzABCDEJ",
  error?: ExtensionAcquisitionSessionView["error"],
): ExtensionAcquisitionSessionView {
  return {
    sessionId,
    purpose: "install",
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    selectedProviderId,
    status,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:01.000Z",
    error,
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

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value: Value): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await flush();
  }
  assert.fail("Timed out waiting for acquisition state.");
}
