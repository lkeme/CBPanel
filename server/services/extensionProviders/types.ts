import type {
  ExtensionArtifactOffer,
  ExtensionArtifactProviderId,
  ExtensionCatalogItem,
  ExtensionCatalogProviderId,
  ExtensionStoreNamespace,
} from "../../../src/shared/extensionAcquisition";
import type {
  ProviderDownloadResult,
  ProviderHttpClient,
} from "../providerHttpClient";

/** Raw provider cursors stay server-side and are wrapped by the acquisition service. */
export interface CatalogContinuation {
  page: number;
  token: string;
}

export interface CatalogSearchInput {
  query: string;
  continuation?: CatalogContinuation;
}

export interface CatalogSearchPage {
  items: ExtensionCatalogItem[];
  excludedNonCanonicalCount: number;
  continuation?: CatalogContinuation;
  hasMore: boolean;
}

export interface CatalogSearchProvider {
  readonly id: ExtensionCatalogProviderId;
  search(input: CatalogSearchInput, signal: AbortSignal): Promise<CatalogSearchPage>;
}

export interface CatalogDetailProvider {
  detail(storeId: string, signal: AbortSignal): Promise<ExtensionCatalogItem>;
}

export interface ArtifactResolveInput {
  storeId: string;
  destinationPath: string;
}

/**
 * Server-only result consumed by preflight. Provider URLs and signed tokens are
 * deliberately absent; callers receive only the bounded local artifact facts.
 */
export interface ResolvedArtifact {
  namespace: ExtensionStoreNamespace;
  storeId: string;
  artifactProviderId: ExtensionArtifactProviderId;
  format: "crx3";
  download: ProviderDownloadResult;
}

export interface ArtifactProvider {
  readonly id: ExtensionArtifactProviderId;
  offer(storeId: string): ExtensionArtifactOffer;
  resolveCurrent(input: ArtifactResolveInput, signal: AbortSignal): Promise<ResolvedArtifact>;
}

export type ProviderHttpTransport = Pick<ProviderHttpClient, "readJson" | "downloadToFile">;

export type ProviderClock = () => Date;

export type BrowserCoreVersionReader = () => string | undefined | Promise<string | undefined>;
