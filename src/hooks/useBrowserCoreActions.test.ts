import assert from "node:assert/strict";
import test from "node:test";

import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { translate, type TranslationKey } from "../i18n";
import type { BinaryInfo, BrowserCoreImportedBuild } from "../shared/browserCore";
import { api } from "../lib/apiClient";
import { refreshBrowserCoreState } from "../lib/browserCoreChange";
import { useBrowserCoreActions } from "./useBrowserCoreActions";

const ARCHIVE = "cloakbrowser-windows-x64.zip";

// The guardrail the provenance marker exists for. `update` explicitly resolves the
// latest online build and finishes by pruning the cache to one build — so one click on what looks like a
// routine action used to delete an offline-imported core with no warning, and CBPanel keeps no copy of the
// archive to put back.
test("updating over an offline-imported core asks before replacing it", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const busyKeys: string[] = [];
  const actions = createActions(dialogs, importedBuild(), busyKeys);

  await actions.updateBinary();

  const dialog = dialogs.at(-1);
  assert.equal(dialogs.length, 1);
  // Nothing was sent: the request only happens once the dialog's own confirm runs.
  assert.deepEqual(busyKeys, []);
  assert.equal(dialog?.title, t("confirm.replaceImportedCoreTitle"));
  // Which archive, and that there is no way back — the two facts a user needs to answer the question.
  assert.equal(dialog?.body, t("confirm.replaceImportedCore", { version: "146.0.7680.177.5", file: ARCHIVE }));
  assert.equal(dialog?.confirmLabel, t("actions.update"));
  // The key the dialog disables its own buttons with has to be the one updateBinaryNow sets.
  assert.equal(dialog?.busyKey, "binary-update");
});

// The tooltip's caveat applies here too: the marker's version is the archive's own, which after a compatible
// cache repair is shorter than the build directory's name. The confirmation names the archive, so it quotes
// the archive's version rather than the resolved one.
test("the update confirmation quotes the archive's own version", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const actions = createActions(dialogs, importedBuild({ version: "146.0.7680.177" }));

  await actions.updateBinary();

  assert.equal(dialogs.at(-1)?.body, t("confirm.replaceImportedCore", { version: "146.0.7680.177", file: ARCHIVE }));
});

// A downloaded build costs nothing to fetch again, so the guard must not spread to it — an extra
// confirmation on the ordinary path is how a guard stops being read.
test("updating over a downloaded core goes straight through with no confirmation", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const busyKeys: string[] = [];
  const actions = createActions(dialogs, undefined, busyKeys);

  // The request itself cannot leave a test process — `api()` resolves its base URL off `window` — so it
  // fails and is reported through `toast`. What is asserted is that it was attempted at all rather than
  // deferred to a dialog.
  await actions.updateBinary();

  assert.deepEqual(dialogs, []);
  assert.ok(busyKeys.includes("binary-update"));
});

// Clearing the cache is the second manual path that destroys an offline-imported core, and the difference
// from a downloaded one is that the archive is the operator's own file — CBPanel keeps no copy, so nothing
// can fetch it back. The action still goes through on one confirmation; only the text changes.
// Clearing keeps the build in use, so the archive warning is about an import that is *not* running —
// that one is among the superseded builds the clear removes, and it cannot be fetched again.
test("clearing the cache warns about an imported core that is not the one running", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const actions = createActions(dialogs, importedBuild({ version: "145.0.7000.1.1" }));

  await actions.clearBinaryCache();

  const dialog = dialogs.at(-1);
  assert.equal(dialogs.length, 1);
  assert.equal(dialog?.title, t("confirm.clearBinaryTitle"));
  // Both halves: what clearing the cache does at all, plus the part that cannot be undone here.
  assert.ok(dialog?.body.includes(t("confirm.clearBinary")));
  assert.ok(dialog?.body.includes(t("confirm.clearBinaryImportedCore", { file: ARCHIVE })));
  // Told, not blocked: one dialog, and its confirm button is the ordinary clear-cache action.
  assert.equal(dialog?.confirmLabel, t("actions.clearCache"));
  assert.equal(dialog?.tone, "danger");
});

// The imported build is the running one, and the clear keeps exactly that build: the warning would
// describe a file this action does not touch.
test("clearing the cache keeps the running imported core and does not warn about it", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const actions = createActions(dialogs, importedBuild());

  await actions.clearBinaryCache();

  const dialog = dialogs.at(-1);
  assert.equal(dialog?.body, t("confirm.clearBinary"));
  assert.equal(dialog?.body.includes(t("confirm.clearBinaryImportedCore", { file: ARCHIVE })), false);
});

test("clearing the cache over a downloaded core keeps the plain confirmation", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const actions = createActions(dialogs);

  await actions.clearBinaryCache();

  assert.equal(dialogs.at(-1)?.body, t("confirm.clearBinary"));
});

test("automatic checks respect version locks while manual checks and unlocked updates still report availability", async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __CBPANEL_API_BASE_URL__: "http://fixture.local", __CBPANEL_API_TOKEN__: "fixture-token" } });
  try {
    for (const [silent, blocked, notices] of [[true, true, 0], [false, true, 1], [true, false, 1]] as const) {
      const messages: string[] = [];
      globalThis.fetch = async () => Response.json({
        info: binaryInfoFixture(),
        update: { checkedAt: new Date().toISOString(), currentVersion: "156.0.0.0", latestVersion: "157.0.0.0", updateAvailable: true, blockedReason: blocked ? "Pinned browser version is enabled." : undefined },
      });
      await createActions([], undefined, [], messages).checkBrowserCoreUpdate({ silent });
      assert.equal(messages.length, notices);
      if (notices) assert.equal(messages[0], t("browserCore.updateAvailable", { version: "157.0.0.0" }));
    }
  } finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

/**
 * `useBrowserCoreActions` holds no React state of its own — it is a factory over the setters it is handed —
 * so a test can call it directly and read what the actions pushed into the confirm dialog. An action that
 * opens one sends nothing until `onConfirm` runs, and no test here invokes that; the one action that does
 * send (the unguarded update) cannot leave the process, because `api()` resolves its base URL and token off
 * `window`.
 */
// The server installs and activates in one request: the build it downloaded is the build that launches,
// and a second round trip would leave a private build prepared but unused if it failed.
test("installing a private release installs and activates it in one request", async () => {
  await withMockCoreApi(async (requests) => {
    const refreshes: Array<{ info: BinaryInfo; restart?: boolean }> = [];
    const messages: string[] = [];
    globalThis.fetch = async (input) => {
      const url = String(input);
      requests.push(url);
      const info = binaryInfoFixture();
      const activated = { ...info, core: { ...info.core!, channel: "private" as const, channelMode: "online" as const } };
      if (url.endsWith("/private/install")) return Response.json({ info: activated, version: "156.0.8078.47.1" });
      throw new Error(`Unexpected request: ${url}`);
    };
    const actions = createActions([], undefined, [], messages, async (info, options) => { refreshes.push({ info, restart: options?.restart }); });
    await actions.installPrivateVersion("156.0.8078.47.1");
    assert.deepEqual(requests.map((url) => new URL(url).pathname), ["/api/browser-core/private/install"]);
    assert.equal(refreshes.length, 1);
    assert.equal(refreshes[0].restart, true);
    assert.equal(refreshes[0].info.core?.channel, "private");
    assert.ok(messages.includes(t("browserCore.privateInstalled", { version: "156.0.8078.47.1" })));
  });
});

test("a private install the server refuses reports the refusal and changes nothing", async () => {
  await withMockCoreApi(async () => {
    const restartRequests: boolean[] = [];
    const messages: string[] = [];
    globalThis.fetch = async () => Response.json({ error: "Stop running sessions first.", code: "BROWSER_CORE_SESSIONS_RUNNING" }, { status: 409 });
    await createActions([], undefined, [], messages, async (_info, options) => { restartRequests.push(Boolean(options?.restart)); }).installPrivateVersion("156.0.8078.47.1");
    assert.deepEqual(restartRequests, []);
    assert.equal(messages.includes(t("browserCore.privateInstalled", { version: "156.0.8078.47.1" })), false);
  });
});

test("offline import forwards its target channel and a pending activation never restarts", async () => {
  await withMockCoreApi(async () => {
    const restartRequests: boolean[] = [];
    const messages: string[] = [];
    globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as { targetChannel: string };
      assert.equal(body.targetChannel, "private");
      return Response.json({ analysis: { importedVersion: "156.0.8078.47.1" }, info: binaryInfoFixture(), pendingActivation: true });
    };
    await createActions([], undefined, [], messages, async (_info, options) => { restartRequests.push(Boolean(options?.restart)); }).installBrowserCoreImport({
      filePath: "D:/cloakbrowser-windows-x64.zip", fileName: "cloakbrowser-windows-x64.zip", fileSize: 200, sha256: "a".repeat(64), platform: "windows-x64", targetTier: "pro", targetChannel: "private", currentVersion: "155.0.0.0.1", importedVersion: "156.0.8078.47.1", operation: "upgrade", allowed: true,
    });
    assert.deepEqual(restartRequests, [false]);
    assert.ok(messages.includes(t("browserCore.pendingImportSessionsRunning")));
  });
});

// Installing the official core is one request aimed at the official channel; the server activates it.
test("installing the official core targets the official channel and requests a restart", async () => {
  await withMockCoreApi(async (requests) => {
    const restartRequests: boolean[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      requests.push(new URL(url).pathname);
      assert.deepEqual(JSON.parse(String(init?.body)), { targetChannel: "official" });
      return Response.json({ info: binaryInfoFixture(), binaryPath: "D:/core/chrome.exe" });
    };
    await createActions([], undefined, [], [], async (_info, options) => { restartRequests.push(Boolean(options?.restart)); }).installBinary("official");
    assert.deepEqual(requests, ["/api/binary/install"]);
    assert.deepEqual(restartRequests, [true]);
  });
});

// A failed install is reported as a failure, never as a prepared build waiting to be enabled: the card
// shows the channel it was aimed at, and "enabled" would be a claim about a build that is not there.
test("a failed channel install reports the error and leaves the running core alone", async () => {
  await withMockCoreApi(async () => {
    const refreshes: boolean[] = [];
    const messages: string[] = [];
    globalThis.fetch = async () => Response.json({ error: "Fixture install failure.", code: "BROWSER_CORE_UPDATE_INCOMPLETE" }, { status: 502 });
    const actions = createActions([], undefined, [], messages, async (_info, options) => { refreshes.push(Boolean(options?.restart)); });
    await actions.installBinary("official");
    assert.deepEqual(refreshes, []);
    assert.equal(messages.includes(t("browserCore.channelActivated")), false);
    assert.equal(messages.includes(t("toast.binaryReady")), false);
  });
});

test("private install binds the selected version to its catalog repository and release identity", async () => {
  await withMockCoreApi(async () => {
    let requestBody: unknown;
    globalThis.fetch = async (input, init) => {
      if (String(input).endsWith("/private/install")) requestBody = JSON.parse(String(init?.body));
      return Response.json({ info: binaryInfoFixture(), version: "156.0.8078.47.1" });
    };
    await createActions([]).installPrivateVersion("156.0.8078.47.1", { repositoryUrl: "https://github.com/example/source-b", releaseId: 823 });
    assert.deepEqual(requestBody, { version: "156.0.8078.47.1", repositoryUrl: "https://github.com/example/source-b", releaseId: 823 });
  });
});

test("saved private credentials and cleared tokens succeed before a failed or stalled refresh finishes", async () => {
  await withMockCoreApi(async () => {
    for (const mutation of ["test", "clear"] as const) {
      for (const failure of ["rejected", "stalled"] as const) {
        const notices: string[] = [];
        const configurations: Array<{ configured: boolean; repositoryUrl?: string }> = [];
        let refreshSignal: AbortSignal | undefined;
        let refreshFinished: Promise<void> | undefined;
        let refreshSettled = false;
        globalThis.fetch = async (input, init) => {
          const url = String(input);
          if (url.endsWith("/private/test")) return Response.json({ configured: true, repositoryUrl: "https://github.com/example/saved-core" });
          if (url.endsWith("/private/token")) return Response.json({ configured: false });
          assert.ok(url.endsWith("/api/binary"));
          refreshSignal = init?.signal ?? undefined;
          if (failure === "rejected") throw new Error("State refresh is unavailable.");
          return new Promise(() => undefined);
        };
        const actions = createActions([], undefined, [], notices, undefined, (configuration) => {
          configurations.push(configuration);
          refreshFinished = refreshBrowserCoreState({
            refresh: [(signal) => api<BinaryInfo>("/api/binary", { signal })],
            refreshTimeoutMs: 10,
            notifyRefreshFailure: () => { notices.push("refresh-failed"); },
          }).then(() => { refreshSettled = true; });
          return refreshFinished;
        });
        if (mutation === "test") {
          const result = await actions.testPrivateRepository("https://github.com/example/saved-core", "fixture-token");
          assert.equal(result.configured, true);
          assert.equal(result.repositoryUrl, "https://github.com/example/saved-core");
          assert.deepEqual(configurations, [{ configured: true, repositoryUrl: "https://github.com/example/saved-core" }]);
        } else {
          await actions.clearPrivateToken();
          assert.deepEqual(configurations, [{ configured: false }]);
        }
        if (failure === "stalled") assert.equal(refreshSettled, false, "the form must finish while the ancillary GET is still pending");
        await refreshFinished;
        assert.deepEqual(notices, ["refresh-failed"]);
        if (failure === "stalled") assert.equal(refreshSignal?.aborted, true);
      }
    }
  });
});

test("a rejected private credential mutation keeps its API error and never reports a saved configuration", async () => {
  await withMockCoreApi(async () => {
    let notified = false;
    globalThis.fetch = async () => Response.json({ error: "Rejected credential.", code: "PRIVATE_TOKEN_INVALID" }, { status: 401 });
    const actions = createActions([], undefined, [], [], undefined, () => { notified = true; });
    await assert.rejects(actions.testPrivateRepository("https://github.com/example/core", "fixture"), { message: "Rejected credential.", code: "PRIVATE_TOKEN_INVALID" });
    await assert.rejects(actions.clearPrivateToken(), { message: "Rejected credential.", code: "PRIVATE_TOKEN_INVALID" });
    assert.equal(notified, false);
  });
});

test("activating an imported core binds the request to the version shown and preserves stale-version errors", async () => {
  await withMockCoreApi(async () => {
    const messages: string[] = [];
    let changed = false;
    globalThis.fetch = async (_input, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), { channel: "official", mode: "offline", expectedVersion: "156.0.8078.47.2" });
      return Response.json({ error: "Prepared build changed.", code: "BROWSER_CORE_ACTIVATION_CONTEXT_CHANGED" }, { status: 409 });
    };
    await createActions([], undefined, [], messages, async () => { changed = true; }).activateCoreChannel("official", "offline", "156.0.8078.47.2");
    assert.equal(changed, false);
    assert.deepEqual(messages, [t("error.browserCoreActivationContextChanged")]);
  });
});

test("a validated full build version is sent again when analyzing and installing a four-part private archive", async () => {
  await withMockCoreApi(async () => {
    const bodies: Array<{ versionHint?: string; targetChannel?: string }> = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ analysis: { importedVersion: "156.0.8078.47.2" }, info: binaryInfoFixture(), pendingActivation: true });
    };
    const actions = createActions([]);
    await actions.analyzeBrowserCoreImport("D:/cloakbrowser-windows-x64.zip", { targetChannel: "private", versionHint: "156.0.8078.47.2" });
    await actions.installBrowserCoreImport({
      filePath: "D:/cloakbrowser-windows-x64.zip", fileName: "cloakbrowser-windows-x64.zip", fileSize: 200, sha256: "a".repeat(64), platform: "windows-x64", targetTier: "pro", targetChannel: "private", currentVersion: "155.0.0.0.1", importedVersion: "156.0.8078.47.2", versionHint: "156.0.8078.47.2", operation: "upgrade", allowed: true,
    });
    assert.deepEqual(bodies.map((body) => [body.targetChannel, body.versionHint]), [["private", "156.0.8078.47.2"], ["private", "156.0.8078.47.2"]]);
  });
});

async function withMockCoreApi(run: (requests: string[]) => Promise<void>): Promise<void> {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const previousFetch = globalThis.fetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { __CBPANEL_API_BASE_URL__: "http://fixture.local", __CBPANEL_API_TOKEN__: "fixture-token" } });
  try { await run([]); }
  finally {
    globalThis.fetch = previousFetch;
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
}

function createActions(dialogs: ConfirmDialogState[], imported?: BrowserCoreImportedBuild, busyKeys: string[] = [], messages: string[] = [], onCoreChanged?: (info: BinaryInfo, options?: { restart?: boolean }) => Promise<void>, onPrivateConfigurationChanged?: (configuration: { configured: boolean; repositoryUrl?: string }) => void | Promise<void>) {
  return useBrowserCoreActions({
    binaryInfo: binaryInfoFixture(imported),
    checkPreflight: async () => undefined,
    draft: null,
    preflight: null,
    setBinaryInfo: () => undefined,
    setBrowserCoreImport: () => undefined,
    setBusy: (busy) => {
      const next = typeof busy === "function" ? busy(busyKeys.at(-1) ?? "") : busy;
      if (next) busyKeys.push(next);
    },
    setConfirmDialog: (state) => {
      dialogs.push(typeof state === "function" ? state(dialogs.at(-1) ?? null) : state);
    },
    t,
    toast: (_tone, message) => { messages.push(message); },
    onCoreChanged,
    onPrivateConfigurationChanged,
  });
}

function binaryInfoFixture(imported?: BrowserCoreImportedBuild): BinaryInfo {
  return {
    version: "146.0.7680.177.5",
    bundledVersion: "146.0.7680.177.5",
    tier: "free",
    platform: "windows-x64",
    binaryPath: "D:\\cache\\chromium-146.0.7680.177.5\\chrome.exe",
    installed: true,
    cacheDir: "D:\\cache\\chromium-146.0.7680.177.5",
    downloadUrl: "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
    core: {
      status: "installed",
      installed: true,
      tier: "free",
      targetTier: "free",
      planIsFree: false,
      versionMode: "latest",
      platform: "windows-x64",
      binaryPath: "D:\\cache\\chromium-146.0.7680.177.5\\chrome.exe",
      cacheDir: "D:\\cache\\chromium-146.0.7680.177.5",
      downloadUrl: "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
      versions: {
        chromiumVersion: "146.0.7680.177.5",
        wrapperVersion: "0.5.3",
      },
      license: { configured: false, active: false },
      env: [],
      importedBuild: imported,
      portable: false,
      cacheManagedByCBPanel: true,
      restartRequired: false,
      channels: { official: { installed: true, version: "146.0.7680.177.5" }, private: { installed: false } },
      officialLicense: { configured: true, valid: true, plan: "solo" },
    },
  };
}

function importedBuild(patch: Partial<BrowserCoreImportedBuild> = {}): BrowserCoreImportedBuild {
  return {
    source: "offline-import",
    version: "146.0.7680.177.5",
    tier: "free",
    fileName: ARCHIVE,
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    importedAt: "2026-08-01T09:30:00.000Z",
    ...patch,
  };
}

/** zh-CN is statically imported, so translate resolves synchronously and the assertions read as user-visible text. */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}
