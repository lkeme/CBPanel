import type { TranslationKey } from "../../i18n";
import type { EnvironmentPackageOperation } from "../../shared/environmentPackage";
import { DialogShell } from "../ui/DialogShell";
import { KeyValueList } from "../ui/KeyValueList";
import { StatusPill, type StatusPillTone } from "../ui/StatusPill";

export function EnvironmentPackageOperationDialog({
  operation,
  t,
}: {
  operation: EnvironmentPackageOperation;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const percent = operationPercent(operation);
  const tone: StatusPillTone = operation.status === "failed" ? "error" : operation.status === "succeeded" ? "running" : "launching";
  const running = operation.status === "queued" || operation.status === "running";
  return (
    <DialogShell
      actions={null}
      close={() => undefined}
      closeDisabled
      labelledBy="environment-package-operation-title"
      panelClassName="confirm-panel"
      showCloseButton={false}
      t={t}
      title={operation.type === "export" ? t("environmentPackage.exportProgressTitle") : t("environmentPackage.importProgressTitle")}
    >
      <div className="settings-section-head compact">
        <h2 id="environment-package-operation-title">{operation.phase}</h2>
        <StatusPill tone={tone}>{operation.status}</StatusPill>
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
      <p className="operation-progress-label">{operation.message}</p>
      <KeyValueList
        items={[
          { label: t("environmentPackage.phase"), value: operation.phase },
          { label: t("environmentPackage.progress"), value: `${operation.current}/${operation.total || "-"}` },
        ]}
      />
    </DialogShell>
  );
}

function operationPercent(operation: EnvironmentPackageOperation): number | null {
  if (!operation.total) return null;
  return Math.max(0, Math.min(100, Math.round((operation.current / operation.total) * 100)));
}
