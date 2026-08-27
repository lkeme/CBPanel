import { randomBytes } from "node:crypto";

import {
  EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  chromeWebStoreListingUrl,
  classifyExtensionReference,
  extensionCapabilityDescriptors,
  isCanonicalChromeExtensionId,
  selectedExtensionArtifactProvider,
  type ExtensionAcquisitionCapabilityId,
  type ExtensionAcquisitionErrorCode,
  type ExtensionCapabilityHealth,
  type ExtensionCapabilityView,
  type ExtensionCatalogItem,
  type ExtensionCatalogProviderId,
  type ExtensionCatalogSearchPage,
  type ExtensionCatalogSearchRequest,
  type ExtensionReferenceResolution,
  type ExtensionReferenceResolveRequest,
} from "../../src/shared/extensionAcquisition";
import { normalizeSettings, type AppSettings } from "../../src/shared/settings";
import type {
  CatalogContinuation,
  CatalogSearchPage,
  CatalogSearchProvider,
} from "./extensionProviders/types";
import type { ExtensionProviderRegistry } from "./extensionProviders/providerRegistry";

export const EXTENSION_CATALOG_QUERY_MAX_LENGTH = 256;
export const EXTENSION_ACQUISITION_CURSOR_MAX_LENGTH = 128;
export const EXTENSION_REFERENCE_INPUT_MAX_LENGTH = 4_096;

const DEFAULT_CURSOR_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_CURSOR_ENTRIES = 512;
const MAX_PROVIDER_CONTINUATION_LENGTH = 4_096;
const MAX_PROVIDER_CONTINUATION_PAGE = 100_000;
const MAX_PROVIDER_DESCRIPTION_LENGTH = 8_192;
const MAX_PROVIDER_PAGE_ITEMS = 100;
const MAX_EXCLUDED_ITEM_COUNT = 1_000_000;
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export function isValidExtensionAcquisitionCursor(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= EXTENSION_ACQUISITION_CURSOR_MAX_LENGTH
    && CURSOR_PATTERN.test(value);
}

export function normalizeExtensionCatalogQuery(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length > EXTENSION_CATALOG_QUERY_MAX_LENGTH
    || /[\u0000-\u001f\u007f]/.test(value)
  ) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Catalog search query must be a bounded plain string.");
  }
  const query = value.trim();
  if (!query) throw new ExtensionAcquisitionError("ACQUISITION_INPUT_EMPTY", "Enter a catalog search keyword.");
  const reference = classifyExtensionReference(query);
  if (reference.kind === "invalid") {
    throw new ExtensionAcquisitionError(reference.code, reference.message);
  }
  if (reference.kind === "canonical") {
    throw new ExtensionAcquisitionError(
      "ACQUISITION_INPUT_UNSUPPORTED",
      "Use exact resolution for a supported store URL or canonical extension id.",
    );
  }
  return reference.query;
}

export interface ExtensionAcquisitionServiceOptions {
  readSettings: () => Promise<AppSettings>;
  providerRegistry: Pick<ExtensionProviderRegistry, "catalog" | "artifactOffers">;
  now?: () => number;
  cursorTtlMs?: number;
  maxCursorEntries?: number;
}

type CursorState = {
  providerId: ExtensionCatalogProviderId;
  query: string;
  continuation: CatalogContinuation;
  expiresAt: number;
  inUse: boolean;
};

type SearchOperation = {
  sequence: number;
  controller: AbortController;
};

export interface ExtensionCatalogObservation {
  observationId: string;
  storeId: string;
  providerId: ExtensionCatalogProviderId;
  observedAt: string;
  name: string;
  version?: string;
}

type CatalogObservationState = ExtensionCatalogObservation & { expiresAt: number };

type NormalizedProviderPage = {
  items: ExtensionCatalogItem[];
  excludedNonCanonicalCount: number;
  continuation?: CatalogContinuation;
  hasMore: boolean;
};

export class ExtensionAcquisitionError extends Error {
  readonly code: ExtensionAcquisitionErrorCode;

  readonly status: number;

  constructor(code: ExtensionAcquisitionErrorCode, message = publicErrorMessage(code)) {
    super(message);
    this.name = "ExtensionAcquisitionError";
    this.code = code;
    this.status = publicErrorStatus(code);
  }
}

/**
 * Read-only orchestration for built-in remote extension discovery. It deliberately has no repository,
 * extension service, cache path, or filesystem dependency: search and exact resolution are ephemeral.
 */
export class ExtensionAcquisitionService {
  private readonly catalogSearchProvider: CatalogSearchProvider;

  private readonly now: () => number;

  private readonly cursorTtlMs: number;

  private readonly maxCursorEntries: number;

  private readonly cursors = new Map<string, CursorState>();

  private readonly health = new Map<ExtensionAcquisitionCapabilityId, ExtensionCapabilityHealth>();

  private readonly observations = new Map<string, CatalogObservationState>();

  private activeSearch?: SearchOperation;

  private searchSequence = 0;

  constructor(private readonly options: ExtensionAcquisitionServiceOptions) {
    this.catalogSearchProvider = options.providerRegistry.catalog("crxsoso");
    if (this.catalogSearchProvider.id !== "crxsoso") {
      throw new TypeError("The built-in catalog search provider must be CRX搜搜.");
    }
    this.now = options.now ?? Date.now;
    this.cursorTtlMs = positiveSafeInteger(options.cursorTtlMs, DEFAULT_CURSOR_TTL_MS);
    this.maxCursorEntries = positiveSafeInteger(options.maxCursorEntries, DEFAULT_MAX_CURSOR_ENTRIES);
  }

  async capabilities(): Promise<ExtensionCapabilityView[]> {
    const settings = await this.readSettings();
    this.observeSearchGates(settings);
    return extensionCapabilityDescriptors(settings.extensionAcquisition).map((descriptor) => {
      // Artifact channels are configuration-only; they are never probed in
      // the background and therefore have no health state.  Search health is
      // retained only as evidence from the most recent explicit request.
      const health = descriptor.id === "crxsoso-search" ? this.health.get(descriptor.id) : undefined;
      return {
        ...descriptor,
        operations: [...descriptor.operations],
        ...(health ? { health: { ...health } } : {}),
      };
    });
  }

  /** Called by the settings write path so disabling/revoking a gate aborts before another API read. */
  settingsChanged(settings: AppSettings): void {
    this.observeSearchGates(normalizeSettings(settings));
  }

  catalogObservation(observationId: string, storeId: string): ExtensionCatalogObservation | undefined {
    if (!isValidExtensionAcquisitionCursor(observationId) || !isCanonicalChromeExtensionId(storeId)) return undefined;
    const observation = this.observations.get(observationId);
    if (!observation || observation.storeId !== storeId || observation.expiresAt <= this.now()) {
      this.observations.delete(observationId);
      return undefined;
    }
    const { expiresAt: _expiresAt, ...view } = observation;
    return { ...view };
  }

  async search(
    request: ExtensionCatalogSearchRequest,
    callerSignal?: AbortSignal,
  ): Promise<ExtensionCatalogSearchPage> {
    const normalizedRequest = normalizeSearchRequest(request);
    const settings = await this.readSettings();
    this.observeSearchGates(settings);
    assertSearchAllowed(settings);
    if (callerSignal?.aborted) throw new ExtensionAcquisitionError("ACQUISITION_CANCELLED");

    let cursorId: string | undefined;
    let cursorState: CursorState | undefined;
    if (normalizedRequest.cursor) {
      cursorId = normalizedRequest.cursor;
      cursorState = this.readCursor(cursorId, normalizedRequest.query);
    } else {
      this.deleteCursors("crxsoso", normalizedRequest.query);
    }

    const operation = this.beginSearch();
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, operation.controller.signal])
      : operation.controller.signal;
    if (signal.aborted) {
      this.finishSearch(operation, cursorState);
      throw abortReason(signal);
    }
    if (cursorState) cursorState.inUse = true;

    try {
      let rawPage: CatalogSearchPage;
      try {
        rawPage = await this.catalogSearchProvider.search({
          query: normalizedRequest.query,
          ...(cursorState ? { continuation: { ...cursorState.continuation } } : {}),
        }, signal);
      } catch (error) {
        await this.handleProviderFailure(error, operation, signal);
      }

      this.assertSearchCurrent(operation, signal);
      const latestSettings = await this.readSettings();
      this.observeSearchGates(latestSettings);
      this.assertSearchCurrent(operation, signal);
      assertSearchAllowed(latestSettings);

      let page: NormalizedProviderPage;
      try {
        page = normalizeProviderPage(rawPage!);
      } catch {
        const error = new ExtensionAcquisitionError("EXTENSION_CATALOG_SCHEMA_CHANGED");
        this.recordHealth("crxsoso-search", "unavailable", error.code);
        throw error;
      }

      this.assertSearchCurrent(operation, signal);
      if (cursorId) this.cursors.delete(cursorId);
      const nextCursor = page.hasMore && page.continuation
        ? this.issueCursor(normalizedRequest.query, page.continuation)
        : undefined;
      this.recordHealth("crxsoso-search", "healthy");
      return {
        query: normalizedRequest.query,
        items: page.items.map((item) => ({
          ...item,
          observationId: this.issueObservation(item),
        })),
        excludedNonCanonicalCount: page.excludedNonCanonicalCount,
        ...(nextCursor ? { cursor: nextCursor } : {}),
        hasMore: page.hasMore,
      };
    } finally {
      this.finishSearch(operation, cursorState);
    }
  }

  async resolve(request: ExtensionReferenceResolveRequest): Promise<ExtensionReferenceResolution> {
    const input = normalizeReferenceInput(request);
    const settings = await this.readSettings();
    this.observeSearchGates(settings);
    const reference = classifyExtensionReference(input);
    if (reference.kind === "invalid") {
      throw new ExtensionAcquisitionError(reference.code, reference.message);
    }
    if (reference.kind === "keyword") {
      throw new ExtensionAcquisitionError(
        "ACQUISITION_INPUT_UNSUPPORTED",
        "Use catalog search for keywords; exact resolution accepts a supported store URL or canonical extension id.",
      );
    }

    const acquisition = settings.extensionAcquisition;
    const selectedProviderId = selectedExtensionArtifactProvider(acquisition);
    // The registry is a reviewed built-in boundary, but keep the single-choice
    // invariant at this orchestration boundary too so a test/custom adapter can
    // never accidentally expose two download channels to the client.
    const offers = this.options.providerRegistry
      .artifactOffers(reference.storeId, acquisition)
      .filter((offer) => (
        offer.namespace === "chrome-web-store"
        && offer.storeId === reference.storeId
        && offer.artifactProviderId === selectedProviderId
        && offer.format === "crx3"
      ))
      .slice(0, 1);
    return {
      namespace: "chrome-web-store",
      storeId: reference.storeId,
      storeUrl: reference.storeUrl,
      offers,
    };
  }

  private async readSettings(): Promise<AppSettings> {
    return normalizeSettings(await this.options.readSettings());
  }

  private observeSearchGates(settings: AppSettings): void {
    if (
      settings.extensionAcquisition.crxsosoDisclosureVersionAccepted
      < EXTENSION_ACQUISITION_DISCLOSURE_VERSION
    ) {
      this.cancelActiveSearch(new ExtensionAcquisitionError("CATALOG_DISCLOSURE_REQUIRED"));
      this.deleteCursors("crxsoso");
      this.observations.clear();
    }
  }

  private beginSearch(): SearchOperation {
    this.cancelActiveSearch(new ExtensionAcquisitionError("ACQUISITION_CANCELLED"));
    const operation = {
      sequence: ++this.searchSequence,
      controller: new AbortController(),
    };
    this.activeSearch = operation;
    return operation;
  }

  private finishSearch(operation: SearchOperation, cursorState: CursorState | undefined): void {
    if (cursorState && this.cursorsHasState(cursorState)) cursorState.inUse = false;
    if (this.activeSearch === operation) this.activeSearch = undefined;
  }

  private cancelActiveSearch(error: ExtensionAcquisitionError): void {
    if (this.activeSearch && !this.activeSearch.controller.signal.aborted) {
      this.activeSearch.controller.abort(error);
    }
  }

  private assertSearchCurrent(operation: SearchOperation, signal: AbortSignal): void {
    if (signal.aborted) throw abortReason(signal);
    if (this.activeSearch !== operation || operation.sequence !== this.searchSequence) {
      throw new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
    }
  }

  private async handleProviderFailure(
    error: unknown,
    operation: SearchOperation,
    signal: AbortSignal,
  ): Promise<never> {
    if (signal.aborted || this.activeSearch !== operation || operation.sequence !== this.searchSequence) {
      throw signal.aborted ? abortReason(signal) : new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
    }
    const mapped = normalizeCatalogFailure(error);
    if (mapped.code === "ACQUISITION_CANCELLED") throw mapped;

    // A settings change may overtake a provider failure. Re-read before publishing health or the error so
    // a now-disabled capability cannot leave a stale network result visible.
    try {
      const latestSettings = await this.readSettings();
      this.observeSearchGates(latestSettings);
      this.assertSearchCurrent(operation, signal);
      assertSearchAllowed(latestSettings);
    } catch (gateError) {
      if (gateError instanceof ExtensionAcquisitionError) throw gateError;
      // Settings storage failed after the provider already produced a stable failure. Keep the provider
      // failure safe and actionable rather than replacing it with an unrelated internal exception.
    }

    this.recordHealth("crxsoso-search", "unavailable", mapped.code);
    throw mapped;
  }

  private readCursor(cursor: string, query: string): CursorState {
    const state = this.cursors.get(cursor);
    if (!state) throw new ExtensionAcquisitionError("EXTENSION_CATALOG_CURSOR_INVALID");
    if (state.expiresAt <= this.now()) {
      this.cursors.delete(cursor);
      throw new ExtensionAcquisitionError("EXTENSION_CATALOG_CURSOR_EXPIRED");
    }
    if (state.providerId !== this.catalogSearchProvider.id || state.query !== query || state.inUse) {
      throw new ExtensionAcquisitionError("EXTENSION_CATALOG_CURSOR_INVALID");
    }
    return state;
  }

  private issueCursor(query: string, continuation: CatalogContinuation): string {
    this.ensureCursorCapacity();
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const cursor = randomBytes(24).toString("base64url");
      if (this.cursors.has(cursor)) continue;
      this.cursors.set(cursor, {
        providerId: this.catalogSearchProvider.id,
        query,
        continuation: { ...continuation },
        expiresAt: this.now() + this.cursorTtlMs,
        inUse: false,
      });
      return cursor;
    }
    throw new Error("Could not allocate an extension catalog cursor.");
  }

  private issueObservation(item: ExtensionCatalogItem): string {
    const now = this.now();
    for (const [id, observation] of this.observations) {
      if (observation.expiresAt <= now) this.observations.delete(id);
    }
    while (this.observations.size >= this.maxCursorEntries) {
      const oldest = this.observations.keys().next().value as string | undefined;
      if (!oldest) break;
      this.observations.delete(oldest);
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const observationId = randomBytes(24).toString("base64url");
      if (this.observations.has(observationId)) continue;
      this.observations.set(observationId, {
        observationId,
        storeId: item.storeId,
        providerId: item.catalogProviderId,
        observedAt: item.observedAt,
        name: item.name,
        expiresAt: now + this.cursorTtlMs,
      });
      return observationId;
    }
    throw new Error("Could not allocate an extension catalog observation.");
  }

  private ensureCursorCapacity(): void {
    if (this.cursors.size < this.maxCursorEntries) return;
    const now = this.now();
    for (const [cursor, state] of this.cursors) {
      if (state.expiresAt <= now && !state.inUse) this.cursors.delete(cursor);
    }
    while (this.cursors.size >= this.maxCursorEntries) {
      const oldest = [...this.cursors].find(([, state]) => !state.inUse)?.[0];
      if (!oldest) throw new Error("All extension catalog cursors are currently in use.");
      this.cursors.delete(oldest);
    }
  }

  private deleteCursors(providerId: ExtensionCatalogProviderId, query?: string): void {
    for (const [cursor, state] of this.cursors) {
      if (state.providerId === providerId && (query === undefined || state.query === query)) {
        this.cursors.delete(cursor);
      }
    }
  }

  private cursorsHasState(candidate: CursorState): boolean {
    for (const state of this.cursors.values()) {
      if (state === candidate) return true;
    }
    return false;
  }

  private recordHealth(
    capabilityId: ExtensionAcquisitionCapabilityId,
    status: ExtensionCapabilityHealth["status"],
    errorCode?: ExtensionAcquisitionErrorCode,
  ): void {
    this.health.set(capabilityId, {
      status,
      checkedAt: new Date(this.now()).toISOString(),
      ...(errorCode ? { errorCode } : {}),
    });
  }
}

function normalizeSearchRequest(request: ExtensionCatalogSearchRequest): ExtensionCatalogSearchRequest {
  if (!request || typeof request !== "object") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Search request must be an object.");
  }
  const query = normalizeExtensionCatalogQuery(request.query);
  if (request.cursor === undefined) return { query };
  if (!isValidExtensionAcquisitionCursor(request.cursor)) {
    throw new ExtensionAcquisitionError("EXTENSION_CATALOG_CURSOR_INVALID");
  }
  return { query, cursor: request.cursor };
}

function normalizeReferenceInput(request: ExtensionReferenceResolveRequest): string {
  if (!request || typeof request !== "object") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Resolution request must be an object.");
  }
  if (typeof request.input !== "string" || request.input.length > EXTENSION_REFERENCE_INPUT_MAX_LENGTH) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Extension reference must be a bounded string.");
  }
  return request.input;
}

function assertSearchAllowed(settings: AppSettings): void {
  if (
    settings.extensionAcquisition.crxsosoDisclosureVersionAccepted
    < EXTENSION_ACQUISITION_DISCLOSURE_VERSION
  ) {
    throw new ExtensionAcquisitionError("CATALOG_DISCLOSURE_REQUIRED");
  }
}

function normalizeProviderPage(value: CatalogSearchPage): NormalizedProviderPage {
  if (!isRecord(value) || !Array.isArray(value.items) || value.items.length > MAX_PROVIDER_PAGE_ITEMS) {
    throw new Error("Invalid normalized catalog page.");
  }
  if (
    !Number.isSafeInteger(value.excludedNonCanonicalCount)
    || value.excludedNonCanonicalCount < 0
    || value.excludedNonCanonicalCount > MAX_EXCLUDED_ITEM_COUNT
    || typeof value.hasMore !== "boolean"
  ) {
    throw new Error("Invalid normalized catalog page metadata.");
  }
  let continuation: CatalogContinuation | undefined;
  if (value.hasMore) {
    if (
      !isRecord(value.continuation)
      || !Number.isSafeInteger(value.continuation.page)
      || Number(value.continuation.page) < 2
      || Number(value.continuation.page) > MAX_PROVIDER_CONTINUATION_PAGE
      || typeof value.continuation.token !== "string"
      || !value.continuation.token
      || value.continuation.token.trim() !== value.continuation.token
      || value.continuation.token.length > MAX_PROVIDER_CONTINUATION_LENGTH
      || /[\u0000-\u001f\u007f]/.test(value.continuation.token)
    ) {
      throw new Error("Invalid normalized catalog continuation.");
    }
    continuation = {
      page: Number(value.continuation.page),
      token: value.continuation.token,
    };
  }

  const items: ExtensionCatalogItem[] = [];
  const seen = new Set<string>();
  let locallyExcluded = 0;
  for (const rawItem of value.items as unknown[]) {
    if (!isRecord(rawItem)) throw new Error("Invalid normalized catalog item.");
    if (!isCanonicalChromeExtensionId(rawItem.storeId)) {
      locallyExcluded += 1;
      continue;
    }
    const item = normalizeCatalogItem(rawItem, rawItem.storeId);
    if (seen.has(item.storeId)) continue;
    seen.add(item.storeId);
    items.push(item);
  }

  const excludedNonCanonicalCount = value.excludedNonCanonicalCount + locallyExcluded;
  if (!Number.isSafeInteger(excludedNonCanonicalCount) || excludedNonCanonicalCount > MAX_EXCLUDED_ITEM_COUNT) {
    throw new Error("Invalid normalized catalog exclusion count.");
  }
  return {
    items,
    excludedNonCanonicalCount,
    continuation,
    hasMore: value.hasMore,
  };
}

function normalizeCatalogItem(raw: Record<string, unknown>, storeId: string): ExtensionCatalogItem {
  if (raw.namespace !== "chrome-web-store" || raw.catalogProviderId !== "crxsoso") {
    throw new Error("Invalid normalized catalog identity.");
  }
  const storeUrl = chromeWebStoreListingUrl(storeId);
  if (raw.storeUrl !== storeUrl) throw new Error("Invalid normalized catalog listing URL.");
  const observedAt = isoTimestamp(raw.observedAt);
  const name = requiredBoundedString(raw.name, 512);
  const description = optionalBoundedString(raw.description, MAX_PROVIDER_DESCRIPTION_LENGTH);
  const category = optionalBoundedString(raw.category, 256);
  const rating = optionalFiniteNumber(raw.rating, 0, 5);
  const userCount = optionalSafeInteger(raw.userCount, 0);
  return {
    namespace: "chrome-web-store",
    storeId,
    storeUrl,
    catalogProviderId: "crxsoso",
    observedAt,
    name,
    ...(description ? { description } : {}),
    ...(category ? { category } : {}),
    ...(rating !== undefined ? { rating } : {}),
    ...(userCount !== undefined ? { userCount } : {}),
  };
}

function normalizeCatalogFailure(error: unknown): ExtensionAcquisitionError {
  if (error instanceof ExtensionAcquisitionError) return error;
  const code = isRecord(error) && typeof error.code === "string" ? error.code : undefined;
  if (code && CATALOG_FAILURE_CODES.has(code as ExtensionAcquisitionErrorCode)) {
    return new ExtensionAcquisitionError(code as ExtensionAcquisitionErrorCode);
  }
  if (isRecord(error) && error.name === "AbortError") {
    return new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
  }
  return new ExtensionAcquisitionError("EXTENSION_CATALOG_NETWORK");
}

function abortReason(signal: AbortSignal): ExtensionAcquisitionError {
  return signal.reason instanceof ExtensionAcquisitionError
    ? signal.reason
    : new ExtensionAcquisitionError("ACQUISITION_CANCELLED");
}

function boundedString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.length > maxLength) return undefined;
  const normalized = value.trim();
  return normalized
    && normalized.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(normalized)
    ? normalized
    : undefined;
}

function requiredBoundedString(value: unknown, maxLength: number): string {
  const normalized = boundedString(value, maxLength);
  if (!normalized) throw new Error("Invalid normalized catalog string.");
  return normalized;
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredBoundedString(value, maxLength);
}

function optionalFiniteNumber(value: unknown, minimum: number, maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error("Invalid normalized catalog number.");
  }
  return value;
}

function optionalSafeInteger(value: unknown, minimum: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error("Invalid normalized catalog integer.");
  }
  return Number(value);
}

function isoTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length > 64 || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    throw new Error("Invalid normalized catalog timestamp.");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("Invalid normalized catalog timestamp.");
  return new Date(timestamp).toISOString();
}

function positiveSafeInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const CATALOG_FAILURE_CODES = new Set<ExtensionAcquisitionErrorCode>([
  "EXTENSION_CATALOG_RATE_LIMITED",
  "EXTENSION_CATALOG_TIMEOUT",
  "EXTENSION_CATALOG_NETWORK",
  "EXTENSION_CATALOG_HTTP_ERROR",
  "EXTENSION_CATALOG_RESPONSE_TOO_LARGE",
  "EXTENSION_CATALOG_REDIRECT_REJECTED",
  "EXTENSION_CATALOG_SCHEMA_CHANGED",
  "ACQUISITION_CANCELLED",
]);

function publicErrorStatus(code: ExtensionAcquisitionErrorCode): number {
  switch (code) {
    case "ACQUISITION_INPUT_EMPTY":
    case "ACQUISITION_INPUT_UNSUPPORTED":
    case "EXTENSION_CATALOG_CURSOR_INVALID":
    case "EXTENSION_ARCHIVE_INVALID":
    case "EXTENSION_ARCHIVE_UNSAFE_PATH":
    case "EXTENSION_ARCHIVE_RESOURCE_LIMIT":
    case "EXTENSION_MANIFEST_INVALID":
      return 400;
    case "CATALOG_DISCLOSURE_REQUIRED":
      return 428;
    case "CATALOG_PROVIDER_DISABLED":
    case "ARTIFACT_PROVIDER_DISABLED":
    case "ACQUISITION_SESSION_NOT_READY":
    case "ACQUISITION_SESSION_CONSUMED":
    case "ACQUISITION_CONFLICT_TARGET_INVALID":
    case "ACQUISITION_IDENTITY_CONFLICT":
    case "ACQUISITION_PERMISSION_INCREASE":
    case "ACQUISITION_UPDATE_PROVIDER_INVALID":
      return 409;
    case "ACQUISITION_RECONCILIATION_REQUIRED":
      return 503;
    case "EXTENSION_CATALOG_CURSOR_EXPIRED":
    case "ACQUISITION_EXPIRED":
    case "ACQUISITION_SESSION_NOT_FOUND":
      return 410;
    case "EXTENSION_CATALOG_RATE_LIMITED":
      return 429;
    case "ACQUISITION_CANCELLED":
      return 499;
    case "ARTIFACT_TOO_LARGE":
    case "ACQUISITION_TEMP_BUDGET_EXCEEDED":
      return 413;
    case "ACQUISITION_COMMIT_FAILED":
      return 500;
    case "EXTENSION_CATALOG_TIMEOUT":
    case "ARTIFACT_TIMEOUT":
      return 504;
    default:
      return 502;
  }
}

function publicErrorMessage(code: ExtensionAcquisitionErrorCode): string {
  switch (code) {
    case "ACQUISITION_INPUT_EMPTY":
      return "Enter an extension search keyword, supported store URL, or canonical extension id.";
    case "ACQUISITION_INPUT_UNSUPPORTED":
      return "The extension acquisition input is unsupported.";
    case "CATALOG_PROVIDER_DISABLED":
      return "CRX搜搜 catalog search is disabled in extension acquisition settings.";
    case "CATALOG_DISCLOSURE_REQUIRED":
      return "Accept the current CRX搜搜 third-party search disclosure before searching.";
    case "EXTENSION_CATALOG_RATE_LIMITED":
      return "The catalog provider is rate limiting requests.";
    case "EXTENSION_CATALOG_TIMEOUT":
      return "The catalog provider timed out.";
    case "EXTENSION_CATALOG_NETWORK":
      return "The catalog provider could not be reached.";
    case "EXTENSION_CATALOG_HTTP_ERROR":
      return "The catalog provider returned an HTTP error.";
    case "EXTENSION_CATALOG_RESPONSE_TOO_LARGE":
      return "The catalog provider response exceeded the size limit.";
    case "EXTENSION_CATALOG_REDIRECT_REJECTED":
      return "The catalog provider returned an unsupported redirect.";
    case "EXTENSION_CATALOG_SCHEMA_CHANGED":
      return "The catalog provider response format is no longer supported.";
    case "EXTENSION_CATALOG_CURSOR_INVALID":
      return "The catalog continuation cursor is invalid for this search.";
    case "EXTENSION_CATALOG_CURSOR_EXPIRED":
      return "The catalog continuation cursor has expired. Start the search again.";
    case "ARTIFACT_PROVIDER_DISABLED":
      return "The selected package provider is disabled.";
    case "ARTIFACT_PROVIDER_HTTP_ERROR":
      return "The package provider returned an HTTP error.";
    case "ARTIFACT_UNAVAILABLE":
      return "The selected package provider has no current package.";
    case "ARTIFACT_TIMEOUT":
      return "The package provider timed out.";
    case "ARTIFACT_NETWORK":
      return "The package provider could not be reached.";
    case "ARTIFACT_REDIRECT_LOOP":
    case "ARTIFACT_REDIRECT_REJECTED":
      return "The package provider returned an unsupported redirect.";
    case "ARTIFACT_TOO_LARGE":
      return "The package exceeded the size limit.";
    case "BROWSER_CORE_VERSION_REQUIRED":
      return "A selected CloakBrowser Chromium version is required for this package provider.";
    case "STORE_CRX3_REQUIRED":
    case "CRX_DEVELOPER_PROOF_INVALID":
    case "CRX_ID_MISMATCH":
    case "CWS_PUBLISHER_PROOF_REQUIRED":
      return "The package did not satisfy remote store verification requirements.";
    case "EXTENSION_ARCHIVE_INVALID":
      return "The extension package archive is invalid.";
    case "EXTENSION_ARCHIVE_UNSAFE_PATH":
      return "The extension package contains an unsafe path or entry type.";
    case "EXTENSION_ARCHIVE_RESOURCE_LIMIT":
      return "The extension package exceeds safe extraction limits.";
    case "EXTENSION_MANIFEST_INVALID":
      return "The extension package Manifest is missing or invalid.";
    case "ACQUISITION_TEMP_BUDGET_EXCEEDED":
      return "Extension acquisition temporary storage is full.";
    case "ACQUISITION_SESSION_NOT_FOUND":
      return "The extension acquisition session no longer exists.";
    case "ACQUISITION_SESSION_NOT_READY":
      return "The extension acquisition session is not ready to confirm.";
    case "ACQUISITION_SESSION_CONSUMED":
      return "The extension acquisition session was already consumed.";
    case "ACQUISITION_CONFLICT_TARGET_INVALID":
      return "The selected extension conflict target is no longer eligible.";
    case "ACQUISITION_IDENTITY_CONFLICT":
      return "The selected extension conflicts with a different verified developer identity.";
    case "ACQUISITION_PERMISSION_INCREASE":
      return "The extension update adds permissions and requires a separate review.";
    case "ACQUISITION_UPDATE_PROVIDER_INVALID":
      return "The extension is not eligible for the selected update provider.";
    case "ACQUISITION_RECONCILIATION_REQUIRED":
      return "The extension commit needs startup reconciliation before it can be retried.";
    case "ACQUISITION_COMMIT_FAILED":
      return "The verified extension could not be committed safely.";
    case "ACQUISITION_CANCELLED":
      return "The extension acquisition operation was cancelled.";
    case "ACQUISITION_EXPIRED":
      return "The extension acquisition operation has expired.";
  }
}
