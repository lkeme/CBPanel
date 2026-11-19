import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { mergeSettings, normalizeSettings } from "../../src/shared/settings";
import { SqlitePanelRepository } from "../storage/sqliteStore";
import { BinaryService, type BinaryServiceOptions, type CloakBrowserModule } from "./binaryService";

const envKeys = ["CLOAKBROWSER_BINARY_PATH", "CLOAKBROWSER_CACHE_DIR", "CLOAKBROWSER_VERSION", "CLOAKBROWSER_LICENSE_KEY", "CLOAKBROWSER_AUTO_UPDATE", "CLOAKBROWSER_RELEASE_CHANNEL", "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS"];
const platform = `${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;
const assetPlatform = platform.replace(/^darwin-/, "macos-");
const executableName = process.platform === "win32" ? "chrome.exe" : process.platform === "darwin" ? "Chromium.app/Contents/MacOS/Chromium" : "chrome";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-channel-test-"));
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  for (const key of envKeys) delete process.env[key];
  let settings = normalizeSettings({ binary: { licenseKey: "official-fixture-key", privateRepositoryUrl: "https://github.com/example/private-core" } });
  let releaseVersion = "156.0.8078.47.1";
  let saveFails = false;
  let sessions = false;
  let fetches = 0;
  let validations = 0;
  let executableVersion = "156.0.8078.47";
  let catalogGate: Promise<void> | undefined;
  const archive = () => zipSync({ [`chromium-v${releaseVersion}/${executableName}`]: new TextEncoder().encode("fixture-executable") });
  const options: BinaryServiceOptions = {
    dataDir: root, portable: false, readSettings: async () => settings,
    saveSettings: async (patch) => { if (saveFails && patch.binary?.privateReleaseVersion) throw new Error("fixture save failure"); settings = mergeSettings(settings, patch); return settings; },
    hasActiveSessions: () => sessions, readPrivateToken: async () => "fixture-token",
    readExecutableVersion: async () => executableVersion,
    fetchImpl: (async (input: string | URL | Request) => {
      fetches += 1;
      const url = String(input);
      if (url.includes("cloakbrowser.dev/api/download/version")) { await catalogGate; return Response.json({ version: releaseVersion }); }
      if (url.includes("/releases?")) { await catalogGate; return Response.json([{ id: 1, name: `CloakBrowser Pro ${releaseVersion} (VERIFIED)`, assets: [{ id: 10, name: `cloakbrowser-${assetPlatform}.zip` }, { id: 11, name: "SHA256SUMS" }] }]); }
      if (url.endsWith("/11")) return new Response(`${createHash("sha256").update(archive()).digest("hex")}  cloakbrowser-${assetPlatform}.zip\n`);
      if (url.endsWith("/10")) return new Response(archive() as BodyInit);
      throw new Error("unexpected fixture network request");
    }) as typeof fetch,
    loadCloakBrowser: async () => ({
      binaryInfo: () => ({ version: "155.0.8059.39.1", platform, binaryPath: path.join(root, "cloakbrowser-cache", "chromium-155.0.8059.39.1-pro", executableName), cacheDir: path.join(root, "cloakbrowser-cache", "chromium-155.0.8059.39.1-pro"), installed: false, downloadUrl: "", tier: "pro" }),
      ensureBinary: async () => { throw new Error("private mode must never download an official binary"); },
      validateLicense: async () => { validations += 1; return null; },
      clearCache: () => rmSync(process.env.CLOAKBROWSER_CACHE_DIR!, { recursive: true, force: true }),
    } as unknown as CloakBrowserModule),
  };
  const service = new BinaryService(options);
  return {
    root, service, reopen: () => new BinaryService(options), settings: () => settings, patchSettings: (patch: Parameters<typeof mergeSettings>[1]) => { settings = mergeSettings(settings, patch); }, setVersion: (value: string) => { releaseVersion = value; }, setExecutableVersion: (value: string) => { executableVersion = value; }, setCatalogGate: (value: Promise<void> | undefined) => { catalogGate = value; }, failSave: (value: boolean) => { saveFails = value; }, setSessions: (value: boolean) => { sessions = value; }, counts: () => ({ fetches, validations }),
    cleanup: async () => { for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } await fs.rm(root, { recursive: true, force: true }); },
  };
}

test("a private release installs, activates with its full release version, and retains one build", async () => {
  const f = await fixture();
  try {
    // The default fixture has no sessions, so the install activates the private channel it just built.
    // Without one the prepared build would sit in a cache nothing launches from.
    const installed = await f.service.installPrivateRelease(undefined, {}, { activate: true });
    assert.equal(installed.info.core.channel, "private");
    assert.equal(f.settings().binary.coreChannel, "private");
    const validationsBeforeActivation = f.counts().validations;
    await f.service.activateChannel("private", "online");
    const active = await f.service.readPublicInfo();
    assert.equal(active.version, "156.0.8078.47.1");
    assert.equal(active.installed, true);
    assert.equal(active.licenseRequired, false);
    assert.equal(active.core.licensePolicy, "not-applicable");
    assert.equal(active.core.env.find((row) => row.key === "CLOAKBROWSER_BINARY_PATH")?.source, "cbpanel-default");
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, undefined);
    f.setVersion("156.0.8078.47.2");
    await f.service.installPrivateRelease();
    const privateRoot = path.join(f.root, "cloakbrowser-cache-private", platform);
    assert.deepEqual((await fs.readdir(privateRoot)).filter((name) => /^\d/.test(name)), ["156.0.8078.47.2"]);
    assert.equal(f.counts().validations, validationsBeforeActivation);
  } finally { await f.cleanup(); }
});

test("a failed publication keeps the old private binary and pointer; running sessions block replacement and activation", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease();
    await f.service.activateChannel("private", "online");
    f.setVersion("156.0.8078.47.2");
    f.failSave(true);
    await assert.rejects(f.service.installPrivateRelease(), /fixture save failure/);
    assert.equal((await f.service.readInfo()).version, "156.0.8078.47.1");
    f.failSave(false);
    f.setSessions(true);
    await assert.rejects(f.service.installPrivateRelease(), { code: "BROWSER_CORE_SESSIONS_RUNNING" });
    await assert.rejects(f.service.activateChannel("official", "online"), { code: "BROWSER_CORE_SESSIONS_RUNNING" });
  } finally { await f.cleanup(); }
});

test("offline private mode makes no update requests and ordinary settings cannot bypass channel activation", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease();
    await f.service.activateChannel("private", "offline");
    const before = f.counts();
    await f.service.checkUpdate();
    await f.service.readTargetVersion();
    await assert.rejects(f.service.listPrivateReleases(), { code: "BROWSER_CORE_OFFLINE_MODE" });
    await assert.rejects(f.service.update(), { code: "BROWSER_CORE_OFFLINE_MODE" });
    await assert.rejects(f.service.install(), { code: "BROWSER_CORE_OFFLINE_MODE" });
    // Offline suspends every network call the private channel would make. The counted reads above are
    // local, and neither the update check nor the rejected actions add a request.
    assert.deepEqual(f.counts(), before, "offline private requests stay local");
    // Explicitly aiming at the running channel is the same refusal, and aiming at the other one is not
    // blocked by this channel's offline mode — that is the route out of it.
    await assert.rejects(f.service.install({ targetChannel: "private" }), { code: "BROWSER_CORE_OFFLINE_MODE" });
    await assert.rejects(f.service.assertSettingsPatchAllowed({ binary: { coreChannel: "official" } }), { code: "BROWSER_CORE_ACTIVATION_REQUIRED" });
  } finally { await f.cleanup(); }
});

test("official offline install does not block private repository access", async () => {
  const f = await fixture();
  try {
    // Official + offline is a state the user can only leave by acting on the *private* channel: either
    // switching back to online or installing a private build. Gating repository access on the active
    // channel's mode removed both routes, so offline has to mean "this channel, offline".
    f.patchSettings({ binary: { coreChannel: "official", coreChannelMode: "offline" } });
    const releases = await f.service.listPrivateReleases();
    assert.deepEqual(releases.releases.map((release) => release.version), ["156.0.8078.47.1"]);
    await f.service.installPrivateRelease();
    assert.equal((await f.service.readPublicInfo()).core.channels.private.installed, true);
  } finally { await f.cleanup(); }
});

test("clearing the official cache cannot remove its private sibling, and missing private builds never resolve official binaries", async () => {
  const f = await fixture();
  try {
    // An official build and a private build, both on disk, with private running.
    const officialArchive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(officialArchive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    await f.service.installImportZip(officialArchive, { targetChannel: "official" });
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    const privateRoot = path.join(f.root, "cloakbrowser-cache-private", platform);

    // Clearing the official channel must not touch the private sibling.
    await f.service.clearCache({ targetChannel: "official" });
    assert.equal((await f.service.readInfo()).installed, true);
    assert.deepEqual((await fs.readdir(privateRoot)).filter((name) => /^\d/.test(name)), ["156.0.8078.47.1"]);

    // Clearing the private channel keeps its build in use, which is the only one there.
    await f.service.clearCache();
    const cleared = await f.service.readInfo();
    assert.equal(cleared.installed, true, "the running build is kept");
    assert.equal(cleared.version, "156.0.8078.47.1");
    assert.ok(await fs.stat(path.join(privateRoot, "156.0.8078.47.1")));
  } finally { await f.cleanup(); }
});

test("private offline import rejects four-part packages, cleans its own old build, and can remain pending while official sessions run", async () => {
  const f = await fixture();
  try {
    // Nothing published yet: the gesture keys "can this be enabled" off this, so it has to be false here
    // and true after a build lands, independently of which channel is active.
    assert.equal((await f.service.readPublicInfo()).core.channels.private.installed, false);
    await f.service.installPrivateRelease();
    assert.equal((await f.service.readPublicInfo()).core.channels.private.installed, true);
    const fourPart = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(fourPart, zipSync({ [`chromium-v156.0.8078.47/${executableName}`]: new TextEncoder().encode("fixture") }));
    assert.equal((await f.service.analyzeImportZip(fourPart, { targetChannel: "private" })).allowed, false);
    await fs.writeFile(fourPart, zipSync({ [`chromium-v156.0.8078.47.3/${executableName}`]: new TextEncoder().encode("fixture") }));
    f.setSessions(true);
    const imported = await f.service.installImportZip(fourPart, { targetChannel: "private" });
    assert.equal(imported.pendingActivation, true);
    assert.equal((await f.service.readPublicInfo()).core.channels.private.version, "156.0.8078.47.3");
    assert.equal(f.settings().binary.coreChannel, "official");
    const privateRoot = path.join(f.root, "cloakbrowser-cache-private", platform);
    assert.deepEqual((await fs.readdir(privateRoot)).filter((name) => /^\d/.test(name)), ["156.0.8078.47.3"]);
    f.setSessions(false);
    await f.service.activateChannel("private", "offline");
    const active = await f.service.readPublicInfo();
    assert.equal(active.version, "156.0.8078.47.3");
    assert.equal(active.core.importedBuild?.source, "offline-import");
    const provenance = JSON.parse(await fs.readFile(path.join(privateRoot, active.version, "cbpanel-import.json"), "utf8"));
    assert.equal(provenance.channel, "private");
  } finally { await f.cleanup(); }
});

test("official offline imports stay pending until activation and retain official license policy", async () => {
  const f = await fixture();
  try {
    const archivePath = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    const write = async (version: string) => fs.writeFile(archivePath, zipSync({ [`chromium-v${version}/${executableName}`]: new TextEncoder().encode("fixture") }));
    await write("156.0.8078.47.1");
    await f.service.installImportZip(archivePath, { targetChannel: "official" });
    assert.equal(f.settings().binary.coreChannelMode, "offline");
    assert.equal((await f.service.readInfo()).version, "156.0.8078.47.1");
    f.setSessions(true);
    await write("156.0.8078.47.2");
    const pending = await f.service.installImportZip(archivePath, { targetChannel: "official" });
    assert.equal(pending.pendingActivation, true);
    for (const key of envKeys) delete process.env[key];
    const reopened = await f.reopen().readPublicInfo();
    assert.equal(reopened.core.channels.official.version, "156.0.8078.47.2");
    assert.equal((await f.service.readInfo()).version, "156.0.8078.47.1");
    f.setSessions(false);
    await f.service.activateChannel("official", "offline");
    const active = await f.service.readInfo();
    assert.equal(active.version, "156.0.8078.47.2");
    assert.equal(active.licenseRequired, false);
    assert.equal(process.env.CLOAKBROWSER_LICENSE_KEY, "official-fixture-key");
    assert.equal(process.env.CLOAKBROWSER_BINARY_PATH, active.binaryPath);
    const before = f.counts();
    await f.service.checkUpdate();
    await f.service.readTargetVersion();
    assert.deepEqual(f.counts(), before);
  } finally { await f.cleanup(); }
});

test("official offline activation suspends an old online pin and prunes against the imported build", async () => {
  const f = await fixture();
  try {
    const old = "155.0.8059.39.1";
    const next = "156.0.8078.47.1";
    const cache = path.join(f.root, "cloakbrowser-cache");
    const oldExecutable = path.join(cache, `chromium-${old}-pro`, executableName);
    await fs.mkdir(path.dirname(oldExecutable), { recursive: true });
    await fs.writeFile(oldExecutable, "fixture");
    f.patchSettings({ binary: { coreChannel: "private", browserVersionMode: "pinned", pinnedBrowserVersion: old } });
    f.setSessions(true);
    const archive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(archive, zipSync({ [`chromium-v${next}/${executableName}`]: new TextEncoder().encode("fixture") }));
    assert.equal((await f.service.installImportZip(archive, { targetChannel: "official" })).pendingActivation, true);
    f.setSessions(false);
    const activated = await f.service.activateChannel("official", "offline");
    assert.equal(activated.info.version, next);
    assert.deepEqual((await fs.readdir(cache)).filter((name) => name.startsWith("chromium-")), [`chromium-${next}-pro`]);
    assert.equal(f.settings().binary.pinnedBrowserVersion, old, "online policy is retained without controlling offline activation");
  } finally { await f.cleanup(); }
});

// Offline is a mode, not a property of the build: the clear keeps the build in use, so the channel can
// be taken offline and back without the cache having to be emptied first.
test("a channel can leave offline mode while its build stays on disk", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease();
    await f.service.activateChannel("private", "offline");
    await f.service.clearCache();
    assert.equal((await f.service.readInfo()).installed, true, "the running build survived the clear");
    const privateOnline = await f.service.activateChannel("private", "online");
    assert.equal(privateOnline.info.core.channelMode, "online");
    assert.equal(privateOnline.info.core.channels.private.installed, true, "the private build is still on disk");
    const archive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(archive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    await f.service.installImportZip(archive, { targetChannel: "official" });
    await f.service.activateChannel("official", "offline");
    await f.service.clearCache({ targetChannel: "official" });
    const officialOnline = await f.service.activateChannel("official", "online");
    assert.equal(officialOnline.info.core.channelMode, "online");
    assert.equal(officialOnline.info.core.channels.official.installed, true, "the official build is still on disk");
  } finally { await f.cleanup(); }
});

test("private pointers survive moving the complete portable data directory", async () => {
  const f = await fixture();
  const moved = `${f.root}-moved`;
  try {
    await f.service.installPrivateRelease();
    await f.service.activateChannel("private", "offline");
    const privateRoot = path.join(f.root, "cloakbrowser-cache-private", platform);
    const pointer = JSON.parse(await fs.readFile(path.join(privateRoot, "current.json"), "utf8"));
    assert.equal(path.isAbsolute(pointer.executablePath), false);
    await fs.rename(f.root, moved);
    for (const key of envKeys) delete process.env[key];
    const service = new BinaryService({ dataDir: moved, portable: true, readSettings: async () => f.settings(), loadCloakBrowser: async () => ({
      binaryInfo: () => ({ version: "", platform, binaryPath: "", cacheDir: "", installed: false, downloadUrl: "" }),
      ensureBinary: async () => { throw new Error("unexpected download"); }, clearCache: () => undefined, validateLicense: async () => null,
    } as unknown as CloakBrowserModule) });
    const info = await service.readInfo();
    assert.equal(info.installed, true);
    assert.ok(info.binaryPath.startsWith(moved));
    assert.equal(info.version, "156.0.8078.47.1");
    pointer.executablePath = path.join("..", "..", "escape", executableName);
    await fs.writeFile(path.join(moved, "cloakbrowser-cache-private", platform, "current.json"), JSON.stringify(pointer));
    assert.equal((await service.readInfo()).installed, false, "relative traversal is still refused");
  } finally { await f.cleanup(); await fs.rm(moved, { recursive: true, force: true }); }
});

test("private offline revision hints require known matching metadata and are rechecked against the executable", async () => {
  const f = await fixture();
  try {
    const archive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    const bytes = (version: string) => zipSync({ [`chromium-v${version}/${executableName}`]: new TextEncoder().encode("fixture") });
    await fs.writeFile(archive, bytes("156.0.8078.47"));
    const missing = await f.service.analyzeImportZip(archive, { targetChannel: "private" });
    assert.equal(missing.requiresVersionHint, true);
    assert.equal(missing.allowed, false);
    for (const versionHint of ["156.0.8078.47", "157.0.8078.47.1", "156.0.8078.47.1.2"]) {
      assert.equal((await f.service.analyzeImportZip(archive, { targetChannel: "private", versionHint })).allowed, false);
    }
    const valid = await f.service.analyzeImportZip(archive, { targetChannel: "private", versionHint: "156.0.8078.47.2" });
    assert.equal(valid.allowed, true);
    assert.equal(valid.versionHint, "156.0.8078.47.2");
    f.setExecutableVersion("157.0.8078.47");
    await assert.rejects(f.service.installImportZip(archive, { targetChannel: "private", versionHint: valid.versionHint }), { code: "PRIVATE_RELEASE_VERSION_MISMATCH" });
    f.setExecutableVersion("156.0.8078.47");
    const imported = await f.service.installImportZip(archive, { targetChannel: "private", versionHint: valid.versionHint });
    assert.equal(imported.info.version, "156.0.8078.47.2");
    await fs.writeFile(archive, bytes("156.0.8078.47.3"));
    assert.equal((await f.service.analyzeImportZip(archive, { targetChannel: "private", versionHint: "156.0.8078.47.2" })).allowed, false);
    await fs.writeFile(archive, zipSync({ [executableName]: new TextEncoder().encode("unknown executable") }));
    assert.equal((await f.service.analyzeImportZip(archive, { targetChannel: "private", versionHint: "156.0.8078.47.2" })).allowed, false);
  } finally { await f.cleanup(); }
});

// Installing the official core is now the same operation as installing any other channel, aimed at the
// official channel: the derivation runs against that target, and enabling it is part of the operation.
test("installing the official channel derives a Free key plan from the target configuration", async () => {
  const f = await fixture();
  try {
    const old = "155.0.8059.39.1", latest = "156.0.8078.47.1";
    f.setVersion("154.0.8000.1.1");
    f.setExecutableVersion("154.0.8000.1");
    await f.service.installPrivateRelease();
    f.patchSettings({ binary: { coreChannel: "private", licenseKey: "free-fixture", browserVersionMode: "pinned", pinnedBrowserVersion: old } });
    let installed = false, validationCalls = 0;
    const cache = path.join(f.root, "cloakbrowser-cache");
    const service = new BinaryService({ dataDir: f.root, portable: false, readSettings: async () => f.settings(), saveSettings: async (patch) => { f.patchSettings(patch); return f.settings(); }, loadCloakBrowser: async () => ({
      binaryInfo: (pin?: string) => {
        const version = pin ?? (installed ? latest : old);
        const directory = path.join(cache, `chromium-${version}-pro`);
        return { version, platform, cacheDir: directory, binaryPath: path.join(directory, executableName), installed: installed && version === latest, downloadUrl: "", tier: "pro" };
      },
      ensureBinary: async (_key?: string, pin?: string) => {
        assert.equal(pin, undefined, "the Free key cannot honor the old paid-plan pin");
        const executable = path.join(cache, `chromium-${latest}-pro`, executableName);
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, "fixture");
        await fs.writeFile(path.join(cache, `latest_pro_version_${platform}`), latest);
        installed = true;
        return executable;
      },
      clearCache: () => undefined,
      validateLicense: async () => { validationCalls += 1; return { valid: true, plan: "free", expires: null }; },
    } as unknown as CloakBrowserModule) });
    const result = await service.install({ targetChannel: "official" });
    assert.equal(result.info.version, latest);
    assert.equal(validationCalls, 1);
    assert.equal(f.settings().binary.coreChannel, "official");
    assert.equal(f.settings().binary.coreChannelMode, "online");
    assert.equal(result.info.core.planIsFree, true);
  } finally { await f.cleanup(); }
});

test("installing a channel with a configured or external custom executable refuses the managed target", async () => {
  for (const source of ["settings", "external"] as const) {
    const f = await fixture();
    try {
      const binary = path.join(f.root, executableName);
      await fs.mkdir(path.dirname(binary), { recursive: true });
      await fs.writeFile(binary, "fixture");
      if (source === "settings") f.patchSettings({ binary: { customBinaryPathEnabled: true, customBinaryPath: binary } });
      else process.env.CLOAKBROWSER_BINARY_PATH = binary;
      const service = f.reopen();
      // Either source means a custom executable is what launches, so a managed install for this channel
      // is refused before it downloads or replaces anything.
      await assert.rejects(service.install({ targetChannel: "official" }), { status: 409, code: "BROWSER_CORE_CUSTOM_BINARY_ACTIVE" });
      assert.equal(f.settings().binary.coreChannel, "official");
    } finally { await f.cleanup(); }
  }
});

// A custom executable means the managed cache is not what launches, so an install aimed at a channel with
// one configured neither downloads nor replaces that file.
test("a channel install with a custom executable configured never fetches a managed build", async () => {
  const f = await fixture();
  try {
    const binary = path.join(f.root, executableName);
    await fs.mkdir(path.dirname(binary), { recursive: true });
    await fs.writeFile(binary, "fixture");
    f.patchSettings({ binary: { customBinaryPathEnabled: true, customBinaryPath: binary } });
    const service = f.reopen();
    await assert.rejects(service.install({ targetChannel: "official" }), (error: unknown) => Boolean(error));
    assert.equal(f.counts().fetches, 0);
    assert.equal(f.settings().binary.coreChannel, "official");
    assert.equal(await fs.readFile(binary, "utf8"), "fixture");
  } finally { await f.cleanup(); }
});

// The panel acts on the channel it shows. A target that is not the running channel gets its own cache
// and its own derivation; clearing one channel leaves the other one's build and the running channel alone.
test("an action aimed at one channel leaves the other channel's builds and the running channel alone", async () => {
  const f = await fixture();
  try {
    const officialArchive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(officialArchive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    // Import the official build (it activates, as an import does), then move to the private channel.
    await f.service.installImportZip(officialArchive, { targetChannel: "official" });
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    assert.equal(f.settings().binary.coreChannel, "private");
    const privateRoot = path.join(f.root, "cloakbrowser-cache-private", platform);

    await f.service.clearCache({ targetChannel: "official" });

    assert.equal(f.settings().binary.coreChannel, "private", "the running channel is unchanged");
    assert.deepEqual((await fs.readdir(privateRoot)).filter((name) => /^\d/.test(name)), ["156.0.8078.47.1"], "the private cache keeps its build");
    const info = await f.service.readPublicInfo();
    assert.equal(info.core.channel, "private");
    assert.equal(info.installed, true, "the running private channel still launches");
    assert.equal(info.core.channels.official.installed, true, "the target channel keeps the build it may launch");
    assert.equal(info.core.channels.private.installed, true);
  } finally { await f.cleanup(); }
});

// A build that lands while sessions are running is installed but not enabled. Reporting it as enabled
// would describe a switch the server declined to make, and the panel would draw the wrong card.
test("an import during a running session lands the build without switching to it", async () => {
  const f = await fixture();
  try {
    const officialArchive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(officialArchive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    f.setSessions(true);
    const imported = await f.service.installImportZip(officialArchive, { targetChannel: "official" });
    assert.equal(imported.pendingActivation, true);
    assert.equal(f.settings().binary.coreChannel, "official", "the running channel is unchanged");
    assert.equal(f.settings().binary.coreChannelMode, "online", "offline was not declared either");
    assert.equal(imported.info.core.channels.official.version, "156.0.8078.47.1");
    // And the switch that was declined is still available once the sessions stop.
    f.setSessions(false);
    const activated = await f.service.activateChannel("official", "offline");
    assert.equal(activated.info.version, "156.0.8078.47.1");
  } finally { await f.cleanup(); }
});

// `info` is what launches; `target` is what the operation changed. A caller that installs `info` as the
// global state — every client does — must never be told the target channel is the running one.
test("a target-channel install reports the running channel in info and the changed one in target", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    const archive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(archive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    await f.service.installImportZip(archive, { targetChannel: "official" });
    await f.service.activateChannel("private", "online");
    assert.equal((await f.service.readPublicInfo()).core.channel, "private");

    // A session is running, so the official install may land but must not switch what launches. The
    // response has to keep `info` on the running channel and report the new build through `target`.
    f.setSessions(true);
    const nested = path.join(f.root, "second");
    await fs.mkdir(nested, { recursive: true });
    const secondArchive = path.join(nested, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(secondArchive, zipSync({ [`chromium-v156.0.8078.47.2/${executableName}`]: new TextEncoder().encode("fixture") }));
    await f.service.installImportZip(secondArchive, { targetChannel: "official" });

    const after = await f.service.readPublicInfo();
    assert.equal(after.core.channel, "private", "the running channel still describes the launch target");
    assert.equal(after.core.channels.official.version, "156.0.8078.47.2", "the changed channel is reported separately");
    assert.equal(f.settings().binary.coreChannel, "private", "nothing was activated while the session ran");

    // The private update path is the one the panel's Update button calls on the private card; its
    // response must describe the same two channels the same way. Sessions are stopped first: replacing
    // the running private build is what that guard is for.
    f.setSessions(false);
    const updated = await f.service.update({ targetChannel: "private" });
    assert.equal(updated.info.core.channel, "private");
    assert.equal(updated.target.channel, "private");
    assert.equal(updated.target.version, "156.0.8078.47.1");
  } finally { await f.cleanup(); }
});

// Validation is suspended while the private channel runs, and `core.license` is the private placeholder
// there. The official card reads this field to decide whether it may download, so a configured key has to
// stay visible.
test("the official key state is reported while the private channel is running", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    const info = await f.service.readPublicInfo();
    assert.equal(info.core.channel, "private");
    assert.equal(info.core.license.active, false, "the running channel's license is the private placeholder");
    assert.equal(info.core.officialLicense.configured, true, "the configured official key is still reported");
    assert.equal(info.core.officialLicense.valid, undefined, "no verdict was asked for, so none is claimed");

    f.patchSettings({ binary: { licenseKey: "" } });
    assert.equal((await f.service.readPublicInfo()).core.officialLicense.configured, false);
  } finally { await f.cleanup(); }
});

// A pin is an official-online selector. `channelStates` describes the online configuration, so a pinned
// build is the one it names — and the clear keeps it — even while the running channel is private offline.
test("channel state and cache clearing agree with the online pin while another channel runs offline", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    const root = path.join(f.root, "cloakbrowser-cache");
    for (const version of ["155.0.8059.39.1", "156.0.8078.47.1"]) {
      const directory = path.join(root, `chromium-${version}-pro`);
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, executableName), "fixture");
    }
    await fs.writeFile(path.join(root, `latest_pro_version_${platform}`), "156.0.8078.47.1");
    f.patchSettings({ binary: { coreChannelMode: "offline", browserVersionMode: "pinned", pinnedBrowserVersion: "155.0.8059.39.1" } });

    const info = await f.service.readPublicInfo();
    assert.equal(info.core.channels.official.version, "155.0.8059.39.1", "the pin is what an online activation would select");

    await f.service.clearCache({ targetChannel: "official" });
    assert.ok(await fs.stat(path.join(root, "chromium-155.0.8059.39.1-pro")), "the pinned build is kept");
    assert.equal(await fs.stat(path.join(root, "chromium-156.0.8078.47.1-pro")).catch(() => undefined), undefined, "the unpinned build is superseded");
  } finally { await f.cleanup(); }
});

// The target scope is async-local: a poll that lands while the operation runs keeps reading the running
// channel, and the process env is the running channel's again once the operation ends.
test("a concurrent read during a target-channel operation keeps describing the running channel", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    const officialArchive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(officialArchive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    await f.service.installImportZip(officialArchive, { targetChannel: "official" });
    await f.service.activateChannel("private", "online");

    let gate: (() => void) | undefined;
    const gatePromise = new Promise<void>((resolve) => { gate = resolve; });
    f.setCatalogGate(gatePromise);
    // The private update path holds the target scope open across its release catalog request, which is
    // where the gate sits — no download is attempted while the poll reads.
    const updating = f.service.update({ targetChannel: "private" });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const concurrent = await f.service.readPublicInfo();
    assert.equal(concurrent.core.channel, "private", "a poll sees the running channel, not the target");
    assert.equal(concurrent.core.channels.official.installed, true);
    gate?.();
    await updating;
    assert.equal((await f.service.readPublicInfo()).core.channel, "private");
  } finally { await f.cleanup(); }
});

test("a completed private update check is cleared when the repository changes and cannot reload after restart", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease();
    await f.service.activateChannel("private", "online");
    await f.service.checkUpdate();
    assert.equal(f.settings().binary.lastUpdateCheck?.latestVersion, "156.0.8078.47.1");
    await f.service.testPrivateConfiguration("https://github.com/owner/changed");
    assert.equal(f.settings().binary.lastUpdateCheck, undefined);
    assert.equal((await f.service.readPublicInfo()).core.update, undefined);
    for (const key of envKeys) delete process.env[key];
    assert.equal((await f.reopen().readPublicInfo()).core.update, undefined);
  } finally { await f.cleanup(); }
});

test("SQLite settings mutations preserve concurrent Xray updates and return the cleared core check", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-settings-commit-"));
  const repository = new SqlitePanelRepository({ dataDir: root });
  const oldCheck = { checkedAt: new Date().toISOString(), currentVersion: "155.0.8059.39.1", latestVersion: "156.0.8078.47.1", updateAvailable: true };
  try {
    await repository.saveSettings({ binary: { privateRepositoryUrl: "https://github.com/owner/old", lastUpdateCheck: oldCheck } });
    const service = new BinaryService({ dataDir: root, portable: false, readSettings: () => repository.getSettings(), saveSettings: (patch) => repository.saveSettings(patch) });
    const [saved] = await Promise.all([
      service.saveSettingsPatch({ binary: { privateRepositoryUrl: "https://github.com/owner/changed", lastUpdateCheck: oldCheck } }),
      service.saveSettingsPatch({ xray: { checkForUpdatesOnStartup: true, lastUpdateCheck: oldCheck } }),
    ]);
    assert.equal(saved.binary.lastUpdateCheck, undefined);
    const stored = await repository.getSettings();
    assert.equal(stored.binary.privateRepositoryUrl, "https://github.com/owner/changed");
    assert.equal(stored.binary.lastUpdateCheck, undefined);
    assert.equal(stored.xray.checkForUpdatesOnStartup, true);
    assert.equal(stored.xray.lastUpdateCheck?.latestVersion, oldCheck.latestVersion);
  } finally { repository.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test("private configuration commits, rollbacks and credential deletion share one serialized transaction", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-private-config-"));
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let settings = normalizeSettings({ binary: { privateRepositoryUrl: "https://github.com/owner/original" } });
  let storedToken: string | undefined = "original-token";
  let releaseWrite!: () => void, writeStarted!: () => void;
  const started = new Promise<void>((resolve) => { writeStarted = resolve; });
  const blocked = new Promise<void>((resolve) => { releaseWrite = resolve; });
  let blockFirst = true;
  const trace: string[] = [];
  const service = new BinaryService({ dataDir: root, portable: false, readSettings: async () => settings,
    saveSettings: async (patch) => { trace.push(`repo:${patch.binary?.privateRepositoryUrl}`); settings = mergeSettings(settings, patch); return settings; },
    readPrivateToken: async () => storedToken,
    savePrivateToken: async (token) => { storedToken = token || undefined; trace.push(`token:${token}`); if (blockFirst) { blockFirst = false; writeStarted(); await blocked; } },
    fetchImpl: async () => Response.json([]),
  });
  try {
    const first = service.testPrivateConfiguration("https://github.com/owner/A", "token-A");
    await started;
    const second = service.testPrivateConfiguration("https://github.com/owner/B", "token-B");
    releaseWrite();
    await Promise.all([first, second]);
    assert.equal(settings.binary.privateRepositoryUrl, "https://github.com/owner/B");
    assert.equal(storedToken, "token-B");
    assert.ok(trace.indexOf("repo:https://github.com/owner/A") < trace.indexOf("token:token-B"));
    await service.savePrivateRepositoryToken("");
    assert.equal(storedToken, undefined);
    assert.ok(trace.indexOf("repo:https://github.com/owner/A") < trace.indexOf("token:"));

    let fail = true;
    const rollbackService = new BinaryService({ dataDir: root, portable: false, readSettings: async () => settings,
      saveSettings: async (patch) => { if (fail) { fail = false; throw new Error("fixture commit failure"); } settings = mergeSettings(settings, patch); return settings; },
      readPrivateToken: async () => storedToken, savePrivateToken: async (token) => { storedToken = token || undefined; }, fetchImpl: async () => Response.json([]),
    });
    const results = await Promise.allSettled([
      rollbackService.testPrivateConfiguration("https://github.com/owner/failed", "failed-token"),
      rollbackService.testPrivateConfiguration("https://github.com/owner/success", "success-token"),
    ]);
    assert.equal(results[0].status, "rejected");
    assert.equal(results[1].status, "rejected", "a failed configuration transaction also invalidates work that preceded its rollback");
    await rollbackService.testPrivateConfiguration("https://github.com/owner/success", "success-token");
    assert.equal(settings.binary.privateRepositoryUrl, "https://github.com/owner/success");
    assert.equal(storedToken, "success-token");
  } finally { for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; } await fs.rm(root, { recursive: true, force: true }); }
});

test("private installation binds the selected repository and release identity", async () => {
  const f = await fixture();
  try {
    const before = f.counts().fetches;
    await assert.rejects(f.service.installPrivateRelease("156.0.8078.47.1", { repositoryUrl: "https://github.com/other/private-core", releaseId: 1 }), { code: "PRIVATE_RELEASE_SOURCE_CHANGED" });
    assert.equal(f.counts().fetches, before);
    await assert.rejects(f.service.installPrivateRelease("156.0.8078.47.1", { repositoryUrl: f.settings().binary.privateRepositoryUrl, releaseId: 99 }), { code: "PRIVATE_RELEASE_NOT_FOUND" });
    await f.service.installPrivateRelease("156.0.8078.47.1", { repositoryUrl: f.settings().binary.privateRepositoryUrl, releaseId: 1 });
    assert.equal(f.settings().binary.privateReleaseVersion, "156.0.8078.47.1");
  } finally { await f.cleanup(); }
});

test("credentials cannot be cleared during an in-flight private installation", async () => {
  const f = await fixture();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  try {
    f.setCatalogGate(gate);
    const installation = f.service.installPrivateRelease();
    while (!f.service.activeCacheOperation()) await new Promise((resolve) => setTimeout(resolve, 1));
    await assert.rejects(f.service.savePrivateRepositoryToken(""), { code: "BROWSER_CORE_OPERATION_IN_PROGRESS" });
    release();
    await installation;
    assert.equal(f.settings().binary.privateReleaseVersion, "156.0.8078.47.1");
  } finally { release(); await f.cleanup(); }
});

test("a stale connection test cannot restore a deleted token or overwrite a newer repository", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-stale-config-"));
  let settings = normalizeSettings({ binary: { privateRepositoryUrl: "https://github.com/owner/original" } });
  let storedToken: string | undefined = "original-token";
  let releaseNetwork!: () => void, networkStarted!: () => void;
  let started = new Promise<void>((resolve) => { networkStarted = resolve; });
  let gate = new Promise<void>((resolve) => { releaseNetwork = resolve; });
  const service = new BinaryService({ dataDir: root, portable: false, readSettings: async () => settings,
    saveSettings: async (patch) => { settings = mergeSettings(settings, patch); return settings; },
    readPrivateToken: async () => storedToken, savePrivateToken: async (token) => { storedToken = token || undefined; },
    fetchImpl: async () => { networkStarted(); await gate; return Response.json([]); },
  });
  try {
    const staleAfterClear = service.testPrivateConfiguration("https://github.com/owner/original");
    await started;
    await service.savePrivateRepositoryToken("");
    assert.equal(storedToken, undefined);
    releaseNetwork();
    await assert.rejects(staleAfterClear, { code: "PRIVATE_CONFIGURATION_CHANGED" });
    assert.equal(storedToken, undefined);
    assert.equal(settings.binary.privateRepositoryUrl, "https://github.com/owner/original");

    await service.savePrivateRepositoryToken("fresh-token");
    started = new Promise<void>((resolve) => { networkStarted = resolve; });
    gate = new Promise<void>((resolve) => { releaseNetwork = resolve; });
    const staleAfterRepoChange = service.testPrivateConfiguration("https://github.com/owner/original");
    await started;
    await service.saveSettingsPatch({ binary: { privateRepositoryUrl: "https://github.com/owner/newer" } });
    releaseNetwork();
    await assert.rejects(staleAfterRepoChange, { code: "PRIVATE_CONFIGURATION_CHANGED" });
    assert.equal(settings.binary.privateRepositoryUrl, "https://github.com/owner/newer");
    assert.equal(storedToken, "fresh-token");
  } finally { releaseNetwork(); await fs.rm(root, { recursive: true, force: true }); }
});

test("official and private update responses cannot publish after channel changes, including a round trip", async () => {
  for (const source of ["official", "private"] as const) {
    const f = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await f.service.installPrivateRelease();
      const official = path.join(f.root, "cloakbrowser-cache", "chromium-155.0.8059.39.1-pro", executableName);
      await fs.mkdir(path.dirname(official), { recursive: true });
      await fs.writeFile(official, "fixture");
      await fs.writeFile(path.join(f.root, "cloakbrowser-cache", `latest_pro_version_${platform}`), "155.0.8059.39.1");
      if (source === "private") await f.service.activateChannel("private", "online");
      f.setCatalogGate(gate);
      const before = f.counts().fetches;
      const checking = f.service.checkUpdate();
      const rejected = assert.rejects(checking, { code: "BROWSER_CORE_UPDATE_CONTEXT_CHANGED", status: 409 });
      while (f.counts().fetches === before) await new Promise((resolve) => setTimeout(resolve, 1));
      await f.service.activateChannel(source === "official" ? "private" : "official", "offline");
      if (source === "official") await f.service.activateChannel("official", "online");
      release();
      await rejected;
      assert.equal((await f.service.readPublicInfo()).core.update, undefined);
      assert.equal(f.settings().binary.lastUpdateCheck, undefined);
    } finally { release(); await f.cleanup(); }
  }
});

test("a check aimed at the channel that is not running answers without becoming the running channel's badge", async () => {
  const f = await fixture();
  try {
    await f.service.installPrivateRelease(undefined, {}, { activate: true });
    const official = path.join(f.root, "cloakbrowser-cache", "chromium-155.0.8059.39.1-pro", executableName);
    await fs.mkdir(path.dirname(official), { recursive: true });
    await fs.writeFile(official, "fixture");
    await fs.writeFile(path.join(f.root, "cloakbrowser-cache", `latest_pro_version_${platform}`), "155.0.8059.39.1");
    const before = await f.service.readPublicInfo();
    assert.equal(before.core.channel, "private");
    const runningCheck = await f.service.checkUpdate();
    assert.equal(runningCheck.update.latestVersion, "156.0.8078.47.1");
    const storedAfterRunningCheck = f.settings().binary.lastUpdateCheck;
    assert.equal(storedAfterRunningCheck?.latestVersion, "156.0.8078.47.1");

    // Aimed at the official channel, which is not running: the answer is returned, but it must not
    // replace the running channel's stored verdict — the badge would then describe a comparison the
    // private channel never ran.
    const other = await f.service.checkUpdate({ targetChannel: "official" });
    assert.equal(other.update.currentVersion, "155.0.8059.39.1");
    assert.equal((await f.service.readPublicInfo()).core.update?.latestVersion, "156.0.8078.47.1");
    assert.equal(f.settings().binary.lastUpdateCheck?.latestVersion, "156.0.8078.47.1");
    // And the running channel's own answer survives a restart.
    for (const key of envKeys) delete process.env[key];
    assert.equal((await f.reopen().readPublicInfo()).core.update?.latestVersion, "156.0.8078.47.1");
  } finally { await f.cleanup(); }
});

test("an offline activation refuses a version that another import replaced", async () => {
  const f = await fixture();
  try {
    const archive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    const write = (version: string) => fs.writeFile(archive, zipSync({ [`chromium-v${version}/${executableName}`]: new TextEncoder().encode("fixture") }));
    f.setSessions(true);
    await write("156.0.8078.47.1");
    await f.service.installImportZip(archive, { targetChannel: "official" });
    await write("156.0.8078.47.2");
    await f.service.installImportZip(archive, { targetChannel: "official" });
    f.setSessions(false);
    await assert.rejects(f.service.activateChannel("official", "offline", "156.0.8078.47.1"), { code: "BROWSER_CORE_ACTIVATION_CONTEXT_CHANGED", status: 409 });
    assert.equal(f.settings().binary.coreChannelMode, "online");
    assert.equal(await fs.readFile(path.join(f.root, "cloakbrowser-cache", "chromium-156.0.8078.47.2-pro", executableName), "utf8"), "fixture");
    assert.equal((await f.service.activateChannel("official", "offline", "156.0.8078.47.2")).info.version, "156.0.8078.47.2");
  } finally { await f.cleanup(); }
});

test("private channel shares the GeoIP/Widevine cache root, marks restartRequired on channel switch, and isolates clearCache", async () => {
  const f = await fixture();
  try {
    const sharedGeoipDir = path.join(f.root, "cloakbrowser-cache", "geoip");
    await fs.mkdir(sharedGeoipDir, { recursive: true });
    const sharedGeoipFile = path.join(sharedGeoipDir, "GeoLite2-City.mmdb");
    await fs.writeFile(sharedGeoipFile, "geoip-db");

    const initialInfo = await f.service.readPublicInfo();
    assert.equal(initialInfo.core.restartRequired, false);

    await f.service.installPrivateRelease();
    const activated = await f.service.activateChannel("private", "online");
    assert.equal(activated.info.core.restartRequired, true, "switching to private changes loaded CLOAKBROWSER_BINARY_PATH and requires runtime restart");
    assert.equal(process.env.CLOAKBROWSER_CACHE_DIR, path.join(f.root, "cloakbrowser-cache"), "wrapper GeoIP/Widevine cache stays shared across channels");
    assert.equal(await f.service.resolveGeoipDbPath(), sharedGeoipFile);

    const diag = await f.service.readWrapperDiagnostics({ quick: true });
    assert.equal(diag.binary?.override, undefined, "internal private binary path is not reported as a user override");
    assert.equal(diag.license?.tier, "not-applicable", "private channel diagnostics report license as not-applicable");
    assert.equal(diag.geoip?.dbPresent, true);

    await f.service.checkUpdate();
    assert.equal(f.settings().binary.lastUpdateCheck?.latestVersion, "156.0.8078.47.1");
    await f.service.clearCache();
    // The build in use is kept, so the channel still launches; the stored check it belonged to is not.
    assert.equal((await f.service.readInfo()).installed, true);
    assert.equal(f.settings().binary.lastUpdateCheck, undefined, "clearing cache clears stale update check");
    assert.equal(await fs.readFile(sharedGeoipFile, "utf8"), "geoip-db", "clearing private binary cache preserves shared GeoIP DB");
  } finally { await f.cleanup(); }
});

test("cross-channel offline import analysis compares against the target channel's installed version, and checkUpdate captures private errors", async () => {
  const f = await fixture();
  try {
    const officialExec = path.join(f.root, "cloakbrowser-cache", "chromium-155.0.8059.39.1-pro", executableName);
    await fs.mkdir(path.dirname(officialExec), { recursive: true });
    await fs.writeFile(officialExec, "fixture");
    await fs.writeFile(path.join(f.root, "cloakbrowser-cache", `latest_pro_version_${platform}`), "155.0.8059.39.1");

    await f.service.installPrivateRelease(); // installs 156.0.8078.47.1 into private cache

    const archive = path.join(f.root, `cloakbrowser-${assetPlatform}.zip`);
    await fs.writeFile(archive, zipSync({ [`chromium-v156.0.8078.47.1/${executableName}`]: new TextEncoder().encode("fixture") }));
    const privateAnalysis = await f.service.analyzeImportZip(archive, { targetChannel: "private" });
    assert.equal(privateAnalysis.currentVersion, "156.0.8078.47.1");
    assert.equal(privateAnalysis.operation, "reinstall");

    let quarantineCleared: string[] = [];
    const quarantineService = new BinaryService({
      dataDir: f.root,
      portable: false,
      readSettings: async () => f.settings(),
      saveSettings: async (patch) => { f.patchSettings(patch); return f.settings(); },
      readPrivateToken: async () => undefined,
      readExecutableVersion: async () => "156.0.8078.47",
      removeQuarantine: async (dir) => { quarantineCleared.push(dir); },
    });
    await quarantineService.installImportZip(archive, { targetChannel: "private" });
    assert.equal(quarantineCleared.length, 1);

    await quarantineService.activateChannel("private", "online");
    const failedCheck = await quarantineService.checkUpdate();
    assert.equal(failedCheck.update.updateAvailable, false);
    assert.equal(failedCheck.update.errorCode, "PRIVATE_TOKEN_REQUIRED");
  } finally { await f.cleanup(); }
});
