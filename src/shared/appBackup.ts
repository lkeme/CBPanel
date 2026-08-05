import type {
  BrowserEnvironment,
  ExtensionEntity,
  ExtensionSourceEntity,
  GroupEntity,
  ProxyEntity,
  TagEntity,
} from "./entities";
import type { BrowserProfile } from "./profile";
import type { AppSettings } from "./settings";

export const APP_BACKUP_KIND = "cbpanel.appBackup";
export const APP_BACKUP_SCHEMA_VERSION = 1;

export type AppBackupOperationType = "export" | "restore";
export type AppBackupOperationStatus = "queued" | "running" | "succeeded" | "failed";

export interface AppBackupCounts {
  profiles: number;
  environments: number;
  trashEnvironments: number;
  browserData: number;
  groups: number;
  tags: number;
  proxies: number;
  extensions: number;
  extensionSources: number;
  runtimeExtensions: number;
}

export interface AppBackupManifest {
  kind: typeof APP_BACKUP_KIND;
  schemaVersion: typeof APP_BACKUP_SCHEMA_VERSION;
  exportedAt: string;
  containsSecrets: true;
  containsBrowserData: boolean;
  containsExtensions: boolean;
  counts: AppBackupCounts;
}

export interface AppBackupData {
  schemaVersion: typeof APP_BACKUP_SCHEMA_VERSION;
  settings: AppSettings;
  profiles: BrowserProfile[];
  environments: BrowserEnvironment[];
  groups: GroupEntity[];
  tags: TagEntity[];
  proxies: ProxyEntity[];
  extensions: ExtensionEntity[];
  extensionSources: ExtensionSourceEntity[];
}

export interface AppBackupOperationResult {
  outputPath?: string;
  inputPath?: string;
  counts: AppBackupCounts;
  warnings: string[];
}

export interface AppBackupOperation {
  id: string;
  type: AppBackupOperationType;
  status: AppBackupOperationStatus;
  phase: string;
  current: number;
  total: number;
  message: string;
  startedAt: string;
  updatedAt: string;
  result?: AppBackupOperationResult;
  error?: string;
}
