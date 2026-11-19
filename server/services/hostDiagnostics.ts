import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import type { SystemDiagnosticsHost } from "../../src/shared/entities";

/**
 * The host block of the diagnostics payload. `os.type()` alone is the kernel family (`Windows_NT`),
 * which names nothing an operator recognises; the About page reports the OS the machine runs, so the
 * human name and the release are resolved here, once, instead of in each consumer.
 *
 * Every probe degrades to a partial answer rather than failing the diagnostics request: a missing
 * `/etc/os-release` or an unavailable tool costs a row, not the page.
 */
export async function readHostDiagnostics(): Promise<SystemDiagnosticsHost> {
  const host: SystemDiagnosticsHost = {
    os: os.type(),
    arch: os.arch(),
    node: process.version,
  };
  if (process.platform === "win32") {
    // `os.version()` on Windows is the marketing name (`Windows 11 Enterprise`) and `os.release()` is
    // the `10.0.26300` build half, so both are reported rather than one standing in for the other.
    host.osName = nonEmpty(os.version());
    host.osVersion = nonEmpty(os.release());
    return host;
  }
  if (process.platform === "darwin") {
    const [productVersion, buildVersion] = await Promise.all([
      runTool("sw_vers", ["-productVersion"]),
      runTool("sw_vers", ["-buildVersion"]),
    ]);
    host.osName = productVersion ? "macOS" : undefined;
    host.osVersion = [productVersion, buildVersion].filter(Boolean).join(" ") || undefined;
    return host;
  }
  host.osName = await readLinuxPrettyName();
  host.osVersion = nonEmpty(os.release());
  return host;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Font families the upstream docs name as the most common block cause once proxy, GeoIP and headed
 * mode are correct: emoji, CJK, and the Windows-compatible set a `windows` persona reports.
 *
 * Linux is the host the docs single out. macOS and Windows ship these families, so the probe returns
 * `undefined` there rather than paying a tool call for a list that is always present.
 */
/**
 * The eight Windows families the docs name for a `windows` persona, plus the emoji/CJK baseline every
 * persona needs. The docs single the missing-Windows-font case out as the most common block cause once
 * proxy, GeoIP and headed mode are correct.
 */
const WINDOWS_PERSONA_FONT_FAMILIES = [
  "Noto Color Emoji",
  "Noto Sans CJK",
  "Segoe UI",
  "Segoe UI Light",
  "Calibri",
  "Marlett",
  "MS UI Gothic",
  "Franklin Gothic",
  "Consolas",
  "Courier New",
] as const;

/** The Mac families `cloakbrowser info` reports for a `macos` persona. */
const MACOS_PERSONA_FONT_FAMILIES = [
  "Noto Color Emoji",
  "Noto Sans CJK",
  "Helvetica Neue",
  "Menlo",
  "SF Pro",
  "SF Pro Text",
] as const;

export type FontPersona = "windows" | "macos";

/**
 * Which persona the wrapper will present. `auto` is not "no persona": the wrapper spoofs Windows on
 * Linux/Windows hosts and runs native on macOS, so the font requirement follows the host in that case.
 */
export function effectiveFontPersona(
  platform: string | undefined,
  hostPlatform: NodeJS.Platform = process.platform,
): FontPersona {
  if (platform === "windows" || platform === "macos") return platform;
  return hostPlatform === "darwin" ? "macos" : "windows";
}

export async function checkRequiredFonts(
  persona: FontPersona = "windows",
): Promise<{ missing: string[]; detail?: string } | undefined> {
  // Linux is the host the docs single out, and the only one with fontconfig to query. macOS and Windows
  // ship their own persona fonts, so there is nothing this probe could add there.
  if (process.platform !== "linux") return undefined;
  const listing = await runTool("fc-list", [":", "family"]);
  if (listing === undefined) {
    return {
      missing: [],
      detail: "未找到 fc-list（fontconfig），无法检查 emoji / CJK / Windows 字体；字体缺失是常见的被拦原因。",
    };
  }
  const families = listing.toLowerCase();
  const required = persona === "macos" ? MACOS_PERSONA_FONT_FAMILIES : WINDOWS_PERSONA_FONT_FAMILIES;
  const missing = required.filter((family) => !families.includes(family.toLowerCase()));
  return missing.length > 0 ? { missing: [...missing] } : { missing: [] };
}

function runTool(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 2000 }, (error, stdout) => {
      resolve(error ? undefined : nonEmpty(stdout));
    });
  });
}

async function readLinuxPrettyName(): Promise<string | undefined> {
  try {
    const content = await fs.readFile("/etc/os-release", "utf8");
    return nonEmpty(/^PRETTY_NAME="?([^"\n]+)"?$/m.exec(content)?.[1]);
  } catch {
    return undefined;
  }
}
