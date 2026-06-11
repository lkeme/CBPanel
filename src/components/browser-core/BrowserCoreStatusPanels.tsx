import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import type { BrowserCoreInfo, BrowserCoreOperation } from "../../shared/browserCore";
import { CopyButton } from "../ui/CopyButton";
import { KeyValueList } from "../ui/KeyValueList";
import { StatusPill, type StatusPillTone } from "../ui/StatusPill";

export function BrowserCoreOperationPanel({
  busy,
  operation,
  t,
}: {
  busy: string;
  operation?: BrowserCoreOperation;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const running = operation?.status === "running" || isBrowserCoreBusy(busy);
  const percent = operationPercent(operation);
  const label = operation?.progress?.label ?? browserCoreBusyLabel(busy, t);
  const statusTone: StatusPillTone = operation?.status === "failed" ? "error" : running ? "launching" : "running";
  return (
    <section className="browser-core-card operation-card">
      <div className="settings-section-head">
        <h2>{t("browserCore.operation")}</h2>
        <StatusPill tone={statusTone}>
          {operation?.phase ?? t("browserCore.operationRunning")}
        </StatusPill>
      </div>
      <div className="operation-progress-row">
        <div
          aria-label={t("browserCore.progress")}
          aria-valuemax={percent === null ? undefined : 100}
          aria-valuemin={percent === null ? undefined : 0}
          aria-valuenow={percent ?? undefined}
          className={`operation-progress ${percent === null && running ? "indeterminate" : ""}`}
          role="progressbar"
        >
          <span style={percent === null ? undefined : { width: `${percent}%` }} />
        </div>
        <strong>{percent === null ? t("browserCore.progressIndeterminate") : `${percent}%`}</strong>
      </div>
      <p className="operation-progress-label">{label}</p>
      <div className="operation-log">
        {!operation || operation.logs.length === 0 ? (
          <div className="preflight-empty">{t("browserCore.noLogs")}</div>
        ) : (
          operation.logs.slice(-8).map((log) => (
            <div className={`operation-log-row ${log.level}`} key={`${log.at}-${log.message}`}>
              <span>{formatTime(log.at)}</span>
              <strong>{log.message}</strong>
              {log.detail && <small>{log.detail}</small>}
            </div>
          ))
        )}
      </div>
    </section>
  );
}

export function BrowserCoreUpdateStatus({
  core,
  t,
}: {
  core: BrowserCoreInfo;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const update = core.update;
  if (!update) return null;
  const tone: StatusPillTone = update.error ? "error" : update.updateAvailable ? "warning" : "running";
  return (
    <section className="browser-core-card update-status-card">
      <div className="settings-section-head">
        <h2>{t("browserCore.updateStatus")}</h2>
        <StatusPill tone={tone}>
          {update.error
            ? t("browserCore.updateCheckFailed")
            : update.updateAvailable
              ? t("browserCore.updateAvailableShort")
              : t("browserCore.upToDate")}
        </StatusPill>
      </div>
      <KeyValueList
        items={[
          { label: t("browserCore.lastCheckedAt"), value: formatTime(update.checkedAt, "dateTime") },
          { label: t("browserCore.currentVersion"), value: update.currentVersion },
          { label: t("browserCore.latestVersion"), value: update.latestVersion ?? "-" },
          ...(update.error ? [{ label: t("status.error"), value: <span className="inline-error">{update.error}</span> }] : []),
        ]}
      />
      {update.downloadLinks && (
        <div className="update-download-links">
          <div className="download-url-row">
            <span className="mono-cell">{update.downloadLinks.primaryUrl}</span>
            <CopyButton value={update.downloadLinks.primaryUrl} t={t} />
          </div>
          {update.downloadLinks.fallbackUrl && (
            <div className="download-url-row">
              <span className="mono-cell">{update.downloadLinks.fallbackUrl}</span>
              <CopyButton value={update.downloadLinks.fallbackUrl} t={t} />
            </div>
          )}
        </div>
      )}
    </section>
  );
}

export function browserCoreOperationActive(operation: BrowserCoreOperation | undefined): boolean {
  return operation?.status === "running";
}

export function isBrowserCoreBusy(busy: string): boolean {
  return ["binary-install", "binary-update", "binary-clear", "browser-core-import"].includes(busy);
}

function operationPercent(operation: BrowserCoreOperation | undefined): number | null {
  const current = operation?.progress?.current;
  const total = operation?.progress?.total;
  if (typeof current !== "number" || typeof total !== "number" || total <= 0) return null;
  return Math.max(0, Math.min(100, Math.round((current / total) * 100)));
}

function browserCoreBusyLabel(busy: string, t: (key: TranslationKey) => string): string {
  if (busy === "binary-install") return t("browserCore.installing");
  if (busy === "binary-update") return t("browserCore.updating");
  if (busy === "binary-clear") return t("browserCore.clearing");
  if (busy === "browser-core-import") return t("browserCore.importing");
  return t("browserCore.operationRunning");
}
