import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile, type BrowserProfile } from "../../shared/profile";
import { TooltipProvider } from "../ui/tooltip";
import { ProfileEditorRuntimeTab } from "./ProfileEditorRuntimeTab";

// The identity read-out names its source instead of offering an editable seed: "empty means random"
// and "empty means the file" are exactly what the old input box could not express. It lives at the
// foot of the tab column, so the runtime tab renders no seed field at all.
test("the identity is a read-out that names its source, never an input", () => {
  const ephemeral = renderTab(defaultProfile({ mode: "ephemeral" }));
  assert.equal(/placeholder="42069"/.test(ephemeral), false, "the sample seed placeholder is gone");
  assert.equal(ephemeral.includes(t("form.seed")), false, "the runtime tab no longer carries the seed");
  assert.equal(ephemeral.includes(t("form.identitySource.ephemeral-random")), false);
});

// Viewport, color scheme and watermark all describe the window this launch opens, so they moved into
// the launch section instead of two sections that each held one or two rows.
test("the launch section carries viewport, color mode and watermark", () => {
  const html = renderTab(defaultProfile());
  const sections = [...html.matchAll(/<section class="form-section wide">([\s\S]*?)<\/section>/g)].map((match) => match[1]);
  const runtimeSection = sections.find((section) => section.includes(t("editor.section.runtime"))) ?? "";
  for (const label of ["form.viewportMode", "form.colorMode", "form.watermark", "table.startUrl", "table.mode"] as const) {
    assert.ok(runtimeSection.includes(t(label)), label);
  }
  // The sections those controls used to live under are gone.
  assert.equal(html.includes("屏幕与视口"), false);
  assert.equal(html.includes("指纹联动与行为"), false);
});

// The size only exists in fixed mode: native passes no viewport at all, so the default profile (native)
// shows no size pair and a fixed one does.
test("the window size only exists in fixed viewport mode", () => {
  const native = renderTab(defaultProfile());
  assert.equal(native.includes(t("form.windowSize")), false);
  const fixed = renderTab(defaultProfile({
    viewport: { ...defaultProfile().viewport, mode: "fixed" },
  }));
  assert.match(fixed, new RegExp(escapeRegExp(t("form.windowSize"))));
});

// Preset cards share one shape: the badge is a corner label outside the title/body stack, and the
// summary has its own class, so a card with a longer summary grows the row instead of pushing its
// title down relative to its neighbour.
test("preset cards put the badge in the corner and keep the summary in its own slot", () => {
  const html = renderTab(defaultProfile());
  const cards = [...html.matchAll(/<button class="preset-button"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]);
  assert.equal(cards.length, 4);
  for (const card of cards) {
    assert.match(card, /^<span class="preset-badge">/);
    assert.match(card, /<strong>[^<]+<\/strong><span class="preset-summary">/);
  }
});

// An unsaved draft cannot bind, so the library is shown under one mask carrying the reason. The manual
// path list that used to sit beside it is gone: every extension directory comes from the library.
test("an unsaved draft masks the extension library", () => {
  const fresh = renderTab(defaultProfile(), { draftIsNew: true });
  const surface = fresh.match(/<div class="extension-surface wide">([\s\S]*?)<\/div><\/div>/)?.[1] ?? "";
  assert.ok(surface.includes("extension-binding-panel"), "the library sits inside the masked surface");
  assert.equal(surface.includes("manual-paths-panel"), false, "the manual path list is gone");
  assert.match(surface, /class="extension-surface-content" inert=""/);
  assert.match(surface, /class="extension-surface-mask"[^>]*>[^<]*先保存环境/);

  const saved = renderTab(defaultProfile(), { draftIsNew: false });
  assert.equal(saved.includes("extension-surface-mask"), false);
  assert.equal(saved.includes("inert"), false);
});

function renderTab(draft: BrowserProfile, overrides: {
  draftIsNew?: boolean;
} = {}): string {
  return renderToStaticMarkup(
    React.createElement(
      // main.tsx wraps the whole app in one, and the Field help tips are Radix tooltips, which throw
      // "must be used within TooltipProvider" under renderToStaticMarkup exactly as in the browser.
      TooltipProvider,
      null,
      React.createElement(ProfileEditorRuntimeTab, {
        boundExtensionIds: [],
        busy: "",
        draft,
        draftIsNew: overrides.draftIsNew ?? false,
        extensions: [],
        groups: [],
        nameError: "",
        setDraft: () => undefined,
        setDraftExtensionBinding: async () => undefined,
        tags: [],
        t,
      }),
    ),
  );
}

/** zh-CN is statically imported, so translate resolves synchronously and the assertions read as user-visible text. */
function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
