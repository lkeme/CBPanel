import { useEffect, useState } from "react";

import { api } from "./apiClient";
import type { ExtensionIconAsset } from "../shared/entities";

type CachedIcon = { key: string; dataUrl: string | null };

/**
 * One cache slot per extension id, stamped with `id:updatedAt`, so a reinstall or update
 * naturally invalidates the entry without explicit cache busting while a long session cannot
 * accumulate superseded payloads. `dataUrl: null` means "no icon, do not ask again" and is
 * cached exactly like a hit.
 */
const iconCache = new Map<string, CachedIcon>();
const iconRequests = new Map<string, Promise<string | null>>();

function iconCacheKey(id: string, updatedAt: string): string {
  return `${id}:${updatedAt}`;
}

/** Returns the cached data URL, `null` when known-missing, or `undefined` when never fetched. */
export function peekExtensionIcon(id: string, updatedAt: string): string | null | undefined {
  const cached = iconCache.get(id);
  return cached && cached.key === iconCacheKey(id, updatedAt) ? cached.dataUrl : undefined;
}

export function loadExtensionIcon(id: string, updatedAt: string): Promise<string | null> {
  const cached = peekExtensionIcon(id, updatedAt);
  if (cached !== undefined) return Promise.resolve(cached);
  const key = iconCacheKey(id, updatedAt);
  const inflight = iconRequests.get(key);
  if (inflight) return inflight;

  const request = api<ExtensionIconAsset>(`/api/extensions/${id}/icon`)
    .then((asset) => (asset?.mime && asset?.data ? `data:${asset.mime};base64,${asset.data}` : null))
    .catch(() => null)
    .then((dataUrl) => {
      iconCache.set(id, { key, dataUrl });
      iconRequests.delete(key);
      return dataUrl;
    });
  iconRequests.set(key, request);
  return request;
}

/** Marks an icon as unusable after the browser failed to decode it, so the glyph stays. */
export function forgetExtensionIcon(id: string, updatedAt: string): void {
  iconCache.set(id, { key: iconCacheKey(id, updatedAt), dataUrl: null });
}

/**
 * Install states whose unpacked directory can carry a readable icon. Anything else would only trade a
 * request for a 404/400, so the hook skips the fetch for them.
 */
const ICON_LOADABLE_STATES = new Set(["installed", "update-available"]);

/**
 * The real manifest icon for one extension, cached per `id:updatedAt`.
 *
 * Shared by the registry list and the environment editor's bind list: both render the same row shape,
 * and keeping the hook here stops the editor from importing the registry module just for its icon.
 */
export function useExtensionIcon(extension: {
  id: string;
  installState: string;
  localPath?: string;
  updatedAt: string;
}): { src: string | null; onError: () => void } {
  const { id, installState, localPath, updatedAt } = extension;
  const [src, setSrc] = useState<string | null>(() => peekExtensionIcon(id, updatedAt) ?? null);

  useEffect(() => {
    const cached = peekExtensionIcon(id, updatedAt);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    if (!localPath || !ICON_LOADABLE_STATES.has(installState)) {
      setSrc(null);
      return;
    }
    // Keep the current icon on screen while revalidating: `updatedAt` also changes on a status or
    // policy write, and blanking to the glyph first makes the row flicker.
    let active = true;
    void loadExtensionIcon(id, updatedAt).then((value) => {
      if (active) setSrc(value);
    });
    return () => {
      active = false;
    };
  }, [id, installState, localPath, updatedAt]);

  return {
    src,
    onError: () => {
      forgetExtensionIcon(id, updatedAt);
      setSrc(null);
    },
  };
}
