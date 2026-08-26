import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionProviderError } from "../providerHttpClient";
import { TAMPERMONKEY_ID } from "./fixtures/crxsosoFixtures";
import { ExtensionProviderRegistry } from "./providerRegistry";
import type { ArtifactProvider, CatalogSearchProvider } from "./types";

test("ExtensionProviderRegistry exposes only the reviewed built-in provider slots", () => {
  const search = fakeSearchProvider();
  const google = fakeArtifactProvider("chrome-web-store", "Chrome Web Store");
  const crxsoso = fakeArtifactProvider("crxsoso", "CRX搜搜");
  const registry = new ExtensionProviderRegistry({
    crxsosoSearch: search,
    googleArtifact: google,
    crxsosoArtifact: crxsoso,
  });

  assert.equal(registry.catalog("crxsoso"), search);
  assert.equal(registry.artifact("chrome-web-store"), google);
  assert.equal(registry.artifact("crxsoso"), crxsoso);
});

test("ExtensionProviderRegistry returns enabled offers in fixed Google-first order", () => {
  const registry = new ExtensionProviderRegistry({
    crxsosoSearch: fakeSearchProvider(),
    googleArtifact: fakeArtifactProvider("chrome-web-store", "Chrome Web Store"),
    crxsosoArtifact: fakeArtifactProvider("crxsoso", "CRX搜搜"),
  });

  assert.deepEqual(
    registry.artifactOffers(TAMPERMONKEY_ID, {
      crxsosoSearchEnabled: false,
      googleArtifactEnabled: true,
      crxsosoArtifactEnabled: true,
    }).map((offer) => offer.artifactProviderId),
    ["chrome-web-store", "crxsoso"],
  );
  assert.deepEqual(
    registry.artifactOffers(TAMPERMONKEY_ID, {
      crxsosoSearchEnabled: true,
      googleArtifactEnabled: false,
      crxsosoArtifactEnabled: true,
    }).map((offer) => offer.artifactProviderId),
    ["crxsoso"],
  );
  assert.deepEqual(
    registry.artifactOffers(TAMPERMONKEY_ID, {
      crxsosoSearchEnabled: true,
      googleArtifactEnabled: false,
      crxsosoArtifactEnabled: false,
    }),
    [],
  );
});

test("ExtensionProviderRegistry rejects arbitrary provider registration and invalid identities", () => {
  assert.throws(
    () => new ExtensionProviderRegistry({
      crxsosoSearch: fakeSearchProvider(),
      googleArtifact: fakeArtifactProvider("crxsoso", "Wrong slot"),
      crxsosoArtifact: fakeArtifactProvider("crxsoso", "CRX搜搜"),
    }),
    TypeError,
  );

  const registry = new ExtensionProviderRegistry({
    crxsosoSearch: fakeSearchProvider(),
    googleArtifact: fakeArtifactProvider("chrome-web-store", "Chrome Web Store"),
    crxsosoArtifact: fakeArtifactProvider("crxsoso", "CRX搜搜"),
  });
  assert.throws(
    () => registry.artifactOffers("youxiaohoubox", {
      crxsosoSearchEnabled: true,
      googleArtifactEnabled: true,
      crxsosoArtifactEnabled: true,
    }),
    (error: unknown) => error instanceof ExtensionProviderError
      && error.code === "ACQUISITION_INPUT_UNSUPPORTED",
  );
});

function fakeSearchProvider(): CatalogSearchProvider {
  return {
    id: "crxsoso",
    search: async () => ({
      items: [],
      excludedNonCanonicalCount: 0,
      hasMore: false,
    }),
  };
}

function fakeArtifactProvider(
  id: ArtifactProvider["id"],
  providerLabel: string,
): ArtifactProvider {
  return {
    id,
    offer: (storeId) => ({
      namespace: "chrome-web-store",
      storeId,
      artifactProviderId: id,
      format: "crx3",
      providerLabel,
    }),
    resolveCurrent: async () => {
      throw new Error("Not used by registry tests.");
    },
  };
}
