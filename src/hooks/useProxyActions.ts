import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ConfirmDialogState } from "../components/registry/RegistryDialogs";
import { api, errorMessage, referenceErrorMessage } from "../lib/apiClient";
import type { ProxyEntity } from "../shared/entities";
import type { PanelState } from "../shared/profile";

type ProxyEditorState =
  | { mode: "create" }
  | { mode: "edit"; proxy: ProxyEntity }
  | null;

type ProxyReferenceState = {
  action: "replace" | "unbind" | "delete";
  proxy: ProxyEntity;
} | null;

export function useProxyActions({
  loadState,
  setBusy,
  setConfirmDialog,
  setProxyEditor,
  setProxyReference,
  state,
  t,
  toast,
}: {
  loadState: () => Promise<void>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setProxyEditor: Dispatch<SetStateAction<ProxyEditorState>>;
  setProxyReference: Dispatch<SetStateAction<ProxyReferenceState>>;
  state: PanelState | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  async function updateProxy(proxy: ProxyEntity, patch: Partial<ProxyEntity>) {
    setBusy(`proxy-update:${proxy.id}`);
    try {
      await api<ProxyEntity>(`/api/proxies/${proxy.id}`, {
        method: "PUT",
        body: JSON.stringify(patch),
      });
      await loadState();
      toast("success", t("toast.proxyUpdated"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function openProxyEditor(mode: "create", proxy?: ProxyEntity): Promise<void>;
  async function openProxyEditor(mode: "edit", proxy: ProxyEntity): Promise<void>;
  async function openProxyEditor(mode: "create" | "edit", proxy?: ProxyEntity): Promise<void> {
    if (mode === "create") {
      setProxyEditor({ mode });
      return;
    }
    if (!proxy) return;
    setBusy(`proxy-load:${proxy.id}`);
    try {
      const fullProxy = await api<ProxyEntity>(`/api/proxies/${proxy.id}?secrets=1`);
      setProxyEditor({ mode, proxy: fullProxy });
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function saveProxyDraft(mode: "create" | "edit", input: Partial<ProxyEntity>, proxy?: ProxyEntity) {
    const busyKey = mode === "create" ? "proxy-create" : proxy ? `proxy-update:${proxy.id}` : "proxy-update";
    setBusy(busyKey);
    try {
      if (mode === "create") {
        await api<ProxyEntity>("/api/proxies", {
          method: "POST",
          body: JSON.stringify(input),
        });
        toast("success", t("toast.proxyCreated"));
      } else if (proxy) {
        await api<ProxyEntity>(`/api/proxies/${proxy.id}`, {
          method: "PUT",
          body: JSON.stringify(input),
        });
        toast("success", t("toast.proxyUpdated"));
      }
      setProxyEditor(null);
      await loadState();
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  function proxyReferenceCount(proxyId: string): number {
    return (state?.environments ?? []).filter((environment) => !environment.deletedAt && environment.proxyId === proxyId).length;
  }

  function requestProxyDelete(proxy: ProxyEntity) {
    if (proxyReferenceCount(proxy.id) > 0) {
      setProxyReference({ action: "delete", proxy });
      return;
    }
    setConfirmDialog({
      title: t("proxy.delete.title", { name: proxy.name }),
      body: t("proxy.delete.body"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: `proxy-delete:${proxy.id}`,
      onConfirm: () => deleteProxyNow(proxy),
    });
  }

  async function duplicateProxy(proxy: ProxyEntity) {
    setBusy(`proxy-duplicate:${proxy.id}`);
    try {
      await api<ProxyEntity>(`/api/proxies/${proxy.id}/duplicate`, { method: "POST" });
      await loadState();
      toast("success", t("toast.proxyDuplicated"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function replaceProxyReferences(proxy: ProxyEntity, targetId: string) {
    const target = state?.proxies?.find((item) => item.id === targetId);
    if (!target) {
      toast("error", t("error.invalidTarget"));
      return;
    }
    setBusy(`proxy-replace:${proxy.id}`);
    try {
      await api(`/api/proxies/${proxy.id}/replace-references`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
      });
      setProxyReference(null);
      await loadState();
      toast("success", t("toast.proxyReferencesReplaced"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function unbindProxyReferences(proxy: ProxyEntity) {
    setBusy(`proxy-unbind:${proxy.id}`);
    try {
      await api(`/api/proxies/${proxy.id}/replace-references`, { method: "POST" });
      setProxyReference(null);
      await loadState();
      toast("success", t("toast.proxyReferencesUnbound"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function replaceProxyReferencesAndDelete(proxy: ProxyEntity, targetId: string) {
    const target = state?.proxies?.find((item) => item.id === targetId);
    if (!target) {
      toast("error", t("error.invalidTarget"));
      return;
    }
    setBusy(`proxy-delete:${proxy.id}`);
    try {
      await api(`/api/proxies/${proxy.id}/replace-references`, {
        method: "POST",
        body: JSON.stringify({ targetId }),
      });
      await api(`/api/proxies/${proxy.id}`, { method: "DELETE" });
      setProxyReference(null);
      await loadState();
      toast("success", t("toast.proxyDeleted"));
    } catch (error) {
      toast("error", referenceErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function unbindProxyReferencesAndDelete(proxy: ProxyEntity) {
    setBusy(`proxy-delete:${proxy.id}`);
    try {
      await api(`/api/proxies/${proxy.id}/replace-references`, { method: "POST" });
      await api(`/api/proxies/${proxy.id}`, { method: "DELETE" });
      setProxyReference(null);
      await loadState();
      toast("success", t("toast.proxyDeleted"));
    } catch (error) {
      toast("error", referenceErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  async function checkManagedProxy(proxy: ProxyEntity) {
    setBusy(`proxy-check:${proxy.id}`);
    try {
      await api(`/api/proxies/${proxy.id}/check`, { method: "POST" });
      await loadState();
      toast("success", t("toast.proxyReady"));
    } catch (error) {
      await loadState();
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function deleteProxyNow(proxy: ProxyEntity) {
    setBusy(`proxy-delete:${proxy.id}`);
    try {
      await api(`/api/proxies/${proxy.id}`, { method: "DELETE" });
      setConfirmDialog(null);
      setProxyReference(null);
      await loadState();
      toast("success", t("toast.proxyDeleted"));
    } catch (error) {
      toast("error", referenceErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  return {
    checkManagedProxy,
    deleteProxyNow,
    duplicateProxy,
    openProxyEditor,
    proxyReferenceCount,
    replaceProxyReferences,
    replaceProxyReferencesAndDelete,
    requestProxyDelete,
    saveProxyDraft,
    unbindProxyReferences,
    unbindProxyReferencesAndDelete,
    updateProxy,
  };
}
