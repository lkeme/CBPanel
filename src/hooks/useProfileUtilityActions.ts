import type { Dispatch, RefObject, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { TextInputDialogState, ConfirmDialogState } from "../components/registry/RegistryDialogs";
import { api } from "../lib/apiClient";
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
  setTextInputDialog,
  t,
  toast,
}: {
  batchLaunch: () => Promise<void>;
  batchStop: () => Promise<void>;
  downloadTextFile: (content: string, filename: string, type: string) => void;
  draft: BrowserProfile | null;
  importInput: RefObject<HTMLInputElement | null>;
  loadState: () => Promise<void>;
  selectedProfiles: BrowserProfile[];
  sessionsByProfileId: Map<string, SessionSummary>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setState: Dispatch<SetStateAction<PanelState | null>>;
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

  function batchExport() {
    const profiles = selectedProfiles.map(maskProfileSecrets);
    if (!profiles.length) return;
    downloadTextFile(`${JSON.stringify({ profiles }, null, 2)}\n`, "cbpanel-selected-profiles.json", "application/json");
    toast("success", t("toast.exported"));
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

  function downloadSnapshot(format: "json" | "md") {
    if (!draft) return;
    try {
      const snapshot = createProfileSnapshot(draft);
      const content = format === "json" ? `${JSON.stringify(snapshot, null, 2)}\n` : snapshotToMarkdown(snapshot);
      const type = format === "json" ? "application/json" : "text/markdown";
      downloadTextFile(content, `cbpanel-${slugify(draft.name)}-snapshot.${format}`, type);
      toast("success", t("toast.snapshotExported", { format: format.toUpperCase() }));
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
    setBusy("export");
    try {
      const data = await api<{ profiles: BrowserProfile[] }>("/api/profiles/export");
      downloadTextFile(`${JSON.stringify({ profiles: data.profiles.map(maskProfileSecrets) }, null, 2)}\n`, "cbpanel-profiles.json", "application/json");
      toast("success", t("toast.exported"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
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
