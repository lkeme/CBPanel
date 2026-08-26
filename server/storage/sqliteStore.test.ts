import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { defaultProfile } from "../../src/shared/profile";
import { SqlitePanelRepository } from "./sqliteStore";

const STORE_ID = "dhdgffkkebhmkfjojejmpbldmpobfkfo";

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

test("profile names stay unique across create, update, and import, and copies take a numbered suffix", async () => {
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

  repository.close();
});

test("a name held by a trashed environment is refused with its own code, not the plain duplicate one", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const trashed = await repository.createProfile({ name: "Trashed Name" });
  const survivor = await repository.createProfile({ name: "Survivor" });
  await repository.deleteProfile(trashed.id);

  // The occupier is invisible to listProfiles, so the code has to say where it is or the panel cannot
  // tell the user what to do about it.
  await assert.rejects(
    () => repository.createProfile({ name: " trashed name " }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE_IN_TRASH",
  );
  await assert.rejects(
    () => repository.updateProfile(survivor.id, { name: "TRASHED NAME" }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE_IN_TRASH",
  );
  await assert.rejects(
    () => repository.importProfiles([{ name: "Trashed Name" }]),
    (error: unknown) => (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE_IN_TRASH",
  );

  // An active occupier keeps the plain code, so the two cases stay distinguishable.
  await assert.rejects(
    () => repository.createProfile({ name: "Survivor" }),
    (error: unknown) => (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE",
  );

  // Emptying the trash is the escape the message promises.
  await repository.clearTrashEnvironments();
  const reused = await repository.createProfile({ name: "Trashed Name" });
  assert.equal(reused.name, "Trashed Name");

  repository.close();
});

// Two rows holding one normalized name is unreachable through the checked API — the check itself refuses the
// second — so the fixture goes in the one way that writes rows verbatim: restoreFullBackupData, which is what
// a hand-edited .cbpb reaches. With both an active and a trashed holder present, an unordered `LIMIT 1` picked
// whichever the scan reached first, so the user was told to go and empty the trash over a name they can see
// occupied in the list. The active occupier is the actionable answer and wins.
test("with an active and a trashed holder of one name, the active occupier is the one reported", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });

  const active = await repository.createProfile({ name: "Shared Name" });
  const trashed = await repository.createProfile({ name: "Placeholder" });
  await repository.deleteProfile(trashed.id);
  const backup = await repository.exportFullBackupData();
  await repository.restoreFullBackupData({
    ...backup,
    profiles: backup.profiles.map((profile) => (profile.id === trashed.id ? { ...profile, name: "Shared Name" } : profile)),
    environments: backup.environments.map((environment) => (environment.id === trashed.id
      ? { ...environment, name: "Shared Name", runtimeProfile: { ...environment.runtimeProfile, name: "Shared Name" } }
      : environment)),
  });

  // The state the ordering is about: the same name held twice, once in the list and once in the trash.
  assert.deepEqual((await repository.listProfiles()).map((profile) => profile.name), ["Shared Name"]);
  assert.deepEqual((await repository.listTrashEnvironments()).map((item) => item.environment.name), ["Shared Name"]);
  await assert.rejects(
    () => repository.createProfile({ name: " shared name " }),
    (error: unknown) => (error as { status?: number; code?: string }).status === 409
      && (error as { status?: number; code?: string }).code === "PROFILE_NAME_DUPLICATE",
  );
  // And renaming the one visible holder out of the way leaves only the trashed one, which then answers.
  await repository.updateProfile(active.id, { name: "Renamed" });
  await assert.rejects(
    () => repository.createProfile({ name: "Shared Name" }),
    (error: unknown) => (error as { code?: string }).code === "PROFILE_NAME_DUPLICATE_IN_TRASH",
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

test("extension bindings keep stable lifecycle revisions until an actual unbind and rebind", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Lifecycle Binding" });
  const extension = await repository.createExtension({
    name: "Lifecycle Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
  });

  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const first = (await repository.listEnvironmentExtensionBindings(profile.id))[0];
  assert.ok(first?.lifecycleRevision);
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  assert.equal((await repository.listEnvironmentExtensionBindings(profile.id))[0]?.lifecycleRevision, first.lifecycleRevision);

  await repository.unbindExtensionFromEnvironments(extension.id, [profile.id]);
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const rebound = (await repository.listEnvironmentExtensionBindings(profile.id))[0];
  assert.ok(rebound?.lifecycleRevision);
  assert.notEqual(rebound.lifecycleRevision, first.lifecycleRevision);
  repository.close();
});

test("extension acquisition settings persist across SQLite reopen", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await repository.saveSettings({
    extensionAcquisition: {
      crxsosoSearchEnabled: false,
      googleArtifactEnabled: true,
      crxsosoArtifactEnabled: false,
      crxsosoDisclosureVersionAccepted: 1,
    },
  });
  repository.close();

  const reopened = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  assert.deepEqual((await reopened.getSettings()).extensionAcquisition, {
    crxsosoSearchEnabled: false,
    googleArtifactEnabled: true,
    crxsosoArtifactEnabled: false,
    crxsosoDisclosureVersionAccepted: 1,
  });
  reopened.close();
});

test("explicit extension unbind validates every environment before deleting any binding", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Atomic Unbind" });
  const extension = await repository.createExtension({
    name: "Atomic Unbind Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);

  await assert.rejects(
    repository.unbindExtensionFromEnvironments(extension.id, [profile.id, "missing-environment"]),
    (error) => (error as { status?: number }).status === 404,
  );

  assert.deepEqual(
    (await repository.listEnvironmentExtensionBindings(profile.id)).map((binding) => binding.extensionId),
    [extension.id],
  );
  repository.close();
});

test("environment package binding metadata must name an actual mapped binding even without a revision", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const environment = await repository.createEnvironment({ name: "Unbound Package Pair" });
  const extension = await repository.createExtension({
    name: "Unbound Package Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
  });
  const groups = await repository.listGroups();
  const beforeEnvironmentIds = (await repository.listEnvironments()).map((item) => item.id);
  const beforeExtensionIds = (await repository.listExtensions()).map((item) => item.id);

  await assert.rejects(repository.importEnvironmentPackage({
    environments: [environment],
    groups,
    extensions: [extension],
    environmentExtensionBindings: [{
      environmentId: environment.id,
      extensionId: extension.id,
    }],
  }), /unbound entity pair/);

  assert.deepEqual((await repository.listEnvironments()).map((item) => item.id), beforeEnvironmentIds);
  assert.deepEqual((await repository.listExtensions()).map((item) => item.id), beforeExtensionIds);
  repository.close();
});

test("a database predating lifecycle revisions gains the nullable binding column without inventing revisions", async () => {
  const directory = await makeTempDir();
  const databasePath = path.join(directory, "cbpanel.sqlite");
  const fresh = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await fresh.createProfile({ name: "Legacy Binding" });
  const extension = await fresh.createExtension({
    name: "Legacy Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
  });
  await fresh.bindExtensionToEnvironments(extension.id, [profile.id]);
  fresh.close();

  const raw = new DatabaseSync(databasePath);
  raw.exec("ALTER TABLE environment_extensions DROP COLUMN lifecycle_revision");
  raw.close();

  const upgraded = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const binding = (await upgraded.listEnvironmentExtensionBindings(profile.id))[0];
  assert.equal(binding?.extensionId, extension.id);
  assert.equal(binding?.lifecycleRevision, undefined);
  await upgraded.bindExtensionToEnvironments(extension.id, [profile.id]);
  assert.equal((await upgraded.listEnvironmentExtensionBindings(profile.id))[0]?.lifecycleRevision, undefined);
  upgraded.close();
});

test("full backup restore rejects unknown binding metadata even when its revision is omitted", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Binding Metadata Validation" });
  const extension = await repository.createExtension({
    name: "Binding Metadata Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  const backup = await repository.exportFullBackupData();
  backup.environmentExtensionBindings = [{
    environmentId: "missing-environment",
    extensionId: extension.id,
  }];

  await assert.rejects(repository.restoreFullBackupData(backup), /binding metadata references an unknown entity/);
  assert.ok(await repository.getEnvironment(profile.id));
  assert.ok(await repository.getExtension(extension.id));
  repository.close();
});

test("trashed environments neither block extension deletes nor survive as bindings", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Trashed Extension Profile" });
  const extension = await repository.createExtension({
    name: "Orphan Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
    localPath: path.join(directory, "extension"),
  });
  await repository.bindExtensionToEnvironments(extension.id, [profile.id]);
  await repository.deleteProfile(profile.id);

  await repository.deleteExtension(extension.id);
  assert.equal((await repository.listExtensions()).length, 0);

  const restored = await repository.restoreEnvironment(profile.id);
  assert.deepEqual(restored.extensionIds, []);
  assert.deepEqual((await repository.getEnvironment(profile.id))?.extensionIds, []);

  repository.close();
});

test("binding an extension to a trashed environment is a 404", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const profile = await repository.createProfile({ name: "Soon Trashed" });
  const extension = await repository.createExtension({
    name: "Bindable Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "extension"),
    installState: "installed",
    localPath: path.join(directory, "extension"),
  });
  await repository.deleteProfile(profile.id);

  await assert.rejects(repository.bindExtensionToEnvironments(extension.id, [profile.id]), (error) => {
    assert.equal((error as { status?: number }).status, 404);
    return true;
  });
  const restored = await repository.restoreEnvironment(profile.id);
  assert.deepEqual(restored.extensionIds, []);

  repository.close();
});

test("extension rows normalize directory mode per source kind and round-trip the manifest key", async () => {
  const directory = await makeTempDir();
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const legacyDirectory = await repository.createExtension({
    name: "Legacy Directory Extension",
    sourceKind: "local-directory",
    sourceUrl: path.join(directory, "legacy"),
    localPath: path.join(directory, "legacy"),
    installState: "installed",
    manifestKey: "legacy-manifest-key",
  });
  const remote = await repository.createExtension({
    name: "Remote Extension",
    sourceKind: "remote-zip",
    sourceUrl: "https://example.test/extension.zip",
    directoryMode: "copy",
    installState: "download-pending",
  });

  assert.equal(legacyDirectory.directoryMode, "reference");
  assert.equal(legacyDirectory.manifestKey, "legacy-manifest-key");
  assert.equal(remote.directoryMode, undefined);

  const flipped = await repository.updateExtension(legacyDirectory.id, { sourceKind: "local-zip" });
  assert.equal(flipped.directoryMode, undefined);
  assert.equal(flipped.manifestKey, "legacy-manifest-key");

  // insertExtensionExact writes directory_mode verbatim, so this restores a legacy NULL column.
  const exported = await repository.exportFullBackupData();
  await repository.restoreFullBackupData({
    ...exported,
    extensions: exported.extensions.map((item) => ({
      ...item,
      sourceKind: item.id === legacyDirectory.id ? ("local-directory" as const) : item.sourceKind,
      directoryMode: undefined,
    })),
  });
  const restored = await repository.listExtensions();
  const rereadDirectory = restored.find((item) => item.id === legacyDirectory.id);
  assert.equal(rereadDirectory?.directoryMode, "reference");
  assert.equal(rereadDirectory?.manifestKey, "legacy-manifest-key");
  assert.equal(restored.find((item) => item.id === remote.id)?.directoryMode, undefined);

  repository.close();
});

test("a data directory predating the manifest fingerprint column opens and gains the column", async () => {
  const directory = await makeTempDir();
  const databasePath = path.join(directory, "cbpanel.sqlite");

  // Fresh data directory: CREATE TABLE already declares manifest_sha256, so ensureColumn is a no-op.
  const fresh = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const created = await fresh.createExtension({
    name: "Fingerprinted Extension",
    sourceKind: "local-zip",
    sourceUrl: path.join(directory, "package.zip"),
    manifestSha256: `  ${"AB".repeat(32)}  `,
    installState: "installed",
  });
  // Normalized like sha256: trimmed and lower-cased so both sides of a match compare equal.
  assert.equal(created.manifestSha256, "ab".repeat(32));
  fresh.close();

  // Rewind the schema to the shape an installation created before this change still has on disk.
  const raw = new DatabaseSync(databasePath);
  raw.exec("ALTER TABLE extensions DROP COLUMN manifest_sha256");
  assert.equal(extensionColumns(raw).includes("manifest_sha256"), false);
  raw.close();

  // Reopening runs ensureColumn, which adds it back without disturbing the surviving row.
  const upgraded = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const legacyRow = (await upgraded.listExtensions()).find((item) => item.id === created.id);
  assert.equal(legacyRow?.name, "Fingerprinted Extension");
  assert.equal(legacyRow?.manifestSha256, undefined);
  const refilled = await upgraded.updateExtension(created.id, { manifestSha256: "cd".repeat(32) });
  assert.equal(refilled.manifestSha256, "cd".repeat(32));
  upgraded.close();

  // Opening a third time proves ensureColumn is idempotent rather than failing on an existing column.
  const reopened = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  assert.equal((await reopened.getExtension(created.id))?.manifestSha256, "cd".repeat(32));
  reopened.close();

  const verify = new DatabaseSync(databasePath);
  assert.equal(extensionColumns(verify).includes("manifest_sha256"), true);
  verify.close();
});

test("extension acquisition authority round-trips without changing legacy store projections", async () => {
  const directory = await makeTempDir();
  const artifactArchivePath = path.join(directory, "extension-artifacts", "extension-store", "current.crx");
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const created = await repository.createExtension({
    id: "extension-store",
    name: "Verified Store Extension",
    sourceKind: "local-crx",
    sourceUrl: artifactArchivePath,
    sha256: "a".repeat(64),
    manifestSha256: "c".repeat(64),
    storeIdentity: {
      namespace: "chrome-web-store",
      storeId: STORE_ID,
      listingUrl: `https://chromewebstore.google.com/detail/${STORE_ID}`,
    },
    provenance: {
      schemaVersion: 1,
      catalog: { providerId: "crxsoso", observedAt: "2026-08-26T00:00:00.000Z" },
      artifact: {
        providerId: "chrome-web-store",
        finalByteHost: "clients2.googleusercontent.com",
        fetchedAt: "2026-08-26T00:00:01.000Z",
        format: "crx3",
        size: 123,
        sha256: "a".repeat(64),
        retained: true,
      },
      verification: {
        level: "cws-publisher-verified",
        verifiedAt: "2026-08-26T00:00:02.000Z",
        proofDerivedStoreId: STORE_ID,
        developerKeySha256: "b".repeat(64),
        publisherKeySha256: "e".repeat(64),
        publisherTrustRootId: "chromium-cws",
        publisherTrustRootVersion: 1,
        manifestSha256: "c".repeat(64),
        treeSha256: "d".repeat(64),
      },
    },
    artifactArchivePath,
    updateProviderId: "chrome-web-store",
    updateState: {
      status: "available",
      checkedAt: "2026-08-26T01:00:00.000Z",
      availableVersion: "5.5.0",
    },
    installState: "installed",
  });
  assert.equal(created.storeId, STORE_ID);
  assert.equal(created.storeUrl, `https://chromewebstore.google.com/detail/${STORE_ID}`);
  repository.close();

  const reopened = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const stored = await reopened.getExtension(created.id);
  assert.deepEqual(stored?.storeIdentity, created.storeIdentity);
  assert.deepEqual(stored?.provenance, created.provenance);
  assert.equal(stored?.artifactArchivePath, artifactArchivePath);
  assert.equal(stored?.updateProviderId, "chrome-web-store");
  assert.deepEqual(stored?.updateState, created.updateState);

  const internalSnapshot = await reopened.exportFullBackupData();
  await reopened.restoreFullBackupData(internalSnapshot);
  const exactRestored = await reopened.getExtension(created.id);
  assert.deepEqual(exactRestored?.storeIdentity, created.storeIdentity);
  assert.deepEqual(exactRestored?.provenance, created.provenance);
  assert.equal(exactRestored?.artifactArchivePath, artifactArchivePath);
  assert.equal(exactRestored?.updateProviderId, "chrome-web-store");

  const legacy = await reopened.createExtension({
    name: "Legacy Metadata",
    sourceKind: "chrome-web-store",
    storeId: "abcdefghijklmnop",
    storeUrl: "https://legacy.example.test/detail/abcdefghijklmnop",
  });
  assert.equal(legacy.storeIdentity, undefined);
  assert.equal(legacy.storeId, "abcdefghijklmnop");
  reopened.close();
});

test("older extension tables gain nullable acquisition columns without invented trust", async () => {
  const directory = await makeTempDir();
  const databasePath = path.join(directory, "cbpanel.sqlite");
  const fresh = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const legacy = await fresh.createExtension({
    name: "Legacy Extension",
    sourceKind: "chrome-web-store",
    storeId: "abcdefghijklmnop",
    storeUrl: "https://legacy.example.test/detail/abcdefghijklmnop",
  });
  fresh.close();

  const raw = new DatabaseSync(databasePath);
  for (const column of [
    "store_namespace",
    "provenance_json",
    "artifact_archive_path",
    "update_provider_id",
    "update_state_json",
  ]) {
    raw.exec(`ALTER TABLE extensions DROP COLUMN ${column}`);
  }
  raw.close();

  const upgraded = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const restored = await upgraded.getExtension(legacy.id);
  assert.equal(restored?.storeId, "abcdefghijklmnop");
  assert.equal(restored?.storeIdentity, undefined);
  assert.equal(restored?.provenance, undefined);
  assert.equal(restored?.artifactArchivePath, undefined);
  assert.equal(restored?.updateProviderId, undefined);
  assert.equal(restored?.updateState, undefined);
  upgraded.close();

  const verify = new DatabaseSync(databasePath);
  const columns = extensionColumns(verify);
  for (const column of [
    "store_namespace",
    "provenance_json",
    "artifact_archive_path",
    "update_provider_id",
    "update_state_json",
  ]) {
    assert.equal(columns.includes(column), true, column);
  }
  verify.close();
});

test("malformed or unknown persisted acquisition authority fails closed", async () => {
  const directory = await makeTempDir();
  const databasePath = path.join(directory, "cbpanel.sqlite");
  const repository = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  const created = await repository.createExtension({ name: "Damaged", sourceKind: "local-directory" });
  repository.close();

  const raw = new DatabaseSync(databasePath);
  raw.prepare("UPDATE extensions SET provenance_json = ? WHERE id = ?").run("{bad json", created.id);
  raw.close();
  const malformed = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await assert.rejects(malformed.getExtension(created.id), /Stored JSON is invalid/);
  malformed.close();

  const unknown = new DatabaseSync(databasePath);
  unknown.prepare("UPDATE extensions SET provenance_json = ? WHERE id = ?").run(JSON.stringify({
    schemaVersion: 1,
    artifact: { providerId: "unknown", format: "crx3", retained: false },
    verification: { level: "legacy-unknown" },
  }), created.id);
  unknown.close();
  const rejected = new SqlitePanelRepository({ dataDir: directory, seed: () => [] });
  await assert.rejects(rejected.getExtension(created.id), (error: unknown) => {
    assert.equal((error as { code?: string }).code, "EXTENSION_ACQUISITION_CONTRACT_INVALID");
    return true;
  });
  rejected.close();
});

function extensionColumns(db: DatabaseSync): string[] {
  return (db.prepare("PRAGMA table_info(extensions)").all() as Array<{ name: string }>).map((row) => row.name);
}

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
