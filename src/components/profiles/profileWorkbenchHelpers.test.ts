import assert from "node:assert/strict";
import test from "node:test";

import { type TranslationKey, translate } from "../../i18n";
import type { BrowserEnvironment, TrashEnvironment } from "../../shared/entities";
import { type BrowserProfile, defaultProfile } from "../../shared/profile";
import { nextAvailableProfileName, profileNameValidationError, reservedProfileNames } from "./profileWorkbenchHelpers";

const TIMESTAMP = "2026-08-05T00:00:00.000Z";

function t(key: TranslationKey): string {
  return translate("zh-CN", key);
}

function profileFixture(name: string, id = `profile-${name}`): BrowserProfile {
  return defaultProfile({ id, name, createdAt: TIMESTAMP, updatedAt: TIMESTAMP });
}

function trashFixture(name: string, id = `profile-${name}`): TrashEnvironment {
  const runtimeProfile = profileFixture(name, id);
  return {
    environment: {
      id,
      name,
      notes: "",
      mode: runtimeProfile.mode,
      startUrl: runtimeProfile.startUrl,
      groupId: "group-default",
      tagIds: [],
      extensionIds: [],
      runtimeProfile,
      createdAt: TIMESTAMP,
      updatedAt: TIMESTAMP,
      deletedAt: TIMESTAMP,
    } satisfies BrowserEnvironment,
    deletedAt: TIMESTAMP,
  };
}

test("nextAvailableProfileName keeps the plain base name when nothing holds it", () => {
  assert.equal(nextAvailableProfileName("新浏览器配置", []), "新浏览器配置");
  assert.equal(nextAvailableProfileName("新浏览器配置", ["环境 A", "环境 B"]), "新浏览器配置");
});

test("nextAvailableProfileName counts up instead of reaching for a random suffix", () => {
  assert.equal(nextAvailableProfileName("新浏览器配置", ["新浏览器配置"]), "新浏览器配置 2");
  assert.equal(nextAvailableProfileName("新浏览器配置", ["新浏览器配置", "新浏览器配置 2"]), "新浏览器配置 3");
  // A gap is filled rather than skipped, so the series never runs away from the number of environments.
  assert.equal(nextAvailableProfileName("新浏览器配置", ["新浏览器配置", "新浏览器配置 3"]), "新浏览器配置 2");
});

test("nextAvailableProfileName normalizes case and padding the way the store's key does", () => {
  assert.equal(nextAvailableProfileName("  新浏览器配置  ", ["新浏览器配置"]), "新浏览器配置 2");
  assert.equal(nextAvailableProfileName("New browser profile", ["  NEW BROWSER PROFILE  "]), "New browser profile 2");
  // An empty base would produce a name the store rejects as blank, so it falls back like nextProfileCopyName.
  assert.equal(nextAvailableProfileName("   ", []), "Profile");
});

test("nextAvailableProfileName skips a name only the trash still holds", () => {
  const active = [profileFixture("环境 A")];
  const trash = [trashFixture("新浏览器配置"), trashFixture("新浏览器配置 2")];

  // Without the trash the default would look free here, and the create would come back 409.
  assert.equal(nextAvailableProfileName("新浏览器配置", active.map((profile) => profile.name)), "新浏览器配置");
  assert.equal(nextAvailableProfileName("新浏览器配置", reservedProfileNames(active, trash)), "新浏览器配置 3");
});

test("reservedProfileNames reports the trash names the environment table cannot show", () => {
  const names = reservedProfileNames([profileFixture("环境 A")], [trashFixture("已删除环境")]);

  assert.deepEqual(names, ["环境 A", "已删除环境"]);
});

test("profileNameValidationError still refuses a blank name and another profile's name", () => {
  const stored = profileFixture("环境 A");

  // An empty trash here on purpose: these are the rules that must survive the trash being added to the
  // judgement, so they are checked with nothing in it.
  assert.equal(profileNameValidationError({ ...stored, name: "   " }, [stored], false, t, []), t("form.profileNameRequired"));
  assert.equal(
    profileNameValidationError({ ...profileFixture("环境 B"), name: " 环境 a " }, [stored], false, t, []),
    t("form.profileNameDuplicate"),
  );
  assert.equal(profileNameValidationError(stored, [stored], false, t, []), "");
  // A new draft cannot excuse a clash as "the same record", because its id is not in the store yet.
  assert.equal(profileNameValidationError(profileFixture("环境 A"), [stored], true, t, []), t("form.profileNameDuplicate"));
});

test("profileNameValidationError names the trash when that is what holds the name", () => {
  const draft = profileFixture("新浏览器配置");
  const trash = [trashFixture("新浏览器配置")];
  const message = profileNameValidationError(draft, [], true, t, trash);

  // The generic wording sent users hunting for a duplicate the table never shows; this one says where it is.
  assert.equal(message, t("form.profileNameDuplicateInTrash"));
  assert.match(message, /回收站/);
  assert.notEqual(t("form.profileNameDuplicateInTrash"), t("form.profileNameDuplicate"));
});

test("profileNameValidationError matches a trash name past case and padding", () => {
  const draft = { ...profileFixture("Draft"), name: "  TRASHED name  " };

  assert.equal(
    profileNameValidationError(draft, [], true, t, [trashFixture("Trashed Name")]),
    t("form.profileNameDuplicateInTrash"),
  );
});

test("profileNameValidationError lets the environment being edited keep its own trashed row", () => {
  const trashed = trashFixture("环境 A", "profile-a");
  const draft = profileFixture("环境 A", "profile-a");

  // Restoring an environment edits the same id, so its own trash row must not read as a conflict.
  assert.equal(profileNameValidationError(draft, [], false, t, [trashed]), "");
});
