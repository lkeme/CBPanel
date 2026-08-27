import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import express from "express";

import {
  chromeWebStoreListingUrl,
  extensionCapabilityDescriptors,
  type ExtensionCatalogSearchRequest,
  type ExtensionReferenceResolveRequest,
} from "../../src/shared/extensionAcquisition";
import { normalizeSettings } from "../../src/shared/settings";
import { ExtensionAcquisitionError } from "../services/extensionAcquisitionService";
import {
  createExtensionAcquisitionRouter,
  decodeExtensionCatalogSearchRequest,
  decodeExtensionReferenceResolveRequest,
  decodeSessionConfirmRequest,
  decodeSessionCreateRequest,
  type ExtensionAcquisitionRouteService,
} from "./extensionAcquisitionRoutes";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

test("route request decoders accept only bounded explicit fields", () => {
  assert.deepEqual(decodeExtensionCatalogSearchRequest({ query: "  privacy  " }), { query: "privacy" });
  assert.deepEqual(decodeExtensionCatalogSearchRequest({ query: "privacy", cursor: "opaque_cursor-1" }), {
    query: "privacy",
    cursor: "opaque_cursor-1",
  });
  assert.deepEqual(decodeExtensionReferenceResolveRequest({ input: `  ${STORE_ID}  ` }), {
    input: `  ${STORE_ID}  `,
  });

  assertDecoderCode(() => decodeExtensionCatalogSearchRequest(undefined), "ACQUISITION_INPUT_UNSUPPORTED");
  assertDecoderCode(() => decodeExtensionCatalogSearchRequest([]), "ACQUISITION_INPUT_UNSUPPORTED");
  assertDecoderCode(() => decodeExtensionCatalogSearchRequest({ query: "" }), "ACQUISITION_INPUT_EMPTY");
  assertDecoderCode(
    () => decodeExtensionCatalogSearchRequest({ query: "valid", provider: "crxsoso" }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  assert.deepEqual(decodeSessionCreateRequest({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  }), {
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    artifactProviderId: "chrome-web-store",
    purpose: "install",
  });
  assert.deepEqual(decodeSessionConfirmRequest({
    disposition: "upgrade",
    targetExtensionId: "extension-1",
    environmentIds: ["environment-1", "environment-1"],
    permissionApprovalToken: "abcdefghijklmnopqrstuvwxyzABCDEJ",
  }), {
    disposition: "upgrade",
    targetExtensionId: "extension-1",
    environmentIds: ["environment-1"],
    permissionApprovalToken: "abcdefghijklmnopqrstuvwxyzABCDEJ",
  });
  for (const forbidden of ["artifactUrl", "artifactPath", "developerProof", "conflictCandidates"]) {
    assertDecoderCode(() => decodeSessionCreateRequest({
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      artifactProviderId: "chrome-web-store",
      purpose: "install",
      [forbidden]: "client-forged",
    }), "ACQUISITION_INPUT_UNSUPPORTED");
  }
  assertDecoderCode(
    () => decodeExtensionCatalogSearchRequest({ query: "x".repeat(257) }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  assertDecoderCode(
    () => decodeExtensionCatalogSearchRequest({ query: "privacy\u0000tools" }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  assertDecoderCode(
    () => decodeExtensionCatalogSearchRequest({ query: `https://example.com/detail/${STORE_ID}` }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
  assertDecoderCode(
    () => decodeExtensionCatalogSearchRequest({ query: "valid", cursor: "token with spaces" }),
    "EXTENSION_CATALOG_CURSOR_INVALID",
  );
  assertDecoderCode(() => decodeExtensionReferenceResolveRequest({ input: " " }), "ACQUISITION_INPUT_EMPTY");
  assertDecoderCode(
    () => decodeExtensionReferenceResolveRequest({ input: STORE_ID, artifactUrl: "https://example.test/x.crx" }),
    "ACQUISITION_INPUT_UNSUPPORTED",
  );
});

test("feature router exposes only capabilities/search/resolve and leaves api state independent", async () => {
  const calls: {
    capabilities: number;
    searches: ExtensionCatalogSearchRequest[];
    resolves: ExtensionReferenceResolveRequest[];
    signals: AbortSignal[];
  } = { capabilities: 0, searches: [], resolves: [], signals: [] };
  const settings = normalizeSettings({
    extensionAcquisition: { crxsosoDisclosureVersionAccepted: 1 },
  });
  const service: ExtensionAcquisitionRouteService = {
    ...unusedSessionRoutes(),
    capabilities: async () => {
      calls.capabilities += 1;
      return extensionCapabilityDescriptors(settings.extensionAcquisition);
    },
    search: async (request, signal) => {
      calls.searches.push(request);
      if (signal) calls.signals.push(signal);
      if (request.query === "known-error") {
        throw new ExtensionAcquisitionError("EXTENSION_CATALOG_RATE_LIMITED");
      }
      if (request.query === "unknown-error") throw new Error("private provider response");
      return {
        query: request.query,
        items: [],
        excludedNonCanonicalCount: 0,
        hasMore: false,
      };
    },
    resolve: async (request) => {
      calls.resolves.push(request);
      return {
        namespace: "chrome-web-store",
        storeId: STORE_ID,
        storeUrl: chromeWebStoreListingUrl(STORE_ID),
        offers: [],
      };
    },
  };
  const app = express();
  app.use(express.json());
  app.get("/api/state", (_request, response) => response.json({ revision: 7, extensions: [] }));
  app.use("/api/extension-acquisition", createExtensionAcquisitionRouter(service));
  const server = await startServer(app);
  try {
    const beforeState = await request(server.baseUrl, "GET", "/api/state");

    const capabilities = await request(server.baseUrl, "GET", "/api/extension-acquisition/capabilities");
    assert.equal(capabilities.status, 200);
    assert.equal(Array.isArray(capabilities.body), true);

    const search = await request(server.baseUrl, "POST", "/api/extension-acquisition/search", {
      query: "  privacy  ",
    });
    assert.equal(search.status, 200);
    assert.deepEqual(search.body, {
      query: "privacy",
      items: [],
      excludedNonCanonicalCount: 0,
      hasMore: false,
    });
    assert.equal(calls.signals[0] instanceof AbortSignal, true);

    const resolution = await request(server.baseUrl, "POST", "/api/extension-acquisition/resolve", {
      input: STORE_ID,
    });
    assert.equal(resolution.status, 200);
    assert.equal((resolution.body as { storeId?: string }).storeId, STORE_ID);

    const afterState = await request(server.baseUrl, "GET", "/api/state");
    assert.deepEqual(afterState, beforeState);
    assert.deepEqual(calls.searches, [{ query: "privacy" }]);
    assert.deepEqual(calls.resolves, [{ input: STORE_ID }]);

    const malformedCalls = calls.searches.length;
    const malformed = await request(server.baseUrl, "POST", "/api/extension-acquisition/search", {
      query: "privacy",
      rawProviderToken: "must-not-cross",
    });
    assert.equal(malformed.status, 400);
    assert.equal((malformed.body as { code?: string }).code, "ACQUISITION_INPUT_UNSUPPORTED");
    assert.equal(calls.searches.length, malformedCalls);

    const queryString = await request(
      server.baseUrl,
      "POST",
      "/api/extension-acquisition/resolve?artifactUrl=https://example.test/x.crx",
      { input: STORE_ID },
    );
    assert.equal(queryString.status, 400);
    assert.equal((queryString.body as { code?: string }).code, "ACQUISITION_INPUT_UNSUPPORTED");

    const knownError = await request(server.baseUrl, "POST", "/api/extension-acquisition/search", {
      query: "known-error",
    });
    assert.equal(knownError.status, 429);
    assert.equal((knownError.body as { code?: string }).code, "EXTENSION_CATALOG_RATE_LIMITED");

    const unknownError = await request(server.baseUrl, "POST", "/api/extension-acquisition/search", {
      query: "unknown-error",
    });
    assert.equal(unknownError.status, 500);
    assert.deepEqual(unknownError.body, { error: "Extension acquisition request failed." });
    assert.equal(JSON.stringify(unknownError.body).includes("private provider response"), false);

    const missingRoute = await request(server.baseUrl, "POST", "/api/extension-acquisition/download", {});
    assert.equal(missingRoute.status, 404);
    assert.equal(calls.capabilities, 1);
  } finally {
    await server.dispose();
  }
});

test("disconnecting a search request propagates cancellation to the service", async () => {
  let receivedSignal: AbortSignal | undefined;
  let signalAborted: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    signalAborted = resolve;
  });
  const service: ExtensionAcquisitionRouteService = {
    ...unusedSessionRoutes(),
    capabilities: async () => [],
    search: async (_request, signal) => {
      assert.ok(signal);
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          signalAborted?.();
          reject(new ExtensionAcquisitionError("ACQUISITION_CANCELLED"));
        }, { once: true });
      });
    },
    resolve: async () => {
      throw new Error("not used");
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/extension-acquisition", createExtensionAcquisitionRouter(service));
  const server = await startServer(app);
  try {
    const controller = new AbortController();
    const pending = fetch(`${server.baseUrl}/api/extension-acquisition/search`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "slow" }),
      signal: controller.signal,
    });
    await until(() => receivedSignal !== undefined);
    controller.abort();
    await assert.rejects(pending);
    await within(aborted, 2_000);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    await server.dispose();
  }
});

test("disconnecting an update-provider request propagates cancellation to the probe", async () => {
  let receivedSignal: AbortSignal | undefined;
  let signalAborted: (() => void) | undefined;
  const aborted = new Promise<void>((resolve) => {
    signalAborted = resolve;
  });
  const service: ExtensionAcquisitionRouteService = {
    ...unusedSessionRoutes(),
    capabilities: async () => [],
    search: async () => ({ query: "", items: [], excludedNonCanonicalCount: 0, hasMore: false }),
    resolve: async () => ({
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      storeUrl: chromeWebStoreListingUrl(STORE_ID),
      offers: [],
    }),
    transitionUpdateProvider: async (_extensionId, _providerId, signal) => {
      assert.ok(signal);
      receivedSignal = signal;
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          signalAborted?.();
          reject(new ExtensionAcquisitionError("ACQUISITION_CANCELLED"));
        }, { once: true });
      });
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/extension-acquisition", createExtensionAcquisitionRouter(service));
  const server = await startServer(app);
  try {
    const controller = new AbortController();
    const pending = fetch(`${server.baseUrl}/api/extension-acquisition/extensions/extension-1/update-provider`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ providerId: "crxsoso" }),
      signal: controller.signal,
    });
    await until(() => receivedSignal !== undefined);
    controller.abort();
    await assert.rejects(pending);
    await within(aborted, 2_000);
    assert.equal(receivedSignal?.aborted, true);
  } finally {
    await server.dispose();
  }
});

function assertDecoderCode(run: () => unknown, code: string): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof ExtensionAcquisitionError);
    assert.equal(error.code, code);
    return true;
  });
}

function unusedSessionRoutes(): Pick<
  ExtensionAcquisitionRouteService,
  | "createSession"
  | "listSessions"
  | "getSession"
  | "cancelSession"
  | "confirmSession"
  | "transitionUpdateProvider"
> {
  const unused = (): never => {
    throw new Error("not used");
  };
  return {
    createSession: async () => unused(),
    listSessions: () => [],
    getSession: unused,
    cancelSession: async () => unused(),
    confirmSession: async () => unused(),
    transitionUpdateProvider: async () => unused(),
  };
}

async function startServer(app: express.Express): Promise<{ baseUrl: string; dispose: () => Promise<void> }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    dispose: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function request(
  baseUrl: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(new URL(route, baseUrl), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

async function until(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for the route operation.");
}

async function within(promise: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("route did not abort")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
