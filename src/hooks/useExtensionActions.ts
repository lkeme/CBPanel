import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ExtensionImportDialogState } from "../components/registry/RegistryDialogs";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, type ApiError, extensionErrorMessage } from "../lib/apiClient";
import { shortExtensionId } from "../lib/utils";
import type {
  ExtensionDirectoryImportResult,
  ExtensionDirectoryMode,
  ExtensionDirectoryPreviewResult,
  ExtensionEntity,
  ExtensionSourceEntity,
  ExtensionSourceRefreshResult,
  ExtensionUpdatePolicy,
} from "../shared/entities";
import type { BrowserProfile } from "../shared/profile";

type ExtensionSourceEditorState =
  | { mode: "create"; source?: undefined }
  | { mode: "edit"; source: ExtensionSourceEntity }
  | null;

type ExtensionImportConflictDisposition = "reuse" | "overwrite" | "create";

type ExtensionImportConflictOptions = {
  conflictDisposition?: ExtensionImportConflictDisposition;
  conflictExtensionId?: string;
};

const AUTO_CHECK_CONCURRENCY = 3;
const AUTO_CHECK_MIN_INTERVAL_MS = 60_000;
const autoCheckMemory = new Map<string, number>();

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

function canAutoCheckExtension(extension: ExtensionEntity): boolean {
  if (extension.updatePolicy === "pinned") return false;
  if (extension.sourceId) return true;
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
  setExtensionSourceEditor,
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
  setExtensionSourceEditor: Dispatch<SetStateAction<ExtensionSourceEditorState>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  void _selectedProfiles;

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
          await retry({
            conflictDisposition: disposition,
            conflictExtensionId: disposition === "create" ? undefined : primary.id,
          });
          setConfirmDialog(null);
          setExtensionImport(null);
          await loadState();
          toast(
            "success",
            disposition === "reuse"
              ? t("toast.extensionImportReused")
              : disposition === "overwrite"
                ? t("toast.extensionImportOverwritten")
                : t("toast.extensionImported"),
          );
        } catch (error) {
          toast("error", extensionErrorMessage(error, t));
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
      await api<ExtensionEntity>("/api/extensions/import-directory", {
        method: "POST",
        body: JSON.stringify({ path: directory.trim(), mode }),
      });
      setExtensionImport(null);
      await loadState();
      toast("success", t("toast.extensionImported"));
    } catch (error) {
      if (isImportConflict(error)) {
        setBusy("");
        promptImportConflict(error.candidates as ExtensionEntity[], error.matchBy, async (options) => {
          await api<ExtensionEntity>("/api/extensions/import-directory", {
            method: "POST",
            body: JSON.stringify({ path: directory.trim(), mode, ...options }),
          });
        });
        return;
      }
      toast("error", extensionErrorMessage(error, t));
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
      const result = await api<ExtensionDirectoryImportResult>("/api/extensions/import-directories", {
        method: "POST",
        body: JSON.stringify({ paths, mode, conflictDisposition: "create" }),
      });
      await loadState();
      const params = { imported: result.imported.length, failed: result.failed.length, skipped: result.skipped };
      toast(result.failed.length ? "info" : "success", t(result.failed.length ? "toast.extensionImportPartial" : "toast.extensionImportBatchDone", params));
      return result;
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function importExtensionArchivePath(kind: "zip" | "crx", filePath: string) {
    if (!filePath.trim()) return;
    setBusy(`extension-import-${kind}`);
    try {
      await api<ExtensionEntity>(`/api/extensions/import-${kind}`, {
        method: "POST",
        body: JSON.stringify({ path: filePath.trim() }),
      });
      setExtensionImport(null);
      await loadState();
      toast("success", t("toast.extensionImported"));
    } catch (error) {
      if (isImportConflict(error)) {
        setBusy("");
        promptImportConflict(error.candidates as ExtensionEntity[], error.matchBy, async (options) => {
          await api<ExtensionEntity>(`/api/extensions/import-${kind}`, {
            method: "POST",
            body: JSON.stringify({ path: filePath.trim(), ...options }),
          });
        });
        return;
      }
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  /** Web browsers never expose the real path of a picked file, so the bytes are uploaded instead. */
  async function uploadExtensionArchive(kind: "zip" | "crx", file: File) {
    setBusy(`extension-import-${kind}`);
    try {
      await api<ExtensionEntity>(`/api/extensions/upload-${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: file,
      });
      setExtensionImport(null);
      await loadState();
      toast("success", t("toast.extensionImported"));
    } catch (error) {
      if (isImportConflict(error)) {
        setBusy("");
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
    } finally {
      setBusy("");
    }
  }

  async function addRemoteExtension(input: { sourceUrl: string; sha256: string }) {
    const sourceUrl = input.sourceUrl.trim();
    const sha256 = input.sha256.trim();
    if (!sourceUrl || !sha256) return;
    const sourceKind = sourceUrl.toLowerCase().includes(".crx") ? "remote-crx" : "remote-zip";
    setBusy("extension-remote-create");
    try {
      await api<ExtensionEntity>("/api/extensions", {
        method: "POST",
        body: JSON.stringify({ sourceKind, sourceUrl, sha256 }),
      });
      setExtensionImport(null);
      await loadState();
      toast("success", t("toast.extensionAdded"));
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function updateExtensionSource(source: ExtensionSourceEntity, patch: Partial<ExtensionSourceEntity>) {
    setBusy(`extension-source-update:${source.id}`);
    try {
      await api<ExtensionSourceEntity>(`/api/extension-sources/${source.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await loadState();
      toast("success", t("toast.extensionSourceUpdated"));
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function saveExtensionSourceDraft(mode: "create" | "edit", input: Partial<ExtensionSourceEntity>, source?: ExtensionSourceEntity) {
    const busyKey = mode === "create" ? "extension-source-create" : source ? `extension-source-update:${source.id}` : "extension-source-update";
    setBusy(busyKey);
    try {
      if (mode === "create") {
        await api<ExtensionSourceEntity>("/api/extension-sources", {
          method: "POST",
          body: JSON.stringify(input),
        });
        toast("success", t("toast.extensionSourceAdded"));
      } else if (source) {
        await api<ExtensionSourceEntity>(`/api/extension-sources/${source.id}`, {
          method: "PUT",
          body: JSON.stringify(input),
        });
        toast("success", t("toast.extensionSourceUpdated"));
      }
      setExtensionSourceEditor(null);
      await loadState();
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function toggleExtensionSourceStatus(source: ExtensionSourceEntity) {
    await updateExtensionSource(source, { status: source.status === "disabled" ? "enabled" : "disabled" });
  }

  async function toggleExtensionSourceUnsigned(source: ExtensionSourceEntity) {
    if (!source.allowUnsignedAssets) {
      setConfirmDialog({
        title: t("extension.source.allowUnsignedTitle", { name: source.name }),
        body: t("extension.source.allowUnsignedBody"),
        confirmLabel: t("actions.allowUnsigned"),
        tone: "warning",
        busyKey: `extension-source-update:${source.id}`,
        onConfirm: async () => {
          await updateExtensionSource(source, { allowUnsignedAssets: true });
          setConfirmDialog(null);
        },
      });
      return;
    }
    await updateExtensionSource(source, { allowUnsignedAssets: !source.allowUnsignedAssets });
  }

  async function refreshExtensionSource(source: ExtensionSourceEntity) {
    setBusy(`extension-source-refresh:${source.id}`);
    try {
      const result = await api<ExtensionSourceRefreshResult>(`/api/extension-sources/${source.id}/refresh`, { method: "POST" });
      await loadState();
      toast("success", t("toast.extensionSourceRefreshed", { imported: result.imported, updated: result.updated }));
    } catch (error) {
      await loadState();
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function deleteExtensionSource(source: ExtensionSourceEntity) {
    setConfirmDialog({
      title: t("extension.source.deleteTitle", { name: source.name }),
      body: t("extension.source.deleteBody"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: `extension-source-delete:${source.id}`,
      onConfirm: () => deleteExtensionSourceNow(source),
    });
  }

  async function deleteExtensionSourceNow(source: ExtensionSourceEntity) {
    setBusy(`extension-source-delete:${source.id}`);
    try {
      await api(`/api/extension-sources/${source.id}`, { method: "DELETE" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.extensionSourceDeleted"));
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function installExtension(extension: ExtensionEntity) {
    setBusy(`extension-install:${extension.id}`);
    try {
      await api<ExtensionEntity>(`/api/extensions/${extension.id}/install`, { method: "POST" });
      await loadState();
      toast("success", t("toast.extensionInstalled"));
    } catch (error) {
      await loadState();
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function checkExtension(extension: ExtensionEntity) {
    setBusy(`extension-check:${extension.id}`);
    try {
      await api<ExtensionEntity>(`/api/extensions/${extension.id}/check`, { method: "POST" });
      await loadState();
      toast("success", t("toast.extensionChecked"));
    } catch (error) {
      await loadState();
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function checkExtensionUpdate(extension: ExtensionEntity) {
    setBusy(`extension-check-update:${extension.id}`);
    try {
      await api<ExtensionEntity>(`/api/extensions/${extension.id}/check-update`, { method: "POST" });
      await loadState();
      toast("success", t("toast.extensionUpdateChecked"));
    } catch (error) {
      await loadState();
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function updateExtension(extension: ExtensionEntity) {
    setBusy(`extension-update:${extension.id}`);
    try {
      await api<ExtensionEntity>(`/api/extensions/${extension.id}/update`, { method: "POST" });
      await loadState();
      toast("success", t("toast.extensionUpdated"));
    } catch (error) {
      await loadState();
      if (isPermissionGateError(error)) {
        toast("error", t("error.extensionUpdatePermissions", {
          permissions: (error.permissions ?? []).join(", "),
        }));
      } else {
        toast("error", extensionErrorMessage(error, t));
      }
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
      await api<ExtensionEntity>(`/api/extensions/${extension.id}/reinstall`, { method: "POST" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.extensionReinstalled"));
    } catch (error) {
      await loadState();
      toast("error", extensionErrorMessage(error, t));
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
      await api<ExtensionEntity>(`/api/extensions/${extension.id}/migrate-identity`, { method: "POST" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.extensionIdentityMigrated"));
    } catch (error) {
      await loadState();
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function setDraftExtensionBinding(extension: ExtensionEntity, bound: boolean) {
    if (!draft || draftIsNew) return;
    setBusy(`extension-bind-draft:${extension.id}`);
    try {
      await api(`/api/extensions/${extension.id}/${bound ? "bind-environments" : "unbind-environments"}`, {
        method: "POST",
        body: JSON.stringify({ environmentIds: [draft.id] }),
      });
      await loadState();
      toast("success", t(bound ? "toast.extensionBoundOne" : "toast.extensionUnboundOne"));
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function patchExtension(extension: ExtensionEntity, patch: Partial<ExtensionEntity>, busyKey: string, successKey: TranslationKey) {
    setBusy(busyKey);
    try {
      await api<ExtensionEntity>(`/api/extensions/${extension.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await loadState();
      toast("success", t(successKey));
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
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
      await api(`/api/extensions/${extension.id}`, { method: "DELETE" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.extensionDeleted"));
    } catch (error) {
      toast("error", extensionErrorMessage(error, t));
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
    if (changed) await loadState();
  }

  return {
    addRemoteExtension,
    checkExtension,
    checkExtensionUpdate,
    deleteExtension,
    deleteExtensionSource,
    importExtensionArchivePath,
    importExtensionDirectoryPaths,
    importExtensionDirectoryPath,
    installExtension,
    migrateExtensionIdentity,
    previewExtensionDirectoryPath,
    refreshExtensionSource,
    reinstallExtension,
    runExtensionAutoChecks,
    saveExtensionSourceDraft,
    setDraftExtensionBinding,
    setExtensionUpdatePolicy,
    toggleExtensionSourceStatus,
    toggleExtensionSourceUnsigned,
    toggleExtensionStatus,
    updateExtension,
    updateExtensionSource,
    uploadExtensionArchive,
  };
}
