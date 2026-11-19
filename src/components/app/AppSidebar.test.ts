import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { TooltipProvider } from "../ui/tooltip";
import { AppSidebar } from "./AppSidebar";

const t = (key: TranslationKey, params?: Record<string, string | number>): string => translate("zh-CN", key, params);

function renderSidebar(options: { updateAvailable?: boolean; updateVersion?: string } = {}): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(AppSidebar, {
        browserCoreMissing: false,
        busy: "",
        createProfile: () => {},
        moduleStats: { groups: [], tags: [], proxies: [], extensions: [] },
        openAbout: () => {},
        openSettings: () => {},
        renderMark: (className: string) => React.createElement("span", { className }),
        setWorkbenchView: () => {},
        settingsActive: false,
        showProfileView: () => {},
        sidebarCollapsed: false,
        t,
        toggleSidebarMode: () => {},
        totalProfiles: 0,
        trashCount: 0,
        updateAvailable: options.updateAvailable ?? false,
        updateVersion: options.updateVersion,
        versions: { app: "1.0.10", wrapper: "0.7.0" },
        workbenchView: "profiles",
      }),
    ),
  );
}

test("the settings button carries no dot when no update is known", () => {
  const html = renderSidebar();

  assert.equal(html.includes("sidebar-utility-dot"), false);
  assert.ok(html.includes(`aria-label="${t("nav.settings")}"`));
});

test("an available update puts a decorative dot on the settings button and names the version", () => {
  const html = renderSidebar({ updateAvailable: true, updateVersion: "1.0.11" });

  assert.ok(html.includes("sidebar-utility-dot"));
  assert.match(html, /class="sidebar-utility-dot" aria-hidden="true"/);
  assert.ok(html.includes(t("about.update.available", { version: "1.0.11" })));
});
