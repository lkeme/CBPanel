import type { TranslationKey } from "../../i18n";
import { formatTime } from "../../lib/utils";
import type {
  BrowserCoreOperation,
  BrowserCoreTier,
  BrowserCoreVersionMode,
} from "../../shared/browserCore";
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

export function browserCoreTierLabel(
  value: BrowserCoreTier,
  t: (key: TranslationKey) => string,
): string {
  return value === "pro" ? t("browserCore.tierPro") : t("browserCore.tierFree");
}

export function browserCoreVersionModeLabel(
  value: BrowserCoreVersionMode,
  t: (key: TranslationKey) => string,
): string {
  return value === "pinned" ? t("browserCore.versionPinned") : t("browserCore.versionLatest");
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
