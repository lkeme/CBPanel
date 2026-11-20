import type { GithubMirrorProviderId } from "./settings";

const CLOAKBROWSER_OFFICIAL_BASE_URL = "https://cloakbrowser.dev";
const CLOAKBROWSER_GITHUB_RELEASE_BASE_URL = "https://github.com/CloakHQ/cloakbrowser/releases/download";
export const CLOAKBROWSER_GEOIP_DB_URL = "https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb";
export const XRAY_CORE_GITHUB_RELEASE_BASE_URL = "https://github.com/XTLS/Xray-core/releases/download";

/**
 * The cheapest Xray asset that still proves a mirror serves release archives: the checksum sidecar
 * the installer already downloads alongside the archive. Probing with it keeps mirror checks at one
 * small request instead of a multi-megabyte archive transfer, and `latest/download` keeps the probe
 * valid across releases.
 */
export const XRAY_CORE_MIRROR_PROBE_URL = "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-windows-64.zip.dgst";

export type GithubMirrorRewriteKind =
  | "cloakbrowser-pro-manifest"
  | "cloakbrowser-geoip"
  | "xray-core";

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
  targetUrl: string;
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
    // The archive itself carries a license token, so it never appears here: since the official core
    // moved to a license-gated download URL, the only public GitHub content left on this origin is the
    // Pro checksum manifest and its detached signature.
    const proManifest = url.pathname.match(/^\/releases\/pro\/(chromium-v[^/]+)\/(SHA256SUMS(?:\.sig)?)$/);
    if (!proManifest) return undefined;
    const [, tag, asset] = proManifest;
    return {
      url: `${CLOAKBROWSER_GITHUB_RELEASE_BASE_URL}/${tag}-pro/${asset}`,
      kind: "cloakbrowser-pro-manifest",
    };
  }

  if (url.origin === "https://github.com") {
    if (url.pathname.match(/^\/CloakHQ\/cloakbrowser\/releases\/download\/chromium-v[^/]+-pro\/SHA256SUMS(?:\.sig)?$/)) {
      return {
        url: url.toString(),
        kind: "cloakbrowser-pro-manifest",
      };
    }

    if (url.toString() === CLOAKBROWSER_GEOIP_DB_URL) {
      return {
        url: CLOAKBROWSER_GEOIP_DB_URL,
        kind: "cloakbrowser-geoip",
      };
    }

    // The Xray engine's release archives are the one other GitHub download the panel performs.
    // `latest/download` is the same asset as a versioned tag and is what mirror probing uses.
    if (url.pathname.match(/^\/XTLS\/Xray-core\/releases\/(?:download\/v[^/]+|latest\/download)\/Xray-[A-Za-z0-9._-]+\.zip(?:\.dgst)?$/)) {
      return {
        url: url.toString(),
        kind: "xray-core",
      };
    }
  }

  return undefined;
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
