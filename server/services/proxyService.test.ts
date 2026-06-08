import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings";
import { normalizeProxyCheckError, parseCloudflareTrace, ProxyService } from "./proxyService";

test("ProxyService returns a unified network check result from Cloudflare trace", async () => {
  let checkedProxyUrl = "";
  let checkedProviderUrl = "";
  const service = new ProxyService({
    checkTrace: async (proxyUrl, providerUrl) => {
      checkedProxyUrl = proxyUrl;
      checkedProviderUrl = providerUrl;
      return [
        "fl=35f962",
        "h=speed.cloudflare.com",
        "ip=203.0.113.42",
        "loc=US",
        "colo=LAX",
        "http=http/1.1",
        "tls=TLSv1.3",
        "warp=off",
      ].join("\n");
    },
  });

  const result = await service.check({
    enabled: true,
    raw: "http://alice:secret@proxy.example.test:8080",
  }, {
    traceSettings: DEFAULT_APP_SETTINGS.networkTrace,
    source: "environment-check",
  });

  assert.equal(checkedProxyUrl, "http://alice:secret@proxy.example.test:8080");
  assert.equal(checkedProviderUrl, "https://speed.cloudflare.com/cdn-cgi/trace");
  assert.equal(result.ok, true);
  assert.equal(result.ip, "203.0.113.42");
  assert.equal(result.source, "environment-check");
  assert.equal(result.trace?.providerId, "cloudflare-speed");
  assert.equal(result.trace?.loc, "US");
  assert.equal(result.trace?.colo, "LAX");
  assert.equal(result.trace?.tls, "TLSv1.3");
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("parseCloudflareTrace reads key value trace responses", () => {
  assert.deepEqual(parseCloudflareTrace("ip=18.143.185.28\nloc=SG\ncolo=SIN\nuag=a=b\n"), {
    ip: "18.143.185.28",
    loc: "SG",
    colo: "SIN",
    uag: "a=b",
  });
});

test("ProxyService rejects incomplete proxy settings", async () => {
  const service = new ProxyService();

  await assert.rejects(
    service.check({ enabled: true, host: "", port: "" }),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      return true;
    },
  );
});

test("normalizeProxyCheckError hides low-level socket failures", () => {
  const error = normalizeProxyCheckError(new Error("Socket closed"));

  assert.equal((error as { status?: number }).status, 502);
  assert.equal((error as { code?: string }).code, "PROXY_CHECK_FAILED");
  assert.match(error.message, /代理连接已关闭/);
});
