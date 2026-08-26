import {
  CircleCheck,
  CircleX,
  Database,
  Download,
  Info,
  Network,
  RefreshCw,
  Search,
  ShieldAlert,
} from "lucide-react";
import { useId, type ReactNode } from "react";

import type { Locale } from "../../i18n";
import type {
  ExtensionAcquisitionCapabilityId,
  ExtensionCapabilityOperation,
  ExtensionCapabilityView,
} from "../../shared/extensionAcquisition";
import { StatusPill } from "../ui/StatusPill";
import { Switch } from "../ui/switch";
import {
  ExtensionAcquisitionDialog,
  formatAcquisitionDateTime,
  type ExtensionAcquisitionUiKey,
  type ExtensionAcquisitionUiTranslator,
} from "./extensionAcquisitionUi";

const CAPABILITY_COPY: Record<
  ExtensionAcquisitionCapabilityId,
  { name: ExtensionAcquisitionUiKey; description: ExtensionAcquisitionUiKey; icon: ReactNode }
> = {
  "crxsoso-search": {
    name: "extension.acquisition.source.crxsosoSearchName",
    description: "extension.acquisition.source.crxsosoSearchDescription",
    icon: <Search aria-hidden="true" size={18} />,
  },
  "google-artifact": {
    name: "extension.acquisition.source.googleArtifactName",
    description: "extension.acquisition.source.googleArtifactDescription",
    icon: <Download aria-hidden="true" size={18} />,
  },
  "crxsoso-artifact": {
    name: "extension.acquisition.source.crxsosoArtifactName",
    description: "extension.acquisition.source.crxsosoArtifactDescription",
    icon: <Download aria-hidden="true" size={18} />,
  },
};

const OPERATION_COPY: Record<ExtensionCapabilityOperation, ExtensionAcquisitionUiKey> = {
  search: "extension.acquisition.source.operation.search",
  "resolve-id": "extension.acquisition.source.operation.resolve",
  "download-current": "extension.acquisition.source.operation.download",
  "open-listing": "extension.acquisition.source.operation.openListing",
};

export type ExtensionAcquisitionSourceSettingsProps = {
  busyCapabilityId?: ExtensionAcquisitionCapabilityId;
  capabilities: ExtensionCapabilityView[];
  disabledReasons?: Partial<Record<ExtensionAcquisitionCapabilityId, string>>;
  error?: string;
  healthMessages?: Partial<Record<ExtensionAcquisitionCapabilityId, string>>;
  loading?: boolean;
  locale: Locale;
  onRefresh?: () => void | Promise<void>;
  onToggle: (capabilityId: ExtensionAcquisitionCapabilityId, enabled: boolean) => void | Promise<void>;
  refreshing?: boolean;
  t: ExtensionAcquisitionUiTranslator;
};

export function ExtensionAcquisitionSourceSettings({
  busyCapabilityId,
  capabilities,
  disabledReasons = {},
  error,
  healthMessages = {},
  loading = false,
  locale,
  onRefresh,
  onToggle,
  refreshing = false,
  t,
}: ExtensionAcquisitionSourceSettingsProps) {
  const headingId = useId();
  const allOff = capabilities.length > 0 && capabilities.every((capability) => !capability.enabled);

  return (
    <section aria-labelledby={headingId} className="acquisition-source-settings">
      <header className="acquisition-section-header">
        <div>
          <h3 id={headingId}>{t("extension.acquisition.source.title")}</h3>
          <p>{t("extension.acquisition.source.description")}</p>
        </div>
        {onRefresh && (
          <button
            className="command subtle"
            disabled={loading || refreshing || Boolean(busyCapabilityId)}
            onClick={() => void onRefresh()}
            type="button"
          >
            <RefreshCw aria-hidden="true" className={refreshing ? "spin" : undefined} size={15} />
            {refreshing ? t("extension.acquisition.source.loading") : t("actions.refresh")}
          </button>
        )}
      </header>

      {error && (
        <div className="inline-error" role="alert">
          <CircleX aria-hidden="true" size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading && capabilities.length === 0 ? (
        <div aria-live="polite" className="preflight-empty" role="status">
          {t("extension.acquisition.source.loading")}
        </div>
      ) : (
        <div className="acquisition-source-list" role="list">
          {capabilities.map((capability) => (
            <CapabilityRow
              busy={busyCapabilityId === capability.id}
              capability={capability}
              disabledReason={disabledReasons[capability.id] ?? (
                busyCapabilityId && busyCapabilityId !== capability.id
                  ? t("extension.acquisition.source.saving")
                  : undefined
              )}
              healthMessage={healthMessages[capability.id]}
              key={capability.id}
              locale={locale}
              onToggle={onToggle}
              t={t}
            />
          ))}
        </div>
      )}

      {allOff && (
        <div aria-live="polite" className="diagnostic-note acquisition-all-off" role="status">
          <Info aria-hidden="true" size={16} />
          <span>
            <strong>{t("extension.acquisition.source.allOff")}</strong>
            <small>{t("extension.acquisition.source.allOffHelp")}</small>
          </span>
        </div>
      )}
    </section>
  );
}

function CapabilityRow({
  busy,
  capability,
  disabledReason,
  healthMessage,
  locale,
  onToggle,
  t,
}: {
  busy: boolean;
  capability: ExtensionCapabilityView;
  disabledReason?: string;
  healthMessage?: string;
  locale: Locale;
  onToggle: ExtensionAcquisitionSourceSettingsProps["onToggle"];
  t: ExtensionAcquisitionUiTranslator;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const stateId = useId();
  const disabledReasonId = useId();
  const copy = CAPABILITY_COPY[capability.id];
  const disabled = busy || Boolean(disabledReason);
  const health = capability.health;
  const describedBy = [descriptionId, stateId, disabledReason ? disabledReasonId : undefined]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={`acquisition-source-card ${capability.enabled ? "enabled" : "disabled"}`} role="listitem">
      <span className="acquisition-source-icon" aria-hidden="true">
        {copy.icon}
      </span>
      <div className="acquisition-source-copy">
        <div className="acquisition-source-heading">
          <h4 id={titleId}>{t(copy.name)}</h4>
          <StatusPill tone={capability.trust === "google-hosted" ? "running" : "warning"}>
            {capability.trust === "google-hosted"
              ? t("extension.acquisition.source.trust.google")
              : t("extension.acquisition.source.trust.thirdParty")}
          </StatusPill>
        </div>
        <p id={descriptionId}>{t(copy.description)}</p>
        <p className="acquisition-source-operations">
          <strong>{t("extension.acquisition.source.operations")}</strong>{" "}
          {capability.operations.map((operation) => t(OPERATION_COPY[operation])).join(" · ")}
        </p>
        <div className="acquisition-source-health" id={stateId}>
          {health ? (
            <>
              {health.status === "healthy" ? (
                <CircleCheck aria-hidden="true" size={14} />
              ) : (
                <CircleX aria-hidden="true" size={14} />
              )}
              <span>
                {health.status === "healthy"
                  ? t("extension.acquisition.health.healthy")
                  : t("extension.acquisition.health.unavailable")}
                {" · "}
                {t("extension.acquisition.health.checkedAt", {
                  time: formatAcquisitionDateTime(health.checkedAt, locale),
                })}
                {healthMessage ? ` · ${healthMessage}` : health.errorCode ? ` · ${health.errorCode}` : ""}
              </span>
            </>
          ) : (
            <>
              <Info aria-hidden="true" size={14} />
              <span>{t("extension.acquisition.health.notChecked")}</span>
            </>
          )}
        </div>
        {disabledReason && (
          <p className="acquisition-disabled-reason" id={disabledReasonId}>
            {disabledReason}
          </p>
        )}
      </div>
      <div className="acquisition-source-toggle">
        <Switch
          aria-describedby={describedBy}
          aria-labelledby={titleId}
          checked={capability.enabled}
          className="toggle-switch"
          disabled={disabled}
          onCheckedChange={(enabled) => void onToggle(capability.id, enabled)}
        />
        <small aria-live="polite">
          {busy
            ? t("extension.acquisition.source.saving")
            : capability.enabled
              ? t("extension.acquisition.source.enabled")
              : t("extension.acquisition.source.disabled")}
        </small>
      </div>
    </article>
  );
}

export function ExtensionAcquisitionSourceSettingsDialog({
  close,
  ...settingsProps
}: ExtensionAcquisitionSourceSettingsProps & { close: () => void }) {
  const saving = Boolean(settingsProps.busyCapabilityId);
  return (
    <ExtensionAcquisitionDialog
      actions={
        <button className="command primary" disabled={saving} onClick={close} type="button">
          {settingsProps.t("actions.close")}
        </button>
      }
      closeDisabled={saving}
      closeLabel={settingsProps.t("actions.close")}
      description={settingsProps.t("extension.acquisition.source.description")}
      onClose={close}
      title={settingsProps.t("extension.acquisition.source.title")}
    >
      <ExtensionAcquisitionSourceSettings {...settingsProps} />
    </ExtensionAcquisitionDialog>
  );
}

export function ExtensionAcquisitionDisclosureDialog({
  busy,
  error,
  onAccept,
  onCancel,
  t,
}: {
  busy: boolean;
  error?: string;
  onAccept: () => void | Promise<void>;
  onCancel: () => void;
  t: ExtensionAcquisitionUiTranslator;
}) {
  return (
    <ExtensionAcquisitionDialog
      actions={
        <>
          <button
            className="command subtle"
            data-acquisition-autofocus
            disabled={busy}
            onClick={onCancel}
            type="button"
          >
            {t("actions.cancel")}
          </button>
          <button className="command primary" disabled={busy} onClick={() => void onAccept()} type="button">
            {t("extension.acquisition.disclosure.accept")}
          </button>
        </>
      }
      closeDisabled={busy}
      closeLabel={t("actions.close")}
      description={t("extension.acquisition.disclosure.description")}
      onClose={onCancel}
      panelClassName="confirm-panel acquisition-disclosure-panel"
      title={t("extension.acquisition.disclosure.title")}
    >
      <div className="acquisition-disclosure">
        <div className="diagnostic-note warning">
          <ShieldAlert aria-hidden="true" size={18} />
          <strong>{t("extension.acquisition.disclosure.notGoogle")}</strong>
        </div>
        <section aria-labelledby="acquisition-disclosure-data-title">
          <h3 id="acquisition-disclosure-data-title">{t("extension.acquisition.disclosure.dataTitle")}</h3>
          <ul className="acquisition-fact-list">
            <li>
              <Search aria-hidden="true" size={16} />
              <span>{t("extension.acquisition.disclosure.dataQuery")}</span>
            </li>
            <li>
              <Network aria-hidden="true" size={16} />
              <span>{t("extension.acquisition.disclosure.dataContext")}</span>
            </li>
            <li>
              <Database aria-hidden="true" size={16} />
              <span>{t("extension.acquisition.disclosure.noRequestOnCancel")}</span>
            </li>
          </ul>
        </section>
        {error && (
          <div className="inline-error" role="alert">
            <CircleX aria-hidden="true" size={16} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </ExtensionAcquisitionDialog>
  );
}
