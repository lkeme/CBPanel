import assert from "node:assert/strict";
import test from "node:test";
import type { BrowserEnvironment, ProxyEntity, TrashEnvironment } from "../../shared/entities";
import { matchesQuery, proxyHaystack, statHaystack, trashHaystack } from "./registrySearch";

function proxyFixture(patch: Partial<ProxyEntity> = {}): ProxyEntity {
  return {
    id: "proxy-1",
    name: "美西住宅",
    scheme: "socks5",
    host: "us-west.residential.example.com",
    port: "1080",
    username: "",
    password: "",
    bypass: "",
    notes: "",
    status: "enabled",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...patch,
  };
}

test("statHaystack covers name and description and skips missing fields", () => {
  assert.equal(statHaystack({ name: "广告投放", count: 0, running: 0 }), "广告投放");
  assert.equal(
    statHaystack({ name: "广告投放", count: 0, running: 0, description: "投放与素材测试" }),
    "广告投放 投放与素材测试",
  );
});

test("proxyHaystack matches the address, notes, and username shown on the row", () => {
  const proxy = proxyFixture({ username: "alice", password: "s3cret", notes: "白名单已加" });
  const haystack = proxyHaystack({ id: proxy.id, name: proxy.name, count: 0, running: 0 }, proxy);

  for (const term of ["美西住宅", "socks5", "us-west.residential.example.com", "1080", "alice", "白名单已加"]) {
    assert.equal(matchesQuery(haystack, term), true, `expected to match ${term}`);
  }
});

test("proxyHaystack never exposes the proxy password to search", () => {
  const proxy = proxyFixture({ username: "alice", password: "s3cret" });
  const haystack = proxyHaystack({ id: proxy.id, name: proxy.name, count: 0, running: 0 }, proxy);

  assert.equal(haystack.includes("s3cret"), false);
  assert.equal(matchesQuery(haystack, "s3cret"), false);
});

test("proxyHaystack finds host:port even when credentials sit inside the masked address", () => {
  const withAuth = proxyFixture({ username: "alice", password: "s3cret" });
  const haystack = proxyHaystack({ id: withAuth.id, name: withAuth.name, count: 0, running: 0 }, withAuth);

  assert.equal(matchesQuery(haystack, "us-west.residential.example.com:1080"), true);
  assert.equal(matchesQuery(haystack, "socks5://us-west.residential.example.com:1080"), true);
});

test("proxyHaystack falls back to the stat fields when the entity is missing", () => {
  assert.equal(proxyHaystack({ name: "10.0.0.1:8080", count: 0, running: 0 }), "10.0.0.1:8080");
});

test("matchesQuery treats a blank query as matching everything and ignores case", () => {
  assert.equal(matchesQuery("Cookie Editor", "   "), true);
  assert.equal(matchesQuery("Cookie Editor", "COOKIE"), true);
  assert.equal(matchesQuery("Cookie Editor", "  editor "), true);
  assert.equal(matchesQuery("Cookie Editor", "firefox"), false);
});

function trashFixture(patch: Partial<TrashEnvironment> = {}): TrashEnvironment {
  return {
    environment: { id: "env-1", name: "亚马逊主号" } as BrowserEnvironment,
    deletedAt: "2026-07-20T02:30:00.000Z",
    ...patch,
  };
}

test("trashHaystack covers the name, the delete reason, and the rendered timestamp", () => {
  const haystack = trashHaystack(trashFixture({ deleteReason: "指纹冲突" }), "2026/7/20 10:30:00");

  assert.equal(matchesQuery(haystack, "亚马逊主号"), true);
  assert.equal(matchesQuery(haystack, "指纹冲突"), true);
  assert.equal(matchesQuery(haystack, "2026/7/20"), true);
  assert.equal(matchesQuery(haystack, "不存在的词"), false);
});

test("trashHaystack skips a missing delete reason instead of printing undefined", () => {
  const haystack = trashHaystack(trashFixture(), "2026/7/20 10:30:00");

  assert.equal(haystack.includes("undefined"), false);
  assert.equal(haystack, "亚马逊主号 2026/7/20 10:30:00");
});

test("trashHaystack keeps the row's field order so a query can span two fields", () => {
  const haystack = trashHaystack(trashFixture({ deleteReason: "指纹冲突" }), "2026/7/20 10:30:00");

  assert.equal(haystack, "亚马逊主号 2026/7/20 10:30:00 指纹冲突");
  assert.equal(matchesQuery(haystack, "10:30:00 指纹"), true);
});
