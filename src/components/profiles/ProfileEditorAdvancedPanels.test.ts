import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile, setRuntimeQuickArg } from "../../shared/profile";
import { TooltipProvider } from "../ui/tooltip";
import { ExtensionBindingPanel } from "./ProfileEditorAdvancedPanels";

// The identity read-out moved to the launch tab, and the manual path list is gone (directories come from
// the extension library alone), so this file covers the one panel that remains: the extension library.
test("extension binding explains an ephemeral profile instead of failing at launch", () => {
  const ephemeral = renderExtensions(defaultProfile({ mode: "ephemeral" }));
  assert.ok(ephemeral.includes(t("editor.extensionNeedsPersistentMode")));

  const persistent = renderExtensions(defaultProfile({ mode: "persistent" }));
  assert.equal(persistent.includes(t("editor.extensionNeedsPersistentMode")), false);
});

// An unsaved draft cannot bind, and the reason rides on a mask over the whole extension surface — the
// library and the manual path list together, since both are "extensions" to an operator. The panel
// itself no longer owns that mask: it is one frame, drawn by the runtime tab around both halves.
test("the library panel carries no mask of its own and no notice bar", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ExtensionBindingPanel, {
        boundExtensionIds: [],
        busy: "",
        draft: defaultProfile(),
        draftIsNew: true,
        extensions: [],
        setDraftExtensionBinding: async () => undefined,
        t,
      }),
    ),
  );
  assert.equal(html.includes("extension-surface-mask"), false);
  assert.equal(html.includes("extension-binding-mask"), false);
  assert.doesNotMatch(html, /<div class="preflight-empty">[^<]*先保存环境/);
});

// Kept as a guard: the quick-arg flags are what the fingerprint tab and the proxy row depend on, so a
// change that drops one from the profile should fail here rather than at launch.
test("quick args still write their flags onto the profile", () => {
  const enabled = setRuntimeQuickArg(defaultProfile(), "fingerprint-off", true);
  assert.ok(enabled.runtime.extraArgs.includes("--fingerprint=off"));
});

function renderExtensions(draft: ReturnType<typeof defaultProfile>): string {
  return renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(ExtensionBindingPanel, {
        boundExtensionIds: [],
        busy: "",
        draft,
        draftIsNew: false,
        extensions: [],
        setDraftExtensionBinding: async () => undefined,
        t,
      }),
    ),
  );
}

/** zh-CN is statically imported, so translate resolves synchronously and the assertions read as user-visible text. */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}
