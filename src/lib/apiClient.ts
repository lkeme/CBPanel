import { invoke, isTauri } from "@tauri-apps/api/core";

import type { TranslationKey } from "../i18n";
import type { ReferenceUsage } from "../shared/entities";
import type { DesktopRuntimeInfo, PlatformChrome, RuntimePlatform, ShellMode } from "../shared/settings";

export type RuntimeError = {
  title: string;
  detail: string;
};

export type ApiError = Error & {
  code?: string;
  usage?: ReferenceUsage;
};

type ApiErrorResponse = {
  error?: string;
  code?: string;
  usage?: ReferenceUsage;
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
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "X-CBPanel-Token": token } : {}),
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  if (response.status === 204) return undefined as T;
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as T | ApiErrorResponse) : undefined;
  if (!response.ok) {
    const errorResponse = (parsed ?? {}) as ApiErrorResponse;
    const error = new Error(errorResponse.error ?? `HTTP ${response.status}`) as ApiError;
    error.code = errorResponse.code;
    error.usage = errorResponse.usage;
    throw error;
  }
  return parsed as T;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
