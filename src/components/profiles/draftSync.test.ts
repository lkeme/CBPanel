import assert from "node:assert/strict";
import test from "node:test";

import { type BrowserProfile, defaultProfile, normalizeProfile } from "../../shared/profile";
import { hasUnsavedEdits, planDraftSync } from "./draftSync";

function profileFixture(patch: Partial<BrowserProfile> = {}): BrowserProfile {
  return normalizeProfile({
    id: "profile-a",
    name: "环境 A",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...patch,
  });
}

test("picking another row rebuilds the draft, unsaved edits or not", () => {
  const current = profileFixture();
  const next = profileFixture({ id: "profile-b", name: "环境 B" });
  const draft = { ...structuredClone(current), startUrl: "https://mail.example.com" };

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [current, next], selectedId: next.id }), {
    action: "adopt",
    selectedId: next.id,
    profile: next,
  });
});

test("a state refresh never resets an edit the user has not saved", () => {
  const stored = profileFixture();
  const draft = { ...structuredClone(stored), startUrl: "https://mail.example.com" };

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [stored], selectedId: stored.id }), {
    action: "keep",
    selectedId: stored.id,
  });
});

test("a record whose updatedAt moved server-side still may not overwrite unsaved edits", () => {
  const stored = profileFixture();
  const draft = { ...structuredClone(stored), proxy: { ...stored.proxy, enabled: true, host: "10.0.0.9", port: "8080" } };
  const refreshed = profileFixture({ updatedAt: "2026-08-05T09:00:00.000Z" });

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [refreshed], selectedId: stored.id }), {
    action: "keep",
    selectedId: stored.id,
  });
});

test("a draft that still matches the store is adopted, so a refresh stays harmless", () => {
  const stored = profileFixture();
  const draft = structuredClone(stored);

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [stored], selectedId: stored.id }), {
    action: "adopt",
    selectedId: stored.id,
    profile: stored,
  });
});

test("a fresher updatedAt on its own is adopted rather than mistaken for an edit", () => {
  const draft = profileFixture();
  const refreshed = profileFixture({ updatedAt: "2026-08-05T09:00:00.000Z" });

  assert.equal(hasUnsavedEdits(draft, refreshed), false);
  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [refreshed], selectedId: draft.id }), {
    action: "adopt",
    selectedId: refreshed.id,
    profile: refreshed,
  });
});

test("a draft for a profile that is not stored yet is left alone", () => {
  const stored = profileFixture();
  const draft = defaultProfile({ id: "profile-new", name: "新浏览器配置 2" });

  assert.deepEqual(planDraftSync({ draft, draftIsNew: true, profiles: [stored], selectedId: stored.id }), {
    action: "skip",
  });
});

test("the editor opening with no draft yet takes the selected record", () => {
  const stored = profileFixture();

  assert.deepEqual(planDraftSync({ draft: null, draftIsNew: false, profiles: [stored], selectedId: stored.id }), {
    action: "adopt",
    selectedId: stored.id,
    profile: stored,
  });
});

test("an initial empty selection stays empty until the user picks a row", () => {
  const stored = profileFixture();

  assert.deepEqual(planDraftSync({ draft: null, draftIsNew: false, profiles: [stored], selectedId: "" }), {
    action: "skip",
  });
});

test("a selection pointing at a deleted environment falls back to the first record", () => {
  const survivor = profileFixture({ id: "profile-b", name: "环境 B" });
  const draft = profileFixture({ id: "profile-gone", name: "已删除" });

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [survivor], selectedId: draft.id }), {
    action: "adopt",
    selectedId: survivor.id,
    profile: survivor,
  });
});

test("a corrected selection landing back on the drafted record still protects unsaved edits", () => {
  const survivor = profileFixture();
  const draft = { ...structuredClone(survivor), name: "环境 A 改名" };

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [survivor], selectedId: "profile-gone" }), {
    action: "keep",
    selectedId: survivor.id,
  });
});

test("an emptied store clears the draft", () => {
  const draft = profileFixture();

  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: [], selectedId: draft.id }), { action: "clear" });
  assert.deepEqual(planDraftSync({ draft, draftIsNew: false, profiles: undefined, selectedId: draft.id }), {
    action: "clear",
  });
});

test("hasUnsavedEdits reaches into nested settings, arrays and numbers", () => {
  const stored = profileFixture();

  assert.equal(hasUnsavedEdits({ ...stored, startUrl: "https://example.com" }, stored), true);
  assert.equal(hasUnsavedEdits({ ...stored, tags: [...stored.tags, "client-a"] }, stored), true);
  assert.equal(hasUnsavedEdits({ ...stored, proxy: { ...stored.proxy, host: "10.0.0.9" } }, stored), true);
  assert.equal(hasUnsavedEdits({ ...stored, viewport: { ...stored.viewport, height: 900 } }, stored), true);
  assert.equal(hasUnsavedEdits({ ...stored, runtime: { ...stored.runtime, extraArgs: ["--mute-audio"] } }, stored), true);
  assert.equal(hasUnsavedEdits({ ...stored, runtime: { ...stored.runtime, geoip: !stored.runtime.geoip } }, stored), true);
});

test("hasUnsavedEdits ignores the undefined fields an API round trip drops", () => {
  const draft = profileFixture();
  const stored = JSON.parse(JSON.stringify(draft)) as BrowserProfile;

  assert.equal(draft.verification.detectionChecks.some((check) => "checkedAt" in check && check.checkedAt === undefined), true);
  assert.equal(hasUnsavedEdits(draft, stored), false);
});
