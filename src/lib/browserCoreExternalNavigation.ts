import { invoke, isTauri } from "@tauri-apps/api/core";

export const BROWSER_CORE_LINKS = {
  "free-key": "https://cloakbrowser.dev/free",
  configuration: "https://github.com/CloakHQ/CloakBrowser/tree/main#configuration",
} as const;

export type BrowserCoreLink = keyof typeof BROWSER_CORE_LINKS;

export async function openBrowserCoreLink(link: BrowserCoreLink): Promise<void> {
  if (!Object.hasOwn(BROWSER_CORE_LINKS, link)) throw new Error("Unsupported browser core link.");
  if (isTauri()) {
    await invoke("cbpanel_open_browser_core_link", { link });
    return;
  }
  window.open(BROWSER_CORE_LINKS[link], "_blank", "noopener,noreferrer");
}
