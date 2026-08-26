import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultProfile,
  type BrowserProfile,
  type PanelState,
  type SessionSummary,
} from "../shared/profile";
import { DEFAULT_APP_SETTINGS } from "../shared/settings";
import { useProfileLifecycleActions } from "./useProfileLifecycleActions";

const PROFILE_ID = "profile-stop-test";
const STARTED_AT = "2026-08-26T08:00:00.000Z";

test("concurrent Stop clicks share one profile-local request", async () => {
  await withBrowserGlobals(async () => {
    let fetchCalls = 0;
    let resolveResponse: (() => void) | undefined;
    globalThis.fetch = ((_input, init) => {
      fetchCalls += 1;
      return new Promise<Response>((resolve, reject) => {
        resolveResponse = () => resolve(jsonResponse(session("stopped")));
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    }) as typeof fetch;
    const pending: boolean[] = [];
    const toasts: string[] = [];
    const stopRequestsRef = { current: new Map() };
    const actions = createActions({
      markStopPending: (_id, value) => pending.push(value),
      stopRequestsRef,
      toast: (_kind, text) => toasts.push(text),
    });

    const first = actions.stopProfile(PROFILE_ID);
    assert.equal(stopRequestsRef.current.size, 1);
    const duplicate = actions.stopProfile(PROFILE_ID);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fetchCalls, 1);
    assert.equal(stopRequestsRef.current.size, 1);
    resolveResponse?.();
    await Promise.all([first, duplicate]);

    assert.equal(fetchCalls, 1);
    assert.deepEqual(pending, [true, false]);
    assert.deepEqual(toasts, ["toast.stopped"]);
    assert.equal(stopRequestsRef.current.size, 0);
  });
});

test("a failed Stop keeps its guard through bounded authoritative reconciliation", async () => {
  await withBrowserGlobals(async () => {
    globalThis.fetch = (async () => {
      throw new Error("stop transport failed");
    }) as typeof fetch;
    const pending: boolean[] = [];
    const stopRequestsRef = { current: new Map() };
    let reconcileCalls = 0;
    let guardedDuringReconcile = false;
    const actions = createActions({
      loadState: async (signal) => {
        reconcileCalls += 1;
        assert.equal(signal?.aborted, false);
        guardedDuringReconcile = stopRequestsRef.current.has(PROFILE_ID)
          && pending.at(-1) === true;
      },
      markStopPending: (_id, value) => pending.push(value),
      stopRequestsRef,
    });

    await actions.stopProfile(PROFILE_ID);

    assert.equal(reconcileCalls, 1);
    assert.equal(guardedDuringReconcile, true);
    assert.deepEqual(pending, [true, false]);
    assert.equal(stopRequestsRef.current.size, 0);
  });
});

test("Stop forwards the pending launch identity so an overtaken server route cannot start later", async () => {
  await withBrowserGlobals(async () => {
    let launchRequestId = "";
    let stopRequestId = "";
    globalThis.fetch = ((_input, init) => {
      const pathname = new URL(String(_input)).pathname;
      const body = JSON.parse(String(init?.body)) as { launchRequestId?: string };
      if (pathname.endsWith("/launch")) {
        launchRequestId = body.launchRequestId ?? "";
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (pathname.endsWith("/stop")) {
        stopRequestId = body.launchRequestId ?? "";
        return Promise.resolve(jsonResponse(session("stopped")));
      }
      throw new Error(`Unexpected request ${pathname}`);
    }) as typeof fetch;
    const profile = defaultProfile({ id: PROFILE_ID, name: "Stop Route Race" });
    const actions = createActions({
      state: panelStateFor(profile),
    });

    const launching = actions.launchProfile(PROFILE_ID);
    assert.match(launchRequestId, /^launch-/);
    const stopping = actions.stopProfile(PROFILE_ID);
    await Promise.all([launching, stopping]);

    assert.equal(stopRequestId, launchRequestId);
  });
});

test("a failed tokened Stop retains the exact cancellation identity and Stop affordance for retry", async () => {
  await withBrowserGlobals(async () => {
    let failStop = true;
    globalThis.fetch = ((_input, init) => {
      const pathname = new URL(String(_input)).pathname;
      if (pathname.endsWith("/launch")) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(init.signal?.reason ?? new DOMException("aborted", "AbortError")),
            { once: true },
          );
        });
      }
      if (pathname.endsWith("/stop")) {
        return failStop
          ? Promise.reject(new Error("stop transport failed"))
          : Promise.resolve(jsonResponse(session("stopped")));
      }
      throw new Error(`Unexpected request ${pathname}`);
    }) as typeof fetch;
    const profile = defaultProfile({ id: PROFILE_ID, name: "Stop Retry Race" });
    const launchRequestsRef: LifecycleOptions["launchRequestsRef"] = { current: new Map() };
    const launchPending: boolean[] = [];
    const actions = createActions({
      launchRequestsRef,
      loadState: async () => undefined,
      markLaunchPending: (_id, value) => launchPending.push(value),
      state: panelStateFor(profile),
    });

    const launching = actions.launchProfile(PROFILE_ID);
    const request = launchRequestsRef.current.get(PROFILE_ID);
    assert.ok(request);
    await actions.stopProfile(PROFILE_ID);

    assert.equal(launchRequestsRef.current.get(PROFILE_ID), request);
    assert.equal(request.cancellationPending, true);
    assert.equal(request.controller.signal.aborted, true);
    assert.deepEqual(launchPending, [true]);

    failStop = false;
    await actions.stopProfile(PROFILE_ID);
    await launching;

    assert.equal(launchRequestsRef.current.size, 0);
    assert.deepEqual(launchPending, [true, false]);
  });
});

type LifecycleOptions = Parameters<typeof useProfileLifecycleActions>[0];

function createActions(overrides: Partial<LifecycleOptions> = {}) {
  const ignore = () => undefined;
  const options: LifecycleOptions = {
    browserCoreMissing: false,
    draft: null,
    draftIsNew: false,
    draftProxyLibraryIds: {},
    launchRequestsRef: { current: new Map() },
    loadState: async () => undefined,
    localProxyDraftIds: new Set(),
    locale: "zh-CN",
    markLaunchPending: ignore,
    markStopPending: ignore,
    reportSettledLaunch: ignore,
    setBusy: ignore,
    setConfirmDialog: ignore,
    setDraft: ignore,
    setDraftIsNew: ignore,
    setDraftProxyLibraryIds: ignore,
    setDrawerMode: ignore,
    setLocalProxyDraftIds: ignore,
    setPreflight: ignore,
    setProxyCheck: ignore,
    setSelectedId: ignore,
    setSelectedIds: ignore,
    setState: ignore,
    setWorkbenchView: ignore,
    state: null,
    stopRequestsRef: { current: new Map() },
    t: (key) => key,
    toast: ignore,
    ...overrides,
  };
  return useProfileLifecycleActions(options);
}

async function withBrowserGlobals(work: () => Promise<void>): Promise<void> {
  const windowDescriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __CBPANEL_API_BASE_URL__: "http://127.0.0.1:4173",
      __CBPANEL_API_TOKEN__: "test-token",
    },
  });
  try {
    await work();
  } finally {
    globalThis.fetch = originalFetch;
    if (windowDescriptor) Object.defineProperty(globalThis, "window", windowDescriptor);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}

function session(status: SessionSummary["status"]): SessionSummary {
  return { profileId: PROFILE_ID, status, startedAt: STARTED_AT };
}

function panelStateFor(profile: BrowserProfile): PanelState {
  return {
    meta: { dataDir: "test-data", profileCount: 1 },
    profiles: [profile],
    sessions: [],
    settings: DEFAULT_APP_SETTINGS,
    storage: {
      kind: "sqlite",
      migratedFromJson: false,
      portable: false,
    },
  };
}
