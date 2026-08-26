import {
  isCanonicalChromeExtensionId,
  type ExtensionAcquisitionSettingsLike,
  type ExtensionArtifactOffer,
  type ExtensionArtifactProviderId,
  type ExtensionCatalogProviderId,
} from "../../../src/shared/extensionAcquisition";
import { ExtensionProviderError } from "../providerHttpClient";
import {
  ChromeWebStoreProvider,
  type ChromeWebStoreProviderOptions,
} from "./chromeWebStoreProvider";
import { CrxsosoProvider, type CrxsosoProviderOptions } from "./crxsosoProvider";
import type { ArtifactProvider, CatalogSearchProvider } from "./types";

export interface BuiltInExtensionProviders {
  crxsosoSearch: CatalogSearchProvider;
  googleArtifact: ArtifactProvider;
  crxsosoArtifact: ArtifactProvider;
}

export class ExtensionProviderRegistry {
  private readonly providers: BuiltInExtensionProviders;

  constructor(providers: BuiltInExtensionProviders) {
    if (
      providers.crxsosoSearch.id !== "crxsoso"
      || providers.googleArtifact.id !== "chrome-web-store"
      || providers.crxsosoArtifact.id !== "crxsoso"
    ) {
      throw new TypeError("Extension provider registry accepts only the three reviewed built-in capabilities.");
    }
    this.providers = Object.freeze({ ...providers });
  }

  catalog(providerId: ExtensionCatalogProviderId): CatalogSearchProvider {
    if (providerId === "crxsoso") return this.providers.crxsosoSearch;
    return assertNever(providerId);
  }

  artifact(providerId: ExtensionArtifactProviderId): ArtifactProvider {
    switch (providerId) {
      case "chrome-web-store":
        return this.providers.googleArtifact;
      case "crxsoso":
        return this.providers.crxsosoArtifact;
      default:
        return assertNever(providerId);
    }
  }

  artifactOffers(storeId: string, settings: ExtensionAcquisitionSettingsLike): ExtensionArtifactOffer[] {
    if (!isCanonicalChromeExtensionId(storeId)) {
      throw new ExtensionProviderError(
        "ACQUISITION_INPUT_UNSUPPORTED",
        "Artifact offers require a canonical Chrome extension id.",
        400,
      );
    }
    const offers: ExtensionArtifactOffer[] = [];
    if (settings.googleArtifactEnabled) offers.push(this.providers.googleArtifact.offer(storeId));
    if (settings.crxsosoArtifactEnabled) offers.push(this.providers.crxsosoArtifact.offer(storeId));
    return offers;
  }
}

export interface CreateExtensionProviderRegistryOptions {
  chromeWebStore: ChromeWebStoreProviderOptions;
  crxsoso?: CrxsosoProviderOptions;
}

export function createExtensionProviderRegistry(
  options: CreateExtensionProviderRegistryOptions,
): ExtensionProviderRegistry {
  const crxsoso = new CrxsosoProvider(options.crxsoso);
  return new ExtensionProviderRegistry({
    crxsosoSearch: crxsoso,
    googleArtifact: new ChromeWebStoreProvider(options.chromeWebStore),
    crxsosoArtifact: crxsoso,
  });
}

function assertNever(value: never): never {
  throw new TypeError(`Unsupported built-in extension provider: ${String(value)}`);
}
