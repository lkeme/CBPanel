import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ExtensionImportDialogState } from "../components/registry/RegistryDialogs";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, errorMessage, referenceErrorMessage } from "../lib/apiClient";
import type {
  ExtensionDirectoryImportResult,
  ExtensionDirectoryPreviewResult,
  ExtensionEntity,
  ExtensionSourceEntity,
  ExtensionSourceRefreshResult,
} from "../shared/entities";
import type { BrowserProfile } from "../shared/profile";

type ExtensionSourceEditorState =
  | { mode: "create"; source?: undefined }
  | { mode: "edit"; source: ExtensionSourceEntity }
  | null;

export function useExtensionActions({
  draft,
  draftIsNew,
  loadState,
  selectedProfiles,
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
  async function importExtensionDirectoryPath(directory: string) {
    if (!directory.trim()) return;
    setBusy("extension-import-directory");
    try {
      await api<ExtensionEntity>("/api/extensions/import-directory", {
        method: "POST",
        body: JSON.stringify({ path: directory.trim() }),
      });
      setExtensionImport(null);
      await loadState();
      toast("success", t("toast.extensionImported"));
    } catch (error) {
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
      return null;
    } finally {
      setBusy("");
    }
  }

  async function importExtensionDirectoryPaths(paths: string[]): Promise<ExtensionDirectoryImportResult | null> {
    if (paths.length === 0) return null;
    setBusy("extension-import-directory");
    try {
      const result = await api<ExtensionDirectoryImportResult>("/api/extensions/import-directories", {
        method: "POST",
        body: JSON.stringify({ paths }),
      });
      await loadState();
      const params = { imported: result.imported.length, failed: result.failed.length, skipped: result.skipped };
      toast(result.failed.length ? "info" : "success", t(result.failed.length ? "toast.extensionImportPartial" : "toast.extensionImportBatchDone", params));
      return result;
    } catch (error) {
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", referenceErrorMessage(error, t));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function bindExtensionToSelected(extension: ExtensionEntity) {
    const environmentIds = selectedProfiles.map((profile) => profile.id);
    if (!environmentIds.length) {
      toast("info", t("toast.selectProfilesFirst"));
      return;
    }
    setBusy(`extension-bind:${extension.id}`);
    try {
      await api(`/api/extensions/${extension.id}/bind-environments`, {
        method: "POST",
        body: JSON.stringify({ environmentIds }),
      });
      await loadState();
      toast("success", t("toast.extensionBound", { count: environmentIds.length }));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function unbindExtensionFromSelected(extension: ExtensionEntity) {
    const environmentIds = selectedProfiles.map((profile) => profile.id);
    const body = environmentIds.length ? { environmentIds } : {};
    setBusy(`extension-unbind:${extension.id}`);
    try {
      await api(`/api/extensions/${extension.id}/unbind-environments`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await loadState();
      toast("success", t("toast.extensionUnbound"));
    } catch (error) {
      toast("error", errorMessage(error));
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
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
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
      toast("error", referenceErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  return {
    addRemoteExtension,
    bindExtensionToSelected,
    checkExtension,
    checkExtensionUpdate,
    deleteExtension,
    deleteExtensionSource,
    importExtensionArchivePath,
    importExtensionDirectoryPaths,
    importExtensionDirectoryPath,
    installExtension,
    previewExtensionDirectoryPath,
    refreshExtensionSource,
    reinstallExtension,
    saveExtensionSourceDraft,
    setDraftExtensionBinding,
    toggleExtensionSourceStatus,
    toggleExtensionSourceUnsigned,
    unbindExtensionFromSelected,
    updateExtension,
    updateExtensionSource,
  };
}
