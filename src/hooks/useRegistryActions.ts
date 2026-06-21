import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import type { WorkbenchView } from "../components/registry/registryStats";
import { api, errorMessage, referenceErrorMessage } from "../lib/apiClient";
import type { BrowserEnvironment, GroupEntity, TagEntity } from "../shared/entities";
import type { PanelState } from "../shared/profile";

type RegistryMergeState =
  | { kind: "group"; entity: GroupEntity }
  | { kind: "tag"; entity: TagEntity }
  | null;

type RegistryEditorState =
  | { kind: "group"; mode: "create"; entity?: undefined }
  | { kind: "group"; mode: "edit"; entity: GroupEntity }
  | { kind: "tag"; mode: "create"; entity?: undefined }
  | { kind: "tag"; mode: "edit"; entity: TagEntity }
  | null;

export function useRegistryActions({
  loadState,
  setBusy,
  setConfirmDialog,
  setRegistryEditor,
  setRegistryMerge,
  setSelectedId,
  setWorkbenchView,
  state,
  t,
  toast,
}: {
  loadState: () => Promise<void>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setRegistryEditor: Dispatch<SetStateAction<RegistryEditorState>>;
  setRegistryMerge: Dispatch<SetStateAction<RegistryMergeState>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setWorkbenchView: Dispatch<SetStateAction<WorkbenchView>>;
  state: PanelState | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  async function restoreTrashEnvironment(id: string) {
    setBusy(`trash-restore:${id}`);
    try {
      await api(`/api/trash/environments/${id}/restore`, { method: "POST" });
      await loadState();
      setSelectedId(id);
      setWorkbenchView("profiles");
      toast("success", t("toast.restored"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function permanentlyDeleteTrashEnvironment(id: string, name: string) {
    setConfirmDialog({
      title: t("actions.permanentDelete"),
      body: t("confirm.permanentDelete", { name }),
      confirmLabel: t("actions.permanentDelete"),
      tone: "danger",
      busyKey: `trash-delete:${id}`,
      onConfirm: () => permanentlyDeleteTrashEnvironmentNow(id),
    });
  }

  async function permanentlyDeleteTrashEnvironmentNow(id: string) {
    setBusy(`trash-delete:${id}`);
    try {
      await api(`/api/trash/environments/${id}`, { method: "DELETE" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.permanentlyDeleted"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function clearTrashEnvironments() {
    const count = state?.trash?.length ?? 0;
    if (count === 0) return;
    setConfirmDialog({
      title: t("actions.emptyTrash"),
      body: t("confirm.emptyTrash", { count }),
      confirmLabel: t("actions.emptyTrash"),
      tone: "danger",
      busyKey: "trash-clear",
      onConfirm: clearTrashEnvironmentsNow,
    });
  }

  async function clearTrashEnvironmentsNow() {
    setBusy("trash-clear");
    try {
      const result = await api<{ deleted: number }>("/api/trash/environments", { method: "DELETE" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.trashCleared", { count: result.deleted }));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function updateGroup(group: GroupEntity, patch: Partial<GroupEntity>) {
    setBusy(`group-update:${group.id}`);
    try {
      await api<GroupEntity>(`/api/groups/${group.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await loadState();
      toast("success", t("toast.groupUpdated"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function saveGroupDraft(mode: "create" | "edit", input: Partial<GroupEntity>, group?: GroupEntity) {
    const busyKey = mode === "create" ? "group-create" : group ? `group-update:${group.id}` : "group-update";
    setBusy(busyKey);
    try {
      if (mode === "create") {
        await api<GroupEntity>("/api/groups", {
          method: "POST",
          body: JSON.stringify(createRegistryPayload(input)),
        });
        toast("success", t("toast.groupCreated"));
      } else if (group) {
        await api<GroupEntity>(`/api/groups/${group.id}`, {
          method: "PUT",
          body: JSON.stringify(input),
        });
        toast("success", t("toast.groupUpdated"));
      }
      setRegistryEditor(null);
      await loadState();
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  function groupReferenceCount(groupId: string): number {
    return activeEnvironments(state?.environments).filter((environment) => environment.groupId === groupId).length;
  }

  function requestGroupDelete(group: GroupEntity) {
    if (group.isDefault) return;
    if (groupReferenceCount(group.id) > 0) {
      setRegistryMerge({ kind: "group", entity: group });
      return;
    }
    setConfirmDialog({
      title: t("registry.delete.groupTitle", { name: group.name }),
      body: t("registry.delete.groupBody"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: `group-delete:${group.id}`,
      onConfirm: () => deleteGroupNow(group),
    });
  }

  async function deleteGroupNow(group: GroupEntity) {
    setBusy(`group-delete:${group.id}`);
    try {
      await api(`/api/groups/${group.id}`, { method: "DELETE" });
      setConfirmDialog(null);
      setRegistryMerge(null);
      await loadState();
      toast("success", t("toast.groupDeleted"));
    } catch (error) {
      toast("error", referenceErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function mergeGroup(group: GroupEntity, targetId: string) {
    const target = state?.groups?.find((item) => item.id === targetId);
    if (!target) {
      toast("error", t("error.invalidTarget"));
      return;
    }
    setBusy(`group-merge:${group.id}`);
    try {
      await api<GroupEntity>(`/api/groups/${group.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
      });
      setRegistryMerge(null);
      await loadState();
      toast("success", t("toast.groupMerged"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function updateTag(tag: TagEntity, patch: Partial<TagEntity>) {
    setBusy(`tag-update:${tag.id}`);
    try {
      await api<TagEntity>(`/api/tags/${tag.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await loadState();
      toast("success", t("toast.tagUpdated"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function saveTagDraft(mode: "create" | "edit", input: Partial<TagEntity>, tag?: TagEntity) {
    const busyKey = mode === "create" ? "tag-create" : tag ? `tag-update:${tag.id}` : "tag-update";
    setBusy(busyKey);
    try {
      if (mode === "create") {
        await api<TagEntity>("/api/tags", {
          method: "POST",
          body: JSON.stringify(createRegistryPayload(input)),
        });
        toast("success", t("toast.tagCreated"));
      } else if (tag) {
        await api<TagEntity>(`/api/tags/${tag.id}`, {
          method: "PUT",
          body: JSON.stringify(input),
        });
        toast("success", t("toast.tagUpdated"));
      }
      setRegistryEditor(null);
      await loadState();
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  function tagReferenceCount(tagId: string): number {
    return activeEnvironments(state?.environments).filter((environment) => environment.tagIds.includes(tagId)).length;
  }

  function requestTagDelete(tag: TagEntity) {
    if (tagReferenceCount(tag.id) > 0) {
      setRegistryMerge({ kind: "tag", entity: tag });
      return;
    }
    setConfirmDialog({
      title: t("registry.delete.tagTitle", { name: tag.name }),
      body: t("registry.delete.tagBody"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: `tag-delete:${tag.id}`,
      onConfirm: () => deleteTagNow(tag),
    });
  }

  async function deleteTagNow(tag: TagEntity) {
    setBusy(`tag-delete:${tag.id}`);
    try {
      await api(`/api/tags/${tag.id}`, { method: "DELETE" });
      setConfirmDialog(null);
      setRegistryMerge(null);
      await loadState();
      toast("success", t("toast.tagDeleted"));
    } catch (error) {
      toast("error", referenceErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function mergeTag(tag: TagEntity, targetId: string) {
    const target = state?.tags?.find((item) => item.id === targetId);
    if (!target) {
      toast("error", t("error.invalidTarget"));
      return;
    }
    setBusy(`tag-merge:${tag.id}`);
    try {
      await api<TagEntity>(`/api/tags/${tag.id}/merge`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
      });
      setRegistryMerge(null);
      await loadState();
      toast("success", t("toast.tagMerged"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  return {
    clearTrashEnvironments,
    groupReferenceCount,
    mergeGroup,
    mergeTag,
    permanentlyDeleteTrashEnvironment,
    requestGroupDelete,
    requestTagDelete,
    restoreTrashEnvironment,
    saveGroupDraft,
    saveTagDraft,
    tagReferenceCount,
    updateGroup,
    updateTag,
  };
}

function activeEnvironments(environments: BrowserEnvironment[] | undefined): BrowserEnvironment[] {
  return (environments ?? []).filter((environment) => !environment.deletedAt);
}

function createRegistryPayload<T extends { id?: string; createdAt?: string; updatedAt?: string }>(input: Partial<T>): Partial<T> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = input;
  return payload as Partial<T>;
}
