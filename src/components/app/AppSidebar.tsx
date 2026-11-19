import type { ReactNode } from "react";
import {
  FilePlus2,
  PanelLeftClose,
  PanelLeftOpen,
  Settings2,
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { APP_BRAND, formatAppVersionLabel, type AppVersionInfo } from "../../shared/appVersion";
import type { ModuleStats, WorkbenchView } from "../registry/registryStats";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { WorkbenchViewIcon } from "./WorkbenchViewIcon";

type AppSidebarProps = {
  browserCoreMissing: boolean;
  busy: string;
  moduleStats: ModuleStats;
  /** Draws the brand mark. Injected so this module carries no bundler-only `.svg` import. */
  renderMark: (className: string) => ReactNode;
  sidebarCollapsed: boolean;
  settingsActive: boolean;
  totalProfiles: number;
  trashCount: number;
  updateAvailable: boolean;
  updateVersion?: string;
  versions?: AppVersionInfo;
  workbenchView: WorkbenchView;
  createProfile: () => void;
  openAbout: () => void;
  openSettings: () => void;
  setWorkbenchView: (view: WorkbenchView) => void;
  showProfileView: () => void;
  toggleSidebarMode: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
};

export function AppSidebar({
  browserCoreMissing,
  busy,
  moduleStats,
  renderMark,
  sidebarCollapsed,
  settingsActive,
  totalProfiles,
  trashCount,
  updateAvailable,
  updateVersion,
  versions,
  workbenchView,
  createProfile,
  openAbout,
  openSettings,
  setWorkbenchView,
  showProfileView,
  toggleSidebarMode,
  t,
}: AppSidebarProps) {
  const versionLabel = formatAppVersionLabel(versions);
  const updateHint = updateAvailable
    ? t("about.update.available", { version: updateVersion ?? "" })
    : undefined;

  const openView = (view: WorkbenchView) => {
    setWorkbenchView(view);
  };

  return (
    <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
      {/* The brand block is the shortest path to what this build is: clicking it opens Settings → About,
          which is where the identity, versions and environment rows now live. It is an implicit
          affordance on purpose — no button chrome, no hover treatment, no tooltip — so the mark reads
          as the app's identity instead of competing with the nav rows. */}
      <div className="sidebar-brand" onClick={openAbout}>
        {renderMark("brand-mark app-icon-mark")}
        <span className="sidebar-brand-copy">
          <strong>{APP_BRAND}</strong>
          {versionLabel && <small className="sidebar-brand-versions">{versionLabel}</small>}
        </span>
      </div>

      <button className="sidebar-create" disabled={busy === "create"} onClick={createProfile} title={t("actions.new")} type="button">
        <NewProfileIcon size={18} />
        <span>{t("actions.new")}</span>
      </button>

      <nav className="sidebar-nav" aria-label={t("nav.main")}>
        <div className="sidebar-nav-group">
          <span className="sidebar-nav-label">{t("nav.sectionWorkspace")}</span>
          {browserCoreMissing && (
            <SidebarNavButton
              active={workbenchView === "runtimeCheck"}
              icon={<WorkbenchViewIcon size={19} view="runtimeCheck" />}
              label={t("nav.runtimeCheck")}
              meta={t("browserCore.missingShort")}
              onClick={() => openView("runtimeCheck")}
            />
          )}
          <SidebarNavButton
            active={workbenchView === "profiles"}
            icon={<WorkbenchViewIcon size={19} view="profiles" />}
            label={t("nav.profiles")}
            meta={totalProfiles > 0 ? String(totalProfiles) : undefined}
            onClick={showProfileView}
          />
        </div>

        <div className="sidebar-nav-group">
          <span className="sidebar-nav-label">{t("nav.sectionResources")}</span>
          <SidebarNavButton
            active={workbenchView === "groups"}
            icon={<WorkbenchViewIcon size={19} view="groups" />}
            label={t("nav.groups")}
            meta={moduleStats.groups.length > 0 ? String(moduleStats.groups.length) : undefined}
            onClick={() => openView("groups")}
          />
          <SidebarNavButton
            active={workbenchView === "tags"}
            icon={<WorkbenchViewIcon size={19} view="tags" />}
            label={t("nav.tags")}
            meta={moduleStats.tags.length > 0 ? String(moduleStats.tags.length) : undefined}
            onClick={() => openView("tags")}
          />
          <SidebarNavButton
            active={workbenchView === "proxies"}
            icon={<WorkbenchViewIcon size={19} view="proxies" />}
            label={t("nav.proxies")}
            meta={moduleStats.proxies.length > 0 ? String(moduleStats.proxies.length) : undefined}
            onClick={() => openView("proxies")}
          />
          <SidebarNavButton
            active={workbenchView === "extensions"}
            icon={<WorkbenchViewIcon size={19} view="extensions" />}
            label={t("nav.extensions")}
            meta={moduleStats.extensions.length > 0 ? String(moduleStats.extensions.length) : undefined}
            onClick={() => openView("extensions")}
          />
        </div>

        <div className="sidebar-nav-group sidebar-nav-group-system">
          <SidebarNavButton
            active={workbenchView === "trash"}
            icon={<WorkbenchViewIcon size={19} view="trash" />}
            label={t("nav.trash")}
            meta={trashCount > 0 ? String(trashCount) : undefined}
            onClick={() => openView("trash")}
          />
        </div>
      </nav>

      <div className="sidebar-footer" aria-label={t("nav.settings")}>
        <SidebarUtilityButton
          icon={
            sidebarCollapsed ? (
              <PanelLeftOpen size={19} aria-hidden="true" />
            ) : (
              <PanelLeftClose size={19} aria-hidden="true" />
            )
          }
          label={sidebarCollapsed ? t("actions.expandSidebar") : t("actions.collapseSidebar")}
          onClick={toggleSidebarMode}
          pressed={sidebarCollapsed}
        />
        <SidebarUtilityButton
          active={settingsActive}
          badge={updateAvailable}
          hint={updateHint}
          icon={<Settings2 size={19} aria-hidden="true" />}
          label={t("nav.settings")}
          onClick={openSettings}
        />
      </div>
    </aside>
  );
}
function SidebarNavButton({
  active = false,
  disabled = false,
  icon,
  label,
  meta,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  meta?: string;
  onClick?: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button className={`sidebar-button ${active ? "active" : ""}`} aria-label={label} disabled={disabled} title={label} onClick={onClick} type="button">
          {icon}
          <span>
            <strong>{label}</strong>
            {meta && <small>{meta}</small>}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {meta ? (
          <span className="sidebar-tooltip-stack">
            <strong>{label}</strong>
            <small>{meta}</small>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function SidebarUtilityButton({
  active = false,
  badge = false,
  hint,
  icon,
  label,
  onClick,
  pressed,
}: {
  active?: boolean;
  badge?: boolean;
  hint?: string;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  const accessibleLabel = hint ? `${label} · ${hint}` : label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={accessibleLabel}
          aria-pressed={pressed}
          className={`sidebar-utility ${active ? "active" : ""}`}
          onClick={onClick}
          title={accessibleLabel}
          type="button"
        >
          <span className="sidebar-utility-icon">
            {icon}
            {badge && <i className="sidebar-utility-dot" aria-hidden="true" />}
          </span>
          <span>{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {hint ? (
          <span className="sidebar-tooltip-stack">
            <strong>{label}</strong>
            <small>{hint}</small>
          </span>
        ) : (
          label
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function NewProfileIcon({ size }: { size: number }) {
  return (
    <span className="new-profile-icon" aria-hidden="true">
      <FilePlus2 size={size} strokeWidth={2.4} />
    </span>
  );
}
