import { FilePlus2, MoreHorizontal, RefreshCw, Rss, Search } from "lucide-react";

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
  return (
    <section className="subscription-panel" aria-label={t("subscription.title")}>
      <header className="subscription-panel-head">
        <Rss size={15} aria-hidden="true" />
        <strong>{t("subscription.title")}</strong>
        <small>{t("subscription.count", { count: subscriptions.length })}</small>
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
      {subscriptions.length === 0 ? (
        <p className="subscription-empty">{t("subscription.empty")}</p>
      ) : (
        <div className="subscription-list">
          {subscriptions.map((subscription) => {
            const members = proxies.filter((proxy) => proxy.subscriptionId === subscription.id);
            const inUse = members.filter((proxy) => inUseIds.has(proxy.id)).length;
            const refreshing = busy === `subscription-refresh:${subscription.id}` || refreshingAll;
            const last = subscription.lastRefresh;
            const disabled = subscription.status === "disabled";
            const tone = last && !last.ok ? "error" : disabled ? "muted" : "ready";
            const health: "ok" | "error" | "pending" = last ? (last.ok ? "ok" : "error") : "pending";
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
                    <small className="mono-cell subscription-host" title={subscription.urlHost}>{subscription.urlHost}</small>
                  </div>
                  <div className="subscription-line secondary">
                    <button className="subscription-members" onClick={() => showMembers(subscription)} type="button" title={t("subscription.viewMembers")}>
                      <Search size={11} aria-hidden="true" />
                      {t("subscription.members", { count: members.length })}
                      {inUse > 0 && <span className="subscription-in-use">· {t("subscription.membersInUse", { count: inUse })}</span>}
                    </button>
                    <small title={last ? new Date(last.checkedAt).toLocaleString(locale) : undefined}>{lastText}</small>
                    {last?.ok && (
                      <small className="subscription-outcome">
                        {t("subscription.refreshSummary", { added: last.added, removed: last.removed, kept: last.kept })}
                        {last.detached > 0 && ` · ${t("subscription.refreshDetached", { count: last.detached })}`}
                      </small>
                    )}
                    {last && !last.ok && (
                      <small className="subscription-error" title={last.error}>
                        {t("subscription.refreshFailed", { error: last.error ?? "" })}
                      </small>
                    )}
                    {subscription.notes && <small className="subscription-notes" title={subscription.notes}>{subscription.notes}</small>}
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
                  <button className="command subtle" disabled={refreshing || disabled} onClick={() => void refreshSubscription(subscription)} type="button">
                    <RefreshCw className={refreshing ? "spin-icon" : undefined} size={14} aria-hidden="true" />
                    {t("subscription.refresh")}
                  </button>
                  <button className="command subtle" disabled={busy === `subscription-load:${subscription.id}`} onClick={() => void editSubscription(subscription)} type="button">
                    {t("actions.edit")}
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button className="icon-button compact" aria-label={t("actions.more")} title={t("actions.more")} type="button">
                        <MoreHorizontal size={16} aria-hidden="true" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="proxy-row-menu">
                      <DropdownMenuItem disabled={members.length === 0} onSelect={() => showMembers(subscription)}>
                        {t("subscription.viewMembers")}
                      </DropdownMenuItem>
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
