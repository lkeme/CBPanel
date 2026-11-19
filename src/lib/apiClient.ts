import { invoke, isTauri } from "@tauri-apps/api/core";

import type { TranslationKey } from "../i18n";
import type { ReferenceUsage } from "../shared/entities";
import type { BrowserCoreUpdateCheck } from "../shared/browserCore";
import type { DesktopRuntimeInfo, PlatformChrome, RuntimePlatform, ShellMode } from "../shared/settings";

export type RuntimeError = {
  title: string;
  detail: string;
};

export type ApiError = Error & {
  code?: string;
  params?: Record<string, unknown>;
  usage?: ReferenceUsage;
  candidates?: unknown;
  matchBy?: string;
  permissions?: string[];
};

type ApiErrorResponse = {
  error?: string;
  code?: string;
  params?: Record<string, unknown>;
  usage?: ReferenceUsage;
  candidates?: unknown;
  matchBy?: string;
  permissions?: string[];
};

type RuntimeGlobals = Window & {
  __CBPANEL_API_BASE_URL__?: string;
  __CBPANEL_API_TOKEN__?: string;
  __CBPANEL_DESKTOP_BRIDGE_FAILED__?: boolean;
};

type DesktopBridgeRuntimeConfig = {
  shell: ShellMode;
  platform: RuntimePlatform;
  chrome: PlatformChrome;
  portable: boolean;
  versions?: DesktopRuntimeInfo["versions"];
  apiBaseUrl: string;
  apiToken: string;
  dataDir: string;
  sidecar: {
    status: DesktopRuntimeInfo["sidecar"]["status"];
    detail: string;
  };
};

export async function initializeDesktopBridge(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  onRuntimeConfig: (runtime: DesktopRuntimeInfo) => void,
): Promise<RuntimeError | null> {
  const runtime = window as RuntimeGlobals;
  runtime.__CBPANEL_DESKTOP_BRIDGE_FAILED__ = false;

  if (!isTauri()) {
    delete runtime.__CBPANEL_API_BASE_URL__;
    delete runtime.__CBPANEL_API_TOKEN__;
    return null;
  }

  let config: DesktopBridgeRuntimeConfig;
  try {
    config = await invoke<DesktopBridgeRuntimeConfig>("cbpanel_runtime_config");
  } catch (error) {
    runtime.__CBPANEL_DESKTOP_BRIDGE_FAILED__ = true;
    return runtimeError(t, "error.desktopRuntimeInvoke", { message: errorMessage(error) });
  }

  onRuntimeConfig(desktopInfoFromBridgeConfig(config));

  if (!config.apiBaseUrl || !config.apiToken || config.sidecar.status === "error" || config.sidecar.status === "stopped") {
    runtime.__CBPANEL_DESKTOP_BRIDGE_FAILED__ = true;
    return {
      title: t("error.desktopRuntimeTitle"),
      detail: config.sidecar.detail || t("error.desktopRuntimeMissing"),
    };
  }

  runtime.__CBPANEL_API_BASE_URL__ = config.apiBaseUrl;
  runtime.__CBPANEL_API_TOKEN__ = config.apiToken;

  try {
    await waitForDesktopApi(config.apiBaseUrl, config.apiToken, t);
    return null;
  } catch (error) {
    runtime.__CBPANEL_DESKTOP_BRIDGE_FAILED__ = true;
    return runtimeError(t, "error.desktopRuntimeApi", { message: errorMessage(error) });
  }
}

export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const runtime = window as RuntimeGlobals;
  const token = runtime.__CBPANEL_API_TOKEN__ ?? import.meta.env.VITE_CBPANEL_API_TOKEN;
  const response = await fetch(apiUrl(url), {
    ...init,
    // Headers stay last so a caller overriding Content-Type (binary uploads) keeps the API token.
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-CBPanel-Token": token } : {}),
      ...(init?.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T | ApiErrorResponse) : undefined;
  if (!response.ok) {
    const errorResponse = (parsed ?? {}) as ApiErrorResponse;
    const error = new Error(errorResponse.error ?? `HTTP ${response.status}`) as ApiError;
    error.code = errorResponse.code;
    error.params = errorResponse.params;
    error.usage = errorResponse.usage;
    error.candidates = errorResponse.candidates;
    error.matchBy = errorResponse.matchBy;
    error.permissions = errorResponse.permissions;
    throw error;
  }
  return parsed as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * POSTs a JSON body and consumes a JSON-Lines response, handing each parsed line to `onLine` as it
 * arrives. Used by batch endpoints so a slow node cannot hold back the rows that already answered.
 *
 * A non-OK response is still ordinary JSON (`sendError`), so it is routed through the same error shape
 * as `api()` — a stream that fails upfront must not surface as a parse error on line one.
 */
export async function apiNdjson<T = unknown>(
  url: string,
  body: unknown,
  onLine: (line: T) => void,
  signal?: AbortSignal,
): Promise<void> {
  const runtime = window as RuntimeGlobals;
  const token = runtime.__CBPANEL_API_TOKEN__ ?? import.meta.env.VITE_CBPANEL_API_TOKEN;
  const response = await fetch(apiUrl(url), {
    method: "POST",
    body: JSON.stringify(body),
    signal,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/x-ndjson",
      ...(token ? { "X-CBPanel-Token": token } : {}),
    },
  });

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    let errorResponse: ApiErrorResponse = {};
    try {
      errorResponse = text ? (JSON.parse(text) as ApiErrorResponse) : {};
    } catch {
      // A non-JSON error body still has a status worth reporting.
    }
    const error = new Error(errorResponse.error ?? `HTTP ${response.status}`) as ApiError;
    error.code = errorResponse.code;
    error.params = errorResponse.params;
    error.usage = errorResponse.usage;
    error.candidates = errorResponse.candidates;
    error.matchBy = errorResponse.matchBy;
    error.permissions = errorResponse.permissions;
    throw error;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) onLine(JSON.parse(line) as T);
        newline = buffer.indexOf("\n");
      }
      if (done) break;
    }
    const tail = buffer.trim();
    if (tail) onLine(JSON.parse(tail) as T);
  } finally {
    reader.releaseLock();
  }
}

const PROXY_FETCH_REASON_KEYS: Record<string, TranslationKey> = {
  dns: "error.proxyFetch.dns",
  refused: "error.proxyFetch.refused",
  reset: "error.proxyFetch.reset",
  timeout: "error.proxyFetch.timeout",
  tls: "error.proxyFetch.tls",
  network: "error.proxyFetch.network",
  body: "error.proxyFetch.body",
};

/**
 * A proxy import or subscription error in the active locale. The server sends `code` plus params —
 * the host and an OS-level reason, never the token-bearing address — and the dictionary turns them
 * into a sentence; unknown shapes fall back to the server's own message.
 */
export function proxyImportErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const apiError = error as ApiError | undefined;
  const code = apiError?.code;
  const params = (apiError?.params ?? {}) as Record<string, unknown>;
  switch (code) {
    case "PROXY_SUBSCRIPTION_FETCH_FAILED": {
      const host = String(params.host ?? "");
      if (params.reason === "http-status") {
        return t("error.proxyFetchHttp", { status: Number(params.status ?? 0), host });
      }
      const reasonKey = PROXY_FETCH_REASON_KEYS[String(params.reason ?? "network")];
      const reason = t(reasonKey ?? "error.proxyFetch.network");
      const detail = typeof params.detail === "string" ? params.detail : "";
      return detail
        ? t("error.proxyFetchWithDetail", { reason, host, detail })
        : t("error.proxyFetch", { reason, host });
    }
    case "PROXY_SUBSCRIPTION_TOO_LARGE":
      return t("error.proxySubscriptionTooLarge", { limitMb: Number(params.limitMb ?? 4) });
    case "PROXY_IMPORT_UNSUPPORTED_FORMAT":
      return t(params.format === "html" ? "error.proxyImportHtml" : params.format === "json" ? "error.proxyImportJson" : "error.proxyImportEmpty");
    case "PROXY_IMPORT_EMPTY":
      return t("error.proxyImportEmpty");
    case "PROXY_IMPORT_PROVIDERS_ONLY":
      return t("error.proxyImportProvidersOnly", { count: Number(params.providers ?? 0) });
    case "PROXY_IMPORT_UNRECOGNIZED": {
      const sample = typeof params.sample === "string" ? params.sample : "";
      const sampleError = typeof params.sampleError === "string" ? params.sampleError : "";
      return sample
        ? t("error.proxyImportUnrecognizedSample", { total: Number(params.total ?? 0), sample, sampleError })
        : t("error.proxyImportUnrecognized", { total: Number(params.total ?? 0) });
    }
    default:
      return errorMessage(error);
  }
}

export function referenceErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (isReferenceConflict(error)) {
    return t("error.referenceConflict", { count: error.usage.count });
  }
  return errorMessage(error);
}

const EXTENSION_ERROR_KEYS: Record<string, TranslationKey> = {
  EXTENSION_IN_USE: "error.extensionInUse",
  EXTENSION_IDENTITY_PINNED: "error.extensionIdentityPinned",
  EXTENSION_REFERENCE_MODE: "error.extensionReferenceMode",
  EXTENSION_WEB_STORE: "error.extensionWebStore",
  EXTENSION_DIRECTORY_MODE_INVALID: "error.extensionDirectoryModeInvalid",
  EXTENSION_IMPORT_CONFLICT: "error.extensionImportConflict",
  EXTENSION_IMPORT_DISPOSITION_INVALID: "error.extensionImportDispositionInvalid",
  EXTENSION_IMPORT_CONFLICT_TARGET: "error.extensionImportConflictTarget",
};

export function extensionErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const code = error instanceof Error ? (error as ApiError).code : undefined;
  const key = code ? EXTENSION_ERROR_KEYS[code] : undefined;
  if (key) return t(key);
  return referenceErrorMessage(error, t);
}

const BROWSER_CORE_ERROR_KEYS: Record<string, TranslationKey> = {
  BROWSER_CORE_LICENSE_REQUIRED: "error.browserCoreLicenseRequired",
  BROWSER_CORE_LICENSE_INVALID: "error.browserCoreLicenseInvalid",
  BROWSER_CORE_UPDATE_INCOMPLETE: "error.browserCoreUpdateIncomplete",
  BROWSER_CORE_OPERATION_IN_PROGRESS: "error.browserCoreOperationInProgress",
  BROWSER_CORE_SESSIONS_RUNNING: "error.browserCoreSessionsRunning",
  BROWSER_CORE_OFFLINE_MODE: "browserCore.offlineModeHint",
  BROWSER_CORE_ACTIVATION_REQUIRED: "error.browserCoreActivationRequired",
  BROWSER_CORE_UPDATE_CONTEXT_CHANGED: "error.browserCoreUpdateContextChanged",
  BROWSER_CORE_ACTIVATION_CONTEXT_CHANGED: "error.browserCoreActivationContextChanged",
  BROWSER_CORE_CUSTOM_BINARY_ACTIVE: "error.browserCoreCustomBinaryActive",
  BROWSER_CORE_CACHE_ROOT_INVALID: "error.browserCoreCacheRootInvalid",
  BROWSER_CORE_MISSING: "browserCore.missingAction",
  PRIVATE_REPOSITORY_REQUIRED: "error.privateRepositoryRequired",
  PRIVATE_REPOSITORY_INVALID: "error.privateRepositoryInvalid",
  PRIVATE_TOKEN_REQUIRED: "error.privateTokenRequired",
  PRIVATE_TOKEN_INVALID: "error.privateTokenInvalid",
  PRIVATE_TOKEN_STORAGE_UNAVAILABLE: "error.privateTokenStorageUnavailable",
  PRIVATE_TOKEN_IDENTITY_INVALID: "error.privateTokenIdentityInvalid",
  PRIVATE_TOKEN_ENV_MANAGED: "error.privateTokenEnvManaged",
  PRIVATE_RELEASES_HTTP_ERROR: "error.privateReleasesHttp",
  PRIVATE_RELEASES_SCHEMA_ERROR: "error.privateReleasesSchema",
  PRIVATE_RELEASES_LIMIT: "error.privateReleasesLimit",
  PRIVATE_RELEASE_NOT_FOUND: "error.privateReleaseNotFound",
  PRIVATE_RELEASE_ASSET_MISSING: "error.privateReleaseAssetMissing",
  PRIVATE_RELEASE_CHECKSUM_MISSING: "error.privateReleaseChecksumMissing",
  PRIVATE_RELEASE_CHECKSUM_MISMATCH: "error.privateReleaseChecksumMismatch",
  PRIVATE_RELEASE_VERSION_MISMATCH: "error.privateReleaseVersionMismatch",
  PRIVATE_RELEASE_SOURCE_CHANGED: "error.privateReleaseSourceChanged",
  PRIVATE_CONFIGURATION_CHANGED: "error.privateConfigurationChanged",
  PRIVATE_RELEASE_EXECUTABLE_MISSING: "error.privateReleaseExecutableMissing",
  PRIVATE_RELEASE_REDIRECT_REJECTED: "error.privateReleaseRedirectRejected",
  PRIVATE_RELEASE_TOO_LARGE: "error.privateReleaseTooLarge",
  PRIVATE_RELEASE_EMPTY_BODY: "error.privateReleaseEmptyBody",
  PRIVATE_RELEASE_DOWNLOAD_ERROR: "error.privateReleaseDownload",
  PRIVATE_CORE_NOT_INSTALLED: "error.privateCoreNotInstalled",
  // The import refusals reuse the dialog's reason strings so the toast and the dialog say the same
  // thing. Those are clause fragments, so they are wrapped below instead of duplicated as sentences.
  BROWSER_CORE_IMPORT_SESSIONS_RUNNING: "browserCore.importRefusalSessionsRunning",
  BROWSER_CORE_IMPORT_UNVERIFIED: "browserCore.importRefusalUnverified",
};

export function browserCoreErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const code = error instanceof Error ? (error as ApiError).code : undefined;
  const key = code ? BROWSER_CORE_ERROR_KEYS[code] : undefined;
  if (!key) return errorMessage(error);
  return code?.startsWith("BROWSER_CORE_IMPORT_") ? t("browserCore.importBlocked", { reason: t(key) }) : t(key);
}

export function browserCoreUpdateErrorMessage(
  update: BrowserCoreUpdateCheck,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return browserCoreErrorMessage(Object.assign(new Error(update.error), { code: update.errorCode }), t);
}

const LAUNCH_ERROR_KEYS: Record<string, TranslationKey> = {
  // The reason is upstream's, and it is the only accurate account of why the core refused; the key wraps it
  // with where to act, which the reason alone cannot say.
  BROWSER_CORE_LICENSE_DENIED: "toast.launchLicenseDenied",
  // An over-cap seat is not a key problem: the remedy is closing a running session, so it must not send the
  // operator to the licence field.
  BROWSER_CORE_LICENSE_SESSION_LIMIT: "toast.launchLicenseSessionLimit",
};

// Every launch failure toast goes through here. The licence rule started out inline at one of the two
// launch call sites, which is how the ordinary launch — the one that is not a brand-new draft — ended up
// showing the bare reason with no pointer at the core settings.
export function launchErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const code = error instanceof Error ? (error as ApiError).code : undefined;
  const key = code ? LAUNCH_ERROR_KEYS[code] : undefined;
  if (code === "BROWSER_CORE_LICENSE_REQUIRED" || code === "BROWSER_CORE_LICENSE_INVALID") return browserCoreErrorMessage(error, t);
  // Launching a new draft saves it first, so the store's name 409 surfaces on the launch path and not only
  // through saveDraft. Chaining rather than branching per call site is what keeps that 409 translated.
  if (!key) return profileErrorMessage(error, t);
  return t(key, { reason: errorMessage(error) });
}

const PROFILE_ERROR_KEYS: Record<string, TranslationKey> = {
  PROFILE_NAME_DUPLICATE: "form.profileNameDuplicate",
  PROFILE_NAME_DUPLICATE_IN_TRASH: "form.profileNameDuplicateInTrash",
};

// The store phrases its 409 bodies as Chinese literals, so the code has to be translated rather than
// echoed or an en-US panel shows Chinese. The same rules are also checked in the panel before the request,
// and that path throws a plain Error whose message is already translated — hence the untouched fallback,
// which would otherwise swallow the inline validation message.
export function profileErrorMessage(
  error: unknown,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  const code = error instanceof Error ? (error as ApiError).code : undefined;
  const key = code ? PROFILE_ERROR_KEYS[code] : undefined;
  if (!key) return errorMessage(error);
  return t(key);
}

function isReferenceConflict(error: unknown): error is ApiError & { usage: ReferenceUsage } {
  return error instanceof Error && (error as ApiError).code === "REFERENCE_CONFLICT" && Boolean((error as ApiError).usage);
}

async function waitForDesktopApi(
  baseUrl: string,
  token: string,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): Promise<void> {
  const deadline = Date.now() + 8_000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/desktop/runtime", baseUrl), {
        headers: {
          "X-CBPanel-Token": token,
        },
      });
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(250);
  }
  throw lastError instanceof Error ? lastError : new Error(t("error.desktopRuntimeWait"));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function apiUrl(pathname: string): string {
  const runtime = window as RuntimeGlobals;
  const baseUrl = runtime.__CBPANEL_API_BASE_URL__ ?? import.meta.env.VITE_CBPANEL_API_BASE_URL ?? "";
  return baseUrl ? new URL(pathname, baseUrl).toString() : pathname;
}

function desktopInfoFromBridgeConfig(config: DesktopBridgeRuntimeConfig): DesktopRuntimeInfo {
  return {
    shell: config.shell,
    platform: config.platform,
    chrome: config.chrome,
    portable: config.portable,
    versions: config.versions ?? {},
    api: {
      host: "127.0.0.1",
      port: portFromApiBaseUrl(config.apiBaseUrl),
      tokenRequired: Boolean(config.apiToken),
    },
    sidecar: config.sidecar,
  };
}

function portFromApiBaseUrl(apiBaseUrl: string): number {
  try {
    return Number(new URL(apiBaseUrl).port);
  } catch {
    return 0;
  }
}

function runtimeError(
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  detailKey: TranslationKey,
  params?: Record<string, string | number>,
): RuntimeError {
  return {
    title: t("error.desktopRuntimeTitle"),
    detail: t(detailKey, params),
  };
}
