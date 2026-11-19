import { isTauri } from "@tauri-apps/api/core";
import { ArrowUpCircle, Boxes, Bug, CircleAlert, Copy, Cpu, Download, ExternalLink, FolderOpen, HardDrive, RefreshCw, Scale, Server, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";

import type { Locale, TranslationKey } from "../../i18n";
import { formatArchitecture, formatCopyrightYears } from "../../shared/aboutInfo";
import type { AppUpdateCheck } from "../../shared/appUpdate";
import {
  APP_BRAND,
  APP_COPYRIGHT_HOLDER,
  APP_COPYRIGHT_START_YEAR,
  type AppVersionInfo,
} from "../../shared/appVersion";
import type { BinaryInfo } from "../../shared/browserCore";
import type { SystemDiagnostics } from "../../shared/entities";
import type { DesktopRuntimeInfo, StorageInfo } from "../../shared/settings";
import type { AboutLink } from "../../lib/aboutExternalNavigation";
import { formatRelativeTime } from "../registry/RegistryEntityRow";
import { KeyValueList } from "../ui/KeyValueList";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export type AboutUpdateProps = {
  currentVersion: string;
  check: AppUpdateCheck | undefined;
  checking: boolean;
  portable: boolean;
  onCheck: () => void;
  onDownload: () => void;
  onOpenReleasePage: () => void;
};

export type AboutContentProps = {
  appUpdate: AboutUpdateProps;
  binaryInfo: BinaryInfo | null;
  copyDiagnostics: () => Promise<void>;
  diagnostics: SystemDiagnostics | null;
  exportDiagnostics: () => void;
  locale: Locale;
  openDataDirectory: (path: string | undefined) => Promise<void>;
  /** Opens one whitelisted destination; the shell validates the key on both sides. */
  openLink: (link: AboutLink) => Promise<void>;
  /** Web mode opens the current origin; desktop mode opens the loopback sidecar in the system browser. */
  openSidecarEndpoint: (port: number | undefined) => Promise<void>;
  /**
   * Draws the brand mark for a class name. Injected rather than imported so this module carries no
   * bundler-only `.svg` import and stays renderable by plain Node tests.
   */
  renderMark: (className: string) => ReactNode;
  runtime: DesktopRuntimeInfo | null;
  storage?: StorageInfo;
  t: Translate;
  versions: AppVersionInfo;
};

/**
 * What the application is, which machine it runs on, and where its data lives. Operational state —
 * sessions, engines, core probes, GeoIP — lives in Settings → Core, Settings → Network and the
 * diagnostics export; this page keeps only the facts that describe the installation itself.
 */
export function AboutContent({
  appUpdate,
  binaryInfo,
  copyDiagnostics,
  diagnostics,
  exportDiagnostics,
  locale,
  openDataDirectory,
  openLink,
  openSidecarEndpoint,
  renderMark,
  runtime,
  storage,
  t,
  versions,
}: AboutContentProps) {
  const core = binaryInfo?.core;
  const host = diagnostics?.host;
  const portable = storage?.portable ?? runtime?.portable ?? diagnostics?.portable ?? false;
  const dataDir = diagnostics?.dataDir;
  const copyright = `© ${formatCopyrightYears(APP_COPYRIGHT_START_YEAR)} ${APP_COPYRIGHT_HOLDER}. All rights reserved.`;
  const sidecarPort = runtime?.api.port ?? 0;
  const sidecarEndpoint = sidecarPort > 0 ? `${runtime?.api.host || "127.0.0.1"}:${sidecarPort}` : "-";

  return (
    <div className="settings-stack no-padding about-page">
      <section className="settings-section about-hero">
        <div className="about-identity">
          {renderMark("brand-mark app-icon-mark about-app-mark")}
          <div className="about-identity-copy">
            <h2>{APP_BRAND}</h2>
            <p>{t("about.tagline")}</p>
            <div className="about-version-row">
              <VersionPill tone="pink" icon={<Cpu size={13} aria-hidden="true" />} label={t("about.wrapperVersion")} value={versions.wrapper} />
              <VersionPill tone="success" icon={<HardDrive size={13} aria-hidden="true" />} label="Node" value={host?.node} />
              {/* Same pill as its neighbours: the endpoint is a value here, and the whole pill is the
                  control that opens it — no separate badge or link icon. */}
              <VersionPill
                tone="accent"
                icon={<Server size={13} aria-hidden="true" />}
                label={t("about.sidecar")}
                onClick={() => void openSidecarEndpoint(sidecarPort)}
                title={t("about.sidecarOpen")}
                value={sidecarEndpoint}
              />
            </div>
          </div>
        </div>

        {/* Four facts, four hues: the row is a legend, so every chip carries its own tint instead of
            leaving one coloured chip among three grey ones. */}
        <dl className="about-facts">
          <FactChip
            icon={<ShieldCheck size={12} aria-hidden="true" />}
            label={t("about.summary.platform")}
            tone="primary"
            value={runtimePlatformLabel(runtime, t)}
          />
          <FactChip
            icon={<HardDrive size={12} aria-hidden="true" />}
            label={t("about.summary.distribution")}
            tone="pink"
            value={t(portable ? "about.distribution.portable" : "about.distribution.installed")}
          />
          <FactChip
            icon={<Boxes size={12} aria-hidden="true" />}
            label={t("about.summary.architecture")}
            tone="success"
            value={formatArchitecture(host?.arch)}
          />
          <FactChip
            icon={<Sparkles size={12} aria-hidden="true" />}
            label={t("about.summary.channel")}
            tone={core?.channel === "private" ? "warning" : "accent"}
            value={core?.channel ? t(core.channel === "private" ? "system.channel.private" : "system.channel.official") : "-"}
          />
        </dl>
      </section>

      <section className="settings-section about-update">
        <h2>{t("about.update.title")}</h2>
        <div className="about-update-versions">
          <VersionPill tone="primary" icon={<Sparkles size={13} aria-hidden="true" />} label={t("about.update.current")} value={appUpdate.currentVersion} />
          <VersionPill
            tone={appUpdate.check?.updateAvailable ? "warning" : "success"}
            icon={<ArrowUpCircle size={13} aria-hidden="true" />}
            label={t("about.update.latest")}
            value={appUpdate.check?.latestVersion}
          />
        </div>
        {appUpdate.check?.updateAvailable && appUpdate.check.latestVersion && (
          <p className="about-update-status warning">
            {t("about.update.available", { version: appUpdate.check.latestVersion })}
          </p>
        )}
        {appUpdate.check?.error && (
          <p className="about-update-status danger">
            {t("about.update.error", { message: appUpdate.check.error })}
          </p>
        )}
        <div className="about-actions">
          <button className="about-action" disabled={appUpdate.checking} onClick={appUpdate.onCheck} type="button">
            <RefreshCw size={16} aria-hidden="true" />
            <span>{t(appUpdate.checking ? "about.update.checking" : "about.update.check")}</span>
          </button>
          {appUpdate.check?.updateAvailable && appUpdate.check.latestVersion && appUpdate.check.download && (
            <button className="about-action" onClick={appUpdate.onDownload} type="button">
              <Download size={16} aria-hidden="true" />
              <span>{t("about.update.download")}</span>
            </button>
          )}
          <button className="about-action" onClick={appUpdate.onOpenReleasePage} type="button">
            <ExternalLink size={16} aria-hidden="true" />
            <span>{t("about.update.releasePage")}</span>
          </button>
        </div>
        {appUpdate.portable && appUpdate.check?.updateAvailable && appUpdate.check.download && (
          <p className="about-update-note">{t("about.update.portableHint")}</p>
        )}
      </section>

      <div className="about-grid">
        <section className="settings-section">
          <h2>{t("about.storage")}</h2>
          <KeyValueList
            className="about-path-list"
            t={t}
            items={[
              {
                label: t("system.dataDir"),
                value: (
                  <span className="about-path-field">
                    <span className="about-path-text mono-cell" title={dataDir ?? "-"}>
                      {dataDir ?? "-"}
                    </span>
                    <button
                      className="about-path-action"
                      aria-label={t("about.openDataDirectory")}
                      disabled={!isTauri() || !dataDir}
                      onClick={() => void openDataDirectory(dataDir)}
                      title={isTauri() ? t("about.openDataDirectory") : t("about.openDataDirectoryDesktopOnly")}
                      type="button"
                    >
                      <FolderOpen size={15} aria-hidden="true" />
                    </button>
                  </span>
                ),
              },
            ]}
          />
        </section>

        <section className="settings-section about-support">
          <h2>{t("about.support")}</h2>
          <div className="about-actions">
            <button className="about-action" disabled={!diagnostics} onClick={() => void copyDiagnostics()} type="button">
              <Copy size={16} aria-hidden="true" />
              <span>{t("about.copyDiagnostics")}</span>
            </button>
            <button className="about-action" disabled={!diagnostics} onClick={exportDiagnostics} type="button">
              <Download size={16} aria-hidden="true" />
              <span>{t("about.exportDiagnostics")}</span>
            </button>
            <button className="about-action" onClick={() => void openLink("issues")} type="button">
              <Bug size={16} aria-hidden="true" />
              <span>{t("about.issues")}</span>
            </button>
          </div>
          {diagnostics && diagnostics.recentErrors.length > 0 && (
            <details className="session-events about-error-details">
              <summary>
                <CircleAlert size={14} aria-hidden="true" />
                <span>{t("system.recentErrors")}</span>
                <strong>{diagnostics.recentErrors.length}</strong>
              </summary>
              <div className="system-error-list">
                {diagnostics.recentErrors.slice(0, 8).map((error) => (
                  <div className="session-event error" key={`${error.at}-${error.source}-${error.message}`}>
                    <span>{formatRelativeTime(error.at, locale)}</span>
                    <strong>{error.source}</strong>
                    <small>{error.message}</small>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      </div>

      <footer className="about-footer">
        <span>{copyright}</span>
        <span className="about-legal-chips">
          <button className="about-legal-chip" onClick={() => void openLink("license")} type="button">
            <Scale size={13} aria-hidden="true" />
            MIT License
          </button>
          <button className="about-legal-chip" onClick={() => void openLink("upstream")} type="button">
            <ShieldCheck size={13} aria-hidden="true" />
            {t("about.thirdParty")}
          </button>
        </span>
      </footer>
    </div>
  );
}

type FactTone = "primary" | "accent" | "success" | "pink" | "warning";

function VersionPill({
  icon,
  label,
  onClick,
  title,
  tone,
  value,
}: {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  title?: string;
  tone: FactTone;
  value: string | undefined;
}) {
  const content = (
    <>
      {icon}
      <span>{label}</span>
      <strong className="mono-cell">{value?.trim() || "-"}</strong>
    </>
  );
  const className = `about-version-pill tone-${tone}`;
  if (!onClick) return <span className={className}>{content}</span>;
  return (
    <button className={className} onClick={onClick} title={title} type="button">
      {content}
    </button>
  );
}

function FactChip({ icon, label, tone, value }: { icon: ReactNode; label: string; tone: FactTone; value: string }) {
  return (
    <div className={`about-fact tone-${tone}`}>
      <dt>
        {icon}
        {label}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

function runtimePlatformLabel(runtime: DesktopRuntimeInfo | null, t: Translate): string {
  if (!runtime || runtime.shell !== "desktop") return t("system.shell.web");
  if (runtime.platform === "windows") return t("about.platform.windows");
  if (runtime.platform === "macos") return t("about.platform.macos");
  if (runtime.platform === "linux") return t("about.platform.linux");
  return t("system.shell.desktop");
}


