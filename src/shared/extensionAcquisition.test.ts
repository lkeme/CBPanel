import assert from "node:assert/strict";
import test from "node:test";
import {
  chromeWebStoreListingUrl,
  classifyExtensionReference,
  extensionCapabilityDescriptors,
  isCanonicalChromeExtensionId,
  normalizeExtensionProvenance,
  normalizeExtensionStoreIdentity,
  normalizeExtensionUpdateProviderId,
  normalizeExtensionUpdateState,
} from "./extensionAcquisition";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";
const LISTING_URL = `https://chromewebstore.google.com/detail/${STORE_ID}`;

test("classifyExtensionReference maps canonical ids and supported detail URLs to one identity", () => {
  for (const input of [
    STORE_ID,
    `https://chromewebstore.google.com/detail/tampermonkey/${STORE_ID}`,
    `https://chromewebstore.google.com/detail/${STORE_ID}?hl=zh-CN`,
    `https://chrome.google.com/webstore/detail/tampermonkey/${STORE_ID}`,
    `https://www.crxsoso.com/webstore/detail/tampermonkey/${STORE_ID}`,
    `https://www.crxsoso.com/webstore/detail/${STORE_ID}`,
  ]) {
    const parsed = classifyExtensionReference(input);
    assert.equal(parsed.kind, "canonical", input);
    if (parsed.kind !== "canonical") continue;
    assert.equal(parsed.storeId, STORE_ID);
    assert.equal(parsed.storeUrl, LISTING_URL);
  }
  assert.equal(chromeWebStoreListingUrl(STORE_ID), LISTING_URL);
  assert.equal(isCanonicalChromeExtensionId(STORE_ID), true);
});

test("classifyExtensionReference keeps ordinary text as a keyword and rejects URL-like input locally", () => {
  assert.deepEqual(classifyExtensionReference("  tampermonkey 中文  "), {
    kind: "keyword",
    query: "tampermonkey 中文",
  });
  assert.equal(classifyExtensionReference(" ").kind, "invalid");

  const unsupported = [
    STORE_ID.toUpperCase(),
    `http://chromewebstore.google.com/detail/${STORE_ID}`,
    `https://user@chromewebstore.google.com/detail/${STORE_ID}`,
    `https://chromewebstore.google.com:444/detail/${STORE_ID}`,
    `https://chromewebstore.google.com:443/detail/${STORE_ID}`,
    `https://@chromewebstore.google.com/detail/${STORE_ID}`,
    `https://:@chromewebstore.google.com/detail/${STORE_ID}`,
    `https://chromewebstore.google.com./detail/${STORE_ID}`,
    `https://chromewebstore.google.com/search/${STORE_ID}`,
    `https://chromewebstore.google.com/detail/slug/${STORE_ID}/extra`,
    `https://chromewebstore.google.com/detail/slug/${STORE_ID}/${"a".repeat(32)}`,
    `https://chromewebstore.google.com/detail%2f${STORE_ID}`,
    `https://chromewebstore.google.com/not-detail/../detail/${STORE_ID}`,
    `https://chromewebstore.google.com/not-detail/%2e%2e/detail/${STORE_ID}`,
    `https://chromewebstore.google.com//detail/${STORE_ID}`,
    `https://chromewebstore.google.com/detail/${STORE_ID}/`,
    `https://chromewebstore.google.com\\detail\\${STORE_ID}`,
    `https://%63hromewebstore.google.com/detail/${STORE_ID}`,
    `https://chromewebstore%2egoogle.com/detail/${STORE_ID}`,
    `https://chromewebstore。google.com/detail/${STORE_ID}`,
    `https://chromewebstore．google.com/detail/${STORE_ID}`,
    `https://chromewebstore｡google.com/detail/${STORE_ID}`,
    `https://ｃｈｒｏｍｅｗｅｂｓｔｏｒｅ.google.com/detail/${STORE_ID}`,
    `https://chromewebstore.google.com/det\tail/${STORE_ID}`,
    `https:\n//chromewebstore.google.com/detail/${STORE_ID}`,
    `https:/chromewebstore.google.com/detail/${STORE_ID}`,
    `https:chromewebstore.google.com/detail/${STORE_ID}`,
    `https:///chromewebstore.google.com/detail/${STORE_ID}`,
    `https://crxsoso.com/webstore/detail/${STORE_ID}`,
    `https://www.crxsoso.com/webstore/category/${STORE_ID}`,
    `https://example.com/detail/${STORE_ID}`,
    "javascript:alert(1)",
    "https://",
    `chromewebstore.google.com/detail/${STORE_ID}`,
    "example.com/extension",
  ];
  for (const input of unsupported) {
    const parsed = classifyExtensionReference(input);
    assert.equal(parsed.kind, "invalid", input);
    if (parsed.kind === "invalid") assert.equal(parsed.code, "ACQUISITION_INPUT_UNSUPPORTED");
  }
});

test("capability descriptors preserve independent search and artifact switches", () => {
  const descriptors = extensionCapabilityDescriptors({
    crxsosoSearchEnabled: false,
    googleArtifactEnabled: true,
    crxsosoArtifactEnabled: false,
  });
  assert.deepEqual(descriptors.map(({ id, enabled }) => ({ id, enabled })), [
    { id: "crxsoso-search", enabled: false },
    { id: "google-artifact", enabled: true },
    { id: "crxsoso-artifact", enabled: false },
  ]);
});

test("strict acquisition projections normalize valid server-derived facts", () => {
  assert.deepEqual(normalizeExtensionStoreIdentity({
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    listingUrl: LISTING_URL,
  }), {
    namespace: "chrome-web-store",
    storeId: STORE_ID,
    listingUrl: LISTING_URL,
  });
  assert.deepEqual(normalizeExtensionUpdateState({ status: "available", availableVersion: "5.5.0" }), {
    status: "available",
    availableVersion: "5.5.0",
    checkedAt: undefined,
    errorCode: undefined,
  });
  assert.equal(normalizeExtensionUpdateProviderId("chrome-web-store"), "chrome-web-store");

  const provenance = normalizeExtensionProvenance({
    schemaVersion: 1,
    catalog: { providerId: "crxsoso", observedAt: "2026-08-26T00:00:00.000Z" },
    artifact: {
      providerId: "chrome-web-store",
      finalByteHost: "clients2.googleusercontent.com",
      fetchedAt: "2026-08-26T00:00:01.000Z",
      format: "crx3",
      size: 42,
      sha256: "A".repeat(64),
      retained: true,
    },
    verification: {
      level: "cws-publisher-verified",
      verifiedAt: "2026-08-26T00:00:02.000Z",
      proofDerivedStoreId: STORE_ID,
      developerKeySha256: "b".repeat(64),
      publisherKeySha256: "e".repeat(64),
      manifestSha256: "c".repeat(64),
      treeSha256: "d".repeat(64),
      publisherTrustRootId: "chromium-cws",
      publisherTrustRootVersion: 1,
    },
  });
  assert.equal(provenance?.artifact.sha256, "a".repeat(64));
  assert.equal(provenance?.verification.proofDerivedStoreId, STORE_ID);
});

test("strict acquisition projections reject unknown or inconsistent trust facts", () => {
  const invalidValues = [
    () => normalizeExtensionStoreIdentity({ namespace: "other", storeId: STORE_ID, listingUrl: LISTING_URL }),
    () => normalizeExtensionStoreIdentity({ namespace: "chrome-web-store", storeId: "short", listingUrl: LISTING_URL }),
    () => normalizeExtensionStoreIdentity({ namespace: "chrome-web-store", storeId: STORE_ID, listingUrl: "https://example.com" }),
    () => normalizeExtensionUpdateProviderId("automatic"),
    () => normalizeExtensionUpdateState({ status: "failed" }),
    () => normalizeExtensionUpdateState({ status: "available" }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: { providerId: "mystery", format: "crx3", retained: true },
      verification: { level: "safe" },
    }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: { providerId: "legacy", format: "zip", retained: false, sha256: "not-a-digest" },
      verification: { level: "legacy-unknown" },
    }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: { providerId: "legacy", format: "zip", retained: false },
      verification: { level: "cws-publisher-verified" },
    }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: { providerId: "manual-local", format: "zip", retained: false },
      verification: { level: "developer-signed" },
    }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: { providerId: "chrome-web-store", format: "crx3", retained: false },
      verification: { level: "legacy-unknown" },
    }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: { providerId: "manual-local", format: "crx3", sha256: "a".repeat(64), retained: false },
      verification: { level: "developer-signed", proofDerivedStoreId: STORE_ID },
    }),
    () => normalizeExtensionProvenance({
      schemaVersion: 1,
      artifact: {
        providerId: "chrome-web-store",
        finalByteHost: "https://example.com/package.crx",
        fetchedAt: "not-a-time",
        format: "crx3",
        retained: true,
      },
      verification: { level: "legacy-unknown" },
    }),
  ];
  for (const read of invalidValues) {
    assert.throws(read, (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.equal((error as { code?: string }).code, "EXTENSION_ACQUISITION_CONTRACT_INVALID");
      return true;
    });
  }
});
