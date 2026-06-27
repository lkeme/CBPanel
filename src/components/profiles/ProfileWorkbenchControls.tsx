import type { RefObject } from "react";
import {
  CircleAlert,
  CircleStop,
  Columns3,
  Download,
  FileInput,
  Funnel,
  Layers3,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { ModeFilter, ProxyFilter, StatusFilter } from "../registry/registryStats";

type ProfileWorkbenchControlsProps = {
  activeFilterCount: number;
  allTags: string[];
  browserCoreMissing: boolean;
  filterPanelOpen: boolean;
  importInput: RefObject<HTMLInputElement | null>;
  inspectorOpen: boolean;
  query: string;
  selectedCount: number;
  statusFilter: StatusFilter;
  proxyFilter: ProxyFilter;
  modeFilter: ModeFilter;
  tagFilters: string[];
  batchDelete: () => Promise<void>;
  batchExport: () => Promise<void>;
  batchGroupOrTag: () => Promise<void>;
  batchLaunch: () => Promise<void>;
  batchStop: () => Promise<void>;
  exportProfiles: () => Promise<void>;
  importEnvironmentPackage: () => Promise<void>;
  importProfiles: (file: File) => Promise<void>;
  loadState: () => Promise<void>;
  openColumns: () => void;
  resetFilters: () => void;
  setFilterPanelOpen: (updater: (current: boolean) => boolean) => void;
  setModeFilter: (filter: ModeFilter) => void;
  setProxyFilter: (filter: ProxyFilter) => void;
  setQuery: (query: string) => void;
  setStatusFilter: (filter: StatusFilter | ((current: StatusFilter) => StatusFilter)) => void;
  showBrowserCoreMissing: () => void;
  toggleInspector: () => void;
  toggleTagFilter: (tag: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
};

export function ProfileWorkbenchControls({
  activeFilterCount,
  allTags,
  browserCoreMissing,
  filterPanelOpen,
  importInput,
  inspectorOpen,
  query,
  selectedCount,
  statusFilter,
  proxyFilter,
  modeFilter,
  tagFilters,
  batchDelete,
  batchExport,
  batchGroupOrTag,
  batchLaunch,
  batchStop,
  exportProfiles,
  importEnvironmentPackage,
  importProfiles,
  loadState,
  openColumns,
  resetFilters,
  setFilterPanelOpen,
  setModeFilter,
  setProxyFilter,
  setQuery,
  setStatusFilter,
  showBrowserCoreMissing,
  toggleInspector,
  toggleTagFilter,
  t,
}: ProfileWorkbenchControlsProps) {
  return (
    <>
      <section className="toolbar-band workbench-toolbar">
        <div className="toolbar-left">
          <label className="search-box" aria-label={t("search.placeholder")}>
            <Search size={16} aria-hidden="true" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("search.placeholder")} />
          </label>
          <button className={`filter-chip ${activeFilterCount === 0 ? "active" : ""}`} onClick={resetFilters} type="button">
            {t("filter.all")}
          </button>
          <button
            className={`filter-chip ${statusFilter === "running" ? "active" : ""}`}
            onClick={() => setStatusFilter((current) => (current === "running" ? "all" : "running"))}
            type="button"
          >
            {t("filter.running")}
          </button>
          <button
            className={`filter-chip ${filterPanelOpen || activeFilterCount > 0 ? "active" : ""}`}
            onClick={() => setFilterPanelOpen((current) => !current)}
            type="button"
          >
            <Funnel size={15} aria-hidden="true" />
            {activeFilterCount > 0 ? t("filter.moreCount", { count: activeFilterCount }) : t("filter.more")}
          </button>
          {browserCoreMissing && (
            <button className="filter-chip warning active" onClick={showBrowserCoreMissing} type="button">
              <CircleAlert size={15} aria-hidden="true" />
              {t("browserCore.missingShort")}
            </button>
          )}
        </div>
        <div className="toolbar-actions">
          <input
            ref={importInput}
            className="hidden-input"
            accept="application/json"
            type="file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importProfiles(file);
            }}
          />
          <button className="icon-button" aria-label={t("actions.import")} title={t("actions.import")} onClick={() => void importEnvironmentPackage()} type="button">
            <FileInput size={17} aria-hidden="true" />
          </button>
          <button className="icon-button" aria-label={t("actions.export")} title={t("actions.export")} onClick={() => void exportProfiles()} type="button">
            <Download size={17} aria-hidden="true" />
          </button>
          <button className="icon-button" aria-label={t("table.columnSettings")} title={t("table.columnSettings")} onClick={openColumns} type="button">
            <Columns3 size={17} aria-hidden="true" />
          </button>
          <button
            className="icon-button"
            aria-label={inspectorOpen ? t("settings.hideInspector") : t("settings.showInspector")}
            title={inspectorOpen ? t("settings.hideInspector") : t("settings.showInspector")}
            onClick={toggleInspector}
            type="button"
          >
            {inspectorOpen ? <PanelRightClose size={17} /> : <PanelRightOpen size={17} />}
          </button>
          <button className="icon-button" aria-label={t("actions.refresh")} title={t("actions.refresh")} onClick={() => void loadState()} type="button">
            <RefreshCw size={18} aria-hidden="true" />
          </button>
        </div>
      </section>

      {filterPanelOpen && (
        <section className="filter-panel" aria-label={t("filter.panel")}>
          <div className="filter-group">
            <strong>{t("filter.status")}</strong>
            <button className={`filter-chip small ${statusFilter === "all" ? "active" : ""}`} onClick={() => setStatusFilter("all")} type="button">
              {t("filter.all")}
            </button>
            <button className={`filter-chip small ${statusFilter === "running" ? "active" : ""}`} onClick={() => setStatusFilter("running")} type="button">
              {t("filter.running")}
            </button>
          </div>
          <div className="filter-group">
            <strong>{t("filter.proxy")}</strong>
            <button className={`filter-chip small ${proxyFilter === "all" ? "active" : ""}`} onClick={() => setProxyFilter("all")} type="button">
              {t("filter.all")}
            </button>
            <button className={`filter-chip small ${proxyFilter === "enabled" ? "active" : ""}`} onClick={() => setProxyFilter("enabled")} type="button">
              {t("filter.proxyEnabled")}
            </button>
            <button className={`filter-chip small ${proxyFilter === "disabled" ? "active" : ""}`} onClick={() => setProxyFilter("disabled")} type="button">
              {t("filter.proxyDisabled")}
            </button>
          </div>
          <div className="filter-group">
            <strong>{t("filter.mode")}</strong>
            <button className={`filter-chip small ${modeFilter === "all" ? "active" : ""}`} onClick={() => setModeFilter("all")} type="button">
              {t("filter.all")}
            </button>
            <button className={`filter-chip small ${modeFilter === "persistent" ? "active" : ""}`} onClick={() => setModeFilter("persistent")} type="button">
              {t("mode.persistent")}
            </button>
            <button className={`filter-chip small ${modeFilter === "ephemeral" ? "active" : ""}`} onClick={() => setModeFilter("ephemeral")} type="button">
              {t("mode.ephemeral")}
            </button>
          </div>
          {allTags.length > 0 && (
            <div className="filter-group tags">
              <strong>{t("filter.tags")}</strong>
              {allTags.map((tag) => (
                <button
                  className={`tag filter-tag ${tagFilters.includes(tag) ? "active" : ""}`}
                  key={tag}
                  onClick={() => toggleTagFilter(tag)}
                  type="button"
                >
                  {tag}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {selectedCount > 0 && (
        <section className="batch-bar">
          <strong>{t("batch.selected", { count: selectedCount })}</strong>
          <button className="command success" onClick={() => void batchLaunch()} type="button">
            <Play size={17} />
            {t("actions.launch")}
          </button>
          <button className="command" onClick={() => void batchStop()} type="button">
            <CircleStop size={17} />
            {t("actions.stop")}
          </button>
          <button className="command" onClick={() => void batchGroupOrTag()} type="button">
            <Layers3 size={17} />
            {t("batch.group")}
          </button>
          <button className="command" onClick={() => void batchExport()} type="button">
            <Download size={17} />
            {t("batch.export")}
          </button>
          <button className="command danger subtle" onClick={() => void batchDelete()} type="button">
            <Trash2 size={17} />
            {t("batch.delete")}
          </button>
        </section>
      )}
    </>
  );
}
