import { useEffect, useState } from "react";
import { ChevronsUpDown, CircleStop, ShieldCheck, Sparkles, Zap } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { GithubMirrorProbeResponse } from "../../shared/githubMirror";
import {
  BUILTIN_GITHUB_MIRROR_PROVIDERS,
  BUILTIN_NETWORK_TRACE_PROVIDERS,
  type AppSettings,
  type AppSettingsPatch,
  type GithubMirrorProviderId,
  type NetworkTraceSettings,
} from "../../shared/settings";
import { ChoiceList, ChoiceOption, clampChoiceIndex, closeOnFocusLeave, nextChoiceIndex } from "../ui/choice-list";
import { SelectMenu } from "../ui/SelectMenu";
import { Field, NumberField } from "../ui/form-controls";

export function NetworkSettingsPanel({
  checkGithubMirrors,
  saveSettings,
  settings,
  t,
}: {
  checkGithubMirrors: (customGithubMirrorPrefix: string) => Promise<GithubMirrorProbeResponse>;
  saveSettings: (patch: AppSettingsPatch) => Promise<void>;
  settings: AppSettings;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const trace = settings.networkTrace;
  const [mirrorProbe, setMirrorProbe] = useState<GithubMirrorProbeResponse | null>(null);
  const options = [
    ...BUILTIN_NETWORK_TRACE_PROVIDERS.map((item) => ({
      value: item.id,
      label: item.name,
      meta: item.url,
    })),
    {
      value: "custom",
      label: t("networkTrace.custom"),
      meta: trace.customProviderUrl || t("networkTrace.customHint"),
    },
  ];

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

  return (
    <div className="settings-stack no-padding">
      <section className="settings-section">
        <div className="settings-section-head">
          <div>
            <h2>{t("networkTrace.title")}</h2>
            <p>{t("networkTrace.description")}</p>
          </div>
        </div>
        <Field label={t("networkTrace.provider")} help={t("networkTrace.providerHelp")}>
          <SelectMenu
            value={trace.providerId}
            placeholder={t("networkTrace.provider")}
            options={options}
            onChange={(providerId) => saveTrace({ providerId })}
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
          <div>
            <h2>{t("githubMirror.title")}</h2>
            <p>{t("githubMirror.description")}</p>
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
    </div>
  );
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
          if (event.key === "Escape") setOpen(false);
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
