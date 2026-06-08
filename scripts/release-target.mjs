import { execFileSync } from "node:child_process";

export function currentRustTarget() {
  const output = execFileSync("rustc", ["-vV"], { encoding: "utf8" });
  const host = output
    .split(/\r?\n/)
    .find((line) => line.startsWith("host:"))
    ?.slice("host:".length)
    .trim();
  if (!host) throw new Error("Could not determine rustc host target.");
  return host;
}

export function pkgTargetForRustTarget(rustTarget) {
  if (rustTarget === "x86_64-pc-windows-msvc" || rustTarget === "x86_64-pc-windows-gnu") return "node26-win-x64";
  if (rustTarget === "aarch64-pc-windows-msvc") return "node26-win-arm64";
  if (rustTarget === "x86_64-unknown-linux-gnu") return "node26-linux-x64";
  if (rustTarget === "x86_64-apple-darwin") return "node26-macos-x64";
  if (rustTarget === "aarch64-apple-darwin") return "node26-macos-arm64";
  throw new Error(`Unsupported Rust target for sidecar packaging: ${rustTarget}`);
}

export function sidecarFileName(rustTarget, baseName = "cbpanel-sidecar") {
  const extension = rustTarget.includes("windows") ? ".exe" : "";
  return `${baseName}-${rustTarget}${extension}`;
}

export function isWindowsRustTarget(rustTarget) {
  return rustTarget.includes("windows");
}

export function isLinuxRustTarget(rustTarget) {
  return rustTarget === "x86_64-unknown-linux-gnu";
}

export function releasePlatformForRustTarget(rustTarget) {
  if (isWindowsRustTarget(rustTarget)) return "windows";
  if (isLinuxRustTarget(rustTarget)) return "linux";
  throw new Error(`Unsupported release platform for Rust target: ${rustTarget}`);
}
