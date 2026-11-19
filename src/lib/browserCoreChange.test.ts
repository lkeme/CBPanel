import assert from "node:assert/strict";
import test from "node:test";
import type { BinaryInfo } from "../shared/browserCore";
import { applyBrowserCoreChange, type BrowserCoreChangeEffects } from "./browserCoreChange";

test("a committed desktop activation requests restart before any fallible state refresh", async () => {
  const calls: string[] = [];
  await applyBrowserCoreChange(effects(calls, {
    desktop: true,
    restartRequested: true,
    refresh: [async () => { calls.push("refresh"); throw new Error("state unavailable"); }],
  }));
  assert.deepEqual(calls, ["apply-private", "restart"]);
});

test("a committed Web activation keeps its success and restart notice when refreshing state fails", async () => {
  const calls: string[] = [];
  await applyBrowserCoreChange(effects(calls, {
    restartRequested: true,
    refresh: [async () => { calls.push("refresh"); throw new Error("state unavailable"); }],
  }));
  assert.deepEqual(calls, ["apply-private", "web-restart", "refresh", "refresh-failed"]);
});

test("a desktop restart failure reports manual recovery and still refreshes the committed channel", async () => {
  const calls: string[] = [];
  await applyBrowserCoreChange(effects(calls, {
    desktop: true,
    restartRequested: true,
    restartRuntime: async () => { calls.push("restart"); throw new Error("bridge unavailable"); },
  }));
  assert.deepEqual(calls, ["apply-private", "restart", "restart-failed", "refresh"]);
});

test("preparation refresh failures resolve so callers can continue with explicit activation", async () => {
  const calls: string[] = [];
  await applyBrowserCoreChange(effects(calls, {
    refresh: [async () => { calls.push("refresh"); throw new Error("state unavailable"); }],
  }));
  calls.push("activate-next");
  assert.deepEqual(calls, ["apply-private", "refresh", "refresh-failed", "activate-next"]);
});

test("a preparation refresh that never settles times out, aborts stale state reads and allows activation to continue", async () => {
  const calls: string[] = [];
  let refreshSignal: AbortSignal | undefined;
  await applyBrowserCoreChange(effects(calls, {
    refreshTimeoutMs: 10,
    refresh: [(signal) => {
      refreshSignal = signal;
      calls.push("refresh-start");
      return new Promise(() => undefined);
    }],
  }));
  calls.push("activate-next");
  assert.equal(refreshSignal?.aborted, true);
  assert.deepEqual(calls, ["apply-private", "refresh-start", "refresh-failed", "activate-next"]);
});

function effects(calls: string[], patch: Partial<BrowserCoreChangeEffects>): BrowserCoreChangeEffects {
  return {
    previousInfo: info("official"), info: info("private"), desktop: false,
    applyInfo: (next) => { calls.push(`apply-${next.core?.channel}`); },
    refresh: [async () => { calls.push("refresh"); }],
    restartRuntime: async () => { calls.push("restart"); },
    notifyWebRestart: () => { calls.push("web-restart"); },
    notifyRefreshFailure: () => { calls.push("refresh-failed"); },
    notifyRestartFailure: () => { calls.push("restart-failed"); },
    ...patch,
  };
}

function info(channel: "official" | "private"): BinaryInfo {
  return { core: { channel, channelMode: "online" } } as BinaryInfo;
}
