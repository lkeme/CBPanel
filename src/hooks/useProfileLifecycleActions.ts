import type { Dispatch, MutableRefObject, SetStateAction } from "react";

import type { Locale, TranslationKey } from "../i18n";
import { preflightToastMessage } from "../components/profiles/ProfileDetails";
import { profileNameValidationError, profileStartUrlValidationError, selectedProxyIdForDraft } from "../components/profiles/profileWorkbenchHelpers";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import type { WorkbenchView } from "../components/registry/registryStats";
import { api, launchErrorMessage, profileErrorMessage } from "../lib/apiClient";
import { omitKeys, withoutIds } from "../lib/collectionState";
import { launchGeoSummary } from "../lib/launchGeoDisplay";
import type { BrowserEnvironment, NetworkCheckResult } from "../shared/entities";
import { networkCheckSummaryText } from "../shared/networkCheckDisplay";
import {
  abortProfileLaunchRequest,
  isAbortError,
  launchResponseMatchesRequest,
  launchResponseOutcome,
  type ProfileLaunchRequest,
  registerProfileLaunchRequest,
  rekeyProfileLaunchRequest,
  upsertSessionByGeneration,
} from "./profileLaunchState";
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
  launchRequestsRef,
  loadState,
  localProxyDraftIds,
  markLaunchPending,
  setBusy,
  setConfirmDialog,
  setDraft,
  setDraftIsNew,
  setDraftProxyLibraryIds,
  setDrawerMode,
  setLocalProxyDraftIds,
  setPreflight,
  setProxyCheck,
  setSelectedId,
  setSelectedIds,
  setState,
  setWorkbenchView,
  state,
  t,
  locale,
  toast,
}: {
  browserCoreMissing: boolean;
  draft: BrowserProfile | null;
  draftIsNew: boolean;
  draftProxyLibraryIds: Record<string, string>;
  launchRequestsRef: MutableRefObject<Map<string, ProfileLaunchRequest>>;
  loadState: () => Promise<unknown>;
  localProxyDraftIds: Set<string>;
  markLaunchPending: (id: string, pending: boolean) => void;
  setBusy: Dispatch<SetStateAction<string>>;
  setConfirmDialog: Dispatch<SetStateAction<ConfirmDialogState>>;
  setDraft: Dispatch<SetStateAction<BrowserProfile | null>>;
  setDraftIsNew: Dispatch<SetStateAction<boolean>>;
  setDraftProxyLibraryIds: Dispatch<SetStateAction<Record<string, string>>>;
  setDrawerMode: Dispatch<SetStateAction<DrawerMode>>;
  setLocalProxyDraftIds: Dispatch<SetStateAction<Set<string>>>;
  setPreflight: Dispatch<SetStateAction<ProfilePreflightReport | null>>;
  setProxyCheck: Dispatch<SetStateAction<string>>;
  setSelectedId: Dispatch<SetStateAction<string>>;
  setSelectedIds: Dispatch<SetStateAction<Set<string>>>;
  setState: Dispatch<SetStateAction<PanelState | null>>;
  setWorkbenchView: Dispatch<SetStateAction<WorkbenchView>>;
  state: PanelState | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  toast: (kind: "success" | "error" | "info", text: string) => void;
}) {
  function showBrowserCoreMissing() {
    setWorkbenchView("runtimeCheck");
    setDrawerMode(null);
    toast("error", t("browserCore.missingAction"));
  }

  async function persistDraft(notify: boolean): Promise<BrowserProfile | null> {
    if (!draft) return null;
    // The trash has to be part of the judgement here too, not only in the inline field error: a
    // soft-deleted environment keeps its `profiles` row, so saving over its name reaches the store and
    // comes back as a 409 that the panel could have caught.
    const nameError = profileNameValidationError(draft, state?.profiles ?? [], draftIsNew, t, state?.trash ?? []);
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
      toast("error", profileErrorMessage(error, t));
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
    if (launchRequestsRef.current.has(id)) return;
    if (browserCoreMissing) {
      showBrowserCoreMissing();
      return;
    }
    const profile = draftIsNew && draft?.id === id
      ? draft
      : state?.profiles.find((item) => item.id === id);
    if (!profile) return;

    const request = registerProfileLaunchRequest(
      launchRequestsRef.current,
      id,
      state?.sessions.find((session) => session.profileId === id),
    );
    markLaunchPending(id, true);
    let requestProfileId = id;
    let attemptedLaunchId: string | null = null;
    try {
      let launchTarget = profile;
      if (draft?.id === id) {
        const saved = await persistDraft(false);
        if (!saved) {
          finishLaunchRequest(requestProfileId, request);
          return;
        }
        launchTarget = saved;
      }
      if (launchTarget.id !== requestProfileId) {
        if (!rekeyProfileLaunchRequest(launchRequestsRef.current, requestProfileId, launchTarget.id, request)) {
          finishLaunchRequest(requestProfileId, request);
          return;
        }
        markLaunchPending(requestProfileId, false);
        requestProfileId = launchTarget.id;
        markLaunchPending(requestProfileId, true);
      }
      attemptedLaunchId = launchTarget.id;
      const session = await api<SessionSummary>(`/api/environments/${launchTarget.id}/launch`, {
        method: "POST",
        signal: request.controller.signal,
      });
      if (launchRequestsRef.current.get(requestProfileId) !== request) return;
      if (!launchResponseMatchesRequest(request, session)) return;
      upsertSession(session);
      const outcome = launchResponseOutcome(session);
      if (session.startedAt) request.observedStartedAt = session.startedAt;
      if (outcome.kind === "pending") return;
      finishLaunchRequest(requestProfileId, request);
      if (outcome.kind === "running") {
        toast(
          outcome.tone,
          outcome.message ?? t(outcome.headless ? "toast.launchedHeadless" : "toast.launched"),
        );
        return;
      }
      const fallbackKey = outcome.status === "stopped"
        ? "toast.launchStopped"
        : outcome.status === "stopping"
          ? "toast.launchStopping"
          : "toast.launchFailed";
      toast(outcome.tone, outcome.message ?? t(fallbackKey));
      if (attemptedLaunchId) {
        setSelectedId(attemptedLaunchId);
        setDrawerMode("details");
      }
    } catch (error) {
      if (request.controller.signal.aborted || isAbortError(error)) return;
      finishLaunchRequest(requestProfileId, request);
      toast("error", launchErrorMessage(error, t));
      if (attemptedLaunchId) {
        setSelectedId(attemptedLaunchId);
        setDrawerMode("details");
      }
      void loadState().catch(() => undefined);
    }
  }

  function finishLaunchRequest(id: string, request: ProfileLaunchRequest) {
    if (!abortProfileLaunchRequest(launchRequestsRef.current, id, request)) return;
    markLaunchPending(id, false);
  }

  async function stopProfile(id = draft?.id) {
    if (!id) return;
    if (abortProfileLaunchRequest(launchRequestsRef.current, id)) {
      markLaunchPending(id, false);
    }
    setBusy(`stop:${id}`);
    try {
      const session = await api<SessionSummary>(`/api/environments/${id}/stop`, { method: "POST" });
      upsertSession(session);
      // The server refuses to claim a process exit nobody observed, so the panel must not claim it
      // either: a green "session stopped" here was the last thing the user saw before the browser core
      // and extension operations started refusing with no visible reason.
      if (session.closeUnconfirmed) {
        toast("error", session.lastError ?? t("toast.stopUnconfirmed"));
      } else {
        toast("success", t("toast.stopped"));
      }
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
      const warnOnly = report.ok && report.summary.warn > 0;
      if (!report.ok || warnOnly) {
        setDrawerMode("details");
        setSelectedId(saved.id);
      }
      if (warnOnly) {
        toast("info", t("toast.preflightPassWithWarnings", { count: report.summary.warn }));
      } else {
        toast(report.ok ? "success" : "error", preflightToastMessage(report, t));
      }
    } catch (error) {
      // Preflight saves the draft first, so this catch also sees the store's name 409.
      toast("error", profileErrorMessage(error, t));
    } finally {
      setBusy("");
    }
  }

  function upsertSession(session: SessionSummary) {
    setState((current) => {
      if (!current) return current;
      return {
        ...current,
        sessions: upsertSessionByGeneration(current.sessions, session),
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
      const summary = networkCheckSummaryText(result, {
        emptyText: t("table.ipUnchecked"),
        failedText: t("table.ipCheckFailed"),
        includeFlag: true,
        locale,
      });
      setProxyCheck(summary);
      if (saved) await loadState();
      toast(result.ok ? "success" : "error", result.ok ? t("toast.proxyReady") : summary);
    } catch (error) {
      // An existing environment is saved before it is checked, so a name 409 can land here too and the
      // result line would otherwise print the store's Chinese literal to an en-US panel.
      const message = profileErrorMessage(error, t);
      setProxyCheck(message);
      if (!draftIsNew) await loadState();
      toast("error", message);
    } finally {
      setBusy("");
    }
  }

  // Deliberately does not persist the draft first, unlike checkProxy: nothing is stored, so there is no
  // saved environment to attach the answer to. That also keeps the draft's proxy the thing being asked
  // about — saving first would answer for whatever the save normalized it into.
  async function resolveProxyGeoip() {
    if (!draft) return;
    setBusy("proxy-geoip");
    setProxyCheck("");
    try {
      const result = await api<NetworkCheckResult>("/api/proxy/geoip", {
        method: "POST",
        body: JSON.stringify({ proxy: draft.proxy }),
      });
      const summary = launchGeoSummary(result, t);
      setProxyCheck(summary);
      // A resolution that reached the exit but got no timezone/locale is not a failure — the reason is
      // already in the summary, so the toast follows the reason rather than the ok flag alone.
      toast(result.geoUnresolvedReason ? "info" : "success", summary);
    } catch (error) {
      const message = profileErrorMessage(error, t);
      setProxyCheck(message);
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
    resolveProxyGeoip,
    saveDraft,
    showBrowserCoreMissing,
    stopProfile,
  };
}
