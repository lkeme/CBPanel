import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RegistryListShell } from "./RegistryModuleShell";

type Row = { name: string };

const searchInput = /<input\b/;

test("an empty list renders one centred empty panel instead of a stranded card", () => {
  const html = renderList({ items: [] });

  assert.ok(html.includes("module-surface-body is-empty"));
  assert.ok(html.includes("empty-panel"));
  assert.ok(html.includes("empty.title"));
  assert.ok(html.includes("empty.body"));
  assert.equal(html.includes("module-list"), false, "an empty list must not render its list grid");
  assert.equal(html.includes("summary"), false);
  assert.equal(searchInput.test(html), false, "there is nothing to search yet, so the box stays out");
  assert.ok(html.includes("new"), "the create action stays reachable from the empty state");
  // The page header already names the view, so the card must not repeat the heading.
  assert.equal(html.includes("module-header"), false);
});

test("a populated list keeps its toolbar search and summary", () => {
  const html = renderList({ items: [{ name: "alpha" }] });

  assert.ok(html.includes("module-list"));
  assert.ok(html.includes("alpha"));
  assert.equal(html.includes("module-surface-body is-empty"), false);
  assert.equal(html.includes("empty-panel"), false);
  assert.equal(searchInput.test(html), true);
  assert.ok(html.includes("summary"));
});

test("a filtered list with no matches explains the filter and offers a reset", () => {
  const html = renderList({ items: [{ name: "alpha" }], query: "zzz" });

  assert.ok(html.includes("empty-panel"));
  assert.ok(html.includes("filter.title"));
  assert.ok(html.includes("filter.body"));
  assert.ok(html.includes("clear-but-done"), "the reset action lives in the empty panel");
  // The search box stays, so the query can be edited as well as cleared.
  assert.equal(searchInput.test(html), true);
  assert.ok(html.includes("module-surface-body is-empty"), "no visible rows means the panel owns the body");
  assert.equal(html.includes("alpha"), false);
});

test("a list with its own toolbar keeps search, rows and paging in one surface", () => {
  const html = renderToStaticMarkup(
    React.createElement(RegistryListShell<Row>, {
      action: React.createElement("button", { type: "button" }, "add"),
      emptyTitle: "empty.title",
      emptyBody: "empty.body",
      filterEmptyTitle: "filter.title",
      filterEmptyBody: "filter.body",
      filterResetLabel: "clear-but-done",
      haystack: (item: Row) => item.name,
      icon: null,
      items: [{ name: "alpha" }],
      listClassName: "proxy-table",
      listRole: "table",
      listToolbar: () =>
        React.createElement(
          "label",
          { className: "search-box registry-search" },
          React.createElement("input", { readOnly: true }),
        ),
      pagination: {
        pageSize: 10,
        pageSizeOptions: [10, 20],
        pageSizeLabel: "per page",
        onPageSizeChange: () => undefined,
        prevLabel: "prev",
        nextLabel: "next",
        indicator: (current, total) => `${current}/${total}`,
        range: (start, end, total) => `${start}-${end}/${total}`,
      },
      renderItem: (item: Row) => React.createElement("div", { key: item.name }, item.name),
      searchPlaceholder: "search",
      summaryText: () => "summary",
    }),
  );

  assert.ok(html.includes("registry-list-surface"), "the list, its toolbar and paging share one card");
  assert.ok(html.includes("module-surface is-flush"), "the list card is the only card around the table");
  assert.ok(html.includes("proxy-table"));
  assert.ok(html.includes("alpha"));
  assert.equal(html.match(/<input\b/g)?.length, 1, "the search lives inside the card, not the module toolbar");
  assert.ok(html.includes("pagination-size-options"), "the per-page control is part of the table footer");
  assert.ok(html.includes("1-1/1"));
});

function renderList({
  items,
  query,
}: {
  items: Row[];
  query?: string;
}): string {
  return renderToStaticMarkup(
    React.createElement(RegistryListShell<Row>, {
      action: React.createElement("button", { className: "command primary", type: "button" }, "new"),
      emptyTitle: "empty.title",
      emptyBody: "empty.body",
      filterEmptyTitle: "filter.title",
      filterEmptyBody: "filter.body",
      filterResetLabel: "clear-but-done",
      haystack: (item: Row) => item.name,
      icon: React.createElement("span", null, "icon"),
      items,
      listClassName: "module-list",
      renderItem: (item: Row) => React.createElement("div", { key: item.name }, item.name),
      searchPlaceholder: "search",
      summaryText: () => "summary",
      query,
      onQueryChange: () => undefined,
    }),
  );
}
