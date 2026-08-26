import assert from "node:assert/strict";
import test from "node:test";

import type { SessionSummary } from "../shared/profile";
import {
  abortProfileLaunchRequest,
  abortProfileStopRequest,
  abortSingleFlight,
  armProfileStopRequestDeadline,
  launchResponseMatchesRequest,
  launchResponseOutcome,
  mergeSessionSnapshotByGeneration,
  profileLifecycleActionState,
  raceAbortSignal,
  reconcileProfileLaunchRequests,
  registerProfileLaunchRequest,
  registerProfileStopRequest,
  rekeyProfileLaunchRequest,
  runAbortableSingleFlight,
  shouldPollProfileSessions,
  upsertSessionByGeneration,
} from "./profileLaunchState";

const FIRST_GENERATION = "2026-08-26T08:00:00.000Z";
const SECOND_GENERATION = "2026-08-26T08:01:00.000Z";
const THIRD_GENERATION = "2026-08-26T08:02:00.000Z";

test("profile launch abort controllers are isolated and identity guarded", () => {
  const requests = new Map();
  const first = registerProfileLaunchRequest(requests, "profile-a");
  const second = registerProfileLaunchRequest(requests, "profile-b");

  assert.equal(abortProfileLaunchRequest(requests, "profile-a", second), false);
  assert.equal(first.controller.signal.aborted, false);
  assert.equal(abortProfileLaunchRequest(requests, "profile-a", first), true);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(second.controller.signal.aborted, false);
  assert.equal(requests.get("profile-b"), second);
});

test("a saved new profile can move its pending request without disturbing another profile", () => {
  const requests = new Map();
  const draft = registerProfileLaunchRequest(requests, "draft-id");
  const other = registerProfileLaunchRequest(requests, "other-id");

  assert.equal(rekeyProfileLaunchRequest(requests, "draft-id", "saved-id", draft), true);
  assert.equal(requests.has("draft-id"), false);
  assert.equal(requests.get("saved-id"), draft);
  assert.equal(requests.get("other-id"), other);
  assert.equal(draft.controller.signal.aborted, false);
});

test("pending reconciliation ignores the previous generation and settles the observed launch generation", () => {
  const requests = new Map();
  const request = registerProfileLaunchRequest(
    requests,
    "profile-a",
    session("profile-a", "stopped", FIRST_GENERATION),
  );

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "stopped", FIRST_GENERATION)]),
    [],
  );
  assert.equal(request.controller.signal.aborted, false);

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "launching", SECOND_GENERATION)]),
    [],
  );
  assert.equal(request.observedStartedAt, SECOND_GENERATION);

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "stopped", FIRST_GENERATION)]),
    [],
  );
  assert.equal(request.controller.signal.aborted, false);

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "error", SECOND_GENERATION)]),
    [{ profileId: "profile-a", session: session("profile-a", "error", SECOND_GENERATION) }],
  );
  assert.equal(request.controller.signal.aborted, true);
  assert.equal(requests.has("profile-a"), false);
  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "error", SECOND_GENERATION)]),
    [],
  );
});

test("polling can own one running launch outcome and suppress the late HTTP owner", () => {
  const requests = new Map();
  const request = registerProfileLaunchRequest(
    requests,
    "profile-a",
    session("profile-a", "stopped", FIRST_GENERATION),
  );
  const running = session("profile-a", "running", SECOND_GENERATION);

  assert.deepEqual(reconcileProfileLaunchRequests(requests, [running]), [
    { profileId: "profile-a", session: running },
  ]);
  assert.equal(request.controller.signal.aborted, true);
  assert.equal(requests.has("profile-a"), false);
  assert.deepEqual(reconcileProfileLaunchRequests(requests, [running]), []);
});

test("a transport-unconfirmed launch cancellation stays pending while the server is still active", () => {
  const requests = new Map();
  const request = registerProfileLaunchRequest(
    requests,
    "profile-a",
    session("profile-a", "stopped", FIRST_GENERATION),
  );
  request.cancellationPending = true;
  request.controller.abort();

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "running", SECOND_GENERATION)]),
    [],
  );
  assert.equal(requests.get("profile-a"), request);
  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "stopped", SECOND_GENERATION)]),
    [{ profileId: "profile-a", session: session("profile-a", "stopped", SECOND_GENERATION) }],
  );
  assert.equal(requests.has("profile-a"), false);
});

test("a terminal generation can settle pending even when polling missed launching", () => {
  const requests = new Map();
  const request = registerProfileLaunchRequest(
    requests,
    "profile-a",
    session("profile-a", "stopped", FIRST_GENERATION),
  );

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "stopped", SECOND_GENERATION)]),
    [{ profileId: "profile-a", session: session("profile-a", "stopped", SECOND_GENERATION) }],
  );
  assert.equal(request.controller.signal.aborted, true);
});

test("a late HTTP response cannot settle a newer generation already observed by polling", () => {
  const requests = new Map();
  const request = registerProfileLaunchRequest(
    requests,
    "profile-a",
    session("profile-a", "stopped", FIRST_GENERATION),
  );

  assert.deepEqual(
    reconcileProfileLaunchRequests(requests, [session("profile-a", "launching", THIRD_GENERATION)]),
    [],
  );
  assert.equal(request.observedStartedAt, THIRD_GENERATION);
  assert.equal(
    launchResponseMatchesRequest(request, session("profile-a", "stopped", SECOND_GENERATION)),
    false,
  );
  assert.equal(
    launchResponseMatchesRequest(request, session("profile-a", "running", THIRD_GENERATION)),
    true,
  );
});

test("session upsert rejects an older launch response and accepts the next generation", () => {
  const current = session("profile-a", "running", SECOND_GENERATION);
  const sessions = [current, session("profile-b", "running", FIRST_GENERATION)];

  assert.equal(
    upsertSessionByGeneration(sessions, session("profile-a", "running", FIRST_GENERATION)),
    sessions,
  );
  assert.equal(
    upsertSessionByGeneration(sessions, { profileId: "profile-a", status: "stopped" }),
    sessions,
  );

  const next = upsertSessionByGeneration(sessions, session("profile-a", "launching", THIRD_GENERATION));
  assert.equal(next[0]?.status, "launching");
  assert.equal(next[0]?.startedAt, THIRD_GENERATION);
  assert.equal(next[1], sessions[1]);
});

test("a timestamped server generation replaces an unversioned synthetic stop", () => {
  const syntheticStop: SessionSummary = {
    profileId: "profile-a",
    status: "stopped",
    stoppedAt: "2026-08-26T08:00:00.000Z",
  };

  assert.deepEqual(
    upsertSessionByGeneration(
      [syntheticStop],
      session("profile-a", "running", SECOND_GENERATION),
    ),
    [session("profile-a", "running", SECOND_GENERATION)],
  );
});

test("a late same-generation launching snapshot cannot revive a terminal session", () => {
  const terminal = session("profile-a", "stopped", SECOND_GENERATION);
  const sessions = [terminal];

  assert.equal(
    upsertSessionByGeneration(sessions, session("profile-a", "launching", SECOND_GENERATION)),
    sessions,
  );
  assert.deepEqual(
    mergeSessionSnapshotByGeneration(sessions, [
      session("profile-a", "launching", SECOND_GENERATION),
      session("profile-b", "running", THIRD_GENERATION),
    ]),
    [terminal, session("profile-b", "running", THIRD_GENERATION)],
  );
});

test("a snapshot started before launch cannot erase a locally observed generation", () => {
  const running = session("profile-a", "running", SECOND_GENERATION);
  const other = session("profile-b", "stopped", FIRST_GENERATION);

  assert.deepEqual(
    mergeSessionSnapshotByGeneration([running], [other]),
    [other, running],
  );
  assert.deepEqual(
    mergeSessionSnapshotByGeneration([running], []),
    [running],
  );
});

test("a confirmed stop is final over same-generation close errors", () => {
  const closeError: SessionSummary = {
    ...session("profile-a", "error", SECOND_GENERATION),
    closeUnconfirmed: true,
    lastError: "browser close was not confirmed",
  };
  const stopped = {
    ...session("profile-a", "stopped", SECOND_GENERATION),
    stoppedAt: THIRD_GENERATION,
  };

  assert.deepEqual(upsertSessionByGeneration([closeError], stopped), [stopped]);
  const confirmed = [stopped];
  assert.equal(upsertSessionByGeneration(confirmed, closeError), confirmed);
  assert.deepEqual(
    mergeSessionSnapshotByGeneration(confirmed, [closeError]),
    confirmed,
  );
});

test("only a healthy running launch response has a success outcome", () => {
  assert.deepEqual(launchResponseOutcome(session("profile-a", "launching", SECOND_GENERATION)), {
    kind: "pending",
  });
  assert.deepEqual(launchResponseOutcome(session("profile-a", "running", SECOND_GENERATION)), {
    kind: "running",
    tone: "success",
    headless: false,
    message: undefined,
  });
  assert.deepEqual(
    launchResponseOutcome({
      ...session("profile-a", "running", SECOND_GENERATION),
      lastError: "started with a warning",
    }),
    {
      kind: "running",
      tone: "info",
      headless: false,
      message: "started with a warning",
    },
  );
  assert.deepEqual(launchResponseOutcome(session("profile-a", "stopped", SECOND_GENERATION)), {
    kind: "terminal",
    tone: "info",
    status: "stopped",
    message: undefined,
  });
  assert.deepEqual(
    launchResponseOutcome({
      ...session("profile-a", "error", SECOND_GENERATION),
      lastError: "browser exited during launch",
    }),
    {
      kind: "terminal",
      tone: "error",
      status: "error",
      message: "browser exited during launch",
    },
  );
});

test("pending launches and unconfirmed closes keep session polling active", () => {
  assert.equal(shouldPollProfileSessions([], 1), true);
  assert.equal(shouldPollProfileSessions([], 0, 1), true);
  assert.equal(shouldPollProfileSessions([session("profile-a", "launching", SECOND_GENERATION)], 0), true);
  assert.equal(shouldPollProfileSessions([session("profile-a", "running", SECOND_GENERATION)], 0), true);
  assert.equal(shouldPollProfileSessions([session("profile-a", "stopping", SECOND_GENERATION)], 0), true);
  assert.equal(
    shouldPollProfileSessions(
      [{ ...session("profile-a", "error", SECOND_GENERATION), closeUnconfirmed: true }],
      0,
    ),
    true,
  );
  assert.equal(shouldPollProfileSessions([session("profile-a", "stopped", SECOND_GENERATION)], 0), false);
});

test("session polling is caught single-flight and can retry after settlement", async () => {
  const flight = { controller: null, current: null as Promise<void> | null };
  let attempts = 0;
  let release: (() => void) | undefined;
  const task = (_signal: AbortSignal) => {
    attempts += 1;
    return new Promise<void>((resolve) => {
      release = resolve;
    });
  };

  const failUnexpectedly = (error: unknown) => assert.fail(error instanceof Error ? error : String(error));
  const first = runAbortableSingleFlight(flight, 1_000, task, failUnexpectedly);
  const duplicate = runAbortableSingleFlight(flight, 1_000, task, failUnexpectedly);
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(attempts, 1);
  release?.();
  await first;
  assert.equal(flight.current, null);
  assert.equal(flight.controller, null);

  const errors: unknown[] = [];
  await runAbortableSingleFlight(flight, 1_000, async () => {
    attempts += 1;
    throw new Error("offline");
  }, (error) => errors.push(error));
  assert.equal(attempts, 2);
  assert.equal((errors[0] as Error).message, "offline");
  assert.equal(flight.current, null);
});

test("a never-settling poll is aborted by its deadline and the next poll can run", async () => {
  const flight = { controller: null, current: null as Promise<void> | null };
  const errors: unknown[] = [];
  let attempts = 0;

  await runAbortableSingleFlight(
    flight,
    10,
    async () => {
      attempts += 1;
      await new Promise<never>(() => undefined);
    },
    (error) => errors.push(error),
  );

  assert.equal(attempts, 1);
  assert.equal((errors[0] as Error).name, "TimeoutError");
  assert.equal(flight.current, null);
  assert.equal(flight.controller, null);

  await runAbortableSingleFlight(
    flight,
    1_000,
    async () => {
      attempts += 1;
    },
    (error) => assert.fail(error instanceof Error ? error : String(error)),
  );
  assert.equal(attempts, 2);
});

test("poll cleanup aborts the active request and releases single-flight ownership", async () => {
  const flight = { controller: null, current: null as Promise<void> | null };
  const errors: unknown[] = [];
  const polling = runAbortableSingleFlight(
    flight,
    1_000,
    async () => {
      await new Promise<never>(() => undefined);
    },
    (error) => errors.push(error),
  );

  abortSingleFlight(flight);
  await polling;

  assert.equal((errors[0] as Error).name, "AbortError");
  assert.equal(flight.current, null);
  assert.equal(flight.controller, null);
});

test("profile Stop registration is single-flight and identity guarded", () => {
  const requests = new Map();
  const first = registerProfileStopRequest(requests, "profile-a");
  assert.ok(first);

  assert.equal(registerProfileStopRequest(requests, "profile-a"), undefined);
  assert.equal(abortProfileStopRequest(requests, "profile-a", { ...first }), false);
  assert.equal(first.controller.signal.aborted, false);
  assert.equal(abortProfileStopRequest(requests, "profile-a", first), true);
  assert.equal(first.controller.signal.aborted, true);
  assert.equal(requests.has("profile-a"), false);
});

test("a profile Stop request owns an aborting transport deadline", async () => {
  const request = registerProfileStopRequest(new Map(), "profile-a");
  assert.ok(request);
  const clearDeadline = armProfileStopRequestDeadline(request, 10);

  await new Promise<void>((resolve) => {
    request.controller.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  clearDeadline();

  assert.equal(request.timedOut, true);
  assert.equal(request.controller.signal.aborted, true);
  assert.equal((request.controller.signal.reason as Error).name, "TimeoutError");
});

test("an abort signal settles its caller even when the transport ignores cancellation", async () => {
  const controller = new AbortController();
  const waiting = raceAbortSignal(controller.signal, new Promise<never>(() => undefined));

  controller.abort(new DOMException("deadline", "TimeoutError"));

  await assert.rejects(waiting, (error) => {
    assert.equal((error as Error).name, "TimeoutError");
    return true;
  });
});

test("local pending lifecycle state keeps Stop reachable and serializes its UI", () => {
  assert.deepEqual(profileLifecycleActionState(undefined, true, false), {
    canStop: true,
    stopPending: false,
  });
  assert.deepEqual(profileLifecycleActionState(undefined, false, true), {
    canStop: true,
    stopPending: true,
  });
  assert.deepEqual(
    profileLifecycleActionState(session("profile-a", "stopping", SECOND_GENERATION), false, false),
    { canStop: true, stopPending: true },
  );
  assert.deepEqual(
    profileLifecycleActionState(
      { ...session("profile-a", "error", SECOND_GENERATION), closeUnconfirmed: true },
      false,
      true,
    ),
    { canStop: true, stopPending: true },
  );
  assert.deepEqual(
    profileLifecycleActionState(session("profile-a", "stopped", SECOND_GENERATION), false, false),
    { canStop: false, stopPending: false },
  );
});

function session(
  profileId: string,
  status: SessionSummary["status"],
  startedAt: string,
): SessionSummary {
  return { profileId, status, startedAt };
}
