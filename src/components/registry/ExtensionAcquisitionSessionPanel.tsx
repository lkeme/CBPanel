import {
  Check,
  CircleAlert,
  CircleCheck,
  CircleX,
  Download,
  FileCheck2,
  LoaderCircle,
  PackageCheck,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useId, useState, type ReactNode } from "react";

import type { Locale } from "../../i18n";
import type { ExtensionEntity, ExtensionPermissionRiskReasonKey } from "../../shared/entities";
import type {
  ExtensionAcquisitionConflictCandidate,
  ExtensionAcquisitionSessionConfirmRequest,
  ExtensionAcquisitionSessionStatus,
  ExtensionAcquisitionSessionView,
  ExtensionPreflightReport,
} from "../../shared/extensionAcquisition";
import { KeyValueList, type KeyValueItem } from "../ui/KeyValueList";
import { StatusPill } from "../ui/StatusPill";
import {
  ExtensionAcquisitionErrorText,
  formatAcquisitionBytes,
  formatAcquisitionDateTime,
  type ExtensionAcquisitionUiKey,
  type ExtensionAcquisitionUiError,
  type ExtensionAcquisitionUiTranslator,
} from "./extensionAcquisitionUi";

export type ExtensionAcquisitionSessionOperation =
  | "idle"
  | "starting"
  | "polling"
  | "cancelling"
  | "confirming";

export type ExtensionAcquisitionConfirmationChoice = {
  key: string;
  request: Pick<ExtensionAcquisitionSessionConfirmRequest, "disposition" | "targetExtensionId">;
  candidate?: ExtensionAcquisitionConflictCandidate;
};

const LOADABLE_INSTALL_STATES = new Set<ExtensionEntity["installState"]>(["installed", "update-available"]);

export function extensionAcquisitionConfirmationChoices(
  session: ExtensionAcquisitionSessionView,
  targetExtensionId?: string,
): ExtensionAcquisitionConfirmationChoice[] {
  const conflicts = session.report?.conflicts ?? [];
  if (session.purpose === "update") {
    const candidate = conflicts.find((item) => item.extensionId === targetExtensionId && item.eligible);
    return candidate
      ? [{
        key: `upgrade:${candidate.extensionId}`,
        request: { disposition: "upgrade", targetExtensionId: candidate.extensionId },
        candidate,
      }]
      : [];
  }
  if (conflicts.some((candidate) => (
    candidate.matchBy === "store-identity"
    && candidate.blockingReason === "developer-identity-mismatch"
  ))) return [];
  if (conflicts.length === 0) return [{ key: "create", request: { disposition: "create" } }];
  return conflicts.flatMap((candidate) => {
    if (!candidate.eligible) return [];
    const choices: ExtensionAcquisitionConfirmationChoice[] = [];
    if (LOADABLE_INSTALL_STATES.has(candidate.installState)) {
      choices.push({
        key: `reuse:${candidate.extensionId}`,
        request: { disposition: "reuse", targetExtensionId: candidate.extensionId },
        candidate,
      });
    }
    choices.push({
      key: `upgrade:${candidate.extensionId}`,
      request: { disposition: "upgrade", targetExtensionId: candidate.extensionId },
      candidate,
    });
    return choices;
  });
}

export function buildExtensionAcquisitionConfirmationRequest(
  choice: ExtensionAcquisitionConfirmationChoice | undefined,
  report: ExtensionPreflightReport,
  permissionApproved: boolean,
): ExtensionAcquisitionSessionConfirmRequest | undefined {
  if (!choice || (report.permissionApproval && !permissionApproved)) return undefined;
  return {
    ...choice.request,
    ...(report.permissionApproval ? { permissionApprovalToken: report.permissionApproval.token } : {}),
  };
}

export function ExtensionAcquisitionSessionPanel({
  confirmedExtension,
  error,
  locale,
  onBindNext,
  onCancel,
  onConfirm,
  onDone,
  onRetry,
  onRetryStateRefresh,
  operation,
  refreshError,
  refreshingState = false,
  session,
  t,
  targetExtensionId,
}: {
  confirmedExtension?: Pick<ExtensionEntity, "id" | "name" | "version">;
  error?: ExtensionAcquisitionUiError;
  locale: Locale;
  onBindNext?: (extensionId: string) => void;
  onCancel: () => void | Promise<void>;
  onConfirm: (request: ExtensionAcquisitionSessionConfirmRequest) => void | Promise<void>;
  onDone: () => void;
  onRetry: () => void | Promise<void>;
  onRetryStateRefresh?: () => void | Promise<void>;
  operation: ExtensionAcquisitionSessionOperation;
  refreshError?: ExtensionAcquisitionUiError;
  refreshingState?: boolean;
  session: ExtensionAcquisitionSessionView;
  t: ExtensionAcquisitionUiTranslator;
  targetExtensionId?: string;
}) {
  const failure = error ?? session.error;
  if (session.status === "consumed") {
    return (
      <div aria-live="polite" className="module-empty acquisition-success" role="status">
        <CircleCheck aria-hidden="true" size={24} />
        <strong>{t("extension.acquisition.success.title")}</strong>
        <span>{t("extension.acquisition.success.description", {
          name: confirmedExtension?.name ?? session.storeId,
          version: confirmedExtension?.version ?? "-",
        })}</span>
        {refreshError && (
          <div className="diagnostic-note warning acquisition-refresh-warning" role="alert">
            <CircleAlert aria-hidden="true" size={18} />
            <ExtensionAcquisitionErrorText
              error={refreshError}
              t={t}
            />
            {onRetryStateRefresh && (
              <button
                className="command subtle"
                disabled={refreshingState}
                onClick={() => void onRetryStateRefresh()}
                type="button"
              >
                {refreshingState
                  ? t("extension.acquisition.success.retryingRefresh")
                  : t("extension.acquisition.success.retryRefresh")}
              </button>
            )}
          </div>
        )}
        <div className="acquisition-success-actions">
          {confirmedExtension && onBindNext && (
            <button className="command subtle" onClick={() => onBindNext(confirmedExtension.id)} type="button">
              {t("extension.acquisition.bindNext")}
            </button>
          )}
          <button className="command primary" onClick={onDone} type="button">{t("extension.acquisition.done")}</button>
        </div>
      </div>
    );
  }
  if (session.status === "rejected" || session.status === "expired" || session.status === "cancelled") {
    const statusKey = session.status === "rejected"
      ? "extension.acquisition.session.rejected"
      : session.status === "expired"
        ? "extension.acquisition.session.expired"
        : "extension.acquisition.cancelled";
    return (
      <div className="module-empty acquisition-session-terminal">
        <div
          className={session.status === "cancelled" ? "diagnostic-note" : "inline-error"}
          role={session.status === "cancelled" ? "status" : "alert"}
        >
          {session.status === "cancelled"
            ? <CircleAlert aria-hidden="true" size={18} />
            : <CircleX aria-hidden="true" size={18} />}
          <ExtensionAcquisitionErrorText error={failure} fallbackKey={statusKey} t={t} />
        </div>
        <button className="command primary" disabled={operation === "starting"} onClick={() => void onRetry()} type="button">
          {t("extension.acquisition.session.retry")}
        </button>
      </div>
    );
  }
  if (session.status !== "ready") {
    return <ExtensionAcquisitionProgress locale={locale} onCancel={onCancel} operation={operation} session={session} t={t} />;
  }
  if (!session.report) {
    return <div className="inline-error" role="alert"><CircleX aria-hidden="true" size={18} /><ExtensionAcquisitionErrorText error={failure} t={t} /></div>;
  }
  return (
    <ExtensionAcquisitionPreflight
      error={failure}
      locale={locale}
      onCancel={onCancel}
      onConfirm={onConfirm}
      operation={operation}
      session={{ ...session, report: session.report }}
      t={t}
      targetExtensionId={targetExtensionId}
    />
  );
}

function ExtensionAcquisitionProgress({
  locale,
  onCancel,
  operation,
  session,
  t,
}: {
  locale: Locale;
  onCancel: () => void | Promise<void>;
  operation: ExtensionAcquisitionSessionOperation;
  session: ExtensionAcquisitionSessionView;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const progress = progressValue(session.status);
  const statusKey = SESSION_STATUS_COPY[session.status] ?? "extension.acquisition.progress.created";
  return (
    <section aria-busy="true" aria-label={t("extension.acquisition.preflight.title")} className="acquisition-session-progress">
      <div aria-atomic="true" aria-live="polite" className="acquisition-progress-summary" role="status">
        <LoaderCircle aria-hidden="true" className="spin" size={22} />
        <span>
          <strong>{t(statusKey)}</strong>
          <small>{t("extension.acquisition.storeId")}: <span className="mono-cell">{session.storeId}</span></small>
          {session.downloadedBytes !== undefined && <small>{t("extension.acquisition.session.bytesDownloaded", {
            size: formatAcquisitionBytes(session.downloadedBytes, locale),
          })}</small>}
        </span>
      </div>
      <progress aria-label={t(statusKey)} max={4} value={progress} />
      <ol className="acquisition-progress-steps">
        {PROGRESS_STEPS.map((step, index) => (
          <li aria-current={progress === index + 1 ? "step" : undefined} className={progress > index ? "complete" : "pending"} key={step.key}>
            {progress > index + 1 ? <Check aria-hidden="true" size={14} /> : step.icon}
            <span>{t(step.key)}</span>
          </li>
        ))}
      </ol>
      {session.status !== "committing" && (
        <button className="command subtle" disabled={operation === "cancelling"} onClick={() => void onCancel()} type="button">
          {t("actions.cancelOperation")}
        </button>
      )}
    </section>
  );
}

function ExtensionAcquisitionPreflight({
  error,
  locale,
  onCancel,
  onConfirm,
  operation,
  session,
  t,
  targetExtensionId,
}: {
  error?: ExtensionAcquisitionUiError;
  locale: Locale;
  onCancel: () => void | Promise<void>;
  onConfirm: (request: ExtensionAcquisitionSessionConfirmRequest) => void | Promise<void>;
  operation: ExtensionAcquisitionSessionOperation;
  session: ExtensionAcquisitionSessionView & { report: ExtensionPreflightReport };
  t: ExtensionAcquisitionUiTranslator;
  targetExtensionId?: string;
}) {
  const report = session.report;
  const choices = extensionAcquisitionConfirmationChoices(session, targetExtensionId);
  const choiceSignature = choices.map((choice) => choice.key).join("|");
  const [selectedKey, setSelectedKey] = useState(choices[0]?.key ?? "");
  const [permissionApproved, setPermissionApproved] = useState(false);
  const confirmationTitleId = useId();
  useEffect(() => {
    setSelectedKey(choices[0]?.key ?? "");
    setPermissionApproved(false);
  }, [choiceSignature, report.permissionApproval?.token, session.sessionId]);
  const selectedChoice = choices.find((choice) => choice.key === selectedKey);
  const request = buildExtensionAcquisitionConfirmationRequest(selectedChoice, report, permissionApproved);
  const confirming = operation === "confirming";

  return (
    <section className="acquisition-preflight">
      <header className="acquisition-section-header">
        <div>
          <h3>{t("extension.acquisition.preflight.title")}</h3>
          <p>{t("extension.acquisition.preflight.expiresAt", { time: formatAcquisitionDateTime(report.expiresAt, locale) })}</p>
        </div>
        <StatusPill tone="running"><ShieldCheck aria-hidden="true" size={14} />{t("extension.acquisition.verification.evidenceOnly")}</StatusPill>
      </header>
      {error && <div className="inline-error" role="alert"><CircleX aria-hidden="true" size={16} /><ExtensionAcquisitionErrorText error={error} t={t} /></div>}
      <div className="acquisition-preflight-grid">
        <FactSection icon={<PackageCheck aria-hidden="true" size={17} />} items={identityFacts(report, t)} title={t("extension.acquisition.identity")} />
        <FactSection icon={<FileCheck2 aria-hidden="true" size={17} />} items={packageFacts(report, locale, t)} title={t("extension.acquisition.package")} />
        <FactSection icon={<Download aria-hidden="true" size={17} />} items={transportFacts(report, locale, t)} title={t("extension.acquisition.transport")} />
        <FactSection icon={<ShieldCheck aria-hidden="true" size={17} />} items={verificationFacts(report, t)} title={t("extension.acquisition.verification")} />
      </div>
      <PermissionFacts report={report} t={t} />
      <DiscrepancyFacts report={report} t={t} />
      <ConflictFacts report={report} t={t} />

      <section aria-labelledby={confirmationTitleId} className="acquisition-confirmation">
        <h4 id={confirmationTitleId}>{t("extension.acquisition.confirm.title")}</h4>
        <p>{t("extension.acquisition.confirm.description")}</p>
        {choices.length > 0 ? (
          <fieldset className="acquisition-confirmation-choices" disabled={confirming}>
            <legend>{t("extension.acquisition.confirm.title")}</legend>
            {choices.map((choice) => (
              <label className={`confirm-choice ${selectedKey === choice.key ? "active" : ""}`} key={choice.key}>
                <input checked={selectedKey === choice.key} name={`acquisition-confirm-${session.sessionId}`} onChange={() => setSelectedKey(choice.key)} type="radio" />
                <span className="confirm-choice-mark" aria-hidden="true" />
                <span className="confirm-choice-text">
                  <strong>{confirmationChoiceLabel(choice, t)}</strong>
                  {choice.candidate && <small className="mono-cell">{choice.candidate.extensionId}</small>}
                </span>
              </label>
            ))}
          </fieldset>
        ) : <div className="inline-error" role="alert"><CircleX aria-hidden="true" size={16} /><span>{t("extension.acquisition.conflict.blocked")}</span></div>}
        {report.permissionApproval && (
          <label className="acquisition-permission-approval">
            <input checked={permissionApproved} disabled={confirming} onChange={(event) => setPermissionApproved(event.target.checked)} type="checkbox" />
            <span><strong>{t("extension.acquisition.confirm.permissionApproval")}</strong><small>{report.permissionApproval.added.join(", ")}</small></span>
          </label>
        )}
        <div className="acquisition-confirmation-actions">
          <button className="command subtle" disabled={confirming} onClick={() => void onCancel()} type="button">{t("actions.cancel")}</button>
          <button className="command primary" disabled={confirming || !request} onClick={() => request && void onConfirm(request)} type="button">
            {confirming ? t("extension.acquisition.progress.committing") : t(session.purpose === "update" ? "actions.update" : "actions.install")}
          </button>
        </div>
      </section>
    </section>
  );
}

function FactSection({ icon, items, title }: { icon: ReactNode; items: KeyValueItem[]; title: string }) {
  return <section className="acquisition-fact-section"><h4>{icon}{title}</h4><KeyValueList items={items} /></section>;
}

function identityFacts(report: ExtensionPreflightReport, t: ExtensionAcquisitionUiTranslator): KeyValueItem[] {
  return [
    { label: t("extension.acquisition.identity.requestedId"), value: report.identity.requestedStoreId, mono: true },
    { label: t("extension.acquisition.identity.proofDerivedId"), value: report.identity.proofDerivedStoreId, mono: true },
    { label: t("extension.acquisition.identity.matches"), value: t("extension.acquisition.identity.matches") },
  ];
}

function packageFacts(report: ExtensionPreflightReport, locale: Locale, t: ExtensionAcquisitionUiTranslator): KeyValueItem[] {
  const facts = report.package;
  return [
    { label: t("extension.acquisition.package.name"), value: facts.name },
    { label: t("extension.acquisition.package.description"), value: facts.description || "-" },
    { label: t("extension.acquisition.package.version"), value: facts.version },
    { label: t("extension.acquisition.package.manifestVersion"), value: facts.manifestVersion },
    { label: t("extension.acquisition.package.format"), value: facts.format },
    { label: t("extension.acquisition.package.size"), value: formatAcquisitionBytes(facts.size, locale) },
    { label: t("extension.acquisition.package.sha256"), value: facts.sha256, mono: true },
    { label: t("extension.acquisition.package.manifestSha256"), value: facts.manifestSha256, mono: true },
    { label: t("extension.acquisition.package.treeSha256"), value: facts.treeSha256, mono: true },
    { label: t("extension.acquisition.package.entryCount"), value: facts.entryCount },
    { label: t("extension.acquisition.package.filesystemNodeCount"), value: facts.filesystemNodeCount },
    { label: t("extension.acquisition.package.fileCount"), value: facts.fileCount },
    { label: t("extension.acquisition.package.expandedBytes"), value: formatAcquisitionBytes(facts.expandedBytes, locale) },
    ...(facts.icon ? [{ label: t("extension.acquisition.package.icon"), value: `${facts.icon.relativePath} · ${facts.icon.mimeType} · ${formatAcquisitionBytes(facts.icon.size, locale)}` }] : []),
  ];
}

function transportFacts(report: ExtensionPreflightReport, locale: Locale, t: ExtensionAcquisitionUiTranslator): KeyValueItem[] {
  const fetchedAt = formatAcquisitionDateTime(report.transport.fetchedAt, locale);
  const duration = `${report.transport.durationMs} ms`;
  return [
    { label: t("extension.acquisition.transport.provider"), value: report.transport.selectedProviderId },
    { label: t("extension.acquisition.transport.finalHost"), value: report.transport.finalByteHost, mono: true },
    { label: t("extension.acquisition.transport.fetchedAt", { time: fetchedAt }), value: fetchedAt },
    { label: t("extension.acquisition.transport.duration", { value: duration }), value: duration },
  ];
}

function verificationFacts(report: ExtensionPreflightReport, t: ExtensionAcquisitionUiTranslator): KeyValueItem[] {
  return [
    { label: t("extension.acquisition.verification.level"), value: report.verification.level },
    { label: t("extension.acquisition.verification.developerKey"), value: report.verification.developerKeySha256, mono: true },
    {
      label: t("extension.acquisition.verification.trustRoot", {
        id: report.verification.publisherTrustRootId,
        version: report.verification.publisherTrustRootVersion,
      }),
      value: `${report.verification.publisherTrustRootId} · v${report.verification.publisherTrustRootVersion}`,
      mono: true,
    },
    { label: t("extension.acquisition.verification.developerAlgorithm"), value: report.verification.developerProofAlgorithm },
    { label: t("extension.acquisition.verification.publisherAlgorithm"), value: report.verification.publisherProofAlgorithm },
  ];
}

function PermissionFacts({ report, t }: { report: ExtensionPreflightReport; t: ExtensionAcquisitionUiTranslator }) {
  const lists = [
    [t("extension.acquisition.permissions.required"), report.permissions],
    [t("extension.acquisition.permissions.host"), report.hostPermissions],
    [t("extension.acquisition.permissions.optional"), report.optionalPermissions],
    [t("extension.acquisition.permissions.optionalHost"), report.optionalHostPermissions],
  ] as const;
  return (
    <section className="acquisition-permissions">
      <h4>{t("extension.acquisition.permissions")}</h4>
      <div className="acquisition-permission-groups">
        {lists.map(([label, values]) => <div key={label}><strong>{label}</strong>{values.length > 0
          ? <ul>{values.map((value) => <li className="mono-cell" key={value}>{value}</li>)}</ul>
          : <small>{t("extension.acquisition.permissions.none")}</small>}</div>)}
      </div>
      <h4>{t("extension.acquisition.risks")}</h4>
      {report.permissionRisks.length > 0 ? <ul className="acquisition-risk-list">
        {report.permissionRisks.map((risk, index) => <li key={`${risk.permission}:${index}`}>
          <StatusPill tone={risk.level === "high" ? "error" : risk.level === "medium" ? "warning" : "neutral"}>{t(`extension.acquisition.risk.${risk.level}`)}</StatusPill>
          <span className="mono-cell">{risk.permission}</span>
          <span>{risk.reasonKey ? t(RISK_REASON_COPY[risk.reasonKey]) : risk.reason}</span>
          {risk.optional && <small>{t("extension.acquisition.risk.optional")}</small>}
        </li>)}
      </ul> : <small>{t("extension.acquisition.permissions.none")}</small>}
    </section>
  );
}

function DiscrepancyFacts({ report, t }: { report: ExtensionPreflightReport; t: ExtensionAcquisitionUiTranslator }) {
  if (report.discrepancies.length === 0) return null;
  return <section className="acquisition-discrepancies"><h4>{t("extension.acquisition.discrepancies")}</h4><ul>{report.discrepancies.map((item, index) => (
    <li key={`${item.field}:${index}`}><CircleAlert aria-hidden="true" size={16} /><strong>{t(item.field === "name" ? "extension.acquisition.discrepancy.name" : "extension.acquisition.discrepancy.version")}</strong><span>{t("extension.acquisition.discrepancy.catalog", { value: item.catalog ?? "-" })}</span><span>{t("extension.acquisition.discrepancy.package", { value: item.package })}</span></li>
  ))}</ul></section>;
}

function ConflictFacts({ report, t }: { report: ExtensionPreflightReport; t: ExtensionAcquisitionUiTranslator }) {
  if (report.conflicts.length === 0) return null;
  return <section className="acquisition-conflicts"><h4>{t("extension.acquisition.conflicts")}</h4><ul>{report.conflicts.map((candidate) => (
    <li key={candidate.extensionId}>
      {candidate.eligible ? <CircleCheck aria-hidden="true" size={16} /> : <CircleX aria-hidden="true" size={16} />}
      <span><strong>{candidate.name} · {candidate.version}</strong><small className="mono-cell">{candidate.extensionId}</small><small>{t(INSTALL_STATE_COPY[candidate.installState])}</small><small>{t(MATCH_COPY[candidate.matchBy])}</small><small>{candidate.eligible
        ? t("extension.acquisition.conflict.eligible")
        : t(candidate.blockingReason ? BLOCKING_COPY[candidate.blockingReason] : "extension.acquisition.conflict.ineligible")}</small></span>
    </li>
  ))}</ul></section>;
}

function confirmationChoiceLabel(choice: ExtensionAcquisitionConfirmationChoice, t: ExtensionAcquisitionUiTranslator): string {
  if (choice.request.disposition === "create") return t("extension.acquisition.confirm.create");
  const params = { name: choice.candidate?.name ?? "-", version: choice.candidate?.version ?? "-" };
  return choice.request.disposition === "reuse" ? t("extension.acquisition.confirm.reuse", params) : t("extension.acquisition.confirm.upgrade", params);
}

const SESSION_STATUS_COPY: Partial<Record<ExtensionAcquisitionSessionStatus, ExtensionAcquisitionUiKey>> = {
  created: "extension.acquisition.progress.created",
  downloading: "extension.acquisition.progress.downloading",
  verifying: "extension.acquisition.progress.verifying",
  analyzing: "extension.acquisition.progress.analyzing",
  ready: "extension.acquisition.progress.ready",
  committing: "extension.acquisition.progress.committing",
};

const PROGRESS_STEPS: Array<{ icon: ReactNode; key: ExtensionAcquisitionUiKey }> = [
  { icon: <Download aria-hidden="true" size={14} />, key: "extension.acquisition.progress.downloading" },
  { icon: <ShieldCheck aria-hidden="true" size={14} />, key: "extension.acquisition.progress.verifying" },
  { icon: <FileCheck2 aria-hidden="true" size={14} />, key: "extension.acquisition.progress.analyzing" },
  { icon: <PackageCheck aria-hidden="true" size={14} />, key: "extension.acquisition.progress.ready" },
];

function progressValue(status: ExtensionAcquisitionSessionStatus): number {
  if (status === "downloading") return 1;
  if (status === "verifying") return 2;
  if (status === "analyzing") return 3;
  if (status === "ready" || status === "committing" || status === "consumed") return 4;
  return 0;
}

const RISK_REASON_COPY: Record<ExtensionPermissionRiskReasonKey, ExtensionAcquisitionUiKey> = {
  "all-urls": "extension.acquisition.risk.reason.allUrls",
  "content-script-all-urls": "extension.acquisition.risk.reason.contentScriptAllUrls",
  "high-privilege": "extension.acquisition.risk.reason.highPrivilege",
  "tabs-metadata": "extension.acquisition.risk.reason.tabsMetadata",
};

const MATCH_COPY: Record<ExtensionAcquisitionConflictCandidate["matchBy"], ExtensionAcquisitionUiKey> = {
  "store-identity": "extension.acquisition.conflict.match.storeIdentity",
  "developer-identity": "extension.acquisition.conflict.match.developerIdentity",
  "metadata-store-id": "extension.acquisition.conflict.match.metadataStoreId",
};

const BLOCKING_COPY: Record<NonNullable<ExtensionAcquisitionConflictCandidate["blockingReason"]>, ExtensionAcquisitionUiKey> = {
  "developer-identity-mismatch": "extension.acquisition.conflict.blocking.developerIdentityMismatch",
  "ambiguous-metadata": "extension.acquisition.conflict.blocking.ambiguousMetadata",
  "installed-identity-missing": "extension.acquisition.conflict.blocking.installedIdentityMissing",
};

const INSTALL_STATE_COPY: Record<ExtensionEntity["installState"], ExtensionAcquisitionUiKey> = {
  "metadata-only": "extension.state.notInstalled",
  "download-pending": "extension.state.notInstalled",
  downloading: "extension.state.downloading",
  installed: "extension.state.installed",
  "update-available": "extension.state.updateAvailable",
  "local-missing": "extension.state.localMissing",
  "invalid-manifest": "extension.state.invalidManifest",
  "install-failed": "extension.state.installFailed",
};
