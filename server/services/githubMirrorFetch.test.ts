import assert from "node:assert/strict";
import test from "node:test";
import { normalizeSettings } from "../../src/shared/settings";
import { applyGithubMirrorFetch, restoreGithubMirrorFetch } from "./githubMirrorFetch";
import { GithubMirrorProbeService } from "./githubMirrorProbeService";

test("applyGithubMirrorFetch rewrites only supported GitHub downloads", async () => {
  const originalFetch = globalThis.fetch;
  const seenUrls: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    seenUrls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return new Response("ok");
  }) as typeof fetch;

  try {
    applyGithubMirrorFetch(normalizeSettings({
      networkTrace: {
        providerId: "cloudflare-www",
        customProviderUrl: "",
        timeoutSeconds: 8,
        githubMirrorProviderId: "gh-proxy-com",
        customGithubMirrorPrefix: "",
      },
    }));

    // The retired official archive path and the API stay untouched; the Pro checksum manifest does not.
    await fetch("https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip");
    await fetch("https://api.github.com/repos/CloakHQ/cloakbrowser/releases");
    await fetch("https://cloakbrowser.dev/releases/pro/chromium-v156.0.8078.47.1/SHA256SUMS");

    assert.deepEqual(seenUrls, [
      "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
      "https://api.github.com/repos/CloakHQ/cloakbrowser/releases",
      "https://gh-proxy.com/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v156.0.8078.47.1-pro/SHA256SUMS",
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
      if (url.startsWith("https://gh.qfmc0721.cc.cd/")) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return new Response(null, { headers: { "content-type": "application/octet-stream" } });
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
        providerId: "cloudflare-www",
        customProviderUrl: "",
        timeoutSeconds: 8,
        githubMirrorProviderId: "auto-best",
        customGithubMirrorPrefix: "",
      },
    });
    const resolution = await service.resolvePrefix(settings);
    applyGithubMirrorFetch(settings, resolution?.prefix);

    await fetch("https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb");

    assert.equal(resolution?.providerId, "gh-qfmc0721");
    assert.deepEqual(seenUrls, [
      "https://gh.qfmc0721.cc.cd/https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb",
    ]);
  } finally {
    restoreGithubMirrorFetch();
    globalThis.fetch = originalFetch;
  }
});
