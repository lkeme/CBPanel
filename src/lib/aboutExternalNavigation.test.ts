import assert from "node:assert/strict";
import test from "node:test";

import { ABOUT_LINKS, openAboutLink, openDataDirectory, type AboutLink } from "./aboutExternalNavigation";

test("about links open a protected tab or the system browser through the desktop command", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  const webCalls: unknown[][] = [];
  const desktopCalls: unknown[][] = [];
  try {
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        open: (...args: unknown[]) => {
          webCalls.push(args);
          return null;
        },
        __TAURI_INTERNALS__: {
          invoke: async (...args: unknown[]) => {
            desktopCalls.push(args);
          },
        },
      },
    });
    for (const link of Object.keys(ABOUT_LINKS) as AboutLink[]) await openAboutLink(link);
    assert.deepEqual(webCalls, Object.values(ABOUT_LINKS).map((url) => [url, "_blank", "noopener,noreferrer"]));

    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    for (const link of Object.keys(ABOUT_LINKS) as AboutLink[]) await openAboutLink(link);
    assert.deepEqual(desktopCalls, Object.keys(ABOUT_LINKS).map((link) => ["cbpanel_open_about_link", { link }, undefined]));
    assert.equal(webCalls.length, Object.keys(ABOUT_LINKS).length);
    await assert.rejects(openAboutLink("https://example.com" as AboutLink), /Unsupported/);
    await assert.rejects(openAboutLink("toString" as AboutLink), /Unsupported/);
    assert.equal(desktopCalls.length, Object.keys(ABOUT_LINKS).length);
  } finally {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
    if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
  }
});

test("revealing the data directory is a desktop-only capability and refuses an empty path", async () => {
  const originalTauri = Object.getOwnPropertyDescriptor(globalThis, "isTauri");
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const calls: unknown[][] = [];
  try {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { __TAURI_INTERNALS__: { invoke: async (...args: unknown[]) => { calls.push(args); } } },
    });
    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: true });
    await openDataDirectory("  D:/data  ");
    assert.deepEqual(calls, [["cbpanel_open_directory", { path: "D:/data" }, undefined]]);

    await openDataDirectory(undefined);
    await openDataDirectory("   ");
    assert.equal(calls.length, 1);

    Object.defineProperty(globalThis, "isTauri", { configurable: true, value: false });
    await openDataDirectory("D:/data");
    assert.equal(calls.length, 1);
  } finally {
    if (originalTauri) Object.defineProperty(globalThis, "isTauri", originalTauri);
    else Reflect.deleteProperty(globalThis, "isTauri");
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
