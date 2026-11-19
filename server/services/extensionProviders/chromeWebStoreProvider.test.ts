import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { ProviderHttpRequest } from "../providerHttpClient";
import { ExtensionProviderError } from "../providerHttpClient";
import {
  buildChromeWebStoreCrxUrl,
  ChromeWebStoreProvider,
  googleArtifactHostPolicy,
  normalizeChromeCoreVersion,
} from "./chromeWebStoreProvider";
import { TAMPERMONKEY_ID } from "./fixtures/crxsosoFixtures";
import type { ProviderHttpTransport } from "./types";

const FIXED_NOW = "2026-08-27T01:02:03.000Z";

test("normalizeChromeCoreVersion strips only CloakBrowser packaging components", () => {
  assert.equal(normalizeChromeCoreVersion("146.0.7680.177.5"), "146.0.7680.177");
  assert.equal(normalizeChromeCoreVersion(" 146.0.7680.177 "), "146.0.7680.177");
  assert.throws(() => normalizeChromeCoreVersion("146.0.7680"), errorWithCode("BROWSER_CORE_VERSION_REQUIRED"));
  assert.throws(() => normalizeChromeCoreVersion("v146.0.7680.177"), errorWithCode("BROWSER_CORE_VERSION_REQUIRED"));
  assert.throws(() => normalizeChromeCoreVersion(undefined), errorWithCode("BROWSER_CORE_VERSION_REQUIRED"));
});

test("buildChromeWebStoreCrxUrl locks the exact CRX3 on-demand endpoint contract", () => {
  assert.equal(
    buildChromeWebStoreCrxUrl(TAMPERMONKEY_ID, "146.0.7680.177.5"),
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=146.0.7680.177&acceptformat=crx3&x=id%3D${TAMPERMONKEY_ID}%26installsource%3Dondemand%26uc`,
  );
});

test("ChromeWebStoreProvider downloads through the exact reviewed Google host chain", async () => {
  let request: ProviderHttpRequest | undefined;
  const destinationPath = path.resolve("google-current.crx");
  const httpClient: ProviderHttpTransport = {
    readJson: async () => {
      throw new Error("Google artifact provider must not issue JSON catalog requests.");
    },
    downloadToFile: async (value, destination) => {
      request = value;
      assert.equal(destination, destinationPath);
      return {
        path: destination,
        size: 2_000_000,
        sha256: "b".repeat(64),
        finalHost: "clients2.googleusercontent.com",
        fetchedAt: FIXED_NOW,
      };
    },
  };
  const provider = new ChromeWebStoreProvider({
    httpClient,
    readBrowserCoreVersion: async () => "146.0.7680.177.5",
  });

  const result = await provider.resolveCurrent(
    { storeId: TAMPERMONKEY_ID, destinationPath },
    new AbortController().signal,
  );

  assert.equal(
    request?.url,
    `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=146.0.7680.177&acceptformat=crx3&x=id%3D${TAMPERMONKEY_ID}%26installsource%3Dondemand%26uc`,
  );
  assert.equal(request?.kind, "artifact");
  assert.equal(request?.init?.method, "GET");
  assert.equal(request?.hostPolicy("clients2.google.com", 0), true);
  assert.equal(request?.hostPolicy("clients2.googleusercontent.com", 1), true);
  assert.equal(request?.hostPolicy("evil.googleusercontent.com", 1), false);
  assert.equal(request?.hostPolicy("clients2.google.com", 1), false);
  assert.deepEqual(result, {
    namespace: "chrome-web-store",
    storeId: TAMPERMONKEY_ID,
    artifactProviderId: "chrome-web-store",
    format: "crx3",
    download: {
      path: destinationPath,
      size: 2_000_000,
      sha256: "b".repeat(64),
      finalHost: "clients2.googleusercontent.com",
      fetchedAt: FIXED_NOW,
    },
  });
  assert.equal(JSON.stringify(result).includes("service/update2/crx"), false);
});

test("ChromeWebStoreProvider reports a missing core version without making a request", async () => {
  let requests = 0;
  const provider = new ChromeWebStoreProvider({
    httpClient: downloadOnlyTransport(async () => {
      requests += 1;
      throw new Error("must not download");
    }),
    readBrowserCoreVersion: () => undefined,
  });

  await assert.rejects(
    provider.resolveCurrent(
      { storeId: TAMPERMONKEY_ID, destinationPath: path.resolve("missing-version.crx") },
      new AbortController().signal,
    ),
    errorWithCode("BROWSER_CORE_VERSION_REQUIRED"),
  );
  assert.equal(requests, 0);
});

test("ChromeWebStoreProvider rejects noncanonical ids before reading the core version", async () => {
  let versionReads = 0;
  let requests = 0;
  const provider = new ChromeWebStoreProvider({
    httpClient: downloadOnlyTransport(async () => {
      requests += 1;
      throw new Error("must not download");
    }),
    readBrowserCoreVersion: () => {
      versionReads += 1;
      return "146.0.7680.177";
    },
  });

  await assert.rejects(
    provider.resolveCurrent(
      { storeId: "youxiaohoubox", destinationPath: path.resolve("invalid-id.crx") },
      new AbortController().signal,
    ),
    errorWithCode("ACQUISITION_INPUT_UNSUPPORTED"),
  );
  assert.equal(versionReads, 0);
  assert.equal(requests, 0);
});

test("ChromeWebStoreProvider removes an empty successful response before reporting unavailable", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-google-provider-"));
  const destinationPath = path.join(tempDirectory, "empty.crx");
  try {
    await fs.writeFile(destinationPath, "");
    const provider = new ChromeWebStoreProvider({
      httpClient: downloadOnlyTransport(async () => ({
        path: destinationPath,
        size: 0,
        sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        finalHost: "clients2.google.com",
        fetchedAt: FIXED_NOW,
      })),
      readBrowserCoreVersion: () => "146.0.7680.177",
    });

    await assert.rejects(
      provider.resolveCurrent({ storeId: TAMPERMONKEY_ID, destinationPath }, new AbortController().signal),
      errorWithCode("ARTIFACT_UNAVAILABLE"),
    );
    await assert.rejects(fs.stat(destinationPath), (error: unknown) => isNodeError(error) && error.code === "ENOENT");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("Chrome Web Store offer and host policy contain only normalized public facts", () => {
  const provider = new ChromeWebStoreProvider({ readBrowserCoreVersion: () => "146.0.7680.177" });
  assert.deepEqual(provider.offer(TAMPERMONKEY_ID), {
    namespace: "chrome-web-store",
    storeId: TAMPERMONKEY_ID,
    artifactProviderId: "chrome-web-store",
    format: "crx3",
    providerLabel: "Chrome Web Store",
  });
  assert.equal(googleArtifactHostPolicy("clients2.google.com", 0), true);
  assert.equal(googleArtifactHostPolicy("clients2.googleusercontent.com", 0), false);
  assert.equal(googleArtifactHostPolicy("clients2.googleusercontent.com", 5), true);
  assert.equal(googleArtifactHostPolicy("clients2.googleusercontent.com.evil.example", 1), false);
});

function downloadOnlyTransport(
  download: ProviderHttpTransport["downloadToFile"],
): ProviderHttpTransport {
  return {
    readJson: async () => {
      throw new Error("Unexpected JSON request.");
    },
    downloadToFile: download,
  };
}

function errorWithCode(code: string): (error: unknown) => boolean {
  return (error: unknown) => error instanceof ExtensionProviderError && error.code === code;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
