import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile, type BrowserProfile } from "../../shared/profile";
import { TooltipProvider } from "../ui/tooltip";
import { ProfileEditorIdentityPanel } from "./ProfileEditorIdentityPanel";

// "Empty means random" and "empty means the file" are exactly what an editable input could not
// express, so the identity is a read-out and never an input.
test("the identity is a read-out, never an input", () => {
  const ephemeral = renderPanel(defaultProfile({ mode: "ephemeral" }));
  assert.match(ephemeral, new RegExp(escapeRegExp(t("form.identitySource.ephemeral-random"))));
  assert.equal(/placeholder="42069"/.test(ephemeral), false, "the sample seed placeholder is gone");
  assert.equal(/<input/.test(ephemeral), false, "the seed is never editable");

  const persistent = renderPanel(defaultProfile({ mode: "persistent" }));
  // The wrapper's own seed file is the default state, and the value already reads "Automatic", so the
  // caption that used to spell out the file and its first-launch generation is gone; only the help
  // tooltip still explains where the identity comes from.
  assert.match(persistent, new RegExp(escapeRegExp(t("form.identityValue.persistent-file"))));
  assert.equal(/<small class="editor-identity-source">/.test(persistent), false);
  assert.equal(persistent.includes("自动维护"), false);

  const fromArgs = renderPanel(defaultProfile({
    runtime: { ...defaultProfile().runtime, extraArgs: ["--fingerprint=12345"] },
  }));
  assert.match(fromArgs, /<code[^>]*>12345<\/code>/);
  assert.match(fromArgs, new RegExp(escapeRegExp(t("form.identitySource.arg"))));
  // An explicit arg wins over a stored seed, exactly as it does at launch.
  const both = renderPanel(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, seed: "42069" },
    runtime: { ...defaultProfile().runtime, extraArgs: ["--fingerprint=12345"] },
  }));
  assert.match(both, /<code[^>]*>12345<\/code>/);
  assert.equal(both.includes(">42069</code>"), false);

  // Pass-through outranks a stored seed: the binary strips it, so no file applies.
  const passthrough = renderPanel(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, seed: "42069" },
    runtime: { ...defaultProfile().runtime, extraArgs: ["--fingerprint=off"] },
  }));
  assert.match(passthrough, /<code[^>]*>--fingerprint=off<\/code>/);
  assert.match(passthrough, new RegExp(escapeRegExp(t("form.identitySource.passthrough"))));
  assert.equal(passthrough.includes(">42069</code>"), false);
});

// A stored seed is the one state whose value is also the way out of itself: the button shows the seed
// id at rest and the "use the automatic identity" action on hover/focus, both in the same cell, so
// nothing reflows when the pointer lands. The caption that used to say "fixed seed" is gone — it only
// restated the value.
test("a stored seed is a button that swaps its label on hover", () => {
  const stored = renderPanel(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, seed: "42069" },
  }));

  assert.match(stored, /<button[^>]*class="editor-identity-value editor-identity-button"[^>]*>/);
  assert.match(stored, /<span class="editor-identity-idle">42069<\/span>/);
  assert.match(stored, new RegExp(`<span class="editor-identity-hover">${escapeRegExp(t("form.identityUseAutomatic"))}</span>`));
  assert.match(stored, new RegExp(`title="${escapeRegExp(t("form.identityUseAutomatic"))}"`));
  // The caption element is gone; the phrase survives only inside the help tooltip's own explanation.
  assert.equal(/<small class="editor-identity-source">/.test(stored), false, "the source caption is gone");
  assert.equal(/<small class="editor-identity-source">固定 seed<\/small>/.test(stored), false);
  // The seed is not also rendered as a read-out code element.
  assert.equal(/<code[^>]*>42069<\/code>/.test(stored), false);
});

// Every other source is a plain read-out: there is nothing here to clear, and rendering it as a button
// would promise an action the launch does not have.
test("only a stored seed renders as an action", () => {
  const cases: Array<BrowserProfile> = [
    defaultProfile({ mode: "ephemeral" }),
    defaultProfile(),
    defaultProfile({ runtime: { ...defaultProfile().runtime, extraArgs: ["--fingerprint=12345"] } }),
    defaultProfile({ runtime: { ...defaultProfile().runtime, extraArgs: ["--fingerprint=off"] } }),
  ];
  for (const draft of cases) {
    assert.equal(renderPanel(draft).includes("editor-identity-button"), false);
  }
});

// The two identity actions act on different sources — a stored field versus the seed file — so they
// never appear together, and the reset appears only where a file exists to delete.
test("the identity read-out offers one action for the source it is showing", () => {
  const stored = renderPanel(defaultProfile({
    fingerprint: { ...defaultProfile().fingerprint, seed: "42069" },
  }), { rotateIdentity: () => undefined });
  assert.match(stored, new RegExp(escapeRegExp(t("form.identityUseAutomatic"))));
  assert.equal(stored.includes(t("form.rotateIdentityAction")), false);

  const rotate = () => undefined;
  const render = (draft: BrowserProfile, draftIsNew = false) =>
    renderPanel(draft, { draftIsNew, rotateIdentity: rotate });

  // Persistent + saved: the only state where a seed file exists to delete.
  assert.match(render(defaultProfile({ mode: "persistent" })), new RegExp(escapeRegExp(t("form.rotateIdentityAction"))));
  // Ephemeral gets a new identity on every launch, so there is nothing to rotate.
  assert.doesNotMatch(render(defaultProfile({ mode: "ephemeral" })), new RegExp(escapeRegExp(t("form.rotateIdentityAction"))));
  // A draft that was never saved has no user data dir yet.
  assert.doesNotMatch(render(defaultProfile({ mode: "persistent" }), true), new RegExp(escapeRegExp(t("form.rotateIdentityAction"))));
});

// A live session may still hold the seed file, and the server refuses then: the control says so up front.
test("the reset action is disabled while a session runs", () => {
  const html = renderPanel(defaultProfile({ mode: "persistent" }), {
    identityRotationBlocked: true,
    rotateIdentity: () => undefined,
  });
  assert.match(html, new RegExp(escapeRegExp(t("form.rotateIdentityBlocked"))));
  const rotateButton = html.match(new RegExp(`<button[^>]*>[^<]*${escapeRegExp(t("form.rotateIdentityAction"))}`))?.[0] ?? "";
  assert.ok(rotateButton.includes("disabled"), "the rotate action is disabled while a session runs");
});

function renderPanel(draft: BrowserProfile, overrides: {
  draftIsNew?: boolean;
  identityRotationBlocked?: boolean;
  rotateIdentity?: () => void;
} = {}): string {
  return renderToStaticMarkup(
    React.createElement(
      // main.tsx wraps the whole app in one, and the help tip is a Radix tooltip, which throws
      // "must be used within TooltipProvider" under renderToStaticMarkup exactly as in the browser.
      TooltipProvider,
      null,
      React.createElement(ProfileEditorIdentityPanel, {
        draft,
        draftIsNew: overrides.draftIsNew ?? false,
        identityRotationBlocked: overrides.identityRotationBlocked ?? false,
        rotateIdentity: overrides.rotateIdentity,
        setDraft: () => undefined,
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
