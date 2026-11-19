import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionEntity } from "./entities";
import {
  extensionInstallStateLabel,
  launchExtensionPaths,
  localPathBaseName,
  withLaunchExtensionPaths,
} from "./extensionDisplay";

test("the environment editor names an extension's directory without printing its path", () => {
  assert.equal(localPathBaseName("D:\\Extensions\\uBlock Origin"), "uBlock Origin");
  assert.equal(localPathBaseName("/home/user/extensions/adblock"), "adblock");
  // A trailing separator is a directory marker, not a name.
  assert.equal(localPathBaseName("D:\\Extensions\\uBlock Origin\\"), "uBlock Origin");
  assert.equal(localPathBaseName("/home/user/extensions/adblock/"), "adblock");
  // A root or an empty value has no segment to show; both fall back to the stored text rather than "".
  assert.equal(localPathBaseName("/"), "/");
  assert.equal(localPathBaseName("  "), "");
});

test("every install state has its own localized badge, including the legacy pending states", () => {
  const t = (key: string) => key;
  assert.equal(extensionInstallStateLabel("installed", t), "extension.state.installed");
  assert.equal(extensionInstallStateLabel("update-available", t), "extension.state.updateAvailable");
  assert.equal(extensionInstallStateLabel("local-missing", t), "extension.state.localMissing");
  assert.equal(extensionInstallStateLabel("invalid-manifest", t), "extension.state.invalidManifest");
  assert.equal(extensionInstallStateLabel("install-failed", t), "extension.state.installFailed");
  assert.equal(extensionInstallStateLabel("metadata-only", t), "extension.state.notInstalled");
  assert.equal(extensionInstallStateLabel("download-pending", t), "extension.state.notInstalled");
});

function extension(patch: Partial<ExtensionEntity> & { id: string }): ExtensionEntity {
  return {
    name: patch.id,
    description: "",
    sourceKind: "local-directory",
    sourceUrl: "/src",
    version: "1.0.0",
    permissions: [],
    hostPermissions: [],
    permissionRisks: [],
    installState: "installed",
    updatePolicy: "pinned",
    status: "enabled",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    localPath: `/cache/${patch.id}`,
    ...patch,
  } as ExtensionEntity;
}

// Directories are a launch input the extension service resolves from the binding table, so the read-only
// surfaces have to reproduce exactly the same filter or the argv they show is not the argv of a launch.
test("launch extension paths mirror the launcher's filter", () => {
  const extensions = [
    extension({ id: "ok" }),
    extension({ id: "disabled", status: "disabled" }),
    extension({ id: "not-installed", installState: "metadata-only" }),
    extension({ id: "missing-path", localPath: undefined }),
    extension({ id: "updating", installState: "update-available" }),
  ];
  // Order follows the binding order, not the library order; a downgraded install state is excluded.
  assert.deepEqual(launchExtensionPaths(["ok", "disabled", "missing-path", "not-installed"], extensions), ["/cache/ok"]);
  // A bound id the library no longer has simply contributes nothing.
  assert.deepEqual(launchExtensionPaths(["ok", "gone"], extensions), ["/cache/ok"]);
  assert.deepEqual(launchExtensionPaths([], extensions), []);
  assert.deepEqual(launchExtensionPaths(["ok"], undefined), []);
});

test("a profiling draft keeps its own fields and gains only the resolved directories", () => {
  const draft = {
    id: "draft",
    name: "Kept",
    runtime: { extensionPaths: [] as string[], extraArgs: ["--foo"] },
  };
  const resolved = withLaunchExtensionPaths(draft, ["a"], [extension({ id: "a" })]);
  assert.equal(resolved.name, "Kept");
  assert.deepEqual(resolved.runtime.extraArgs, ["--foo"]);
  assert.deepEqual(resolved.runtime.extensionPaths, ["/cache/a"]);
  // The input is untouched: these are read-only surfaces rendering from state.
  assert.deepEqual(draft.runtime.extensionPaths, []);
  // A never-saved draft has no bindings, which is the correct answer rather than a failure.
  assert.deepEqual(withLaunchExtensionPaths(draft, undefined, undefined).runtime.extensionPaths, []);
});
