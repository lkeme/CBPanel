import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CHROMIUM_VERSION } from "cloakbrowser";
import { isCanonicalChromeExtensionId } from "../../../src/shared/extensionAcquisition";
import { ProviderHttpClient } from "../providerHttpClient";
import { ChromeWebStoreProvider } from "./chromeWebStoreProvider";
import { CrxsosoProvider } from "./crxsosoProvider";
import { TAMPERMONKEY_ID } from "./fixtures/crxsosoFixtures";
import type { ProviderHttpTransport } from "./types";

const LIVE_ENABLED = process.env.CBPANEL_LIVE_EXTENSION_PROVIDERS === "1";

test("opt-in live CRX搜搜 smoke exercises first and continuation pages", {
  skip: !LIVE_ENABLED,
}, async () => {
  const provider = new CrxsosoProvider();
  const first = await provider.search({ query: "tampermonkey" }, AbortSignal.timeout(30_000));
  assert.ok(first.items.length > 0);
  assert.ok(first.items.every((item) => isCanonicalChromeExtensionId(item.storeId)));
  assert.ok(first.continuation);

  const next = await provider.search({
    query: "tampermonkey",
    continuation: first.continuation,
  }, AbortSignal.timeout(30_000));
  assert.ok(next.items.every((item) => isCanonicalChromeExtensionId(item.storeId)));
});

test("opt-in live CRX搜搜 exact artifact smoke selects only the reviewed mirror host", {
  skip: !LIVE_ENABLED,
}, async () => {
  const realHttpClient = new ProviderHttpClient();
  let selectedReviewedCrx = false;
  const destinationPath = path.resolve("live-crxsoso-probe.crx");
  const transport: ProviderHttpTransport = {
    readJson: (request) => realHttpClient.readJson(request),
    downloadToFile: async (request, destination) => {
      const url = new URL(request.url);
      selectedReviewedCrx = url.protocol === "https:"
        && url.hostname === "c2.crxsoso.com"
        && !url.username
        && !url.password
        && !url.port
        && !url.hash
        && url.pathname.toLowerCase().endsWith(".crx");
      assert.equal(selectedReviewedCrx, true);
      return {
        path: destination,
        size: 1,
        sha256: "a".repeat(64),
        finalHost: url.hostname,
        fetchedAt: new Date().toISOString(),
      };
    },
  };
  const result = await new CrxsosoProvider({ httpClient: transport }).resolveCurrent(
    { storeId: TAMPERMONKEY_ID, destinationPath },
    AbortSignal.timeout(30_000),
  );

  assert.equal(selectedReviewedCrx, true);
  assert.equal(result.download.finalHost, "c2.crxsoso.com");
  assert.equal(JSON.stringify(result).includes("https://"), false);
  assert.equal(JSON.stringify(result).includes("?"), false);
});

test("opt-in live Google exact artifact smoke downloads positive bytes from a reviewed host", {
  skip: !LIVE_ENABLED,
}, async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-google-provider-live-"));
  const destinationPath = path.join(tempDirectory, "current.crx");
  try {
    const result = await new ChromeWebStoreProvider({
      readBrowserCoreVersion: () => CHROMIUM_VERSION,
    }).resolveCurrent(
      { storeId: TAMPERMONKEY_ID, destinationPath },
      AbortSignal.timeout(5 * 60_000),
    );

    assert.ok(result.download.size > 0);
    assert.equal(result.download.path, destinationPath);
    assert.equal(
      result.download.finalHost === "clients2.google.com"
        || result.download.finalHost === "clients2.googleusercontent.com",
      true,
    );
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
