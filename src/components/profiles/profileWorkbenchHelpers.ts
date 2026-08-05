import type { TranslationKey } from "../../i18n";
import type { BrowserProfile, PanelState, ProxySettings } from "../../shared/profile";
import { buildProxyUrl, parseProxyUrlInput, validateStartUrl } from "../../shared/profile";
import type { ProxyEntity, TrashEnvironment } from "../../shared/entities";
import type { AppSettings } from "../../shared/settings";
import { normalizeSettings } from "../../shared/settings";
import type { WorkbenchView } from "../registry/registryStats";

export function selectedProxyIdForDraft(
  draft: BrowserProfile,
  environments: NonNullable<PanelState["environments"]>,
  draftProxyLibraryIds: Record<string, string>,
): string | undefined {
  const selectedProxyId = draftProxyLibraryIds[draft.id];
  if (selectedProxyId) return selectedProxyId;
  const environment = environments.find((item) => item.id === draft.id);
  return environment?.proxyId || undefined;
}

export function proxyNameFromSettings(proxy: ProxySettings): string {
  const host = proxy.host.trim();
  const port = proxy.port.trim();
  if (host && port) return `${host}:${port}`;
  if (host) return host;
  const proxyUrl = buildProxyUrl(proxy);
  if (proxyUrl) {
    try {
      const parsed = new URL(proxyUrl.includes("://") ? proxyUrl : `${proxy.scheme}://${proxyUrl}`);
      return parsed.host || "Proxy";
    } catch {
      return proxyUrl;
    }
  }
  return "Proxy";
}

export function workbenchViewTitleKey(view: WorkbenchView): TranslationKey {
  if (view === "runtimeCheck") return "browserCore.runtimeCheckTitle";
  if (view === "groups") return "module.groupsTitle";
  if (view === "tags") return "module.tagsTitle";
  if (view === "proxies") return "module.proxiesTitle";
  if (view === "extensions") return "module.extensionsTitle";
  if (view === "trash") return "module.trashTitle";
  if (view === "system") return "system.title";
  return "workspace.environmentTitle";
}

export function workbenchViewMetaKey(view: WorkbenchView): TranslationKey {
  if (view === "runtimeCheck") return "browserCore.runtimeCheckMeta";
  if (view === "groups") return "module.groupsMeta";
  if (view === "tags") return "module.tagsMeta";
  if (view === "proxies") return "module.proxiesMeta";
  if (view === "extensions") return "module.extensionsMeta";
  if (view === "trash") return "module.trashMeta";
  if (view === "system") return "system.diagnostics";
  return "workspace.tableTitle";
}

export function parseProxyInput(value: string, invalidMessage: string): Partial<ProxyEntity> {
  const proxy = parseProxyUrlInput(value);
  if (!proxy) {
    throw new Error(invalidMessage);
  }
  return {
    name: proxy.host,
    ...proxy,
    bypass: "localhost,127.0.0.1",
  };
}

export function sortProfiles(profiles: BrowserProfile[], settings: AppSettings): BrowserProfile[] {
  const sort = normalizeSettings(settings).table.sort;
  return [...profiles].sort((left, right) => {
    const direction = sort.direction === "asc" ? 1 : -1;
    const leftValue = sortValue(left, sort.columnId);
    const rightValue = sortValue(right, sort.columnId);
    return leftValue.localeCompare(rightValue) * direction;
  });
}

/**
 * Every name the store already counts as taken. The trash has to be in here: a soft-deleted environment
 * keeps its `profiles` row, so its name still holds even though `listProfiles()` no longer returns it —
 * leaving it out is what let the panel offer a name the store then refused with a 409.
 */
export function reservedProfileNames(profiles: BrowserProfile[], trash: TrashEnvironment[]): string[] {
  // `runtimeProfile.name` rather than `environment.name`, because the store's uniqueness check reads the
  // profile row this mirrors.
  return [...profiles.map((profile) => profile.name), ...trash.map((item) => item.environment.runtimeProfile.name)];
}

/**
 * First free name in the `base`, `base 2`, `base 3` … series, matching the store's copy-naming shape.
 * `existingNames` must come from `reservedProfileNames` so the trash counts. The loop is bounded by the
 * name count: `existingNames` names cannot occupy `existingNames.size + 2` distinct candidates, so it
 * always terminates on a real name and needs no random or timestamp suffix to escape.
 */
export function nextAvailableProfileName(baseName: string, existingNames: Iterable<string>): string {
  const base = baseName.trim() || "Profile";
  const taken = new Set([...existingNames].map(profileNameKey));
  let candidate = base;
  let index = 2;
  while (taken.has(profileNameKey(candidate))) {
    candidate = `${base} ${index}`;
    index += 1;
  }
  return candidate;
}

export function profileNameValidationError(
  draft: BrowserProfile,
  profiles: BrowserProfile[],
  draftIsNew: boolean,
  t: (key: TranslationKey) => string,
  // Required, with no default: an omitted trash is precisely the judgement gap this exists to close, and
  // a defaulted `[]` would let a new call site reintroduce it while still typechecking.
  trash: TrashEnvironment[],
): string {
  const key = profileNameKey(draft.name);
  if (!key) return t("form.profileNameRequired");
  // A new draft carries an id no stored record has, so nothing can be excused as "the same record".
  const takesTheName = (id: string, name: string): boolean => profileNameKey(name) === key && (draftIsNew || id !== draft.id);
  if (profiles.some((profile) => takesTheName(profile.id, profile.name))) return t("form.profileNameDuplicate");
  // The trash is judged separately because the generic "must be unique" sent users hunting for an occupier
  // the table cannot show: the name is held by a row only the trash view lists.
  if (trash.some((item) => takesTheName(item.environment.id, item.environment.runtimeProfile.name))) {
    return t("form.profileNameDuplicateInTrash");
  }
  return "";
}

export function profileStartUrlValidationError(draft: BrowserProfile, t: (key: TranslationKey) => string): string {
  const result = validateStartUrl(draft.startUrl);
  return result.ok ? "" : t("form.startUrlInvalid");
}

/** Kept in step with the store's `normalizeProfileNameKey`, or the panel and the 409 would disagree. */
function profileNameKey(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function sortValue(profile: BrowserProfile, columnId: string): string {
  switch (columnId) {
    case "name":
      return profile.name;
    case "group":
      return profile.group;
    case "mode":
      return profile.mode;
    case "launcher":
      return profile.runtime.launcher;
    case "startUrl":
      return profile.startUrl;
    case "ip":
      return profile.fingerprint.webrtcIpValue || profile.proxy.host || "";
    case "updatedAt":
      return profile.updatedAt;
    case "actions":
      return profile.updatedAt;
    default:
      return profile.updatedAt;
  }
}
