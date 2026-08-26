import assert from "node:assert/strict";
import test from "node:test";
import { DataMutationCoordinator, DataMutationCoordinatorError } from "./dataMutationCoordinator";

test("exclusive data leases are acquired synchronously and block every competing kind", () => {
  const coordinator = new DataMutationCoordinator();
  const backup = coordinator.enter("app-backup");
  assert.equal(coordinator.activeReason(), "app-backup");
  for (const kind of ["app-backup", "environment-package", "extension-cache-commit"] as const) {
    assert.throws(() => coordinator.enter(kind), (error: unknown) => {
      assert.ok(error instanceof DataMutationCoordinatorError);
      assert.equal(error.code, "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS");
      return true;
    });
  }
  backup.release();
  assert.equal(coordinator.activeReason(), undefined);
});

test("extension leases run unrelated keys concurrently and serialize identical keys", async () => {
  const coordinator = new DataMutationCoordinator();
  const first = coordinator.enter("extension-cache-commit");
  const second = coordinator.enter("extension-cache-commit");
  const third = coordinator.enter("extension-cache-commit");
  const events: string[] = [];
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstRun = first.runWithExtensions(["extension-a"], async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  await tick();
  const secondRun = second.runWithExtensions(["extension-a"], async () => {
    events.push("second-start");
  });
  const thirdRun = third.runWithExtensions(["extension-b"], async () => {
    events.push("third-start");
  });
  await tick();
  assert.deepEqual(events, ["first-start", "third-start"]);
  releaseFirst?.();
  await Promise.all([firstRun, secondRun, thirdRun]);
  assert.deepEqual(events, ["first-start", "third-start", "first-end", "second-start"]);
  first.release();
  second.release();
  third.release();
});

test("sorted multi-extension acquisition cannot deadlock reverse-order callers", async () => {
  const coordinator = new DataMutationCoordinator();
  const first = coordinator.enter("extension-cache-commit");
  const second = coordinator.enter("extension-cache-commit");
  const events: string[] = [];
  await Promise.all([
    first.runWithExtensions(["b", "a"], async () => {
      events.push("first");
      await tick();
    }),
    second.runWithExtensions(["a", "b"], async () => {
      events.push("second");
    }),
  ]);
  assert.deepEqual(events, ["first", "second"]);
  first.release();
  second.release();
});

test("extension leases block exclusive publication until every owner releases", () => {
  const coordinator = new DataMutationCoordinator();
  const first = coordinator.enter("extension-cache-commit");
  const second = coordinator.enter("extension-cache-commit");
  assert.equal(coordinator.activeReason(), "extension-cache-commit");
  assert.throws(() => coordinator.enter("environment-package"), DataMutationCoordinatorError);
  first.release();
  assert.throws(() => coordinator.enter("app-backup"), DataMutationCoordinatorError);
  second.release();
  const next = coordinator.enter("environment-package");
  assert.equal(coordinator.activeReason(), "environment-package");
  next.release();
});

test("leases are non-reentrant, release is idempotent, and invalid keys fail safely", async () => {
  const coordinator = new DataMutationCoordinator();
  const lease = coordinator.enter("extension-cache-commit");
  await lease.runWithExtensions(["extension-a", "extension-a"], async () => undefined);
  await assert.rejects(
    lease.runWithExtensions(["extension-a"], async () => undefined),
    /non-reentrant/,
  );
  lease.release();
  lease.release();
  assert.equal(lease.released, true);
  assert.equal(coordinator.activeReason(), undefined);

  const invalid = coordinator.enter("extension-cache-commit");
  await assert.rejects(invalid.runWithExtensions(["   "], async () => undefined), /non-empty/);
  invalid.release();
});

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
