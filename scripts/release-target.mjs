import { execFileSync } from "node:child_process";
import path from "node:path";

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

/**
 * The Windows target every artifact is built for.
 *
 * The Tauri build is invoked without `--target`, so it always compiles for the host. A forced
 * `CBPANEL_RUST_TARGET` would therefore name a sidecar the shell never packs — the source of the
 * gnu/msvc sidecar pair — so a disagreeing override is rejected instead of silently ignored.
 *
 * A host with several Rust installations (scoop ships both `rust` and `rust-gnu`) resolves whichever
 * shim comes first on PATH, which is not necessarily the MSVC one the release requires. So instead of
 * trusting PATH blindly, the MSVC toolchain is preferred when it is installed: an explicit
 * `CBPANEL_RUSTC` wins first, then the MSVC rustc found next to a documented layout, then PATH.
 */
export function resolveWindowsRustTarget() {
  const host = currentRustTarget();
  const requested = process.env.CBPANEL_RUST_TARGET?.trim();
  if (requested && requested !== host) {
    throw new Error(
      `Windows artifacts are built for the host target (${host}); Tauri runs without --target. ` +
        `Make ${requested} the default rustup toolchain, or build the release in CI.`,
    );
  }
  return host;
}

/**
 * Paths where a second Rust installation may live, checked only when the PATH `rustc` is not MSVC.
 *
 * These are the layouts scoop and rustup use on Windows. A candidate is accepted only when it reports
 * an msvc host, so a stale directory cannot silently change the build target.
 */
function msvcRustcCandidates() {
  const candidates = [];
  const explicit = process.env.CBPANEL_RUSTC?.trim();
  if (explicit) candidates.push(explicit);
  if (process.env.USERPROFILE || process.env.HOME) {
    const home = process.env.USERPROFILE ?? process.env.HOME;
    candidates.push(path.join(home, "scoop", "apps", "rust", "current", "bin", "rustc.exe"));
    candidates.push(path.join(home, ".cargo", "bin", "rustc.exe"));
  }
  return candidates;
}

/**
 * The rustc the build should actually use.
 *
 * Returns the PATH `rustc` when it is already the MSVC toolchain; otherwise the first installed MSVC
 * rustc among the known layouts, so `npm run sidecar:build` on this machine does not produce a GNU
 * sidecar just because `rust-gnu` sorts first in scoop's shims.
 */
export function selectWindowsRustc() {
  const onPath = process.env.CBPANEL_RUSTC?.trim() || "rustc";
  if (rustcHostTarget(onPath) === WINDOWS_RELEASE_RUST_TARGET) return onPath;
  for (const candidate of msvcRustcCandidates()) {
    if (rustcHostTarget(candidate) === WINDOWS_RELEASE_RUST_TARGET) return candidate;
  }
  return onPath;
}

function rustcHostTarget(command) {
  try {
    const output = execFileSync(command, ["-vV"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return output.split(/\r?\n/).find((line) => line.startsWith("host:"))?.slice("host:".length).trim();
  } catch {
    return undefined;
  }
}

/**
 * Put the selected MSVC toolchain first for this process and everything it spawns.
 *
 * Tauri and pkg invoke `cargo` themselves, so validating the target is not enough: the child has to
 * find the same rustc. Prepending its directory to PATH is what makes the shell compiled by
 * `npm run desktop:build` actually match the sidecar the panel looks for.
 */
export function applySelectedWindowsToolchain() {
  if (!isWindowsReleaseBuild()) return;
  const rustc = selectWindowsRustc();
  if (rustc === "rustc" || rustc === process.env.CBPANEL_RUSTC) return;
  const dir = path.dirname(rustc);
  const current = process.env.PATH ?? "";
  if (!current.split(path.delimiter).includes(dir)) {
    process.env.PATH = `${dir}${path.delimiter}${current}`;
  }
  process.env.CBPANEL_RUSTC = rustc;
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

/**
 * The triple every Windows release artifact is published for.
 *
 * The portable packager copies the sidecar verbatim, so its name carries the triple, and the shell
 * looks for the compiled triple first. Shipping a local `-gnu` host would therefore produce a package
 * the release pipeline never tests. Development builds stay free to use any host triple; only the
 * release entry points require this one.
 */
export const WINDOWS_RELEASE_RUST_TARGET = "x86_64-pc-windows-msvc";

/**
 * Whether this process should refuse anything but the MSVC triple.
 *
 * Every Windows build entry point calls this: `release:windows`, `desktop:build`, `desktop:portable`
 * and `sidecar:build`. Gating only the release script left the other three free to produce and pack a
 * `-gnu` sidecar from a GNU host — which is exactly how a local build ended up gnu while the docs say
 * MSVC. A development build may opt out explicitly with `CBPANEL_ALLOW_NON_MSVC=1`.
 */
export function isWindowsReleaseBuild() {
  return process.env.CBPANEL_ALLOW_NON_MSVC !== "1";
}

export function assertWindowsReleaseTarget(rustTarget) {
  if (!isWindowsReleaseBuild()) {
    console.log(`CBPANEL_ALLOW_NON_MSVC=1: accepting the non-MSVC target ${rustTarget} (local build only).`);
    return;
  }
  if (rustTarget === WINDOWS_RELEASE_RUST_TARGET) return;
  throw new Error(
    `Windows artifacts are built for ${WINDOWS_RELEASE_RUST_TARGET}, but the host rustc target is ${rustTarget}. ` +
      "Two Rust installations are on PATH — the scoop `rust-gnu` package wins over `rust` in scoop's shim " +
      "order. Put the MSVC toolchain first (or run the build from a shell where it is), or set " +
      "CBPANEL_ALLOW_NON_MSVC=1 for a local-only build that will not be published.",
  );
}

/**
 * Windows GNU builds link WebView2Loader dynamically and need its DLL next to the executable.
 * MSVC builds link WebView2LoaderStatic into the binary, so the DLL is neither produced nor used.
 * Tauri's NSIS bundler ships WebView2Loader.dll only for `-gnu` targets; `-gnullvm` is also a
 * non-MSVC environment and links the loader dynamically.
 */
export function windowsTargetNeedsWebView2Loader(rustTarget) {
  return isWindowsRustTarget(rustTarget) && (rustTarget.endsWith("-gnu") || rustTarget.endsWith("-gnullvm"));
}

export function isLinuxRustTarget(rustTarget) {
  return rustTarget === "x86_64-unknown-linux-gnu";
}

export function isMacRustTarget(rustTarget) {
  return rustTarget === "x86_64-apple-darwin" || rustTarget === "aarch64-apple-darwin";
}

export function macArtifactArchForRustTarget(rustTarget) {
  if (rustTarget === "x86_64-apple-darwin") return "x64";
  if (rustTarget === "aarch64-apple-darwin") return "arm64";
  throw new Error(`Unsupported macOS release target: ${rustTarget}`);
}

export function releasePlatformForRustTarget(rustTarget) {
  if (isWindowsRustTarget(rustTarget)) return "windows";
  if (isLinuxRustTarget(rustTarget)) return "linux";
  if (isMacRustTarget(rustTarget)) return "macos";
  throw new Error(`Unsupported release platform for Rust target: ${rustTarget}`);
}
