import { useEffect, useMemo, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { ChevronDown, ChevronRight, FilePlus2, FolderOpen, MoreHorizontal, Plus, Puzzle } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { errorMessage } from "../../lib/apiClient";
import { forgetExtensionIcon, loadExtensionIcon, peekExtensionIcon } from "../../lib/extensionIcons";
import { formatTime, shortExtensionId } from "../../lib/utils";
import type {
  ExtensionEntity,
  ExtensionInstallState,
  ExtensionPermissionRisk,
  ExtensionSourceEntity,
  ExtensionSourceKind,
  ExtensionUpdatePolicy,
} from "../../shared/entities";
import { CopyButton } from "../ui/CopyButton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Switch } from "../ui/switch";
import { renderEntityStatus, riskReasonText } from "./entityDisplay";
import type { ExtensionModuleStat } from "./registryStats";
import { RegistryListShell } from "./RegistryModuleShell";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

type Notify = (kind: "success" | "error" | "info", text: string) => void;

type ExtensionTone = "ready" | "error" | "muted";

type ExtensionHealth = "ready" | "pending" | "error";

type ExtensionActions = {
  checkExtension: (extension: ExtensionEntity) => Promise<void>;
  checkExtensionUpdate: (extension: ExtensionEntity) => Promise<void>;
  deleteExtension: (extension: ExtensionEntity) => Promise<void>;
  installExtension: (extension: ExtensionEntity) => Promise<void>;
  migrateExtensionIdentity: (extension: ExtensionEntity) => Promise<void>;
  reinstallExtension: (extension: ExtensionEntity) => Promise<void>;
  setExtensionUpdatePolicy: (extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) => Promise<void>;
  toggleExtensionStatus: (extension: ExtensionEntity) => Promise<void>;
  updateExtension: (extension: ExtensionEntity) => Promise<void>;
};

type ExtensionRegistryPanelProps = ExtensionActions & {
  busy: string;
  extensions: ExtensionEntity[];
  extensionSources: ExtensionSourceEntity[];
  extensionStats: ExtensionModuleStat[];
  locale: string;
  t: Translate;
  toast: Notify;
  addExtensionSource: () => void | Promise<void>;
  addRemoteExtension: () => void | Promise<void>;
  deleteExtensionSource: (source: ExtensionSourceEntity) => Promise<void>;
  editExtensionSource: (source: ExtensionSourceEntity) => void | Promise<void>;
  importExtensionArchive: (kind: "zip" | "crx") => void | Promise<void>;
  importExtensionDirectory: () => void | Promise<void>;
  refreshExtensionSource: (source: ExtensionSourceEntity) => Promise<void>;
  toggleExtensionSourceStatus: (source: ExtensionSourceEntity) => Promise<void>;
  toggleExtensionSourceUnsigned: (source: ExtensionSourceEntity) => Promise<void>;
};

type ExtensionRowModel = {
  extension: ExtensionEntity;
  duplicated: boolean;
  failing: boolean;
  haystack: string;
  highRiskCount: number;
  kindLabel: string;
  mediumRiskCount: number;
  refCount: number;
  stateLabel: string;
};

const sourceKindKeys: Record<ExtensionSourceKind, TranslationKey> = {
  "local-directory": "extension.kind.localDirectory",
  "local-zip": "extension.kind.localZip",
  "local-crx": "extension.kind.localCrx",
  "remote-zip": "extension.kind.remoteZip",
  "remote-crx": "extension.kind.remoteCrx",
  "chrome-web-store": "extension.kind.chromeWebStore",
};

const installStateKeys: Record<ExtensionInstallState, TranslationKey> = {
  "metadata-only": "extension.state.notInstalled",
  "download-pending": "extension.state.notInstalled",
  downloading: "extension.state.downloading",
  installed: "extension.state.installed",
  "update-available": "extension.state.updateAvailable",
  "local-missing": "extension.state.localMissing",
  "invalid-manifest": "extension.state.invalidManifest",
  "install-failed": "extension.state.installFailed",
};

const failingStates = new Set<ExtensionInstallState>(["local-missing", "invalid-manifest", "install-failed"]);

const pendingStates = new Set<ExtensionInstallState>(["metadata-only", "download-pending", "downloading"]);

const loadableStates = new Set<ExtensionInstallState>(["installed", "update-available"]);

/** Only same name + same version needs the short-ID chip, so count that pair exactly. */
function nameVersionKey(extension: ExtensionEntity) {
  return JSON.stringify([extension.name, extension.version]);
}

/** Fetches the real manifest icon once per `id:updatedAt`; falls back to the glyph on any miss. */
function useExtensionIcon(extension: ExtensionEntity): { src: string | null; onError: () => void } {
  const { id, installState, localPath, updatedAt } = extension;
  const [src, setSrc] = useState<string | null>(() => peekExtensionIcon(id, updatedAt) ?? null);

  useEffect(() => {
    const cached = peekExtensionIcon(id, updatedAt);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    // Only an installed unpacked copy can have a readable icon; asking for the others
    // just trades a request for a 404/400 in the console.
    if (!localPath || !loadableStates.has(installState)) {
      setSrc(null);
      return;
    }
    // Deliberately keep the current icon on screen while revalidating: `updatedAt` also changes
    // on a status/policy write, and blanking to the glyph first makes the row flicker.
    let active = true;
    void loadExtensionIcon(id, updatedAt).then((value) => {
      if (active) setSrc(value);
    });
    return () => {
      active = false;
    };
  }, [id, installState, localPath, updatedAt]);

  return {
    src,
    onError: () => {
      forgetExtensionIcon(id, updatedAt);
      setSrc(null);
    },
  };
}

function extensionSearchText(extension: ExtensionEntity, kindLabel: string, stateLabel: string) {
  return [
    extension.name,
    extension.description,
    extension.version,
    extension.id,
    extension.sourceKind,
    kindLabel,
    extension.installState,
    stateLabel,
    extension.localPath ?? "",
    extension.sourceUrl,
    extension.permissions.join(" "),
    extension.hostPermissions.join(" "),
  ]
    .join(" ")
    .toLowerCase();
}

export function ExtensionRegistryPanel({
  busy,
  extensions,
  extensionSources,
  extensionStats,
  locale,
  t,
  toast,
  addExtensionSource,
  addRemoteExtension,
  checkExtension,
  checkExtensionUpdate,
  deleteExtension,
  deleteExtensionSource,
  editExtensionSource,
  importExtensionArchive,
  importExtensionDirectory,
  installExtension,
  migrateExtensionIdentity,
  refreshExtensionSource,
  reinstallExtension,
  setExtensionUpdatePolicy,
  toggleExtensionSourceStatus,
  toggleExtensionSourceUnsigned,
  toggleExtensionStatus,
  updateExtension,
}: ExtensionRegistryPanelProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());

  const rows = useMemo<ExtensionRowModel[]>(() => {
    const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
    const statsById = new Map(extensionStats.filter((item) => item.id).map((item) => [item.id as string, item]));
    const labelCounts = new Map<string, number>();
    for (const extension of extensions) {
      const label = nameVersionKey(extension);
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
    return extensions
      .map((extension) => {
        const stat = statsById.get(extension.id);
        const kindLabel = t(sourceKindKeys[extension.sourceKind] ?? "extension.kind.localDirectory");
        const stateLabel = t(installStateKeys[extension.installState] ?? "extension.state.notInstalled");
        return {
          extension,
          duplicated: (labelCounts.get(nameVersionKey(extension)) ?? 0) > 1,
          failing: Boolean(extension.lastError) || failingStates.has(extension.installState),
          haystack: extensionSearchText(extension, kindLabel, stateLabel),
          highRiskCount: extension.permissionRisks.filter((risk) => risk.level === "high").length,
          kindLabel,
          mediumRiskCount: extension.permissionRisks.filter((risk) => risk.level === "medium").length,
          refCount: stat?.profiles ?? stat?.count ?? 0,
          stateLabel,
        };
      })
      .sort((left, right) => {
        const byName = collator.compare(left.extension.name, right.extension.name);
        if (byName !== 0) return byName;
        const byVersion = collator.compare(right.extension.version, left.extension.version);
        if (byVersion !== 0) return byVersion;
        return left.extension.createdAt.localeCompare(right.extension.createdAt);
      });
  }, [extensions, extensionStats, locale, t]);

  const summary = useMemo(
    () => ({
      total: rows.length,
      updatable: rows.filter((row) => row.extension.installState === "update-available").length,
      failing: rows.filter((row) => row.failing).length,
    }),
    [rows],
  );

  const importBusy = busy === "extension-import-directory"
    || busy === "extension-import-zip"
    || busy === "extension-import-crx"
    || busy === "extension-remote-create";
  const toggleExpanded = (id: string) => {
    setExpandedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <RegistryListShell
      icon={<Puzzle size={19} />}
      title={t("module.extensionsTitle")}
      body={t("module.extensionsBody")}
      items={rows}
      haystack={(row) => row.haystack}
      listClassName="module-list extension-registry-list"
      searchPlaceholder={t("extension.search.placeholder")}
      // Zero counts stay out of the summary: a permanent "0 failing" reads like a metric to fix.
      summaryText={(shown, total, filtered) =>
        filtered
          ? t("extension.summaryFiltered", { shown, total })
          : [
            t("extension.summaryTotal", { total }),
            ...(summary.updatable > 0 ? [t("extension.summaryUpdatable", { count: summary.updatable })] : []),
            ...(summary.failing > 0 ? [t("extension.summaryFailing", { count: summary.failing })] : []),
          ].join(" · ")}
      emptyTitle={t("module.emptyTitle")}
      emptyBody={t("module.emptyBody")}
      filterEmptyTitle={t("extension.filterEmptyTitle")}
      filterEmptyBody={t("module.filterEmptyBody")}
      filterResetLabel={t("actions.clearSearch")}
      action={
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="command primary" disabled={importBusy} type="button">
              <Plus size={16} aria-hidden="true" />
              {t("actions.addExtension")}
              <ChevronDown size={14} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem disabled={busy === "extension-import-directory"} onSelect={() => void importExtensionDirectory()}>
              {t("actions.importDirectory")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy === "extension-import-zip"} onSelect={() => void importExtensionArchive("zip")}>
              {t("actions.importZip")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy === "extension-import-crx"} onSelect={() => void importExtensionArchive("crx")}>
              {t("actions.importCrx")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy === "extension-remote-create"} onSelect={() => void addRemoteExtension()}>
              {t("actions.addRemoteExtension")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      renderItem={(row) => (
        <ExtensionRow
          busy={busy}
          checkExtension={checkExtension}
          checkExtensionUpdate={checkExtensionUpdate}
          deleteExtension={deleteExtension}
          expanded={expandedIds.has(row.extension.id)}
          installExtension={installExtension}
          key={row.extension.id}
          migrateExtensionIdentity={migrateExtensionIdentity}
          reinstallExtension={reinstallExtension}
          row={row}
          setExtensionUpdatePolicy={setExtensionUpdatePolicy}
          t={t}
          toast={toast}
          toggleExpanded={toggleExpanded}
          toggleExtensionStatus={toggleExtensionStatus}
          updateExtension={updateExtension}
        />
      )}
      footer={
        <div className="module-subsection">
          <div className="module-subsection-head">
            <h3>{t("module.extensionSourcesTitle")}</h3>
            <button className="command subtle" disabled={busy === "extension-source-create"} onClick={() => void addExtensionSource()} type="button">
              <FilePlus2 size={15} aria-hidden="true" />
              {t("actions.addExtensionSource")}
            </button>
          </div>
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
                    <button className="command subtle" disabled={sourceBusy} onClick={() => void editExtensionSource(source)} type="button">
                      {t("actions.edit")}
                    </button>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                          <MoreHorizontal size={16} aria-hidden="true" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem disabled={sourceBusy} onSelect={() => void toggleExtensionSourceStatus(source)}>
                          {t(source.status === "disabled" ? "actions.enable" : "actions.disable")}
                        </DropdownMenuItem>
                        <DropdownMenuItem disabled={sourceBusy} onSelect={() => void toggleExtensionSourceUnsigned(source)}>
                          {t(source.allowUnsignedAssets ? "actions.requireSha256" : "actions.allowUnsigned")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="dropdown-menu-item-danger"
                          disabled={sourceBusy}
                          onSelect={() => void deleteExtensionSource(source)}
                        >
                          {t("actions.delete")}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
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
      }
    />
  );
}

function ExtensionRow({
  busy,
  checkExtension,
  checkExtensionUpdate,
  deleteExtension,
  expanded,
  installExtension,
  migrateExtensionIdentity,
  reinstallExtension,
  row,
  setExtensionUpdatePolicy,
  t,
  toast,
  toggleExpanded,
  toggleExtensionStatus,
  updateExtension,
}: ExtensionActions & {
  busy: string;
  expanded: boolean;
  row: ExtensionRowModel;
  t: Translate;
  toast: Notify;
  toggleExpanded: (id: string) => void;
}) {
  const { duplicated, extension, failing, highRiskCount, kindLabel, mediumRiskCount, refCount, stateLabel } = row;
  const canMutatePackage = extension.sourceKind !== "chrome-web-store";
  const isLoadable = extension.installState === "installed" || extension.installState === "update-available";
  const canInstall = canMutatePackage && !isLoadable;
  const canReinstall = canMutatePackage && extension.installState !== "update-available";
  const canCheckUpdate = Boolean(extension.sourceId)
    || extension.sourceKind === "local-zip"
    || extension.sourceKind === "local-crx"
    || extension.sourceKind === "local-directory";
  const canUpdate = extension.installState === "update-available";
  const identityPinned = Boolean(extension.manifestKey);
  const referenceDirectory = extension.sourceKind === "local-directory" && extension.directoryMode !== "copy";
  const canMigrateIdentity = canMutatePackage && !identityPinned && !referenceDirectory;
  const installHint = !canMutatePackage
    ? t("module.webStoreMetadataOnly")
    : canUpdate
      ? t("module.extensionUseUpdate")
      : undefined;
  const disabled = extension.status === "disabled";
  // `update-available` is signalled by the NEW badge plus the inline Update button, so the
  // health dot and the accent bar stay reserved for states that actually block a launch.
  const tone: ExtensionTone = failing ? "error" : disabled ? "muted" : "ready";
  const health: ExtensionHealth = failing ? "error" : pendingStates.has(extension.installState) ? "pending" : "ready";
  const healthTitle = health === "error"
    ? extension.lastError || stateLabel
    : health === "pending"
      ? t("extension.state.notInstalled")
      : t("extension.state.installed");
  const detailsLabel = expanded ? t("module.extensionHideDetails") : t("module.extensionShowDetails");
  const expand = () => toggleExpanded(extension.id);
  const icon = useExtensionIcon(extension);

  return (
    <div className={`extension-row tone-${tone}${expanded ? " is-expanded" : ""}`}>
      <button
        className="extension-row-toggle"
        onClick={expand}
        type="button"
        aria-expanded={expanded}
        aria-label={detailsLabel}
        title={detailsLabel}
      >
        {expanded ? <ChevronDown size={18} aria-hidden="true" /> : <ChevronRight size={18} aria-hidden="true" />}
      </button>
      <span className="extension-row-icon">
        {icon.src ? (
          <img alt="" className="extension-row-icon-img" onError={icon.onError} src={icon.src} />
        ) : (
          <Puzzle size={18} aria-hidden="true" />
        )}
        {/* Announced but not focusable: the chevron and the name button already cover expansion, so a
            third control per row would only add tab stops. `role="img"` keeps the label readable. */}
        <span className={`extension-row-health is-${health}`} role="img" aria-label={healthTitle} title={healthTitle} />
        {canUpdate && <span className="extension-row-badge" title={t("extension.state.updateAvailable")}>{t("extension.badgeUpdate")}</span>}
      </span>
      <div className="extension-row-body">
        <div className="extension-row-headline">
          <button className="extension-row-name" onClick={expand} type="button" aria-expanded={expanded} title={extension.name}>
            {extension.name}
          </button>
          <small className="extension-row-version">
            v{extension.version}
            {extension.manifestVersion ? ` · MV${extension.manifestVersion}` : ""}
          </small>
        </div>
        <div className="extension-row-meta">
          <small>{kindLabel}</small>
          {health === "pending" && (
            <>
              <small aria-hidden="true">·</small>
              <span className="extension-row-pill">{t("extension.state.notInstalled")}</span>
            </>
          )}
          <small aria-hidden="true">·</small>
          {highRiskCount > 0 || mediumRiskCount > 0 ? (
            <span className="risk-badge-group">
              {highRiskCount > 0 && <span className="risk-badge risk-high">{t("module.extensionRisk", { count: highRiskCount })}</span>}
              {mediumRiskCount > 0 && <span className="risk-badge risk-medium">{t("module.extensionRiskMedium", { count: mediumRiskCount })}</span>}
            </span>
          ) : (
            <small>{t("module.extensionNoRisk")}</small>
          )}
          <small aria-hidden="true">·</small>
          <small>{refCount > 0 ? t("module.referenceCount", { count: refCount }) : t("module.noReferences")}</small>
          {duplicated && (
            <>
              <small aria-hidden="true">·</small>
              <span className="extension-row-id mono-cell" title={extension.id}>
                #{shortExtensionId(extension.id)}
              </span>
            </>
          )}
        </div>
      </div>
      <div className="extension-row-actions">
        <Switch
          aria-label={t("extension.enabledToggle")}
          checked={!disabled}
          className="extension-row-switch"
          disabled={busy === `extension-status:${extension.id}`}
          onCheckedChange={() => void toggleExtensionStatus(extension)}
          title={t(disabled ? "actions.enable" : "actions.disable")}
        />
        {canUpdate && (
          <button
            className="command subtle warning"
            disabled={busy === `extension-update:${extension.id}`}
            onClick={() => void updateExtension(extension)}
            type="button"
          >
            {t("actions.update")}
          </button>
        )}
        {canInstall && (
          <button
            className="command subtle"
            disabled={busy === `extension-install:${extension.id}`}
            onClick={() => void installExtension(extension)}
            title={installHint}
            type="button"
          >
            {t("actions.install")}
          </button>
        )}
        {/* `deleteExtension` opens its own confirm dialog, so a permanent button is not a one-click destroy. */}
        <button
          className="command danger subtle"
          disabled={busy === `extension-delete:${extension.id}`}
          onClick={() => void deleteExtension(extension)}
          type="button"
        >
          {t("actions.delete")}
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={!canCheckUpdate || busy === `extension-check-update:${extension.id}`}
              onSelect={() => void checkExtensionUpdate(extension)}
            >
              {t("actions.checkUpdate")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={busy === `extension-check:${extension.id}`} onSelect={() => void checkExtension(extension)}>
              {t("actions.check")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={!canReinstall || busy === `extension-reinstall:${extension.id}`}
              onSelect={() => void reinstallExtension(extension)}
            >
              {t("actions.reinstall")}
            </DropdownMenuItem>
            {canMigrateIdentity && (
              <DropdownMenuItem
                disabled={busy === `extension-migrate:${extension.id}`}
                onSelect={() => void migrateExtensionIdentity(extension)}
              >
                {t("actions.migrateIdentity")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {expanded && (
        <ExtensionRowDetail
          busy={busy}
          extension={extension}
          identityPinned={identityPinned}
          kindLabel={kindLabel}
          setExtensionUpdatePolicy={setExtensionUpdatePolicy}
          t={t}
          toast={toast}
        />
      )}
    </div>
  );
}

function ExtensionRowDetail({
  busy,
  extension,
  identityPinned,
  kindLabel,
  setExtensionUpdatePolicy,
  t,
  toast,
}: {
  busy: string;
  extension: ExtensionEntity;
  identityPinned: boolean;
  kindLabel: string;
  setExtensionUpdatePolicy: (extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) => Promise<void>;
  t: Translate;
  toast: Notify;
}) {
  const pathText = extension.localPath ?? (extension.sourceUrl || t("module.extensionNoPath"));
  const description = extension.description && extension.description !== extension.name ? extension.description : "";
  const localPath = extension.localPath;
  const canOpenDirectory = Boolean(localPath) && isTauri();
  const permissionChips = useMemo(() => {
    const risks = new Map<string, ExtensionPermissionRisk>(extension.permissionRisks.map((risk) => [risk.permission, risk]));
    return [...new Set([...extension.permissions, ...extension.hostPermissions])].map((permission) => {
      const risk = risks.get(permission);
      const level = risk?.level === "high" ? "high" : risk?.level === "medium" ? "medium" : "low";
      return { permission, level, title: risk ? riskReasonText(risk, t) : undefined };
    });
  }, [extension.hostPermissions, extension.permissionRisks, extension.permissions, t]);

  async function openLocalDirectory() {
    if (!localPath) return;
    try {
      // Must stay a Rust command. The shell plugin's JS `open` validates its argument against a
      // scope regex that only accepts mailto/tel/http(s), so no filesystem path ever passes.
      // Calling the plugin from Rust skips that scope check, and `cbpanel_open_directory` guards
      // the path is a directory first. `shell:allow-open` is intentionally absent from
      // src-tauri/capabilities/default.json, so the JS route is not reachable from here anyway.
      await invoke("cbpanel_open_directory", { path: localPath });
    } catch (error) {
      toast("error", t("error.openDirectoryFailed", { message: errorMessage(error) }));
    }
  }

  return (
    <div className="extension-detail">
      {extension.lastError && <div className="extension-detail-error">{extension.lastError}</div>}
      {description && <p className="extension-detail-description">{description}</p>}
      <section className="extension-detail-group">
        <h4>{t("extension.detail.info")}</h4>
        <dl>
          <div>
            <dt>{t("extension.detail.sourceKind")}</dt>
            <dd>{kindLabel}</dd>
          </div>
          <div>
            <dt>{t("module.extensionManifest")}</dt>
            <dd>{extension.manifestVersion ? `MV${extension.manifestVersion}` : "-"}</dd>
          </div>
          <div>
            <dt>{t("form.version")}</dt>
            <dd>{extension.version}</dd>
          </div>
          {extension.sourceKind === "local-directory" && (
            <div>
              <dt>{t("module.extensionDirectoryMode")}</dt>
              <dd>{extension.directoryMode === "copy" ? t("module.extensionDirectoryModeCopy") : t("module.extensionDirectoryModeReference")}</dd>
            </div>
          )}
          {/* A pinned identity is the healthy default, so only the path-derived case is worth a cell. */}
          {!identityPinned && (
            <div>
              <dt>{t("module.extensionIdentity")}</dt>
              <dd>{t("module.extensionIdentityPathBased")}</dd>
            </div>
          )}
          <div className="extension-detail-row-wide">
            <dt>{t("extension.detail.extensionId")}</dt>
            <dd className="extension-detail-copyable">
              <span className="mono-cell extension-detail-wrap">{extension.id}</span>
              <CopyButton t={t} value={extension.id} />
            </dd>
          </div>
          {/* Local-directory imports never carry a sha256, so an empty row would just print a dash. */}
          {extension.sha256 && (
            <div className="extension-detail-row-wide">
              <dt>{t("module.extensionSha256")}</dt>
              <dd className="extension-detail-copyable">
                <span className="mono-cell extension-detail-wrap">{extension.sha256}</span>
                <CopyButton t={t} value={extension.sha256} />
              </dd>
            </div>
          )}
        </dl>
      </section>
      <section className="extension-detail-group">
        <h4>{t("extension.detail.location")}</h4>
        <div className="extension-detail-location">
          <span className="mono-cell extension-detail-wrap">{pathText}</span>
          <div className="extension-detail-location-actions">
            <CopyButton t={t} value={pathText} />
            {canOpenDirectory && (
              <button className="command subtle" onClick={() => void openLocalDirectory()} type="button">
                <FolderOpen size={15} aria-hidden="true" />
                {t("actions.openDirectory")}
              </button>
            )}
          </div>
        </div>
      </section>
      <section className="extension-detail-group">
        <h4>{t("extension.detail.permissions")}</h4>
        <div className="extension-detail-chips">
          {permissionChips.length === 0 && <small>-</small>}
          {permissionChips.map((chip) => (
            <span className={`risk-chip risk-${chip.level}`} key={chip.permission} title={chip.title}>
              {chip.permission}
            </span>
          ))}
        </div>
      </section>
      <section className="extension-detail-group">
        <h4>{t("extension.detail.settings")}</h4>
        <dl>
          <div className="extension-detail-row-wide">
            <dt>{t("module.extensionUpdatePolicy")}</dt>
            <dd>
              <select
                className="extension-policy-select"
                disabled={busy === `extension-policy:${extension.id}`}
                value={extension.updatePolicy}
                onChange={(event) => void setExtensionUpdatePolicy(extension, event.target.value as ExtensionUpdatePolicy)}
              >
                <option value="pinned">{t("module.extensionUpdatePolicyPinned")}</option>
                <option value="notify">{t("module.extensionUpdatePolicyNotify")}</option>
                <option value="auto">{t("module.extensionUpdatePolicyAuto")}</option>
              </select>
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
