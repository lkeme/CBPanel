import type { SystemDiagnosticsHost } from "./entities";

/**
 * `process.arch` / `os.arch()` speak Node's abbreviations; the About page reports the machine the
 * binary actually runs on, where `x64` names the architecture family rather than the CPU model.
 * Unknown values stay verbatim instead of being guessed into a family.
 */
const ARCHITECTURE_LABELS: Record<string, string> = {
  x64: "x86_64",
  ia32: "x86",
  arm64: "arm64",
  arm: "arm",
  ppc64: "ppc64",
  s390x: "s390x",
  riscv64: "riscv64",
};

export function formatArchitecture(arch: string | undefined): string {
  const value = arch?.trim();
  if (!value) return "-";
  return ARCHITECTURE_LABELS[value] ?? value;
}

/**
 * `Windows 11 Enterprise (10.0.26300)`: the human name the OS reports plus the release it names.
 * Older payloads carry only `os`/`arch` (`Windows_NT`, the kernel family), so the name falls back to
 * that instead of an empty row — an About page that says nothing about the OS is worse than one that
 * says `Windows_NT`.
 */
export function formatOperatingSystem(host: SystemDiagnosticsHost | undefined): string {
  if (!host) return "-";
  const name = host.osName?.trim() || host.os?.trim() || "";
  const version = host.osVersion?.trim();
  if (!name) return version ?? "-";
  return version && version !== name ? `${name} (${version})` : name;
}

/** `2026` for the first year, `2026-2027` once the copyright spans more than one. */
export function formatCopyrightYears(startYear: number, now: Date = new Date()): string {
  const currentYear = now.getFullYear();
  return currentYear > startYear ? `${startYear}-${currentYear}` : String(startYear);
}
