import type { TranslationKey } from "../i18n";
import type { ExtensionEntity } from "./entities";

/**
 * Every install state in one localized word. The registry's table and the environment editor's bind
 * list both show the same five states, so the mapping lives here rather than in either component —
 * importing it across those features would put the registry's display module in the editor's chunk.
 */
const installStateKeys: Record<ExtensionEntity["installState"], TranslationKey> = {
  "metadata-only": "extension.state.notInstalled",
  "download-pending": "extension.state.notInstalled",
  downloading: "extension.state.downloading",
  installed: "extension.state.installed",
  "update-available": "extension.state.updateAvailable",
  "local-missing": "extension.state.localMissing",
  "invalid-manifest": "extension.state.invalidManifest",
  "install-failed": "extension.state.installFailed",
};

export function extensionInstallStateLabel(
  state: ExtensionEntity["installState"],
  t: (key: TranslationKey) => string,
): string {
  return t(installStateKeys[state] ?? "extension.state.notInstalled");
}

/**
 * The last segment of a local directory path, for rows that must not print the whole path. Both
 * separators are handled because a stored Windows path can arrive on any host (backups, packages),
 * and a trailing separator is not a name.
 */
export function localPathBaseName(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "");
  const segment = trimmed.split(/[\\/]/).pop();
  return segment?.trim() || value.trim();
}

/**
 * The directories a launch would load for one environment, derived from the library alone.
 *
 * The preview, the effective-argv panel and the exported snippets are all pure functions of a
 * `BrowserProfile`, but the extension directories are a launch input rather than a stored field — the
 * extension service resolves them immediately before the browser starts. This is the same rule that
 * service applies (enabled, installed, has a local path), reproduced here so the read-only surfaces
 * show the argv the launch will produce instead of an argv missing its extension switches.
 *
 * An extension the library reports as installed but not yet verified on disk is still included: the
 * server drops it at launch time if the check fails, and a preview that promised a directory the
 * launch then refused would be the more misleading of the two.
 */
export function launchExtensionPaths(
  extensionIds: readonly string[],
  extensions: readonly ExtensionEntity[] | undefined,
): string[] {
  if (extensionIds.length === 0 || !extensions?.length) return [];
  const byId = new Map(extensions.map((extension) => [extension.id, extension]));
  return extensionIds
    .map((id) => byId.get(id))
    .filter((extension): extension is ExtensionEntity => Boolean(extension))
    .filter((extension) => extension.status === "enabled" && extension.installState === "installed" && extension.localPath)
    .map((extension) => extension.localPath as string);
}

/**
 * The profile a read-only surface should describe: the draft itself, plus the extension directories
 * the launch will actually carry. Extension directories are never stored on a profile any more, so
 * every preview that shows an argv has to join them in from the binding table the same way the
 * launcher does. A draft that was never saved has no bindings yet, which is exactly right — nothing
 * is bound until the profile exists.
 */
export function withLaunchExtensionPaths<T extends { id: string; runtime: { extensionPaths: string[] } }>(
  draft: T,
  environmentExtensionIds: readonly string[] | undefined,
  extensions: readonly ExtensionEntity[] | undefined,
): T {
  return {
    ...draft,
    runtime: { ...draft.runtime, extensionPaths: launchExtensionPaths(environmentExtensionIds ?? [], extensions) },
  };
}
