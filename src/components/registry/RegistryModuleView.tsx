import React, { Suspense, lazy } from "react";
import { Archive, FilePlus2, FolderKanban, Info, MoreHorizontal, Network, Plug, RotateCcw, Tags, Trash2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import type { BinaryInfo } from "../../shared/browserCore";
import type { ExtensionEntity, ExtensionSourceEntity, GroupEntity, ProxyEntity, SystemDiagnostics, TagEntity } from "../../shared/entities";
import type { PanelState } from "../../shared/profile";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";
import { maskManagedProxyForDisplay } from "../profiles/proxyDisplay";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import type { ModeFilter, ModuleStat, ModuleStats, ProxyFilter, StatusFilter, WorkbenchView } from "./registryStats";
import { RegistryModuleEmpty, RegistryModuleShell } from "./RegistryModuleShell";

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
  bindExtensionToSelected: (extension: ExtensionEntity) => Promise<void>;
  checkExtension: (extension: ExtensionEntity) => Promise<void>;
  checkExtensionUpdate: (extension: ExtensionEntity) => Promise<void>;
  showProfiles: (patch?: ShowProfilePatch) => void;
  importExtensionArchive: (kind: "zip" | "crx") => void | Promise<void>;
  importExtensionDirectory: () => void | Promise<void>;
  installExtension: (extension: ExtensionEntity) => Promise<void>;
  mergeGroup: (group: GroupEntity) => void | Promise<void>;
  mergeTag: (tag: TagEntity) => void | Promise<void>;
  newGroup: () => void;
  newTag: () => void;
  newProxy: () => void | Promise<void>;
  reinstallExtension: (extension: ExtensionEntity) => Promise<void>;
  permanentlyDeleteTrashEnvironment: (id: string, name: string) => Promise<void>;
  refreshExtensionSource: (source: ExtensionSourceEntity) => Promise<void>;
  requestGroupDelete: (group: GroupEntity) => void;
  requestProxyDelete: (proxy: ProxyEntity) => void;
  requestProxyReference: (action: "replace" | "unbind", proxy: ProxyEntity) => void;
  requestTagDelete: (tag: TagEntity) => void;
  restoreTrashEnvironment: (id: string) => Promise<void>;
  toggleExtensionSourceStatus: (source: ExtensionSourceEntity) => Promise<void>;
  toggleExtensionSourceUnsigned: (source: ExtensionSourceEntity) => Promise<void>;
  unbindExtensionFromSelected: (extension: ExtensionEntity) => Promise<void>;
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
  bindExtensionToSelected,
  checkExtension,
  checkExtensionUpdate,
  showProfiles,
  importExtensionArchive,
  importExtensionDirectory,
  installExtension,
  mergeGroup,
  mergeTag,
  newProxy,
  newGroup,
  newTag,
  reinstallExtension,
  permanentlyDeleteTrashEnvironment,
  refreshExtensionSource,
  requestGroupDelete,
  requestProxyDelete,
  requestProxyReference,
  requestTagDelete,
  restoreTrashEnvironment,
  toggleExtensionSourceStatus,
  toggleExtensionSourceUnsigned,
  unbindExtensionFromSelected,
  updateExtension,
  updateGroup,
  updateProxy,
  updateTag,
}: RegistryModuleViewProps) {
  if (view === "runtimeCheck") {
    return (
      <Suspense fallback={<div className="preflight-empty">{t("status.loading")}</div>}>
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
      <RegistryModuleShell
        icon={<FolderKanban size={19} />}
        title={t("module.groupsTitle")}
        body={t("module.groupsBody")}
        toolbar={
          <button className="command primary" disabled={busy === "group-create"} onClick={newGroup} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.newGroup")}
          </button>
        }
      >
        <div className="module-card-grid">
          {stats.groups.map((group) => (
            <div className="module-card managed" key={group.id ?? group.name}>
              <button className="module-card-main" onClick={() => showProfiles({ group: group.name })} type="button">
                <strong>{group.name}</strong>
                <span>{t("module.profileCount", { count: group.count })}</span>
                <small>{t("module.runningCount", { count: group.running })}</small>
              </button>
              {group.id && (
                <div className="module-row-actions">
                  {renderEntityStatus(group.status, t)}
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
                  <button
                    className="command subtle"
                    disabled={group.isDefault || busy === `group-update:${group.id}`}
                    onClick={() => {
                      const entity = groups.find((item) => item.id === group.id);
                      if (entity) void updateGroup(entity, { status: entity.status === "disabled" ? "enabled" : "disabled" });
                    }}
                    title={group.isDefault ? t("module.defaultGroupLocked") : undefined}
                    type="button"
                  >
                    {t(group.status === "disabled" ? "actions.enable" : "actions.disable")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={group.isDefault || !groups.some((item) => item.id !== group.id) || busy === `group-merge:${group.id}`}
                    onClick={() => {
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
                    type="button"
                  >
                    {t("actions.merge")}
                  </button>
                  <button
                    className="command danger subtle"
                    disabled={group.isDefault || busy === `group-delete:${group.id}`}
                    onClick={() => {
                      const entity = groups.find((item) => item.id === group.id);
                      if (entity) requestGroupDelete(entity);
                    }}
                    title={group.isDefault ? t("module.defaultGroupLocked") : undefined}
                    type="button"
                  >
                    {t("actions.delete")}
                  </button>
                </div>
              )}
            </div>
          ))}
          {stats.groups.length === 0 && <ModuleEmpty t={t} />}
        </div>
      </RegistryModuleShell>
    );
  }

  if (view === "tags") {
    const tags = state?.tags ?? [];
    return (
      <RegistryModuleShell
        icon={<Tags size={19} />}
        title={t("module.tagsTitle")}
        body={t("module.tagsBody")}
        toolbar={
          <button className="command primary" disabled={busy === "tag-create"} onClick={newTag} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.newTag")}
          </button>
        }
      >
        <div className="module-chip-grid tag-tile-grid">
          {stats.tags.map((tag) => (
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
          ))}
          {stats.tags.length === 0 && <ModuleEmpty t={t} />}
        </div>
      </RegistryModuleShell>
    );
  }

  if (view === "proxies") {
    const proxies = state?.proxies ?? [];
    return (
      <RegistryModuleShell
        icon={<Network size={19} />}
        title={t("module.proxiesTitle")}
        body={t("module.proxiesBody")}
        toolbar={
          <button className="command primary" disabled={busy === "proxy-create"} onClick={() => void newProxy()} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.newProxy")}
          </button>
        }
      >
        <div className="module-list proxy-registry-list">
          {stats.proxies.map((proxy) => (
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
              updateProxy={updateProxy}
            />
          ))}
          {stats.proxies.length === 0 && <ModuleEmpty t={t} />}
        </div>
      </RegistryModuleShell>
    );
  }

  if (view === "extensions") {
    const extensions = state?.extensions ?? [];
    const extensionSources = state?.extensionSources ?? [];
    return (
      <RegistryModuleShell
        icon={<Plug size={19} />}
        title={t("module.extensionsTitle")}
        body={t("module.extensionsBody")}
        toolbar={
          <>
          <button className="command primary" disabled={busy === "extension-import-directory"} onClick={() => void importExtensionDirectory()} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
            {t("actions.importDirectory")}
          </button>
          <button className="command" disabled={busy === "extension-import-zip"} onClick={() => void importExtensionArchive("zip")} type="button">
            {t("actions.importZip")}
          </button>
          <button className="command" disabled={busy === "extension-import-crx"} onClick={() => void importExtensionArchive("crx")} type="button">
            {t("actions.importCrx")}
          </button>
          <button className="command" disabled={busy === "extension-remote-create"} onClick={() => void addRemoteExtension()} type="button">
            {t("actions.addRemoteExtension")}
          </button>
          <button className="command" disabled={busy === "extension-source-create"} onClick={() => void addExtensionSource()} type="button">
            {t("actions.addExtensionSource")}
          </button>
          </>
        }
      >
        <div className="module-list">
          {extensions.map((extension) => {
            const related = stats.extensions.find((item) => item.id === extension.id);
            const canInstall = extension.sourceKind !== "chrome-web-store";
            const canCheckUpdate = Boolean(extension.sourceId);
            const canUpdate = extension.installState === "update-available";
            return (
              <div className="module-list-row managed extension-row" key={extension.id}>
                <span>
                  <strong>{extension.name}</strong>
                  <small className="mono-cell">{extension.localPath ?? (extension.sourceUrl || t("module.extensionNoPath"))}</small>
                  <small>{extension.permissionRisks.length ? t("module.extensionRisk", { count: extension.permissionRisks.length }) : t("module.extensionNoRisk")}</small>
                  {extension.lastError && <small className="danger-text">{extension.lastError}</small>}
                </span>
                <strong>{extension.version}</strong>
                <small>
                  {extension.sourceKind} / {extension.installState}
                </small>
                <small>{t("module.referenceCount", { count: related?.profiles ?? 0 })}</small>
                <div className="module-row-actions">
                  {renderEntityStatus(extension.status, t)}
                  <button
                    className="command subtle"
                    disabled={!canInstall || busy === `extension-install:${extension.id}`}
                    onClick={() => void installExtension(extension)}
                    title={canInstall ? undefined : t("module.webStoreMetadataOnly")}
                    type="button"
                  >
                    {t("actions.install")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={busy === `extension-check:${extension.id}`}
                    onClick={() => void checkExtension(extension)}
                    type="button"
                  >
                    {t("actions.check")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={!canCheckUpdate || busy === `extension-check-update:${extension.id}`}
                    onClick={() => void checkExtensionUpdate(extension)}
                    title={canCheckUpdate ? undefined : t("module.extensionNoSource")}
                    type="button"
                  >
                    {t("actions.checkUpdate")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={!canUpdate || busy === `extension-update:${extension.id}`}
                    onClick={() => void updateExtension(extension)}
                    title={canUpdate ? undefined : t("module.extensionUpdateUnavailable")}
                    type="button"
                  >
                    {t("actions.update")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={!canInstall || busy === `extension-reinstall:${extension.id}`}
                    onClick={() => void reinstallExtension(extension)}
                    title={canInstall ? undefined : t("module.webStoreMetadataOnly")}
                    type="button"
                  >
                    {t("actions.reinstall")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={busy === `extension-bind:${extension.id}`}
                    onClick={() => void bindExtensionToSelected(extension)}
                    type="button"
                  >
                    {t("actions.bindSelected")}
                  </button>
                  <button
                    className="command subtle"
                    disabled={busy === `extension-unbind:${extension.id}`}
                    onClick={() => void unbindExtensionFromSelected(extension)}
                    type="button"
                  >
                    {t("actions.unbind")}
                  </button>
                  <button
                    className="command danger subtle"
                    disabled={busy === `extension-delete:${extension.id}`}
                    onClick={() => void deleteExtension(extension)}
                    type="button"
                  >
                    {t("actions.delete")}
                  </button>
                </div>
                <dl className="extension-detail-grid">
                  <div>
                    <dt>{t("form.platform")}</dt>
                    <dd>{extension.sourceKind}</dd>
                  </div>
                  <div>
                    <dt>{t("module.extensionManifest")}</dt>
                    <dd>{extension.manifestVersion ? `MV${extension.manifestVersion}` : "-"}</dd>
                  </div>
                  <div>
                    <dt>{t("module.extensionUpdatePolicy")}</dt>
                    <dd>{extension.updatePolicy}</dd>
                  </div>
                  <div>
                    <dt>{t("module.extensionSha256")}</dt>
                    <dd className="mono-cell">{extension.sha256 ?? "-"}</dd>
                  </div>
                  <div>
                    <dt>{t("module.extensionPermissions")}</dt>
                    <dd>{extension.permissions.length ? extension.permissions.join(", ") : "-"}</dd>
                  </div>
                  <div>
                    <dt>{t("module.extensionHostPermissions")}</dt>
                    <dd>{extension.hostPermissions.length ? extension.hostPermissions.join(", ") : "-"}</dd>
                  </div>
                  <div>
                    <dt>{t("module.extensionRiskDetail")}</dt>
                    <dd>{extension.permissionRisks.length ? extension.permissionRisks.map((risk) => risk.permission).join(", ") : t("module.extensionNoRisk")}</dd>
                  </div>
                  <div>
                    <dt>{t("module.referenceCount")}</dt>
                    <dd>{related?.profiles ?? 0}</dd>
                  </div>
                </dl>
              </div>
            );
          })}
          {extensions.length === 0 && <ModuleEmpty t={t} />}
        </div>
        <div className="module-subsection">
          <h3>{t("module.extensionSourcesTitle")}</h3>
          <div className="module-list">
            {extensionSources.map((source) => {
              const canRefresh = source.status !== "disabled" && Boolean(source.url);
              const sourceBusy = busy.startsWith("extension-source-") && busy.endsWith(`:${source.id}`);
              return (
                <div className="module-list-row managed extension-source-row" key={source.id}>
                  <span>
                    <strong>{source.name}</strong>
                    <small className="mono-cell">{source.url}</small>
                    {source.lastError && <small className="danger-text">{source.lastError}</small>}
                  </span>
                  <small>{source.allowUnsignedAssets ? t("module.extensionSourceUnsigned") : t("module.extensionSourceVerified")}</small>
                  <small>{source.lastRefreshedAt ? t("module.lastRefreshedAt", { value: formatTime(source.lastRefreshedAt) }) : t("module.neverRefreshed")}</small>
                  <div className="module-row-actions">
                    {renderEntityStatus(source.status, t)}
                    <button
                      className="command subtle"
                      disabled={!canRefresh || sourceBusy}
                      onClick={() => void refreshExtensionSource(source)}
                      title={canRefresh ? undefined : t("module.extensionSourceRefreshDisabled")}
                      type="button"
                    >
                      {t("actions.refresh")}
                    </button>
                    <button
                      className="command subtle"
                      disabled={sourceBusy}
                      onClick={() => void editExtensionSource(source)}
                      type="button"
                    >
                      {t("actions.edit")}
                    </button>
                    <button
                      className="command subtle"
                      disabled={sourceBusy}
                      onClick={() => void toggleExtensionSourceStatus(source)}
                      type="button"
                    >
                      {t(source.status === "disabled" ? "actions.enable" : "actions.disable")}
                    </button>
                    <button
                      className="command subtle"
                      disabled={sourceBusy}
                      onClick={() => void toggleExtensionSourceUnsigned(source)}
                      type="button"
                    >
                      {t(source.allowUnsignedAssets ? "actions.requireSha256" : "actions.allowUnsigned")}
                    </button>
                    <button
                      className="command danger subtle"
                      disabled={sourceBusy}
                      onClick={() => void deleteExtensionSource(source)}
                      type="button"
                    >
                      {t("actions.delete")}
                    </button>
                  </div>
                </div>
              );
            })}
            {extensionSources.length === 0 && (
              <div className="module-empty">
                <strong>{t("module.extensionSourcesEmptyTitle")}</strong>
                <span>{t("module.extensionSourcesEmptyBody")}</span>
              </div>
            )}
          </div>
        </div>
      </RegistryModuleShell>
    );
  }

  if (view === "system") {
    return (
      <RegistryModuleShell icon={<Info size={19} />} title={t("system.title")} body={t("system.diagnostics")}>
        <Suspense fallback={<div className="preflight-empty">{t("status.loading")}</div>}>
          <SystemStatusContent
            binaryInfo={binaryInfo}
            busy={busy}
            copyDiagnostics={copyDiagnostics}
            diagnostics={diagnostics}
            exportDiagnostics={exportDiagnostics}
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

  return (
    <RegistryModuleShell
      icon={<Archive size={19} />}
      title={t("module.trashTitle")}
      body={t("module.trashBody")}
      toolbar={
        <button
          className="command danger subtle"
          disabled={(trash ?? []).length === 0 || busy === "trash-clear"}
          onClick={() => void clearTrashEnvironments()}
          type="button"
        >
          <Trash2 size={16} aria-hidden="true" />
          {t("actions.emptyTrash")}
        </button>
      }
    >
      <div className="module-list">
        {(trash ?? []).map((item) => {
          const name = item.environment.name;
          return (
            <div className="module-list-row" key={item.environment.id}>
              <span>
                <strong>{name}</strong>
                <small>
                  {t("module.deletedAt")}: {new Date(item.deletedAt).toLocaleString()}
                  {item.deleteReason ? ` / ${t("module.deleteReason")}: ${item.deleteReason}` : ""}
                </small>
              </span>
              <button
                className="command subtle"
                disabled={busy === `trash-restore:${item.environment.id}`}
                onClick={() => void restoreTrashEnvironment(item.environment.id)}
                type="button"
              >
                <RotateCcw size={16} aria-hidden="true" />
                {t("actions.restore")}
              </button>
              <button
                className="command danger subtle"
                disabled={busy === `trash-delete:${item.environment.id}`}
                onClick={() => void permanentlyDeleteTrashEnvironment(item.environment.id, name)}
                type="button"
              >
                <Trash2 size={16} aria-hidden="true" />
                {t("actions.permanentDelete")}
              </button>
            </div>
          );
        })}
        {(trash ?? []).length === 0 && (
          <div className="module-empty solid">
            <strong>{t("module.trashEmptyTitle")}</strong>
            <span>{t("module.trashEmptyBody")}</span>
          </div>
        )}
      </div>
    </RegistryModuleShell>
  );
}

function renderEntityStatus(status: string | undefined, t: (key: TranslationKey) => string) {
  const enabled = status !== "disabled";
  return <span className={`pill ${enabled ? "running" : "stopped"}`}>{t(enabled ? "status.enabled" : "status.disabled")}</span>;
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
        <span className="proxy-check-state">{proxyCheckSummary(check, t)}</span>
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
): React.ReactNode {
  if (!check) return <span className="pill stopped">{t("module.proxyUnchecked")}</span>;
  if (check.ok) {
    const trace = [check.trace?.loc, check.trace?.colo].filter(Boolean).join(" / ");
    const detail = check.ip
      ? `${t("proxy.check.okWithIp", { ip: check.ip, latency: check.latencyMs ?? "-" })}${trace ? ` / ${trace}` : ""}`
      : t("proxy.check.ok", { latency: check.latencyMs ?? "-" });
    return <span className="pill running">{detail}</span>;
  }
  return <span className="pill error">{check.error || t("proxy.check.failed")}</span>;
}

function ModuleEmpty({ t }: { t: (key: TranslationKey) => string }) {
  return (
    <RegistryModuleEmpty title={t("module.emptyTitle")} body={t("module.emptyBody")} />
  );
}
