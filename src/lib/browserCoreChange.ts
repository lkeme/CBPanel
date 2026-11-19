import type { BinaryInfo } from "../shared/browserCore";

export interface BrowserCoreRefreshEffects {
  refresh: Array<(signal: AbortSignal) => Promise<unknown>>;
  refreshTimeoutMs?: number;
  notifyRefreshFailure: () => void;
}

export interface BrowserCoreChangeEffects extends BrowserCoreRefreshEffects {
  previousInfo: BinaryInfo | null;
  info: BinaryInfo;
  restartRequested?: boolean;
  desktop: boolean;
  applyInfo: (info: BinaryInfo) => void;
  restartRuntime: () => Promise<unknown>;
  notifyWebRestart: () => void;
  notifyRestartFailure: () => void;
}

/** The mutation already succeeded. Ancillary refreshes must never reclassify it as a failure. */
export async function applyBrowserCoreChange(effects: BrowserCoreChangeEffects): Promise<void> {
  effects.applyInfo(effects.info);
  const changed = effects.previousInfo?.core?.channel !== effects.info.core?.channel
    || effects.previousInfo?.core?.channelMode !== effects.info.core?.channelMode;
  const restartNeeded = effects.restartRequested && (changed || effects.info.core?.restartRequired);

  if (restartNeeded && effects.desktop) {
    try {
      // A replacement desktop runtime bootstraps its state itself. Do not put network refreshes
      // in front of the restart: even a pending state request must not postpone the transition.
      await effects.restartRuntime();
      return;
    } catch {
      effects.notifyRestartFailure();
    }
  } else if (restartNeeded) {
    effects.notifyWebRestart();
  }

  await refreshBrowserCoreState(effects);
}

/** Refreshes only observe a committed mutation; errors and stalled requests cannot undo it. */
export async function refreshBrowserCoreState(effects: BrowserCoreRefreshEffects): Promise<void> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const refreshed = Promise.allSettled(effects.refresh.map((refresh) => Promise.resolve().then(() => refresh(controller.signal))));
  try {
    const failed = await Promise.race([
      refreshed.then((results) => results.some((result) => result.status === "rejected")),
      new Promise<boolean>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort(new Error("Browser core state refresh timed out."));
          resolve(true);
        }, effects.refreshTimeoutMs ?? 5_000);
      }),
    ]);
    if (failed) effects.notifyRefreshFailure();
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
