import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "./sqliteStore";

test("empty SQLite store seeds default profiles and settings", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory });

  const profiles = await repository.listProfiles();
  const settings = await repository.getSettings();
  const info = await repository.getInfo();

  assert.equal(profiles.length, 2);
  assert.equal(settings.storage.primary, "sqlite");
  assert.equal(info.kind, "sqlite");
  assert.equal(info.migratedFromJson, false);

  repository.close();
});

test("valid legacy profiles.json migrates into SQLite and creates a backup copy", async () => {
  const directory = await makeTempDir();
  const legacyProfile = defaultProfile({
    name: "Legacy",
    group: "Migrated",
  });
  await fs.writeFile(
    path.join(directory, "profiles.json"),
    `${JSON.stringify({ profiles: [legacyProfile] }, null, 2)}\n`,
    "utf8",
  );

  const repository = new SqlitePanelRepository({ dataDir: directory });
  const profiles = await repository.listProfiles();
  const info = await repository.getInfo();

  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].name, "Legacy");
  assert.equal(info.migratedFromJson, true);
  assert.ok(info.migrationBackupPath);
  assert.equal(await fileExists(info.migrationBackupPath!), true);

  repository.close();
});

test("existing SQLite profiles prevent repeated automatic JSON migration", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory });
  const created = await repository.createProfile({ name: "SQLite First" });
  repository.close();

  await fs.writeFile(
    path.join(directory, "profiles.json"),
    `${JSON.stringify({ profiles: [defaultProfile({ name: "Legacy Later" })] }, null, 2)}\n`,
    "utf8",
  );

  const reopened = new SqlitePanelRepository({ dataDir: directory });
  const profiles = await reopened.listProfiles();

  assert.equal(profiles.some((profile) => profile.id === created.id), true);
  assert.equal(profiles.some((profile) => profile.name === "Legacy Later"), false);

  reopened.close();
});

test("corrupt legacy profiles.json does not prevent seed creation or delete the JSON", async () => {
  const directory = await makeTempDir();
  const legacyPath = path.join(directory, "profiles.json");
  await fs.writeFile(legacyPath, "{", "utf8");

  const repository = new SqlitePanelRepository({ dataDir: directory });
  const profiles = await repository.listProfiles();
  const info = await repository.getInfo();

  assert.equal(profiles.length, 2);
  assert.equal(await fs.readFile(legacyPath, "utf8"), "{");
  assert.match(info.migrationError ?? "", /解析失败/);

  repository.close();
});

test("profile CRUD, duplicate, import, and export round-trip through normalization", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const created = await repository.createProfile({ name: "  Created  ", tags: [" a ", ""] });
  const updated = await repository.updateProfile(created.id, { group: "  QA  " });
  const duplicated = await repository.duplicateProfile(created.id);
  const imported = await repository.importProfiles([{ name: "Imported", id: created.id }]);
  const exported = await repository.exportProfiles();

  assert.equal(created.name, "Created");
  assert.deepEqual(created.tags, ["a"]);
  assert.equal(updated.group, "QA");
  assert.notEqual(duplicated.id, created.id);
  assert.equal(imported.imported, 1);
  assert.equal(new Set(exported.profiles.map((profile) => profile.id)).size, exported.profiles.length);

  await repository.deleteProfile(created.id);
  assert.equal(await repository.getProfile(created.id), undefined);

  repository.close();
});

test("profile names are unique across active and trash environments", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const first = await repository.createProfile({ name: "Unique Name" });
  await assert.rejects(
    () => repository.createProfile({ name: " unique name " }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE",
  );

  await repository.updateProfile(first.id, { notes: "same profile keeps its own name" });
  await assert.rejects(
    () => repository.importProfiles([{ name: "UNIQUE NAME" }]),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE",
  );

  const second = await repository.createProfile({ name: "Second Name" });
  await assert.rejects(
    () => repository.updateProfile(second.id, { name: " unique name " }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE",
  );

  const copyOne = await repository.duplicateProfile(first.id);
  const copyTwo = await repository.duplicateProfile(first.id);
  assert.equal(copyOne.name, "Unique Name 副本");
  assert.equal(copyTwo.name, "Unique Name 副本 2");

  await repository.deleteProfile(first.id);
  await assert.rejects(
    () => repository.createProfile({ name: "Unique Name" }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE",
  );

  repository.close();
});

test("profile facade projects groups, tags, and active environments", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const created = await repository.createProfile({
    name: "Registry Profile",
    group: "Research",
    tags: ["alpha", "beta"],
  });
  const [environment] = await repository.listEnvironments();
  const groups = await repository.listGroups();
  const tags = await repository.listTags();

  assert.equal(environment.id, created.id);
  assert.equal(environment.name, "Registry Profile");
  assert.equal(groups.some((group) => group.name === "Research"), true);
  assert.equal(tags.some((tag) => tag.name === "alpha"), true);
  assert.equal(tags.some((tag) => tag.name === "beta"), true);
  assert.equal(environment.tagIds.length, 2);

  repository.close();
});

test("profile delete soft-deletes environment while preserving trash restore", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const created = await repository.createProfile({ name: "Trash Me" });
  await repository.deleteProfile(created.id);

  assert.equal(await repository.getProfile(created.id), undefined);
  assert.equal((await repository.listProfiles()).length, 0);

  const trash = await repository.listTrashEnvironments();
  assert.equal(trash.length, 1);
  assert.equal(trash[0].environment.id, created.id);

  const restored = await repository.restoreEnvironment(created.id);
  assert.equal(restored.id, created.id);
  assert.equal((await repository.listProfiles()).length, 1);
  assert.equal((await repository.listTrashEnvironments()).length, 0);

  await repository.deleteProfile(created.id);
  await repository.permanentlyDeleteEnvironment(created.id);
  assert.equal((await repository.listTrashEnvironments()).length, 0);

  repository.close();
});

test("environment facade supports CRUD, duplicate, soft delete, and trash clearing", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const created = await repository.createEnvironment({ name: "Environment A", group: "Ops" });
  const updated = await repository.updateEnvironment(created.id, { name: "Environment B", tags: ["live"] });
  const duplicated = await repository.duplicateEnvironment(created.id);

  assert.equal(created.name, "Environment A");
  assert.equal(updated.name, "Environment B");
  assert.deepEqual(updated.runtimeProfile.tags, ["live"]);
  assert.notEqual(duplicated.id, created.id);
  assert.equal((await repository.listEnvironments()).length, 2);

  await repository.softDeleteEnvironment(created.id, "test-clear");
  assert.equal(await repository.getProfile(created.id), undefined);
  assert.equal((await repository.listTrashEnvironments()).length, 1);

  const cleared = await repository.clearTrashEnvironments();
  assert.equal(cleared.deleted, 1);
  assert.equal((await repository.listTrashEnvironments()).length, 0);
  assert.equal(await repository.getEnvironment(created.id), undefined);
  assert.equal((await repository.listEnvironments()).length, 1);

  repository.close();
});

test("proxy registry masks secrets by default and keeps full secrets for internal reads", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  await repository.createProxy({
    name: "Proxy Profile",
    scheme: "http",
    host: "example.test",
    port: "8080",
    username: "alice",
    password: "secret",
  });

  const masked = await repository.listProxies();
  const full = await repository.listProxies({ includeSecrets: true });

  assert.equal(masked.length, 1);
  assert.equal(masked[0].host, "example.test");
  assert.equal(masked[0].username, "alice");
  assert.equal(masked[0].password, "");
  assert.equal(full[0].password, "secret");

  repository.close();
});

test("environment network checks persist across profile facade updates", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({ name: "Network Check" });
  const checked = await repository.saveEnvironmentNetworkCheck(profile.id, {
    checkedAt: "2026-06-03T00:00:00.000Z",
    ok: true,
    ip: "203.0.113.10",
    latencyMs: 123,
    geo: {
      countryCode: "JP",
      timezone: "Asia/Tokyo",
      locale: "ja-JP",
    },
    source: "environment-check",
  });

  assert.equal(checked.lastNetworkCheck?.ok, true);
  assert.equal(checked.lastNetworkCheck?.ip, "203.0.113.10");
  assert.equal(checked.lastNetworkCheck?.geo?.timezone, "Asia/Tokyo");

  await repository.updateProfile(profile.id, { notes: "keep the check" });
  const updated = await repository.getEnvironment(profile.id);

  assert.equal(updated?.lastNetworkCheck?.ip, "203.0.113.10");
  assert.equal(updated?.lastNetworkCheck?.geo?.locale, "ja-JP");

  repository.close();
});

test("proxy registry rejects unsupported proxy schemes", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  await assert.rejects(
    repository.createProxy({
      name: "Unsupported Proxy",
      scheme: "socks5h" as never,
      host: "proxy.example.test",
      port: "1080",
    }),
    (error) => {
      assert.equal((error as { status?: number }).status, 400);
      return true;
    },
  );

  repository.close();
});

test("registry create methods ignore blank ids instead of overwriting existing rows", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const firstProfile = await repository.createProfile({ id: "", name: "Profile A" });
  const secondProfile = await repository.createProfile({ id: "", name: "Profile B" });
  const profiles = await repository.listProfiles();
  assert.notEqual(firstProfile.id, "");
  assert.notEqual(secondProfile.id, "");
  assert.notEqual(firstProfile.id, secondProfile.id);
  assert.equal(profiles.some((profile) => profile.name === "Profile A"), true);
  assert.equal(profiles.some((profile) => profile.name === "Profile B"), true);

  const firstGroup = await repository.createGroup({ id: "", name: "Group A" });
  const secondGroup = await repository.createGroup({ id: "", name: "Group B" });
  const groups = await repository.listGroups();
  assert.notEqual(firstGroup.id, "");
  assert.notEqual(secondGroup.id, "");
  assert.notEqual(firstGroup.id, secondGroup.id);
  assert.equal(groups.some((group) => group.name === "Group A"), true);
  assert.equal(groups.some((group) => group.name === "Group B"), true);

  const firstTag = await repository.createTag({ id: "   ", name: "Tag A" });
  const secondTag = await repository.createTag({ id: "   ", name: "Tag B" });
  const tags = await repository.listTags();
  assert.notEqual(firstTag.id, secondTag.id);
  assert.equal(tags.some((tag) => tag.name === "Tag A"), true);
  assert.equal(tags.some((tag) => tag.name === "Tag B"), true);

  const firstProxy = await repository.createProxy({
    id: "",
    name: "Proxy A",
    scheme: "http",
    host: "proxy-a.example.test",
    port: "8080",
  });
  const secondProxy = await repository.createProxy({
    id: "",
    name: "Proxy B",
    scheme: "http",
    host: "proxy-b.example.test",
    port: "8081",
  });
  const proxies = await repository.listProxies({ includeSecrets: true });
  assert.notEqual(firstProxy.id, secondProxy.id);
  assert.equal(proxies.some((proxy) => proxy.name === "Proxy A"), true);
  assert.equal(proxies.some((proxy) => proxy.name === "Proxy B"), true);

  const firstExtension = await repository.createExtension({
    id: "",
    name: "Extension A",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension-a"),
  });
  const secondExtension = await repository.createExtension({
    id: "",
    name: "Extension B",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension-b"),
  });
  const extensions = await repository.listExtensions();
  assert.notEqual(firstExtension.id, secondExtension.id);
  assert.equal(extensions.some((extension) => extension.name === "Extension A"), true);
  assert.equal(extensions.some((extension) => extension.name === "Extension B"), true);

  const firstSource = await repository.createExtensionSource({
    id: "",
    name: "Source A",
    url: "https://extensions-a.example.test/index.json",
  });
  const secondSource = await repository.createExtensionSource({
    id: "",
    name: "Source B",
    url: "https://extensions-b.example.test/index.json",
  });
  const sources = await repository.listExtensionSources();
  assert.notEqual(firstSource.id, secondSource.id);
  assert.equal(sources.some((source) => source.name === "Source A"), true);
  assert.equal(sources.some((source) => source.name === "Source B"), true);

  repository.close();
});

test("registry create methods reject duplicate ids instead of upserting existing rows", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({ id: "profile-duplicate", name: "Profile A" });
  await assertDuplicateId(repository.createProfile({ id: profile.id, name: "Profile B" }));
  assert.equal((await repository.getProfile(profile.id))?.name, "Profile A");

  const group = await repository.createGroup({ id: "group-duplicate", name: "Group A" });
  await assertDuplicateId(repository.createGroup({ id: group.id, name: "Group B" }));
  assert.equal((await repository.listGroups()).find((item) => item.id === group.id)?.name, "Group A");

  const tag = await repository.createTag({ id: "tag-duplicate", name: "Tag A" });
  await assertDuplicateId(repository.createTag({ id: tag.id, name: "Tag B" }));
  assert.equal((await repository.listTags()).find((item) => item.id === tag.id)?.name, "Tag A");

  const proxy = await repository.createProxy({
    id: "proxy-duplicate",
    name: "Proxy A",
    scheme: "http",
    host: "proxy-a.example.test",
    port: "8080",
  });
  await assertDuplicateId(
    repository.createProxy({
      id: proxy.id,
      name: "Proxy B",
      scheme: "http",
      host: "proxy-b.example.test",
      port: "8081",
    }),
  );
  assert.equal((await repository.listProxies({ includeSecrets: true })).find((item) => item.id === proxy.id)?.name, "Proxy A");

  const extension = await repository.createExtension({
    id: "extension-duplicate",
    name: "Extension A",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension-a"),
  });
  await assertDuplicateId(
    repository.createExtension({
      id: extension.id,
      name: "Extension B",
      sourceKind: "local-directory",
      sourceUrl: path.join(directory, "extension-b"),
    }),
  );
  assert.equal((await repository.listExtensions()).find((item) => item.id === extension.id)?.name, "Extension A");

  const source = await repository.createExtensionSource({
    id: "extension-source-duplicate",
    name: "Source A",
    url: "https://extensions-a.example.test/index.json",
  });
  await assertDuplicateId(
    repository.createExtensionSource({
      id: source.id,
      name: "Source B",
      url: "https://extensions-b.example.test/index.json",
    }),
  );
  assert.equal((await repository.listExtensionSources()).find((item) => item.id === source.id)?.name, "Source A");

  repository.close();
});

test("referenced group and proxy deletes return reference conflicts", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({
    group: "Referenced",
  });
  const proxy = await repository.createProxy({
    name: "Referenced Proxy",
    scheme: "http",
    host: "proxy.example.test",
    port: "8080",
  });
  await repository.updateEnvironment(profile.id, { proxyId: proxy.id });
  const group = (await repository.listGroups()).find((item) => item.name === "Referenced");

  assert.ok(group);
  await assert.rejects(repository.deleteGroup(group.id), (error) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { code?: string }).code, "REFERENCE_CONFLICT");
    assert.deepEqual((error as { usage?: { environmentIds: string[] } }).usage?.environmentIds, [profile.id]);
    return true;
  });
  await assert.rejects(repository.deleteProxy(proxy.id), (error) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { code?: string }).code, "REFERENCE_CONFLICT");
    return true;
  });

  repository.close();
});

test("environment local proxies do not create proxy registry records", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({
    proxy: {
      ...defaultProfile().proxy,
      enabled: true,
      host: "local.example.test",
      port: "8080",
    },
  });

  const proxies = await repository.listProxies({ includeSecrets: true });
  const environment = await repository.getEnvironment(profile.id);
  const projected = await repository.getProfile(profile.id);

  assert.equal(proxies.some((proxy) => proxy.host === "local.example.test"), false);
  assert.equal(environment?.proxyId, undefined);
  assert.equal(projected?.proxy.host, "local.example.test");

  repository.close();
});

test("explicit proxy registry binding projects into the profile facade", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({ name: "Managed Proxy Environment" });
  const proxy = await repository.createProxy({
    name: "Managed Proxy",
    scheme: "http",
    host: "managed.example.test",
    port: "8081",
    username: "operator",
    password: "secret",
  });

  const environment = await repository.updateEnvironment(profile.id, { proxyId: proxy.id });
  const projected = await repository.getProfile(profile.id);

  assert.equal(environment.proxyId, proxy.id);
  assert.equal(projected?.proxy.enabled, true);
  assert.equal(projected?.proxy.host, "managed.example.test");
  assert.equal(projected?.proxy.username, "operator");

  repository.close();
});

test("group and tag merges refresh profile facade projection", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({
    group: "Old Group",
    tags: ["old-tag"],
  });
  const targetGroup = await repository.createGroup({ name: "New Group" });
  const sourceGroup = (await repository.listGroups()).find((item) => item.name === "Old Group");
  const targetTag = await repository.createTag({ name: "new-tag" });
  const sourceTag = (await repository.listTags()).find((item) => item.name === "old-tag");

  assert.ok(sourceGroup);
  assert.ok(sourceTag);
  await repository.mergeGroup(sourceGroup.id, targetGroup.id);
  await repository.mergeTag(sourceTag.id, targetTag.id);

  const updated = await repository.getProfile(profile.id);
  assert.equal(updated?.group, "New Group");
  assert.deepEqual(updated?.tags, ["new-tag"]);

  repository.close();
});

test("proxy replacement refreshes profile facade and removes proxy when unbound", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({ name: "Replace Proxy" });
  const oldProxy = await repository.createProxy({
    name: "Old Proxy",
    scheme: "http",
    host: "old.example.test",
    port: "8080",
  });
  const newProxy = await repository.createProxy({
    name: "New Proxy",
    scheme: "http",
    host: "new.example.test",
    port: "8081",
  });

  await repository.updateEnvironment(profile.id, { proxyId: oldProxy.id });
  await repository.replaceProxyReferences(oldProxy.id, newProxy.id);
  assert.equal((await repository.getProfile(profile.id))?.proxy.host, "new.example.test");

  await repository.replaceProxyReferences(newProxy.id);
  const unboundEnvironment = await repository.getEnvironment(profile.id);
  const unboundProfile = await repository.getProfile(profile.id);
  assert.equal(unboundEnvironment?.proxyId, undefined);
  assert.equal(unboundProfile?.proxy.enabled, true);
  assert.equal(unboundProfile?.proxy.host, "new.example.test");

  repository.close();
});

test("extension registry protects referenced deletes and projects installed paths", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const profile = await repository.createProfile({ name: "Extension Profile" });
  const extension = await repository.createExtension({
    name: "Local Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    version: "1.0.0",
    manifestVersion: 3,
    permissions: ["storage"],
    installState: "installed",
    localPath: path.join(directory, "extension"),
  });

  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);

  await assert.rejects(repository.deleteExtension(extension.id), (error) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { code?: string }).code, "REFERENCE_CONFLICT");
    assert.deepEqual((error as { usage?: { environmentIds: string[] } }).usage?.environmentIds, [profile.id]);
    return true;
  });

  const projected = await repository.getProfile(profile.id);
  assert.deepEqual(projected?.runtime.extensionPaths, [path.join(directory, "extension")]);

  await repository.unbindExtensionFromEnvironments(extension.id);
  await repository.deleteExtension(extension.id);
  assert.equal((await repository.listExtensions()).length, 0);

  repository.close();
});

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-sqlite-"));
}

async function assertDuplicateId(operation: Promise<unknown>): Promise<void> {
  await assert.rejects(operation, (error) => {
    assert.equal((error as { status?: number }).status, 409);
    assert.equal((error as { code?: string }).code, "ENTITY_ID_DUPLICATE");
    return true;
  });
}

async function fileExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}
