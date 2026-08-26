import express from "express";

import { isCanonicalChromeExtensionId } from "../../src/shared/extensionAcquisition";
import type {
  ExtensionCapabilityView,
  ExtensionCatalogSearchPage,
  ExtensionCatalogSearchRequest,
  ExtensionAcquisitionSessionConfirmRequest,
  ExtensionAcquisitionSessionCreateRequest,
  ExtensionAcquisitionSessionView,
  ExtensionArtifactProviderId,
  ExtensionReferenceResolution,
  ExtensionReferenceResolveRequest,
} from "../../src/shared/extensionAcquisition";
import {
  EXTENSION_REFERENCE_INPUT_MAX_LENGTH,
  ExtensionAcquisitionError,
  isValidExtensionAcquisitionCursor,
  normalizeExtensionCatalogQuery,
} from "../services/extensionAcquisitionService";
import type { ExtensionAcquisitionConfirmationResult } from "../services/extensionAcquisitionSessionService";
import type { ExtensionEntity } from "../../src/shared/entities";

export interface ExtensionAcquisitionRouteService {
  capabilities(): Promise<ExtensionCapabilityView[]>;
  search(request: ExtensionCatalogSearchRequest, signal?: AbortSignal): Promise<ExtensionCatalogSearchPage>;
  resolve(request: ExtensionReferenceResolveRequest): Promise<ExtensionReferenceResolution>;
  createSession(request: ExtensionAcquisitionSessionCreateRequest): Promise<ExtensionAcquisitionSessionView>;
  listSessions(): ExtensionAcquisitionSessionView[];
  getSession(sessionId: string): ExtensionAcquisitionSessionView;
  cancelSession(sessionId: string): Promise<ExtensionAcquisitionSessionView>;
  confirmSession(
    sessionId: string,
    request: ExtensionAcquisitionSessionConfirmRequest,
  ): Promise<ExtensionAcquisitionConfirmationResult>;
  transitionUpdateProvider(extensionId: string, providerId: ExtensionArtifactProviderId): Promise<ExtensionEntity>;
}

/** Mount at `/api/extension-acquisition`; the router intentionally owns no `/api/state` route. */
export function createExtensionAcquisitionRouter(service: ExtensionAcquisitionRouteService): express.Router {
  const router = express.Router();

  router.get("/capabilities", async (request, response) => {
    try {
      assertNoQuery(request);
      response.json(await service.capabilities());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.post("/search", async (request, response) => {
    const requestAbort = requestAbortSignal(request, response);
    try {
      assertNoQuery(request);
      const input = decodeExtensionCatalogSearchRequest(request.body);
      response.json(await service.search(input, requestAbort.signal));
    } catch (error) {
      sendRouteError(response, error);
    } finally {
      requestAbort.dispose();
    }
  });

  router.post("/resolve", async (request, response) => {
    try {
      assertNoQuery(request);
      response.json(await service.resolve(decodeExtensionReferenceResolveRequest(request.body)));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.get("/sessions", (request, response) => {
    try {
      assertNoQuery(request);
      response.json(service.listSessions());
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.post("/sessions", async (request, response) => {
    try {
      assertNoQuery(request);
      response.status(202).json(await service.createSession(decodeSessionCreateRequest(request.body)));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.get("/sessions/:sessionId", (request, response) => {
    try {
      assertNoQuery(request);
      response.json(service.getSession(request.params.sessionId));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.delete("/sessions/:sessionId", async (request, response) => {
    try {
      assertNoQuery(request);
      assertEmptyBody(request.body);
      response.json(await service.cancelSession(request.params.sessionId));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.post("/sessions/:sessionId/confirm", async (request, response) => {
    try {
      assertNoQuery(request);
      response.json(await service.confirmSession(
        request.params.sessionId,
        decodeSessionConfirmRequest(request.body),
      ));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  router.put("/extensions/:extensionId/update-provider", async (request, response) => {
    try {
      assertNoQuery(request);
      const body = strictBody(request.body, ["providerId"]);
      if (body.providerId !== "chrome-web-store" && body.providerId !== "crxsoso") {
        throw new ExtensionAcquisitionError("ACQUISITION_UPDATE_PROVIDER_INVALID");
      }
      response.json(await service.transitionUpdateProvider(request.params.extensionId, body.providerId));
    } catch (error) {
      sendRouteError(response, error);
    }
  });

  return router;
}

export function decodeExtensionCatalogSearchRequest(input: unknown): ExtensionCatalogSearchRequest {
  const body = strictBody(input, ["query", "cursor"]);
  const query = normalizeExtensionCatalogQuery(body.query);
  if (body.cursor === undefined) return { query };
  if (!isValidExtensionAcquisitionCursor(body.cursor)) {
    throw new ExtensionAcquisitionError("EXTENSION_CATALOG_CURSOR_INVALID");
  }
  return { query, cursor: body.cursor };
}

export function decodeExtensionReferenceResolveRequest(input: unknown): ExtensionReferenceResolveRequest {
  const body = strictBody(input, ["input"]);
  if (typeof body.input !== "string") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Extension reference must be a string.");
  }
  if (!body.input.trim()) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_EMPTY", "Enter a supported store URL or canonical extension id.");
  }
  if (body.input.length > EXTENSION_REFERENCE_INPUT_MAX_LENGTH) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Extension reference is too long.");
  }
  return { input: body.input };
}

export function decodeSessionCreateRequest(input: unknown): ExtensionAcquisitionSessionCreateRequest {
  const body = strictBody(input, [
    "namespace",
    "storeId",
    "artifactProviderId",
    "purpose",
    "targetExtensionId",
    "catalogObservationId",
  ]);
  if (body.namespace !== "chrome-web-store" || !isCanonicalChromeExtensionId(body.storeId)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "A canonical Chrome Web Store id is required.");
  }
  if (body.artifactProviderId !== "chrome-web-store" && body.artifactProviderId !== "crxsoso") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Artifact provider is unsupported.");
  }
  if (body.purpose !== "install" && body.purpose !== "update") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Acquisition purpose is unsupported.");
  }
  const targetExtensionId = optionalBoundedId(body.targetExtensionId, "Target extension id");
  const catalogObservationId = optionalOpaqueId(body.catalogObservationId, "Catalog observation id");
  return {
    namespace: "chrome-web-store",
    storeId: body.storeId,
    artifactProviderId: body.artifactProviderId,
    purpose: body.purpose,
    ...(targetExtensionId ? { targetExtensionId } : {}),
    ...(catalogObservationId ? { catalogObservationId } : {}),
  };
}

export function decodeSessionConfirmRequest(input: unknown): ExtensionAcquisitionSessionConfirmRequest {
  const body = strictBody(input, ["disposition", "targetExtensionId", "environmentIds", "permissionApprovalToken"]);
  if (body.disposition !== "create" && body.disposition !== "upgrade" && body.disposition !== "reuse") {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Confirmation disposition is unsupported.");
  }
  if (body.environmentIds !== undefined && !Array.isArray(body.environmentIds)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Environment ids must be an array.");
  }
  const targetExtensionId = optionalBoundedId(body.targetExtensionId, "Target extension id");
  const environmentIds = body.environmentIds === undefined
    ? undefined
    : uniqueBoundedIds(body.environmentIds, "Environment ids");
  const permissionApprovalToken = body.permissionApprovalToken === undefined
    ? undefined
    : optionalOpaqueId(body.permissionApprovalToken, "Permission approval token");
  return {
    disposition: body.disposition,
    ...(targetExtensionId ? { targetExtensionId } : {}),
    ...(environmentIds ? { environmentIds } : {}),
    ...(permissionApprovalToken ? { permissionApprovalToken } : {}),
  };
}

function strictBody(input: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Request body must be a JSON object.");
  }
  const body = input as Record<string, unknown>;
  const unknownKey = Object.keys(body).find((key) => !allowedKeys.includes(key));
  if (unknownKey) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Request body contains unsupported fields.");
  }
  return body;
}

function assertNoQuery(request: express.Request): void {
  if (Object.keys(request.query).length > 0) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "Query-string parameters are not supported.");
  }
}

function assertEmptyBody(input: unknown): void {
  if (input === undefined || input === null) return;
  if (typeof input === "object" && !Array.isArray(input) && Object.keys(input as Record<string, unknown>).length === 0) return;
  throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", "This request does not accept a body.");
}

function optionalBoundedId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", `${label} is invalid.`);
  }
  return value.trim();
}

function optionalOpaqueId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32,128}$/.test(value)) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", `${label} is invalid.`);
  }
  return value;
}

function uniqueBoundedIds(value: unknown[], label: string): string[] {
  if (value.length > 10_000) {
    throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", `${label} exceed the request limit.`);
  }
  return [...new Set(value.map((item) => {
    const id = optionalBoundedId(item, label);
    if (!id) throw new ExtensionAcquisitionError("ACQUISITION_INPUT_UNSUPPORTED", `${label} contain an invalid id.`);
    return id;
  }))];
}

function requestAbortSignal(
  request: express.Request,
  response: express.Response,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (!response.writableEnded && !controller.signal.aborted) controller.abort();
  };
  request.once("aborted", abort);
  response.once("close", abort);
  return {
    signal: controller.signal,
    dispose: () => {
      request.off("aborted", abort);
      response.off("close", abort);
    },
  };
}

function sendRouteError(response: express.Response, error: unknown): void {
  if (response.headersSent || response.destroyed) return;
  if (error instanceof ExtensionAcquisitionError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (
    error
    && typeof error === "object"
    && typeof (error as { code?: unknown }).code === "string"
    && Number.isInteger((error as { status?: unknown }).status)
  ) {
    const status = Number((error as { status: number }).status);
    if (status >= 400 && status <= 599) {
      response.status(status).json({
        error: status >= 500 ? "Extension acquisition request failed safely." : (error as Error).message,
        code: (error as { code: string }).code,
      });
      return;
    }
  }
  response.status(500).json({ error: "Extension acquisition request failed." });
}
