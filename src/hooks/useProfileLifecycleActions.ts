import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { TranslationKey } from "../i18n";
import { preflightToastMessage } from "../components/profiles/ProfileDetails";
import { networkCheckSummaryText } from "../components/profiles/ProfileTable";
import { profileNameValidationError, profileStartUrlValidationError, selectedProxyIdForDraft } from "../components/profiles/profileWorkbenchHelpers";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import type { WorkbenchView } from "../components/registry/registryStats";
import { api, errorMessage } from "../lib/apiClient";
import { omitKeys, withoutIds } from "../lib/collectionState";
import type { BrowserEnvironment, NetworkCheckResult } from "../shared/entities";
import {
  type BrowserProfile,
  type PanelState,
  type ProfilePreflightReport,
  type SessionSummary,
  nowIso,
} from "../shared/profile";

type DrawerMode = "edit" | "settings" | "details" | "columns" | null;

export function useProfileLifecycleActions({
  browserCoreMissing,
  draft,
  draftIsNew,
  draftProxyLibraryIds,
  loadState,
  localProxyDraftIds,
  pendingLaunchIdsRef,
  setBusy,
  setConfirmDialog,
  setDraft,
  setDraftIsNew,
  setDraftProxyLibraryIds,
  setDrawerMode,
  setLocalProxyDraftIds,
  setPendingLaunchIds,
  setPreflight,
  setProxyCheck,
  setSelectedId,
  setSelectedIds,
  setState,
  setWorkbenchView,
  state,
  t,
  toast,
}: {
  browserCoreMissing: boolean;
  draft: BrowserProfile | null;
  draftIsNew: boolean;
  draftProxyLibraryIds: Record<string, string>;
  loadState: () => Promise<void>;
  localProxyDraftIds: Set<string>;
  pendingLaunchIdsRef: MutableRefObject<Set<string>>;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setDraft: Dispatch<SetStateAction<BrowserProfile | null>>;
  setDraftIsNew: Dispatch<SetStateAction<boolean>>;
  setDraftProxyLibraryIds: Dispatch<SetStateAction<Record<string, string>>>;
  setDrawerMode: Dispatch<SetStateAction<DrawerMode>>;
  setLocalProxyDraftIds: Dispatch<SetStateAction<Set<string>>>;
  setPendingLaunchIds: Dispatch<SetStateAction<Set<string>>>;
  setPreflight: Dispatch<SetStateAction<ProfilePreflightReport | null>>;
  setProxyCheck: Dispatch<SetStateAction<string>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setState: Dispatch<SetStateAction<PanelState | null>>;
  setWorkbenchView: Dispatch<SetStateAction<WorkbenchView>>;
  state: PanelState | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  function showBrowserCoreMissing() {
    setWorkbenchView("runtimeCheck");
    setDrawerMode(null);
    toast("error", t("browserCore.missingAction"));
  }

  async function persistDraft(notify: boolean): Promise<BrowserProfile | null> {
    if (!draft) return null;
    const nameError = profileNameValidationError(draft, state?.profiles ?? [], draftIsNew, t);
    if (nameError) throw new Error(nameError);
    const startUrlError = profileStartUrlValidationError(draft, t);
    if (startUrlError) throw new Error(startUrlError);
    const payload = { ...draft, updatedAt: nowIso() };
    const draftProxyId = localProxyDraftIds.has(draft.id)
      ? undefined
      : selectedProxyIdForDraft(draft, state?.environments ?? [], draftProxyLibraryIds);
    let savedEnvironment: BrowserEnvironment;
    if (draftIsNew) {
      savedEnvironment = await api<BrowserEnvironment>("/api/environments", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      if (draftProxyId) {
        savedEnvironment = await api<BrowserEnvironment>(`/api/environments/${savedEnvironment.id}`, {
          method: "PUT",
          body: JSON.stringify({ ...savedEnvironment.runtimeProfile, proxyId: draftProxyId }),
        });
      }
    } else {
      savedEnvironment = await api<BrowserEnvironment>(`/api/environments/${draft.id}`, {
        method: "PUT",
        body: JSON.stringify({ ...payload, proxyId: draftProxyId ?? null }),
      });
    }
    const saved = savedEnvironment.runtimeProfile;
    setState((current) =>
      current
        ? {
            ...current,
            profiles: draftIsNew
              ? [saved, ...current.profiles]
              : current.profiles.map((profile) => (profile.id === saved.id ? saved : profile)),
            environments: current.environments
              ? draftIsNew
                ? [savedEnvironment, ...current.environments]
                : current.environments.map((environment) => (environment.id === savedEnvironment.id ? savedEnvironment : environment))
              : current.environments,
            meta: draftIsNew ? { ...current.meta, profileCount: current.meta.profileCount + 1 } : current.meta,
          }
        : current,
    );
    setDraftIsNew(false);
    setLocalProxyDraftIds((current) => withoutIds(current, [draft.id, saved.id]));
    setDraftProxyLibraryIds((current) => omitKeys(current, [draft.id, saved.id]));
    setSelectedId(saved.id);
    setDraft(structuredClone(saved));
    if (notify) toast("success", t(draftIsNew ? "toast.created" : "toast.saved"));
    return saved;
  }

  async function saveDraft(): Promise<BrowserProfile | null> {
    setBusy("save");
    try {
      return await persistDraft(true);
    } catch (error) {
      toast("error", (error as Error).message);
      throw error;
    } finally {
      setBusy("");
    }
  }

  async function duplicateProfile() {
    if (!draft) return;
    setBusy("duplicate");
    try {
      const profile = await api<BrowserProfile>(`/api/profiles/${draft.id}/duplicate`, { method: "POST" });
      setState((current) =>
        current
          ? {
              ...current,
              profiles: [profile, ...current.profiles],
              meta: { ...current.meta, profileCount: current.meta.profileCount + 1 },
            }
          : current,
      );
      setSelectedId(profile.id);
      setDrawerMode("edit");
      toast("success", t("toast.duplicated"));
    } catch (error) {
      toast("error", (error as Error).message);
      window.setTimeout(() => void loadState(), 300);
    } finally {
      setBusy("");
    }
  }

  async function deleteProfile(closeDraftDrawer: () => void) {
    if (!draft) return;
    if (draftIsNew) {
      closeDraftDrawer();
      return;
    }
    setConfirmDialog({
      title: t("confirm.deleteProfileTitle"),
      body: t("confirm.deleteProfile", { name: draft.name }),
      confirmLabel: t("actions.delete"),
      tone: "danger",
      busyKey: "delete",
      onConfirm: deleteProfileNow,
    });
  }

  async function deleteProfileNow() {
    if (!draft || draftIsNew) return;
    setBusy("delete");
    try {
      await api(`/api/profiles/${draft.id}`, { method: "DELETE" });
      setSelectedIds((current) => withoutIds(current, [draft.id]));
      setConfirmDialog(null);
      setDrawerMode(null);
      await loadState();
      toast("success", t("toast.deleted"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function launchProfile(id = draft?.id) {
    if (!id) return;
    if (pendingLaunchIdsRef.current.has(id)) return;
    if (browserCoreMissing) {
      showBrowserCoreMissing();
      return;
    }
    markLaunchPending(id, true);
    if (draftIsNew && draft && id === draft.id) {
      setBusy(`launch:${draft.id}`);
      let attemptedLaunchId: string | null = null;
      try {
        const saved = await persistDraft(false);
        if (!saved) return;
        attemptedLaunchId = saved.id;
        const session = await api<SessionSummary>(`/api/environments/${saved.id}/launch`, { method: "POST" });
        upsertSession(session);
        toast(session.lastError ? "info" : "success", session.lastError ?? t("toast.launched"));
        window.setTimeout(() => void loadState(), 1000);
      } catch (error) {
        toast("error", (error as Error).message);
        if (attemptedLaunchId) {
          setSelectedId(attemptedLaunchId);
          setDrawerMode("details");
          window.setTimeout(() => void loadState(), 300);
        }
      } finally {
        setBusy("");
        markLaunchPending(id, false);
      }
      return;
    }
    const profile = state?.profiles.find((item) => item.id === id);
    if (!profile) {
      markLaunchPending(id, false);
      return;
    }
    setBusy(`launch:${id}`);
    let attemptedLaunchId: string | null = null;
    try {
      let launchTarget = profile;
      if (draft?.id === id) {
        const saved = await persistDraft(false);
        if (!saved) return;
        launchTarget = saved;
      }
      attemptedLaunchId = launchTarget.id;
      const session = await api<SessionSummary>(`/api/environments/${launchTarget.id}/launch`, { method: "POST" });
      upsertSession(session);
      toast(session.lastError ? "info" : "success", session.lastError ?? t("toast.launched"));
      window.setTimeout(() => void loadState(), 1000);
    } catch (error) {
      toast("error", (error as Error).message);
      if (attemptedLaunchId) {
        setSelectedId(attemptedLaunchId);
        setDrawerMode("details");
        window.setTimeout(() => void loadState(), 300);
      }
    } finally {
      setBusy("");
      markLaunchPending(id, false);
    }
  }

  function markLaunchPending(id: string, pending: boolean) {
    const next = new Set(pendingLaunchIdsRef.current);
    if (pending) {
      next.add(id);
    } else {
      next.delete(id);
    }
    pendingLaunchIdsRef.current = next;
    setPendingLaunchIds(next);
  }

  async function stopProfile(id = draft?.id) {
    if (!id) return;
    setBusy(`stop:${id}`);
    try {
      const session = await api<SessionSummary>(`/api/environments/${id}/stop`, { method: "POST" });
      upsertSession(session);
      toast("success", t("toast.stopped"));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function checkPreflight() {
    if (!draft) return;
    if (browserCoreMissing) {
      showBrowserCoreMissing();
      return;
    }
    setBusy("preflight");
    try {
      const saved = await persistDraft(false);
      if (!saved) return;
      const report = await api<ProfilePreflightReport>(`/api/environments/${saved.id}/preflight`, { method: "POST" });
      setPreflight(report);
      if (!report.ok) {
        setDrawerMode("details");
        setSelectedId(saved.id);
      }
      toast(report.ok ? "success" : "error", preflightToastMessage(report, t));
    } catch (error) {
      toast("error", (error as Error).message);
    } finally {
      setBusy("");
    }
  }

  function upsertSession(session: SessionSummary) {
    setState((current) => {
      if (!current) return current;
      const exists = current.sessions.some((item) => item.profileId === session.profileId);
      return {
        ...current,
        sessions: exists
          ? current.sessions.map((item) => (item.profileId === session.profileId ? session : item))
          : [...current.sessions, session],
      };
    });
  }

  async function checkProxy() {
    if (!draft) return;
    setBusy("proxy");
    setProxyCheck("");
    try {
      const saved = draftIsNew ? null : await persistDraft(false);
      const result = saved
        ? await api<NetworkCheckResult>(`/api/environments/${saved.id}/network-check`, { method: "POST" })
        : await api<NetworkCheckResult>("/api/proxy/check", {
            method: "POST",
            body: JSON.stringify({ proxy: draft.proxy }),
          });
      setProxyCheck(networkCheckSummaryText(result, t));
      if (saved) await loadState();
      toast(result.ok ? "success" : "error", result.ok ? t("toast.proxyReady") : networkCheckSummaryText(result, t));
    } catch (error) {
      const message = errorMessage(error);
      setProxyCheck(message);
      if (!draftIsNew) await loadState();
      toast("error", message);
    } finally {
      setBusy("");
    }
  }

  return {
    checkPreflight,
    checkProxy,
    deleteProfile,
    duplicateProfile,
    launchProfile,
    persistDraft,
    saveDraft,
    showBrowserCoreMissing,
    stopProfile,
  };
}
