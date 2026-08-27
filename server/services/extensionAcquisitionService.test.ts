import assert from "node:assert/strict";
import test from "node:test";

import {
  EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  chromeWebStoreListingUrl,
  type ExtensionAcquisitionErrorCode,
  type ExtensionArtifactOffer,
  type ExtensionCatalogItem,
} from "../../src/shared/extensionAcquisition";
import {
  normalizeSettings,
  type AppSettings,
  type ExtensionAcquisitionSettingsPatch,
} from "../../src/shared/settings";
import {
  ExtensionAcquisitionError,
  ExtensionAcquisitionService,
} from "./extensionAcquisitionService";
import type { ExtensionProviderRegistry } from "./extensionProviders/providerRegistry";
import type {
  CatalogSearchInput,
  CatalogSearchPage,
  CatalogSearchProvider,
} from "./extensionProviders/types";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";
const SECOND_STORE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const OBSERVED_AT = "2026-08-27T01:02:03.000Z";

test("search is always-on apart from the first-use disclosure gate", async () => {
  let settings = acquisitionSettings({ crxsosoDisclosureVersionAccepted: 0 });
  const calls: CatalogSearchInput[] = [];
  const provider = catalogProvider(async (input) => {
    calls.push(input);
    return emptyPage();
  });
  const service = createService(provider, () => settings);

  await rejectsWithCode(
    service.search({ query: "tampermonkey" }),
    "CATALOG_DISCLOSURE_REQUIRED",
  );
  assert.equal(calls.length, 0);

  settings = acquisitionSettings({
    crxsosoDisclosureVersionAccepted: EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  });
  await service.search({ query: "tampermonkey" });
  assert.equal(calls.length, 1);
});

test("control characters are rejected locally without degrading provider health", async () => {
  let calls = 0;
  const service = createService(catalogProvider(async () => {
    calls += 1;
    return emptyPage();
  }));

  await rejectsWithCode(service.search({ query: "privacy\u0000tools" }), "ACQUISITION_INPUT_UNSUPPORTED");
  await rejectsWithCode(service.search({ query: "privacy\u007ftools" }), "ACQUISITION_INPUT_UNSUPPORTED");
  assert.equal(calls, 0);
  assert.equal((await service.capabilities())[0]?.health, undefined);
});

test("search rejects ids and URL-like input locally instead of treating them as provider keywords", async () => {
  let calls = 0;
  const service = createService(catalogProvider(async () => {
    calls += 1;
    return emptyPage();
  }));

  await rejectsWithCode(service.search({ query: STORE_ID }), "ACQUISITION_INPUT_UNSUPPORTED");
  await rejectsWithCode(
    service.search({ query: `https://chromewebstore.google.com/detail/name/${STORE_ID}` }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  await rejectsWithCode(
    service.search({ query: "https://example.com/extension.crx" }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  assert.equal(calls, 0);
  assert.equal((await service.capabilities())[0]?.health, undefined);
});

test("capabilities re-read selected channel and expose only last user-triggered capability health", async () => {
  let settings = acquisitionSettings({
    artifactProviderId: "crxsoso",
    crxsosoDisclosureVersionAccepted: EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  });
  let settingsReads = 0;
  const service = createService(catalogProvider(async () => emptyPage()), () => {
    settingsReads += 1;
    return settings;
  });

  await service.search({ query: "empty result" });
  let capabilities = await service.capabilities();
  assert.deepEqual(capabilities.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "crxsoso-search", enabled: true },
    { id: "google-artifact", enabled: false },
    { id: "crxsoso-artifact", enabled: true },
  ]);
  assert.equal(capabilities[0]?.health?.status, "healthy");
  assert.equal(capabilities[1]?.health, undefined);
  assert.equal(capabilities[2]?.health, undefined);

  settings = acquisitionSettings({
    artifactProviderId: "chrome-web-store",
    crxsosoDisclosureVersionAccepted: EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  });
  capabilities = await service.capabilities();
  assert.deepEqual(capabilities.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "crxsoso-search", enabled: true },
    { id: "google-artifact", enabled: true },
    { id: "crxsoso-artifact", enabled: false },
  ]);
  assert.equal(capabilities[0]?.health?.status, "healthy", "disabling does not invent a health probe");
  assert.equal(settingsReads, 4, "search reads before and after networking; each capability read is fresh");
});

test("search deduplicates canonical ids and keeps provider continuation opaque", async () => {
  const calls: CatalogSearchInput[] = [];
  const pages: CatalogSearchPage[] = [
    {
      items: [
        { ...catalogItem(STORE_ID, "First observation"), iconUrl: "https://lhimg.crxsoso.com/first.webp" },
        catalogItem(STORE_ID, "Duplicate observation"),
        { ...catalogItem(SECOND_STORE_ID, "Alias"), storeId: "youxiaohoubox" } as ExtensionCatalogItem,
        catalogItem(SECOND_STORE_ID, "Second extension"),
      ],
      excludedNonCanonicalCount: 2,
      continuation: { page: 2, token: "provider-secret-token" },
      hasMore: true,
    },
    {
      items: [catalogItem(SECOND_STORE_ID, "Page two")],
      excludedNonCanonicalCount: 0,
      hasMore: false,
    },
  ];
  const service = createService(catalogProvider(async (input) => {
    calls.push(structuredClone(input));
    return pages.shift() ?? emptyPage();
  }));

  const first = await service.search({ query: "  extensions  " });
  assert.equal(first.query, "extensions");
  assert.deepEqual(first.items.map((item) => [item.storeId, item.name]), [
    [STORE_ID, "First observation"],
    [SECOND_STORE_ID, "Second extension"],
  ]);
  assert.equal(first.items[0]?.iconUrl, "https://lhimg.crxsoso.com/first.webp");
  assert.equal(first.excludedNonCanonicalCount, 3);
  assert.equal(first.hasMore, true);
  assert.match(first.cursor ?? "", /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(first.cursor, "provider-secret-token");
  assert.equal(JSON.stringify(first).includes("provider-secret-token"), false);
  assert.deepEqual(calls[0], { query: "extensions" });

  const second = await service.search({ query: "extensions", cursor: first.cursor });
  assert.equal(second.hasMore, false);
  assert.equal(second.cursor, undefined);
  assert.deepEqual(calls[1], {
    query: "extensions",
    continuation: { page: 2, token: "provider-secret-token" },
  });

  await rejectsWithCode(
    service.search({ query: "extensions", cursor: first.cursor }),
    "EXTENSION_CATALOG_CURSOR_INVALID",
  );
  assert.equal(calls.length, 2);
});

test("catalog cursors are bound to their normalized query and expire distinctly", async () => {
  let now = Date.parse("2026-08-27T00:00:00.000Z");
  let calls = 0;
  const service = createService(catalogProvider(async () => {
    calls += 1;
    return {
      items: [],
      excludedNonCanonicalCount: 0,
      continuation: { page: 2, token: "next" },
      hasMore: true,
    };
  }), undefined, { now: () => now, cursorTtlMs: 50 });

  const first = await service.search({ query: "one" });
  await rejectsWithCode(
    service.search({ query: "two", cursor: first.cursor }),
    "EXTENSION_CATALOG_CURSOR_INVALID",
  );
  assert.equal(calls, 1);

  now += 51;
  await rejectsWithCode(
    service.search({ query: "one", cursor: first.cursor }),
    "EXTENSION_CATALOG_CURSOR_EXPIRED",
  );
  assert.equal(calls, 1);
});

test("catalog provider failures map to stable safe errors and update search health only", async (context) => {
  const cases: Array<[ExtensionAcquisitionErrorCode, number]> = [
    ["EXTENSION_CATALOG_RATE_LIMITED", 429],
    ["EXTENSION_CATALOG_TIMEOUT", 504],
    ["EXTENSION_CATALOG_NETWORK", 502],
    ["EXTENSION_CATALOG_HTTP_ERROR", 502],
    ["EXTENSION_CATALOG_RESPONSE_TOO_LARGE", 502],
    ["EXTENSION_CATALOG_REDIRECT_REJECTED", 502],
    ["EXTENSION_CATALOG_SCHEMA_CHANGED", 502],
  ];

  for (const [code, status] of cases) {
    await context.test(code, async () => {
      const service = createService(catalogProvider(async () => {
        throw Object.assign(new Error("provider secret must not cross the boundary"), { code, status });
      }));
      const error = await captureAcquisitionError(service.search({ query: "failure" }));
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      assert.doesNotMatch(error.message, /provider secret/);
      const capabilities = await service.capabilities();
      assert.deepEqual(capabilities[0]?.health, {
        status: "unavailable",
        checkedAt: "2026-08-27T01:02:03.000Z",
        errorCode: code,
      });
      assert.equal(capabilities[1]?.health, undefined);
      assert.equal(capabilities[2]?.health, undefined);
    });
  }

  await context.test("unknown failures become catalog network errors", async () => {
    const service = createService(catalogProvider(async () => {
      throw new Error("raw internal exception");
    }));
    const error = await captureAcquisitionError(service.search({ query: "failure" }));
    assert.equal(error.code, "EXTENSION_CATALOG_NETWORK");
    assert.doesNotMatch(error.message, /raw internal/);
  });
});

test("malformed normalized provider output fails as schema drift instead of a false empty result", async () => {
  const malformed = {
    items: [{ ...catalogItem(STORE_ID), observedAt: "not-a-date" }],
    excludedNonCanonicalCount: 0,
    hasMore: false,
  } as CatalogSearchPage;
  const service = createService(catalogProvider(async () => malformed));

  await rejectsWithCode(service.search({ query: "schema" }), "EXTENSION_CATALOG_SCHEMA_CHANGED");
  const health = (await service.capabilities())[0]?.health;
  assert.equal(health?.status, "unavailable");
  assert.equal(health?.errorCode, "EXTENSION_CATALOG_SCHEMA_CHANGED");
});

test("a provider cannot issue a continuation that points back to the first page", async () => {
  const service = createService(catalogProvider(async () => ({
    items: [],
    excludedNonCanonicalCount: 0,
    continuation: { page: 1, token: "replay-first-page" },
    hasMore: true,
  })));

  await rejectsWithCode(service.search({ query: "schema" }), "EXTENSION_CATALOG_SCHEMA_CHANGED");
});

test("provider continuation bounds match the adapter contract before a cursor is issued", async (context) => {
  for (const continuation of [
    { page: 100_001, token: "too-far" },
    { page: 2, token: " padded " },
  ]) {
    await context.test(JSON.stringify(continuation), async () => {
      const service = createService(catalogProvider(async () => ({
        items: [],
        excludedNonCanonicalCount: 0,
        continuation,
        hasMore: true,
      })));
      await rejectsWithCode(service.search({ query: "schema" }), "EXTENSION_CATALOG_SCHEMA_CHANGED");
    });
  }
});

test("settingsChanged synchronously aborts and discards in-flight work when disclosure closes", async (context) => {
  const cases: Array<[
    string,
    Partial<AppSettings["extensionAcquisition"]>,
    ExtensionAcquisitionErrorCode,
  ]> = [
    ["disclosure revoked", { crxsosoDisclosureVersionAccepted: 0 }, "CATALOG_DISCLOSURE_REQUIRED"],
  ];
  for (const [name, patch, code] of cases) {
    await context.test(name, async () => {
      let settings = acquisitionSettings();
      let providerSignal: AbortSignal | undefined;
      let release: ((page: CatalogSearchPage) => void) | undefined;
      const provider = catalogProvider((_input, signal) => {
        providerSignal = signal;
        return new Promise<CatalogSearchPage>((resolve) => {
          release = resolve;
        });
      });
      const service = createService(provider, () => settings);
      const pending = service.search({ query: "slow" });
      await until(() => providerSignal !== undefined);

      settings = acquisitionSettings(patch);
      service.settingsChanged(settings);
      assert.equal(providerSignal?.aborted, true);
      release?.(emptyPage());
      await rejectsWithCode(pending, code);
      const capabilities = await service.capabilities();
      assert.equal(capabilities[0]?.health, undefined, "a discarded result is not provider health");
    });
  }
});

test("a newer search cancels stale work even when the provider ignores AbortSignal", async () => {
  let releaseFirst: ((page: CatalogSearchPage) => void) | undefined;
  const provider = catalogProvider((input) => {
    if (input.query === "first") {
      return new Promise<CatalogSearchPage>((resolve) => {
        releaseFirst = resolve;
      });
    }
    return Promise.resolve(emptyPage());
  });
  const service = createService(provider);
  const first = service.search({ query: "first" });
  await until(() => releaseFirst !== undefined);
  const second = await service.search({ query: "second" });
  assert.equal(second.query, "second");

  releaseFirst?.({
    items: [catalogItem(STORE_ID, "Stale")],
    excludedNonCanonicalCount: 0,
    hasMore: false,
  });
  await rejectsWithCode(first, "ACQUISITION_CANCELLED");
  assert.equal((await service.capabilities())[0]?.health?.status, "healthy");
});

test("an already-aborted caller signal makes zero provider calls and does not change health", async () => {
  let calls = 0;
  const service = createService(catalogProvider(async () => {
    calls += 1;
    return emptyPage();
  }));
  const controller = new AbortController();
  controller.abort();

  await rejectsWithCode(service.search({ query: "cancel", }, controller.signal), "ACQUISITION_CANCELLED");
  assert.equal(calls, 0);
  assert.equal((await service.capabilities())[0]?.health, undefined);
});

test("exact resolution is local, re-reads the selected artifact channel, and delegates reviewed offers", async () => {
  let settings = acquisitionSettings({
    artifactProviderId: "chrome-web-store",
  });
  let searchCalls = 0;
  const provider = catalogProvider(async () => {
    searchCalls += 1;
    return emptyPage();
  });
  const offerCalls: Array<{ storeId: string; provider: string }> = [];
  const registry = registryFor(provider, (storeId, acquisition) => {
    offerCalls.push({ storeId, provider: acquisition.artifactProviderId });
    return [artifactOffer(storeId, acquisition.artifactProviderId, "Reviewed selected label")];
  });
  const service = new ExtensionAcquisitionService({
    readSettings: async () => settings,
    providerRegistry: registry,
  });

  const fromId = await service.resolve({ input: STORE_ID });
  const fromUrl = await service.resolve({ input: `https://chromewebstore.google.com/detail/name/${STORE_ID}` });
  const fromCrxsoso = await service.resolve({ input: `https://www.crxsoso.com/webstore/detail/name/${STORE_ID}` });
  assert.deepEqual(fromUrl, fromId);
  assert.deepEqual(fromCrxsoso, fromId);
  assert.equal(fromId.storeUrl, chromeWebStoreListingUrl(STORE_ID));
  assert.equal(fromId.offers[0]?.providerLabel, "Reviewed selected label");
  assert.equal(searchCalls, 0);
  assert.equal(offerCalls.length, 3);

  settings = acquisitionSettings({ artifactProviderId: "crxsoso" });
  const noChannels = await service.resolve({ input: STORE_ID });
  assert.deepEqual(noChannels.offers.map((offer) => offer.artifactProviderId), ["crxsoso"]);
  assert.equal(searchCalls, 0);

  await rejectsWithCode(
    service.resolve({ input: "https://example.com/extension.crx" }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  await rejectsWithCode(service.resolve({ input: "privacy extension" }), "ACQUISITION_INPUT_UNSUPPORTED");
  assert.equal(searchCalls, 0);
});

function createService(
  provider: CatalogSearchProvider,
  readSettings: (() => AppSettings) | undefined = undefined,
  overrides: { now?: () => number; cursorTtlMs?: number } = {},
): ExtensionAcquisitionService {
  return new ExtensionAcquisitionService({
    readSettings: async () => readSettings?.() ?? acquisitionSettings(),
    providerRegistry: registryFor(provider),
    now: overrides.now ?? (() => Date.parse(OBSERVED_AT)),
    cursorTtlMs: overrides.cursorTtlMs,
  });
}

function registryFor(
  provider: CatalogSearchProvider,
  offers: (
    storeId: string,
    settings: AppSettings["extensionAcquisition"],
  ) => ExtensionArtifactOffer[] = defaultOffers,
): Pick<ExtensionProviderRegistry, "catalog" | "artifactOffers"> {
  return {
    catalog: (providerId) => {
      assert.equal(providerId, "crxsoso");
      return provider;
    },
    artifactOffers: offers,
  };
}

function defaultOffers(storeId: string, settings: AppSettings["extensionAcquisition"]): ExtensionArtifactOffer[] {
  return [artifactOffer(storeId, settings.artifactProviderId, settings.artifactProviderId)];
}

function artifactOffer(
  storeId: string,
  artifactProviderId: ExtensionArtifactOffer["artifactProviderId"],
  providerLabel: string,
): ExtensionArtifactOffer {
  return {
    namespace: "chrome-web-store",
    storeId,
    artifactProviderId,
    format: "crx3",
    providerLabel,
  };
}

function catalogProvider(
  search: (input: CatalogSearchInput, signal: AbortSignal) => Promise<CatalogSearchPage>,
): CatalogSearchProvider {
  return { id: "crxsoso", search };
}

function acquisitionSettings(
  overrides: ExtensionAcquisitionSettingsPatch = {},
): AppSettings {
  return normalizeSettings({
    extensionAcquisition: {
      artifactProviderId: "crxsoso",
      crxsosoDisclosureVersionAccepted: EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
      ...overrides,
    },
  });
}

function catalogItem(storeId: string, name = "Extension"): ExtensionCatalogItem {
  return {
    namespace: "chrome-web-store",
    storeId,
    storeUrl: chromeWebStoreListingUrl(storeId),
    catalogProviderId: "crxsoso",
    observedAt: OBSERVED_AT,
    name,
    description: "Description",
    category: "Productivity",
    rating: 4.5,
    userCount: 12_345,
  };
}

function emptyPage(): CatalogSearchPage {
  return {
    items: [],
    excludedNonCanonicalCount: 0,
    hasMore: false,
  };
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: ExtensionAcquisitionErrorCode,
): Promise<void> {
  const error = await captureAcquisitionError(promise);
  assert.equal(error.code, code);
}

async function captureAcquisitionError(promise: Promise<unknown>): Promise<ExtensionAcquisitionError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof ExtensionAcquisitionError);
    return error;
  }
  assert.fail("Expected extension acquisition operation to reject.");
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the test operation.");
}
