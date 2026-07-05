import { Activity, Copy, Network, Save } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { BrowserProfile, ProxyScheme, ProxySettings } from "../../shared/profile";
import { maskProxyUrlForDisplay } from "../../shared/profile";
import type { ProxyEntity } from "../../shared/entities";
import { PasswordInput } from "../ui/PasswordInput";
import { Field, Segmented } from "../ui/form-controls";
import { SelectMenu } from "../ui/SelectMenu";
import { maskManagedProxyForDisplay } from "./proxyDisplay";

export type ProxySourceMode = "local" | "managed";

export function ManagedProxyPicker({
  applyManagedProxy,
  proxies,
  proxyEnabled,
  selectedLibraryProxyId,
  t,
}: {
  applyManagedProxy: (proxyId: string) => void;
  proxies: ProxyEntity[];
  proxyEnabled: boolean;
  selectedLibraryProxyId: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <Field label={t("form.proxyLibrary")} help={t("tips.proxyLibrary")} wide>
      <SelectMenu
        disabled={!proxyEnabled || proxies.length === 0}
        value={selectedLibraryProxyId}
        placeholder={proxies.length === 0 ? t("module.emptyTitle") : t("form.proxyLibrary")}
        options={proxies.map((proxy) => ({
          value: proxy.id,
          label: proxy.name,
          meta: `${proxy.scheme}://${proxy.host}:${proxy.port}`,
        }))}
        onChange={applyManagedProxy}
      />
    </Field>
  );
}

export function ManualProxyFields({
  draft,
  proxyEnabled,
  proxyUrlError,
  proxyUrlText,
  t,
  updateProxyParts,
  updateProxyRaw,
  usingManagedProxy,
}: {
  draft: BrowserProfile;
  proxyEnabled: boolean;
  proxyUrlError: string;
  proxyUrlText: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateProxyParts: (patch: Partial<ProxySettings>) => void;
  updateProxyRaw: (value: string) => void;
  usingManagedProxy: boolean;
}) {
  return (
    <fieldset className="proxy-manual-fields wide" disabled={!proxyEnabled || usingManagedProxy}>
      <div className="form-grid two compact-section">
        <Field label={t("form.scheme")} help={t("tips.proxyScheme")} wide>
          <Segmented<ProxyScheme>
            value={draft.proxy.scheme}
            options={[
              { value: "http", label: "HTTP" },
              { value: "https", label: "HTTPS" },
              { value: "socks5", label: "SOCKS5" },
            ]}
            onChange={(scheme) => updateProxyParts({ scheme })}
          />
        </Field>
        <Field label={t("form.proxyUrl")} wide error={proxyUrlError}>
          <input value={proxyUrlText} onChange={(event) => updateProxyRaw(event.target.value)} placeholder={t("placeholder.proxyUrl")} />
        </Field>
        <Field label={t("form.host")}>
          <input value={draft.proxy.host} onChange={(event) => updateProxyParts({ host: event.target.value })} placeholder={t("placeholder.proxyHost")} />
        </Field>
        <Field label={t("form.port")}>
          <input value={draft.proxy.port} onChange={(event) => updateProxyParts({ port: event.target.value })} placeholder={t("placeholder.proxyPort")} />
        </Field>
        <Field label={t("form.username")}>
          <input autoComplete="off" value={draft.proxy.username} onChange={(event) => updateProxyParts({ username: event.target.value })} placeholder={t("placeholder.proxyUsername")} />
        </Field>
        <Field label={t("form.password")}>
          <PasswordInput value={draft.proxy.password} onChange={(password) => updateProxyParts({ password })} t={t} />
        </Field>
        <Field label={t("form.bypass")} wide>
          <input value={draft.proxy.bypass} onChange={(event) => updateProxyParts({ bypass: event.target.value })} placeholder={t("placeholder.proxyBypass")} />
        </Field>
      </div>
    </fieldset>
  );
}

export function ProxyCheckPanel({
  busy,
  canSaveProxyToLibrary,
  checkProxy,
  copyManagedProxyToLocal,
  currentProxyUrl,
  proxyEnabled,
  proxyUrlError,
  saveDraftProxyToLibrary,
  selectedManagedProxy,
  t,
  usingManagedProxy,
}: {
  busy: string;
  canSaveProxyToLibrary: boolean;
  checkProxy: () => Promise<void>;
  copyManagedProxyToLocal: () => void;
  currentProxyUrl: string;
  proxyEnabled: boolean;
  proxyUrlError: string;
  saveDraftProxyToLibrary: () => Promise<void>;
  selectedManagedProxy: ProxyEntity | undefined;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  usingManagedProxy: boolean;
}) {
  const proxyDisplay = proxyEnabled
    ? usingManagedProxy
      ? maskManagedProxyForDisplay(selectedManagedProxy, maskProxyUrlForDisplay(currentProxyUrl))
      : maskProxyUrlForDisplay(currentProxyUrl)
    : t("filter.proxyDisabled");

  return (
    <div className={`proxy-check-panel wide${proxyEnabled ? "" : " disabled"}`}>
      <div className="proxy-check-summary">
        <Network size={18} aria-hidden="true" />
        <span>{proxyDisplay}</span>
      </div>
      <div className="proxy-check-actions">
        {usingManagedProxy && proxyEnabled && (
          <button
            className="command subtle"
            onClick={copyManagedProxyToLocal}
            title={t("tips.copyManagedProxyToLocal")}
            type="button"
          >
            <Copy size={16} aria-hidden="true" />
            {t("actions.copyToEnvironment")}
          </button>
        )}
        {!usingManagedProxy && (
          <button
            className="command subtle"
            disabled={!canSaveProxyToLibrary || busy === "proxy-promote"}
            onClick={() => void saveDraftProxyToLibrary()}
            title={t("tips.saveProxyToLibrary")}
            type="button"
          >
            <Save size={16} aria-hidden="true" />
            {t("actions.saveToProxyLibrary")}
          </button>
        )}
        <button
          className="command"
          disabled={Boolean(proxyUrlError) || !currentProxyUrl || busy === "proxy"}
          onClick={() => void checkProxy()}
          title={t("tips.checkProxyExit")}
          type="button"
        >
          <Activity size={17} aria-hidden="true" />
          {t("actions.check")}
        </button>
      </div>
    </div>
  );
}
