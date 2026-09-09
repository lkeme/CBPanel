import type { FingerprintPlatform } from "../../shared/profile";

export type GpuCatalogPlatform = "windows" | "macos" | "linux";

export interface GpuProfileEntry {
  id: string;
  platform: GpuCatalogPlatform;
  label: string;
  vendor: string;
  renderer: string;
}

/**
 * The value the picker reports when the current vendor/renderer pair matches no catalog entry.
 * It is never an option, so the SelectMenu falls back to its placeholder.
 */
export const GPU_CUSTOM_VALUE = "custom";

/**
 * Vendor and renderer pairs that are internally consistent, grouped by platform.
 *
 * `renderer` must be the full ANGLE string: CloakBrowser emits
 * `--fingerprint-gpu-renderer` verbatim only when it starts with `ANGLE (`, and otherwise wraps
 * the value itself — truncating models it does not know (`Intel(R) UHD Graphics 630` became
 * `Intel(R) UHD Graphics` with a wrong device id). `vendor` uses the masked form real Chrome
 * reports. Windows entries were verified against the binary; macOS and Linux entries follow the
 * shapes those builds report but are untested (no binary available on this machine).
 */
export const GPU_PROFILE_CATALOG: GpuProfileEntry[] = [
  {
    id: "win_nvidia_rtx_3060",
    platform: "windows",
    label: "NVIDIA GeForce RTX 3060",
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_nvidia_rtx_3070",
    platform: "windows",
    label: "NVIDIA GeForce RTX 3070",
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_nvidia_rtx_4060",
    platform: "windows",
    label: "NVIDIA GeForce RTX 4060",
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_nvidia_rtx_2060",
    platform: "windows",
    label: "NVIDIA GeForce RTX 2060",
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 2060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_nvidia_gtx_1660_super",
    platform: "windows",
    label: "NVIDIA GeForce GTX 1660 SUPER",
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce GTX 1660 SUPER Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_intel_uhd_630",
    platform: "windows",
    label: "Intel UHD Graphics 630",
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 (0x00003E9B) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_intel_uhd_620",
    platform: "windows",
    label: "Intel UHD Graphics 620",
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) UHD Graphics 620 (0x00003EA0) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_intel_iris_xe",
    platform: "windows",
    label: "Intel Iris Xe Graphics",
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) Iris(R) Xe Graphics (0x00009A49) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_intel_hd_520",
    platform: "windows",
    label: "Intel HD Graphics 520",
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Intel(R) HD Graphics 520 (0x00001916) Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_amd_rx_6600_xt",
    platform: "windows",
    label: "AMD Radeon RX 6600 XT",
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 6600 XT Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_amd_rx_580",
    platform: "windows",
    label: "AMD Radeon RX 580",
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 580 Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "win_amd_rx_7900_xtx",
    platform: "windows",
    label: "AMD Radeon RX 7900 XTX",
    vendor: "Google Inc. (AMD)",
    renderer: "ANGLE (AMD, AMD Radeon RX 7900 XTX Direct3D11 vs_5_0 ps_5_0, D3D11)",
  },
  {
    id: "mac_apple_m1",
    platform: "macos",
    label: "Apple M1",
    vendor: "Google Inc. (Apple)",
    renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)",
  },
  {
    id: "mac_apple_m1_pro",
    platform: "macos",
    label: "Apple M1 Pro",
    vendor: "Google Inc. (Apple)",
    renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)",
  },
  {
    id: "mac_apple_m2",
    platform: "macos",
    label: "Apple M2",
    vendor: "Google Inc. (Apple)",
    renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)",
  },
  {
    id: "mac_apple_m3",
    platform: "macos",
    label: "Apple M3",
    vendor: "Google Inc. (Apple)",
    renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M3, Unspecified Version)",
  },
  {
    id: "linux_intel_uhd_620",
    platform: "linux",
    label: "Intel UHD Graphics 620 (Mesa)",
    vendor: "Google Inc. (Intel)",
    renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6 (Core Profile) Mesa 23.0.4-0ubuntu1~22.04.1)",
  },
  {
    id: "linux_amd_rx_580",
    platform: "linux",
    label: "AMD Radeon RX 580 (Mesa)",
    vendor: "Google Inc. (AMD)",
    renderer:
      "ANGLE (AMD, AMD Radeon RX 580 (polaris10, LLVM 15.0.7, DRM 3.49, 6.2.0-26-generic), OpenGL 4.6 (Core Profile) Mesa 23.0.4-0ubuntu1~22.04.1)",
  },
  {
    id: "linux_nvidia_rtx_3060",
    platform: "linux",
    label: "NVIDIA GeForce RTX 3060 (proprietary)",
    vendor: "Google Inc. (NVIDIA)",
    renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6.0 NVIDIA 535.54.03)",
  },
  {
    id: "linux_amd_radeon_680m",
    platform: "linux",
    label: "AMD Radeon 680M (Mesa)",
    vendor: "Google Inc. (AMD)",
    renderer:
      "ANGLE (AMD, AMD Radeon 680M (rembrandt, LLVM 15.0.7, DRM 3.49, 6.2.0-26-generic), OpenGL 4.6 (Core Profile) Mesa 23.0.4-0ubuntu1~22.04.1)",
  },
];

/** The catalog entry the two fields spell out, or `undefined` for anything else. */
export function gpuEntryId(vendor: string, renderer: string): string | undefined {
  const vendorText = vendor.trim();
  const rendererText = renderer.trim();
  return GPU_PROFILE_CATALOG.find((entry) => entry.vendor === vendorText && entry.renderer === rendererText)?.id;
}

/** What the picker shows as selected: a catalog id, or `GPU_CUSTOM_VALUE` for a hand-written pair. */
export function gpuSelectionValue(vendor: string, renderer: string): string {
  return gpuEntryId(vendor, renderer) ?? GPU_CUSTOM_VALUE;
}

/** The fingerprint fields an entry writes. */
export function applyGpuEntry(entry: GpuProfileEntry): { gpuVendor: string; gpuRenderer: string } {
  return { gpuVendor: entry.vendor, gpuRenderer: entry.renderer };
}

const GPU_CATALOG_PLATFORMS: ReadonlySet<string> = new Set<GpuCatalogPlatform>(["windows", "macos", "linux"]);

/**
 * The rows the picker offers. A concrete platform narrows the list to its own entries; `auto` shows
 * every entry in catalog order. A hand-edited share string can carry a platform the catalog does not
 * know (`"win"`); rather than silently emptying the menu, that value is treated like `auto`. The entry
 * the current pair already names is kept even when the platform filter excludes it, so switching
 * platform cannot silently drop the selection.
 */
export function gpuCatalogOptions(
  platform: FingerprintPlatform,
  currentVendor: string,
  currentRenderer: string,
): GpuProfileEntry[] {
  const filtered =
    platform === "auto" || !GPU_CATALOG_PLATFORMS.has(platform)
      ? GPU_PROFILE_CATALOG
      : GPU_PROFILE_CATALOG.filter((entry) => entry.platform === platform);
  const current = GPU_PROFILE_CATALOG.find((entry) => entry.id === gpuEntryId(currentVendor, currentRenderer));
  if (!current || filtered.includes(current)) return filtered;
  return [...filtered, current];
}
