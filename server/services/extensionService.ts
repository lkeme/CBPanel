import { createHash, createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import {
  type BrowserEnvironment,
  type ExtensionDirectoryCandidate,
  type ExtensionDirectoryImportResult,
  type ExtensionDirectoryMode,
  type ExtensionDirectoryPreviewResult,
  type ExtensionEntity,
  type ExtensionIconAsset,
  type ExtensionPermissionRisk,
  type ExtensionPermissionRiskLevel,
  type ExtensionPermissionRiskReasonKey,
  type ExtensionSourceEntity,
  type ExtensionSourceRefreshResult,
  type ExtensionSourceKind,
} from "../../src/shared/entities";
import { createId, nowIso } from "../../src/shared/profile";
import type { PanelRepository } from "../storage/types";
import { ExtensionRuntimeService } from "./extensionRuntimeService";

type ExtensionServiceOptions = {
  repository: PanelRepository;
  extensionCacheDir: string;
  extensionRuntimeDir?: string;
  browserDataDir?: string;
  /** Where uploaded archives are persisted so `sourceUrl` stays readable for reinstall/update. */
  extensionArchiveDir?: string;
  fetchImpl?: typeof fetch;
  activeEnvironmentIds?: () => Set<string>;
};

type ExtensionManifest = {
  name?: string;
  description?: string;
  version?: string;
  manifest_version?: number;
  key?: unknown;
  default_locale?: unknown;
  icons?: unknown;
  action?: unknown;
  browser_action?: unknown;
  permissions?: unknown[];
  host_permissions?: unknown[];
  optional_permissions?: unknown[];
  optional_host_permissions?: unknown[];
  content_scripts?: unknown[];
};

type PermissionRiskInput = {
  permissions?: string[];
  hostPermissions?: string[];
  optionalPermissions?: string[];
  optionalHostPermissions?: string[];
  contentScriptMatches?: string[];
};

export type ExtensionLaunchWarning = {
  name: string;
  reason: string;
};

export type EnsureExtensionsResult = {
  paths: string[];
  warnings: ExtensionLaunchWarning[];
};

type InUseGuardOptions = {
  exemptEnvironmentId?: string;
};

type ExtensionAssetKind = "zip" | "crx";

export type ExtensionImportConflictDisposition = "reuse" | "overwrite" | "create";
export type ExtensionImportConflictMatchBy = "manifestKey" | "sha256" | "sourceUrl" | "manifestSha256" | "nameVersion";

export type ExtensionImportOptions = {
  conflictDisposition?: ExtensionImportConflictDisposition;
  conflictExtensionId?: string;
};

type ImportCandidateIdentity = {
  manifestKey?: string;
  sha256?: string;
  sourceUrl?: string;
  manifestSha256?: string;
  name?: string;
  version?: string;
};

type ExtensionImportConflict = {
  matchBy: ExtensionImportConflictMatchBy;
  candidates: ExtensionEntity[];
};

type ExtensionSourceIndexEntry = {
  id: string;
  name: string;
  description?: string;
  version: string;
  assetKind: ExtensionAssetKind;
  assetUrl: string;
  sha256?: string;
  webStoreId?: string;
  storeUrl?: string;
};

type ExtensionSourceIndex = {
  name: string;
  extensions: ExtensionSourceIndexEntry[];
};

const HIGH_RISK_PERMISSIONS = new Set([
  "cookies",
  "proxy",
  "webRequest",
  "declarativeNetRequest",
  "scripting",
  "nativeMessaging",
]);

const MEDIUM_RISK_PERMISSIONS: Record<string, { reason: string; reasonKey: ExtensionPermissionRiskReasonKey }> = {
  tabs: { reason: "可读取标签页 URL 与标题", reasonKey: "tabs-metadata" },
};

const ALL_URLS_PATTERNS = new Set(["<all_urls>", "*://*/*", "http://*/*", "https://*/*"]);

// Crash leftovers from the extract/copy temp-dir swaps; they are never valid extension roots.
const CACHE_ARTIFACT_MARKERS = [".tmp-", ".old-"];

const CACHE_PREVIEW_PREFIX = ".preview-";

const CRX3_SIGNED_DATA_MAGIC = "CRX3 SignedData";

const MESSAGE_PLACEHOLDER_PATTERN = /__MSG_([A-Za-z0-9_@]+)__/;

const PREFERRED_MESSAGE_LOCALES = ["zh_CN", "zh"];

const FALLBACK_MESSAGE_LOCALES = ["en", "en_US"];

/** Only raster/vector formats a browser can render inline; anything else is refused. */
const ICON_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

/** Real extension icons are a few KB; the cap only exists to stop a crafted manifest from OOMing us. */
const MAX_ICON_ASSET_BYTES = 512 * 1024;

export class ExtensionService {
  private readonly fetchImpl: typeof fetch;

  private readonly extensionArchiveDir: string;

  private readonly runtimeService: ExtensionRuntimeService;

  constructor(private readonly options: ExtensionServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.extensionArchiveDir = options.extensionArchiveDir
      ?? path.join(path.dirname(path.resolve(options.extensionCacheDir)), "extension-archives");
    const dataDir = path.dirname(path.resolve(options.extensionCacheDir));
    this.runtimeService = new ExtensionRuntimeService({
      runtimeDir: options.extensionRuntimeDir ?? path.join(dataDir, "extension-runtimes"),
      browserDataDir: options.browserDataDir ?? path.join(dataDir, "browser-data"),
    });
  }

  async importDirectory(
    directory: string,
    mode: ExtensionDirectoryMode = "copy",
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionEntity> {
    const sourcePath = path.resolve(directory);
    assertPathHasNoComma(sourcePath);
    // Both modes are guarded: reference-importing a copy extension's cache dir would create two
    // entities sharing one injected key, so the browser resolves both to the same ID.
    this.assertOutsideExtensionCache(sourcePath);
    const manifest = await readManifestFromDirectory(sourcePath);
    const manifestFields = extensionFieldsFromManifest(manifest);
    // Fingerprint the source directory, not the snapshot: copy mode injects a key into the snapshot,
    // and hashing the source keeps both modes on the same digest for the same package.
    const manifestSha256 = await readManifestFingerprint(sourcePath);
    const identity: ImportCandidateIdentity = {
      manifestKey: typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined,
      sourceUrl: sourcePath,
      manifestSha256,
      name: manifestFields.name,
      version: manifestFields.version,
    };
    const conflict = await this.resolveImportDisposition(identity, options);
    if (conflict?.disposition === "reuse") {
      return conflict.target;
    }
    if (conflict?.disposition === "overwrite") {
      return this.overwriteFromDirectory(conflict.target, sourcePath, mode, manifestFields, manifestSha256);
    }

    if (mode === "reference") {
      return this.options.repository.createExtension({
        ...manifestFields,
        sourceKind: "local-directory",
        sourceUrl: sourcePath,
        localPath: sourcePath,
        manifestKey: identity.manifestKey,
        manifestSha256,
        directoryMode: "reference",
        installState: "installed",
        lastInstalledAt: nowIso(),
      });
    }

    const extensionId = createId("extension");
    const localPath = await this.copyDirectoryIntoCache(sourcePath, extensionId);
    const manifestKey = await this.acquireManifestKey(localPath);
    return this.options.repository.createExtension({
      ...manifestFields,
      id: extensionId,
      sourceKind: "local-directory",
      sourceUrl: sourcePath,
      localPath,
      manifestKey,
      manifestSha256,
      directoryMode: "copy",
      installState: "installed",
      lastInstalledAt: nowIso(),
    });
  }

  /** Best-effort removal of interrupted extract/copy swap leftovers in the extension cache. */
  async sweepCacheArtifacts(): Promise<void> {
    await this.runtimeService.sweepArtifacts();
    const environments = [
      ...await this.options.repository.listEnvironments(),
      ...(await this.options.repository.listTrashEnvironments()).map((item) => item.environment),
    ];
    const bindings = new Map<string, ReadonlySet<string>>();
    for (const environment of environments) {
      bindings.set(
        environment.id,
        new Set((await this.options.repository.listEnvironmentExtensionBindings(environment.id)).map((binding) => binding.extensionId)),
      );
    }
    await this.runtimeService.sweepBindings(bindings, this.options.activeEnvironmentIds?.());
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.options.extensionCacheDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!isCacheArtifactName(entry.name)) continue;
      await fs.rm(path.join(this.options.extensionCacheDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async previewDirectory(directory: string): Promise<ExtensionDirectoryPreviewResult> {
    if (!directory.trim()) {
      throw Object.assign(new Error("Extension directory path cannot be empty"), { status: 400 });
    }
    const rootPath = path.resolve(directory.trim());
    const direct = await readDirectManifestCandidate(rootPath);
    if (direct) {
      return { rootPath, direct, candidates: [] };
    }

    const candidates = await discoverChromeExtensionCandidates(rootPath);
    if (candidates.length === 0) {
      throw Object.assign(new Error(`Extension directory must directly contain manifest.json or Chrome extension version folders: ${rootPath}`), { status: 400 });
    }
    return { rootPath, candidates };
  }

  async importDirectories(
    paths: string[],
    mode: ExtensionDirectoryMode = "copy",
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionDirectoryImportResult> {
    const requestedPaths = paths.filter((input) => typeof input === "string" && input.trim());
    const uniquePaths = uniqueResolvedPaths(requestedPaths);
    if (uniquePaths.length === 0) {
      throw Object.assign(new Error("No extension directories selected"), { status: 400 });
    }
    const imported: ExtensionEntity[] = [];
    const failed: ExtensionDirectoryImportResult["failed"] = [];

    for (const directory of uniquePaths) {
      try {
        imported.push(await this.importDirectory(directory, mode, options));
      } catch (error) {
        failed.push({ path: directory, error: (error as Error).message });
      }
    }

    return {
      imported,
      failed,
      skipped: requestedPaths.length - uniquePaths.length,
    };
  }

  async importZip(filePath: string, options: ExtensionImportOptions = {}): Promise<ExtensionEntity> {
    return this.importLocalAsset(filePath, "zip", options);
  }

  async importCrx(filePath: string, options: ExtensionImportOptions = {}): Promise<ExtensionEntity> {
    return this.importLocalAsset(filePath, "crx", options);
  }

  /**
   * Uploaded archives have no server-side source file, so the bytes are persisted inside the data
   * directory first: reinstall and update checks read `sourceUrl` and would break without a copy.
   */
  async importUploadedArchive(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionEntity> {
    const identity = await this.identityFromArchiveBytes(bytes, assetKind);
    const conflict = await this.resolveImportDisposition(identity, options);
    if (conflict?.disposition === "reuse") {
      return conflict.target;
    }
    if (conflict?.disposition === "overwrite") {
      const existing = conflict.target;
      await fs.mkdir(this.extensionArchiveDir, { recursive: true });
      const archivePath = path.join(this.extensionArchiveDir, `${existing.id}.${assetKind}`);
      await fs.writeFile(archivePath, bytes);
      try {
        return await this.overwriteFromArchive(existing, bytes, assetKind, archivePath);
      } catch (error) {
        // Keep any previous archive for the same id; only remove a brand-new write when overwrite fails
        // after the entity still points at a different sourceUrl.
        if (existing.sourceUrl !== archivePath) {
          await fs.rm(archivePath, { force: true }).catch(() => undefined);
        }
        throw error;
      }
    }

    const extensionId = createId("extension");
    const archivePath = path.join(this.extensionArchiveDir, `${extensionId}.${assetKind}`);
    await fs.mkdir(this.extensionArchiveDir, { recursive: true });
    await fs.writeFile(archivePath, bytes);
    try {
      return await this.createFromArchiveBytes(bytes, assetKind, extensionId, archivePath);
    } catch (error) {
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  /** Deletes the DB row (and bindings) then best-effort cleans panel-owned cache/archive files. */
  async deleteExtension(id: string): Promise<void> {
    const extension = await this.getExtensionOrThrow(id);
    await this.options.repository.deleteExtension(id);
    await this.cleanupExtensionFiles(extension);
    await this.cleanupRuntimeBindings(id);
  }

  /** Best-effort cleanup after the repository has removed one or more bindings. */
  async cleanupRuntimeBindings(extensionId: string, environmentIds?: string[]): Promise<void> {
    const held = this.options.activeEnvironmentIds?.() ?? new Set<string>();
    const removable = environmentIds?.filter((environmentId) => !held.has(environmentId));
    if (environmentIds && removable?.length === 0) return;
    if (!environmentIds && held.size > 0) {
      await this.runtimeService.removeExtension(extensionId, undefined, held);
      return;
    }
    await this.runtimeService.removeExtension(extensionId, removable);
  }

  async createRemote(input: Partial<ExtensionEntity>): Promise<ExtensionEntity> {
    const sourceKind = input.sourceKind === "remote-crx" ? "remote-crx" : "remote-zip";
    if (!input.sourceUrl?.trim()) {
      throw Object.assign(new Error("Remote extension URL cannot be empty"), { status: 400 });
    }
    if (!input.sha256?.trim()) {
      throw Object.assign(new Error("Remote extension sha256 is required"), { status: 400 });
    }
    return this.options.repository.createExtension({
      ...input,
      sourceKind,
      sourceUrl: input.sourceUrl.trim(),
      installState: "download-pending",
      updatePolicy: input.updatePolicy ?? "pinned",
      sha256: input.sha256.trim().toLowerCase(),
    });
  }

  async refreshSource(id: string): Promise<ExtensionSourceRefreshResult> {
    const source = await this.getExtensionSourceOrThrow(id);
    if (source.status === "disabled") {
      throw Object.assign(new Error("Extension source is disabled"), { status: 409 });
    }

    try {
      const index = await this.fetchSourceIndex(source);
      let imported = 0;
      let updated = 0;
      const extensions: ExtensionEntity[] = [];

      for (const entry of index.extensions) {
        const extensionId = extensionIdFromSourceEntry(source.id, entry.id);
        const existing = await this.options.repository.getExtension(extensionId);
        const sourceKind: ExtensionSourceKind = entry.assetKind === "crx" ? "remote-crx" : "remote-zip";
        const basePatch: Partial<ExtensionEntity> = {
          id: extensionId,
          name: entry.name,
          description: entry.description ?? "",
          sourceKind,
          sourceUrl: entry.assetUrl,
          sourceId: source.id,
          storeId: entry.webStoreId,
          storeUrl: entry.storeUrl,
          version: entry.version,
          sha256: entry.sha256,
          updatePolicy: existing?.updatePolicy ?? "pinned",
          status: existing?.status ?? "enabled",
        };

        if (existing) {
          const assetChanged = existing.sourceUrl !== entry.assetUrl || Boolean(entry.sha256 && existing.sha256 !== entry.sha256);
          const installState = existing.installState === "installed" && (existing.version !== entry.version || assetChanged)
            ? "update-available"
            : existing.installState === "installed"
              ? "installed"
              : "download-pending";
          extensions.push(await this.options.repository.updateExtension(extensionId, { ...basePatch, installState }));
          updated += 1;
        } else {
          extensions.push(await this.options.repository.createExtension({ ...basePatch, installState: "download-pending" }));
          imported += 1;
        }
      }

      const refreshedSource = await this.options.repository.updateExtensionSource(source.id, {
        name: index.name || source.name,
        lastRefreshedAt: nowIso(),
        lastError: undefined,
      });

      return { source: refreshedSource, imported, updated, skipped: 0, extensions };
    } catch (error) {
      await this.options.repository.updateExtensionSource(source.id, {
        lastRefreshedAt: nowIso(),
        lastError: (error as Error).message,
      });
      throw error;
    }
  }

  async install(id: string, options: InUseGuardOptions = {}): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    await this.assertNotInUse(extension.id, options);
    // Preserve update-available on rollback so the UI Update action and B16 check()
    // path stay available; collapsing to install-failed would hide the pending update.
    const previousInstalledState =
      extension.installState === "installed" || extension.installState === "update-available"
        ? extension.installState
        : "install-failed";
    // Keep the on-disk snapshot reachable even when the failed install started from
    // update-available; nulling localPath wedges check() and the next launch.
    const previousLocalPath = extension.localPath;
    try {
      // Defense-in-depth for B9/R3: launch and UI no longer auto-apply updates, but direct
      // install/reinstall API calls must still refuse silent permission increases. Inside the
      // try so candidate-manifest download failures still record lastError like other install errors.
      if (extension.installState === "update-available") {
        await this.assertNoAddedPermissionsForUpdate(extension);
      }
      if (extension.sourceKind === "local-directory") {
        return await this.refreshLocalDirectory(extension);
      }
      if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
        return await this.installLocalAsset(extension);
      }
      if (extension.sourceKind === "remote-zip" || extension.sourceKind === "remote-crx") {
        return await this.installRemoteAsset(extension);
      }
      throw Object.assign(new Error("Chrome Web Store metadata cannot be installed without a verified asset"), {
        status: 409,
        code: "EXTENSION_WEB_STORE",
      });
    } catch (error) {
      // Permission-gate 409 already persisted update-available + a detailed lastError; rewriting
      // here would clobber "adds permissions: cookies" with the generic confirmation message.
      if (isPermissionConfirmationError(error)) throw error;
      await this.options.repository.updateExtension(id, {
        installState: previousInstalledState,
        localPath: previousLocalPath,
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
      throw error;
    }
  }

  async check(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (!extension.localPath) {
      return this.options.repository.updateExtension(id, {
        installState: extension.sourceKind === "chrome-web-store" ? "metadata-only" : extension.installState,
        lastCheckedAt: nowIso(),
        lastError: "Extension has no local unpacked path",
      });
    }
    try {
      const manifest = await readManifestFromDirectory(extension.localPath);
      // The entity may claim a pinned identity that a half-finished install never wrote to
      // disk; check() runs before every launch, so heal the manifest here. Reference mode is
      // excluded because localPath is the user's own directory and must stay untouched.
      if (extension.manifestKey && extension.directoryMode !== "reference" && manifest.key !== extension.manifestKey) {
        await applyManifestKey(extension.localPath, extension.manifestKey);
      }
      // `manifestSha256` means "the digest of the package currently installed at localPath", which is
      // exactly what this line reads. check() already rewrites the whole row (manifest fields plus
      // lastCheckedAt), so refreshing costs nothing extra, and refreshing rather than only filling a
      // gap makes every missed install write-point self-heal instead of relying on a list of write
      // points staying complete forever. Falling back to the stored value is a hard requirement: a
      // manifest that cannot be read must never blank an established digest.
      const manifestSha256 = (await readManifestFingerprint(extension.localPath)) ?? extension.manifestSha256;
      const referenceManifestKey = extension.directoryMode === "reference"
        && !extension.manifestKey
        && typeof manifest.key === "string"
        && manifest.key.trim()
        ? manifest.key.trim()
        : undefined;
      return this.options.repository.updateExtension(id, {
        ...extensionFieldsFromManifest(manifest),
        ...(referenceManifestKey ? { manifestKey: referenceManifestKey } : {}),
        manifestSha256,
        installState: extension.installState === "update-available" ? "update-available" : "installed",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      // No manifestSha256 in this patch on purpose: the failure branch must not carry the field at
      // all, otherwise an unreadable directory would clear the digest on its way to local-missing.
      return this.options.repository.updateExtension(id, {
        installState: "local-missing",
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  /**
   * Reads the best icon declared by the extension's own manifest on demand.
   * Nothing is persisted: freshness is controlled by the caller keying on `updatedAt`.
   * Resolves to `undefined` when the manifest simply declares no icon — a normal state for many
   * packages, so it must not surface as an error the client logs.
   */
  async readIconAsset(id: string): Promise<ExtensionIconAsset | undefined> {
    const extension = await this.getExtensionOrThrow(id);
    if (!extension.localPath) {
      throw Object.assign(new Error("Extension has no local path"), { status: 404 });
    }
    const root = path.resolve(extension.localPath);
    const manifest = await readManifestFromDirectory(root);
    const iconRelPath = pickManifestIcon(manifest);
    if (!iconRelPath) return undefined;
    const iconPath = path.resolve(root, iconRelPath);
    // `icons` is attacker-controlled data inside the package; refuse anything resolving outside.
    // Lexical containment is not enough: `fs.cp` keeps symlinks verbatim, so a copied package can
    // hold `icon.png -> ~/.ssh/id_rsa`, which resolves inside the directory but reads outside it.
    // Both sides are canonicalized or neither is, otherwise a symlinked data dir (macOS
    // /tmp -> /private/tmp) would reject every legitimate icon.
    const [canonicalIconPath, canonicalRoot] = await realpathPair(iconPath, root);
    if (canonicalIconPath === canonicalRoot || !isPathInsideDir(canonicalIconPath, canonicalRoot)) {
      throw Object.assign(new Error(`Extension icon path escapes the extension directory: ${iconRelPath}`), { status: 400 });
    }
    const mime = ICON_MIME_TYPES[path.extname(iconPath).toLowerCase()];
    if (!mime) {
      throw Object.assign(new Error(`Unsupported extension icon type: ${iconRelPath}`), { status: 400 });
    }
    const stats = await fs.stat(iconPath).catch(() => undefined);
    if (!stats?.isFile()) {
      throw Object.assign(new Error(`Extension icon is not a readable file: ${iconRelPath}`), { status: 404 });
    }
    // The manifest picks the file, so a crafted package could point at a huge asset; this ships
    // base64 inside JSON and the client keeps it in memory, so cap it instead of buffering it.
    if (stats.size > MAX_ICON_ASSET_BYTES) {
      throw Object.assign(new Error(`Extension icon is larger than ${MAX_ICON_ASSET_BYTES / 1024} KB: ${iconRelPath}`), { status: 400 });
    }
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(iconPath);
    } catch (error) {
      throw Object.assign(new Error(`Extension icon is not readable: ${(error as Error).message}`), { status: 404 });
    }
    return { mime, data: bytes.toString("base64") };
  }

  async checkUpdate(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);

    if (extension.sourceId) {
      const source = await this.getExtensionSourceOrThrow(extension.sourceId);
      if (source.status === "disabled") {
        return this.options.repository.updateExtension(id, {
          lastCheckedAt: nowIso(),
          lastError: "Extension source is disabled",
        });
      }
      await this.refreshSource(source.id);
      const refreshed = await this.getExtensionOrThrow(id);
      return this.options.repository.updateExtension(id, {
        lastCheckedAt: nowIso(),
        lastError: undefined,
        installState: refreshed.installState,
      });
    }

    if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
      return this.checkLocalArchiveUpdate(extension);
    }
    if (extension.sourceKind === "local-directory") {
      return this.checkLocalDirectoryUpdate(extension);
    }

    return this.options.repository.updateExtension(id, {
      lastCheckedAt: nowIso(),
      lastError: "Extension has no checkable update source",
    });
  }

  async update(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    await this.assertNotInUse(extension.id);
    if (extension.installState !== "update-available") {
      throw Object.assign(new Error("Extension update is not available"), { status: 409 });
    }
    // Permission increases are gated inside install() for every entry that can apply a package
    // (install / reinstall / update), so scripts cannot bypass the UI-only R3 disable.
    return this.install(extension.id);
  }

  async reinstall(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    await this.assertNotInUse(extension.id);
    if (extension.sourceKind === "chrome-web-store") {
      throw Object.assign(new Error("Chrome Web Store metadata cannot be reinstalled without a verified asset"), {
        status: 409,
        code: "EXTENSION_WEB_STORE",
      });
    }
    return this.install(extension.id);
  }

  async migrateIdentity(id: string): Promise<ExtensionEntity> {
    const extension = await this.getExtensionOrThrow(id);
    if (extension.sourceKind === "chrome-web-store") {
      throw Object.assign(new Error("Chrome Web Store metadata cannot be pinned without a verified asset"), {
        status: 409,
        code: "EXTENSION_WEB_STORE",
      });
    }
    if (extension.sourceKind === "local-directory" && extension.directoryMode !== "copy") {
      throw Object.assign(
        new Error("Reference-mode extension directories cannot be pinned; re-import the directory as a snapshot copy"),
        { status: 409, code: "EXTENSION_REFERENCE_MODE" },
      );
    }
    if (extension.manifestKey) {
      throw Object.assign(new Error("Extension identity is already pinned"), {
        status: 409,
        code: "EXTENSION_IDENTITY_PINNED",
      });
    }
    await this.assertNotInUse(extension.id);

    const installedKey = extension.installState === "installed" && extension.localPath
      ? await readManifestKey(extension.localPath)
      : undefined;
    if (installedKey) {
      return this.options.repository.updateExtension(extension.id, { manifestKey: installedKey });
    }

    const manifestKey = (await this.readSourceCrxPublicKey(extension)) ?? generateManifestKey();
    await this.options.repository.updateExtension(extension.id, { manifestKey });
    try {
      return await this.install(extension.id);
    } catch (error) {
      // A failed install may still have injected the key into the unpacked manifest; clearing the
      // persisted key then would desync entity and disk and flip the browser-side ID a second time.
      const injectedKey = extension.localPath ? await readManifestKey(extension.localPath) : undefined;
      if (injectedKey !== manifestKey) {
        await this.options.repository.updateExtension(extension.id, { manifestKey: undefined });
      }
      throw error;
    }
  }

  async ensureExtensionsInstalled(environmentId: string): Promise<EnsureExtensionsResult> {
    const environment = await this.options.repository.getEnvironment(environmentId);
    if (!environment) throw Object.assign(new Error("Environment does not exist"), { status: 404 });

    const extensionById = new Map((await this.options.repository.listExtensions()).map((extension) => [extension.id, extension]));
    const bindingByExtensionId = new Map(
      (await this.options.repository.listEnvironmentExtensionBindings(environmentId))
        .map((binding) => [binding.extensionId, binding] as const),
    );
    const protectsLifecycle = environment.runtimeProfile.mode === "persistent"
      && environment.runtimeProfile.runtime.launcher !== "playwright-browser";
    const paths: string[] = [];
    const warnings: ExtensionLaunchWarning[] = [];
    const loaded: ExtensionEntity[] = [];
    for (const extensionId of environment.extensionIds) {
      const extension = extensionById.get(extensionId);
      if (!extension) {
        warnings.push({ name: extensionId, reason: "扩展记录不存在（浏览器可能回收未加载扩展的本地数据）" });
        continue;
      }
      if (extension.status === "disabled") {
        warnings.push({ name: extension.name, reason: "扩展已停用，本次启动不会加载（浏览器可能回收未加载扩展的本地数据）" });
        continue;
      }
      // update-available must never auto-install here: update() owns the permission-diff gate,
      // and install() would apply added permissions without the 409 confirmation.
      const installed = isLoadableInstallState(extension.installState)
        ? await this.check(extension.id)
        : await this.install(extension.id, { exemptEnvironmentId: environmentId });
      if (!isLoadableInstallState(installed.installState) || !installed.localPath) {
        throw Object.assign(new Error(`Extension ${installed.name} is not installed`), { status: 409 });
      }
      if (installed.installState === "update-available") {
        warnings.push({ name: installed.name, reason: "有可用更新未安装，本次启动仍使用当前版本" });
      }
      if (protectsLifecycle) {
        const runtime = await this.runtimeService.materialize({
          environmentId,
          extension: installed,
          lifecycleRevision: bindingByExtensionId.get(installed.id)?.lifecycleRevision,
        });
        paths.push(runtime.path);
        if (runtime.warning) warnings.push({ name: installed.name, reason: runtime.warning });
        if (!runtime.protected && !this.options.activeEnvironmentIds?.().has(environmentId)) {
          await this.runtimeService.removeExtension(installed.id, [environmentId]);
        }
      } else {
        paths.push(installed.localPath);
      }
      loaded.push(installed);
    }
    warnings.push(...duplicateIdentityWarnings(loaded));
    return { paths, warnings };
  }

  async resolveEnvironment(environmentId: string): Promise<{ environment: BrowserEnvironment; profile: BrowserEnvironment["runtimeProfile"] }> {
    const environment = await this.options.repository.getEnvironment(environmentId);
    if (!environment) throw Object.assign(new Error("Environment does not exist"), { status: 404 });
    const extensionById = new Map((await this.options.repository.listExtensions()).map((extension) => [extension.id, extension]));
    const extensionPaths = environment.extensionIds
      .map((id) => extensionById.get(id))
      .filter((extension): extension is ExtensionEntity => Boolean(extension))
      .filter((extension) => extension.status === "enabled" && extension.installState === "installed" && Boolean(extension.localPath))
      .map((extension) => extension.localPath as string);
    return {
      environment,
      profile: {
        ...environment.runtimeProfile,
        runtime: {
          ...environment.runtimeProfile.runtime,
          extensionPaths,
        },
      },
    };
  }

  private async importLocalAsset(
    filePath: string,
    assetKind: ExtensionAssetKind,
    options: ExtensionImportOptions = {},
  ): Promise<ExtensionEntity> {
    const sourceUrl = path.resolve(filePath);
    const bytes = await fs.readFile(sourceUrl);
    const identity = await this.identityFromArchiveBytes(bytes, assetKind, sourceUrl);
    const conflict = await this.resolveImportDisposition(identity, options);
    if (conflict?.disposition === "reuse") {
      return conflict.target;
    }
    if (conflict?.disposition === "overwrite") {
      return this.overwriteFromArchive(conflict.target, bytes, assetKind, sourceUrl);
    }
    return this.createFromArchiveBytes(bytes, assetKind, createId("extension"), sourceUrl);
  }

  private async createFromArchiveBytes(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    extensionId: string,
    sourceUrl: string,
  ): Promise<ExtensionEntity> {
    const sha256 = sha256Hex(bytes);
    const localPath = await this.extractAsset(bytes, assetKind, extensionId);
    try {
      // Before acquireManifestKey so the digest comes from the package's untouched manifest.
      // (The algorithm drops `key` anyway, but reading first keeps the intent obvious.)
      const manifestSha256 = await readManifestFingerprint(localPath);
      const manifestKey = await this.acquireManifestKey(localPath, assetKind === "crx" ? bytes : undefined);
      const manifest = await readManifestFromDirectory(localPath);
      return await this.options.repository.createExtension({
        ...extensionFieldsFromManifest(manifest),
        id: extensionId,
        sourceKind: assetKind === "zip" ? "local-zip" : "local-crx",
        sourceUrl,
        sha256,
        manifestSha256,
        localPath,
        manifestKey,
        installState: "installed",
        lastInstalledAt: nowIso(),
      });
    } catch (error) {
      await fs.rm(localPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async identityFromArchiveBytes(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    sourceUrl?: string,
  ): Promise<ImportCandidateIdentity> {
    const sha256 = sha256Hex(bytes);
    const previewId = `preview-${sha256.slice(0, 12)}`;
    let manifestKey: string | undefined;
    let manifestSha256: string | undefined;
    let name: string | undefined;
    let version: string | undefined;
    try {
      const { manifest, rawManifestText } = await this.readAssetManifestSources(bytes, assetKind, previewId);
      if (typeof manifest.key === "string" && manifest.key.trim()) {
        manifestKey = manifest.key.trim();
      } else if (assetKind === "crx") {
        manifestKey = extractCrxPublicKey(bytes) || undefined;
      }
      // Same normalization as the directory path so the nameVersion layer compares like with like.
      const manifestFields = extensionFieldsFromManifest(manifest);
      name = manifestFields.name;
      version = manifestFields.version;
      manifestSha256 = manifestFingerprint(rawManifestText);
    } catch {
      // Match still works via sha256/sourceUrl when the archive is valid enough to install later.
    }
    return { manifestKey, sha256, sourceUrl, manifestSha256, name, version };
  }

  private async findImportConflict(identity: ImportCandidateIdentity): Promise<ExtensionImportConflict | undefined> {
    const extensions = await this.options.repository.listExtensions();
    const byKey = identity.manifestKey
      ? extensions.filter((extension) => extension.manifestKey && extension.manifestKey === identity.manifestKey)
      : [];
    if (byKey.length > 0) {
      return { matchBy: "manifestKey", candidates: await this.rankConflictCandidates(byKey) };
    }

    const bySha = identity.sha256
      ? extensions.filter((extension) => extension.sha256 && extension.sha256.toLowerCase() === identity.sha256!.toLowerCase())
      : [];
    if (bySha.length > 0) {
      return { matchBy: "sha256", candidates: await this.rankConflictCandidates(bySha) };
    }

    const normalizedSource = normalizeComparableSourceUrl(identity.sourceUrl);
    const bySource = normalizedSource
      ? extensions.filter((extension) => normalizeComparableSourceUrl(extension.sourceUrl) === normalizedSource)
      : [];
    if (bySource.length > 0) {
      return { matchBy: "sourceUrl", candidates: await this.rankConflictCandidates(bySource) };
    }

    // Content identity, deliberately placed AFTER sourceUrl: re-importing the same path means the
    // user is aiming at the record that owns that path, even when a package with identical content
    // sits in another row. Being a stronger identity does not make it the more specific intent.
    const byManifestSha = identity.manifestSha256
      ? extensions.filter((extension) =>
        extension.manifestSha256 && extension.manifestSha256.toLowerCase() === identity.manifestSha256!.toLowerCase())
      : [];
    if (byManifestSha.length > 0) {
      return { matchBy: "manifestSha256", candidates: await this.rankConflictCandidates(byManifestSha) };
    }

    // Softest layer, deliberately last: a zip and its extracted directory share no key, no sha256,
    // and no path, so without this the same extension lands twice and each copy gets its own
    // injected key — two isolated extension IDs in the browser that nothing else warns about.
    // Still required alongside the fingerprint above: it covers rows stored before fingerprints
    // existed, and packages whose manifest was re-serialized between the two imports.
    const comparableName = normalizeComparableName(identity.name);
    const comparableVersion = identity.version?.trim();
    if (!comparableName || !comparableVersion) return undefined;
    const byNameVersion = extensions.filter((extension) =>
      normalizeComparableName(extension.name) === comparableName && extension.version.trim() === comparableVersion);
    if (byNameVersion.length === 0) return undefined;
    return { matchBy: "nameVersion", candidates: await this.rankConflictCandidates(byNameVersion) };
  }

  private async rankConflictCandidates(candidates: ExtensionEntity[]): Promise<ExtensionEntity[]> {
    if (candidates.length <= 1) return candidates;
    const environments = await this.options.repository.listEnvironments();
    const bindingCount = new Map<string, number>();
    for (const environment of environments) {
      for (const extensionId of environment.extensionIds) {
        bindingCount.set(extensionId, (bindingCount.get(extensionId) ?? 0) + 1);
      }
    }
    return [...candidates].sort((left, right) => {
      const bindingDelta = (bindingCount.get(right.id) ?? 0) - (bindingCount.get(left.id) ?? 0);
      if (bindingDelta !== 0) return bindingDelta;
      return right.updatedAt.localeCompare(left.updatedAt);
    });
  }

  /**
   * First import without disposition throws 409 with candidates.
   * Retry may force a target id (reuse/overwrite) even if the new package no longer
   * matches by key/sha/source — the user already confirmed the conflict dialog.
   */
  private async resolveImportDisposition(
    identity: ImportCandidateIdentity,
    options: ExtensionImportOptions,
  ): Promise<{ disposition: "reuse" | "overwrite"; target: ExtensionEntity } | undefined> {
    const disposition = options.conflictDisposition;
    if (disposition === "create") return undefined;

    if ((disposition === "reuse" || disposition === "overwrite") && options.conflictExtensionId) {
      const target = await this.options.repository.getExtension(options.conflictExtensionId);
      if (!target) {
        throw Object.assign(new Error("conflictExtensionId does not exist"), {
          status: 404,
          code: "EXTENSION_IMPORT_CONFLICT_TARGET",
        });
      }
      return { disposition, target };
    }

    const conflict = await this.findImportConflict(identity);
    if (!conflict) return undefined;

    if (disposition === "reuse" || disposition === "overwrite") {
      // Only an unambiguous match may be resolved implicitly. The name+version layer routinely
      // matches several records at once, and silently overwriting whichever one ranked first is the
      // wrong default for a destructive action, so the caller has to name its target.
      if (conflict.candidates.length > 1) {
        throw Object.assign(new Error("Several extensions match; pass conflictExtensionId to choose one"), {
          status: 409,
          code: "EXTENSION_IMPORT_CONFLICT",
          matchBy: conflict.matchBy,
          candidates: conflict.candidates,
        });
      }
      return { disposition, target: conflict.candidates[0]! };
    }

    throw Object.assign(new Error("Extension already exists; choose reuse, overwrite, or create"), {
      status: 409,
      code: "EXTENSION_IMPORT_CONFLICT",
      matchBy: conflict.matchBy,
      candidates: conflict.candidates,
    });
  }

  private async overwriteFromDirectory(
    existing: ExtensionEntity,
    sourcePath: string,
    mode: ExtensionDirectoryMode,
    manifestFields: ExtensionManifestFields,
    manifestSha256: string | undefined,
  ): Promise<ExtensionEntity> {
    await this.assertNotInUse(existing.id);
    if (mode === "reference") {
      // Overwrite never writes into a user directory; keep the entity as a live reference.
      // Clear archive checksums — a previous zip/crx overwrite must not keep a stale sha256.
      return this.options.repository.updateExtension(existing.id, {
        ...manifestFields,
        sourceKind: "local-directory",
        sourceUrl: sourcePath,
        localPath: sourcePath,
        manifestKey: await readManifestKey(sourcePath),
        directoryMode: "reference",
        sha256: undefined,
        manifestSha256,
        installState: "installed",
        lastInstalledAt: nowIso(),
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    }

    const localPath = await this.copyDirectoryIntoCache(sourcePath, existing.id);
    const manifestKey = await this.resolveOverwriteManifestKey(existing, localPath);
    return this.options.repository.updateExtension(existing.id, {
      ...manifestFields,
      sourceKind: "local-directory",
      sourceUrl: sourcePath,
      localPath,
      manifestKey,
      directoryMode: "copy",
      sha256: undefined,
      manifestSha256,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async overwriteFromArchive(
    existing: ExtensionEntity,
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    sourceUrl: string,
  ): Promise<ExtensionEntity> {
    await this.assertNotInUse(existing.id);
    const sha256 = sha256Hex(bytes);
    const localPath = await this.extractAsset(bytes, assetKind, existing.id);
    // Read before the key is forced back on: the record must carry the NEW package's fingerprint,
    // because keeping the replaced package's digest would make the row answer for content it no
    // longer holds.
    const manifestSha256 = await readManifestFingerprint(localPath);
    const manifestKey = await this.resolveOverwriteManifestKey(
      existing,
      localPath,
      assetKind === "crx" ? bytes : undefined,
    );
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(existing.id, {
      ...extensionFieldsFromManifest(manifest),
      sourceKind: assetKind === "zip" ? "local-zip" : "local-crx",
      sourceUrl,
      sha256,
      manifestSha256,
      localPath,
      manifestKey,
      directoryMode: undefined,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  /**
   * Overwrite keeps the browser-side extension ID stable: force the previous key back onto disk
   * even when the incoming package carries a different developer key.
   */
  private async resolveOverwriteManifestKey(
    existing: ExtensionEntity,
    localPath: string,
    crxBytes?: Uint8Array,
  ): Promise<string | undefined> {
    if (existing.manifestKey) {
      await applyManifestKey(localPath, existing.manifestKey);
      return existing.manifestKey;
    }
    return this.acquireManifestKey(localPath, crxBytes);
  }

  private async cleanupExtensionFiles(extension: ExtensionEntity): Promise<void> {
    const cacheDir = path.resolve(this.options.extensionCacheDir);
    const localPath = extension.localPath ? path.resolve(extension.localPath) : undefined;
    const isReference = extension.sourceKind === "local-directory" && extension.directoryMode === "reference";
    if (localPath && !isReference && isPathInsideDir(localPath, cacheDir) && path.basename(localPath) === extension.id) {
      await fs.rm(localPath, { recursive: true, force: true }).catch(() => undefined);
    }
    for (const assetKind of ["zip", "crx"] as const) {
      const archivePath = path.join(this.extensionArchiveDir, `${extension.id}.${assetKind}`);
      await fs.rm(archivePath, { force: true }).catch(() => undefined);
    }
  }

  private async checkLocalArchiveUpdate(extension: ExtensionEntity): Promise<ExtensionEntity> {
    if (!extension.sourceUrl) {
      return this.options.repository.updateExtension(extension.id, {
        lastCheckedAt: nowIso(),
        lastError: "Extension has no local archive source",
      });
    }
    try {
      const bytes = await fs.readFile(extension.sourceUrl);
      const nextSha = sha256Hex(bytes);
      const assetKind: ExtensionAssetKind = extension.sourceKind === "local-crx" ? "crx" : "zip";
      let nextVersion = extension.version;
      try {
        const manifest = await this.readManifestFromAsset(bytes, assetKind, extension.id);
        nextVersion = typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : nextVersion;
      } catch {
        // Version compare is best-effort; sha256 alone is enough to mark update-available.
      }
      const changed = (extension.sha256 && extension.sha256.toLowerCase() !== nextSha)
        || (nextVersion !== extension.version);
      if (!changed) {
        return this.options.repository.updateExtension(extension.id, {
          lastCheckedAt: nowIso(),
          lastError: undefined,
        });
      }
      return this.options.repository.updateExtension(extension.id, {
        installState: "update-available",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      return this.options.repository.updateExtension(extension.id, {
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  private async checkLocalDirectoryUpdate(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const sourcePath = extension.directoryMode === "copy"
      ? path.resolve(extension.sourceUrl)
      : path.resolve(extension.localPath ?? extension.sourceUrl);
    try {
      const manifest = await readManifestFromDirectory(sourcePath);
      const nextVersion = typeof manifest.version === "string" && manifest.version.trim()
        ? manifest.version.trim()
        : extension.version;
      if (nextVersion === extension.version) {
        // Reference mode still refreshes metadata from the live directory on check-update.
        if (extension.directoryMode === "reference") {
          return this.options.repository.updateExtension(extension.id, {
            ...extensionFieldsFromManifest(manifest),
            lastCheckedAt: nowIso(),
            lastError: undefined,
          });
        }
        return this.options.repository.updateExtension(extension.id, {
          lastCheckedAt: nowIso(),
          lastError: undefined,
        });
      }
      return this.options.repository.updateExtension(extension.id, {
        installState: "update-available",
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    } catch (error) {
      return this.options.repository.updateExtension(extension.id, {
        lastCheckedAt: nowIso(),
        lastError: (error as Error).message,
      });
    }
  }

  private async refreshLocalDirectory(extension: ExtensionEntity): Promise<ExtensionEntity> {
    if (extension.directoryMode === "copy") {
      const sourcePath = path.resolve(extension.sourceUrl);
      let manifest: ExtensionManifest;
      try {
        manifest = await readManifestFromDirectory(sourcePath);
      } catch (error) {
        return await this.keepCopySnapshot(extension, error as Error);
      }
      const localPath = await this.copyDirectoryIntoCache(sourcePath, extension.id);
      // Taken from the fresh snapshot after the copy and before the stored key is re-injected:
      // that is the exact content this record now loads into the browser.
      const manifestSha256 = await readManifestFingerprint(localPath);
      if (extension.manifestKey) await applyManifestKey(localPath, extension.manifestKey);
      return this.options.repository.updateExtension(extension.id, {
        ...extensionFieldsFromManifest(manifest),
        manifestSha256,
        localPath,
        installState: "installed",
        lastInstalledAt: nowIso(),
        lastCheckedAt: nowIso(),
        lastError: undefined,
      });
    }

    const localPath = extension.localPath ?? extension.sourceUrl;
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      manifestSha256: await readManifestFingerprint(localPath),
      sourceUrl: localPath,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  /**
   * Copy mode promises the extension survives losing its source directory. When the source is
   * unreadable but the cached snapshot still holds a valid manifest, stay installed on that
   * snapshot instead of failing the reinstall/launch path.
   *
   * The fingerprint is deliberately left untouched: this path installs nothing, it keeps the
   * previous snapshot, so the stored digest already describes what is on disk.
   */
  private async keepCopySnapshot(extension: ExtensionEntity, sourceError: Error): Promise<ExtensionEntity> {
    if (!extension.localPath) throw sourceError;
    const snapshot = await readManifestFromDirectory(extension.localPath).catch(() => undefined);
    if (!snapshot) throw sourceError;
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(snapshot),
      installState: "installed",
      lastCheckedAt: nowIso(),
      lastError: sourceError.message,
    });
  }

  private async installLocalAsset(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const bytes = await fs.readFile(extension.sourceUrl);
    const actualSha256 = sha256Hex(bytes);
    // update-available means checkUpdate already detected a source change; reinstall from the
    // current local file. Other states still verify the stored checksum for integrity.
    if (
      extension.installState !== "update-available"
      && extension.sha256
      && actualSha256 !== extension.sha256.toLowerCase()
    ) {
      throw Object.assign(new Error("Extension checksum mismatch"), { status: 409 });
    }
    const localPath = await this.extractAsset(bytes, extension.sourceKind === "local-crx" ? "crx" : "zip", extension.id);
    // Before the stored key is forced back on. A local archive replaced in place lands here, so
    // skipping the fingerprint would leave the row describing the package it no longer holds.
    const manifestSha256 = await readManifestFingerprint(localPath);
    if (extension.manifestKey) await applyManifestKey(localPath, extension.manifestKey);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      sha256: actualSha256,
      manifestSha256,
      localPath,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async installRemoteAsset(extension: ExtensionEntity): Promise<ExtensionEntity> {
    const allowUnsigned = await this.allowUnsignedRemote(extension);
    if (!extension.sha256 && !allowUnsigned) {
      throw Object.assign(new Error("Remote extension sha256 is required"), { status: 400 });
    }
    const response = await this.fetchImpl(extension.sourceUrl);
    if (!response.ok) {
      throw Object.assign(new Error(`Remote extension download failed: HTTP ${response.status}`), { status: 502 });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const actualSha256 = sha256Hex(bytes);
    if (extension.sha256 && actualSha256 !== extension.sha256.toLowerCase()) {
      throw Object.assign(new Error("Remote extension checksum mismatch"), { status: 409 });
    }
    const localPath = await this.extractAsset(bytes, extension.sourceKind === "remote-crx" ? "crx" : "zip", extension.id);
    // Before the key lands on disk: a remote asset only becomes a local package here, so this is the
    // one point where its manifest can still be read exactly as the publisher shipped it.
    const manifestSha256 = await readManifestFingerprint(localPath);
    const manifestKey = await this.applyRemoteManifestKey(extension, localPath, bytes);
    const manifest = await readManifestFromDirectory(localPath);
    return this.options.repository.updateExtension(extension.id, {
      ...extensionFieldsFromManifest(manifest),
      sha256: actualSha256,
      manifestSha256,
      localPath,
      manifestKey,
      installState: "installed",
      lastInstalledAt: nowIso(),
      lastCheckedAt: nowIso(),
      lastError: undefined,
    });
  }

  private async applyRemoteManifestKey(
    extension: ExtensionEntity,
    localPath: string,
    bytes: Uint8Array,
  ): Promise<string | undefined> {
    if (extension.manifestKey) {
      await applyManifestKey(localPath, extension.manifestKey);
      return extension.manifestKey;
    }
    const firstInstall = !extension.lastInstalledAt
      && (extension.installState === "download-pending" || extension.installState === "install-failed");
    if (!firstInstall) return undefined;
    return this.acquireManifestKey(localPath, extension.sourceKind === "remote-crx" ? bytes : undefined);
  }

  private async acquireManifestKey(localPath: string, crxBytes?: Uint8Array): Promise<string> {
    const existing = await readManifestKey(localPath);
    if (existing) return existing;
    const manifestKey = (crxBytes && extractCrxPublicKey(crxBytes)) || generateManifestKey();
    await applyManifestKey(localPath, manifestKey);
    return manifestKey;
  }

  /**
   * Recovers the real CRX developer key so migrating a remote-crx adopts the same identity a
   * first install would have extracted, instead of generating a second one for the same asset.
   */
  private async readSourceCrxPublicKey(extension: ExtensionEntity): Promise<string | undefined> {
    try {
      if (extension.sourceKind === "local-crx") {
        return extractCrxPublicKey(await fs.readFile(extension.sourceUrl));
      }
      if (extension.sourceKind !== "remote-crx") return undefined;
      const response = await this.fetchImpl(extension.sourceUrl);
      if (!response.ok) return undefined;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (extension.sha256 && sha256Hex(bytes) !== extension.sha256.toLowerCase()) return undefined;
      return extractCrxPublicKey(bytes);
    } catch {
      return undefined;
    }
  }

  private async assertNotInUse(extensionId: string, options: InUseGuardOptions = {}): Promise<void> {
    const activeEnvironmentIds = this.options.activeEnvironmentIds?.();
    if (!activeEnvironmentIds || activeEnvironmentIds.size === 0) return;
    const environments = await this.options.repository.listEnvironments();
    const blocked = environments.filter(
      (environment) =>
        environment.id !== options.exemptEnvironmentId
        && environment.extensionIds.includes(extensionId)
        && activeEnvironmentIds.has(environment.id),
    );
    if (blocked.length === 0) return;
    throw Object.assign(new Error("扩展正在被运行中的环境使用，请先停止相关会话再执行此操作。"), {
      status: 409,
      code: "EXTENSION_IN_USE",
    });
  }

  private assertOutsideExtensionCache(sourcePath: string): void {
    const cacheDir = path.resolve(this.options.extensionCacheDir);
    const runtimeDir = path.resolve(
      this.options.extensionRuntimeDir ?? path.join(path.dirname(cacheDir), "extension-runtimes"),
    );
    const comparableSource = process.platform === "win32" ? sourcePath.toLowerCase() : sourcePath;
    for (const [managedDir, label] of [[cacheDir, "extension cache"], [runtimeDir, "extension runtime"]] as const) {
      const comparableManaged = process.platform === "win32" ? managedDir.toLowerCase() : managedDir;
      if (comparableSource === comparableManaged || comparableSource.startsWith(`${comparableManaged}${path.sep}`)) {
        throw Object.assign(
          new Error(`Extension directory cannot be inside the ${label} directory: ${sourcePath}`),
          { status: 400 },
        );
      }
      if (comparableManaged.startsWith(`${comparableSource}${path.sep}`)) {
        throw Object.assign(
          new Error(`Extension directory cannot contain the ${label} directory: ${sourcePath}`),
          { status: 400 },
        );
      }
    }
  }

  private async copyDirectoryIntoCache(sourcePath: string, extensionId: string): Promise<string> {
    const outputDir = path.join(this.options.extensionCacheDir, extensionId);
    const swapSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempDir = `${outputDir}.tmp-${swapSuffix}`;
    const asideDir = `${outputDir}.old-${swapSuffix}`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    let movedAside = false;
    try {
      await fs.cp(sourcePath, tempDir, { recursive: true });
      movedAside = await renameIfExists(outputDir, asideDir);
      await fs.rename(tempDir, outputDir);
      await fs.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
      return outputDir;
    } catch (error) {
      if (movedAside) await fs.rename(asideDir, outputDir).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async extractAsset(bytes: Uint8Array, assetKind: ExtensionAssetKind, extensionId: string): Promise<string> {
    const zipBytes = assetKind === "crx" ? stripCrxHeader(bytes) : bytes;
    const outputDir = path.join(this.options.extensionCacheDir, extensionId);
    const swapSuffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempDir = `${outputDir}.tmp-${swapSuffix}`;
    const asideDir = `${outputDir}.old-${swapSuffix}`;
    const unpackDir = `${tempDir}-unpack`;
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(unpackDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    let movedAside = false;
    try {
      // Unpack into a throwaway tree first, then promote the manifest root into tempDir so
      // the live swap renames one directory (mirrors copyDirectoryIntoCache).
      await fs.mkdir(unpackDir, { recursive: true });
      await writeZipEntries(zipBytes, unpackDir);
      const manifestDir = await findManifestDirectory(unpackDir);
      await fs.rename(manifestDir, tempDir);
      await fs.rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
      movedAside = await renameIfExists(outputDir, asideDir);
      await fs.rename(tempDir, outputDir);
      await fs.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
      return outputDir;
    } catch (error) {
      if (movedAside) await fs.rename(asideDir, outputDir).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      await fs.rm(unpackDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private async getExtensionOrThrow(id: string): Promise<ExtensionEntity> {
    const extension = await this.options.repository.getExtension(id);
    if (!extension) throw Object.assign(new Error("Extension does not exist"), { status: 404 });
    return extension;
  }

  private async getExtensionSourceOrThrow(id: string): Promise<ExtensionSourceEntity> {
    const source = await this.options.repository.getExtensionSource(id);
    if (!source) throw Object.assign(new Error("Extension source does not exist"), { status: 404 });
    return source;
  }

  private async fetchSourceIndex(source: ExtensionSourceEntity): Promise<ExtensionSourceIndex> {
    const response = await this.fetchImpl(source.url);
    if (!response.ok) {
      throw Object.assign(new Error(`Extension source refresh failed: HTTP ${response.status}`), { status: 502 });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch (error) {
      throw Object.assign(new Error(`Extension source index is not valid JSON: ${(error as Error).message}`), { status: 400 });
    }
    return parseExtensionSourceIndex(parsed, source.allowUnsignedAssets);
  }

  private async allowUnsignedRemote(extension: ExtensionEntity): Promise<boolean> {
    if (!extension.sourceId) return false;
    const source = await this.options.repository.getExtensionSource(extension.sourceId);
    return source?.allowUnsignedAssets === true;
  }

  private async assertNoAddedPermissionsForUpdate(extension: ExtensionEntity): Promise<void> {
    const nextManifest = await this.readInstallCandidateManifest(extension);
    const candidate = { ...extension, ...extensionFieldsFromManifest(nextManifest) };
    const addedPermissions = permissionsAdded(extension, candidate);
    if (addedPermissions.length === 0) return;
    await this.options.repository.updateExtension(extension.id, {
      installState: "update-available",
      lastCheckedAt: nowIso(),
      lastError: `Extension update adds permissions: ${addedPermissions.join(", ")}`,
    });
    throw Object.assign(new Error("Extension update adds permissions and requires confirmation"), {
      status: 409,
      permissions: addedPermissions,
    });
  }

  private async readInstallCandidateManifest(extension: ExtensionEntity): Promise<ExtensionManifest> {
    if (extension.sourceKind === "local-directory") {
      // Copy mode installs FROM sourceUrl; diffing localPath would compare the snapshot with
      // itself and turn the added-permission gate into a no-op.
      return extension.directoryMode === "copy"
        ? readManifestFromDirectory(extension.sourceUrl)
        : readManifestFromDirectory(extension.localPath ?? extension.sourceUrl);
    }
    if (extension.sourceKind === "local-zip" || extension.sourceKind === "local-crx") {
      const bytes = await fs.readFile(extension.sourceUrl);
      // Permission-diff for an available update must read the new package even when sha differs.
      if (
        extension.installState !== "update-available"
        && extension.sha256
        && sha256Hex(bytes) !== extension.sha256.toLowerCase()
      ) {
        throw Object.assign(new Error("Extension checksum mismatch"), { status: 409 });
      }
      return this.readManifestFromAsset(bytes, extension.sourceKind === "local-crx" ? "crx" : "zip", extension.id);
    }
    if (extension.sourceKind === "remote-zip" || extension.sourceKind === "remote-crx") {
      const allowUnsigned = await this.allowUnsignedRemote(extension);
      if (!extension.sha256 && !allowUnsigned) {
        throw Object.assign(new Error("Remote extension sha256 is required"), { status: 400 });
      }
      const response = await this.fetchImpl(extension.sourceUrl);
      if (!response.ok) {
        throw Object.assign(new Error(`Remote extension download failed: HTTP ${response.status}`), { status: 502 });
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      const actualSha256 = sha256Hex(bytes);
      if (extension.sha256 && actualSha256 !== extension.sha256.toLowerCase()) {
        throw Object.assign(new Error("Remote extension checksum mismatch"), { status: 409 });
      }
      return this.readManifestFromAsset(bytes, extension.sourceKind === "remote-crx" ? "crx" : "zip", extension.id);
    }
    throw Object.assign(new Error("Chrome Web Store metadata cannot be installed without a verified asset"), {
      status: 409,
      code: "EXTENSION_WEB_STORE",
    });
  }

  private async readManifestFromAsset(bytes: Uint8Array, assetKind: ExtensionAssetKind, extensionId: string): Promise<ExtensionManifest> {
    return (await this.readAssetManifestSources(bytes, assetKind, extensionId)).manifest;
  }

  /**
   * Both views of an archive's manifest from a single extraction: the resolved object for entity
   * fields, and the raw text the fingerprint must hash (see `manifestFingerprint`, reason 2).
   */
  private async readAssetManifestSources(
    bytes: Uint8Array,
    assetKind: ExtensionAssetKind,
    extensionId: string,
  ): Promise<{ manifest: ExtensionManifest; rawManifestText: string }> {
    const zipBytes = assetKind === "crx" ? stripCrxHeader(bytes) : bytes;
    const tempDir = path.join(this.options.extensionCacheDir, `.preview-${extensionId}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.mkdir(tempDir, { recursive: true });
    try {
      await writeZipEntries(zipBytes, tempDir);
      const manifestDir = await findManifestDirectory(tempDir);
      const manifest = await readManifestFromDirectory(manifestDir);
      const rawManifestText = await fs.readFile(path.join(manifestDir, "manifest.json"), "utf8");
      return { manifest, rawManifestText };
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }
}

export async function readManifestFromDirectory(directory: string): Promise<ExtensionManifest> {
  const manifestPath = path.join(path.resolve(directory), "manifest.json");
  let manifest: unknown;
  try {
    await fs.access(manifestPath, fsConstants.R_OK);
    manifest = JSON.parse(stripBom(await fs.readFile(manifestPath, "utf8")));
  } catch (error) {
    if (isMissingManifestError(error)) {
      throw Object.assign(new Error(`Extension directory must directly contain manifest.json: ${path.resolve(directory)}`), { status: 400 });
    }
    throw Object.assign(new Error(`Invalid extension manifest: ${(error as Error).message}`), { status: 400 });
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw Object.assign(new Error("Invalid extension manifest"), { status: 400 });
  }
  const candidate = manifest as ExtensionManifest;
  if (!candidate.name || !candidate.version || !Number.isFinite(candidate.manifest_version)) {
    throw Object.assign(new Error("Extension manifest must include name, version, and manifest_version"), { status: 400 });
  }
  return resolveManifestI18n(path.resolve(directory), candidate);
}

/** Chrome keys `icons` by pixel size; prefer 128, else the largest up to 256, else the largest. */
function pickManifestIcon(manifest: ExtensionManifest): string | undefined {
  return pickIconFromSizeMap(manifest.icons)
    ?? pickActionIcon(manifest.action)
    ?? pickActionIcon(manifest.browser_action);
}

/** Toolbar-only extensions often declare no top-level `icons`, just `action.default_icon`. */
function pickActionIcon(action: unknown): string | undefined {
  if (typeof action === "string") return normalizeIconPath(action);
  if (!action || typeof action !== "object" || Array.isArray(action)) return undefined;
  const defaultIcon = (action as { default_icon?: unknown }).default_icon;
  if (typeof defaultIcon === "string") return normalizeIconPath(defaultIcon);
  return pickIconFromSizeMap(defaultIcon);
}

function pickIconFromSizeMap(icons: unknown): string | undefined {
  if (!icons || typeof icons !== "object" || Array.isArray(icons)) return undefined;
  const entries: { size: number; value: string }[] = [];
  for (const [key, value] of Object.entries(icons as Record<string, unknown>)) {
    const normalized = normalizeIconPath(value);
    if (!normalized) continue;
    const size = Number.parseInt(key, 10);
    if (!Number.isFinite(size) || size <= 0) continue;
    entries.push({ size, value: normalized });
  }
  if (entries.length === 0) return undefined;
  entries.sort((left, right) => right.size - left.size);
  return (
    entries.find((entry) => entry.size === 128)
    ?? entries.find((entry) => entry.size <= 256)
    ?? entries[0]
  )?.value;
}

/** Manifests may write package-root paths like "/icons/128.png"; Chrome resolves those inside the package. */
function normalizeIconPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/^[\\/]+/, "");
  return trimmed || undefined;
}

export async function resolveManifestI18n(directory: string, manifest: ExtensionManifest): Promise<ExtensionManifest> {
  const name = typeof manifest.name === "string" ? manifest.name : "";
  const description = typeof manifest.description === "string" ? manifest.description : "";
  if (!MESSAGE_PLACEHOLDER_PATTERN.test(name) && !MESSAGE_PLACEHOLDER_PATTERN.test(description)) return manifest;

  try {
    const locales = messageLocaleCandidates(manifest.default_locale);
    const cache = new Map<string, Map<string, string> | undefined>();
    return {
      ...manifest,
      name: await resolveMessagePlaceholders(name, directory, locales, cache),
      description: await resolveMessagePlaceholders(description, directory, locales, cache),
    };
  } catch {
    return manifest;
  }
}

function messageLocaleCandidates(defaultLocale: unknown): string[] {
  return [...new Set([...PREFERRED_MESSAGE_LOCALES, normalizeLocaleTag(defaultLocale), ...FALLBACK_MESSAGE_LOCALES].filter(Boolean))];
}

function normalizeLocaleTag(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim().replace(/-/g, "_") : "";
  if (!normalized) return "";
  const segments = normalized.split("_");
  if (segments.length === 1) return normalized.toLowerCase();
  if (segments.length !== 2) return normalized;
  return `${segments[0].toLowerCase()}_${segments[1].toUpperCase()}`;
}

async function resolveMessagePlaceholders(
  value: string,
  directory: string,
  locales: string[],
  cache: Map<string, Map<string, string> | undefined>,
): Promise<string> {
  if (!MESSAGE_PLACEHOLDER_PATTERN.test(value)) return value;
  let resolved = value;
  for (const token of new Set(value.match(/__MSG_([A-Za-z0-9_@]+)__/g) ?? [])) {
    const messageName = token.slice("__MSG_".length, -"__".length);
    const message = await readLocalizedMessage(directory, locales, cache, messageName);
    if (message === undefined) continue;
    resolved = resolved.split(token).join(message);
  }
  return resolved;
}

async function readLocalizedMessage(
  directory: string,
  locales: string[],
  cache: Map<string, Map<string, string> | undefined>,
  messageName: string,
): Promise<string | undefined> {
  for (const locale of locales) {
    const messages = await readLocaleMessages(directory, locale, cache);
    const message = messages?.get(messageName.toLowerCase());
    if (typeof message === "string") return message;
  }
  return undefined;
}

async function readLocaleMessages(
  directory: string,
  locale: string,
  cache: Map<string, Map<string, string> | undefined>,
): Promise<Map<string, string> | undefined> {
  if (cache.has(locale)) return cache.get(locale);
  let messages: Map<string, string> | undefined;
  try {
    const raw = stripBom(await fs.readFile(path.join(directory, "_locales", locale, "messages.json"), "utf8"));
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      messages = new Map<string, string>();
      for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
        const message = (entry as { message?: unknown } | null)?.message;
        if (typeof message === "string") messages.set(key.toLowerCase(), message);
      }
    }
  } catch {
    messages = undefined;
  }
  cache.set(locale, messages);
  return messages;
}

function isCacheArtifactName(name: string): boolean {
  return name.startsWith(CACHE_PREVIEW_PREFIX) || CACHE_ARTIFACT_MARKERS.some((marker) => name.includes(marker));
}

/**
 * cloakbrowser joins `--load-extension` paths with commas, so a path containing one silently
 * splits into two bogus paths and the extension never loads while preflight still passes.
 */
function assertPathHasNoComma(sourcePath: string): void {
  if (!sourcePath.includes(",")) return;
  throw Object.assign(
    new Error(`Extension directory path cannot contain a comma because the browser separates extension paths with commas: ${sourcePath}`),
    { status: 400 },
  );
}

function isLoadableInstallState(state: ExtensionEntity["installState"]): boolean {
  return state === "installed" || state === "update-available";
}

/** Chromium derives one ID per key/path, so a shared identity means one of the two never loads. */
function duplicateIdentityWarnings(extensions: ExtensionEntity[]): ExtensionLaunchWarning[] {
  const warnings: ExtensionLaunchWarning[] = [];
  const firstByKey = new Map<string, ExtensionEntity>();
  const firstByPath = new Map<string, ExtensionEntity>();

  for (const extension of extensions) {
    if (extension.manifestKey) {
      const first = firstByKey.get(extension.manifestKey);
      if (!first) {
        firstByKey.set(extension.manifestKey, extension);
      } else {
        warnings.push({ name: extension.name, reason: `与 ${first.name} 使用相同的固定 key，浏览器只会加载其中一个` });
      }
    }

    const normalizedPath = normalizeComparablePath(extension.localPath);
    if (!normalizedPath) continue;
    const firstPath = firstByPath.get(normalizedPath);
    if (!firstPath) {
      firstByPath.set(normalizedPath, extension);
      continue;
    }
    warnings.push({
      name: extension.name,
      reason: `与 ${firstPath.name} 使用相同的本地路径，浏览器只会加载其中一个`,
    });
  }
  return warnings;
}

function normalizeComparableSourceUrl(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
  return normalizeComparablePath(trimmed);
}

function normalizeComparablePath(value: string | undefined): string | undefined {
  if (!value?.trim()) return undefined;
  const resolved = path.resolve(value.trim());
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Display names differ only in case/padding across import paths, so both are ignored when matching. */
function normalizeComparableName(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function isPathInsideDir(targetPath: string, parentDir: string): boolean {
  const parent = process.platform === "win32" ? path.resolve(parentDir).toLowerCase() : path.resolve(parentDir);
  const target = process.platform === "win32" ? path.resolve(targetPath).toLowerCase() : path.resolve(targetPath);
  return target === parent || target.startsWith(`${parent}${path.sep}`);
}

/**
 * Canonicalizes a target and its containing directory together so a symlink cannot pass a lexical
 * containment check. Either both sides are canonical or neither is: resolving only the target would
 * reject every icon under a symlinked data directory. A missing target (or a platform that refuses
 * realpath) falls back to the lexical paths, which is exactly the previous behaviour.
 */
async function realpathPair(targetPath: string, parentDir: string): Promise<[string, string]> {
  try {
    return [await fs.realpath(targetPath), await fs.realpath(parentDir)];
  } catch {
    return [targetPath, parentDir];
  }
}

function isMissingManifestError(error: unknown): boolean {
  if (!(error instanceof Error) || !("code" in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function renameIfExists(from: string, to: string): Promise<boolean> {
  try {
    await fs.rename(from, to);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function analyzePermissionRisks(input: PermissionRiskInput): ExtensionPermissionRisk[] {
  const risks = new Map<string, ExtensionPermissionRisk>();
  const addRisk = (risk: ExtensionPermissionRisk): void => {
    const existing = risks.get(risk.permission);
    if (existing && (existing.level === "high" || risk.level !== "high")) return;
    risks.set(risk.permission, risk);
  };

  for (const permission of [...(input.permissions ?? []), ...(input.hostPermissions ?? [])]) {
    const risk = classifyPermission(permission);
    if (risk) addRisk({ permission, ...risk });
  }
  for (const match of input.contentScriptMatches ?? []) {
    if (!ALL_URLS_PATTERNS.has(match)) continue;
    addRisk({ permission: match, level: "high", reason: "内容脚本注入所有网站", reasonKey: "content-script-all-urls" });
  }
  for (const permission of [...(input.optionalPermissions ?? []), ...(input.optionalHostPermissions ?? [])]) {
    const risk = classifyPermission(permission);
    if (risk) addRisk({ permission, ...risk, reason: `可选权限：${risk.reason}`, optional: true });
  }

  return [...risks.values()];
}

function classifyPermission(
  permission: string,
): { level: ExtensionPermissionRiskLevel; reason: string; reasonKey: ExtensionPermissionRiskReasonKey } | undefined {
  if (ALL_URLS_PATTERNS.has(permission)) return { level: "high", reason: "可访问所有网站", reasonKey: "all-urls" };
  if (HIGH_RISK_PERMISSIONS.has(permission)) {
    return { level: "high", reason: "High-privilege browser extension permission", reasonKey: "high-privilege" };
  }
  const medium = MEDIUM_RISK_PERMISSIONS[permission];
  return medium ? { level: "medium", reason: medium.reason, reasonKey: medium.reasonKey } : undefined;
}

/** The subset of an entity that is derived purely from a resolved manifest. */
type ExtensionManifestFields = Pick<
  ExtensionEntity,
  "name" | "description" | "version" | "manifestVersion" | "permissions" | "hostPermissions" | "permissionRisks"
>;

function extensionFieldsFromManifest(manifest: ExtensionManifest): ExtensionManifestFields {
  const permissions = stringArray(manifest.permissions);
  const hostPermissions = stringArray(manifest.host_permissions);
  return {
    name: typeof manifest.name === "string" && manifest.name.trim() ? manifest.name.trim() : "Extension",
    description: typeof manifest.description === "string" ? manifest.description.trim() : "",
    version: typeof manifest.version === "string" && manifest.version.trim() ? manifest.version.trim() : "0.0.0",
    manifestVersion: Number(manifest.manifest_version),
    permissions,
    hostPermissions,
    permissionRisks: analyzePermissionRisks({
      permissions,
      hostPermissions,
      optionalPermissions: stringArray(manifest.optional_permissions),
      optionalHostPermissions: stringArray(manifest.optional_host_permissions),
      contentScriptMatches: contentScriptMatches(manifest.content_scripts),
    }),
  };
}

function contentScriptMatches(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const matches: string[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    matches.push(...stringArray((entry as { matches?: unknown }).matches));
  }
  return [...new Set(matches)];
}

async function discoverChromeExtensionCandidates(rootPath: string): Promise<ExtensionDirectoryCandidate[]> {
  const extensionDirectories = await listDirectories(rootPath);
  const byPath = new Map<string, ExtensionDirectoryCandidate>();

  for (const extensionDirectory of extensionDirectories) {
    const extensionId = path.basename(extensionDirectory);
    const versionDirectories = await listDirectories(extensionDirectory);
    for (const versionDirectory of versionDirectories) {
      const candidate = await readManifestCandidate(versionDirectory, extensionId);
      if (candidate) byPath.set(candidate.path, candidate);
    }
  }

  return [...byPath.values()].sort((left, right) =>
    left.name.localeCompare(right.name) ||
    left.version.localeCompare(right.version) ||
    left.extensionId.localeCompare(right.extensionId) ||
    left.path.localeCompare(right.path),
  );
}

async function readDirectManifestCandidate(directory: string): Promise<ExtensionDirectoryCandidate | undefined> {
  if (!(await manifestFileExists(directory))) return undefined;
  const manifest = await readManifestFromDirectory(directory);
  return manifestCandidateFromManifest(directory, inferExtensionId(directory), manifest);
}

async function readManifestCandidate(directory: string, extensionId: string): Promise<ExtensionDirectoryCandidate | undefined> {
  try {
    const manifest = await readManifestFromDirectory(directory);
    return manifestCandidateFromManifest(directory, extensionId, manifest);
  } catch {
    return undefined;
  }
}

function manifestCandidateFromManifest(directory: string, extensionId: string, manifest: ExtensionManifest): ExtensionDirectoryCandidate {
  const fields = extensionFieldsFromManifest(manifest);
  const resolvedPath = path.resolve(directory);
  return {
    id: sha256Hex(Buffer.from(resolvedPath, "utf8")).slice(0, 16),
    extensionId,
    name: fields.name,
    version: fields.version,
    manifestVersion: fields.manifestVersion,
    path: resolvedPath,
    permissionRisks: fields.permissionRisks,
  };
}

async function manifestFileExists(directory: string): Promise<boolean> {
  try {
    await fs.access(path.join(path.resolve(directory), "manifest.json"), fsConstants.R_OK);
    return true;
  } catch (error) {
    if (isMissingManifestError(error)) return false;
    throw Object.assign(new Error(`Cannot read extension manifest: ${(error as Error).message}`), { status: 400 });
  }
}

async function listDirectories(directory: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingManifestError(error)) return [];
    throw Object.assign(new Error(`Cannot read extension directory: ${(error as Error).message}`), { status: 400 });
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(directory, entry.name));
}

function inferExtensionId(directory: string): string {
  return path.basename(path.resolve(directory));
}

function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const uniquePaths: string[] = [];
  for (const input of paths) {
    if (typeof input !== "string" || !input.trim()) continue;
    const resolved = path.resolve(input.trim());
    const comparable = process.platform === "win32" ? resolved.toLowerCase() : resolved;
    if (seen.has(comparable)) continue;
    seen.add(comparable);
    uniquePaths.push(resolved);
  }
  return uniquePaths;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()))]
    : [];
}

function permissionsAdded(previous: ExtensionEntity, next: ExtensionEntity): string[] {
  const before = new Set([...previous.permissions, ...previous.hostPermissions]);
  return [...new Set([...next.permissions, ...next.hostPermissions].filter((permission) => !before.has(permission)))];
}

function isPermissionConfirmationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { status?: unknown }).status === 409 &&
    Array.isArray((error as { permissions?: unknown }).permissions)
  );
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function extensionIdFromSourceEntry(sourceId: string, entryId: string): string {
  const digest = sha256Hex(Buffer.from(`${sourceId}:${entryId}`, "utf8")).slice(0, 16);
  return `extension-${digest}`;
}

function parseExtensionSourceIndex(input: unknown, allowUnsignedAssets: boolean): ExtensionSourceIndex {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error("Extension source index must be an object"), { status: 400 });
  }
  const record = input as Record<string, unknown>;
  if (record.schemaVersion !== 1) {
    throw Object.assign(new Error("Extension source index schemaVersion must be 1"), { status: 400 });
  }
  if (!Array.isArray(record.extensions)) {
    throw Object.assign(new Error("Extension source index must include extensions array"), { status: 400 });
  }
  return {
    name: readOptionalString(record.name) ?? "Extension Source",
    extensions: record.extensions.map((entry, index) => parseExtensionSourceEntry(entry, index, allowUnsignedAssets)),
  };
}

function parseExtensionSourceEntry(input: unknown, index: number, allowUnsignedAssets: boolean): ExtensionSourceIndexEntry {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw Object.assign(new Error(`Extension source entry ${index + 1} must be an object`), { status: 400 });
  }
  const record = input as Record<string, unknown>;
  const id = readRequiredString(record.id, `Extension source entry ${index + 1} id`);
  const name = readRequiredString(record.name, `Extension source entry ${index + 1} name`);
  const version = readRequiredString(record.version, `Extension source entry ${index + 1} version`);
  const assetKind = readRequiredString(record.assetKind, `Extension source entry ${index + 1} assetKind`);
  if (assetKind !== "zip" && assetKind !== "crx") {
    throw Object.assign(new Error(`Extension source entry ${index + 1} assetKind must be zip or crx`), { status: 400 });
  }
  const assetUrl = readRequiredString(record.assetUrl, `Extension source entry ${index + 1} assetUrl`);
  const sha256 = readOptionalString(record.sha256)?.toLowerCase();
  if (!sha256 && !allowUnsignedAssets) {
    throw Object.assign(new Error(`Extension source entry ${index + 1} sha256 is required`), { status: 400 });
  }
  if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) {
    throw Object.assign(new Error(`Extension source entry ${index + 1} sha256 must be 64 hex characters`), { status: 400 });
  }
  return {
    id,
    name,
    description: readOptionalString(record.description),
    version,
    assetKind,
    assetUrl,
    sha256,
    webStoreId: readOptionalString(record.webStoreId),
    storeUrl: readOptionalString(record.storeUrl),
  };
}

function readRequiredString(value: unknown, label: string): string {
  const normalized = readOptionalString(value);
  if (!normalized) throw Object.assign(new Error(`${label} cannot be empty`), { status: 400 });
  return normalized;
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Adopting a CRX developer key inherits that extension's browser-side ID and therefore its
 * stored data in every profile, so the key is only adopted when the CRX3 `sha256_with_rsa`
 * proof actually verifies over this exact payload. CRX2 (dead format) and ECDSA proofs are
 * never adopted; callers fall back to a generated key.
 */
export function extractCrxPublicKey(bytes: Uint8Array): string | undefined {
  try {
    if (bytes.byteLength < 16) return undefined;
    if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "Cr24") return undefined;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint32(4, true) !== 3) return undefined;

    const headerLength = view.getUint32(8, true);
    if (headerLength === 0 || 12 + headerLength > bytes.byteLength) return undefined;
    const headerFields = readProtobufFields(bytes.subarray(12, 12 + headerLength));
    if (!headerFields) return undefined;
    const signedHeaderData = headerFields.find((field) => field.field === 10000)?.value;
    if (!signedHeaderData) return undefined;
    const crxId = readProtobufFields(signedHeaderData)?.find((field) => field.field === 1)?.value;
    if (!crxId || crxId.byteLength !== 16) return undefined;
    const crxIdHex = Buffer.from(crxId).toString("hex");
    const zipPayload = bytes.subarray(12 + headerLength);

    for (const proof of headerFields.filter((field) => field.field === 2)) {
      const proofFields = readProtobufFields(proof.value);
      const publicKey = proofFields?.find((field) => field.field === 1)?.value;
      const signature = proofFields?.find((field) => field.field === 2)?.value;
      if (!publicKey || publicKey.byteLength === 0 || !signature || signature.byteLength === 0) continue;
      if (sha256Hex(publicKey).slice(0, 32) !== crxIdHex) continue;
      if (!verifyCrx3Signature(publicKey, signature, signedHeaderData, zipPayload)) continue;
      return Buffer.from(publicKey).toString("base64");
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function verifyCrx3Signature(
  publicKey: Uint8Array,
  signature: Uint8Array,
  signedHeaderData: Uint8Array,
  zipPayload: Uint8Array,
): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKey), format: "der", type: "spki" });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(crx3SignedDataPrefix(signedHeaderData.byteLength));
    verifier.update(signedHeaderData);
    verifier.update(zipPayload);
    return verifier.verify(key, signature);
  } catch {
    return false;
  }
}

function crx3SignedDataPrefix(signedHeaderLength: number): Buffer {
  const prefix = Buffer.alloc(CRX3_SIGNED_DATA_MAGIC.length + 1 + 4);
  prefix.write(CRX3_SIGNED_DATA_MAGIC, 0, "ascii");
  prefix.writeUInt8(0, CRX3_SIGNED_DATA_MAGIC.length);
  prefix.writeUInt32LE(signedHeaderLength, CRX3_SIGNED_DATA_MAGIC.length + 1);
  return prefix;
}

export function generateManifestKey(): string {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).toString("base64");
}

export async function applyManifestKey(directory: string, key: string): Promise<void> {
  const manifestPath = path.join(path.resolve(directory), "manifest.json");
  const manifest = parseManifestJson(stripBom(await fs.readFile(manifestPath, "utf8"))) as Record<string, unknown>;
  if (manifest.key === key) return;
  manifest.key = key;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function readManifestKey(directory: string): Promise<string | undefined> {
  try {
    const manifestPath = path.join(path.resolve(directory), "manifest.json");
    const manifest = parseManifestJson(stripBom(await fs.readFile(manifestPath, "utf8"))) as { key?: unknown };
    return typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Fingerprints the `manifest.json` sitting in `directory`.
 * Best-effort by design: an unreadable or invalid manifest yields `undefined` so a missing
 * fingerprint never fails an import or a check — the softer `nameVersion` layer still covers
 * those records.
 */
async function readManifestFingerprint(directory: string): Promise<string | undefined> {
  try {
    return manifestFingerprint(await fs.readFile(path.join(path.resolve(directory), "manifest.json"), "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Content identity of one extension package, derived from its RAW manifest text.
 *
 * Three properties, each load-bearing — do not simplify any of them:
 *
 * 1. The top-level `key` is dropped. Copy imports get a per-record key injected into their snapshot
 *    (`acquireManifestKey`), so keeping it would make two imports of the SAME package hash
 *    differently and defeat this layer entirely. Packages that ship their own `key` lose nothing:
 *    the earlier `manifestKey` layer already catches those.
 * 2. The input is the package's own text, never the object `readManifestFromDirectory` returns —
 *    that one ran through `resolveManifestI18n`, whose result depends on the `_locales` message
 *    files and on the order of `PREFERRED_MESSAGE_LOCALES`. Hashing it would silently invalidate
 *    every already-stored digest the day that preference list changes: no error, records just stop
 *    matching.
 * 3. The value is re-serialized key-sorted instead of hashing the raw bytes. A manifest inside a ZIP
 *    and a copy the user unpacked by hand routinely differ in indentation, newlines, BOM and key
 *    order, and none of those differences mean a different package.
 */
function manifestFingerprint(rawManifestText: string): string {
  const parsed = JSON.parse(stripBom(rawManifestText)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("Invalid extension manifest"), { status: 400 });
  }
  const withoutKey = { ...(parsed as Record<string, unknown>) };
  delete withoutKey.key;
  return sha256Hex(Buffer.from(canonicalJsonText(withoutKey), "utf8"));
}

/** Key-sorted re-serialization; array order is preserved because a manifest's arrays are ordered data. */
function canonicalJsonText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJsonText).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      // Code-unit order, never `localeCompare`: a locale-sensitive sort would make the digest depend
      // on the host's locale, so the same package would hash differently on two machines.
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJsonText(item)}`).join(",")}}`;
  }
  // Only reached for JSON scalars (null / string / finite number / boolean), which always stringify.
  return JSON.stringify(value);
}

function parseManifestJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw Object.assign(new Error(`Invalid extension manifest: ${(error as Error).message}`), { status: 400 });
  }
}

function readProtobufFields(bytes: Uint8Array): Array<{ field: number; value: Uint8Array }> | undefined {
  const fields: Array<{ field: number; value: Uint8Array }> = [];
  let cursor = 0;
  while (cursor < bytes.byteLength) {
    const tag = readVarint(bytes, cursor);
    if (!tag) return undefined;
    cursor = tag.next;
    const fieldNumber = Math.floor(tag.value / 8);
    const wireType = tag.value % 8;
    if (wireType === 2) {
      const length = readVarint(bytes, cursor);
      if (!length) return undefined;
      const end = length.next + length.value;
      if (end > bytes.byteLength) return undefined;
      fields.push({ field: fieldNumber, value: bytes.subarray(length.next, end) });
      cursor = end;
      continue;
    }
    if (wireType === 0) {
      const skipped = readVarint(bytes, cursor);
      if (!skipped) return undefined;
      cursor = skipped.next;
      continue;
    }
    if (wireType === 1 || wireType === 5) {
      cursor += wireType === 1 ? 8 : 4;
      if (cursor > bytes.byteLength) return undefined;
      continue;
    }
    return undefined;
  }
  return fields;
}

function readVarint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let shift = 0;
  let cursor = offset;
  while (cursor < bytes.byteLength) {
    const byte = bytes[cursor];
    cursor += 1;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift += 7;
    if (shift > 49) return undefined;
  }
  return undefined;
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function stripCrxHeader(bytes: Uint8Array): Uint8Array {
  if (bytes.byteLength < 4) return bytes;
  const magic = Buffer.from(bytes.subarray(0, 4)).toString("ascii");
  if (magic !== "Cr24") return bytes;
  if (bytes.byteLength < 12) throw Object.assign(new Error("Invalid CRX header"), { status: 400 });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  if (version === 2) {
    if (bytes.byteLength < 16) throw Object.assign(new Error("Invalid CRX2 header"), { status: 400 });
    const publicKeyLength = view.getUint32(8, true);
    const signatureLength = view.getUint32(12, true);
    return bytes.subarray(16 + publicKeyLength + signatureLength);
  }
  if (version === 3) {
    const headerLength = view.getUint32(8, true);
    return bytes.subarray(12 + headerLength);
  }
  throw Object.assign(new Error(`Unsupported CRX version: ${version}`), { status: 400 });
}

async function findManifestDirectory(root: string): Promise<string> {
  const manifestPath = await findFile(root, "manifest.json", 3);
  if (!manifestPath) throw Object.assign(new Error("Extension package does not contain manifest.json"), { status: 400 });
  return path.dirname(manifestPath);
}

async function writeZipEntries(zipBytes: Uint8Array, outputDir: string): Promise<void> {
  const entries = unzipSync(zipBytes);
  for (const [entryName, entryBytes] of Object.entries(entries)) {
    const normalizedName = entryName.replace(/\\/g, "/");
    if (!normalizedName || normalizedName.endsWith("/")) continue;
    const targetPath = safeJoin(outputDir, normalizedName);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, entryBytes);
  }
}

async function findFile(directory: string, fileName: string, depth: number): Promise<string | undefined> {
  if (depth < 0) return undefined;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isFile() && entry.name === fileName) return entryPath;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findFile(path.join(directory, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function safeJoin(root: string, relativePath: string): string {
  const targetPath = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const comparableRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}${path.sep}`)) {
    throw Object.assign(new Error("Extension archive contains an unsafe path"), { status: 400 });
  }
  return targetPath;
}
