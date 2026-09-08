import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { ProxySubscriptionService, isRefreshDue, subscriptionNote } from "./proxySubscriptionService";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_A = `vless://${UUID}@a.example.com:443?security=tls&type=ws&path=%2Fws#Node%20A`;
const VLESS_A_RENAMED = `vless://${UUID}@a.example.com:443?security=tls&type=ws&path=%2Fws#Node%20A%20v2`;
const TROJAN_B = "trojan://secret@b.example.com:443?sni=b.example.com#Node%20B";
const SOCKS_C = "socks5://user:pass@10.0.0.9:1080#Plain%20C";
const VMESS_D = `vmess://${Buffer.from(JSON.stringify({
  v: "2", ps: "Node D", add: "d.example.com", port: "443", id: UUID, aid: "0", scy: "auto", net: "ws", type: "none", host: "", path: "/vm", tls: "tls",
}), "utf8").toString("base64")}`;
const URL_A = "https://sub.example.com/api/v1/client?token=abc";

async function makeHarness(bodies: Record<string, string | Error>, clock?: { now: Date }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-subscription-service-"));
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await repository.initialize();
  const fetched: string[] = [];
  const service = new ProxySubscriptionService({
    repository,
    now: () => clock?.now ?? new Date(),
    log: () => {},
    fetchBody: async (url) => {
      fetched.push(url);
      const body = bodies[url];
      if (body === undefined) throw Object.assign(new Error(`订阅下载失败：HTTP 404`), { status: 502, code: "PROXY_SUBSCRIPTION_FETCH_FAILED" });
      if (body instanceof Error) throw body;
      return body;
    },
  });
  return {
    repository,
    service,
    fetched,
    bodies,
    async dispose() {
      repository.close();
      await fs.rm(directory, { recursive: true, force: true });
    },
  };
}

test("remembering a subscription imports its nodes as members, and a refresh makes them match the address again", async () => {
  const bodies: Record<string, string> = { [URL_A]: [VLESS_A, TROJAN_B, SOCKS_C].join("\n") };
  const harness = await makeHarness(bodies);
  try {
    const { repository, service } = harness;
    const result = await service.importSubscription(URL_A, { remember: { name: "Provider A", autoRefresh: true, refreshIntervalHours: 6 } });
    assert.equal(result.imported.length, 3);
    assert.equal(result.skipped, 0);
    assert.equal(result.subscription?.name, "Provider A");
    assert.equal(result.subscription?.url, "", "the list view never carries the token");
    assert.equal(result.subscription?.urlHost, "sub.example.com");
    assert.equal(result.subscription?.autoRefresh, true);
    assert.equal(result.subscription?.refreshIntervalHours, 6);
    assert.equal(result.subscription?.lastRefresh?.ok, true);
    assert.equal(result.subscription?.lastRefresh?.added, 3);
    const subscriptionId = result.subscription!.id;

    const members = (await repository.listProxies()).filter((proxy) => proxy.subscriptionId === subscriptionId);
    assert.equal(members.length, 3);
    assert.deepEqual(members.map((proxy) => proxy.notes), ["", "", ""], "members carry the subscription, not a note about it");
    assert.equal(members.find((proxy) => proxy.name === "Plain C")?.scheme, "socks5");

    // Remembering the same address again refreshes the existing subscription instead of duplicating it.
    const again = await service.importSubscription(URL_A, { remember: { name: "ignored" } });
    assert.equal(again.subscription?.id, subscriptionId);
    assert.equal(again.subscription?.name, "Provider A");
    assert.equal(again.imported.length, 0);
    assert.equal(again.skipped, 3, "still-listed members count as skipped for the import view");
    assert.equal((await repository.listProxySubscriptions()).length, 1);

    // The provider renames A, drops B and adds D.
    bodies[URL_A] = [VLESS_A_RENAMED, SOCKS_C, VMESS_D].join("\n");
    const refreshed = await service.refresh(subscriptionId);
    assert.equal(refreshed.result.ok, true);
    assert.equal(refreshed.result.added, 1);
    assert.equal(refreshed.result.kept, 2);
    assert.equal(refreshed.result.removed, 1);
    assert.equal(refreshed.result.detached, 0);
    assert.equal(refreshed.result.total, 3);
    assert.equal(refreshed.subscription.lastRefresh?.added, 1);

    const after = (await repository.listProxies({ includeSecrets: true })).filter((proxy) => proxy.subscriptionId === subscriptionId);
    assert.deepEqual(after.map((proxy) => proxy.name).sort(), ["Node A v2", "Node D", "Plain C"]);
    const renamed = after.find((proxy) => proxy.name === "Node A v2");
    assert.equal(renamed?.id, members.find((proxy) => proxy.name === "Node A")?.id, "a renamed node keeps its record");
    assert.equal(renamed?.shareLink, VLESS_A_RENAMED);
    assert.equal((await repository.listProxies()).some((proxy) => proxy.name === "Node B"), false);
  } finally {
    await harness.dispose();
  }
});

test("a member in use leaves the subscription as a standalone proxy instead of being replaced", async () => {
  const bodies: Record<string, string> = { [URL_A]: [VLESS_A, TROJAN_B, SOCKS_C].join("\n") };
  const harness = await makeHarness(bodies);
  try {
    const { repository, service } = harness;
    const created = await service.createSubscription({ name: "Provider A", url: URL_A });
    const subscriptionId = created.subscription.id;
    const members = (await repository.listProxies()).filter((proxy) => proxy.subscriptionId === subscriptionId);
    const nodeA = members.find((proxy) => proxy.name === "Node A")!;
    const nodeB = members.find((proxy) => proxy.name === "Node B")!;
    const plainC = members.find((proxy) => proxy.name === "Plain C")!;

    const environment = await repository.createEnvironment(defaultProfile({ name: "Bound env" }));
    await repository.updateEnvironment(environment.id, { proxyId: nodeA.id });
    // B is the front of a chain the user built by hand.
    await repository.updateProxy(plainC.id, { preProxyId: nodeB.id });

    // The provider drops every node the user relies on.
    bodies[URL_A] = VMESS_D;
    const refreshed = await service.refresh(subscriptionId);
    assert.equal(refreshed.result.detached, 2);
    assert.equal(refreshed.result.removed, 1, "only the unused member (C, which is itself in the chain as the tail, not the front) goes");
    assert.equal(refreshed.result.added, 1);

    const proxies = await repository.listProxies();
    const aAfter = proxies.find((proxy) => proxy.id === nodeA.id);
    const bAfter = proxies.find((proxy) => proxy.id === nodeB.id);
    assert.ok(aAfter, "the bound node survives");
    assert.equal(aAfter?.subscriptionId, "");
    assert.ok(bAfter, "the chained front survives");
    assert.equal(bAfter?.subscriptionId, "");
    assert.equal(proxies.some((proxy) => proxy.id === plainC.id), false);
    assert.equal((await repository.getEnvironment(environment.id))?.proxyId, nodeA.id);

    // Now standalone, A is left alone when the provider lists it again: no duplicate, no re-adoption.
    bodies[URL_A] = [VLESS_A, VMESS_D].join("\n");
    const next = await service.refresh(subscriptionId);
    assert.equal(next.result.skipped, 1);
    assert.equal(next.result.added, 0);
    assert.equal(next.result.kept, 1);
    const finalProxies = await repository.listProxies();
    assert.equal(finalProxies.filter((proxy) => proxy.host === "a.example.com").length, 1);
    assert.equal(finalProxies.find((proxy) => proxy.id === nodeA.id)?.subscriptionId, "");
  } finally {
    await harness.dispose();
  }
});

test("standalone proxies are never touched by a refresh, and a plain import of the address is adopted once remembered", async () => {
  const bodies: Record<string, string> = { [URL_A]: [VLESS_A, TROJAN_B].join("\n") };
  const harness = await makeHarness(bodies);
  try {
    const { repository, service } = harness;
    const own = await repository.createProxy({ scheme: "xray", shareLink: VLESS_A, name: "My own A" });

    const plain = await service.importSubscription(URL_A);
    assert.equal(plain.subscription, undefined);
    assert.equal(plain.imported.length, 1, "A already exists as the user's own proxy");
    assert.equal(plain.skipped, 1);
    assert.equal(plain.imported[0].notes, subscriptionNote(URL_A));
    assert.equal(plain.imported[0].notes, "订阅：sub.example.com", "the note names the host, never the token");
    assert.equal(plain.imported[0].subscriptionId, "");

    const remembered = await service.importSubscription(URL_A, { remember: {} });
    assert.equal(remembered.adopted, 1, "the plain import's node joins the subscription");
    assert.equal(remembered.imported.length, 0);
    assert.equal(remembered.skipped, 1, "the user's own copy of A stays standalone");
    assert.equal(remembered.subscription?.name, "sub.example.com");
    const subscriptionId = remembered.subscription!.id;
    const adopted = (await repository.listProxies()).find((proxy) => proxy.id === plain.imported[0].id);
    assert.equal(adopted?.subscriptionId, subscriptionId);
    assert.equal(adopted?.notes, "");

    bodies[URL_A] = VMESS_D;
    const refreshed = await service.refresh(subscriptionId);
    assert.equal(refreshed.result.removed, 1);
    assert.equal(refreshed.result.added, 1);
    const ownAfter = (await repository.listProxies()).find((proxy) => proxy.id === own.id);
    assert.equal(ownAfter?.name, "My own A");
    assert.equal(ownAfter?.subscriptionId, "");
  } finally {
    await harness.dispose();
  }
});

test("a failed read is recorded on the subscription and nothing is remembered for an unreadable address", async () => {
  const bodies: Record<string, string | Error> = { [URL_A]: [VLESS_A].join("\n") };
  const harness = await makeHarness(bodies);
  try {
    const { repository, service } = harness;
    await assert.rejects(service.createSubscription({ url: "https://down.example.com/sub" }), /HTTP 404/);
    assert.equal((await repository.listProxySubscriptions()).length, 0);
    await assert.rejects(service.createSubscription({ url: "ftp://sub.example.com/x" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROXY_SUBSCRIPTION_URL_INVALID");
      return true;
    });

    const created = await service.createSubscription({ url: URL_A });
    bodies[URL_A] = new Error("订阅下载失败：fetch failed");
    await assert.rejects(service.refresh(created.subscription.id), /fetch failed/);
    let subscription = await repository.getProxySubscription(created.subscription.id);
    assert.equal(subscription?.lastRefresh?.ok, false);
    assert.match(subscription?.lastRefresh?.error ?? "", /fetch failed/);
    assert.equal((await repository.listProxies()).length, 1, "a failed read changes no proxy");

    bodies[URL_A] = "<!DOCTYPE html><html><body>Please sign in</body></html>";
    await assert.rejects(service.refresh(created.subscription.id), /网页/);
    subscription = await repository.getProxySubscription(created.subscription.id);
    assert.match(subscription?.lastRefresh?.error ?? "", /网页/);
    assert.equal((await repository.listProxies()).length, 1);
  } finally {
    await harness.dispose();
  }
});

test("the scheduler only refreshes enabled auto-refresh subscriptions whose interval has elapsed", async () => {
  const URL_B = "https://other.example.com/sub";
  const URL_C = "https://manual.example.com/sub";
  const clock = { now: new Date("2026-09-08T00:00:00.000Z") };
  const bodies: Record<string, string> = { [URL_A]: VLESS_A, [URL_B]: TROJAN_B, [URL_C]: SOCKS_C };
  const harness = await makeHarness(bodies, clock);
  try {
    const { repository, service, fetched } = harness;
    const a = await service.createSubscription({ name: "A", url: URL_A, autoRefresh: true, refreshIntervalHours: 6 });
    const b = await service.createSubscription({ name: "B", url: URL_B, autoRefresh: true, refreshIntervalHours: 1 });
    await service.createSubscription({ name: "C", url: URL_C, autoRefresh: false, refreshIntervalHours: 1 });
    fetched.length = 0;

    assert.equal(isRefreshDue({ lastRefresh: undefined, refreshIntervalHours: 1 }, clock.now), true);
    assert.equal(isRefreshDue(a.subscription, clock.now), false);

    clock.now = new Date("2026-09-08T02:00:00.000Z");
    let results = await service.refreshAll({ onlyDue: true });
    assert.deepEqual(results.map((entry) => entry.name), ["B"]);
    assert.deepEqual(fetched, [URL_B]);

    clock.now = new Date("2026-09-08T07:00:00.000Z");
    await repository.updateProxySubscription(b.subscription.id, { status: "disabled" });
    fetched.length = 0;
    results = await service.refreshAll({ onlyDue: true });
    assert.deepEqual(results.map((entry) => entry.name), ["A"]);

    // A manual "refresh all" ignores the interval and the auto flag, but still skips disabled ones.
    fetched.length = 0;
    results = await service.refreshAll();
    assert.deepEqual(results.map((entry) => entry.name).sort(), ["A", "C"]);
    assert.equal(results.every((entry) => entry.result.ok), true);
  } finally {
    await harness.dispose();
  }
});
