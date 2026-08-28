import { createCipheriv } from "node:crypto";
import fs from "node:fs/promises";
import {
  chromeWebStoreListingUrl,
  isCanonicalChromeExtensionId,
  normalizeCrxsosoCatalogIconUrl,
  type ExtensionArtifactOffer,
  type ExtensionCatalogItem,
} from "../../../src/shared/extensionAcquisition";
import {
  ExtensionProviderError,
  PROVIDER_HTTP_LIMITS,
  ProviderHttpClient,
} from "../providerHttpClient";
import type {
  ArtifactProvider,
  ArtifactResolveInput,
  CatalogContinuation,
  CatalogSearchInput,
  CatalogSearchPage,
  CatalogSearchProvider,
  ProviderClock,
  ProviderHttpTransport,
  ResolvedArtifact,
} from "./types";

const CRXSOSO_SEARCH_ENDPOINT = "https://api.crxsoso.com/search/result?type=chrome";
const CRXSOSO_DLINK_ENDPOINT = "https://api.crxsoso.com/chrome/dlink";
const CRXSOSO_API_HOST = "api.crxsoso.com";
const CRXSOSO_CRX_HOST = "c2.crxsoso.com";
const CRXSOSO_PAGE_SIZE = 24;
const CRXSOSO_RESPONSE_TIMEOUT_MS = 30_000;
const CRXSOSO_FIELD_LIMITS = Object.freeze({
  query: 256,
  pageItems: 100,
  id: 128,
  name: 512,
  description: 8_192,
  category: 256,
  token: 4_096,
});

// Public website compatibility constants. They are not credentials or secrets.
const CRXSOSO_AES_KEY = "lOrd6SqeZpDdGBoY";
const CRXSOSO_AES_IV = "RxE86Of9vRkNvfZL";

export type CrxsosoRequestEncoder = (payload: Readonly<Record<string, unknown>>) => string;

export interface CrxsosoProviderOptions {
  httpClient?: ProviderHttpTransport;
  now?: ProviderClock;
  encodeRequest?: CrxsosoRequestEncoder;
}

export class CrxsosoProvider implements CatalogSearchProvider, ArtifactProvider {
  readonly id = "crxsoso" as const;

  private readonly httpClient: ProviderHttpTransport;

  private readonly now: ProviderClock;

  private readonly encodeRequest: CrxsosoRequestEncoder;

  constructor(options: CrxsosoProviderOptions = {}) {
    this.httpClient = options.httpClient ?? new ProviderHttpClient();
    this.now = options.now ?? (() => new Date());
    this.encodeRequest = options.encodeRequest ?? encodeCrxsosoRequest;
  }

  offer(storeId: string): ExtensionArtifactOffer {
    assertCanonicalStoreId(storeId);
    return {
      namespace: "chrome-web-store",
      storeId,
      artifactProviderId: this.id,
      format: "crx3",
      providerLabel: "CRX搜搜",
    };
  }

  async search(input: CatalogSearchInput, signal: AbortSignal): Promise<CatalogSearchPage> {
    const query = normalizeQuery(input.query);
    const continuation = normalizeContinuation(input.continuation);
    const payload: Record<string, unknown> = {
      keyword: query,
      page: continuation?.page ?? 1,
      size: CRXSOSO_PAGE_SIZE,
    };
    if (continuation) payload.token = continuation.token;

    const response = await this.httpClient.readJson({
      url: CRXSOSO_SEARCH_ENDPOINT,
      init: encodedPost(this.encodeRequest, payload),
      kind: "catalog",
      hostPolicy: crxsosoApiHostPolicy,
      signal,
      maxBytes: PROVIDER_HTTP_LIMITS.catalogBytes,
      headerTimeoutMs: PROVIDER_HTTP_LIMITS.catalogHeaderTimeoutMs,
      idleTimeoutMs: PROVIDER_HTTP_LIMITS.catalogHeaderTimeoutMs,
      totalTimeoutMs: CRXSOSO_RESPONSE_TIMEOUT_MS,
      maxRedirects: PROVIDER_HTTP_LIMITS.redirectHops,
    });

    return normalizeCrxsosoSearchResponse(response.value, observedAt(this.now));
  }

  async detail(storeId: string, signal: AbortSignal): Promise<ExtensionCatalogItem> {
    assertCanonicalStoreId(storeId);
    const response = await this.httpClient.readJson({
      url: "https://api.crxsoso.com/chrome/detail",
      init: encodedPost(this.encodeRequest, { id: storeId }),
      kind: "catalog",
      hostPolicy: crxsosoApiHostPolicy,
      signal,
      maxBytes: PROVIDER_HTTP_LIMITS.catalogBytes,
      headerTimeoutMs: PROVIDER_HTTP_LIMITS.catalogHeaderTimeoutMs,
      idleTimeoutMs: PROVIDER_HTTP_LIMITS.catalogHeaderTimeoutMs,
      totalTimeoutMs: CRXSOSO_RESPONSE_TIMEOUT_MS,
      maxRedirects: PROVIDER_HTTP_LIMITS.redirectHops,
    });
    const root = providerRecord(response.value, "CRX搜搜 detail response");
    assertBusinessSuccess(root.code, "catalog");
    const data = providerRecord(root.data, "CRX搜搜 detail data");
    const detail = providerRecord(data.detail, "CRX搜搜 detail item");
    if (detail.crxId !== storeId) throw catalogSchemaChanged("CRX搜搜 detail id does not match the requested id.");
    const page = normalizeCrxsosoSearchResponse({
      code: root.code,
      data: { extensionList: [detail], hasMorePages: false },
    }, observedAt(this.now));
    const item = page.items[0];
    if (!item) throw new ExtensionProviderError("EXTENSION_CATALOG_HTTP_ERROR", "CRX搜搜 detail was not found.", 404);
    return item;
  }

  async resolveCurrent(input: ArtifactResolveInput, signal: AbortSignal): Promise<ResolvedArtifact> {
    assertCanonicalStoreId(input.storeId);
    const detailPayload = {
      storeUrl: `https://chrome.google.com/webstore/detail/${input.storeId}`,
      addonId: input.storeId,
      storeType: "chrome",
      downloadUrl: buildCrxsosoUpstreamHint(input.storeId),
      name: input.storeId,
      version: "",
      size: "",
    };
    const detail = await this.httpClient.readJson({
      url: CRXSOSO_DLINK_ENDPOINT,
      init: encodedPost(this.encodeRequest, detailPayload),
      kind: "artifact",
      hostPolicy: crxsosoApiHostPolicy,
      signal,
      maxBytes: PROVIDER_HTTP_LIMITS.catalogBytes,
      headerTimeoutMs: PROVIDER_HTTP_LIMITS.artifactHeaderTimeoutMs,
      idleTimeoutMs: PROVIDER_HTTP_LIMITS.catalogHeaderTimeoutMs,
      totalTimeoutMs: CRXSOSO_RESPONSE_TIMEOUT_MS,
      maxRedirects: PROVIDER_HTTP_LIMITS.redirectHops,
    });
    const artifactUrl = normalizeCrxsosoArtifactResponse(detail.value, detailPayload.downloadUrl);
    const download = await this.httpClient.downloadToFile({
      url: artifactUrl,
      init: {
        method: "GET",
        headers: { accept: "application/x-chrome-extension,application/octet-stream" },
      },
      kind: "artifact",
      hostPolicy: crxsosoArtifactHostPolicy,
      signal,
      maxBytes: PROVIDER_HTTP_LIMITS.artifactBytes,
      headerTimeoutMs: PROVIDER_HTTP_LIMITS.artifactHeaderTimeoutMs,
      idleTimeoutMs: PROVIDER_HTTP_LIMITS.artifactIdleTimeoutMs,
      totalTimeoutMs: PROVIDER_HTTP_LIMITS.artifactTotalTimeoutMs,
      maxRedirects: PROVIDER_HTTP_LIMITS.redirectHops,
    }, input.destinationPath);

    if (download.size === 0) {
      await fs.rm(download.path, { force: true }).catch(() => undefined);
      throw artifactUnavailable();
    }

    return {
      namespace: "chrome-web-store",
      storeId: input.storeId,
      artifactProviderId: this.id,
      format: "crx3",
      download,
    };
  }
}

/** AES-128-CTR with explicit CryptoJS-compatible PKCS#7 padding. */
export function encodeCrxsosoRequest(payload: Readonly<Record<string, unknown>>): string {
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const paddingLength = 16 - (plaintext.length % 16);
  const padded = Buffer.concat([plaintext, Buffer.alloc(paddingLength, paddingLength)]);
  const cipher = createCipheriv(
    "aes-128-ctr",
    Buffer.from(CRXSOSO_AES_KEY, "utf8"),
    Buffer.from(CRXSOSO_AES_IV, "utf8"),
  );
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("hex");
}

export function normalizeCrxsosoSearchResponse(value: unknown, observedAtValue: string): CatalogSearchPage {
  const root = providerRecord(value, "CRX搜搜 search response");
  assertBusinessSuccess(root.code, "catalog");
  const data = providerRecord(root.data, "CRX搜搜 search data");
  if (!Array.isArray(data.extensionList) || data.extensionList.length > CRXSOSO_FIELD_LIMITS.pageItems) {
    throw catalogSchemaChanged("CRX搜搜 search results are missing or exceed the page limit.");
  }

  const items: ExtensionCatalogItem[] = [];
  const seenIds = new Set<string>();
  let excludedNonCanonicalCount = 0;
  for (const rawItem of data.extensionList) {
    const item = providerRecord(rawItem, "CRX搜搜 catalog item");
    const rawId = boundedRequiredString(item.crxId, CRXSOSO_FIELD_LIMITS.id, "CRX搜搜 extension id");
    if (!isCanonicalChromeExtensionId(rawId)) {
      excludedNonCanonicalCount += 1;
      continue;
    }
    if (seenIds.has(rawId)) continue;
    seenIds.add(rawId);

    const normalized: ExtensionCatalogItem = {
      namespace: "chrome-web-store",
      storeId: rawId,
      storeUrl: chromeWebStoreListingUrl(rawId),
      catalogProviderId: "crxsoso",
      observedAt: normalizeObservedAt(observedAtValue),
      name: boundedRequiredString(item.name, CRXSOSO_FIELD_LIMITS.name, "CRX搜搜 extension name"),
    };
    const description = boundedOptionalDescription(
      item.shortDescription,
      CRXSOSO_FIELD_LIMITS.description,
      "CRX搜搜 extension description",
    );
    const overview = boundedOptionalDescription(
      item.description,
      CRXSOSO_FIELD_LIMITS.description,
      "CRX搜搜 extension overview",
    );
    const category = boundedOptionalString(
      item.categoryName,
      CRXSOSO_FIELD_LIMITS.category,
      "CRX搜搜 extension category",
    );
    const version = boundedOptionalString(item.version, 128, "CRX搜搜 extension version");
    const size = boundedOptionalString(item.size, 128, "CRX搜搜 extension size");
    const developer = boundedOptionalString(item.developerName ?? item.developer, 512, "CRX搜搜 extension developer");
    const manifestVersion = optionalNonNegativeInteger(item.manifestVersion, "CRX搜搜 Manifest version");
    const updatedAt = normalizeCrxsosoCatalogUpdatedAt(item.lastUpdateDate);
    const userCount = optionalNonNegativeInteger(item.activeInstallCount, "CRX搜搜 active install count");
    const rating = optionalRating(item.averageRating);
    // `thumbnail` is the field emitted by the public CRX搜搜 catalog.  Keep
    // the historical `iconUrl` alias for fixture/compatibility payloads, but
    // only expose it after the shared strict host/scheme projection.
    const iconUrl = normalizeCrxsosoCatalogIconUrl(item.thumbnail)
      ?? normalizeCrxsosoCatalogIconUrl(item.iconUrl);
    if (description !== undefined) normalized.description = description;
    if (overview !== undefined) normalized.overview = overview;
    if (category !== undefined) normalized.category = category;
    if (version !== undefined) normalized.version = version;
    if (updatedAt !== undefined) normalized.updatedAt = updatedAt;
    if (size !== undefined) normalized.size = size;
    if (manifestVersion !== undefined) normalized.manifestVersion = manifestVersion;
    if (developer !== undefined) normalized.developer = developer;
    if (userCount !== undefined) normalized.userCount = userCount;
    if (rating !== undefined) normalized.rating = rating;
    if (iconUrl !== undefined) normalized.iconUrl = iconUrl;
    items.push(normalized);
  }

  if (typeof data.hasMorePages !== "boolean") {
    throw catalogSchemaChanged("CRX搜搜 pagination status is invalid.");
  }
  const continuation = data.hasMorePages ? decodeContinuation(data) : undefined;
  return {
    items,
    excludedNonCanonicalCount,
    continuation,
    hasMore: continuation !== undefined,
  };
}

function normalizeCrxsosoCatalogUpdatedAt(value: unknown): string | undefined {
  const numericValue = typeof value === "number"
    ? value
    : typeof value === "string" && value.trim() && /^\d+(?:\.\d+)?$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  const timestampMs = Number.isFinite(numericValue)
    ? numericValue > 100_000_000_000 ? numericValue : numericValue * 1_000
    : typeof value === "string" && value.trim() ? Date.parse(value) : Number.NaN;
  if (!Number.isFinite(timestampMs) || timestampMs < 0 || timestampMs > Date.UTC(2100, 0, 1)) return undefined;
  return new Date(timestampMs).toISOString();
}

function normalizeCrxsosoArtifactResponse(value: unknown, expectedUpstreamHint: string): string {
  const root = providerRecord(value, "CRX搜搜 package response", "artifact");
  assertBusinessSuccess(root.code, "artifact");
  if (!Array.isArray(root.dlinkOffline) || root.dlinkOffline.length > 100) {
    throw artifactProviderError("CRX搜搜 offline package offers are invalid.");
  }
  for (const rawOffer of root.dlinkOffline) {
    const offer = providerRecord(rawOffer, "CRX搜搜 offline package offer", "artifact");
    if (offer.format !== ".crx") continue;
    const candidate = boundedArtifactString(offer.dlink, 16_384, "CRX搜搜 package URL");
    if (candidate === expectedUpstreamHint) continue;
    return normalizeCrxsosoCrxUrl(candidate);
  }

  // Some revisions return the current CRX as the top-level link. It is usable
  // only when the link independently satisfies the reviewed mirror contract.
  if (typeof root.dlink === "string" && root.dlink.trim()) {
    const candidate = boundedArtifactString(root.dlink, 16_384, "CRX搜搜 package URL");
    if (candidate === expectedUpstreamHint) throw artifactUnavailable();
    return normalizeCrxsosoCrxUrl(candidate);
  }
  throw artifactUnavailable();
}

function normalizeCrxsosoCrxUrl(rawUrl: string): string {
  if (
    rawUrl.trim() !== rawUrl
    || /[\u0000-\u001f\u007f\\]/.test(rawUrl)
    || !/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(rawUrl)
  ) {
    throw artifactRedirectRejected();
  }
  const rawAuthority = /^https:\/\/([^/?#]+)/i.exec(rawUrl)?.[1];
  if (
    !rawAuthority
    || /[%:@]/.test(rawAuthority)
    || /[^\x21-\x7e]/.test(rawAuthority)
  ) {
    throw artifactRedirectRejected();
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw artifactRedirectRejected();
  }
  if (
    parsed.protocol !== "https:"
    || parsed.username
    || parsed.password
    || parsed.port
    || parsed.hostname !== CRXSOSO_CRX_HOST
    || rawAuthority.toLowerCase() !== parsed.hostname
    || parsed.hostname.endsWith(".")
    || parsed.hash
    || !parsed.pathname.toLowerCase().endsWith(".crx")
    || /%(?:2f|5c)/i.test(parsed.pathname)
  ) {
    throw artifactRedirectRejected();
  }
  return parsed.toString();
}

export function crxsosoApiHostPolicy(hostname: string): boolean {
  return hostname === CRXSOSO_API_HOST;
}

export function crxsosoArtifactHostPolicy(hostname: string): boolean {
  return hostname === CRXSOSO_CRX_HOST;
}

function encodedPost(encoder: CrxsosoRequestEncoder, payload: Record<string, unknown>): RequestInit {
  const encoded = encoder(payload);
  if (
    typeof encoded !== "string"
    || encoded.length === 0
    || encoded.length > 131_072
    || encoded.length % 2 !== 0
    || !/^[a-f0-9]+$/.test(encoded)
  ) {
    throw new TypeError("CRX搜搜 request encoder returned an invalid ciphertext.");
  }
  return {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ data: encoded }),
  };
}

function buildCrxsosoUpstreamHint(storeId: string): string {
  const url = new URL("https://clients2.google.com/service/update2/crx");
  url.searchParams.set("response", "redirect");
  url.searchParams.set("os", "win");
  url.searchParams.set("arch", "x86-64");
  url.searchParams.set("os_arch", "x86-64");
  url.searchParams.set("nacl_arch", "x86-64");
  url.searchParams.set("prod", "chromecrx");
  url.searchParams.set("prodchannel", "unknown");
  url.searchParams.set("prodversion", "9999.0.9999.0");
  url.searchParams.set("acceptformat", "crx3");
  // These are CRX搜搜's fixed website-compatibility hints, not the local core
  // version. Simplified/on-demand Google URLs are echoed instead of mirrored.
  url.searchParams.set("x", `id=${storeId}&uc`);
  return url.toString();
}

function normalizeQuery(query: unknown): string {
  if (typeof query !== "string") throw unsupportedInput("Search query must be text.");
  const normalized = query.trim();
  if (!normalized || normalized.length > CRXSOSO_FIELD_LIMITS.query || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw unsupportedInput("Search query must be non-empty bounded text.");
  }
  return normalized;
}

function normalizeContinuation(value: CatalogContinuation | undefined): CatalogContinuation | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value.page) || value.page < 2 || value.page > 100_000) {
    throw catalogCursorInvalid();
  }
  if (
    typeof value.token !== "string"
    || !value.token
    || value.token.trim() !== value.token
    || value.token.length > CRXSOSO_FIELD_LIMITS.token
    || /[\u0000-\u001f\u007f]/.test(value.token)
  ) {
    throw catalogCursorInvalid();
  }
  return { page: value.page, token: value.token };
}

function decodeContinuation(data: Record<string, unknown>): CatalogContinuation {
  const token = boundedOpaqueToken(data.nextToken, CRXSOSO_FIELD_LIMITS.token, "CRX搜搜 continuation token");
  if (!Number.isSafeInteger(data.nextPageNo) || Number(data.nextPageNo) < 2 || Number(data.nextPageNo) > 100_000) {
    throw catalogSchemaChanged("CRX搜搜 next page number is invalid.");
  }
  return { page: Number(data.nextPageNo), token };
}

function boundedOpaqueToken(value: unknown, maxLength: number, label: string): string {
  if (
    typeof value !== "string"
    || !value
    || value.trim() !== value
    || value.length > maxLength
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw catalogSchemaChanged(`${label} is invalid.`);
  }
  return value;
}

function providerRecord(
  value: unknown,
  label: string,
  kind: "catalog" | "artifact" = "catalog",
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (kind === "artifact") throw artifactProviderError(`${label} is invalid.`);
    throw catalogSchemaChanged(`${label} is invalid.`);
  }
  return value as Record<string, unknown>;
}

function assertBusinessSuccess(code: unknown, kind: "catalog" | "artifact"): void {
  if (code === 200) return;
  if (!Number.isSafeInteger(code)) {
    if (kind === "catalog") throw catalogSchemaChanged("CRX搜搜 business status is invalid.");
    throw artifactProviderError("CRX搜搜 business status is invalid.");
  }
  if (code === 429 && kind === "catalog") {
    throw new ExtensionProviderError(
      "EXTENSION_CATALOG_RATE_LIMITED",
      "CRX搜搜 is rate limiting catalog requests.",
      429,
    );
  }
  if ((code === 404 || code === 410) && kind === "artifact") throw artifactUnavailable();
  if (kind === "catalog") {
    throw new ExtensionProviderError(
      "EXTENSION_CATALOG_HTTP_ERROR",
      "CRX搜搜 returned an unsuccessful catalog status.",
      502,
    );
  }
  throw artifactProviderError("CRX搜搜 returned an unsuccessful package status.");
}

function boundedRequiredString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string") throw catalogSchemaChanged(`${label} is invalid.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw catalogSchemaChanged(`${label} is invalid.`);
  }
  return normalized;
}

function boundedOptionalString(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return boundedRequiredString(value, maxLength, label);
}

function boundedOptionalDescription(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > maxLength) {
    throw catalogSchemaChanged(`${label} is missing or exceeds the field limit.`);
  }
  const normalized = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!normalized || normalized.length > maxLength) return undefined;
  return normalized;
}

function boundedArtifactString(value: unknown, maxLength: number, label: string): string {
  if (typeof value !== "string") throw artifactProviderError(`${label} is invalid.`);
  if (!value || value.length > maxLength) {
    throw artifactProviderError(`${label} is invalid.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw catalogSchemaChanged(`${label} is invalid.`);
  }
  return value;
}

function optionalRating(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  let parsed: number;
  if (typeof value === "number") {
    parsed = value;
  } else if (typeof value === "string" && /^\d(?:\.\d+)?$/.test(value)) {
    parsed = Number(value);
  } else {
    throw catalogSchemaChanged("CRX搜搜 average rating is invalid.");
  }
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 5) {
    throw catalogSchemaChanged("CRX搜搜 average rating is invalid.");
  }
  return parsed;
}

function observedAt(now: ProviderClock): string {
  const value = now();
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new TypeError("Provider clock returned an invalid date.");
  }
  return value.toISOString();
}

function normalizeObservedAt(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new TypeError("Catalog observation time must be an ISO timestamp with a timezone.");
  }
  return new Date(timestamp).toISOString();
}

function assertCanonicalStoreId(storeId: string): void {
  if (!isCanonicalChromeExtensionId(storeId)) {
    throw unsupportedInput("CRX搜搜 acquisition requires a canonical extension id.");
  }
}

function unsupportedInput(message: string): ExtensionProviderError {
  return new ExtensionProviderError("ACQUISITION_INPUT_UNSUPPORTED", message, 400);
}

function catalogCursorInvalid(): ExtensionProviderError {
  return new ExtensionProviderError(
    "EXTENSION_CATALOG_CURSOR_INVALID",
    "The catalog continuation cursor is invalid.",
    400,
  );
}

function catalogSchemaChanged(message: string): ExtensionProviderError {
  return new ExtensionProviderError("EXTENSION_CATALOG_SCHEMA_CHANGED", message, 502);
}

function artifactUnavailable(): ExtensionProviderError {
  return new ExtensionProviderError(
    "ARTIFACT_UNAVAILABLE",
    "CRX搜搜 has no current CRX package for this extension.",
    404,
  );
}

function artifactProviderError(message: string): ExtensionProviderError {
  return new ExtensionProviderError("ARTIFACT_PROVIDER_HTTP_ERROR", message, 502);
}

function artifactRedirectRejected(): ExtensionProviderError {
  return new ExtensionProviderError(
    "ARTIFACT_REDIRECT_REJECTED",
    "CRX搜搜 returned an unsupported package URL.",
    502,
  );
}
