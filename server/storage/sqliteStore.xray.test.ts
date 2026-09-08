import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "./sqliteStore";

const UUID = "b831381d-6324-4d53-ad4f-8cda48b30811";
const VLESS_LINK = `vless://${UUID}@node.example.com:443?security=reality&pbk=SbVKOEMjK0sIlbwg4akyBg5mL5KZwwB-ed4eEE7YnRc&sni=www.microsoft.com&type=grpc&serviceName=svc#%E9%A6%99%E6%B8%AF%2001`;

async function makeRepository(): Promise<{ repository: SqlitePanelRepository; directory: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-xray-store-"));
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await repository.initialize();
  return { repository, directory };
}

test("an xray proxy is stored from its share link and read back without the secret", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const created = await repository.createProxy({ scheme: "xray", shareLink: VLESS_LINK, ipStrategy: "ipv6-first" });
    assert.equal(created.scheme, "xray");
    assert.equal(created.name, "香港 01");
    assert.equal(created.host, "node.example.com");
    assert.equal(created.port, "443");
    assert.equal(created.username, "");
    assert.equal(created.password, "");
    assert.equal(created.shareLink, VLESS_LINK);
    assert.equal(created.ipStrategy, "ipv6-first");
    assert.equal(created.xrayNode?.protocol, "vless");
    assert.equal(created.xrayNode?.network, "grpc");
    assert.equal(created.xrayNode?.security, "reality");

    const listed = (await repository.listProxies()).find((proxy) => proxy.id === created.id);
    assert.equal(listed?.shareLink, "");
    assert.equal(listed?.xrayNode?.protocol, "vless");
    assert.equal(listed?.host, "node.example.com");

    const withSecrets = (await repository.listProxies({ includeSecrets: true })).find((proxy) => proxy.id === created.id);
    assert.equal(withSecrets?.shareLink, VLESS_LINK);

    await assert.rejects(repository.createProxy({ scheme: "xray", shareLink: "vless://broken" }), (error: unknown) => {
      assert.equal((error as { status?: number }).status, 400);
      assert.match((error as Error).message, /Xray 分享链接无法解析/);
      return true;
    });
    await assert.rejects(repository.createProxy({ scheme: "xray", shareLink: "" }), /不能为空/);
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("updating with a masked share link keeps the real one, and self-chaining is refused", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const created = await repository.createProxy({ scheme: "xray", shareLink: VLESS_LINK });
    const updated = await repository.updateProxy(created.id, { name: "Renamed", shareLink: "vless://****@node.example.com:443" });
    assert.equal(updated.name, "Renamed");
    assert.equal(updated.shareLink, VLESS_LINK);
    await assert.rejects(repository.updateProxy(created.id, { preProxyId: created.id }), /不能是代理自身/);

    const plain = await repository.createProxy({ scheme: "socks5", host: "10.0.0.1", port: "1080", shareLink: "should-be-dropped" });
    assert.equal(plain.shareLink, "");
    assert.equal(plain.preProxyId, "");
    assert.equal(plain.ipStrategy, "auto");
    assert.equal(plain.xrayNode, undefined);
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("binding an environment to an xray proxy carries the engine fields into its runtime profile", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const front = await repository.createProxy({ name: "Front", scheme: "socks5", host: "front.example.com", port: "1080" });
    const node = await repository.createProxy({ scheme: "xray", shareLink: VLESS_LINK, preProxyId: front.id, ipStrategy: "ipv4-only" });
    const environment = await repository.createEnvironment(defaultProfile({ name: "Chained env" }));
    const bound = await repository.updateEnvironment(environment.id, { proxyId: node.id });
    assert.equal(bound.proxyId, node.id);
    assert.equal(bound.runtimeProfile.proxy.scheme, "xray");
    assert.equal(bound.runtimeProfile.proxy.shareLink, VLESS_LINK);
    assert.equal(bound.runtimeProfile.proxy.preProxyId, front.id);
    assert.equal(bound.runtimeProfile.proxy.ipStrategy, "ipv4-only");
    assert.equal(bound.runtimeProfile.proxy.host, "node.example.com");

    const profile = await repository.getProfile(environment.id);
    assert.equal(profile?.proxy.scheme, "xray");
    assert.equal(profile?.proxy.preProxyId, front.id);

    // Deleting the front proxy unwinds every chain that named it.
    await repository.deleteProxy(front.id);
    const nodeAfter = (await repository.listProxies()).find((proxy) => proxy.id === node.id);
    assert.equal(nodeAfter?.preProxyId, "");
    const environmentAfter = await repository.getEnvironment(environment.id);
    assert.equal(environmentAfter?.runtimeProfile.proxy.preProxyId, "");
    assert.equal((await repository.getProfile(environment.id))?.proxy.preProxyId, "");
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an environment's own chained proxy setting is unwound when the front proxy is deleted", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const front = await repository.createProxy({ name: "Front", scheme: "http", host: "front.example.com", port: "8080" });
    const environment = await repository.createEnvironment(defaultProfile({
      name: "Local chained env",
      proxy: { ...defaultProfile().proxy, enabled: true, scheme: "socks5", host: "10.0.0.2", port: "1080", preProxyId: front.id },
    }));
    assert.equal(environment.runtimeProfile.proxy.preProxyId, front.id);
    await repository.deleteProxy(front.id);
    assert.equal((await repository.getEnvironment(environment.id))?.runtimeProfile.proxy.preProxyId, "");
    assert.equal((await repository.getProfile(environment.id))?.proxy.preProxyId, "");
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a latency probe is stored without touching the proxy's updatedAt", async () => {
  const { repository, directory } = await makeRepository();
  try {
    const created = await repository.createProxy({ name: "Probe", scheme: "socks5", host: "10.0.0.1", port: "1080" });
    const saved = await repository.saveProxyLatencyResult(created.id, {
      checkedAt: "2026-09-06T10:00:00.000Z",
      ok: true,
      latencyMs: 42,
      target: "https://cp.cloudflare.com/generate_204",
    });
    assert.deepEqual(saved.lastLatency, {
      checkedAt: "2026-09-06T10:00:00.000Z",
      ok: true,
      latencyMs: 42,
      target: "https://cp.cloudflare.com/generate_204",
    });
    assert.equal(saved.updatedAt, created.updatedAt);
    const listed = (await repository.listProxies()).find((proxy) => proxy.id === created.id);
    assert.equal(listed?.lastLatency?.latencyMs, 42);
    // A later edit keeps the probe.
    const renamed = await repository.updateProxy(created.id, { name: "Probe 2" });
    assert.equal(renamed.lastLatency?.latencyMs, 42);
  } finally {
    repository.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a database written before the engine fields gains them with their defaults", async () => {
  const { repository, directory } = await makeRepository();
  repository.close();
  const database = new DatabaseSync(path.join(directory, "cbpanel.sqlite"));
  database.exec("ALTER TABLE proxies DROP COLUMN share_link");
  database.exec("ALTER TABLE proxies DROP COLUMN pre_proxy_id");
  database.exec("ALTER TABLE proxies DROP COLUMN ip_strategy");
  database.prepare(`
    INSERT INTO proxies (id, name, scheme, host, port, username, password, bypass, notes, status, last_check_json, created_at, updated_at)
    VALUES ('proxy-legacy', 'Legacy', 'http', 'legacy.example.com', '8080', 'u', 'p', '', '', 'enabled', NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
  `).run();
  database.close();

  const reopened = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  try {
    const legacy = (await reopened.listProxies({ includeSecrets: true })).find((proxy) => proxy.id === "proxy-legacy");
    assert.equal(legacy?.scheme, "http");
    assert.equal(legacy?.shareLink, "");
    assert.equal(legacy?.preProxyId, "");
    assert.equal(legacy?.ipStrategy, "auto");
    assert.equal(legacy?.password, "p");
    const upgraded = await reopened.updateProxy("proxy-legacy", { ipStrategy: "ipv4-first" });
    assert.equal(upgraded.ipStrategy, "ipv4-first");
  } finally {
    reopened.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
