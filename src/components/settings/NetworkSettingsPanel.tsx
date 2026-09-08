import { useEffect, useState } from "react";
import { ChevronsUpDown, CircleStop, Download, RefreshCw, ShieldCheck, Sparkles, Zap } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { XrayEngineStatus } from "../../shared/entities";
import type { GithubMirrorProbeResponse } from "../../shared/githubMirror";
import {
  BUILTIN_GITHUB_MIRROR_PROVIDERS,
  BUILTIN_NETWORK_TRACE_PROVIDERS,
  type AppSettings,
  type AppSettingsPatch,
  type GithubMirrorProviderId,
  type NetworkTraceProvider,
  type NetworkTraceProviderCategory,
  type NetworkTraceSettings,
  type XrayNativeProxyRouting,
  type XraySettings,
} from "../../shared/settings";
import { XRAY_LOG_LEVELS, XRAY_UTLS_FINGERPRINTS, type XrayLogLevel, type XrayUtlsFingerprint } from "../../shared/xray";
import { NetworkTraceProviderIcon } from "./networkTraceProviderIcons";
import { ChoiceList, ChoiceOption, clampChoiceIndex, closeOnFocusLeave, nextChoiceIndex } from "../ui/choice-list";
import { Field, InfoTip, NumberField, Segmented, ToggleField } from "../ui/form-controls";
import { SelectMenu } from "../ui/SelectMenu";

export function NetworkSettingsPanel({
  busy = "",
  checkGithubMirrors,
  checkXrayUpdate,
  installXray,
  saveSettings,
  settings,
  t,
  xrayStatus = null,
}: {
  busy?: string;
  checkGithubMirrors: (customGithubMirrorPrefix: string) => Promise<GithubMirrorProbeResponse>;
  checkXrayUpdate?: () => Promise<unknown>;
  installXray?: () => Promise<unknown>;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  settings: AppSettings;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  xrayStatus?: XrayEngineStatus | null;
}) {
  const trace = settings.networkTrace;
  const [mirrorProbe, setMirrorProbe] = useState<GithubMirrorProbeResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    void checkGithubMirrors(trace.customGithubMirrorPrefix)
      .then((response) => {
        if (!cancelled) setMirrorProbe(response);
      })
      .catch(() => {
        if (!cancelled) setMirrorProbe(null);
      });
    return () => {
      cancelled = true;
    };
  }, [checkGithubMirrors, trace.customGithubMirrorPrefix]);

  function saveTrace(patch: Partial<NetworkTraceSettings>) {
    void saveSettings({ networkTrace: { ...trace, ...patch } });
  }

  function saveXray(patch: Partial<XraySettings>) {
    void saveSettings({ xray: { ...settings.xray, ...patch } });
  }

  return (
    <div className="settings-stack no-padding">
      <section className="settings-section">
        <div className="settings-section-head">
          <div className="settings-section-title-with-tip">
            <h2>{t("networkTrace.title")}</h2>
            <InfoTip text={t("networkTrace.description")} />
          </div>
        </div>
        <Field label={t("networkTrace.provider")} help={t("networkTrace.providerHelp")}>
          <NetworkTraceProviderSelect
            value={trace.providerId}
            customUrl={trace.customProviderUrl}
            onChange={(providerId) => saveTrace({ providerId })}
            t={t}
          />
        </Field>
        {trace.providerId === "custom" && (
          <Field label={t("networkTrace.customUrl")} wide help={t("networkTrace.customUrlHelp")}>
            <input
              value={trace.customProviderUrl}
              onChange={(event) => saveTrace({ customProviderUrl: event.target.value })}
              placeholder="https://example.com/cdn-cgi/trace"
            />
          </Field>
        )}
        <NumberField
          label={t("networkTrace.timeout")}
          value={trace.timeoutSeconds}
          min={2}
          max={30}
          onChange={(timeoutSeconds) => saveTrace({ timeoutSeconds })}
        />
      </section>

      <section className="settings-section">
        <div className="settings-section-head">
          <div className="settings-section-title-with-tip">
            <h2>{t("githubMirror.title")}</h2>
            <InfoTip text={t("githubMirror.description")} />
          </div>
        </div>
        <Field label={t("githubMirror.provider")} help={t("githubMirror.providerHelp")}>
          <GithubMirrorSelect
            value={trace.githubMirrorProviderId}
            customPrefix={trace.customGithubMirrorPrefix}
            probe={mirrorProbe}
            onChange={(githubMirrorProviderId) => saveTrace({ githubMirrorProviderId })}
            t={t}
          />
        </Field>
        {trace.githubMirrorProviderId === "custom" && (
          <Field label={t("githubMirror.customPrefix")} wide help={t("githubMirror.customPrefixHelp")}>
            <input
              value={trace.customGithubMirrorPrefix}
              onChange={(event) => saveTrace({ customGithubMirrorPrefix: event.target.value })}
              placeholder="https://gh-proxy.com/"
            />
          </Field>
        )}
      </section>

      <XrayEngineSection
        busy={busy}
        checkXrayUpdate={checkXrayUpdate}
        installXray={installXray}
        saveXray={saveXray}
        settings={settings.xray}
        status={xrayStatus}
        t={t}
      />
    </div>
  );
}

const UTLS_LABEL_KEYS: Partial<Record<XrayUtlsFingerprint, TranslationKey>> = {
  auto: "xray.utls.auto",
};

function XrayEngineSection({
  busy,
  checkXrayUpdate,
  installXray,
  saveXray,
  settings,
  status,
  t,
}: {
  busy: string;
  checkXrayUpdate?: () => Promise<unknown>;
  installXray?: () => Promise<unknown>;
  saveXray: (patch: Partial<XraySettings>) => void;
  settings: XraySettings;
  status: XrayEngineStatus | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const installed = status?.installed ?? false;
  const operationRunning = Boolean(status?.operation) || busy === "xray-install" || busy === "xray-check-update";
  const lastCheck = status?.lastUpdateCheck ?? settings.lastUpdateCheck;
  const sourceKey: TranslationKey = status?.source === "custom" ? "xray.source.custom" : status?.source === "managed" ? "xray.source.managed" : "xray.source.missing";

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <div className="settings-section-title-with-tip">
          <h2>{t("xray.title")}</h2>
          <InfoTip text={t("xray.description")} />
        </div>
        <div className="row-actions">
          <button
            className="command subtle"
            disabled={operationRunning || !checkXrayUpdate || !status?.releaseAsset}
            onClick={() => void checkXrayUpdate?.()}
            type="button"
          >
            <RefreshCw size={15} aria-hidden="true" />
            {t("xray.checkUpdate")}
          </button>
          <button
            className="command primary"
            disabled={operationRunning || !installXray || !status?.releaseAsset || (status?.instances.length ?? 0) > 0}
            onClick={() => void installXray?.()}
            title={(status?.instances.length ?? 0) > 0 ? t("xray.instancesBlockInstall") : undefined}
            type="button"
          >
            <Download size={15} aria-hidden="true" />
            {installed ? t("xray.update") : t("xray.install")}
          </button>
        </div>
      </div>
      <div className={`settings-status-line ${installed ? "enabled" : "warning"}`}>
        <span className="settings-status-heading">
          <strong>{installed ? t("xray.installed") : t("xray.notInstalled")}</strong>
          {status?.version && <small>v{status.version}</small>}
          {status && <small>· {t(sourceKey)}</small>}
          {status?.operation && <small>· {t("xray.operationRunning", { operation: status.operation.type })}</small>}
        </span>
        {status?.binaryPath && <small className="mono-cell">{status.binaryPath}</small>}
        {status && !status.releaseAsset && <small>{t("xray.unsupportedPlatform")}</small>}
        {lastCheck && (
          <small>
            {lastCheck.error
              ? lastCheck.error
              : lastCheck.updateAvailable
                ? t("xray.updateAvailable", { version: lastCheck.latestVersion ?? "" })
                : t("xray.upToDate")}
            {" · "}
            {t("xray.lastCheck")} {new Date(lastCheck.checkedAt).toLocaleString()}
          </small>
        )}
        {status?.lastError && <small className="xray-status-error">{status.lastError}</small>}
      </div>
      <Field label={t("xray.customBinaryPath")} wide help={t("xray.customBinaryPathHelp")}>
        <input
          value={settings.customBinaryPath}
          onChange={(event) => saveXray({ customBinaryPath: event.target.value })}
          placeholder={status?.binaryPath ?? "xray"}
        />
      </Field>
      <Field label={t("xray.nativeProxyRouting")} wide help={t("xray.nativeProxyRoutingHelp")}>
        <Segmented<XrayNativeProxyRouting>
          value={settings.nativeProxyRouting}
          options={[
            { value: "auto", label: t("xray.nativeProxyRouting.auto") },
            { value: "always", label: t("xray.nativeProxyRouting.always") },
            { value: "never", label: t("xray.nativeProxyRouting.never") },
          ]}
          onChange={(nativeProxyRouting) => saveXray({ nativeProxyRouting })}
        />
      </Field>
      <Field label={t("xray.utlsFingerprint")} help={t("xray.utlsFingerprintHelp")}>
        <SelectMenu<XrayUtlsFingerprint>
          onChange={(utlsFingerprint) => saveXray({ utlsFingerprint })}
          options={XRAY_UTLS_FINGERPRINTS.map((fingerprint) => ({
            value: fingerprint,
            label: UTLS_LABEL_KEYS[fingerprint] ? t(UTLS_LABEL_KEYS[fingerprint]) : fingerprint,
          }))}
          placeholder={t("xray.utls.auto")}
          value={settings.utlsFingerprint}
        />
      </Field>
      <Field label={t("xray.logLevel")}>
        <Segmented<XrayLogLevel>
          value={settings.logLevel}
          options={XRAY_LOG_LEVELS.map((level) => ({ value: level, label: level }))}
          onChange={(logLevel) => saveXray({ logLevel })}
        />
      </Field>
      <ToggleField
        checked={settings.autoRestart}
        help={t("xray.autoRestartHelp")}
        label={t("xray.autoRestart")}
        onChange={(autoRestart) => saveXray({ autoRestart })}
      />
      <ToggleField
        checked={settings.checkForUpdatesOnStartup}
        label={t("xray.checkForUpdatesOnStartup")}
        onChange={(checkForUpdatesOnStartup) => saveXray({ checkForUpdatesOnStartup })}
      />
      <div className="result-line">
        {status && status.instances.length > 0
          ? status.instances.map((instance) => (
              <div key={instance.ownerId}>
                {t("xray.instanceLine", { owner: instance.ownerId, port: instance.port, restarts: instance.restarts })} · {instance.preProxy ? `${instance.preProxy} → ` : ""}{instance.upstream}
              </div>
            ))
          : t("xray.noInstances")}
      </div>
    </section>
  );
}

type NetworkTraceOption = {
  value: string;
  label: string;
  meta: string;
  category: NetworkTraceProviderCategory;
  kind: NetworkTraceProvider["kind"] | "custom";
};

function NetworkTraceProviderSelect({
  customUrl,
  onChange,
  t,
  value,
}: {
  customUrl: string;
  onChange: (value: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const options: NetworkTraceOption[] = [
    ...BUILTIN_NETWORK_TRACE_PROVIDERS.map((provider) => ({
      value: provider.id,
      label: provider.name,
      meta: provider.actualDomain ?? summarizeTraceUrl(provider.url),
      category: provider.category,
      kind: provider.kind,
    })),
    {
      value: "custom",
      label: t("networkTrace.custom"),
      meta: customUrl || t("networkTrace.customHint"),
      category: "static",
      kind: "custom",
    },
  ];
  const selected = options.find((option) => option.value === value) ?? options[0];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected.value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  function openAt(index: number) {
    setActiveIndex(clampChoiceIndex(index, options.length));
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div
      className={`network-trace-select ${open ? "open" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => setOpen(false))}
    >
      <button
        aria-label={t("networkTrace.provider")}
        aria-expanded={open}
        className="network-trace-trigger"
        onClick={() => {
          if (!open) openAt(selectedIndex);
          else setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            if (open) {
              setActiveIndex((current) => nextChoiceIndex(current, options.length, direction));
            } else {
              setActiveIndex(nextChoiceIndex(selectedIndex, options.length, direction));
              setOpen(true);
            }
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openAt(selectedIndex);
            else commit(activeIndex);
          }
          if (event.key === "Escape" && open) {
            // Swallow it while the menu is open so an enclosing Drawer stays put.
            event.stopPropagation();
            setOpen(false);
          }
        }}
        type="button"
      >
        <TraceIcon option={selected} />
        <span className="network-trace-trigger-main">
          <strong>{selected.label}</strong>
          <small>{selected.meta}</small>
        </span>
        <span className="network-trace-trigger-side">
          <TraceChips option={selected} t={t} />
          <ChevronsUpDown size={16} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <ChoiceList className="network-trace-list">
          {options.map((option, index) => {
            const selectedOption = option.value === value;
            return (
              <ChoiceOption
                active={activeIndex === index || (activeIndex < 0 && selectedOption)}
                className="network-trace-option"
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                keepFocus
                onMouseEnter={() => setActiveIndex(index)}
              >
                <TraceIcon option={option} />
                <span className="network-trace-option-main">
                  <span className="network-trace-option-title">
                    <strong>{option.label}</strong>
                    {selectedOption && <span className="mirror-chip primary">{t("githubMirror.currentBadge")}</span>}
                  </span>
                  <small>{option.meta}</small>
                </span>
                <span className="network-trace-option-tags">
                  <TraceChips option={option} t={t} />
                </span>
              </ChoiceOption>
            );
          })}
        </ChoiceList>
      )}
    </div>
  );
}

function TraceIcon({ option }: { option: NetworkTraceOption }) {
  return (
    <span className={`trace-provider-icon ${option.category} ${option.kind === "custom" ? "custom" : ""}`} aria-hidden="true">
      <NetworkTraceProviderIcon className="trace-provider-icon-svg" category={option.category} providerId={option.value} />
    </span>
  );
}

function TraceChips({
  option,
  t,
}: {
  option: NetworkTraceOption;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  if (option.kind === "custom") {
    return <span className="trace-category-chip custom">{t("networkTrace.tagCustom")}</span>;
  }
  const chips = traceDisplayCategories(option.category);
  return (
    <>
      {chips.map((category) => (
        <CategoryChip category={category} key={category} t={t} />
      ))}
    </>
  );
}

function CategoryChip({
  category,
  t,
}: {
  category: NetworkTraceProviderCategory;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return <span className={`trace-category-chip ${category}`}>{t(`networkTrace.category.${category}`)}</span>;
}

function traceDisplayCategories(category: NetworkTraceProviderCategory): NetworkTraceProviderCategory[] {
  if (category === "domestic") return ["domestic"];
  if (category === "international") return ["international"];
  return ["international", category];
}

function summarizeTraceUrl(value: string): string {
  try {
    const url = new URL(value);
    return url.hostname;
  } catch {
    return value;
  }
}

type GithubMirrorOption = {
  value: GithubMirrorProviderId;
  label: string;
  meta: string;
  icon: "auto" | "off" | "mirror" | "custom";
  result?: GithubMirrorProbeResponse["results"][number];
  isBest?: boolean;
  isDefault?: boolean;
};

function GithubMirrorSelect({
  customPrefix,
  onChange,
  probe,
  t,
  value,
}: {
  customPrefix: string;
  onChange: (value: GithubMirrorProviderId) => void;
  probe: GithubMirrorProbeResponse | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  value: GithubMirrorProviderId;
}) {
  const [open, setOpen] = useState(false);
  const bestId = probe?.recommendedProviderId;
  const options: GithubMirrorOption[] = [
    {
      value: "auto-best",
      label: t("githubMirror.autoBest"),
      meta: bestId
        ? t("githubMirror.bestNode", { name: mirrorProviderName(bestId) })
        : t("githubMirror.autoBestMeta"),
      icon: "auto",
      isBest: value === "auto-best",
    },
    {
      value: "off",
      label: t("githubMirror.off"),
      meta: t("githubMirror.offMeta"),
      icon: "off",
    },
    ...BUILTIN_GITHUB_MIRROR_PROVIDERS.map((item) => {
      const result = probe?.results.find((candidate) => candidate.providerId === item.id);
      return {
        value: item.id,
        label: item.name,
        meta: item.prefix,
        icon: "mirror" as const,
        result,
        isBest: item.id === bestId,
        isDefault: item.id === "gh-proxy-com",
      };
    }),
    {
      value: "custom",
      label: t("githubMirror.custom"),
      meta: customPrefix || t("githubMirror.customHint"),
      icon: "custom",
      result: probe?.results.find((candidate) => candidate.providerId === "custom"),
    },
  ];
  const selected = options.find((option) => option.value === value) ?? options[1];
  const selectedIndex = Math.max(0, options.findIndex((option) => option.value === selected.value));
  const [activeIndex, setActiveIndex] = useState(selectedIndex);

  function openAt(index: number) {
    setActiveIndex(clampChoiceIndex(index, options.length));
    setOpen(true);
  }

  function commit(index: number) {
    const option = options[index];
    if (!option) return;
    onChange(option.value);
    setOpen(false);
  }

  return (
    <div
      className={`github-mirror-select ${open ? "open" : ""}`}
      onBlur={(event) => closeOnFocusLeave(event, () => setOpen(false))}
    >
      <button
        aria-label={t("githubMirror.provider")}
        aria-expanded={open}
        className="github-mirror-trigger"
        onClick={() => {
          if (!open) openAt(selectedIndex);
          else setOpen(false);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const direction = event.key === "ArrowDown" ? 1 : -1;
            if (open) {
              setActiveIndex((current) => nextChoiceIndex(current, options.length, direction));
            } else {
              setActiveIndex(nextChoiceIndex(selectedIndex, options.length, direction));
              setOpen(true);
            }
          }
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openAt(selectedIndex);
            else commit(activeIndex);
          }
          if (event.key === "Escape" && open) {
            // Swallow it while the menu is open so an enclosing Drawer stays put.
            event.stopPropagation();
            setOpen(false);
          }
        }}
        type="button"
      >
        <MirrorIcon kind={selected.icon} />
        <span className="github-mirror-trigger-main">
          <strong>{selected.label}</strong>
          <small>{selected.value === "auto-best" ? selected.meta : githubMirrorOptionMeta(selected, t)}</small>
        </span>
        <span className="github-mirror-trigger-side">
          {selected.value === "auto-best" && <span className="mirror-chip primary">{t("githubMirror.autoBadge")}</span>}
          {selected.isDefault && <span className="mirror-chip neutral">{t("githubMirror.defaultBadge")}</span>}
          {selected.isBest && selected.value !== "auto-best" && <span className="mirror-chip success">{t("githubMirror.bestBadge")}</span>}
          <ChevronsUpDown size={16} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <ChoiceList className="github-mirror-list">
          {options.map((option) => {
            const speed = githubMirrorSpeed(option.result?.latencyMs, option.result?.ok, t);
            const selectedOption = option.value === value;
            const isMeasuredMirror = option.value !== "off" && option.value !== "auto-best";
            return (
              <ChoiceOption
                active={activeIndex === options.indexOf(option) || (activeIndex < 0 && selectedOption)}
                className={`github-mirror-option ${option.value === "auto-best" ? "auto" : ""}`}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                keepFocus
                onMouseEnter={() => setActiveIndex(options.indexOf(option))}
              >
                <MirrorIcon kind={option.icon} />
                <span className="github-mirror-option-main">
                  <span className="github-mirror-option-title">
                    <strong>{option.label}</strong>
                    {option.value === "auto-best" && <span className="mirror-chip primary">{t("githubMirror.autoBadge")}</span>}
                    {option.isDefault && <span className="mirror-chip neutral">{t("githubMirror.defaultBadge")}</span>}
                    {option.isBest && option.value !== "auto-best" && <span className="mirror-chip success">{t("githubMirror.bestBadge")}</span>}
                    {selectedOption && <span className="mirror-chip primary">{t("githubMirror.currentBadge")}</span>}
                  </span>
                  <small>{option.meta}</small>
                </span>
                <span className="github-mirror-option-metric">
                  {isMeasuredMirror && (
                    <>
                      {option.result?.ok && <span>{githubMirrorLatencyText(option.result, t)}</span>}
                      <span className={`mirror-speed ${speed.tone}`}>{speed.label}</span>
                    </>
                  )}
                </span>
              </ChoiceOption>
            );
          })}
        </ChoiceList>
      )}
    </div>
  );
}

function MirrorIcon({ kind }: { kind: GithubMirrorOption["icon"] }) {
  if (kind === "auto") return <ShieldCheck className="mirror-node-icon auto" size={17} aria-hidden="true" />;
  if (kind === "custom") return <Sparkles className="mirror-node-icon custom" size={17} aria-hidden="true" />;
  if (kind === "off") return <CircleStop className="mirror-node-icon off" size={17} aria-hidden="true" />;
  return <Zap className="mirror-node-icon mirror" size={17} aria-hidden="true" />;
}

function githubMirrorOptionMeta(
  option: GithubMirrorOption,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  if (option.value === "off") return option.meta;
  if (option.value === "auto-best") return option.meta;
  const latency = githubMirrorLatencyText(option.result, t);
  const speed = githubMirrorSpeed(option.result?.latencyMs, option.result?.ok, t);
  return option.result?.ok ? `${latency} - ${speed.label}` : speed.label;
}

function githubMirrorLatencyText(
  result: GithubMirrorProbeResponse["results"][number] | undefined,
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
): string {
  return typeof result?.latencyMs === "number" && Number.isFinite(result.latencyMs)
    ? t("githubMirror.latency", { ms: result.latencyMs })
    : t("githubMirror.speedUnknown");
}

function githubMirrorSpeed(
  latencyMs: number | undefined,
  ok: boolean | undefined,
  t: (key: TranslationKey) => string,
): { label: string; tone: "fast" | "medium" | "slow" | "failed" | "unknown" } {
  if (ok === false) return { label: t("githubMirror.failed"), tone: "failed" };
  if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs)) {
    return { label: t("githubMirror.unchecked"), tone: "unknown" };
  }
  if (latencyMs <= 500) return { label: t("githubMirror.speed.fast"), tone: "fast" };
  if (latencyMs <= 1200) return { label: t("githubMirror.speed.medium"), tone: "medium" };
  return { label: t("githubMirror.speed.slow"), tone: "slow" };
}

function mirrorProviderName(providerId: Exclude<GithubMirrorProviderId, "off">): string {
  if (providerId === "custom") return "Custom";
  if (providerId === "auto-best") return "Auto";
  return BUILTIN_GITHUB_MIRROR_PROVIDERS.find((provider) => provider.id === providerId)?.name ?? providerId;
}
