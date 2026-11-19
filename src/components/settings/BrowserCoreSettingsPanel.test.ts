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
import { BrowserCoreSettingsPanel, officialLicenseUsable } from "./BrowserCoreSettingsPanel";

// The SDK's raw error is replaced with a localized validation status in the indicator.
const SERVER_SENTENCE = "CloakBrowser license validation is unavailable right now.";

test("no license key on file reads as not configured, not as a failed validation", () => {
  const html = renderPanel({ license: { configured: false, active: false } });

  assert.equal(licenseIndicatorLabel(html), t("browserCore.licensePlanNone"));
});

test("0.7 exposes email key acquisition and removes the bundled baseline from the panel", () => {
  const html = renderPanel({ license: { configured: false, active: false } });
  assert.match(html, /href="https:\/\/cloakbrowser.dev\/free"/);
  assert.ok(html.includes(t("browserCore.getFreeKey")));
  assert.doesNotMatch(html, /CloakBrowser 0\.7/);
  assert.equal(html.includes(t("browserCore.bundledVersion")), false);
});

test("an inactive key source reads as not configured", () => {
  const html = renderPanel({ license: { configured: true, active: false } });

  assert.equal(licenseIndicatorLabel(html), t("browserCore.licensePlanNone"));
});

// A newly entered key has no validation verdict yet.
test("a just-entered key reads as validating rather than as a validation failure", () => {
  const html = renderPanel({ license: { configured: true, active: true } });

  assert.equal(licenseIndicatorLabel(html), t("browserCore.licensePlanValidating"));
});

test("a confirmed plan is reported by the name the license server gave it", () => {
  const html = renderPanel({
    license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", valid: true, plan: "team" },
    targetTier: "pro",
    installedTier: "pro",
  });

  assert.equal(licenseIndicatorLabel(html), `${t("browserCore.licensePlan")}: team`);
});

// A rejected key is distinct from an unavailable validation and never displays a plan as confirmed.
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

  assert.equal(licenseIndicatorLabel(html), t("browserCore.licensePlanInvalid"));
  assert.doesNotMatch(html, new RegExp(escapeRegExp(SERVER_SENTENCE)));
});

test("an unconfirmed plan reads as unknown and never prints the server's error sentence", () => {
  const html = renderPanel({
    license: { configured: true, active: true, checkedAt: "2026-08-04T00:00:00.000Z", error: SERVER_SENTENCE },
    targetTier: "pro",
    installedTier: "pro",
  });

  assert.equal(licenseIndicatorLabel(html), t("browserCore.licensePlanUnknown"));
  assert.doesNotMatch(html, new RegExp(escapeRegExp(SERVER_SENTENCE)));
});

test("only the account's license plan is displayed, independently of the Pro cache layout", () => {
  for (const plan of ["free", "solo", "team", "business", "scale", "future-plan"]) {
    const html = renderPanel({
      license: { configured: true, active: true, checkedAt: "2026-11-06T00:00:00Z", valid: true, plan },
      targetTier: "pro",
      installedTier: "pro",
      planIsFree: plan === "free",
    });
    assert.equal(licenseIndicatorLabel(html), `${t("browserCore.licensePlan")}: ${plan}`);
    assert.equal(keyValueRow(html, t("browserCore.tier")), "");
    assert.equal([...html.matchAll(new RegExp(`<dt>${escapeRegExp(t("browserCore.licensePlan"))}</dt>`, "g"))].length, 0);
    assert.doesNotMatch(html, /<button[^>]*browser-core-license-indicator[^>]*>[^<]*(?:FREE|PRO)/);
    for (const label of ["browserCore.tierFree", "browserCore.tierPro"] as const) {
      assert.doesNotMatch(html, new RegExp(`<button[^>]*aria-pressed[^>]*>${escapeRegExp(t(label))}<`));
    }
  }
});

test("installed cores offer update actions without a reinstall or redundant policy switches", () => {
  const html = renderPanel({ license: { configured: true, active: true, valid: true, checkedAt: "2026-11-06T00:00:00Z", plan: "solo" } });
  const actions = html.match(/<div class="row-actions">[\s\S]*?<\/div>/)?.[0] ?? "";
  for (const label of ["actions.install", "actions.reinstall"] as const) {
    assert.equal(stripTags(actions).includes(t(label)), false);
  }
  assert.ok(actions.includes(t("actions.checkUpdate")));
  const download = sectionContaining(html, t("browserCore.downloadInstall"));
  // The only switch the card carries is the custom-executable policy; license and key-source switches
  // were removed on purpose, and their read-out rows must not come back.
  const switches = [...download.matchAll(/role="switch"/g)].length;
  assert.equal(switches, 1);
  assert.ok(download.includes(t("browserCore.customBinaryEnabled")));
  assert.doesNotMatch(download, /<dt>许可证计划<\/dt>|<dt>密钥来源<\/dt>/);
});

test("core actions and key acquisition precede the editable required license field", () => {
  const off = renderPanel({ installed: false, license: { configured: false, active: false } });
  assert.match(off, /type="password"/);
  const keyInput = off.match(/<input[^>]*type="password"[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(keyInput, /disabled/);
  assert.doesNotMatch(off, /启用许可证/);
  assert.ok(off.indexOf(t("actions.install")) < off.indexOf(t("browserCore.licenseKey")));
  const actions = off.match(/<div class="row-actions">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(actions.includes(t("browserCore.getFreeKey")));
  assert.ok(actions.includes(t("actions.install")));
  assert.ok(off.indexOf('type="password"') < off.indexOf('<fieldset'));
});

test("a keyless installation disables managed download and cache controls while keeping import and env controls accessible", () => {
  const html = renderPanel({ installed: false, license: { configured: false, active: false } });
  assert.equal(html.includes("browser-core-status-line"), false);
  assert.equal(licenseIndicatorLabel(html), t("browserCore.licensePlanNone"));
  assert.match(html, /browser-core-license-indicator warning/);
  // Only the official channel's remote policy is gated by the key; the local controls are not in a
  // disabled fieldset at all, which is what keeps them usable while the key is missing.
  assert.match(html, /<fieldset class="disabled-fieldset in-place" disabled="">/);
  // The cache controls are outside every fieldset: they are local storage, not a remote operation.
  const cacheStart = html.indexOf(t("browserCore.cacheDirMode"));
  const fieldsetStart = html.indexOf("<fieldset");
  assert.ok(cacheStart < fieldsetStart, "cache controls sit above the gated block and outside it");
  assert.ok(html.slice(cacheStart).includes(t("browserCore.customEnv")));
  // The import entry lives in the action row with the other card actions.
  const actions = html.match(/<div class="row-actions">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(actions.includes(t("browserCore.offlineImport")));
  // The key gates only what reaches the network for the official channel. Clearing the cache is a local
  // delete of superseded builds and a runtime check is a local probe, so neither waits for a key.
  for (const name of ["actions.install", "actions.checkUpdate"] as const) {
    const button = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === t(name));
    assert.match(button ?? "", /disabled=""/, name);
  }
  for (const name of ["actions.clearCache", "browserCore.runtimeCheckTitle"] as const) {
    const button = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === t(name));
    assert.ok(button, name);
    assert.doesNotMatch(button, /disabled=""/, name);
  }
});

test("version mode is configured once and cache controls follow it in the download card", () => {
  const cachePath = "D:/custom-browser-cache";
  const html = renderPanel({ cacheDirMode: "custom", customCacheDir: cachePath, license: { configured: true, active: true, valid: true, plan: "solo" } });
  const download = sectionContaining(html, t("browserCore.downloadInstall"));
  assert.equal([...download.matchAll(new RegExp(escapeRegExp(t("browserCore.versionMode")), "g"))].length, 1);
  assert.equal(keyValueRow(html, t("browserCore.versionMode")), "");
  // The cache location now sits directly under the action row, above the policy fields.
  assert.ok(download.indexOf(t("browserCore.cacheDirMode")) < download.indexOf(t("browserCore.versionMode")));
  assert.ok(download.includes(t("browserCore.cacheAuto")));
  assert.ok(download.includes(t("browserCore.cacheCustom")));
  assert.ok(download.includes(`value="${cachePath}"`));
  assert.equal([...html.matchAll(/class="settings-section"/g)].length, 2);
  const labels = [...download.matchAll(/<dt>([\s\S]*?)<\/dt>/g)].map((match) => stripTags(match[1]));
  assert.deepEqual(labels, [t("browserCore.installedVersion")]);
  // In the card head, not as a row: the version belongs to the wrapper that owns this section, and a
  // key/value row here made it read as another editable setting.
  assert.equal(keyValueRow(html, t("browserCore.wrapperVersion")), "");
  assert.ok(download.includes(`class="browser-core-wrapper-version"`));
  // The label is omitted, so only the number a reader wants remains.
  assert.equal(download.includes(`${t("browserCore.wrapperVersion")} 0.5.3`), false);
});

test("a fresh target is described below version choices instead of in a status banner or footer", () => {
  const html = renderPanel({ installed: false, version: "", license: { configured: true, active: true, valid: true, plan: "solo" } });
  const download = sectionContaining(html, t("browserCore.downloadInstall"));
  // A fresh install has no pin to configure, so the policy it does show is the release channel, and the
  // target query sits beside it — above the local cache controls, not in a banner.
  // The release channel and the target version share one row, channel first; the cache controls sit
  // above both, directly under the action row.
  assert.ok(download.indexOf(t("browserCore.cacheDirMode")) < download.indexOf(t("browserCore.releaseChannel")));
  assert.ok(download.indexOf(t("browserCore.releaseChannel")) < download.indexOf(t("browserCore.targetVersion")));
  assert.ok(download.includes(t("browserCore.targetVersionLoading")));
  assert.equal(download.includes("browser-core-status-line"), false);
});

// A key that is merely unvalidated must not hide the target version: that is exactly the state before
// the first install, which is when the number matters. Only a rejected key withdraws it.
test("an unvalidated key keeps the target query and the release policy editable", () => {
  const html = renderPanel({ license: { configured: true, active: true } });
  assert.ok(html.includes(t("browserCore.targetVersionLoading")));
  assert.ok(html.includes(t("browserCore.releaseChannel")));
  assert.equal(html.includes(`<fieldset class="disabled-fieldset in-place" disabled="">`), false);
});

test("an existing four-component pin is preserved for correction and cannot trigger a download", () => {
  const html = renderPanel({ installed: false, browserVersionMode: "pinned", pinnedBrowserVersion: "156.0.8078.47", license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.ok(html.includes('value="156.0.8078.47"'));
  assert.ok(html.includes('placeholder="156.0.8078.47.1"'));
  assert.ok(html.includes(t("error.browserCorePinRevision")));
  assert.match(html, /<button class="command success"[^>]*disabled=""/);
});

test("the desktop cache picker shows a read-only path without a redundant heading", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  Object.defineProperty(globalThis, "isTauri", { value: true, configurable: true });
  try {
    const html = renderPanel({ cacheDirMode: "custom", customCacheDir: "D:/selected-cache", license: { configured: false, active: false } });
    const input = [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0]).find((markup) => markup.includes(`aria-label="${t("browserCore.customCacheDir")}"`)) ?? "";
    assert.match(input, /readonly=""/i);
    assert.ok(input.includes('value="D:/selected-cache"'));
    assert.ok(html.includes(t("browserCore.chooseCacheDirectory")));
    assert.equal(html.includes(`>${t("browserCore.customCacheDir")}<`), false);
  } finally {
    if (original) Object.defineProperty(globalThis, "isTauri", original);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

test("the input indicator reports missing, invalid and unconfirmed keys without a redundant status banner", () => {
  for (const license of [
    { configured: false, active: false },
    { configured: true, active: true, checkedAt: "2026-11-06T00:00:00Z", valid: false },
    { configured: true, active: true },
    { configured: true, active: true, checkedAt: "2026-11-06T00:00:00Z" },
  ]) {
    const html = renderPanel({ license });
    assert.equal(html.includes("browser-core-status-line"), false);
    assert.doesNotMatch(html, /class="browser-core-license-indicator valid"/);
  }
  const valid = renderPanel({ license: { configured: true, active: true, valid: true, checkedAt: "2026-11-06T00:00:00Z", plan: "free" } });
  assert.match(valid, /class="browser-core-license-indicator valid"/);
});

// Pins the three things binaryPathOverrideFrom drives. An override short-circuits ensureBinary before
// any version resolution, so the cache stops deciding what launches — but the panel kept a green ready
// line, an up-to-date badge and clickable managed actions over a binary they cannot reach.
test("an active custom binary path keeps its explicit warning without a status banner", () => {
  const html = renderPanel({ license: { configured: false, active: false }, override: "D:\\external\\chrome.exe" });

  assert.equal(html.includes("browser-core-status-line"), false);
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
  // The same check, on a card that is not running, is not this card's verdict either.
  const otherChannel = renderPanel({ channel: "private", installed: false, channelStates: { official: { installed: true, version: "146.0.7680.177.5" }, private: { installed: false } }, license: { configured: false, active: false }, update });
  assert.doesNotMatch(otherChannel, new RegExp(escapeRegExp(t("browserCore.newVersionBadge"))));
});

test("an active custom binary path disables every managed cache action", () => {
  const withOverride = renderPanel({ installed: false, license: { configured: false, active: false }, override: "D:\\external\\chrome.exe" });
  const withoutOverride = renderPanel({ installed: false, license: { configured: true, active: true, valid: true } });

  for (const managed of ["command success", "command danger subtle"]) {
    assert.match(withOverride, new RegExp(`<button class="${escapeRegExp(managed)}"[^>]*disabled=""`), managed);
    assert.doesNotMatch(withoutOverride, new RegExp(`<button class="${escapeRegExp(managed)}"[^>]*disabled=""`), managed);
  }
  // A custom executable still leaves the keyless settings form disabled.
  assert.match(withOverride, new RegExp(`<button class="command"[^>]*>[\\s\\S]*?${escapeRegExp(t("actions.checkUpdate"))}`));
  assert.match(withOverride, new RegExp(`<button class="command"[^>]*disabled=""[^>]*>[\\s\\S]*?${escapeRegExp(t("actions.checkUpdate"))}`));
});

// The documented CLOAKBROWSER_BINARY_PATH used to be reachable only through an environment row. The
// control lives under the managed actions it takes over, and its state has to be readable there.
test("the custom executable control reflects its setting", () => {
  const off = renderPanel({ license: { configured: true, active: true, valid: true } });
  assert.ok(off.includes(t("browserCore.customBinaryEnabled")));
  // Off: no path row.
  assert.equal(off.includes(t("browserCore.customBinaryPath")), false);

  const on = renderPanel({
    license: { configured: true, active: true, valid: true },
    customBinaryPathEnabled: true,
    customBinaryPath: "D:\\CloakBrowser\\chrome.exe",
  });
  // On: the stored path is shown.
  assert.ok(on.includes(t("browserCore.customBinaryPath")));
  assert.ok(on.includes("D:\\CloakBrowser\\chrome.exe"));
});

// Offline import is an entry in the card's action row, aimed at the channel the card shows. There is no
// separate section, and no tier or channel selector: the card already answered both questions.
test("offline import is an action of the card, not a separate section", () => {
  const html = renderPanel({ license: { configured: true, active: true }, channel: "private" });
  const actions = html.match(/<div class="row-actions">[\s\S]*?<\/div>/)?.[0] ?? "";

  assert.ok(actions.includes(t("browserCore.offlineImport")));
  assert.equal([...html.matchAll(/class="settings-section"/g)].length, 2);
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
    license: { configured: true, active: true, valid: true, plan: "solo" },
    update: updateCheck({ currentVersion: "146.0.7680.177.5" }),
  });

  assert.match(current, new RegExp(escapeRegExp(t("browserCore.upToDate"))));
});

// Both of these name the version they are about in their own text, so a stale check cannot be misread
// off them the way a bare "up to date" can.
test("a stale check still reports an available update and a failed check", () => {
  const available = renderPanel({
    license: { configured: true, active: true, valid: true, plan: "solo" },
    update: updateCheck({ currentVersion: "150.0.7871.114", updateAvailable: true, latestVersion: "151.0.0.1" }),
  });
  const failed = renderPanel({
    license: { configured: true, active: true, valid: true },
    update: updateCheck({ currentVersion: "150.0.7871.114", error: "offline" }),
  });

  assert.match(available, new RegExp(escapeRegExp(t("browserCore.newVersionBadge"))));
  assert.match(failed, new RegExp(escapeRegExp(t("browserCore.updateCheckFailed"))));
});

test("update errors translate both their visible text and tooltip while unconfigured licenses show only setup state", () => {
  const error = "English license details from a prior check";
  const update = updateCheck({ error, errorCode: "BROWSER_CORE_LICENSE_REQUIRED" });
  const configured = renderPanel({ license: { configured: true, active: true, valid: true }, update });
  assert.equal(configured.includes(error), false);
  assert.ok(configured.includes(t("error.browserCoreLicenseRequired")));
  const pending = renderPanel({ license: { configured: false, active: false }, update });
  assert.equal(pending.includes(error), false);
  assert.equal(pending.includes(t("browserCore.updateCheckFailed")), false);
  assert.equal(licenseIndicatorLabel(pending), t("browserCore.licensePlanNone"));
});

// The override stays visible as a warning without adding permanent filesystem rows.
test("an active override keeps its warning while redundant mode and filesystem rows are omitted", () => {
  const html = renderPanel({
    license: { configured: false, active: false },
    override: "D:\\portable\\chrome.exe",
  });

  assert.ok(html.includes(t("browserCore.overrideTakesOver", { path: "D:\\portable\\chrome.exe" })));
  const labels = [...sectionContaining(html, t("browserCore.downloadInstall")).matchAll(/<dt>([\s\S]*?)<\/dt>/g)].map((match) => stripTags(match[1]));
  assert.deepEqual(labels, [t("browserCore.customVersion")]);
});

// The web entry cannot read a real path, so its path row is only rendered after the operator asks for
// the import. Rendering it permanently put a full-width hint under the action row and left the input at
// about 62px in en-US.
test("the web import path row is opened from the action, not rendered in the card", () => {
  const html = renderPanel({ license: { configured: false, active: false } });

  assert.equal(html.includes(t("browserCore.webManualPathOnly")), false);
  assert.equal(html.includes(t("browserCore.importZipPlaceholder")), false);
  const actions = html.match(/<div class="row-actions">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(actions.includes(t("browserCore.offlineImport")));
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
    license: { configured: true, active: true, valid: true, plan: "solo" },
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
  browserVersionMode?: "latest" | "pinned";
  pinnedBrowserVersion?: string;
  version?: string;
  cacheDirMode?: "auto" | "custom";
  customCacheDir?: string;
  binaryPath?: string;
  importedBuild?: BrowserCoreImportedBuild;
  installed?: boolean;
  installedTier?: "free" | "pro";
  license: BrowserCoreLicenseState;
  override?: string;
  planIsFree?: boolean;
  targetTier?: "free" | "pro";
  update?: BrowserCoreUpdateCheck;
  channel?: "official" | "private";
  mode?: "online" | "offline";
  unlocked?: boolean;
  internalPrivatePath?: boolean;
  tokenConfigured?: boolean;
  channelStates?: BrowserCoreInfo["channels"];
  officialLicense?: BrowserCoreInfo["officialLicense"];
  hasActiveSessions?: boolean;
  repositoryUrl?: string;
  customBinaryPathEnabled?: boolean;
  customBinaryPath?: string;
};

// The trigger lives in the section head as plain text. A button, a hover colour or an aria-label naming
// it are all ways of announcing that something is there to click, which defeats the point of hiding it.
// The label is gone and only the number remains: the row already sits beside the channel it belongs to,
// and "Wrapper" named the component rather than the fact.
test("the locked card shows only the wrapper version number, as inert text, and reveals no private feature", () => {
  const html = renderPanel({ license: { configured: false, active: false } });
  const trigger = html.match(/<span class="browser-core-wrapper-version"[^>]*>[^<]*<\/span>/)?.[0] ?? "";
  assert.ok(trigger);
  assert.ok(trigger.includes("0.5.3"));
  assert.equal(stripTags(trigger).trim(), "0.5.3");
  assert.doesNotMatch(trigger, /aria-label|role="button"|tabindex/i);
  assert.equal(html.includes(`<button class="browser-core-wrapper-version`), false);
  assert.equal(html.includes(t("browserCore.privateRepository")), false);
  assert.equal(html.includes("https://github.com/example/private-core"), false);
});

// One card, one channel. The private channel's settings are only on the private card, so the official
// card never exposes a field that belongs to another channel.
test("the card shows the active channel and hides the other channel's settings", () => {
  const official = renderPanel({ channel: "official", unlocked: true, license: { configured: false, active: false } });
  assert.ok(official.includes(t("browserCore.channelOfficial")));
  assert.equal(official.includes(t("browserCore.privateRepository")), false);
  assert.equal(official.includes(t("browserCore.privateToken")), false);
  assert.ok(official.includes(`aria-label="${t("browserCore.licenseKey")}"`));
});

test("a private managed core omits official licensing and treats its internal path as managed", () => {
  const html = renderPanel({ channel: "private", override: "D:/private/chrome.exe", internalPrivatePath: true, license: { configured: false, active: false } });
  assert.equal(html.includes(`aria-label="${t("browserCore.licenseKey")}"`), false);
  assert.equal(html.includes(t("browserCore.targetVersionLoading")), false);
  assert.equal(html.includes(t("browserCore.overrideTakesOver", { path: "D:/private/chrome.exe" })), false);
  assert.equal(html.includes(t("browserCore.licenseKey")), false, "the private card carries no license field at all");
  assert.ok(html.includes(t("browserCore.privateRepository")));
  const clear = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === t("actions.clearCache"));
  assert.ok(clear);
  assert.doesNotMatch(clear, /disabled=""/);
});

// The card labels the channel it shows only when that channel has a build. "Not installed" is not a
// label: the install action already says so, and on the hidden channel such a label would announce it.
test("a channel with nothing on disk shows no channel label, only the install action", () => {
  const html = renderPanel({ channel: "official", installed: false, channelStates: { official: { installed: false }, private: { installed: false } }, license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.equal(html.includes(`class="pill`), false);
  const install = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === t("actions.install"));
  assert.ok(install);
  assert.doesNotMatch(install, /disabled=""/);
});

// The card no longer labels the channel it shows: the two channels are one card at a time and exactly
// one runs, so "私有维护 · 当前使用" repeated what the actions below already said.
test("a channel that is installed is not labelled in the card head", () => {
  const html = renderPanel({ channel: "official", channelStates: { official: { installed: true, version: "156.0.8078.47.2" }, private: { installed: true, version: "156.0.8078.47.3" } }, license: { configured: false, active: false } });
  // Neither label exists any more: the channel is implied by which card is shown, not stated again.
  assert.equal(html.includes("当前使用"), false);
  assert.equal(html.includes("已安装，未启用"), false);
  assert.equal(html.includes(`class="pill`), false);
});

// The mode toggle belongs to the running channel. On a channel that is not running there is nothing to
// take offline, so the control is static rather than an enabled button that would answer 409.
test("the online/offline toggle is live on the active channel and static on the other", () => {
  const active = renderPanel({ channel: "official", mode: "online", license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.ok(active.includes(`aria-label="${t("browserCore.switchOffline")}"`));
  const activeToggle = active.match(/<button[^>]*browser-core-mode-toggle[^>]*>/)?.[0] ?? "";
  assert.doesNotMatch(activeToggle, /disabled=""/);
});

// The card the gesture lands on when the official build is missing has to be able to fetch it. With the
// private channel running, `core.license` is the private placeholder — reading it there made a configured
// official key look absent and disabled the very install that gets the operator back to official.
test("the official card stays installable while the private channel runs", () => {
  // The other-channel card is only reachable through the gesture, which a static render cannot perform,
  // so the derivation that gates the install is asserted directly.
  assert.equal(officialLicenseUsable({
    displayIsActive: false,
    license: { configured: false, active: false, plan: "private" },
    licenseIssue: undefined,
    officialLicense: { configured: true, valid: true, plan: "solo" },
  }), true);
  // A key that was never validated is not a rejected one.
  assert.equal(officialLicenseUsable({
    displayIsActive: false,
    license: { configured: false, active: false, plan: "private" },
    licenseIssue: undefined,
    officialLicense: { configured: true },
  }), true);
  // No official key at all still blocks, and so does a rejected one.
  assert.equal(officialLicenseUsable({ displayIsActive: false, license: { configured: false, active: false }, licenseIssue: undefined, officialLicense: { configured: false } }), false);
  assert.equal(officialLicenseUsable({ displayIsActive: false, license: { configured: false, active: false }, licenseIssue: undefined, officialLicense: { configured: true, valid: false } }), false);
  // On the running official card the live state is what counts.
  assert.equal(officialLicenseUsable({ displayIsActive: true, license: { configured: true, active: true, valid: true }, licenseIssue: undefined, officialLicense: { configured: true, valid: true } }), true);
  assert.equal(officialLicenseUsable({ displayIsActive: true, license: { configured: false, active: false }, licenseIssue: "required", officialLicense: { configured: true, valid: true } }), false);
});

// A key the server actually rejected is a different state from one that was never validated, and it
// still stops the download it could not authenticate.
test("a rejected official key disables the official install", () => {
  const html = renderPanel({
    channel: "official",
    license: { configured: true, active: true, valid: false },
    officialLicense: { configured: true, valid: false },
    installed: false,
  });
  const install = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === t("actions.install"));
  assert.match(install ?? "", /disabled=""/);
});

test("offline mode replaces the target version with the stored hint and keeps cache management available", () => {
  const html = renderPanel({ channel: "official", mode: "offline", internalPrivatePath: true, browserVersionMode: "pinned", pinnedBrowserVersion: "155.0.8059.39.1", license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.ok(html.includes(`aria-label="${t("browserCore.switchOnline")}"`));
  assert.equal(html.includes(t("browserCore.targetVersionLoading")), false);
  assert.equal(html.includes(t("browserCore.releaseChannel")), false, "online release policy stays dormant while offline");
  assert.equal(html.includes(t("browserCore.versionMode")), false);
  assert.equal(html.includes("155.0.8059.39.1"), false);
  const clear = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === t("actions.clearCache"));
  assert.doesNotMatch(clear ?? "", /disabled=""/);
});

// Offline is a mode of the active channel, not a network switch over the whole panel: the private card's
// repository is not the one running offline, so its connection controls stay usable.
test("an official offline install does not suspend the private repository controls", () => {
  const html = renderPanel({ channel: "official", mode: "offline", unlocked: true, license: { configured: false, active: false } });
  assert.equal(html.includes(t("browserCore.privateRepository")), false);
  // The card is official, so the private settings are simply not rendered; the private card, when shown,
  // always offers its connection controls in online mode. The refresh control is an icon, so it is found
  // by its accessible name rather than by text.
  const privateCard = renderPanel({ channel: "private", unlocked: true, license: { configured: false, active: false } });
  assert.ok(privateCard.includes(t("browserCore.privateTest")));
  assert.ok(privateCard.includes(`aria-label="${t("browserCore.privateRefresh")}"`));
});

// Each credential gets its own row, and the connection test is an icon inside the field it tests.
test("the private card gives the repository and the key one row each with an inline test control", () => {
  const html = renderPanel({ channel: "private", license: { configured: false, active: false } });
  const repositoryField = keyValueCells(html, t("browserCore.privateRepository"));
  void repositoryField;
  const inputs = [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0]);
  const repository = inputs.find((markup) => markup.includes('inputMode="url"')) ?? "";
  const key = inputs.find((markup) => markup.includes(`aria-label="${t("browserCore.privateToken")}"`)) ?? "";
  assert.ok(repository);
  assert.ok(key);
  // Separate rows means the two controls are not siblings inside one flex/grid row.
  const between = html.slice(html.indexOf(repository), html.indexOf(key));
  assert.ok(between.includes("</div>"), "the repository row closes before the key row starts");
  assert.ok(html.includes(`aria-label="${t("browserCore.privateTest")}"`));
});

// The live control and the static readout must be the same shape: switching cards may change the glyph,
// never the box around it. The static branch only renders once the card has been moved off the running
// channel, which a static render cannot do, so the shared class set is asserted at the source of truth.
test("the mode control and its static readout share one class set", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./BrowserCoreSettingsPanel.tsx", import.meta.url), "utf8");
  const live = source.match(/className="([^"]*browser-core-mode-toggle[^"]*)"/)?.[1] ?? "";
  const readout = source.match(/className="([^"]*browser-core-mode-static[^"]*)"/)?.[1] ?? "";
  assert.ok(live.includes("icon-button"));
  assert.ok(readout.includes("icon-button"));
  assert.ok(live.includes("borderless"));
  assert.ok(readout.includes("borderless"));
});

// One rule for both cards: the icon is a control only where the switch can act, and an inert readout
// everywhere else. Previously the other card rendered a live-looking cloud with no hover state while a
// disabled live card rendered a not-allowed cursor, so the same glyph meant two different things.
test("the mode icon is a hoverable control only where the switch can act and inert elsewhere", () => {
  // A running card with a build and no blockers: a real button.
  const live = renderPanel({ channel: "official", installed: true, license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.match(live, /<button[^>]*browser-core-mode-toggle[^>]*>/);
  assert.equal(live.includes("browser-core-mode-static"), false);
  // Sessions in flight: the toggle cannot act, so it is the readout, not a disabled button.
  const blocked = renderPanel({ channel: "official", installed: true, hasActiveSessions: true, license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.equal(blocked.includes("browser-core-mode-toggle"), false);
  assert.match(blocked, /<span[^>]*browser-core-mode-static[^>]*>/);
  // Nothing on disk: there is no mode to switch yet, so the icon reports the configured mode and does
  // not offer a hover state. This is the same branch the non-running card renders.
  const empty = renderPanel({ channel: "official", installed: false, channelStates: { official: { installed: false }, private: { installed: false } }, license: { configured: true, active: true, valid: true, plan: "solo" } });
  assert.equal(empty.includes("browser-core-mode-toggle"), false);
  assert.ok(empty.includes(`title="${t("browserCore.modeOnline")}"`));
});

// A pasted repository URL carries the page the operator was viewing. The canonical owner/repository is
// what the panel validates, tests and stores, so the noise never reaches the server.
test("a pasted repository URL is reduced to the canonical repository before it is used", async () => {
  const { normalizeGithubRepositoryUrl } = await import("../../shared/githubRepository");
  assert.equal(normalizeGithubRepositoryUrl("https://github.com/owner/repository/tree/main/apps/site"), "https://github.com/owner/repository");
  assert.equal(normalizeGithubRepositoryUrl("https://github.com/owner/repository?tab=readme-ov-file#install"), "https://github.com/owner/repository");
  assert.equal(normalizeGithubRepositoryUrl("https://github.com/owner/repository.git"), "https://github.com/owner/repository");
  // The test button is gated on the same value, so an invalid draft keeps it inert.
  const html = renderPanel({ channel: "private", license: { configured: false, active: false } });
  const test = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => (markup.match(/aria-label="([^"]*)"/)?.[1] ?? "").startsWith(t("browserCore.privateTest")));
  assert.ok(test);
  assert.match(test, /disabled=""/, "no typed key means nothing to test");
});

// The two supported GitHub credential shapes are recognised by prefix; anything else is rejected before
// a request is made, so a mistyped key fails on the field instead of as a 401 from GitHub.
test("only fine-grained and classic GitHub token shapes pass the field check", async () => {
  const { githubTokenKind } = await import("../../shared/githubToken");
  assert.equal(githubTokenKind(`github_pat_${"a".repeat(40)}`), "fine-grained");
  assert.equal(githubTokenKind(`ghp_${"A".repeat(36)}`), "classic");
  assert.equal(githubTokenKind(`ghp_${"A".repeat(36)}`), "classic");
  for (const value of ["", "token-A", `github_pat_short`, `ghp_${"a".repeat(10)}`, `gho_${"a".repeat(36)}`, `ghp_${"a".repeat(35)}`]) {
    assert.equal(githubTokenKind(value), undefined, value);
  }
});

// The release row has nothing to list until both halves of the credential are on file: the list is
// fetched with the stored key against the stored repository.
test("the release row stays locked until a repository and a key are both on file", () => {
  const locked = renderPanel({ channel: "private", tokenConfigured: false, license: { configured: false, active: false } });
  assert.ok(locked.includes(t("browserCore.privateReleasesLocked")));
  assert.equal(locked.includes(`aria-label="${t("browserCore.privateRefresh")}"`), false);
  // A key is on file but the repository is not: still nothing to list.
  const noRepository = renderPanel({ channel: "private", tokenConfigured: true, repositoryUrl: "", license: { configured: false, active: false } });
  assert.ok(noRepository.includes(t("browserCore.privateReleasesLocked")));
  assert.equal(noRepository.includes(`aria-label="${t("browserCore.privateRefresh")}"`), false);
  const connected = renderPanel({ channel: "private", tokenConfigured: true, license: { configured: false, active: false } });
  assert.equal(connected.includes(t("browserCore.privateReleasesLocked")), false);
  assert.ok(connected.includes(`aria-label="${t("browserCore.privateRefresh")}"`));
});

// The private card's key field can carry three controls. They are ordered the way they are used, and
// each appears only when it can act: the reveal toggle needs something typed, the clear control needs a
// stored key, and the test control is always last so its position is stable.
test("the key field orders reveal, clear and test and only shows controls that can act", () => {
  const html = renderPanel({ channel: "private", tokenConfigured: true, license: { configured: false, active: false } });
  const field = html.slice(html.indexOf(`aria-label="${t("browserCore.privateToken")}"`), html.indexOf(t("browserCore.privateConfigurationUnsaved")));
  // A stored key can be cleared and re-tested, but nothing is typed, so there is nothing to reveal.
  assert.ok(field.includes("browser-core-license-clear"));
  assert.ok(field.includes("browser-core-license-test"));
  assert.equal(field.includes("browser-core-license-reveal"), false);
  assert.ok(field.indexOf("browser-core-license-clear") < field.indexOf("browser-core-license-test"));
  // No stored key: the clear control is gone, the test control keeps its place.
  const fresh = renderPanel({ channel: "private", tokenConfigured: false, license: { configured: false, active: false } });
  const freshField = fresh.slice(fresh.indexOf(`aria-label="${t("browserCore.privateToken")}"`), fresh.indexOf(t("browserCore.privateConfigurationUnsaved")));
  assert.equal(freshField.includes("browser-core-license-clear"), false);
  assert.ok(freshField.includes("browser-core-license-test"));
  assert.match(freshField, /<button[^>]*browser-core-license-test[^>]*disabled=""/, "nothing typed, nothing to test");
});

// A card that is not the running channel acts on itself: the update and check actions must be pointed at
// the displayed channel, not at whichever one happens to be running.
test("a private card offers release installs but no official update check", () => {
  const html = renderPanel({ channel: "private", mode: "online", license: { configured: false, active: false } });
  const buttonByLabel = (markup: string, label: string) => [...markup.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((item) => stripTags(item) === label);
  assert.ok(html.includes(t("browserCore.privateRefresh")));
  assert.equal(buttonByLabel(html, t("actions.update")), undefined);
});

// The channel switch is the version label's gesture and nothing else. A visible "switch back" button
// would be a second path to the same state, and the card must not offer two answers to one question.
test("the private card offers no separate switch back to the official channel", () => {
  const html = renderPanel({ channel: "private", license: { configured: false, active: false } });
  const button = [...html.matchAll(/<button[^>]*>[\s\S]*?<\/button>/g)].map((match) => match[0]).find((markup) => stripTags(markup) === "切换到官方渠道");
  assert.equal(button, undefined);
  assert.equal(html.includes("切换到官方渠道"), false);
  // The gesture trigger itself is still the only switch, and it stays inert text.
  assert.ok(html.includes(`class="browser-core-wrapper-version"`));
});

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
        activateCoreChannel: async () => undefined,
        loadPrivateReleases: async () => [],
        testPrivateRepository: async () => ({ configured: true }),
        installPrivateVersion: async () => undefined,
        clearPrivateToken: async () => undefined,
        hasActiveSessions: patch.hasActiveSessions,
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
      browserVersionMode: patch.browserVersionMode ?? "latest",
      pinnedBrowserVersion: patch.pinnedBrowserVersion ?? "",
      cacheDirMode: patch.cacheDirMode ?? "auto",
      customCacheDir: patch.customCacheDir ?? "",
      coreChannel: patch.channel ?? "official",
      coreChannelMode: patch.mode ?? "online",
      privateChannelUnlocked: patch.unlocked ?? false,
      privateRepositoryUrl: patch.repositoryUrl ?? "https://github.com/example/private-core",
      customBinaryPathEnabled: patch.customBinaryPathEnabled ?? false,
      customBinaryPath: patch.customBinaryPath ?? "",
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
      source: patch.internalPrivatePath ? "cbpanel-default" : "settings",
      sensitive: false,
      valueKind: "path",
      requiresRuntimeRestart: false,
    });
  }
  const core: BrowserCoreInfo = {
    channel: patch.channel ?? "official",
    channelMode: patch.mode ?? "online",
    licensePolicy: patch.channel === "private" ? "not-applicable" : "official",
    privateTokenConfigured: patch.tokenConfigured ?? true,
    channels: patch.channelStates ?? { official: { installed: true, version: "146.0.7680.177.5" }, private: { installed: false } },
    // The official channel's own key state, independent of which channel runs. It mirrors the fixture's
    // `license` unless a test says otherwise, which is the case a private activation would break.
    officialLicense: patch.officialLicense ?? { configured: patch.license.active, valid: patch.license.valid, plan: patch.license.plan },
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
      chromiumVersion: patch.version ?? "146.0.7680.177.5",
      wrapperVersion: "0.5.3",
    },
    license: patch.license,
    env,
    update: patch.update,
    importedBuild: patch.importedBuild,
    portable: false,
    cacheManagedByCBPanel: true,
    restartRequired: false,
  };
  return {
    version: patch.version ?? "146.0.7680.177.5",
    licenseRequired: !patch.override && !patch.license.active,
    licenseValid: patch.override ? undefined : patch.license.valid,
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

function licenseIndicatorLabel(html: string): string {
  const indicator = html.match(/<button[^>]*data-license-state[^>]*>/)?.[0] ?? "";
  return indicator.match(/aria-label="([^"]*)"/)?.[1] ?? "";
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
