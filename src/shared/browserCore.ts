import type {
  BrowserCoreChannel,
  BrowserCoreChannelMode,
  BrowserCoreEnvValueKind,
  BrowserCoreReleaseChannel,
  BuiltinCloakBrowserEnvKey,
} from "./settings";

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

// A configured key can be awaiting validation, confirmed, rejected, or temporarily unverifiable.
export interface BrowserCoreLicenseState {
  /** A license key is on file in settings, whether or not it is in use. */
  configured: boolean;
  /** A key resolves from settings, the external environment, or the configured cache's license.key. */
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
  playwrightCoreVersion?: string;
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
    /** Bytes received so far and expected in total, when the source reports the sizes. */
    receivedBytes?: number;
    totalBytes?: number;
    /** Transfer rate measured between progress reports, in bytes per second. */
    bytesPerSecond?: number;
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
  errorCode?: string;
}

export interface BrowserCoreTargetVersion {
  version: string;
  versionMode: BrowserCoreVersionMode;
  releaseChannel: BrowserCoreReleaseChannel;
  platform: string;
}

export function browserCoreLicenseIssue(info: { licenseRequired?: boolean; licenseValid?: boolean } | null | undefined): "required" | "invalid" | undefined {
  if (info?.licenseRequired) return "required";
  if (info?.licenseValid === false) return "invalid";
  return undefined;
}

/** The settings editor asks for the full CloakBrowser build, including its revision. */
export function browserCorePinIssue(value: string): "required" | "chromium-only" | "invalid" | undefined {
  const version = value.trim();
  if (!version) return "required";
  if (!/^\d+(?:\.\d+){3,4}$/.test(version) || version.split(".").some((part) => !Number.isSafeInteger(Number(part)))) return "invalid";
  return version.split(".").length === 4 ? "chromium-only" : undefined;
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

/** What each channel has on disk, independent of which one is active. `version` is absent with `installed: false`. */
export interface BrowserCoreChannelState {
  installed: boolean;
  version?: string;
}

export interface BrowserCoreChannelStates {
  official: BrowserCoreChannelState;
  private: BrowserCoreChannelState;
}

/**
 * The official channel's license as its own card needs it. The running channel reports its license in
 * `core.license`; this exists because a private activation suspends validation and reports the private
 * placeholder there, which would otherwise leave the official card unable to tell a configured key from
 * a missing one.
 */
export interface BrowserCoreOfficialLicenseState {
  /** Whether a key is configured at all — not whether it works. */
  configured: boolean;
  /** The last verdict for that key, when one was ever obtained. */
  valid?: boolean;
  plan?: string;
}

export interface BrowserCoreImportAnalysis {
  filePath: string;
  fileName: string;
  fileSize: number;
  sha256: string;
  platform: string;
  targetTier: BrowserCoreTier;
  targetChannel?: BrowserCoreChannel;
  /** Operator-supplied full build version when the archive identifies only Chromium's four parts. */
  versionHint?: string;
  embeddedVersion?: string;
  requiresVersionHint?: boolean;
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

export type CloakBrowserDiagnosticsSessionState = "ok" | "unreachable" | "denied" | "unknown";

export interface CloakBrowserDiagnosticsLicense {
  tier?: string;
  valid?: boolean;
  expires?: string;
  error?: string;
  sessions?: {
    active?: number | null;
    limit?: number | null;
    state?: CloakBrowserDiagnosticsSessionState;
    reason?: string | null;
  };
}

// Mirrors upstream `diag.geoip.resolved` from `cloakbrowser info --proxy <url>` (0.5.10): the exit IP
// a launch would egress from, plus the timezone and locale `geoip: true` would derive from it. Upstream
// reports `exit_ip`; the field is camelCased here like every other diagnostics key. `error` is set when
// the resolution itself failed, exactly as upstream's `{ error }` branch does.
export interface CloakBrowserDiagnosticsGeoIpResolved {
  exitIp?: string;
  timezone?: string;
  locale?: string;
  error?: string;
}

export interface CloakBrowserDiagnosticsGeoIp {
  dbPresent?: boolean;
  path?: string;
  /** Present whenever a proxy was supplied, even if nothing came back — upstream keeps the key with null fields and prints `(unknown)`. Absent therefore means "no proxy was given", never "resolved to nothing". */
  resolved?: CloakBrowserDiagnosticsGeoIpResolved;
}

export interface CloakBrowserDiagnosticsFonts {
  /** Linux-only persona font probes: null means the probe could not run. */
  windows?: [present: number, total: number] | null;
  office?: [present: number, total: number] | null;
  macos?: [present: number, total: number] | null;
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
  /** The active source channel selected by the operator. */
  channel?: BrowserCoreChannel;
  /** Offline mode disables network update checks for the active channel. */
  channelMode?: BrowserCoreChannelMode;
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
  /** Whether an official license applies to the active channel. */
  licensePolicy?: "official" | "not-applicable";
  privateTokenConfigured?: boolean;
  /** What each channel has on disk, for gestures and activation without a server round trip. */
  channels: BrowserCoreChannelStates;
  /** The official channel's key state, independent of which channel is running. */
  officialLicense: BrowserCoreOfficialLicenseState;
  env: BrowserCoreEnvRuntimeValue[];
  operation?: BrowserCoreOperation;
  update?: BrowserCoreUpdateCheck;
  /** Present only while the build that actually resolves is one an offline import put there. Absent is "not proven", never "downloaded". */
  importedBuild?: BrowserCoreImportedBuild;
  portable: boolean;
  cacheManagedByCBPanel: boolean;
  restartRequired: boolean;
  detail?: string;
}

export interface BinaryInfo {
  licenseRequired?: boolean;
  licenseValid?: boolean;
  version: string;
  bundledVersion?: string;
  tier?: BrowserCoreTier;
  platform: string;
  binaryPath: string;
  installed: boolean;
  cacheDir: string;
  downloadUrl: string;
  core?: BrowserCoreInfo;
}

export interface BrowserCorePrivateReleaseAsset {
  name: string;
  size?: number;
  downloadUrl: string;
  checksum?: string;
  platform: string;
}

export interface BrowserCorePrivateRelease {
  id: number;
  tagName?: string;
  title: string;
  version: string;
  publishedAt?: string;
  assets: BrowserCorePrivateReleaseAsset[];
  verified: true;
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
  if (!row?.enabled || row.source === "cbpanel-default") return undefined;
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
