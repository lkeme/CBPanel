import express from "express";

import type {
  ExtensionCapabilityView,
  ExtensionCatalogSearchPage,
  ExtensionCatalogSearchRequest,
  ExtensionReferenceResolution,
  ExtensionReferenceResolveRequest,
} from "../../src/shared/extensionAcquisition";
import {
  EXTENSION_REFERENCE_INPUT_MAX_LENGTH,
  ExtensionAcquisitionError,
  isValidExtensionAcquisitionCursor,
  normalizeExtensionCatalogQuery,
} from "../services/extensionAcquisitionService";

export interface ExtensionAcquisitionRouteService {
  capabilities(): Promise<ExtensionCapabilityView[]>;
  search(request: ExtensionCatalogSearchRequest, signal?: AbortSignal): Promise<ExtensionCatalogSearchPage>;
  resolve(request: ExtensionReferenceResolveRequest): Promise<ExtensionReferenceResolution>;
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
  response.status(500).json({ error: "Extension acquisition request failed." });
}
