import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { ProxyEntity, XrayEngineStatus } from "../src/shared/entities";
import { startPanelHarness, type PanelHarness } from "./testing/httpHarness";

/**
 * Route-level contracts of the Xray engine: the status route, the share-link import, and the checks
 * that must answer honestly when the engine is not installed. Asserted over HTTP against the real
 * entry point, because the wiring — which routes go through the engine, how a missing binary is
 * reported — lives in server/index.ts and nowhere a unit test can see.
 */

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_LINK = `vless://${UUID}@node.example.com:443?security=tls&type=ws&path=%2Fws#Node%20A`;
const TROJAN_LINK = "trojan://secret@trojan.example.com:443?sni=trojan.example.com#Node%20B";

let panel: PanelHarness;

before(async () => {
  panel = await startPanelHarness();
});

after(async () => {
  await panel?.dispose();
});

test("GET /api/xray reports the engine as not installed on a fresh data directory", async () => {
  const response = await panel.request("GET", "/api/xray");
  assert.equal(response.status, 200);
  const status = response.body as XrayEngineStatus;
  assert.equal(status.installed, false);
  assert.equal(status.source, "missing");
  assert.ok(status.binaryPath.includes("xray"));
  assert.deepEqual(status.instances, []);
  assert.equal(status.operation, undefined);
});

test("xray proxies round-trip through the registry routes with the share link kept secret", async () => {
  const created = await panel.request("POST", "/api/proxies", { scheme: "xray", shareLink: VLESS_LINK, ipStrategy: "ipv4-first", utlsFingerprint: "hellorandomizednoalpn" });
  assert.equal(created.status, 201);
  const proxy = created.body as ProxyEntity;
  assert.equal(proxy.name, "Node A");
  assert.equal(proxy.host, "node.example.com");
  assert.equal(proxy.port, "443");
  assert.equal(proxy.utlsFingerprint, "hellorandomizednoalpn");
  assert.equal(proxy.xrayNode?.protocol, "vless");
  assert.equal(proxy.xrayNode?.network, "ws");

  const listed = await panel.request("GET", "/api/proxies");
  const found = (listed.body as ProxyEntity[]).find((item) => item.id === proxy.id);
  assert.equal(found?.shareLink, "");
  assert.equal(found?.xrayNode?.security, "tls");

  const withSecrets = await panel.request("GET", `/api/proxies/${proxy.id}?secrets=1`);
  assert.equal((withSecrets.body as ProxyEntity).shareLink, VLESS_LINK);

  const invalid = await panel.request("POST", "/api/proxies", { scheme: "xray", shareLink: "vless://nope" });
  assert.equal(invalid.status, 400);

  // A check of an xray proxy needs the engine; without it the failure is a coded refusal and the
  // proxy remembers it as its last check.
  const check = await panel.request("POST", `/api/proxies/${proxy.id}/check`);
  assert.equal(check.status, 409);
  assert.equal((check.body as { code?: string }).code, "XRAY_ENGINE_MISSING");
  const afterCheck = await panel.request("GET", `/api/proxies/${proxy.id}`);
  assert.equal((afterCheck.body as ProxyEntity).lastCheck?.ok, false);
  assert.match((afterCheck.body as ProxyEntity).lastCheck?.error ?? "", /Xray 引擎未安装/);

  const draftCheck = await panel.request("POST", "/api/proxy/check", { proxy: { enabled: true, scheme: "xray", shareLink: TROJAN_LINK } });
  assert.equal(draftCheck.status, 409);
  assert.equal((draftCheck.body as { code?: string }).code, "XRAY_ENGINE_MISSING");

  await panel.request("DELETE", `/api/proxies/${proxy.id}`);
});

test("POST /api/proxies/import-links imports every parsable node once", async () => {
  const text = [VLESS_LINK, "garbage line", TROJAN_LINK, "socks5://user:pass@10.0.0.9:1080#Plain"].join("\n");
  const first = await panel.request("POST", "/api/proxies/import-links", { text });
  assert.equal(first.status, 201);
  const result = first.body as { imported: ProxyEntity[]; failed: Array<{ link: string; error: string }>; skipped: number; total: number };
  assert.equal(result.total, 4);
  assert.equal(result.imported.length, 3);
  assert.equal(result.failed.length, 1);
  assert.equal(result.skipped, 0);
  const plain = result.imported.find((proxy) => proxy.name === "Plain");
  assert.equal(plain?.scheme, "socks5");
  assert.equal(plain?.host, "10.0.0.9");
  assert.equal(plain?.username, "user");
  const node = result.imported.find((proxy) => proxy.name === "Node B");
  assert.equal(node?.scheme, "xray");
  assert.equal(node?.xrayNode?.protocol, "trojan");

  const again = await panel.request("POST", "/api/proxies/import-links", { text: `${VLESS_LINK}\n${TROJAN_LINK}` });
  assert.equal(again.status, 201);
  assert.equal((again.body as { skipped: number }).skipped, 2);
  assert.equal((again.body as { imported: ProxyEntity[] }).imported.length, 0);

  const empty = await panel.request("POST", "/api/proxies/import-links", { text: "\n\n" });
  assert.equal(empty.status, 400);
  assert.equal((empty.body as { code?: string }).code, "PROXY_IMPORT_EMPTY");

  for (const proxy of result.imported) await panel.request("DELETE", `/api/proxies/${proxy.id}`);
});

test("import answers a single format error for pages, Clash YAML, JSON and all-garbage bodies", async () => {
  const html = await panel.request("POST", "/api/proxies/import-links", { text: "<!DOCTYPE html><html><body>Please sign in</body></html>" });
  assert.equal(html.status, 400);
  assert.equal((html.body as { code?: string }).code, "PROXY_IMPORT_UNSUPPORTED_FORMAT");
  assert.match((html.body as { error: string }).error, /网页/);

  const clash = await panel.request("POST", "/api/proxies/import-links", { text: "port: 7890\nproxies:\n  - name: HK\n    type: vmess\n" });
  assert.equal(clash.status, 400);
  assert.match((clash.body as { error: string }).error, /Clash/);

  const json = await panel.request("POST", "/api/proxies/import-links", { text: JSON.stringify({ outbounds: [] }) });
  assert.equal(json.status, 400);
  assert.match((json.body as { error: string }).error, /JSON/);

  const garbageLines = Array.from({ length: 40 }, (_, index) => `line ${index} is not a node`).join("\n");
  const garbage = await panel.request("POST", "/api/proxies/import-links", { text: garbageLines });
  assert.equal(garbage.status, 400);
  assert.equal((garbage.body as { code?: string }).code, "PROXY_IMPORT_UNRECOGNIZED");
  assert.match((garbage.body as { error: string }).error, /共 40 行/);

  // A mostly-broken body that still contains one node imports the node and caps the failure list.
  const mixed = await panel.request("POST", "/api/proxies/import-links", { text: `${garbageLines}\n${TROJAN_LINK}` });
  assert.equal(mixed.status, 201);
  const mixedResult = mixed.body as { imported: ProxyEntity[]; failed: unknown[]; failedTotal: number; total: number };
  assert.equal(mixedResult.imported.length, 1);
  assert.equal(mixedResult.failedTotal, 40);
  assert.equal(mixedResult.failed.length, 20);
  assert.equal(mixedResult.total, 41);
  for (const proxy of mixedResult.imported) await panel.request("DELETE", `/api/proxies/${proxy.id}`);
});

test("batch latency, check and delete work on ids and keep referenced proxies", async () => {
  const dead = await panel.request("POST", "/api/proxies", { name: "Dead A", scheme: "socks5", host: "127.0.0.1", port: "9" });
  const deadTwo = await panel.request("POST", "/api/proxies", { name: "Dead B", scheme: "http", host: "127.0.0.1", port: "9" });
  const ids = [(dead.body as ProxyEntity).id, (deadTwo.body as ProxyEntity).id];

  const latency = await panel.request("POST", "/api/proxies/batch/latency", { ids: [...ids, "proxy-missing"] });
  assert.equal(latency.status, 200);
  const latencyResults = (latency.body as { results: Array<{ id: string; result: { ok: boolean; error?: string } }> }).results;
  assert.equal(latencyResults.length, 3);
  assert.equal(latencyResults.every((item) => item.result.ok === false), true);
  assert.match(latencyResults[0].result.error ?? "", /真延迟检测失败/);
  assert.match(latencyResults[2].result.error ?? "", /代理不存在/);
  const stored = await panel.request("GET", `/api/proxies/${ids[0]}`);
  assert.equal((stored.body as ProxyEntity).lastLatency?.ok, false);

  const single = await panel.request("POST", `/api/proxies/${ids[1]}/latency`);
  assert.equal(single.status, 502);
  assert.equal((single.body as { code?: string }).code, "PROXY_LATENCY_FAILED");

  const check = await panel.request("POST", "/api/proxies/batch/check", { ids });
  assert.equal(check.status, 200);
  const checkResults = (check.body as { results: Array<{ id: string; result: { ok: boolean } }> }).results;
  assert.deepEqual(checkResults.map((item) => item.result.ok), [false, false]);
  assert.equal(((await panel.request("GET", `/api/proxies/${ids[1]}`)).body as ProxyEntity).lastCheck?.ok, false);

  const invalid = await panel.request("POST", "/api/proxies/batch/check", { ids: "nope" });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { code?: string }).code, "PROXY_IDS_INVALID");

  // Bind one proxy to an environment: the batch delete keeps it and says so.
  const environment = await panel.request("POST", "/api/environments", { name: "Batch delete guard" });
  assert.equal(environment.status, 201);
  const environmentId = (environment.body as { id: string }).id;
  const bound = await panel.request("PUT", `/api/environments/${environmentId}`, { proxyId: ids[0] });
  assert.equal(bound.status, 200);

  const deleted = await panel.request("POST", "/api/proxies/batch/delete", { ids: [...ids, "proxy-missing"] });
  assert.equal(deleted.status, 200);
  const deleteResult = deleted.body as { deleted: string[]; blocked: Array<{ id: string; name: string; count: number }> };
  assert.deepEqual(deleteResult.deleted, [ids[1]]);
  assert.deepEqual(deleteResult.blocked, [{ id: ids[0], name: "Dead A", count: 1 }]);

  await panel.request("DELETE", `/api/environments/${environmentId}`);
  await panel.request("DELETE", `/api/trash/environments/${environmentId}`);
  await panel.request("POST", `/api/proxies/${ids[0]}/replace-references`, {});
  await panel.request("DELETE", `/api/proxies/${ids[0]}`);
});

test("the native-routing setting decides whether a plain proxy needs the engine", async () => {
  const plain = await panel.request("POST", "/api/proxies", { name: "Plain", scheme: "socks5", host: "127.0.0.1", port: "9" });
  const id = (plain.body as ProxyEntity).id;
  try {
    // Default "auto" with no engine installed: the check goes straight to the proxy and fails on the
    // proxy itself, not on the engine.
    const direct = await panel.request("POST", `/api/proxies/${id}/check`);
    assert.equal(direct.status, 502);
    assert.notEqual((direct.body as { code?: string }).code, "XRAY_ENGINE_MISSING");

    const always = await panel.request("PUT", "/api/settings", { xray: { nativeProxyRouting: "always" } });
    assert.equal(always.status, 200);
    const viaEngine = await panel.request("POST", `/api/proxies/${id}/check`);
    assert.equal(viaEngine.status, 409);
    assert.equal((viaEngine.body as { code?: string }).code, "XRAY_ENGINE_MISSING");

    const never = await panel.request("PUT", "/api/settings", { xray: { nativeProxyRouting: "never" } });
    assert.equal(never.status, 200);
    const directAgain = await panel.request("POST", `/api/proxies/${id}/check`);
    assert.notEqual((directAgain.body as { code?: string }).code, "XRAY_ENGINE_MISSING");
  } finally {
    await panel.request("PUT", "/api/settings", { xray: { nativeProxyRouting: "auto" } });
    await panel.request("DELETE", `/api/proxies/${id}`);
  }
});

test("POST /api/proxies/import-subscription validates the address before fetching", async () => {
  const invalid = await panel.request("POST", "/api/proxies/import-subscription", { url: "not a url" });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { code?: string }).code, "PROXY_SUBSCRIPTION_URL_INVALID");
  const scheme = await panel.request("POST", "/api/proxies/import-subscription", { url: "ftp://example.test/sub" });
  assert.equal(scheme.status, 400);
});

test("system diagnostics carry the engine status", async () => {
  const response = await panel.request("GET", "/api/system/diagnostics");
  assert.equal(response.status, 200);
  const diagnostics = response.body as { schemaVersion: number; xrayEngine?: XrayEngineStatus };
  assert.equal(diagnostics.schemaVersion, 4);
  assert.equal(diagnostics.xrayEngine?.installed, false);
});
