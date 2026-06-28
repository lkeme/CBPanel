import type { TranslationKey } from "../../i18n";
import type { BinaryInfo } from "../../shared/browserCore";
import type { GithubMirrorProbeResponse } from "../../shared/githubMirror";
import {
  ADVANCED_WEB_ENTRY_CODE,
  type AppSettings,
  type AppSettingsPatch,
  type BrowserCoreTierMode,
  type DesktopCloseBehavior,
  type DesktopRuntimeInfo,
  normalizeSettings,
} from "../../shared/settings";
import { BrowserCoreSettingsPanel } from "./BrowserCoreSettingsPanel";
import { NetworkSettingsPanel } from "./NetworkSettingsPanel";
import { CopyButton } from "../ui/CopyButton";
import { Drawer, Field, InfoTip, NumberField, Segmented, ToggleField } from "../ui/form-controls";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Download, Upload } from "lucide-react";

export type SettingsTab = "general" | "appearance" | "network" | "browserCore" | "advanced";

export function SettingsDrawer({
  binaryInfo,
  busy,
  checkBrowserCoreUpdate,
  checkGithubMirrors,
  close,
  clearBinaryCache,
  importBrowserCoreZip,
  exportAppBackup,
  initialTab,
  installBinary,
  restoreAppBackup,
  openRuntimeCheck,
  requestAdvancedWebEntry,
  runtime,
  settings,
  saveSettings,
  t,
  updateBinary,
}: {
  binaryInfo: BinaryInfo | null;
  busy: string;
  checkBrowserCoreUpdate: () => Promise<void>;
  checkGithubMirrors: (customGithubMirrorPrefix: string) => Promise<GithubMirrorProbeResponse>;
  close: () => void;
  clearBinaryCache: () => Promise<void>;
  exportAppBackup: () => Promise<void>;
  importBrowserCoreZip: (
    filePath: string,
    options?: { setAsDefault?: boolean; targetTier?: BrowserCoreTierMode },
  ) => void;
  initialTab: SettingsTab;
  installBinary: () => Promise<void>;
  openRuntimeCheck: () => void;
  requestAdvancedWebEntry: () => void;
  restoreAppBackup: () => Promise<void>;
  runtime: DesktopRuntimeInfo | null;
  settings: AppSettings;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateBinary: () => Promise<void>;
}) {
  const normalized = normalizeSettings(settings);
  function setAdvancedWebEntry(advancedWebEntry: boolean) {
    if (advancedWebEntry && !normalized.desktop.advancedWebEntry) {
      requestAdvancedWebEntry();
      return;
    }
    void saveSettings({ desktop: { ...normalized.desktop, advancedWebEntry } });
  }

  const maintenanceUrl = advancedWebEntryUrl(runtime);

  return (
    <Drawer title={t("nav.settings")} close={close} t={t}>
      <Tabs defaultValue={initialTab} className="settings-tabs">
        <TabsList className="settings-tab-list" aria-label={t("settings.sections")}>
          <TabsTrigger value="general">{t("settings.general")}</TabsTrigger>
          <TabsTrigger value="appearance">{t("settings.interface")}</TabsTrigger>
          <TabsTrigger value="network">{t("settings.network")}</TabsTrigger>
          <TabsTrigger value="browserCore">{t("settings.browserCore")}</TabsTrigger>
          <TabsTrigger value="advanced">{t("settings.advanced")}</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="motion-tab-content">
          <section className="settings-section">
            <h2>{t("settings.appPreferences")}</h2>
            <Field label={t("settings.language")}>
              <Segmented
                value={normalized.appearance.language}
                options={[
                  { value: "system", label: t("settings.system") },
                  { value: "zh-CN", label: t("settings.language.zhCN") },
                  { value: "en-US", label: t("settings.language.enUS") },
                ]}
                onChange={(language) => void saveSettings({ appearance: { ...normalized.appearance, language } })}
              />
            </Field>
            {runtime?.shell === "desktop" && runtime.platform === "windows" && (
              <Field label={t("settings.closeBehavior")} help={t("settings.closeBehaviorHelp")}>
                <Segmented<DesktopCloseBehavior>
                  value={normalized.desktop.closeBehavior}
                  options={[
                    { value: "ask", label: t("settings.closeBehavior.ask") },
                    { value: "tray", label: t("settings.closeBehavior.tray") },
                    { value: "quit", label: t("settings.closeBehavior.quit") },
                  ]}
                  onChange={(closeBehavior) =>
                    void saveSettings({
                      desktop: { ...normalized.desktop, closeBehavior, closeToTray: closeBehavior === "tray" },
                    })
                  }
                />
              </Field>
            )}
          </section>
        </TabsContent>

        <TabsContent value="appearance" className="motion-tab-content">
          <div className="settings-stack no-padding">
            <section className="settings-section">
              <h2>{t("settings.themeDisplay")}</h2>
              <Field label={t("settings.theme")}>
                <Segmented
                  value={normalized.appearance.theme}
                  options={[
                    { value: "system", label: t("settings.system") },
                    { value: "light", label: t("settings.light") },
                    { value: "dark", label: t("settings.dark") },
                  ]}
                  onChange={(theme) => void saveSettings({ appearance: { ...normalized.appearance, theme } })}
                />
              </Field>
              <Field label={t("settings.density")}>
                <Segmented
                  value={normalized.appearance.density}
                  options={[
                    { value: "compact", label: t("settings.compact") },
                    { value: "comfortable", label: t("settings.comfortable") },
                  ]}
                  onChange={(density) => void saveSettings({ appearance: { ...normalized.appearance, density } })}
                />
              </Field>
            </section>
            <section className="settings-section">
              <h2>{t("settings.fonts")}</h2>
              <Field label={t("settings.uiFont")}>
                <input
                  value={normalized.appearance.uiFontFamily}
                  onChange={(event) =>
                    void saveSettings({ appearance: { ...normalized.appearance, uiFontFamily: event.target.value } })
                  }
                />
              </Field>
              <Field label={t("settings.monoFont")} help={t("settings.monoFontHelp")}>
                <input
                  value={normalized.appearance.monoFontFamily}
                  onChange={(event) =>
                    void saveSettings({ appearance: { ...normalized.appearance, monoFontFamily: event.target.value } })
                  }
                />
              </Field>
              <div className="settings-number-grid">
                <NumberField
                  label={t("settings.baseFontSize")}
                  value={normalized.appearance.baseFontSize}
                  min={12}
                  max={22}
                  onChange={(baseFontSize) => void saveSettings({ appearance: { ...normalized.appearance, baseFontSize } })}
                />
                <NumberField
                  label={t("settings.tableFontSize")}
                  value={normalized.appearance.tableFontSize}
                  min={11}
                  max={20}
                  onChange={(tableFontSize) => void saveSettings({ appearance: { ...normalized.appearance, tableFontSize } })}
                />
                <NumberField
                  label={t("settings.codeFontSize")}
                  value={normalized.appearance.codeFontSize}
                  min={11}
                  max={20}
                  onChange={(codeFontSize) => void saveSettings({ appearance: { ...normalized.appearance, codeFontSize } })}
                />
              </div>
            </section>
          </div>
        </TabsContent>

        <TabsContent value="network" className="motion-tab-content">
          <NetworkSettingsPanel
            checkGithubMirrors={checkGithubMirrors}
            saveSettings={saveSettings}
            settings={normalized}
            t={t}
          />
        </TabsContent>

        <TabsContent value="browserCore" className="motion-tab-content">
          <BrowserCoreSettingsPanel
            binaryInfo={binaryInfo}
            busy={busy}
            checkBrowserCoreUpdate={checkBrowserCoreUpdate}
            clearBinaryCache={clearBinaryCache}
            importBrowserCoreZip={importBrowserCoreZip}
            installBinary={installBinary}
            openRuntimeCheck={openRuntimeCheck}
            saveSettings={saveSettings}
            settings={normalized}
            t={t}
            updateBinary={updateBinary}
          />
        </TabsContent>

        <TabsContent value="advanced" className="motion-tab-content">
          <div className="settings-stack no-padding">
            <section className="settings-section">
              <div className="settings-section-head">
                <h2>{t("appBackup.title")}</h2>
                <InfoTip text={t("appBackup.help")} />
              </div>
              <div className="settings-action-row">
                <button className="command" disabled={busy === "app-backup-export"} onClick={() => void exportAppBackup()} type="button">
                  <Download size={15} />
                  {t("appBackup.export")}
                </button>
                <button className="command danger subtle" disabled={busy === "app-backup-restore"} onClick={() => void restoreAppBackup()} type="button">
                  <Upload size={15} />
                  {t("appBackup.restore")}
                </button>
              </div>
              <div className="result-line">{t("appBackup.includes")}</div>
            </section>
            <section className="settings-section">
              <h2>{t("settings.maintenanceEntry")}</h2>
              <ToggleField
                label={t("settings.advancedWebEntry")}
                help={t("tips.advancedWebEntry", { code: ADVANCED_WEB_ENTRY_CODE })}
                checked={normalized.desktop.advancedWebEntry}
                onChange={setAdvancedWebEntry}
              />
              <div className={`settings-status-line ${normalized.desktop.advancedWebEntry ? "enabled" : ""}`}>
                <span className="settings-status-heading">
                  <strong>
                    {normalized.desktop.advancedWebEntry
                      ? t("settings.advancedWebEnabled")
                      : t("settings.advancedWebDisabled")}
                  </strong>
                  <InfoTip text={t("settings.advancedWebEffect")} />
                </span>
                {normalized.desktop.advancedWebEntry && (
                  <span className="settings-status-address">
                    <span>{t("settings.advancedWebAddress")}</span>
                    <a href={maintenanceUrl} target="_blank" rel="noreferrer">
                      {maintenanceUrl}
                    </a>
                    <CopyButton value={maintenanceUrl} t={t} />
                  </span>
                )}
              </div>
            </section>
          </div>
        </TabsContent>

        {busy === "settings" && <div className="result-line">{t("status.saving")}</div>}
      </Tabs>
    </Drawer>
  );
}

function advancedWebEntryUrl(runtime: DesktopRuntimeInfo | null): string {
  if (runtime?.shell === "desktop" && runtime.api.port > 0) {
    return `http://${runtime.api.host || "127.0.0.1"}:${runtime.api.port}`;
  }
  return window.location.origin;
}
