import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Field, Segmented } from "./form-controls";

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
