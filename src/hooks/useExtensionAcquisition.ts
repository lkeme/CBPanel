import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";

import {
  createExtensionAcquisitionClient,
  extensionAcquisitionClient,
  type ExtensionAcquisitionClient,
  type ExtensionAcquisitionConfirmationResult,
} from "../lib/extensionAcquisitionClient";
import type { ExtensionEntity } from "../shared/entities";
import {
  EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  classifyExtensionReference,
  isCanonicalChromeExtensionId,
  type ExtensionAcquisitionCapabilityId,
  type ExtensionAcquisitionSessionConfirmRequest,
  type ExtensionAcquisitionSessionCreateRequest,
  type ExtensionAcquisitionSessionView,
  type ExtensionArtifactProviderId,
  type ExtensionCatalogItem,
} from "../shared/extensionAcquisition";
import type { AppSettings, ExtensionAcquisitionSettings } from "../shared/settings";
import {
  artifactProviderEnabled,
  capabilitySettingPatch,
  createInitialExtensionAcquisitionState,
  extensionAcquisitionReducer,
  preferredArtifactProvider,
  sessionViewNeedsPolling,
  type ExtensionAcquisitionFailure,
  type ExtensionAcquisitionState,
} from "./extensionAcquisitionState";

const DEFAULT_SESSION_POLL_INTERVAL_MS = 500;

export type PersistExtensionAcquisitionSettings = (
  patch: Partial<ExtensionAcquisitionSettings>,
  signal?: AbortSignal,
) => Promise<AppSettings | ExtensionAcquisitionSettings | void>;

export interface ExtensionAcquisitionControllerOptions {
  settings: ExtensionAcquisitionSettings;
  client?: ExtensionAcquisitionClient;
  persistSettings?: PersistExtensionAcquisitionSettings;
  reloadState: () => Promise<unknown>;
  pollIntervalMs?: number;
  pollDelay?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => string;
}

export interface UseExtensionAcquisitionOptions extends ExtensionAcquisitionControllerOptions {
  autoLoadCapabilities?: boolean;
}

export interface ExtensionAcquisitionController {
  getState(): ExtensionAcquisitionState;
  subscribe(listener: () => void): () => void;
  activate(): void;
  dispose(): void;
  updateOptions(options: ExtensionAcquisitionControllerOptions): void;
  syncSettings(settings: ExtensionAcquisitionSettings): void;
  setInput(input: string): void;
  refreshCapabilities(): Promise<void>;
  submit(input?: string): Promise<void>;
  loadMore(): Promise<void>;
  retryDiscovery(): Promise<void>;
  cancelDiscovery(): void;
  acceptDisclosure(): Promise<boolean>;
  dismissDisclosure(): void;
  setCapabilityEnabled(capabilityId: ExtensionAcquisitionCapabilityId, enabled: boolean): Promise<boolean>;
  selectCatalogItem(item: ExtensionCatalogItem): boolean;
  selectProvider(providerId: ExtensionArtifactProviderId): boolean;
  startSession(request: ExtensionAcquisitionSessionCreateRequest): Promise<ExtensionAcquisitionSessionView | undefined>;
  startSelectedSession(options?: {
    purpose?: ExtensionAcquisitionSessionCreateRequest["purpose"];
    targetExtensionId?: string;
  }): Promise<ExtensionAcquisitionSessionView | undefined>;
  retrySession(): Promise<ExtensionAcquisitionSessionView | undefined>;
  restartWithSelectedProvider(): Promise<ExtensionAcquisitionSessionView | undefined>;
  cancelSession(): Promise<ExtensionAcquisitionSessionView | undefined>;
  confirm(request: ExtensionAcquisitionSessionConfirmRequest): Promise<ExtensionAcquisitionConfirmationResult | undefined>;
  retryStateRefresh(): Promise<boolean>;
  transitionUpdateProvider(
    extensionId: string,
    previousProviderId: ExtensionArtifactProviderId,
    requestedProviderId: ExtensionArtifactProviderId,
  ): Promise<ExtensionEntity | undefined>;
  reset(): void;
}

export type UseExtensionAcquisitionResult = {
  state: ExtensionAcquisitionState;
} & Pick<
  ExtensionAcquisitionController,
  | "setInput"
  | "refreshCapabilities"
  | "submit"
  | "loadMore"
  | "retryDiscovery"
  | "cancelDiscovery"
  | "acceptDisclosure"
  | "dismissDisclosure"
  | "setCapabilityEnabled"
  | "selectCatalogItem"
  | "selectProvider"
  | "startSession"
  | "startSelectedSession"
  | "retrySession"
  | "restartWithSelectedProvider"
  | "cancelSession"
  | "confirm"
  | "retryStateRefresh"
  | "transitionUpdateProvider"
  | "reset"
>;

export function createExtensionAcquisitionController(
  initialOptions: ExtensionAcquisitionControllerOptions,
): ExtensionAcquisitionController {
  return new ExtensionAcquisitionControllerImpl(initialOptions);
}

export function useExtensionAcquisition(options: UseExtensionAcquisitionOptions): UseExtensionAcquisitionResult {
  const controllerRef = useRef<ExtensionAcquisitionController | null>(null);
  if (!controllerRef.current) controllerRef.current = createExtensionAcquisitionController(options);
  const controller = controllerRef.current;
  controller.updateOptions(options);

  const state = useSyncExternalStore(controller.subscribe, controller.getState, controller.getState);

  useEffect(() => {
    controller.activate();
    return () => controller.dispose();
  }, [controller]);

  useEffect(() => {
    controller.syncSettings(options.settings);
  }, [
    controller,
    options.settings.crxsosoSearchEnabled,
    options.settings.googleArtifactEnabled,
    options.settings.crxsosoArtifactEnabled,
    options.settings.crxsosoDisclosureVersionAccepted,
  ]);

  useEffect(() => {
    if (options.autoLoadCapabilities !== false) void controller.refreshCapabilities();
  }, [controller, options.autoLoadCapabilities]);

  return useMemo(() => ({
    state,
    setInput: controller.setInput,
    refreshCapabilities: controller.refreshCapabilities,
    submit: controller.submit,
    loadMore: controller.loadMore,
    retryDiscovery: controller.retryDiscovery,
    cancelDiscovery: controller.cancelDiscovery,
    acceptDisclosure: controller.acceptDisclosure,
    dismissDisclosure: controller.dismissDisclosure,
    setCapabilityEnabled: controller.setCapabilityEnabled,
    selectCatalogItem: controller.selectCatalogItem,
    selectProvider: controller.selectProvider,
    startSession: controller.startSession,
    startSelectedSession: controller.startSelectedSession,
    retrySession: controller.retrySession,
    restartWithSelectedProvider: controller.restartWithSelectedProvider,
    cancelSession: controller.cancelSession,
    confirm: controller.confirm,
    retryStateRefresh: controller.retryStateRefresh,
    transitionUpdateProvider: controller.transitionUpdateProvider,
    reset: controller.reset,
  }), [controller, state]);
}

class ExtensionAcquisitionControllerImpl implements ExtensionAcquisitionController {
  private state: ExtensionAcquisitionState;

  private options: Required<Pick<ExtensionAcquisitionControllerOptions, "reloadState">>
    & Omit<ExtensionAcquisitionControllerOptions, "client" | "reloadState">
    & { client: ExtensionAcquisitionClient };

  private readonly listeners = new Set<() => void>();

  private sequence = 0;

  private suspended = false;

  private capabilitiesController?: AbortController;

  private discoveryController?: AbortController;

  private sessionController?: AbortController;

  private updateProviderController?: AbortController;

  private settingsController?: AbortController;

  private settingsTail: Promise<unknown> = Promise.resolve();

  private confirmInFlight?: Promise<ExtensionAcquisitionConfirmationResult | undefined>;

  private refreshStateInFlight?: Promise<boolean>;

  private updateProviderInFlight?: Promise<ExtensionEntity | undefined>;

  constructor(options: ExtensionAcquisitionControllerOptions) {
    this.options = normalizeControllerOptions(options);
    this.state = createInitialExtensionAcquisitionState(options.settings);
  }

  readonly getState = (): ExtensionAcquisitionState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  readonly activate = (): void => {
    this.suspended = false;
  };

  readonly dispose = (): void => {
    this.suspended = true;
    abortRequest(this.capabilitiesController);
    abortRequest(this.discoveryController);
    abortRequest(this.sessionController);
    abortRequest(this.updateProviderController);
    abortRequest(this.settingsController);
    this.capabilitiesController = undefined;
    this.discoveryController = undefined;
    this.sessionController = undefined;
    this.updateProviderController = undefined;
    this.settingsController = undefined;
  };

  readonly updateOptions = (options: ExtensionAcquisitionControllerOptions): void => {
    this.options = normalizeControllerOptions(options);
  };

  readonly syncSettings = (settings: ExtensionAcquisitionSettings): void => {
    if (sameSettings(this.state.settings, settings)) return;
    if (!settings.crxsosoSearchEnabled && this.discoveryIsSearching()) this.cancelDiscovery();
    this.dispatch({ type: "settings-synced", settings });
  };

  readonly setInput = (input: string): void => {
    this.dispatch({ type: "input-changed", input });
  };

  readonly refreshCapabilities = async (): Promise<void> => {
    if (this.suspended) return;
    abortRequest(this.capabilitiesController);
    const controller = new AbortController();
    this.capabilitiesController = controller;
    const sequence = this.nextSequence();
    const client = this.options.client;
    this.dispatch({ type: "capabilities-requested", sequence });
    try {
      const items = await client.capabilities(controller.signal);
      if (!this.isCurrentCapabilities(sequence, controller)) return;
      this.dispatch({ type: "capabilities-loaded", sequence, items });
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentCapabilities(sequence, controller)) return;
      this.dispatch({ type: "capabilities-failed", sequence, error: acquisitionFailure(error) });
    } finally {
      if (this.capabilitiesController === controller) this.capabilitiesController = undefined;
    }
  };

  readonly submit = async (input = this.state.input): Promise<void> => {
    if (this.suspended) return;
    const reference = classifyExtensionReference(input);
    if (reference.kind === "invalid") {
      this.failDiscoveryLocally("resolve", input, localAcquisitionFailure(reference.code));
      return;
    }
    if (reference.kind === "keyword") {
      if (!this.state.settings.crxsosoSearchEnabled) {
        this.failDiscoveryLocally("search", reference.query, localAcquisitionFailure("CATALOG_SEARCH_DISABLED"));
        return;
      }
      if (
        this.state.settings.crxsosoDisclosureVersionAccepted
        < EXTENSION_ACQUISITION_DISCLOSURE_VERSION
      ) {
        this.dispatch({ type: "disclosure-required", query: reference.query });
        return;
      }
      await this.runSearch(reference.query, undefined, false);
      return;
    }
    if (!this.anyArtifactProviderEnabled()) {
      this.failDiscoveryLocally("resolve", input, localAcquisitionFailure("REMOTE_ACQUISITION_DISABLED"));
      return;
    }
    await this.runResolution(input);
  };

  readonly loadMore = async (): Promise<void> => {
    const page = this.state.discovery.page;
    if (
      this.state.discovery.kind !== "search"
      || !page?.hasMore
      || !page.cursor
      || this.discoveryRequestActive()
    ) return;
    await this.runSearch(page.query, page.cursor, true);
  };

  readonly retryDiscovery = async (): Promise<void> => {
    if (this.discoveryRequestActive()) return;
    const discovery = this.state.discovery;
    if (discovery.kind === "search") {
      if (discovery.page?.hasMore && discovery.page.cursor) {
        await this.runSearch(discovery.page.query, discovery.page.cursor, true);
      } else if (discovery.submittedInput) {
        await this.runSearch(discovery.submittedInput, undefined, false);
      }
      return;
    }
    if (discovery.kind === "resolve" && discovery.submittedInput) {
      await this.runResolution(discovery.submittedInput);
    }
  };

  readonly cancelDiscovery = (): void => {
    if (!this.discoveryRequestActive() && !this.discoveryController) return;
    abortRequest(this.discoveryController);
    this.discoveryController = undefined;
    this.dispatch({ type: "discovery-cancelled", sequence: this.nextSequence() });
  };

  readonly acceptDisclosure = async (): Promise<boolean> => {
    const query = this.state.disclosure.pendingQuery;
    if (!query) return false;
    if (
      this.state.settings.crxsosoDisclosureVersionAccepted
      >= EXTENSION_ACQUISITION_DISCLOSURE_VERSION
    ) {
      this.dispatch({ type: "disclosure-dismissed" });
      await this.runSearch(query, undefined, false);
      return true;
    }
    const saved = await this.persistSettingsPatch({
      crxsosoDisclosureVersionAccepted: EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
    });
    if (!saved || this.suspended) return false;
    await this.runSearch(query, undefined, false);
    return true;
  };

  readonly dismissDisclosure = (): void => {
    this.dispatch({ type: "disclosure-dismissed" });
  };

  readonly setCapabilityEnabled = async (
    capabilityId: ExtensionAcquisitionCapabilityId,
    enabled: boolean,
  ): Promise<boolean> => {
    if (capabilityId === "crxsoso-search" && !enabled && this.discoveryIsSearching()) {
      this.cancelDiscovery();
    }
    return this.persistSettingsPatch(capabilitySettingPatch(capabilityId, enabled));
  };

  readonly selectCatalogItem = (item: ExtensionCatalogItem): boolean => {
    const known = this.state.discovery.page?.items.find((candidate) => (
      candidate.storeId === item.storeId
      && candidate.observationId === item.observationId
    ));
    if (!known) return false;
    this.dispatch({
      type: "catalog-item-selected",
      item: known,
      selectedProviderId: preferredArtifactProvider(this.state.settings),
    });
    return true;
  };

  readonly selectProvider = (providerId: ExtensionArtifactProviderId): boolean => {
    if (!artifactProviderEnabled(this.state.settings, providerId)) return false;
    const offers = this.state.selection?.resolution?.offers;
    if (offers && !offers.some((offer) => offer.artifactProviderId === providerId)) return false;
    this.dispatch({ type: "provider-selected", providerId });
    return true;
  };

  readonly startSelectedSession = async (options: {
    purpose?: ExtensionAcquisitionSessionCreateRequest["purpose"];
    targetExtensionId?: string;
  } = {}): Promise<ExtensionAcquisitionSessionView | undefined> => {
    const selection = this.state.selection;
    const providerId = this.state.selectedProviderId;
    if (!selection || !providerId) {
      this.failSessionLocally(localAcquisitionFailure("ACQUISITION_PROVIDER_SELECTION_REQUIRED"));
      return undefined;
    }
    return this.startSession({
      namespace: "chrome-web-store",
      storeId: selection.storeId,
      artifactProviderId: providerId,
      purpose: options.purpose ?? "install",
      ...(options.targetExtensionId ? { targetExtensionId: options.targetExtensionId } : {}),
      ...(selection.catalogObservationId ? { catalogObservationId: selection.catalogObservationId } : {}),
    });
  };

  readonly startSession = async (
    request: ExtensionAcquisitionSessionCreateRequest,
  ): Promise<ExtensionAcquisitionSessionView | undefined> => {
    if (this.suspended) return undefined;
    if (!isCanonicalChromeExtensionId(request.storeId) || request.namespace !== "chrome-web-store") {
      this.failSessionLocally(localAcquisitionFailure("ACQUISITION_INPUT_UNSUPPORTED"));
      return undefined;
    }
    if (!artifactProviderEnabled(this.state.settings, request.artifactProviderId)) {
      this.failSessionLocally(localAcquisitionFailure("ARTIFACT_CHANNEL_DISABLED"), request);
      return undefined;
    }
    if (this.sessionBlocksReplacement()) {
      this.failSessionLocally(localAcquisitionFailure("ACQUISITION_SESSION_ACTIVE"));
      return undefined;
    }

    abortRequest(this.sessionController);
    const controller = new AbortController();
    this.sessionController = controller;
    const sequence = this.nextSequence();
    const client = this.options.client;
    this.dispatch({ type: "provider-selected", providerId: request.artifactProviderId });
    this.dispatch({ type: "session-requested", sequence, request });
    try {
      const view = await client.createSession(request, controller.signal);
      if (!this.isCurrentSession(sequence, controller)) {
        void client.cancelSession(view.sessionId).catch(() => undefined);
        return undefined;
      }
      this.dispatch({ type: "session-view-received", sequence, view });
      this.observeArtifactHealth(view);
      if (sessionViewNeedsPolling(view)) void this.pollSession(sequence, view.sessionId, controller, false);
      return view;
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentSession(sequence, controller)) return undefined;
      this.dispatch({ type: "session-failed", sequence, error: acquisitionFailure(error) });
      return undefined;
    }
  };

  readonly retrySession = async (): Promise<ExtensionAcquisitionSessionView | undefined> => {
    const { view, lastRequest } = this.state.session;
    if (view && sessionViewNeedsPolling(view)) {
      abortRequest(this.sessionController);
      const controller = new AbortController();
      this.sessionController = controller;
      const sequence = this.nextSequence();
      this.dispatch({ type: "session-resumed", sequence });
      void this.pollSession(sequence, view.sessionId, controller, true);
      return view;
    }
    if (!lastRequest) return undefined;
    return this.startSession(lastRequest);
  };

  readonly restartWithSelectedProvider = async (): Promise<ExtensionAcquisitionSessionView | undefined> => {
    const request = this.state.session.lastRequest;
    const providerId = this.state.selectedProviderId;
    if (!request || !providerId) return undefined;
    return this.startSession({ ...request, artifactProviderId: providerId });
  };

  readonly cancelSession = async (): Promise<ExtensionAcquisitionSessionView | undefined> => {
    const view = this.state.session.view;
    abortRequest(this.sessionController);
    this.sessionController = undefined;
    const sequence = this.nextSequence();
    this.dispatch({ type: "session-cancel-requested", sequence });
    if (!view) {
      this.dispatch({
        type: "session-failed",
        sequence,
        error: localAcquisitionFailure("ACQUISITION_REQUEST_CANCELLED"),
      });
      return undefined;
    }
    if (view.status === "consumed" || view.status === "cancelled" || view.status === "expired") {
      this.dispatch({ type: "session-view-received", sequence, view });
      return view;
    }
    const controller = new AbortController();
    this.sessionController = controller;
    const client = this.options.client;
    try {
      const cancelled = await client.cancelSession(view.sessionId, controller.signal);
      if (!this.isCurrentSession(sequence, controller)) return undefined;
      this.dispatch({ type: "session-view-received", sequence, view: cancelled });
      return cancelled;
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentSession(sequence, controller)) return undefined;
      this.dispatch({ type: "session-failed", sequence, error: acquisitionFailure(error) });
      return undefined;
    }
  };

  readonly confirm = (
    request: ExtensionAcquisitionSessionConfirmRequest,
  ): Promise<ExtensionAcquisitionConfirmationResult | undefined> => {
    if (this.confirmInFlight) return this.confirmInFlight;
    const pending = this.confirmNow(request);
    this.confirmInFlight = pending;
    void pending.then(() => {
      if (this.confirmInFlight === pending) this.confirmInFlight = undefined;
    }, () => {
      if (this.confirmInFlight === pending) this.confirmInFlight = undefined;
    });
    return pending;
  };

  readonly retryStateRefresh = (): Promise<boolean> => {
    if (this.refreshStateInFlight) return this.refreshStateInFlight;
    const pending = this.retryStateRefreshNow();
    this.refreshStateInFlight = pending;
    void pending.then(() => {
      if (this.refreshStateInFlight === pending) this.refreshStateInFlight = undefined;
    }, () => {
      if (this.refreshStateInFlight === pending) this.refreshStateInFlight = undefined;
    });
    return pending;
  };

  readonly transitionUpdateProvider = (
    extensionId: string,
    previousProviderId: ExtensionArtifactProviderId,
    requestedProviderId: ExtensionArtifactProviderId,
  ): Promise<ExtensionEntity | undefined> => {
    if (previousProviderId === requestedProviderId) return Promise.resolve(undefined);
    if (this.updateProviderInFlight) return this.updateProviderInFlight;
    const pending = this.transitionUpdateProviderNow(extensionId, previousProviderId, requestedProviderId);
    this.updateProviderInFlight = pending;
    void pending.then(() => {
      if (this.updateProviderInFlight === pending) this.updateProviderInFlight = undefined;
    }, () => {
      if (this.updateProviderInFlight === pending) this.updateProviderInFlight = undefined;
    });
    return pending;
  };

  readonly reset = (): void => {
    this.cancelDiscovery();
    abortRequest(this.sessionController);
    this.sessionController = undefined;
    this.dispatch({ type: "reset-workflow" });
  };

  private dispatch(action: Parameters<typeof extensionAcquisitionReducer>[1]): void {
    if (this.suspended) return;
    const next = extensionAcquisitionReducer(this.state, action);
    if (next === this.state) return;
    this.state = next;
    for (const listener of this.listeners) listener();
  }

  private async runSearch(query: string, cursor: string | undefined, append: boolean): Promise<void> {
    if (this.suspended) return;
    if (!this.state.settings.crxsosoSearchEnabled) {
      this.failDiscoveryLocally("search", query, localAcquisitionFailure("CATALOG_SEARCH_DISABLED"), append);
      return;
    }
    if (
      this.state.settings.crxsosoDisclosureVersionAccepted
      < EXTENSION_ACQUISITION_DISCLOSURE_VERSION
    ) {
      this.dispatch({ type: "disclosure-required", query });
      return;
    }
    abortRequest(this.discoveryController);
    const controller = new AbortController();
    this.discoveryController = controller;
    const sequence = this.nextSequence();
    const client = this.options.client;
    this.dispatch({ type: "discovery-requested", sequence, kind: "search", submittedInput: query, append });
    try {
      const page = await client.search({ query, ...(cursor ? { cursor } : {}) }, controller.signal);
      if (!this.isCurrentDiscovery(sequence, controller)) return;
      this.dispatch({ type: "search-loaded", sequence, page, append });
      this.dispatch({
        type: "capability-health-observed",
        capabilityId: "crxsoso-search",
        status: "healthy",
        checkedAt: this.options.now?.() ?? new Date().toISOString(),
      });
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentDiscovery(sequence, controller)) return;
      const failure = acquisitionFailure(error);
      this.dispatch({ type: "discovery-failed", sequence, error: failure });
      this.dispatch({
        type: "capability-health-observed",
        capabilityId: "crxsoso-search",
        status: "unavailable",
        checkedAt: this.options.now?.() ?? new Date().toISOString(),
      });
    } finally {
      if (this.discoveryController === controller) this.discoveryController = undefined;
    }
  }

  private async runResolution(input: string): Promise<void> {
    if (this.suspended) return;
    const reference = classifyExtensionReference(input);
    if (reference.kind !== "canonical") {
      this.failDiscoveryLocally(
        "resolve",
        input,
        localAcquisitionFailure(reference.kind === "invalid" ? reference.code : "ACQUISITION_INPUT_UNSUPPORTED"),
      );
      return;
    }
    if (!this.anyArtifactProviderEnabled()) {
      this.failDiscoveryLocally("resolve", input, localAcquisitionFailure("REMOTE_ACQUISITION_DISABLED"));
      return;
    }
    abortRequest(this.discoveryController);
    const controller = new AbortController();
    this.discoveryController = controller;
    const sequence = this.nextSequence();
    const client = this.options.client;
    this.dispatch({ type: "discovery-requested", sequence, kind: "resolve", submittedInput: input, append: false });
    try {
      const resolution = await client.resolve({ input }, controller.signal);
      if (!this.isCurrentDiscovery(sequence, controller)) return;
      this.dispatch({
        type: "reference-resolved",
        sequence,
        resolution,
        selectedProviderId: preferredArtifactProvider(this.state.settings, resolution.offers),
      });
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentDiscovery(sequence, controller)) return;
      this.dispatch({ type: "discovery-failed", sequence, error: acquisitionFailure(error) });
    } finally {
      if (this.discoveryController === controller) this.discoveryController = undefined;
    }
  }

  private persistSettingsPatch(patch: Partial<ExtensionAcquisitionSettings>): Promise<boolean> {
    const run = this.settingsTail.then(async () => {
      if (this.suspended) return false;
      const previous = this.state.settings;
      const optimistic = { ...previous, ...patch };
      const sequence = this.nextSequence();
      const controller = new AbortController();
      this.settingsController = controller;
      this.dispatch({ type: "settings-requested", sequence, settings: optimistic });
      try {
        const persisted = this.options.persistSettings
          ? await this.options.persistSettings(patch, controller.signal)
          : await this.options.client.saveSettings(patch, controller.signal);
        if (controller.signal.aborted || this.suspended) return false;
        const settings = persistedAcquisitionSettings(persisted, optimistic);
        this.dispatch({ type: "settings-saved", sequence, settings });
        void this.refreshCapabilities();
        return true;
      } catch (error) {
        if (controller.signal.aborted || this.suspended) return false;
        this.dispatch({ type: "settings-failed", sequence, settings: previous, error: acquisitionFailure(error) });
        return false;
      } finally {
        if (this.settingsController === controller) this.settingsController = undefined;
      }
    });
    this.settingsTail = run.catch(() => undefined);
    return run;
  }

  private async pollSession(
    sequence: number,
    sessionId: string,
    controller: AbortController,
    immediate: boolean,
  ): Promise<void> {
    let requestImmediately = immediate;
    const client = this.options.client;
    try {
      while (this.isCurrentSession(sequence, controller)) {
        if (!requestImmediately) {
          await (this.options.pollDelay ?? abortableDelay)(
            this.options.pollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS,
            controller.signal,
          );
        }
        requestImmediately = false;
        if (!this.isCurrentSession(sequence, controller)) return;
        const view = await client.getSession(sessionId, controller.signal);
        if (!this.isCurrentSession(sequence, controller)) return;
        this.dispatch({ type: "session-view-received", sequence, view });
        this.observeArtifactHealth(view);
        if (!sessionViewNeedsPolling(view)) return;
      }
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentSession(sequence, controller)) return;
      this.dispatch({ type: "session-failed", sequence, error: acquisitionFailure(error) });
    }
  }

  private async confirmNow(
    request: ExtensionAcquisitionSessionConfirmRequest,
  ): Promise<ExtensionAcquisitionConfirmationResult | undefined> {
    const view = this.state.session.view;
    if (!view || view.status !== "ready") {
      this.failSessionLocally(localAcquisitionFailure("ACQUISITION_CONFIRMATION_NOT_READY"));
      return undefined;
    }
    abortRequest(this.sessionController);
    const controller = new AbortController();
    this.sessionController = controller;
    const sequence = this.nextSequence();
    const client = this.options.client;
    const reloadState = this.options.reloadState;
    this.dispatch({ type: "session-confirm-requested", sequence });
    try {
      const result = await client.confirmSession(view.sessionId, request, controller.signal);
      if (!this.isCurrentSession(sequence, controller)) return undefined;
      this.dispatch({ type: "session-confirmed", sequence, result });
      try {
        await reloadState();
      } catch (error) {
        if (this.isCurrentSession(sequence, controller)) {
          this.dispatch({ type: "session-refresh-failed", sequence, error: {
            ...acquisitionFailure(error),
            code: "ACQUISITION_STATE_REFRESH_FAILED",
          } });
        }
      }
      return result;
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentSession(sequence, controller)) return undefined;
      this.dispatch({ type: "session-failed", sequence, error: acquisitionFailure(error) });
      return undefined;
    }
  }

  private async retryStateRefreshNow(): Promise<boolean> {
    const session = this.state.session;
    if (!session.refreshError || session.view?.status !== "consumed") return false;
    const sequence = session.sequence;
    const reloadState = this.options.reloadState;
    this.dispatch({ type: "session-refresh-requested", sequence });
    try {
      await reloadState();
      if (!this.isCurrentSessionRefresh(sequence)) return false;
      this.dispatch({ type: "session-refresh-succeeded", sequence });
      return true;
    } catch (error) {
      if (!this.isCurrentSessionRefresh(sequence)) return false;
      this.dispatch({
        type: "session-refresh-failed",
        sequence,
        error: { ...acquisitionFailure(error), code: "ACQUISITION_STATE_REFRESH_FAILED" },
      });
      return false;
    }
  }

  private async transitionUpdateProviderNow(
    extensionId: string,
    previousProviderId: ExtensionArtifactProviderId,
    requestedProviderId: ExtensionArtifactProviderId,
  ): Promise<ExtensionEntity | undefined> {
    if (!artifactProviderEnabled(this.state.settings, requestedProviderId)) {
      const sequence = this.nextSequence();
      this.dispatch({
        type: "update-provider-requested",
        sequence,
        extensionId,
        previousProviderId,
        requestedProviderId,
      });
      this.dispatch({
        type: "update-provider-failed",
        sequence,
        error: localAcquisitionFailure("ARTIFACT_CHANNEL_DISABLED"),
      });
      return undefined;
    }
    abortRequest(this.updateProviderController);
    const controller = new AbortController();
    this.updateProviderController = controller;
    const sequence = this.nextSequence();
    const client = this.options.client;
    const reloadState = this.options.reloadState;
    this.dispatch({
      type: "update-provider-requested",
      sequence,
      extensionId,
      previousProviderId,
      requestedProviderId,
    });
    try {
      const extension = await client.transitionUpdateProvider(extensionId, requestedProviderId, controller.signal);
      if (!this.isCurrentUpdateProvider(sequence, controller)) return undefined;
      this.dispatch({ type: "update-provider-saved", sequence, extension });
      try {
        await reloadState();
      } catch (error) {
        if (this.isCurrentUpdateProvider(sequence, controller)) {
          this.dispatch({
            type: "update-provider-refresh-failed",
            sequence,
            error: { ...acquisitionFailure(error), code: "ACQUISITION_STATE_REFRESH_FAILED" },
          });
        }
      }
      return extension;
    } catch (error) {
      if (controller.signal.aborted || !this.isCurrentUpdateProvider(sequence, controller)) return undefined;
      this.dispatch({ type: "update-provider-failed", sequence, error: acquisitionFailure(error) });
      return undefined;
    } finally {
      if (this.updateProviderController === controller) this.updateProviderController = undefined;
    }
  }

  private failDiscoveryLocally(
    kind: "search" | "resolve",
    submittedInput: string,
    error: ExtensionAcquisitionFailure,
    append = false,
  ): void {
    abortRequest(this.discoveryController);
    this.discoveryController = undefined;
    const sequence = this.nextSequence();
    this.dispatch({ type: "discovery-requested", sequence, kind, submittedInput, append });
    this.dispatch({ type: "discovery-failed", sequence, error });
  }

  private failSessionLocally(
    error: ExtensionAcquisitionFailure,
    request?: ExtensionAcquisitionSessionCreateRequest,
  ): void {
    const sequence = this.nextSequence();
    if (request) {
      this.dispatch({ type: "session-requested", sequence, request });
    } else {
      this.dispatch({ type: "session-resumed", sequence });
    }
    this.dispatch({ type: "session-failed", sequence, error });
  }

  private observeArtifactHealth(view: ExtensionAcquisitionSessionView): void {
    const capabilityId = view.selectedProviderId === "chrome-web-store" ? "google-artifact" : "crxsoso-artifact";
    if (view.status === "ready" || view.status === "consumed") {
      this.dispatch({
        type: "capability-health-observed",
        capabilityId,
        status: "healthy",
        checkedAt: view.updatedAt,
      });
    } else if (view.status === "rejected") {
      this.dispatch({
        type: "capability-health-observed",
        capabilityId,
        status: "unavailable",
        checkedAt: view.updatedAt,
        errorCode: view.error?.code,
      });
    }
  }

  private anyArtifactProviderEnabled(): boolean {
    return this.state.settings.googleArtifactEnabled || this.state.settings.crxsosoArtifactEnabled;
  }

  private discoveryRequestActive(): boolean {
    return this.state.discovery.status === "loading" || this.state.discovery.status === "loading-more";
  }

  private discoveryIsSearching(): boolean {
    return this.discoveryRequestActive() && this.state.discovery.kind === "search";
  }

  private sessionBlocksReplacement(): boolean {
    const { operation, view } = this.state.session;
    if (operation === "starting" || operation === "cancelling" || operation === "confirming") return true;
    return Boolean(view && (sessionViewNeedsPolling(view) || view.status === "ready"));
  }

  private nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  private isCurrentCapabilities(sequence: number, controller: AbortController): boolean {
    return !this.suspended
      && this.capabilitiesController === controller
      && this.state.capabilities.sequence === sequence;
  }

  private isCurrentDiscovery(sequence: number, controller: AbortController): boolean {
    return !this.suspended
      && this.discoveryController === controller
      && this.state.discovery.sequence === sequence;
  }

  private isCurrentSession(sequence: number, controller: AbortController): boolean {
    return !this.suspended
      && this.sessionController === controller
      && this.state.session.sequence === sequence;
  }

  private isCurrentUpdateProvider(sequence: number, controller: AbortController): boolean {
    return !this.suspended
      && this.updateProviderController === controller
      && this.state.updateProvider.sequence === sequence;
  }

  private isCurrentSessionRefresh(sequence: number): boolean {
    return !this.suspended
      && this.state.session.sequence === sequence
      && this.state.session.view?.status === "consumed";
  }
}

function normalizeControllerOptions(
  options: ExtensionAcquisitionControllerOptions,
): ExtensionAcquisitionControllerImpl["options"] {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_SESSION_POLL_INTERVAL_MS;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TypeError("Extension acquisition poll interval must be a non-negative finite number.");
  }
  return {
    ...options,
    client: options.client ?? extensionAcquisitionClient,
    pollIntervalMs,
  };
}

function persistedAcquisitionSettings(
  value: AppSettings | ExtensionAcquisitionSettings | void,
  fallback: ExtensionAcquisitionSettings,
): ExtensionAcquisitionSettings {
  if (!value) return { ...fallback };
  const candidate = "extensionAcquisition" in value ? value.extensionAcquisition : value;
  if (
    typeof candidate.crxsosoSearchEnabled !== "boolean"
    || typeof candidate.googleArtifactEnabled !== "boolean"
    || typeof candidate.crxsosoArtifactEnabled !== "boolean"
    || !Number.isSafeInteger(candidate.crxsosoDisclosureVersionAccepted)
  ) return { ...fallback };
  return { ...candidate };
}

function localAcquisitionFailure(code: string): ExtensionAcquisitionFailure {
  return { code, message: code };
}

function acquisitionFailure(error: unknown): ExtensionAcquisitionFailure {
  if (error instanceof Error) {
    const code = typeof (error as { code?: unknown }).code === "string"
      ? (error as unknown as { code: string }).code
      : undefined;
    return { ...(code ? { code } : {}), message: error.message };
  }
  return { message: String(error) };
}

function sameSettings(left: ExtensionAcquisitionSettings, right: ExtensionAcquisitionSettings): boolean {
  return left.crxsosoSearchEnabled === right.crxsosoSearchEnabled
    && left.googleArtifactEnabled === right.googleArtifactEnabled
    && left.crxsosoArtifactEnabled === right.crxsosoArtifactEnabled
    && left.crxsosoDisclosureVersionAccepted === right.crxsosoDisclosureVersionAccepted;
}

function abortRequest(controller: AbortController | undefined): void {
  if (controller && !controller.signal.aborted) {
    controller.abort(new DOMException("Request was aborted", "AbortError"));
  }
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new DOMException("Request was aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason ?? new DOMException("Request was aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

// Kept as an explicit factory alias for consumers that want a fresh client in tests or embedded views.
export { createExtensionAcquisitionClient };
