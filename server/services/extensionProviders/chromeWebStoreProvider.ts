import fs from "node:fs/promises";
import {
  isCanonicalChromeExtensionId,
  type ExtensionArtifactOffer,
} from "../../../src/shared/extensionAcquisition";
import {
  ExtensionProviderError,
  PROVIDER_HTTP_LIMITS,
  ProviderHttpClient,
} from "../providerHttpClient";
import type {
  ArtifactProvider,
  ArtifactResolveInput,
  BrowserCoreVersionReader,
  ProviderHttpTransport,
  ResolvedArtifact,
} from "./types";

const GOOGLE_UPDATE_ENDPOINT = "https://clients2.google.com/service/update2/crx";
const GOOGLE_UPDATE_HOST = "clients2.google.com";
const GOOGLE_CRX_BLOB_HOST = "clients2.googleusercontent.com";

export interface ChromeWebStoreProviderOptions {
  readBrowserCoreVersion: BrowserCoreVersionReader;
  httpClient?: ProviderHttpTransport;
}

export class ChromeWebStoreProvider implements ArtifactProvider {
  readonly id = "chrome-web-store" as const;

  private readonly httpClient: ProviderHttpTransport;

  private readonly readBrowserCoreVersion: BrowserCoreVersionReader;

  constructor(options: ChromeWebStoreProviderOptions) {
    this.httpClient = options.httpClient ?? new ProviderHttpClient();
    this.readBrowserCoreVersion = options.readBrowserCoreVersion;
  }

  offer(storeId: string): ExtensionArtifactOffer {
    assertCanonicalStoreId(storeId);
    return {
      namespace: "chrome-web-store",
      storeId,
      artifactProviderId: this.id,
      format: "crx3",
      providerLabel: "Chrome Web Store",
    };
  }

  async resolveCurrent(input: ArtifactResolveInput, signal: AbortSignal): Promise<ResolvedArtifact> {
    assertCanonicalStoreId(input.storeId);
    const browserVersion = await this.getBrowserCoreVersion();
    const url = buildChromeWebStoreCrxUrl(input.storeId, browserVersion);
    const download = await this.httpClient.downloadToFile({
      url,
      init: {
        method: "GET",
        headers: { accept: "application/x-chrome-extension,application/octet-stream" },
      },
      kind: "artifact",
      hostPolicy: googleArtifactHostPolicy,
      signal,
      maxBytes: PROVIDER_HTTP_LIMITS.artifactBytes,
      headerTimeoutMs: PROVIDER_HTTP_LIMITS.artifactHeaderTimeoutMs,
      idleTimeoutMs: PROVIDER_HTTP_LIMITS.artifactIdleTimeoutMs,
      totalTimeoutMs: PROVIDER_HTTP_LIMITS.artifactTotalTimeoutMs,
      maxRedirects: PROVIDER_HTTP_LIMITS.redirectHops,
    }, input.destinationPath);

    if (download.size === 0) {
      await fs.rm(download.path, { force: true }).catch(() => undefined);
      throw new ExtensionProviderError(
        "ARTIFACT_UNAVAILABLE",
        "Chrome Web Store returned no current package for this extension.",
        404,
      );
    }

    return {
      namespace: "chrome-web-store",
      storeId: input.storeId,
      artifactProviderId: this.id,
      format: "crx3",
      download,
    };
  }

  private async getBrowserCoreVersion(): Promise<string> {
    let value: string | undefined;
    try {
      value = await this.readBrowserCoreVersion();
    } catch {
      throw browserCoreVersionRequired();
    }
    return normalizeChromeCoreVersion(value);
  }
}

/**
 * CloakBrowser versions may include a fifth packaging component. Google's
 * update endpoint expects the first four Chromium version components.
 */
export function normalizeChromeCoreVersion(value: unknown): string {
  if (typeof value !== "string") throw browserCoreVersionRequired();
  const normalized = value.trim();
  if (normalized.length > 80 || !/^\d+(?:\.\d+){3,}$/.test(normalized)) {
    throw browserCoreVersionRequired();
  }
  const components = normalized.split(".");
  if (components.some((component) => component.length > 10 || !Number.isSafeInteger(Number(component)))) {
    throw browserCoreVersionRequired();
  }
  return components.slice(0, 4).join(".");
}

export function buildChromeWebStoreCrxUrl(storeId: string, browserCoreVersion: string): string {
  assertCanonicalStoreId(storeId);
  const version = normalizeChromeCoreVersion(browserCoreVersion);
  const url = new URL(GOOGLE_UPDATE_ENDPOINT);
  url.searchParams.set("response", "redirect");
  url.searchParams.set("prodversion", version);
  url.searchParams.set("acceptformat", "crx3");
  url.searchParams.set("x", `id=${storeId}&installsource=ondemand&uc`);
  return url.toString();
}

export function googleArtifactHostPolicy(hostname: string, hop: number): boolean {
  return hop === 0 ? hostname === GOOGLE_UPDATE_HOST : hostname === GOOGLE_CRX_BLOB_HOST;
}

function assertCanonicalStoreId(storeId: string): void {
  if (!isCanonicalChromeExtensionId(storeId)) {
    throw new ExtensionProviderError(
      "ACQUISITION_INPUT_UNSUPPORTED",
      "Chrome Web Store acquisition requires a canonical extension id.",
      400,
    );
  }
}

function browserCoreVersionRequired(): ExtensionProviderError {
  return new ExtensionProviderError(
    "BROWSER_CORE_VERSION_REQUIRED",
    "A compatible Chromium core version is required for Chrome Web Store acquisition.",
    409,
  );
}
