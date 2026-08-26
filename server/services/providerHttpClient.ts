import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionAcquisitionErrorCode } from "../../src/shared/extensionAcquisition";

export const PROVIDER_HTTP_LIMITS = Object.freeze({
  catalogBytes: 4 * 1024 * 1024,
  artifactBytes: 200 * 1024 * 1024,
  redirectHops: 5,
  catalogHeaderTimeoutMs: 10_000,
  catalogIdleTimeoutMs: 10_000,
  artifactHeaderTimeoutMs: 20_000,
  artifactIdleTimeoutMs: 30_000,
  artifactTotalTimeoutMs: 5 * 60_000,
});

export type ProviderRequestKind = "catalog" | "artifact";

export type ProviderHostPolicy = (hostname: string, hop: number) => boolean;

export interface ProviderHttpRequest {
  url: string;
  init?: RequestInit;
  kind: ProviderRequestKind;
  hostPolicy: ProviderHostPolicy;
  signal?: AbortSignal;
  maxBytes: number;
  headerTimeoutMs: number;
  idleTimeoutMs?: number;
  totalTimeoutMs: number;
  maxRedirects?: number;
}

export interface ProviderJsonResponse {
  value: unknown;
  finalHost: string;
  status: number;
}

export interface ProviderDownloadResult {
  path: string;
  size: number;
  sha256: string;
  finalHost: string;
  fetchedAt: string;
}

interface ProviderRequestContext {
  readonly controller: AbortController;
  readonly signal: AbortSignal;
  abort(error: ExtensionProviderError): void;
  error(): ExtensionProviderError;
  throwIfAborted(): void;
  dispose(): void;
}

export class ExtensionProviderError extends Error {
  readonly status: number;

  readonly code: ExtensionAcquisitionErrorCode;

  constructor(code: ExtensionAcquisitionErrorCode, message: string, status: number) {
    super(message);
    this.name = "ExtensionProviderError";
    this.code = code;
    this.status = status;
  }
}

export class ProviderHttpClient {
  private readonly fetchImpl: typeof fetch;

  private readonly now: () => Date;

  constructor(options: { fetchImpl?: typeof fetch; now?: () => Date } = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? (() => new Date());
  }

  async readJson(request: ProviderHttpRequest): Promise<ProviderJsonResponse> {
    const boundedRequest = normalizeRequest(request, PROVIDER_HTTP_LIMITS.catalogBytes);
    let opened: Awaited<ReturnType<ProviderHttpClient["openResponse"]>> | undefined;
    try {
      opened = await this.openResponse(boundedRequest);
      const bytes = await readBoundedBody(opened.response, boundedRequest, opened.context);
      opened.context.throwIfAborted();
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw schemaError(boundedRequest.kind, "Provider returned invalid UTF-8.");
      }
      let value: unknown;
      try {
        value = JSON.parse(text) as unknown;
      } catch {
        throw schemaError(boundedRequest.kind, "Provider returned invalid JSON.");
      }
      opened.context.throwIfAborted();
      return { value, finalHost: opened.url.hostname, status: opened.response.status };
    } catch (error) {
      throw normalizedFailure(error, boundedRequest.kind, boundedRequest.signal, opened?.context);
    } finally {
      opened?.context.dispose();
    }
  }

  async downloadToFile(request: ProviderHttpRequest, destinationPath: string): Promise<ProviderDownloadResult> {
    if (request.kind !== "artifact") {
      throw new TypeError("Only artifact requests can stream to a file.");
    }
    if (!path.isAbsolute(destinationPath) || path.resolve(destinationPath) !== destinationPath) {
      throw new TypeError("Provider download destination must be an absolute normalized path.");
    }
    const boundedRequest = normalizeRequest(request, PROVIDER_HTTP_LIMITS.artifactBytes);
    if (boundedRequest.signal?.aborted) throw cancelledError();
    const partPath = `${destinationPath}.part`;
    try {
      await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    } catch {
      if (boundedRequest.signal?.aborted) throw cancelledError();
      throw new ExtensionProviderError("ARTIFACT_NETWORK", "Cannot prepare the provider download directory.", 500);
    }
    const handle = await fs.open(partPath, "wx").catch((error: NodeJS.ErrnoException) => {
      const alreadyExists = error.code === "EEXIST";
      throw new ExtensionProviderError(
        "ARTIFACT_NETWORK",
        alreadyExists ? "A temporary provider download already exists." : "Cannot create the provider download file.",
        alreadyExists ? 409 : 500,
      );
    });
    let opened: Awaited<ReturnType<ProviderHttpClient["openResponse"]>> | undefined;
    let handleOpen = true;
    try {
      opened = await this.openResponse(boundedRequest);
      const reader = opened.response.body?.getReader();
      if (!reader) throw new ExtensionProviderError("ARTIFACT_NETWORK", "Provider returned no package body.", 502);
      const declaredLength = contentLength(opened.response);
      if (declaredLength !== undefined && declaredLength > boundedRequest.maxBytes) throw tooLarge(boundedRequest.kind);
      const hash = createHash("sha256");
      let size = 0;
      for (;;) {
        const result = await raceStep(
          reader.read(),
          boundedRequest.idleTimeoutMs ?? PROVIDER_HTTP_LIMITS.artifactIdleTimeoutMs,
          opened.context,
          timeoutError(boundedRequest.kind),
        );
        if (result.done) break;
        const chunk = result.value;
        size += chunk.byteLength;
        if (size > boundedRequest.maxBytes) throw tooLarge(boundedRequest.kind);
        hash.update(chunk);
        await writeAll(handle, chunk);
        opened.context.throwIfAborted();
      }
      opened.context.throwIfAborted();
      const result = {
        path: destinationPath,
        size,
        sha256: hash.digest("hex"),
        finalHost: opened.url.hostname,
        fetchedAt: this.now().toISOString(),
      } satisfies ProviderDownloadResult;
      await handle.sync();
      opened.context.throwIfAborted();
      await handle.close();
      handleOpen = false;
      opened.context.throwIfAborted();
      await fs.rename(partPath, destinationPath);
      try {
        opened.context.throwIfAborted();
      } catch (error) {
        // Cancellation can arrive while the atomic rename is in flight. The destination belongs to
        // this operation at that point, so reclaim it instead of publishing a cancelled session file.
        await fs.rm(destinationPath, { force: true }).catch(() => undefined);
        throw error;
      }
      return result;
    } catch (error) {
      throw normalizedFailure(error, boundedRequest.kind, boundedRequest.signal, opened?.context);
    } finally {
      opened?.context.dispose();
      if (handleOpen) await handle.close().catch(() => undefined);
      await fs.rm(partPath, { force: true }).catch(() => undefined);
    }
  }

  private async openResponse(request: ProviderHttpRequest): Promise<{
    response: Response;
    url: URL;
    context: ProviderRequestContext;
  }> {
    let url = validateProviderUrl(request.url, request.hostPolicy, request.kind, 0);
    const context = createRequestContext(request.kind, request.signal, request.totalTimeoutMs);
    const visited = new Set<string>();
    const maxRedirects = Math.min(request.maxRedirects ?? PROVIDER_HTTP_LIMITS.redirectHops, PROVIDER_HTTP_LIMITS.redirectHops);
    let init: RequestInit = { ...request.init, redirect: "manual" };
    try {
      for (let hop = 0; ; hop += 1) {
        context.throwIfAborted();
        const requestUrl = withoutFragment(url);
        if (visited.has(requestUrl.href)) throw redirectLoop(request.kind);
        visited.add(requestUrl.href);
        let response: Response;
        try {
          response = await raceStep(
            this.fetchImpl(requestUrl, {
              ...init,
              signal: context.signal,
            }),
            request.headerTimeoutMs,
            context,
            timeoutError(request.kind),
          );
        } catch (error) {
          throw normalizedFailure(error, request.kind, request.signal, context);
        }
        if (isRedirect(response.status)) {
          if (hop >= maxRedirects) {
            cancelResponseBody(response);
            throw redirectLoop(request.kind);
          }
          const location = response.headers.get("location");
          cancelResponseBody(response);
          if (!location) throw redirectRejected(request.kind);
          const nextUrl = validateProviderUrl(location, request.hostPolicy, request.kind, hop + 1, requestUrl);
          init = redirectedInit(init, requestUrl, nextUrl, response.status);
          url = nextUrl;
          continue;
        }
        if (!response.ok) {
          cancelResponseBody(response);
          throw httpStatusError(request.kind, response.status);
        }
        const declaredLength = contentLength(response);
        if (declaredLength !== undefined && declaredLength > request.maxBytes) {
          cancelResponseBody(response);
          throw tooLarge(request.kind);
        }
        return { response, url: requestUrl, context };
      }
    } catch (error) {
      const normalized = normalizedFailure(error, request.kind, request.signal, context);
      context.dispose();
      throw normalized;
    }
  }
}

function validateProviderUrl(
  raw: string,
  policy: ProviderHostPolicy,
  kind: ProviderRequestKind,
  hop: number,
  base?: URL,
): URL {
  if (!raw || /[\u0000-\u001f\u007f\\]/.test(raw)) throw redirectRejected(kind);
  const absolute = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (absolute) {
    if (!/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(raw)) throw redirectRejected(kind);
    const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1] ?? "";
    if (!authority || /[%@:]/.test(authority) || /[^\x21-\x7e]/.test(authority)) throw redirectRejected(kind);
  } else if (!base || raw.startsWith("//")) {
    throw redirectRejected(kind);
  }
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw redirectRejected(kind);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hostname.endsWith(".")) {
    throw redirectRejected(kind);
  }
  let allowed = false;
  try {
    allowed = policy(url.hostname.toLowerCase(), hop);
  } catch {
    throw redirectRejected(kind);
  }
  if (/%(?:2f|5c)/i.test(url.pathname) || !allowed) throw redirectRejected(kind);
  if (absolute) {
    const authority = /^https:\/\/([^/?#]+)/i.exec(raw)?.[1];
    if (!authority || authority.toLowerCase() !== url.hostname.toLowerCase()) throw redirectRejected(kind);
  }
  return url;
}

function normalizeRequest(request: ProviderHttpRequest, hardByteLimit: number): ProviderHttpRequest {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) {
    throw new TypeError("Provider response byte limit must be a non-negative safe integer.");
  }
  assertPositiveDuration(request.headerTimeoutMs, "header");
  assertPositiveDuration(request.totalTimeoutMs, "total");
  if (request.idleTimeoutMs !== undefined) assertPositiveDuration(request.idleTimeoutMs, "idle");
  if (
    request.maxRedirects !== undefined
    && (!Number.isSafeInteger(request.maxRedirects) || request.maxRedirects < 0)
  ) {
    throw new TypeError("Provider redirect limit must be a non-negative safe integer.");
  }
  return {
    ...request,
    maxBytes: Math.min(request.maxBytes, hardByteLimit),
    maxRedirects: Math.min(request.maxRedirects ?? PROVIDER_HTTP_LIMITS.redirectHops, PROVIDER_HTTP_LIMITS.redirectHops),
  };
}

function assertPositiveDuration(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`Provider ${label} timeout must be a positive finite number.`);
  }
}

function createRequestContext(
  kind: ProviderRequestKind,
  callerSignal: AbortSignal | undefined,
  totalTimeoutMs: number,
): ProviderRequestContext {
  const controller = new AbortController();
  let failure: ExtensionProviderError | undefined;
  const abort = (error: ExtensionProviderError): void => {
    if (controller.signal.aborted) return;
    failure = error;
    controller.abort(error);
  };
  const totalTimer = setTimeout(() => abort(timeoutError(kind)), totalTimeoutMs);
  const onCallerAbort = () => abort(cancelledError());
  callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
  if (callerSignal?.aborted) onCallerAbort();
  return {
    controller,
    signal: controller.signal,
    abort,
    error: () => failure ?? (callerSignal?.aborted ? cancelledError() : networkError(kind)),
    throwIfAborted: () => {
      if (controller.signal.aborted) throw failure ?? networkError(kind);
    },
    dispose: () => {
      clearTimeout(totalTimer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

function normalizedFailure(
  error: unknown,
  kind: ProviderRequestKind,
  callerSignal?: AbortSignal,
  context?: ProviderRequestContext,
): ExtensionProviderError {
  if (error instanceof ExtensionProviderError) return error;
  if (callerSignal?.aborted) return cancelledError();
  if (context?.signal.aborted) return context.error();
  return networkError(kind);
}

function withoutFragment(url: URL): URL {
  if (!url.hash) return url;
  const normalized = new URL(url);
  normalized.hash = "";
  return normalized;
}

function redirectedInit(init: RequestInit, previousUrl: URL, nextUrl: URL, status: number): RequestInit {
  const headers = new Headers(init.headers);
  if (previousUrl.origin !== nextUrl.origin) {
    const crossOriginSafeHeaders = new Set([
      "accept",
      "accept-encoding",
      "accept-language",
      "content-length",
      "content-type",
      "range",
      "user-agent",
    ]);
    for (const name of [...headers.keys()]) {
      if (!crossOriginSafeHeaders.has(name)) headers.delete(name);
    }
  }
  const method = methodOf(init);
  if ((status === 303 && method !== "HEAD") || ((status === 301 || status === 302) && method === "POST")) {
    headers.delete("content-type");
    headers.delete("content-length");
    return { ...init, method: "GET", body: undefined, headers, credentials: "omit" };
  }
  return { ...init, headers, credentials: previousUrl.origin === nextUrl.origin ? init.credentials : "omit" };
}

function cancelResponseBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => undefined);
  } catch {
    // The primary provider failure must not be replaced by best-effort response cleanup.
  }
}

async function readBoundedBody(
  response: Response,
  request: ProviderHttpRequest,
  context: ProviderRequestContext,
): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw schemaError(request.kind, "Provider returned no response body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await raceStep(
        reader.read(),
        request.idleTimeoutMs ?? PROVIDER_HTTP_LIMITS.catalogIdleTimeoutMs,
        context,
        timeoutError(request.kind),
      );
      if (result.done) break;
      size += result.value.byteLength;
      if (size > request.maxBytes) throw tooLarge(request.kind);
      chunks.push(result.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function raceStep<T>(
  operation: Promise<T>,
  timeoutMs: number,
  context: ProviderRequestContext,
  timeout: ExtensionProviderError,
): Promise<T> {
  context.throwIfAborted();
  let timer: NodeJS.Timeout | undefined;
  let removeAbort: (() => void) | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      context.abort(timeout);
      reject(timeout);
    }, Math.max(1, timeoutMs));
  });
  const abortPromise = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      reject(context.error());
    };
    context.signal.addEventListener("abort", onAbort, { once: true });
    removeAbort = () => context.signal.removeEventListener("abort", onAbort);
    if (context.signal.aborted) onAbort();
  });
  try {
    return await Promise.race([operation, timeoutPromise, abortPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    removeAbort?.();
  }
}

async function writeAll(handle: fs.FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw new Error("Provider download write made no progress.");
    offset += bytesWritten;
  }
}

function contentLength(response: Response): number | undefined {
  const raw = response.headers.get("content-length");
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function methodOf(init: RequestInit): string {
  return (init.method ?? "GET").toUpperCase();
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function httpStatusError(kind: ProviderRequestKind, status: number): ExtensionProviderError {
  if (kind === "catalog" && status === 429) {
    return new ExtensionProviderError("EXTENSION_CATALOG_RATE_LIMITED", "The catalog provider is rate limiting requests.", 429);
  }
  if (kind === "artifact" && (status === 404 || status === 410)) {
    return new ExtensionProviderError("ARTIFACT_UNAVAILABLE", "The selected package channel has no current package.", 404);
  }
  return kind === "catalog"
    ? new ExtensionProviderError("EXTENSION_CATALOG_HTTP_ERROR", "The catalog provider returned an HTTP error.", 502)
    : new ExtensionProviderError("ARTIFACT_PROVIDER_HTTP_ERROR", "The package provider returned an HTTP error.", 502);
}

function schemaError(kind: ProviderRequestKind, message: string): ExtensionProviderError {
  return kind === "catalog"
    ? new ExtensionProviderError("EXTENSION_CATALOG_SCHEMA_CHANGED", message, 502)
    : new ExtensionProviderError("ARTIFACT_PROVIDER_HTTP_ERROR", message, 502);
}

function timeoutError(kind: ProviderRequestKind): ExtensionProviderError {
  return kind === "catalog"
    ? new ExtensionProviderError("EXTENSION_CATALOG_TIMEOUT", "The catalog provider timed out.", 504)
    : new ExtensionProviderError("ARTIFACT_TIMEOUT", "The package provider timed out.", 504);
}

function networkError(kind: ProviderRequestKind): ExtensionProviderError {
  return kind === "catalog"
    ? new ExtensionProviderError("EXTENSION_CATALOG_NETWORK", "The catalog provider could not be reached.", 502)
    : new ExtensionProviderError("ARTIFACT_NETWORK", "The package provider could not be reached.", 502);
}

function tooLarge(kind: ProviderRequestKind): ExtensionProviderError {
  return kind === "catalog"
    ? new ExtensionProviderError("EXTENSION_CATALOG_RESPONSE_TOO_LARGE", "The catalog response is too large.", 502)
    : new ExtensionProviderError("ARTIFACT_TOO_LARGE", "The package is larger than the configured limit.", 413);
}

function redirectRejected(kind: ProviderRequestKind): ExtensionProviderError {
  return kind === "catalog"
    ? new ExtensionProviderError(
        "EXTENSION_CATALOG_REDIRECT_REJECTED",
        "The catalog provider returned an unsupported redirect.",
        502,
      )
    : new ExtensionProviderError("ARTIFACT_REDIRECT_REJECTED", "The provider returned an unsupported redirect.", 502);
}

function redirectLoop(kind: ProviderRequestKind): ExtensionProviderError {
  return kind === "catalog"
    ? redirectRejected(kind)
    : new ExtensionProviderError("ARTIFACT_REDIRECT_LOOP", "The provider returned too many or repeated redirects.", 502);
}

function cancelledError(): ExtensionProviderError {
  return new ExtensionProviderError("ACQUISITION_CANCELLED", "The provider operation was cancelled.", 499);
}
