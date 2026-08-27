import assert from "node:assert/strict";
import test from "node:test";

import {
  extensionRefreshFailureTranslationKey,
  runExtensionMutationWithRefresh,
} from "./useExtensionActions";

test("refresh warning copy stays truthful for success, failure reconciliation, and background work", () => {
  assert.equal(
    extensionRefreshFailureTranslationKey("mutation-succeeded"),
    "toast.extensionMutationRefreshFailed",
  );
  assert.equal(
    extensionRefreshFailureTranslationKey("mutation-failed"),
    "toast.extensionFailureRefreshFailed",
  );
  assert.equal(
    extensionRefreshFailureTranslationKey("background"),
    "toast.extensionStateRefreshFailed",
  );
});

test("a successful extension mutation stays successful when the state refresh fails", async () => {
  const refreshError = new Error("state refresh failed");
  const events: string[] = [];

  const outcome = await runExtensionMutationWithRefresh({
    mutate: async () => {
      events.push("mutation");
      return "committed";
    },
    onMutationFailure: () => events.push("mutation-failure"),
    onMutationSuccess: (value) => events.push(`mutation-success:${value}`),
    onRefreshFailure: (error, context) => events.push(`refresh-failure:${context}:${(error as Error).message}`),
    refresh: async () => {
      events.push("refresh");
      throw refreshError;
    },
  });

  assert.equal(outcome.status, "success");
  assert.equal(outcome.value, "committed");
  assert.equal(outcome.refreshError, refreshError);
  assert.deepEqual(events, [
    "mutation",
    "mutation-success:committed",
    "refresh",
    "refresh-failure:mutation-succeeded:state refresh failed",
  ]);
});

test("a mutation failure remains primary when its reconciliation refresh also fails", async () => {
  const mutationError = new Error("mutation rejected");
  const refreshError = new Error("state refresh failed");
  const events: string[] = [];

  const outcome = await runExtensionMutationWithRefresh({
    mutate: async () => {
      events.push("mutation");
      throw mutationError;
    },
    onMutationFailure: (error) => events.push(`mutation-failure:${(error as Error).message}`),
    onMutationSuccess: () => events.push("mutation-success"),
    onRefreshFailure: (error, context) => events.push(`refresh-failure:${context}:${(error as Error).message}`),
    refresh: async () => {
      events.push("refresh");
      throw refreshError;
    },
    refreshAfterMutationFailure: true,
  });

  assert.equal(outcome.status, "failure");
  assert.equal(outcome.error, mutationError);
  assert.equal(outcome.refreshError, refreshError);
  assert.deepEqual(events, [
    "mutation",
    "mutation-failure:mutation rejected",
    "refresh",
    "refresh-failure:mutation-failed:state refresh failed",
  ]);
});
