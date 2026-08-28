import type { Locale } from "../../i18n";
import type { ExtensionAcquisitionErrorCode } from "../../shared/extensionAcquisition";

export type ExtensionAcquisitionLocalizedErrorCode =
  | ExtensionAcquisitionErrorCode
  | "ARTIFACT_CHANNEL_DISABLED"
  | "ACQUISITION_PROVIDER_SELECTION_REQUIRED"
  | "ACQUISITION_CONFIRMATION_NOT_READY"
  | "ACQUISITION_SESSION_ACTIVE"
  | "ACQUISITION_REQUEST_CANCELLED"
  | "ACQUISITION_STATE_REFRESH_FAILED";

export type ExtensionAcquisitionUiKey =
  | "actions.bind"
  | "actions.cancel"
  | "actions.cancelOperation"
  | "actions.close"
  | "actions.install"
  | "actions.importCrx"
  | "actions.importDirectory"
  | "actions.importZip"
  | "actions.open"
  | "actions.update"
  | "extension.state.downloading"
  | "extension.state.installFailed"
  | "extension.state.installed"
  | "extension.state.invalidManifest"
  | "extension.state.localMissing"
  | "extension.state.notInstalled"
  | "extension.state.updateAvailable"
  | "extension.acquisition.aliasesExcluded"
  | "extension.acquisition.bindNext"
  | "extension.acquisition.cancelled"
  | "extension.acquisition.channel.googleDescription"
  | "extension.acquisition.channel.mirrorDescription"
  | "extension.acquisition.channel.noneBody"
  | "extension.acquisition.channel.noneTitle"
  | "extension.acquisition.channel.providerError"
  | "extension.acquisition.channel.selected"
  | "extension.acquisition.channel.start"
  | "extension.acquisition.channel.title"
  | "extension.acquisition.channel.tryMirror"
  | "extension.acquisition.channel.tryGoogle"
  | "extension.acquisition.confirm.create"
  | "extension.acquisition.confirm.description"
  | "extension.acquisition.confirm.reviewRequired"
  | "extension.acquisition.confirm.reviewSummary"
  | "extension.acquisition.confirm.technicalDetails"
  | "extension.acquisition.confirm.permissionApproval"
  | "extension.acquisition.confirm.reuse"
  | "extension.acquisition.confirm.title"
  | "extension.acquisition.confirm.upgrade"
  | "extension.acquisition.conflict.blocked"
  | "extension.acquisition.conflict.blocking.ambiguousMetadata"
  | "extension.acquisition.conflict.blocking.developerIdentityMismatch"
  | "extension.acquisition.conflict.blocking.installedIdentityMissing"
  | "extension.acquisition.conflict.eligible"
  | "extension.acquisition.conflict.ineligible"
  | "extension.acquisition.conflict.match.developerIdentity"
  | "extension.acquisition.conflict.match.metadataStoreId"
  | "extension.acquisition.conflict.match.storeIdentity"
  | "extension.acquisition.conflicts"
  | "extension.acquisition.disclosure.accept"
  | "extension.acquisition.disclosure.dataContext"
  | "extension.acquisition.disclosure.dataQuery"
  | "extension.acquisition.disclosure.dataTitle"
  | "extension.acquisition.disclosure.description"
  | "extension.acquisition.disclosure.noRequestOnCancel"
  | "extension.acquisition.disclosure.notGoogle"
  | "extension.acquisition.disclosure.title"
  | "extension.acquisition.discrepancy.catalog"
  | "extension.acquisition.discrepancy.name"
  | "extension.acquisition.discrepancy.package"
  | "extension.acquisition.discrepancy.version"
  | "extension.acquisition.discrepancies"
  | "extension.acquisition.done"
  | "extension.acquisition.error"
  | `extension.acquisition.errorCode.${ExtensionAcquisitionLocalizedErrorCode}`
  | "extension.acquisition.identity"
  | "extension.acquisition.identity.matches"
  | "extension.acquisition.identity.proofDerivedId"
  | "extension.acquisition.identity.requestedId"
  | "extension.acquisition.loadMore"
  | "extension.acquisition.loading"
  | "extension.acquisition.openWebStore"
  | "extension.acquisition.openListingFailed"
  | "extension.acquisition.package"
  | "extension.acquisition.package.description"
  | "extension.acquisition.package.entryCount"
  | "extension.acquisition.package.expandedBytes"
  | "extension.acquisition.package.fileCount"
  | "extension.acquisition.package.filesystemNodeCount"
  | "extension.acquisition.package.format"
  | "extension.acquisition.package.icon"
  | "extension.acquisition.package.manifestSha256"
  | "extension.acquisition.package.manifestVersion"
  | "extension.acquisition.package.name"
  | "extension.acquisition.package.sha256"
  | "extension.acquisition.package.size"
  | "extension.acquisition.package.treeSha256"
  | "extension.acquisition.package.version"
  | "extension.acquisition.permissions"
  | "extension.acquisition.permissions.host"
  | "extension.acquisition.permissions.none"
  | "extension.acquisition.permissions.optional"
  | "extension.acquisition.permissions.optionalHost"
  | "extension.acquisition.permissions.required"
  | "extension.acquisition.preflight.expiresAt"
  | "extension.acquisition.preflight.title"
  | "extension.acquisition.progress.analyzing"
  | "extension.acquisition.progress.committing"
  | "extension.acquisition.progress.created"
  | "extension.acquisition.progress.downloading"
  | "extension.acquisition.progress.ready"
  | "extension.acquisition.progress.verifying"
  | "extension.acquisition.results.cancelled"
  | "extension.acquisition.results.back"
  | "extension.acquisition.results.noDescription"
  | "extension.acquisition.results.rating"
  | "extension.acquisition.results.downloads"
  | "extension.acquisition.results.installed"
  | "extension.acquisition.results.version"
  | "extension.acquisition.results.updatedAt"
  | "extension.acquisition.results.size"
  | "extension.acquisition.results.manifestVersion"
  | "extension.acquisition.results.developer"
  | "extension.acquisition.results.overview"
  | "extension.acquisition.results.openProvider"
  | "extension.acquisition.results.viewLabel"
  | "extension.acquisition.results.viewTwo"
  | "extension.acquisition.results.viewFour"
  | "extension.acquisition.results.emptyBody"
  | "extension.acquisition.results.emptyTitle"
  | "extension.acquisition.results.error"
  | "extension.acquisition.results.errorTitle"
  | "extension.acquisition.results.end"
  | "extension.acquisition.results.loading"
  | "extension.acquisition.results.loadingMore"
  | "extension.acquisition.results.retry"
  | "extension.acquisition.results.summary"
  | "extension.acquisition.results.title"
  | "extension.acquisition.risk.high"
  | "extension.acquisition.risk.low"
  | "extension.acquisition.risk.medium"
  | "extension.acquisition.risk.optional"
  | "extension.acquisition.risk.reason.allUrls"
  | "extension.acquisition.risk.reason.contentScriptAllUrls"
  | "extension.acquisition.risk.reason.highPrivilege"
  | "extension.acquisition.risk.reason.tabsMetadata"
  | "extension.acquisition.risks"
  | "extension.acquisition.session.bytesDownloaded"
  | "extension.acquisition.session.expired"
  | "extension.acquisition.session.rejected"
  | "extension.acquisition.session.retry"
  | "extension.acquisition.source.crxsosoArtifactDescription"
  | "extension.acquisition.source.crxsosoArtifactName"
  | "extension.acquisition.source.description"
  | "extension.acquisition.source.channelLegend"
  | "extension.acquisition.source.singleChannelHelp"
  | "extension.acquisition.source.googleArtifactDescription"
  | "extension.acquisition.source.googleArtifactName"
  | "extension.acquisition.source.title"
  | "extension.acquisition.source.trust.google"
  | "extension.acquisition.source.trust.thirdParty"
  | "extension.acquisition.sources.open"
  | "extension.acquisition.storeId"
  | "extension.acquisition.success.description"
  | "extension.acquisition.success.retryRefresh"
  | "extension.acquisition.success.retryingRefresh"
  | "extension.acquisition.success.title"
  | "extension.acquisition.transport"
  | "extension.acquisition.transport.duration"
  | "extension.acquisition.transport.fetchedAt"
  | "extension.acquisition.transport.finalHost"
  | "extension.acquisition.transport.provider"
  | "extension.acquisition.verification"
  | "extension.acquisition.verification.developerAlgorithm"
  | "extension.acquisition.verification.developerKey"
  | "extension.acquisition.verification.evidenceOnly"
  | "extension.acquisition.verification.level"
  | "extension.acquisition.verification.publisherAlgorithm"
  | "extension.acquisition.verification.trustRoot";

export type ExtensionAcquisitionUiTranslator = (
  key: ExtensionAcquisitionUiKey,
  params?: Record<string, string | number>,
) => string;

export interface ExtensionAcquisitionUiError {
  code?: string;
  message?: string;
}

export interface ExtensionAcquisitionErrorCopy {
  primary: string;
  detail?: string;
}

function acquisitionErrorCopyKey(code: string | undefined): ExtensionAcquisitionUiKey | undefined {
  if (!code || !/^[A-Z][A-Z0-9_]{1,80}$/.test(code)) return undefined;
  return `extension.acquisition.errorCode.${code as ExtensionAcquisitionLocalizedErrorCode}`;
}

export function formatExtensionAcquisitionError(
  error: ExtensionAcquisitionUiError | undefined,
  t: ExtensionAcquisitionUiTranslator,
  options: {
    fallbackKey?: ExtensionAcquisitionUiKey;
  } = {},
): ExtensionAcquisitionErrorCopy {
  const candidateKey = acquisitionErrorCopyKey(error?.code);
  const candidatePrimary = candidateKey ? t(candidateKey) : undefined;
  const key = candidatePrimary && candidatePrimary !== candidateKey ? candidateKey : undefined;
  const primary = key && candidatePrimary
    ? candidatePrimary
    : t(options.fallbackKey ?? "extension.acquisition.error");
  const rawDetail = boundedAcquisitionErrorDetail(error?.message);
  const detail = rawDetail
    && !key
    && rawDetail !== primary
    && rawDetail !== error?.code
    ? rawDetail
    : undefined;
  return { primary, ...(detail ? { detail } : {}) };
}

export function ExtensionAcquisitionErrorText({
  error,
  fallbackKey,
  t,
}: {
  error?: ExtensionAcquisitionUiError;
  fallbackKey?: ExtensionAcquisitionUiKey;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const copy = formatExtensionAcquisitionError(error, t, { fallbackKey });
  return (
    <span className="acquisition-error-copy">
      <strong>{copy.primary}</strong>
      {copy.detail && <small>{copy.detail}</small>}
    </span>
  );
}

function boundedAcquisitionErrorDetail(message: string | undefined): string | undefined {
  const normalized = message
    ?.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return normalized.length > 300 ? `${normalized.slice(0, 299)}…` : normalized;
}

export function formatAcquisitionBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 1 : 2 }).format(value)} ${unit}`;
}

export function formatAcquisitionDateTime(value: string, locale: Locale): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}
