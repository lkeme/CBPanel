import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionAcquisitionClient, ExtensionAcquisitionConfirmationResult } from "../lib/extensionAcquisitionClient";
import type { ExtensionEntity } from "../shared/entities";
import {
  chromeWebStoreListingUrl,
  extensionCapabilityDescriptors,
  type ExtensionPreflightReport,
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

  await controller.submit();
  assert.deepEqual(events, ["persist:1", "search:privacy tools", "search:privacy tools"]);
  assert.equal(controller.getState().disclosure.open, false, "accepted disclosure is not shown again");
});

test("catalog detail requests are abortable and return optional metadata without changing search state", async () => {
  const item = catalogItem(STORE_ID, "Base");
  let detailCalls = 0;
  let detailSignal: AbortSignal | undefined;
  const detailResponse = deferred<ExtensionCatalogItem>();
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      search: async () => page("privacy", [item]),
      detail: async (_storeId, signal) => {
        detailCalls += 1;
        detailSignal = signal;
        return detailResponse.promise;
      },
    }),
    reloadState: async () => undefined,
  });

  controller.setInput("privacy");
  await controller.submit();
  assert.equal(controller.selectCatalogItem(item), true);
  const detailPending = controller.loadCatalogDetail(STORE_ID);
  await flush();
  detailResponse.resolve({ ...item, name: "Enriched", version: "2.0.0" });
  const detail = await detailPending;
  assert.equal(detail?.name, "Enriched");
  assert.equal(detail?.version, "2.0.0");
  assert.equal(detailCalls, 1);
  assert.equal(detailSignal?.aborted, false);
  assert.equal(controller.getState().discovery.page?.items[0]?.name, "Base");
  controller.dispose();
});

test("persisted acquisition settings fail safe when the disclosure version is outside the known range", async () => {
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "crxsoso", crxsosoDisclosureVersionAccepted: 0 }),
    persistSettings: async () => ({
      artifactProviderId: "chrome-web-store",
      crxsosoDisclosureVersionAccepted: 99,
    }),
    reloadState: async () => undefined,
  });

  assert.equal(await controller.setArtifactProvider("chrome-web-store"), true);
  assert.deepEqual(controller.getState().settings, {
    artifactProviderId: "chrome-web-store",
    crxsosoDisclosureVersionAccepted: 0,
  });
});

test("unsupported URLs stay local while built-in search and the selected channel remain available", async () => {
  let searchCalls = 0;
  let resolveCalls = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "crxsoso", crxsosoDisclosureVersionAccepted: 1 }),
    client: stubClient({
      search: async () => {
        searchCalls += 1;
        return page("unused", []);
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

  controller.setInput(`https://example.test/detail/${STORE_ID}`);
  await controller.submit();
  assert.equal(controller.getState().discovery.error?.code, "ACQUISITION_INPUT_UNSUPPORTED");

  controller.setInput("privacy");
  await controller.submit();

  controller.setInput(STORE_ID);
  await controller.submit();
  assert.deepEqual({ searchCalls, resolveCalls }, { searchCalls: 1, resolveCalls: 1 });
});

test("both canonical channel choices keep keyword search and exact resolution available", async () => {
  for (const artifactProviderId of ["crxsoso", "chrome-web-store"] as const) {
    let searchCalls = 0;
    let resolveCalls = 0;
    const controller = createExtensionAcquisitionController({
      settings: settings({ artifactProviderId }),
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

    assert.equal(searchCalls, 1, `search via ${artifactProviderId}`);
    assert.equal(resolveCalls, 1, `resolve via ${artifactProviderId}`);
  }
});

test("an exact selection starts through the newly persisted channel without resolving again", async () => {
  let resolveCalls = 0;
  const sessionProviders: string[] = [];
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      resolve: async () => {
        resolveCalls += 1;
        return {
          namespace: "chrome-web-store",
          storeId: STORE_ID,
          storeUrl: chromeWebStoreListingUrl(STORE_ID),
          offers: [{
            namespace: "chrome-web-store",
            storeId: STORE_ID,
            artifactProviderId: "chrome-web-store",
            format: "crx3",
            providerLabel: "Chrome Web Store",
          }],
        };
      },
      createSession: async (request) => {
        sessionProviders.push(request.artifactProviderId);
        return session("created", request.artifactProviderId);
      },
    }),
    persistSettings: async () => settings({ artifactProviderId: "crxsoso" }),
    reloadState: async () => undefined,
  });

  controller.setInput(STORE_ID);
  await controller.submit();
  assert.equal(await controller.setArtifactProvider("crxsoso"), true);
  await controller.startSelectedSession();

  assert.equal(resolveCalls, 1);
  assert.deepEqual(sessionProviders, ["crxsoso"]);
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
    settings: settings({ artifactProviderId: "crxsoso" }),
    client: stubClient({
      createSession: async (input) => {
        createCalls += 1;
        return { ...session("rejected", input.artifactProviderId), purpose: input.purpose };
      },
    }),
    persistSettings: async (patch) => settings({
      artifactProviderId: patch.artifactProviderId ?? "crxsoso",
    }),
    reloadState: async () => undefined,
  });

  assert.equal(await controller.startSession(request), undefined);
  assert.equal(controller.getState().session.error?.code, "ARTIFACT_CHANNEL_DISABLED");
  assert.deepEqual(controller.getState().session.lastRequest, request);
  assert.equal(createCalls, 0);

  assert.equal(await controller.setArtifactProvider("chrome-web-store"), true);
  await controller.retrySession();
  assert.equal(createCalls, 1);
});

test("a newer explicit submission aborts and rejects a late stale search response", async () => {
  const searches = new Map<string, ReturnType<typeof deferred<ExtensionCatalogSearchPage>>>();
  const signals = new Map<string, AbortSignal | undefined>();
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
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
  const selected = result?.items[0];
  assert.ok(selected);
  assert.equal(controller.selectCatalogItem(selected), true);
  assert.equal(controller.getState().discovery.page, result, "opening details preserves the accumulated search page");
  assert.equal(controller.getState().selection?.storeId, STORE_ID);
  assert.equal(call, 2, "opening details makes no additional catalog request");
  controller.clearSelection();
  assert.equal(controller.getState().selection, undefined);
  assert.equal(controller.getState().discovery.page, result, "back keeps the accumulated search page");
  assert.equal(call, 2, "back makes no additional catalog request");

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

  const loaded = extensionAcquisitionReducer(pending, {
    type: "search-loaded",
    sequence: 2,
    page: page("new", [catalogItem(STORE_ID, "Selected")]),
    append: false,
  });
  const withSelection = extensionAcquisitionReducer(loaded, {
    type: "catalog-item-selected",
    item: loaded.discovery.page!.items[0]!,
    selectedProviderId: "crxsoso",
  });
  const updating = extensionAcquisitionReducer(withSelection, {
    type: "session-requested",
    sequence: 3,
    request: {
      namespace: "chrome-web-store",
      storeId: SECOND_STORE_ID,
      artifactProviderId: "crxsoso",
      purpose: "update",
      targetExtensionId: "extension-2",
    },
  });
  assert.equal(updating.selection, undefined, "an installed-row update cannot inherit another catalog result");
  assert.equal(updating.discovery.page, withSelection.discovery.page, "clearing identity preserves the search snapshot");
});

test("expired pagination retry restarts the keyword search with a fresh cursor", async () => {
  const requests: Array<string | undefined> = [];
  let call = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings(),
    client: stubClient({
      search: async ({ query, cursor }) => {
        requests.push(cursor);
        call += 1;
        if (call === 2) throw Object.assign(new Error("expired"), { code: "EXTENSION_CATALOG_CURSOR_EXPIRED" });
        return { ...page(query, [catalogItem(STORE_ID, "Fresh")]), cursor: "fresh_cursor", hasMore: true };
      },
    }),
    reloadState: async () => undefined,
  });
  controller.setInput("privacy");
  await controller.submit();
  await controller.loadMore();
  assert.equal(controller.getState().discovery.error?.code, "EXTENSION_CATALOG_CURSOR_EXPIRED");
  assert.ok(controller.getState().discovery.page?.hasMore);
  await controller.retryDiscovery();
  assert.equal(controller.getState().discovery.error, undefined);
  assert.deepEqual(requests, [undefined, "fresh_cursor", undefined]);
});

test("Google remains selected after failure and mirror acquisition starts only after an explicit switch", async () => {
  const providers: string[] = [];
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
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
    persistSettings: async (patch) => settings({
      artifactProviderId: patch.artifactProviderId ?? "chrome-web-store",
    }),
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

  assert.equal(await controller.setArtifactProvider("crxsoso"), true);
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
    settings: settings({ artifactProviderId: "chrome-web-store" }),
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

test("clean ready install is confirmed automatically while permission increases remain explicit", async () => {
  let confirmCalls = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      createSession: async () => ({ ...session("ready", "chrome-web-store"), report: preflightReport() }),
      confirmSession: async () => {
        confirmCalls += 1;
        return { session: session("consumed", "chrome-web-store"), extension: extension() };
      },
    }),
    reloadState: async () => undefined,
  });

  await controller.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  await until(() => controller.getState().session.view?.status === "consumed");
  assert.equal(confirmCalls, 1);

  const approvalController = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      createSession: async () => ({
        ...session("ready", "chrome-web-store"),
        report: preflightReport({
          permissionApproval: { token: "approval-token", added: ["cookies"] },
        }),
      }),
      confirmSession: async () => {
        confirmCalls += 1;
        return { session: session("consumed", "chrome-web-store"), extension: extension() };
      },
    }),
    reloadState: async () => undefined,
  });
  await approvalController.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  await flush();
  assert.equal(approvalController.getState().session.view?.status, "ready");
  assert.equal(confirmCalls, 1, "permission increases still require explicit approval");

  const conflictController = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      createSession: async () => ({
        ...session("ready", "chrome-web-store"),
        report: preflightReport({
          conflicts: [{
            extensionId: "existing-extension",
            name: "Existing extension",
            version: "0.9.0",
            installState: "installed",
            matchBy: "store-identity",
            eligible: true,
          }],
        }),
      }),
      confirmSession: async () => {
        confirmCalls += 1;
        return { session: session("consumed", "chrome-web-store"), extension: extension() };
      },
    }),
    reloadState: async () => undefined,
  });
  await conflictController.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  await flush();
  assert.equal(conflictController.getState().session.view?.status, "ready");
  assert.equal(confirmCalls, 1, "an existing target still requires an explicit disposition");
});

test("a polled ready session is auto-confirmed exactly once", async () => {
  let polls = 0;
  let confirms = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "crxsoso" }),
    client: stubClient({
      createSession: async () => session("created", "crxsoso"),
      getSession: async (sessionId) => {
        polls += 1;
        return { ...session("ready", "crxsoso", sessionId), report: preflightReport({
          sessionId,
          transport: { ...preflightReport().transport, selectedProviderId: "crxsoso" },
        }) };
      },
      confirmSession: async () => {
        confirms += 1;
        return { session: session("consumed", "crxsoso"), extension: extension() };
      },
    }),
    reloadState: async () => undefined,
    pollDelay: async () => undefined,
  });
  await controller.startSession({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "crxsoso",
    purpose: "install",
  });
  await until(() => controller.getState().session.view?.status === "consumed");
  assert.equal(polls, 1);
  assert.equal(confirms, 1);
});

test("a post-confirm state refresh failure preserves acquisition success as a separate outcome", async () => {
  const result = { session: session("consumed", "chrome-web-store"), extension: extension() };
  let refreshAvailable = false;
  let reloadCalls = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      createSession: async () => session("ready", "chrome-web-store"),
      confirmSession: async () => result,
    }),
    reloadState: async () => {
      reloadCalls += 1;
      if (!refreshAvailable) throw new Error("state unavailable");
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

  refreshAvailable = true;
  const firstRetry = controller.retryStateRefresh();
  const duplicateRetry = controller.retryStateRefresh();
  assert.equal(firstRetry, duplicateRetry);
  assert.equal(controller.getState().session.refreshingState, true);
  assert.deepEqual(await Promise.all([firstRetry, duplicateRetry]), [true, true]);
  assert.equal(reloadCalls, 2);
  assert.equal(controller.getState().session.refreshingState, false);
  assert.equal(controller.getState().session.refreshError, undefined);
  assert.equal(controller.getState().session.view?.status, "consumed");
});

test("changing the package channel does not cancel an active built-in catalog search", async () => {
  const pending = deferred<ExtensionCatalogSearchPage>();
  let searchSignal: AbortSignal | undefined;
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "crxsoso" }),
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
  await controller.setArtifactProvider("chrome-web-store");
  assert.equal(searchSignal?.aborted, false);
  pending.resolve(page("privacy", [catalogItem(STORE_ID, "Late")]));
  await searching;

  assert.equal(controller.getState().discovery.status, "ready");
  assert.equal(controller.getState().discovery.page?.items[0]?.name, "Late");
});

test("retry and pagination recheck disclosure while search remains built in", async () => {
  let searchCalls = 0;
  let resolveCalls = 0;
  const controller = createExtensionAcquisitionController({
    settings: settings({ crxsosoDisclosureVersionAccepted: 0 }),
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
  assert.equal(searchCalls, 0);
  assert.equal(controller.getState().disclosure.open, true);

  controller.syncSettings(settings({ crxsosoDisclosureVersionAccepted: 1 }));
  await controller.submit();
  assert.equal(searchCalls, 1);
  await controller.loadMore();
  assert.equal(searchCalls, 2);

  controller.setInput(STORE_ID);
  await controller.submit();
  assert.equal(resolveCalls, 1);
  await controller.setArtifactProvider("chrome-web-store");
  await controller.retryDiscovery();
  assert.equal(resolveCalls, 2);
});

test("local selection, active-session, and confirmation guards expose distinct stable codes", async () => {
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      createSession: async (request) => session("ready", request.artifactProviderId),
    }),
    reloadState: async () => undefined,
  });

  await controller.startSelectedSession();
  assert.equal(controller.getState().session.error?.code, "ACQUISITION_PROVIDER_SELECTION_REQUIRED");

  const request = {
    namespace: "chrome-web-store" as const,
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store" as const,
    purpose: "install" as const,
  };
  await controller.startSession(request);
  await controller.startSession(request);
  assert.equal(controller.getState().session.error?.code, "ACQUISITION_SESSION_ACTIVE");

  controller.reset();
  await controller.confirm({ disposition: "create" });
  assert.equal(controller.getState().session.error?.code, "ACQUISITION_CONFIRMATION_NOT_READY");
});

test("rejected single-flight cleanup emits no detached unhandled rejection and releases every slot", async () => {
  const failure = new Error("listener rejected acquisition state delivery");
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  process.prependListener("unhandledRejection", onUnhandled);
  const result = { session: session("consumed", "chrome-web-store"), extension: extension() };
  const request = {
    namespace: "chrome-web-store" as const,
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store" as const,
    purpose: "install" as const,
  };
  const controller = createExtensionAcquisitionController({
    settings: settings({ artifactProviderId: "chrome-web-store" }),
    client: stubClient({
      createSession: async () => session("ready", "chrome-web-store"),
      confirmSession: async () => result,
    }),
    reloadState: async () => { throw new Error("state unavailable"); },
  });

  try {
    let unsubscribe = controller.subscribe(() => { throw failure; });
    const rejectedConfirm = controller.confirm({ disposition: "create" });
    await assert.rejects(rejectedConfirm, failure);
    unsubscribe();
    const nextConfirm = controller.confirm({ disposition: "create" });
    assert.notEqual(nextConfirm, rejectedConfirm);
    assert.equal(await nextConfirm, undefined);

    controller.reset();
    await controller.startSession(request);
    await controller.confirm({ disposition: "create" });
    assert.equal(controller.getState().session.refreshError?.code, "ACQUISITION_STATE_REFRESH_FAILED");

    unsubscribe = controller.subscribe(() => { throw failure; });
    const rejectedRefresh = controller.retryStateRefresh();
    await assert.rejects(rejectedRefresh, failure);
    unsubscribe();
    const nextRefresh = controller.retryStateRefresh();
    assert.notEqual(nextRefresh, rejectedRefresh);
    assert.equal(await nextRefresh, false);

    controller.syncSettings(settings({ artifactProviderId: "crxsoso" }));
    unsubscribe = controller.subscribe(() => { throw failure; });
    const rejectedTransition = controller.transitionUpdateProvider(
      "extension-1",
      "chrome-web-store",
      "crxsoso",
    );
    await assert.rejects(rejectedTransition, failure);
    unsubscribe();
    const nextTransition = controller.transitionUpdateProvider(
      "extension-1",
      "chrome-web-store",
      "crxsoso",
    );
    assert.notEqual(nextTransition, rejectedTransition);
    assert.equal((await nextTransition)?.updateProviderId, "crxsoso");

    await flush();
    await flush();
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    controller.dispose();
  }
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

function preflightReport(overrides: Partial<ExtensionPreflightReport> = {}): ExtensionPreflightReport {
  return {
    sessionId: "abcdefghijklmnopqrstuvwxyzABCDEJ",
    expiresAt: "2026-08-27T01:00:00.000Z",
    identity: {
      namespace: "chrome-web-store",
      requestedStoreId: STORE_ID,
      proofDerivedStoreId: STORE_ID,
      matches: true,
    },
    package: {
      name: "Extension",
      description: "",
      version: "1.0.0",
      manifestVersion: 3,
      format: "crx3",
      size: 1,
      sha256: "a".repeat(64),
      manifestSha256: "b".repeat(64),
      treeSha256: "c".repeat(64),
      entryCount: 1,
      filesystemNodeCount: 1,
      fileCount: 1,
      expandedBytes: 1,
    },
    transport: {
      selectedProviderId: "chrome-web-store",
      finalByteHost: "example.test",
      fetchedAt: "2026-08-27T00:00:00.000Z",
      durationMs: 1,
    },
    verification: {
      level: "cws-publisher-verified",
      developerKeySha256: "d".repeat(64),
      publisherTrustRootId: "root",
      publisherTrustRootVersion: 1,
      developerProofAlgorithm: "rsa-sha256",
      publisherProofAlgorithm: "rsa-sha256",
    },
    permissions: [],
    hostPermissions: [],
    optionalPermissions: [],
    optionalHostPermissions: [],
    permissionRisks: [],
    discrepancies: [],
    conflicts: [],
    ...overrides,
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
