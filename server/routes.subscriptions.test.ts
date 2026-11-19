import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, before } from "node:test";
import type { ProxyEntity, ProxyImportResult, ProxySubscriptionEntity, ProxySubscriptionRefreshResult } from "../src/shared/entities";
import { startPanelHarness, type PanelHarness } from "./testing/httpHarness";

/**
 * Route contracts of remembered subscriptions, over HTTP against the real entry point, with a local
 * server standing in for the provider so the body can change between calls.
 */

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_A = `vless://${UUID}@a.example.com:443?security=tls&type=ws&path=%2Fws#Node%20A`;
const TROJAN_B = "trojan://secret@b.example.com:443?sni=b.example.com#Node%20B";
const SOCKS_C = "socks5://user:pass@10.0.0.9:1080#Plain%20C";

let panel: PanelHarness;
let provider: http.Server;
let providerUrl: string;
let body = [VLESS_A, TROJAN_B].join("\n");
let providerStatus = 200;

before(async () => {
  provider = http.createServer((_request, response) => {
    response.writeHead(providerStatus, { "content-type": "text/plain; charset=utf-8" });
    response.end(providerStatus === 200 ? body : "nope");
  });
  await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
  providerUrl = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/sub?token=abc`;
  panel = await startPanelHarness();
});

after(async () => {
  await panel?.dispose();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
});

test("a remembered import creates the subscription, refreshes replace its members, and delete can take them along", async () => {
  const imported = await panel.request("POST", "/api/proxies/import-subscription", { url: providerUrl, remember: true, name: "Local provider", autoRefresh: true, refreshIntervalHours: 12 });
  assert.equal(imported.status, 201);
  const result = imported.body as ProxyImportResult;
  assert.equal(result.imported.length, 2);
  assert.equal(result.subscription?.name, "Local provider");
  assert.equal(result.subscription?.url, "");
  assert.equal(result.subscription?.urlHost, `127.0.0.1:${(provider.address() as AddressInfo).port}`);
  assert.equal(result.subscription?.autoRefresh, true);
  assert.equal(result.subscription?.refreshIntervalHours, 12);
  const subscriptionId = result.subscription!.id;

  const listed = await panel.request("GET", "/api/proxy-subscriptions");
  assert.equal(listed.status, 200);
  assert.equal((listed.body as ProxySubscriptionEntity[]).length, 1);
  assert.equal((listed.body as ProxySubscriptionEntity[])[0].url, "");
  const withSecrets = await panel.request("GET", `/api/proxy-subscriptions/${subscriptionId}?secrets=1`);
  assert.equal((withSecrets.body as ProxySubscriptionEntity).url, providerUrl);

  const state = await panel.request("GET", "/api/state");
  const proxies = (state.body as { proxies: ProxyEntity[]; proxySubscriptions: ProxySubscriptionEntity[] });
  assert.equal(proxies.proxySubscriptions.length, 1);
  assert.equal(proxies.proxies.filter((proxy) => proxy.subscriptionId === subscriptionId).length, 2);

  body = [TROJAN_B, SOCKS_C].join("\n");
  const refreshed = await panel.request("POST", `/api/proxy-subscriptions/${subscriptionId}/refresh`);
  assert.equal(refreshed.status, 200);
  const outcome = refreshed.body as { subscription: ProxySubscriptionEntity; result: ProxySubscriptionRefreshResult };
  assert.equal(outcome.result.added, 1);
  assert.equal(outcome.result.removed, 1);
  assert.equal(outcome.result.kept, 1);
  assert.equal(outcome.subscription.lastRefresh?.ok, true);
  const afterRefresh = (await panel.request("GET", "/api/proxies")).body as ProxyEntity[];
  assert.deepEqual(afterRefresh.filter((proxy) => proxy.subscriptionId === subscriptionId).map((proxy) => proxy.name).sort(), ["Node B", "Plain C"]);

  const renamed = await panel.request("PUT", `/api/proxy-subscriptions/${subscriptionId}`, { name: "Renamed", autoRefresh: false });
  assert.equal(renamed.status, 200);
  assert.equal((renamed.body as ProxySubscriptionEntity).name, "Renamed");
  assert.equal((renamed.body as ProxySubscriptionEntity).autoRefresh, false);

  const all = await panel.request("POST", "/api/proxy-subscriptions/refresh-all");
  assert.equal(all.status, 200);
  assert.equal((all.body as { results: Array<{ id: string; result: ProxySubscriptionRefreshResult }> }).results[0].result.ok, true);

  providerStatus = 500;
  const failed = await panel.request("POST", `/api/proxy-subscriptions/${subscriptionId}/refresh`);
  assert.equal(failed.status, 502);
  assert.equal((failed.body as { code?: string }).code, "PROXY_SUBSCRIPTION_FETCH_FAILED");
  const recorded = (await panel.request("GET", `/api/proxy-subscriptions/${subscriptionId}`)).body as ProxySubscriptionEntity;
  assert.equal(recorded.lastRefresh?.ok, false);
  providerStatus = 200;

  const deleted = await panel.request("DELETE", `/api/proxy-subscriptions/${subscriptionId}?proxies=delete`);
  assert.equal(deleted.status, 200);
  assert.equal((deleted.body as { deleted: string[] }).deleted.length, 2);
  assert.equal(((await panel.request("GET", "/api/proxy-subscriptions")).body as ProxySubscriptionEntity[]).length, 0);
  assert.equal(((await panel.request("GET", "/api/proxies")).body as ProxyEntity[]).length, 0);
});

test("an address that cannot be read is not remembered, and a plain import stays standalone", async () => {
  providerStatus = 500;
  const created = await panel.request("POST", "/api/proxy-subscriptions", { url: providerUrl });
  assert.equal(created.status, 502);
  assert.equal(((await panel.request("GET", "/api/proxy-subscriptions")).body as ProxySubscriptionEntity[]).length, 0);
  providerStatus = 200;

  body = VLESS_A;
  const plain = await panel.request("POST", "/api/proxies/import-subscription", { url: providerUrl });
  assert.equal(plain.status, 201);
  const result = plain.body as ProxyImportResult;
  assert.equal(result.subscription, undefined);
  assert.equal(result.imported[0].subscriptionId, "");
  assert.equal(result.imported[0].notes, `订阅：127.0.0.1:${(provider.address() as AddressInfo).port}`);

  const missing = await panel.request("POST", "/api/proxy-subscriptions/nope/refresh");
  assert.equal(missing.status, 404);
  const invalid = await panel.request("POST", "/api/proxy-subscriptions", { url: "not a url" });
  assert.equal(invalid.status, 400);
  assert.equal((invalid.body as { code?: string }).code, "PROXY_SUBSCRIPTION_URL_INVALID");
  await panel.request("DELETE", `/api/proxies/${result.imported[0].id}`);
});
