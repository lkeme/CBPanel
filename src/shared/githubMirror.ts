import type { GithubMirrorProviderId } from "./settings";

const CLOAKBROWSER_OFFICIAL_BASE_URL = "https://cloakbrowser.dev";
const CLOAKBROWSER_GITHUB_RELEASE_BASE_URL = "https://github.com/CloakHQ/cloakbrowser/releases/download";
export const CLOAKBROWSER_GEOIP_DB_URL = "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb";

export type GithubMirrorRewriteKind = "cloakbrowser-core" | "cloakbrowser-geoip";

export interface GithubMirrorProbeRequest {
  providerId?: GithubMirrorProviderId | "all";
  customGithubMirrorPrefix?: string;
}

export interface GithubMirrorProbeResult {
  providerId: Exclude<GithubMirrorProviderId, "off">;
  name: string;
  prefix: string;
  ok: boolean;
  latencyMs?: number;
  status?: number;
  checkedAt: string;
  error?: string;
}

export interface GithubMirrorProbeResponse {
  results: GithubMirrorProbeResult[];
  recommendedProviderId?: Exclude<GithubMirrorProviderId, "off">;
  targetVersion: string;
  checkedAt: string;
}

export interface GithubMirrorRewriteResult {
  originalUrl: string;
  githubUrl: string;
  rewrittenUrl: string;
  kind: GithubMirrorRewriteKind;
}

export function rewriteGithubDownloadUrl(inputUrl: string, mirrorPrefix: string | undefined): GithubMirrorRewriteResult | undefined {
  const prefix = normalizeMirrorPrefix(mirrorPrefix);
  if (!prefix) return undefined;
  const githubUrl = normalizeSupportedGithubDownloadUrl(inputUrl);
  if (!githubUrl) return undefined;
  return {
    originalUrl: inputUrl,
    githubUrl: githubUrl.url,
    rewrittenUrl: `${prefix}${githubUrl.url}`,
    kind: githubUrl.kind,
  };
}

export function githubMirrorProbeTargetUrl(version: string): string {
  return `${CLOAKBROWSER_OFFICIAL_BASE_URL}/chromium-v${version}/SHA256SUMS`;
}

export function githubMirrorProbeSignatureTargetUrl(version: string): string {
  return `${CLOAKBROWSER_OFFICIAL_BASE_URL}/chromium-v${version}/SHA256SUMS.sig`;
}

export function selectRecommendedGithubMirror(
  results: readonly GithubMirrorProbeResult[],
): Exclude<GithubMirrorProviderId, "off"> | undefined {
  return results
    .filter((result) => result.ok && typeof result.latencyMs === "number")
    .sort((left, right) => (left.latencyMs ?? Number.POSITIVE_INFINITY) - (right.latencyMs ?? Number.POSITIVE_INFINITY))[0]
    ?.providerId;
}

export function normalizeSupportedGithubDownloadUrl(inputUrl: string): { url: string; kind: GithubMirrorRewriteKind } | undefined {
  let url: URL;
  try {
    url = new URL(inputUrl);
  } catch {
    return undefined;
  }

  if (url.origin === CLOAKBROWSER_OFFICIAL_BASE_URL) {
    const match = url.pathname.match(/^\/(chromium-v[^/]+)\/([^/?#]+)$/);
    if (!match) return undefined;
    const [, tag, asset] = match;
    if (!isSupportedCloakBrowserReleaseAsset(asset)) return undefined;
    return {
      url: `${CLOAKBROWSER_GITHUB_RELEASE_BASE_URL}/${tag}/${asset}`,
      kind: "cloakbrowser-core",
    };
  }

  if (url.origin === "https://github.com") {
    if (url.pathname.match(/^\/CloakHQ\/cloakbrowser\/releases\/download\/chromium-v[^/]+\/([^/?#]+)$/)) {
      const asset = url.pathname.split("/").at(-1);
      if (!asset || !isSupportedCloakBrowserReleaseAsset(asset)) return undefined;
      return {
        url: url.toString(),
        kind: "cloakbrowser-core",
      };
    }

    if (url.toString() === CLOAKBROWSER_GEOIP_DB_URL) {
      return {
        url: CLOAKBROWSER_GEOIP_DB_URL,
        kind: "cloakbrowser-geoip",
      };
    }
  }

  return undefined;
}

function isSupportedCloakBrowserReleaseAsset(asset: string): boolean {
  return asset === "SHA256SUMS"
    || asset === "SHA256SUMS.sig"
    || /^cloakbrowser-[A-Za-z0-9_-]+\.(zip|tar\.gz)$/.test(asset);
}

function normalizeMirrorPrefix(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return `${url.toString().replace(/\/+$/, "")}/`;
  } catch {
    return undefined;
  }
}
