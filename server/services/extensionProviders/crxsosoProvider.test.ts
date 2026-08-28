import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import type { ProviderHttpRequest } from "../providerHttpClient";
import { ExtensionProviderError } from "../providerHttpClient";
import {
  CrxsosoProvider,
  crxsosoApiHostPolicy,
  crxsosoArtifactHostPolicy,
  encodeCrxsosoRequest,
  normalizeCrxsosoSearchResponse,
} from "./crxsosoProvider";
import {
  ADBLOCK_ID,
  crxsosoArtifactFixture,
  crxsosoEmptyPageFixture,
  crxsosoFirstPageFixture,
  crxsosoNextPageFixture,
  crxsosoSchemaDriftFixture,
  TAMPERMONKEY_ID,
  UBLOCK_ORIGIN_ID,
} from "./fixtures/crxsosoFixtures";
import type { ProviderHttpTransport } from "./types";

const FIXED_NOW = "2026-08-27T01:02:03.000Z";

test("encodeCrxsosoRequest matches the website AES-128-CTR compatibility vector", () => {
  assert.equal(
    encodeCrxsosoRequest({ keyword: "tampermonkey", page: 1, size: 24 }),
    "08aaab3a827120b255c48cad6f8a23594ec8946c1809ed174696dd9bb3fe3d875b030eb8eb0db28d58368ba77b628da5",
  );
});

test("CrxsosoProvider posts the first page contract and returns only normalized catalog facts", async () => {
  let request: ProviderHttpRequest | undefined;
  let encodedPayload: Readonly<Record<string, unknown>> | undefined;
  const provider = new CrxsosoProvider({
    httpClient: jsonTransport(crxsosoFirstPageFixture, (value) => { request = value; }),
    now: () => new Date(FIXED_NOW),
    encodeRequest: (payload) => {
      encodedPayload = payload;
      return "00";
    },
  });

  const result = await provider.search({ query: "  tampermonkey  " }, new AbortController().signal);

  assert.deepEqual(encodedPayload, { keyword: "tampermonkey", page: 1, size: 24 });
  assert.equal(request?.url, "https://api.crxsoso.com/search/result?type=chrome");
  assert.equal(request?.kind, "catalog");
  assert.equal(request?.init?.method, "POST");
  assert.equal(request?.init?.body, JSON.stringify({ data: "00" }));
  assert.equal(request?.hostPolicy("api.crxsoso.com", 0), true);
  assert.equal(request?.hostPolicy("api.crxsoso.com.evil.example", 1), false);
  assert.equal(result.items.length, 2);
  assert.equal(result.excludedNonCanonicalCount, 1);
  assert.deepEqual(result.continuation, { page: 2, token: "opaque-provider-token-2" });
  assert.equal(result.hasMore, true);
  assert.deepEqual(result.items[0], {
    namespace: "chrome-web-store",
    storeId: TAMPERMONKEY_ID,
    storeUrl: `https://chromewebstore.google.com/detail/${TAMPERMONKEY_ID}`,
    catalogProviderId: "crxsoso",
    observedAt: FIXED_NOW,
    name: "Tampermonkey",
    description: "Userscript manager",
    category: "Productivity",
    rating: 4.7,
    userCount: 12_000_000,
  });
  assert.equal(result.items[1]?.storeId, UBLOCK_ORIGIN_ID);
  assert.equal(result.items[1]?.description, undefined);
  assert.equal(result.items[1]?.category, undefined);
  assert.equal(JSON.stringify(result).includes("raw-icon"), false);
  assert.equal(JSON.stringify(result).includes("ratingCount"), false);
});

test("CrxsosoProvider carries bounded continuation only in the next-page encrypted payload", async () => {
  let encodedPayload: Readonly<Record<string, unknown>> | undefined;
  const provider = new CrxsosoProvider({
    httpClient: jsonTransport(crxsosoNextPageFixture),
    now: () => new Date(FIXED_NOW),
    encodeRequest: (payload) => {
      encodedPayload = payload;
      return "00";
    },
  });

  const result = await provider.search({
    query: "ad blocker",
    continuation: { page: 2, token: "opaque-provider-token-2" },
  }, new AbortController().signal);

  assert.deepEqual(encodedPayload, {
    keyword: "ad blocker",
    page: 2,
    size: 24,
    token: "opaque-provider-token-2",
  });
  assert.equal(result.items[0]?.storeId, ADBLOCK_ID);
  assert.equal(result.continuation, undefined);
  assert.equal(result.hasMore, false);
});

test("CRX搜搜 empty pages remain successful zero-result pages", () => {
  assert.deepEqual(normalizeCrxsosoSearchResponse(crxsosoEmptyPageFixture, FIXED_NOW), {
    items: [],
    excludedNonCanonicalCount: 0,
    continuation: undefined,
    hasMore: false,
  });
});

test("CrxsosoProvider detail projects useful metadata without exposing the raw manifest", async () => {
  let request: ProviderHttpRequest | undefined;
  let encodedPayload: Readonly<Record<string, unknown>> | undefined;
  const provider = new CrxsosoProvider({
    httpClient: jsonTransport({
      code: 200,
      data: {
        detail: {
          crxId: TAMPERMONKEY_ID,
          name: "Tampermonkey",
          shortDescription: "Userscript manager",
          description: "Long overview\nSecond line",
          categoryName: "Productivity",
          version: "5.5.0",
          lastUpdateDate: 1_778_331_156,
          size: "1.64MiB",
          manifestVersion: 3,
          developerName: "Jan Biniok",
          averageRating: "4.7",
          activeInstallCount: 12_000_000,
          thumbnail: "https://lhimg.crxsoso.com/detail-icon",
          manifest: "{\"permissions\":[\"tabs\"]}",
        },
      },
    }, (value) => { request = value; }),
    encodeRequest: (payload) => {
      encodedPayload = payload;
      return "00";
    },
  });

  const item = await provider.detail(TAMPERMONKEY_ID, new AbortController().signal);
  assert.deepEqual(encodedPayload, { id: TAMPERMONKEY_ID });
  assert.equal(request?.url, "https://api.crxsoso.com/chrome/detail");
  assert.equal(request?.init?.method, "POST");
  assert.equal(item.storeId, TAMPERMONKEY_ID);
  assert.equal(item.version, "5.5.0");
  assert.equal(item.updatedAt, "2026-05-09T12:52:36.000Z");
  assert.equal(item.size, "1.64MiB");
  assert.equal(item.manifestVersion, 3);
  assert.equal(item.developer, "Jan Biniok");
  assert.equal(item.description, "Userscript manager");
  assert.equal(item.overview, "Long overview\nSecond line");
  assert.equal(item.iconUrl, "https://lhimg.crxsoso.com/detail-icon");
  assert.equal(JSON.stringify(item).includes("permissions"), false);
});

test("CRX搜搜 schema drift is distinct from a zero-result response", () => {
  assert.throws(
    () => normalizeCrxsosoSearchResponse(crxsosoSchemaDriftFixture, FIXED_NOW),
    errorWithCode("EXTENSION_CATALOG_SCHEMA_CHANGED"),
  );
  assert.throws(
    () => normalizeCrxsosoSearchResponse({ code: 200, data: { extensionList: [], hasMorePages: "false" } }, FIXED_NOW),
    errorWithCode("EXTENSION_CATALOG_SCHEMA_CHANGED"),
  );
  assert.throws(
    () => normalizeCrxsosoSearchResponse({ code: "200", data: { extensionList: [], hasMorePages: false } }, FIXED_NOW),
    errorWithCode("EXTENSION_CATALOG_SCHEMA_CHANGED"),
  );
});

test("CRX搜搜 catalog projects only reviewed thumbnail hosts", () => {
  const page = normalizeCrxsosoSearchResponse({
    code: 200,
    data: {
      extensionList: [
        {
          crxId: TAMPERMONKEY_ID,
          name: "Tampermonkey",
          thumbnail: "https://lhimg.crxsoso.com/thumb-token",
        },
        {
          crxId: UBLOCK_ORIGIN_ID,
          name: "uBlock Origin",
          iconUrl: "https://lhimg.crxsoso.com/icon.png?token=must-not-leak",
        },
      ],
      hasMorePages: false,
    },
  }, FIXED_NOW);

  assert.equal(page.items[0]?.iconUrl, "https://lhimg.crxsoso.com/thumb-token");
  assert.equal(page.items[1]?.iconUrl, undefined);
  assert.equal(JSON.stringify(page).includes("token=must-not-leak"), false);
});

test("CRX搜搜 business rate limit is mapped without leaking its raw message", () => {
  assert.throws(
    () => normalizeCrxsosoSearchResponse({ code: 429, message: "raw-provider-message" }, FIXED_NOW),
    (error: unknown) => {
      assert.ok(error instanceof ExtensionProviderError);
      assert.equal(error.code, "EXTENSION_CATALOG_RATE_LIMITED");
      assert.equal(error.message.includes("raw-provider-message"), false);
      return true;
    },
  );
});

test("CrxsosoProvider rejects invalid continuations before making a request", async () => {
  let requests = 0;
  const provider = new CrxsosoProvider({
    httpClient: jsonTransport(crxsosoEmptyPageFixture, () => { requests += 1; }),
    encodeRequest: () => "00",
  });

  await assert.rejects(
    provider.search({ query: "test", continuation: { page: 1, token: "token" } }, new AbortController().signal),
    errorWithCode("EXTENSION_CATALOG_CURSOR_INVALID"),
  );
  await assert.rejects(
    provider.search({ query: "test", continuation: { page: 2, token: "x".repeat(4_097) } }, new AbortController().signal),
    errorWithCode("EXTENSION_CATALOG_CURSOR_INVALID"),
  );
  assert.equal(requests, 0);
});

test("CrxsosoProvider resolves only the current CRX mirror and keeps signed URLs internal", async () => {
  let detailRequest: ProviderHttpRequest | undefined;
  let downloadRequest: ProviderHttpRequest | undefined;
  let detailPayload: Readonly<Record<string, unknown>> | undefined;
  const destinationPath = path.resolve("crxsoso-current.crx");
  const httpClient: ProviderHttpTransport = {
    readJson: async (request) => {
      detailRequest = request;
      return { value: crxsosoArtifactFixture, finalHost: "api.crxsoso.com", status: 200 };
    },
    downloadToFile: async (request, destination) => {
      downloadRequest = request;
      assert.equal(destination, destinationPath);
      return {
        path: destination,
        size: 1_718_375,
        sha256: "a".repeat(64),
        finalHost: "c2.crxsoso.com",
        fetchedAt: FIXED_NOW,
      };
    },
  };
  const provider = new CrxsosoProvider({
    httpClient,
    encodeRequest: (payload) => {
      detailPayload = payload;
      return "00";
    },
  });

  const result = await provider.resolveCurrent(
    { storeId: TAMPERMONKEY_ID, destinationPath },
    new AbortController().signal,
  );

  assert.equal(detailRequest?.url, "https://api.crxsoso.com/chrome/dlink");
  assert.equal(detailRequest?.kind, "artifact");
  assert.deepEqual(detailPayload, {
    storeUrl: `https://chrome.google.com/webstore/detail/${TAMPERMONKEY_ID}`,
    addonId: TAMPERMONKEY_ID,
    storeType: "chrome",
    downloadUrl: `https://clients2.google.com/service/update2/crx?response=redirect&os=win&arch=x86-64&os_arch=x86-64&nacl_arch=x86-64&prod=chromecrx&prodchannel=unknown&prodversion=9999.0.9999.0&acceptformat=crx3&x=id%3D${TAMPERMONKEY_ID}%26uc`,
    name: TAMPERMONKEY_ID,
    version: "",
    size: "",
  });
  assert.equal(downloadRequest?.url, "https://c2.crxsoso.com/download/current.crx?token=raw-crx-token");
  assert.equal(downloadRequest?.hostPolicy("c2.crxsoso.com", 0), true);
  assert.equal(downloadRequest?.hostPolicy("c2.crxsoso.com.evil.example", 1), false);
  assert.deepEqual(result, {
    namespace: "chrome-web-store",
    storeId: TAMPERMONKEY_ID,
    artifactProviderId: "crxsoso",
    format: "crx3",
    download: {
      path: destinationPath,
      size: 1_718_375,
      sha256: "a".repeat(64),
      finalHost: "c2.crxsoso.com",
      fetchedAt: FIXED_NOW,
    },
  });
  assert.equal(JSON.stringify(result).includes("raw-crx-token"), false);
  assert.equal(JSON.stringify(result).includes("dlink"), false);
});

test("CRX搜搜 package normalization ignores ZIP/history and rejects host escapes", async () => {
  const maliciousProvider = new CrxsosoProvider({
    httpClient: jsonTransport({
      code: 200,
      dlinkOffline: [{ format: ".crx", dlink: "https://c2.crxsoso.com.evil.example/current.crx" }],
    }),
    encodeRequest: () => "00",
  });
  await assert.rejects(
    maliciousProvider.resolveCurrent(
      { storeId: TAMPERMONKEY_ID, destinationPath: path.resolve("host-escape.crx") },
      new AbortController().signal,
    ),
    errorWithCode("ARTIFACT_REDIRECT_REJECTED"),
  );
  const zipOnlyProvider = new CrxsosoProvider({
    httpClient: jsonTransport({
      code: 200,
      dlinkOffline: [{ format: ".zip", dlink: "https://c2.crxsoso.com/current.zip" }],
    }),
    encodeRequest: () => "00",
  });
  await assert.rejects(
    zipOnlyProvider.resolveCurrent(
      { storeId: TAMPERMONKEY_ID, destinationPath: path.resolve("zip-only.crx") },
      new AbortController().signal,
    ),
    errorWithCode("ARTIFACT_UNAVAILABLE"),
  );
});

test("CRX搜搜 package URL preserves raw authority evidence before URL normalization", async () => {
  const ambiguousUrls = [
    "https://c%32.crxsoso.com/current.crx",
    "https://c2.crxsoso.com:443/current.crx",
    "https://c2。crxsoso.com/current.crx",
    "https://c2.crxsoso.com@evil.example/current.crx",
    "https://c2.crxsoso.com\\@evil.example/current.crx",
    " https://c2.crxsoso.com/current.crx",
  ];
  for (const dlink of ambiguousUrls) {
    const provider = new CrxsosoProvider({
      httpClient: jsonTransport({
        code: 200,
        dlinkOffline: [{ format: ".crx", dlink }],
      }),
      encodeRequest: () => "00",
    });
    await assert.rejects(
      provider.resolveCurrent(
        { storeId: TAMPERMONKEY_ID, destinationPath: path.resolve("ambiguous-authority.crx") },
        new AbortController().signal,
      ),
      errorWithCode("ARTIFACT_REDIRECT_REJECTED"),
    );
  }
});

test("CRX搜搜 can use a separately validated top-level current CRX when offline offers are empty", async () => {
  let selectedUrl: string | undefined;
  const destinationPath = path.resolve("top-level-current.crx");
  const provider = new CrxsosoProvider({
    httpClient: {
      readJson: async () => ({
        value: {
          code: 200,
          dlink: "https://c2.crxsoso.com/download/top-level.crx?token=internal-only",
          dlinkOffline: [],
        },
        finalHost: "api.crxsoso.com",
        status: 200,
      }),
      downloadToFile: async (request, destination) => {
        selectedUrl = request.url;
        return {
          path: destination,
          size: 10,
          sha256: "c".repeat(64),
          finalHost: "c2.crxsoso.com",
          fetchedAt: FIXED_NOW,
        };
      },
    },
    encodeRequest: () => "00",
  });

  const result = await provider.resolveCurrent(
    { storeId: TAMPERMONKEY_ID, destinationPath },
    new AbortController().signal,
  );

  assert.equal(selectedUrl, "https://c2.crxsoso.com/download/top-level.crx?token=internal-only");
  assert.equal(JSON.stringify(result).includes("internal-only"), false);
});

test("CRX搜搜 exact upstream echo means package unavailable, not a redirect escape", async () => {
  let upstreamHint: string | undefined;
  let downloads = 0;
  const provider = new CrxsosoProvider({
    httpClient: {
      readJson: async () => {
        assert.ok(upstreamHint);
        return {
          value: {
            code: 200,
            dlink: upstreamHint,
            dlinkOffline: [{ format: ".crx", dlink: upstreamHint }],
          },
          finalHost: "api.crxsoso.com",
          status: 200,
        };
      },
      downloadToFile: async () => {
        downloads += 1;
        throw new Error("An echoed Google hint must never be downloaded as a CRX搜搜 artifact.");
      },
    },
    encodeRequest: (payload) => {
      upstreamHint = typeof payload.downloadUrl === "string" ? payload.downloadUrl : undefined;
      return "00";
    },
  });

  await assert.rejects(
    provider.resolveCurrent(
      { storeId: "a".repeat(32), destinationPath: path.resolve("unavailable.crx") },
      new AbortController().signal,
    ),
    errorWithCode("ARTIFACT_UNAVAILABLE"),
  );
  assert.equal(downloads, 0);
});

test("CrxsosoProvider rejects aliases before detail or download requests", async () => {
  let requests = 0;
  const provider = new CrxsosoProvider({
    httpClient: jsonTransport(crxsosoArtifactFixture, () => { requests += 1; }),
    encodeRequest: () => "00",
  });

  await assert.rejects(
    provider.resolveCurrent({ storeId: "youxiaohoubox", destinationPath: path.resolve("invalid.crx") }, new AbortController().signal),
    errorWithCode("ACQUISITION_INPUT_UNSUPPORTED"),
  );
  assert.equal(requests, 0);
});

test("CRX搜搜 host policies use exact reviewed hosts", () => {
  assert.equal(crxsosoApiHostPolicy("api.crxsoso.com"), true);
  assert.equal(crxsosoApiHostPolicy("www.crxsoso.com"), false);
  assert.equal(crxsosoArtifactHostPolicy("c2.crxsoso.com"), true);
  assert.equal(crxsosoArtifactHostPolicy("c3.crxsoso.com"), false);
});

function jsonTransport(value: unknown, observe?: (request: ProviderHttpRequest) => void): ProviderHttpTransport {
  return {
    readJson: async (request) => {
      observe?.(request);
      return { value, finalHost: "api.crxsoso.com", status: 200 };
    },
    downloadToFile: async () => {
      throw new Error("Unexpected package download in catalog test.");
    },
  };
}

function errorWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ExtensionProviderError && error.code === code;
}
