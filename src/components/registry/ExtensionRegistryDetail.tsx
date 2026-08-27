import { useId, useMemo } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { FolderOpen } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import { errorMessage } from "../../lib/apiClient";
import type {
  ExtensionEntity,
  ExtensionPermissionRisk,
  ExtensionUpdatePolicy,
} from "../../shared/entities";
import type {
  ExtensionArtifactProviderId,
  ExtensionUpdateProviderId,
  ExtensionUpdateState,
  ExtensionVerificationLevel,
} from "../../shared/extensionAcquisition";
import type { ExtensionAcquisitionSettings } from "../../shared/settings";
import type { ExtensionUpdateProviderTransitionState } from "../../hooks/extensionAcquisitionState";
import { CopyButton } from "../ui/CopyButton";
import { riskReasonText } from "./entityDisplay";
import {
  formatAcquisitionDateTime,
  formatExtensionAcquisitionError,
} from "./extensionAcquisitionUi";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

type Notify = (kind: "success" | "error" | "info", text: string) => void;

export type BrowserRuntimeIdentity =
  | { status: "known"; id: string }
  | { status: "deriving" | "path-derived" | "unavailable" };

export type ArtifactProviderSettings = Pick<
  ExtensionAcquisitionSettings,
  "googleArtifactEnabled" | "crxsosoArtifactEnabled"
>;

export function displayedExtensionUpdateProviderId(
  extension: ExtensionEntity,
  transition: ExtensionUpdateProviderTransitionState,
): ExtensionUpdateProviderId | undefined {
  if (transition.extensionId !== extension.id) return extension.updateProviderId;
  if (transition.status === "success") {
    return transition.extension?.updateProviderId ?? transition.requestedProviderId ?? extension.updateProviderId;
  }
  return transition.previousProviderId ?? extension.updateProviderId;
}

function extensionProviderLabel(
  providerId: ExtensionArtifactProviderId | "manual-local" | "legacy" | undefined,
  t: Translate,
): string {
  switch (providerId) {
    case "chrome-web-store":
      return t("extension.detail.provider.google");
    case "crxsoso":
      return t("extension.detail.provider.crxsoso");
    case "manual-local":
      return t("extension.detail.provider.manualLocal");
    case "legacy":
      return t("extension.detail.provider.legacy");
    default:
      return t("extension.detail.notRecorded");
  }
}

function extensionVerificationLabel(level: ExtensionVerificationLevel | undefined, t: Translate): string {
  if (!level) return t("extension.detail.notRecorded");
  return t(`extension.detail.verification.${level}` as TranslationKey);
}

function extensionUpdateStateLabel(state: ExtensionUpdateState | undefined, t: Translate): string {
  if (!state) return t("extension.detail.notRecorded");
  return t(`extension.detail.updateState.${state.status}` as TranslationKey);
}

export function ExtensionRowDetail({
  browserRuntimeIdentity,
  busy,
  extension,
  identityPinned,
  kindLabel,
  locale,
  setExtensionUpdatePolicy,
  t,
  toast,
  transitionUpdateProvider,
  updateProviderSettings,
  updateProviderTransition,
}: {
  browserRuntimeIdentity: BrowserRuntimeIdentity;
  busy: string;
  extension: ExtensionEntity;
  identityPinned: boolean;
  kindLabel: string;
  locale: Locale;
  setExtensionUpdatePolicy: (extension: ExtensionEntity, updatePolicy: ExtensionUpdatePolicy) => Promise<void>;
  t: Translate;
  toast: Notify;
  transitionUpdateProvider: (
    extensionId: string,
    previousProviderId: ExtensionArtifactProviderId,
    requestedProviderId: ExtensionArtifactProviderId,
  ) => Promise<ExtensionEntity | undefined>;
  updateProviderSettings: ArtifactProviderSettings;
  updateProviderTransition: ExtensionUpdateProviderTransitionState;
}) {
  const localSourceKind = extension.sourceKind === "local-directory"
    || extension.sourceKind === "local-zip"
    || extension.sourceKind === "local-crx";
  const pathText = extension.localPath
    ?? (localSourceKind && extension.sourceUrl ? extension.sourceUrl : t("module.extensionNoPath"));
  const description = extension.description && extension.description !== extension.name ? extension.description : "";
  const localPath = extension.localPath;
  const canOpenDirectory = Boolean(localPath) && isTauri();
  const updateProviderTransitionApplies = updateProviderTransition.extensionId === extension.id;
  const effectiveExtension = updateProviderTransitionApplies
    && updateProviderTransition.status === "success"
    && updateProviderTransition.extension
    ? updateProviderTransition.extension
    : extension;
  const provenance = effectiveExtension.provenance;
  const updateState = effectiveExtension.updateState;
  const displayedUpdateProvider = displayedExtensionUpdateProviderId(extension, updateProviderTransition);
  const updatePolicySelectId = useId();
  const updateProviderSelectId = useId();
  const updateProviderFeedbackId = useId();
  const updateProviderOptions: Array<{
    id: ExtensionUpdateProviderId;
    enabled: boolean;
    label: string;
  }> = [
    {
      id: "chrome-web-store",
      enabled: updateProviderSettings.googleArtifactEnabled,
      label: extensionProviderLabel("chrome-web-store", t),
    },
    {
      id: "crxsoso",
      enabled: updateProviderSettings.crxsosoArtifactEnabled,
      label: extensionProviderLabel("crxsoso", t),
    },
  ];
  const updateProviderEligible = Boolean(
    displayedUpdateProvider
    && effectiveExtension.storeIdentity?.namespace === "chrome-web-store"
    && effectiveExtension.provenance?.verification.level === "cws-publisher-verified",
  );
  const updateProviderRequestInFlight = updateProviderTransition.status === "saving";
  const updateProviderSaving = updateProviderTransitionApplies && updateProviderTransition.status === "saving";
  const hasEnabledUpdateProviderAlternative = updateProviderOptions.some((option) => (
    option.id !== displayedUpdateProvider && option.enabled
  ));
  const updateProviderFailure = updateProviderTransitionApplies
    && updateProviderTransition.status === "error"
    && updateProviderTransition.error
    ? formatExtensionAcquisitionError(updateProviderTransition.error, t)
    : undefined;
  const updateProviderRefreshFailure = updateProviderTransitionApplies
    && updateProviderTransition.refreshError
    ? formatExtensionAcquisitionError(updateProviderTransition.refreshError, t)
    : undefined;
  const updateProviderFeedback = updateProviderSaving
    ? t("extension.detail.updateProvider.saving")
    : updateProviderFailure
      ? t("extension.detail.updateProvider.failed", { message: updateProviderFailure.primary })
      : updateProviderRefreshFailure
        ? t("extension.detail.updateProvider.savedRefreshFailed", { message: updateProviderRefreshFailure.primary })
        : updateProviderTransitionApplies && updateProviderTransition.status === "success" && displayedUpdateProvider
          ? t("extension.detail.updateProvider.saved", {
              provider: extensionProviderLabel(displayedUpdateProvider, t),
            })
          : hasEnabledUpdateProviderAlternative
            ? t("extension.detail.updateProvider.help")
            : t("extension.detail.updateProvider.noAlternative");
  const updateProviderFeedbackDetail = updateProviderFailure?.detail ?? updateProviderRefreshFailure?.detail;
  const updateProviderFeedbackIsError = Boolean(updateProviderFailure || updateProviderRefreshFailure);
  const lifecycleUnprotected = extension.sourceKind === "local-directory"
    && extension.directoryMode !== "copy"
    && !identityPinned;
  const permissionChips = useMemo(() => {
    const risks = new Map<string, ExtensionPermissionRisk>(extension.permissionRisks.map((risk) => [risk.permission, risk]));
    return [...new Set([...extension.permissions, ...extension.hostPermissions])].map((permission) => {
      const risk = risks.get(permission);
      const level = risk?.level === "high" ? "high" : risk?.level === "medium" ? "medium" : "low";
      return { permission, level, title: risk ? riskReasonText(risk, t) : undefined };
    });
  }, [extension.hostPermissions, extension.permissionRisks, extension.permissions, t]);

  async function openLocalDirectory() {
    if (!localPath) return;
    try {
      // Must stay a Rust command. The shell plugin's JS `open` validates its argument against a
      // scope regex that only accepts mailto/tel/http(s), so no filesystem path ever passes.
      // Calling the plugin from Rust skips that scope check, and `cbpanel_open_directory` guards
      // the path is a directory first. `shell:allow-open` is intentionally absent from
      // src-tauri/capabilities/default.json, so the JS route is not reachable from here anyway.
      await invoke("cbpanel_open_directory", { path: localPath });
    } catch (error) {
      toast("error", t("error.openDirectoryFailed", { message: errorMessage(error) }));
    }
  }

  return (
    <div className="extension-detail">
      {lifecycleUnprotected && (
        <div className="extension-detail-warning">{t("module.extensionLifecycleUnprotectedReference")}</div>
      )}
      {extension.lastError && <div className="extension-detail-error">{extension.lastError}</div>}
      {description && <p className="extension-detail-description">{description}</p>}
      <section className="extension-detail-group">
        <h4>{t("extension.detail.info")}</h4>
        <dl>
          <div>
            <dt>{t("extension.detail.sourceKind")}</dt>
            <dd>{kindLabel}</dd>
          </div>
          <div>
            <dt>{t("module.extensionManifest")}</dt>
            <dd>{extension.manifestVersion ? `MV${extension.manifestVersion}` : "-"}</dd>
          </div>
          <div>
            <dt>{t("form.version")}</dt>
            <dd>{extension.version}</dd>
          </div>
          {extension.sourceKind === "local-directory" && (
            <div>
              <dt>{t("module.extensionDirectoryMode")}</dt>
              <dd>{extension.directoryMode === "copy" ? t("module.extensionDirectoryModeCopy") : t("module.extensionDirectoryModeReference")}</dd>
            </div>
          )}
          {/* A pinned identity is the healthy default, so only the path-derived case is worth a cell. */}
          {!identityPinned && (
            <div>
              <dt>{t("module.extensionIdentity")}</dt>
              <dd>{t("module.extensionIdentityPathBased")}</dd>
            </div>
          )}
          <div className="extension-detail-row-wide">
            <dt>{t("extension.detail.extensionId")}</dt>
            <dd className="extension-detail-copyable">
              <span className="mono-cell extension-detail-wrap">{extension.id}</span>
              <CopyButton t={t} value={extension.id} />
            </dd>
          </div>
          <div className="extension-detail-row-wide">
            <dt>{t("extension.detail.webStoreId")}</dt>
            {effectiveExtension.storeIdentity?.namespace === "chrome-web-store" ? (
              <dd className="extension-detail-copyable">
                <span className="mono-cell extension-detail-wrap">{effectiveExtension.storeIdentity.storeId}</span>
                <CopyButton t={t} value={effectiveExtension.storeIdentity.storeId} />
              </dd>
            ) : <dd>{t("extension.detail.notAssociated")}</dd>}
          </div>
          <div className="extension-detail-row-wide">
            <dt>{t("extension.detail.browserRuntimeId")}</dt>
            {browserRuntimeIdentity.status === "known" ? (
              <dd className="extension-detail-copyable">
                <span className="mono-cell extension-detail-wrap">{browserRuntimeIdentity.id}</span>
                <CopyButton t={t} value={browserRuntimeIdentity.id} />
              </dd>
            ) : (
              <dd>{t(`extension.detail.browserRuntimeId.${browserRuntimeIdentity.status}` as TranslationKey)}</dd>
            )}
          </div>
          {/* Local-directory imports never carry a sha256, so an empty row would just print a dash. */}
          {extension.sha256 && (
            <div className="extension-detail-row-wide">
              <dt>{t("module.extensionSha256")}</dt>
              <dd className="extension-detail-copyable">
                <span className="mono-cell extension-detail-wrap">{extension.sha256}</span>
                <CopyButton t={t} value={extension.sha256} />
              </dd>
            </div>
          )}
        </dl>
      </section>
      {(provenance || displayedUpdateProvider || updateState) && (
        <section className="extension-detail-group">
          <h4>{t("extension.detail.provenance")}</h4>
          <dl>
            <div>
              <dt>{t("extension.detail.catalogProvider")}</dt>
              <dd>{extensionProviderLabel(provenance?.catalog?.providerId, t)}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.catalogObservedAt")}</dt>
              <dd>{provenance?.catalog?.observedAt
                ? formatAcquisitionDateTime(provenance.catalog.observedAt, locale)
                : t("extension.detail.notRecorded")}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.artifactProvider")}</dt>
              <dd>{extensionProviderLabel(provenance?.artifact.providerId, t)}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.finalByteHost")}</dt>
              <dd className="mono-cell extension-detail-wrap">
                {provenance?.artifact.finalByteHost ?? t("extension.detail.notRecorded")}
              </dd>
            </div>
            <div>
              <dt>{t("extension.detail.fetchedAt")}</dt>
              <dd>{provenance?.artifact.fetchedAt
                ? formatAcquisitionDateTime(provenance.artifact.fetchedAt, locale)
                : t("extension.detail.notRecorded")}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.verificationLevel")}</dt>
              <dd>{extensionVerificationLabel(provenance?.verification.level, t)}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.verifiedAt")}</dt>
              <dd>{provenance?.verification.verifiedAt
                ? formatAcquisitionDateTime(provenance.verification.verifiedAt, locale)
                : t("extension.detail.notRecorded")}</dd>
            </div>
            <div className="extension-detail-row-wide">
              <dt>{t("extension.detail.publisherTrustRoot")}</dt>
              <dd className="mono-cell extension-detail-wrap">
                {provenance?.verification.publisherTrustRootId
                  ? `${provenance.verification.publisherTrustRootId}${
                      provenance.verification.publisherTrustRootVersion === undefined
                        ? ""
                        : ` · v${provenance.verification.publisherTrustRootVersion}`
                    }`
                  : t("extension.detail.notRecorded")}
              </dd>
            </div>
            <div>
              <dt>{t("extension.detail.updateProvider")}</dt>
              <dd>{extensionProviderLabel(displayedUpdateProvider, t)}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.updateState")}</dt>
              <dd>{extensionUpdateStateLabel(updateState, t)}</dd>
            </div>
            <div>
              <dt>{t("extension.detail.updateCheckedAt")}</dt>
              <dd>{updateState?.checkedAt
                ? formatAcquisitionDateTime(updateState.checkedAt, locale)
                : t("extension.detail.notRecorded")}</dd>
            </div>
            {updateState?.availableVersion && (
              <div>
                <dt>{t("extension.detail.availableVersion")}</dt>
                <dd>{updateState.availableVersion}</dd>
              </div>
            )}
            {updateState?.errorCode && (
              <div className="extension-detail-row-wide">
                <dt>{t("extension.detail.updateErrorCode")}</dt>
                <dd className="mono-cell extension-detail-wrap">{updateState.errorCode}</dd>
              </div>
            )}
          </dl>
        </section>
      )}
      <section className="extension-detail-group">
        <h4>{t("extension.detail.location")}</h4>
        <div className="extension-detail-location">
          <span className="mono-cell extension-detail-wrap">{pathText}</span>
          <div className="extension-detail-location-actions">
            <CopyButton t={t} value={pathText} />
            {canOpenDirectory && (
              <button className="command subtle" onClick={() => void openLocalDirectory()} type="button">
                <FolderOpen size={15} aria-hidden="true" />
                {t("actions.openDirectory")}
              </button>
            )}
          </div>
        </div>
      </section>
      <section className="extension-detail-group">
        <h4>{t("extension.detail.permissions")}</h4>
        <div className="extension-detail-chips">
          {permissionChips.length === 0 && <small>-</small>}
          {permissionChips.map((chip) => (
            <span className={`risk-chip risk-${chip.level}`} key={chip.permission} title={chip.title}>
              {chip.permission}
            </span>
          ))}
        </div>
      </section>
      <section className="extension-detail-group">
        <h4>{t("extension.detail.settings")}</h4>
        <dl>
          <div className="extension-detail-row-wide">
            <dt><label htmlFor={updatePolicySelectId}>{t("module.extensionUpdatePolicy")}</label></dt>
            <dd>
              <select
                className="extension-policy-select"
                disabled={busy === `extension-policy:${extension.id}`}
                id={updatePolicySelectId}
                value={extension.updatePolicy}
                onChange={(event) => void setExtensionUpdatePolicy(extension, event.target.value as ExtensionUpdatePolicy)}
              >
                <option value="pinned">{t("module.extensionUpdatePolicyPinned")}</option>
                <option value="notify">{t("module.extensionUpdatePolicyNotify")}</option>
                <option value="auto">{t("module.extensionUpdatePolicyAuto")}</option>
              </select>
            </dd>
          </div>
          {updateProviderEligible && displayedUpdateProvider && (
            <div className="extension-detail-row-wide">
              <dt><label htmlFor={updateProviderSelectId}>{t("extension.detail.updateProvider.select")}</label></dt>
              <dd className="extension-update-provider-control">
                <select
                  aria-busy={updateProviderSaving || undefined}
                  aria-describedby={updateProviderFeedbackId}
                  className="extension-policy-select"
                  disabled={updateProviderRequestInFlight || !hasEnabledUpdateProviderAlternative}
                  id={updateProviderSelectId}
                  onChange={(event) => {
                    const requestedProvider = event.target.value as ExtensionArtifactProviderId;
                    if (requestedProvider !== displayedUpdateProvider) {
                      void transitionUpdateProvider(extension.id, displayedUpdateProvider, requestedProvider);
                    }
                  }}
                  value={displayedUpdateProvider}
                >
                  {updateProviderOptions.map((option) => (
                    <option
                      disabled={!option.enabled && option.id !== displayedUpdateProvider}
                      key={option.id}
                      value={option.id}
                    >
                      {option.label}
                    </option>
                  ))}
                </select>
                <small
                  className={updateProviderFeedbackIsError ? "danger-text" : undefined}
                  id={updateProviderFeedbackId}
                  role={updateProviderFeedbackIsError ? "alert" : "status"}
                >
                  {updateProviderFeedback}
                  {updateProviderFeedbackDetail ? ` — ${updateProviderFeedbackDetail}` : ""}
                </small>
              </dd>
            </div>
          )}
        </dl>
      </section>
    </div>
  );
}
