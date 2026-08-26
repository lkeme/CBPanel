import { createId, type SessionSummary } from "../shared/profile";

export interface ProfileLaunchRequest {
  controller: AbortController;
  requestId: string;
  cancellationPending?: boolean;
  baselineStartedAt?: string;
  observedStartedAt?: string;
}

export interface ProfileStopRequest {
  controller: AbortController;
  timedOut: boolean;
}

export interface AbortableSingleFlight {
  controller: AbortController | null;
  current: Promise<void> | null;
}

export interface SettledProfileLaunch {
  profileId: string;
  session: SessionSummary;
}

export interface ProfileLifecycleActionState {
  canStop: boolean;
  stopPending: boolean;
}

export const SESSION_STATE_POLL_TIMEOUT_MS = 5_000;
export const PROFILE_STOP_REQUEST_TIMEOUT_MS = 10_000;

export type LaunchResponseOutcome =
  | { kind: "pending" }
  | { kind: "running"; tone: "success" | "info"; headless: boolean; message?: string }
  | {
      kind: "terminal";
      tone: "error" | "info";
      status: Exclude<SessionSummary["status"], "launching" | "running">;
      message?: string;
    };

export function registerProfileLaunchRequest(
  requests: Map<string, ProfileLaunchRequest>,
  profileId: string,
  baselineSession?: SessionSummary,
): ProfileLaunchRequest {
  const previous = requests.get(profileId);
  if (previous) previous.controller.abort();
  const request: ProfileLaunchRequest = {
    controller: new AbortController(),
    requestId: createId("launch"),
    baselineStartedAt: baselineSession?.startedAt,
  };
  requests.set(profileId, request);
  return request;
}

export function rekeyProfileLaunchRequest(
  requests: Map<string, ProfileLaunchRequest>,
  previousProfileId: string,
  nextProfileId: string,
  expected: ProfileLaunchRequest,
): boolean {
  if (previousProfileId === nextProfileId) return requests.get(previousProfileId) === expected;
  if (requests.get(previousProfileId) !== expected || requests.has(nextProfileId)) return false;
  requests.delete(previousProfileId);
  requests.set(nextProfileId, expected);
  return true;
}

export function abortProfileLaunchRequest(
  requests: Map<string, ProfileLaunchRequest>,
  profileId: string,
  expected?: ProfileLaunchRequest,
): boolean {
  const request = requests.get(profileId);
  if (!request || (expected && request !== expected)) return false;
  requests.delete(profileId);
  request.controller.abort();
  return true;
}

export function registerProfileStopRequest(
  requests: Map<string, ProfileStopRequest>,
  profileId: string,
): ProfileStopRequest | undefined {
  if (requests.has(profileId)) return undefined;
  const request: ProfileStopRequest = {
    controller: new AbortController(),
    timedOut: false,
  };
  requests.set(profileId, request);
  return request;
}

export function abortProfileStopRequest(
  requests: Map<string, ProfileStopRequest>,
  profileId: string,
  expected?: ProfileStopRequest,
): boolean {
  const request = requests.get(profileId);
  if (!request || (expected && request !== expected)) return false;
  requests.delete(profileId);
  request.controller.abort();
  return true;
}

export function armProfileStopRequestDeadline(
  request: ProfileStopRequest,
  timeoutMs: number,
): () => void {
  const timeout = setTimeout(() => {
    request.timedOut = true;
    request.controller.abort(timeoutError("Stop request timed out"));
  }, Math.max(1, timeoutMs));
  return () => clearTimeout(timeout);
}

export function raceAbortSignal<Result>(
  signal: AbortSignal,
  work: Promise<Result>,
): Promise<Result> {
  if (signal.aborted) {
    return Promise.reject(signal.reason ?? abortError("Request was aborted"));
  }
  return new Promise<Result>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? abortError("Request was aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Reconcile long-running launch HTTP requests from the authoritative session
 * list. A previous terminal session is not evidence about the launch which is
 * currently pending, so a session only becomes authoritative after its
 * `startedAt` advances beyond the request's baseline generation.
 */
export function reconcileProfileLaunchRequests(
  requests: Map<string, ProfileLaunchRequest>,
  sessions: SessionSummary[],
): SettledProfileLaunch[] {
  const sessionsByProfileId = new Map(sessions.map((session) => [session.profileId, session]));
  const settledLaunches: SettledProfileLaunch[] = [];
  for (const [profileId, request] of requests) {
    const session = sessionsByProfileId.get(profileId);
    if (!sessionFromPendingGeneration(request, session)) continue;
    request.observedStartedAt = session?.startedAt;
    if (session?.status === "launching") continue;
    if (
      request.cancellationPending
      && (session?.status === "running" || session?.status === "stopping")
    ) continue;
    requests.delete(profileId);
    request.controller.abort();
    settledLaunches.push({ profileId, session });
  }
  return settledLaunches;
}

export function launchResponseMatchesRequest(
  request: ProfileLaunchRequest,
  session: SessionSummary,
): boolean {
  return sessionFromPendingGeneration(request, session);
}

export function shouldPollProfileSessions(
  sessions: SessionSummary[],
  pendingLaunchCount: number,
  pendingStopCount = 0,
): boolean {
  if (pendingLaunchCount > 0 || pendingStopCount > 0) return true;
  return sessions.some(
    (session) =>
      session.closeUnconfirmed === true
      || session.status === "launching"
      || session.status === "running"
      || session.status === "stopping",
  );
}

export function runAbortableSingleFlight(
  flight: AbortableSingleFlight,
  timeoutMs: number,
  task: (signal: AbortSignal) => Promise<unknown>,
  onError: (error: unknown) => void,
): Promise<void> {
  if (flight.current) return flight.current;
  const controller = new AbortController();
  flight.controller = controller;
  const timeout = setTimeout(() => {
    controller.abort(timeoutError("Session state request timed out"));
  }, Math.max(1, timeoutMs));
  const request = raceAbortSignal(
    controller.signal,
    Promise.resolve().then(() => task(controller.signal)),
  )
    .then(() => undefined)
    .catch(onError)
    .finally(() => {
      clearTimeout(timeout);
      if (flight.current === request) {
        flight.current = null;
        flight.controller = null;
      }
    });
  flight.current = request;
  return request;
}

export function abortSingleFlight(flight: AbortableSingleFlight): void {
  flight.controller?.abort(abortError("Session state polling was stopped"));
}

export function profileLifecycleActionState(
  session: SessionSummary | undefined,
  launchPending: boolean,
  stopRequestPending: boolean,
): ProfileLifecycleActionState {
  const serverCanStop = session?.status === "running"
    || session?.status === "launching"
    || session?.status === "stopping"
    || session?.closeUnconfirmed === true;
  return {
    canStop: launchPending || stopRequestPending || serverCanStop,
    stopPending: stopRequestPending || session?.status === "stopping",
  };
}

export function upsertSessionByGeneration(
  sessions: SessionSummary[],
  incoming: SessionSummary,
): SessionSummary[] {
  const index = sessions.findIndex((session) => session.profileId === incoming.profileId);
  if (index < 0) return [...sessions, incoming];
  const current = sessions[index];
  if (sessionGenerationOrder(incoming, current) < 0) return sessions;
  if (current.startedAt && !incoming.startedAt) return sessions;
  return sessions.map((session, itemIndex) => (itemIndex === index ? incoming : session));
}

export function mergeSessionSnapshotByGeneration(
  current: SessionSummary[],
  incoming: SessionSummary[],
): SessionSummary[] {
  const currentByProfileId = new Map(current.map((session) => [session.profileId, session]));
  const incomingProfileIds = new Set(incoming.map((session) => session.profileId));
  const merged = incoming.map((session) => {
    const existing = currentByProfileId.get(session.profileId);
    if (!existing) return session;
    return upsertSessionByGeneration([existing], session)[0] ?? session;
  });
  // A state request can be sent before the launch reaches the server and arrive after the launch
  // response has already inserted its generation locally. SessionService retains terminal records, so
  // omission here is not a newer tombstone; keep current-only generations until a later snapshot sees
  // them instead of letting an out-of-order full response make a live browser disappear from the UI.
  for (const session of current) {
    if (!incomingProfileIds.has(session.profileId)) merged.push(session);
  }
  return merged;
}

export function launchResponseOutcome(session: SessionSummary): LaunchResponseOutcome {
  if (session.status === "launching") return { kind: "pending" };
  if (session.status === "running") {
    return {
      kind: "running",
      tone: session.lastError ? "info" : "success",
      headless: session.launch?.headless === true,
      message: session.lastError,
    };
  }
  return {
    kind: "terminal",
    tone: session.status === "error" || Boolean(session.lastError) ? "error" : "info",
    status: session.status,
    message: session.lastError,
  };
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && error.name === "AbortError";
}

function sessionFromPendingGeneration(
  request: ProfileLaunchRequest,
  session: SessionSummary | undefined,
): session is SessionSummary {
  if (!session?.startedAt) return false;
  if (request.observedStartedAt) {
    return compareStartedAt(session.startedAt, request.observedStartedAt) >= 0;
  }
  if (!request.baselineStartedAt) return true;
  return compareStartedAt(session.startedAt, request.baselineStartedAt) > 0;
}

function sessionGenerationOrder(incoming: SessionSummary, current: SessionSummary): number {
  if (incoming.startedAt && !current.startedAt) return 1;
  if (!incoming.startedAt && current.startedAt) return -1;
  if (incoming.startedAt && current.startedAt) {
    const generationOrder = compareStartedAt(incoming.startedAt, current.startedAt);
    if (generationOrder !== 0) return generationOrder;
  }
  return sessionStatusOrder(incoming.status) - sessionStatusOrder(current.status);
}

function sessionStatusOrder(status: SessionSummary["status"]): number {
  if (status === "launching") return 0;
  if (status === "running") return 1;
  if (status === "stopping") return 2;
  if (status === "error") return 3;
  return 4;
}

function compareStartedAt(left: string, right: string): number {
  if (left === right) return 0;
  const leftTimestamp = Date.parse(left);
  const rightTimestamp = Date.parse(right);
  if (Number.isFinite(leftTimestamp) && Number.isFinite(rightTimestamp)) {
    return Math.sign(leftTimestamp - rightTimestamp);
  }
  return left.localeCompare(right);
}

function abortError(message: string): DOMException {
  return new DOMException(message, "AbortError");
}

function timeoutError(message: string): DOMException {
  return new DOMException(message, "TimeoutError");
}
