import assert from "node:assert/strict";
import test from "node:test";
import { rewriteGithubDownloadUrl } from "../../src/shared/githubMirror";
import { normalizeSettings } from "../../src/shared/settings";
import { GithubMirrorProbeService, mirrorProbeTargets } from "./githubMirrorProbeService";

test("mirrorProbeTargets returns built-in mirrors and valid custom mirror for all checks", () => {
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-speed",
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

test("GithubMirrorProbeService checks checksum URLs and recommends the fastest successful mirror", async () => {
  const seenUrls: string[] = [];
  const service = new GithubMirrorProbeService({
    fetchImpl: (async (input: Parameters<typeof fetch>[0]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seenUrls.push(url);
      if (url.startsWith("https://ghproxy.vip/")) return new Response("abc cloakbrowser-windows-x64.zip", { status: 200 });
      return new Response("missing", { status: 502 });
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-speed",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "",
    },
  });

  const response = await service.check(settings, "146.0.7680.177.5", { providerId: "all" });

  assert.equal(response.recommendedProviderId, "ghproxy-vip");
  assert.equal(response.results.find((item) => item.providerId === "ghproxy-vip")?.ok, true);
  assert.ok(
    seenUrls.every((url) => url.endsWith("/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/SHA256SUMS")),
  );
});

test("auto-best probe target checks all built-in mirrors", () => {
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-speed",
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
      providerId: "cloudflare-speed",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "custom",
      customGithubMirrorPrefix: "https://mirror.example.com/",
    },
  });

  const response = await service.check(settings, "146.0.7680.177.5");

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
      return new Response("SHA256 cloakbrowser-windows-x64.zip");
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-speed",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "",
    },
  });

  const first = await service.check(settings, "146.0.7680.177.5", { providerId: "all" });
  const second = await service.check(settings, "146.0.7680.177.5", { providerId: "all" });

  assert.equal(fetchCalls, 5);
  assert.deepEqual(second, first);
});

test("GithubMirrorProbeService caches mirror probes by request shape", async () => {
  let fetchCalls = 0;
  const service = new GithubMirrorProbeService({
    fetchImpl: (async () => {
      fetchCalls += 1;
      return new Response("SHA256 cloakbrowser-windows-x64.zip");
    }) as typeof fetch,
  });
  const settings = normalizeSettings({
    networkTrace: {
      providerId: "cloudflare-speed",
      customProviderUrl: "",
      timeoutSeconds: 8,
      githubMirrorProviderId: "off",
      customGithubMirrorPrefix: "https://mirror-one.example.com/",
    },
  });

  await service.check(settings, "146.0.7680.177.5", { providerId: "custom" });
  await service.check(settings, "146.0.7680.177.5", { providerId: "custom" });
  await service.check(settings, "146.0.7680.177.5", {
    providerId: "custom",
    customGithubMirrorPrefix: "https://mirror-two.example.com/",
  });

  assert.equal(fetchCalls, 2);
});

test("GitHub mirror probe target is still limited to supported CloakBrowser downloads", () => {
  assert.equal(
    rewriteGithubDownloadUrl(
      "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/SHA256SUMS",
      "https://gh-proxy.com/",
    )?.rewrittenUrl,
    "https://gh-proxy.com/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/SHA256SUMS",
  );
});
