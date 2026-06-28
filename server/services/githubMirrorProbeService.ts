import {
  githubMirrorProbeSignatureTargetUrl,
  githubMirrorProbeTargetUrl,
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
    version: string,
    request: GithubMirrorProbeRequest = {},
  ): Promise<GithubMirrorProbeResponse> {
    const cacheKey = probeCacheKey(settings, version, request);
    const cached = this.probeCache.get(cacheKey);
    if (cached && Date.now() - cached.checkedAtMs < this.probeTtlMs) {
      return withoutCacheStamp(cached);
    }

    const checkedAt = new Date().toISOString();
    const targetUrl = githubMirrorProbeTargetUrl(version);
    const signatureTargetUrl = githubMirrorProbeSignatureTargetUrl(version);
    const targets = mirrorProbeTargets(settings, request);
    const results = await Promise.all(targets.map((target) => this.checkOne(target, targetUrl, signatureTargetUrl, checkedAt)));
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
      targetVersion: version,
      checkedAt,
    };
    this.probeCache.set(cacheKey, {
      ...response,
      checkedAtMs: Date.now(),
    });
    return response;
  }

  async resolvePrefix(settings: AppSettings, version: string): Promise<GithubMirrorPrefixResolution | undefined> {
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

    const response = await this.check(settings, version, {
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
    targetUrl: string,
    signatureTargetUrl: string,
    checkedAt: string,
  ): Promise<GithubMirrorProbeResult> {
    const rewrite = rewriteGithubDownloadUrl(targetUrl, target.prefix);
    const signatureRewrite = rewriteGithubDownloadUrl(signatureTargetUrl, target.prefix);
    if (!rewrite || !signatureRewrite) {
      return {
        ...target,
        ok: false,
        checkedAt,
        error: "Mirror prefix cannot rewrite the CloakBrowser checksum or signature URL.",
      };
    }

    const startedAt = Date.now();
    try {
      const [manifest, signature] = await Promise.all([
        this.fetchText(rewrite.rewrittenUrl),
        this.fetchText(signatureRewrite.rewrittenUrl),
      ]);
      const latencyMs = Date.now() - startedAt;
      const manifestLooksValid = manifest.ok && manifest.text.split("\n").some((line) =>
        /^([a-f0-9]{64})\s+\*?cloakbrowser-/i.test(line.trim()) || line.trim().startsWith("version="),
      );
      const signatureLooksValid = signature.ok && /^[A-Za-z0-9+/= \r\n]+$/.test(signature.text) && signature.text.trim().length >= 40;
      return {
        ...target,
        ok: manifestLooksValid && signatureLooksValid,
        latencyMs,
        status: manifest.ok ? signature.status : manifest.status,
        checkedAt,
        ...(!manifest.ok
          ? { error: `SHA256SUMS HTTP ${manifest.status}` }
          : !signature.ok
            ? { error: `SHA256SUMS.sig HTTP ${signature.status}` }
          : !manifestLooksValid
            ? { error: "Response does not look like CloakBrowser SHA256SUMS." }
          : !signatureLooksValid
            ? { error: "Response does not look like CloakBrowser SHA256SUMS.sig." }
            : {}),
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

  private async fetchText(url: string): Promise<{ ok: boolean; status: number; text: string }> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }
}

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

function probeCacheKey(settings: AppSettings, version: string, request: GithubMirrorProbeRequest): string {
  const trace = normalizeNetworkTraceSettings({
    ...settings.networkTrace,
    customGithubMirrorPrefix:
      request.customGithubMirrorPrefix ?? settings.networkTrace.customGithubMirrorPrefix,
  });
  return JSON.stringify({
    version,
    providerId: request.providerId ?? trace.githubMirrorProviderId,
    customGithubMirrorPrefix: trace.customGithubMirrorPrefix,
  });
}

function withoutCacheStamp(response: GithubMirrorProbeResponse & { checkedAtMs: number }): GithubMirrorProbeResponse {
  const { checkedAtMs: _checkedAtMs, ...publicResponse } = response;
  return publicResponse;
}
