import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Drawer, Field, Segmented } from "./form-controls";

test("Drawer names itself by linking its heading, which no call site could supply", () => {
  const html = renderToStaticMarkup(
    React.createElement(Drawer, {
      title: "Column settings",
      close: () => undefined,
      t: () => "Close",
      children: React.createElement("p", null, "body"),
    }),
  );

  const dialogMatch = html.match(/<div class="drawer-layer"[^>]*>/);
  assert.ok(dialogMatch);
  const labelledBy = attributeValue(dialogMatch[0], "aria-labelledby");
  assert.ok(labelledBy, "role=dialog is name-from-author, so aria-labelledby must be present");
  assert.match(html, new RegExp(`<h2 id="${escapeRegExp(labelledBy)}">Column settings</h2>`));
});

test("Drawer close button carries an accessible name, not just a tooltip", () => {
  const html = renderToStaticMarkup(
    React.createElement(Drawer, {
      title: "Settings",
      close: () => undefined,
      t: () => "Close",
      children: null,
    }),
  );

  const headerButton = html.match(/<button class="icon-button"[^>]*>/);
  assert.ok(headerButton);
  assert.equal(attributeValue(headerButton[0], "aria-label"), "Close");
});

test("Field links a direct native control to its visible label", () => {
  const html = renderToStaticMarkup(
    React.createElement(Field, {
      label: "Name",
      children: React.createElement("input", { defaultValue: "" }),
    }),
  );

  const labelMatch = html.match(/<label[^>]*>Name<\/label>/);
  assert.ok(labelMatch);
  const labelId = attributeValue(labelMatch[0], "id");
  const controlId = attributeValue(labelMatch[0], "for");
  assert.ok(labelId);
  assert.ok(controlId);
  assert.match(html, new RegExp(`<input[^>]*id="${escapeRegExp(controlId)}"`));
  assert.match(html, new RegExp(`<input[^>]*aria-labelledby="${escapeRegExp(labelId)}"`));
});

test("Field does not wrap composite button controls in a native label", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      Field,
      {
        label: "Mode",
        children: React.createElement(Segmented, {
          value: "free",
          options: [
            { value: "free", label: "Free" },
            { value: "pro", label: "Pro" },
          ],
          onChange: () => undefined,
        }),
      },
    ),
  );

  assert.doesNotMatch(html, /<label[\s\S]*<button/);
  assert.match(html, /<span id="[^"]+">Mode<\/span>/);
  assert.match(html, /<button aria-pressed="true"/);
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function attributeValue(html: string, attribute: string): string {
  return html.match(new RegExp(`${attribute}="([^"]*)"`))?.[1] ?? "";
}
