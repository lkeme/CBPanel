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

// The tier is derived from the license plan, never chosen, so the panel has to be able to say which
// of the four states it is in: no key, a key the operator switched off, a validated plan, or a key
// whose plan could not be confirmed. `plan` is undefined for the last one — the license server was
// unreachable and the wrapper had no cached answer — and that is reported as unknown rather than as
// free, because guessing is what the derived tier exists to stop.
export interface BrowserCoreLicenseState {
  /** A license key is on file in settings, whether or not it is in use. */
  configured: boolean;
  /** A resolved key actually reaches the wrapper. False when no key is configured or the operator switched it off. A custom download source still leaves this true — it forces the tier to free without taking the key out of play. */
  active: boolean;
  checkedAt?: string;
  valid?: boolean;
  plan?: string;
  expires?: string;
  error?: string;
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

// Why the comparison this check performed cannot be trusted, as a code the panel translates. A verdict
// is only as good as the version it started from, and an offline import can leave that baseline in a
// state no comparison covers — see checkUpdate.
export type BrowserCoreUpdateBaselineCaveat = "offline-import-tier-mismatch";

export interface BrowserCoreUpdateCheck {
  checkedAt: string;
  targetTier?: BrowserCoreTier;
  versionMode?: BrowserCoreVersionMode;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  blockedReason?: string;
  /** Set when `updateAvailable` is the answer of a comparison whose baseline is unsound. Never a substitute for `error`: the check itself succeeded. */
  baselineCaveat?: BrowserCoreUpdateBaselineCaveat;
  error?: string;
}

// Where the build that currently resolves came from, reported only when CBPanel can prove it was an
// offline import rather than a download. The proof is a marker file inside the build directory itself,
// so it disappears with the build — see BinaryService.importedBuild.
export interface BrowserCoreImportedBuild {
  source: "offline-import";
  version: string;
  /** The tier the import was filed under, which is not necessarily the tier this configuration now downloads for. */
  tier: BrowserCoreTier;
  fileName: string;
  sha256: string;
  importedAt: string;
}

export interface BrowserCoreImportAnalysis {
  filePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  platform: string;
  targetTier: BrowserCoreTier;
  currentVersion: string;
  importedVersion?: string;
  operation: BrowserCoreImportKind;
  allowed: boolean;
  reason?: string;
  // The reason as a code the panel can translate. `reason` stays the English sentence so a direct API
  // consumer still gets something readable; the dialog prefers this and only falls back to `reason`.
  reasonCode?: BrowserCoreImportRefusal;
  chromePath?: string;
  targetCacheDir?: string;
}

export type BrowserCoreImportRefusal = "unverified-package" | "sessions-running";

export interface CloakBrowserDiagnosticsEnvironment {
  node?: string;
  os?: string;
  arch?: string;
  platformTag?: string;
}

export interface CloakBrowserDiagnosticsBinary {
  version?: string;
  tier?: string;
  bundledVersion?: string;
  path?: string;
  installed?: boolean;
  cacheDir?: string;
  override?: string;
  error?: string;
}

export interface CloakBrowserDiagnosticsLaunch {
  tested: boolean;
  ok?: boolean;
  version?: string;
  error?: string;
  reason?: string;
  missingLibs?: string[];
}

export interface CloakBrowserDiagnosticsLicense {
  tier?: string;
  valid?: boolean;
  expires?: string;
  error?: string;
  sessions?: {
    active?: number | null;
  };
}

export interface CloakBrowserDiagnosticsGeoIp {
  dbPresent?: boolean;
  path?: string;
}

export interface CloakBrowserDiagnosticsFonts {
  windowsFonts?: "ok" | "missing" | "unknown" | string;
}

export interface CloakBrowserDiagnostics {
  checkedAt: string;
  available: boolean;
  error?: string;
  environment?: CloakBrowserDiagnosticsEnvironment;
  binary?: CloakBrowserDiagnosticsBinary;
  launch?: CloakBrowserDiagnosticsLaunch;
  license?: CloakBrowserDiagnosticsLicense;
  geoip?: CloakBrowserDiagnosticsGeoIp;
  fonts?: CloakBrowserDiagnosticsFonts;
  modules?: Record<string, boolean>;
}

export interface BrowserCoreInfo {
  status: BrowserCoreInstallStatus;
  installed: boolean;
  /** What the wrapper reports from disk. `binaryInfo().tier` is `proBinaryReady(...)` with no license check, so it says `pro` whenever a Pro build plus its marker exist — even with no key configured. Never read it as the tier the configuration produces; that is `targetTier`. */
  tier?: BrowserCoreTier;
  /** The cache layout this configuration produces: `ensureBinary` branches on `info.valid` alone, so any valid key lands under `chromium-<version>-pro`. */
  targetTier: BrowserCoreTier;
  /** Whether upstream drops the version pin. That is the only thing `plan === "free"` changes, and a free plan still uses the Pro layout — so this is carried beside `targetTier`, never folded into it. */
  planIsFree: boolean;
  versionMode: BrowserCoreVersionMode;
  pinnedVersion?: string;
  platform: string;
  binaryPath: string;
  cacheDir: string;
  downloadUrl: string;
  versions: BrowserCoreVersionInfo;
  license: BrowserCoreLicenseState;
  env: BrowserCoreEnvRuntimeValue[];
  operation?: BrowserCoreOperation;
  update?: BrowserCoreUpdateCheck;
  /** Present only while the build that actually resolves is one an offline import put there. Absent is "not proven", never "downloaded". */
  importedBuild?: BrowserCoreImportedBuild;
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

// An enabled CLOAKBROWSER_BINARY_PATH short-circuits the wrapper's binary resolution entirely, so
// anything that populates the managed cache — an import above all — cannot take effect while it is
// set. Callers read the resolved runtime env rather than re-deriving the settings/env precedence.
export function binaryPathOverrideFrom(env: BrowserCoreEnvRuntimeValue[]): string | undefined {
  const row = env.find((item) => item.key === "CLOAKBROWSER_BINARY_PATH");
  if (!row?.enabled) return undefined;
  const value = row.value?.trim();
  return value || undefined;
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
