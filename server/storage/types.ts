import type { BrowserProfile } from "../../src/shared/profile";
import type {
  BrowserEnvironment,
  ExtensionEntity,
  ExtensionBindingMetadata,
  GroupEntity,
  NetworkCheckResult,
  ProxyEntity,
  TagEntity,
  TrashEnvironment,
} from "../../src/shared/entities";
import type { AppSettings, AppSettingsPatch, StorageInfo } from "../../src/shared/settings";
import type { AppBackupData } from "../../src/shared/appBackup";
import type { ExtensionArtifactProviderId } from "../../src/shared/extensionAcquisition";

export type EnvironmentPackageImportInput = {
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  extensions: ExtensionEntity[];
  environmentIdMap?: Record<string, string>;
  extensionIdMap?: Record<string, string>;
  extensionLocalPaths?: Record<string, string>;
  extensionArtifactPaths?: Record<string, string>;
  extensionManifestKeys?: Record<string, string>;
  environmentExtensionBindings?: ExtensionBindingMetadata[];
};

export type EnvironmentPackageImportResult = {
  imported: number;
  environments: BrowserEnvironment[];
  idMap: {
    environments: Record<string, string>;
    groups: Record<string, string>;
    extensions: Record<string, string>;
  };
};

export type EnvironmentExtensionBinding = {
  environmentId: string;
  extensionId: string;
  /** Null marks a binding created before lifecycle protection was introduced. */
  lifecycleRevision?: string;
};

export type ExtensionAcquisitionDatabaseCommitInput = {
  extension: ExtensionEntity;
  /** Selected channel that must still be current at the SQLite write boundary. */
  expectedArtifactProviderId?: ExtensionArtifactProviderId;
  /** Undefined creates a new row; otherwise the exact row revision must still match. */
  expectedExistingUpdatedAt?: string;
  expectedEnvironmentBindings?: ExtensionBindingMetadata[];
  environmentBindings: ExtensionBindingMetadata[];
};

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
  exportFullBackupData(): Promise<AppBackupData>;
  restoreFullBackupData(data: AppBackupData): Promise<void>;
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
  importEnvironmentPackage(input: EnvironmentPackageImportInput): Promise<EnvironmentPackageImportResult>;
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
  updateExtension(
    id: string,
    patch: Partial<ExtensionEntity>,
    /** Synchronous policy/CAS guard run after repository initialization and immediately before SQLite writes. */
    beforeWrite?: () => void,
  ): Promise<ExtensionEntity>;
  commitExtensionAcquisition(input: ExtensionAcquisitionDatabaseCommitInput): Promise<ExtensionEntity>;
  deleteExtension(id: string): Promise<void>;
  listEnvironmentExtensionBindings(environmentId: string): Promise<EnvironmentExtensionBinding[]>;
  listExtensionEnvironmentBindings(extensionId: string): Promise<EnvironmentExtensionBinding[]>;
  bindExtensionToEnvironments(id: string, environmentIds: string[]): Promise<BrowserEnvironment[]>;
  unbindExtensionFromEnvironments(id: string, environmentIds?: string[]): Promise<BrowserEnvironment[]>;
}

export type PanelRepository = ProfileRepository
  & SettingsRepository
  & StorageRepository
  & EnvironmentRepository
  & RegistryRepository;
