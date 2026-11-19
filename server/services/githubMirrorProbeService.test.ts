import assert from "node:assert/strict";
import test from "node:test";
import { CLOAKBROWSER_GEOIP_DB_URL, rewriteGithubDownloadUrl } from "../../src/shared/githubMirror";
import { normalizeSettings } from "../../src/shared/settings";
import { GithubMirrorProbeService, mirrorProbeTargets } from "./githubMirrorProbeService";

test("mirrorProbeTargets returns built-in mirrors and valid custom mirror for all checks", () => {
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-www",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "https://mirror.example.com/",
    },
  });

  const targets = mirrorProbeTargets(settings, { providerId: "all" });

  assert.equal(targets.length, 6);
  assert.equal(targets.at(-1)?.providerId, "custom");
  assert.equal(targets.at(-1)?.prefix, "https://mirror.example.com/");
});

test("GithubMirrorProbeService checks GeoIP response headers without downloading the database", async () => {
  const seenUrls: string[] = [];
  const service = new GithubMirrorProbeService({
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      assert.equal(init?.method, "HEAD");
      if (url.startsWith("https://ghproxy.vip/")) {
        return new Response(null, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": "70000000" } });
      }
      return new Response("missing", { status: 502 });
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-www",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "",
    },
  });

  const response = await service.check(settings, { providerId: "all" });

  assert.equal(response.recommendedProviderId, "ghproxy-vip");
  assert.equal(response.results.find((item) => item.providerId === "ghproxy-vip")?.ok, true);
  assert.equal(response.targetUrl, CLOAKBROWSER_GEOIP_DB_URL);
  assert.ok(seenUrls.every((url) => url.endsWith(CLOAKBROWSER_GEOIP_DB_URL)));
});

test("auto-best probe target checks all built-in mirrors", () => {
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-www",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "auto-best",
      customGithubMirrorPrefix: "",
    },
  });

  const targets = mirrorProbeTargets(settings, { providerId: "auto-best" });

  assert.deepEqual(
    targets.map((target) => target.providerId),
    ["gh-proxy-lipk", "ghfast-top", "ghproxy-net", "ghproxy-vip", "gh-proxy-com"],
  );
});

test("GithubMirrorProbeService records failed mirrors without failing the whole check", async () => {
  const service = new GithubMirrorProbeService({
    fetchImpl: (async () => {
      throw new Error("network down");
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-www",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "custom",
      customGithubMirrorPrefix: "https://mirror.example.com/",
    },
  });

  const response = await service.check(settings);

  assert.equal(response.results.length, 1);
  assert.equal(response.results[0]?.providerId, "custom");
  assert.equal(response.results[0]?.ok, false);
  assert.equal(response.results[0]?.error, "network down");
});

test("GithubMirrorProbeService reuses recent mirror probe results", async () => {
  let fetchCalls = 0;
  const service = new GithubMirrorProbeService({
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response(null, { headers: { "content-type": "application/octet-stream" } });
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-www",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "",
    },
  });

  const first = await service.check(settings, { providerId: "all" });
  const second = await service.check(settings, { providerId: "all" });

  assert.equal(fetchCalls, 5);
  assert.deepEqual(second, first);
});

test("GithubMirrorProbeService caches mirror probes by request shape", async () => {
  let fetchCalls = 0;
  const service = new GithubMirrorProbeService({
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response(null, { headers: { "content-type": "application/octet-stream" } });
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-www",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "https://mirror-one.example.com/",
    },
  });

  await service.check(settings, { providerId: "custom" });
  await service.check(settings, { providerId: "custom" });
  await service.check(settings, {
    providerId: "custom",
    customGithubMirrorPrefix: "https://mirror-two.example.com/",
  });

  assert.equal(fetchCalls, 2);
});

test("GitHub mirror probes use the current GeoIP asset independently of any installed core", () => {
  assert.equal(
    rewriteGithubDownloadUrl(
      CLOAKBROWSER_GEOIP_DB_URL,
      "https://gh-proxy.com/",
    )?.rewrittenUrl,
    `https://gh-proxy.com/${CLOAKBROWSER_GEOIP_DB_URL}`,
  );
});

test("mirror probes reject HTML landing pages, missing types, empty files and failed responses", async () => {
  const settings = normalizeSettings({ networkTrace: { githubMirrorProviderId: "custom", customGithubMirrorPrefix: "https://mirror.example.test/" } });
  for (const [status, headers] of [
    [200, { "content-type": "text/html" }],
    [200, {}],
    [200, { "content-type": "application/octet-stream", "content-length": "0" }],
    [200, { "content-type": "application/octet-stream", "content-length": "unknown" }],
    [403, { "content-type": "application/octet-stream" }],
  ] as Array<[number, Record<string, string>]>) {
    const service = new GithubMirrorProbeService({ fetchImpl: async () => new Response(null, { status, headers }) });
    const response = await service.check(settings);
    assert.equal(response.results[0]?.ok, false);
    assert.equal(response.recommendedProviderId, undefined);
  }
});

test("a server that sends a body to HEAD is cancelled without reading the database", async () => {
  let cancelled = false;
  const service = new GithubMirrorProbeService({ fetchImpl: async (_input, init) => {
    assert.equal(init?.method, "HEAD");
    const body = new ReadableStream({ cancel() { cancelled = true; } });
    return new Response(body, { headers: { "content-type": "application/octet-stream", "content-length": "70000000" } });
  } });
  const response = await service.check(normalizeSettings({ networkTrace: { githubMirrorProviderId: "custom", customGithubMirrorPrefix: "https://mirror.example.test/" } }));
  assert.equal(response.results[0]?.ok, true);
  assert.equal(cancelled, true);
});
