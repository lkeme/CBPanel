import type { ExtensionEntity } from "../shared/entities";
import {
  classifyExtensionReference,
  selectedExtensionArtifactProvider,
  type ExtensionAcquisitionCapabilityId,
  type ExtensionAcquisitionErrorCode,
  type ExtensionAcquisitionSessionCreateRequest,
  type ExtensionAcquisitionSessionView,
  type ExtensionArtifactProviderId,
  type ExtensionCapabilityView,
  type ExtensionCatalogItem,
  type ExtensionCatalogSearchPage,
  type ExtensionReference,
  type ExtensionReferenceResolution,
} from "../shared/extensionAcquisition";
import type { ExtensionAcquisitionSettings } from "../shared/settings";
import type { ExtensionAcquisitionConfirmationResult } from "../lib/extensionAcquisitionClient";

export type ExtensionAcquisitionLocalErrorCode =
  | "ARTIFACT_CHANNEL_DISABLED"
  | "ACQUISITION_PROVIDER_SELECTION_REQUIRED"
  | "ACQUISITION_CONFIRMATION_NOT_READY"
  | "ACQUISITION_SESSION_ACTIVE"
  | "ACQUISITION_REQUEST_CANCELLED"
  | "ACQUISITION_STATE_REFRESH_FAILED";

export interface ExtensionAcquisitionFailure {
  code?: ExtensionAcquisitionErrorCode | ExtensionAcquisitionLocalErrorCode | string;
  message: string;
}

export type ExtensionAcquisitionDiscoveryStatus =
  | "idle"
  | "loading"
  | "loading-more"
  | "ready"
  | "error"
  | "cancelled";

export interface ExtensionAcquisitionDiscoveryState {
  sequence: number;
  status: ExtensionAcquisitionDiscoveryStatus;
  kind?: "search" | "resolve";
  submittedInput?: string;
  page?: ExtensionCatalogSearchPage;
  resolution?: ExtensionReferenceResolution;
  error?: ExtensionAcquisitionFailure;
}

export interface ExtensionAcquisitionSelection {
  namespace: "chrome-web-store";
  storeId: string;
  storeUrl: string;
  source: "catalog" | "reference";
  catalogObservationId?: string;
  catalogItem?: ExtensionCatalogItem;
  resolution?: ExtensionReferenceResolution;
}

export interface ExtensionAcquisitionCapabilitiesState {
  sequence: number;
  status: "idle" | "loading" | "ready" | "error";
  items: ExtensionCapabilityView[];
  error?: ExtensionAcquisitionFailure;
}

export interface ExtensionAcquisitionSettingsState {
  sequence: number;
  status: "idle" | "saving" | "error";
  error?: ExtensionAcquisitionFailure;
  previousProviderId?: ExtensionArtifactProviderId;
}

export interface ExtensionAcquisitionSessionState {
  sequence: number;
  operation: "idle" | "starting" | "polling" | "cancelling" | "confirming";
  view?: ExtensionAcquisitionSessionView;
  error?: ExtensionAcquisitionFailure;
  lastRequest?: ExtensionAcquisitionSessionCreateRequest;
  confirmation?: ExtensionAcquisitionConfirmationResult;
  refreshError?: ExtensionAcquisitionFailure;
  refreshingState?: boolean;
}

export interface ExtensionUpdateProviderTransitionState {
  sequence: number;
  status: "idle" | "saving" | "success" | "error";
  extensionId?: string;
  previousProviderId?: ExtensionArtifactProviderId;
  requestedProviderId?: ExtensionArtifactProviderId;
  extension?: ExtensionEntity;
  error?: ExtensionAcquisitionFailure;
  refreshError?: ExtensionAcquisitionFailure;
}

export interface ExtensionAcquisitionState {
  input: string;
  classification: ExtensionReference;
  settings: ExtensionAcquisitionSettings;
  settingsRequest: ExtensionAcquisitionSettingsState;
  capabilities: ExtensionAcquisitionCapabilitiesState;
  disclosure: {
    open: boolean;
    pendingQuery?: string;
  };
  discovery: ExtensionAcquisitionDiscoveryState;
  selection?: ExtensionAcquisitionSelection;
  selectedProviderId?: ExtensionArtifactProviderId;
  session: ExtensionAcquisitionSessionState;
  updateProvider: ExtensionUpdateProviderTransitionState;
}

export type ExtensionAcquisitionAction =
  | { type: "input-changed"; input: string }
  | { type: "settings-synced"; settings: ExtensionAcquisitionSettings }
  | {
      type: "settings-requested";
      sequence: number;
      settings: ExtensionAcquisitionSettings;
    }
  | {
      type: "settings-saved";
      sequence: number;
      settings: ExtensionAcquisitionSettings;
    }
  | {
      type: "settings-failed";
      sequence: number;
      settings: ExtensionAcquisitionSettings;
      error: ExtensionAcquisitionFailure;
    }
  | { type: "disclosure-required"; query: string }
  | { type: "disclosure-dismissed" }
  | { type: "capabilities-requested"; sequence: number }
  | { type: "capabilities-loaded"; sequence: number; items: ExtensionCapabilityView[] }
  | { type: "capabilities-failed"; sequence: number; error: ExtensionAcquisitionFailure }
  | {
      type: "capability-health-observed";
      capabilityId: ExtensionAcquisitionCapabilityId;
      status: "healthy" | "unavailable";
      checkedAt: string;
      errorCode?: ExtensionAcquisitionErrorCode;
    }
  | {
      type: "discovery-requested";
      sequence: number;
      kind: "search" | "resolve";
      submittedInput: string;
      append: boolean;
    }
  | {
      type: "search-loaded";
      sequence: number;
      page: ExtensionCatalogSearchPage;
      append: boolean;
    }
  | {
      type: "reference-resolved";
      sequence: number;
      resolution: ExtensionReferenceResolution;
      selectedProviderId?: ExtensionArtifactProviderId;
    }
  | { type: "discovery-failed"; sequence: number; error: ExtensionAcquisitionFailure }
  | { type: "discovery-cancelled"; sequence: number }
  | { type: "catalog-item-selected"; item: ExtensionCatalogItem; selectedProviderId?: ExtensionArtifactProviderId }
  | { type: "catalog-selection-cleared" }
  | { type: "provider-selected"; providerId?: ExtensionArtifactProviderId }
  | {
      type: "session-requested";
      sequence: number;
      request: ExtensionAcquisitionSessionCreateRequest;
    }
  | { type: "session-resumed"; sequence: number }
  | { type: "session-view-received"; sequence: number; view: ExtensionAcquisitionSessionView }
  | { type: "session-failed"; sequence: number; error: ExtensionAcquisitionFailure }
  | { type: "session-cancel-requested"; sequence: number }
  | { type: "session-confirm-requested"; sequence: number }
  | {
      type: "session-confirmed";
      sequence: number;
      result: ExtensionAcquisitionConfirmationResult;
    }
  | { type: "session-refresh-requested"; sequence: number }
  | { type: "session-refresh-succeeded"; sequence: number }
  | { type: "session-refresh-failed"; sequence: number; error: ExtensionAcquisitionFailure }
  | {
      type: "update-provider-requested";
      sequence: number;
      extensionId: string;
      previousProviderId: ExtensionArtifactProviderId;
      requestedProviderId: ExtensionArtifactProviderId;
    }
  | { type: "update-provider-saved"; sequence: number; extension: ExtensionEntity }
  | { type: "update-provider-failed"; sequence: number; error: ExtensionAcquisitionFailure }
  | { type: "update-provider-refresh-failed"; sequence: number; error: ExtensionAcquisitionFailure }
  | { type: "reset-workflow" };

export function createInitialExtensionAcquisitionState(
  settings: ExtensionAcquisitionSettings,
): ExtensionAcquisitionState {
  return {
    input: "",
    classification: classifyExtensionReference(""),
    settings: cloneSettings(settings),
    settingsRequest: { sequence: 0, status: "idle" },
    capabilities: { sequence: 0, status: "idle", items: [] },
    disclosure: { open: false },
    discovery: { sequence: 0, status: "idle" },
    session: { sequence: 0, operation: "idle" },
    updateProvider: { sequence: 0, status: "idle" },
  };
}

export function extensionAcquisitionReducer(
  state: ExtensionAcquisitionState,
  action: ExtensionAcquisitionAction,
): ExtensionAcquisitionState {
  switch (action.type) {
    case "input-changed":
      return {
        ...state,
        input: action.input,
        classification: classifyExtensionReference(action.input),
      };
    case "settings-synced":
      return applySettings(state, action.settings);
    case "settings-requested":
      return {
        ...applySettings(state, action.settings),
        settingsRequest: {
          sequence: action.sequence,
          status: "saving",
          previousProviderId: state.selectedProviderId,
        },
      };
    case "settings-saved":
      if (action.sequence !== state.settingsRequest.sequence) return state;
      return {
        ...applySettings(state, action.settings),
        settingsRequest: { sequence: action.sequence, status: "idle" },
        disclosure: action.settings.crxsosoDisclosureVersionAccepted > 0
          ? { open: false }
          : state.disclosure,
      };
    case "settings-failed":
      if (action.sequence !== state.settingsRequest.sequence) return state;
      return {
        ...applySettings(state, action.settings),
        selectedProviderId: state.settingsRequest.previousProviderId,
        settingsRequest: { sequence: action.sequence, status: "error", error: action.error },
      };
    case "disclosure-required":
      return { ...state, disclosure: { open: true, pendingQuery: action.query } };
    case "disclosure-dismissed":
      return { ...state, disclosure: { open: false } };
    case "capabilities-requested":
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          sequence: action.sequence,
          status: "loading",
          error: undefined,
        },
      };
    case "capabilities-loaded":
      if (action.sequence !== state.capabilities.sequence) return state;
      return {
        ...state,
        capabilities: {
          sequence: action.sequence,
          status: "ready",
          items: mergeCapabilityHealth(state.capabilities.items, action.items),
        },
      };
    case "capabilities-failed":
      if (action.sequence !== state.capabilities.sequence) return state;
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          status: "error",
          error: action.error,
        },
      };
    case "capability-health-observed":
      return {
        ...state,
        capabilities: {
          ...state.capabilities,
          items: state.capabilities.items.map((item) => item.id === action.capabilityId
            ? {
                ...item,
                health: {
                  status: action.status,
                  checkedAt: action.checkedAt,
                  ...(action.errorCode ? { errorCode: action.errorCode } : {}),
                },
              }
            : item),
        },
      };
    case "discovery-requested":
      return {
        ...state,
        discovery: {
          sequence: action.sequence,
          status: action.append ? "loading-more" : "loading",
          kind: action.kind,
          submittedInput: action.submittedInput,
          page: action.append ? state.discovery.page : undefined,
          error: undefined,
        },
        selection: action.append ? state.selection : undefined,
        selectedProviderId: action.append ? state.selectedProviderId : undefined,
      };
    case "search-loaded":
      if (action.sequence !== state.discovery.sequence) return state;
      return {
        ...state,
        discovery: {
          ...state.discovery,
          status: "ready",
          kind: "search",
          page: action.append && state.discovery.page
            ? appendSearchPage(state.discovery.page, action.page)
            : cloneSearchPage(action.page),
          resolution: undefined,
          error: undefined,
        },
      };
    case "reference-resolved":
      if (action.sequence !== state.discovery.sequence) return state;
      return {
        ...state,
        discovery: {
          ...state.discovery,
          status: "ready",
          kind: "resolve",
          page: undefined,
          resolution: cloneResolution(action.resolution),
          error: undefined,
        },
        selection: selectionFromResolution(action.resolution),
        selectedProviderId: action.selectedProviderId,
      };
    case "discovery-failed":
      if (action.sequence !== state.discovery.sequence) return state;
      return {
        ...state,
        discovery: { ...state.discovery, status: "error", error: action.error },
      };
    case "discovery-cancelled":
      if (action.sequence < state.discovery.sequence) return state;
      return {
        ...state,
        discovery: {
          ...state.discovery,
          sequence: action.sequence,
          status: "cancelled",
          error: { code: "ACQUISITION_REQUEST_CANCELLED", message: "ACQUISITION_REQUEST_CANCELLED" },
        },
      };
    case "catalog-item-selected":
      return {
        ...state,
        selection: selectionFromCatalogItem(action.item),
        selectedProviderId: action.selectedProviderId,
      };
    case "catalog-selection-cleared":
      return { ...state, selection: undefined, selectedProviderId: undefined };
    case "provider-selected":
      return { ...state, selectedProviderId: action.providerId };
    case "session-requested":
      return {
        ...state,
        // An installed-row update is not owned by a catalog result selection.
        // Clear stale result identity so its detail/error association cannot
        // hide the newly started update session for another store ID.
        selection: action.request.purpose === "update" ? undefined : state.selection,
        session: {
          sequence: action.sequence,
          operation: "starting",
          lastRequest: { ...action.request },
        },
      };
    case "session-resumed":
      return {
        ...state,
        session: {
          ...state.session,
          sequence: action.sequence,
          operation: "polling",
          error: undefined,
          refreshError: undefined,
          refreshingState: false,
        },
      };
    case "session-view-received":
      if (action.sequence !== state.session.sequence) return state;
      return {
        ...state,
        session: {
          ...state.session,
          operation: sessionViewNeedsPolling(action.view) ? "polling" : "idle",
          view: cloneSessionView(action.view),
          error: action.view.error ? { ...action.view.error } : undefined,
        },
      };
    case "session-failed":
      if (action.sequence !== state.session.sequence) return state;
      return {
        ...state,
        session: { ...state.session, operation: "idle", error: action.error },
      };
    case "session-cancel-requested":
      return {
        ...state,
        session: {
          ...state.session,
          sequence: action.sequence,
          operation: "cancelling",
          error: undefined,
        },
      };
    case "session-confirm-requested":
      return {
        ...state,
        session: {
          ...state.session,
          sequence: action.sequence,
          operation: "confirming",
          error: undefined,
          refreshError: undefined,
          refreshingState: false,
        },
      };
    case "session-confirmed":
      if (action.sequence !== state.session.sequence) return state;
      return {
        ...state,
        session: {
          ...state.session,
          operation: "idle",
          view: cloneSessionView(action.result.session),
          confirmation: action.result,
          error: undefined,
          refreshingState: false,
        },
      };
    case "session-refresh-requested":
      if (action.sequence !== state.session.sequence) return state;
      return {
        ...state,
        session: { ...state.session, refreshingState: true },
      };
    case "session-refresh-succeeded":
      if (action.sequence !== state.session.sequence) return state;
      return {
        ...state,
        session: { ...state.session, refreshingState: false, refreshError: undefined },
      };
    case "session-refresh-failed":
      if (action.sequence !== state.session.sequence) return state;
      return {
        ...state,
        session: { ...state.session, refreshingState: false, refreshError: action.error },
      };
    case "update-provider-requested":
      return {
        ...state,
        updateProvider: {
          sequence: action.sequence,
          status: "saving",
          extensionId: action.extensionId,
          previousProviderId: action.previousProviderId,
          requestedProviderId: action.requestedProviderId,
        },
      };
    case "update-provider-saved":
      if (action.sequence !== state.updateProvider.sequence) return state;
      return {
        ...state,
        updateProvider: {
          ...state.updateProvider,
          status: "success",
          extension: action.extension,
        },
      };
    case "update-provider-failed":
      if (action.sequence !== state.updateProvider.sequence) return state;
      return {
        ...state,
        updateProvider: { ...state.updateProvider, status: "error", error: action.error },
      };
    case "update-provider-refresh-failed":
      if (action.sequence !== state.updateProvider.sequence) return state;
      return {
        ...state,
        updateProvider: { ...state.updateProvider, refreshError: action.error },
      };
    case "reset-workflow":
      return {
        ...createInitialExtensionAcquisitionState(state.settings),
        capabilities: state.capabilities,
        settingsRequest: state.settingsRequest,
      };
  }
}

export function artifactProviderEnabled(
  settings: ExtensionAcquisitionSettings,
  providerId: ExtensionArtifactProviderId,
): boolean {
  return selectedExtensionArtifactProvider(settings) === providerId;
}

export function preferredArtifactProvider(
  settings: ExtensionAcquisitionSettings,
  offers?: ExtensionReferenceResolution["offers"],
): ExtensionArtifactProviderId | undefined {
  const selected = selectedExtensionArtifactProvider(settings);
  // Offers are a point-in-time server projection. The user may switch the
  // single global channel after an exact resolve has returned, in which case
  // that old projection contains only the previous provider. The selected
  // built-in channel remains a valid candidate for the same canonical ID;
  // session creation performs the authoritative availability/verification
  // check. Do not strand the UI in an unselectable state because of stale
  // offers (the parameter is retained for API/source compatibility).
  void offers;
  return selected;
}

export function sessionViewNeedsPolling(view: ExtensionAcquisitionSessionView): boolean {
  return view.status === "created"
    || view.status === "downloading"
    || view.status === "verifying"
    || view.status === "analyzing"
    || view.status === "committing";
}

function applySettings(
  state: ExtensionAcquisitionState,
  settingsInput: ExtensionAcquisitionSettings,
): ExtensionAcquisitionState {
  const settings = cloneSettings(settingsInput);
  const selectedProviderId = state.selection
    ? selectedExtensionArtifactProvider(settings)
    : state.selectedProviderId && artifactProviderEnabled(settings, state.selectedProviderId)
      ? state.selectedProviderId
      : undefined;
  return {
    ...state,
    settings,
    selectedProviderId,
    capabilities: {
      ...state.capabilities,
      items: state.capabilities.items.map((item) => ({
        ...item,
        enabled: capabilityEnabled(settings, item.id),
      })),
    },
  };
}

function capabilityEnabled(
  settings: ExtensionAcquisitionSettings,
  capabilityId: ExtensionAcquisitionCapabilityId,
): boolean {
  switch (capabilityId) {
    case "crxsoso-search":
      return true;
    case "google-artifact":
      return selectedExtensionArtifactProvider(settings) === "chrome-web-store";
    case "crxsoso-artifact":
      return selectedExtensionArtifactProvider(settings) === "crxsoso";
  }
}

function cloneSettings(settings: ExtensionAcquisitionSettings): ExtensionAcquisitionSettings {
  return { ...settings };
}

function mergeCapabilityHealth(
  previous: ExtensionCapabilityView[],
  next: ExtensionCapabilityView[],
): ExtensionCapabilityView[] {
  const previousById = new Map(previous.map((item) => [item.id, item]));
  return next.map((item) => ({
    ...item,
    operations: [...item.operations],
    health: item.health ? { ...item.health } : previousById.get(item.id)?.health,
  }));
}

function appendSearchPage(
  current: ExtensionCatalogSearchPage,
  next: ExtensionCatalogSearchPage,
): ExtensionCatalogSearchPage {
  const items = new Map(current.items.map((item) => [item.storeId, item]));
  for (const item of next.items) items.set(item.storeId, item);
  return {
    query: next.query,
    items: [...items.values()],
    excludedNonCanonicalCount: current.excludedNonCanonicalCount + next.excludedNonCanonicalCount,
    cursor: next.cursor,
    hasMore: next.hasMore,
  };
}

function cloneSearchPage(page: ExtensionCatalogSearchPage): ExtensionCatalogSearchPage {
  return { ...page, items: page.items.map((item) => ({ ...item })) };
}

function cloneResolution(resolution: ExtensionReferenceResolution): ExtensionReferenceResolution {
  return { ...resolution, offers: resolution.offers.map((offer) => ({ ...offer })) };
}

function selectionFromResolution(resolution: ExtensionReferenceResolution): ExtensionAcquisitionSelection {
  return {
    namespace: "chrome-web-store",
    storeId: resolution.storeId,
    storeUrl: resolution.storeUrl,
    source: "reference",
    resolution: cloneResolution(resolution),
  };
}

function selectionFromCatalogItem(item: ExtensionCatalogItem): ExtensionAcquisitionSelection {
  return {
    namespace: "chrome-web-store",
    storeId: item.storeId,
    storeUrl: item.storeUrl,
    source: "catalog",
    catalogObservationId: item.observationId,
    catalogItem: { ...item },
  };
}

function cloneSessionView(view: ExtensionAcquisitionSessionView): ExtensionAcquisitionSessionView {
  return {
    ...view,
    error: view.error ? { ...view.error } : undefined,
    report: view.report
      ? {
          ...view.report,
          identity: { ...view.report.identity },
          package: {
            ...view.report.package,
            icon: view.report.package.icon ? { ...view.report.package.icon } : undefined,
          },
          transport: { ...view.report.transport },
          verification: { ...view.report.verification },
          permissions: [...view.report.permissions],
          hostPermissions: [...view.report.hostPermissions],
          optionalPermissions: [...view.report.optionalPermissions],
          optionalHostPermissions: [...view.report.optionalHostPermissions],
          permissionRisks: view.report.permissionRisks.map((risk) => ({ ...risk })),
          discrepancies: view.report.discrepancies.map((item) => ({ ...item })),
          permissionApproval: view.report.permissionApproval
            ? { ...view.report.permissionApproval, added: [...view.report.permissionApproval.added] }
            : undefined,
          catalog: view.report.catalog ? { ...view.report.catalog } : undefined,
          conflicts: view.report.conflicts.map((candidate) => ({ ...candidate })),
        }
      : undefined,
  };
}
