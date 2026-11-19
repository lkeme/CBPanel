import type { BrowserCoreChannel } from "../../shared/settings";

/**
 * Where the gesture last left the card. This is a view preference, not a setting: it changes nothing
 * that runs, so it is kept in the webview's own storage rather than in settings the server owns.
 */
const CORE_CARD_STORAGE_KEY = "cbpanel.browserCoreCard";

/**
 * Which card to show when the panel mounts. A stored choice survives closing and reopening the
 * settings drawer, but it can never reveal the private card before that card has been unlocked, and a
 * value that is not a channel is no choice at all.
 */
export function resolveCoreCard(
  stored: unknown,
  input: { unlocked: boolean; activeChannel: BrowserCoreChannel },
): BrowserCoreChannel {
  if (stored === "private" && input.unlocked) return "private";
  if (stored === "official") return "official";
  return input.activeChannel;
}

export function readStoredCoreCard(): string | undefined {
  try {
    if (typeof window === "undefined" || !window.localStorage) return undefined;
    return window.localStorage.getItem(CORE_CARD_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storeCoreCard(channel: BrowserCoreChannel): void {
  try {
    if (typeof window === "undefined" || !window.localStorage) return;
    window.localStorage.setItem(CORE_CARD_STORAGE_KEY, channel);
  } catch {
    // A preference that cannot be stored is still a preference; the next mount falls back to the
    // running channel, which is exactly what it would show without one.
  }
}
