import { rewriteGithubDownloadUrl } from "../../src/shared/githubMirror";
import { resolveGithubMirrorPrefix, type AppSettings } from "../../src/shared/settings";

let originalFetch: typeof fetch | undefined;
let installedFetch: typeof fetch | undefined;
let installedPrefix: string | undefined;

export function applyGithubMirrorFetch(settings: AppSettings, resolvedPrefix?: string): void {
  const prefix = resolvedPrefix ?? resolveGithubMirrorPrefix(settings.networkTrace);
  if (!prefix) {
    restoreGithubMirrorFetch();
    return;
  }
  if (installedPrefix === prefix && installedFetch && globalThis.fetch === installedFetch) return;

  restoreGithubMirrorFetch();
  const baseFetch = globalThis.fetch;
  originalFetch = baseFetch;
  installedFetch = (input, init) => {
    const originalUrl = fetchInputUrl(input);
    const rewrite = originalUrl ? rewriteGithubDownloadUrl(originalUrl, prefix) : undefined;
    if (!rewrite) return baseFetch(input, init);
    return baseFetch(rebuildFetchInput(input, rewrite.rewrittenUrl), init);
  };
  installedPrefix = prefix;
  globalThis.fetch = installedFetch;
}

export function restoreGithubMirrorFetch(): void {
  if (originalFetch && installedFetch && globalThis.fetch === installedFetch) {
    globalThis.fetch = originalFetch;
  }
  originalFetch = undefined;
  installedFetch = undefined;
  installedPrefix = undefined;
}

function fetchInputUrl(input: Parameters<typeof fetch>[0]): string | undefined {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  if (input instanceof Request) return input.url;
  return undefined;
}

function rebuildFetchInput(input: Parameters<typeof fetch>[0], rewrittenUrl: string): Parameters<typeof fetch>[0] {
  if (typeof input === "string") return rewrittenUrl;
  if (input instanceof URL) return new URL(rewrittenUrl);
  if (input instanceof Request) {
    const init: RequestInit = {
      cache: input.cache,
      credentials: input.credentials,
      headers: input.headers,
      integrity: input.integrity,
      keepalive: input.keepalive,
      method: input.method,
      mode: input.mode,
      redirect: input.redirect,
      referrer: input.referrer,
      referrerPolicy: input.referrerPolicy,
      signal: input.signal,
    };
    if (input.method !== "GET" && input.method !== "HEAD") init.body = input.body;
    return new Request(rewrittenUrl, init);
  }
  return input;
}
