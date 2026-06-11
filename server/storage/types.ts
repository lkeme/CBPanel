import type { BrowserProfile } from "../../src/shared/profile";
import type {
  BrowserEnvironment,
  ExtensionEntity,
  ExtensionSourceEntity,
  GroupEntity,
  NetworkCheckResult,
  ProxyEntity,
  TagEntity,
  TrashEnvironment,
} from "../../src/shared/entities";
import type { AppSettings, AppSettingsPatch, StorageInfo } from "../../src/shared/settings";

export interface ProfileRepository {
  listProfiles(): Promise<BrowserProfile[]>;
  getProfile(id: string): Promise<BrowserProfile | undefined>;
  createProfile(profile: Partial<BrowserProfile>): Promise<BrowserProfile>;
  updateProfile(id: string, patch: Partial<BrowserProfile>): Promise<BrowserProfile>;
  duplicateProfile(id: string): Promise<BrowserProfile>;
  deleteProfile(id: string): Promise<void>;
  importProfiles(profiles: unknown[]): Promise<{ imported: number; profiles: BrowserProfile[] }>;
  exportProfiles(): Promise<{ profiles: BrowserProfile[] }>;
}

export interface SettingsRepository {
  getSettings(): Promise<AppSettings>;
  saveSettings(patch: AppSettingsPatch): Promise<AppSettings>;
}

export interface StorageRepository {
  getInfo(): Promise<StorageInfo>;
  migrateLegacyJson(): Promise<StorageInfo>;
}

export interface EnvironmentRepository {
  listEnvironments(): Promise<BrowserEnvironment[]>;
  listTrashEnvironments(): Promise<TrashEnvironment[]>;
  getEnvironment(id: string): Promise<BrowserEnvironment | undefined>;
  createEnvironment(profile: Partial<BrowserProfile>): Promise<BrowserEnvironment>;
  updateEnvironment(id: string, patch: Partial<BrowserProfile> & { proxyId?: string | null }): Promise<BrowserEnvironment>;
  duplicateEnvironment(id: string): Promise<BrowserEnvironment>;
  saveEnvironmentNetworkCheck(id: string, result: NetworkCheckResult): Promise<BrowserEnvironment>;
  softDeleteEnvironment(id: string, reason?: string): Promise<void>;
  restoreEnvironment(id: string): Promise<BrowserEnvironment>;
  permanentlyDeleteEnvironment(id: string): Promise<void>;
  clearTrashEnvironments(): Promise<{ deleted: number }>;
}

export interface RegistryRepository {
  listGroups(): Promise<GroupEntity[]>;
  createGroup(input: Partial<GroupEntity>): Promise<GroupEntity>;
  updateGroup(id: string, patch: Partial<GroupEntity>): Promise<GroupEntity>;
  deleteGroup(id: string): Promise<void>;
  mergeGroup(id: string, targetId: string): Promise<GroupEntity>;
  listTags(): Promise<TagEntity[]>;
  createTag(input: Partial<TagEntity>): Promise<TagEntity>;
  updateTag(id: string, patch: Partial<TagEntity>): Promise<TagEntity>;
  deleteTag(id: string): Promise<void>;
  mergeTag(id: string, targetId: string): Promise<TagEntity>;
  assignTags(environmentIds: string[], tagIds: string[]): Promise<BrowserEnvironment[]>;
  removeTags(environmentIds: string[], tagIds: string[]): Promise<BrowserEnvironment[]>;
  listProxies(options?: { includeSecrets?: boolean }): Promise<ProxyEntity[]>;
  createProxy(input: Partial<ProxyEntity>): Promise<ProxyEntity>;
  updateProxy(id: string, patch: Partial<ProxyEntity>): Promise<ProxyEntity>;
  duplicateProxy(id: string): Promise<ProxyEntity>;
  deleteProxy(id: string): Promise<void>;
  replaceProxyReferences(id: string, targetId?: string): Promise<BrowserEnvironment[]>;
  saveProxyCheckResult(id: string, result: ProxyEntity["lastCheck"]): Promise<ProxyEntity>;
  listExtensions(): Promise<ExtensionEntity[]>;
  getExtension(id: string): Promise<ExtensionEntity | undefined>;
  createExtension(input: Partial<ExtensionEntity>): Promise<ExtensionEntity>;
  updateExtension(id: string, patch: Partial<ExtensionEntity>): Promise<ExtensionEntity>;
  deleteExtension(id: string): Promise<void>;
  bindExtensionToEnvironments(id: string, environmentIds: string[]): Promise<BrowserEnvironment[]>;
  unbindExtensionFromEnvironments(id: string, environmentIds?: string[]): Promise<BrowserEnvironment[]>;
  listExtensionSources(): Promise<ExtensionSourceEntity[]>;
  getExtensionSource(id: string): Promise<ExtensionSourceEntity | undefined>;
  createExtensionSource(input: Partial<ExtensionSourceEntity>): Promise<ExtensionSourceEntity>;
  updateExtensionSource(id: string, patch: Partial<ExtensionSourceEntity>): Promise<ExtensionSourceEntity>;
  deleteExtensionSource(id: string): Promise<void>;
}

export type PanelRepository = ProfileRepository
  & SettingsRepository
  & StorageRepository
  & EnvironmentRepository
  & RegistryRepository;
