import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ExtensionImportDialogState } from "../components/registry/RegistryDialogs";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, type ApiError, errorMessage, extensionErrorMessage } from "../lib/apiClient";
import { shortExtensionId } from "../lib/utils";
import type {
  ExtensionDirectoryImportResult,
  ExtensionDirectoryMode,
  ExtensionDirectoryPreviewResult,
  ExtensionEntity,
  ExtensionUpdatePolicy,
} from "../shared/entities";
import type { BrowserProfile } from "../shared/profile";

type ExtensionImportConflictDisposition = "reuse" | "overwrite" | "create";

type ExtensionImportConflictOptions = {
  conflictDisposition?: ExtensionImportConflictDisposition;
  conflictExtensionId?: string;
};

const AUTO_CHECK_CONCURRENCY = 3;
const AUTO_CHECK_MIN_INTERVAL_MS = 60_000;
const autoCheckMemory = new Map<string, number>();

export type ExtensionMutationRefreshOutcome<T> =
  | { status: "success"; value: T; refreshError?: unknown }
  | { status: "failure"; error: unknown; refreshError?: unknown };

export type ExtensionMutationRefreshContext = "mutation-succeeded" | "mutation-failed";

export function extensionRefreshFailureTranslationKey(
  context: ExtensionMutationRefreshContext | "background",
): TranslationKey {
  if (context === "mutation-succeeded") return "toast.extensionMutationRefreshFailed";
  if (context === "mutation-failed") return "toast.extensionFailureRefreshFailed";
  return "toast.extensionStateRefreshFailed";
}

export async function runExtensionMutationWithRefresh<T>({
  mutate,
  onMutationFailure,
  onMutationSuccess,
  onRefreshFailure,
  refresh,
  refreshAfterMutationFailure = false,
}: {
  mutate: () => Promise<T>;
  onMutationFailure: (error: unknown) => void;
  onMutationSuccess: (value: T) => void;
  onRefreshFailure: (error: unknown, context: ExtensionMutationRefreshContext) => void;
  refresh: () => Promise<unknown>;
  refreshAfterMutationFailure?: boolean;
}): Promise<ExtensionMutationRefreshOutcome<T>> {
  let value: T;
  try {
    value = await mutate();
  } catch (error) {
    // Report the primary mutation failure before attempting reconciliation. A slow or failed
    // state refresh must never delay, replace, or hide the operation's real outcome.
    onMutationFailure(error);
    if (!refreshAfterMutationFailure) return { status: "failure", error };
    const refreshError = await refreshExtensionState(
      refresh,
      (refreshFailure) => onRefreshFailure(refreshFailure, "mutation-failed"),
    );
    return {
      status: "failure",
      error,
      ...(refreshError === undefined ? {} : { refreshError }),
    };
  }

  // The server mutation is already committed. Announce that success independently, then reconcile
  // the global projection; a reconciliation failure is a warning, not a mutation rollback.
  onMutationSuccess(value);
  const refreshError = await refreshExtensionState(
    refresh,
    (refreshFailure) => onRefreshFailure(refreshFailure, "mutation-succeeded"),
  );
  return {
    status: "success",
    value,
    ...(refreshError === undefined ? {} : { refreshError }),
  };
}

async function refreshExtensionState(
  refresh: () => Promise<unknown>,
  onRefreshFailure: (error: unknown) => void,
): Promise<unknown | undefined> {
  try {
    await refresh();
    return undefined;
  } catch (error) {
    onRefreshFailure(error);
    return error;
  }
}

function isImportConflict(error: unknown): error is ApiError & {
  code: "EXTENSION_IMPORT_CONFLICT";
  candidates: ExtensionEntity[];
  matchBy?: string;
} {
  if (!(error instanceof Error)) return false;
  const apiError = error as ApiError;
  return apiError.code === "EXTENSION_IMPORT_CONFLICT" && Array.isArray(apiError.candidates) && apiError.candidates.length > 0;
}

function isPermissionGateError(error: unknown): error is ApiError & { permissions?: string[] } {
  return error instanceof Error && Array.isArray((error as ApiError).permissions) && ((error as ApiError).permissions?.length ?? 0) > 0;
}

export function canAutoCheckExtension(extension: ExtensionEntity): boolean {
  if (extension.updatePolicy === "pinned") return false;
  // Verified store updates use acquisition sessions and explicit preflight/permission confirmation.
  // The legacy auto-check contract expects an ExtensionEntity response and must not consume a session view.
  if (extension.updateProviderId || extension.storeIdentity) return false;
  if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") return Boolean(extension.sourceUrl);
  if (extension.sourceKind === "local-directory") return Boolean(extension.sourceUrl || extension.localPath);
  return false;
}

export function useExtensionActions({
  draft,
  draftIsNew,
  loadState,
  selectedProfiles: _selectedProfiles,
  setBusy,
  setConfirmDialog,
  setExtensionImport,
  t,
  toast,
}: {
  draft: BrowserProfile | null;
  draftIsNew: boolean;
  loadState: () => Promise<unknown>;
  selectedProfiles: BrowserProfile[];
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setExtensionImport: Dispatch<SetStateAction<ExtensionImportDialogState>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  void _selectedProfiles;

  function notifyRefreshFailure(error: unknown, context: ExtensionMutationRefreshContext) {
    toast("info", t(extensionRefreshFailureTranslationKey(context), { message: errorMessage(error) }));
  }

  function notifyBackgroundRefreshFailure(error: unknown) {
    toast("info", t(extensionRefreshFailureTranslationKey("background"), { message: errorMessage(error) }));
  }

  function runMutation<T>({
    mutate,
    onFailure = (error) => toast("error", extensionErrorMessage(error, t)),
    onSuccess,
    refreshAfterFailure = false,
  }: {
    mutate: () => Promise<T>;
    onFailure?: (error: unknown) => void;
    onSuccess: (value: T) => void;
    refreshAfterFailure?: boolean;
  }) {
    return runExtensionMutationWithRefresh({
      mutate,
      onMutationFailure: onFailure,
      onMutationSuccess: onSuccess,
      onRefreshFailure: notifyRefreshFailure,
      refresh: loadState,
      refreshAfterMutationFailure: refreshAfterFailure,
    });
  }

  function promptImportConflict(
    candidates: ExtensionEntity[],
    matchBy: string | undefined,
    retry: (options: ExtensionImportConflictOptions) => Promise<void>,
  ) {
    const primary = candidates[0]!;
    const matchLabel = matchBy === "manifestKey"
      ? t("extension.conflict.matchKey")
      : matchBy === "sha256"
        ? t("extension.conflict.matchSha")
        : matchBy === "manifestSha256"
          ? t("extension.conflict.matchManifest")
          : matchBy === "nameVersion"
            ? t("extension.conflict.matchNameVersion")
            : t("extension.conflict.matchSource");
    // The name+version layer routinely matches several records at once, and they print an identical
    // name and version, so the body alone cannot say which one reuse/overwrite would touch. Name the
    // target with the same short ID the list chips show, plus its path.
    const targetNote = candidates.length > 1
      ? ` ${t("extension.conflict.target", {
        count: candidates.length,
        id: shortExtensionId(primary.id),
        path: primary.localPath || primary.sourceUrl || t("module.extensionNoPath"),
      })}`
      : "";
    setConfirmDialog({
      title: t("extension.conflict.title", { name: primary.name }),
      body: `${t("extension.conflict.body", {
        name: primary.name,
        version: primary.version,
        match: matchLabel,
      })}${targetNote}`,
      confirmLabel: t("actions.confirm"),
      cancelLabel: t("actions.cancel"),
      tone: "warning",
      busyKey: "extension-import-conflict",
      choice: {
        defaultValue: "reuse",
        footerNote: t("extension.conflict.footer"),
        options: [
          { value: "reuse", label: t("extension.conflict.reuse") },
          { value: "overwrite", label: t("extension.conflict.overwrite") },
          { value: "create", label: t("extension.conflict.create") },
        ],
      },
      onConfirm: async ({ choice }) => {
        const disposition = (choice === "overwrite" || choice === "create" || choice === "reuse")
          ? choice
          : "reuse";
        setBusy("extension-import-conflict");
        try {
          await runMutation({
            mutate: () => retry({
              conflictDisposition: disposition,
              conflictExtensionId: disposition === "create" ? undefined : primary.id,
            }),
            onSuccess: () => {
              setConfirmDialog(null);
              setExtensionImport(null);
              toast(
                "success",
                disposition === "reuse"
                  ? t("toast.extensionImportReused")
                  : disposition === "overwrite"
                    ? t("toast.extensionImportOverwritten")
                    : t("toast.extensionImported"),
              );
            },
          });
        } finally {
          setBusy("");
        }
      },
    });
  }

  async function importExtensionDirectoryPath(directory: string, mode: ExtensionDirectoryMode = "copy") {
    if (!directory.trim()) return;
    setBusy("extension-import-directory");
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>("/api/extensions/import-directory", {
          method: "POST",
          body: JSON.stringify({ path: directory.trim(), mode }),
        }),
        onFailure: (error) => {
          if (isImportConflict(error)) {
            promptImportConflict(error.candidates as ExtensionEntity[], error.matchBy, async (options) => {
              await api<ExtensionEntity>("/api/extensions/import-directory", {
                method: "POST",
                body: JSON.stringify({ path: directory.trim(), mode, ...options }),
              });
            });
            return;
          }
          toast("error", extensionErrorMessage(error, t));
        },
        onSuccess: () => {
          setExtensionImport(null);
          toast("success", t("toast.extensionImported"));
        },
      });
    } finally {
      setBusy("");
    }
  }

  async function previewExtensionDirectoryPath(directory: string): Promise<ExtensionDirectoryPreviewResult | null> {
    if (!directory.trim()) return null;
    setBusy("extension-import-directory");
    try {
      return await api<ExtensionDirectoryPreviewResult>("/api/extensions/import-directory/preview", {
        method: "POST",
        body: JSON.stringify({ path: directory.trim() }),
      });
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function importExtensionDirectoryPaths(paths: string[], mode: ExtensionDirectoryMode = "copy"): Promise<ExtensionDirectoryImportResult | null> {
    if (paths.length === 0) return null;
    setBusy("extension-import-directory");
    try {
      const outcome = await runMutation({
        mutate: () => api<ExtensionDirectoryImportResult>("/api/extensions/import-directories", {
          method: "POST",
          body: JSON.stringify({ paths, mode, conflictDisposition: "create" }),
        }),
        onSuccess: (result) => {
          const params = { imported: result.imported.length, failed: result.failed.length, skipped: result.skipped };
          toast(result.failed.length ? "info" : "success", t(result.failed.length ? "toast.extensionImportPartial" : "toast.extensionImportBatchDone", params));
        },
      });
      return outcome.status === "success" ? outcome.value : null;
    } finally {
      setBusy("");
    }
  }

  async function importExtensionArchivePath(kind: "zip" | "crx", filePath: string) {
    if (!filePath.trim()) return;
    setBusy(`extension-import-${kind}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/import-${kind}`, {
          method: "POST",
          body: JSON.stringify({ path: filePath.trim() }),
        }),
        onFailure: (error) => {
          if (isImportConflict(error)) {
            promptImportConflict(error.candidates as ExtensionEntity[], error.matchBy, async (options) => {
              await api<ExtensionEntity>(`/api/extensions/import-${kind}`, {
                method: "POST",
                body: JSON.stringify({ path: filePath.trim(), ...options }),
              });
            });
            return;
          }
          toast("error", extensionErrorMessage(error, t));
        },
        onSuccess: () => {
          setExtensionImport(null);
          toast("success", t("toast.extensionImported"));
        },
      });
    } finally {
      setBusy("");
    }
  }

  /** Web browsers never expose the real path of a picked file, so the bytes are uploaded instead. */
  async function uploadExtensionArchive(kind: "zip" | "crx", file: File) {
    setBusy(`extension-import-${kind}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/upload-${kind}`, {
          method: "POST",
          headers: { "Content-Type": "application/octet-stream" },
          body: file,
        }),
        onFailure: (error) => {
          if (isImportConflict(error)) {
            promptImportConflict(error.candidates as ExtensionEntity[], error.matchBy, async (options) => {
              const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
              if (options.conflictDisposition) {
                headers["X-CBPanel-Conflict-Disposition"] = options.conflictDisposition;
              }
              if (options.conflictExtensionId) {
                headers["X-CBPanel-Conflict-Extension-Id"] = options.conflictExtensionId;
              }
              await api<ExtensionEntity>(`/api/extensions/upload-${kind}`, {
                method: "POST",
                headers,
                body: file,
              });
            });
            return;
          }
          toast("error", extensionErrorMessage(error, t));
        },
        onSuccess: () => {
          setExtensionImport(null);
          toast("success", t("toast.extensionImported"));
        },
      });
    } finally {
      setBusy("");
    }
  }

  async function installExtension(extension: ExtensionEntity) {
    setBusy(`extension-install:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}/install`, { method: "POST" }),
        onSuccess: () => toast("success", t("toast.extensionInstalled")),
        refreshAfterFailure: true,
      });
    } finally {
      setBusy("");
    }
  }

  async function checkExtension(extension: ExtensionEntity) {
    setBusy(`extension-check:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}/check`, { method: "POST" }),
        onSuccess: () => toast("success", t("toast.extensionChecked")),
        refreshAfterFailure: true,
      });
    } finally {
      setBusy("");
    }
  }

  async function checkExtensionUpdate(extension: ExtensionEntity) {
    setBusy(`extension-check-update:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}/check-update`, { method: "POST" }),
        onSuccess: () => toast("success", t("toast.extensionUpdateChecked")),
        refreshAfterFailure: true,
      });
    } finally {
      setBusy("");
    }
  }

  async function updateExtension(extension: ExtensionEntity) {
    setBusy(`extension-update:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}/update`, { method: "POST" }),
        onFailure: (error) => {
          if (isPermissionGateError(error)) {
            toast("error", t("error.extensionUpdatePermissions", {
              permissions: (error.permissions ?? []).join(", "),
            }));
          } else {
            toast("error", extensionErrorMessage(error, t));
          }
        },
        onSuccess: () => toast("success", t("toast.extensionUpdated")),
        refreshAfterFailure: true,
      });
    } finally {
      setBusy("");
    }
  }

  async function reinstallExtension(extension: ExtensionEntity) {
    setConfirmDialog({
      title: t("extension.reinstall.title", { name: extension.name }),
      body: t("extension.reinstall.body"),
      confirmLabel: t("actions.reinstall"),
      tone: "warning",
      busyKey: `extension-reinstall:${extension.id}`,
      onConfirm: () => reinstallExtensionNow(extension),
    });
  }

  async function reinstallExtensionNow(extension: ExtensionEntity) {
    setBusy(`extension-reinstall:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}/reinstall`, { method: "POST" }),
        onSuccess: () => {
          setConfirmDialog(null);
          toast("success", t("toast.extensionReinstalled"));
        },
        refreshAfterFailure: true,
      });
    } finally {
      setBusy("");
    }
  }

  async function migrateExtensionIdentity(extension: ExtensionEntity) {
    setConfirmDialog({
      title: t("extension.migrate.title", { name: extension.name }),
      body: t("extension.migrate.body"),
      confirmLabel: t("actions.migrateIdentity"),
      tone: "danger",
      busyKey: `extension-migrate:${extension.id}`,
      onConfirm: () => migrateExtensionIdentityNow(extension),
    });
  }

  async function migrateExtensionIdentityNow(extension: ExtensionEntity) {
    setBusy(`extension-migrate:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}/migrate-identity`, { method: "POST" }),
        onSuccess: () => {
          setConfirmDialog(null);
          toast("success", t("toast.extensionIdentityMigrated"));
        },
        refreshAfterFailure: true,
      });
    } finally {
      setBusy("");
    }
  }

  async function setDraftExtensionBinding(extension: ExtensionEntity, bound: boolean) {
    if (!draft || draftIsNew) return;
    setBusy(`extension-bind-draft:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api(`/api/extensions/${extension.id}/${bound ? "bind-environments" : "unbind-environments"}`, {
          method: "POST",
          body: JSON.stringify({ environmentIds: [draft.id] }),
        }),
        onSuccess: () => toast("success", t(bound ? "toast.extensionBoundOne" : "toast.extensionUnboundOne")),
      });
    } finally {
      setBusy("");
    }
  }

  async function patchExtension(extension: ExtensionEntity, patch: Partial<ExtensionEntity>, busyKey: string, successKey: TranslationKey) {
    setBusy(busyKey);
    try {
      await runMutation({
        mutate: () => api<ExtensionEntity>(`/api/extensions/${extension.id}`, {
          method: "PUT",
          body: JSON.stringify(patch),
        }),
        onSuccess: () => toast("success", t(successKey)),
      });
    } finally {
      setBusy("");
    }
  }

  async function toggleExtensionStatus(extension: ExtensionEntity) {
    const nextStatus = extension.status === "disabled" ? "enabled" : "disabled";
    await patchExtension(
      extension,
      { status: nextStatus },
      `extension-status:${extension.id}`,
      nextStatus === "disabled" ? "toast.extensionDisabled" : "toast.extensionEnabled",
    );
  }

  async function setExtensionUpdatePolicy(extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) {
    if (extension.updatePolicy === updatePolicy) return;
    await patchExtension(
      extension,
      { updatePolicy },
      `extension-policy:${extension.id}`,
      "toast.extensionUpdatePolicySaved",
    );
  }

  async function deleteExtension(extension: ExtensionEntity) {
    setConfirmDialog({
      title: t("extension.delete.title", { name: extension.name }),
      body: t("extension.delete.body"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: `extension-delete:${extension.id}`,
      onConfirm: () => deleteExtensionNow(extension),
    });
  }

  async function deleteExtensionNow(extension: ExtensionEntity) {
    setBusy(`extension-delete:${extension.id}`);
    try {
      await runMutation({
        mutate: () => api(`/api/extensions/${extension.id}`, { method: "DELETE" }),
        onSuccess: () => {
          setConfirmDialog(null);
          toast("success", t("toast.extensionDeleted"));
        },
      });
    } finally {
      setBusy("");
    }
  }

  /**
   * Background notify/auto policy runner when the user opens the extensions module.
   * Never runs on the launch path; permission 409 leaves update-available as-is.
   */
  async function runExtensionAutoChecks(extensions: ExtensionEntity[]) {
    const queue = extensions.filter((extension) => {
      if (!canAutoCheckExtension(extension)) return false;
      const last = autoCheckMemory.get(extension.id) ?? 0;
      if (Date.now() - last < AUTO_CHECK_MIN_INTERVAL_MS) return false;
      if (extension.lastCheckedAt) {
        const lastChecked = Date.parse(extension.lastCheckedAt);
        if (Number.isFinite(lastChecked) && Date.now() - lastChecked < AUTO_CHECK_MIN_INTERVAL_MS) return false;
      }
      return true;
    });
    if (queue.length === 0) return;

    let cursor = 0;
    let changed = false;
    const workers = Array.from({ length: Math.min(AUTO_CHECK_CONCURRENCY, queue.length) }, async () => {
      while (cursor < queue.length) {
        const index = cursor;
        cursor += 1;
        const extension = queue[index]!;
        autoCheckMemory.set(extension.id, Date.now());
        try {
          const checked = await api<ExtensionEntity>(`/api/extensions/${extension.id}/check-update`, { method: "POST" });
          if (checked.installState !== extension.installState || checked.lastError !== extension.lastError) {
            changed = true;
          }
          if (extension.updatePolicy === "auto" && checked.installState === "update-available") {
            try {
              await api<ExtensionEntity>(`/api/extensions/${extension.id}/update`, { method: "POST" });
              changed = true;
            } catch (error) {
              changed = true;
              if (!isPermissionGateError(error)) {
                // Soft-fail auto install; keep going for other extensions.
              }
            }
          }
        } catch {
          // Soft-fail auto check.
        }
      }
    });
    await Promise.all(workers);
    if (changed) await refreshExtensionState(loadState, notifyBackgroundRefreshFailure);
  }

  return {
    checkExtension,
    checkExtensionUpdate,
    deleteExtension,
    importExtensionArchivePath,
    importExtensionDirectoryPaths,
    importExtensionDirectoryPath,
    installExtension,
    migrateExtensionIdentity,
    previewExtensionDirectoryPath,
    reinstallExtension,
    runExtensionAutoChecks,
    setDraftExtensionBinding,
    setExtensionUpdatePolicy,
    toggleExtensionStatus,
    updateExtension,
    uploadExtensionArchive,
  };
}
