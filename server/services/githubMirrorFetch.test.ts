import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "../../src/shared/settings";
import { applyGithubMirrorFetch, restoreGithubMirrorFetch } from "./githubMirrorFetch";
import { GithubMirrorProbeService } from "./githubMirrorProbeService";

test("applyGithubMirrorFetch rewrites only supported CloakBrowser download URLs", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seenUrls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response("ok");
  }) as typeof fetch;

  try {
    applyGithubMirrorFetch(normalizeSettings({
      networkTrace: {
        providerId: "cloudflare-speed",
        customProviderUrl: "",
        timeoutSeconds: 8,
        githubMirrorProviderId: "gh-proxy-com",
        customGithubMirrorPrefix: "",
      },
    }));

    await fetch("https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip");
    await fetch("https://api.github.com/repos/CloakHQ/cloakbrowser/releases");

    assert.deepEqual(seenUrls, [
      "https://gh-proxy.com/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
      "https://api.github.com/repos/CloakHQ/cloakbrowser/releases",
    ]);
  } finally {
    restoreGithubMirrorFetch();
    globalThis.fetch = originalFetch;
  }
});

test("auto-best mirror resolution rewrites downloads with the fastest successful mirror", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  const service = new GithubMirrorProbeService({
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://ghfast.top/")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response("SHA256 cloakbrowser-windows-x64.zip");
      }
      return new Response("bad", { status: 502 });
    }) as typeof fetch,
  });
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seenUrls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response("ok");
  }) as typeof fetch;

  try {
    const settings = normalizeSettings({
      networkTrace: {
        providerId: "cloudflare-speed",
        customProviderUrl: "",
        timeoutSeconds: 8,
        githubMirrorProviderId: "auto-best",
        customGithubMirrorPrefix: "",
      },
    });
    const resolution = await service.resolvePrefix(settings, "146.0.7680.177.5");
    applyGithubMirrorFetch(settings, resolution?.prefix);

    await fetch("https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip");

    assert.equal(resolution?.providerId, "ghfast-top");
    assert.deepEqual(seenUrls, [
      "https://ghfast.top/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
    ]);
  } finally {
    restoreGithubMirrorFetch();
    globalThis.fetch = originalFetch;
  }
});
