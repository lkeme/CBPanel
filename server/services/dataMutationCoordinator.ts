import { randomUUID } from "node:crypto";

export type DataMutationKind = "app-backup" | "environment-package" | "extension-cache-commit";

export interface DataMutationLease {
  readonly id: string;
  readonly kind: DataMutationKind;
  readonly released: boolean;
  runWithExtensions<T>(extensionIds: readonly string[], operation: () => Promise<T>): Promise<T>;
  release(): void;
}

export class DataMutationCoordinatorError extends Error {
  readonly status = 409;

  readonly code = "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS";

  constructor(message: string) {
    super(message);
    this.name = "DataMutationCoordinatorError";
  }
}

/**
 * Owns the cross-service publication boundary. `enter()` changes global state synchronously, before
 * callers can reach their first `await`; backup/package leases are exclusive, while extension-cache
 * leases may run in parallel and serialize only identical extension IDs in deterministic order.
 */
export class DataMutationCoordinator {
  private exclusive?: { id: string; kind: Exclude<DataMutationKind, "extension-cache-commit"> };

  private readonly extensionLeases = new Set<string>();

  private readonly extensionTails = new Map<string, Promise<void>>();

  enter(kind: DataMutationKind): DataMutationLease {
    if (kind === "extension-cache-commit") {
      if (this.exclusive) throw busyError(this.exclusive.kind);
    } else if (this.exclusive || this.extensionLeases.size > 0) {
      throw busyError(this.exclusive?.kind ?? "extension-cache-commit");
    }

    const id = randomUUID();
    if (kind === "extension-cache-commit") this.extensionLeases.add(id);
    else this.exclusive = { id, kind };

    let released = false;
    let extensionOperationStarted = false;
    let extensionOperationFinished = false;
    let releaseRequested = false;
    const release = (): void => {
      if (released) return;
      if (kind === "extension-cache-commit" && extensionOperationStarted && !extensionOperationFinished) {
        // Keep the global lease visible until a queued key acquisition/callback has
        // actually settled. A detached finally must not let backup/package publication
        // overlap a still-running extension mutation.
        releaseRequested = true;
        return;
      }
      released = true;
      if (kind === "extension-cache-commit") {
        this.extensionLeases.delete(id);
      } else if (this.exclusive?.id === id) {
        this.exclusive = undefined;
      }
    };

    return {
      id,
      kind,
      get released() {
        return released;
      },
      runWithExtensions: async <T>(extensionIds: readonly string[], operation: () => Promise<T>): Promise<T> => {
        if (kind !== "extension-cache-commit") {
          throw new TypeError("Only an extension-cache lease can acquire extension mutation keys.");
        }
        if (released) throw new TypeError("The data mutation lease has already been released.");
        if (extensionOperationStarted) throw new TypeError("Data mutation leases are non-reentrant.");
        extensionOperationStarted = true;
        let unlock: (() => void) | undefined;
        try {
          const keys = normalizeExtensionIds(extensionIds);
          unlock = await this.acquireExtensionKeys(keys);
          if (released) throw new TypeError("The data mutation lease was released while waiting for extension keys.");
          return await operation();
        } finally {
           extensionOperationFinished = true;
           unlock?.();
           if (releaseRequested && !released) {
             released = true;
             this.extensionLeases.delete(id);
           }
         }
      },
      release,
    };
  }

  activeReason(): DataMutationKind | undefined {
    return this.exclusive?.kind ?? (this.extensionLeases.size > 0 ? "extension-cache-commit" : undefined);
  }

  private async acquireExtensionKeys(keys: readonly string[]): Promise<() => void> {
    const releases: Array<() => void> = [];
    try {
      for (const key of keys) releases.push(await this.acquireExtensionKey(key));
    } catch (error) {
      for (const release of releases.reverse()) release();
      throw error;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const release of releases.reverse()) release();
    };
  }

  private async acquireExtensionKey(key: string): Promise<() => void> {
    const previous = this.extensionTails.get(key) ?? Promise.resolve();
    let openGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    const tail = previous.then(() => gate);
    this.extensionTails.set(key, tail);
    await previous;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      openGate?.();
      void tail.finally(() => {
        if (this.extensionTails.get(key) === tail) this.extensionTails.delete(key);
      });
    };
  }
}

function normalizeExtensionIds(values: readonly string[]): string[] {
  const ids = [...new Set(values.map((value) => value.trim()))].sort();
  if (ids.length === 0 || ids.some((value) => !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value))) {
    throw new TypeError("Extension mutation keys must be non-empty bounded strings.");
  }
  return ids;
}

function busyError(kind: DataMutationKind): DataMutationCoordinatorError {
  const label = kind === "app-backup"
    ? "an application backup or restore"
    : kind === "environment-package"
      ? "an environment package operation"
      : "an extension cache commit";
  return new DataMutationCoordinatorError(`Cannot start this data operation while ${label} is in progress.`);
}
