import fs from "node:fs/promises";
import path from "node:path";

/**
 * Removes what Chromium keeps for one extension inside an environment's user-data directory.
 *
 * Chrome only performs this cleanup itself when the extension is uninstalled through the browser.
 * CBPanel loads extensions as unpacked copies through the `--load-extension` /
 * `--disable-extensions-except` switch pair, so deleting the panel record and
 * its cache never reaches the profile: the browser-side ID (derived from `manifest.key`) stays the same
 * and the next install silently inherits the old `chrome.storage.local`, IndexedDB databases, rules and
 * cookies for that ID. That is how a "fresh" reinstall came back with the previous data.
 *
 * Everything here is keyed by ID and lives under `Default/`, so an environment without this extension
 * is untouched. A missing directory is a normal outcome, not an error.
 */
export const EXTENSION_PROFILE_DATA_DIRECTORIES = [
  // chrome.storage.local / .sync and extension-scoped preferences. `Local Extension Settings` is the
  // modern name; `Extension State` is the legacy store that older builds still consult.
  "Local Extension Settings",
  "Sync Extension Settings",
  "Managed Extension Settings",
  "Extension State",
  "Extension Rules",
  "Extension Scripts",
  "Extension Activity",
  // cookies, database, cachestrorage and sessionStorage all resolve to per-origin storage under these.
  "Local Storage/leveldb",
  "Session Storage",
  "Sync Data/LevelDB",
  "WebStorage",
  "blob_storage",
] as const;

/** IndexedDB and cache entries are named `chrome-extension_<id>_<partition>` rather than kept in a subdirectory. */
const EXTENSION_ORIGIN_DIRECTORY_PREFIXES = {
  "IndexedDB": (id: string) => `chrome-extension_${id}_`,
  "Service Worker/CacheStorage": (id: string) => `chrome-extension_${id}_`,
} as const;

export type ExtensionProfileDataRemoval = {
  environmentId: string;
  /** Relative paths actually removed, for the operator-facing report. */
  removed: string[];
  /** Reasons a path was skipped; a held environment is the only expected one. */
  skipped: string[];
};

export class ExtensionProfileDataService {
  constructor(private readonly options: { browserDataDir: string }) {}

  /**
   * Deletes every profile-side trace of `browserExtensionId` in the given environments.
   *
   * `holdingRuntime` is the session service's file-safety probe. A running browser keeps leveldb locked
   * and caches in memory, so a partially deleted store is worse than a retained one: such environments
   * are reported as skipped and the caller can retry after a stop.
   */
  async removeExtensionData(
    browserExtensionId: string,
    environmentIds: readonly string[],
    holdingRuntime: ReadonlySet<string> = new Set(),
  ): Promise<ExtensionProfileDataRemoval[]> {
    const results: ExtensionProfileDataRemoval[] = [];
    for (const environmentId of environmentIds) {
      const result: ExtensionProfileDataRemoval = { environmentId, removed: [], skipped: [] };
      results.push(result);
      if (holdingRuntime.has(environmentId)) {
        result.skipped.push("环境正在运行，停止后才会清理扩展数据");
        continue;
      }
      const defaultDir = path.join(this.options.browserDataDir, assertDirectChildName(environmentId), "Default");
      await this.removeKeyedDirectories(defaultDir, browserExtensionId, result);
      await this.removeOriginDirectories(defaultDir, browserExtensionId, result);
      await this.removePreferencesEntry(defaultDir, browserExtensionId, result);
    }
    return results;
  }

  private async removeKeyedDirectories(
    defaultDir: string,
    browserExtensionId: string,
    result: ExtensionProfileDataRemoval,
  ): Promise<void> {
    for (const relative of EXTENSION_PROFILE_DATA_DIRECTORIES) {
      const target = path.join(defaultDir, ...relative.split("/"), browserExtensionId);
      if (await removeDirectoryIfPresent(target)) result.removed.push(path.relative(defaultDir, target));
    }
  }

  private async removeOriginDirectories(
    defaultDir: string,
    browserExtensionId: string,
    result: ExtensionProfileDataRemoval,
  ): Promise<void> {
    for (const [relative, prefixFor] of Object.entries(EXTENSION_ORIGIN_DIRECTORY_PREFIXES)) {
      const container = path.join(defaultDir, ...relative.split("/"));
      const entries = await fs.readdir(container).catch(() => undefined);
      if (!entries) continue;
      const prefix = prefixFor(browserExtensionId);
      for (const entry of entries) {
        // `_0`, `_1`, ... are storage partitions; all of them belong to this extension.
        if (!entry.startsWith(prefix)) continue;
        const target = path.join(container, entry);
        if (await removeDirectoryIfPresent(target)) result.removed.push(path.relative(defaultDir, target));
      }
    }
  }

  /**
   * The registry entry itself lives in "Secure Preferences" (and mirrored in "Preferences" in some
   * builds). Leaving it behind means Chromium still shows the extension as previously installed and can
   * resurrect its settings on the next load; removing the key is what makes the reinstall a fresh one.
   */
  private async removePreferencesEntry(
    defaultDir: string,
    browserExtensionId: string,
    result: ExtensionProfileDataRemoval,
  ): Promise<void> {
    for (const fileName of ["Secure Preferences", "Preferences"]) {
      const filePath = path.join(defaultDir, fileName);
      const raw = await fs.readFile(filePath, "utf8").catch(() => undefined);
      if (raw === undefined) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.replace(/^﻿/, ""));
      } catch {
        result.skipped.push(`${fileName} 无法解析，未改动`);
        continue;
      }
      const settings = extensionSettingsRecord(parsed);
      if (!settings || !Object.hasOwn(settings, browserExtensionId)) continue;
      delete settings[browserExtensionId];
      await fs.writeFile(filePath, JSON.stringify(parsed), "utf8");
      result.removed.push(fileName);
    }
  }
}

function extensionSettingsRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const extensions = (value as { extensions?: unknown }).extensions;
  if (!extensions || typeof extensions !== "object" || Array.isArray(extensions)) return undefined;
  const settings = (extensions as { settings?: unknown }).settings;
  return settings && typeof settings === "object" && !Array.isArray(settings)
    ? settings as Record<string, unknown>
    : undefined;
}

async function removeDirectoryIfPresent(target: string): Promise<boolean> {
  const stats = await fs.lstat(target).catch(() => undefined);
  if (!stats) return false;
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    // Never follow a link out of the profile; remove only the unexpected entry itself.
    await fs.rm(target, { force: true }).catch(() => undefined);
    return true;
  }
  await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  return true;
}

function assertDirectChildName(value: string): string {
  const clean = value.trim();
  if (!clean || clean === "." || clean === ".." || clean !== path.basename(clean)) {
    throw Object.assign(new Error(`Invalid environment id: ${value}`), { status: 400 });
  }
  return clean;
}
