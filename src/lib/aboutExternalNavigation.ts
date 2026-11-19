import { invoke, isTauri } from "@tauri-apps/api/core";

import { appUpdateAssetUrl } from "../shared/appUpdate";

/**
 * The About page's outbound links. Only these exact destinations may cross the shell's
 * browser-opening capability; the Rust side keeps the same list, so a webview that supplies its own
 * URL is refused twice rather than once.
 */
export const ABOUT_LINKS = {
  repository: "https://github.com/lkeme/CBPanel",
  releases: "https://github.com/lkeme/CBPanel/releases",
  issues: "https://github.com/lkeme/CBPanel/issues",
  license: "https://github.com/lkeme/CBPanel/blob/master/LICENSE",
  upstream: "https://github.com/CloakHQ/CloakBrowser",
} as const;

export type AboutLink = keyof typeof ABOUT_LINKS;

export async function openAboutLink(link: AboutLink): Promise<void> {
  if (!Object.hasOwn(ABOUT_LINKS, link)) throw new Error("Unsupported about link.");
  if (isTauri()) {
    await invoke("cbpanel_open_about_link", { link });
    return;
  }
  window.open(ABOUT_LINKS[link], "_blank", "noopener,noreferrer");
}

/**
 * Opens one release asset of CBPanel's own update. Only the version and the file name cross the shell's
 * browser-opening capability; the URL is rebuilt on both sides from those two fields.
 */
export async function openAppUpdateAsset(version: string, fileName: string): Promise<void> {
  const url = appUpdateAssetUrl(version, fileName);
  if (!url) return;
  if (isTauri()) {
    await invoke("cbpanel_open_app_update_asset", { version, fileName });
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Reveals a directory the payload already reported. The path is never constructed here: the desktop
 * shell re-checks it and refuses anything that is not a directory, and the browser has no equivalent
 * capability, so the caller disables the control instead.
 */
export async function openDataDirectory(path: string | undefined): Promise<void> {
  const target = path?.trim();
  if (!target || !isTauri()) return;
  await invoke("cbpanel_open_directory", { path: target });
}

/**
 * Opens the sidecar's own HTTP endpoint.
 *
 * The two shells differ: the desktop build talks to a loopback sidecar on a random port, so the port
 * is handed to a shell command that rebuilds `http://127.0.0.1:<port>` itself — a webview-supplied
 * URL never reaches the browser opener. The web build has no sidecar and is served by that same
 * origin, so it opens the current origin instead.
 */
export async function openSidecarEndpoint(port: number | undefined): Promise<void> {
  if (isTauri()) {
    if (!port || port <= 0) return;
    await invoke("cbpanel_open_sidecar_endpoint", { port });
    return;
  }
  window.open(window.location.origin, "_blank", "noopener,noreferrer");
}
