import type { ReactNode } from "react";
import { Activity, Layers, MoreHorizontal, Pencil, Power, Rss } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { ProxyEntity, ProxySubscriptionEntity } from "../../shared/entities";
import { networkCheckSummaryText } from "../../shared/networkCheckDisplay";
import { describeXrayTransport } from "../../shared/xray";
import { Checkbox } from "../ui/checkbox";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { StatusPill } from "../ui/StatusPill";
import type { ModuleStat, ProxyFilter } from "./registryStats";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * The proxy library as a table: one row per node, sortable by eye because every kind of value keeps
 * its own column. The same inline actions the card layout had stay on each row.
 */
export function ProxyTableHeader({
  allPageSelected,
  t,
  togglePageSelected,
}: {
  allPageSelected: boolean;
  t: Translate;
  togglePageSelected: () => void;
}) {
  return (
    <div className="proxy-table-row head" role="row">
      <div className="cell align-center" role="columnheader">
        <Checkbox aria-label={t("proxy.batch.selectPage")} checked={allPageSelected} onCheckedChange={togglePageSelected} />
      </div>
      <div className="cell" role="columnheader">{t("proxy.table.name")}</div>
      <div className="cell" role="columnheader">{t("proxy.table.protocol")}</div>
      <div className="cell" role="columnheader">{t("proxy.table.health")}</div>
      <div className="cell align-center" role="columnheader">{t("proxy.table.references")}</div>
      <div className="cell proxy-table-actions" role="columnheader">{t("proxy.table.actions")}</div>
    </div>
  );
}

export function ProxyTableRow({
  busy,
  canReplace,
  checkManagedProxy,
  duplicateProxy,
  editProxy,
  preProxyName,
  proxy,
  requestProxyDelete,
  requestProxyReference,
  selected,
  showProfiles,
  stat,
  subscription,
  t,
  locale,
  toggleSelected,
  updateProxy,
}: {
  busy: string;
  canReplace: boolean;
  checkManagedProxy: (proxy: ProxyEntity) => Promise<void>;
  duplicateProxy: (proxy: ProxyEntity) => Promise<void>;
  editProxy: (proxy: ProxyEntity) => Promise<void>;
  preProxyName?: string;
  proxy?: ProxyEntity;
  requestProxyDelete: (proxy: ProxyEntity) => void;
  requestProxyReference: (action: "replace" | "unbind", proxy: ProxyEntity) => void;
  selected: boolean;
  showProfiles: (patch?: { proxyId?: string; proxy?: ProxyFilter }) => void;
  stat: ModuleStat;
  subscription?: ProxySubscriptionEntity;
  t: Translate;
  locale: Locale;
  toggleSelected: (proxyId: string) => void;
  updateProxy: (proxy: ProxyEntity, patch: Partial<ProxyEntity>) => Promise<void>;
}) {
  const check = proxy?.lastCheck;
  // A node's scheme is always "xray"; the useful part of the column is the endpoint it dials and,
  // for a native proxy, whether credentials are stored — never the credentials themselves.
  const endpoint = proxy ? `${proxy.host}:${proxy.port}` : stat.name;
  const address = proxy && proxy.scheme !== "xray" && proxy.username
    ? `${proxy.scheme}://${encodeURIComponent(proxy.username)}:***@${endpoint}`
    : proxy && proxy.scheme !== "xray"
      ? `${proxy.scheme}://${endpoint}`
      : endpoint;
  const hasReferences = stat.count > 0;
  const protocol = proxy?.xrayNode?.protocol ?? (proxy?.scheme === "socks5" ? "socks" : "http");
  const badge = proxy?.xrayNode
    ? proxy.xrayNode.protocol === "hysteria" ? "HY2" : proxy.xrayNode.protocol.toUpperCase()
    : proxy?.scheme.toUpperCase() ?? "-";
  const disabled = proxy?.status === "disabled";
  const transport = proxy?.xrayNode ? describeXrayTransport(proxy.xrayNode) : protocol;
  const protocolTitle = proxy ? `${badge} · ${transport} · ${address}` : badge;
  const healthTitle = check
    ? check.ok
      ? networkCheckSummaryText(check, { emptyText: t("table.ipUnchecked"), includeFlag: true, locale })
      : check.error ?? t("proxy.check.failed")
    : t("module.proxyUnchecked");

  return (
    <div className={`proxy-table-row tone-${disabled ? "muted" : "ready"}${selected ? " selected" : ""}`} role="row">
      <div className="cell align-center" role="cell">
        <Checkbox
          aria-label={t("proxy.batch.selectOne")}
          checked={selected}
          disabled={!proxy}
          onCheckedChange={() => proxy && toggleSelected(proxy.id)}
        />
      </div>
      <div className="cell proxy-table-name-cell" role="cell">
        <strong className="proxy-table-name" title={proxy?.name ?? stat.name}>{proxy?.name ?? stat.name}</strong>
        {subscription && (
          <span className="proxy-registry-subscription" title={t("subscription.member", { name: subscription.name })}>
            <Rss size={11} aria-hidden="true" />
            {subscription.name}
          </span>
        )}
        {proxy?.preProxyId && (
          <span className="proxy-table-chip" title={t("proxy.xray.chained", { name: preProxyName ?? proxy.preProxyId })}>
            {t("proxy.badge.chain")}
          </span>
        )}
        {proxy?.notes && <small className="proxy-table-notes" title={proxy.notes}>{proxy.notes}</small>}
      </div>
      <div className="cell" role="cell">
        <span className={`proxy-table-badge protocol-${protocol}`} title={protocolTitle}>
          {badge}
        </span>
      </div>
      <div className="cell proxy-table-health" role="cell" title={healthTitle}>
        {proxyCheckSummary(check, t, locale)}
      </div>
      <div className="cell align-center" role="cell">
        <button
          aria-label={t("proxy.table.references")}
          className={`proxy-reference-button${hasReferences ? "" : " is-empty"}`}
          disabled={!proxy || !hasReferences}
          onClick={() => proxy && showProfiles({ proxyId: proxy.id })}
          title={hasReferences ? t("module.runningCount", { count: stat.running }) : t("module.noReferences")}
          type="button"
        >
          <Layers size={12} aria-hidden="true" />
          <strong>{stat.count}</strong>
        </button>
      </div>
      <div className="cell proxy-table-actions" role="cell">
        {proxy && (
          <div className="module-row-actions proxy-row-actions">
            <button
              aria-label={t("actions.edit")}
              className="icon-button compact"
              disabled={busy === `proxy-load:${proxy.id}`}
              onClick={() => void editProxy(proxy)}
              title={t("actions.edit")}
              type="button"
            >
              <Pencil size={15} aria-hidden="true" />
            </button>
            <button
              aria-label={t("actions.check")}
              className="icon-button compact"
              disabled={busy === `proxy-check:${proxy.id}` || busy === "proxy-batch"}
              onClick={() => void checkManagedProxy(proxy)}
              title={t("actions.check")}
              type="button"
            >
              <Activity size={15} aria-hidden="true" />
            </button>
            {/* Disabling a managed proxy also turns it off for every environment that routes through
                it (the server maps status onto the profile's proxy.enabled), so this is the button
                that stops those environments from using it. */}
            <button
              aria-label={t(disabled ? "actions.enable" : "actions.disable")}
              aria-pressed={!disabled}
              className={`icon-button compact proxy-status-toggle${disabled ? " is-off" : " is-on"}`}
              disabled={busy === `proxy-update:${proxy.id}`}
              onClick={() => void updateProxy(proxy, { status: disabled ? "enabled" : "disabled" })}
              title={t(disabled ? "actions.enable" : "actions.disable")}
              type="button"
            >
              <Power size={15} aria-hidden="true" />
            </button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                  <MoreHorizontal size={16} aria-hidden="true" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="proxy-row-menu">
                <DropdownMenuItem disabled={busy === `proxy-duplicate:${proxy.id}`} onSelect={() => void duplicateProxy(proxy)}>
                  {t("actions.duplicate")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!canReplace || !hasReferences || busy === `proxy-replace:${proxy.id}`}
                  onSelect={() => requestProxyReference("replace", proxy)}
                  title={!canReplace ? t("module.noReplaceTarget") : !hasReferences ? t("module.noReferences") : undefined}
                >
                  {t("actions.replaceReferences")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!hasReferences || busy === `proxy-unbind:${proxy.id}`}
                  onSelect={() => requestProxyReference("unbind", proxy)}
                  title={!hasReferences ? t("module.noReferences") : undefined}
                >
                  {t("actions.unbindReferences")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="dropdown-menu-item-danger"
                  disabled={busy === `proxy-delete:${proxy.id}`}
                  onSelect={() => requestProxyDelete(proxy)}
                >
                  {t("actions.delete")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </div>
    </div>
  );
}

function proxyCheckSummary(
  check: ProxyEntity["lastCheck"],
  t: Translate,
  locale: Locale,
): ReactNode {
  if (!check) return <StatusPill tone="stopped">{t("module.proxyUnchecked")}</StatusPill>;
  if (check.ok) {
    return (
      <StatusPill tone="running">
        {networkCheckSummaryText(check, {
          emptyText: t("table.ipUnchecked"),
          failedText: t("proxy.check.failed"),
          includeFlag: true,
          locale,
          successPrefix: "✅",
        })}
      </StatusPill>
    );
  }
  return (
    <StatusPill tone="error">
      {networkCheckSummaryText(check, {
        failedText: t("proxy.check.failed"),
        failurePrefix: "❌",
        locale,
      })}
    </StatusPill>
  );
}
