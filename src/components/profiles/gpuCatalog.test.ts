import assert from "node:assert/strict";
import test from "node:test";

import { buildFingerprintArgs, defaultProfile } from "../../shared/profile";
import type { FingerprintPlatform } from "../../shared/profile";
import {
  GPU_CUSTOM_VALUE,
  GPU_PROFILE_CATALOG,
  applyGpuEntry,
  gpuCatalogOptions,
  gpuEntryId,
  gpuSelectionValue,
} from "./gpuCatalog";

const WINDOWS_ENTRIES = GPU_PROFILE_CATALOG.filter((entry) => entry.platform === "windows");
const FIRST_WINDOWS_ENTRY = WINDOWS_ENTRIES[0];
const MACOS_ENTRY = GPU_PROFILE_CATALOG.find((entry) => entry.platform === "macos")!;

test("every catalog entry can be emitted verbatim by the binary", () => {
  // CloakBrowser only emits --fingerprint-gpu-renderer verbatim when it starts with "ANGLE (";
  // anything else is wrapped by the binary, which truncates models it does not know.
  for (const entry of GPU_PROFILE_CATALOG) {
    assert.ok(entry.renderer.startsWith("ANGLE ("), `${entry.id} renderer must be a full ANGLE string`);
    assert.ok(entry.vendor.length > 0, `${entry.id} vendor must not be empty`);
    assert.ok(entry.label.length > 0, `${entry.id} label must not be empty`);
  }
  assert.ok(WINDOWS_ENTRIES.length > 0, "expected Windows entries");
});

test("vendors are the masked form real Chrome reports", () => {
  for (const entry of GPU_PROFILE_CATALOG) {
    assert.match(entry.vendor, /^Google Inc\. \((Intel|NVIDIA|AMD|Apple)\)$/, `${entry.id} vendor must be masked`);
  }
});

test("catalog ids are unique and every platform is represented", () => {
  assert.equal(new Set(GPU_PROFILE_CATALOG.map((entry) => entry.id)).size, GPU_PROFILE_CATALOG.length);
  for (const platform of ["windows", "macos", "linux"] as const) {
    assert.ok(
      GPU_PROFILE_CATALOG.some((entry) => entry.platform === platform),
      `expected a ${platform} entry`,
    );
  }
});

test("an exact vendor/renderer pair maps to its entry id, surrounding blanks ignored", () => {
  assert.equal(gpuEntryId(FIRST_WINDOWS_ENTRY.vendor, FIRST_WINDOWS_ENTRY.renderer), FIRST_WINDOWS_ENTRY.id);
  assert.equal(gpuEntryId(`  ${FIRST_WINDOWS_ENTRY.vendor}  `, `\t${FIRST_WINDOWS_ENTRY.renderer}\n`), FIRST_WINDOWS_ENTRY.id);
});

test("a pair that is not a catalog entry has no id", () => {
  assert.equal(gpuEntryId("", ""), undefined);
  assert.equal(gpuEntryId("Intel Inc.", "Intel Iris OpenGL Engine"), undefined);
  // Half of an entry is not an entry: the vendor matches but the renderer does not.
  assert.equal(gpuEntryId(FIRST_WINDOWS_ENTRY.vendor, "ANGLE (NVIDIA, NVIDIA GeForce RTX 4090 Direct3D11 vs_5_0 ps_5_0, D3D11)"), undefined);
});

test("the picker value is the entry id, or the custom marker for anything else", () => {
  assert.equal(gpuSelectionValue(FIRST_WINDOWS_ENTRY.vendor, FIRST_WINDOWS_ENTRY.renderer), FIRST_WINDOWS_ENTRY.id);
  assert.equal(gpuSelectionValue("", ""), GPU_CUSTOM_VALUE);
  assert.equal(gpuSelectionValue("NVIDIA Corporation", "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)"), GPU_CUSTOM_VALUE);
});

test("selecting an entry writes both fingerprint fields verbatim", () => {
  assert.deepEqual(applyGpuEntry(FIRST_WINDOWS_ENTRY), {
    gpuVendor: FIRST_WINDOWS_ENTRY.vendor,
    gpuRenderer: FIRST_WINDOWS_ENTRY.renderer,
  });
});

test("the chosen pair reaches the launch arguments unmodified", () => {
  for (const entry of GPU_PROFILE_CATALOG) {
    const profile = defaultProfile();
    const args = buildFingerprintArgs({ ...profile, fingerprint: { ...profile.fingerprint, ...applyGpuEntry(entry) } });

    assert.ok(args.includes(`--fingerprint-gpu-vendor=${entry.vendor}`), `${entry.id} vendor flag`);
    assert.ok(args.includes(`--fingerprint-gpu-renderer=${entry.renderer}`), `${entry.id} renderer flag`);
  }
});

test("auto offers every entry in catalog order", () => {
  assert.deepEqual(
    gpuCatalogOptions("auto", "", "").map((entry) => entry.id),
    GPU_PROFILE_CATALOG.map((entry) => entry.id),
  );
});

test("a concrete platform narrows the list to its own entries", () => {
  assert.deepEqual(
    gpuCatalogOptions("windows", "", "").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
  assert.ok(gpuCatalogOptions("macos", "", "").every((entry) => entry.platform === "macos"));
  assert.ok(gpuCatalogOptions("linux", "", "").every((entry) => entry.platform === "linux"));
});

test("the selected entry survives a platform filter that excludes it", () => {
  // The profile is pinned to windows but its stored pair is a mac entry: dropping it would leave the
  // picker on the placeholder and the user one click away from silently losing the selection.
  const options = gpuCatalogOptions("windows", MACOS_ENTRY.vendor, MACOS_ENTRY.renderer);

  assert.deepEqual(options.map((entry) => entry.id), [...WINDOWS_ENTRIES.map((entry) => entry.id), MACOS_ENTRY.id]);
  assert.ok(options.includes(MACOS_ENTRY));
});

test("an orphaned custom pair adds no row", () => {
  assert.deepEqual(
    gpuCatalogOptions("windows", "NVIDIA Corporation", "NVIDIA GeForce RTX 3060").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
});

test("an unknown platform offers every entry instead of emptying the menu", () => {
  // A hand-edited share string can carry e.g. platform: "win"; the picker must not silently go blank.
  const unknown = "win" as FingerprintPlatform;

  assert.deepEqual(
    gpuCatalogOptions(unknown, "", "").map((entry) => entry.id),
    GPU_PROFILE_CATALOG.map((entry) => entry.id),
  );
  // The pair already selected still resolves to its own entry under the fallback.
  assert.deepEqual(
    gpuCatalogOptions(unknown, MACOS_ENTRY.vendor, MACOS_ENTRY.renderer).map((entry) => entry.id),
    GPU_PROFILE_CATALOG.map((entry) => entry.id),
  );
});
