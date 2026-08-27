import {
  CircleAlert,
  CircleX,
  Columns2,
  Download,
  ExternalLink,
  Grid2X2,
  RefreshCw,
  SearchX,
  Settings2,
  Store,
  Star,
  Users,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";

import type { Locale } from "../../i18n";
import type {
  ExtensionArtifactOffer,
  ExtensionArtifactProviderId,
  ExtensionCatalogItem,
  ExtensionCatalogSearchPage,
  ExtensionReferenceResolution,
} from "../../shared/extensionAcquisition";
import { StatusPill } from "../ui/StatusPill";
import {
  ExtensionAcquisitionErrorText,
  type ExtensionAcquisitionUiError,
  type ExtensionAcquisitionUiTranslator,
} from "./extensionAcquisitionUi";

export function ExtensionAcquisitionStartError({
  error,
  onOpenSources,
  onRetry,
  t,
}: {
  error: ExtensionAcquisitionUiError;
  onOpenSources: () => void;
  onRetry?: () => void;
  t: ExtensionAcquisitionUiTranslator;
}) {
  return (
    <div className="inline-error acquisition-session-start-error" role="alert">
      <div>
        <ExtensionAcquisitionErrorText error={error} t={t} />
      </div>
      <div className="acquisition-session-start-error-actions">
        <button className="command subtle" onClick={onOpenSources} type="button">
          <Settings2 aria-hidden="true" size={16} />
          {t("extension.acquisition.sources.open")}
        </button>
        {onRetry && (
          <button className="command subtle" onClick={onRetry} type="button">
            {t("extension.acquisition.results.retry")}
          </button>
        )}
      </div>
    </div>
  );
}

export type ExtensionDiscoveryStatus =
  | "idle"
  | "loading"
  | "loading-more"
  | "ready"
  | "error"
  | "cancelled";

export function ExtensionCatalogResults({
  discoveryKind,
  error,
  locale,
  onCancel,
  onChoose,
  onLoadMore,
  onOpenListing,
  onOpenDetail,
  detailItem,
  onBackDetail,
  detailProviderId,
  detailFooter,
  onRetry,
  viewMode = "two",
  onViewModeChange,
  page,
  selectedStoreId,
  status,
  t,
}: {
  discoveryKind?: "search" | "resolve";
  error?: ExtensionAcquisitionUiError;
  locale: Locale;
  onCancel: () => void;
  onChoose: (item: ExtensionCatalogItem) => void;
  onLoadMore: () => void;
  onOpenListing: (item: ExtensionCatalogItem, providerId?: ExtensionArtifactProviderId) => void;
  onOpenDetail?: (item: ExtensionCatalogItem) => void;
  detailItem?: ExtensionCatalogItem;
  onBackDetail?: () => void;
  detailProviderId?: ExtensionArtifactProviderId;
  detailFooter?: ReactNode;
  onRetry: () => void;
  viewMode?: "two" | "four";
  onViewModeChange?: (mode: "two" | "four") => void;
  page?: ExtensionCatalogSearchPage;
  selectedStoreId?: string;
  status: ExtensionDiscoveryStatus;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const headingId = useId();
  const failureFallback = discoveryKind === "resolve"
    ? "extension.acquisition.error" as const
    : "extension.acquisition.results.errorTitle" as const;
  if (status === "idle") return null;
  if (detailItem) {
    return (
      <ExtensionCatalogDetail
        item={detailItem}
        locale={locale}
        onBack={onBackDetail ?? (() => undefined)}
        onOpenListing={onOpenListing}
        providerId={detailProviderId}
        t={t}
        footer={detailFooter}
      />
    );
  }
  if (status === "loading" && !page) {
    return (
      <div aria-live="polite" className="preflight-empty acquisition-results-state" role="status">
        <RefreshCw aria-hidden="true" className="spin" size={18} />
        <strong>{t("extension.acquisition.results.loading")}</strong>
        <button className="command subtle" onClick={onCancel} type="button">
          {t("actions.cancelOperation")}
        </button>
      </div>
    );
  }

  if (status === "cancelled" && !page) {
    return (
      <div aria-live="polite" className="module-empty acquisition-results-state" role="status">
        <CircleAlert aria-hidden="true" size={18} />
        <strong>{t("extension.acquisition.results.cancelled")}</strong>
        <button className="command subtle" onClick={onRetry} type="button">
          {t("extension.acquisition.results.retry")}
        </button>
      </div>
    );
  }

  if (status === "error" && !page) {
    return (
      <div className="module-empty acquisition-results-state">
        <div className="inline-error" role="alert">
          <CircleX aria-hidden="true" size={18} />
          <ExtensionAcquisitionErrorText error={error} fallbackKey={failureFallback} t={t} />
        </div>
        <button className="command primary" onClick={onRetry} type="button">
          {t("extension.acquisition.results.retry")}
        </button>
      </div>
    );
  }

  if (!page) return null;

  return (
    <section aria-labelledby={headingId} className="acquisition-results">
      <header className="acquisition-section-header">
        <div>
          <h3 id={headingId} aria-live="polite">
            {t("extension.acquisition.results.summary", { query: page.query })}
          </h3>
        </div>
        {onViewModeChange && (
          <div className="acquisition-view-switch" role="group" aria-label={t("extension.acquisition.results.viewLabel")}>
            <button
              aria-label={t("extension.acquisition.results.viewTwo")}
              aria-pressed={viewMode === "two"}
              className="icon-button compact"
              onClick={() => onViewModeChange("two")}
              type="button"
            >
              <Columns2 aria-hidden="true" size={16} />
            </button>
            <button
              aria-label={t("extension.acquisition.results.viewFour")}
              aria-pressed={viewMode === "four"}
              className="icon-button compact"
              onClick={() => onViewModeChange("four")}
              type="button"
            >
              <Grid2X2 aria-hidden="true" size={16} />
            </button>
          </div>
        )}
      </header>

      {page.excludedNonCanonicalCount > 0 && (
        <div aria-live="polite" className="diagnostic-note" role="status">
          <CircleAlert aria-hidden="true" size={16} />
          <span>
            {t("extension.acquisition.aliasesExcluded", { count: page.excludedNonCanonicalCount })}
          </span>
        </div>
      )}

      {status === "error" && (
        <div className="inline-error acquisition-results-inline-error" role="alert">
          <CircleX aria-hidden="true" size={16} />
          <ExtensionAcquisitionErrorText error={error} fallbackKey={failureFallback} t={t} />
          <button className="command subtle" onClick={onRetry} type="button">
            {t("extension.acquisition.results.retry")}
          </button>
        </div>
      )}

      {status === "cancelled" && (
        <div aria-live="polite" className="diagnostic-note acquisition-pagination-status" role="status">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{t("extension.acquisition.results.cancelled")}</span>
          <button className="command subtle" onClick={onRetry} type="button">
            {t("extension.acquisition.results.retry")}
          </button>
        </div>
      )}

      {page.items.length === 0 ? (
        <div className="module-empty acquisition-results-empty">
          <SearchX aria-hidden="true" size={20} />
          <strong>{t("extension.acquisition.results.emptyTitle")}</strong>
          <span>{t("extension.acquisition.results.emptyBody")}</span>
          <button className="command subtle" onClick={onRetry} type="button">
            {t("extension.acquisition.results.retry")}
          </button>
        </div>
      ) : (
        <div className={`acquisition-result-list view-${viewMode}`} role="list">
          {page.items.map((item) => (
            <CatalogResultCard
              item={item}
              key={item.storeId}
              locale={locale}
              onChoose={onChoose}
              onOpenDetail={onOpenDetail}
              viewMode={viewMode}
              selected={item.storeId === selectedStoreId}
              t={t}
            />
          ))}
        </div>
      )}

      {status === "loading-more" && (
        <div aria-live="polite" className="acquisition-pagination-status" role="status">
          <RefreshCw aria-hidden="true" className="spin" size={15} />
          <span>{t("extension.acquisition.results.loadingMore")}</span>
          <button className="command subtle" onClick={onCancel} type="button">
            {t("actions.cancelOperation")}
          </button>
        </div>
      )}
      {status === "ready" && page.hasMore && (
        <button className="command subtle acquisition-load-more" onClick={onLoadMore} type="button">
          {t("extension.acquisition.loadMore")}
        </button>
      )}
      {status === "ready" && !page.hasMore && page.items.length > 0 && (
        <div aria-live="polite" className="acquisition-results-end" role="status">
          <span aria-hidden="true" />
          <span>{t("extension.acquisition.results.end")}</span>
          <span aria-hidden="true" />
        </div>
      )}
    </section>
  );
}

function CatalogResultCard({
  item,
  locale,
  onChoose,
  onOpenDetail,
  viewMode,
  selected,
  t,
}: {
  item: ExtensionCatalogItem;
  locale: Locale;
  onChoose: (item: ExtensionCatalogItem) => void;
  onOpenDetail?: (item: ExtensionCatalogItem) => void;
  viewMode: "two" | "four";
  selected: boolean;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const titleId = useId();
  const [iconFailed, setIconFailed] = useState(false);
  const details = [item.category, t("extension.acquisition.results.crxsosoProvider")].filter(Boolean);
  const activate = () => (onOpenDetail ? onOpenDetail(item) : onChoose(item));
  const glyph = extensionGlyph(item);

  return (
    <article
      aria-labelledby={titleId}
      className={`acquisition-result-card ${selected ? "selected" : ""}`.trim()}
      role="listitem"
    >
      <button
        aria-labelledby={titleId}
        className="acquisition-result-card-surface"
        onClick={activate}
        type="button"
      >
        <span className={`acquisition-result-icon acquisition-result-glyph glyph-${glyph.tone}`} aria-hidden="true">
          {item.iconUrl && !iconFailed ? (
            <img alt="" loading="lazy" onError={() => setIconFailed(true)} referrerPolicy="no-referrer" src={item.iconUrl} />
          ) : <span>{glyph.label}</span>}
        </span>
        <div className="acquisition-result-copy">
          <div className="acquisition-result-heading">
            <span className="acquisition-result-title" id={titleId}>{item.name}</span>
            {selected && <StatusPill tone="running">{t("extension.acquisition.channel.selected")}</StatusPill>}
            {viewMode === "two" && <span className="acquisition-result-arrow" aria-hidden="true">›</span>}
          </div>
          {details.length > 0 && (
            <div className="acquisition-result-badges">
              {item.category && <span className="acquisition-result-badge category">{item.category}</span>}
              <span className="acquisition-result-badge provider">{t("extension.acquisition.results.crxsosoProvider")}</span>
            </div>
          )}
          {item.description && <p>{item.description}</p>}
          {(item.rating !== undefined || item.userCount !== undefined) && (
            <div className="acquisition-result-metrics">
              {item.rating !== undefined && <span className="acquisition-result-metric rating"><Star aria-hidden="true" size={13} /> {item.rating.toFixed(1)}</span>}
              {item.userCount !== undefined && <span className="acquisition-result-metric users"><Users aria-hidden="true" size={13} /> {formatUserCount(item.userCount, locale)}</span>}
            </div>
          )}
        </div>
      </button>
    </article>
  );
}

function extensionGlyph(item: ExtensionCatalogItem): { label: string; tone: number } {
  const words = item.name.trim().split(/\s+/).filter(Boolean);
  const label = (words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : item.name.slice(0, 2))
    .toUpperCase() || "EX";
  let hash = 0;
  for (const char of item.storeId) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return { label, tone: Math.abs(hash) % 6 };
}

/**
 * Catalog details deliberately stay in the acquisition workspace instead of
 * opening a second browser tab. This preserves the search page/cursor and
 * gives the user one predictable back path after a mistaken click.
 */
export function ExtensionCatalogDetail({
  footer,
  item,
  locale,
  onBack,
  onOpenListing,
  providerId,
  t,
}: {
  footer?: ReactNode;
  item: ExtensionCatalogItem;
  locale: Locale;
  onBack: () => void;
  onOpenListing: (item: ExtensionCatalogItem, providerId?: ExtensionArtifactProviderId) => void;
  providerId?: ExtensionArtifactProviderId;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const headingId = useId();
  const [iconFailed, setIconFailed] = useState(false);
  const glyph = extensionGlyph(item);
  return (
    <section aria-labelledby={headingId} className="acquisition-result-detail">
      <header className="acquisition-detail-header">
        <button className="command subtle" onClick={onBack} type="button">
          {t("extension.acquisition.results.back")}
        </button>
        <span className="acquisition-detail-breadcrumb">{t("extension.acquisition.results.title")}</span>
      </header>
      <div className="acquisition-detail-hero">
        <span className={`acquisition-result-icon acquisition-result-glyph glyph-${glyph.tone}`} aria-hidden="true">
          {item.iconUrl && !iconFailed ? (
            <img alt="" loading="lazy" onError={() => setIconFailed(true)} referrerPolicy="no-referrer" src={item.iconUrl} />
          ) : <span>{glyph.label}</span>}
        </span>
        <div>
          <h3 id={headingId}>{item.name}</h3>
          <p>{item.description || t("extension.acquisition.results.noDescription")}</p>
          <div className="acquisition-detail-badges">
            <StatusPill tone="warning">{t("extension.acquisition.results.crxsosoProvider")}</StatusPill>
            {item.category && <StatusPill tone="neutral">{item.category}</StatusPill>}
          </div>
        </div>
      </div>
      {footer}
      <dl className="acquisition-detail-facts">
        <div><dt>{t("extension.acquisition.storeId")}</dt><dd className="mono-cell">{item.storeId}</dd></div>
        {item.rating !== undefined && <div><dt>{t("extension.acquisition.results.rating")}</dt><dd><Star aria-hidden="true" size={14} /> {item.rating.toFixed(1)}</dd></div>}
        {item.userCount !== undefined && <div><dt>{t("extension.acquisition.results.users")}</dt><dd><Users aria-hidden="true" size={14} /> {formatUserCount(item.userCount, locale)}</dd></div>}
        <div><dt>{t("extension.acquisition.results.provider")}</dt><dd>{t("extension.acquisition.results.crxsosoProvider")}</dd></div>
      </dl>
      {!footer && providerId && (
        <div className="acquisition-detail-actions">
          <button className="command subtle" onClick={() => onOpenListing(item, providerId)} type="button">
            <ExternalLink aria-hidden="true" size={15} />
            {providerId === "crxsoso"
              ? t("extension.acquisition.results.openProvider")
              : t("extension.acquisition.openWebStore")}
          </button>
        </div>
      )}
    </section>
  );
}

function formatUserCount(value: number, locale: Locale): string {
  if (!Number.isFinite(value)) return "-";
  return new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

export type ExtensionArtifactProviderFailure = ExtensionAcquisitionUiError & {
  providerId: ExtensionArtifactProviderId;
};

export function ExtensionArtifactChannelChoice({
  embedded = false,
  onCancel,
  onOpenListing,
  onSelect,
  onStart,
  providerFailure,
  resolution,
  selectedProviderId,
  startingProviderId,
  t,
}: {
  embedded?: boolean;
  onCancel?: () => void | Promise<void>;
  onOpenListing: (resolution: ExtensionReferenceResolution) => void;
  onSelect: (providerId: ExtensionArtifactProviderId) => void;
  onStart: (offer: ExtensionArtifactOffer) => void | Promise<void>;
  providerFailure?: ExtensionArtifactProviderFailure;
  resolution: ExtensionReferenceResolution;
  selectedProviderId?: ExtensionArtifactProviderId;
  startingProviderId?: ExtensionArtifactProviderId;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const headingId = useId();
  const selectedOffer = resolution.offers.find((offer) => offer.artifactProviderId === selectedProviderId);
  // The server normally returns only the persisted channel. After a failure,
  // construct the opposite offer solely for an explicit user-requested retry;
  // `startOffer` persists the switch and the server validates it again. Never
  // use the failed offer itself as the alternate (that would retry the same
  // channel while labelling it as a fallback).
  const alternateProviderId = providerFailure?.providerId === "chrome-web-store" ? "crxsoso"
    : providerFailure?.providerId === "crxsoso" ? "chrome-web-store"
      : undefined;
  const alternateOffer = alternateProviderId && resolution.offers.length > 0
    ? resolution.offers.find((offer) => offer.artifactProviderId === alternateProviderId) ?? {
      namespace: "chrome-web-store" as const,
      storeId: resolution.storeId,
      artifactProviderId: alternateProviderId,
      format: "crx3" as const,
      providerLabel: alternateProviderId === "crxsoso"
        ? t("extension.acquisition.source.crxsosoArtifactName")
        : t("extension.acquisition.source.googleArtifactName"),
    }
    : undefined;
  const busy = Boolean(startingProviderId);

  return (
    <section aria-labelledby={headingId} className="acquisition-channel-choice">
      <header className="acquisition-section-header">
        <div>
          <h3 id={headingId}>{t("extension.acquisition.channel.title")}</h3>
          <p>{t("extension.acquisition.channel.description")}</p>
        </div>
        <div className="acquisition-section-actions">
          <button className="command subtle" disabled={busy} onClick={() => onOpenListing(resolution)} type="button">
            <ExternalLink aria-hidden="true" size={15} />
            {t("extension.acquisition.openWebStore")}
          </button>
          {selectedOffer && (
            <button
              className="command primary acquisition-channel-start"
              disabled={busy}
              onClick={() => void onStart(selectedOffer)}
              type="button"
            >
              {startingProviderId === selectedOffer.artifactProviderId
                ? t("extension.acquisition.loading")
                : t("extension.acquisition.channel.start", { provider: selectedOffer.providerLabel })}
            </button>
          )}
          {busy && onCancel && (
            <button className="command subtle" onClick={() => void onCancel()} type="button">
              {t("actions.cancelOperation")}
            </button>
          )}
        </div>
      </header>

      {!embedded && (
        <dl className="acquisition-identity-summary">
          <div>
            <dt>{t("extension.acquisition.storeId")}</dt>
            <dd className="mono-cell">{resolution.storeId}</dd>
          </div>
        </dl>
      )}

      {providerFailure && (
        <div className="inline-error acquisition-provider-error" role="alert">
          <CircleX aria-hidden="true" size={16} />
          <ExtensionAcquisitionErrorText error={providerFailure} t={t} />
        </div>
      )}

      {resolution.offers.length === 0 ? (
        <div className="module-empty acquisition-channel-empty">
          <Store aria-hidden="true" size={20} />
          <strong>{t("extension.acquisition.channel.noneTitle")}</strong>
          <span>{t("extension.acquisition.channel.noneBody")}</span>
        </div>
      ) : resolution.offers.length === 1 ? (
        <div className="acquisition-selected-channel" role="status">
          <span className="acquisition-channel-icon" aria-hidden="true"><Download size={18} /></span>
          <span className="acquisition-channel-copy">
            <strong>{resolution.offers[0]?.providerLabel}</strong>
            <small>{resolution.offers[0]?.artifactProviderId === "chrome-web-store"
              ? t("extension.acquisition.channel.googleDescription")
              : t("extension.acquisition.channel.mirrorDescription")}</small>
          </span>
          <StatusPill tone="running">{t("extension.acquisition.channel.selected")}</StatusPill>
        </div>
      ) : (
        <fieldset className="acquisition-channel-list" disabled={busy}>
          <legend>{t("extension.acquisition.channel.title")}</legend>
          {resolution.offers.map((offer) => {
            const selected = offer.artifactProviderId === selectedProviderId;
            const google = offer.artifactProviderId === "chrome-web-store";
            return (
              <label className={`acquisition-channel-card ${selected ? "selected" : ""}`} key={offer.artifactProviderId}>
                <input
                  checked={selected}
                  name={`extension-channel-${resolution.storeId}`}
                  onChange={() => onSelect(offer.artifactProviderId)}
                  type="radio"
                  value={offer.artifactProviderId}
                />
                <span className="acquisition-channel-icon" aria-hidden="true">
                  <Download size={18} />
                </span>
                <span className="acquisition-channel-copy">
                  <strong>{offer.providerLabel}</strong>
                  <small>
                    {google
                      ? t("extension.acquisition.channel.googleDescription")
                      : t("extension.acquisition.channel.mirrorDescription")}
                  </small>
                </span>
                {selected && <StatusPill tone="running">{t("extension.acquisition.channel.selected")}</StatusPill>}
              </label>
            );
          })}
        </fieldset>
      )}

      {providerFailure && alternateOffer && (
        <div className="diagnostic-note warning acquisition-mirror-fallback">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{alternateOffer.artifactProviderId === "crxsoso"
            ? t("extension.acquisition.channel.mirrorDescription")
            : t("extension.acquisition.channel.googleDescription")}</span>
          <button
            className="command subtle"
            disabled={busy}
            onClick={() => void onStart(alternateOffer)}
            type="button"
          >
            {alternateOffer.artifactProviderId === "crxsoso"
              ? t("extension.acquisition.channel.tryMirror")
              : t("extension.acquisition.channel.tryGoogle")}
          </button>
        </div>
      )}

    </section>
  );
}
