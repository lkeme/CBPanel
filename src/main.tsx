import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { type Root, createRoot } from "react-dom/client";
import {
  Check,
  CircleAlert,
  RefreshCw,
  X,
} from "lucide-react";
import { Toaster } from "sonner";
import { AppSidebar } from "./components/app/AppSidebar";
import { DesktopTitlebar } from "./components/app/DesktopTitlebar";
import type { BrowserCoreImportDialogState } from "./components/browser-core/BrowserCoreImportDialog";
import { browserCoreOperationActive, isBrowserCoreBusy } from "./components/browser-core/BrowserCoreStatusPanels";
import {
  DetailsDrawer,
  ProfileInspectorAside,
  firstPreflightFailure,
} from "./components/profiles/ProfileDetails";
import type { ProfileEditorTab } from "./components/profiles/ProfileEditorDrawer";
import { ProfileWorkbenchControls } from "./components/profiles/ProfileWorkbenchControls";
import { ProfilePagination, ProfileTable, statusText } from "./components/profiles/ProfileTable";
import {
  parseProxyInput,
  profileNameValidationError,
  proxyNameFromSettings,
  sortProfiles,
  workbenchViewMetaKey,
  workbenchViewTitleKey,
} from "./components/profiles/profileWorkbenchHelpers";
import type { ExtensionImportDialogState, TextInputDialogState } from "./components/registry/RegistryDialogs";
import { buildModuleStats, type ModeFilter, type ProxyFilter, type StatusFilter, type WorkbenchView } from "./components/registry/registryStats";
import type { SettingsTab } from "./components/settings/SettingsDrawer";
import type { ConfirmDialogState } from "./components/ui/ConfirmDialog";
import { LoadingSkeleton } from "./components/ui/LoadingSkeleton";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  type BrowserProfile,
  type PanelState,
  type ProfilePreflightAction,
  type ProfilePreflightReport,
  type ProxyScheme,
  applyProfileConfigShare,
  buildProxyUrl,
  createProfileConfigShareString,
  defaultProfile,
  maskProxyUrl,
  maskProxyUrlForDisplay,
  nowIso,
  parseProfileConfigShareString,
  proxyUrlFromParts,
} from "./shared/profile";
import {
  type BrowserEnvironment,
  type ExtensionEntity,
  type ExtensionSourceEntity,
  type GroupEntity,
  type ProxyEntity,
  type SystemDiagnostics,
  type TagEntity,
} from "./shared/entities";
import {
  type BinaryInfo,
  shouldRunStartupBrowserCoreUpdateCheck,
} from "./shared/browserCore";
import type { EnvironmentPackageOperation } from "./shared/environmentPackage";
import type { AppBackupOperation } from "./shared/appBackup";
import {
  type AppSettings,
  type AppSettingsPatch,
  type DesktopCloseBehavior,
  type DesktopRuntimeInfo,
  type ProfileColumnConfig,
  ADVANCED_WEB_ENTRY_CODE,
  DEFAULT_APP_SETTINGS,
  mergeSettings,
  normalizeSettings,
} from "./shared/settings";
import { api, errorMessage, initializeDesktopBridge, referenceErrorMessage, type RuntimeError } from "./lib/apiClient";
import { omitKeys, withoutIds } from "./lib/collectionState";
import { useBrowserCoreActions } from "./hooks/useBrowserCoreActions";
import { useDiagnosticsActions } from "./hooks/useDiagnosticsActions";
import { useExtensionActions } from "./hooks/useExtensionActions";
import { useProfileLifecycleActions } from "./hooks/useProfileLifecycleActions";
import { useProfileUtilityActions } from "./hooks/useProfileUtilityActions";
import { useProxyActions } from "./hooks/useProxyActions";
import { useRegistryActions } from "./hooks/useRegistryActions";
import { type TranslationKey, localeFromMode, translate } from "./i18n";
import "subsetted-fonts/SarasaUiSC-Regular/SarasaUiSC-Regular.css";
import "./styles.css";

const RegistryModuleView = lazy(() =>
  import("./components/registry/RegistryModuleView").then((module) => ({ default: module.RegistryModuleView })),
);
const BrowserCoreImportDialog = lazy(() =>
  import("./components/browser-core/BrowserCoreImportDialog").then((module) => ({ default: module.BrowserCoreImportDialog })),
);
const ProfileEditorDrawer = lazy(() =>
  import("./components/profiles/ProfileEditorDrawer").then((module) => ({ default: module.ProfileEditorDrawer })),
);
const EnvironmentPackageOperationDialog = lazy(() =>
  import("./components/profiles/EnvironmentPackageOperationDialog").then((module) => ({ default: module.EnvironmentPackageOperationDialog })),
);
const SettingsDrawer = lazy(() =>
  import("./components/settings/SettingsDrawer").then((module) => ({ default: module.SettingsDrawer })),
);
const ColumnSettingsDrawer = lazy(() =>
  import("./components/profiles/ColumnSettingsDrawer").then((module) => ({ default: module.ColumnSettingsDrawer })),
);
const ConfirmDialog = lazy(() =>
  import("./components/ui/ConfirmDialog").then((module) => ({ default: module.ConfirmDialog })),
);
const ProxyEditorDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.ProxyEditorDialog })),
);
const RegistryEntityDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.RegistryEntityDialog })),
);
const RegistryMergeDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.RegistryMergeDialog })),
);
const ExtensionImportDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.ExtensionImportDialog })),
);
const ExtensionSourceDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.ExtensionSourceDialog })),
);
const ProxyReferenceDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.ProxyReferenceDialog })),
);
const TextInputDialog = lazy(() =>
  import("./components/registry/RegistryDialogs").then((module) => ({ default: module.TextInputDialog })),
);

type TabKey = ProfileEditorTab;
type DrawerMode = "edit" | "settings" | "details" | "columns" | null;
type Toast = {
  id: string;
  kind: "success" | "error" | "info";
  text: string;
};

type ProxyEditorState =
  | { mode: "create" }
  | { mode: "edit"; proxy: ProxyEntity }
  | null;

type ProxyReferenceState = {
  action: "replace" | "unbind" | "delete";
  proxy: ProxyEntity;
} | null;

type RegistryEditorState =
  | { kind: "group"; mode: "create"; entity?: undefined }
  | { kind: "group"; mode: "edit"; entity: GroupEntity }
  | { kind: "tag"; mode: "create"; entity?: undefined }
  | { kind: "tag"; mode: "edit"; entity: TagEntity }
  | null;

type RegistryMergeState =
  | { kind: "group"; entity: GroupEntity }
  | { kind: "tag"; entity: TagEntity }
  | null;

type ExtensionSourceEditorState =
  | { mode: "create"; source?: undefined }
  | { mode: "edit"; source: ExtensionSourceEntity }
  | null;

function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<BrowserProfile | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("runtime");
  const [drawerMode, setDrawerMode] = useState<DrawerMode>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [proxyFilter, setProxyFilter] = useState<ProxyFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [groupFilter, setGroupFilter] = useState("");
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [proxyEntityFilter, setProxyEntityFilter] = useState("");
  const [profilePage, setProfilePage] = useState(1);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [workbenchView, setWorkbenchView] = useState<WorkbenchView>("profiles");
  const [busy, setBusy] = useState("");
  const [pendingLaunchIds, setPendingLaunchIds] = useState<Set<string>>(() => new Set());
  const [localProxyDraftIds, setLocalProxyDraftIds] = useState<Set<string>>(() => new Set());
  const [draftProxyLibraryIds, setDraftProxyLibraryIds] = useState<Record<string, string>>({});
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialogState>(null);
  const [textInputDialog, setTextInputDialog] = useState<TextInputDialogState>(null);
  const [proxyEditor, setProxyEditor] = useState<ProxyEditorState>(null);
  const [proxyReference, setProxyReference] = useState<ProxyReferenceState>(null);
  const [registryEditor, setRegistryEditor] = useState<RegistryEditorState>(null);
  const [registryMerge, setRegistryMerge] = useState<RegistryMergeState>(null);
  const [extensionImport, setExtensionImport] = useState<ExtensionImportDialogState>(null);
  const [extensionSourceEditor, setExtensionSourceEditor] = useState<ExtensionSourceEditorState>(null);
  const [browserCoreImport, setBrowserCoreImport] = useState<BrowserCoreImportDialogState>(null);
  const [environmentPackageOperation, setEnvironmentPackageOperation] = useState<EnvironmentPackageOperation | null>(null);
  const [appBackupOperation, setAppBackupOperation] = useState<AppBackupOperation | null>(null);
  const [proxyCheck, setProxyCheck] = useState("");
  const [binaryInfo, setBinaryInfo] = useState<BinaryInfo | null>(null);
  const [preflight, setPreflight] = useState<ProfilePreflightReport | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<RuntimeError | null>(null);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const pendingLaunchIdsRef = useRef<Set<string>>(new Set());
  const confirmedSettingsRef = useRef<AppSettings | null>(null);
  const optimisticSettingsRef = useRef<AppSettings | null>(null);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsSaveSeqRef = useRef(0);
  const startupBrowserCoreCheckDone = useRef(false);

  const settings = state?.settings ?? DEFAULT_APP_SETTINGS;
  const locale = localeFromMode(settings.appearance.language, navigator.language);
  const t = (key: TranslationKey, params?: Record<string, string | number>) => translate(locale, key, params);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    applyAppearance(settings);
    if (!optimisticSettingsRef.current) {
      confirmedSettingsRef.current = normalizeSettings(settings);
    }
  }, [settings]);

  useEffect(() => {
    if (startupBrowserCoreCheckDone.current || !state || !binaryInfo) return;
    if (!normalizeSettings(settings).binary.checkForUpdatesOnStartup) return;
    if (!shouldRunStartupBrowserCoreUpdateCheck(settings.binary.lastUpdateCheck)) return;
    startupBrowserCoreCheckDone.current = true;
    void checkBrowserCoreUpdate({ silent: true });
  }, [binaryInfo, settings, state]);

  useEffect(() => {
    if (runtime?.shell !== "desktop") return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) =>
        listen<{ action: "open" | "settings" | "quit" }>("cbpanel-tray-action", (event) => {
          if (disposed) return;
          if (event.payload.action === "settings") {
            openSettings("general");
            return;
          }
          if (event.payload.action === "quit") {
            requestDesktopQuit();
          }
        }),
      )
      .then((cleanup) => {
        if (disposed) cleanup();
        else unlisten = cleanup;
      })
      .catch((error) => console.warn("Tauri tray listener failed", error));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [runtime?.shell]);

  useEffect(() => {
    if (runtime?.shell !== "desktop") return;
    const runningCount = (state?.sessions ?? []).filter((session) =>
      session.status === "running" || session.status === "launching" || session.status === "stopping"
    ).length;
    void invoke("cbpanel_update_tray_state", {
      runningCount,
      sidecarStatus: runtime.sidecar.status,
    }).catch((error) => console.warn("Tauri tray update failed", error));
  }, [runtime?.shell, runtime?.sidecar.status, state?.sessions]);

  useEffect(() => {
    if (draftIsNew) return;
    if (!state?.profiles.length) {
      setDraft(null);
      return;
    }
    const selected = state.profiles.find((profile) => profile.id === selectedId) ?? state.profiles[0];
    if (!selected) return;
    if (selected.id !== selectedId) setSelectedId(selected.id);
    setDraft(structuredClone(selected));
    setPreflight((current) => (current?.profileId === selected.id ? current : null));
  }, [draftIsNew, state, selectedId]);

  const sessionsByProfileId = useMemo(
    () => new Map((state?.sessions ?? []).map((session) => [session.profileId, session])),
    [state?.sessions],
  );

  const selectedSession = sessionsByProfileId.get(selectedId);
  const activeFilterCount =
    (statusFilter === "running" ? 1 : 0) +
    (proxyFilter !== "all" ? 1 : 0) +
    (modeFilter !== "all" ? 1 : 0) +
    (groupFilter ? 1 : 0) +
    (proxyEntityFilter ? 1 : 0) +
    tagFilters.length;
  const environmentsById = useMemo(
    () => new Map((state?.environments ?? []).map((environment) => [environment.id, environment])),
    [state?.environments],
  );
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const profile of state?.profiles ?? []) {
      for (const tag of profile.tags) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
  }, [state?.profiles]);
  const hasActiveSessions = useMemo(
    () => (state?.sessions ?? []).some((session) => session.status === "running" || session.status === "launching" || session.status === "stopping"),
    [state?.sessions],
  );
  const moduleStats = useMemo(() => buildModuleStats(state, sessionsByProfileId), [sessionsByProfileId, state]);
  const filteredProfiles = useMemo(() => {
    const profiles = state?.profiles ?? [];
    const needle = query.trim().toLowerCase();
    const filtered = profiles.filter((profile) => {
      const session = sessionsByProfileId.get(profile.id);
      const isRunning = session?.status === "running" || session?.status === "launching";
      if (statusFilter === "running" && !isRunning) return false;
      if (proxyFilter === "enabled" && !buildProxyUrl(profile.proxy)) return false;
      if (proxyFilter === "disabled" && buildProxyUrl(profile.proxy)) return false;
      if (proxyEntityFilter && environmentsById.get(profile.id)?.proxyId !== proxyEntityFilter) return false;
      if (modeFilter !== "all" && profile.mode !== modeFilter) return false;
      if (groupFilter && profile.group !== groupFilter) return false;
      if (tagFilters.length > 0 && !tagFilters.every((tag) => profile.tags.includes(tag))) return false;
      if (!needle) return true;
      return [profile.name, profile.group, profile.notes, profile.startUrl, ...profile.tags].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
    return sortProfiles(filtered, settings);
  }, [environmentsById, groupFilter, modeFilter, proxyEntityFilter, proxyFilter, query, sessionsByProfileId, settings, state?.profiles, statusFilter, tagFilters]);

  const visibleColumns = useMemo(
    () =>
      normalizeSettings(settings).table.columns.filter((column) => {
        if (column.id === "select") return true;
        return column.visible;
      }),
    [settings],
  );

  const selectedProfiles = useMemo(
    () => (state?.profiles ?? []).filter((profile) => selectedIds.has(profile.id)),
    [selectedIds, state?.profiles],
  );
  const profileNameError = useMemo(
    () => (draft ? profileNameValidationError(draft, state?.profiles ?? [], draftIsNew, t) : ""),
    [draft, draftIsNew, locale, state?.profiles],
  );

  useEffect(() => {
    if (!hasActiveSessions) return;
    const interval = window.setInterval(() => {
      void loadState();
    }, 1800);
    return () => window.clearInterval(interval);
  }, [hasActiveSessions]);

  useEffect(() => {
    if (!browserCoreOperationActive(binaryInfo?.core?.operation) && !isBrowserCoreBusy(busy)) return;
    const interval = window.setInterval(() => {
      void loadBinaryInfo(false);
    }, 1200);
    return () => window.clearInterval(interval);
  }, [binaryInfo?.core?.operation?.id, binaryInfo?.core?.operation?.status, busy]);

  const runtimeIsCustomDesktop = runtime?.shell === "desktop" && runtime.platform === "windows" && runtime.chrome === "custom";
  const browserCoreMissing = binaryInfo ? !binaryInfo.installed : false;
  const totalProfiles = state?.meta.profileCount ?? state?.profiles.length ?? 0;
  const inspectorOpen = settings.table.showInspector && drawerMode === "details";
  const normalizedSettings = normalizeSettings(settings);
  const sidebarCollapsed = normalizedSettings.desktop.sidebarMode === "collapsed";
  const draftSession = draft ? sessionsByProfileId.get(draft.id) : undefined;
  const draftRunning = draftSession?.status === "running" || draftSession?.status === "launching";
  const pageSize = normalizedSettings.table.pageSize;
  const totalPages = Math.max(1, Math.ceil(filteredProfiles.length / pageSize));
  const currentPage = Math.min(profilePage, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pagedProfiles = filteredProfiles.slice(pageStart, pageStart + pageSize);
  const allPageSelected = pagedProfiles.length > 0 && pagedProfiles.every((profile) => selectedIds.has(profile.id));
  const pageEnd = filteredProfiles.length === 0 ? 0 : Math.min(filteredProfiles.length, pageStart + pagedProfiles.length);

  useEffect(() => {
    setProfilePage(1);
  }, [groupFilter, modeFilter, proxyEntityFilter, proxyFilter, query, statusFilter, tagFilters.join("\u0000")]);

  useEffect(() => {
    if (profilePage > totalPages) setProfilePage(totalPages);
  }, [profilePage, totalPages]);

  async function bootstrap() {
    const bridgeError = await initializeDesktopBridge(t, setRuntime);
    setRuntimeError(bridgeError);
    if (bridgeError) return;
    await Promise.all([loadState(), loadBinaryInfo(false), loadRuntimeInfo(), loadDiagnostics()]);
  }

  async function loadState(): Promise<PanelState> {
    const next = await api<PanelState>("/api/state");
    const optimisticSettings = optimisticSettingsRef.current;
    if (!optimisticSettings) {
      confirmedSettingsRef.current = normalizeSettings(next.settings);
    }
    setState(optimisticSettings ? { ...next, settings: optimisticSettings } : next);
    return next;
  }

  async function loadRuntimeInfo() {
    try {
      setRuntime(await api<DesktopRuntimeInfo>("/api/desktop/runtime"));
    } catch {
      setRuntime(null);
    }
  }

  async function loadBinaryInfo(notify: boolean) {
    try {
      const info = await api<BinaryInfo>("/api/binary");
      setBinaryInfo(info);
      if (!info.installed) {
        setWorkbenchView((current) => (current === "profiles" ? "runtimeCheck" : current));
      } else {
        setWorkbenchView((current) => (current === "runtimeCheck" ? "profiles" : current));
      }
      if (notify) toast("success", t("actions.refresh"));
    } catch (error) {
      if (notify) toast("error", (error as Error).message);
    }
  }

  function toast(kind: Toast["kind"], text: string) {
    const id = crypto.randomUUID();
    setToasts((items) => [...items, { id, kind, text }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 4200);
  }

  function updateDraft(next: BrowserProfile) {
    setDraft(next);
    setPreflight((current) => (current?.profileId === next.id ? null : current));
  }

  async function shareDraftConfigToClipboard() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(createProfileConfigShareString(draft));
      toast("success", t("toast.profileConfigShared"));
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  async function importDraftConfigFromClipboard() {
    if (!draft) return;
    try {
      const share = parseProfileConfigShareString(await navigator.clipboard.readText());
      setConfirmDialog({
        title: t("profileConfig.importTitle"),
        body: t("profileConfig.importBody", { name: share.profile.name }),
        confirmLabel: t("actions.importConfig"),
        busyKey: "profile-config-import",
        onConfirm: async () => {
          setBusy("profile-config-import");
          try {
            updateDraft(applyProfileConfigShare(draft, share));
            setLocalProxyDraftIds((current) => new Set(current).add(draft.id));
            setDraftProxyLibraryIds((current) => omitKeys(current, [draft.id]));
            setConfirmDialog(null);
            toast("success", t("toast.profileConfigImported"));
          } finally {
            setBusy("");
          }
        },
      });
    } catch (error) {
      toast("error", errorMessage(error));
    }
  }

  async function exportAppBackup() {
    await runAppBackupAction("export");
  }

  async function restoreAppBackup() {
    await runAppBackupAction("restore");
  }

  async function runAppBackupAction(action: "export" | "restore") {
    const client = await import("./lib/appBackupClient");
    const context = {
      t,
      toast,
      setBusy,
      setAppBackupOperation,
    };
    if (action === "export") {
      await client.runAppBackupExport(context);
      return;
    }
    await client.requestAppBackupRestore({
      ...context,
      setConfirmDialog,
      afterRestore: refreshAfterAppBackupRestore,
    });
  }

  async function refreshAfterAppBackupRestore() {
    setSelectedIds(new Set());
    setDraft(null);
    setDrawerMode(null);
    const [nextState] = await Promise.all([loadState(), loadBinaryInfo(false), loadRuntimeInfo(), loadDiagnostics()]);
    setSelectedId(nextState.profiles[0]?.id ?? "");
  }

  function closeDrawer() {
    setDrawerMode(null);
    if (!draftIsNew) return;
    setDraftIsNew(false);
    const selected = state?.profiles.find((profile) => profile.id === selectedId) ?? state?.profiles[0] ?? null;
    setDraft(selected ? structuredClone(selected) : null);
  }

  const {
    checkPreflight,
    checkProxy,
    deleteProfile: deleteProfileAction,
    duplicateProfile,
    launchProfile,
    persistDraft,
    saveDraft,
    showBrowserCoreMissing,
    stopProfile,
  } = useProfileLifecycleActions({
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
  });

  async function deleteProfile() {
    await deleteProfileAction(closeDrawer);
  }

  async function saveSettings(patch: AppSettingsPatch) {
    const baseSettings = optimisticSettingsRef.current ?? confirmedSettingsRef.current ?? normalizeSettings(settings);
    const nextSettings = mergeSettings(baseSettings, patch);
    const saveSeq = settingsSaveSeqRef.current + 1;
    settingsSaveSeqRef.current = saveSeq;
    optimisticSettingsRef.current = nextSettings;
    setState((current) => (current ? { ...current, settings: nextSettings } : current));
    setBusy("settings");
    const requestPatch = settingsPatchFromNext(patch, nextSettings);
    const save = settingsSaveQueueRef.current
      .catch(() => undefined)
      .then(() =>
        api<AppSettings>("/api/settings", {
          method: "PUT",
          body: JSON.stringify(requestPatch),
        }),
      );
    settingsSaveQueueRef.current = save.then(() => undefined, () => undefined);
    try {
      const saved = normalizeSettings(await save);
      confirmedSettingsRef.current = saved;
      if (saveSeq === settingsSaveSeqRef.current) {
        optimisticSettingsRef.current = null;
        setState((current) => (current ? { ...current, settings: saved } : current));
      }
    } catch (error) {
      if (saveSeq === settingsSaveSeqRef.current) {
        optimisticSettingsRef.current = null;
        const confirmedSettings = confirmedSettingsRef.current ?? baseSettings;
        setState((current) => (current ? { ...current, settings: confirmedSettings } : current));
        toast("error", (error as Error).message);
      }
    } finally {
      if (saveSeq === settingsSaveSeqRef.current) setBusy("");
    }
  }

  function requestAdvancedWebEntry(currentSettings: AppSettings) {
    const normalized = normalizeSettings(currentSettings);
    setTextInputDialog({
      title: t("confirm.advancedWebEntryTitle"),
      body: t("confirm.advancedWebEntryCode", { code: ADVANCED_WEB_ENTRY_CODE }),
      bodyCode: ADVANCED_WEB_ENTRY_CODE,
      label: t("confirm.advancedWebEntryLabel"),
      placeholder: t("confirm.advancedWebEntryPlaceholder"),
      confirmLabel: t("actions.apply"),
      secret: true,
      busyKey: "settings",
      validate: (value) => (value === ADVANCED_WEB_ENTRY_CODE ? null : t("error.invalidTarget")),
      onConfirm: async () => {
        await saveSettings({ desktop: { ...normalized.desktop, advancedWebEntry: true } });
        setTextInputDialog(null);
      },
    });
  }

  function cycleTheme() {
    const nextTheme = normalizedSettings.appearance.theme === "dark" ? "light" : "dark";
    void saveSettings({ appearance: { ...normalizedSettings.appearance, theme: nextTheme } });
  }

  function cycleLanguage() {
    const nextLanguage = normalizedSettings.appearance.language === "zh-CN" ? "en-US" : "zh-CN";
    void saveSettings({ appearance: { ...normalizedSettings.appearance, language: nextLanguage } });
  }

  function toggleSidebarMode() {
    const sidebarMode = sidebarCollapsed ? "expanded" : "collapsed";
    void saveSettings({ desktop: { ...normalizedSettings.desktop, sidebarMode } });
  }

  function createProfile() {
    const profile = defaultProfile({ name: t("form.defaultProfileName") });
    setDraft(profile);
    setDraftIsNew(true);
    setPreflight(null);
    setActiveTab("runtime");
    setDrawerMode("edit");
  }

  async function saveDraftProxyToLibrary() {
    if (!draft || !buildProxyUrl(draft.proxy)) return;
    setBusy("proxy-promote");
    try {
      const proxy = await api<ProxyEntity>("/api/proxies", {
        method: "POST",
        body: JSON.stringify({
          name: proxyNameFromSettings(draft.proxy),
          scheme: draft.proxy.scheme,
          host: draft.proxy.host,
          port: draft.proxy.port,
          username: draft.proxy.username,
          password: draft.proxy.password,
          bypass: draft.proxy.bypass,
          status: "enabled",
        }),
      });
      if (!draftIsNew) {
        const environment = await api<BrowserEnvironment>(`/api/environments/${draft.id}`, {
          method: "PUT",
          body: JSON.stringify({ ...draft, updatedAt: nowIso(), proxyId: proxy.id }),
        });
        await loadState();
        setDraft(structuredClone(environment.runtimeProfile));
        setLocalProxyDraftIds((current) => withoutIds(current, [draft.id]));
        setDraftProxyLibraryIds((current) => ({ ...current, [draft.id]: proxy.id }));
      } else {
        await loadState();
        setDraftProxyLibraryIds((current) => ({ ...current, [draft.id]: proxy.id }));
      }
      toast("success", t("toast.proxySavedToLibrary"));
    } catch (error) {
      toast("error", errorMessage(error));
    } finally {
      setBusy("");
    }
  }

  function copyManagedProxyToLocal() {
    if (!draft) return;
    setLocalProxyDraftIds((current) => new Set(current).add(draft.id));
    setDraftProxyLibraryIds((current) => omitKeys(current, [draft.id]));
    updateDraft({ ...draft });
    toast("info", t("toast.proxyCopiedToEnvironment"));
  }

  const {
    analyzeBrowserCoreImport,
    checkBrowserCoreUpdate,
    checkGithubMirrors,
    clearBinaryCache,
    installBinary,
    installBrowserCoreImport,
    updateBinary,
  } = useBrowserCoreActions({
    checkPreflight,
    draft,
    preflight,
    setBinaryInfo,
    setBrowserCoreImport,
    setBusy,
    setConfirmDialog,
    t,
    toast,
  });
  const {
    copyDiagnostics,
    exportDiagnostics,
    fetchDiagnostics,
    loadDiagnostics,
    refreshDiagnostics,
  } = useDiagnosticsActions({
    diagnostics,
    downloadTextFile,
    setBusy,
    setDiagnostics,
    t,
    toast,
  });
  const {
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
  } = useRegistryActions({
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
  });
  const {
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
  } = useProxyActions({
    loadState,
    setBusy,
    setConfirmDialog,
    setProxyEditor,
    setProxyReference,
    state,
    t,
    toast,
  });
  const {
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
  } = useExtensionActions({
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
  });

  function toggleCurrentPageSelected() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allPageSelected) {
        for (const profile of pagedProfiles) next.delete(profile.id);
      } else {
        for (const profile of pagedProfiles) next.add(profile.id);
      }
      return next;
    });
  }

  function toggleSelected(id: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function resetFilters() {
    setStatusFilter("all");
    setProxyFilter("all");
    setProxyEntityFilter("");
    setModeFilter("all");
    setGroupFilter("");
    setTagFilters([]);
    setFilterPanelOpen(false);
  }

  function toggleTagFilter(tag: string) {
    setTagFilters((current) => (current.includes(tag) ? current.filter((item) => item !== tag) : [...current, tag]));
    setWorkbenchView("profiles");
  }

  function showProfileView(
    patch: { group?: string; query?: string; status?: StatusFilter; proxy?: ProxyFilter; proxyId?: string; mode?: ModeFilter; tags?: string[] } = {},
  ) {
    setWorkbenchView("profiles");
    setFilterPanelOpen(false);
    setGroupFilter(patch.group ?? "");
    setQuery(patch.query ?? "");
    setStatusFilter(patch.status ?? "all");
    setProxyFilter(patch.proxy ?? "all");
    setProxyEntityFilter(patch.proxyId ?? "");
    setModeFilter(patch.mode ?? "all");
    setTagFilters(patch.tags ?? []);
  }

  async function launchSelectedProfiles() {
    if (browserCoreMissing) {
      showBrowserCoreMissing();
      return;
    }
    for (const profile of selectedProfiles) {
      const session = sessionsByProfileId.get(profile.id);
      if (session?.status === "running" || session?.status === "launching") continue;
      await launchProfile(profile.id);
    }
  }

  async function stopSelectedProfiles() {
    for (const profile of selectedProfiles) {
      const session = sessionsByProfileId.get(profile.id);
      if (session?.status === "running" || session?.status === "launching") {
        await stopProfile(profile.id);
      }
    }
  }
  const {
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
  } = useProfileUtilityActions({
    batchLaunch: launchSelectedProfiles,
    batchStop: stopSelectedProfiles,
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
  });

  async function runPreflightAction(action: ProfilePreflightAction) {
    if (action.kind === "install-binary") {
      await installBinary();
      return;
    }
    if (action.kind === "open-tab" && action.target) {
      setActiveTab(action.target);
      setDrawerMode("edit");
    }
  }

  function selectProfile(profile: BrowserProfile, openEditor = false) {
    setDraftIsNew(false);
    setSelectedId(profile.id);
    if (openEditor) setDrawerMode("edit");
  }

  function openSettings(tab: SettingsTab = "general") {
    setSettingsInitialTab(tab);
    setDrawerMode("settings");
  }

  async function saveDesktopCloseBehavior(closeBehavior: DesktopCloseBehavior, options: { wait?: boolean } = {}) {
    if (normalizedSettings.desktop.closeBehavior === closeBehavior) return;
    const nextDesktop = { ...normalizedSettings.desktop, closeBehavior, closeToTray: closeBehavior === "tray" };
    const save = saveSettings({ desktop: nextDesktop });
    if (options.wait) await save;
    else void save;
  }

  function runDesktopCommand(command: string) {
    try {
      void invoke(command).catch((error) => console.warn("Tauri desktop command failed", error));
    } catch (error) {
      console.warn("Tauri desktop command failed", error);
    }
  }

  function hideWindowToTray() {
    runDesktopCommand("cbpanel_window_hide_to_tray");
  }

  async function hideWindowToTrayAfterSettingsSaved() {
    await settingsSaveQueueRef.current;
    hideWindowToTray();
  }

  function quitDesktopApp() {
    runDesktopCommand("cbpanel_app_quit");
  }

  function confirmRunningSessionsBeforeExit(): boolean {
    if (!hasActiveSessions) return false;
    setConfirmDialog({
        title: t("tray.closeRunningTitle"),
        body: t("tray.closeRunningBody"),
        confirmLabel: t("tray.hideToTray"),
        cancelLabel: t("actions.cancel"),
        dangerLabel: t("tray.quitApp"),
        busyKey: "window-close",
        onConfirm: async () => {
          hideWindowToTray();
          setConfirmDialog(null);
        },
        onDanger: async () => {
          quitDesktopApp();
          setConfirmDialog(null);
        },
    });
    return true;
  }

  function requestDesktopQuit() {
    if (confirmRunningSessionsBeforeExit()) return;
    quitDesktopApp();
  }

  function closeDesktopWindow() {
    if (confirmRunningSessionsBeforeExit()) {
      return;
    }
    if (normalizedSettings.desktop.closeBehavior === "tray") {
      void hideWindowToTrayAfterSettingsSaved();
      return;
    }
    if (normalizedSettings.desktop.closeBehavior === "quit") {
      quitDesktopApp();
      return;
    }
    setConfirmDialog({
      title: t("tray.closeChoiceTitle"),
      body: t("tray.closeChoiceBody"),
      confirmLabel: t("actions.confirm"),
      hideCancel: true,
      showCloseButton: true,
      busyKey: "settings",
      choice: {
        defaultValue: "tray",
        footerNote: t("tray.closeChoiceFootnote"),
        options: [
          {
            value: "tray",
            label: t("tray.hideToTray"),
          },
          {
            value: "quit",
            label: t("tray.quitApp"),
          },
        ],
      },
      onConfirm: async ({ choice }) => {
        setConfirmDialog(null);
        if (choice === "quit") {
          await saveDesktopCloseBehavior("quit", { wait: true });
          quitDesktopApp();
          return;
        }
        await saveDesktopCloseBehavior("tray", { wait: true });
        hideWindowToTray();
      },
    });
  }

  return (
    <TooltipProvider delayDuration={180}>
      <main
        className={`app-shell ${runtimeIsCustomDesktop ? "desktop-custom-chrome" : ""} ${
          sidebarCollapsed ? "sidebar-collapsed" : ""
        }`}
      >
        {runtimeIsCustomDesktop && <DesktopTitlebar closeWindow={closeDesktopWindow} runtime={runtime} t={t} />}

        <AppSidebar
          browserCoreMissing={browserCoreMissing}
          busy={busy}
          createProfile={createProfile}
          cycleLanguage={cycleLanguage}
          cycleTheme={cycleTheme}
          moduleStats={moduleStats}
          normalizedSettings={normalizedSettings}
          openSettings={() => openSettings("general")}
          setWorkbenchView={(view) => {
            setWorkbenchView(view);
            setDrawerMode(null);
          }}
          settingsActive={drawerMode === "settings"}
          showProfileView={showProfileView}
          sidebarCollapsed={sidebarCollapsed}
          t={t}
          toggleSidebarMode={toggleSidebarMode}
          totalProfiles={totalProfiles}
          trashCount={state?.trash?.length ?? 0}
          workbenchView={workbenchView}
        />

        <section className="workbench">
        {runtimeError ? (
          <section className="runtime-blocker" role="alert">
            <CircleAlert size={22} aria-hidden="true" />
            <div>
              <h1>{runtimeError.title}</h1>
              <p>{runtimeError.detail}</p>
            </div>
            <button className="command" onClick={() => void bootstrap()} type="button">
              <RefreshCw size={17} aria-hidden="true" />
              {t("actions.refresh")}
            </button>
          </section>
        ) : (
          <>
            <header className="workspace-header">
              <div className="workspace-title">
                <h1>{t(workbenchViewTitleKey(workbenchView))}</h1>
                <p>
                  {workbenchView === "profiles"
                    ? t("workspace.visibleCount", { visible: filteredProfiles.length, total: totalProfiles })
                    : t(workbenchViewMetaKey(workbenchView), workbenchView === "trash" ? { count: state?.trash?.length ?? 0 } : undefined)}
                </p>
              </div>
            </header>

            {workbenchView === "profiles" && (
              <ProfileWorkbenchControls
                activeFilterCount={activeFilterCount}
                allTags={allTags}
                browserCoreMissing={browserCoreMissing}
                filterPanelOpen={filterPanelOpen}
                importInput={importInput}
                inspectorOpen={inspectorOpen}
                query={query}
                selectedCount={selectedProfiles.length}
                statusFilter={statusFilter}
                proxyFilter={proxyFilter}
                modeFilter={modeFilter}
                tagFilters={tagFilters}
                batchDelete={batchDelete}
                batchExport={batchExport}
                batchGroupOrTag={batchGroupOrTag}
                batchLaunch={batchLaunch}
                batchStop={batchStop}
                exportProfiles={exportProfiles}
                importEnvironmentPackage={importEnvironmentPackage}
                importProfiles={importProfiles}
                loadState={loadState}
                openColumns={() => setDrawerMode("columns")}
                resetFilters={resetFilters}
                setFilterPanelOpen={setFilterPanelOpen}
                setModeFilter={setModeFilter}
                setProxyFilter={setProxyFilter}
                setQuery={setQuery}
                setStatusFilter={setStatusFilter}
                showBrowserCoreMissing={showBrowserCoreMissing}
                toggleInspector={() => (inspectorOpen ? setDrawerMode(null) : setDrawerMode("details"))}
                toggleTagFilter={toggleTagFilter}
                t={t}
              />
            )}

            <div className={`main-grid ${inspectorOpen ? "inspector-open" : "no-inspector"}`}>
              <div key={workbenchView} className="workbench-content motion-content-enter">
                {workbenchView === "profiles" ? (
                  <section className="table-surface">
                    <ProfileTable
                      allPageSelected={allPageSelected}
                      columns={visibleColumns}
                      environments={state?.environments ?? []}
                      profiles={pagedProfiles}
                      proxies={state?.proxies ?? []}
                      pendingLaunchIds={pendingLaunchIds}
                      selectedId={selectedId}
                      selectedIds={selectedIds}
                      sessionsByProfileId={sessionsByProfileId}
                      t={t}
                      tagFilters={tagFilters}
                      toggleCurrentPageSelected={toggleCurrentPageSelected}
                      toggleSelected={toggleSelected}
                      toggleTagFilter={toggleTagFilter}
                      selectProfile={selectProfile}
                      launchProfile={launchProfile}
                      browserCoreMissing={browserCoreMissing}
                      stopProfile={stopProfile}
                    />
                    <ProfilePagination
                      currentPage={currentPage}
                      filteredCount={filteredProfiles.length}
                      pageEnd={pageEnd}
                      pageSize={pageSize}
                      pageStart={filteredProfiles.length === 0 ? 0 : pageStart + 1}
                      saveSettings={saveSettings}
                      selectedCount={selectedProfiles.length}
                      setProfilePage={setProfilePage}
                      settings={normalizedSettings}
                      t={t}
                      totalPages={totalPages}
                      totalProfiles={totalProfiles}
                    />
                  </section>
                ) : (
                  <Suspense fallback={<LoadingSkeleton rows={4} />}>
                    <RegistryModuleView
                      busy={busy}
                      binaryInfo={binaryInfo}
                      browserCoreMissing={browserCoreMissing}
                      copyDiagnostics={copyDiagnostics}
                      diagnostics={diagnostics}
                      exportDiagnostics={exportDiagnostics}
                      refreshBinary={() => loadBinaryInfo(true)}
                      refreshDiagnostics={refreshDiagnostics}
                      runtime={runtime}
                      stats={moduleStats}
                      state={state}
                      storage={state?.storage}
                      t={t}
                      trash={state?.trash ?? []}
                      view={workbenchView}
                      openBrowserCoreSettings={() => openSettings("browserCore")}
                      checkManagedProxy={checkManagedProxy}
                      clearTrashEnvironments={clearTrashEnvironments}
                      deleteExtension={deleteExtension}
                      deleteExtensionSource={deleteExtensionSource}
                      duplicateProxy={duplicateProxy}
                      editGroup={(group) => setRegistryEditor({ kind: "group", mode: "edit", entity: group })}
                      editProxy={(proxy) => openProxyEditor("edit", proxy)}
                      editTag={(tag) => setRegistryEditor({ kind: "tag", mode: "edit", entity: tag })}
                      editExtensionSource={(source) => setExtensionSourceEditor({ mode: "edit", source })}
                      addExtensionSource={() => setExtensionSourceEditor({ mode: "create" })}
                      addRemoteExtension={() => setExtensionImport({ kind: "remote" })}
                      bindExtensionToSelected={bindExtensionToSelected}
                      checkExtension={checkExtension}
                      checkExtensionUpdate={checkExtensionUpdate}
                      showProfiles={showProfileView}
                      importExtensionArchive={(kind) => setExtensionImport({ kind })}
                      importExtensionDirectory={() => setExtensionImport({ kind: "directory" })}
                      installExtension={installExtension}
                      mergeGroup={(group) => setRegistryMerge({ kind: "group", entity: group })}
                      mergeTag={(tag) => setRegistryMerge({ kind: "tag", entity: tag })}
                      newGroup={() => setRegistryEditor({ kind: "group", mode: "create" })}
                      newTag={() => setRegistryEditor({ kind: "tag", mode: "create" })}
                      newProxy={() => openProxyEditor("create")}
                      reinstallExtension={reinstallExtension}
                      permanentlyDeleteTrashEnvironment={permanentlyDeleteTrashEnvironment}
                      refreshExtensionSource={refreshExtensionSource}
                      requestProxyDelete={requestProxyDelete}
                      requestProxyReference={(action, proxy) => setProxyReference({ action, proxy })}
                      requestGroupDelete={requestGroupDelete}
                      requestTagDelete={requestTagDelete}
                      restoreTrashEnvironment={restoreTrashEnvironment}
                      toggleExtensionSourceStatus={toggleExtensionSourceStatus}
                      toggleExtensionSourceUnsigned={toggleExtensionSourceUnsigned}
                      unbindExtensionFromSelected={unbindExtensionFromSelected}
                      updateExtension={updateExtension}
                      updateGroup={updateGroup}
                      updateProxy={updateProxy}
                      updateTag={updateTag}
                    />
                  </Suspense>
                )}
              </div>

              {workbenchView === "profiles" && inspectorOpen && draft && (
                <ProfileInspectorAside
                  busy={busy}
                  copySnippet={copySnippet}
                  copySnapshotMarkdown={copySnapshotMarkdown}
                  downloadSnapshot={downloadSnapshot}
                  draft={draft}
                  editProfile={() => setDrawerMode("edit")}
                  preflight={preflight}
                  runPreflightAction={runPreflightAction}
                  selectedSession={selectedSession}
                  state={state}
                  storage={state?.storage}
                  t={t}
                />
              )}
            </div>
          </>
        )}
        </section>

      {drawerMode === "edit" && draft && (
        <Suspense fallback={<LazyDrawerFallback close={closeDrawer} title={t("actions.edit")} t={t} />}>
          <ProfileEditorDrawer
            activeTab={activeTab}
            busy={busy}
            checkPreflight={checkPreflight}
            checkProxy={checkProxy}
            close={closeDrawer}
            deleteProfile={deleteProfile}
            draftIsNew={draftIsNew}
            draft={draft}
            duplicateProfile={duplicateProfile}
            environments={state?.environments ?? []}
            extensions={state?.extensions ?? []}
            groups={state?.groups ?? []}
            localProxyDraftIds={localProxyDraftIds}
            nameError={profileNameError}
            tags={state?.tags ?? []}
            boundExtensionIds={state?.environments?.find((environment) => environment.id === draft.id)?.extensionIds ?? []}
            proxies={state?.proxies ?? []}
            proxyCheck={proxyCheck}
            proxyLibraryDraftIds={draftProxyLibraryIds}
            browserCoreMissing={browserCoreMissing}
            running={draftRunning}
            saveDraft={saveDraft}
            saveDraftProxyToLibrary={saveDraftProxyToLibrary}
            setActiveTab={setActiveTab}
            setDraftProxyLibraryId={(draftId, proxyId) => {
              setLocalProxyDraftIds((current) => withoutIds(current, [draftId]));
              setDraftProxyLibraryIds((current) => ({ ...current, [draftId]: proxyId }));
            }}
            setDraftExtensionBinding={setDraftExtensionBinding}
            setDraft={updateDraft}
            setDraftProxyLocal={(draftId) => {
              setLocalProxyDraftIds((current) => new Set(current).add(draftId));
              setDraftProxyLibraryIds((current) => omitKeys(current, [draftId]));
            }}
            stopProfile={() => stopProfile()}
            copyManagedProxyToLocal={copyManagedProxyToLocal}
            launchProfile={() => launchProfile()}
            importConfigFromClipboard={importDraftConfigFromClipboard}
            shareConfigToClipboard={shareDraftConfigToClipboard}
            t={t}
          />
        </Suspense>
      )}

      {drawerMode === "settings" && (
        <Suspense fallback={<LazyDrawerFallback close={closeDrawer} title={t("nav.settings")} t={t} />}>
          <SettingsDrawer
            binaryInfo={binaryInfo}
            busy={busy}
            checkBrowserCoreUpdate={checkBrowserCoreUpdate}
            checkGithubMirrors={checkGithubMirrors}
            close={closeDrawer}
            exportAppBackup={exportAppBackup}
            importBrowserCoreZip={(filePath) => setBrowserCoreImport({ filePath })}
            installBinary={installBinary}
            initialTab={settingsInitialTab}
            openRuntimeCheck={() => {
              setDrawerMode(null);
              setWorkbenchView("runtimeCheck");
            }}
            requestAdvancedWebEntry={() => requestAdvancedWebEntry(normalizedSettings)}
            restoreAppBackup={restoreAppBackup}
            runtime={runtime}
            settings={settings}
            saveSettings={saveSettings}
            t={t}
            updateBinary={updateBinary}
            clearBinaryCache={clearBinaryCache}
          />
        </Suspense>
      )}

      {drawerMode === "columns" && (
        <Suspense fallback={<LazyDrawerFallback close={closeDrawer} title={t("table.columnSettings")} t={t} />}>
          <ColumnSettingsDrawer
            close={closeDrawer}
            settings={settings}
            saveSettings={saveSettings}
            t={t}
          />
        </Suspense>
      )}

      {drawerMode === "details" && draft && (
        <DetailsDrawer
          close={() => setDrawerMode(null)}
          copySnippet={copySnippet}
          copySnapshotMarkdown={copySnapshotMarkdown}
          downloadSnapshot={downloadSnapshot}
          draft={draft}
          busy={busy}
          editProfile={() => setDrawerMode("edit")}
          preflight={preflight}
          runPreflightAction={runPreflightAction}
          selectedSession={selectedSession}
          state={state}
          storage={state?.storage}
          t={t}
        />
      )}

      <Suspense fallback={<LazyModalFallback t={t} />}>
        {proxyEditor && (
          <ProxyEditorDialog
            busy={busy}
            close={() => setProxyEditor(null)}
            mode={proxyEditor.mode}
            proxy={proxyEditor.mode === "edit" ? proxyEditor.proxy : undefined}
            saveProxy={saveProxyDraft}
            t={t}
          />
        )}

        {registryEditor && (
          <RegistryEntityDialog
            busy={busy}
            close={() => setRegistryEditor(null)}
            entity={registryEditor.entity}
            kind={registryEditor.kind}
            mode={registryEditor.mode}
            saveGroup={saveGroupDraft}
            saveTag={saveTagDraft}
            t={t}
          />
        )}

        {registryMerge && (
          <RegistryMergeDialog
            busy={busy}
            close={() => setRegistryMerge(null)}
            entity={registryMerge.entity}
            groups={state?.groups ?? []}
            kind={registryMerge.kind}
            mergeGroup={mergeGroup}
            mergeTag={mergeTag}
            referenceCount={registryMerge.kind === "group" ? groupReferenceCount(registryMerge.entity.id) : tagReferenceCount(registryMerge.entity.id)}
            showProfiles={(entity) =>
              registryMerge.kind === "group"
                ? showProfileView({ group: entity.name })
                : showProfileView({ tags: [entity.name] })
            }
            tags={state?.tags ?? []}
            t={t}
          />
        )}

        {extensionImport && (
          <ExtensionImportDialog
            addRemoteExtension={addRemoteExtension}
            busy={busy}
            close={() => setExtensionImport(null)}
            importArchive={importExtensionArchivePath}
            importDirectories={importExtensionDirectoryPaths}
            importDirectory={importExtensionDirectoryPath}
            previewDirectory={previewExtensionDirectoryPath}
            state={extensionImport}
            t={t}
          />
        )}

        {extensionSourceEditor && (
          <ExtensionSourceDialog
            busy={busy}
            close={() => setExtensionSourceEditor(null)}
            mode={extensionSourceEditor.mode}
            saveSource={saveExtensionSourceDraft}
            source={extensionSourceEditor.mode === "edit" ? extensionSourceEditor.source : undefined}
            t={t}
          />
        )}
      </Suspense>

      {browserCoreImport && (
        <Suspense fallback={<LazyDrawerFallback close={() => setBrowserCoreImport(null)} title={t("settings.browserCore")} t={t} />}>
          <BrowserCoreImportDialog
            analyzeImport={analyzeBrowserCoreImport}
            busy={busy}
            close={() => setBrowserCoreImport(null)}
            installImport={installBrowserCoreImport}
            setState={setBrowserCoreImport}
            state={browserCoreImport}
            t={t}
          />
        </Suspense>
      )}

      {confirmDialog && (
        <Suspense fallback={<LazyModalFallback t={t} />}>
          <ConfirmDialog
            busy={busy}
            close={() => setConfirmDialog(null)}
            state={confirmDialog}
            t={t}
          />
        </Suspense>
      )}

      {environmentPackageOperation && (
        <EnvironmentPackageOperationDialog
          operation={environmentPackageOperation}
          t={t}
        />
      )}

      {appBackupOperation && (
        <EnvironmentPackageOperationDialog
          namespace="appBackup"
          operation={appBackupOperation}
          t={t}
        />
      )}

      <Suspense fallback={<LazyModalFallback t={t} />}>
        {proxyReference && (
          <ProxyReferenceDialog
            busy={busy}
            close={() => setProxyReference(null)}
            deleteProxy={deleteProxyNow}
            proxy={proxyReference.proxy}
            proxies={state?.proxies ?? []}
            referenceCount={proxyReferenceCount(proxyReference.proxy.id)}
            replaceAndDelete={replaceProxyReferencesAndDelete}
            replaceReferences={replaceProxyReferences}
            showProfiles={(proxyId) => showProfileView({ proxyId })}
            t={t}
            type={proxyReference.action}
            unbindAndDelete={unbindProxyReferencesAndDelete}
            unbindReferences={unbindProxyReferences}
          />
        )}

        {textInputDialog && (
          <TextInputDialog
            busy={busy}
            close={() => setTextInputDialog(null)}
            state={textInputDialog}
            t={t}
          />
        )}
      </Suspense>

        <div className="toast-stack" aria-live="polite">
          {toasts.map((item) => (
            <div className={`toast ${item.kind}`} key={item.id}>
              {item.kind === "success" ? <Check size={16} /> : <CircleAlert size={16} />}
              {item.text}
            </div>
          ))}
        </div>
        <Toaster position="bottom-right" richColors={false} closeButton theme={settings.appearance.theme === "dark" ? "dark" : "light"} />
      </main>
    </TooltipProvider>
  );
}

function settingsPatchFromNext(patch: AppSettingsPatch, nextSettings: AppSettings): AppSettingsPatch {
  return {
    ...(patch.appearance !== undefined ? { appearance: nextSettings.appearance } : {}),
    ...(patch.table !== undefined ? { table: nextSettings.table } : {}),
    ...(patch.desktop !== undefined ? { desktop: nextSettings.desktop } : {}),
    ...(patch.storage !== undefined ? { storage: nextSettings.storage } : {}),
    ...(patch.binary !== undefined ? { binary: nextSettings.binary } : {}),
    ...(patch.networkTrace !== undefined ? { networkTrace: nextSettings.networkTrace } : {}),
  };
}

function LazyDrawerFallback({
  close,
  title,
  t,
}: {
  close: () => void;
  title: string;
  t: (key: TranslationKey) => string;
}) {
  return (
    <div className="drawer-layer lazy-fallback-layer" role="dialog" aria-modal="true" aria-busy="true">
      <button className="drawer-scrim" aria-label={t("actions.close")} onClick={close} type="button" />
      <section className="drawer-panel">
        <header className="drawer-header">
          <div className="drawer-title-block">
            <h2>{title}</h2>
          </div>
          <button className="icon-button" title={t("actions.close")} onClick={close} type="button">
            <X size={16} aria-hidden="true" />
          </button>
        </header>
        <div className="drawer-scroll">
          <LoadingSkeleton variant="drawer" />
        </div>
      </section>
    </div>
  );
}

function LazyModalFallback({ t }: { t: (key: TranslationKey) => string }) {
  return (
    <div className="modal-layer lazy-fallback-layer" role="dialog" aria-modal="true" aria-busy="true">
      <div className="modal-scrim" />
      <section className="modal-panel">
        <div className="modal-body">
          <LoadingSkeleton rows={2} variant="modal" />
        </div>
      </section>
    </div>
  );
}

function applyAppearance(settings: AppSettings): void {
  const normalized = normalizeSettings(settings);
  const root = document.documentElement;
  const theme =
    normalized.appearance.theme === "system"
      ? window.matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light"
      : normalized.appearance.theme;

  root.dataset.theme = theme;
  root.dataset.density = normalized.appearance.density;
  root.style.setProperty("--font-ui", normalized.appearance.uiFontFamily);
  root.style.setProperty("--font-mono", normalized.appearance.monoFontFamily);
  root.style.setProperty("--font-size-base", `${normalized.appearance.baseFontSize}px`);
  root.style.setProperty("--font-size-table", `${normalized.appearance.tableFontSize}px`);
  root.style.setProperty("--font-size-code", `${normalized.appearance.codeFontSize}px`);
}

async function downloadTextFile(content: string, filename: string, type: string): Promise<boolean> {
  if (isTauri()) {
    return await invoke<boolean>("cbpanel_save_text_file", { filename, content, contentType: type });
  }

  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}

const rootElement = document.getElementById("root") as (HTMLElement & { __cbpanelRoot?: Root }) | null;
if (!rootElement) throw new Error("CBPanel root element is missing");
const root = rootElement.__cbpanelRoot ?? createRoot(rootElement);
rootElement.__cbpanelRoot = root;
root.render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
