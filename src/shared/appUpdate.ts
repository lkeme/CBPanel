export type AppUpdateArtifactKind =
  | "windows-installer"
  | "windows-portable"
  | "linux-appimage"
  | "macos-dmg";

export const APP_UPDATE_ARTIFACT_KINDS: readonly AppUpdateArtifactKind[] = [
  "windows-installer",
  "windows-portable",
  "linux-appimage",
  "macos-dmg",
];

export interface AppUpdateArtifact {
  kind: AppUpdateArtifactKind;
  fileName: string;
  size?: number;
  sha256?: string;
  url: string;
}

/** The release asset `app-update-manifest.json` that `scripts/publish-release.mjs` uploads. */
export interface AppUpdateManifest {
  version: string;
  generatedAt?: string;
  commit?: string;
  signing?: { codeSigned?: boolean; updaterSigned?: boolean };
  artifacts: AppUpdateArtifact[];
  notes?: string[];
}

export interface AppUpdateDownload {
  kind: AppUpdateArtifactKind;
  fileName: string;
  url: string;
  sha256?: string;
  size?: number;
}

export interface AppUpdateCheck {
  /** When the last check produced a verdict. Absent when every attempt has failed. */
  checkedAt?: string;
  /** When the last attempt ran, successful or not. The startup TTL is measured from here. */
  attemptedAt: string;
  currentVersion: string;
  latestVersion?: string;
  updateAvailable: boolean;
  releaseUrl?: string;
  download?: AppUpdateDownload;
  error?: string;
  errorCode?: string;
}

export const APP_UPDATE_STARTUP_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
export const APP_UPDATE_REPOSITORY = "lkeme/CBPanel";
export const APP_UPDATE_MANIFEST_URL =
  `https://github.com/${APP_UPDATE_REPOSITORY}/releases/latest/download/app-update-manifest.json`;
/** A manifest is a few hundred bytes; anything past this is not the file this code wrote. */
export const APP_UPDATE_MANIFEST_MAX_BYTES = 256 * 1024;
export const APP_UPDATE_REQUEST_TIMEOUT_MS = 10_000;

const VERSION_PATTERN = /^v?[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.+-]+)?$/;
const FILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const MAX_VERSION_LENGTH = 64;
const MAX_FILE_NAME_LENGTH = 128;

export function shouldRunStartupAppUpdateCheck(
  check: AppUpdateCheck | undefined,
  now = Date.now(),
): boolean {
  const attemptedAt = check?.attemptedAt ?? check?.checkedAt;
  if (!attemptedAt) return true;
  const attempted = Date.parse(attemptedAt);
  if (!Number.isFinite(attempted)) return true;
  return now - attempted >= APP_UPDATE_STARTUP_CHECK_TTL_MS;
}

/**
 * Compares the numeric core segment by segment. A suffix after the core (`-rc.1`) sorts below the bare
 * core, which is what semver says and what keeps a stray prerelease tag from reading as an upgrade.
 */
export function compareAppVersions(left: string, right: string): number {
  const parse = (value: string): { parts: number[]; prerelease: boolean } => {
    const normalized = value.trim().replace(/^v/, "");
    const prerelease = /[-+]/.test(normalized);
    const core = normalized.split(/[-+]/)[0] ?? "";
    return { parts: core.split(".").map((part) => Number.parseInt(part, 10)), prerelease };
  };
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.parts.length, b.parts.length);
  for (let index = 0; index < length; index += 1) {
    const x = Number.isFinite(a.parts[index]) ? a.parts[index] : 0;
    const y = Number.isFinite(b.parts[index]) ? b.parts[index] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  return a.prerelease ? -1 : 1;
}

/**
 * The manifest comes from the network, so nothing in it is trusted: unknown kinds, malformed file names
 * and URLs that do not point at a GitHub release asset are dropped rather than forwarded to the UI.
 */
export function parseAppUpdateManifest(value: unknown): AppUpdateManifest | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const version = typeof record.version === "string" ? record.version.trim() : "";
  if (!version || version.length > MAX_VERSION_LENGTH || !VERSION_PATTERN.test(version)) return undefined;
  if (!Array.isArray(record.artifacts)) return undefined;

  const artifacts: AppUpdateArtifact[] = [];
  for (const item of record.artifacts) {
    const artifact = parseArtifact(item);
    if (artifact) artifacts.push(artifact);
  }
  if (artifacts.length === 0) return undefined;

  const signing = record.signing && typeof record.signing === "object"
    ? record.signing as Record<string, unknown>
    : undefined;
  const notes = Array.isArray(record.notes)
    ? record.notes.filter((note): note is string => typeof note === "string").slice(0, 20).map((note) => note.slice(0, 500))
    : undefined;

  return {
    version,
    generatedAt: typeof record.generatedAt === "string" ? record.generatedAt : undefined,
    commit: typeof record.commit === "string" ? record.commit : undefined,
    signing: signing
      ? {
        codeSigned: signing.codeSigned === true,
        updaterSigned: signing.updaterSigned === true,
      }
      : undefined,
    artifacts,
    notes,
  };
}

export function selectAppUpdateArtifact(
  artifacts: readonly AppUpdateArtifact[],
  target: { platform: "windows" | "macos" | "linux" | "unknown"; arch?: string; portable: boolean },
): AppUpdateArtifact | undefined {
  if (target.platform === "windows") {
    return artifacts.find((artifact) => artifact.kind === (target.portable ? "windows-portable" : "windows-installer"));
  }
  if (target.platform === "linux") {
    return artifacts.find((artifact) => artifact.kind === "linux-appimage");
  }
  if (target.platform === "macos") {
    const token = target.arch === "arm64" ? "-arm64." : "-x64.";
    return artifacts.find((artifact) => artifact.kind === "macos-dmg" && artifact.fileName.includes(token));
  }
  return undefined;
}

/**
 * The same URL the desktop shell rebuilds from these two fields, so the web build and the desktop build
 * open the identical asset.
 */
export function appUpdateAssetUrl(version: string, fileName: string): string | undefined {
  if (!isSafeVersion(version) || !isSafeFileName(fileName)) return undefined;
  return `https://github.com/${APP_UPDATE_REPOSITORY}/releases/download/v${version}/${fileName}`;
}

export function isSafeVersion(value: string): boolean {
  return value.length > 0 && value.length <= MAX_VERSION_LENGTH && VERSION_PATTERN.test(value);
}

/** The leading alphanumeric keeps `..` and `.hidden` out of the URL path. */
export function isSafeFileName(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_FILE_NAME_LENGTH
    && FILE_NAME_PATTERN.test(value)
    && /^[A-Za-z0-9]/.test(value);
}

function parseArtifact(value: unknown): AppUpdateArtifact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(APP_UPDATE_ARTIFACT_KINDS as readonly string[]).includes(kind)) return undefined;
  const fileName = typeof record.fileName === "string" ? record.fileName.trim() : "";
  if (!isSafeFileName(fileName)) return undefined;
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!isTrustedReleaseAssetUrl(url)) return undefined;
  return {
    kind: kind as AppUpdateArtifactKind,
    fileName,
    size: typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0 ? record.size : undefined,
    sha256: typeof record.sha256 === "string" && /^[a-f0-9]{64}$/i.test(record.sha256) ? record.sha256.toLowerCase() : undefined,
    url,
  };
}

function isTrustedReleaseAssetUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === "https:" && url.hostname === "github.com" && url.pathname.startsWith(`/${APP_UPDATE_REPOSITORY}/releases/download/`);
}
