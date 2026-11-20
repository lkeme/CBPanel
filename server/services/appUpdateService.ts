import {
  APP_UPDATE_MANIFEST_MAX_BYTES,
  APP_UPDATE_MANIFEST_URL,
  APP_UPDATE_REPOSITORY,
  APP_UPDATE_REQUEST_TIMEOUT_MS,
  type AppUpdateCheck,
  type AppUpdateDownload,
  appUpdateAssetUrl,
  compareAppVersions,
  mirroredAppUpdateManifestUrl,
  parseAppUpdateManifest,
  selectAppUpdateArtifact,
} from "../../src/shared/appUpdate";
import type { AppSettings, AppSettingsPatch } from "../../src/shared/settings";

export type AppUpdateServiceOptions = {
  currentVersion: string;
  manifestUrl?: string;
  readSettings: () => Promise<AppSettings>;
  saveSettings?: (patch: AppSettingsPatch) => Promise<AppSettings>;
  fetchImpl?: typeof fetch;
  platform?: NodeJS.Platform;
  arch?: string;
  portable?: boolean;
  now?: () => Date;
  /**
   * The mirror prefix a check should use, resolved at call time. Injected rather than read from
   * settings here so `auto-best` keeps using the probe service's measured winner.
   */
  resolveMirrorPrefix?: () => Promise<string | undefined>;
};

export type AppUpdateInfo = {
  currentVersion: string;
  check?: AppUpdateCheck;
};

/**
 * Reads the release manifest `scripts/publish-release.mjs` uploads and compares it with the running
 * build. The manifest URL is the only network destination, and the response is parsed as untrusted
 * input before anything reaches settings or the UI.
 */
export class AppUpdateService {
  private readonly fetchImpl: typeof fetch;

  private readonly now: () => Date;

  private readonly manifestUrl: string;

  private inFlight?: Promise<AppUpdateCheck>;

  constructor(private readonly options: AppUpdateServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.manifestUrl = options.manifestUrl ?? APP_UPDATE_MANIFEST_URL;
  }

  async read(): Promise<AppUpdateInfo> {
    const settings = await this.options.readSettings();
    return {
      currentVersion: this.options.currentVersion,
      check: settings.appUpdate.lastUpdateCheck,
    };
  }

  /** One request at a time: a double click and a startup check share the same answer. */
  check(): Promise<AppUpdateCheck> {
    this.inFlight ??= this.runCheck().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runCheck(): Promise<AppUpdateCheck> {
    const settings = await this.options.readSettings();
    const previous = settings.appUpdate.lastUpdateCheck;
    const attemptedAt = this.now().toISOString();
    const currentVersion = this.options.currentVersion;

    let check: AppUpdateCheck;
    try {
      const manifest = await this.fetchManifest();
      const latestVersion = manifest.version;
      const updateAvailable = compareAppVersions(latestVersion, currentVersion) > 0;
      const artifact = selectAppUpdateArtifact(manifest.artifacts, this.target());
      check = {
        attemptedAt,
        checkedAt: attemptedAt,
        currentVersion,
        latestVersion,
        updateAvailable,
        releaseUrl: `https://github.com/${APP_UPDATE_REPOSITORY}/releases/tag/v${latestVersion}`,
        download: artifact ? toDownload(artifact, latestVersion) : undefined,
      };
    } catch (error) {
      const failure = classifyFailure(error);
      // A failed attempt keeps the last verdict: one flaky network moment must not erase the
      // "update available" the user was already told about.
      check = {
        ...(previous ? { ...previous } : { currentVersion, updateAvailable: false }),
        attemptedAt,
        currentVersion,
        error: failure.message,
        errorCode: failure.code,
      };
    }

    await this.options.saveSettings?.({ appUpdate: { lastUpdateCheck: check } });
    return check;
  }

  private async fetchManifest() {
    const mirrorPrefix = await this.resolveMirrorPrefix();
    const url = new URL(mirroredAppUpdateManifestUrl(this.manifestUrl, mirrorPrefix));
    if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
      throw Object.assign(new Error("The app update manifest must be served over HTTPS."), {
        code: "APP_UPDATE_MANIFEST_URL_UNSUPPORTED",
      });
    }

    const response = await this.fetchImpl(url, { signal: AbortSignal.timeout(APP_UPDATE_REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
      throw Object.assign(new Error(`The app update manifest answered HTTP ${response.status}.`), {
        code: `APP_UPDATE_HTTP_${response.status}`,
      });
    }
    const body = await readBoundedBody(response, APP_UPDATE_MANIFEST_MAX_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw Object.assign(new Error("The app update manifest is not valid JSON."), {
        code: "APP_UPDATE_MANIFEST_INVALID",
      });
    }
    const manifest = parseAppUpdateManifest(parsed);
    if (!manifest) {
      throw Object.assign(new Error("The app update manifest does not describe a release."), {
        code: "APP_UPDATE_MANIFEST_INVALID",
      });
    }
    return manifest;
  }

  private target(): { platform: "windows" | "macos" | "linux" | "unknown"; arch?: string; portable: boolean } {
    const platform = this.options.platform ?? process.platform;
    return {
      platform: platform === "win32" ? "windows" : platform === "darwin" ? "macos" : platform === "linux" ? "linux" : "unknown",
      arch: this.options.arch ?? process.arch,
      portable: this.options.portable ?? false,
    };
  }

  /**
   * A mirror only ever wraps a public GitHub asset. The override URL an operator can point at a local
   * server must stay untouched, or an unrelated (and possibly loopback) destination would be prefixed.
   */
  private async resolveMirrorPrefix(): Promise<string | undefined> {
    if (this.manifestUrl !== APP_UPDATE_MANIFEST_URL) return undefined;
    try {
      return await this.options.resolveMirrorPrefix?.();
    } catch {
      // A mirror that cannot be resolved is not a reason to fail the update check.
      return undefined;
    }
  }
}

function toDownload(
  artifact: NonNullable<ReturnType<typeof selectAppUpdateArtifact>>,
  version: string,
): AppUpdateDownload | undefined {
  // Rebuilt rather than forwarded so the stored URL is the release asset for this exact version, even
  // if the manifest named a different tag.
  const url = appUpdateAssetUrl(version, artifact.fileName) ?? artifact.url;
  return {
    kind: artifact.kind,
    fileName: artifact.fileName,
    url,
    sha256: artifact.sha256,
    size: artifact.size,
  };
}

function classifyFailure(error: unknown): { message: string; code: string } {
  const candidate = error as { message?: string; code?: string; name?: string };
  if (candidate?.name === "TimeoutError" || candidate?.name === "AbortError") {
    return { message: "The app update check timed out.", code: "APP_UPDATE_TIMEOUT" };
  }
  const message = typeof candidate?.message === "string" && candidate.message.trim()
    ? candidate.message.trim()
    : "The app update check failed.";
  return { message, code: typeof candidate?.code === "string" ? candidate.code : "APP_UPDATE_FETCH_FAILED" };
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** Streams the body so a server that never stops writing cannot grow past the budget. */
async function readBoundedBody(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw Object.assign(new Error("The app update manifest is too large."), { code: "APP_UPDATE_MANIFEST_TOO_LARGE" });
    }
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        throw Object.assign(new Error("The app update manifest is too large."), { code: "APP_UPDATE_MANIFEST_TOO_LARGE" });
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8");
}
