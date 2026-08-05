import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathExists } from "./archiveUtils";

type EnvironmentDataServiceOptions = {
  browserDataDir: string;
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
      const directory = this.resolveEnvironmentDir(id);
      if (!directory) {
        warnings.push(`Refused to remove browser data for an unusable environment id: ${id}`);
        continue;
      }
      // An environment that was never launched has no directory, and reporting it as removed would
      // inflate the count the caller shows. `force` below still covers the directory disappearing
      // between this check and the rm.
      if (!(await pathExists(directory))) continue;
      // Per id, so one failure never aborts the rest, and never throws: on Windows a browser process
      // still holding handles under its profile answers EPERM/EBUSY, and that must not turn an already
      // committed permanent delete into a 5xx.
      try {
        await fs.rm(directory, { recursive: true, force: true });
        removed.push(id);
      } catch (error) {
        warnings.push(`Failed to remove browser data for ${id}: ${(error as Error).message}`);
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
    // No directory means nothing has ever been launched, which is not something to report as a failure.
    if (!(await pathExists(this.options.browserDataDir))) return { removed: [], warnings: [] };
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.options.browserDataDir, { withFileTypes: true });
    } catch (error) {
      return { removed: [], warnings: [`Failed to read browser data directory: ${(error as Error).message}`] };
    }
    const known = new Set(await readKnownIds());
    // Only directories are environment data. Loose files next to them belong to whatever wrote them,
    // and deleting a file because no environment is named after it would be pure guesswork.
    const orphans = entries
      .filter((entry) => entry.isDirectory() && !known.has(entry.name))
      .map((entry) => entry.name);
    return this.removeEnvironmentData(orphans);
  }

  /**
   * Environment ids reach the delete routes as request parameters, and the rm this feeds is recursive, so
   * anything that is not a plain direct child name (empty, `..`, a nested or absolute path) is rejected
   * rather than resolved into a target.
   */
  private resolveEnvironmentDir(id: string): string | undefined {
    const name = id.trim();
    if (!name || name === "." || name === ".." || name !== path.basename(name)) return undefined;
    return path.join(this.options.browserDataDir, name);
  }
}
