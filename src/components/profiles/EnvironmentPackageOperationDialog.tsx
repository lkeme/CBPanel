import type { TranslationKey } from "../../i18n";
import type { AppBackupOperation } from "../../shared/appBackup";
import type { EnvironmentPackageOperation } from "../../shared/environmentPackage";
import { DialogShell } from "../ui/DialogShell";
import { KeyValueList } from "../ui/KeyValueList";
import { StatusPill, type StatusPillTone } from "../ui/StatusPill";

export function EnvironmentPackageOperationDialog({
  namespace = "environmentPackage",
  operation,
  t,
}: {
  namespace?: "environmentPackage" | "appBackup";
  operation: EnvironmentPackageOperation | AppBackupOperation;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const percent = operationPercent(operation);
  const tone: StatusPillTone = operation.status === "failed" ? "error" : operation.status === "succeeded" ? "running" : "launching";
  const running = operation.status === "queued" || operation.status === "running";
  const title = namespace === "appBackup"
    ? operation.type === "export" ? t("appBackup.exportProgressTitle") : t("appBackup.restoreProgressTitle")
    : operation.type === "export" ? t("environmentPackage.exportProgressTitle") : t("environmentPackage.importProgressTitle");
  const progressLabel = namespace === "appBackup" ? t("appBackup.progress") : t("environmentPackage.progress");
  const phaseLabel = namespace === "appBackup" ? t("appBackup.phase") : t("environmentPackage.phase");
  const titleId = `${namespace}-operation-title`;
  return (
    <DialogShell
      actions={null}
      close={() => undefined}
      closeDisabled
      labelledBy={titleId}
      panelClassName="confirm-panel"
      showCloseButton={false}
      t={t}
      title={title}
    >
      <div className="settings-section-head compact">
        <h2 id={titleId}>{operation.phase}</h2>
        <StatusPill tone={tone}>{operation.status}</StatusPill>
      </div>
      <div className="operation-progress-row">
        <div
          aria-label={progressLabel}
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
      <p className="operation-progress-label">{operation.message}</p>
      <KeyValueList
        items={[
          { label: phaseLabel, value: operation.phase },
          { label: progressLabel, value: `${operation.current}/${operation.total || "-"}` },
          ...(operation.error ? [{ label: t("status.error"), value: <span className="inline-error">{operation.error}</span> }] : []),
        ]}
      />
    </DialogShell>
  );
}

function operationPercent(operation: EnvironmentPackageOperation | AppBackupOperation): number | null {
  if (!operation.total) return null;
  return Math.max(0, Math.min(100, Math.round((operation.current / operation.total) * 100)));
}
