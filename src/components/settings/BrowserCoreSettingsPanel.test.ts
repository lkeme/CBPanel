import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import type {
  BinaryInfo,
  BrowserCoreEnvRuntimeValue,
  BrowserCoreImportedBuild,
  BrowserCoreInfo,
  BrowserCoreLicenseState,
  BrowserCoreUpdateCheck,
} from "../../shared/browserCore";
import { DEFAULT_APP_SETTINGS, type AppSettings } from "../../shared/settings";
import { TooltipProvider } from "../ui/tooltip";
import { BrowserCoreSettingsPanel } from "./BrowserCoreSettingsPanel";

// The license server's own prose. It reaches the panel in licenseState.error, and no state may print
// it: it is English regardless of the UI locale, and it says nothing the four state strings do not.
const SERVER_SENTENCE = "CloakBrowser license validation is unavailable right now.";

test("no license key on file reads as not configured, not as a failed validation", () => {
  const html = renderPanel({ license: { configured: false, active: false } });

  assert.equal(planRow(html), t("browserCore.licensePlanNone"));
});

test("a key the operator switched off reads as disabled, keeping it distinct from having no key", () => {
  const html = renderPanel({ license: { configured: true, active: false } });

  assert.equal(planRow(html), t("browserCore.licensePlanDisabled"));
});

// Pins `if (!license.checkedAt) return t("browserCore.licensePlanValidating")`. Validation runs behind
// the read that scheduled it, so the first payload after a key is entered carries no verdict at all;
// falling through to licensePlanUnknown asserted a failure that had not happened.
test("a just-entered key reads as validating rather than as a validation failure", () => {
  const html = renderPanel({ license: { configured: true, active: true } });

  assert.equal(planRow(html), t("browserCore.licensePlanValidating"));
});

test("a confirmed plan is reported by the name the license server gave it", () => {
  const html = renderPanel({
    license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", valid: true, plan: "team" },
    targetTier: "pro",
    installedTier: "pro",
  });

  assert.equal(planRow(html), "team");
});

// Pins `if (license.valid === false) return t("browserCore.licensePlanInvalid")`. The rejected form used
// to be `${license.plan} · Invalid`, and the live server names a rejected key's plan "unknown" — which
// rendered as `unknown · 无效`, colliding with this panel's own licensePlanUnknown ("could not be
// validated") and meaning its opposite. Cell equality is the assertion, so no extra token can slip in.
test("a rejected key reads as rejected, echoing neither the server's plan token nor its sentence", () => {
  const html = renderPanel({
    license: {
      configured: true,
      active: true,
      checkedAt: "2026-08-04T00:00:00.000Z",
      valid: false,
      plan: "unknown",
      error: SERVER_SENTENCE,
    },
  });

  assert.equal(planRow(html), t("browserCore.licensePlanInvalid"));
  assert.doesNotMatch(html, new RegExp(escapeRegExp(SERVER_SENTENCE)));
});

test("an unconfirmed plan reads as unknown and never prints the server's error sentence", () => {
  const html = renderPanel({
    license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", error: SERVER_SENTENCE },
    targetTier: "pro",
    installedTier: "pro",
  });

  assert.equal(planRow(html), t("browserCore.licensePlanUnknown"));
  assert.doesNotMatch(html, new RegExp(escapeRegExp(SERVER_SENTENCE)));
});

// Pins `value: browserCoreTierLabel(cacheTier, t)` on the tier row for all four license states, each
// against a cache holding the *other* tier's build. The row answers "which layout does this
// configuration produce", which is core.targetTier — never core.tier, which is proBinaryReady(...) read
// off disk with no license check and reports "pro" with no key configured at all.
test("the tier row reports the derived cache tier in every license state", () => {
  const states: Array<{ license: BrowserCoreLicenseState; targetTier: "free" | "pro"; expected: TranslationKey }> = [
    { license: { configured: false, active: false }, targetTier: "free", expected: "browserCore.tierFree" },
    { license: { configured: true, active: false }, targetTier: "free", expected: "browserCore.tierFree" },
    {
      license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", valid: true, plan: "free" },
      // A valid free-plan key still downloads through ensureProBinary into chromium-<version>-pro, so
      // the layout it produces is Pro even though the plan is free.
      targetTier: "pro",
      expected: "browserCore.tierPro",
    },
    {
      license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", valid: false, plan: "unknown" },
      targetTier: "free",
      expected: "browserCore.tierFree",
    },
  ];

  for (const state of states) {
    const html = renderPanel({
      license: state.license,
      targetTier: state.targetTier,
      installedTier: state.targetTier === "pro" ? "free" : "pro",
    });
    assert.equal(tierRow(html), t(state.expected), `tier row for plan ${state.license.plan ?? "none"}`);
  }
});

// Pins the tierCacheMismatch line. Reporting `版本层级 Free` beside
// `可执行文件路径 …\chromium-<v>-pro\chrome.exe` and a green ready line stated two contradictory facts,
// and every automated gate was happy with it.
test("a cache still holding the other tier's build is named, not silently contradicted", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    targetTier: "free",
    installedTier: "pro",
    binaryPath: "D:\\cache\\chromium-146.0.7680.177.5-pro\\chrome.exe",
  });
  const mismatch = t("browserCore.tierCacheMismatch", {
    derived: t("browserCore.tierFree"),
    installed: t("browserCore.tierPro"),
  });

  assert.equal(tierRow(html), t("browserCore.tierFree"));
  assert.match(html, /chromium-146\.0\.7680\.177\.5-pro/);
  // The visible line, not merely the row's tooltip: a hover-only explanation still leaves "Free" and a
  // `-pro` executable path on screen as two plain facts.
  assert.match(html, new RegExp(`<div class="result-line">${escapeRegExp(mismatch)}</div>`));
  assert.match(html, new RegExp(`<dd><span[^>]*title="${escapeRegExp(mismatch)}"`));
});

test("a cache holding the derived tier's build says nothing about a mismatch", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    targetTier: "free",
    installedTier: "free",
  });

  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("browserCore.tierCacheMismatch", {
    derived: t("browserCore.tierFree"),
    installed: t("browserCore.tierFree"),
  }))));
});

// The mismatch is about the managed cache, and an override takes the managed cache out of play
// entirely — the override warning already says so, so repeating it as a tier complaint is noise.
test("an active custom binary path reports the override instead of a tier mismatch", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    targetTier: "free",
    installedTier: "pro",
    override: "D:\\external\\chrome.exe",
  });

  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("browserCore.tierCacheMismatch", {
    derived: t("browserCore.tierFree"),
    installed: t("browserCore.tierPro"),
  }))));
  assert.match(html, new RegExp(escapeRegExp(t("browserCore.overrideShort"))));
});

// The tier is derived from the license plan, never chosen: a free-plan key marked Pro takes the
// authenticated download path and fails. A Segmented renders `<button aria-pressed=...>`, so a tier
// selector reintroduced anywhere in this panel matches here. The sentence that says so is now a tip on
// the tier row's label — as a line of its own it restated the value that row already shows, while the
// reason it exists (why there is no selector) belongs to the row it explains.
test("the panel offers no free/pro selector to guess the tier with", () => {
  const html = renderPanel({ license: { configured: true, active: true } });
  const hint = t("browserCore.tierDerivedHint", { tier: t("browserCore.tierFree") });

  assert.doesNotMatch(html, new RegExp(`<button[^>]*aria-pressed[^>]*>${escapeRegExp(t("browserCore.tierFree"))}<`));
  assert.doesNotMatch(html, new RegExp(`<button[^>]*aria-pressed[^>]*>${escapeRegExp(t("browserCore.tierPro"))}<`));
  assert.match(
    keyValueCells(html, t("browserCore.tier")).label,
    new RegExp(`<button class="info-tip" aria-label="${escapeRegExp(hint)}"`),
  );
  assert.doesNotMatch(html, new RegExp(`<div class="result-line">${escapeRegExp(hint)}</div>`));
});

// The switch defaults to off, so the key cannot be typed until it is deliberately turned on. A disabled
// fieldset carries that, exactly as the proxy fields do, which keeps the input itself unaware of the
// switch — and its boundary is the assertion: everything else in this section is unrelated to the
// licence, and the switch above it must stay reachable or there is no way back. The class is pinned
// because it is what makes the state visible: `input` carries an explicit background here, so a disabled
// input without that block's dimming reads exactly like an editable one.
test("the license key sits alone in a fieldset the switch disables", () => {
  const off = renderPanel({ license: { configured: false, active: false } });
  const on = renderPanel({ license: { configured: true, active: true }, licenseKeyEnabled: true });
  const fieldset = off.match(/<fieldset[^>]*>[\s\S]*?<\/fieldset>/)?.[0] ?? "";

  assert.match(fieldset, /<fieldset class="disabled-fieldset" disabled="">/);
  assert.match(fieldset, /type="password"/);
  assert.match(fieldset, new RegExp(escapeRegExp(t("browserCore.licenseKey"))));
  for (const outside of ["browserCore.licenseKeyEnabled", "browserCore.releaseChannel", "browserCore.versionMode"] as const) {
    assert.doesNotMatch(fieldset, new RegExp(escapeRegExp(t(outside))), outside);
  }
  assert.doesNotMatch(on, /<fieldset[^>]*disabled=""/);
});

// Pins the three things binaryPathOverrideFrom drives. An override short-circuits ensureBinary before
// any version resolution, so the cache stops deciding what launches — but the panel kept a green ready
// line, an up-to-date badge and clickable managed actions over a binary they cannot reach.
test("an active custom binary path turns the status line into the override warning", () => {
  const html = renderPanel({ license: { configured: false, active: false }, override: "D:\\external\\chrome.exe" });

  const statusLine = html.match(/<div class="settings-status-line browser-core-status-line [^"]*"[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.match(statusLine, new RegExp(escapeRegExp(t("browserCore.overrideShort"))));
  assert.doesNotMatch(statusLine, new RegExp(escapeRegExp(t("browserCore.readyShort"))));
  assert.match(statusLine, /browser-core-status-line warning/);
  assert.match(html, new RegExp(escapeRegExp(t("browserCore.overrideTakesOver", { path: "D:\\external\\chrome.exe" }))));
});

test("an active custom binary path drops the update badge about a build it prevents from launching", () => {
  const update: BrowserCoreUpdateCheck = {
    checkedAt: "2026-08-04T00:00:00.000Z",
    currentVersion: "146.0.7680.177.5",
    latestVersion: "150.0.0.0",
    updateAvailable: true,
  };

  const withOverride = renderPanel({ license: { configured: false, active: false }, override: "D:\\external\\chrome.exe", update });
  const withoutOverride = renderPanel({ license: { configured: false, active: false }, update });

  assert.doesNotMatch(withOverride, new RegExp(escapeRegExp(t("browserCore.newVersionBadge"))));
  assert.match(withoutOverride, new RegExp(escapeRegExp(t("browserCore.newVersionBadge"))));
});

test("an active custom binary path disables every managed cache action", () => {
  const withOverride = renderPanel({ license: { configured: false, active: false }, override: "D:\\external\\chrome.exe" });
  const withoutOverride = renderPanel({ license: { configured: false, active: false } });

  for (const managed of ["command success", "command danger subtle"]) {
    assert.match(withOverride, new RegExp(`<button class="${escapeRegExp(managed)}" disabled=""`), managed);
    assert.doesNotMatch(withoutOverride, new RegExp(`<button class="${escapeRegExp(managed)}" disabled=""`), managed);
  }
  // The update check reads GitHub / cloakbrowser.dev metadata and touches no cache content, so it stays
  // available while the override is in charge.
  assert.match(withOverride, new RegExp(`<button class="command"[^>]*>[\\s\\S]*?${escapeRegExp(t("actions.checkUpdate"))}`));
  assert.doesNotMatch(withOverride, new RegExp(`<button class="command" disabled=""[^>]*>[\\s\\S]*?${escapeRegExp(t("actions.checkUpdate"))}`));
});

// The offline-import section holds the archive path and nothing else. A tier selector here would ask
// the operator for a fact the server owns, which is what the derived tier removed; the import already
// defaults to the derived cache tier.
test("only the archive path control sits under the offline-import heading", () => {
  const html = renderPanel({ license: { configured: true, active: true } });
  const section = sectionContaining(html, t("browserCore.offlineImport"));

  assert.match(section, new RegExp(escapeRegExp(t("browserCore.importZipPlaceholder"))));
  assert.equal(section.match(/<input/g)?.length, 1);
  assert.doesNotMatch(section, /aria-pressed/);
  assert.doesNotMatch(section, new RegExp(escapeRegExp(t("browserCore.tier"))));
});

// A free plan is force-served the latest build, so the pin controls are hidden — but only on the plan,
// never on the tier: a valid free-plan key derives the Pro cache tier, so `cacheTier === "free"` stopped
// answering this question.
test("a free plan hides the version pin controls while its Pro cache tier keeps them for other plans", () => {
  const freePlan = renderPanel({
    license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", valid: true, plan: "free" },
    targetTier: "pro",
    installedTier: "pro",
    planIsFree: true,
  });
  const paidPlan = renderPanel({
    license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", valid: true, plan: "team" },
    targetTier: "pro",
    installedTier: "pro",
  });

  assert.doesNotMatch(freePlan, new RegExp(`<button[^>]*aria-pressed[^>]*>${escapeRegExp(t("browserCore.versionPinned"))}<`));
  assert.match(paidPlan, new RegExp(`<button[^>]*aria-pressed[^>]*>${escapeRegExp(t("browserCore.versionPinned"))}<`));
});

// Nothing re-runs the update check when the cache changes, and the managed cache holds exactly one build,
// so importing an older package is an ordinary way to leave the stored check describing a build that is
// no longer installed. Vouching for it then is a claim no comparison was ever made.
test("an update check about a different build than the installed one shows no verdict", () => {
  const stale = renderPanel({
    license: { configured: false, active: false },
    update: updateCheck({ currentVersion: "150.0.7871.114" }),
  });

  assert.doesNotMatch(stale, new RegExp(escapeRegExp(t("browserCore.upToDate"))));
});

test("an update check about the installed build still reports up to date", () => {
  const current = renderPanel({
    license: { configured: false, active: false },
    update: updateCheck({ currentVersion: "146.0.7680.177.5" }),
  });

  assert.match(current, new RegExp(escapeRegExp(t("browserCore.upToDate"))));
});

// Both of these name the version they are about in their own text, so a stale check cannot be misread
// off them the way a bare "up to date" can.
test("a stale check still reports an available update and a failed check", () => {
  const available = renderPanel({
    license: { configured: false, active: false },
    update: updateCheck({ currentVersion: "150.0.7871.114", updateAvailable: true, latestVersion: "151.0.0.1" }),
  });
  const failed = renderPanel({
    license: { configured: false, active: false },
    update: updateCheck({ currentVersion: "150.0.7871.114", error: "offline" }),
  });

  assert.match(available, new RegExp(escapeRegExp(t("browserCore.newVersionBadge"))));
  assert.match(failed, new RegExp(escapeRegExp(t("browserCore.updateCheckFailed"))));
});

// The wrapper rewrites cacheDir to the override binary's own directory, so this row was labelling a
// foreign path as the managed cache — the one claim the rest of this panel stopped making under an
// override.
test("an active override does not call the override's own directory the cache directory", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    override: "D:\\portable\\chrome.exe",
  });

  assert.equal(keyValueRow(html, t("browserCore.cacheDirectory")), "");
  assert.notEqual(keyValueRow(html, t("browserCore.overrideBinaryDirectory")), "");
});

// The row is a grid whose middle track is sized for the desktop file picker. On web the hint sat in that
// track and, at 118 characters in en-US, took the width it needed — leaving the path input at about 62px.
test("the import hint does not share the file row's grid tracks with the path input", () => {
  const html = renderPanel({ license: { configured: false, active: false } });
  const row = html.match(/<div class="inline-file-row[^"]*">([\s\S]*?)<\/div>/)?.[0] ?? "";

  assert.match(row, /inline-file-row no-picker/);
  assert.equal(row.includes("input-hint"), false);
  // Still rendered, just not competing for the input's width.
  assert.ok(html.includes(t("browserCore.webManualPathOnly")));
});

// A build that came from an offline import cannot be re-downloaded, and updating replaces it for good, so
// the row that names the version says where it came from. The server reports provenance only for the build
// that actually resolves, so the badge's presence is exactly "this is the imported build".
test("an offline-imported build is named on the version row with its archive and digest", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    importedBuild: importedBuild(),
  });
  const version = keyValueCells(html, t("browserCore.installedVersion")).value;

  assert.match(version, new RegExp(escapeRegExp(t("browserCore.localBuildBadge"))));
  // Enough to identify the archive without pasting a 64-character digest into the row.
  assert.match(version, new RegExp(escapeRegExp(t("browserCore.localBuildBadgeDetail", {
    at: formatTime("2026-08-01T09:30:00.000Z", "dateTime"),
    file: "cloakbrowser-windows-x64.zip",
    sha: "0123456789ab",
    version: "146.0.7680.177.5",
  }))));
});

// The server reports provenance when the marker names the same Chromium build as the resolved one, not the
// identical string — repairCompatibleManagedCache renames a build (marker included) onto a longer version's
// directory name, and requiring equality made the badge and its update guard disappear exactly then. So the
// tooltip's version can legitimately differ from the row's, and it is labelled as the archive's own rather
// than left to be read as the installed one.
test("the import tooltip names the archive's version, which need not be the resolved build's", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    // What the repair leaves behind: chromium-146.0.7680.177 renamed onto chromium-146.0.7680.177.5.
    importedBuild: importedBuild({ version: "146.0.7680.177" }),
  });
  const version = keyValueCells(html, t("browserCore.installedVersion")).value;

  assert.match(version, new RegExp(escapeRegExp(t("browserCore.localBuildBadge"))));
  assert.match(version, new RegExp(escapeRegExp(t("browserCore.localBuildBadgeDetail", {
    at: formatTime("2026-08-01T09:30:00.000Z", "dateTime"),
    file: "cloakbrowser-windows-x64.zip",
    sha: "0123456789ab",
    version: "146.0.7680.177",
  }))));
  // The row itself keeps reporting the version the wrapper resolves; only the tooltip speaks for the archive.
  assert.match(version, /<span class="mono-cell" title="146\.0\.7680\.177\.5">146\.0\.7680\.177\.5<\/span>/);
});

test("a downloaded build claims no import provenance", () => {
  const html = renderPanel({ license: { configured: false, active: false } });

  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("browserCore.localBuildBadge"))));
});

// Two facts, two pills, and no third: the import badge describes the build, the update badge describes the
// comparison. The caveat is what takes the comparison's verdict away, so the row never carries both a
// "compared across two feeds" warning and a confident "up to date".
test("a caveated comparison withdraws the up-to-date verdict and keeps the import badge", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    importedBuild: importedBuild({ tier: "pro" }),
    update: updateCheck({ baselineCaveat: "offline-import-tier-mismatch" }),
  });

  assert.doesNotMatch(html, new RegExp(escapeRegExp(t("browserCore.upToDate"))));
  assert.match(html, new RegExp(escapeRegExp(t("browserCore.localBuildBadge"))));
  // Visible, not merely a tooltip: the whole point is that "up to date" would otherwise have been read as
  // a settled answer.
  assert.match(html, new RegExp(`<div class="result-line">${escapeRegExp(t("browserCore.updateBaselineImportedTier"))}</div>`));
});

// The caveat is persisted with the check in settings.binary.lastUpdateCheck, so it outlives the build it
// describes exactly as the up-to-date badge does — and it is the same kind of statement: a sentence about a
// comparison, made where nothing re-ran that comparison. Once the cache holds a different build the caveat is
// talking about something that is no longer installed, so it goes quiet until the next check.
test("a caveat about a build that is no longer installed is withdrawn with the verdict", () => {
  const stale = renderPanel({
    license: { configured: false, active: false },
    importedBuild: importedBuild({ tier: "pro" }),
    update: updateCheck({ baselineCaveat: "offline-import-tier-mismatch", currentVersion: "150.0.7871.114" }),
  });

  assert.doesNotMatch(stale, new RegExp(escapeRegExp(t("browserCore.updateBaselineImportedTier"))));
  assert.doesNotMatch(stale, new RegExp(escapeRegExp(t("browserCore.upToDate"))));
  // The provenance badge is a fact about the build this row names, read off that build's own directory, so it
  // is unaffected by how old the stored check is.
  assert.match(stale, new RegExp(escapeRegExp(t("browserCore.localBuildBadge"))));
});

// Two questions, two answers: where the build came from, and what the comparison found. Both belong on the
// row — and only ever those two, which is the other reason the caveat withdraws a verdict instead of
// adding a third pill beside it.
test("an available update and an imported build sit side by side, two pills at most", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    importedBuild: importedBuild(),
    update: updateCheck({ updateAvailable: true, latestVersion: "151.0.0.1" }),
  });
  const version = keyValueCells(html, t("browserCore.installedVersion")).value;

  assert.match(version, new RegExp(escapeRegExp(t("browserCore.newVersionBadge"))));
  assert.match(version, new RegExp(escapeRegExp(t("browserCore.localBuildBadge"))));
  assert.equal(version.match(/class="pill/g)?.length, 2);
});

/** Named because renderPanel and binaryInfoFixture must agree about it, not to move props out of a signature. */
type PanelFixture = {
  binaryPath?: string;
  importedBuild?: BrowserCoreImportedBuild;
  installed?: boolean;
  installedTier?: "free" | "pro";
  license: BrowserCoreLicenseState;
  licenseKeyEnabled?: boolean;
  override?: string;
  planIsFree?: boolean;
  targetTier?: "free" | "pro";
  update?: BrowserCoreUpdateCheck;
};

function renderPanel(patch: PanelFixture): string {
  return renderToStaticMarkup(
    React.createElement(
      // main.tsx wraps the whole app in one, and Radix's Tooltip throws "must be used within
      // TooltipProvider" under renderToStaticMarkup exactly as it would in the browser.
      TooltipProvider,
      null,
      React.createElement(BrowserCoreSettingsPanel, {
        binaryInfo: binaryInfoFixture(patch),
        busy: "",
        checkBrowserCoreUpdate: async () => undefined,
        clearBinaryCache: async () => undefined,
        importBrowserCoreZip: () => undefined,
        installBinary: async () => undefined,
        openRuntimeCheck: () => undefined,
        saveSettings: async () => undefined,
        settings: appSettings(patch),
        t,
        updateBinary: async () => undefined,
      }),
    ),
  );
}

/**
 * zh-CN is statically imported, so translate resolves synchronously and the assertions read as the
 * strings a user sees — a placeholder that stopped being substituted shows up instead of passing.
 */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}

function appSettings(patch: PanelFixture): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    binary: {
      ...DEFAULT_APP_SETTINGS.binary,
      // The licence switch lives in settings, not in binaryInfo, and it ships off — so a fixture that
      // wants the key field editable has to say so, and every other fixture renders the shipped state.
      licenseKeyEnabled: patch.licenseKeyEnabled ?? DEFAULT_APP_SETTINGS.binary.licenseKeyEnabled,
    },
  };
}

function binaryInfoFixture(patch: PanelFixture): BinaryInfo {
  const binaryPath = patch.binaryPath ?? "D:\\cache\\chromium-146.0.7680.177.5\\chrome.exe";
  const env: BrowserCoreEnvRuntimeValue[] = [
    {
      key: "CLOAKBROWSER_CACHE_DIR",
      label: "CLOAKBROWSER_CACHE_DIR",
      value: "D:\\cache",
      maskedValue: "D:\\cache",
      enabled: true,
      source: "cbpanel-default",
      sensitive: false,
      valueKind: "directory",
      requiresRuntimeRestart: false,
    },
  ];
  if (patch.override) {
    env.unshift({
      key: "CLOAKBROWSER_BINARY_PATH",
      label: "CLOAKBROWSER_BINARY_PATH",
      value: patch.override,
      maskedValue: patch.override,
      enabled: true,
      source: "settings",
      sensitive: false,
      valueKind: "path",
      requiresRuntimeRestart: false,
    });
  }
  const core: BrowserCoreInfo = {
    status: "installed",
    installed: patch.installed ?? true,
    tier: patch.installedTier ?? "free",
    targetTier: patch.targetTier ?? "free",
    planIsFree: patch.planIsFree ?? false,
    versionMode: "latest",
    platform: "windows-x64",
    binaryPath,
    cacheDir: "D:\\cache\\chromium-146.0.7680.177.5",
    downloadUrl: "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
    versions: {
      chromiumVersion: "146.0.7680.177.5",
      baselineChromiumVersion: "146.0.7680.177.5",
      wrapperVersion: "0.5.3",
    },
    license: patch.license,
    env,
    update: patch.update,
    importedBuild: patch.importedBuild,
    portable: false,
    cacheManagedByCbpanel: true,
    restartRequired: false,
  };
  return {
    version: "146.0.7680.177.5",
    bundledVersion: "146.0.7680.177.5",
    tier: core.tier,
    platform: core.platform,
    binaryPath: patch.override ?? binaryPath,
    installed: core.installed,
    cacheDir: core.cacheDir,
    downloadUrl: core.downloadUrl,
    core,
  };
}

function updateCheck(patch: Partial<BrowserCoreUpdateCheck> = {}): BrowserCoreUpdateCheck {
  return {
    checkedAt: "2026-08-04T00:00:00.000Z",
    targetTier: "free",
    versionMode: "latest",
    currentVersion: "146.0.7680.177.5",
    latestVersion: "146.0.7680.177.5",
    updateAvailable: false,
    ...patch,
  };
}

/** The version matches the fixture's installed one; the server reports provenance for any marker naming the same Chromium build. */
function importedBuild(patch: Partial<BrowserCoreImportedBuild> = {}): BrowserCoreImportedBuild {
  return {
    source: "offline-import",
    version: "146.0.7680.177.5",
    tier: "free",
    fileName: "cloakbrowser-windows-x64.zip",
    sha256: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    importedAt: "2026-08-01T09:30:00.000Z",
    ...patch,
  };
}

function tierRow(html: string): string {
  return keyValueRow(html, t("browserCore.tier"));
}

function planRow(html: string): string {
  return keyValueRow(html, t("browserCore.licensePlan"));
}

/**
 * The text of the `<dd>` whose `<dt>` is this label, so an assertion is about the cell a user reads
 * rather than about the string appearing anywhere in the document — a whole-document match also hits
 * the row's own `title` attribute, which let a deleted visible line keep the test green.
 */
function keyValueRow(html: string, label: string): string {
  return stripTags(keyValueCells(html, label).value);
}

/**
 * The raw markup of the row a label names, matched on the label's *text*: a label may carry an InfoTip
 * beside it, so `<dt>` is no longer only the label string. Empty strings when no row carries the label,
 * which is what "this row is not rendered" assertions read.
 */
function keyValueCells(html: string, label: string): { label: string; value: string } {
  for (const [, dt, dd] of html.matchAll(/<dt>([\s\S]*?)<\/dt><dd>([\s\S]*?)<\/dd>/g)) {
    if (stripTags(dt) === label) return { label: dt, value: dd };
  }
  return { label: "", value: "" };
}

function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, "");
}

/** Everything from a section heading up to the next `<section`, i.e. the markup that heading owns. */
function sectionContaining(html: string, heading: string): string {
  return html.match(new RegExp(`<h2>${escapeRegExp(heading)}</h2>([\\s\\S]*?)(?:<section|$)`))?.[1] ?? "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
