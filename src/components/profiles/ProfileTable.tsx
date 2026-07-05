import { useMemo, type CSSProperties, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  CheckSquare,
  CircleAlert,
  CircleStop,
  Clock3,
  Database,
  Globe2,
  LoaderCircle,
  PauseCircle,
  PlayCircle,
  Square,
} from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { NetworkCheckResult, ProxyEntity } from "../../shared/entities";
import {
  type BrowserProfile,
  type PanelState,
  type ProfileMode,
  type SessionSummary,
  buildProxyUrl,
  maskProxyUrlForDisplay,
} from "../../shared/profile";
import { DEFAULT_PROFILE_COLUMNS, type AppSettings, type AppSettingsPatch, type ProfileColumnConfig } from "../../shared/settings";
import {
  buildNetworkCheckSuccessParts,
  networkCheckSummaryText,
} from "../../shared/networkCheckDisplay";
import { columnLabels, type ProfileColumnId } from "./columns";

type Environment = NonNullable<PanelState["environments"]>[number];

export function ProfileTable({
  allPageSelected,
  columns,
  environments,
  pendingLaunchIds,
  profiles,
  proxies,
  selectedId,
  selectedIds,
  sessionsByProfileId,
  t,
  locale,
  tagFilters,
  toggleCurrentPageSelected,
  toggleSelected,
  toggleTagFilter,
  selectProfile,
  launchProfile,
  browserCoreMissing,
  stopProfile,
}: {
  allPageSelected: boolean;
  columns: ProfileColumnConfig[];
  environments: Environment[];
  pendingLaunchIds: Set<string>;
  profiles: BrowserProfile[];
  proxies: ProxyEntity[];
  selectedId: string;
  selectedIds: Set<string>;
  sessionsByProfileId: Map<string, SessionSummary>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  tagFilters: string[];
  toggleCurrentPageSelected: () => void;
  toggleSelected: (id: string) => void;
  toggleTagFilter: (tag: string) => void;
  selectProfile: (profile: BrowserProfile, openEditor?: boolean) => void;
  launchProfile: (id?: string) => Promise<void>;
  browserCoreMissing: boolean;
  stopProfile: (id?: string) => Promise<void>;
}) {
  const template = columns.map(tableTrackForColumn).join(" ");
  const tableWidth = columns.reduce((sum, column) => sum + safeColumnWidth(column), 0);
  const environmentsById = useMemo(() => new Map(environments.map((environment) => [environment.id, environment])), [environments]);
  const proxiesById = useMemo(() => new Map(proxies.map((proxy) => [proxy.id, proxy])), [proxies]);
  return (
    <div className="profile-table">
      <div
        className="profile-table-grid"
        style={{ "--table-template": template, "--table-width": `${tableWidth}px` } as CSSProperties}
      >
        <div className="profile-table-row table-head">
          {columns.map((column) => (
            <div className={`cell col-${column.id} ${columnAlignClass(column.id as ProfileColumnId)}`} key={column.id}>
              {column.id === "select" ? (
                <button className="select-button" aria-label={t("table.selectPage")} onClick={toggleCurrentPageSelected} type="button">
                  {allPageSelected ? <CheckSquare size={17} /> : <Square size={17} />}
                </button>
              ) : (
                <span>{t(columnLabels[column.id as ProfileColumnId])}</span>
              )}
            </div>
          ))}
        </div>

        {profiles.length === 0 ? (
          <div className="empty-state">
            <strong>{t("empty.title")}</strong>
            <span>{t("empty.body")}</span>
          </div>
        ) : (
          profiles.map((profile) => {
            const session = sessionsByProfileId.get(profile.id);
            const environment = environmentsById.get(profile.id);
            const proxy = environment?.proxyId ? proxiesById.get(environment.proxyId) : undefined;
            const status = session?.status ?? "stopped";
            const launchPending = pendingLaunchIds.has(profile.id);
            const isRunning = status === "running" || status === "launching" || status === "stopping";
            const stopPending = status === "stopping";
            return (
              <div
                className={`profile-table-row ${profile.id === selectedId ? "active" : ""}`}
                key={profile.id}
                onDoubleClick={() => selectProfile(profile, true)}
                onClick={() => selectProfile(profile)}
              >
                {columns.map((column) => (
                  <div className={`cell col-${column.id} ${columnAlignClass(column.id as ProfileColumnId)}`} key={`${profile.id}-${column.id}`}>
                    {renderCell({
                      columnId: column.id as ProfileColumnId,
                      isRunning,
                      profile,
                      launchPending,
                      stopPending,
                      environment,
                      proxy,
                      selected: selectedIds.has(profile.id),
                      session,
                      status,
                      t,
                      locale,
                      tagFilters,
                      toggleSelected,
                      toggleTagFilter,
                      launchProfile,
                      browserCoreMissing,
                      stopProfile,
                    })}
                  </div>
                ))}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

export function ProfilePagination({
  currentPage,
  filteredCount,
  pageEnd,
  pageSize,
  pageStart,
  saveSettings,
  selectedCount,
  setProfilePage,
  settings,
  t,
  totalPages,
  totalProfiles,
}: {
  currentPage: number;
  filteredCount: number;
  pageEnd: number;
  pageSize: number;
  pageStart: number;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  selectedCount: number;
  setProfilePage: Dispatch<SetStateAction<number>>;
  settings: AppSettings;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  totalPages: number;
  totalProfiles: number;
}) {
  const pageSizeOptions = [25, 50, 100] as const;
  return (
    <footer className="table-pagination">
      <div className="pagination-summary">
        <span>{t("table.paginationRange", { start: pageStart, end: pageEnd, total: filteredCount })}</span>
        <small>{t("table.paginationTotal", { total: totalProfiles, selected: selectedCount })}</small>
      </div>
      <div className="pagination-controls">
        <div className="pagination-size">
          <span>{t("table.pageSize")}</span>
          <div className="pagination-size-options" role="group" aria-label={t("table.pageSize")}>
            {pageSizeOptions.map((option) => (
              <button
                className={option === pageSize ? "active" : ""}
                key={option}
                onClick={() => void saveSettings({ table: { ...settings.table, pageSize: option } })}
                type="button"
              >
                {option}
              </button>
            ))}
          </div>
        </div>
        <button className="command subtle" disabled={currentPage <= 1} onClick={() => setProfilePage((page) => Math.max(1, page - 1))} type="button">
          {t("table.prevPage")}
        </button>
        <span className="page-indicator">{t("table.pageIndicator", { current: currentPage, total: totalPages })}</span>
        <button
          className="command subtle"
          disabled={currentPage >= totalPages}
          onClick={() => setProfilePage((page) => Math.min(totalPages, page + 1))}
          type="button"
        >
          {t("table.nextPage")}
        </button>
      </div>
    </footer>
  );
}

function tableTrackForColumn(column: ProfileColumnConfig) {
  const width = safeColumnWidth(column);
  switch (column.id) {
    case "select":
      return "46px";
    case "status":
    case "mode":
      return `${width}px`;
    case "updatedAt":
    case "actions":
      return `minmax(${width}px, auto)`;
    case "name":
      return `minmax(${width}px, 1.6fr)`;
    case "ip":
      return `minmax(${width}px, 1.35fr)`;
    case "group":
      return `minmax(${width}px, 0.8fr)`;
    case "tags":
      return `minmax(${width}px, 1fr)`;
    case "proxy":
    case "startUrl":
      return `minmax(${width}px, 1.25fr)`;
    default:
      return `minmax(${width}px, 0.9fr)`;
  }
}

function safeColumnWidth(column: ProfileColumnConfig) {
  if (column.id === "select") return 46;
  const fallback = DEFAULT_PROFILE_COLUMNS.find((item) => item.id === column.id)?.width ?? 112;
  const width = typeof column.width === "number" && Number.isFinite(column.width) ? column.width : fallback;
  const minWidth = column.id === "status" || column.id === "mode" ? 48 : 64;
  return Math.round(Math.min(360, Math.max(minWidth, width)));
}

function columnAlignClass(columnId: ProfileColumnId) {
  switch (columnId) {
    case "select":
    case "status":
    case "mode":
    case "updatedAt":
    case "actions":
      return "align-center";
    default:
      return "align-left";
  }
}

function renderCell({
  columnId,
  isRunning,
  launchPending,
  stopPending,
  profile,
  environment,
  proxy,
  selected,
  session,
  status,
  t,
  locale,
  tagFilters,
  toggleSelected,
  toggleTagFilter,
  launchProfile,
  browserCoreMissing,
  stopProfile,
}: {
  columnId: ProfileColumnId;
  isRunning: boolean;
  launchPending: boolean;
  stopPending: boolean;
  profile: BrowserProfile;
  environment?: Environment;
  proxy?: ProxyEntity;
  selected: boolean;
  session?: SessionSummary;
  status: SessionSummary["status"] | "stopped";
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  locale: Locale;
  tagFilters: string[];
  toggleSelected: (id: string) => void;
  toggleTagFilter: (tag: string) => void;
  launchProfile: (id?: string) => Promise<void>;
  browserCoreMissing: boolean;
  stopProfile: (id?: string) => Promise<void>;
}) {
  switch (columnId) {
    case "select":
      return (
        <button
          className="select-button"
          aria-label={t("table.selectProfile", { name: profile.name })}
          onClick={(event) => {
            event.stopPropagation();
            toggleSelected(profile.id);
          }}
          type="button"
        >
          {selected ? <CheckSquare size={17} /> : <Square size={17} />}
        </button>
      );
    case "name":
      return (
        <div className="name-cell">
          <strong>{profile.name}</strong>
          <small>{profile.notes || profile.id}</small>
        </div>
      );
    case "status":
      return (
        <span className={`status-badge status-icon-badge ${status}`} title={statusText(status, t)} aria-label={statusText(status, t)}>
          {statusIcon(status)}
        </span>
      );
    case "group":
      return profile.group;
    case "tags":
      return (
        <span className="tag-list">
          {(profile.tags.length > 2 ? profile.tags.slice(0, 1) : profile.tags.slice(0, 2)).map((tag) => (
            <button
              className={`tag tag-button ${tagFilters.includes(tag) ? "active" : ""}`}
              key={tag}
              onClick={(event) => {
                event.stopPropagation();
                toggleTagFilter(tag);
              }}
              title={t("filter.tagToggle", { tag })}
              type="button"
            >
              {tag}
            </button>
          ))}
          {profile.tags.length > 2 && (
            <span className="tag muted" title={profile.tags.slice(1).join(", ")}>
              +{profile.tags.length - 1}
            </span>
          )}
        </span>
      );
    case "proxy":
      return <span className="mono-cell">{maskProxyUrlForDisplay(buildProxyUrl(profile.proxy))}</span>;
    case "ip":
      return <ExitCell profile={profile} check={environment?.lastNetworkCheck ?? proxy?.lastCheck} t={t} locale={locale} />;
    case "mode":
      return <ModeCell mode={profile.mode} t={t} />;
    case "launcher":
      return profile.runtime.launcher;
    case "startUrl":
      return profile.startUrl || "-";
    case "updatedAt":
      return <UpdatedAtCell value={profile.updatedAt} />;
    case "actions":
      return (
        <div className="row-actions-cell">
          {isRunning ? (
            <button
              className={`row-primary danger ${stopPending ? "loading" : ""}`}
              disabled={stopPending}
              title={stopPending ? statusText("stopping", t) : t("actions.stop")}
              onClick={(event) => {
                event.stopPropagation();
                void stopProfile(profile.id);
              }}
              type="button"
            >
              {stopPending ? <LoaderCircle size={15} aria-hidden="true" /> : <CircleStop size={15} aria-hidden="true" />}
              {stopPending ? statusText("stopping", t) : t("actions.stop")}
            </button>
          ) : (
            <button
              className={`row-primary ${launchPending ? "loading" : ""}`}
              disabled={browserCoreMissing || launchPending}
              title={launchPending ? statusText("launching", t) : t("actions.open")}
              onClick={(event) => {
                event.stopPropagation();
                void launchProfile(profile.id);
              }}
              type="button"
            >
              {launchPending ? <LoaderCircle size={16} aria-hidden="true" /> : <Globe2 size={16} aria-hidden="true" />}
              {launchPending ? statusText("launching", t) : t("actions.open")}
            </button>
          )}
        </div>
      );
  }
}

function UpdatedAtCell({ value }: { value: string }) {
  const date = new Date(value);
  const valid = Number.isFinite(date.getTime());
  if (!valid) {
    return (
      <span className="updated-at-cell">
        <strong>-</strong>
        <small>-</small>
      </span>
    );
  }
  return (
    <span className="updated-at-cell">
      <strong>{date.toLocaleDateString()}</strong>
      <small>{date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</small>
    </span>
  );
}

function statusIcon(status: SessionSummary["status"] | "stopped"): ReactNode {
  if (status === "running") return <PlayCircle size={16} aria-hidden="true" />;
  if (status === "launching" || status === "stopping") return <LoaderCircle className="spin-icon" size={16} aria-hidden="true" />;
  if (status === "error") return <CircleAlert size={16} aria-hidden="true" />;
  return <PauseCircle size={16} aria-hidden="true" />;
}

function ModeCell({
  mode,
  t,
}: {
  mode: ProfileMode;
  t: (key: TranslationKey) => string;
}) {
  const isPersistent = mode === "persistent";
  const label = t(isPersistent ? "mode.persistent" : "mode.ephemeral");
  return (
    <span className={`mode-cell icon-only ${mode}`} title={label} aria-label={label}>
      {isPersistent ? <Database size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}
    </span>
  );
}

function ExitCell({
  profile,
  check,
  t,
  locale,
}: {
  profile: BrowserProfile;
  check: NetworkCheckResult | undefined;
  t: (key: TranslationKey) => string;
  locale: Locale;
}) {
  const info = exitCellInfo(profile, check, t, locale);
  return (
    <span className={`ip-cell ${info.tone}`} title={exitCellTitle(profile, check, t, locale)}>
      <span className="ip-region-line">
        <Globe2 size={14} aria-hidden="true" />
        <strong>{info.primary}</strong>
      </span>
      <small>{info.secondary}</small>
    </span>
  );
}

function exitCellInfo(
  profile: BrowserProfile,
  check: NetworkCheckResult | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: Locale,
): { primary: string; secondary: string; tone: "direct" | "ok" | "failed" | "unchecked" } {
  const proxy = buildProxyUrl(profile.proxy);
  if (!proxy) {
    return { primary: t("table.directConnection"), secondary: "-", tone: "direct" };
  }
  const explicitWebrtc = profile.fingerprint.webrtcIp === "custom" ? profile.fingerprint.webrtcIpValue.trim() : "";
  if (explicitWebrtc) {
    return { primary: explicitWebrtc, secondary: t("network.ip", { ip: explicitWebrtc }), tone: "ok" };
  }
  if (check?.ok) {
    const locationParts = buildNetworkCheckSuccessParts(check, {
      includeFlag: true,
      includeIp: false,
      includeLatency: false,
      locale,
    });
    const exitFacts = locationParts.join(" · ");
    return {
      primary: exitFacts || check.ip || t("table.ipUnchecked"),
      secondary: check.ip || t("table.ipUnchecked"),
      tone: "ok",
    };
  }
  if (check && !check.ok) {
    return { primary: t("table.ipCheckFailed"), secondary: check.error || t("table.ipUnchecked"), tone: "failed" };
  }
  return { primary: t("table.ipUnchecked"), secondary: maskProxyUrlForDisplay(proxy), tone: "unchecked" };
}

function exitCellTitle(
  profile: BrowserProfile,
  check: NetworkCheckResult | undefined,
  t: (key: TranslationKey) => string,
  locale: Locale,
): string {
  const proxy = buildProxyUrl(profile.proxy);
  const parts = proxy
    ? [
        t("table.proxy"),
        maskProxyUrlForDisplay(proxy),
        networkCheckSummaryText(check, { emptyText: t("table.ipUnchecked"), failedText: t("table.ipCheckFailed"), includeFlag: true, locale, separator: " / " }),
      ]
    : [t("table.directConnection"), networkCheckSummaryText(check, { emptyText: t("table.ipUnchecked"), failedText: t("table.ipCheckFailed"), includeFlag: true, locale, separator: " / " })];
  return parts.filter(Boolean).join(" / ");
}

export function statusText(status: SessionSummary["status"] | "stopped", t: (key: TranslationKey) => string): string {
  if (status === "running") return t("status.running");
  if (status === "launching") return t("status.launching");
  if (status === "stopping") return t("status.stopping");
  if (status === "error") return t("status.error");
  return t("status.stopped");
}
