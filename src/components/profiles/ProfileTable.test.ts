import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { translate, type TranslationKey } from "../../i18n";
import { defaultProfile, type SessionSummary } from "../../shared/profile";
import { DEFAULT_PROFILE_COLUMNS } from "../../shared/settings";
import { ProfileTable } from "./ProfileTable";

const PROFILE_ID = "profile-action-test";
const STARTED_AT = "2026-08-26T08:00:00.000Z";

test("a local pending launch exposes an enabled Stop before a server session exists", () => {
  const html = renderTable({ pendingLaunch: true });

  assert.ok(html.includes(t("actions.stop")));
  assert.equal(html.includes(t("actions.open")), false);
  assert.equal(html.includes("disabled"), false);
});

test("a profile-local Stop request keeps Stop visible and disables duplicate clicks", () => {
  const html = renderTable({ pendingStop: true });

  assert.ok(html.includes(t("status.stopping")));
  assert.ok(html.includes("row-primary danger loading"));
  assert.ok(html.includes("disabled"));
  assert.equal(html.includes(t("actions.open")), false);
});

test("an authoritative stopping session cannot expose Launch", () => {
  const html = renderTable({ session: session("stopping") });

  assert.ok(html.includes(t("status.stopping")));
  assert.equal(html.includes(t("actions.open")), false);
});

test("an idle stopped profile exposes Launch", () => {
  const html = renderTable({ session: session("stopped") });

  assert.ok(html.includes(t("actions.open")));
  assert.equal(html.includes(t("actions.stop")), false);
});

test("an empty row selection does not highlight the first profile", () => {
  const html = renderTable({});

  assert.equal(html.includes("profile-table-row active"), false);
});

function renderTable(options: {
  pendingLaunch?: boolean;
  pendingStop?: boolean;
  session?: SessionSummary;
}): string {
  const actionsColumn = DEFAULT_PROFILE_COLUMNS.find((column) => column.id === "actions");
  assert.ok(actionsColumn);
  return renderToStaticMarkup(
    React.createElement(ProfileTable, {
      allPageSelected: false,
      browserCoreMissing: false,
      columns: [actionsColumn],
      environments: [],
      launchProfile: async () => undefined,
      locale: "zh-CN",
      pendingLaunchIds: options.pendingLaunch ? new Set([PROFILE_ID]) : new Set<string>(),
      pendingStopIds: options.pendingStop ? new Set([PROFILE_ID]) : new Set<string>(),
      profiles: [defaultProfile({ id: PROFILE_ID, name: "Action Test" })],
      proxies: [],
      selectProfile: () => undefined,
      selectedId: "",
      selectedIds: new Set<string>(),
      sessionsByProfileId: new Map(options.session ? [[PROFILE_ID, options.session]] : []),
      stopProfile: async () => undefined,
      t,
      tagFilters: [],
      toggleCurrentPageSelected: () => undefined,
      toggleSelected: () => undefined,
      toggleTagFilter: () => undefined,
    }),
  );
}

function session(status: SessionSummary["status"]): SessionSummary {
  return { profileId: PROFILE_ID, status, startedAt: STARTED_AT };
}

function t(key: TranslationKey, params?: Record<string, string | number>): string {
  return translate("zh-CN", key, params);
}
