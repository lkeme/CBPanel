import type { BrowserCoreEnvValueKind, BuiltinCloakBrowserEnvKey } from "./settings";

export type BrowserCoreInstallStatus =
  | "unknown"
  | "checking"
  | "not-installed"
  | "installed"
  | "update-available"
  | "installing"
  | "updating"
  | "failed"
  | "corrupted";

export type BrowserCoreOperationType = "install" | "update" | "clear-cache" | "import-zip" | "check-update";
export type BrowserCoreOperationStatus = "idle" | "running" | "succeeded" | "failed";
export type BrowserCoreEnvSource = "cbpanel-default" | "settings" | "custom" | "external" | "cloakbrowser-default";
export type BrowserCoreImportKind = "install" | "upgrade" | "reinstall" | "downgrade" | "blocked";
export type BrowserCoreTier = "free" | "pro";
export type BrowserCoreVersionMode = "latest" | "pinned";

export interface BrowserCoreDownloadLinks {
  tier: BrowserCoreTier;
  version: string;
  platform: string;
  primaryUrl: string;
  fallbackUrl?: string;
  checksumUrl?: string;
  signatureUrl?: string;
  fallbackChecksumUrl?: string;
  fallbackSignatureUrl?: string;
  requiresLicense?: boolean;
}

export interface BrowserCoreVersionInfo {
  cbpanelVersion?: string;
  wrapperVersion?: string;
  wrapperVersionDetail?: string;
  chromiumVersion: string;
  baselineChromiumVersion: string;
  playwrightCoreVersion?: string;
  puppeteerCoreVersion?: string;
}

export interface BrowserCoreEnvRuntimeValue {
  key: BuiltinCloakBrowserEnvKey | string;
  label: string;
  value?: string;
  maskedValue?: string;
  enabled: boolean;
  source: BrowserCoreEnvSource;
  sensitive: boolean;
  valueKind: BrowserCoreEnvValueKind;
  requiresRuntimeRestart: boolean;
  detail?: string;
}

export interface BrowserCoreOperationLog {
  at: string;
  level: "info" | "warn" | "error";
  message: string;
  detail?: string;
}

export interface BrowserCoreOperation {
  id: string;
  type: BrowserCoreOperationType;
  status: BrowserCoreOperationStatus;
  phase: string;
  startedAt?: string;
  finishedAt?: string;
  progress?: {
    current?: number;
    total?: number;
    label?: string;
  };
  logs: BrowserCoreOperationLog[];
  error?: string;
}

export interface BrowserCoreUpdateCheck {
  checkedAt: string;
  targetTier?: BrowserCoreTier;
  versionMode?: BrowserCoreVersionMode;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  downloadLinks?: BrowserCoreDownloadLinks;
  blockedReason?: string;
  error?: string;
}

export interface BrowserCoreImportAnalysis {
  filePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  platform: string;
  targetTier: BrowserCoreTier;
  setAsDefault: boolean;
  currentVersion: string;
  importedVersion?: string;
  operation: BrowserCoreImportKind;
  allowed: boolean;
  reason?: string;
  chromePath?: string;
  targetCacheDir?: string;
}

export interface BrowserCoreInfo {
  status: BrowserCoreInstallStatus;
  installed: boolean;
  tier?: BrowserCoreTier;
  targetTier: BrowserCoreTier;
  versionMode: BrowserCoreVersionMode;
  pinnedVersion?: string;
  platform: string;
  binaryPath: string;
  cacheDir: string;
  downloadUrl: string;
  versions: BrowserCoreVersionInfo;
  downloads: {
    current: BrowserCoreDownloadLinks;
    latest?: BrowserCoreDownloadLinks;
  };
  env: BrowserCoreEnvRuntimeValue[];
  operation?: BrowserCoreOperation;
  update?: BrowserCoreUpdateCheck;
  portable: boolean;
  cacheManagedByCbpanel: boolean;
  restartRequired: boolean;
  detail?: string;
}

export interface CloakBrowserEnvInfo {
  binaryPath?: string;
  cacheDir?: string;
  downloadUrl?: string;
  autoUpdate?: string;
  skipChecksum?: string;
  geoipTimeoutSeconds?: string;
  version?: string;
  licenseKey?: string;
}

export interface BinaryInfo {
  version: string;
  bundledVersion?: string;
  tier?: BrowserCoreTier;
  platform: string;
  binaryPath: string;
  installed: boolean;
  cacheDir: string;
  downloadUrl: string;
  env?: CloakBrowserEnvInfo;
  core?: BrowserCoreInfo;
}

export const BROWSER_CORE_STARTUP_UPDATE_CHECK_TTL_MS = 12 * 60 * 60 * 1000;

export function shouldRunStartupBrowserCoreUpdateCheck(
  update: BrowserCoreUpdateCheck | undefined,
  now = Date.now(),
): boolean {
  if (!update) return true;
  const checkedAt = Date.parse(update.checkedAt);
  if (!Number.isFinite(checkedAt)) return true;
  return now - checkedAt >= BROWSER_CORE_STARTUP_UPDATE_CHECK_TTL_MS;
}

export function maskEnvValue(key: string, value: string | undefined, sensitive = false): string | undefined {
  if (!value) return value;
  if (sensitive || /TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)) return "****";
  try {
    const url = new URL(value);
    for (const param of [...url.searchParams.keys()]) {
      if (/token|secret|password|credential|key/i.test(param)) url.searchParams.set(param, "****");
    }
    if (url.username) url.username = "****";
    if (url.password) url.password = "****";
    return url.toString();
  } catch {
    return value;
  }
}
