import assert from "node:assert/strict";
import test from "node:test";

import { BROWSER_CORE_LINKS, openBrowserCoreLink, type BrowserCoreLink } from "./browserCoreExternalNavigation";

test("core links open a protected web tab or the system browser through the desktop command", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  const webCalls: unknown[][] = [];
  const desktopCalls: unknown[][] = [];
  try {
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    Object.defineProperty(globalThis, "window", { configurable: true, value: {
      open: (...args: unknown[]) => { webCalls.push(args); return null; },
      __TAURI_INTERNALS__: { invoke: async (...args: unknown[]) => { desktopCalls.push(args); } },
    } });
    for (const link of Object.keys(BROWSER_CORE_LINKS) as BrowserCoreLink[]) await openBrowserCoreLink(link);
    assert.deepEqual(webCalls, Object.values(BROWSER_CORE_LINKS).map((url) => [url, "_blank", "noopener,noreferrer"]));

    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    for (const link of Object.keys(BROWSER_CORE_LINKS) as BrowserCoreLink[]) await openBrowserCoreLink(link);
    assert.deepEqual(desktopCalls, Object.keys(BROWSER_CORE_LINKS).map((link) => ["cbpanel_open_browser_core_link", { link }, undefined]));
    assert.equal(webCalls.length, 2);
    await assert.rejects(openBrowserCoreLink("https://example.com" as BrowserCoreLink), /Unsupported/);
    await assert.rejects(openBrowserCoreLink("toString" as BrowserCoreLink), /Unsupported/);
    assert.equal(desktopCalls.length, 2);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});
