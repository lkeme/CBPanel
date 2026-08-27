import type { ExtensionDirectoryMode, ExtensionEntity } from "../../src/shared/entities";

/** express.raw yields `{}` when the content type does not match and an empty Buffer for empty files. */
export function readUploadedArchive(body: unknown): Buffer {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw Object.assign(new Error("上传内容为空，请重新选择扩展包文件。"), { status: 400 });
  }
  return body;
}

/**
 * body-parser rejects oversized bodies with `type: "entity.too.large"` and the limit in bytes.
 * Returns the message for the API error middleware, or `undefined` when the error is unrelated.
 */
export function payloadTooLargeMessage(error: unknown): string | undefined {
  if (typeof error !== "object" || !error || (error as { type?: unknown }).type !== "entity.too.large") return undefined;
  const limit = Number((error as { limit?: unknown }).limit);
  if (!Number.isFinite(limit) || limit <= 0) return "上传内容超过大小限制。";
  return `上传内容超过大小限制（${Math.round(limit / 1024 / 1024)}MB）。`;
}

export function readDirectoryMode(value: unknown): ExtensionDirectoryMode {
  if (value === undefined || value === null) return "copy";
  if (value === "copy" || value === "reference") return value;
  throw Object.assign(new Error("Extension directory mode must be copy or reference"), {
    status: 400,
    code: "EXTENSION_DIRECTORY_MODE_INVALID",
  });
}

export type ExtensionImportConflictDisposition = "reuse" | "overwrite" | "create";

export type ExtensionImportConflictBody = {
  conflictDisposition?: ExtensionImportConflictDisposition;
  conflictExtensionId?: string;
};

export function readImportConflictOptions(body: unknown): ExtensionImportConflictBody {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const disposition = record.conflictDisposition;
  if (disposition !== undefined && disposition !== "reuse" && disposition !== "overwrite" && disposition !== "create") {
    throw Object.assign(new Error("conflictDisposition must be reuse, overwrite, or create"), {
      status: 400,
      code: "EXTENSION_IMPORT_DISPOSITION_INVALID",
    });
  }
  const conflictExtensionId = typeof record.conflictExtensionId === "string" && record.conflictExtensionId.trim()
    ? record.conflictExtensionId.trim()
    : undefined;
  return {
    conflictDisposition: disposition as ExtensionImportConflictDisposition | undefined,
    conflictExtensionId,
  };
}

/** Upload routes cannot put disposition in a JSON body; clients send it as headers. */
export function readImportConflictHeaders(headers: Record<string, unknown> | undefined): ExtensionImportConflictBody {
  if (!headers) return {};
  const rawDisposition = headers["x-cbpanel-conflict-disposition"] ?? headers["X-CBPanel-Conflict-Disposition"];
  const rawId = headers["x-cbpanel-conflict-extension-id"] ?? headers["X-CBPanel-Conflict-Extension-Id"];
  const disposition = typeof rawDisposition === "string" ? rawDisposition.trim() : undefined;
  if (disposition !== undefined && disposition !== "reuse" && disposition !== "overwrite" && disposition !== "create") {
    throw Object.assign(new Error("conflictDisposition must be reuse, overwrite, or create"), {
      status: 400,
      code: "EXTENSION_IMPORT_DISPOSITION_INVALID",
    });
  }
  const conflictExtensionId = typeof rawId === "string" && rawId.trim() ? rawId.trim() : undefined;
  return {
    conflictDisposition: disposition as ExtensionImportConflictDisposition | undefined,
    conflictExtensionId,
  };
}

export type ExtensionPreferencePatch = Pick<ExtensionEntity, "status" | "updatePolicy">;

/** Ordinary extension writes are preferences only; all identity/package/provenance fields are server-owned. */
export function readExtensionPreferencePatch(body: unknown): Partial<ExtensionPreferencePatch> {
  const record = isRecord(body) ? body : {};
  const patch: Partial<ExtensionPreferencePatch> = {};
  if (record.status !== undefined) {
    if (record.status !== "enabled" && record.status !== "disabled") {
      throw requestError("Extension status must be enabled or disabled", "EXTENSION_STATUS_INVALID");
    }
    patch.status = record.status;
  }
  if (record.updatePolicy !== undefined) {
    if (record.updatePolicy !== "pinned" && record.updatePolicy !== "notify" && record.updatePolicy !== "auto") {
      throw requestError("Extension update policy must be pinned, notify, or auto", "EXTENSION_UPDATE_POLICY_INVALID");
    }
    patch.updatePolicy = record.updatePolicy;
  }
  return patch;
}

export function readBindEnvironmentIds(value: unknown): string[] {
  return readEnvironmentIds(value) ?? [];
}

export function readUnbindEnvironmentIds(value: unknown): string[] | undefined {
  return readEnvironmentIds(value);
}

function readEnvironmentIds(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw Object.assign(new Error("environmentIds must be an array"), { status: 400 });
  }
  return value.filter((item): item is string => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requestError(message: string, code: string): Error {
  return Object.assign(new Error(message), { status: 400, code });
}
