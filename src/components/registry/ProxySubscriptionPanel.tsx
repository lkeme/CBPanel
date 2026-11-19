import { useState } from "react";
import { ChevronDown, ChevronRight, FilePlus2, MoreHorizontal, Pencil, RefreshCw, Rss, Search } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { ProxyEntity, ProxySubscriptionEntity } from "../../shared/entities";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu";
import { Switch } from "../ui/switch";
import { formatRelativeTime } from "./RegistryEntityRow";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/**
 * The remembered subscriptions above the proxy list: one dense row each with its member count, the
 * outcome of the last refresh and the auto-refresh switch, so the library's sources are managed
 * where their nodes are seen.
 */
export function ProxySubscriptionPanel({
  busy,
  compact = false,
  editSubscription,
  inUseIds,
  locale,
  newSubscription,
  proxies,
  refreshAll,
  refreshSubscription,
  requestDelete,
  showMembers,
  subscriptions,
  t,
  updateSubscription,
}: {
  busy: string;
  /** One dense row instead of the full panel, for a library that holds neither proxies nor subscriptions. */
  compact?: boolean;
  editSubscription: (subscription: ProxySubscriptionEntity) => Promise<void>;
  /** Proxies named by a live environment, for the "in use" count. */
  inUseIds: Set<string>;
  locale: Locale;
  newSubscription: () => void | Promise<void>;
  proxies: ProxyEntity[];
  refreshAll: () => Promise<void>;
  refreshSubscription: (subscription: ProxySubscriptionEntity) => Promise<void>;
  requestDelete: (subscription: ProxySubscriptionEntity, proxies: "keep" | "delete") => void;
  showMembers: (subscription: ProxySubscriptionEntity) => void;
  subscriptions: ProxySubscriptionEntity[];
  t: Translate;
  updateSubscription: (subscription: ProxySubscriptionEntity, patch: Partial<ProxySubscriptionEntity>) => Promise<void>;
}) {
  const refreshingAll = busy === "subscription-refresh-all";
  const [collapsed, setCollapsed] = useState(false);
  // The compact one-liner has no toggle of its own, so a collapse chosen earlier must not hide it.
  const showList = compact || !collapsed;
  const toggleLabel = t(collapsed ? "subscription.expand" : "subscription.collapse");
  return (
    <section className={`subscription-panel${compact ? " is-compact" : ""}`} aria-label={t("subscription.title")}>
      <header className="subscription-panel-head">
        {!compact && (
          <button
            aria-expanded={!collapsed}
            aria-label={toggleLabel}
            className="icon-button compact subscription-panel-toggle"
            onClick={() => setCollapsed((current) => !current)}
            title={toggleLabel}
            type="button"
          >
            {collapsed ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          </button>
        )}
        <Rss size={15} aria-hidden="true" />
        <strong>{t("subscription.title")}</strong>
        {!compact && <small>{t("subscription.count", { count: subscriptions.length })}</small>}
        <span className="subscription-panel-spacer" />
        {subscriptions.length > 0 && (
          <button className="command subtle" disabled={refreshingAll || busy.startsWith("subscription-refresh:")} onClick={() => void refreshAll()} type="button">
            <RefreshCw className={refreshingAll ? "spin-icon" : undefined} size={14} aria-hidden="true" />
            {t("subscription.refreshAll")}
          </button>
        )}
        <button className="command subtle" disabled={busy === "subscription-create"} onClick={() => void newSubscription()} type="button">
          <FilePlus2 size={14} aria-hidden="true" />
          {t("subscription.new")}
        </button>
      </header>
      {!showList ? null : subscriptions.length === 0 ? (
        <p className="subscription-empty">{t(compact ? "subscription.compactHint" : "subscription.empty")}</p>
      ) : (
        <div className="subscription-list">
          {subscriptions.map((subscription) => {
            const members = proxies.filter((proxy) => proxy.subscriptionId === subscription.id);
            const inUse = members.filter((proxy) => inUseIds.has(proxy.id)).length;
            const refreshing = busy === `subscription-refresh:${subscription.id}` || refreshingAll;
            const last = subscription.lastRefresh;
            const disabled = subscription.status === "disabled";
            // A body that partly failed still refreshed what it could; it is a warning, not an error.
            const partial = Boolean(last?.ok && last.failed > 0);
            const tone = last && !last.ok ? "error" : disabled ? "muted" : partial ? "warning" : "ready";
            const health: "ok" | "error" | "warning" | "pending" = last ? (last.ok ? (partial ? "warning" : "ok") : "error") : "pending";
            const lastText = last
              ? t("subscription.lastRefresh", { time: formatRelativeTime(last.checkedAt, locale) })
              : t("subscription.neverRefreshed");
            return (
              <div className={`subscription-row tone-${tone}`} key={subscription.id}>
                <span className="subscription-icon">
                  <Rss size={16} aria-hidden="true" />
                  <span className={`proxy-registry-health is-${health}`} role="img" aria-label={lastText} title={lastText} />
                </span>
                <div className="subscription-body">
                  <div className="subscription-line headline">
                    <strong className="subscription-name" title={subscription.name}>{subscription.name}</strong>
                    <span className={`entity-badge${subscription.autoRefresh && !disabled ? " auto" : ""}`}>
                      {disabled
                        ? t("status.disabled")
                        : subscription.autoRefresh
                          ? t("subscription.auto", { count: subscription.refreshIntervalHours })
                          : t("subscription.manual")}
                    </span>
                  </div>
                  <div className="subscription-line secondary">
                    <small className="mono-cell subscription-host" title={subscription.urlHost}>{subscription.urlHost}</small>
                    {subscription.notes && <small className="subscription-notes" title={subscription.notes}>{subscription.notes}</small>}
                  </div>
                </div>
                {/* The numbers sit between the identity and the controls instead of trailing the name,
                    so the row reads as three bands rather than one crowded left edge. */}
                <div className="subscription-metrics">
                  <button className="subscription-members" onClick={() => showMembers(subscription)} type="button" title={t("subscription.viewMembers")}>
                    <Search size={12} aria-hidden="true" />
                    <strong>{t("subscription.members", { count: members.length })}</strong>
                    {inUse > 0 && <span className="subscription-in-use">{t("subscription.membersInUse", { count: inUse })}</span>}
                  </button>
                  <div className="subscription-metrics-detail">
                    <small title={last ? new Date(last.checkedAt).toLocaleString(locale) : undefined}>{lastText}</small>
                    {last?.ok && (
                      <small className="subscription-outcome">
                        {t("subscription.refreshSummary", { added: last.added, removed: last.removed, kept: last.kept })}
                        {last.detached > 0 && ` · ${t("subscription.refreshDetached", { count: last.detached })}`}
                      </small>
                    )}
                    {partial && (
                      <small className="subscription-warning" title={t("subscription.partialHint")}>
                        {t("subscription.partial", { count: last?.failed ?? 0 })}
                      </small>
                    )}
                    {last?.ok && last.removalSkipped && (
                      <small className="subscription-warning" title={t("subscription.removalSkippedHint")}>
                        {t("subscription.removalSkipped")}
                      </small>
                    )}
                    {last && !last.ok && (
                      <small className="subscription-error" title={last.error}>
                        {t("subscription.refreshFailed", { error: last.error ?? "" })}
                      </small>
                    )}
                  </div>
                </div>
                <div className="subscription-actions">
                  <Switch
                    aria-label={t("subscription.autoRefresh")}
                    checked={subscription.autoRefresh}
                    className="proxy-registry-switch"
                    disabled={disabled || busy === `subscription-update:${subscription.id}`}
                    onCheckedChange={(checked) => void updateSubscription(subscription, { autoRefresh: checked === true })}
                    title={t("subscription.autoRefresh")}
                  />
                  <button
                    aria-label={t("subscription.refresh")}
                    className="icon-button compact"
                    disabled={refreshing || disabled}
                    onClick={() => void refreshSubscription(subscription)}
                    title={t("subscription.refresh")}
                    type="button"
                  >
                    <RefreshCw className={refreshing ? "spin-icon" : undefined} size={15} aria-hidden="true" />
                  </button>
                  <button
                    aria-label={t("actions.edit")}
                    className="icon-button compact"
                    disabled={busy === `subscription-load:${subscription.id}`}
                    onClick={() => void editSubscription(subscription)}
                    title={t("actions.edit")}
                    type="button"
                  >
                    <Pencil size={15} aria-hidden="true" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="proxy-row-menu">
                      <DropdownMenuItem
                        disabled={busy === `subscription-update:${subscription.id}`}
                        onSelect={() => void updateSubscription(subscription, { status: disabled ? "enabled" : "disabled" })}
                      >
                        {t(disabled ? "actions.enable" : "actions.disable")}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="dropdown-menu-item-danger"
                        disabled={busy === `subscription-delete:${subscription.id}`}
                        onSelect={() => requestDelete(subscription, "keep")}
                      >
                        {t("subscription.delete.keep")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        className="dropdown-menu-item-danger"
                        disabled={busy === `subscription-delete:${subscription.id}`}
                        onSelect={() => requestDelete(subscription, "delete")}
                      >
                        {t("subscription.delete.all")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
