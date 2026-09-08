import { Activity, Copy, Download, Globe, Network, Save } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { BrowserProfile, ProxyScheme, ProxySettings } from "../../shared/profile";
import { describeXrayProxy, maskProxyUrlForDisplay, proxyRequiresXray, proxyUsesXray } from "../../shared/profile";
import type { ProxyEntity, XrayEngineStatus } from "../../shared/entities";
import type { XrayNativeProxyRouting } from "../../shared/settings";
import { PasswordInput } from "../ui/PasswordInput";
import { Field, Segmented } from "../ui/form-controls";
import { SelectMenu } from "../ui/SelectMenu";
import { maskManagedProxyForDisplay } from "./proxyDisplay";
import { IpStrategyField, PreProxyField, XrayShareLinkField, proxyHealthSummary, proxyOptionMeta } from "./XrayProxyFields";

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
          meta: proxyOptionMeta(proxy, t),
        }))}
        onChange={applyManagedProxy}
      />
    </Field>
  );
}

export function ManualProxyFields({
  draft,
  proxies,
  proxyEnabled,
  proxyUrlError,
  proxyUrlText,
  t,
  updateProxyParts,
  updateProxyRaw,
  usingManagedProxy,
}: {
  draft: BrowserProfile;
  proxies: ProxyEntity[];
  proxyEnabled: boolean;
  proxyUrlError: string;
  proxyUrlText: string;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  updateProxyParts: (patch: Partial<ProxySettings>) => void;
  updateProxyRaw: (value: string) => void;
  usingManagedProxy: boolean;
}) {
  const isXray = draft.proxy.scheme === "xray";
  const chained = Boolean(draft.proxy.preProxyId);
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
              { value: "xray", label: t("form.schemeXray") },
            ]}
            onChange={(scheme) => updateProxyParts({ scheme })}
          />
        </Field>
        {isXray ? (
          <XrayShareLinkField
            disabled={!proxyEnabled || usingManagedProxy}
            onChange={(shareLink) => updateProxyParts({ shareLink })}
            t={t}
            value={draft.proxy.shareLink}
          />
        ) : (
          <>
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
          </>
        )}
        <Field label={t("form.bypass")} wide>
          <input value={draft.proxy.bypass} onChange={(event) => updateProxyParts({ bypass: event.target.value })} placeholder={t("placeholder.proxyBypass")} />
        </Field>
        <PreProxyField
          disabled={!proxyEnabled || usingManagedProxy}
          onChange={(preProxyId) => updateProxyParts({ preProxyId })}
          proxies={proxies}
          t={t}
          value={draft.proxy.preProxyId}
        />
        {(isXray || chained) && (
          <IpStrategyField
            disabled={!proxyEnabled || usingManagedProxy}
            onChange={(ipStrategy) => updateProxyParts({ ipStrategy })}
            t={t}
            value={draft.proxy.ipStrategy}
          />
        )}
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
  draft,
  installXray,
  nativeProxyRouting = "auto",
  proxyEnabled,
  proxyUrlError,
  resolveProxyGeoip,
  saveDraftProxyToLibrary,
  selectedManagedProxy,
  t,
  usingManagedProxy,
  xrayStatus,
}: {
  busy: string;
  canSaveProxyToLibrary: boolean;
  checkProxy: () => Promise<void>;
  copyManagedProxyToLocal: () => void;
  currentProxyUrl: string;
  draft: BrowserProfile;
  installXray?: () => Promise<unknown>;
  nativeProxyRouting?: XrayNativeProxyRouting;
  proxyEnabled: boolean;
  proxyUrlError: string;
  resolveProxyGeoip: () => Promise<void>;
  saveDraftProxyToLibrary: () => Promise<void>;
  selectedManagedProxy: ProxyEntity | undefined;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  usingManagedProxy: boolean;
  xrayStatus?: XrayEngineStatus | null;
}) {
  const proxyDisplay = proxyEnabled
    ? usingManagedProxy
      ? maskManagedProxyForDisplay(selectedManagedProxy, maskProxyUrlForDisplay(currentProxyUrl))
      : maskProxyUrlForDisplay(currentProxyUrl)
    : t("filter.proxyDisabled");
  const engineDetail = proxyEnabled ? describeXrayProxy(draft.proxy) ?? (draft.proxy.preProxyId ? t("proxy.xray.viaEngine") : undefined) : undefined;
  // The library entry's own history: an operator picking a managed proxy wants to know whether it worked
  // the last time anyone looked, without having to run a check from inside the environment first.
  const managedHealth = usingManagedProxy && selectedManagedProxy && (selectedManagedProxy.lastCheck || selectedManagedProxy.lastLatency)
    ? proxyHealthSummary(selectedManagedProxy, t)
    : undefined;
  // Read live from the panel's engine status, so installing the engine in Settings shows up here at once.
  const engineInstalled = xrayStatus?.installed ?? false;
  const hardRequired = proxyEnabled && proxyRequiresXray(draft.proxy);
  const viaEngine = proxyEnabled && Boolean(xrayStatus) && proxyUsesXray(draft.proxy, { nativeProxyRouting, engineInstalled });
  // A missing engine only blocks when something insists on it: a node, a chain, or the "always" setting.
  const engineMissingBlocks = proxyEnabled && Boolean(xrayStatus) && !engineInstalled && (hardRequired || nativeProxyRouting === "always");
  const engineRequired = viaEngine || engineMissingBlocks;
  const engineReady = engineRequired ? !engineMissingBlocks : undefined;

  return (
    <div className={`proxy-check-panel wide${proxyEnabled ? "" : " disabled"}`}>
      <div className="proxy-check-summary">
        <Network size={18} aria-hidden="true" />
        <span>
          {proxyDisplay}
          {engineDetail && <small className="proxy-check-engine">{engineDetail}</small>}
          {managedHealth && <small className="proxy-check-engine">{managedHealth}</small>}
        </span>
      </div>
      {engineRequired && engineReady !== undefined && (
        <div className={`proxy-engine-line ${engineReady ? "ready" : "missing"}`}>
          <small>
            {engineReady
              ? hardRequired
                ? t("proxy.xray.engineReady", { version: xrayStatus?.version ?? "" })
                : t("proxy.xray.viaEngineAuto", { version: xrayStatus?.version ?? "" })
              : t("proxy.xray.engineMissing")}
          </small>
          {!engineReady && installXray && (
            <button className="command subtle" disabled={busy === "xray-install"} onClick={() => void installXray()} type="button">
              <Download size={15} aria-hidden="true" />
              {t("proxy.xray.installEngine")}
            </button>
          )}
        </div>
      )}
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
          className="command subtle"
          disabled={Boolean(proxyUrlError) || !currentProxyUrl || busy === "proxy-geoip"}
          onClick={() => void resolveProxyGeoip()}
          title={t("tips.resolveGeoip")}
          type="button"
        >
          <Globe size={16} aria-hidden="true" />
          {t("actions.resolveGeoip")}
        </button>
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
