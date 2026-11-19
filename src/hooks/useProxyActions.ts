import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, apiNdjson, errorMessage, referenceErrorMessage } from "../lib/apiClient";
import type {
  ProxyBatchDeleteResult,
  ProxyEntity,
  ProxyImportResult,
  ProxySubscriptionEntity,
  ProxySubscriptionRefreshResult,
} from "../shared/entities";
import type { PanelState } from "../shared/profile";

/** One JSON-Lines row of a batch route: a per-proxy result, then a `{done:true}` terminator. */
type ProxyBatchLine = { id?: string; result?: { ok?: boolean }; done?: boolean; error?: string };

type ProxyEditorState =
  | { mode: "create" }
  | { mode: "edit"; proxy: ProxyEntity }
  | null;

type ProxyReferenceState = {
  action: "replace" | "unbind" | "delete";
  proxy: ProxyEntity;
} | null;

export type ProxySubscriptionEditorState =
  | { mode: "create" }
  | { mode: "edit"; subscription: ProxySubscriptionEntity }
  | null;

/** A finished import: a result to show, or the error the dialog should render in place. */
export type ProxyImportOutcome = { result?: ProxyImportResult; error?: unknown };

type SubscriptionRefreshOutcome = { subscription: ProxySubscriptionEntity; result: ProxySubscriptionRefreshResult };

export function useProxyActions({
  loadState,
  setBusy,
  setConfirmDialog,
  setProxyEditor,
  setProxyReference,
  setProxySubscriptionEditor,
  state,
  t,
  toast,
}: {
  loadState: () => Promise<unknown>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setProxyEditor: Dispatch<SetStateAction<ProxyEditorState>>;
  setProxyReference: Dispatch<SetStateAction<ProxyReferenceState>>;
  setProxySubscriptionEditor?: Dispatch<SetStateAction<ProxySubscriptionEditorState>>;
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

  async function saveProxyDraft(mode: "create" | "edit", input: Partial<ProxyEntity>, proxy?: ProxyEntity): Promise<boolean> {
    const busyKey = mode === "create" ? "proxy-create" : proxy ? `proxy-update:${proxy.id}` : "proxy-update";
    setBusy(busyKey);
    try {
      if (mode === "create") {
        await api<ProxyEntity>("/api/proxies", {
          method: "POST",
          body: JSON.stringify(createProxyPayload(input)),
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
      return true;
    } catch (error) {
      toast("error", errorMessage(error));
      return false;
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

  async function batchCheckProxies(ids: string[]) {
    if (ids.length === 0) return;
    setBusy("proxy-batch");
    let ok = 0;
    let failed = 0;
    // Coalesced, not one refresh per line: a hundred results would otherwise fire a hundred full state
    // reads, and each read is far more expensive than the row it would repaint. One refresh in flight at
    // a time, with at most one more queued, keeps rows landing continuously without the storm.
    let refreshing = false;
    let refreshQueued = false;
    const refreshSoon = async () => {
      if (refreshing) {
        refreshQueued = true;
        return;
      }
      refreshing = true;
      try {
        do {
          refreshQueued = false;
          await loadState();
        } while (refreshQueued);
      } catch {
        // A failed reconciliation refresh must not hide the batch result; the final refresh reports it.
      } finally {
        refreshing = false;
      }
    };
    try {
      // One streaming request, not a series of slices: every result is written the moment that proxy
      // answers, so the rows fill in progressively instead of after the slowest node of a slice. The
      // server still bounds its own concurrency.
      await apiNdjson<ProxyBatchLine>("/api/proxies/batch/check", { ids }, (line) => {
        if (!line.id) return;
        if (line.result?.ok) ok += 1;
        else failed += 1;
        void refreshSoon();
      });
      toast(failed === 0 ? "success" : "info", t("toast.proxyBatchChecked", { ok, failed }));
    } catch (error) {
      await loadState();
      toast("error", errorMessage(error));
    } finally {
      await loadState();
      setBusy("");
    }
  }

  function requestBatchProxyDelete(ids: string[]) {
    if (ids.length === 0) return;
    setConfirmDialog({
      title: t("proxy.batch.deleteTitle", { count: ids.length }),
      body: t("proxy.batch.deleteBody"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: "proxy-batch",
      onConfirm: () => batchDeleteProxiesNow(ids),
    });
  }

  async function batchDeleteProxiesNow(ids: string[]) {
    setBusy("proxy-batch");
    try {
      const result = await api<ProxyBatchDeleteResult>("/api/proxies/batch/delete", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      setConfirmDialog(null);
      await loadState();
      toast(
        result.blocked.length === 0 ? "success" : "info",
        t("toast.proxyBatchDeleted", { deleted: result.deleted.length, blocked: result.blocked.length }),
      );
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  // Pasted share links, a base64 node list, a Clash/mihomo YAML, or a subscription body. The server
  // decides what each line becomes — a native socks/http proxy or an xray node — and reports every
  // line it could not use, masked. Failures return to the dialog instead of a toast: the dialog is
  // where the user pasted the source and can fix it.
  async function importProxyLinks(text: string): Promise<ProxyImportOutcome> {
    return importProxies("/api/proxies/import-links", { text });
  }

  async function importProxies(route: string, body: Record<string, unknown>): Promise<ProxyImportOutcome> {
    setBusy("proxy-import");
    try {
      const result = await api<ProxyImportResult>(route, { method: "POST", body: JSON.stringify(body) });
      await loadState();
      const imported = result.imported.length + (result.adopted ?? 0);
      toast(imported > 0 ? "success" : "info", t("toast.proxiesImported", { count: imported }));
      return { result };
    } catch (error) {
      return { error };
    } finally {
      setBusy("");
    }
  }

  // Remembered subscriptions. Every mutation reloads the state: a refresh can add, rename, remove or
  // detach proxies, and the list must show what the library holds now.
  async function openProxySubscriptionEditor(mode: "create"): Promise<void>;
  async function openProxySubscriptionEditor(mode: "edit", subscription: ProxySubscriptionEntity): Promise<void>;
  async function openProxySubscriptionEditor(mode: "create" | "edit", subscription?: ProxySubscriptionEntity): Promise<void> {
    if (!setProxySubscriptionEditor) return;
    if (mode === "create") {
      setProxySubscriptionEditor({ mode });
      return;
    }
    if (!subscription) return;
    setBusy(`subscription-load:${subscription.id}`);
    try {
      const full = await api<ProxySubscriptionEntity>(`/api/proxy-subscriptions/${subscription.id}?secrets=1`);
      setProxySubscriptionEditor({ mode, subscription: full });
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function saveProxySubscription(mode: "create" | "edit", input: Partial<ProxySubscriptionEntity>, subscription?: ProxySubscriptionEntity) {
    const busyKey = mode === "create" ? "subscription-create" : subscription ? `subscription-update:${subscription.id}` : "subscription-update";
    setBusy(busyKey);
    try {
      if (mode === "create") {
        const outcome = await api<SubscriptionRefreshOutcome>("/api/proxy-subscriptions", { method: "POST", body: JSON.stringify(input) });
        toast("success", t("toast.subscriptionCreated", { name: outcome.subscription.name, added: outcome.result.added }));
      } else if (subscription) {
        await api<ProxySubscriptionEntity>(`/api/proxy-subscriptions/${subscription.id}`, { method: "PUT", body: JSON.stringify(input) });
        toast("success", t("toast.subscriptionSaved"));
      }
      setProxySubscriptionEditor?.(null);
      await loadState();
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function updateProxySubscription(subscription: ProxySubscriptionEntity, patch: Partial<ProxySubscriptionEntity>) {
    setBusy(`subscription-update:${subscription.id}`);
    try {
      await api<ProxySubscriptionEntity>(`/api/proxy-subscriptions/${subscription.id}`, { method: "PUT", body: JSON.stringify(patch) });
      await loadState();
      toast("success", t("toast.subscriptionSaved"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function refreshProxySubscription(subscription: ProxySubscriptionEntity) {
    setBusy(`subscription-refresh:${subscription.id}`);
    try {
      const outcome = await api<SubscriptionRefreshOutcome>(`/api/proxy-subscriptions/${subscription.id}/refresh`, { method: "POST" });
      await loadState();
      const { added, removed, kept, detached } = outcome.result;
      const params = { name: outcome.subscription.name, added, removed, kept, detached };
      toast("success", t(detached > 0 ? "toast.subscriptionRefreshedDetached" : "toast.subscriptionRefreshed", params));
    } catch (error) {
      await loadState();
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function refreshAllProxySubscriptions() {
    setBusy("subscription-refresh-all");
    try {
      const response = await api<{ results: Array<{ id: string; name: string; result: ProxySubscriptionRefreshResult }> }>("/api/proxy-subscriptions/refresh-all", { method: "POST" });
      await loadState();
      const ok = response.results.filter((entry) => entry.result.ok).length;
      const failed = response.results.length - ok;
      toast(failed === 0 ? "success" : "info", t("toast.subscriptionsRefreshed", { ok, failed }));
    } catch (error) {
      await loadState();
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  function requestProxySubscriptionDelete(subscription: ProxySubscriptionEntity, proxies: "keep" | "delete") {
    const members = (state?.proxies ?? []).filter((proxy) => proxy.subscriptionId === subscription.id).length;
    setConfirmDialog({
      title: t("subscription.delete.title", { name: subscription.name }),
      body: proxies === "keep" ? t("subscription.delete.keepBody", { count: members }) : t("subscription.delete.allBody"),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: `subscription-delete:${subscription.id}`,
      onConfirm: () => deleteProxySubscriptionNow(subscription, proxies),
    });
  }

  async function deleteProxySubscriptionNow(subscription: ProxySubscriptionEntity, proxies: "keep" | "delete") {
    setBusy(`subscription-delete:${subscription.id}`);
    try {
      const outcome = await api<{ detached: string[]; deleted: string[] }>(`/api/proxy-subscriptions/${subscription.id}?proxies=${proxies}`, { method: "DELETE" });
      setConfirmDialog(null);
      await loadState();
      toast("success", t("toast.subscriptionDeleted", { detached: outcome.detached.length, deleted: outcome.deleted.length }));
    } catch (error) {
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
    batchCheckProxies,
    checkManagedProxy,
    deleteProxyNow,
    duplicateProxy,
    importProxyLinks,
    openProxyEditor,
    openProxySubscriptionEditor,
    refreshAllProxySubscriptions,
    refreshProxySubscription,
    requestBatchProxyDelete,
    requestProxySubscriptionDelete,
    proxyReferenceCount,
    replaceProxyReferences,
    replaceProxyReferencesAndDelete,
    requestProxyDelete,
    saveProxyDraft,
    saveProxySubscription,
    unbindProxyReferences,
    unbindProxyReferencesAndDelete,
    updateProxy,
    updateProxySubscription,
  };
}

function createProxyPayload(input: Partial<ProxyEntity>): Partial<ProxyEntity> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = input;
  return payload;
}
