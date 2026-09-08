import React, { Suspense, lazy, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Activity,
  Archive,
  Clock3,
  Database,
  FilePlus2,
  FolderKanban,
  Gauge,
  Globe,
  Import,
  Info,
  Layers,
  MoreHorizontal,
  Network,
  RotateCcw,
  Rss,
  Star,
  Tags,
  Trash2,
  Waypoints,
} from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { BinaryInfo } from "../../shared/browserCore";
import type {
  ExtensionEntity,
  ExtensionUpdatePolicy,
  GroupEntity,
  ProxyEntity,
  ProxySubscriptionEntity,
  SystemDiagnostics,
  TagEntity,
} from "../../shared/entities";
import { networkCheckFlagEmoji, networkCheckSummaryText } from "../../shared/networkCheckDisplay";
import { type PanelState, buildProxyUrl, maskProxyUrlForDisplay } from "../../shared/profile";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";
import { describeXrayNode } from "../../shared/xray";
import { maskManagedProxyForDisplay } from "../profiles/proxyDisplay";
import { Checkbox } from "../ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { LoadingSkeleton } from "../ui/LoadingSkeleton";
import { StatusPill } from "../ui/StatusPill";
import { Switch } from "../ui/switch";
import { renderEntityStatus } from "./entityDisplay";
import { ExtensionRegistryPanel } from "./ExtensionRegistryPanel";
import { ProxySubscriptionPanel } from "./ProxySubscriptionPanel";
import { RegistryEntityRow, formatRelativeTime } from "./RegistryEntityRow";
import type { ModeFilter, ModuleStat, ModuleStats, ProxyFilter, StatusFilter, WorkbenchView } from "./registryStats";
import { RegistryListShell, RegistryModuleShell } from "./RegistryModuleShell";
import { proxyHaystack, statHaystack, trashHaystack } from "./registrySearch";
import { RegistrySummaryStrip } from "./RegistrySummaryStrip";

const PROXY_PAGE_SIZE = 25;

const RuntimeCheckContent = lazy(() =>
  import("../runtime/RuntimeCheckContent").then((module) => ({ default: module.RuntimeCheckContent })),
);
const SystemStatusContent = lazy(() =>
  import("../system/SystemStatusContent").then((module) => ({ default: module.SystemStatusContent })),
);

type ShowProfilePatch = {
  group?: string;
  query?: string;
  status?: StatusFilter;
  proxy?: ProxyFilter;
  proxyId?: string;
  mode?: ModeFilter;
  tags?: string[];
};

type RegistryModuleViewProps = {
  binaryInfo: BinaryInfo | null;
  browserCoreMissing: boolean;
  busy: string;
  copyDiagnostics: () => Promise<void>;
  diagnostics: SystemDiagnostics | null;
  exportDiagnostics: () => void;
  refreshBinary: () => Promise<void>;
  refreshDiagnostics: (proxyId?: string) => Promise<void>;
  runtime: DesktopRuntimeInfo | null;
  storage?: StorageInfo;
  stats: ModuleStats;
  state: PanelState | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  toast: (kind: "success" | "error" | "info", text: string) => void;
  trash: PanelState["trash"];
  view: WorkbenchView;
  openBrowserCoreSettings: () => void;
  batchCheckProxies: (ids: string[]) => Promise<void>;
  batchMeasureProxyLatency: (ids: string[]) => Promise<void>;
  checkManagedProxy: (proxy: ProxyEntity) => Promise<void>;
  clearTrashEnvironments: () => Promise<void>;
  deleteExtension: (extension: ExtensionEntity) => Promise<void>;
  duplicateProxy: (proxy: ProxyEntity) => Promise<void>;
  editGroup: (group: GroupEntity) => void;
  editProxy: (proxy: ProxyEntity) => Promise<void>;
  editProxySubscription: (subscription: ProxySubscriptionEntity) => Promise<void>;
  editTag: (tag: TagEntity) => void;
  checkExtension: (extension: ExtensionEntity) => Promise<void>;
  checkExtensionUpdate: (extension: ExtensionEntity) => Promise<void>;
  showProfiles: (patch?: ShowProfilePatch) => void;
  importExtensionArchive: (kind: "zip" | "crx") => void | Promise<void>;
  importExtensionDirectory: () => void | Promise<void>;
  importProxies: () => void | Promise<void>;
  installExtension: (extension: ExtensionEntity) => Promise<void>;
  measureProxyLatency: (proxy: ProxyEntity) => Promise<void>;
  mergeGroup: (group: GroupEntity) => void | Promise<void>;
  mergeTag: (tag: TagEntity) => void | Promise<void>;
  migrateExtensionIdentity: (extension: ExtensionEntity) => Promise<void>;
  newGroup: () => void;
  newTag: () => void;
  newProxy: () => void | Promise<void>;
  newProxySubscription: () => void | Promise<void>;
  refreshAllProxySubscriptions: () => Promise<void>;
  refreshProxySubscription: (subscription: ProxySubscriptionEntity) => Promise<void>;
  requestProxySubscriptionDelete: (subscription: ProxySubscriptionEntity, proxies: "keep" | "delete") => void;
  updateProxySubscription: (subscription: ProxySubscriptionEntity, patch: Partial<ProxySubscriptionEntity>) => Promise<void>;
  reinstallExtension: (extension: ExtensionEntity) => Promise<void>;
  permanentlyDeleteTrashEnvironment: (id: string, name: string) => Promise<void>;
  pruneBrowserData: () => Promise<void>;
  reloadState: () => Promise<unknown>;
  requestBatchProxyDelete: (ids: string[]) => void;
  requestGroupDelete: (group: GroupEntity) => void;
  requestProxyDelete: (proxy: ProxyEntity) => void;
  requestProxyReference: (action: "replace" | "unbind", proxy: ProxyEntity) => void;
  requestTagDelete: (tag: TagEntity) => void;
  restoreTrashEnvironment: (id: string) => Promise<void>;
  runExtensionAutoChecks?: (extensions: ExtensionEntity[]) => Promise<void>;
  setExtensionUpdatePolicy: (extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) => Promise<void>;
  toggleExtensionStatus: (extension: ExtensionEntity) => Promise<void>;
  updateExtension: (extension: ExtensionEntity) => Promise<void>;
  updateGroup: (group: GroupEntity, patch: Partial<GroupEntity>) => Promise<void>;
  updateProxy: (proxy: ProxyEntity, patch: Partial<ProxyEntity>) => Promise<void>;
  updateTag: (tag: TagEntity, patch: Partial<TagEntity>) => Promise<void>;
};

export function RegistryModuleView({
  binaryInfo,
  browserCoreMissing,
  busy,
  copyDiagnostics,
  diagnostics,
  exportDiagnostics,
  refreshBinary,
  refreshDiagnostics,
  runtime,
  storage,
  stats,
  state,
  t,
  locale,
  toast,
  trash,
  view,
  openBrowserCoreSettings,
  batchCheckProxies,
  batchMeasureProxyLatency,
  checkManagedProxy,
  clearTrashEnvironments,
  deleteExtension,
  duplicateProxy,
  editGroup,
  editProxy,
  editProxySubscription,
  editTag,
  checkExtension,
  checkExtensionUpdate,
  showProfiles,
  importExtensionArchive,
  importExtensionDirectory,
  importProxies,
  installExtension,
  measureProxyLatency,
  mergeGroup,
  mergeTag,
  migrateExtensionIdentity,
  newProxy,
  newProxySubscription,
  newGroup,
  newTag,
  refreshAllProxySubscriptions,
  refreshProxySubscription,
  reinstallExtension,
  permanentlyDeleteTrashEnvironment,
  pruneBrowserData,
  reloadState,
  requestBatchProxyDelete,
  requestGroupDelete,
  requestProxyDelete,
  requestProxyReference,
  requestProxySubscriptionDelete,
  requestTagDelete,
  restoreTrashEnvironment,
  runExtensionAutoChecks,
  setExtensionUpdatePolicy,
  toggleExtensionStatus,
  updateExtension,
  updateGroup,
  updateProxy,
  updateProxySubscription,
  updateTag,
}: RegistryModuleViewProps) {
  const autoCheckStartedForVisit = useRef(false);
  const [selectedProxyIds, setSelectedProxyIds] = useState<Set<string>>(() => new Set());
  // Controlled so a subscription row can narrow the list to its own nodes.
  const [proxyQuery, setProxyQuery] = useState("");

  // A selection only ever names proxies that still exist; a batch delete or another tab's edit prunes it.
  useEffect(() => {
    const ids = new Set((state?.proxies ?? []).map((proxy) => proxy.id));
    setSelectedProxyIds((current) => {
      const next = new Set([...current].filter((id) => ids.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [state?.proxies]);

  useEffect(() => {
    if (view !== "extensions") {
      autoCheckStartedForVisit.current = false;
      return;
    }
    if (!runExtensionAutoChecks || autoCheckStartedForVisit.current) return;
    const extensions = state?.extensions;
    if (!extensions?.length) return;
    autoCheckStartedForVisit.current = true;
    // Enter-view once the list is available; runner has its own 60s throttle.
    void runExtensionAutoChecks(extensions);
  }, [view, state?.extensions, runExtensionAutoChecks]);
  if (view === "runtimeCheck") {
    return (
      <Suspense fallback={<LoadingSkeleton rows={4} />}>
        <RuntimeCheckContent
          binaryInfo={binaryInfo}
          browserCoreMissing={browserCoreMissing}
          busy={busy}
          openBrowserCoreSettings={openBrowserCoreSettings}
          t={t}
        />
      </Suspense>
    );
  }

  if (view === "groups") {
    const groups = state?.groups ?? [];
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const liveEnvironments = (state?.environments ?? []).filter((environment) => !environment.deletedAt);
    const totalEnvironments = liveEnvironments.length;
    const runningTotal = stats.groups.reduce((sum, group) => sum + group.running, 0);
    const withProxyTotal = liveEnvironments.filter((environment) => environment.proxyId).length;
    const defaultGroup = groups.find((group) => group.isDefault);
    return (
      <RegistryListShell
        icon={<FolderKanban size={19} />}
        title={t("module.groupsTitle")}
        body={t("module.groupsBody")}
        action={
          <button className="command primary" disabled={busy === "group-create"} onClick={newGroup} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.newGroup")}
          </button>
        }
        beforeList={() => (
          <RegistrySummaryStrip
            items={[
              { icon: <FolderKanban size={12} />, label: t("registry.summary.groups"), value: groups.length || stats.groups.length },
              { icon: <Layers size={12} />, label: t("registry.summary.environments"), value: totalEnvironments },
              { icon: <Activity size={12} />, label: t("registry.summary.running"), value: runningTotal, tone: runningTotal > 0 ? "running" : undefined },
              { icon: <Network size={12} />, label: t("registry.summary.withProxy"), value: withProxyTotal },
              { icon: <Star size={12} />, label: t("registry.summary.defaultGroup"), value: defaultGroup?.name ?? "-", title: defaultGroup?.name },
            ]}
          />
        )}
        items={stats.groups}
        haystack={statHaystack}
        listClassName="module-list entity-row-list"
        searchPlaceholder={t("module.groupSearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.groupSummaryFiltered", { shown, total }) : t("module.groupSummaryTotal", { total })
        }
        emptyTitle={t("module.emptyTitle")}
        emptyBody={t("module.emptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(group) => {
          const entity = group.id ? groupsById.get(group.id) : undefined;
          const members = entity
            ? liveEnvironments.filter((environment) => environment.groupId === entity.id)
            : liveEnvironments.filter((environment) => environment.runtimeProfile.group === group.name);
          const proxied = members.filter((environment) => environment.proxyId).length;
          const previews = members.slice(0, 5).map((environment) => environment.name);
          const canMerge = Boolean(entity) && !group.isDefault && groups.some((item) => item.id !== group.id);
          return (
            <RegistryEntityRow
              actions={
                entity ? (
                  <>
                    <button className="command subtle" disabled={busy === `group-update:${entity.id}`} onClick={() => editGroup(entity)} type="button">
                      {t("actions.edit")}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="entity-row-menu">
                        <DropdownMenuItem onSelect={() => showProfiles({ group: group.name })}>
                          {t("registry.viewEnvironments")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={group.isDefault || busy === `group-update:${entity.id}`}
                          onSelect={() => void updateGroup(entity, { status: entity.status === "disabled" ? "enabled" : "disabled" })}
                          title={group.isDefault ? t("module.defaultGroupLocked") : undefined}
                        >
                          {t(group.status === "disabled" ? "actions.enable" : "actions.disable")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canMerge || busy === `group-merge:${entity.id}`}
                          onSelect={() => void mergeGroup(entity)}
                          title={group.isDefault ? t("module.defaultGroupLocked") : canMerge ? undefined : t("module.noMergeTarget")}
                        >
                          {t("actions.merge")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="dropdown-menu-item-danger"
                          disabled={group.isDefault || busy === `group-delete:${entity.id}`}
                          onSelect={() => requestGroupDelete(entity)}
                          title={group.isDefault ? t("module.defaultGroupLocked") : undefined}
                        >
                          {t("actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : (
                  <button className="command subtle" onClick={() => showProfiles({ group: group.name })} type="button">
                    <Layers size={15} aria-hidden="true" />
                    {t("registry.viewEnvironments")}
                  </button>
                )
              }
              badges={
                <>
                  {group.isDefault && <span className="entity-badge default">{t("form.default")}</span>}
                  {entity && !group.isDefault && renderEntityStatus(entity.status, t)}
                </>
              }
              chips={[
                { icon: <Layers size={12} />, label: t("module.profileCount", { count: group.count }) },
                { icon: <Activity size={12} />, label: t("module.runningCount", { count: group.running }), tone: group.running > 0 ? "running" : "muted" },
                { icon: <Network size={12} />, label: t("registry.proxiedCount", { count: proxied }), tone: proxied > 0 ? "info" : "muted" },
              ]}
              color={group.color}
              description={group.description}
              disabled={group.status === "disabled"}
              key={group.id ?? group.name}
              kind="group"
              locale={locale}
              name={group.name}
              onOpen={() => showProfiles({ group: group.name })}
              openLabel={t("registry.viewEnvironments")}
              previewMore={Math.max(0, members.length - previews.length)}
              previews={previews}
              t={t}
              updatedAt={entity?.updatedAt}
              usage={{ count: members.length, total: totalEnvironments }}
            />
          );
        }}
      />
    );
  }

  if (view === "tags") {
    const tags = state?.tags ?? [];
    const tagsById = new Map(tags.map((tag) => [tag.id, tag]));
    const liveEnvironments = (state?.environments ?? []).filter((environment) => !environment.deletedAt);
    const totalEnvironments = liveEnvironments.length;
    const taggedTotal = liveEnvironments.filter((environment) => environment.tagIds.length > 0 || environment.runtimeProfile.tags.length > 0).length;
    const runningTotal = stats.tags.reduce((sum, tag) => sum + tag.running, 0);
    const topTag = stats.tags[0];
    return (
      <RegistryListShell
        icon={<Tags size={19} />}
        title={t("module.tagsTitle")}
        body={t("module.tagsBody")}
        action={
          <button className="command primary" disabled={busy === "tag-create"} onClick={newTag} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.newTag")}
          </button>
        }
        beforeList={() => (
          <RegistrySummaryStrip
            items={[
              { icon: <Tags size={12} />, label: t("registry.summary.tags"), value: tags.length || stats.tags.length },
              { icon: <Layers size={12} />, label: t("registry.summary.tagged"), value: taggedTotal },
              { icon: <Layers size={12} />, label: t("registry.summary.untagged"), value: Math.max(0, totalEnvironments - taggedTotal), tone: totalEnvironments - taggedTotal > 0 ? "warning" : undefined },
              { icon: <Activity size={12} />, label: t("registry.summary.running"), value: runningTotal, tone: runningTotal > 0 ? "running" : undefined },
              { icon: <Star size={12} />, label: t("registry.summary.topTag"), value: topTag && topTag.count > 0 ? `${topTag.name} · ${topTag.count}` : "-", title: topTag?.name },
            ]}
          />
        )}
        items={stats.tags}
        haystack={statHaystack}
        listClassName="module-list entity-row-list"
        searchPlaceholder={t("module.tagSearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.tagSummaryFiltered", { shown, total }) : t("module.tagSummaryTotal", { total })
        }
        emptyTitle={t("module.emptyTitle")}
        emptyBody={t("module.emptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(tag) => {
          const entity = tag.id ? tagsById.get(tag.id) : undefined;
          const members = entity
            ? liveEnvironments.filter((environment) => environment.tagIds.includes(entity.id))
            : liveEnvironments.filter((environment) => environment.runtimeProfile.tags.includes(tag.name));
          const proxied = members.filter((environment) => environment.proxyId).length;
          const previews = members.slice(0, 5).map((environment) => environment.name);
          const canMerge = Boolean(entity) && tags.some((item) => item.id !== tag.id);
          return (
            <RegistryEntityRow
              actions={
                entity ? (
                  <>
                    <button className="command subtle" disabled={busy === `tag-update:${entity.id}`} onClick={() => editTag(entity)} type="button">
                      {t("actions.edit")}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="entity-row-menu">
                        <DropdownMenuItem onSelect={() => showProfiles({ tags: [tag.name] })}>
                          {t("registry.viewEnvironments")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={busy === `tag-update:${entity.id}`}
                          onSelect={() => void updateTag(entity, { status: entity.status === "disabled" ? "enabled" : "disabled" })}
                        >
                          {t(tag.status === "disabled" ? "actions.enable" : "actions.disable")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={!canMerge || busy === `tag-merge:${entity.id}`}
                          onSelect={() => void mergeTag(entity)}
                          title={canMerge ? undefined : t("module.noMergeTarget")}
                        >
                          {t("actions.merge")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="dropdown-menu-item-danger"
                          disabled={busy === `tag-delete:${entity.id}`}
                          onSelect={() => requestTagDelete(entity)}
                        >
                          {t("actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                ) : (
                  <button className="command subtle" onClick={() => showProfiles({ tags: [tag.name] })} type="button">
                    <Layers size={15} aria-hidden="true" />
                    {t("registry.viewEnvironments")}
                  </button>
                )
              }
              badges={entity ? renderEntityStatus(entity.status, t) : undefined}
              chips={[
                { icon: <Layers size={12} />, label: t("module.profileCount", { count: tag.count }) },
                { icon: <Activity size={12} />, label: t("module.runningCount", { count: tag.running }), tone: tag.running > 0 ? "running" : "muted" },
                { icon: <Network size={12} />, label: t("registry.proxiedCount", { count: proxied }), tone: proxied > 0 ? "info" : "muted" },
              ]}
              color={tag.color}
              description={tag.description}
              disabled={tag.status === "disabled"}
              key={tag.id ?? tag.name}
              kind="tag"
              locale={locale}
              name={tag.name}
              onOpen={() => showProfiles({ tags: [tag.name] })}
              openLabel={t("registry.viewEnvironments")}
              previewMore={Math.max(0, members.length - previews.length)}
              previews={previews}
              t={t}
              updatedAt={entity?.updatedAt}
              usage={{ count: members.length, total: totalEnvironments }}
            />
          );
        }}
      />
    );
  }

  if (view === "proxies") {
    const proxies = state?.proxies ?? [];
    const proxiesById = new Map(proxies.map((proxy) => [proxy.id, proxy]));
    const subscriptions = state?.proxySubscriptions ?? [];
    const subscriptionsById = new Map(subscriptions.map((subscription) => [subscription.id, subscription]));
    const subscriptionNameOf = (proxy?: ProxyEntity) => (proxy?.subscriptionId ? subscriptionsById.get(proxy.subscriptionId)?.name : undefined);
    const inUseProxyIds = new Set(
      (state?.environments ?? []).filter((environment) => !environment.deletedAt && environment.proxyId).map((environment) => environment.proxyId as string),
    );
    const subscriptionPanel = (
      <ProxySubscriptionPanel
        busy={busy}
        editSubscription={editProxySubscription}
        inUseIds={inUseProxyIds}
        locale={locale}
        newSubscription={newProxySubscription}
        proxies={proxies}
        refreshAll={refreshAllProxySubscriptions}
        refreshSubscription={refreshProxySubscription}
        requestDelete={requestProxySubscriptionDelete}
        showMembers={(subscription) => setProxyQuery(subscription.name)}
        subscriptions={subscriptions}
        t={t}
        updateSubscription={updateProxySubscription}
      />
    );
    const selectedIds = [...selectedProxyIds].filter((id) => proxiesById.has(id));
    const batchBusy = busy === "proxy-batch";
    const toggleProxySelected = (id: string) => {
      setSelectedProxyIds((current) => {
        const next = new Set(current);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    };
    return (
      <RegistryListShell
        icon={<Network size={19} />}
        title={t("module.proxiesTitle")}
        body={t("module.proxiesBody")}
        action={
          <div className="row-actions">
            <button className="command subtle" disabled={busy === "proxy-import"} onClick={() => void importProxies()} type="button">
              <Import size={16} aria-hidden="true" />
              {t("actions.importProxies")}
            </button>
            <button className="command primary" disabled={busy === "proxy-create"} onClick={() => void newProxy()} type="button">
              <FilePlus2 size={16} aria-hidden="true" />
              {t("actions.newProxy")}
            </button>
          </div>
        }
        items={stats.proxies}
        haystack={(stat) => proxyHaystack(stat, proxiesById.get(stat.id ?? ""), subscriptionNameOf(proxiesById.get(stat.id ?? "")))}
        listClassName="module-list proxy-registry-list"
        onQueryChange={setProxyQuery}
        query={proxyQuery}
        beforeListWhenEmpty
        pagination={{
          pageSize: PROXY_PAGE_SIZE,
          prevLabel: t("table.prevPage"),
          nextLabel: t("table.nextPage"),
          indicator: (current, total) => t("table.pageIndicator", { current, total }),
          range: (start, end, total) => t("registry.paginationRange", { start, end, total }),
        }}
        beforeList={({ pagedItems }) => {
          if (stats.proxies.length === 0) return subscriptionPanel;
          const pageIds = pagedItems.map((stat) => stat.id).filter((id): id is string => Boolean(id) && proxiesById.has(id ?? ""));
          const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedProxyIds.has(id));
          const healthy = proxies.filter((proxy) => proxy.lastCheck?.ok).length;
          const failing = proxies.filter((proxy) => proxy.lastCheck && !proxy.lastCheck.ok).length;
          const unchecked = proxies.length - healthy - failing;
          const latencies = proxies.map((proxy) => proxy.lastLatency).filter((latency) => latency?.ok && typeof latency.latencyMs === "number") as Array<{ latencyMs: number }>;
          const averageLatency = latencies.length ? Math.round(latencies.reduce((sum, latency) => sum + latency.latencyMs, 0) / latencies.length) : undefined;
          const nodes = proxies.filter((proxy) => proxy.scheme === "xray").length;
          const subscribed = proxies.filter((proxy) => proxy.subscriptionId).length;
          return (
            <>
              <RegistrySummaryStrip
                items={[
                  { icon: <Network size={12} />, label: t("registry.summary.proxies"), value: proxies.length },
                  { icon: <Rss size={12} />, label: t("registry.summary.subscriptions"), value: subscriptions.length, title: t("registry.summary.subscribed") + ` ${subscribed}` },
                  { icon: <Activity size={12} />, label: t("registry.summary.healthy"), value: healthy, tone: healthy > 0 ? "running" : undefined },
                  { icon: <Activity size={12} />, label: t("registry.summary.failing"), value: failing, tone: failing > 0 ? "error" : undefined },
                  { icon: <Activity size={12} />, label: t("registry.summary.unchecked"), value: unchecked, tone: unchecked > 0 ? "warning" : undefined },
                  { icon: <Gauge size={12} />, label: t("registry.summary.avgLatency"), value: averageLatency === undefined ? "-" : `${averageLatency} ms` },
                  { icon: <Waypoints size={12} />, label: t("registry.summary.xrayNodes"), value: nodes, tone: nodes > 0 ? "info" : undefined },
                ]}
              />
              {subscriptionPanel}
              <div className={`batch-bar proxy-batch-bar${selectedIds.length > 0 ? " active" : ""}`}>
              <label className="proxy-batch-select-page">
                <Checkbox
                  aria-label={t("proxy.batch.selectPage")}
                  checked={allPageSelected}
                  onCheckedChange={(checked) =>
                    setSelectedProxyIds((current) => {
                      const next = new Set(current);
                      for (const id of pageIds) {
                        if (checked === true) next.add(id);
                        else next.delete(id);
                      }
                      return next;
                    })
                  }
                />
                <span>{t("proxy.batch.selectPage")}</span>
              </label>
              <strong>{t("proxy.batch.selected", { count: selectedIds.length })}</strong>
              <button className="command" disabled={batchBusy || selectedIds.length === 0} onClick={() => void batchCheckProxies(selectedIds)} type="button">
                <Activity size={15} aria-hidden="true" />
                {t("proxy.batch.check")}
              </button>
              <button className="command" disabled={batchBusy || selectedIds.length === 0} onClick={() => void batchMeasureProxyLatency(selectedIds)} type="button">
                <Gauge size={15} aria-hidden="true" />
                {t("proxy.batch.latency")}
              </button>
              <button className="command danger subtle" disabled={batchBusy || selectedIds.length === 0} onClick={() => requestBatchProxyDelete(selectedIds)} type="button">
                <Trash2 size={15} aria-hidden="true" />
                {t("batch.delete")}
              </button>
              {selectedIds.length > 0 && (
                <button className="command subtle" disabled={batchBusy} onClick={() => setSelectedProxyIds(new Set())} type="button">
                  {t("proxy.batch.clear")}
                </button>
              )}
            </div>
            </>
          );
        }}
        searchPlaceholder={t("module.proxySearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.proxySummaryFiltered", { shown, total }) : t("module.proxySummaryTotal", { total })
        }
        emptyTitle={t("module.emptyTitle")}
        emptyBody={t("module.emptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(stat) => {
          const proxy = proxiesById.get(stat.id ?? "");
          return (
            <ProxyRegistryRow
              busy={busy}
              canReplace={proxies.some((item) => item.id !== stat.id)}
              checkManagedProxy={checkManagedProxy}
              duplicateProxy={duplicateProxy}
              editProxy={editProxy}
              key={stat.id ?? stat.name}
              measureProxyLatency={measureProxyLatency}
              preProxyName={proxy?.preProxyId ? proxiesById.get(proxy.preProxyId)?.name : undefined}
              proxy={proxy}
              requestProxyDelete={requestProxyDelete}
              requestProxyReference={requestProxyReference}
              selected={Boolean(proxy && selectedProxyIds.has(proxy.id))}
              showProfiles={showProfiles}
              stat={stat}
              subscriptionName={subscriptionNameOf(proxy)}
              t={t}
              locale={locale}
              toggleSelected={toggleProxySelected}
              updateProxy={updateProxy}
            />
          );
        }}
      />
    );
  }

  if (view === "extensions") {
    return (
      <ExtensionRegistryPanel
        busy={busy}
        extensions={state?.extensions ?? []}
        extensionStats={stats.extensions}
        settings={state?.settings}
        locale={locale}
        t={t}
        toast={toast}
        checkExtension={checkExtension}
        checkExtensionUpdate={checkExtensionUpdate}
        deleteExtension={deleteExtension}
        importExtensionArchive={importExtensionArchive}
        importExtensionDirectory={importExtensionDirectory}
        installExtension={installExtension}
        migrateExtensionIdentity={migrateExtensionIdentity}
        reloadState={reloadState}
        reinstallExtension={reinstallExtension}
        setExtensionUpdatePolicy={setExtensionUpdatePolicy}
        showProfiles={() => showProfiles()}
        toggleExtensionStatus={toggleExtensionStatus}
        updateExtension={updateExtension}
      />
    );
  }

  if (view === "system") {
    return (
      <RegistryModuleShell icon={<Info size={19} />} title={t("system.title")} body={t("system.diagnostics")}>
        <Suspense fallback={<LoadingSkeleton rows={5} />}>
          <SystemStatusContent
            binaryInfo={binaryInfo}
            busy={busy}
            copyDiagnostics={copyDiagnostics}
            diagnostics={diagnostics}
            exportDiagnostics={exportDiagnostics}
            proxies={state?.proxies ?? []}
            pruneBrowserData={pruneBrowserData}
            refreshBinary={refreshBinary}
            refreshDiagnostics={refreshDiagnostics}
            runtime={runtime}
            state={state}
            storage={storage}
            t={t}
          />
        </Suspense>
      </RegistryModuleShell>
    );
  }

  const trashRows = (trash ?? []).map((entry) => {
    const deletedAtLabel = new Date(entry.deletedAt).toLocaleString();
    return { deletedAtLabel, entry, haystack: trashHaystack(entry, deletedAtLabel) };
  });
  const trashGroupsById = new Map((state?.groups ?? []).map((group) => [group.id, group]));
  const trashTagsById = new Map((state?.tags ?? []).map((tag) => [tag.id, tag]));
  const trashTagColors = new Map((state?.tags ?? []).map((tag) => [tag.name, tag.color]));
  const trashProxiesById = new Map((state?.proxies ?? []).map((proxy) => [proxy.id, proxy]));
  const now = Date.now();
  const recentlyDeleted = trashRows.filter((row) => now - Date.parse(row.entry.deletedAt) < 24 * 60 * 60_000).length;
  const withReason = trashRows.filter((row) => Boolean(row.entry.deleteReason)).length;
  const oldest = trashRows.reduce<string | undefined>(
    (current, row) => (!current || Date.parse(row.entry.deletedAt) < Date.parse(current) ? row.entry.deletedAt : current),
    undefined,
  );
  return (
    <RegistryListShell
      icon={<Archive size={19} />}
      title={t("module.trashTitle")}
      body={t("module.trashBody")}
      action={
        <button
          className="command danger subtle"
          disabled={trashRows.length === 0 || busy === "trash-clear"}
          onClick={() => void clearTrashEnvironments()}
          type="button"
        >
          <Trash2 size={16} aria-hidden="true" />
          {t("actions.emptyTrash")}
        </button>
      }
      beforeList={() => (
        <RegistrySummaryStrip
          items={[
            { icon: <Archive size={12} />, label: t("registry.summary.trashTotal"), value: trashRows.length },
            { icon: <Clock3 size={12} />, label: t("registry.summary.recentlyDeleted"), value: recentlyDeleted, tone: recentlyDeleted > 0 ? "warning" : undefined },
            { icon: <Info size={12} />, label: t("registry.summary.withReason"), value: withReason },
            { icon: <Clock3 size={12} />, label: t("registry.summary.oldestDeleted"), value: oldest ? formatRelativeTime(oldest, locale) : "-", title: oldest ? new Date(oldest).toLocaleString() : undefined },
          ]}
        />
      )}
      items={trashRows}
      haystack={(row) => row.haystack}
      listClassName="module-list trash-list"
      searchPlaceholder={t("module.trashSearchPlaceholder")}
      summaryText={(shown, total, filtered) =>
        filtered ? t("module.trashSummaryFiltered", { shown, total }) : t("module.trashSummaryTotal", { total })
      }
      emptyTitle={t("module.trashEmptyTitle")}
      emptyBody={t("module.trashEmptyBody")}
      emptyClassName="solid"
      filterEmptyTitle={t("module.filterEmptyTitle")}
      filterEmptyBody={t("module.filterEmptyBody")}
      filterResetLabel={t("actions.clearSearch")}
      renderItem={({ deletedAtLabel, entry }) => {
        const environment = entry.environment;
        const group = trashGroupsById.get(environment.groupId);
        const groupName = group?.name ?? environment.runtimeProfile.group;
        const tagNames = environment.tagIds.map((id) => trashTagsById.get(id)?.name).filter((name): name is string => Boolean(name));
        const tags = tagNames.length > 0 ? tagNames : environment.runtimeProfile.tags;
        const proxy = environment.proxyId ? trashProxiesById.get(environment.proxyId) : undefined;
        const proxyUrl = buildProxyUrl(environment.runtimeProfile.proxy);
        const proxyLabel = proxy ? proxy.name : proxyUrl ? maskProxyUrlForDisplay(proxyUrl) : "";
        const persistent = environment.mode === "persistent";
        return (
          <div className="trash-row" key={environment.id}>
            <span className="trash-row-tile">
              <Archive size={16} aria-hidden="true" />
            </span>
            <div className="trash-row-body">
              <div className="trash-row-line">
                <strong title={environment.name}>{environment.name}</strong>
                {groupName && (
                  <span className="group-chip" style={entityColorStyle(group?.color)} title={groupName}>
                    <span className="color-dot" aria-hidden="true" />
                    {groupName}
                  </span>
                )}
                <span className={`mode-cell ${environment.mode}`} title={t(persistent ? "mode.persistent" : "mode.ephemeral")}>
                  {persistent ? <Database size={12} aria-hidden="true" /> : <Clock3 size={12} aria-hidden="true" />}
                  {t(persistent ? "mode.persistent" : "mode.ephemeral")}
                </span>
                {tags.slice(0, 3).map((tag) => (
                  <span className="tag tag-colored" key={tag} style={entityColorStyle(trashTagColors.get(tag))}>
                    {tag}
                  </span>
                ))}
                {tags.length > 3 && (
                  <span className="tag muted" title={tags.slice(3).join(", ")}>
                    +{tags.length - 3}
                  </span>
                )}
              </div>
              <div className="trash-row-line">
                <small title={deletedAtLabel}>
                  <Clock3 size={12} aria-hidden="true" />
                  {t("module.deletedAt")}: {formatRelativeTime(entry.deletedAt, locale)} · {deletedAtLabel}
                </small>
                {entry.deleteReason && (
                  <small className="trash-row-reason" title={entry.deleteReason}>
                    <Info size={12} aria-hidden="true" />
                    {t("module.deleteReason")}: {entry.deleteReason}
                  </small>
                )}
                {proxyLabel && (
                  <small title={proxyLabel}>
                    <Network size={12} aria-hidden="true" />
                    {proxyLabel}
                  </small>
                )}
                {environment.notes && <small title={environment.notes}>{environment.notes}</small>}
              </div>
            </div>
            <div className="trash-row-actions">
              <button
                className="command subtle"
                disabled={busy === `trash-restore:${environment.id}`}
                onClick={() => void restoreTrashEnvironment(environment.id)}
                type="button"
              >
                <RotateCcw size={15} aria-hidden="true" />
                {t("actions.restore")}
              </button>
              <button
                className="command danger subtle"
                disabled={busy === `trash-delete:${environment.id}`}
                onClick={() => void permanentlyDeleteTrashEnvironment(environment.id, environment.name)}
                type="button"
              >
                <Trash2 size={15} aria-hidden="true" />
                {t("actions.permanentDelete")}
              </button>
            </div>
          </div>
        );
      }}
    />
  );
}

function entityColorStyle(color: string | undefined): CSSProperties | undefined {
  return color ? ({ "--entity-color": color } as CSSProperties) : undefined;
}

function ProxyRegistryRow({
  busy,
  canReplace,
  checkManagedProxy,
  duplicateProxy,
  editProxy,
  measureProxyLatency,
  preProxyName,
  proxy,
  requestProxyDelete,
  requestProxyReference,
  selected,
  showProfiles,
  stat,
  subscriptionName,
  t,
  locale,
  toggleSelected,
  updateProxy,
}: {
  busy: string;
  canReplace: boolean;
  checkManagedProxy: (proxy: ProxyEntity) => Promise<void>;
  duplicateProxy: (proxy: ProxyEntity) => Promise<void>;
  editProxy: (proxy: ProxyEntity) => Promise<void>;
  measureProxyLatency: (proxy: ProxyEntity) => Promise<void>;
  preProxyName?: string;
  proxy?: ProxyEntity;
  requestProxyDelete: (proxy: ProxyEntity) => void;
  requestProxyReference: (action: "replace" | "unbind", proxy: ProxyEntity) => void;
  selected: boolean;
  showProfiles: (patch?: { proxyId?: string; proxy?: ProxyFilter }) => void;
  stat: ModuleStat;
  /** The remembered subscription this entry belongs to, if any. */
  subscriptionName?: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  toggleSelected: (proxyId: string) => void;
  updateProxy: (proxy: ProxyEntity, patch: Partial<ProxyEntity>) => Promise<void>;
}) {
  const check = proxy?.lastCheck;
  const address = proxy ? `${proxy.scheme}://${proxy.host}:${proxy.port}` : stat.name;
  const hasReferences = stat.count > 0;
  const protocol = proxy?.xrayNode?.protocol ?? (proxy?.scheme === "socks5" ? "socks" : "http");
  const badge = proxy?.xrayNode ? `XRAY · ${proxy.xrayNode.protocol.toUpperCase()}` : proxy?.scheme.toUpperCase() ?? "-";
  const disabled = proxy?.status === "disabled";
  const health: "ok" | "error" | "pending" = check ? (check.ok ? "ok" : "error") : "pending";
  const healthTitle = check
    ? check.ok
      ? networkCheckSummaryText(check, { emptyText: t("table.ipUnchecked"), includeFlag: true, locale })
      : check.error ?? t("proxy.check.failed")
    : t("module.proxyUnchecked");
  const flag = check?.ok ? networkCheckFlagEmoji(check) : "";
  const region = check?.ok ? check.geo?.countryCode ?? check.trace?.loc?.toUpperCase() : undefined;
  const tone = health === "error" ? "error" : disabled ? "muted" : "ready";
  const KindIcon = proxy?.xrayNode ? Waypoints : proxy?.scheme === "socks5" ? Network : Globe;

  // The extension rows' language: an icon tile with a health dot, a bold headline with coloured
  // badges, a meta line, a switch and the actions — so the two registries read as one product.
  return (
    <div className={`module-list-row managed proxy-registry-row tone-${tone}${selected ? " selected" : ""}`}>
      <Checkbox
        aria-label={t("proxy.batch.selectOne")}
        checked={selected}
        className="proxy-registry-select"
        disabled={!proxy}
        onCheckedChange={() => proxy && toggleSelected(proxy.id)}
      />
      <span className={`proxy-registry-icon protocol-${protocol}`}>
        <KindIcon size={18} aria-hidden="true" />
        <span className={`proxy-registry-health is-${health}`} role="img" aria-label={healthTitle} title={healthTitle} />
        {proxy?.preProxyId && (
          <span className="proxy-registry-corner" title={t("proxy.xray.chained", { name: preProxyName ?? proxy.preProxyId })}>
            {t("proxy.badge.chain")}
          </span>
        )}
      </span>
      <div className="proxy-registry-body">
        <div className="proxy-registry-line headline">
          <strong className="proxy-registry-name" title={proxy?.name ?? stat.name}>{proxy?.name ?? stat.name}</strong>
          <span className={`proxy-registry-badge protocol-${protocol}`}>{badge}</span>
          {subscriptionName && (
            <span className="proxy-registry-subscription" title={t("subscription.member", { name: subscriptionName })}>
              <Rss size={11} aria-hidden="true" />
              {subscriptionName}
            </span>
          )}
          {flag && (
            <span className="proxy-registry-flag" title={healthTitle}>
              {flag} {region}
            </span>
          )}
          <small className="mono-cell proxy-registry-address" title={address}>{maskManagedProxyForDisplay(proxy, address)}</small>
        </div>
        <div className="proxy-registry-line secondary">
          {proxyCheckSummary(check, t, locale)}
          {proxyLatencySummary(proxy?.lastLatency, t)}
          {proxy?.xrayNode && <small>{describeXrayNode(proxy.xrayNode)}</small>}
          {proxy?.preProxyId && <small>{t("proxy.xray.chained", { name: preProxyName ?? proxy.preProxyId })}</small>}
          <small>{proxy?.username ? t("proxy.credentials.saved") : t("proxy.credentials.none")}</small>
          {proxy?.notes && <small className="proxy-registry-notes" title={proxy.notes}>{proxy.notes}</small>}
        </div>
      </div>
      <button
        className="module-count-button"
        disabled={!proxy || stat.count === 0}
        onClick={() => proxy && showProfiles({ proxyId: proxy.id })}
        title={stat.count === 0 ? t("module.noReferences") : undefined}
        type="button"
      >
        <strong>{t("module.profileCount", { count: stat.count })}</strong>
        <small>{t("module.runningCount", { count: stat.running })}</small>
      </button>
      {proxy && (
        <div className="module-row-actions proxy-row-actions">
          <Switch
            aria-label={t("proxy.editor.status")}
            checked={!disabled}
            className="proxy-registry-switch"
            disabled={busy === `proxy-update:${proxy.id}`}
            onCheckedChange={() => void updateProxy(proxy, { status: disabled ? "enabled" : "disabled" })}
            title={t(disabled ? "actions.enable" : "actions.disable")}
          />
          <button className="command subtle" disabled={busy === `proxy-load:${proxy.id}`} onClick={() => void editProxy(proxy)} type="button">
            {t("actions.edit")}
          </button>
          <button className="command subtle" disabled={busy === `proxy-check:${proxy.id}` || busy === "proxy-batch"} onClick={() => void checkManagedProxy(proxy)} type="button">
            {t("actions.check")}
          </button>
          <button className="command subtle" disabled={busy === `proxy-latency:${proxy.id}` || busy === "proxy-batch"} onClick={() => void measureProxyLatency(proxy)} type="button">
            {t("actions.latency")}
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                <MoreHorizontal size={16} aria-hidden="true" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="proxy-row-menu">
              <DropdownMenuItem disabled={busy === `proxy-duplicate:${proxy.id}`} onSelect={() => void duplicateProxy(proxy)}>
                {t("actions.duplicate")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canReplace || !hasReferences || busy === `proxy-replace:${proxy.id}`}
                onSelect={() => requestProxyReference("replace", proxy)}
                title={!canReplace ? t("module.noReplaceTarget") : !hasReferences ? t("module.noReferences") : undefined}
              >
                {t("actions.replaceReferences")}
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!hasReferences || busy === `proxy-unbind:${proxy.id}`}
                onSelect={() => requestProxyReference("unbind", proxy)}
                title={!hasReferences ? t("module.noReferences") : undefined}
              >
                {t("actions.unbindReferences")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="dropdown-menu-item-danger"
                disabled={busy === `proxy-delete:${proxy.id}`}
                onSelect={() => requestProxyDelete(proxy)}
              >
                {t("actions.delete")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}
    </div>
  );
}

function proxyLatencySummary(
  latency: ProxyEntity["lastLatency"],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): React.ReactNode {
  if (!latency) return null;
  if (latency.ok) {
    const ms = latency.latencyMs ?? 0;
    const speed = ms < 150 ? "good" : ms < 400 ? "fair" : "slow";
    return <StatusPill className={`latency-pill latency-${speed}`} tone="neutral" title={latency.target}>{`⏱ ${ms} ms`}</StatusPill>;
  }
  return <StatusPill tone="error" title={latency.error}>{`⏱ ${t("proxy.latency.failed")}`}</StatusPill>;
}

function proxyCheckSummary(
  check: ProxyEntity["lastCheck"],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: Locale,
): React.ReactNode {
  if (!check) return <StatusPill tone="stopped">{t("module.proxyUnchecked")}</StatusPill>;
  if (check.ok) {
    return (
      <StatusPill tone="running">
        {networkCheckSummaryText(check, {
          emptyText: t("table.ipUnchecked"),
          failedText: t("proxy.check.failed"),
          includeFlag: true,
          locale,
          successPrefix: "✅",
        })}
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="error">
      {networkCheckSummaryText(check, {
        failedText: t("proxy.check.failed"),
        failurePrefix: "❌",
        locale,
      })}
    </StatusPill>
  );
}

