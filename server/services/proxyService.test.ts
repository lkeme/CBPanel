import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_APP_SETTINGS } from "../../src/shared/settings";
import {
  normalizeProxyCheckError,
  parseAliyunDnsDetectJsonp,
  parseCloudflareTrace,
  parseHeaderIpTraceResponse,
  parseTencentIp2CityJsonp,
  ProxyService,
} from "./proxyService";

test("ProxyService returns a unified network check result from Cloudflare trace", async () => {
  let checkedProxyUrl = "";
  let checkedProviderUrl = "";
  const service = new ProxyService({
    checkTrace: async (proxyUrl, providerUrl) => {
      checkedProxyUrl = proxyUrl;
      checkedProviderUrl = providerUrl;
      return [
        "fl=35f962",
        "h=www.cloudflare.com",
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
    traceSettings: {
      ...DEFAULT_APP_SETTINGS.networkTrace,
      providerId: "cloudflare-www",
    },
    source: "environment-check",
  });

  assert.equal(checkedProxyUrl, "http://alice:secret@proxy.example.test:8080");
  assert.equal(checkedProviderUrl, "https://ip.skk.moe/cdn-cgi/trace");
  assert.equal(result.ok, true);
  assert.equal(result.ip, "203.0.113.42");
  assert.equal(result.source, "environment-check");
  assert.equal(result.trace?.providerId, "cloudflare-www");
  assert.equal(result.trace?.loc, "US");
  assert.equal(result.trace?.colo, "LAX");
  assert.equal(result.trace?.tls, "TLSv1.3");
  assert.match(result.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test("ProxyService uses Tencent JSONP parser and geo enrichment", async () => {
  let checkedProviderUrl = "";
  const service = new ProxyService({
    checkTrace: async (_proxyUrl, providerUrl, request) => {
      checkedProviderUrl = providerUrl;
      assert.equal(request.providerId, "tencent-ip2city");
      assert.equal(request.method, "GET");
      assert.ok(request.callbackName);
      return `${request.callbackName}({"ip":"198.51.100.23","country":"United States","province":"California","city":"Los Angeles","district":"","isp":"ExampleNet"});`;
    },
    geoLookup: async (ip) => {
      assert.equal(ip, "198.51.100.23");
      return { countryCode: "US", countryName: "United States", cityName: "Los Angeles", timezone: "America/Los_Angeles" };
    },
  });

  const result = await service.check({
    enabled: true,
    raw: "http://proxy.example.test:8080",
  }, {
    traceSettings: {
      ...DEFAULT_APP_SETTINGS.networkTrace,
      providerId: "tencent-ip2city",
    },
  });

  assert.match(checkedProviderUrl, /^https:\/\/r\.inews\.qq\.com\/api\/ip2city\?/);
  assert.equal(result.ip, "198.51.100.23");
  assert.equal(result.trace?.providerId, "tencent-ip2city");
  assert.equal(result.trace?.raw?.isp, "ExampleNet");
  assert.equal(result.geo?.countryCode, "US");
  assert.equal(result.geo?.timezone, "America/Los_Angeles");
});

test("ProxyService uses header parser and keeps single selected provider", async () => {
  const service = new ProxyService({
    checkTrace: async (_proxyUrl, providerUrl, request) => {
      assert.equal(providerUrl, "https://necaptcha.nosdn.127.net/ab7f4275c1744aa28e0a8f3a1c58c532.png");
      assert.equal(request.providerId, "netease-nosdn");
      assert.equal(request.method, "HEAD");
      return {
        url: providerUrl,
        status: 200,
        text: "",
        headers: {
          "cdn-user-ip": "192.0.2.55",
        },
      };
    },
    geoLookup: async (ip) => {
      assert.equal(ip, "192.0.2.55");
      return { countryCode: "JP", countryName: "Japan", cityName: "Tokyo" };
    },
  });

  const result = await service.check({
    enabled: true,
    raw: "http://proxy.example.test:8080",
  }, {
    traceSettings: {
      ...DEFAULT_APP_SETTINGS.networkTrace,
      providerId: "netease-nosdn",
    },
  });

  assert.equal(result.ip, "192.0.2.55");
  assert.equal(result.trace?.providerId, "netease-nosdn");
  assert.equal(result.trace?.raw?.ipHeader, "cdn-user-ip");
  assert.equal(result.geo?.countryCode, "JP");
});

test("parseCloudflareTrace reads key value trace responses", () => {
  assert.deepEqual(parseCloudflareTrace("ip=18.143.185.28\nloc=SG\ncolo=SIN\nuag=a=b\n"), {
    ip: "18.143.185.28",
    loc: "SG",
    colo: "SIN",
    uag: "a=b",
  });
});

test("JSONP parsers map Tencent and Alibaba responses", () => {
  const tencent = parseTencentIp2CityJsonp(
    "cb({\"ip\":\"203.0.113.10\",\"country\":\"Singapore\",\"province\":\"\",\"city\":\"Singapore\",\"district\":\"\",\"isp\":\"ISP\"});",
    "cb",
  );
  assert.equal(tencent.ip, "203.0.113.10");
  assert.equal(tencent.loc, "Singapore / Singapore");
  assert.equal(tencent.geo?.countryName, "Singapore");
  assert.equal(tencent.raw.isp, "ISP");

  const aliyun = parseAliyunDnsDetectJsonp(
    "jsonp123({\"content\":{\"localIp\":\"198.51.100.9\",\"ipCountry\":\"China\",\"ipProvince\":\"Shanghai\",\"ipCity\":\"Shanghai\"}});",
    "jsonp123",
  );
  assert.equal(aliyun.ip, "198.51.100.9");
  assert.equal(aliyun.loc, "China / Shanghai / Shanghai");
  assert.equal(aliyun.raw["content.localIp"], "198.51.100.9");
});

test("header parser extracts NetEase and static resource IP headers", () => {
  const netease = parseHeaderIpTraceResponse({
    url: "https://necaptcha.nosdn.127.net/asset.png",
    status: 200,
    text: "",
    headers: { "cdn-user-ip": "203.0.113.77" },
  });
  assert.equal(netease.ip, "203.0.113.77");
  assert.equal(netease.raw.ipHeader, "cdn-user-ip");

  const staticHeader = parseHeaderIpTraceResponse({
    url: "https://perfops.byte-test.com/500b-bench.jpg",
    status: 200,
    text: "",
    headers: { "x-response-cinfo": "edge=abc; client=198.51.100.88; region=us" },
  });
  assert.equal(staticHeader.ip, "198.51.100.88");
  assert.equal(staticHeader.raw.ipHeader, "x-response-cinfo");
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
