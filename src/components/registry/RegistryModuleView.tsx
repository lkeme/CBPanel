import React, { Suspense, lazy, useEffect, useRef } from "react";
import { Archive, FilePlus2, FolderKanban, Info, MoreHorizontal, Network, RotateCcw, Tags, Trash2 } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { BinaryInfo } from "../../shared/browserCore";
import type {
  ExtensionEntity,
  ExtensionSourceEntity,
  ExtensionUpdatePolicy,
  GroupEntity,
  ProxyEntity,
  SystemDiagnostics,
  TagEntity,
} from "../../shared/entities";
import { networkCheckSummaryText } from "../../shared/networkCheckDisplay";
import type { PanelState } from "../../shared/profile";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";
import { maskManagedProxyForDisplay } from "../profiles/proxyDisplay";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { LoadingSkeleton } from "../ui/LoadingSkeleton";
import { StatusPill } from "../ui/StatusPill";
import { renderEntityStatus } from "./entityDisplay";
import { ExtensionRegistryPanel } from "./ExtensionRegistryPanel";
import type { ModeFilter, ModuleStat, ModuleStats, ProxyFilter, StatusFilter, WorkbenchView } from "./registryStats";
import { RegistryListShell, RegistryModuleShell } from "./RegistryModuleShell";
import { proxyHaystack, statHaystack, trashHaystack } from "./registrySearch";

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
  refreshDiagnostics: () => Promise<void>;
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
  checkManagedProxy: (proxy: ProxyEntity) => Promise<void>;
  clearTrashEnvironments: () => Promise<void>;
  deleteExtension: (extension: ExtensionEntity) => Promise<void>;
  deleteExtensionSource: (source: ExtensionSourceEntity) => Promise<void>;
  duplicateProxy: (proxy: ProxyEntity) => Promise<void>;
  editGroup: (group: GroupEntity) => void;
  editProxy: (proxy: ProxyEntity) => Promise<void>;
  editTag: (tag: TagEntity) => void;
  editExtensionSource: (source: ExtensionSourceEntity) => void | Promise<void>;
  addExtensionSource: () => void | Promise<void>;
  addRemoteExtension: () => void | Promise<void>;
  checkExtension: (extension: ExtensionEntity) => Promise<void>;
  checkExtensionUpdate: (extension: ExtensionEntity) => Promise<void>;
  showProfiles: (patch?: ShowProfilePatch) => void;
  importExtensionArchive: (kind: "zip" | "crx") => void | Promise<void>;
  importExtensionDirectory: () => void | Promise<void>;
  installExtension: (extension: ExtensionEntity) => Promise<void>;
  mergeGroup: (group: GroupEntity) => void | Promise<void>;
  mergeTag: (tag: TagEntity) => void | Promise<void>;
  migrateExtensionIdentity: (extension: ExtensionEntity) => Promise<void>;
  newGroup: () => void;
  newTag: () => void;
  newProxy: () => void | Promise<void>;
  reinstallExtension: (extension: ExtensionEntity) => Promise<void>;
  permanentlyDeleteTrashEnvironment: (id: string, name: string) => Promise<void>;
  pruneBrowserData: () => Promise<void>;
  refreshExtensionSource: (source: ExtensionSourceEntity) => Promise<void>;
  requestGroupDelete: (group: GroupEntity) => void;
  requestProxyDelete: (proxy: ProxyEntity) => void;
  requestProxyReference: (action: "replace" | "unbind", proxy: ProxyEntity) => void;
  requestTagDelete: (tag: TagEntity) => void;
  restoreTrashEnvironment: (id: string) => Promise<void>;
  runExtensionAutoChecks?: (extensions: ExtensionEntity[]) => Promise<void>;
  setExtensionUpdatePolicy: (extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) => Promise<void>;
  toggleExtensionSourceStatus: (source: ExtensionSourceEntity) => Promise<void>;
  toggleExtensionSourceUnsigned: (source: ExtensionSourceEntity) => Promise<void>;
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
  checkManagedProxy,
  clearTrashEnvironments,
  deleteExtension,
  deleteExtensionSource,
  duplicateProxy,
  editGroup,
  editProxy,
  editTag,
  editExtensionSource,
  addExtensionSource,
  addRemoteExtension,
  checkExtension,
  checkExtensionUpdate,
  showProfiles,
  importExtensionArchive,
  importExtensionDirectory,
  installExtension,
  mergeGroup,
  mergeTag,
  migrateExtensionIdentity,
  newProxy,
  newGroup,
  newTag,
  reinstallExtension,
  permanentlyDeleteTrashEnvironment,
  pruneBrowserData,
  refreshExtensionSource,
  requestGroupDelete,
  requestProxyDelete,
  requestProxyReference,
  requestTagDelete,
  restoreTrashEnvironment,
  runExtensionAutoChecks,
  setExtensionUpdatePolicy,
  toggleExtensionSourceStatus,
  toggleExtensionSourceUnsigned,
  toggleExtensionStatus,
  updateExtension,
  updateGroup,
  updateProxy,
  updateTag,
}: RegistryModuleViewProps) {
  const autoCheckStartedForVisit = useRef(false);

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
        items={stats.groups}
        haystack={statHaystack}
        listClassName="module-card-grid group-tile-grid"
        searchPlaceholder={t("module.groupSearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.groupSummaryFiltered", { shown, total }) : t("module.groupSummaryTotal", { total })
        }
        emptyTitle={t("module.emptyTitle")}
        emptyBody={t("module.emptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(group) => (
          <div className="module-card managed group-tile" key={group.id ?? group.name}>
            <button className="group-tile-main" onClick={() => showProfiles({ group: group.name })} type="button">
              <span className="group-tile-icon" style={group.color ? { color: group.color } : undefined} aria-hidden="true">
                <FolderKanban size={18} />
              </span>
              <span className="group-tile-copy">
                <strong>{group.name}</strong>
                <small>
                  {t("module.profileCount", { count: group.count })} · {t("module.runningCount", { count: group.running })}
                </small>
                {group.description && <small>{group.description}</small>}
              </span>
              <span className="group-tile-status">{group.isDefault ? <StatusPill tone="stopped">{t("form.default")}</StatusPill> : renderEntityStatus(group.status, t)}</span>
            </button>
            {group.id && (
              <div className="module-row-actions group-tile-actions">
                <button
                  className="command subtle"
                  disabled={busy === `group-update:${group.id}`}
                  onClick={() => {
                    const entity = groups.find((item) => item.id === group.id);
                    if (entity) editGroup(entity);
                  }}
                  type="button"
                >
                  {t("actions.edit")}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="group-tile-menu">
                    <DropdownMenuItem
                      disabled={group.isDefault || busy === `group-update:${group.id}`}
                      onSelect={() => {
                        const entity = groups.find((item) => item.id === group.id);
                        if (entity) void updateGroup(entity, { status: entity.status === "disabled" ? "enabled" : "disabled" });
                      }}
                      title={group.isDefault ? t("module.defaultGroupLocked") : undefined}
                    >
                      {t(group.status === "disabled" ? "actions.enable" : "actions.disable")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={group.isDefault || !groups.some((item) => item.id !== group.id) || busy === `group-merge:${group.id}`}
                      onSelect={() => {
                        const entity = groups.find((item) => item.id === group.id);
                        if (entity) void mergeGroup(entity);
                      }}
                      title={
                        group.isDefault
                          ? t("module.defaultGroupLocked")
                          : groups.some((item) => item.id !== group.id)
                            ? undefined
                            : t("module.noMergeTarget")
                      }
                    >
                      {t("actions.merge")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="dropdown-menu-item-danger"
                      disabled={group.isDefault || busy === `group-delete:${group.id}`}
                      onSelect={() => {
                        const entity = groups.find((item) => item.id === group.id);
                        if (entity) requestGroupDelete(entity);
                      }}
                      title={group.isDefault ? t("module.defaultGroupLocked") : undefined}
                    >
                      {t("actions.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        )}
      />
    );
  }

  if (view === "tags") {
    const tags = state?.tags ?? [];
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
        items={stats.tags}
        haystack={statHaystack}
        listClassName="module-chip-grid tag-tile-grid"
        searchPlaceholder={t("module.tagSearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.tagSummaryFiltered", { shown, total }) : t("module.tagSummaryTotal", { total })
        }
        emptyTitle={t("module.emptyTitle")}
        emptyBody={t("module.emptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(tag) => (
          <div className="module-chip managed tag-tile" key={tag.id ?? tag.name}>
            <button className="tag-tile-main" onClick={() => showProfiles({ tags: [tag.name] })} type="button">
              <span className="tag-tile-dot" style={tag.color ? { backgroundColor: tag.color } : undefined} aria-hidden="true" />
              <span className="tag-tile-copy">
                <strong>{tag.name}</strong>
                <small>
                  {t("module.profileCount", { count: tag.count })} · {t("module.runningCount", { count: tag.running })}
                </small>
                {tag.description && <small>{tag.description}</small>}
              </span>
              {tag.status && <span className="tag-tile-status">{renderEntityStatus(tag.status, t)}</span>}
            </button>
            {tag.id && (
              <div className="module-row-actions tag-tile-actions">
                <button
                  className="command subtle"
                  disabled={busy === `tag-update:${tag.id}`}
                  onClick={() => {
                    const entity = tags.find((item) => item.id === tag.id);
                    if (entity) editTag(entity);
                  }}
                  type="button"
                >
                  {t("actions.edit")}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="tag-tile-menu">
                    <DropdownMenuItem
                      disabled={busy === `tag-update:${tag.id}`}
                      onSelect={() => {
                        const entity = tags.find((item) => item.id === tag.id);
                        if (entity) void updateTag(entity, { status: entity.status === "disabled" ? "enabled" : "disabled" });
                      }}
                    >
                      {t(tag.status === "disabled" ? "actions.enable" : "actions.disable")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={!tags.some((item) => item.id !== tag.id) || busy === `tag-merge:${tag.id}`}
                      onSelect={() => {
                        const entity = tags.find((item) => item.id === tag.id);
                        if (entity) void mergeTag(entity);
                      }}
                      title={tags.some((item) => item.id !== tag.id) ? undefined : t("module.noMergeTarget")}
                    >
                      {t("actions.merge")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      className="dropdown-menu-item-danger"
                      disabled={busy === `tag-delete:${tag.id}`}
                      onSelect={() => {
                        const entity = tags.find((item) => item.id === tag.id);
                        if (entity) requestTagDelete(entity);
                      }}
                    >
                      {t("actions.delete")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            )}
          </div>
        )}
      />
    );
  }

  if (view === "proxies") {
    const proxies = state?.proxies ?? [];
    return (
      <RegistryListShell
        icon={<Network size={19} />}
        title={t("module.proxiesTitle")}
        body={t("module.proxiesBody")}
        action={
          <button className="command primary" disabled={busy === "proxy-create"} onClick={() => void newProxy()} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.newProxy")}
          </button>
        }
        items={stats.proxies}
        haystack={(stat) => proxyHaystack(stat, proxies.find((item) => item.id === stat.id))}
        listClassName="module-list proxy-registry-list"
        searchPlaceholder={t("module.proxySearchPlaceholder")}
        summaryText={(shown, total, filtered) =>
          filtered ? t("module.proxySummaryFiltered", { shown, total }) : t("module.proxySummaryTotal", { total })
        }
        emptyTitle={t("module.emptyTitle")}
        emptyBody={t("module.emptyBody")}
        filterEmptyTitle={t("module.filterEmptyTitle")}
        filterEmptyBody={t("module.filterEmptyBody")}
        filterResetLabel={t("actions.clearSearch")}
        renderItem={(proxy) => (
          <ProxyRegistryRow
            busy={busy}
            canReplace={proxies.some((item) => item.id !== proxy.id)}
            checkManagedProxy={checkManagedProxy}
            duplicateProxy={duplicateProxy}
            editProxy={editProxy}
            key={proxy.id ?? proxy.name}
            proxy={proxies.find((item) => item.id === proxy.id)}
            requestProxyDelete={requestProxyDelete}
            requestProxyReference={requestProxyReference}
            showProfiles={showProfiles}
            stat={proxy}
            t={t}
            locale={locale}
            updateProxy={updateProxy}
          />
        )}
      />
    );
  }

  if (view === "extensions") {
    return (
      <ExtensionRegistryPanel
        busy={busy}
        extensions={state?.extensions ?? []}
        extensionSources={state?.extensionSources ?? []}
        extensionStats={stats.extensions}
        locale={locale}
        t={t}
        toast={toast}
        addExtensionSource={addExtensionSource}
        addRemoteExtension={addRemoteExtension}
        checkExtension={checkExtension}
        checkExtensionUpdate={checkExtensionUpdate}
        deleteExtension={deleteExtension}
        deleteExtensionSource={deleteExtensionSource}
        editExtensionSource={editExtensionSource}
        importExtensionArchive={importExtensionArchive}
        importExtensionDirectory={importExtensionDirectory}
        installExtension={installExtension}
        migrateExtensionIdentity={migrateExtensionIdentity}
        refreshExtensionSource={refreshExtensionSource}
        reinstallExtension={reinstallExtension}
        setExtensionUpdatePolicy={setExtensionUpdatePolicy}
        toggleExtensionSourceStatus={toggleExtensionSourceStatus}
        toggleExtensionSourceUnsigned={toggleExtensionSourceUnsigned}
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
      items={trashRows}
      haystack={(row) => row.haystack}
      listClassName="module-list"
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
      renderItem={({ deletedAtLabel, entry }) => (
        <div className="module-list-row" key={entry.environment.id}>
          <span>
            <strong>{entry.environment.name}</strong>
            <small>
              {t("module.deletedAt")}: {deletedAtLabel}
              {entry.deleteReason ? ` / ${t("module.deleteReason")}: ${entry.deleteReason}` : ""}
            </small>
          </span>
          <button
            className="command subtle"
            disabled={busy === `trash-restore:${entry.environment.id}`}
            onClick={() => void restoreTrashEnvironment(entry.environment.id)}
            type="button"
          >
            <RotateCcw size={16} aria-hidden="true" />
            {t("actions.restore")}
          </button>
          <button
            className="command danger subtle"
            disabled={busy === `trash-delete:${entry.environment.id}`}
            onClick={() => void permanentlyDeleteTrashEnvironment(entry.environment.id, entry.environment.name)}
            type="button"
          >
            <Trash2 size={16} aria-hidden="true" />
            {t("actions.permanentDelete")}
          </button>
        </div>
      )}
    />
  );
}

function ProxyRegistryRow({
  busy,
  canReplace,
  checkManagedProxy,
  duplicateProxy,
  editProxy,
  proxy,
  requestProxyDelete,
  requestProxyReference,
  showProfiles,
  stat,
  t,
  locale,
  updateProxy,
}: {
  busy: string;
  canReplace: boolean;
  checkManagedProxy: (proxy: ProxyEntity) => Promise<void>;
  duplicateProxy: (proxy: ProxyEntity) => Promise<void>;
  editProxy: (proxy: ProxyEntity) => Promise<void>;
  proxy?: ProxyEntity;
  requestProxyDelete: (proxy: ProxyEntity) => void;
  requestProxyReference: (action: "replace" | "unbind", proxy: ProxyEntity) => void;
  showProfiles: (patch?: { proxyId?: string; proxy?: ProxyFilter }) => void;
  stat: ModuleStat;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  updateProxy: (proxy: ProxyEntity, patch: Partial<ProxyEntity>) => Promise<void>;
}) {
  const check = proxy?.lastCheck;
  const address = proxy ? `${proxy.scheme}://${proxy.host}:${proxy.port}` : stat.name;
  const hasReferences = stat.count > 0;

  return (
    <div className="module-list-row managed proxy-registry-row">
      <div className="proxy-registry-topline">
        <span className="proxy-registry-main">
          <strong>{proxy?.name ?? stat.name}</strong>
          <small className="mono-cell">{maskManagedProxyForDisplay(proxy, address)}</small>
          {proxy?.notes && <small>{proxy.notes}</small>}
        </span>
        <span className="proxy-registry-meta">
          <strong>{proxy?.scheme.toUpperCase() ?? "-"}</strong>
          <small>{proxy?.username ? t("proxy.credentials.saved") : t("proxy.credentials.none")}</small>
        </span>
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
        {proxy && <span className="proxy-registry-status">{renderEntityStatus(proxy.status, t)}</span>}
      </div>
      <div className="proxy-registry-bottomline">
        <span className="proxy-check-state">{proxyCheckSummary(check, t, locale)}</span>
        {proxy && (
          <div className="module-row-actions proxy-row-actions">
            <button className="command subtle" disabled={busy === `proxy-load:${proxy.id}`} onClick={() => void editProxy(proxy)} type="button">
              {t("actions.edit")}
            </button>
            <button className="command subtle" disabled={busy === `proxy-check:${proxy.id}`} onClick={() => void checkManagedProxy(proxy)} type="button">
              {t("actions.check")}
            </button>
            <button
              className="command subtle"
              disabled={busy === `proxy-update:${proxy.id}`}
              onClick={() => void updateProxy(proxy, { status: proxy.status === "disabled" ? "enabled" : "disabled" })}
              type="button"
            >
              {t(proxy.status === "disabled" ? "actions.enable" : "actions.disable")}
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
    </div>
  );
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

