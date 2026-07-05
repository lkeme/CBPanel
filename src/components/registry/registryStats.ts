import type { Locale } from "../../i18n";
import type { NetworkCheckResult } from "../../shared/entities";
import { networkCheckSummaryText } from "../../shared/networkCheckDisplay";
import type { BrowserProfile, PanelState, ProfileMode, SessionSummary } from "../../shared/profile";
import { buildProxyUrl } from "../../shared/profile";

export type WorkbenchView = "runtimeCheck" | "profiles" | "groups" | "tags" | "proxies" | "extensions" | "trash" | "system";
export type StatusFilter = "all" | "running";
export type ProxyFilter = "all" | "enabled" | "disabled";
export type ModeFilter = "all" | ProfileMode;

export type ModuleStat = {
  id?: string;
  name: string;
  count: number;
  running: number;
  color?: string;
  description?: string;
  isDefault?: boolean;
  status?: string;
};

export type ExtensionModuleStat = {
  id?: string;
  name: string;
  count: number;
  profiles: number;
  status?: string;
  installState?: string;
};

export type ModuleStats = {
  groups: ModuleStat[];
  tags: ModuleStat[];
  proxies: ModuleStat[];
  extensions: ExtensionModuleStat[];
};

export function buildModuleStats(
  state: PanelState | null,
  sessionsByProfileId: Map<string, SessionSummary>,
  locale?: Locale,
): ModuleStats {
  const profiles = state?.profiles ?? [];
  const groups = new Map<string, { name: string; count: number; running: number }>();
  const tags = new Map<string, { name: string; count: number; running: number }>();
  const proxies = new Map<string, { name: string; count: number; running: number }>();
  const extensions = new Map<string, { name: string; count: number; profiles: Set<string> }>();

  for (const profile of profiles) {
    const running = isSessionActive(sessionsByProfileId.get(profile.id)) ? 1 : 0;
    const groupName = profile.group.trim() || "(default)";
    incrementStat(groups, groupName, running);
    for (const tag of profile.tags) incrementStat(tags, tag, running);
    if (buildProxyUrl(profile.proxy)) incrementStat(proxies, proxyDisplayName(profile), running);
    for (const extensionPath of profile.runtime.extensionPaths) {
      const name = extensionPath.trim();
      if (!name) continue;
      const current = extensions.get(name) ?? { name, count: 0, profiles: new Set<string>() };
      current.count += 1;
      current.profiles.add(profile.id);
      extensions.set(name, current);
    }
  }

  const legacyStats = {
    groups: sortStats([...groups.values()]),
    tags: sortStats([...tags.values()]),
    proxies: sortStats([...proxies.values()]),
    extensions: [...extensions.values()]
      .map((item) => ({ name: item.name, count: item.count, profiles: item.profiles.size }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name)),
  };

  if (!state) return legacyStats;

  const environments = state.environments ?? [];
  const activeEnvironmentIds = new Set(environments.filter((environment) => !environment.deletedAt).map((environment) => environment.id));
  const runningByEnvironmentId = (id: string) => (isSessionActive(sessionsByProfileId.get(id)) ? 1 : 0);

  return {
    groups: state.groups?.length
      ? sortStats(
          state.groups.map((group) => {
            const related = environments.filter((environment) => !environment.deletedAt && environment.groupId === group.id);
            return {
              id: group.id,
              name: group.name,
              count: related.length,
              running: related.reduce((count, environment) => count + runningByEnvironmentId(environment.id), 0),
              color: group.color,
              description: group.description,
              isDefault: group.isDefault,
              status: group.status,
            };
          }),
        )
      : legacyStats.groups,
    tags: state.tags?.length
      ? sortStats(
          state.tags.map((tag) => {
            const related = environments.filter((environment) => !environment.deletedAt && environment.tagIds.includes(tag.id));
            return {
              id: tag.id,
              name: tag.name,
              count: related.length,
              running: related.reduce((count, environment) => count + runningByEnvironmentId(environment.id), 0),
              color: tag.color,
              description: tag.description,
              status: tag.status,
            };
          }),
        )
      : legacyStats.tags,
    proxies: state.proxies?.length
      ? sortStats(
          state.proxies.map((proxy) => {
            const related = environments.filter((environment) => !environment.deletedAt && environment.proxyId === proxy.id);
            return {
              id: proxy.id,
              name: proxy.name || proxyDisplayNameFromParts(proxy.host, proxy.port),
              count: related.length,
              running: related.reduce((count, environment) => count + runningByEnvironmentId(environment.id), 0),
              description: networkCheckPlainText(proxy.lastCheck, locale),
              status: proxy.status,
            };
          }),
        )
      : legacyStats.proxies,
    extensions: state.extensions?.length
      ? state.extensions
          .map((extension) => {
            const related = environments.filter((environment) => !environment.deletedAt && environment.extensionIds.includes(extension.id));
            return {
              id: extension.id,
              name: extension.name,
              count: related.length,
              profiles: related.filter((environment) => activeEnvironmentIds.has(environment.id)).length,
              status: extension.status,
              installState: extension.installState,
            };
          })
          .sort((left, right) => right.profiles - left.profiles || left.name.localeCompare(right.name))
      : legacyStats.extensions,
  };
}

function incrementStat(map: Map<string, { name: string; count: number; running: number }>, name: string, running: number): void {
  const current = map.get(name) ?? { name, count: 0, running: 0 };
  current.count += 1;
  current.running += running;
  map.set(name, current);
}

function sortStats<T extends { name: string; count: number }>(items: T[]): T[] {
  return items.sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function isSessionActive(session?: SessionSummary): boolean {
  return session?.status === "running" || session?.status === "launching" || session?.status === "stopping";
}

function proxyDisplayName(profile: BrowserProfile): string {
  const proxyUrl = buildProxyUrl(profile.proxy);
  if (!proxyUrl) return "disabled";
  try {
    const url = new URL(proxyUrl.includes("://") ? proxyUrl : `${profile.proxy.scheme}://${proxyUrl}`);
    return `${url.hostname}${url.port ? `:${url.port}` : ""}`;
  } catch {
    return profile.proxy.host.trim() || proxyUrl;
  }
}

function proxyDisplayNameFromParts(host: string, port: string): string {
  const trimmedHost = host.trim();
  const trimmedPort = port.trim();
  if (!trimmedHost) return "proxy";
  return trimmedPort ? `${trimmedHost}:${trimmedPort}` : trimmedHost;
}

function networkCheckPlainText(check: NetworkCheckResult | undefined, locale?: Locale): string | undefined {
  return networkCheckSummaryText(check, {
    includeLatency: true,
    locale,
  }) || undefined;
}
