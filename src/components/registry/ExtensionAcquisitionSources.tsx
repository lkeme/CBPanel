import { Check, Database, Download, Network, Search, ShieldAlert, CircleX } from "lucide-react";
import { useId, type ReactNode } from "react";

import type { ExtensionArtifactProviderId } from "../../shared/extensionAcquisition";
import { StatusPill } from "../ui/StatusPill";
import { ExtensionAcquisitionDialog } from "./RegistryDialogs";
import {
  ExtensionAcquisitionErrorText,
  type ExtensionAcquisitionUiKey,
  type ExtensionAcquisitionUiError,
  type ExtensionAcquisitionUiTranslator,
} from "./extensionAcquisitionUi";

const CAPABILITY_COPY: Record<
  "google-artifact" | "crxsoso-artifact",
  { name: ExtensionAcquisitionUiKey; description: ExtensionAcquisitionUiKey; icon: ReactNode }
> = {
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

export type ExtensionAcquisitionSourceSettingsProps = {
  busyProviderId?: ExtensionArtifactProviderId;
  selectedProviderId?: ExtensionArtifactProviderId;
  error?: { code?: string; message: string };
  onSelectProvider: (providerId: ExtensionArtifactProviderId) => void | Promise<void>;
  t: ExtensionAcquisitionUiTranslator;
};

export function ExtensionAcquisitionSourceSettings({
  busyProviderId,
  error,
  selectedProviderId = "crxsoso",
  onSelectProvider,
  t,
}: ExtensionAcquisitionSourceSettingsProps) {
  const channelCapabilities = [
    {
      id: "crxsoso-artifact" as const,
      trust: "third-party" as const,
    },
    {
      id: "google-artifact" as const,
      trust: "google-hosted" as const,
    },
  ];

  return (
    <section aria-label={t("extension.acquisition.source.channelLegend")} className="acquisition-source-settings">
      <fieldset className="acquisition-channel-settings-list" disabled={Boolean(busyProviderId)}>
        <legend>{t("extension.acquisition.source.channelLegend")}</legend>
        {channelCapabilities.map((capability) => (
          <ChannelRow
            busy={busyProviderId === providerForCapability(capability.id)}
            capability={capability}
            key={capability.id}
            onSelectProvider={onSelectProvider}
            selected={selectedProviderId === providerForCapability(capability.id)}
            t={t}
          />
        ))}
      </fieldset>

      {error && (
        <div className="inline-error" role="alert">
          <ExtensionAcquisitionErrorText error={error} t={t} />
        </div>
      )}

      <p className="acquisition-source-footnote">
        {t("extension.acquisition.source.singleChannelHelp")}
      </p>
    </section>
  );
}

function providerForCapability(id: "google-artifact" | "crxsoso-artifact"): ExtensionArtifactProviderId {
  return id === "google-artifact" ? "chrome-web-store" : "crxsoso";
}

function ChannelRow({
  busy,
  capability,
  onSelectProvider,
  selected,
  t,
}: {
  busy: boolean;
  capability: { id: "google-artifact" | "crxsoso-artifact"; trust: "google-hosted" | "third-party" };
  onSelectProvider: ExtensionAcquisitionSourceSettingsProps["onSelectProvider"];
  selected: boolean;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const copy = CAPABILITY_COPY[capability.id];
  const providerId = providerForCapability(capability.id);

  return (
    <label className={`acquisition-source-card acquisition-channel-setting-card ${selected ? "enabled" : ""}`}>
      <input
        aria-describedby={descriptionId}
        aria-labelledby={titleId}
        checked={selected}
        disabled={busy}
        name="extension-acquisition-artifact-provider"
        onChange={() => {
          // The controller serializes setting writes; a rejected write is
          // reflected in its error state. Observe the promise here as this is
          // a native event boundary and must not create a detached rejection.
          void Promise.resolve(onSelectProvider(providerId)).catch(() => undefined);
        }}
        type="radio"
        value={providerId}
      />
      <span className="acquisition-source-icon" aria-hidden="true">{copy.icon}</span>
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
      </div>
      {selected && <Check aria-hidden="true" className="acquisition-channel-selected-mark" size={18} />}
    </label>
  );
}

export function ExtensionAcquisitionSourceSettingsDialog({
  close,
  ...settingsProps
}: ExtensionAcquisitionSourceSettingsProps & { close: () => void }) {
  const saving = Boolean(settingsProps.busyProviderId);
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
  error?: ExtensionAcquisitionUiError;
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
            <ExtensionAcquisitionErrorText error={error} t={t} />
          </div>
        )}
      </div>
    </ExtensionAcquisitionDialog>
  );
}
