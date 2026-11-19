import { Suspense, lazy, useEffect, useRef, useState, type CSSProperties } from "react";
import {
  Activity,
  Archive,
  Clock3,
  Database,
  FilePlus2,
  FolderKanban,
  Info,
  Layers,
  MoreHorizontal,
  Network,
  RotateCcw,
  Rss,
  Search,
  Star,
  Tags,
  Trash2,
  X,
} from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { BinaryInfo } from "../../shared/browserCore";
import type {
  ExtensionEntity,
  ExtensionUpdatePolicy,
  GroupEntity,
  ProxyEntity,
  ProxySubscriptionEntity,
  TagEntity,
} from "../../shared/entities";
import { type PanelState, buildProxyUrl, maskProxyUrlForDisplay } from "../../shared/profile";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { LoadingSkeleton } from "../ui/LoadingSkeleton";
import { renderEntityStatus } from "./entityDisplay";
import { ExtensionRegistryPanel } from "./ExtensionRegistryPanel";
import { ProxySubscriptionPanel } from "./ProxySubscriptionPanel";
import { ProxyTableHeader, ProxyTableRow } from "./ProxyTable";
import { RegistryEntityRow, formatRelativeTime } from "./RegistryEntityRow";
import type { ModeFilter, ModuleStats, ProxyFilter, StatusFilter, WorkbenchView } from "./registryStats";
import { RegistryListShell } from "./RegistryModuleShell";
import { proxyHaystack, statHaystack, trashHaystack } from "./registrySearch";
import { RegistrySummaryStrip } from "./RegistrySummaryStrip";

const PROXY_PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const PROXY_PAGE_SIZE_DEFAULT = PROXY_PAGE_SIZE_OPTIONS[0];

const RuntimeCheckContent = lazy(() =>
  import("../runtime/RuntimeCheckContent").then((module) => ({ default: module.RuntimeCheckContent })),
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
  stats: ModuleStats;
  state: PanelState | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  toast: (kind: "success" | "error" | "info", text: string) => void;
  trash: PanelState["trash"];
  view: WorkbenchView;
  openBrowserCoreSettings: () => void;
  batchCheckProxies: (ids: string[]) => Promise<void>;
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
  addProxy: () => void | Promise<void>;
  installExtension: (extension: ExtensionEntity) => Promise<void>;
  mergeGroup: (group: GroupEntity) => void | Promise<void>;
  mergeTag: (tag: TagEntity) => void | Promise<void>;
  migrateExtensionIdentity: (extension: ExtensionEntity) => Promise<void>;
  newGroup: () => void;
  newTag: () => void;
  newProxySubscription: () => void | Promise<void>;
  refreshAllProxySubscriptions: () => Promise<void>;
  refreshProxySubscription: (subscription: ProxySubscriptionEntity) => Promise<void>;
  requestProxySubscriptionDelete: (subscription: ProxySubscriptionEntity, proxies: "keep" | "delete") => void;
  updateProxySubscription: (subscription: ProxySubscriptionEntity, patch: Partial<ProxySubscriptionEntity>) => Promise<void>;
  reinstallExtension: (extension: ExtensionEntity) => Promise<void>;
  permanentlyDeleteTrashEnvironment: (id: string, name: string) => Promise<void>;
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
  stats,
  state,
  t,
  locale,
  toast,
  trash,
  view,
  openBrowserCoreSettings,
  batchCheckProxies,
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
  addProxy,
  installExtension,
  mergeGroup,
  mergeTag,
  migrateExtensionIdentity,
  newProxySubscription,
  newGroup,
  newTag,
  refreshAllProxySubscriptions,
  refreshProxySubscription,
  reinstallExtension,
  permanentlyDeleteTrashEnvironment,
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
  /** A subscription the list is narrowed to, so two subscriptions with the same name never mix. */
  const [proxyScope, setProxyScope] = useState<{ id: string; name: string } | null>(null);
  const [proxyPageSize, setProxyPageSize] = useState<number>(PROXY_PAGE_SIZE_DEFAULT);

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
        emptyTitle={t("module.groupsEmptyTitle")}
        emptyBody={t("module.groupsEmptyBody")}
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
        emptyTitle={t("module.tagsEmptyTitle")}
        emptyBody={t("module.tagsEmptyBody")}
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
    // A scope survives an edit but not a delete: a removed subscription stops narrowing the list.
    const activeScope = proxyScope && subscriptionsById.has(proxyScope.id) ? proxyScope : null;
    const scopedProxies = activeScope ? proxies.filter((proxy) => proxy.subscriptionId === activeScope.id) : proxies;
    const scopedStats = activeScope ? stats.proxies.filter((stat) => proxiesById.get(stat.id ?? "")?.subscriptionId === activeScope.id) : stats.proxies;
    const inUseProxyIds = new Set(
      (state?.environments ?? []).filter((environment) => !environment.deletedAt && environment.proxyId).map((environment) => environment.proxyId as string),
    );
    // Disabled entries stay in the total but leave the health counts: a stopped proxy is neither
    // healthy nor failing, and colouring it by its last check would misreport the library.
    const enabledProxies = scopedProxies.filter((proxy) => proxy.status !== "disabled");
    const healthy = enabledProxies.filter((proxy) => proxy.lastCheck?.ok).length;
    const failing = enabledProxies.filter((proxy) => proxy.lastCheck && !proxy.lastCheck.ok).length;
    const unchecked = enabledProxies.length - healthy - failing;
    const subscribed = scopedProxies.filter((proxy) => proxy.subscriptionId).length;
    const subscriptionPanel = (
      <ProxySubscriptionPanel
        busy={busy}
        compact={proxies.length === 0 && subscriptions.length === 0}
        editSubscription={editProxySubscription}
        inUseIds={inUseProxyIds}
        locale={locale}
        newSubscription={newProxySubscription}
        proxies={proxies}
        refreshAll={refreshAllProxySubscriptions}
        refreshSubscription={refreshProxySubscription}
        requestDelete={requestProxySubscriptionDelete}
        showMembers={(subscription) => {
          setProxyScope({ id: subscription.id, name: subscription.name });
          setProxyQuery("");
        }}
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
        action={
          <div className="proxy-module-toolbar">
            <button className="command primary" disabled={busy === "proxy-import" || busy === "proxy-create"} onClick={() => void addProxy()} type="button">
              <FilePlus2 size={16} aria-hidden="true" />
              {t("actions.addProxy")}
            </button>
            {scopedProxies.length > 0 && (
              <div
                aria-label={t("proxy.health.summary", { total: scopedProxies.length, healthy, failing, unchecked })}
                className="proxy-health-summary"
                role="group"
              >
                <span className="proxy-health-count" title={t("registry.summary.proxies")}>{scopedProxies.length}</span>
                <span aria-hidden="true" className="proxy-health-separator">/</span>
                <span className="proxy-health-count is-ok" title={t("registry.summary.healthy")}>{healthy}</span>
                <span aria-hidden="true" className="proxy-health-separator">/</span>
                <span className="proxy-health-count is-error" title={t("registry.summary.failing")}>{failing}</span>
                <span aria-hidden="true" className="proxy-health-separator">/</span>
                <span className="proxy-health-count is-warning" title={t("registry.summary.unchecked")}>{unchecked}</span>
                {subscriptions.length > 0 && (
                  <span
                    className="proxy-health-subscription"
                    title={`${t("registry.summary.subscriptions")} · ${t("registry.summary.subscribed")} ${subscribed}`}
                  >
                    <Rss size={12} aria-hidden="true" />
                    {subscriptions.length}
                  </span>
                )}
              </div>
            )}
          </div>
        }
        items={scopedStats}
        haystack={(stat) => proxyHaystack(stat, proxiesById.get(stat.id ?? ""), subscriptionNameOf(proxiesById.get(stat.id ?? "")))}
        listClassName="proxy-table"
        listRole="table"
        listHeader={({ pagedItems }) => {
          const pageIds = pagedItems.map((stat) => stat.id).filter((id): id is string => Boolean(id) && proxiesById.has(id ?? ""));
          const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedProxyIds.has(id));
          return (
            <ProxyTableHeader
              allPageSelected={allPageSelected}
              t={t}
              togglePageSelected={() =>
                setSelectedProxyIds((current) => {
                  const next = new Set(current);
                  for (const id of pageIds) {
                    if (allPageSelected) next.delete(id);
                    else next.add(id);
                  }
                  return next;
                })
              }
            />
          );
        }}
        onQueryChange={setProxyQuery}
        query={proxyQuery}
        beforeListWhenEmpty
        pagination={{
          pageSize: proxyPageSize,
          pageSizeOptions: PROXY_PAGE_SIZE_OPTIONS,
          pageSizeLabel: t("table.pageSize"),
          onPageSizeChange: setProxyPageSize,
          prevLabel: t("table.prevPage"),
          nextLabel: t("table.nextPage"),
          indicator: (current, total) => t("table.pageIndicator", { current, total }),
          range: (start, end, total) => t("table.paginationRange", { start, end, total }),
        }}
        listToolbar={({ query, setQuery }) =>
          activeScope || scopedStats.length > 0 ? (
            <div className="proxy-table-toolbar">
              {activeScope && (
                <button className="command subtle proxy-scope-chip" onClick={() => setProxyScope(null)} title={t("proxy.scope.clear")} type="button">
                  <Rss size={14} aria-hidden="true" />
                  {t("proxy.scope.active", { name: activeScope.name })}
                  <X size={14} aria-hidden="true" />
                </button>
              )}
              {scopedStats.length > 0 && (
                <>
                  <label className="search-box registry-search" aria-label={t("module.proxySearchPlaceholder")}>
                    <Search size={16} aria-hidden="true" />
                    <input onChange={(event) => setQuery(event.target.value)} placeholder={t("module.proxySearchPlaceholder")} value={query} />
                  </label>
                  <div className="proxy-table-toolbar-actions">
                    {selectedIds.length > 0 && <strong>{t("proxy.batch.selected", { count: selectedIds.length })}</strong>}
                    <button className="command subtle" disabled={batchBusy || selectedIds.length === 0} onClick={() => void batchCheckProxies(selectedIds)} type="button">
                      <Activity size={15} aria-hidden="true" />
                      {t("proxy.batch.check")}
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
              )}
            </div>
          ) : null
        }
        beforeList={() => subscriptionPanel}
        searchPlaceholder={t("module.proxySearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.proxySummaryFiltered", { shown, total }) : t("module.proxySummaryTotal", { total })
        }
        emptyTitle={activeScope ? t("proxy.scope.emptyTitle", { name: activeScope.name }) : t("module.proxiesEmptyTitle")}
        emptyBody={activeScope ? t("proxy.scope.emptyBody") : t("module.proxiesEmptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(stat) => {
          const proxy = proxiesById.get(stat.id ?? "");
          return (
            <ProxyTableRow
              busy={busy}
              canReplace={proxies.some((item) => item.id !== stat.id)}
              checkManagedProxy={checkManagedProxy}
              duplicateProxy={duplicateProxy}
              editProxy={editProxy}
              key={stat.id ?? stat.name}
              preProxyName={proxy?.preProxyId ? proxiesById.get(proxy.preProxyId)?.name : undefined}
              proxy={proxy}
              requestProxyDelete={requestProxyDelete}
              requestProxyReference={requestProxyReference}
              selected={Boolean(proxy && selectedProxyIds.has(proxy.id))}
              showProfiles={showProfiles}
              stat={stat}
              subscription={proxy?.subscriptionId ? subscriptionsById.get(proxy.subscriptionId) : undefined}
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
