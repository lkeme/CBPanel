import type { Dispatch, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, errorMessage, referenceErrorMessage } from "../lib/apiClient";
import type {
  ProxyBatchDeleteResult,
  ProxyEntity,
  ProxyImportResult,
  ProxyLatencyResult,
  ProxySubscriptionEntity,
  ProxySubscriptionRefreshResult,
} from "../shared/entities";

// Batches travel in slices so the list refreshes as results land instead of after the last proxy of a
// hundred has answered; the server runs each slice with its own bounded concurrency.
const PROXY_BATCH_SLICE = 6;
import type { PanelState } from "../shared/profile";

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

export type ProxySubscriptionImportOptions = {
  remember?: { name?: string; autoRefresh?: boolean; refreshIntervalHours?: number };
};

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

  async function saveProxyDraft(mode: "create" | "edit", input: Partial<ProxyEntity>, proxy?: ProxyEntity) {
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

  async function measureProxyLatency(proxy: ProxyEntity) {
    setBusy(`proxy-latency:${proxy.id}`);
    try {
      const result = await api<ProxyLatencyResult>(`/api/proxies/${proxy.id}/latency`, { method: "POST" });
      await loadState();
      toast("success", t("toast.proxyLatencyMeasured", { ms: result.latencyMs ?? 0, target: probeHost(result.target) }));
    } catch (error) {
      await loadState();
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  async function batchCheckProxies(ids: string[]) {
    await runProxyBatch("/api/proxies/batch/check", ids, (ok, failed) => t("toast.proxyBatchChecked", { ok, failed }));
  }

  async function batchMeasureProxyLatency(ids: string[]) {
    await runProxyBatch("/api/proxies/batch/latency", ids, (ok, failed) => t("toast.proxyBatchLatency", { ok, failed }));
  }

  async function runProxyBatch(route: string, ids: string[], summarize: (ok: number, failed: number) => string) {
    if (ids.length === 0) return;
    setBusy("proxy-batch");
    let ok = 0;
    let failed = 0;
    try {
      for (let index = 0; index < ids.length; index += PROXY_BATCH_SLICE) {
        const slice = ids.slice(index, index + PROXY_BATCH_SLICE);
        const response = await api<{ results: Array<{ id: string; result: { ok: boolean } }> }>(route, {
          method: "POST",
          body: JSON.stringify({ ids: slice }),
        });
        for (const item of response.results) {
          if (item.result.ok) ok += 1;
          else failed += 1;
        }
        await loadState();
      }
      toast(failed === 0 ? "success" : "info", summarize(ok, failed));
    } catch (error) {
      await loadState();
      toast("error", errorMessage(error));
    } finally {
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

  // Pasted share links or a subscription body. The server decides what each line becomes — a native
  // socks/http proxy or an xray node — and reports every line it could not use, masked.
  async function importProxyLinks(text: string): Promise<ProxyImportResult | undefined> {
    return importProxies("/api/proxies/import-links", { text });
  }

  async function importProxySubscription(url: string, options: ProxySubscriptionImportOptions = {}): Promise<ProxyImportResult | undefined> {
    return importProxies("/api/proxies/import-subscription", {
      url,
      ...(options.remember ? { remember: true, ...options.remember } : {}),
    });
  }

  async function importProxies(route: string, body: Record<string, unknown>): Promise<ProxyImportResult | undefined> {
    setBusy("proxy-import");
    try {
      const result = await api<ProxyImportResult>(route, { method: "POST", body: JSON.stringify(body) });
      await loadState();
      const imported = result.imported.length + (result.adopted ?? 0);
      toast(imported > 0 ? "success" : "info", t("toast.proxiesImported", { count: imported }));
      return result;
    } catch (error) {
      toast("error", errorMessage(error));
      return undefined;
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
    batchMeasureProxyLatency,
    checkManagedProxy,
    deleteProxyNow,
    duplicateProxy,
    importProxyLinks,
    importProxySubscription,
    measureProxyLatency,
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

function probeHost(target: string | undefined): string {
  if (!target) return "-";
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
}

function createProxyPayload(input: Partial<ProxyEntity>): Partial<ProxyEntity> {
  const { id: _id, createdAt: _createdAt, updatedAt: _updatedAt, ...payload } = input;
  return payload;
}
