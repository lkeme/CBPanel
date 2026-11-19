import assert from "node:assert/strict";
import test from "node:test";

import { extensionListingUrl, openExtensionListing } from "./extensionExternalNavigation";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

test("extension listings are rebuilt from the selected provider and canonical id", () => {
  assert.equal(
    extensionListingUrl({ storeId: STORE_ID, artifactProviderId: "chrome-web-store" }),
    `https://chromewebstore.google.com/detail/${STORE_ID}`,
  );
  assert.equal(
    extensionListingUrl({ storeId: STORE_ID, artifactProviderId: "crxsoso" }),
    `https://www.crxsoso.com/webstore/detail/${STORE_ID}`,
  );
});

test("extension listing URLs reject noncanonical ids and unsupported providers", () => {
  for (const storeId of [
    "not-canonical",
    STORE_ID.toUpperCase(),
    `${STORE_ID}/other`,
    `${STORE_ID}\n`,
  ]) {
    assert.throws(
      () => extensionListingUrl({ storeId, artifactProviderId: "crxsoso" }),
      /canonical extension id/,
    );
  }

  assert.throws(
    () => extensionListingUrl({
      storeId: STORE_ID,
      artifactProviderId: "attacker" as "crxsoso",
    }),
    /supported provider/,
  );
});

test("external navigation uses a protected web tab and passes no URL authority to Tauri", async () => {
  const runtime = globalThis as typeof globalThis & {
    isTauri?: boolean;
    window?: Window;
  };
  const previousIsTauri = Object.getOwnPropertyDescriptor(runtime, "isTauri");
  const previousWindow = Object.getOwnPropertyDescriptor(runtime, "window");
  const webCalls: unknown[][] = [];
  try {
    Object.defineProperty(runtime, "isTauri", { configurable: true, value: false });
    Object.defineProperty(runtime, "window", {
      configurable: true,
      value: {
        // Returning null is valid with noopener/noreferrer and must not turn a
        // successful privacy-preserving open into an application error.
        open: (...args: unknown[]) => {
          webCalls.push(args);
          return null;
        },
      } as unknown as Window,
    });
    await openExtensionListing({ storeId: STORE_ID, artifactProviderId: "crxsoso" });
    assert.deepEqual(webCalls, [[
      `https://www.crxsoso.com/webstore/detail/${STORE_ID}`,
      "_blank",
      "noopener,noreferrer",
    ]]);

    const invokeCalls: unknown[][] = [];
    Object.defineProperty(runtime, "isTauri", { configurable: true, value: true });
    Object.defineProperty(runtime, "window", {
      configurable: true,
      value: {
        __TAURI_INTERNALS__: {
          invoke: async (...args: unknown[]) => {
            invokeCalls.push(args);
          },
        },
      } as unknown as Window,
    });
    await openExtensionListing({ storeId: STORE_ID, artifactProviderId: "chrome-web-store" });
    assert.deepEqual(invokeCalls, [[
      "cbpanel_open_extension_listing",
      { providerId: "chrome-web-store", storeId: STORE_ID },
      undefined,
    ]]);
    assert.equal(webCalls.length, 1);
  } finally {
    restoreGlobal(runtime, "isTauri", previousIsTauri);
    restoreGlobal(runtime, "window", previousWindow);
  }
});

function restoreGlobal(
  runtime: typeof globalThis,
  key: "isTauri" | "window",
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(runtime, key, descriptor);
  else Reflect.deleteProperty(runtime, key);
}
