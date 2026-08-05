import assert from "node:assert/strict";
import test from "node:test";

import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { translate, type TranslationKey } from "../i18n";
import type { BinaryInfo, BrowserCoreImportedBuild } from "../shared/browserCore";
import { useBrowserCoreActions } from "./useBrowserCoreActions";

const ARCHIVE = "cloakbrowser-windows-x64.zip";

// The guardrail the provenance marker exists for. `update` ignores preferExistingCache, always resolves the
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
test("clearing the cache over an offline-imported core says the archive has to be imported again", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const actions = createActions(dialogs, importedBuild());

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

test("clearing the cache over a downloaded core keeps the plain confirmation", async () => {
  const dialogs: ConfirmDialogState[] = [];
  const actions = createActions(dialogs);

  await actions.clearBinaryCache();

  assert.equal(dialogs.at(-1)?.body, t("confirm.clearBinary"));
});

/**
 * `useBrowserCoreActions` holds no React state of its own — it is a factory over the setters it is handed —
 * so a test can call it directly and read what the actions pushed into the confirm dialog. An action that
 * opens one sends nothing until `onConfirm` runs, and no test here invokes that; the one action that does
 * send (the unguarded update) cannot leave the process, because `api()` resolves its base URL and token off
 * `window`.
 */
function createActions(dialogs: ConfirmDialogState[], imported?: BrowserCoreImportedBuild, busyKeys: string[] = []) {
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
    toast: () => undefined,
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
        baselineChromiumVersion: "146.0.7680.177.5",
        wrapperVersion: "0.5.3",
      },
      license: { configured: false, active: false },
      env: [],
      importedBuild: imported,
      portable: false,
      cacheManagedByCbpanel: true,
      restartRequired: false,
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
