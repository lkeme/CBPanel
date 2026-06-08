import type { TranslationKey } from "../../i18n";
import type { BrowserProfile, PanelState, ProxySettings } from "../../shared/profile";
import { buildProxyUrl, parseProxyUrlInput } from "../../shared/profile";
import type { ProxyEntity } from "../../shared/entities";
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

export function profileNameValidationError(
  draft: BrowserProfile,
  profiles: BrowserProfile[],
  draftIsNew: boolean,
  t: (key: TranslationKey) => string,
): string {
  const key = profileNameKey(draft.name);
  if (!key) return t("form.profileNameRequired");
  const duplicate = profiles.some((profile) => profile.id !== draft.id && profileNameKey(profile.name) === key);
  if (duplicate || (draftIsNew && profiles.some((profile) => profileNameKey(profile.name) === key))) {
    return t("form.profileNameDuplicate");
  }
  return "";
}

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
