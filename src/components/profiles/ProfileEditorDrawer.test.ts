import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile } from "../../shared/profile";
import { TooltipProvider } from "../ui/tooltip";
import { ProfileEditorDrawer } from "./ProfileEditorDrawer";

test("the drawer renders disabled Stopping instead of Launch while Stop is pending", () => {
  const html = renderDrawer({ canStop: true, stopPending: true });

  assert.ok(html.includes(t("status.stopping")));
  assert.ok(html.includes("command danger loading"));
  assert.ok(html.includes("disabled"));
  assert.equal(html.includes("class=\"command success\""), false);
});

test("the drawer offers Stop for a locally pending launch before server state arrives", () => {
  const html = renderDrawer({ canStop: true, stopPending: false });

  assert.ok(html.includes(t("actions.stop")));
  assert.equal(html.includes("class=\"command success\""), false);
});

function renderDrawer(lifecycle: { canStop: boolean; stopPending: boolean }): string {
  const ignore = () => undefined;
  const props: Parameters<typeof ProfileEditorDrawer>[0] = {
    activeTab: "runtime",
    boundExtensionIds: [],
    browserCoreMissing: false,
    busy: "",
    canStop: lifecycle.canStop,
    checkPreflight: async () => undefined,
    checkProxy: async () => undefined,
    close: ignore,
    copyManagedProxyToLocal: ignore,
    deleteProfile: async () => undefined,
    draft: defaultProfile({ id: "profile-drawer-action-test", name: "Drawer Action Test" }),
    draftIsNew: false,
    duplicateProfile: async () => undefined,
    environments: [],
    extensions: [],
    groups: [],
    importConfigFromClipboard: async () => undefined,
    launchProfile: async () => undefined,
    localProxyDraftIds: new Set(),
    nameError: "",
    proxies: [],
    proxyCheck: "",
    proxyLibraryDraftIds: {},
    resolveProxyGeoip: async () => undefined,
    saveDraft: async () => null,
    saveDraftProxyToLibrary: async () => undefined,
    setActiveTab: ignore,
    setDraft: ignore,
    setDraftExtensionBinding: async () => undefined,
    setDraftProxyLibraryId: ignore,
    setDraftProxyLocal: ignore,
    shareConfigToClipboard: async () => undefined,
    stopPending: lifecycle.stopPending,
    stopProfile: async () => undefined,
    t,
    tags: [],
  };
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ProfileEditorDrawer, props),
    ),
  );
}

function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}
