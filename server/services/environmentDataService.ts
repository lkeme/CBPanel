import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathExists } from "./archiveUtils";

type EnvironmentDataServiceOptions = {
  browserDataDir: string;
  extensionRuntimeDir?: string;
};

export type EnvironmentDataCleanupResult = {
  removed: string[];
  warnings: string[];
};

/**
 * Owns the `browser-data/<environment.id>` half of environment deletion, which the repository cannot:
 * it is a pure DB layer and its contract carries no filesystem paths. Callers must delete the rows
 * first and only then call in here — an rm that fails afterwards leaves a recoverable orphan directory,
 * whereas the reverse order would leave an environment whose data silently disappeared.
 */
export class EnvironmentDataService {
  constructor(private readonly options: EnvironmentDataServiceOptions) {}

  /**
   * `holdingRuntime` names the ids whose directories a browser process may still have open — the answer
   * `SessionService.profileIdsHoldingRuntime` gives, which counts a session whose close was never
   * confirmed. They are skipped rather than attempted, and reported as warnings so the caller can say the
   * space is still there; they stay reclaimable through the browser-data prune once the process is gone.
   *
   * Skipping is for the sweeps that clean up after something else (emptying the trash removes many rows,
   * one of which may be held). A caller acting on the single id a user pointed at must refuse instead, and
   * that refusal belongs at the route: the same split `binaryService` makes between `clearCache`, which
   * rejects over a running session, and `pruneToSingleBuild`, which silently defers.
   */
  async removeEnvironmentData(ids: string[], holdingRuntime: ReadonlySet<string> = new Set()): Promise<EnvironmentDataCleanupResult> {
    const removed: string[] = [];
    const warnings: string[] = [];
    for (const id of ids) {
      if (holdingRuntime.has(id)) {
        warnings.push(`Kept browser data for ${id}: a browser process may still be holding it.`);
        continue;
      }
      const directories = this.resolveEnvironmentDirs(id);
      if (!directories) {
        warnings.push(`Refused to remove browser data for an unusable environment id: ${id}`);
        continue;
      }
      // An environment that was never launched has no directory, and reporting it as removed would
      // inflate the count the caller shows. `force` below still covers the directory disappearing
      // between this check and the rm.
      const [browserDirectory, runtimeDirectory] = directories;
      // `removed` is an established API count for browser-data only. Runtime copies are derivative and
      // cleaned independently so a runtime-only orphan cannot inflate that count, and a failure on one
      // side never hides a successful removal on the other.
      if (await pathExists(browserDirectory!)) {
        try {
          await this.removeDirectory(browserDirectory!);
          removed.push(id);
        } catch (error) {
          warnings.push(`Failed to remove browser data for ${id}: ${(error as Error).message}`);
        }
      }
      if (runtimeDirectory && await pathExists(runtimeDirectory)) {
        try {
          await this.removeDirectory(runtimeDirectory);
        } catch (error) {
          warnings.push(`Failed to remove extension runtime data for ${id}: ${(error as Error).message}`);
        }
      }
    }
    return { removed, warnings };
  }

  /**
   * `readKnownIds` is a resolver rather than a ready-made set because the order of the two reads decides
   * whether a live environment can lose its data: an environment registered after the ids were read is
   * missing from the known set while the directory listing that follows already sees its brand new data
   * directory — which is exactly the shape of an orphan. Listing the directories first closes the window
   * from both sides. A directory created after the listing is not a candidate at all, and an environment
   * registered after the listing is still in the ids read afterwards.
   */
  async pruneOrphanEnvironmentData(readKnownIds: () => Promise<Iterable<string>>): Promise<EnvironmentDataCleanupResult> {
    const roots = [this.options.browserDataDir, ...(this.options.extensionRuntimeDir ? [this.options.extensionRuntimeDir] : [])];
    const rootReads = await Promise.all(roots.map(async (root) => {
      if (!(await pathExists(root))) return [] as Dirent[];
      try {
        return await fs.readdir(root, { withFileTypes: true });
      } catch (error) {
        return error as Error;
      }
    }));
    const readWarnings = rootReads
      .filter((result): result is Error => result instanceof Error)
      .map((error) => `Failed to read environment data directory: ${error.message}`);
    const entriesByRoot = rootReads.filter((result): result is Dirent[] => Array.isArray(result));
    if (entriesByRoot.length === 0) return { removed: [], warnings: readWarnings };
    if (entriesByRoot.every((entries) => entries.length === 0)) return { removed: [], warnings: readWarnings };
    const known = new Set(await readKnownIds());
    // Only directories are environment data. Loose files next to them belong to whatever wrote them,
    // and deleting a file because no environment is named after it would be pure guesswork.
    const orphans = [...new Set(entriesByRoot
      .flatMap((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)))]
      .filter((id) => !known.has(id));
    const cleanup = await this.removeEnvironmentData(orphans);
    return { removed: cleanup.removed, warnings: [...readWarnings, ...cleanup.warnings] };
  }

  /**
   * Environment ids reach the delete routes as request parameters, and the rm this feeds is recursive, so
   * anything that is not a plain direct child name (empty, `..`, a nested or absolute path) is rejected
   * rather than resolved into a target.
   */
  private resolveEnvironmentDirs(id: string): string[] | undefined {
    const name = id.trim();
    if (!name || name === "." || name === ".." || name !== path.basename(name)) return undefined;
    return [
      path.join(this.options.browserDataDir, name),
      ...(this.options.extensionRuntimeDir ? [path.join(this.options.extensionRuntimeDir, name)] : []),
    ];
  }

  protected async removeDirectory(directory: string): Promise<void> {
    await fs.rm(directory, { recursive: true, force: true });
  }
}
