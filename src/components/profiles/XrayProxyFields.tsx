import { useMemo } from "react";

import type { TranslationKey } from "../../i18n";
import type { ProxyEntity } from "../../shared/entities";
import {
  XRAY_IP_STRATEGIES,
  type ParsedXrayShareLink,
  type XrayIpStrategy,
  describeXrayNode,
  isMaskedXrayShareLink,
  parseXrayShareLink,
} from "../../shared/xray";
import { Field } from "../ui/form-controls";
import { SelectMenu } from "../ui/SelectMenu";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export type XrayShareLinkAnalysis = {
  parsed?: ParsedXrayShareLink;
  error?: string;
  masked: boolean;
};

const IP_STRATEGY_LABELS: Record<XrayIpStrategy, TranslationKey> = {
  "auto": "ipStrategy.auto",
  "ipv4-first": "ipStrategy.ipv4-first",
  "ipv6-first": "ipStrategy.ipv6-first",
  "ipv4-only": "ipStrategy.ipv4-only",
  "ipv6-only": "ipStrategy.ipv6-only",
};

export function analyzeXrayShareLink(value: string): XrayShareLinkAnalysis {
  const trimmed = value.trim();
  if (!trimmed) return { masked: false };
  if (isMaskedXrayShareLink(trimmed)) return { masked: true };
  try {
    return { parsed: parseXrayShareLink(trimmed), masked: false };
  } catch (error) {
    return { error: (error as Error).message, masked: false };
  }
}

/** The validation message for a share-link field, or "" when the link can be saved. */
export function xrayShareLinkError(value: string, t: Translate): string {
  const analysis = analyzeXrayShareLink(value);
  if (analysis.parsed) return "";
  if (analysis.masked) return t("form.xrayNodeMasked");
  if (analysis.error) return t("form.xrayNodeInvalid", { reason: analysis.error });
  return t("proxy.editor.validationShareLink");
}

export function proxyOptionMeta(proxy: ProxyEntity, t?: Translate): string {
  const address = proxy.xrayNode
    ? `${proxy.xrayNode.protocol} · ${formatAddress(proxy.host)}:${proxy.port}`
    : `${proxy.scheme}://${proxy.host}:${proxy.port}`;
  return t ? `${address} · ${proxyHealthSummary(proxy, t)}` : address;
}

/** The last exit check and latency probe in one short line, for pickers and rows that have no room for two pills. */
export function proxyHealthSummary(proxy: Pick<ProxyEntity, "lastCheck" | "lastLatency">, t: Translate): string {
  const parts: string[] = [];
  const check = proxy.lastCheck;
  if (check) {
    const place = check.geo?.countryCode ?? check.trace?.loc?.toUpperCase();
    parts.push(check.ok ? `✅ ${[place, check.ip].filter(Boolean).join(" ")}`.trim() : `❌ ${t("proxy.check.failed")}`);
  }
  const latency = proxy.lastLatency;
  if (latency) {
    parts.push(latency.ok && latency.latencyMs !== undefined ? `⏱ ${latency.latencyMs} ms` : `⏱ ${t("proxy.latency.failed")}`);
  }
  return parts.length ? parts.join(" · ") : t("module.proxyUnchecked");
}

export function XrayShareLinkField({
  disabled = false,
  onChange,
  t,
  value,
}: {
  disabled?: boolean;
  onChange: (value: string) => void;
  t: Translate;
  value: string;
}) {
  const analysis = useMemo(() => analyzeXrayShareLink(value), [value]);
  const error = value.trim() ? xrayShareLinkError(value, t) : "";
  const summary = analysis.parsed?.summary;

  return (
    <>
      <Field label={t("form.xrayShareLink")} help={t("tips.xrayShareLink")} wide error={error}>
        <textarea
          className="xray-share-link-input"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={t("placeholder.xrayShareLink")}
          rows={3}
          spellCheck={false}
          value={value}
        />
      </Field>
      {summary && (
        <div className="xray-node-summary wide">
          <span>{t("form.xrayNodeSummary")}</span>
          <strong className="mono-cell">
            {describeXrayNode(summary)} · {formatAddress(summary.address)}:{summary.port}
          </strong>
          {summary.remark && <small>{summary.remark}</small>}
          {summary.warnings.map((warning) => (
            <small className="xray-node-warning" key={warning}>
              {warning}
            </small>
          ))}
        </div>
      )}
    </>
  );
}

export function PreProxyField({
  disabled = false,
  excludeId,
  onChange,
  proxies,
  t,
  value,
}: {
  disabled?: boolean;
  /** The proxy being edited, which cannot be its own front proxy. */
  excludeId?: string;
  onChange: (proxyId: string) => void;
  proxies: ProxyEntity[];
  t: Translate;
  value: string;
}) {
  const candidates = proxies.filter((proxy) => proxy.id !== excludeId);
  // A stale id (a front proxy deleted in another tab) still renders, as the id, so the operator can see
  // what the chain points at and clear it.
  const stale = value && !candidates.some((proxy) => proxy.id === value);
  const options = [
    { value: "", label: t("form.preProxyNone") },
    ...candidates.map((proxy) => ({
      value: proxy.id,
      label: proxy.status === "disabled" ? `${proxy.name} (${t("proxy.statusDisabled")})` : proxy.name,
      meta: proxyOptionMeta(proxy, t),
    })),
    ...(stale ? [{ value, label: value, meta: t("proxy.references.noTarget") }] : []),
  ];
  return (
    <Field label={t("form.preProxy")} help={t("tips.preProxy")} wide>
      <SelectMenu
        disabled={disabled}
        onChange={onChange}
        options={options}
        placeholder={t("form.preProxyNone")}
        value={value}
      />
    </Field>
  );
}

export function IpStrategyField({
  disabled = false,
  onChange,
  t,
  value,
}: {
  disabled?: boolean;
  onChange: (value: XrayIpStrategy) => void;
  t: Translate;
  value: XrayIpStrategy;
}) {
  return (
    <Field label={t("form.ipStrategy")} help={t("tips.ipStrategy")}>
      <SelectMenu<XrayIpStrategy>
        disabled={disabled}
        onChange={onChange}
        options={XRAY_IP_STRATEGIES.map((strategy) => ({ value: strategy, label: t(IP_STRATEGY_LABELS[strategy]) }))}
        placeholder={t("ipStrategy.auto")}
        value={value}
      />
    </Field>
  );
}

function formatAddress(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}
