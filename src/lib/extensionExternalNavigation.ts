import { invoke, isTauri } from "@tauri-apps/api/core";

import {
  chromeWebStoreListingUrl,
  isCanonicalChromeExtensionId,
  type ExtensionArtifactProviderId,
} from "../shared/extensionAcquisition";

/**
 * The only values that may influence an external extension-listing URL.
 *
 * Provider URLs returned by a catalog are deliberately not accepted here.  A
 * listing is always rebuilt from the canonical store id and the currently
 * selected artifact channel so an untrusted response cannot redirect the
 * desktop shell (or the browser tab) to an arbitrary authority.
 */
export type ExtensionListingInput = {
  storeId: string;
  artifactProviderId: ExtensionArtifactProviderId;
};

const LISTING_ERROR = "Extension listing requires a canonical extension id and a supported provider.";

/** Build the provider-specific public listing URL from a canonical id. */
export function extensionListingUrl({ storeId, artifactProviderId }: ExtensionListingInput): string {
  if (!isCanonicalChromeExtensionId(storeId)) {
    throw new Error(LISTING_ERROR);
  }

  switch (artifactProviderId) {
    case "chrome-web-store":
      return chromeWebStoreListingUrl(storeId);
    case "crxsoso":
      return `https://www.crxsoso.com/webstore/detail/${storeId}`;
    default:
      // Keep this runtime guard even though the TypeScript type is closed: the
      // value can still originate at a JSON/API boundary or an older bundle.
      throw new Error(LISTING_ERROR);
  }
}

/**
 * Open a listing in the user's browser.
 *
 * Web builds use a protected new tab.  Tauri builds pass only the canonical id
 * and provider to a restricted Rust command; Rust reconstructs and validates
 * the URL before handing it to the system browser.
 */
export async function openExtensionListing(input: ExtensionListingInput): Promise<void> {
  // Snapshot the two boundary values once.  Besides keeping the URL and IPC
  // payload in lockstep, this avoids invoking user-supplied accessors twice if
  // a caller passes a deserialized/proxied object.
  const { artifactProviderId, storeId } = input;
  const url = extensionListingUrl({ artifactProviderId, storeId });
  if (isTauri()) {
    await invoke("cbpanel_open_extension_listing", {
      providerId: artifactProviderId,
      storeId,
    });
    return;
  }

  // With `noopener`/`noreferrer`, some browsers deliberately return `null`
  // even when the new tab opened.  Do not misreport that privacy-preserving
  // behavior as a popup failure.
  window.open(url, "_blank", "noopener,noreferrer");
}
