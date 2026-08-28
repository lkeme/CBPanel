import { lazy, Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, ChevronRight, MoreHorizontal, Plus, Puzzle, Search, Settings2 } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import { forgetExtensionIcon, loadExtensionIcon, peekExtensionIcon } from "../../lib/extensionIcons";
import { openExtensionListing } from "../../lib/extensionExternalNavigation";
import { shortExtensionId } from "../../lib/utils";
import type {
  ExtensionEntity,
  ExtensionInstallState,
  ExtensionSourceKind,
  ExtensionUpdatePolicy,
} from "../../shared/entities";
import type { AppSettings } from "../../shared/settings";
import { DEFAULT_APP_SETTINGS } from "../../shared/settings";
import type {
  ExtensionArtifactProviderId,
  ExtensionCatalogItem,
  ExtensionReferenceResolution,
} from "../../shared/extensionAcquisition";
import {
  chromeWebStoreListingUrl,
  isCanonicalChromeExtensionId,
  selectedExtensionArtifactProvider,
} from "../../shared/extensionAcquisition";
import {
  sessionViewNeedsPolling,
  type ExtensionAcquisitionSelection,
  type ExtensionAcquisitionSessionState,
  type ExtensionUpdateProviderTransitionState,
} from "../../hooks/extensionAcquisitionState";
import { useExtensionAcquisition } from "../../hooks/useExtensionAcquisition";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Switch } from "../ui/switch";
import type { ExtensionModuleStat } from "./registryStats";
import { RegistryListShell } from "./RegistryModuleShell";
import { RegistryModuleShell } from "./RegistryModuleShell";
import { Segmented } from "../ui/form-controls";
import { ExtensionAcquisitionDialogLoading } from "./RegistryDialogs";
import type { ExtensionAcquisitionUiTranslator } from "./extensionAcquisitionUi";
import type { BrowserRuntimeIdentity } from "./ExtensionRegistryDetail";
import { ChromeMark } from "./ChromeMark";

const ExtensionCatalogResults = lazy(() => import("./ExtensionAcquisitionResults").then((module) => ({
  default: module.ExtensionCatalogResults,
})));
const ExtensionArtifactChannelChoice = lazy(() => import("./ExtensionAcquisitionResults").then((module) => ({
  default: module.ExtensionArtifactChannelChoice,
})));
const ExtensionAcquisitionStartError = lazy(() => import("./ExtensionAcquisitionResults").then((module) => ({
  default: module.ExtensionAcquisitionStartError,
})));
const ExtensionAcquisitionSessionPanel = lazy(() => import("./ExtensionAcquisitionSessionPanel").then((module) => ({
  default: module.ExtensionAcquisitionSessionPanel,
})));
const ExtensionAcquisitionDisclosureDialog = lazy(() => import("./ExtensionAcquisitionSources").then((module) => ({
  default: module.ExtensionAcquisitionDisclosureDialog,
})));
const ExtensionAcquisitionSourceSettingsDialog = lazy(() => import("./ExtensionAcquisitionSources").then((module) => ({
  default: module.ExtensionAcquisitionSourceSettingsDialog,
})));
const ExtensionRowDetail = lazy(() => import("./ExtensionRegistryDetail").then((module) => ({
  default: module.ExtensionRowDetail,
})));

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

type Notify = (kind: "success" | "error" | "info", text: string) => void;

type ExtensionTone = "ready" | "error" | "muted";

type ExtensionHealth = "ready" | "pending" | "error";

type ExtensionActions = {
  checkExtension: (extension: ExtensionEntity) => Promise<void>;
  checkExtensionUpdate: (extension: ExtensionEntity) => Promise<void>;
  deleteExtension: (extension: ExtensionEntity) => Promise<void>;
  installExtension: (extension: ExtensionEntity) => Promise<void>;
  migrateExtensionIdentity: (extension: ExtensionEntity) => Promise<void>;
  reinstallExtension: (extension: ExtensionEntity) => Promise<void>;
  setExtensionUpdatePolicy: (extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) => Promise<void>;
  toggleExtensionStatus: (extension: ExtensionEntity) => Promise<void>;
  updateExtension: (extension: ExtensionEntity) => Promise<void>;
};

type ExtensionRegistryPanelProps = ExtensionActions & {
  busy: string;
  extensions: ExtensionEntity[];
  extensionStats: ExtensionModuleStat[];
  settings?: AppSettings;
  locale: string;
  t: Translate;
  toast: Notify;
  importExtensionArchive: (kind: "zip" | "crx") => void | Promise<void>;
  importExtensionDirectory: () => void | Promise<void>;
  reloadState: () => Promise<unknown>;
  showProfiles: () => void;
};

type ExtensionRowModel = {
  extension: ExtensionEntity;
  duplicated: boolean;
  failing: boolean;
  haystack: string;
  highRiskCount: number;
  kindLabel: string;
  mediumRiskCount: number;
  refCount: number;
  stateLabel: string;
};

type DerivedBrowserRuntimeIdentity = {
  manifestKey: string;
  id?: string;
};

const sourceKindKeys: Partial<Record<ExtensionSourceKind, TranslationKey>> = {
  "local-directory": "extension.kind.localDirectory",
  "local-zip": "extension.kind.localZip",
  "local-crx": "extension.kind.localCrx",
  "managed-snapshot": "extension.kind.managedSnapshot",
  "chrome-web-store": "extension.kind.chromeWebStore",
};

const installStateKeys: Record<ExtensionInstallState, TranslationKey> = {
  "metadata-only": "extension.state.notInstalled",
  "download-pending": "extension.state.notInstalled",
  downloading: "extension.state.downloading",
  installed: "extension.state.installed",
  "update-available": "extension.state.updateAvailable",
  "local-missing": "extension.state.localMissing",
  "invalid-manifest": "extension.state.invalidManifest",
  "install-failed": "extension.state.installFailed",
};

const failingStates = new Set<ExtensionInstallState>(["local-missing", "invalid-manifest", "install-failed"]);

const pendingStates = new Set<ExtensionInstallState>(["metadata-only", "download-pending", "downloading"]);

const loadableStates = new Set<ExtensionInstallState>(["installed", "update-available"]);

/** Matches Chromium's extension-ID derivation for a Manifest `key` without exposing the key itself. */
export async function browserRuntimeIdFromManifestKey(manifestKey: string): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return undefined;
  try {
    let normalized = manifestKey.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
    normalized += "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = globalThis.atob(normalized);
    const keyBytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const digest = new Uint8Array(await subtle.digest("SHA-256", keyBytes));
    return [...digest.subarray(0, 16)]
      .map((octet) => String.fromCharCode(0x61 + (octet >> 4), 0x61 + (octet & 0x0f)))
      .join("");
  } catch {
    return undefined;
  }
}

function useBrowserRuntimeIdentities(extensions: ExtensionEntity[]): ReadonlyMap<string, BrowserRuntimeIdentity> {
  const [derived, setDerived] = useState<ReadonlyMap<string, DerivedBrowserRuntimeIdentity>>(() => new Map());

  useEffect(() => {
    let active = true;
    const keyedExtensions = extensions.filter((extension) => (
      Boolean(extension.manifestKey)
      && !extension.provenance?.verification.proofDerivedStoreId
    ));
    void Promise.all(keyedExtensions.map(async (extension) => ({
      extensionId: extension.id,
      identity: {
        manifestKey: extension.manifestKey as string,
        id: await browserRuntimeIdFromManifestKey(extension.manifestKey as string),
      },
    }))).then((entries) => {
      if (active) setDerived(new Map(entries.map((entry) => [entry.extensionId, entry.identity])));
    });
    return () => {
      active = false;
    };
  }, [extensions]);

  return useMemo(() => {
    const identities = new Map<string, BrowserRuntimeIdentity>();
    for (const extension of extensions) {
      const proofDerivedId = extension.provenance?.verification.proofDerivedStoreId;
      if (proofDerivedId) {
        identities.set(extension.id, { status: "known", id: proofDerivedId });
        continue;
      }
      if (!extension.manifestKey) {
        identities.set(
          extension.id,
          extension.localPath && loadableStates.has(extension.installState)
            ? { status: "path-derived" }
            : { status: "unavailable" },
        );
        continue;
      }
      const resolved = derived.get(extension.id);
      if (!resolved || resolved.manifestKey !== extension.manifestKey) {
        identities.set(extension.id, { status: "deriving" });
      } else if (resolved.id) {
        identities.set(extension.id, { status: "known", id: resolved.id });
      } else {
        identities.set(extension.id, { status: "unavailable" });
      }
    }
    return identities;
  }, [derived, extensions]);
}

/** Only same name + same version needs the short-ID chip, so count that pair exactly. */
function nameVersionKey(extension: ExtensionEntity) {
  return JSON.stringify([extension.name, extension.version]);
}

/** Fetches the real manifest icon once per `id:updatedAt`; falls back to the glyph on any miss. */
function useExtensionIcon(extension: ExtensionEntity): { src: string | null; onError: () => void } {
  const { id, installState, localPath, updatedAt } = extension;
  const [src, setSrc] = useState<string | null>(() => peekExtensionIcon(id, updatedAt) ?? null);

  useEffect(() => {
    const cached = peekExtensionIcon(id, updatedAt);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    // Only an installed unpacked copy can have a readable icon; asking for the others
    // just trades a request for a 404/400 in the console.
    if (!localPath || !loadableStates.has(installState)) {
      setSrc(null);
      return;
    }
    // Deliberately keep the current icon on screen while revalidating: `updatedAt` also changes
    // on a status/policy write, and blanking to the glyph first makes the row flicker.
    let active = true;
    void loadExtensionIcon(id, updatedAt).then((value) => {
      if (active) setSrc(value);
    });
    return () => {
      active = false;
    };
  }, [id, installState, localPath, updatedAt]);

  return {
    src,
    onError: () => {
      forgetExtensionIcon(id, updatedAt);
      setSrc(null);
    },
  };
}

function extensionSearchText(
  extension: ExtensionEntity,
  kindLabel: string,
  stateLabel: string,
  browserRuntimeId?: string,
) {
  return [
    extension.name,
    extension.description,
    extension.version,
    extension.id,
    extension.storeIdentity?.storeId ?? extension.storeId ?? "",
    browserRuntimeId ?? "",
    kindLabel,
    extension.installState,
    stateLabel,
    extension.localPath ?? "",
    extension.permissions.join(" "),
    extension.hostPermissions.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

/** External navigation trusts only the canonical ID, never a provider-returned URL. */
export function canonicalExtensionListingUrl(value: { storeId: string }): string {
  return chromeWebStoreListingUrl(value.storeId);
}

/** Restore the scroll position captured before entering a catalog detail view. */
export function restoreExtensionAcquisitionScrollPosition(
  scroller: HTMLElement | null | undefined,
  scrollTop: number,
): void {
  if (!scroller || !Number.isFinite(scrollTop)) return;
  scroller.scrollTop = Math.max(0, scrollTop);
}

/**
 * Project a preserved canonical selection onto the currently selected built-in
 * artifact channel. A server resolution is authoritative for the channel it
 * returned; when that channel is stale after an explicit settings change, the
 * provider is still a reviewed fixed enum and the session endpoint remains the
 * final availability/verification gate. An originally empty or malformed
 * server response stays empty so the UI never invents a package offer out of
 * missing facts.
 */
export function extensionResolutionForSelectedProvider(
  selection: ExtensionAcquisitionSelection | undefined,
  providerId: ExtensionArtifactProviderId,
  providerLabel: string,
): ExtensionReferenceResolution | undefined {
  if (!selection) return undefined;
  if (selection.source === "reference" && selection.resolution) {
    const reviewedOffers = selection.resolution.offers.filter((offer) => (
      offer.namespace === "chrome-web-store"
      && offer.storeId === selection.storeId
      && offer.format === "crx3"
      && (offer.artifactProviderId === "chrome-web-store" || offer.artifactProviderId === "crxsoso")
    ));
    const existingOffer = reviewedOffers.find((offer) => offer.artifactProviderId === providerId);
    if (existingOffer) {
      return {
        ...selection.resolution,
        offers: [{ ...existingOffer }],
      };
    }
    if (reviewedOffers.length === 0) {
      return {
        ...selection.resolution,
        offers: [],
      };
    }
  }
  return {
    namespace: "chrome-web-store",
    storeId: selection.storeId,
    storeUrl: selection.storeUrl,
    offers: [{
      namespace: "chrome-web-store",
      storeId: selection.storeId,
      artifactProviderId: providerId,
      format: "crx3",
      providerLabel,
    }],
  };
}

export function usesTrustedExtensionAcquisitionUpdate(extension: ExtensionEntity): boolean {
  return Boolean(extension.storeIdentity || extension.updateProviderId);
}

export function canStartTrustedExtensionAcquisitionUpdate(extension: ExtensionEntity): boolean {
  return extension.storeIdentity?.namespace === "chrome-web-store"
    && Boolean(extension.updateProviderId);
}

/**
 * Align an installed extension's persisted update authority with the one
 * global download channel before creating an update session. The transition
 * is an explicit consequence of the user's update action and stays
 * server-owned: it downloads, verifies, and CAS-writes the provider before
 * this helper accepts the returned projection.
 */
export async function extensionForSelectedUpdateProvider({
  extension,
  selectedProviderId,
  transitionUpdateProvider,
}: {
  extension: ExtensionEntity;
  selectedProviderId: ExtensionArtifactProviderId;
  transitionUpdateProvider: (
    extensionId: string,
    previousProviderId: ExtensionArtifactProviderId,
    requestedProviderId: ExtensionArtifactProviderId,
  ) => Promise<ExtensionEntity | undefined>;
}): Promise<ExtensionEntity | undefined> {
  const previousProviderId = extension.updateProviderId;
  const storeId = extension.storeIdentity?.namespace === "chrome-web-store"
    ? extension.storeIdentity.storeId
    : undefined;
  if (!previousProviderId || !storeId) return undefined;
  if (previousProviderId === selectedProviderId) return extension;
  const transitioned = await transitionUpdateProvider(
    extension.id,
    previousProviderId,
    selectedProviderId,
  );
  if (
    transitioned?.id !== extension.id
    || transitioned.updateProviderId !== selectedProviderId
    || transitioned.storeIdentity?.namespace !== "chrome-web-store"
    || transitioned.storeIdentity.storeId !== storeId
  ) return undefined;
  return transitioned;
}

/** Active work owns one store ID; terminal history must not contaminate another detail page. */
export function extensionSessionBlocksOtherStore(
  session: ExtensionAcquisitionSessionState,
  storeId: string,
): boolean {
  if (!session.lastRequest || session.lastRequest.storeId === storeId) return false;
  if (
    session.operation === "starting"
    || session.operation === "cancelling"
    || session.operation === "confirming"
  ) return true;
  return Boolean(session.view && (sessionViewNeedsPolling(session.view) || session.view.status === "ready"));
}

/** Associate session feedback only with the canonical result that started it. */
export function extensionSessionMatchesResolution(
  session: ExtensionAcquisitionSessionState,
  resolution: ExtensionReferenceResolution | undefined,
): boolean {
  return !resolution || session.lastRequest?.storeId === resolution.storeId;
}

function ExtensionAcquisitionContentLoading({ t }: { t: Translate }) {
  // Entering the Get tab lazy-loads the results chunk; a bare spinner reads
  // better than a "Working…" sentence for what is usually a single frame.
  return (
    <div aria-live="polite" className="acquisition-search-loading" role="status">
      <span aria-hidden="true" className="acquisition-loading-spinner" />
      <span className="acquisition-visually-hidden">{t("extension.acquisition.loading")}</span>
    </div>
  );
}

export function ExtensionRegistryPanel({
  busy,
  extensions,
  extensionStats,
  settings,
  locale,
  t,
  toast,
  checkExtension,
  checkExtensionUpdate,
  deleteExtension,
  importExtensionArchive,
  importExtensionDirectory,
  installExtension,
  migrateExtensionIdentity,
  reloadState,
  reinstallExtension,
  setExtensionUpdatePolicy,
  showProfiles,
  toggleExtensionStatus,
  updateExtension,
}: ExtensionRegistryPanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [workspaceView, setWorkspaceView] = useState<"library" | "get">("library");
  const [libraryQuery, setLibraryQuery] = useState("");
  const [sourceSettingsOpen, setSourceSettingsOpen] = useState(false);
  const [savingCapabilityId, setSavingCapabilityId] = useState<ExtensionArtifactProviderId | undefined>();
  const [catalogViewMode, setCatalogViewMode] = useState<"two" | "four">("two");
  const [catalogDetail, setCatalogDetail] = useState<ExtensionCatalogItem | undefined>();
  const catalogDetailRequestRef = useRef(0);
  const acquisitionWorkspaceRef = useRef<HTMLDivElement>(null);
  const catalogScrollContainerRef = useRef<HTMLElement | null>(null);
  const catalogScrollTopRef = useRef(0);
  const acquisition = useExtensionAcquisition({
    settings: settings?.extensionAcquisition ?? DEFAULT_APP_SETTINGS.extensionAcquisition,
    reloadState,
  });
  const acquisitionT: ExtensionAcquisitionUiTranslator = (key, params) => t(key as TranslationKey, params);
  const browserRuntimeIdentities = useBrowserRuntimeIdentities(extensions);
  const installedStoreIds = useMemo(() => new Set(
    extensions
      .filter((extension) => (
        extension.installState === "installed"
        || extension.installState === "update-available"
      ))
      .map((extension) => extension.storeIdentity?.storeId
        ?? (extension.sourceKind === "chrome-web-store" ? extension.storeId : undefined))
      .filter(isCanonicalChromeExtensionId),
  ), [extensions]);

  const rows = useMemo<ExtensionRowModel[]>(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    const statsById = new Map(extensionStats.filter((item) => item.id).map((item) => [item.id as string, item]));
    const labelCounts = new Map<string, number>();
    for (const extension of extensions) {
      const label = nameVersionKey(extension);
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    return extensions
      .map((extension) => {
        const stat = statsById.get(extension.id);
        const kindLabel = t(sourceKindKeys[extension.sourceKind] ?? "extension.kind.legacy");
        const stateLabel = t(installStateKeys[extension.installState] ?? "extension.state.notInstalled");
        const runtimeIdentity = browserRuntimeIdentities.get(extension.id);
        return {
          extension,
          duplicated: (labelCounts.get(nameVersionKey(extension)) ?? 0) > 1,
          failing: Boolean(extension.lastError) || failingStates.has(extension.installState),
          haystack: extensionSearchText(
            extension,
            kindLabel,
            stateLabel,
            runtimeIdentity?.status === "known" ? runtimeIdentity.id : undefined,
          ),
          highRiskCount: extension.permissionRisks.filter((risk) => risk.level === "high").length,
          kindLabel,
          mediumRiskCount: extension.permissionRisks.filter((risk) => risk.level === "medium").length,
          refCount: stat?.profiles ?? stat?.count ?? 0,
          stateLabel,
        };
      })
      .sort((left, right) => {
        const byName = collator.compare(left.extension.name, right.extension.name);
        if (byName !== 0) return byName;
        const byVersion = collator.compare(right.extension.version, left.extension.version);
        if (byVersion !== 0) return byVersion;
        return left.extension.createdAt.localeCompare(right.extension.createdAt);
      });
  }, [browserRuntimeIdentities, extensions, extensionStats, locale, t]);

  const summary = useMemo(
    () => ({
      total: rows.length,
      updatable: rows.filter((row) => (
        row.extension.installState === "update-available" || row.extension.updateState?.status === "available"
      )).length,
      failing: rows.filter((row) => row.failing).length,
    }),
    [rows],
  );

  const importBusy = busy === "extension-import-directory"
    || busy === "extension-import-zip"
    || busy === "extension-import-crx";
  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const viewSwitch = (
    <Segmented
      onChange={setWorkspaceView}
      options={[
        { value: "library", label: t("extension.acquisition.view.library") },
        { value: "get", label: t("extension.acquisition.view.get") },
      ]}
      value={workspaceView}
    />
  );

  async function selectArtifactProvider(providerId: ExtensionArtifactProviderId) {
    setSavingCapabilityId(providerId);
    try {
      await acquisition.setArtifactProvider(providerId);
    } finally {
      setSavingCapabilityId(undefined);
    }
  }

  function openListing(value: { storeId: string }, providerId = selectedExtensionArtifactProvider(acquisition.state.settings)) {
    void openExtensionListing({ storeId: value.storeId, artifactProviderId: providerId }).catch(() => {
      toast("error", t("extension.acquisition.openListingFailed"));
    });
  }

  function selectedResolution(): ExtensionReferenceResolution | undefined {
    const selection = acquisition.state.selection;
    if (!selection) return undefined;
    const artifactProviderId = selectedExtensionArtifactProvider(acquisition.state.settings);
    return extensionResolutionForSelectedProvider(
      selection,
      artifactProviderId,
      artifactProviderId === "crxsoso"
        ? t("extension.detail.provider.crxsoso")
        : t("extension.detail.provider.google"),
    );
  }

  async function startOffer(providerId: ExtensionArtifactProviderId) {
    // The normal offer is the persisted channel. A mirror offer can appear
    // only as an explicit fallback after a failed selected-channel attempt;
    // clicking it intentionally switches and persists the single channel
    // before starting a new server session. There is no silent provider hop.
    if (!acquisition.selectProvider(providerId)) {
      if (!await acquisition.setArtifactProvider(providerId)) return;
      if (!acquisition.selectProvider(providerId)) return;
    }
    await acquisition.startSelectedSession();
  }

  async function checkOrStartUpdate(extension: ExtensionEntity) {
    if (usesTrustedExtensionAcquisitionUpdate(extension)) {
      if (!canStartTrustedExtensionAcquisitionUpdate(extension) || !extension.storeIdentity || !extension.updateProviderId) {
        toast("error", t("extension.detail.updateProvider.incomplete"));
        return;
      }
      const selectedProviderId = selectedExtensionArtifactProvider(acquisition.state.settings);
      const updateTarget = await extensionForSelectedUpdateProvider({
        extension,
        selectedProviderId,
        transitionUpdateProvider: acquisition.transitionUpdateProvider,
      });
      if (!updateTarget?.storeIdentity) {
        toast("error", t("extension.acquisition.error"));
        return;
      }
      setCatalogDetail(undefined);
      setWorkspaceView("get");
      await acquisition.startSession({
        namespace: "chrome-web-store",
        storeId: updateTarget.storeIdentity.storeId,
        artifactProviderId: selectedProviderId,
        purpose: "update",
        targetExtensionId: updateTarget.id,
      });
      return;
    }
    await checkExtensionUpdate(extension);
  }

  if (workspaceView === "get") {
    const resolution = selectedResolution();
    const session = acquisition.state.session;
    const sessionMatchesResolution = extensionSessionMatchesResolution(session, resolution);
    const providerFailure = sessionMatchesResolution
      && session.error
      && session.lastRequest
      && session.error.code !== "ACQUISITION_REQUEST_CANCELLED"
      && session.error.code !== "ACQUISITION_CANCELLED"
      ? { ...session.error, providerId: session.lastRequest.artifactProviderId }
      : undefined;
    const startingProviderId = sessionMatchesResolution
      && (
        session.operation === "starting"
        || session.operation === "polling"
        || session.operation === "confirming"
      )
      ? session.lastRequest?.artifactProviderId
      : undefined;
    const classification = acquisition.state.classification;
    // The placeholder already explains keyword/ID input. Only invalid URL-like
    // text gets a persistent hint; the old “requests are sent on submit” copy
    // was repetitive noise on every search.
    const inputHint = acquisition.state.input.trim() && classification.kind === "invalid"
      ? t("extension.acquisition.search.invalid")
      : "";
    const channelChoice = resolution ? (
      <ExtensionArtifactChannelChoice
        embedded={Boolean(catalogDetail)}
        installed={installedStoreIds.has(resolution.storeId)}
        onCancel={session.operation === "confirming"
          ? undefined
          : async () => { await acquisition.cancelSession(); }}
        onOpenListing={openListing}
        onSelect={(providerId) => acquisition.selectProvider(providerId)}
        onStart={(offer) => startOffer(offer.artifactProviderId)}
        providerFailure={providerFailure}
        resolution={resolution}
        selectedProviderId={acquisition.state.selectedProviderId}
        startingProviderId={startingProviderId}
        t={acquisitionT}
      />
    ) : undefined;

    function submitDiscovery(event: FormEvent<HTMLFormElement>) {
      event.preventDefault();
      setCatalogDetail(undefined);
      void acquisition.submit();
    }

    function openCatalogDetail(item: ExtensionCatalogItem) {
      if (extensionSessionBlocksOtherStore(session, item.storeId)) {
        toast("info", t("extension.acquisition.errorCode.ACQUISITION_SESSION_ACTIVE"));
        return;
      }
      const scroller = acquisitionWorkspaceRef.current?.closest<HTMLElement>(".module-surface-body");
      catalogScrollContainerRef.current = scroller ?? null;
      catalogScrollTopRef.current = scroller?.scrollTop ?? 0;
      if (acquisition.selectCatalogItem(item)) {
        // The result can be several viewports down. Reusing that scroll offset
        // for the child page can hide both Back and the primary install CTA.
        restoreExtensionAcquisitionScrollPosition(scroller, 0);
        setCatalogDetail(item);
        const requestId = ++catalogDetailRequestRef.current;
        void acquisition.loadCatalogDetail(item.storeId).then((detail) => {
          if (!detail || catalogDetailRequestRef.current !== requestId) return;
          setCatalogDetail((current) => (
            current && current.storeId === item.storeId ? { ...current, ...detail } : current
          ));
        });
      }
    }

    function closeCatalogDetail() {
      catalogDetailRequestRef.current += 1;
      acquisition.clearSelection();
      setCatalogDetail(undefined);
      const scroller = catalogScrollContainerRef.current;
      const scrollTop = catalogScrollTopRef.current;
      if (scroller) {
        if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
          window.requestAnimationFrame(() => restoreExtensionAcquisitionScrollPosition(scroller, scrollTop));
        } else {
          restoreExtensionAcquisitionScrollPosition(scroller, scrollTop);
        }
      }
    }

    const sessionPanel = session.view && sessionMatchesResolution ? (
      <Suspense fallback={<ExtensionAcquisitionContentLoading t={t} />}>
        <ExtensionAcquisitionSessionPanel
          confirmedExtension={session.confirmation?.extension}
          error={session.error}
          locale={locale as "zh-CN" | "en-US"}
          onCancel={async () => { await acquisition.cancelSession(); }}
          onBindNext={() => {
            setCatalogDetail(undefined);
            acquisition.reset();
            showProfiles();
          }}
          onConfirm={async (request) => { await acquisition.confirm(request); }}
          onDone={() => {
            setCatalogDetail(undefined);
            acquisition.reset();
            setWorkspaceView("library");
          }}
          onRetry={async () => { await acquisition.retrySession(); }}
          onRetryStateRefresh={async () => { await acquisition.retryStateRefresh(); }}
          operation={session.operation}
          refreshError={session.refreshError}
          refreshingState={session.refreshingState}
          session={session.view}
          t={acquisitionT}
          targetExtensionId={session.lastRequest?.targetExtensionId}
        />
      </Suspense>
    ) : undefined;
    const sessionStartError = session.error
      && !session.view
      && sessionMatchesResolution
      && (!resolution || session.lastRequest?.purpose === "update") ? (
        <ExtensionAcquisitionStartError
          error={session.error}
          onOpenSources={() => setSourceSettingsOpen(true)}
          onRetry={session.lastRequest ? () => { void acquisition.retrySession(); } : undefined}
          t={acquisitionT}
        />
      ) : undefined;

    return (
      <>
        <RegistryModuleShell
          body={t("extension.acquisition.get.description")}
          icon={<Puzzle size={19} />}
          title={t("extension.acquisition.get.title")}
          toolbar={
            <>
              {viewSwitch}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button className="command primary" disabled={importBusy} type="button">
                    <Plus aria-hidden="true" size={16} />
                    {t("actions.addExtension")}
                    <ChevronDown aria-hidden="true" size={14} />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  <DropdownMenuItem disabled={busy === "extension-import-directory"} onSelect={() => void importExtensionDirectory()}>
                    {t("actions.importDirectory")}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busy === "extension-import-zip"} onSelect={() => void importExtensionArchive("zip")}>
                    {t("actions.importZip")}
                  </DropdownMenuItem>
                  <DropdownMenuItem disabled={busy === "extension-import-crx"} onSelect={() => void importExtensionArchive("crx")}>
                    {t("actions.importCrx")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              <button className="command subtle" onClick={() => setSourceSettingsOpen(true)} type="button">
                <Settings2 aria-hidden="true" size={16} />
                {t("extension.acquisition.sources.open")}
              </button>
            </>
          }
        >
          <div className="extension-acquisition-workspace" ref={acquisitionWorkspaceRef}>
            <form className="acquisition-search-form" onSubmit={submitDiscovery}>
              <div className="acquisition-search-control">
                <div className="acquisition-search-field">
                  <ChromeMark size={26} />
                  <input
                    aria-describedby={inputHint ? "extension-acquisition-query-hint" : undefined}
                    aria-invalid={classification.kind === "invalid" || undefined}
                    aria-label={t("extension.acquisition.search.label")}
                    autoComplete="off"
                    id="extension-acquisition-query"
                    onChange={(event) => acquisition.setInput(event.target.value)}
                    placeholder={t("extension.acquisition.search.placeholder")}
                    value={acquisition.state.input}
                  />
                </div>
                <button
                  className="command primary"
                  disabled={
                    !acquisition.state.input.trim()
                    || acquisition.state.discovery.status === "loading"
                  }
                  type="submit"
                >
                  <Search aria-hidden="true" size={16} />
                  {t("extension.acquisition.search.submit")}
                </button>
              </div>
              {inputHint && (
                <small
                  className={classification.kind === "invalid" ? "danger-text" : "acquisition-input-hint"}
                  id="extension-acquisition-query-hint"
                >
                  {inputHint}
                </small>
              )}
            </form>

            {/* Installed-row updates are launched from the library rather
                than from the retained catalog selection. Keep their progress
                and required review above an old result snapshot so the active
                operation is visible in the first viewport. */}
            {session.lastRequest?.purpose === "update" && sessionPanel}
            {session.lastRequest?.purpose === "update" && sessionStartError && (
              <Suspense fallback={<ExtensionAcquisitionContentLoading t={t} />}>
                {sessionStartError}
              </Suspense>
            )}

            <Suspense fallback={<ExtensionAcquisitionContentLoading t={t} />}>
              <ExtensionCatalogResults
                detailItem={catalogDetail}
                detailProviderId={selectedExtensionArtifactProvider(acquisition.state.settings)}
                detailFooter={catalogDetail ? channelChoice : undefined}
                installedStoreIds={installedStoreIds}
                discoveryKind={acquisition.state.discovery.kind}
                error={acquisition.state.discovery.error}
                locale={locale as "zh-CN" | "en-US"}
                onChoose={(item) => acquisition.selectCatalogItem(item)}
                onOpenDetail={(item) => {
                  openCatalogDetail(item);
                }}
                onBackDetail={closeCatalogDetail}
                onLoadMore={() => void acquisition.loadMore()}
                onOpenListing={openListing}
                onViewModeChange={setCatalogViewMode}
                onRetry={() => void acquisition.retryDiscovery()}
                page={acquisition.state.discovery.page}
                selectedStoreId={acquisition.state.selection?.storeId}
                status={acquisition.state.discovery.status}
                viewMode={catalogViewMode}
                t={acquisitionT}
              />

              {!catalogDetail && channelChoice}

              {session.lastRequest?.purpose !== "update" && sessionStartError}
            </Suspense>

            {session.lastRequest?.purpose !== "update" && sessionPanel}
          </div>
        </RegistryModuleShell>

        {sourceSettingsOpen && (
          <Suspense fallback={(
            <ExtensionAcquisitionDialogLoading
              close={() => setSourceSettingsOpen(false)}
              t={acquisitionT}
              title={t("extension.acquisition.source.title")}
            />
          )}>
            <ExtensionAcquisitionSourceSettingsDialog
              busyProviderId={savingCapabilityId}
              close={() => setSourceSettingsOpen(false)}
              error={acquisition.state.settingsRequest.error}
              onSelectProvider={selectArtifactProvider}
              selectedProviderId={selectedExtensionArtifactProvider(acquisition.state.settings)}
              t={acquisitionT}
            />
          </Suspense>
        )}
        {acquisition.state.disclosure.open && (
          <Suspense fallback={(
            <ExtensionAcquisitionDialogLoading
              close={acquisition.dismissDisclosure}
              t={acquisitionT}
              title={t("extension.acquisition.disclosure.title")}
            />
          )}>
            <ExtensionAcquisitionDisclosureDialog
              busy={acquisition.state.settingsRequest.status === "saving"}
              error={acquisition.state.settingsRequest.error}
              onAccept={async () => { await acquisition.acceptDisclosure(); }}
              onCancel={acquisition.dismissDisclosure}
              t={acquisitionT}
            />
          </Suspense>
        )}
      </>
    );
  }

  return (
    <RegistryListShell
      icon={<Puzzle size={19} />}
      title={t("module.extensionsTitle")}
      body={t("module.extensionsBody")}
      items={rows}
      haystack={(row) => row.haystack}
      listClassName="module-list extension-registry-list"
      searchPlaceholder={t("extension.search.placeholder")}
      query={libraryQuery}
      onQueryChange={setLibraryQuery}
      // Zero counts stay out of the summary: a permanent "0 failing" reads like a metric to fix.
      summaryText={(shown, total, filtered) =>
        filtered
          ? t("extension.summaryFiltered", { shown, total })
          : [
            t("extension.summaryTotal", { total }),
            ...(summary.updatable > 0 ? [t("extension.summaryUpdatable", { count: summary.updatable })] : []),
            ...(summary.failing > 0 ? [t("extension.summaryFailing", { count: summary.failing })] : []),
          ].join(" · ")}
      emptyTitle={t("module.emptyTitle")}
      emptyBody={t("module.emptyBody")}
      filterEmptyTitle={t("extension.filterEmptyTitle")}
      filterEmptyBody={t("module.filterEmptyBody")}
      filterResetLabel={t("actions.clearSearch")}
      action={
        viewSwitch
      }
      renderItem={(row) => (
        <ExtensionRow
          browserRuntimeIdentity={browserRuntimeIdentities.get(row.extension.id) ?? { status: "unavailable" }}
          busy={busy}
          checkExtension={checkExtension}
          checkExtensionUpdate={checkOrStartUpdate}
          deleteExtension={deleteExtension}
          expanded={expandedIds.has(row.extension.id)}
          installExtension={installExtension}
          key={row.extension.id}
          locale={locale as Locale}
          migrateExtensionIdentity={migrateExtensionIdentity}
          reinstallExtension={reinstallExtension}
          row={row}
          setExtensionUpdatePolicy={setExtensionUpdatePolicy}
          t={t}
          toast={toast}
          toggleExpanded={toggleExpanded}
          toggleExtensionStatus={toggleExtensionStatus}
          updateExtension={updateExtension}
          updateProviderTransition={acquisition.state.updateProvider}
        />
      )}
    />
  );
}

function ExtensionRow({
  browserRuntimeIdentity,
  busy,
  checkExtension,
  checkExtensionUpdate,
  deleteExtension,
  expanded,
  installExtension,
  locale,
  migrateExtensionIdentity,
  reinstallExtension,
  row,
  setExtensionUpdatePolicy,
  t,
  toast,
  toggleExpanded,
  toggleExtensionStatus,
  updateExtension,
  updateProviderTransition,
}: ExtensionActions & {
  browserRuntimeIdentity: BrowserRuntimeIdentity;
  busy: string;
  expanded: boolean;
  locale: Locale;
  row: ExtensionRowModel;
  t: Translate;
  toast: Notify;
  toggleExpanded: (id: string) => void;
  updateProviderTransition: ExtensionUpdateProviderTransitionState;
}) {
  const { duplicated, extension, failing, highRiskCount, kindLabel, mediumRiskCount, refCount, stateLabel } = row;
  const canMutatePackage = Boolean(sourceKindKeys[extension.sourceKind])
    && extension.sourceKind !== "chrome-web-store";
  const isLoadable = extension.installState === "installed" || extension.installState === "update-available";
  const canInstall = canMutatePackage && !isLoadable;
  const canReinstall = canMutatePackage && extension.installState !== "update-available";
  const verifiedStoreUpdate = usesTrustedExtensionAcquisitionUpdate(extension);
  const canCheckUpdate = verifiedStoreUpdate || extension.sourceKind.startsWith("local-");
  const remoteUpdate = extension.updateState?.status === "available" && Boolean(extension.updateProviderId);
  const canUpdate = canMutatePackage && (extension.installState === "update-available" || remoteUpdate);
  const identityPinned = Boolean(extension.manifestKey);
  const referenceDirectory = extension.sourceKind === "local-directory" && extension.directoryMode !== "copy";
  const canMigrateIdentity = canMutatePackage && !identityPinned && !referenceDirectory;
  const installHint = !canMutatePackage
    ? t("module.webStoreMetadataOnly")
    : canUpdate
      ? t("module.extensionUseUpdate")
      : undefined;
  const disabled = extension.status === "disabled";
  // `update-available` is signalled by the NEW badge plus the inline Update button, so the
  // health dot and the accent bar stay reserved for states that actually block a launch.
  const tone: ExtensionTone = failing ? "error" : disabled ? "muted" : "ready";
  const health: ExtensionHealth = failing ? "error" : pendingStates.has(extension.installState) ? "pending" : "ready";
  const healthTitle = health === "error"
    ? extension.lastError || stateLabel
    : health === "pending"
      ? t("extension.state.notInstalled")
      : t("extension.state.installed");
  const detailsLabel = expanded ? t("module.extensionHideDetails") : t("module.extensionShowDetails");
  const expand = () => toggleExpanded(extension.id);
  const icon = useExtensionIcon(extension);

  return (
    <div className={`extension-row tone-${tone}${expanded ? " is-expanded" : ""}`}>
      <button
        className="extension-row-toggle"
        onClick={expand}
        type="button"
        aria-expanded={expanded}
        aria-label={detailsLabel}
        title={detailsLabel}
      >
        {expanded ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
      </button>
      <span className="extension-row-icon">
        {icon.src ? (
          <img alt="" className="extension-row-icon-img" onError={icon.onError} src={icon.src} />
        ) : (
          <Puzzle size={18} aria-hidden="true" />
        )}
        {/* Announced but not focusable: the chevron and the name button already cover expansion, so a
            third control per row would only add tab stops. `role="img"` keeps the label readable. */}
        <span className={`extension-row-health is-${health}`} role="img" aria-label={healthTitle} title={healthTitle} />
        {canUpdate && <span className="extension-row-badge" title={t("extension.state.updateAvailable")}>{t("extension.badgeUpdate")}</span>}
      </span>
      <div className="extension-row-body">
        <div className="extension-row-headline">
          <button className="extension-row-name" onClick={expand} type="button" aria-expanded={expanded} title={extension.name}>
            {extension.name}
          </button>
          <small className="extension-row-version">
            v{extension.version}
            {extension.manifestVersion ? ` · MV${extension.manifestVersion}` : ""}
          </small>
        </div>
        <div className="extension-row-meta">
          <small>{kindLabel}</small>
          {health === "pending" && (
            <>
              <small aria-hidden="true">·</small>
              <span className="extension-row-pill">{t("extension.state.notInstalled")}</span>
            </>
          )}
          <small aria-hidden="true">·</small>
          {highRiskCount > 0 || mediumRiskCount > 0 ? (
            <span className="risk-badge-group">
              {highRiskCount > 0 && <span className="risk-badge risk-high">{t("module.extensionRisk", { count: highRiskCount })}</span>}
              {mediumRiskCount > 0 && <span className="risk-badge risk-medium">{t("module.extensionRiskMedium", { count: mediumRiskCount })}</span>}
            </span>
          ) : (
            <small>{t("module.extensionNoRisk")}</small>
          )}
          <small aria-hidden="true">·</small>
          <small>{refCount > 0 ? t("module.referenceCount", { count: refCount }) : t("module.noReferences")}</small>
          {duplicated && (
            <>
              <small aria-hidden="true">·</small>
              <span className="extension-row-id mono-cell" title={extension.id}>
                #{shortExtensionId(extension.id)}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="extension-row-actions">
        <Switch
          aria-label={t("extension.enabledToggle")}
          checked={!disabled}
          className="extension-row-switch"
          disabled={busy === `extension-status:${extension.id}`}
          onCheckedChange={() => void toggleExtensionStatus(extension)}
          title={t(disabled ? "actions.enable" : "actions.disable")}
        />
        {canUpdate && (
          <button
            className="command subtle warning"
            disabled={busy === `extension-update:${extension.id}`}
            onClick={() => void (verifiedStoreUpdate ? checkExtensionUpdate(extension) : updateExtension(extension))}
            type="button"
          >
            {t("actions.update")}
          </button>
        )}
        {canInstall && (
          <button
            className="command subtle"
            disabled={busy === `extension-install:${extension.id}`}
            onClick={() => void installExtension(extension)}
            title={installHint}
            type="button"
          >
            {t("actions.install")}
          </button>
        )}
        {/* `deleteExtension` opens its own confirm dialog, so a permanent button is not a one-click destroy. */}
        <button
          className="command danger subtle"
          disabled={busy === `extension-delete:${extension.id}`}
          onClick={() => void deleteExtension(extension)}
          type="button"
        >
          {t("actions.delete")}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!canCheckUpdate || busy === `extension-check-update:${extension.id}`}
              onSelect={() => void checkExtensionUpdate(extension)}
            >
              {t("actions.checkUpdate")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy === `extension-check:${extension.id}`} onSelect={() => void checkExtension(extension)}>
              {t("actions.check")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canReinstall || busy === `extension-reinstall:${extension.id}`}
              onSelect={() => void reinstallExtension(extension)}
            >
              {t("actions.reinstall")}
            </DropdownMenuItem>
            {canMigrateIdentity && (
              <DropdownMenuItem
                disabled={busy === `extension-migrate:${extension.id}`}
                onSelect={() => void migrateExtensionIdentity(extension)}
              >
                {t("actions.migrateIdentity")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <Suspense fallback={(
          <div aria-live="polite" className="extension-detail preflight-empty" role="status">
            {t("extension.acquisition.loading")}
          </div>
        )}>
          <ExtensionRowDetail
            browserRuntimeIdentity={browserRuntimeIdentity}
            busy={busy}
            extension={extension}
            identityPinned={identityPinned}
            kindLabel={kindLabel}
            locale={locale}
            setExtensionUpdatePolicy={setExtensionUpdatePolicy}
            t={t}
            toast={toast}
            updateProviderTransition={updateProviderTransition}
          />
        </Suspense>
      )}
    </div>
  );
}
