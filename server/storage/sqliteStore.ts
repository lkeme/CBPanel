import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type BrowserProfile,
  createId,
  defaultProfile,
  normalizeProfile,
  normalizeProxyScheme,
  nowIso,
} from "../../src/shared/profile";
import type {
  BrowserEnvironment,
  EntityStatus,
  ExtensionEntity,
  ExtensionInstallState,
  ExtensionPermissionRisk,
  ExtensionSourceEntity,
  ExtensionSourceKind,
  ExtensionUpdatePolicy,
  GroupEntity,
  NetworkCheckResult,
  ReferenceUsage,
  ProxyCheckResult,
  ProxyEntity,
  TagEntity,
  TrashEnvironment,
} from "../../src/shared/entities";
import {
  type AppSettings,
  type StorageInfo,
  DEFAULT_APP_SETTINGS,
  mergeSettings,
  normalizeSettings,
} from "../../src/shared/settings";
import { seedProfiles } from "./seedProfiles";
import type { PanelRepository } from "./types";

type SqliteStoreOptions = {
  dataDir: string;
  databasePath?: string;
  legacyJsonPath?: string;
  portable?: boolean;
  seed?: () => BrowserProfile[];
};

type StoredData = {
  profiles: BrowserProfile[];
};

type ProfileRow = {
  id?: string;
  profile_json: string;
};

type EnvironmentRow = {
  id: string;
  name: string;
  notes: string;
  mode: BrowserProfile["mode"];
  start_url: string;
  group_id: string;
  proxy_id: string | null;
  runtime_profile_json: string;
  last_network_check_json: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  delete_reason: string | null;
};

type GroupRow = {
  id: string;
  name: string;
  color: string;
  description: string;
  sort_order: number;
  status: EntityStatus;
  is_default: number;
  created_at: string;
  updated_at: string;
};

type TagRow = {
  id: string;
  name: string;
  color: string;
  description: string;
  sort_order: number;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
};

type ProxyRow = {
  id: string;
  name: string;
  scheme: BrowserProfile["proxy"]["scheme"];
  host: string;
  port: string;
  username: string;
  password: string;
  bypass: string;
  notes: string;
  status: EntityStatus;
  last_check_json: string | null;
  created_at: string;
  updated_at: string;
};

type ExtensionRow = {
  id: string;
  name: string;
  description: string;
  source_kind: ExtensionSourceKind;
  source_url: string;
  source_id: string | null;
  store_id: string | null;
  store_url: string | null;
  version: string;
  manifest_version: number | null;
  permissions_json: string;
  host_permissions_json: string;
  permission_risks_json: string;
  install_state: ExtensionInstallState;
  update_policy: ExtensionUpdatePolicy;
  sha256: string | null;
  local_path: string | null;
  last_installed_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  status: EntityStatus;
  created_at: string;
  updated_at: string;
};

type ExtensionSourceRow = {
  id: string;
  name: string;
  url: string;
  status: EntityStatus;
  allow_unsigned_assets: number;
  last_refreshed_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
};

type IdRow = {
  id: string;
};

type SettingsRow = {
  settings_json: string;
};

type CountRow = {
  count: number;
};

type MetadataRow = {
  value: string;
};

export class SqlitePanelRepository implements PanelRepository {
  private readonly databasePath: string;
  private readonly legacyJsonPath: string;
  private readonly portable: boolean;
  private readonly seed: () => BrowserProfile[];
  private db?: DatabaseSync;
  private initialization?: Promise<void>;
  private migrationError?: string;

  constructor(options: SqliteStoreOptions) {
    this.databasePath = options.databasePath ?? path.join(options.dataDir, "cbpanel.sqlite");
    this.legacyJsonPath = options.legacyJsonPath ?? path.join(options.dataDir, "profiles.json");
    this.portable = options.portable ?? Boolean(process.env.CBPANEL_PORTABLE);
    this.seed = options.seed ?? seedProfiles;
  }

  async initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.initializeOnce();
    }
    await this.initialization;
  }

  async listProfiles(): Promise<BrowserProfile[]> {
    await this.initialize();
    return this.readProfiles();
  }

  async getProfile(id: string): Promise<BrowserProfile | undefined> {
    await this.initialize();
    const row = this.database()
      .prepare(`
        SELECT profile_json
        FROM profiles
        WHERE id = ?
          AND NOT EXISTS (
            SELECT 1 FROM browser_environments
            WHERE browser_environments.id = profiles.id
              AND browser_environments.deleted_at IS NOT NULL
          )
      `)
      .get(id) as ProfileRow | undefined;
    return row ? parseProfile(row.profile_json) : undefined;
  }

  async createProfile(profile: Partial<BrowserProfile>): Promise<BrowserProfile> {
    await this.initialize();
    const normalized = normalizeProfile(defaultProfile(profile));
    this.assertUniqueProfileName(normalized.name, normalized.id);
    this.insertProfile(normalized);
    this.markProfilesModified();
    return normalized;
  }

  async updateProfile(id: string, patch: Partial<BrowserProfile>): Promise<BrowserProfile> {
    await this.initialize();
    const existing = await this.getProfile(id);
    if (!existing) throw Object.assign(new Error("配置不存在"), { status: 404 });
    const updated = normalizeProfile({ ...existing, ...patch, id: existing.id, createdAt: existing.createdAt });
    this.assertUniqueProfileName(updated.name, updated.id);
    this.upsertProfile(updated);
    this.markProfilesModified();
    return updated;
  }

  async duplicateProfile(id: string): Promise<BrowserProfile> {
    await this.initialize();
    const existing = await this.getProfile(id);
    if (!existing) throw Object.assign(new Error("配置不存在"), { status: 404 });
    const copy = normalizeProfile({
      ...existing,
      id: undefined,
      name: this.nextProfileCopyName(existing.name),
      createdAt: undefined,
      updatedAt: undefined,
    });
    this.insertProfile(copy);
    this.markProfilesModified();
    return copy;
  }

  async deleteProfile(id: string): Promise<void> {
    await this.initialize();
    const existing = await this.getProfile(id);
    if (!existing) throw Object.assign(new Error("配置不存在"), { status: 404 });
    this.upsertEnvironmentFromProfile(existing);
    const deletedAt = nowIso();
    const result = this.database()
      .prepare("UPDATE browser_environments SET deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt, "profile-delete", deletedAt, id);
    if (Number(result.changes) === 0) throw Object.assign(new Error("配置不存在"), { status: 404 });
    this.markProfilesModified();
  }

  async importProfiles(profiles: unknown[]): Promise<{ imported: number; profiles: BrowserProfile[] }> {
    await this.initialize();
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const profile of profiles) {
        const normalized = normalizeProfile({ ...(profile as Partial<BrowserProfile>), id: undefined });
        this.assertUniqueProfileName(normalized.name, normalized.id);
        this.insertProfile(normalized);
      }
      this.markProfilesModified();
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { imported: profiles.length, profiles: this.readProfiles() };
  }

  async exportProfiles(): Promise<{ profiles: BrowserProfile[] }> {
    await this.initialize();
    return { profiles: this.readProfiles() };
  }

  async listEnvironments(): Promise<BrowserEnvironment[]> {
    await this.initialize();
    return this.readEnvironments({ includeDeleted: false });
  }

  async createEnvironment(profile: Partial<BrowserProfile>): Promise<BrowserEnvironment> {
    const created = await this.createProfile(profile);
    return this.environmentFromProfile(created);
  }

  async updateEnvironment(id: string, patch: Partial<BrowserProfile> & { proxyId?: string | null }): Promise<BrowserEnvironment> {
    await this.initialize();
    const { proxyId, ...profilePatch } = patch;
    const updated = await this.updateProfile(id, profilePatch);
    if (Object.prototype.hasOwnProperty.call(patch, "proxyId")) {
      this.setEnvironmentProxyReference(id, proxyId);
    }
    return this.getEnvironmentOrThrow(updated.id);
  }

  async duplicateEnvironment(id: string): Promise<BrowserEnvironment> {
    const duplicated = await this.duplicateProfile(id);
    return this.environmentFromProfile(duplicated);
  }

  async saveEnvironmentNetworkCheck(id: string, result: NetworkCheckResult): Promise<BrowserEnvironment> {
    await this.initialize();
    this.getEnvironmentOrThrow(id);
    const timestamp = nowIso();
    this.database()
      .prepare("UPDATE browser_environments SET last_network_check_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(result), timestamp, id);
    return this.getEnvironmentOrThrow(id);
  }

  async softDeleteEnvironment(id: string, reason = "environment-delete"): Promise<void> {
    await this.initialize();
    const existing = await this.getEnvironment(id);
    if (!existing || existing.deletedAt) throw Object.assign(new Error("环境不存在"), { status: 404 });
    if (reason === "profile-delete") {
      await this.deleteProfile(id);
      return;
    }
    const deletedAt = nowIso();
    this.database()
      .prepare("UPDATE browser_environments SET deleted_at = ?, delete_reason = ?, updated_at = ? WHERE id = ?")
      .run(deletedAt, reason.trim() || "environment-delete", deletedAt, id);
    this.markProfilesModified();
  }

  async listTrashEnvironments(): Promise<TrashEnvironment[]> {
    await this.initialize();
    return this.readEnvironments({ includeDeleted: true, onlyDeleted: true }).map((environment) => ({
      environment,
      deletedAt: environment.deletedAt ?? environment.updatedAt,
      deleteReason: environment.deleteReason,
    }));
  }

  async getEnvironment(id: string): Promise<BrowserEnvironment | undefined> {
    await this.initialize();
    const row = this.database()
      .prepare("SELECT * FROM browser_environments WHERE id = ?")
      .get(id) as EnvironmentRow | undefined;
    return row ? this.environmentFromRow(row) : undefined;
  }

  async restoreEnvironment(id: string): Promise<BrowserEnvironment> {
    await this.initialize();
    const existing = await this.getEnvironment(id);
    if (!existing) throw Object.assign(new Error("环境不存在"), { status: 404 });
    const restoredProfile = normalizeProfile({ ...existing.runtimeProfile, updatedAt: nowIso() });
    this.upsertProfile(restoredProfile);
    this.database()
      .prepare("UPDATE browser_environments SET deleted_at = NULL, delete_reason = NULL, updated_at = ? WHERE id = ?")
      .run(restoredProfile.updatedAt, id);
    return this.environmentFromProfile(restoredProfile);
  }

  async permanentlyDeleteEnvironment(id: string): Promise<void> {
    await this.initialize();
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare("DELETE FROM browser_environments WHERE id = ? AND deleted_at IS NOT NULL").run(id);
      if (Number(result.changes) === 0) throw Object.assign(new Error("回收站环境不存在"), { status: 404 });
      db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async clearTrashEnvironments(): Promise<{ deleted: number }> {
    await this.initialize();
    const trashIds = this.readEnvironments({ includeDeleted: true, onlyDeleted: true }).map((environment) => environment.id);
    if (trashIds.length === 0) return { deleted: 0 };
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const id of trashIds) {
        db.prepare("DELETE FROM browser_environments WHERE id = ? AND deleted_at IS NOT NULL").run(id);
        db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { deleted: trashIds.length };
  }

  async listGroups(): Promise<GroupEntity[]> {
    await this.initialize();
    return this.database()
      .prepare("SELECT * FROM groups ORDER BY sort_order ASC, name ASC")
      .all()
      .map((row) => groupFromRow(row as GroupRow));
  }

  async createGroup(input: Partial<GroupEntity>): Promise<GroupEntity> {
    await this.initialize();
    const timestamp = nowIso();
    const name = cleanRequiredName(input.name, "分组名称不能为空");
    const group: GroupEntity = {
      id: input.id ?? createId("group"),
      name,
      color: cleanColor(input.color, colorForName(name)),
      description: input.description?.trim() ?? "",
      order: Number.isFinite(input.order) ? Number(input.order) : this.nextSortOrder("groups"),
      status: input.status === "disabled" ? "disabled" : "enabled",
      isDefault: input.isDefault === true,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.insertGroup(group);
    return group;
  }

  async updateGroup(id: string, patch: Partial<GroupEntity>): Promise<GroupEntity> {
    await this.initialize();
    const existing = this.getGroupOrThrow(id);
    if (existing.isDefault && patch.status === "disabled") {
      throw Object.assign(new Error("默认分组不能停用"), { status: 409 });
    }
    const name = patch.name !== undefined ? cleanRequiredName(patch.name, "分组名称不能为空") : existing.name;
    const updated: GroupEntity = {
      ...existing,
      name,
      color: patch.color !== undefined ? cleanColor(patch.color, existing.color) : existing.color,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      order: Number.isFinite(patch.order) ? Number(patch.order) : existing.order,
      status: patch.status === "enabled" || patch.status === "disabled" ? patch.status : existing.status,
      isDefault: existing.isDefault,
      updatedAt: nowIso(),
    };
    this.insertGroup(updated);
    return updated;
  }

  async deleteGroup(id: string): Promise<void> {
    await this.initialize();
    const group = this.getGroupOrThrow(id);
    if (group.isDefault) throw Object.assign(new Error("默认分组不能删除"), { status: 409 });
    this.throwIfReferenced("group", id);
    this.database().prepare("DELETE FROM groups WHERE id = ?").run(id);
  }

  async mergeGroup(id: string, targetId: string): Promise<GroupEntity> {
    await this.initialize();
    if (id === targetId) throw Object.assign(new Error("不能合并到自身"), { status: 400 });
    const source = this.getGroupOrThrow(id);
    const target = this.getGroupOrThrow(targetId);
    const affected = rowsToIds(this.database(), "browser_environments", "group_id", source.id);
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE browser_environments SET group_id = ?, updated_at = ? WHERE group_id = ?").run(target.id, nowIso(), source.id);
      if (!source.isDefault) db.prepare("DELETE FROM groups WHERE id = ?").run(source.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.refreshProfilesFromEnvironments(affected);
    return target;
  }

  async listTags(): Promise<TagEntity[]> {
    await this.initialize();
    return this.database()
      .prepare("SELECT * FROM tags ORDER BY sort_order ASC, name ASC")
      .all()
      .map((row) => tagFromRow(row as TagRow));
  }

  async createTag(input: Partial<TagEntity>): Promise<TagEntity> {
    await this.initialize();
    const timestamp = nowIso();
    const name = cleanRequiredName(input.name, "标签名称不能为空");
    const tag: TagEntity = {
      id: input.id ?? createId("tag"),
      name,
      color: cleanColor(input.color, colorForName(name)),
      description: input.description?.trim() ?? "",
      order: Number.isFinite(input.order) ? Number(input.order) : this.nextSortOrder("tags"),
      status: input.status === "disabled" ? "disabled" : "enabled",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.insertTag(tag);
    return tag;
  }

  async updateTag(id: string, patch: Partial<TagEntity>): Promise<TagEntity> {
    await this.initialize();
    const existing = this.getTagOrThrow(id);
    const name = patch.name !== undefined ? cleanRequiredName(patch.name, "标签名称不能为空") : existing.name;
    const updated: TagEntity = {
      ...existing,
      name,
      color: patch.color !== undefined ? cleanColor(patch.color, existing.color) : existing.color,
      description: patch.description !== undefined ? patch.description.trim() : existing.description,
      order: Number.isFinite(patch.order) ? Number(patch.order) : existing.order,
      status: patch.status === "enabled" || patch.status === "disabled" ? patch.status : existing.status,
      updatedAt: nowIso(),
    };
    this.insertTag(updated);
    return updated;
  }

  async deleteTag(id: string): Promise<void> {
    await this.initialize();
    this.getTagOrThrow(id);
    this.throwIfReferenced("tag", id);
    this.database().prepare("DELETE FROM tags WHERE id = ?").run(id);
  }

  async mergeTag(id: string, targetId: string): Promise<TagEntity> {
    await this.initialize();
    if (id === targetId) throw Object.assign(new Error("不能合并到自身"), { status: 400 });
    this.getTagOrThrow(id);
    const target = this.getTagOrThrow(targetId);
    const affected = rowsToIds(this.database(), "environment_tags", "tag_id", id, "environment_id");
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      const rows = db.prepare("SELECT environment_id AS id FROM environment_tags WHERE tag_id = ?").all(id) as IdRow[];
      for (const row of rows) {
        db.prepare("INSERT OR IGNORE INTO environment_tags (environment_id, tag_id) VALUES (?, ?)").run(row.id, targetId);
      }
      db.prepare("DELETE FROM environment_tags WHERE tag_id = ?").run(id);
      db.prepare("DELETE FROM tags WHERE id = ?").run(id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.refreshProfilesFromEnvironments(affected);
    return target;
  }

  async assignTags(environmentIds: string[], tagIds: string[]): Promise<BrowserEnvironment[]> {
    await this.initialize();
    const cleanEnvironmentIds = uniqueStrings(environmentIds);
    const cleanTagIds = uniqueStrings(tagIds);
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const environmentId of cleanEnvironmentIds) this.getEnvironmentOrThrow(environmentId);
      for (const tagId of cleanTagIds) this.getTagOrThrow(tagId);
      for (const environmentId of cleanEnvironmentIds) {
        for (const tagId of cleanTagIds) {
          db.prepare("INSERT OR IGNORE INTO environment_tags (environment_id, tag_id) VALUES (?, ?)").run(environmentId, tagId);
        }
        this.syncProfileTagsFromEnvironment(environmentId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return cleanEnvironmentIds.map((id) => this.getEnvironmentOrThrow(id));
  }

  async removeTags(environmentIds: string[], tagIds: string[]): Promise<BrowserEnvironment[]> {
    await this.initialize();
    const cleanEnvironmentIds = uniqueStrings(environmentIds);
    const cleanTagIds = uniqueStrings(tagIds);
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const environmentId of cleanEnvironmentIds) {
        this.getEnvironmentOrThrow(environmentId);
        for (const tagId of cleanTagIds) {
          db.prepare("DELETE FROM environment_tags WHERE environment_id = ? AND tag_id = ?").run(environmentId, tagId);
        }
        this.syncProfileTagsFromEnvironment(environmentId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return cleanEnvironmentIds.map((id) => this.getEnvironmentOrThrow(id));
  }

  async listProxies(options: { includeSecrets?: boolean } = {}): Promise<ProxyEntity[]> {
    await this.initialize();
    return this.database()
      .prepare("SELECT * FROM proxies ORDER BY updated_at DESC")
      .all()
      .map((row) => proxyFromRow(row as ProxyRow, { includeSecrets: options.includeSecrets === true }));
  }

  async createProxy(input: Partial<ProxyEntity>): Promise<ProxyEntity> {
    await this.initialize();
    const timestamp = nowIso();
    const proxy = normalizeProxyEntity({
      ...input,
      id: input.id ?? createId("proxy"),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.insertProxy(proxy);
    return proxy;
  }

  async updateProxy(id: string, patch: Partial<ProxyEntity>): Promise<ProxyEntity> {
    await this.initialize();
    const existing = this.getProxyOrThrow(id, { includeSecrets: true });
    const updated = normalizeProxyEntity({
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
    this.insertProxy(updated);
    this.syncProfilesForProxy(id);
    return updated;
  }

  async duplicateProxy(id: string): Promise<ProxyEntity> {
    await this.initialize();
    const existing = this.getProxyOrThrow(id, { includeSecrets: true });
    const timestamp = nowIso();
    const copy = normalizeProxyEntity({
      ...existing,
      id: createId("proxy"),
      name: `${existing.name} copy`,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.insertProxy(copy);
    return copy;
  }

  async deleteProxy(id: string): Promise<void> {
    await this.initialize();
    this.getProxyOrThrow(id, { includeSecrets: false });
    this.throwIfReferenced("proxy", id);
    this.database().prepare("DELETE FROM proxies WHERE id = ?").run(id);
  }

  async replaceProxyReferences(id: string, targetId?: string): Promise<BrowserEnvironment[]> {
    await this.initialize();
    this.getProxyOrThrow(id, { includeSecrets: false });
    if (targetId) this.getProxyOrThrow(targetId, { includeSecrets: false });
    const affected = rowsToIds(this.database(), "browser_environments", "proxy_id", id);
    for (const environmentId of affected) {
      this.setEnvironmentProxyReference(environmentId, targetId ?? null);
    }
    return affected.map((environmentId) => this.getEnvironmentOrThrow(environmentId));
  }

  async saveProxyCheckResult(id: string, result: ProxyEntity["lastCheck"]): Promise<ProxyEntity> {
    await this.initialize();
    const existing = this.getProxyOrThrow(id, { includeSecrets: true });
    const updated = { ...existing, lastCheck: result, updatedAt: nowIso() };
    this.insertProxy(updated);
    return proxyFromRow(
      this.database().prepare("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow,
      { includeSecrets: false },
    );
  }

  async listExtensions(): Promise<ExtensionEntity[]> {
    await this.initialize();
    return this.database()
      .prepare("SELECT * FROM extensions ORDER BY updated_at DESC")
      .all()
      .map((row) => extensionFromRow(row as ExtensionRow));
  }

  async getExtension(id: string): Promise<ExtensionEntity | undefined> {
    await this.initialize();
    const row = this.database().prepare("SELECT * FROM extensions WHERE id = ?").get(id) as ExtensionRow | undefined;
    return row ? extensionFromRow(row) : undefined;
  }

  async createExtension(input: Partial<ExtensionEntity>): Promise<ExtensionEntity> {
    await this.initialize();
    const timestamp = nowIso();
    const extension = normalizeExtensionEntity({
      ...input,
      id: input.id ?? createId("extension"),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.insertExtension(extension);
    return extension;
  }

  async updateExtension(id: string, patch: Partial<ExtensionEntity>): Promise<ExtensionEntity> {
    await this.initialize();
    const existing = this.getExtensionOrThrow(id);
    const updated = normalizeExtensionEntity({
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
    this.insertExtension(updated);
    this.refreshProfilesFromEnvironments(rowsToIds(this.database(), "environment_extensions", "extension_id", id, "environment_id"));
    return updated;
  }

  async deleteExtension(id: string): Promise<void> {
    await this.initialize();
    this.getExtensionOrThrow(id);
    this.throwIfReferenced("extension", id);
    this.database().prepare("DELETE FROM extensions WHERE id = ?").run(id);
  }

  async bindExtensionToEnvironments(id: string, environmentIds: string[]): Promise<BrowserEnvironment[]> {
    await this.initialize();
    this.getExtensionOrThrow(id);
    const cleanEnvironmentIds = uniqueStrings(environmentIds);
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const environmentId of cleanEnvironmentIds) {
        this.getEnvironmentOrThrow(environmentId);
        db.prepare("INSERT OR IGNORE INTO environment_extensions (environment_id, extension_id) VALUES (?, ?)").run(environmentId, id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.refreshProfilesFromEnvironments(cleanEnvironmentIds);
    return cleanEnvironmentIds.map((environmentId) => this.getEnvironmentOrThrow(environmentId));
  }

  async unbindExtensionFromEnvironments(id: string, environmentIds?: string[]): Promise<BrowserEnvironment[]> {
    await this.initialize();
    this.getExtensionOrThrow(id);
    const affected = environmentIds
      ? uniqueStrings(environmentIds)
      : rowsToIds(this.database(), "environment_extensions", "extension_id", id, "environment_id");
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const environmentId of affected) {
        db.prepare("DELETE FROM environment_extensions WHERE environment_id = ? AND extension_id = ?").run(environmentId, id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    this.refreshProfilesFromEnvironments(affected);
    return affected.map((environmentId) => this.getEnvironmentOrThrow(environmentId));
  }

  async listExtensionSources(): Promise<ExtensionSourceEntity[]> {
    await this.initialize();
    return this.database()
      .prepare("SELECT * FROM extension_sources ORDER BY updated_at DESC")
      .all()
      .map((row) => extensionSourceFromRow(row as ExtensionSourceRow));
  }

  async getExtensionSource(id: string): Promise<ExtensionSourceEntity | undefined> {
    await this.initialize();
    const row = this.database().prepare("SELECT * FROM extension_sources WHERE id = ?").get(id) as ExtensionSourceRow | undefined;
    return row ? extensionSourceFromRow(row) : undefined;
  }

  async createExtensionSource(input: Partial<ExtensionSourceEntity>): Promise<ExtensionSourceEntity> {
    await this.initialize();
    const timestamp = nowIso();
    const source = normalizeExtensionSourceEntity({
      ...input,
      id: input.id ?? createId("extension-source"),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.insertExtensionSource(source);
    return source;
  }

  async updateExtensionSource(id: string, patch: Partial<ExtensionSourceEntity>): Promise<ExtensionSourceEntity> {
    await this.initialize();
    const existing = this.getExtensionSourceOrThrow(id);
    const updated = normalizeExtensionSourceEntity({
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: nowIso(),
    });
    this.insertExtensionSource(updated);
    return updated;
  }

  async deleteExtensionSource(id: string): Promise<void> {
    await this.initialize();
    this.getExtensionSourceOrThrow(id);
    const row = this.database()
      .prepare("SELECT COUNT(*) AS count FROM extensions WHERE source_id = ?")
      .get(id) as CountRow;
    if (Number(row.count) > 0) {
      throw Object.assign(new Error("Extension source is still referenced by extensions"), { status: 409 });
    }
    this.database().prepare("DELETE FROM extension_sources WHERE id = ?").run(id);
  }

  async getSettings(): Promise<AppSettings> {
    await this.initialize();
    const row = this.database()
      .prepare("SELECT settings_json FROM app_settings WHERE id = 'default'")
      .get() as SettingsRow | undefined;
    const settings = row ? parseSettings(row.settings_json) : DEFAULT_APP_SETTINGS;
    if (!row) this.writeSettings(settings);
    return settings;
  }

  async saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.initialize();
    const current = await this.getSettings();
    const next = mergeSettings(current, patch);
    this.writeSettings(next);
    return next;
  }

  async getInfo(): Promise<StorageInfo> {
    await this.initialize();
    return this.storageInfo();
  }

  async migrateLegacyJson(): Promise<StorageInfo> {
    await this.initialize();
    try {
      await this.migrateLegacyJsonIfNeeded({ explicit: true });
    } catch (error) {
      this.migrationError = (error as Error).message;
      throw error;
    }
    return this.storageInfo();
  }

  close(): void {
    this.db?.close();
    this.db = undefined;
    this.initialization = undefined;
  }

  private async initializeOnce(): Promise<void> {
    await fs.mkdir(path.dirname(this.databasePath), { recursive: true });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.applySchema();
    await this.migrateLegacyJsonIfNeeded({ explicit: false });
    if (this.profileCount() === 0) {
      this.replaceProfiles(this.seed());
      if (this.migrationError) this.setMetadata("seeded_after_migration_error", "true");
      this.setMetadata("seeded_at", nowIso());
    }
    this.syncRegistryFromProfiles();
    if (!this.getSettingsRow()) this.writeSettings(DEFAULT_APP_SETTINGS);
  }

  private applySchema(): void {
    this.database().exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id TEXT PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        profile_group TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('persistent', 'ephemeral')),
        launcher TEXT NOT NULL,
        proxy_enabled INTEGER NOT NULL CHECK (proxy_enabled IN (0, 1)),
        start_url TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        profile_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_profiles_group ON profiles(profile_group);
      CREATE INDEX IF NOT EXISTS idx_profiles_updated_at ON profiles(updated_at);
      CREATE INDEX IF NOT EXISTS idx_profiles_mode ON profiles(mode);
      CREATE INDEX IF NOT EXISTS idx_profiles_proxy_enabled ON profiles(proxy_enabled);

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        description TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        is_default INTEGER NOT NULL CHECK (is_default IN (0, 1)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL,
        description TEXT NOT NULL,
        sort_order INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS proxies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        scheme TEXT NOT NULL,
        host TEXT NOT NULL,
        port TEXT NOT NULL,
        username TEXT NOT NULL,
        password TEXT NOT NULL,
        bypass TEXT NOT NULL,
        notes TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        last_check_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extensions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_url TEXT NOT NULL,
        source_id TEXT,
        store_id TEXT,
        store_url TEXT,
        version TEXT NOT NULL,
        manifest_version INTEGER,
        permissions_json TEXT NOT NULL,
        host_permissions_json TEXT NOT NULL,
        permission_risks_json TEXT NOT NULL,
        install_state TEXT NOT NULL,
        update_policy TEXT NOT NULL,
        sha256 TEXT,
        local_path TEXT,
        last_installed_at TEXT,
        last_checked_at TEXT,
        last_error TEXT,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS extension_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        url TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('enabled', 'disabled')),
        allow_unsigned_assets INTEGER NOT NULL CHECK (allow_unsigned_assets IN (0, 1)),
        last_refreshed_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS browser_environments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        notes TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('persistent', 'ephemeral')),
        start_url TEXT NOT NULL,
        group_id TEXT NOT NULL,
        proxy_id TEXT,
        runtime_profile_json TEXT NOT NULL,
        last_network_check_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        delete_reason TEXT,
        FOREIGN KEY (group_id) REFERENCES groups(id),
        FOREIGN KEY (proxy_id) REFERENCES proxies(id)
      );

      CREATE TABLE IF NOT EXISTS environment_tags (
        environment_id TEXT NOT NULL,
        tag_id TEXT NOT NULL,
        PRIMARY KEY (environment_id, tag_id),
        FOREIGN KEY (environment_id) REFERENCES browser_environments(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id)
      );

      CREATE TABLE IF NOT EXISTS environment_extensions (
        environment_id TEXT NOT NULL,
        extension_id TEXT NOT NULL,
        PRIMARY KEY (environment_id, extension_id),
        FOREIGN KEY (environment_id) REFERENCES browser_environments(id) ON DELETE CASCADE,
        FOREIGN KEY (extension_id) REFERENCES extensions(id)
      );

      CREATE INDEX IF NOT EXISTS idx_browser_environments_group ON browser_environments(group_id);
      CREATE INDEX IF NOT EXISTS idx_browser_environments_proxy ON browser_environments(proxy_id);
      CREATE INDEX IF NOT EXISTS idx_browser_environments_deleted_at ON browser_environments(deleted_at);

      CREATE TABLE IF NOT EXISTS app_settings (
        id TEXT PRIMARY KEY CHECK (id = 'default'),
        settings_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS storage_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    this.ensureColumn("browser_environments", "last_network_check_json", "TEXT");
    this.setMigration("001_initial_sqlite_store");
    this.setMigration("002_registry_projection");
    this.setMigration("003_environment_network_check");
  }

  private async migrateLegacyJsonIfNeeded({ explicit }: { explicit: boolean }): Promise<void> {
    this.migrationError = undefined;
    if (this.profileCount() > 0 && !explicit) return;
    if (this.profileCount() > 0 && explicit && !this.canReplaceSeedAfterMigrationError()) {
      this.setMetadata("migrate_skipped_reason", "sqlite_already_has_profiles");
      return;
    }
    if (!(await pathExists(this.legacyJsonPath))) return;

    let parsed: Partial<StoredData>;
    try {
      parsed = JSON.parse(await fs.readFile(this.legacyJsonPath, "utf8")) as Partial<StoredData>;
    } catch (error) {
      this.migrationError = `旧 profiles.json 解析失败：${(error as Error).message}`;
      this.setMetadata("migration_error", this.migrationError);
      return;
    }

    if (!Array.isArray(parsed.profiles)) {
      this.migrationError = "旧 profiles.json 缺少 profiles 数组";
      this.setMetadata("migration_error", this.migrationError);
      return;
    }

    const profiles = parsed.profiles.map((profile) => normalizeProfile(profile));
    this.replaceProfiles(profiles);
    const backupPath = await this.backupLegacyJson();
    this.setMetadata("migrated_from_json", "true");
    this.setMetadata("migration_backup_path", backupPath);
    this.setMetadata("migration_error", "");
    this.setMetadata("seeded_after_migration_error", "");
  }

  private async backupLegacyJson(): Promise<string> {
    const parsed = path.parse(this.legacyJsonPath);
    const backupPath = path.join(parsed.dir, `${parsed.name}.migrated-${timestampForFile()}.json`);
    await fs.copyFile(this.legacyJsonPath, backupPath);
    return backupPath;
  }

  private readProfiles(): BrowserProfile[] {
    return this.database()
      .prepare(`
        SELECT id, profile_json
        FROM profiles
        WHERE NOT EXISTS (
          SELECT 1 FROM browser_environments
          WHERE browser_environments.id = profiles.id
            AND browser_environments.deleted_at IS NOT NULL
        )
        ORDER BY updated_at DESC
      `)
      .all()
      .map((row) => parseProfile((row as ProfileRow).profile_json));
  }

  private replaceProfiles(profiles: BrowserProfile[]): void {
    const db = this.database();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("DELETE FROM browser_environments");
      db.exec("DELETE FROM profiles");
      for (const profile of profiles) {
        this.insertProfile(profile);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  private insertProfile(profile: BrowserProfile): void {
    this.upsertProfile(normalizeProfile(profile));
  }

  private upsertProfile(profile: BrowserProfile): void {
    const normalized = normalizeProfile(profile);
    this.upsertProfileRow(normalized);
    this.upsertEnvironmentFromProfile(normalized);
  }

  private upsertProfileRow(profile: BrowserProfile): void {
    const normalized = normalizeProfile(profile);
    this.database()
      .prepare(`
        INSERT INTO profiles (
          id, name, profile_group, tags_json, mode, launcher, proxy_enabled,
          start_url, created_at, updated_at, profile_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          profile_group = excluded.profile_group,
          tags_json = excluded.tags_json,
          mode = excluded.mode,
          launcher = excluded.launcher,
          proxy_enabled = excluded.proxy_enabled,
          start_url = excluded.start_url,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          profile_json = excluded.profile_json
      `)
      .run(
        normalized.id,
        normalized.name,
        normalized.group,
        JSON.stringify(normalized.tags),
        normalized.mode,
        normalized.runtime.launcher,
        normalized.proxy.enabled ? 1 : 0,
        normalized.startUrl,
        normalized.createdAt,
        normalized.updatedAt,
        JSON.stringify(normalized),
      );
  }

  private syncRegistryFromProfiles(): void {
    for (const profile of this.readAllProfileRows()) {
      this.upsertEnvironmentFromProfile(profile);
    }
  }

  private readAllProfileRows(): BrowserProfile[] {
    return this.database()
      .prepare("SELECT profile_json FROM profiles ORDER BY updated_at DESC")
      .all()
      .map((row) => parseProfile((row as ProfileRow).profile_json));
  }

  private assertUniqueProfileName(name: string, profileId: string): void {
    const normalizedName = normalizeProfileNameKey(name);
    const duplicate = this.database()
      .prepare(`
        SELECT id
        FROM profiles
        WHERE lower(trim(name)) = ?
          AND id != ?
        LIMIT 1
      `)
      .get(normalizedName, profileId) as { id: string } | undefined;
    if (duplicate) {
      const error = Object.assign(new Error("Profile 名称不能重复"), {
        status: 409,
        code: "PROFILE_NAME_DUPLICATE",
      });
      throw error;
    }
  }

  private nextProfileCopyName(baseName: string): string {
    const cleanBase = baseName.trim() || "Profile";
    const names = new Set(this.readAllProfileRows().map((profile) => normalizeProfileNameKey(profile.name)));
    const first = `${cleanBase} 副本`;
    if (!names.has(normalizeProfileNameKey(first))) return first;
    for (let index = 2; index < 10_000; index += 1) {
      const candidate = `${first} ${index}`;
      if (!names.has(normalizeProfileNameKey(candidate))) return candidate;
    }
    return `${first} ${Date.now()}`;
  }

  private readEnvironments(options: { includeDeleted: boolean; onlyDeleted?: boolean }): BrowserEnvironment[] {
    const where = options.onlyDeleted
      ? "WHERE deleted_at IS NOT NULL"
      : options.includeDeleted
        ? ""
        : "WHERE deleted_at IS NULL";
    return this.database()
      .prepare(`SELECT * FROM browser_environments ${where} ORDER BY updated_at DESC`)
      .all()
      .map((row) => this.environmentFromRow(row as EnvironmentRow));
  }

  private upsertEnvironmentFromProfile(profile: BrowserProfile): void {
    const normalized = normalizeProfile(profile);
    const group = this.ensureGroup(normalized.group, normalized.createdAt);
    this.ensureTags(normalized.tags, normalized.createdAt);

    const existing = this.database()
      .prepare("SELECT proxy_id, deleted_at, delete_reason, last_network_check_json FROM browser_environments WHERE id = ?")
      .get(normalized.id) as Pick<EnvironmentRow, "proxy_id" | "deleted_at" | "delete_reason" | "last_network_check_json"> | undefined;

    this.database()
      .prepare(`
        INSERT INTO browser_environments (
          id, name, notes, mode, start_url, group_id, proxy_id, runtime_profile_json, last_network_check_json,
          created_at, updated_at, deleted_at, delete_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          notes = excluded.notes,
          mode = excluded.mode,
          start_url = excluded.start_url,
          group_id = excluded.group_id,
          proxy_id = excluded.proxy_id,
          runtime_profile_json = excluded.runtime_profile_json,
          last_network_check_json = excluded.last_network_check_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at,
          delete_reason = excluded.delete_reason
      `)
      .run(
        normalized.id,
        normalized.name,
        normalized.notes,
        normalized.mode,
        normalized.startUrl,
        group.id,
        existing?.proxy_id ?? null,
        JSON.stringify(normalized),
        existing?.last_network_check_json ?? null,
        normalized.createdAt,
        normalized.updatedAt,
        existing?.deleted_at ?? null,
        existing?.delete_reason ?? null,
      );

    this.replaceEnvironmentTags(normalized.id, normalized.tags);
  }

  private ensureGroup(name: string, timestamp: string): GroupEntity {
    const cleanName = name.trim() || "默认";
    const existing = this.database()
      .prepare("SELECT * FROM groups WHERE name = ?")
      .get(cleanName) as GroupRow | undefined;
    if (existing) return groupFromRow(existing);

    const id = createId("group");
    const sortOrder = this.nextSortOrder("groups");
    this.database()
      .prepare(`
        INSERT INTO groups (id, name, color, description, sort_order, status, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'enabled', ?, ?, ?)
      `)
      .run(id, cleanName, colorForName(cleanName), "", sortOrder, cleanName === "默认" ? 1 : 0, timestamp, timestamp);
    return {
      id,
      name: cleanName,
      color: colorForName(cleanName),
      description: "",
      order: sortOrder,
      status: "enabled",
      isDefault: cleanName === "默认",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private insertGroup(group: GroupEntity): void {
    this.database()
      .prepare(`
        INSERT INTO groups (id, name, color, description, sort_order, status, is_default, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          description = excluded.description,
          sort_order = excluded.sort_order,
          status = excluded.status,
          is_default = excluded.is_default,
          updated_at = excluded.updated_at
      `)
      .run(
        group.id,
        group.name,
        group.color,
        group.description,
        group.order,
        group.status,
        group.isDefault ? 1 : 0,
        group.createdAt,
        group.updatedAt,
      );
  }

  private getGroupOrThrow(id: string): GroupEntity {
    const row = this.database().prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
    if (!row) throw Object.assign(new Error("分组不存在"), { status: 404 });
    return groupFromRow(row);
  }

  private ensureTags(tags: string[], timestamp: string): TagEntity[] {
    return tags.map((tag) => this.ensureTag(tag, timestamp));
  }

  private ensureTag(name: string, timestamp: string): TagEntity {
    const cleanName = name.trim();
    const existing = this.database()
      .prepare("SELECT * FROM tags WHERE name = ?")
      .get(cleanName) as TagRow | undefined;
    if (existing) return tagFromRow(existing);

    const id = createId("tag");
    const sortOrder = this.nextSortOrder("tags");
    this.database()
      .prepare(`
        INSERT INTO tags (id, name, color, description, sort_order, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'enabled', ?, ?)
      `)
      .run(id, cleanName, colorForName(cleanName), "", sortOrder, timestamp, timestamp);
    return {
      id,
      name: cleanName,
      color: colorForName(cleanName),
      description: "",
      order: sortOrder,
      status: "enabled",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  private insertTag(tag: TagEntity): void {
    this.database()
      .prepare(`
        INSERT INTO tags (id, name, color, description, sort_order, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          description = excluded.description,
          sort_order = excluded.sort_order,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(tag.id, tag.name, tag.color, tag.description, tag.order, tag.status, tag.createdAt, tag.updatedAt);
  }

  private getTagOrThrow(id: string): TagEntity {
    const row = this.database().prepare("SELECT * FROM tags WHERE id = ?").get(id) as TagRow | undefined;
    if (!row) throw Object.assign(new Error("标签不存在"), { status: 404 });
    return tagFromRow(row);
  }

  private insertProxy(proxy: ProxyEntity): void {
    this.database()
      .prepare(`
        INSERT INTO proxies (
          id, name, scheme, host, port, username, password, bypass, notes, status,
          last_check_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          scheme = excluded.scheme,
          host = excluded.host,
          port = excluded.port,
          username = excluded.username,
          password = excluded.password,
          bypass = excluded.bypass,
          notes = excluded.notes,
          status = excluded.status,
          last_check_json = excluded.last_check_json,
          updated_at = excluded.updated_at
      `)
      .run(
        proxy.id,
        proxy.name,
        proxy.scheme,
        proxy.host,
        proxy.port,
        proxy.username,
        proxy.password,
        proxy.bypass,
        proxy.notes,
        proxy.status,
        proxy.lastCheck ? JSON.stringify(proxy.lastCheck) : null,
        proxy.createdAt,
        proxy.updatedAt,
      );
  }

  private getProxyOrThrow(id: string, options: { includeSecrets: boolean }): ProxyEntity {
    const row = this.database().prepare("SELECT * FROM proxies WHERE id = ?").get(id) as ProxyRow | undefined;
    if (!row) throw Object.assign(new Error("代理不存在"), { status: 404 });
    return proxyFromRow(row, options);
  }

  private insertExtension(extension: ExtensionEntity): void {
    this.database()
      .prepare(`
        INSERT INTO extensions (
          id, name, description, source_kind, source_url, source_id, store_id, store_url,
          version, manifest_version, permissions_json, host_permissions_json, permission_risks_json,
          install_state, update_policy, sha256, local_path, last_installed_at, last_checked_at,
          last_error, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          source_kind = excluded.source_kind,
          source_url = excluded.source_url,
          source_id = excluded.source_id,
          store_id = excluded.store_id,
          store_url = excluded.store_url,
          version = excluded.version,
          manifest_version = excluded.manifest_version,
          permissions_json = excluded.permissions_json,
          host_permissions_json = excluded.host_permissions_json,
          permission_risks_json = excluded.permission_risks_json,
          install_state = excluded.install_state,
          update_policy = excluded.update_policy,
          sha256 = excluded.sha256,
          local_path = excluded.local_path,
          last_installed_at = excluded.last_installed_at,
          last_checked_at = excluded.last_checked_at,
          last_error = excluded.last_error,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(
        extension.id,
        extension.name,
        extension.description,
        extension.sourceKind,
        extension.sourceUrl,
        extension.sourceId ?? null,
        extension.storeId ?? null,
        extension.storeUrl ?? null,
        extension.version,
        extension.manifestVersion ?? null,
        JSON.stringify(extension.permissions),
        JSON.stringify(extension.hostPermissions),
        JSON.stringify(extension.permissionRisks),
        extension.installState,
        extension.updatePolicy,
        extension.sha256 ?? null,
        extension.localPath ?? null,
        extension.lastInstalledAt ?? null,
        extension.lastCheckedAt ?? null,
        extension.lastError ?? null,
        extension.status,
        extension.createdAt,
        extension.updatedAt,
      );
  }

  private getExtensionOrThrow(id: string): ExtensionEntity {
    const row = this.database().prepare("SELECT * FROM extensions WHERE id = ?").get(id) as ExtensionRow | undefined;
    if (!row) throw Object.assign(new Error("Extension does not exist"), { status: 404 });
    return extensionFromRow(row);
  }

  private insertExtensionSource(source: ExtensionSourceEntity): void {
    this.database()
      .prepare(`
        INSERT INTO extension_sources (
          id, name, url, status, allow_unsigned_assets, last_refreshed_at,
          last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          url = excluded.url,
          status = excluded.status,
          allow_unsigned_assets = excluded.allow_unsigned_assets,
          last_refreshed_at = excluded.last_refreshed_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `)
      .run(
        source.id,
        source.name,
        source.url,
        source.status,
        source.allowUnsignedAssets ? 1 : 0,
        source.lastRefreshedAt ?? null,
        source.lastError ?? null,
        source.createdAt,
        source.updatedAt,
      );
  }

  private getExtensionSourceOrThrow(id: string): ExtensionSourceEntity {
    const row = this.database().prepare("SELECT * FROM extension_sources WHERE id = ?").get(id) as ExtensionSourceRow | undefined;
    if (!row) throw Object.assign(new Error("Extension source does not exist"), { status: 404 });
    return extensionSourceFromRow(row);
  }

  private getEnvironmentOrThrow(id: string): BrowserEnvironment {
    const row = this.database().prepare("SELECT * FROM browser_environments WHERE id = ?").get(id) as EnvironmentRow | undefined;
    if (!row) throw Object.assign(new Error("环境不存在"), { status: 404 });
    return this.environmentFromRow(row);
  }

  private throwIfReferenced(entityKind: ReferenceUsage["entityKind"], entityId: string): void {
    const usage = this.referenceUsage(entityKind, entityId);
    if (usage.count === 0) return;
    const error = Object.assign(new Error("实体仍被环境引用"), {
      status: 409,
      code: "REFERENCE_CONFLICT",
      usage,
    });
    throw error;
  }

  private referenceUsage(entityKind: ReferenceUsage["entityKind"], entityId: string): ReferenceUsage {
    let environmentIds: string[];
    if (entityKind === "group") {
      environmentIds = rowsToIds(this.database(), "browser_environments", "group_id", entityId);
    } else if (entityKind === "tag") {
      environmentIds = rowsToIds(this.database(), "environment_tags", "tag_id", entityId, "environment_id");
    } else if (entityKind === "proxy") {
      environmentIds = rowsToIds(this.database(), "browser_environments", "proxy_id", entityId);
    } else {
      environmentIds = rowsToIds(this.database(), "environment_extensions", "extension_id", entityId, "environment_id");
    }
    return {
      entityId,
      entityKind,
      environmentIds,
      count: environmentIds.length,
    };
  }

  private syncProfileTagsFromEnvironment(environmentId: string): void {
    const environment = this.getEnvironmentOrThrow(environmentId);
    const tagNames = this.database()
      .prepare(`
        SELECT tags.name AS name
        FROM tags
        JOIN environment_tags ON environment_tags.tag_id = tags.id
        WHERE environment_tags.environment_id = ?
        ORDER BY tags.sort_order ASC, tags.name ASC
      `)
      .all(environmentId)
      .map((row) => (row as { name: string }).name);
    const profile = normalizeProfile({
      ...environment.runtimeProfile,
      tags: tagNames,
      updatedAt: nowIso(),
    });
    this.upsertProfileRow(profile);
  }

  private syncProfilesForProxy(proxyId: string): void {
    this.refreshProfilesFromEnvironments(rowsToIds(this.database(), "browser_environments", "proxy_id", proxyId));
  }

  private setEnvironmentProxyReference(environmentId: string, proxyId: string | null | undefined): void {
    const timestamp = nowIso();
    const proxy = proxyId ? this.getProxyOrThrow(proxyId, { includeSecrets: true }) : undefined;
    const environment = this.getEnvironmentOrThrow(environmentId);
    const runtimeProfile = normalizeProfile({
      ...environment.runtimeProfile,
      proxy: proxy ? proxyToProfileSettings(proxy) : environment.runtimeProfile.proxy,
      updatedAt: timestamp,
    });
    this.database()
      .prepare("UPDATE browser_environments SET proxy_id = ?, runtime_profile_json = ?, updated_at = ? WHERE id = ?")
      .run(proxy?.id ?? null, JSON.stringify(runtimeProfile), timestamp, environmentId);
    this.upsertProfileRow(this.profileFromEnvironment(this.getEnvironmentOrThrow(environmentId)));
  }

  private refreshProfilesFromEnvironments(environmentIds: string[]): void {
    for (const environmentId of uniqueStrings(environmentIds)) {
      const environment = this.getEnvironmentOrThrow(environmentId);
      const profile = this.profileFromEnvironment(environment);
      this.upsertProfileRow(profile);
    }
  }

  private profileFromEnvironment(environment: BrowserEnvironment): BrowserProfile {
    const group = this.database().prepare("SELECT name FROM groups WHERE id = ?").get(environment.groupId) as { name: string } | undefined;
    const tagNames = this.database()
      .prepare(`
        SELECT tags.name AS name
        FROM tags
        JOIN environment_tags ON environment_tags.tag_id = tags.id
        WHERE environment_tags.environment_id = ?
        ORDER BY tags.sort_order ASC, tags.name ASC
      `)
      .all(environment.id)
      .map((row) => (row as { name: string }).name);
    const proxy = environment.proxyId
      ? this.getProxyOrThrow(environment.proxyId, { includeSecrets: true })
      : undefined;
    const extensionPaths = this.environmentExtensions(environment.id)
      .filter((extension) => extension.status === "enabled" && extension.installState === "installed" && extension.localPath)
      .map((extension) => extension.localPath as string);

    return normalizeProfile({
      ...environment.runtimeProfile,
      name: environment.name,
      notes: environment.notes,
      mode: environment.mode,
      startUrl: environment.startUrl,
      group: group?.name ?? environment.runtimeProfile.group,
      tags: tagNames,
      proxy: proxy ? proxyToProfileSettings(proxy) : environment.runtimeProfile.proxy,
      runtime: {
        ...environment.runtimeProfile.runtime,
        extensionPaths,
      },
      updatedAt: nowIso(),
    });
  }

  private replaceEnvironmentTags(environmentId: string, tagNames: string[]): void {
    this.database().prepare("DELETE FROM environment_tags WHERE environment_id = ?").run(environmentId);
    for (const tagName of tagNames) {
      const row = this.database().prepare("SELECT id FROM tags WHERE name = ?").get(tagName) as IdRow | undefined;
      if (!row) continue;
      this.database()
        .prepare("INSERT OR IGNORE INTO environment_tags (environment_id, tag_id) VALUES (?, ?)")
        .run(environmentId, row.id);
    }
  }

  private environmentFromProfile(profile: BrowserProfile): BrowserEnvironment {
    const row = this.database()
      .prepare("SELECT * FROM browser_environments WHERE id = ?")
      .get(profile.id) as EnvironmentRow | undefined;
    if (row) return this.environmentFromRow(row);
    this.upsertEnvironmentFromProfile(profile);
    const created = this.database()
      .prepare("SELECT * FROM browser_environments WHERE id = ?")
      .get(profile.id) as EnvironmentRow;
    return this.environmentFromRow(created);
  }

  private environmentFromRow(row: EnvironmentRow): BrowserEnvironment {
    const runtimeProfile = parseProfile(row.runtime_profile_json);
    return {
      id: row.id,
      name: row.name,
      notes: row.notes,
      mode: row.mode,
      startUrl: row.start_url,
      groupId: row.group_id,
      tagIds: this.environmentTagIds(row.id),
      proxyId: row.proxy_id ?? undefined,
      extensionIds: this.environmentExtensionIds(row.id),
      runtimeProfile,
      lastNetworkCheck: row.last_network_check_json
        ? parseJson<NetworkCheckResult>(row.last_network_check_json)
        : undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deletedAt: row.deleted_at ?? undefined,
      deleteReason: row.delete_reason ?? undefined,
    };
  }

  private environmentTagIds(environmentId: string): string[] {
    return this.database()
      .prepare("SELECT tag_id AS id FROM environment_tags WHERE environment_id = ? ORDER BY tag_id ASC")
      .all(environmentId)
      .map((row) => (row as IdRow).id);
  }

  private environmentExtensionIds(environmentId: string): string[] {
    return this.database()
      .prepare("SELECT extension_id AS id FROM environment_extensions WHERE environment_id = ? ORDER BY extension_id ASC")
      .all(environmentId)
      .map((row) => (row as IdRow).id);
  }

  private environmentExtensions(environmentId: string): ExtensionEntity[] {
    return this.database()
      .prepare(`
        SELECT extensions.*
        FROM extensions
        JOIN environment_extensions ON environment_extensions.extension_id = extensions.id
        WHERE environment_extensions.environment_id = ?
        ORDER BY extensions.name ASC
      `)
      .all(environmentId)
      .map((row) => extensionFromRow(row as ExtensionRow));
  }

  private nextSortOrder(table: "groups" | "tags"): number {
    const row = this.database().prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow;
    return Number(row.count) + 1;
  }

  private getSettingsRow(): SettingsRow | undefined {
    return this.database()
      .prepare("SELECT settings_json FROM app_settings WHERE id = 'default'")
      .get() as SettingsRow | undefined;
  }

  private writeSettings(settings: AppSettings): void {
    const normalized = normalizeSettings(settings);
    this.database()
      .prepare(`
        INSERT INTO app_settings (id, settings_json, updated_at)
        VALUES ('default', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          settings_json = excluded.settings_json,
          updated_at = excluded.updated_at
      `)
      .run(JSON.stringify(normalized), nowIso());
  }

  private storageInfo(): StorageInfo {
    const migratedFromJson = this.getMetadata("migrated_from_json") === "true";
    const migrationBackupPath = this.getMetadata("migration_backup_path") || undefined;
    const migrationError = (this.migrationError ?? this.getMetadata("migration_error")) || undefined;
    return {
      kind: "sqlite",
      databasePath: this.databasePath,
      legacyJsonPath: this.legacyJsonPath,
      migrationBackupPath,
      migrationError,
      portable: this.portable,
      migratedFromJson,
    };
  }

  private profileCount(): number {
    const row = this.database().prepare("SELECT COUNT(*) AS count FROM profiles").get() as CountRow;
    return Number(row.count);
  }

  private setMigration(id: string): void {
    this.database()
      .prepare("INSERT OR IGNORE INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run(id, nowIso());
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const rows = this.database().prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (rows.some((row) => row.name === column)) return;
    this.database().exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private setMetadata(key: string, value: string): void {
    this.database()
      .prepare(`
        INSERT INTO storage_metadata (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value
      `)
      .run(key, value);
  }

  private getMetadata(key: string): string | undefined {
    const row = this.database().prepare("SELECT value FROM storage_metadata WHERE key = ?").get(key) as MetadataRow | undefined;
    return row?.value || undefined;
  }

  private canReplaceSeedAfterMigrationError(): boolean {
    return this.getMetadata("seeded_after_migration_error") === "true" && this.getMetadata("profiles_user_modified") !== "true";
  }

  private markProfilesModified(): void {
    this.setMetadata("profiles_user_modified", "true");
  }

  private database(): DatabaseSync {
    if (!this.db) throw new Error("SQLite store is not initialized");
    return this.db;
  }
}

function parseProfile(raw: string): BrowserProfile {
  return normalizeProfile(JSON.parse(raw) as Partial<BrowserProfile>);
}

function parseSettings(raw: string): AppSettings {
  return normalizeSettings(JSON.parse(raw) as Partial<AppSettings>);
}

function parseProxyParts(profile: BrowserProfile): {
  scheme: BrowserProfile["proxy"]["scheme"];
  host: string;
  port: string;
  username: string;
  password: string;
} | undefined {
  const raw = profile.proxy.raw.trim();
  if (raw) {
    try {
      const url = new URL(raw.includes("://") ? raw : `${profile.proxy.scheme}://${raw}`);
      const scheme = normalizeProxyScheme(url.protocol.replace(":", ""));
      if (!scheme || !url.hostname || !url.port) return undefined;
      return {
        scheme,
        host: url.hostname,
        port: url.port,
        username: decodeURIComponent(url.username),
        password: decodeURIComponent(url.password),
      };
    } catch {
      return undefined;
    }
  }

  const host = profile.proxy.host.trim();
  const port = profile.proxy.port.trim();
  if (!host || !port) return undefined;
  return {
    scheme: normalizeProxyScheme(profile.proxy.scheme) ?? "http",
    host,
    port,
    username: profile.proxy.username.trim(),
    password: profile.proxy.password,
  };
}

function normalizeProxyEntity(input: Partial<ProxyEntity>): ProxyEntity {
  const now = nowIso();
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : createId("proxy");
  const scheme = typeof input.scheme === "string" ? normalizeProxyScheme(input.scheme) : "http";
  if (!scheme) throw Object.assign(new Error("代理协议不受支持"), { status: 400 });
  const host = typeof input.host === "string" ? input.host.trim() : "";
  const port = typeof input.port === "string" ? input.port.trim() : "";
  if (!host || !port) throw Object.assign(new Error("代理 host 和 port 不能为空"), { status: 400 });
  return {
    id,
    name: typeof input.name === "string" && input.name.trim() ? input.name.trim() : host,
    scheme,
    host,
    port,
    username: typeof input.username === "string" ? input.username.trim() : "",
    password: typeof input.password === "string" ? input.password : "",
    bypass: typeof input.bypass === "string" ? input.bypass : "localhost,127.0.0.1",
    notes: typeof input.notes === "string" ? input.notes.trim() : "",
    status: input.status === "disabled" ? "disabled" : "enabled",
    lastCheck: input.lastCheck,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function normalizeExtensionEntity(input: Partial<ExtensionEntity>): ExtensionEntity {
  const now = nowIso();
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : createId("extension");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "Extension";
  const sourceKind = isExtensionSourceKind(input.sourceKind) ? input.sourceKind : "local-directory";
  const version = typeof input.version === "string" && input.version.trim() ? input.version.trim() : "0.0.0";
  return {
    id,
    name,
    description: typeof input.description === "string" ? input.description.trim() : "",
    sourceKind,
    sourceUrl: typeof input.sourceUrl === "string" ? input.sourceUrl.trim() : "",
    sourceId: typeof input.sourceId === "string" && input.sourceId.trim() ? input.sourceId.trim() : undefined,
    storeId: typeof input.storeId === "string" && input.storeId.trim() ? input.storeId.trim() : undefined,
    storeUrl: typeof input.storeUrl === "string" && input.storeUrl.trim() ? input.storeUrl.trim() : undefined,
    version,
    manifestVersion: Number.isFinite(input.manifestVersion) ? Number(input.manifestVersion) : undefined,
    permissions: uniqueStrings(input.permissions ?? []),
    hostPermissions: uniqueStrings(input.hostPermissions ?? []),
    permissionRisks: Array.isArray(input.permissionRisks) ? input.permissionRisks : [],
    installState: isExtensionInstallState(input.installState) ? input.installState : "metadata-only",
    updatePolicy: isExtensionUpdatePolicy(input.updatePolicy) ? input.updatePolicy : "pinned",
    sha256: typeof input.sha256 === "string" && input.sha256.trim() ? input.sha256.trim().toLowerCase() : undefined,
    localPath: typeof input.localPath === "string" && input.localPath.trim() ? input.localPath.trim() : undefined,
    lastInstalledAt: typeof input.lastInstalledAt === "string" && input.lastInstalledAt.trim() ? input.lastInstalledAt.trim() : undefined,
    lastCheckedAt: typeof input.lastCheckedAt === "string" && input.lastCheckedAt.trim() ? input.lastCheckedAt.trim() : undefined,
    lastError: typeof input.lastError === "string" && input.lastError.trim() ? input.lastError.trim() : undefined,
    status: input.status === "disabled" ? "disabled" : "enabled",
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function normalizeExtensionSourceEntity(input: Partial<ExtensionSourceEntity>): ExtensionSourceEntity {
  const now = nowIso();
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : createId("extension-source");
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim() : "Extension Source";
  const url = typeof input.url === "string" ? input.url.trim() : "";
  if (!url) throw Object.assign(new Error("Extension source URL cannot be empty"), { status: 400 });
  return {
    id,
    name,
    url,
    status: input.status === "disabled" ? "disabled" : "enabled",
    allowUnsignedAssets: input.allowUnsignedAssets === true,
    lastRefreshedAt: typeof input.lastRefreshedAt === "string" && input.lastRefreshedAt.trim() ? input.lastRefreshedAt.trim() : undefined,
    lastError: typeof input.lastError === "string" && input.lastError.trim() ? input.lastError.trim() : undefined,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function proxyToProfileSettings(proxy: ProxyEntity): BrowserProfile["proxy"] {
  return {
    enabled: proxy.status === "enabled",
    raw: "",
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    bypass: proxy.bypass,
  };
}

function isProxyScheme(value: unknown): value is BrowserProfile["proxy"]["scheme"] {
  return typeof value === "string" && normalizeProxyScheme(value) === value;
}

function isExtensionSourceKind(value: unknown): value is ExtensionSourceKind {
  return (
    value === "local-directory" ||
    value === "local-zip" ||
    value === "local-crx" ||
    value === "remote-zip" ||
    value === "remote-crx" ||
    value === "chrome-web-store"
  );
}

function isExtensionInstallState(value: unknown): value is ExtensionInstallState {
  return (
    value === "metadata-only" ||
    value === "download-pending" ||
    value === "downloading" ||
    value === "installed" ||
    value === "update-available" ||
    value === "local-missing" ||
    value === "invalid-manifest" ||
    value === "install-failed"
  );
}

function isExtensionUpdatePolicy(value: unknown): value is ExtensionUpdatePolicy {
  return value === "pinned" || value === "notify" || value === "auto";
}

function cleanRequiredName(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(message), { status: 400 });
  }
  return value.trim();
}

function cleanColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return /^#[0-9a-f]{6}$/i.test(trimmed) ? trimmed.toUpperCase() : fallback;
}

function uniqueStrings(values: unknown[]): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0).map((value) => value.trim()))];
}

function rowsToIds(
  db: DatabaseSync,
  table: "browser_environments" | "environment_tags" | "environment_extensions",
  column: string,
  value: string,
  idColumn = "id",
): string[] {
  return db
    .prepare(`SELECT ${idColumn} AS id FROM ${table} WHERE ${column} = ?`)
    .all(value)
    .map((row) => (row as IdRow).id);
}

function groupFromRow(row: GroupRow): GroupEntity {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    order: Number(row.sort_order),
    status: row.status,
    isDefault: row.is_default === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function tagFromRow(row: TagRow): TagEntity {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    order: Number(row.sort_order),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function proxyFromRow(row: ProxyRow, options: { includeSecrets: boolean }): ProxyEntity {
  return {
    id: row.id,
    name: row.name,
    scheme: normalizeProxyScheme(row.scheme) ?? "http",
    host: row.host,
    port: row.port,
    username: row.username,
    password: options.includeSecrets ? row.password : "",
    bypass: row.bypass,
    notes: row.notes,
    status: row.status,
    lastCheck: row.last_check_json ? parseJson<ProxyCheckResult>(row.last_check_json) : undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function extensionFromRow(row: ExtensionRow): ExtensionEntity {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sourceKind: row.source_kind,
    sourceUrl: row.source_url,
    sourceId: row.source_id ?? undefined,
    storeId: row.store_id ?? undefined,
    storeUrl: row.store_url ?? undefined,
    version: row.version,
    manifestVersion: row.manifest_version ?? undefined,
    permissions: parseJson<string[]>(row.permissions_json, []),
    hostPermissions: parseJson<string[]>(row.host_permissions_json, []),
    permissionRisks: parseJson<ExtensionPermissionRisk[]>(row.permission_risks_json, []),
    installState: row.install_state,
    updatePolicy: row.update_policy,
    sha256: row.sha256 ?? undefined,
    localPath: row.local_path ?? undefined,
    lastInstalledAt: row.last_installed_at ?? undefined,
    lastCheckedAt: row.last_checked_at ?? undefined,
    lastError: row.last_error ?? undefined,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function extensionSourceFromRow(row: ExtensionSourceRow): ExtensionSourceEntity {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    status: row.status,
    allowUnsignedAssets: row.allow_unsigned_assets === 1,
    lastRefreshedAt: row.last_refreshed_at ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseJson<T>(raw: string, fallback?: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    if (fallback !== undefined) return fallback;
    throw new Error("Stored JSON is invalid");
  }
}

function colorForName(name: string): string {
  const palette = ["#0891B2", "#7C3AED", "#DB2777", "#16A34A", "#D97706", "#475569"];
  let hash = 0;
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

function normalizeProfileNameKey(name: string): string {
  return name.trim().toLocaleLowerCase();
}

async function pathExists(inputPath: string): Promise<boolean> {
  try {
    await fs.access(inputPath);
    return true;
  } catch {
    return false;
  }
}

function timestampForFile(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-");
}
