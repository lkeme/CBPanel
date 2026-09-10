import assert from "node:assert/strict";
import test from "node:test";

import { buildFingerprintArgs, defaultProfile } from "../../shared/profile";
import type { FingerprintPlatform } from "../../shared/profile";
import {
  GPU_CUSTOM_VALUE,
  GPU_PROFILE_CATALOG,
  applyGpuEntry,
  effectiveGpuPlatform,
  gpuCatalogOptions,
  gpuEntryId,
  gpuSelectionValue,
  spoofedPlatformFor,
} from "./gpuCatalog";

const WINDOWS_ENTRIES = GPU_PROFILE_CATALOG.filter((entry) => entry.platform === "windows");
const MACOS_ENTRIES = GPU_PROFILE_CATALOG.filter((entry) => entry.platform === "macos");
const LINUX_ENTRIES = GPU_PROFILE_CATALOG.filter((entry) => entry.platform === "linux");
const FIRST_WINDOWS_ENTRY = WINDOWS_ENTRIES[0];
const MACOS_ENTRY = MACOS_ENTRIES[0];

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

test("the spoofed platform under auto follows the host, Linux included", () => {
  // cloakbrowser/config.js getDefaultStealthArgs: darwin spoofs macos; "Linux/Windows: spoof as
  // Windows desktop".
  assert.equal(spoofedPlatformFor("macos"), "macos");
  assert.equal(spoofedPlatformFor("windows"), "windows");
  assert.equal(spoofedPlatformFor("linux"), "windows");
  assert.equal(spoofedPlatformFor("unknown"), undefined);
  assert.equal(spoofedPlatformFor(undefined), undefined);
});

test("auto narrows the catalog to the platform CloakBrowser will spoof on the host", () => {
  assert.deepEqual(
    gpuCatalogOptions("auto", "windows", true, "", "").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
  assert.deepEqual(
    gpuCatalogOptions("auto", "macos", true, "", "").map((entry) => entry.id),
    MACOS_ENTRIES.map((entry) => entry.id),
  );
  // A Linux host is spoofed as Windows, so the Windows entries are the coherent ones.
  assert.deepEqual(
    gpuCatalogOptions("auto", "linux", true, "", "").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
});

test("the platform auto targets follows the host with stealth args off", () => {
  // `stealthArgs: false` is what does the spoofing, so `auto` then means the host's own platform: the
  // browser reports real Linux, and narrowing it to the Windows/D3D11 entries would be the very
  // mismatch the host rule exists to avoid.
  assert.equal(effectiveGpuPlatform("linux", false), "linux");
  assert.equal(effectiveGpuPlatform("windows", false), "windows");
  assert.equal(effectiveGpuPlatform("macos", false), "macos");
  assert.equal(effectiveGpuPlatform("unknown", false), undefined);
  assert.equal(effectiveGpuPlatform(undefined, false), undefined);
  // With spoofing on it is the pre-existing rule, unchanged.
  assert.equal(effectiveGpuPlatform("linux", true), "windows");
  assert.equal(effectiveGpuPlatform("macos", true), "macos");
  assert.equal(effectiveGpuPlatform("windows", true), "windows");
});

test("stealth args off offers the host's own entries under auto", () => {
  assert.deepEqual(
    gpuCatalogOptions("auto", "linux", false, "", "").map((entry) => entry.id),
    LINUX_ENTRIES.map((entry) => entry.id),
  );
  assert.deepEqual(
    gpuCatalogOptions("auto", "windows", false, "", "").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
  assert.deepEqual(
    gpuCatalogOptions("auto", "macos", false, "", "").map((entry) => entry.id),
    MACOS_ENTRIES.map((entry) => entry.id),
  );
  // Unknown or absent host: every entry, exactly as with spoofing on.
  for (const host of [undefined, "unknown"] as const) {
    assert.deepEqual(
      gpuCatalogOptions("auto", host, false, "", "").map((entry) => entry.id),
      GPU_PROFILE_CATALOG.map((entry) => entry.id),
      `a ${host} host must not empty the menu`,
    );
  }
});

test("auto with an unknown or absent host keeps offering every entry", () => {
  for (const host of [undefined, "unknown"] as const) {
    for (const spoofsPlatform of [true, false]) {
      assert.deepEqual(
        gpuCatalogOptions("auto", host, spoofsPlatform, "", "").map((entry) => entry.id),
        GPU_PROFILE_CATALOG.map((entry) => entry.id),
        `a ${host} host must not empty the menu with spoofing ${spoofsPlatform ? "on" : "off"}`,
      );
    }
  }
});

test("a concrete platform narrows the list to its own entries", () => {
  assert.deepEqual(
    gpuCatalogOptions("windows", undefined, true, "", "").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
  assert.deepEqual(
    gpuCatalogOptions("macos", undefined, true, "", "").map((entry) => entry.id),
    MACOS_ENTRIES.map((entry) => entry.id),
  );
  assert.deepEqual(
    gpuCatalogOptions("linux", undefined, true, "", "").map((entry) => entry.id),
    LINUX_ENTRIES.map((entry) => entry.id),
  );
});

test("a concrete platform wins over the host rule and over stealth args", () => {
  // The user asked the browser to spoof this platform, so its entries are offered even when the host
  // would spoof something else under auto — and `stealthArgs` cannot change that.
  for (const host of [undefined, "windows", "macos", "linux", "unknown"] as const) {
    for (const spoofsPlatform of [true, false]) {
      assert.deepEqual(
        gpuCatalogOptions("linux", host, spoofsPlatform, "", "").map((entry) => entry.id),
        LINUX_ENTRIES.map((entry) => entry.id),
        `linux on a ${host} host with spoofing ${spoofsPlatform ? "on" : "off"}`,
      );
      assert.deepEqual(
        gpuCatalogOptions("macos", host, spoofsPlatform, "", "").map((entry) => entry.id),
        MACOS_ENTRIES.map((entry) => entry.id),
        `macos on a ${host} host with spoofing ${spoofsPlatform ? "on" : "off"}`,
      );
    }
  }
});

test("the selected entry survives a filter that excludes it", () => {
  // The profile is pinned to windows but its stored pair is a mac entry: dropping it would leave the
  // picker on the placeholder and the user one click away from silently losing the selection.
  const explicit = gpuCatalogOptions("windows", undefined, true, MACOS_ENTRY.vendor, MACOS_ENTRY.renderer);
  assert.deepEqual(explicit.map((entry) => entry.id), [...WINDOWS_ENTRIES.map((entry) => entry.id), MACOS_ENTRY.id]);
  assert.ok(explicit.includes(MACOS_ENTRY));

  // Same rule under the auto host narrowing: a Windows host offers Windows rows, yet the stored mac
  // pair keeps its own row.
  const narrowed = gpuCatalogOptions("auto", "windows", true, MACOS_ENTRY.vendor, MACOS_ENTRY.renderer);
  assert.deepEqual(narrowed.map((entry) => entry.id), [...WINDOWS_ENTRIES.map((entry) => entry.id), MACOS_ENTRY.id]);

  // And under the stealth-args-off narrowing, where the host's own Linux rows would exclude it.
  const hostNarrowed = gpuCatalogOptions("auto", "linux", false, MACOS_ENTRY.vendor, MACOS_ENTRY.renderer);
  assert.deepEqual(hostNarrowed.map((entry) => entry.id), [...LINUX_ENTRIES.map((entry) => entry.id), MACOS_ENTRY.id]);
});

test("an orphaned custom pair adds no row", () => {
  assert.deepEqual(
    gpuCatalogOptions("windows", undefined, true, "NVIDIA Corporation", "NVIDIA GeForce RTX 3060").map((entry) => entry.id),
    WINDOWS_ENTRIES.map((entry) => entry.id),
  );
});

test("an unknown platform offers every entry instead of emptying the menu", () => {
  // A hand-edited share string can carry e.g. platform: "win"; the picker must not silently go blank.
  const unknown = "win" as FingerprintPlatform;

  assert.deepEqual(
    gpuCatalogOptions(unknown, "windows", true, "", "").map((entry) => entry.id),
    GPU_PROFILE_CATALOG.map((entry) => entry.id),
  );
  // The pair already selected still resolves to its own entry under the fallback.
  assert.deepEqual(
    gpuCatalogOptions(unknown, "windows", true, MACOS_ENTRY.vendor, MACOS_ENTRY.renderer).map((entry) => entry.id),
    GPU_PROFILE_CATALOG.map((entry) => entry.id),
  );
});

test("the picker value always resolves inside the offered options", () => {
  // SelectMenu falls back to its placeholder whenever the value is not an option, so a dropped row
  // would silently show "Custom" while the profile still holds the catalog pair.
  for (const platform of ["auto", "windows", "macos", "linux"] as const) {
    for (const host of [undefined, "windows", "macos", "linux", "unknown"] as const) {
      for (const spoofsPlatform of [true, false]) {
        for (const entry of GPU_PROFILE_CATALOG) {
          const value = gpuSelectionValue(entry.vendor, entry.renderer);
          assert.ok(
            gpuCatalogOptions(platform, host, spoofsPlatform, entry.vendor, entry.renderer).some((option) => option.id === value),
            `${entry.id} under ${platform} on a ${host} host with spoofing ${spoofsPlatform ? "on" : "off"} must keep its own row`,
          );
        }
        // The custom marker is a placeholder signal, never a selectable row.
        assert.equal(
          gpuCatalogOptions(platform, host, spoofsPlatform, "NVIDIA Corporation", "NVIDIA GeForce RTX 3060").some((option) => option.id === GPU_CUSTOM_VALUE),
          false,
          `${platform} on a ${host} host with spoofing ${spoofsPlatform ? "on" : "off"} must not offer the custom marker as an option`,
        );
      }
    }
  }
});
