import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings";
import { LATENCY_PROBE_TARGETS, ProxyService } from "./proxyService";

const ALIBABA = { ...DEFAULT_APP_SETTINGS.networkTrace, providerId: "alibaba-dns-detect" };

test("measureLatency reports the first probe that answers through the proxy", async () => {
  const probed: string[] = [];
  const service = new ProxyService({
    checkTrace: async (_proxyUrl, _providerUrl, request) => {
      probed.push(request.url);
      assert.equal(request.method, "HEAD");
      if (!request.url.includes("cloudflare")) await new Promise((resolve) => setTimeout(resolve, 40));
      return { status: 204, text: "", headers: {} };
    },
  });
  const result = await service.measureLatency({ enabled: true, raw: "socks5://proxy.example.test:1080" });
  assert.equal(result.ok, true);
  assert.equal(result.target, "https://cp.cloudflare.com/generate_204");
  assert.ok((result.latencyMs ?? 0) >= 1);
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual([...probed].sort(), [...LATENCY_PROBE_TARGETS].sort());
});

test("measureLatency fails with a coded, readable error when no probe answers", async () => {
  const service = new ProxyService({
    checkTrace: async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:9");
    },
  });
  await assert.rejects(
    service.measureLatency({ enabled: true, raw: "http://127.0.0.1:9" }, { targets: ["https://example.test/a", "https://example.test/b"] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROXY_LATENCY_FAILED");
      assert.match((error as Error).message, /真延迟检测失败/);
      assert.match((error as Error).message, /拒绝连接/);
      return true;
    },
  );
  await assert.rejects(service.measureLatency({ enabled: false, raw: "" }), /代理未启用或不完整/);
});

test("check retries a provider that answers with something other than its trace format", async () => {
  let calls = 0;
  const service = new ProxyService({
    checkTrace: async (_proxyUrl, _providerUrl, request) => {
      calls += 1;
      if (calls === 1) return { status: 200, text: "<html><body>rate limited</body></html>", headers: {} };
      return `${request.callbackName}({"content":{"localIp":"203.0.113.5","ipCountry":"jp","ipCity":"Tokyo"}})`;
    },
    geoLookup: async () => undefined,
  });
  const result = await service.check({ enabled: true, raw: "http://proxy.example.test:8080" }, { traceSettings: ALIBABA });
  assert.equal(calls, 2);
  assert.equal(result.ok, true);
  assert.equal(result.ip, "203.0.113.5");
});

test("a provider that keeps answering garbage is named in the error along with what it sent", async () => {
  let calls = 0;
  const service = new ProxyService({
    checkTrace: async () => {
      calls += 1;
      return { status: 403, text: "<!DOCTYPE html><html><head><title>Access denied</title></head></html>", headers: {} };
    },
    geoLookup: async () => undefined,
  });
  await assert.rejects(
    service.check({ enabled: true, raw: "http://proxy.example.test:8080" }, { traceSettings: ALIBABA }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROXY_CHECK_TRACE_INVALID");
      const message = (error as Error).message;
      assert.match(message, /Alibaba DNS Detect/);
      assert.match(message, /HTTP 403/);
      assert.match(message, /网页/);
      assert.match(message, /切换检测端点/);
      assert.match(message, /Access denied/);
      return true;
    },
  );
  assert.equal(calls, 2);
});

test("transport failures are translated into actionable messages", async () => {
  const cases: Array<[string, RegExp]> = [
    ["connect ECONNREFUSED 10.0.0.1:1080", /拒绝连接/],
    ["getaddrinfo ENOTFOUND proxy.nowhere.test", /无法解析代理服务器主机名/],
    ["Socks5 Authentication failed", /认证失败/],
    ["socket hang up", /连接已关闭/],
    ["request timed out", /超时/],
    ["Socks5 proxy rejected connection - HostUnreachable", /SOCKS 握手失败/],
  ];
  for (const [raw, expected] of cases) {
    const service = new ProxyService({
      checkTrace: async () => {
        throw new Error(raw);
      },
    });
    await assert.rejects(
      service.check({ enabled: true, raw: "socks5://proxy.example.test:1080" }, { traceSettings: ALIBABA }),
      (error: unknown) => {
        assert.match((error as Error).message, expected, `for "${raw}"`);
        assert.equal((error as { code?: string }).code, "PROXY_CHECK_FAILED");
        return true;
      },
    );
  }
});
