import type { Dispatch, RefObject, SetStateAction } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

import type { TranslationKey } from "../i18n";
import type { TextInputDialogState } from "../components/registry/RegistryDialogs";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api } from "../lib/apiClient";
import type { EnvironmentPackageOperation, EnvironmentPackageOperationResult } from "../shared/environmentPackage";
import {
  type BrowserProfile,
  type PanelState,
  type SessionSummary,
  createProfileSnapshot,
  maskProfileSecrets,
  nowIso,
  snapshotToMarkdown,
} from "../shared/profile";

export function useProfileUtilityActions({
  batchLaunch,
  batchStop,
  downloadTextFile,
  draft,
  importInput,
  loadState,
  selectedProfiles,
  sessionsByProfileId,
  setBusy,
  setConfirmDialog,
  setSelectedIds,
  setState,
  setEnvironmentPackageOperation,
  setTextInputDialog,
  t,
  toast,
}: {
  batchLaunch: () => Promise<void>;
  batchStop: () => Promise<void>;
  downloadTextFile: (content: string, filename: string, type: string) => Promise<boolean>;
  draft: BrowserProfile | null;
  importInput: RefObject<HTMLInputElement | null>;
  loadState: () => Promise<unknown>;
  selectedProfiles: BrowserProfile[];
  sessionsByProfileId: Map<string, SessionSummary>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setState: Dispatch<SetStateAction<PanelState | null>>;
  setEnvironmentPackageOperation: Dispatch<SetStateAction<EnvironmentPackageOperation | null>>;
  setTextInputDialog: Dispatch<SetStateAction<TextInputDialogState>>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  async function batchGroupOrTag() {
    setTextInputDialog({
      title: t("confirm.batchEditTitle"),
      body: t("confirm.batchEditHelp"),
      label: t("confirm.batchEdit"),
      placeholder: t("confirm.batchEditPlaceholder"),
      confirmLabel: t("actions.apply"),
      busyKey: "batch-edit",
      validate: (value) => (value.trim() ? null : t("error.invalidTarget")),
      onConfirm: applyBatchGroupOrTag,
    });
  }

  async function applyBatchGroupOrTag(input: string) {
    const tags = input
      .split(/\s+/)
      .filter((item) => item.startsWith("#"))
      .map((item) => item.slice(1).trim())
      .filter(Boolean);
    const group = input
      .split(/\s+/)
      .filter((item) => !item.startsWith("#"))
      .join(" ")
      .trim();

    setBusy("batch-edit");
    try {
      for (const profile of selectedProfiles) {
        const tagSet = new Set([...profile.tags, ...tags]);
        const updated = await api<BrowserProfile>(`/api/profiles/${profile.id}`, {
          method: "PUT",
          body: JSON.stringify({
            group: group || profile.group,
            tags: [...tagSet],
            updatedAt: nowIso(),
          }),
        });
        setState((current) =>
          current
            ? { ...current, profiles: current.profiles.map((item) => (item.id === updated.id ? updated : item)) }
            : current,
        );
      }
      setTextInputDialog(null);
      toast("success", t("actions.apply"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function batchExport() {
    if (isTauri()) {
      await confirmEnvironmentPackageExport(selectedProfiles.map((profile) => profile.id));
      return;
    }
    const profiles = selectedProfiles.map(maskProfileSecrets);
    if (!profiles.length) return;
    try {
      const saved = await downloadTextFile(`${JSON.stringify({ profiles }, null, 2)}\n`, "cbpanel-selected-profiles.json", "application/json");
      if (saved) toast("success", t("toast.exported"));
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }

  async function batchDelete() {
    if (!selectedProfiles.length) return;
    setConfirmDialog({
      title: t("confirm.deleteBatchTitle"),
      body: t("confirm.deleteBatch", { count: selectedProfiles.length }),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: "batch-delete",
      onConfirm: batchDeleteNow,
    });
  }

  async function batchDeleteNow() {
    if (!selectedProfiles.length) return;
    setBusy("batch-delete");
    const deleted: string[] = [];
    try {
      for (const profile of selectedProfiles) {
        const session = sessionsByProfileId.get(profile.id);
        if (session?.status === "running" || session?.status === "launching") continue;
        await api(`/api/profiles/${profile.id}`, { method: "DELETE" });
        deleted.push(profile.id);
      }
      setSelectedIds((current) => withoutIds(current, deleted));
      setConfirmDialog(null);
      await loadState();
      toast(deleted.length > 0 ? "success" : "info", deleted.length > 0 ? t("toast.deleted") : t("toast.deleteSkipped"));
    } catch (error) {
      toast("error", (error as Error).message);
      void loadState();
    } finally {
      setBusy("");
    }
  }

  async function copySnippet(code: string) {
    await navigator.clipboard.writeText(code);
    toast("success", t("toast.snippetCopied"));
  }

  async function copySnapshotMarkdown() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(snapshotToMarkdown(createProfileSnapshot(draft)));
      toast("success", t("toast.snapshotCopied"));
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }

  async function downloadSnapshot(format: "json" | "md") {
    if (!draft) return;
    try {
      const snapshot = createProfileSnapshot(draft);
      const content = format === "json" ? `${JSON.stringify(snapshot, null, 2)}\n` : snapshotToMarkdown(snapshot);
      const type = format === "json" ? "application/json" : "text/markdown";
      const saved = await downloadTextFile(content, `cbpanel-${slugify(draft.name)}-snapshot.${format}`, type);
      if (saved) toast("success", t("toast.snapshotExported", { format: format.toUpperCase() }));
    } catch (error) {
      toast("error", (error as Error).message);
    }
  }

  async function importProfiles(file: File) {
    setBusy("import");
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      const result = await api<{ imported: number; profiles: BrowserProfile[] }>("/api/profiles/import", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      setState((current) =>
        current
          ? {
              ...current,
              profiles: result.profiles,
              meta: { ...current.meta, profileCount: result.profiles.length },
            }
          : current,
      );
      toast("success", t("toast.imported", { count: result.imported }));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
      if (importInput.current) importInput.current.value = "";
    }
  }

  async function exportProfiles() {
    if (isTauri()) {
      await confirmEnvironmentPackageExport();
      return;
    }
    setBusy("export");
    try {
      const data = await api<{ profiles: BrowserProfile[] }>("/api/profiles/export");
      const saved = await downloadTextFile(
        `${JSON.stringify({ profiles: data.profiles.map(maskProfileSecrets) }, null, 2)}\n`,
        "cbpanel-profiles.json",
        "application/json",
      );
      if (saved) toast("success", t("toast.exported"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function confirmEnvironmentPackageExport(environmentIds?: string[]) {
    const selectedCount = environmentIds?.length ?? 0;
    const count = selectedCount || (await currentEnvironmentCount());
    if (count === 0) return;
    setConfirmDialog({
      title: selectedCount ? t("environmentPackage.exportSelectedTitle") : t("environmentPackage.exportAllTitle"),
      body: t("environmentPackage.exportBody", { count }),
      confirmLabel: t("actions.export"),
      busyKey: "environment-package-export",
      onConfirm: () => exportEnvironmentPackage(environmentIds),
    });
  }

  async function exportEnvironmentPackage(environmentIds?: string[]) {
    setBusy("environment-package-export");
    try {
      const filename = environmentIds?.length ? "cbpanel-selected-environments.cbpe" : "cbpanel-environments.cbpe";
      const outputPath = await invoke<string | null>("cbpanel_select_environment_package_save_path", { filename });
      if (!outputPath) {
        setConfirmDialog(null);
        return;
      }
      const operation = await startEnvironmentPackageOperation("/api/environment-packages/export", { outputPath, environmentIds });
      toastEnvironmentPackageResult("export", operation.result);
      setConfirmDialog(null);
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function importEnvironmentPackage() {
    if (!isTauri()) {
      importInput.current?.click();
      return;
    }
    const inputPath = await invoke<string | null>("cbpanel_select_environment_package_open_path");
    if (!inputPath) return;
    setConfirmDialog({
      title: t("environmentPackage.importTitle"),
      body: t("environmentPackage.importBody"),
      confirmLabel: t("actions.import"),
      busyKey: "environment-package-import",
      onConfirm: () => importEnvironmentPackagePath(inputPath),
    });
  }

  async function importEnvironmentPackagePath(inputPath: string) {
    setBusy("environment-package-import");
    try {
      const operation = await startEnvironmentPackageOperation("/api/environment-packages/import", { inputPath });
      await loadState();
      setConfirmDialog(null);
      setSelectedIds(new Set(Object.values(operation.result?.idMap?.environments ?? {})));
      toastEnvironmentPackageResult("import", operation.result);
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function startEnvironmentPackageOperation(url: string, body: Record<string, unknown>): Promise<EnvironmentPackageOperation> {
    const started = await api<{ operationId: string; operation: EnvironmentPackageOperation }>(url, {
      method: "POST",
      body: JSON.stringify(body),
    });
    setEnvironmentPackageOperation(started.operation);
    return pollEnvironmentPackageOperation(started.operationId);
  }

  async function pollEnvironmentPackageOperation(operationId: string): Promise<EnvironmentPackageOperation> {
    try {
      for (;;) {
        const operation = await api<EnvironmentPackageOperation>(`/api/environment-packages/operations/${operationId}`);
        setEnvironmentPackageOperation(operation.status === "succeeded" || operation.status === "failed" ? null : operation);
        if (operation.status === "succeeded") return operation;
        if (operation.status === "failed") throw new Error(operation.error ?? operation.message);
        await delay(700);
      }
    } catch (error) {
      setEnvironmentPackageOperation(null);
      throw error;
    }
  }

  async function currentEnvironmentCount(): Promise<number> {
    return (await api<PanelState>("/api/state")).environments?.length ?? selectedProfiles.length;
  }

  function toastEnvironmentPackageResult(type: "export" | "import", result: EnvironmentPackageOperationResult | undefined) {
    const counts = result?.counts ?? { environments: 0, browserData: 0, groups: 0, extensions: 0 };
    toast("success", t(type === "export" ? "environmentPackage.exportDone" : "environmentPackage.importDone", {
      environments: counts.environments,
      browserData: counts.browserData,
      groups: counts.groups,
      extensions: counts.extensions,
      warnings: result?.warnings.length ?? 0,
    }));
    const warning = result?.warnings[0];
    if (warning) toast("info", t("environmentPackage.warning", { message: warning }));
  }

  return {
    batchDelete,
    batchExport,
    batchGroupOrTag,
    batchLaunch,
    batchStop,
    copySnippet,
    copySnapshotMarkdown,
    downloadSnapshot,
    exportProfiles,
    importEnvironmentPackage,
    importProfiles,
  };
}

function withoutIds(current: Set<string>, ids: string[]): Set<string> {
  const next = new Set(current);
  for (const id of ids) next.delete(id);
  return next;
}

function slugify(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/gi, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "profile";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
