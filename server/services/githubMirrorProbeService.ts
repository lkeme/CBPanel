import {
  CLOAKBROWSER_GEOIP_DB_URL,
  XRAY_CORE_MIRROR_PROBE_URL,
  rewriteGithubDownloadUrl,
  selectRecommendedGithubMirror,
  type GithubMirrorProbeRequest,
  type GithubMirrorProbeResponse,
  type GithubMirrorProbeResult,
} from "../../src/shared/githubMirror";
import {
  BUILTIN_GITHUB_MIRROR_PROVIDERS,
  type AppSettings,
  type GithubMirrorProviderId,
  normalizeNetworkTraceSettings,
} from "../../src/shared/settings";

type GithubMirrorProbeTarget = {
  providerId: Exclude<GithubMirrorProviderId, "off">;
  name: string;
  prefix: string;
};

export type GithubMirrorPrefixResolution = {
  providerId: Exclude<GithubMirrorProviderId, "off">;
  name: string;
  prefix: string;
  latencyMs?: number;
};

export type GithubMirrorProbeServiceOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 8_000;
const PROBE_RESULT_TTL_MS = 5 * 60 * 1000;

export class GithubMirrorProbeService {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly probeTtlMs: number;
  private readonly probeCache = new Map<string, GithubMirrorProbeResponse & { checkedAtMs: number }>();
  private lastRecommended?: GithubMirrorPrefixResolution & { checkedAtMs: number };

  constructor(options: GithubMirrorProbeServiceOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.probeTtlMs = PROBE_RESULT_TTL_MS;
  }

  async check(
    settings: AppSettings,
    request: GithubMirrorProbeRequest = {},
  ): Promise<GithubMirrorProbeResponse> {
    const cacheKey = probeCacheKey(settings, request);
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAtMs < this.probeTtlMs) {
      return withoutCacheStamp(cached);
    }

    const checkedAt = new Date().toISOString();
    const targetUrl = CLOAKBROWSER_GEOIP_DB_URL;
    const targets = mirrorProbeTargets(settings, request);
    const results = await Promise.all(targets.map((target) => this.checkOne(target, checkedAt)));
    const recommendedProviderId = selectRecommendedGithubMirror(results);
    const recommended = results.find((result) => result.providerId === recommendedProviderId);
    if (recommended?.ok) {
      this.lastRecommended = {
        providerId: recommended.providerId,
        name: recommended.name,
        prefix: recommended.prefix,
        latencyMs: recommended.latencyMs,
        checkedAtMs: Date.now(),
      };
    }
    const response = {
      results,
      recommendedProviderId,
      targetUrl,
      checkedAt,
    };
    this.probeCache.set(cacheKey, {
      ...response,
      checkedAtMs: Date.now(),
    });
    return response;
  }

  async resolvePrefix(settings: AppSettings): Promise<GithubMirrorPrefixResolution | undefined> {
    const trace = normalizeNetworkTraceSettings(settings.networkTrace);
    if (trace.githubMirrorProviderId === "off") return undefined;
    if (trace.githubMirrorProviderId === "custom") {
      return trace.customGithubMirrorPrefix
        ? { providerId: "custom", name: "Custom", prefix: trace.customGithubMirrorPrefix }
        : undefined;
    }
    if (trace.githubMirrorProviderId !== "auto-best") {
      const provider = BUILTIN_GITHUB_MIRROR_PROVIDERS.find((item) => item.id === trace.githubMirrorProviderId);
      return provider ? { providerId: provider.id, name: provider.name, prefix: provider.prefix } : undefined;
    }

    if (this.lastRecommended && Date.now() - this.lastRecommended.checkedAtMs < this.probeTtlMs) {
      return this.lastRecommended;
    }

    const response = await this.check(settings, {
      providerId: "all",
      customGithubMirrorPrefix: trace.customGithubMirrorPrefix,
    });
    const recommended = response.results.find((result) => result.providerId === response.recommendedProviderId);
    return recommended?.ok
      ? {
          providerId: recommended.providerId,
          name: recommended.name,
          prefix: recommended.prefix,
          latencyMs: recommended.latencyMs,
        }
      : undefined;
  }

  private async checkOne(
    target: GithubMirrorProbeTarget,
    checkedAt: string,
  ): Promise<GithubMirrorProbeResult> {
    const startedAt = Date.now();
    try {
      // Two assets, because a mirror can serve one GitHub path and refuse another: `ghfast.top` happily
      // proxies the GeoIP raw file while answering 403 for every release asset. The Xray sidecar is a
      // few hundred bytes, so checking both still transfers nothing.
      const geoip = await this.headRewrite(rewriteGithubDownloadUrl(CLOAKBROWSER_GEOIP_DB_URL, target.prefix));
      const xray = await this.headRewrite(rewriteGithubDownloadUrl(XRAY_CORE_MIRROR_PROBE_URL, target.prefix));
      if (!geoip.ok || !xray.ok) {
        return {
          ...target,
          ok: false,
          latencyMs: Date.now() - startedAt,
          status: geoip.status ?? xray.status,
          checkedAt,
          error: !geoip.ok ? geoip.error : xray.error,
        };
      }
      return {
        ...target,
        ok: true,
        latencyMs: Date.now() - startedAt,
        status: geoip.status,
        checkedAt,
      };
    } catch (error) {
      return {
        ...target,
        ok: false,
        latencyMs: Date.now() - startedAt,
        checkedAt,
        error: (error as Error).message || "Mirror check failed.",
      };
    }
  }

  /** HEAD without a body; falls back to a one-byte range read for hosts that reject HEAD outright. */
  private async headRewrite(
    rewrite: ReturnType<typeof rewriteGithubDownloadUrl>,
  ): Promise<{ ok: boolean; status?: number; error?: string }> {
    if (!rewrite) return { ok: false, error: "Mirror prefix cannot rewrite the probed GitHub URL." };
    try {
      const response = await this.fetchImpl(rewrite.rewrittenUrl, {
        method: "HEAD",
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      await response.body?.cancel();
      const contentType = response.headers.get("content-type") ?? "";
      const length = response.headers.get("content-length");
      const isBinary = /^(?:application\/(?:octet-stream|x-binary|vnd\.maxmind\.maxmind-db)|binary\/octet-stream|text\/plain)(?:;|$)/i.test(contentType)
        && (length === null || (Number.isFinite(Number(length)) && Number(length) > 0));
      if (response.ok && isBinary) return { ok: true, status: response.status };
      if (response.ok) return { ok: false, status: response.status, error: "Response headers do not identify the probed asset." };
      if (!HEAD_REJECTED_STATUSES.has(response.status)) {
        return { ok: false, status: response.status, error: `Mirror answered HTTP ${response.status}.` };
      }
    } catch (error) {
      const message = (error as Error).message || "";
      if (!/method|HEAD|not allowed/i.test(message)) throw error;
    }

    const range = await this.fetchImpl(rewrite.rewrittenUrl, {
      headers: { range: "bytes=0-0" },
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const bytes = await range.arrayBuffer().catch(() => new ArrayBuffer(0));
    return range.ok && bytes.byteLength > 0
      ? { ok: true, status: range.status }
      : { ok: false, status: range.status, error: `Mirror answered HTTP ${range.status} to a range read.` };
  }

}

/** Hosts that answer a probe with "this verb is not supported" rather than "this asset is absent". */
const HEAD_REJECTED_STATUSES = new Set([403, 405, 501]);

export function mirrorProbeTargets(
  settings: AppSettings,
  request: GithubMirrorProbeRequest = {},
): GithubMirrorProbeTarget[] {
  const trace = normalizeNetworkTraceSettings({
    ...settings.networkTrace,
    customGithubMirrorPrefix:
      request.customGithubMirrorPrefix ?? settings.networkTrace.customGithubMirrorPrefix,
  });
  const providerId = request.providerId ?? trace.githubMirrorProviderId;
  const customTarget = trace.customGithubMirrorPrefix
    ? {
        providerId: "custom" as const,
        name: "Custom",
        prefix: trace.customGithubMirrorPrefix,
      }
    : undefined;

  if (providerId === "all" || providerId === "auto-best") {
    return [
      ...BUILTIN_GITHUB_MIRROR_PROVIDERS.map((provider) => ({
        providerId: provider.id,
        name: provider.name,
        prefix: provider.prefix,
      })),
      ...(customTarget ? [customTarget] : []),
    ];
  }

  if (providerId === "off") return [];
  if (providerId === "custom") return customTarget ? [customTarget] : [];

  const provider = BUILTIN_GITHUB_MIRROR_PROVIDERS.find((item) => item.id === providerId);
  return provider ? [{ providerId: provider.id, name: provider.name, prefix: provider.prefix }] : [];
}

function probeCacheKey(settings: AppSettings, request: GithubMirrorProbeRequest): string {
  const trace = normalizeNetworkTraceSettings({
    ...settings.networkTrace,
    customGithubMirrorPrefix:
      request.customGithubMirrorPrefix ?? settings.networkTrace.customGithubMirrorPrefix,
  });
  return JSON.stringify({
    providerId: request.providerId ?? trace.githubMirrorProviderId,
    customGithubMirrorPrefix: trace.customGithubMirrorPrefix,
  });
}

function withoutCacheStamp(response: GithubMirrorProbeResponse & { checkedAtMs: number }): GithubMirrorProbeResponse {
  const { checkedAtMs: _checkedAtMs, ...publicResponse } = response;
  return publicResponse;
}
