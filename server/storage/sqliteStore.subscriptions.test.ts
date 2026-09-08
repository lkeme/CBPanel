import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "./sqliteStore";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_A = `vless://${UUID}@a.example.com:443?security=tls&type=ws&path=%2Fws#Node%20A`;
const VLESS_A_RENAMED = `vless://${UUID}@a.example.com:443?security=tls&type=ws&path=%2Fws#Renamed`;
const VLESS_OTHER = `vless://${UUID}@other.example.com:443?security=tls&type=ws&path=%2Fws#Other`;

async function makeRepository(): Promise<{ repository: SqlitePanelRepository; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-subscription-store-"));
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await repository.initialize();
  return { repository, directory };
}

test("subscriptions are stored with their address kept secret and validated", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const created = await repository.createProxySubscription({ url: "https://sub.example.com/link?token=secret", autoRefresh: true, refreshIntervalHours: 6 });
    assert.equal(created.name, "sub.example.com", "the host is the default name");
    assert.equal(created.url, "https://sub.example.com/link?token=secret");
    assert.equal(created.urlHost, "sub.example.com");
    assert.equal(created.status, "enabled");
    assert.equal(created.autoRefresh, true);
    assert.equal(created.refreshIntervalHours, 6);

    const listed = await repository.listProxySubscriptions();
    assert.equal(listed[0].url, "");
    assert.equal(listed[0].urlHost, "sub.example.com");
    const withSecrets = await repository.listProxySubscriptions({ includeSecrets: true });
    assert.equal(withSecrets[0].url, "https://sub.example.com/link?token=secret");

    await assert.rejects(repository.createProxySubscription({ url: "not a url" }), /订阅地址无效/);
    await assert.rejects(repository.createProxySubscription({ url: "ftp://x.example.com/sub" }), /http/);
    await assert.rejects(repository.createProxySubscription({ url: "https://sub.example.com/link?token=secret" }), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "PROXY_SUBSCRIPTION_EXISTS");
      return true;
    });

    // A blank address in a patch means "unchanged", the way a masked password does.
    const updated = await repository.updateProxySubscription(created.id, { name: "Renamed", url: "", refreshIntervalHours: 0 });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.url, "https://sub.example.com/link?token=secret");
    assert.equal(updated.refreshIntervalHours, 1, "intervals are clamped to at least an hour");

    const refreshed = await repository.saveProxySubscriptionRefresh(created.id, {
      checkedAt: "2026-09-08T00:00:00.000Z", ok: true, added: 2, kept: 0, removed: 0, detached: 0, skipped: 0, failed: 0, total: 2,
    });
    assert.equal(refreshed.lastRefresh?.added, 2);
    assert.equal(refreshed.updatedAt, updated.updatedAt, "a refresh is an observation, not an edit");
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("editing a member's node detaches it from its subscription; renaming or chaining it does not", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const subscription = await repository.createProxySubscription({ url: "https://sub.example.com/a" });
    const member = await repository.createProxy({ scheme: "xray", shareLink: VLESS_A, subscriptionId: subscription.id });
    assert.equal(member.subscriptionId, subscription.id);
    const front = await repository.createProxy({ scheme: "socks5", host: "10.0.0.1", port: "1080" });

    const renamed = await repository.updateProxy(member.id, { name: "Mine", preProxyId: front.id, ipStrategy: "ipv4-only", notes: "note" });
    assert.equal(renamed.subscriptionId, subscription.id);
    const remarked = await repository.updateProxy(member.id, { shareLink: VLESS_A_RENAMED });
    assert.equal(remarked.subscriptionId, subscription.id, "a remark is not the node");

    const edited = await repository.updateProxy(member.id, { shareLink: VLESS_OTHER });
    assert.equal(edited.subscriptionId, "");

    const copy = await repository.duplicateProxy(member.id);
    assert.equal(copy.subscriptionId, "");

    const nativeMember = await repository.createProxy({ scheme: "socks5", host: "10.0.0.2", port: "1080", subscriptionId: subscription.id });
    assert.equal((await repository.updateProxy(nativeMember.id, { port: "1081" })).subscriptionId, "");
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("deleting a subscription keeps members in use and can delete the rest", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const subscription = await repository.createProxySubscription({ url: "https://sub.example.com/a" });
    const bound = await repository.createProxy({ scheme: "xray", shareLink: VLESS_A, subscriptionId: subscription.id });
    const unused = await repository.createProxy({ scheme: "xray", shareLink: VLESS_OTHER, subscriptionId: subscription.id });
    const front = await repository.createProxy({ scheme: "socks5", host: "10.0.0.1", port: "1080", subscriptionId: subscription.id });
    const chained = await repository.createProxy({ scheme: "socks5", host: "10.0.0.3", port: "1080", preProxyId: front.id });
    const environment = await repository.createEnvironment(defaultProfile({ name: "Bound" }));
    await repository.updateEnvironment(environment.id, { proxyId: bound.id });

    const usage = await repository.listProxyUsage();
    assert.deepEqual(usage.get(bound.id)?.environmentIds, [environment.id]);
    assert.deepEqual(usage.get(front.id)?.chainedProxyIds, [chained.id]);
    assert.equal(usage.has(unused.id), false);

    const outcome = await repository.deleteProxySubscription(subscription.id, { proxies: "delete" });
    assert.deepEqual(outcome.deleted, [unused.id]);
    assert.deepEqual(outcome.detached.sort(), [bound.id, front.id].sort());
    assert.equal((await repository.listProxySubscriptions()).length, 0);
    const proxies = await repository.listProxies();
    assert.equal(proxies.some((proxy) => proxy.id === unused.id), false);
    assert.equal(proxies.find((proxy) => proxy.id === bound.id)?.subscriptionId, "");
    assert.equal(proxies.find((proxy) => proxy.id === front.id)?.subscriptionId, "");
    assert.equal(proxies.find((proxy) => proxy.id === chained.id)?.preProxyId, front.id, "the chain is intact");

    const keep = await repository.createProxySubscription({ url: "https://sub.example.com/b" });
    const kept = await repository.createProxy({ scheme: "xray", shareLink: VLESS_OTHER, subscriptionId: keep.id });
    const keepOutcome = await repository.deleteProxySubscription(keep.id, { proxies: "keep" });
    assert.deepEqual(keepOutcome, { detached: [kept.id], deleted: [] });
    assert.equal((await repository.listProxies()).find((proxy) => proxy.id === kept.id)?.subscriptionId, "");

    await assert.rejects(repository.deleteProxySubscription("missing", { proxies: "keep" }), /订阅不存在/);
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a full backup carries subscriptions, and a backup without them leaves every proxy standalone", async () => {
  const source = await makeRepository();
  const target = await makeRepository();
  try {
    const subscription = await source.repository.createProxySubscription({ name: "Provider", url: "https://sub.example.com/a?token=t" });
    const member = await source.repository.createProxy({ scheme: "xray", shareLink: VLESS_A, subscriptionId: subscription.id });
    const backup = await source.repository.exportFullBackupData();
    assert.equal(backup.proxySubscriptions?.length, 1);
    assert.equal(backup.proxySubscriptions?.[0].url, "https://sub.example.com/a?token=t");

    await target.repository.restoreFullBackupData(backup);
    const restoredSubscriptions = await target.repository.listProxySubscriptions({ includeSecrets: true });
    assert.equal(restoredSubscriptions[0]?.id, subscription.id);
    assert.equal(restoredSubscriptions[0]?.url, "https://sub.example.com/a?token=t");
    assert.equal((await target.repository.listProxies()).find((proxy) => proxy.id === member.id)?.subscriptionId, subscription.id);

    const { proxySubscriptions: _dropped, ...legacy } = backup;
    await target.repository.restoreFullBackupData(legacy);
    assert.equal((await target.repository.listProxySubscriptions()).length, 0);
    assert.equal((await target.repository.listProxies()).find((proxy) => proxy.id === member.id)?.subscriptionId, "");
  } finally {
    source.repository.close();
    target.repository.close();
    await fs.rm(source.directory, { recursive: true, force: true });
    await fs.rm(target.directory, { recursive: true, force: true });
  }
});
