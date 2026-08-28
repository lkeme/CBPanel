import { api } from "./apiClient";
import type { ExtensionEntity } from "../shared/entities";
import type {
  ExtensionAcquisitionSessionConfirmRequest,
  ExtensionAcquisitionSessionCreateRequest,
  ExtensionAcquisitionSessionView,
  ExtensionArtifactProviderId,
  ExtensionCapabilityView,
  ExtensionCatalogItem,
  ExtensionCatalogSearchPage,
  ExtensionCatalogSearchRequest,
  ExtensionReferenceResolution,
  ExtensionReferenceResolveRequest,
} from "../shared/extensionAcquisition";
import type { AppSettings, ExtensionAcquisitionSettingsPatch } from "../shared/settings";

export interface ExtensionAcquisitionConfirmationResult {
  session: ExtensionAcquisitionSessionView;
  extension: ExtensionEntity;
}

export type ExtensionAcquisitionRequest = <Response>(url: string, init?: RequestInit) => Promise<Response>;

export interface ExtensionAcquisitionClient {
  capabilities(signal?: AbortSignal): Promise<ExtensionCapabilityView[]>;
  search(request: ExtensionCatalogSearchRequest, signal?: AbortSignal): Promise<ExtensionCatalogSearchPage>;
  detail?(storeId: string, signal?: AbortSignal): Promise<ExtensionCatalogItem | undefined>;
  resolve(request: ExtensionReferenceResolveRequest, signal?: AbortSignal): Promise<ExtensionReferenceResolution>;
  createSession(
    request: ExtensionAcquisitionSessionCreateRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionAcquisitionSessionView>;
  getSession(sessionId: string, signal?: AbortSignal): Promise<ExtensionAcquisitionSessionView>;
  cancelSession(sessionId: string, signal?: AbortSignal): Promise<ExtensionAcquisitionSessionView>;
  confirmSession(
    sessionId: string,
    request: ExtensionAcquisitionSessionConfirmRequest,
    signal?: AbortSignal,
  ): Promise<ExtensionAcquisitionConfirmationResult>;
  saveSettings(
    patch: ExtensionAcquisitionSettingsPatch,
    signal?: AbortSignal,
  ): Promise<AppSettings>;
  transitionUpdateProvider(
    extensionId: string,
    providerId: ExtensionArtifactProviderId,
    signal?: AbortSignal,
  ): Promise<ExtensionEntity>;
}

const ACQUISITION_API_ROOT = "/api/extension-acquisition";

export function createExtensionAcquisitionClient(
  request: ExtensionAcquisitionRequest = api,
): ExtensionAcquisitionClient {
  return {
    capabilities: (signal) => request<ExtensionCapabilityView[]>(`${ACQUISITION_API_ROOT}/capabilities`, {
      method: "GET",
      signal,
    }),
    search: (body, signal) => request<ExtensionCatalogSearchPage>(`${ACQUISITION_API_ROOT}/search`, jsonRequest(
      "POST",
      body,
      signal,
    )),
    detail: (storeId, signal) => request<ExtensionCatalogItem | undefined>(
      `${ACQUISITION_API_ROOT}/detail/${encodeURIComponent(storeId)}`,
      { method: "GET", signal },
    ),
    resolve: (body, signal) => request<ExtensionReferenceResolution>(`${ACQUISITION_API_ROOT}/resolve`, jsonRequest(
      "POST",
      body,
      signal,
    )),
    createSession: (body, signal) => request<ExtensionAcquisitionSessionView>(
      `${ACQUISITION_API_ROOT}/sessions`,
      jsonRequest("POST", body, signal),
    ),
    getSession: (sessionId, signal) => request<ExtensionAcquisitionSessionView>(
      `${ACQUISITION_API_ROOT}/sessions/${encodeURIComponent(sessionId)}`,
      { method: "GET", signal },
    ),
    cancelSession: (sessionId, signal) => request<ExtensionAcquisitionSessionView>(
      `${ACQUISITION_API_ROOT}/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal },
    ),
    confirmSession: (sessionId, body, signal) => request<ExtensionAcquisitionConfirmationResult>(
      `${ACQUISITION_API_ROOT}/sessions/${encodeURIComponent(sessionId)}/confirm`,
      jsonRequest("POST", body, signal),
    ),
    saveSettings: (patch, signal) => request<AppSettings>("/api/settings", jsonRequest(
      "PUT",
      { extensionAcquisition: patch },
      signal,
    )),
    transitionUpdateProvider: (extensionId, providerId, signal) => request<ExtensionEntity>(
      `${ACQUISITION_API_ROOT}/extensions/${encodeURIComponent(extensionId)}/update-provider`,
      jsonRequest("PUT", { providerId }, signal),
    ),
  };
}

export const extensionAcquisitionClient = createExtensionAcquisitionClient();

function jsonRequest(method: "POST" | "PUT", body: unknown, signal?: AbortSignal): RequestInit {
  return {
    method,
    body: JSON.stringify(body),
    signal,
  };
}
