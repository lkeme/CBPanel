import type { ReactNode } from "react";
import {
  Archive,
  FilePlus2,
  FolderKanban,
  Info,
  Languages,
  Layers3,
  ListChecks,
  Moon,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Plug,
  Settings2,
  Sun,
  Tags,
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { AppSettings } from "../../shared/settings";
import type { ModuleStats, WorkbenchView } from "../registry/registryStats";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { AppMark } from "./AppMark";

type AppSidebarProps = {
  browserCoreMissing: boolean;
  busy: string;
  moduleStats: ModuleStats;
  normalizedSettings: AppSettings;
  sidebarCollapsed: boolean;
  settingsActive: boolean;
  totalProfiles: number;
  trashCount: number;
  workbenchView: WorkbenchView;
  createProfile: () => void;
  cycleLanguage: () => void;
  cycleTheme: () => void;
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
  normalizedSettings,
  sidebarCollapsed,
  settingsActive,
  totalProfiles,
  trashCount,
  workbenchView,
  createProfile,
  cycleLanguage,
  cycleTheme,
  openSettings,
  setWorkbenchView,
  showProfileView,
  toggleSidebarMode,
  t,
}: AppSidebarProps) {
  const openView = (view: WorkbenchView) => {
    setWorkbenchView(view);
  };

  return (
    <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
      <div className="sidebar-brand">
        <AppMark className="brand-mark app-icon-mark" />
        <div>
          <strong>CBPanel</strong>
        </div>
      </div>

      <button className="sidebar-create" disabled={busy === "create"} onClick={createProfile} title={t("actions.new")} type="button">
        <span>{t("actions.new")}</span>
        <NewProfileIcon size={22} />
      </button>

      <nav className="sidebar-nav" aria-label={t("nav.profiles")}>
        {browserCoreMissing && (
          <SidebarNavButton
            active={workbenchView === "runtimeCheck"}
            icon={<ListChecks size={20} aria-hidden="true" />}
            label={t("nav.runtimeCheck")}
            meta={t("browserCore.missingShort")}
            onClick={() => openView("runtimeCheck")}
          />
        )}
        <SidebarNavButton
          active={workbenchView === "profiles"}
          icon={<Layers3 size={20} aria-hidden="true" />}
          label={t("nav.profiles")}
          meta={t("nav.profiles.meta", { count: totalProfiles })}
          onClick={showProfileView}
        />
        <SidebarNavButton
          active={workbenchView === "groups"}
          icon={<FolderKanban size={20} aria-hidden="true" />}
          label={t("nav.groups")}
          meta={t("nav.groups.meta", { count: moduleStats.groups.length })}
          onClick={() => openView("groups")}
        />
        <SidebarNavButton
          active={workbenchView === "tags"}
          icon={<Tags size={20} aria-hidden="true" />}
          label={t("nav.tags")}
          meta={t("nav.tags.meta", { count: moduleStats.tags.length })}
          onClick={() => openView("tags")}
        />
        <SidebarNavButton
          active={workbenchView === "proxies"}
          icon={<Network size={20} aria-hidden="true" />}
          label={t("nav.proxies")}
          meta={t("nav.proxies.meta", { count: moduleStats.proxies.length })}
          onClick={() => openView("proxies")}
        />
        <SidebarNavButton
          active={workbenchView === "extensions"}
          icon={<Plug size={20} aria-hidden="true" />}
          label={t("nav.extensions")}
          meta={t("nav.extensions.meta", { count: moduleStats.extensions.length })}
          onClick={() => openView("extensions")}
        />
        <SidebarNavButton
          active={workbenchView === "trash"}
          icon={<Archive size={20} aria-hidden="true" />}
          label={t("nav.trash")}
          meta={t("nav.trash.meta", { count: trashCount })}
          onClick={() => openView("trash")}
        />
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
          pressed={!sidebarCollapsed}
        />
        <SidebarUtilityButton
          icon={normalizedSettings.appearance.theme === "dark" ? <Moon size={19} aria-hidden="true" /> : <Sun size={19} aria-hidden="true" />}
          label={`${t("actions.toggleTheme")} - ${
            normalizedSettings.appearance.theme === "dark"
              ? t("settings.dark")
              : normalizedSettings.appearance.theme === "light"
                ? t("settings.light")
                : t("settings.system")
          }`}
          onClick={cycleTheme}
          pressed={normalizedSettings.appearance.theme === "dark"}
        />
        <SidebarUtilityButton
          icon={<Languages size={19} aria-hidden="true" />}
          label={`${t("actions.toggleLanguage")} - ${
            normalizedSettings.appearance.language === "en-US"
              ? t("settings.language.enUS")
              : normalizedSettings.appearance.language === "zh-CN"
                ? t("settings.language.zhCN")
                : t("settings.system")
          }`}
          onClick={cycleLanguage}
          pressed={normalizedSettings.appearance.language === "en-US"}
        />
        <SidebarUtilityButton
          active={settingsActive}
          icon={<Settings2 size={19} aria-hidden="true" />}
          label={t("nav.settings")}
          onClick={openSettings}
        />
        <SidebarUtilityButton
          active={workbenchView === "system"}
          icon={<Info size={19} aria-hidden="true" />}
          label={t("nav.system")}
          onClick={() => openView("system")}
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
  icon,
  label,
  onClick,
  pressed,
}: {
  active?: boolean;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={label}
          aria-pressed={pressed}
          className={`sidebar-utility ${active ? "active" : ""}`}
          onClick={onClick}
          title={label}
          type="button"
        >
          {icon}
          <span>{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
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
