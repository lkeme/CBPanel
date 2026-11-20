import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { type Root, createRoot } from "react-dom/client";
import {
  Check,
  CircleAlert,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { Toaster } from "sonner";
import { AppSidebar } from "./components/app/AppSidebar";
import { AboutMark } from "./components/about/AboutMark";
import { WorkbenchViewIcon } from "./components/app/WorkbenchViewIcon";
import { DesktopTitlebar } from "./components/app/DesktopTitlebar";
import type { BrowserCoreImportDialogState } from "./components/browser-core/BrowserCoreImportDialog";
import { browserCoreOperationActive, isBrowserCoreBusy } from "./components/browser-core/BrowserCoreStatusPanels";
import { DetailsDrawer } from "./components/profiles/ProfileDetails";
import type { ProfileEditorTab } from "./components/profiles/ProfileEditorDrawer";
import { ProfileWorkbenchControls } from "./components/profiles/ProfileWorkbenchControls";
import { ProfilePagination, ProfileTable } from "./components/profiles/ProfileTable";
import { planDraftSync } from "./components/profiles/draftSync";
import {
  nextAvailableProfileName,
  profileNameValidationError,
  proxyNameFromSettings,
  reservedProfileNames,
  sortProfiles,
  workbenchViewBodyKey,
  workbenchViewTitleKey,
} from "./components/profiles/profileWorkbenchHelpers";
import type { ExtensionImportDialogState, TextInputDialogState } from "./components/registry/RegistryDialogs";
import {
  buildModuleStats,
  extensionReferenceEnvironments,
  nameExtensionReferenceEnvironments,
  type ModeFilter,
  type ProxyFilter,
  type StatusFilter,
  type WorkbenchView,
} from "./components/registry/registryStats";
import type { SettingsTab } from "./components/settings/SettingsDrawer";
import type { ConfirmDialogState } from "./components/ui/ConfirmDialog";
import { LoadingSkeleton } from "./components/ui/LoadingSkeleton";
import { TooltipProvider } from "./components/ui/tooltip";
import {
  type BrowserProfile,
  type PanelState,
  type ProfilePreflightAction,
  type ProfilePreflightReport,
  type SessionSummary,
  applyProfileConfigShare,
  buildProxyUrl,
  createProfileConfigShareString,
  defaultProfile,
  nowIso,
  parseProfileConfigShareString,
} from "./shared/profile";
import {
  type BrowserEnvironment,
  type GroupEntity,
  type ProxyEntity,
  type SystemDiagnostics,
  type TagEntity,
  type XrayEngineStatus,
} from "./shared/entities";
import {
  type BinaryInfo,
  binaryPathOverrideFrom,
  shouldRunStartupBrowserCoreUpdateCheck,
} from "./shared/browserCore";
import type { EnvironmentPackageOperation } from "./shared/environmentPackage";
import type { AppBackupOperation } from "./shared/appBackup";
import {
  type AppSettings,
  type AppSettingsPatch,
  type DesktopCloseBehavior,
  type DesktopRuntimeInfo,
  ADVANCED_WEB_ENTRY_CODE,
  DEFAULT_APP_SETTINGS,
  mergeSettings,
  normalizeSettings,
} from "./shared/settings";
import { formatAppTitle, resolveAppVersions } from "./shared/appVersion";
import { shouldRunStartupAppUpdateCheck } from "./shared/appUpdate";
import { openAboutLink, openAppUpdateAsset, openDataDirectory, openSidecarEndpoint } from "./lib/aboutExternalNavigation";
import { api, errorMessage, initializeDesktopBridge, type RuntimeError } from "./lib/apiClient";
import { applyBrowserCoreChange, refreshBrowserCoreState } from "./lib/browserCoreChange";
import { omitKeys, withoutIds } from "./lib/collectionState";
import { workbenchViewFromHash, workbenchViewHash } from "./lib/workbenchNavigation";
import { useBrowserCoreActions } from "./hooks/useBrowserCoreActions";
import { useAppUpdateActions } from "./hooks/useAppUpdateActions";
import { useDiagnosticsActions } from "./hooks/useDiagnosticsActions";
import { useResolvedTheme } from "./hooks/useResolvedTheme";
import { shouldRunStartupXrayUpdateCheck, useXrayActions } from "./hooks/useXrayActions";
import { useExtensionActions, type ExtensionReferenceState } from "./hooks/useExtensionActions";
import {
  type AbortableSingleFlight,
  abortSingleFlight,
  isAbortError,
  launchResponseOutcome,
  type ProfileLaunchRequest,
  type ProfileStopRequest,
  mergeSessionSnapshotByGeneration,
  profileLifecycleActionState,
  reconcileProfileLaunchRequests,
  runAbortableSingleFlight,
  SESSION_STATE_POLL_TIMEOUT_MS,
  shouldPollProfileSessions,
} from "./hooks/profileLaunchState";
import { useProfileLifecycleActions } from "./hooks/useProfileLifecycleActions";
import { useProfileUtilityActions } from "./hooks/useProfileUtilityActions";
import { type ProxySubscriptionEditorState, useProxyActions } from "./hooks/useProxyActions";
import { useRegistryActions } from "./hooks/useRegistryActions";
import { type Locale, type TranslationKey, ensureLocaleReady, isLocaleReady, localeFromMode, translate } from "./i18n";
import "subsetted-fonts/SarasaUiSC-Regular/SarasaUiSC-Regular.css";
import "./styles.css";
import "./workbench.css";

const RegistryModuleView = lazy(() =>
  import("./components/registry/RegistryModuleView").then((module) => ({ default: module.RegistryModuleView })),
);
function cachedModuleLoader<T>(load: () => Promise<T>): () => Promise<T> {
  let promise: Promise<T> | null = null;
  return () => {
    promise ??= load().catch((error) => {
      promise = null;
      throw error;
    });
    return promise;
  };
}
function preloadModule(load: () => Promise<unknown>): void {
  void load().catch(() => undefined);
}
type ProfileEditorDrawerModule = typeof import("./components/profiles/ProfileEditorDrawer");
type SettingsDrawerModule = typeof import("./components/settings/SettingsDrawer");
type ColumnSettingsDrawerModule = typeof import("./components/profiles/ColumnSettingsDrawer");
type ConfirmDialogModule = typeof import("./components/ui/ConfirmDialog");
type RegistryDialogsModule = typeof import("./components/registry/RegistryDialogs");
type BrowserCoreImportDialogModule = typeof import("./components/browser-core/BrowserCoreImportDialog");
type EnvironmentPackageOperationDialogModule = typeof import("./components/profiles/EnvironmentPackageOperationDialog");
type ProfileEditorDrawerComponent = ProfileEditorDrawerModule["ProfileEditorDrawer"];
type SettingsDrawerComponent = SettingsDrawerModule["SettingsDrawer"];
type ColumnSettingsDrawerComponent = ColumnSettingsDrawerModule["ColumnSettingsDrawer"];
type ConfirmDialogComponent = ConfirmDialogModule["ConfirmDialog"];
type BrowserCoreImportDialogComponent = BrowserCoreImportDialogModule["BrowserCoreImportDialog"];
type EnvironmentPackageOperationDialogComponent = EnvironmentPackageOperationDialogModule["EnvironmentPackageOperationDialog"];
const loadProfileEditorDrawer = cachedModuleLoader<ProfileEditorDrawerModule>(() => import("./components/profiles/ProfileEditorDrawer"));
const loadSettingsDrawer = cachedModuleLoader<SettingsDrawerModule>(() => import("./components/settings/SettingsDrawer"));
const loadColumnSettingsDrawer = cachedModuleLoader<ColumnSettingsDrawerModule>(() => import("./components/profiles/ColumnSettingsDrawer"));
const loadConfirmDialog = cachedModuleLoader<ConfirmDialogModule>(() => import("./components/ui/ConfirmDialog"));
const loadRegistryDialogs = cachedModuleLoader<RegistryDialogsModule>(() => import("./components/registry/RegistryDialogs"));
const loadBrowserCoreImportDialog = cachedModuleLoader<BrowserCoreImportDialogModule>(() => import("./components/browser-core/BrowserCoreImportDialog"));
const loadEnvironmentPackageOperationDialog = cachedModuleLoader<EnvironmentPackageOperationDialogModule>(() => import("./components/profiles/EnvironmentPackageOperationDialog"));
preloadModule(loadProfileEditorDrawer);
preloadModule(loadSettingsDrawer);
preloadModule(loadColumnSettingsDrawer);
preloadModule(loadConfirmDialog);
preloadModule(loadRegistryDialogs);
preloadModule(loadBrowserCoreImportDialog);
preloadModule(loadEnvironmentPackageOperationDialog);
let preloadedProfileEditorDrawer: ProfileEditorDrawerComponent | null = null;
let preloadedSettingsDrawer: SettingsDrawerComponent | null = null;
let preloadedColumnSettingsDrawer: ColumnSettingsDrawerComponent | null = null;
let preloadedConfirmDialog: ConfirmDialogComponent | null = null;
let preloadedRegistryDialogs: RegistryDialogsModule | null = null;
let preloadedBrowserCoreImportDialog: BrowserCoreImportDialogComponent | null = null;
let preloadedEnvironmentPackageOperationDialog: EnvironmentPackageOperationDialogComponent | null = null;
void loadProfileEditorDrawer()
  .then((module) => {
    preloadedProfileEditorDrawer = module.ProfileEditorDrawer;
  })
  .catch(() => undefined);
void loadSettingsDrawer()
  .then((module) => {
    preloadedSettingsDrawer = module.SettingsDrawer;
  })
  .catch(() => undefined);
void loadColumnSettingsDrawer()
  .then((module) => {
    preloadedColumnSettingsDrawer = module.ColumnSettingsDrawer;
  })
  .catch(() => undefined);
void loadConfirmDialog()
  .then((module) => {
    preloadedConfirmDialog = module.ConfirmDialog;
  })
  .catch(() => undefined);
void loadRegistryDialogs()
  .then((module) => {
    preloadedRegistryDialogs = module;
  })
  .catch(() => undefined);
void loadBrowserCoreImportDialog()
  .then((module) => {
    preloadedBrowserCoreImportDialog = module.BrowserCoreImportDialog;
  })
  .catch(() => undefined);
void loadEnvironmentPackageOperationDialog()
  .then((module) => {
    preloadedEnvironmentPackageOperationDialog = module.EnvironmentPackageOperationDialog;
  })
  .catch(() => undefined);

function resolveStateAction<T>(nextState: SetStateAction<T>, currentState: T): T {
  return typeof nextState === "function"
    ? (nextState as (state: T) => T)(currentState)
    : nextState;
}

function useDeferredOpenState<T>(
  initialState: T,
  {
    shouldWait,
    ensureReady,
  }: {
    shouldWait: (nextState: T) => boolean;
    ensureReady: (nextState: T) => Promise<unknown>;
  },
): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState(initialState);
  const stateRef = useRef(state);
  const loadSeqRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  function setDeferredState(nextState: SetStateAction<T>) {
    const resolvedState = resolveStateAction(nextState, stateRef.current);
    if (!shouldWait(resolvedState)) {
      loadSeqRef.current += 1;
      stateRef.current = resolvedState;
      setState(resolvedState);
      return;
    }

    const requestId = loadSeqRef.current + 1;
    loadSeqRef.current = requestId;
    void ensureReady(resolvedState)
      .catch(() => undefined)
      .then(() => {
        if (loadSeqRef.current !== requestId) return;
        stateRef.current = resolvedState;
        setState(resolvedState);
      });
  }

  return [state, setDeferredState];
}

// Only en-US ships as a separate chunk, so switching to it has to wait for the
// dictionary. Keep rendering the previous locale until then instead of showing
// zh-CN fallback strings under an en-US locale.
function useReadyLocale(target: Locale): Locale {
  const [readyLocale, setReadyLocale] = useState<Locale>(() => (isLocaleReady(target) ? target : "zh-CN"));

  useEffect(() => {
    if (isLocaleReady(target)) {
      setReadyLocale(target);
      return;
    }
    let disposed = false;
    void ensureLocaleReady(target)
      .then(() => {
        if (!disposed) setReadyLocale(target);
      })
      .catch((error) => console.warn("Locale dictionary load failed", error));
    return () => {
      disposed = true;
    };
  }, [target]);

  return readyLocale;
}

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

function App() {
  const [state, setState] = useState<PanelState | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [draft, setDraft] = useState<BrowserProfile | null>(null);
  const [draftIsNew, setDraftIsNew] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("runtime");
  const [drawerMode, setDrawerMode] = useDeferredOpenState<DrawerMode>(null, {
    shouldWait: (nextState) => nextState === "edit" || nextState === "settings" || nextState === "columns",
    ensureReady: ensureDrawerReady,
  });
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [proxyFilter, setProxyFilter] = useState<ProxyFilter>("all");
  const [modeFilter, setModeFilter] = useState<ModeFilter>("all");
  const [groupFilter, setGroupFilter] = useState("");
  const [tagFilters, setTagFilters] = useState<string[]>([]);
  const [proxyEntityFilter, setProxyEntityFilter] = useState("");
  const [extensionEntityFilter, setExtensionEntityFilter] = useState("");
  const [profilePage, setProfilePage] = useState(1);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [workbenchView, setWorkbenchViewState] = useState<WorkbenchView>(() => workbenchViewFromHash(window.location.hash));
  const [busy, setBusy] = useState("");
  const [pendingLaunchIds, setPendingLaunchIds] = useState<Set<string>>(() => new Set());
  const [pendingStopIds, setPendingStopIds] = useState<Set<string>>(() => new Set());
  const [localProxyDraftIds, setLocalProxyDraftIds] = useState<Set<string>>(() => new Set());
  const [draftProxyLibraryIds, setDraftProxyLibraryIds] = useState<Record<string, string>>({});
  const [confirmDialog, setConfirmDialog] = useDeferredOpenState<ConfirmDialogState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureConfirmDialogReady,
  });
  const [textInputDialog, setTextInputDialog] = useDeferredOpenState<TextInputDialogState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [proxyEditor, setProxyEditor] = useDeferredOpenState<ProxyEditorState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [proxyReference, setProxyReference] = useDeferredOpenState<ProxyReferenceState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [extensionReference, setExtensionReference] = useDeferredOpenState<ExtensionReferenceState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [proxyImport, setProxyImport] = useDeferredOpenState<boolean>(false, {
    shouldWait: (nextState) => nextState,
    ensureReady: ensureRegistryDialogsReady,
  });
  const [proxySubscriptionEditor, setProxySubscriptionEditor] = useDeferredOpenState<ProxySubscriptionEditorState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [registryEditor, setRegistryEditor] = useDeferredOpenState<RegistryEditorState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [registryMerge, setRegistryMerge] = useDeferredOpenState<RegistryMergeState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [extensionImport, setExtensionImport] = useDeferredOpenState<ExtensionImportDialogState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureRegistryDialogsReady,
  });
  const [browserCoreImport, setBrowserCoreImport] = useDeferredOpenState<BrowserCoreImportDialogState>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureBrowserCoreImportDialogReady,
  });
  const [environmentPackageOperation, setEnvironmentPackageOperation] = useDeferredOpenState<EnvironmentPackageOperation | null>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureEnvironmentPackageOperationDialogReady,
  });
  const [appBackupOperation, setAppBackupOperation] = useDeferredOpenState<AppBackupOperation | null>(null, {
    shouldWait: (nextState) => Boolean(nextState),
    ensureReady: ensureEnvironmentPackageOperationDialogReady,
  });
  const [proxyCheck, setProxyCheck] = useState("");
  const [binaryInfo, setBinaryInfo] = useState<BinaryInfo | null>(null);
  const [xrayStatus, setXrayStatus] = useState<XrayEngineStatus | null>(null);
  const [preflight, setPreflight] = useState<ProfilePreflightReport | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runtime, setRuntime] = useState<DesktopRuntimeInfo | null>(null);
  const [runtimeError, setRuntimeError] = useState<RuntimeError | null>(null);
  const [isOnline, setIsOnline] = useState(() => navigator.onLine);
  const [diagnostics, setDiagnostics] = useState<SystemDiagnostics | null>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const pendingLaunchIdsRef = useRef<Set<string>>(new Set());
  const launchRequestsRef = useRef<Map<string, ProfileLaunchRequest>>(new Map());
  const pendingStopIdsRef = useRef<Set<string>>(new Set());
  const stopRequestsRef = useRef<Map<string, ProfileStopRequest>>(new Map());
  const sessionPollInFlightRef = useRef<AbortableSingleFlight>({ controller: null, current: null });
  const confirmedSettingsRef = useRef<AppSettings | null>(null);
  const optimisticSettingsRef = useRef<AppSettings | null>(null);
  const settingsSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const settingsSaveSeqRef = useRef(0);
  const privateConfigurationRefreshSeqRef = useRef(0);
  const startupBrowserCoreCheckDone = useRef(false);
  const startupXrayCheckDone = useRef(false);
  const startupAppUpdateCheckDone = useRef(false);
  const workbenchNavigationSourceRef = useRef<"initial" | "hash" | "state">("initial");
  const previousWorkbenchViewRef = useRef(workbenchView);

  const setWorkbenchView: Dispatch<SetStateAction<WorkbenchView>> = (next) => {
    workbenchNavigationSourceRef.current = "state";
    setWorkbenchViewState(next);
  };

  const settings = state?.settings ?? DEFAULT_APP_SETTINGS;
  const resolvedTheme = useResolvedTheme(settings.appearance.theme);
  const locale = useReadyLocale(localeFromMode(settings.appearance.language, navigator.language));
  const t = (key: TranslationKey, params?: Record<string, string | number>) => translate(locale, key, params);

  useEffect(() => {
    void bootstrap();
  }, []);

  useEffect(() => {
    const updateOnlineStatus = () => setIsOnline(navigator.onLine);
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    // The desktop window is created hidden so the native side can apply the
    // restored geometry without a visible resize. Reveal it as soon as this
    // component has mounted; a hidden window throttles its rendering loop, so
    // waiting for a frame is not reliable until it is visible. The native side
    // also has a watchdog, so a failed invoke only costs the optimization.
    if (!isTauri()) return;
    void invoke("cbpanel_window_ready").catch((error) =>
      console.warn("Tauri window ready command failed", error),
    );
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      workbenchNavigationSourceRef.current = "hash";
      const nextView = workbenchViewFromHash(window.location.hash);
      const nextHash = workbenchViewHash(nextView);
      if (window.location.hash !== nextHash) window.history.replaceState(null, "", nextHash);
      setDrawerMode(null);
      setWorkbenchViewState(nextView);
    };
    window.addEventListener("hashchange", onHashChange);
    window.addEventListener("popstate", onHashChange);
    return () => {
      window.removeEventListener("hashchange", onHashChange);
      window.removeEventListener("popstate", onHashChange);
    };
  }, []);

  useEffect(() => {
    const nextHash = workbenchViewHash(workbenchView);
    const source = workbenchNavigationSourceRef.current;
    workbenchNavigationSourceRef.current = "state";
    if (window.location.hash === nextHash) return;
    if (source === "initial" || source === "hash") {
      window.history.replaceState(null, "", nextHash);
      return;
    }
    window.history.pushState(null, "", nextHash);
  }, [workbenchView]);

  useEffect(() => {
    if (previousWorkbenchViewRef.current === workbenchView) return;
    previousWorkbenchViewRef.current = workbenchView;
    setDrawerMode(null);
  }, [setDrawerMode, workbenchView]);

  useEffect(() => () => {
    for (const request of launchRequestsRef.current.values()) request.controller.abort();
    launchRequestsRef.current.clear();
    for (const request of stopRequestsRef.current.values()) request.controller.abort();
    stopRequestsRef.current.clear();
    abortSingleFlight(sessionPollInFlightRef.current);
  }, []);

  useEffect(() => {
    applyAppearance(settings, resolvedTheme, locale);
    if (!optimisticSettingsRef.current) {
      confirmedSettingsRef.current = normalizeSettings(settings);
    }
  }, [locale, resolvedTheme, settings]);

  useEffect(() => {
    if (startupBrowserCoreCheckDone.current || !state || !binaryInfo) return;
    const coreSettings = settings.binary;
    if (coreSettings.coreChannel === "private" || coreSettings.coreChannelMode === "offline") return;
    if (binaryInfo.licenseRequired || binaryInfo.licenseValid === false || binaryPathOverrideFrom(binaryInfo.core?.env ?? [])) return;
    if (!shouldRunStartupBrowserCoreUpdateCheck(settings.binary.lastUpdateCheck)) return;
    startupBrowserCoreCheckDone.current = true;
    void checkBrowserCoreUpdate({ silent: true });
  }, [binaryInfo, settings, state]);

  useEffect(() => {
    if (startupXrayCheckDone.current || !state || !xrayStatus?.installed) return;
    const xraySettings = normalizeSettings(settings).xray;
    if (!xraySettings.checkForUpdatesOnStartup) return;
    if (!shouldRunStartupXrayUpdateCheck(xrayStatus.lastUpdateCheck ?? xraySettings.lastUpdateCheck)) return;
    startupXrayCheckDone.current = true;
    void checkXrayUpdate({ silent: true });
  }, [settings, state, xrayStatus]);

  useEffect(() => {
    if (startupAppUpdateCheckDone.current || !state) return;
    if (!shouldRunStartupAppUpdateCheck(normalizeSettings(settings).appUpdate.lastUpdateCheck)) return;
    startupAppUpdateCheckDone.current = true;
    void checkAppUpdate({ silent: true });
  }, [settings, state]);

  // The editor and the settings drawer both show the engine's state; re-read it when they open so an
  // install done elsewhere (another window, the desktop shell) is reflected without a reload.
  useEffect(() => {
    if (drawerMode === "edit" || drawerMode === "settings") void loadXrayStatus();
  }, [drawerMode]);

  // An install runs on the server and only reports through this status, so the drawer polls it while
  // the operation is in flight — the same way the browser-core panel polls its own operation. Byte
  // counts arrive as they are read, which is what the progress bar below the status line shows.
  useEffect(() => {
    if (!xrayStatus?.operation && busy !== "xray-install" && busy !== "xray-check-update") return;
    const interval = window.setInterval(() => void loadXrayStatus(), 800);
    return () => window.clearInterval(interval);
  }, [xrayStatus?.operation?.type, busy]);

  // The About tab has no refresh control, so opening it reads the diagnostics again: a page that
  // reports the data directory and OS build must not answer from the app-start snapshot.
  useEffect(() => {
    if (drawerMode !== "settings" || settingsInitialTab !== "about") return;
    void loadDiagnostics();
  }, [drawerMode, settingsInitialTab]);

  // Opening the tab is the second chance to notice a release; the TTL keeps it from being a second
  // request on a machine that already checked this morning.
  useEffect(() => {
    if (drawerMode !== "settings" || settingsInitialTab !== "about") return;
    if (!shouldRunStartupAppUpdateCheck(normalizeSettings(settings).appUpdate.lastUpdateCheck)) return;
    void checkAppUpdate({ silent: true });
  }, [drawerMode, settingsInitialTab]);

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

  // `draft` stays out of the deps on purpose: this only has to react to a selection change or a store
  // refresh, and the effect writes `draft` itself. The current draft is still read here, because an
  // effect always runs with the values of the render that committed it.
  useEffect(() => {
    const plan = planDraftSync({ draft, draftIsNew, profiles: state?.profiles, selectedId });
    if (plan.action === "skip") return;
    if (plan.action === "clear") {
      setDraft(null);
      return;
    }
    if (plan.selectedId !== selectedId) setSelectedId(plan.selectedId);
    if (plan.action === "adopt") setDraft(structuredClone(plan.profile));
    setPreflight((current) => (current?.profileId === plan.selectedId ? current : null));
  }, [draftIsNew, state, selectedId]);

  const sessionsByProfileId = useMemo(
    () => new Map((state?.sessions ?? []).map((session) => [session.profileId, session])),
    [state?.sessions],
  );

  const selectedSession = sessionsByProfileId.get(selectedId);
  const activeFilterCount =
    (statusFilter === "running" ? 1 : 0) +    (proxyFilter !== "all" ? 1 : 0) +
    (modeFilter !== "all" ? 1 : 0) +
    (groupFilter ? 1 : 0) +
    (proxyEntityFilter ? 1 : 0) +
    (extensionEntityFilter ? 1 : 0) +
    tagFilters.length;
  const environmentsById = useMemo(
    () => new Map((state?.environments ?? []).map((environment) => [environment.id, environment])),
    [state?.environments],
  );
  /**
   * Trashed environments keep their binding rows but are invisible in the UI, so they must not be
   * counted here: the backend's delete guard already ignores them, and listing one would name an
   * environment the operator cannot find or unbind.
   */
  const extensionReferenceEnvironmentIds = useCallback(
    (extensionId: string) => extensionReferenceEnvironments(state?.environments ?? [], extensionId)
      .map((reference) => reference.id),
    [state?.environments],
  );
  /** Names for the reference dialog; an environment that vanished from state keeps its ID visible. */
  const extensionReferenceEnvironmentEntries = useMemo(
    () => nameExtensionReferenceEnvironments(
      extensionReference ? extensionReferenceEnvironmentIds(extensionReference.extension.id).map((id) => ({ id })) : [],
      state?.profiles,
    ),
    [extensionReference, extensionReferenceEnvironmentIds, state?.profiles],
  );
  const allTags = useMemo(() => {
    const tags = new Set<string>();
    for (const profile of state?.profiles ?? []) {
      for (const tag of profile.tags) tags.add(tag);
    }
    return [...tags].sort((left, right) => left.localeCompare(right));
  }, [state?.profiles]);
  const shouldPollSessions = useMemo(
    () => shouldPollProfileSessions(state?.sessions ?? [], pendingLaunchIds.size, pendingStopIds.size),
    [pendingLaunchIds, pendingStopIds, state?.sessions],
  );
  const moduleStats = useMemo(() => buildModuleStats(state, sessionsByProfileId, locale), [locale, sessionsByProfileId, state]);
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
      if (extensionEntityFilter && !environmentsById.get(profile.id)?.extensionIds.includes(extensionEntityFilter)) return false;
      if (modeFilter !== "all" && profile.mode !== modeFilter) return false;
      if (groupFilter && profile.group !== groupFilter) return false;
      if (tagFilters.length > 0 && !tagFilters.every((tag) => profile.tags.includes(tag))) return false;
      if (!needle) return true;
      return [profile.name, profile.group, profile.notes, profile.startUrl, ...profile.tags].some((value) =>
        value.toLowerCase().includes(needle),
      );
    });
    return sortProfiles(filtered, settings);
  }, [environmentsById, extensionEntityFilter, groupFilter, modeFilter, proxyEntityFilter, proxyFilter, query, sessionsByProfileId, settings, state?.profiles, statusFilter, tagFilters]);

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
    () => (draft ? profileNameValidationError(draft, state?.profiles ?? [], draftIsNew, t, state?.trash ?? []) : ""),
    [draft, draftIsNew, locale, state?.profiles, state?.trash],
  );

  useEffect(() => {
    if (!shouldPollSessions) return;
    let disposed = false;
    const poll = () => {
      if (disposed) return;
      void runAbortableSingleFlight(
        sessionPollInFlightRef.current,
        SESSION_STATE_POLL_TIMEOUT_MS,
        (signal) => loadState(signal),
        (error) => {
          if (!isAbortError(error)) console.warn("Session state polling failed", error);
        },
      );
    };
    poll();
    const interval = window.setInterval(() => {
      poll();
    }, 1800);
    return () => {
      disposed = true;
      window.clearInterval(interval);
      abortSingleFlight(sessionPollInFlightRef.current);
    };
  }, [locale, shouldPollSessions]);

  useEffect(() => {
    if (!browserCoreOperationActive(binaryInfo?.core?.operation) && !isBrowserCoreBusy(busy)) return;
    const interval = window.setInterval(() => {
      void loadBinaryInfo(false);
    }, 1200);
    return () => window.clearInterval(interval);
  }, [binaryInfo?.core?.operation?.id, binaryInfo?.core?.operation?.status, busy]);

  useEffect(() => {
    if (binaryInfo?.core?.licensePolicy === "not-applicable" || binaryInfo?.core?.channelMode === "offline") return;
    if (!binaryInfo?.core?.license.active || binaryInfo.core.license.checkedAt) return;
    // Validation can outlive the settings request. Poll until its first verdict,
    // including an unavailable-server verdict, rather than leaving "validating" stuck.
    const interval = window.setInterval(() => void loadBinaryInfo(false), 1500);
    return () => window.clearInterval(interval);
  }, [binaryInfo?.core?.license.active, binaryInfo?.core?.license.checkedAt, binaryInfo?.core?.licensePolicy, binaryInfo?.core?.channelMode]);

  const runtimeIsCustomDesktop = runtime?.shell === "desktop" && runtime.platform === "windows" && runtime.chrome === "custom";
  // The bridge answers before the sidecar, and a packaged sidecar may predate this field, so each
  // version falls back to the binary info the panel already polls.
  const coreVersions = binaryInfo?.core?.versions;
  const runtimeVersions = resolveAppVersions(runtime?.versions, {
    wrapper: coreVersions?.wrapperVersion,
    app: coreVersions?.cbpanelVersion,
  });
  const runtimeVersionLabel = formatAppTitle(runtimeVersions);
  useEffect(() => {
    if (!runtimeVersionLabel) return;
    document.title = runtimeVersionLabel;
  }, [runtimeVersionLabel]);
  useEffect(() => {
    if (!isTauri() || !runtimeIsCustomDesktop || !runtimeVersionLabel) return;
    void invoke("cbpanel_window_set_title", { title: runtimeVersionLabel })
      .catch((error) => console.warn("Tauri window title command failed", error));
  }, [runtimeIsCustomDesktop, runtimeVersionLabel]);
  const browserCoreMissing = binaryInfo ? !binaryInfo.installed : false;
  const totalProfiles = state?.meta.profileCount ?? state?.profiles.length ?? 0;
  const inspectorOpen = drawerMode === "details";
  const normalizedSettings = normalizeSettings(settings);
  const sidebarCollapsed = normalizedSettings.desktop.sidebarMode === "collapsed";
  const draftSession = draft ? sessionsByProfileId.get(draft.id) : undefined;
  const draftActionState = profileLifecycleActionState(
    draftSession,
    Boolean(draft && pendingLaunchIds.has(draft.id)),
    Boolean(draft && pendingStopIds.has(draft.id)),
  );
  const pageSize = normalizedSettings.table.pageSize;
  const totalPages = Math.max(1, Math.ceil(filteredProfiles.length / pageSize));
  const currentPage = Math.min(profilePage, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const pagedProfiles = filteredProfiles.slice(pageStart, pageStart + pageSize);
  const allPageSelected = pagedProfiles.length > 0 && pagedProfiles.every((profile) => selectedIds.has(profile.id));
  const pageEnd = filteredProfiles.length === 0 ? 0 : Math.min(filteredProfiles.length, pageStart + pagedProfiles.length);
  const ProfileEditorDrawerRenderer = preloadedProfileEditorDrawer;
  const SettingsDrawerRenderer = preloadedSettingsDrawer;
  const ColumnSettingsDrawerRenderer = preloadedColumnSettingsDrawer;
  const ConfirmDialogRenderer = preloadedConfirmDialog;
  const RegistryDialogsRenderer = preloadedRegistryDialogs;
  const BrowserCoreImportDialogRenderer = preloadedBrowserCoreImportDialog;
  const EnvironmentPackageOperationDialogRenderer = preloadedEnvironmentPackageOperationDialog;
  const ProxyEditorDialogRenderer = RegistryDialogsRenderer?.ProxyEditorDialog;
  const RegistryEntityDialogRenderer = RegistryDialogsRenderer?.RegistryEntityDialog;
  const RegistryMergeDialogRenderer = RegistryDialogsRenderer?.RegistryMergeDialog;
  const ExtensionImportDialogRenderer = RegistryDialogsRenderer?.ExtensionImportDialog;
  const ProxyReferenceDialogRenderer = RegistryDialogsRenderer?.ProxyReferenceDialog;
  const ExtensionReferenceDialogRenderer = RegistryDialogsRenderer?.ExtensionReferenceDialog;
  const ProxyAddDialogRenderer = RegistryDialogsRenderer?.ProxyAddDialog;
  const ProxySubscriptionDialogRenderer = RegistryDialogsRenderer?.ProxySubscriptionDialog;
  const TextInputDialogRenderer = RegistryDialogsRenderer?.TextInputDialog;

  useEffect(() => {
    setProfilePage(1);
  }, [extensionEntityFilter, groupFilter, modeFilter, proxyEntityFilter, proxyFilter, query, statusFilter, tagFilters.join("\u0000")]);

  useEffect(() => {
    // The inspector can be opened before the initial state request settles. Once rows arrive, honor that
    // explicit request by selecting the first currently visible row instead of leaving an empty drawer.
    if (workbenchView !== "profiles" || drawerMode !== "details" || selectedId || pagedProfiles.length === 0) return;
    setSelectedId(pagedProfiles[0].id);
  }, [drawerMode, pagedProfiles, selectedId, workbenchView]);

  useEffect(() => {
    if (profilePage > totalPages) setProfilePage(totalPages);
  }, [profilePage, totalPages]);

  async function bootstrap() {
    setRuntimeError(null);
    try {
      const bridgeError = await initializeDesktopBridge(t, setRuntime);
      setRuntimeError(bridgeError);
      if (bridgeError) return;
      await Promise.all([loadState(), loadBinaryInfo(false), loadRuntimeInfo(), loadDiagnostics(), loadXrayStatus()]);
    } catch (error) {
      if (isAbortError(error)) return;
      setRuntimeError({
        title: t("error.workspaceLoadFailed"),
        detail: t("error.workspaceLoadFailedDetail", { message: errorMessage(error) }),
      });
    }
  }

  async function loadState(signal?: AbortSignal): Promise<PanelState> {
    const next = await api<PanelState>("/api/state", { signal });
    if (signal?.aborted) {
      throw signal.reason ?? new DOMException("Session state request was aborted", "AbortError");
    }
    const settledLaunches = reconcileProfileLaunchRequests(launchRequestsRef.current, next.sessions);
    for (const { profileId, session } of settledLaunches) {
      markLaunchPending(profileId, false);
      reportSettledLaunch(session);
    }
    const optimisticSettings = optimisticSettingsRef.current;
    if (!optimisticSettings) {
      confirmedSettingsRef.current = normalizeSettings(next.settings);
    }
    setState((current) => {
      const resolved = optimisticSettings ? { ...next, settings: optimisticSettings } : next;
      return current
        ? { ...resolved, sessions: mergeSessionSnapshotByGeneration(current.sessions, resolved.sessions) }
        : resolved;
    });
    return next;
  }

  function markLaunchPending(id: string, pending: boolean) {
    const next = new Set(pendingLaunchIdsRef.current);
    if (pending) next.add(id);
    else next.delete(id);
    pendingLaunchIdsRef.current = next;
    setPendingLaunchIds(next);
  }

  function markStopPending(id: string, pending: boolean) {
    const next = new Set(pendingStopIdsRef.current);
    if (pending) next.add(id);
    else next.delete(id);
    pendingStopIdsRef.current = next;
    setPendingStopIds(next);
  }

  function reportSettledLaunch(session: SessionSummary) {
    const outcome = launchResponseOutcome(session);
    if (outcome.kind === "pending") return;
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
    setSelectedId(session.profileId);
    setDrawerMode("details");
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

  async function ensureProfileEditorDrawerReady(): Promise<ProfileEditorDrawerComponent> {
    if (preloadedProfileEditorDrawer) return preloadedProfileEditorDrawer;
    const component = (await loadProfileEditorDrawer()).ProfileEditorDrawer;
    preloadedProfileEditorDrawer = component;
    return component;
  }

  async function ensureSettingsDrawerReady(): Promise<SettingsDrawerComponent> {
    if (preloadedSettingsDrawer) return preloadedSettingsDrawer;
    const component = (await loadSettingsDrawer()).SettingsDrawer;
    preloadedSettingsDrawer = component;
    return component;
  }

  async function ensureColumnSettingsDrawerReady(): Promise<ColumnSettingsDrawerComponent> {
    if (preloadedColumnSettingsDrawer) return preloadedColumnSettingsDrawer;
    const component = (await loadColumnSettingsDrawer()).ColumnSettingsDrawer;
    preloadedColumnSettingsDrawer = component;
    return component;
  }

  async function ensureDrawerReady(nextState: DrawerMode): Promise<void> {
    if (nextState === "edit") {
      await ensureProfileEditorDrawerReady();
      return;
    }
    if (nextState === "settings") {
      await ensureSettingsDrawerReady();
      return;
    }
    if (nextState === "columns") {
      await ensureColumnSettingsDrawerReady();
    }
  }

  async function ensureConfirmDialogReady(): Promise<ConfirmDialogComponent> {
    if (preloadedConfirmDialog) return preloadedConfirmDialog;
    const component = (await loadConfirmDialog()).ConfirmDialog;
    preloadedConfirmDialog = component;
    return component;
  }

  async function ensureRegistryDialogsReady(): Promise<RegistryDialogsModule> {
    if (preloadedRegistryDialogs) return preloadedRegistryDialogs;
    const module = await loadRegistryDialogs();
    preloadedRegistryDialogs = module;
    return module;
  }

  async function ensureBrowserCoreImportDialogReady(): Promise<BrowserCoreImportDialogComponent> {
    if (preloadedBrowserCoreImportDialog) return preloadedBrowserCoreImportDialog;
    const component = (await loadBrowserCoreImportDialog()).BrowserCoreImportDialog;
    preloadedBrowserCoreImportDialog = component;
    return component;
  }

  async function ensureEnvironmentPackageOperationDialogReady(): Promise<EnvironmentPackageOperationDialogComponent> {
    if (preloadedEnvironmentPackageOperationDialog) return preloadedEnvironmentPackageOperationDialog;
    const component = (await loadEnvironmentPackageOperationDialog()).EnvironmentPackageOperationDialog;
    preloadedEnvironmentPackageOperationDialog = component;
    return component;
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
    const selected = state?.profiles.find((profile) => profile.id === selectedId)
      ?? (selectedId ? state?.profiles[0] : undefined)
      ?? null;
    setDraft(selected ? structuredClone(selected) : null);
  }

  const {
    checkPreflight,
    checkProxy,
    deleteProfile: deleteProfileAction,
    duplicateProfile,
    launchProfile,
    resolveProxyGeoip,
    saveDraft,
    showBrowserCoreMissing,
    stopProfile,
  } = useProfileLifecycleActions({
    browserCoreMissing,
    draft,
    draftIsNew,
    draftProxyLibraryIds,
    launchRequestsRef,
    loadState,
    localProxyDraftIds,
    markLaunchPending,
    markStopPending,
    reportSettledLaunch,
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
    stopRequestsRef,
    t,
    locale,
    toast,
  });

  async function deleteProfile() {
    await deleteProfileAction(closeDrawer);
  }

  /**
   * Rotates a saved persistent profile's identity by deleting the seed file the wrapper wrote. The
   * draft is not saved first on purpose: the seed lives in the user data dir, not in the profile, so
   * unsaved editor changes are irrelevant to the action.
   */
  async function rotateIdentity() {
    if (!draft || draftIsNew) return;
    setConfirmDialog({
      title: t("confirm.rotateIdentityTitle"),
      body: t("confirm.rotateIdentityBody"),
      confirmLabel: t("confirm.rotateIdentityConfirm"),
      tone: "warning",
      busyKey: "rotate-identity",
      onConfirm: async () => {
        setBusy("rotate-identity");
        try {
          await api(`/api/environments/${draft.id}/rotate-identity`, { method: "POST" });
          toast("success", t("toast.identityRotated"));
          setConfirmDialog(null);
        } catch (error) {
          toast("error", t("error.identityRotateFailed", { message: errorMessage(error) }));
        } finally {
          setBusy("");
        }
      },
    });
  }

  async function saveSettings(patch: AppSettingsPatch, options: { throwOnError?: boolean } = {}) {
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
        if (patch.binary !== undefined) {
          if (patch.binary.licenseKey !== undefined) await loadBinaryInfo(false);
          else void loadBinaryInfo(false);
        }
      }
    } catch (error) {
      if (saveSeq === settingsSaveSeqRef.current) {
        optimisticSettingsRef.current = null;
        const confirmedSettings = confirmedSettingsRef.current ?? baseSettings;
        setState((current) => (current ? { ...current, settings: confirmedSettings } : current));
        toast("error", (error as Error).message);
      }
      if (options.throwOnError) throw error;
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

  function toggleSidebarMode() {
    const sidebarMode = sidebarCollapsed ? "expanded" : "collapsed";
    void saveSettings({ desktop: { ...normalizedSettings.desktop, sidebarMode } });
  }

  function createProfile() {
    // The trash counts as taken: it keeps the profiles row of a soft-deleted environment, so reusing the
    // bare default name looked free in the table and came back as a 409 the moment the draft was saved.
    const name = nextAvailableProfileName(
      t("form.defaultProfileName"),
      reservedProfileNames(state?.profiles ?? [], state?.trash ?? []),
    );
    const profile = defaultProfile({ name });
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
          shareLink: draft.proxy.shareLink,
          preProxyId: draft.proxy.preProxyId,
          ipStrategy: draft.proxy.ipStrategy,
          utlsFingerprint: draft.proxy.utlsFingerprint,
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
    cancelBrowserCoreOperation,
    checkBrowserCoreUpdate,
    checkGithubMirrors,
    clearBinaryCache,
    installBinary,
    installBrowserCoreImport,
    installPrivateVersion,
    activateCoreChannel,
    clearPrivateToken,
    loadPrivateReleases,
    testPrivateRepository,
    updateBinary,
  } = useBrowserCoreActions({
    binaryInfo,
    checkPreflight,
    draft,
    preflight,
    setBinaryInfo,
    setBrowserCoreImport,
    setBusy,
    setConfirmDialog,
    t,
    toast,
    onPrivateConfigurationChanged: (configuration) => {
      const refreshSequence = ++privateConfigurationRefreshSeqRef.current;
      // The server response confirms these fields even if the following state reads are unavailable.
      const repositoryUrl = configuration.repositoryUrl;
      if (repositoryUrl !== undefined) {
        const patch = { binary: { privateRepositoryUrl: repositoryUrl } };
        if (confirmedSettingsRef.current) confirmedSettingsRef.current = mergeSettings(confirmedSettingsRef.current, patch);
        if (optimisticSettingsRef.current) optimisticSettingsRef.current = mergeSettings(optimisticSettingsRef.current, patch);
        setState((current) => current ? { ...current, settings: mergeSettings(current.settings, patch) } : current);
      }
      setBinaryInfo((current) => current?.core
        ? { ...current, core: { ...current.core, privateTokenConfigured: configuration.configured } }
        : current);
      return refreshBrowserCoreState({
        refresh: [async (signal) => {
          const info = await api<BinaryInfo>("/api/binary", { signal });
          if (!signal.aborted && refreshSequence === privateConfigurationRefreshSeqRef.current) setBinaryInfo(info);
        }],
        notifyRefreshFailure: () => {
          if (refreshSequence === privateConfigurationRefreshSeqRef.current) toast("info", t("browserCore.privateConfigurationRefreshFailed"));
        },
      });
    },
    onCoreChanged: (info, options) => {
      privateConfigurationRefreshSeqRef.current += 1;
      return applyBrowserCoreChange({
        previousInfo: binaryInfo,
        info,
        restartRequested: options?.restart,
        desktop: isTauri(),
        applyInfo: setBinaryInfo,
        refresh: [(signal) => loadState(signal), loadRuntimeInfo, loadDiagnostics],
        restartRuntime: () => invoke("cbpanel_app_restart"),
        notifyWebRestart: () => toast("info", t("browserCore.webRestartRequired")),
        notifyRefreshFailure: () => toast("info", t("browserCore.changedRefreshFailed")),
        notifyRestartFailure: () => toast("error", t("browserCore.changedRestartFailed")),
      });
    },
  });
  const { cancelXrayOperation, checkXrayUpdate, installXray, loadXrayStatus } = useXrayActions({
    setBusy,
    setXrayStatus,
    t,
    toast,
  });
  const { checkAppUpdate } = useAppUpdateActions({
    setState,
    setBusy,
    t,
    toast,
  });

  // An install changes what the last preflight said about the engine. Refresh the report for the open
  // draft and the diagnostics page, so the panel stops pointing at an install that already happened.
  async function installXrayEngine(): Promise<boolean> {
    const installed = await installXray();
    if (installed) {
      void loadDiagnostics();
      if (draft && preflight?.profileId === draft.id) await checkPreflight();
    }
    return installed;
  }
  const {
    copyDiagnostics,
    exportDiagnostics,
    loadDiagnostics,
  } = useDiagnosticsActions({
    diagnostics,
    downloadTextFile,
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
    pruneBrowserData,
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
    batchCheckProxies,
    checkManagedProxy,
    deleteProxyNow,
    duplicateProxy,
    importProxyLinks,
    openProxyEditor,
    openProxySubscriptionEditor,
    proxyReferenceCount,
    refreshAllProxySubscriptions,
    refreshProxySubscription,
    requestBatchProxyDelete,
    requestProxySubscriptionDelete,
    replaceProxyReferences,
    replaceProxyReferencesAndDelete,
    requestProxyDelete,
    saveProxyDraft,
    saveProxySubscription,
    unbindProxyReferences,
    unbindProxyReferencesAndDelete,
    updateProxy,
    updateProxySubscription,
  } = useProxyActions({
    loadState,
    setBusy,
    setConfirmDialog,
    setProxyEditor,
    setProxyReference,
    setProxySubscriptionEditor,
    state,
    t,
    toast,
  });
  const {
    checkExtension,
    checkExtensionUpdate,
    deleteExtension,
    importExtensionArchivePath,
    importExtensionDirectoryPaths,
    importExtensionDirectoryPath,
    installExtension,
    migrateExtensionIdentity,
    previewExtensionDirectoryPath,
    reinstallExtension,
    runExtensionAutoChecks,
    setDraftExtensionBinding,
    setExtensionUpdatePolicy,
    toggleExtensionStatus,
    unbindAndDeleteExtension,
    unbindExtensionReferences,
    updateExtension,
    uploadExtensionArchive,
  } = useExtensionActions({
    draft,
    draftIsNew,
    loadState,
    referenceEnvironmentIds: extensionReferenceEnvironmentIds,
    selectedProfiles,
    setBusy,
    setConfirmDialog,
    setExtensionImport,
    setExtensionReference,
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
    setQuery("");
    setStatusFilter("all");
    setProxyFilter("all");
    setProxyEntityFilter("");
    setExtensionEntityFilter("");
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
    patch: { group?: string; query?: string; status?: StatusFilter; proxy?: ProxyFilter; proxyId?: string; extensionId?: string; mode?: ModeFilter; tags?: string[] } = {},
  ) {
    setWorkbenchView("profiles");
    setFilterPanelOpen(false);
    setGroupFilter(patch.group ?? "");
    setQuery(patch.query ?? "");
    setStatusFilter(patch.status ?? "all");
    setProxyFilter(patch.proxy ?? "all");
    setProxyEntityFilter(patch.proxyId ?? "");
    setExtensionEntityFilter(patch.extensionId ?? "");
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
      if (profileLifecycleActionState(
        session,
        pendingLaunchIds.has(profile.id),
        pendingStopIds.has(profile.id),
      ).canStop) continue;
      await launchProfile(profile.id);
    }
  }

  async function stopSelectedProfiles() {
    for (const profile of selectedProfiles) {
      const session = sessionsByProfileId.get(profile.id);
      if (profileLifecycleActionState(
        session,
        pendingLaunchIds.has(profile.id),
        pendingStopIds.has(profile.id),
      ).canStop) {
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
    locale,
    selectedProfiles,
    sessionsByProfileId,
    setBusy,
    state,
    setConfirmDialog,
    setSelectedIds,
    setState,
    setEnvironmentPackageOperation,
    setTextInputDialog,
    t,
    toast,
  });

  async function runPreflightAction(action: ProfilePreflightAction) {
    if (action.kind === "open-browser-core-settings") {
      openSettings("browserCore");
      return;
    }
    if (action.kind === "install-binary") {
      await installBinary();
      return;
    }
    if (action.kind === "install-xray") {
      await installXrayEngine();
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

  function toggleInspector() {
    if (inspectorOpen) {
      setDrawerMode(null);
      return;
    }
    if (!selectedId) {
      const firstVisibleProfile = pagedProfiles[0];
      if (firstVisibleProfile) setSelectedId(firstVisibleProfile.id);
    }
    setDrawerMode("details");
  }

  function openSettings(tab: SettingsTab = "general") {
    setSettingsInitialTab(tab);
    setDrawerMode("settings");
  }

  async function saveDesktopCloseBehavior(closeBehavior: DesktopCloseBehavior, options: { wait?: boolean } = {}) {
    if (normalizedSettings.desktop.closeBehavior === closeBehavior) return;
    const nextDesktop = { ...normalizedSettings.desktop, closeBehavior };
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
    if (!shouldPollSessions) return false;
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

  const workbenchViewBody = workbenchViewBodyKey(workbenchView, browserCoreMissing);

  return (
    <TooltipProvider delayDuration={180}>
      <main
        className={`app-shell ${runtimeIsCustomDesktop ? "desktop-custom-chrome" : ""} ${
          sidebarCollapsed ? "sidebar-collapsed" : ""
        }`}
      >
        {runtimeIsCustomDesktop && <DesktopTitlebar closeWindow={closeDesktopWindow} t={t} versions={runtimeVersions} />}

        <AppSidebar
          browserCoreMissing={browserCoreMissing}
          busy={busy}
          createProfile={createProfile}
          moduleStats={moduleStats}
          openAbout={() => openSettings("about")}
          openSettings={() => openSettings(
            normalizedSettings.appUpdate.lastUpdateCheck?.updateAvailable ? "about" : "general",
          )}
          renderMark={(className) => <AboutMark className={className} />}
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
          updateAvailable={Boolean(normalizedSettings.appUpdate.lastUpdateCheck?.updateAvailable)}
          updateVersion={normalizedSettings.appUpdate.lastUpdateCheck?.latestVersion}
          versions={runtimeIsCustomDesktop ? undefined : runtimeVersions}
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
                <span className="workspace-title-icon" aria-hidden="true">
                  <WorkbenchViewIcon size={18} view={workbenchView} />
                </span>
                <h1>{t(workbenchViewTitleKey(workbenchView))}</h1>
                {workbenchViewBody && <p>{t(workbenchViewBody)}</p>}
              </div>
            </header>

            {!isOnline && (
              <div className="offline-banner" role="status">
                <WifiOff size={17} aria-hidden="true" />
                <span>{t("workspace.offlineBody")}</span>
                <strong>{t("workspace.offlineShort")}</strong>
              </div>
            )}

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
                toggleInspector={toggleInspector}
                toggleTagFilter={toggleTagFilter}
                t={t}
              />
            )}

            <div className="main-grid">
              <div key={workbenchView} className="workbench-content motion-content-enter">
                {workbenchView === "profiles" ? (
                  <section className="table-surface">
                    {!state ? (
                      <div className="profile-table-loading" role="status" aria-label={t("status.loading")}>
                        <LoadingSkeleton rows={6} />
                      </div>
                    ) : (
                    <>
                    <ProfileTable
                      allPageSelected={allPageSelected}
                      columns={visibleColumns}
                      environments={state?.environments ?? []}
                      groups={state?.groups ?? []}
                      profiles={pagedProfiles}
                      proxies={state?.proxies ?? []}
                      tags={state?.tags ?? []}
                      pendingLaunchIds={pendingLaunchIds}
                      pendingStopIds={pendingStopIds}
                      selectedId={selectedId}
                      selectedIds={selectedIds}
                      sessionsByProfileId={sessionsByProfileId}
                      t={t}
                      locale={locale}
                      tagFilters={tagFilters}
                      toggleCurrentPageSelected={toggleCurrentPageSelected}
                      toggleSelected={toggleSelected}
                      toggleTagFilter={toggleTagFilter}
                      selectProfile={selectProfile}
                      launchProfile={launchProfile}
                      browserCoreMissing={browserCoreMissing}
                      stopProfile={stopProfile}
                      createProfile={createProfile}
                      hasActiveFilters={activeFilterCount > 0 || Boolean(query.trim())}
                      resetFilters={resetFilters}
                      totalProfiles={totalProfiles}
                    />
                    {filteredProfiles.length > 0 && (
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
                    />
                    )}
                    </>
                    )}
                  </section>
                ) : (
                  <Suspense fallback={<LoadingSkeleton rows={4} />}>
                    <RegistryModuleView
                      busy={busy}
                      binaryInfo={binaryInfo}
                      browserCoreMissing={browserCoreMissing}
                      stats={moduleStats}
                      state={state}
                      t={t}
                      locale={locale}
                      toast={toast}
                      trash={state?.trash ?? []}
                      view={workbenchView}
                      openBrowserCoreSettings={() => openSettings("browserCore")}
                      batchCheckProxies={batchCheckProxies}
                      requestBatchProxyDelete={requestBatchProxyDelete}
                      checkManagedProxy={checkManagedProxy}
                      clearTrashEnvironments={clearTrashEnvironments}
                      deleteExtension={deleteExtension}
                      duplicateProxy={duplicateProxy}
                      editGroup={(group) => setRegistryEditor({ kind: "group", mode: "edit", entity: group })}
                      editProxy={(proxy) => openProxyEditor("edit", proxy)}
                      editProxySubscription={(subscription) => openProxySubscriptionEditor("edit", subscription)}
                      editTag={(tag) => setRegistryEditor({ kind: "tag", mode: "edit", entity: tag })}
                      checkExtension={checkExtension}
                      checkExtensionUpdate={checkExtensionUpdate}
                      showProfiles={showProfileView}
                      importExtensionArchive={(kind) => setExtensionImport({ kind })}
                      importExtensionDirectory={() => setExtensionImport({ kind: "directory" })}
                      addProxy={() => setProxyImport(true)}
                      installExtension={installExtension}
                      mergeGroup={(group) => setRegistryMerge({ kind: "group", entity: group })}
                      mergeTag={(tag) => setRegistryMerge({ kind: "tag", entity: tag })}
                      migrateExtensionIdentity={migrateExtensionIdentity}
                      newGroup={() => setRegistryEditor({ kind: "group", mode: "create" })}
                      newTag={() => setRegistryEditor({ kind: "tag", mode: "create" })}
                      newProxySubscription={() => openProxySubscriptionEditor("create")}
                      refreshAllProxySubscriptions={refreshAllProxySubscriptions}
                      refreshProxySubscription={refreshProxySubscription}
                      requestProxySubscriptionDelete={requestProxySubscriptionDelete}
                      reinstallExtension={reinstallExtension}
                      permanentlyDeleteTrashEnvironment={permanentlyDeleteTrashEnvironment}
                      reloadState={loadState}
                      requestProxyDelete={requestProxyDelete}
                      requestProxyReference={(action, proxy) => setProxyReference({ action, proxy })}
                      requestGroupDelete={requestGroupDelete}
                      requestTagDelete={requestTagDelete}
                      restoreTrashEnvironment={restoreTrashEnvironment}
                      runExtensionAutoChecks={runExtensionAutoChecks}
                      setExtensionUpdatePolicy={setExtensionUpdatePolicy}
                      toggleExtensionStatus={toggleExtensionStatus}
                      updateExtension={updateExtension}
                      updateGroup={updateGroup}
                      updateProxy={updateProxy}
                      updateProxySubscription={updateProxySubscription}
                      updateTag={updateTag}
                    />
                  </Suspense>
                )}
              </div>
            </div>
          </>
        )}
        </section>

      {drawerMode === "edit" && draft && ProfileEditorDrawerRenderer && (
        <ProfileEditorDrawerRenderer
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
          locale={locale}
          nameError={profileNameError}
          tags={state?.tags ?? []}
          boundExtensionIds={state?.environments?.find((environment) => environment.id === draft.id)?.extensionIds ?? []}
          proxies={state?.proxies ?? []}
          proxyCheck={proxyCheck}
          proxyLibraryDraftIds={draftProxyLibraryIds}
          browserCoreMissing={browserCoreMissing}
          canStop={draftActionState.canStop}
          stopPending={draftActionState.stopPending}
          resolveProxyGeoip={resolveProxyGeoip}
          rotateIdentity={() => void rotateIdentity()}
          identityRotationBlocked={Boolean(draftSession && ["running", "launching", "stopping"].includes(draftSession.status))}
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
          installXray={installXrayEngine}
          globalUtlsFingerprint={normalizedSettings.xray.utlsFingerprint}
          nativeProxyRouting={normalizedSettings.xray.nativeProxyRouting}
          xrayStatus={xrayStatus}
          t={t}
        />
      )}

      {drawerMode === "details" && draft && (
        <DetailsDrawer
          busy={busy}
          close={() => setDrawerMode(null)}
          copySnippet={copySnippet}
          copySnapshotMarkdown={copySnapshotMarkdown}
          downloadSnapshot={downloadSnapshot}
          draft={draft}
          editProfile={() => setDrawerMode("edit")}
          locale={locale}
          preflight={preflight}
          runPreflightAction={runPreflightAction}
          selectedSession={selectedSession}
          state={state}
          storage={state?.storage}
          t={t}
        />
      )}

      {drawerMode === "settings" && SettingsDrawerRenderer && (
        <SettingsDrawerRenderer
          binaryInfo={binaryInfo}
          busy={busy}
          cancelBrowserCoreOperation={cancelBrowserCoreOperation}
          cancelXrayOperation={cancelXrayOperation}
          checkBrowserCoreUpdate={checkBrowserCoreUpdate}
          checkGithubMirrors={checkGithubMirrors}
          close={closeDrawer}
          exportAppBackup={exportAppBackup}
          importBrowserCoreZip={(filePath, options) => setBrowserCoreImport({ filePath, ...options })}
          installBinary={installBinary}
          initialTab={settingsInitialTab}
          openRuntimeCheck={() => {
            setDrawerMode(null);
            setWorkbenchView("runtimeCheck");
          }}
          requestAdvancedWebEntry={() => requestAdvancedWebEntry(normalizedSettings)}
          pruneBrowserData={pruneBrowserData}
          restoreAppBackup={restoreAppBackup}
          runtime={runtime}
          settings={settings}
          saveSettings={saveSettings}
          t={t}
          updateBinary={updateBinary}
          clearBinaryCache={clearBinaryCache}
          installPrivateVersion={installPrivateVersion}
          activateCoreChannel={activateCoreChannel}
          clearPrivateToken={clearPrivateToken}
          hasActiveSessions={(state?.sessions ?? []).some((session) => ["running", "launching", "stopping"].includes(session.status) || session.closeUnconfirmed)}
          loadPrivateReleases={loadPrivateReleases}
          testPrivateRepository={testPrivateRepository}
          checkXrayUpdate={checkXrayUpdate}
          installXray={installXrayEngine}
          xrayStatus={xrayStatus}
          about={{
            appUpdate: {
              check: normalizedSettings.appUpdate.lastUpdateCheck,
              checking: busy === "app-update-check",
              currentVersion: runtimeVersions.app ?? "-",
              onCheck: () => void checkAppUpdate(),
              onDownload: () => {
                const download = normalizedSettings.appUpdate.lastUpdateCheck?.download;
                const version = normalizedSettings.appUpdate.lastUpdateCheck?.latestVersion;
                if (download && version) void openAppUpdateAsset(version, download.fileName);
              },
              onOpenReleasePage: () => void openAboutLink("releases"),
              portable: Boolean(state?.storage?.portable ?? runtime?.portable),
            },
            binaryInfo,
            copyDiagnostics,
            diagnostics,
            exportDiagnostics,
            locale,
            openDataDirectory,
            openLink: openAboutLink,
            openSidecarEndpoint,
            runtime,
            storage: state?.storage,
            versions: runtimeVersions,
          }}
        />
      )}

      {drawerMode === "columns" && ColumnSettingsDrawerRenderer && (
        <ColumnSettingsDrawerRenderer
          close={closeDrawer}
          settings={settings}
          saveSettings={saveSettings}
          t={t}
        />
      )}

      {proxyEditor && ProxyEditorDialogRenderer && (
        <ProxyEditorDialogRenderer
          busy={busy}
          close={() => setProxyEditor(null)}
          globalUtlsFingerprint={normalizedSettings.xray.utlsFingerprint}
          locale={locale}
          mode={proxyEditor.mode}
          proxies={state?.proxies ?? []}
          proxy={proxyEditor.mode === "edit" ? proxyEditor.proxy : undefined}
          saveProxy={saveProxyDraft}
          t={t}
        />
      )}

      {proxyImport && ProxyAddDialogRenderer && (
        <ProxyAddDialogRenderer
          busy={busy}
          close={() => setProxyImport(false)}
          globalUtlsFingerprint={normalizedSettings.xray.utlsFingerprint}
          importLinks={importProxyLinks}
          locale={locale}
          proxies={state?.proxies ?? []}
          saveProxy={(input) => saveProxyDraft("create", input)}
          t={t}
        />
      )}

      {proxySubscriptionEditor && ProxySubscriptionDialogRenderer && (
        <ProxySubscriptionDialogRenderer
          busy={busy}
          close={() => setProxySubscriptionEditor(null)}
          mode={proxySubscriptionEditor.mode}
          saveSubscription={saveProxySubscription}
          subscription={proxySubscriptionEditor.mode === "edit" ? proxySubscriptionEditor.subscription : undefined}
          t={t}
        />
      )}

      {registryEditor && RegistryEntityDialogRenderer && (
        <RegistryEntityDialogRenderer
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

      {registryMerge && RegistryMergeDialogRenderer && (
        <RegistryMergeDialogRenderer
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

      {extensionImport && ExtensionImportDialogRenderer && (
        <ExtensionImportDialogRenderer
          busy={busy}
          close={() => setExtensionImport(null)}
          importArchive={importExtensionArchivePath}
          importDirectories={importExtensionDirectoryPaths}
          importDirectory={importExtensionDirectoryPath}
          previewDirectory={previewExtensionDirectoryPath}
          state={extensionImport}
          t={t}
          uploadArchive={uploadExtensionArchive}
        />
      )}

      {browserCoreImport && BrowserCoreImportDialogRenderer && (
        <BrowserCoreImportDialogRenderer
          analyzeImport={analyzeBrowserCoreImport}
          binaryPathOverride={binaryInfo?.core?.env.some((row) => row.key === "CLOAKBROWSER_BINARY_PATH" && row.source === "cbpanel-default") ? undefined : binaryPathOverrideFrom(binaryInfo?.core?.env ?? [])}
          busy={busy}
          close={() => setBrowserCoreImport(null)}
          installImport={installBrowserCoreImport}
          setState={setBrowserCoreImport}
          state={browserCoreImport}
          t={t}
        />
      )}

      {confirmDialog && ConfirmDialogRenderer && (
        <ConfirmDialogRenderer
          busy={busy}
          close={() => setConfirmDialog(null)}
          state={confirmDialog}
          t={t}
        />
      )}

      {environmentPackageOperation && EnvironmentPackageOperationDialogRenderer && (
        <EnvironmentPackageOperationDialogRenderer
          operation={environmentPackageOperation}
          t={t}
        />
      )}

      {appBackupOperation && EnvironmentPackageOperationDialogRenderer && (
        <EnvironmentPackageOperationDialogRenderer
          namespace="appBackup"
          operation={appBackupOperation}
          t={t}
        />
      )}

      {proxyReference && ProxyReferenceDialogRenderer && (
        <ProxyReferenceDialogRenderer
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

      {extensionReference && ExtensionReferenceDialogRenderer && (
        <ExtensionReferenceDialogRenderer
          busy={busy}
          close={() => setExtensionReference(null)}
          environments={extensionReferenceEnvironmentEntries}
          extension={extensionReference.extension}
          showProfiles={(extensionId) => showProfileView({ extensionId })}
          t={t}
          unbindAndDelete={unbindAndDeleteExtension}
          unbindOnly={unbindExtensionReferences}
        />
      )}

      {textInputDialog && TextInputDialogRenderer && (
        <TextInputDialogRenderer
          busy={busy}
          close={() => setTextInputDialog(null)}
          state={textInputDialog}
          t={t}
        />
      )}

        <div className="toast-stack" aria-live="polite">
          {toasts.map((item) => (
            <div className={`toast ${item.kind}`} key={item.id}>
              {item.kind === "success" ? <Check size={16} /> : <CircleAlert size={16} />}
              {item.text}
            </div>
          ))}
        </div>
        <Toaster position="bottom-right" richColors={false} closeButton theme={resolvedTheme} />
      </main>
    </TooltipProvider>
  );
}

function settingsPatchFromNext(patch: AppSettingsPatch, nextSettings: AppSettings): AppSettingsPatch {
  return {
    ...(patch.appearance !== undefined ? { appearance: nextSettings.appearance } : {}),
    ...(patch.table !== undefined ? { table: nextSettings.table } : {}),
    ...(patch.desktop !== undefined ? { desktop: nextSettings.desktop } : {}),
    ...(patch.binary !== undefined ? { binary: nextSettings.binary } : {}),
    ...(patch.networkTrace !== undefined ? { networkTrace: nextSettings.networkTrace } : {}),
    ...(patch.extensionAcquisition !== undefined
      ? { extensionAcquisition: nextSettings.extensionAcquisition }
      : {}),
    ...(patch.xray !== undefined ? { xray: nextSettings.xray } : {}),
    ...(patch.appUpdate !== undefined ? { appUpdate: nextSettings.appUpdate } : {}),
  };
}

function applyAppearance(settings: AppSettings, theme: "light" | "dark", locale?: string): void {
  const normalized = normalizeSettings(settings);
  const root = document.documentElement;
  root.lang = locale ?? localeFromMode(normalized.appearance.language, navigator.language);
  root.dataset.theme = theme;
  // Mirrored for the inline head script, so the next launch starts with the
  // right colour instead of guessing from the OS theme.
  try {
    window.localStorage.setItem("cbpanel.resolvedTheme", theme);
  } catch {
    /* Storage may be unavailable; the inline script then uses the OS theme. */
  }
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

function renderApp(): void {
  root.render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}

// Wait for the initial locale dictionary before the first paint so en-US users
// never see zh-CN fallback strings. zh-CN is already in this chunk, so zh-CN
// users render synchronously.
const bootLocale = localeFromMode(DEFAULT_APP_SETTINGS.appearance.language, navigator.language);
if (isLocaleReady(bootLocale)) {
  renderApp();
} else {
  void ensureLocaleReady(bootLocale)
    .catch((error) => console.warn("Locale dictionary load failed", error))
    .then(renderApp);
}
