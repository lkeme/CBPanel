import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import { downloadProgressDetail } from "../../shared/downloadProgress";
import type {
  BrowserCoreOperation,
} from "../../shared/browserCore";
import { StatusPill, type StatusPillTone } from "../ui/StatusPill";

export function BrowserCoreOperationPanel({
  busy,
  cancelOperation,
  operation,
  t,
}: {
  busy: string;
  cancelOperation?: () => void;
  operation?: BrowserCoreOperation;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const running = operation?.status === "running" || isBrowserCoreBusy(busy);
  const percent = operationPercent(operation);
  const label = operation?.progress?.label ?? browserCoreBusyLabel(busy, t);
  // Only the fields the source actually reported: a download that knows its size but has not measured a
  // rate yet shows the sizes, and one that knows neither shows nothing rather than a made-up "0 B/s".
  const detail = downloadProgressDetail({
    receivedBytes: operation?.progress?.receivedBytes,
    totalBytes: operation?.progress?.totalBytes,
    bytesPerSecond: operation?.progress?.bytesPerSecond,
  });
  const statusTone: StatusPillTone = operation?.status === "failed" ? "error" : running ? "launching" : "running";
  return (
    <section className="browser-core-card operation-card">
      <div className="settings-section-head">
        <h2>{t("browserCore.operation")}</h2>
        <div className="settings-section-actions">
          <StatusPill tone={statusTone}>
            {operation?.phase ?? t("browserCore.operationRunning")}
          </StatusPill>
          {/* Only while something is actually in flight: cancelling aborts the in-flight requests, so
              there is nothing to abort once the operation has finished. */}
          {running && cancelOperation && (
            <button className="command subtle" onClick={cancelOperation} type="button">
              {t("actions.cancelOperation")}
            </button>
          )}
        </div>
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
      <p className="operation-progress-label">
        {label}
        {detail && <span className="operation-progress-detail">{detail}</span>}
      </p>
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

export function browserCoreOperationActive(operation: BrowserCoreOperation | undefined): boolean {
  return operation?.status === "running";
}

export function isBrowserCoreBusy(busy: string): boolean {
  return ["binary-install", "binary-update", "binary-clear", "browser-core-import", "browser-core-private-install", "browser-core-channel-switch"].includes(busy);
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
  if (busy === "browser-core-private-install") return t("browserCore.installing");
  return t("browserCore.operationRunning");
}
