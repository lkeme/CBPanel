import {
  CircleAlert,
  CircleX,
  Columns2,
  Download,
  ExternalLink,
  Grid2X2,
  SearchX,
  Settings2,
  Store,
  Star,
} from "lucide-react";
import { marked, Renderer } from "marked";
import { useId, useMemo, useState, type ReactNode } from "react";

import type { Locale } from "../../i18n";
import {
  chromeWebStoreListingUrl,
  type ExtensionArtifactOffer,
  type ExtensionArtifactProviderId,
  type ExtensionCatalogItem,
  type ExtensionCatalogSearchPage,
  type ExtensionReferenceResolution,
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
  onChoose,
  onLoadMore,
  onOpenListing,
  onOpenDetail,
  detailItem,
  onBackDetail,
  detailProviderId,
  detailFooter,
  installedStoreIds,
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
  onChoose: (item: ExtensionCatalogItem) => void;
  onLoadMore: () => void;
  onOpenListing: (item: ExtensionCatalogItem, providerId?: ExtensionArtifactProviderId) => void;
  onOpenDetail?: (item: ExtensionCatalogItem) => void;
  detailItem?: ExtensionCatalogItem;
  onBackDetail?: () => void;
  detailProviderId?: ExtensionArtifactProviderId;
  detailFooter?: ReactNode;
  installedStoreIds?: ReadonlySet<string>;
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
        installed={installedStoreIds?.has(detailItem.storeId) ?? false}
        t={t}
        footer={detailFooter}
      />
    );
  }
  if (status === "loading" && !page) {
    return (
      <div aria-live="polite" className="acquisition-search-loading acquisition-results-state" role="status">
        <span aria-hidden="true" className="acquisition-loading-spinner" />
        <span className="acquisition-visually-hidden">{t("extension.acquisition.results.loading")}</span>
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
              onChoose={onChoose}
              onOpenDetail={onOpenDetail}
              viewMode={viewMode}
              installed={installedStoreIds?.has(item.storeId) ?? false}
              selected={item.storeId === selectedStoreId}
              t={t}
            />
          ))}
        </div>
      )}

      {status === "loading-more" && (
        <div aria-live="polite" className="acquisition-search-loading acquisition-pagination-status" role="status">
          <span aria-hidden="true" className="acquisition-loading-spinner" />
          <span className="acquisition-visually-hidden">{t("extension.acquisition.results.loadingMore")}</span>
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
  onChoose,
  onOpenDetail,
  viewMode,
  installed,
  selected,
  t,
}: {
  item: ExtensionCatalogItem;
  onChoose: (item: ExtensionCatalogItem) => void;
  onOpenDetail?: (item: ExtensionCatalogItem) => void;
  viewMode: "two" | "four";
  installed: boolean;
  selected: boolean;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const titleId = useId();
  const activate = () => (onOpenDetail ? onOpenDetail(item) : onChoose(item));

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
        <div className="acquisition-result-card-top">
          <CatalogIcon item={item} />
          <div className="acquisition-result-heading">
            <span className="acquisition-result-title" id={titleId}>{item.name}</span>
            {selected && <StatusPill tone="running">{t("extension.acquisition.channel.selected")}</StatusPill>}
            {installed && <StatusPill tone="neutral">{t("extension.acquisition.results.installed")}</StatusPill>}
            {viewMode === "two" && <span className="acquisition-result-arrow" aria-hidden="true">›</span>}
          </div>
        </div>
        <div className="acquisition-result-copy">
          {item.category && (
            <div className="acquisition-result-badges">
              <span className="acquisition-result-badge category">{item.category}</span>
            </div>
          )}
          {item.description && <p>{item.description}</p>}
          {(item.rating !== undefined || item.userCount !== undefined) && (
            <div className="acquisition-result-metrics">
              {item.rating !== undefined && <span className="acquisition-result-metric rating"><Star aria-hidden="true" size={13} /> {item.rating.toFixed(1)}</span>}
              {item.userCount !== undefined && <span
                aria-label={`${t("extension.acquisition.results.downloads")}: ${formatAcquisitionCount(item.userCount)}`}
                className="acquisition-result-metric downloads"
                title={t("extension.acquisition.results.downloads")}
              ><Download aria-hidden="true" size={13} /> {formatAcquisitionCount(item.userCount)}</span>}
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

function CatalogIcon({ item, size = "md" }: { item: ExtensionCatalogItem; size?: "sm" | "md" | "lg" | "xl" }) {
  const [iconFailed, setIconFailed] = useState(false);
  const [iconLoaded, setIconLoaded] = useState(false);
  const glyph = extensionGlyph(item);
  return (
    <span className={`acquisition-result-icon acquisition-result-glyph glyph-${glyph.tone} icon-${size}`} aria-hidden="true">
      <span className={iconLoaded && !iconFailed ? "acquisition-result-icon-placeholder hidden" : "acquisition-result-icon-placeholder"}>
        {glyph.label}
      </span>
      {item.iconUrl && !iconFailed && (
        <img
          alt=""
          className={iconLoaded ? "loaded" : ""}
          decoding="async"
          onError={() => setIconFailed(true)}
          onLoad={() => setIconLoaded(true)}
          referrerPolicy="no-referrer"
          src={item.iconUrl}
        />
      )}
    </span>
  );
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
  installed = false,
  t,
}: {
  footer?: ReactNode;
  item: ExtensionCatalogItem;
  locale: Locale;
  onBack: () => void;
  onOpenListing: (item: ExtensionCatalogItem, providerId?: ExtensionArtifactProviderId) => void;
  providerId?: ExtensionArtifactProviderId;
  installed?: boolean;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const headingId = useId();
  const overviewHtml = useMemo(() => {
    if (!item.overview) return "";
    return renderOverviewMarkdown(item.overview);
  }, [item.overview]);

  return (
    <section aria-labelledby={headingId} className="acquisition-result-detail">
      <header className="acquisition-detail-header">
        <button className="command subtle" onClick={onBack} type="button">
          {t("extension.acquisition.results.back")}
        </button>
        <span className="acquisition-detail-breadcrumb">{t("extension.acquisition.results.title")}</span>
      </header>

      {/* Top section: hero with icon, name, developer, description, badges */}
      <div className="acquisition-detail-hero">
        <CatalogIcon item={item} size="xl" />
        <div className="acquisition-detail-hero-copy">
          <div className="acquisition-detail-title-row">
            <h3 id={headingId}>{item.name}</h3>
            {installed && <StatusPill tone="running">{t("extension.acquisition.results.installed")}</StatusPill>}
          </div>
          {item.developer && <p className="acquisition-detail-developer">{item.developer}</p>}
          <p className="acquisition-detail-description">{item.description || t("extension.acquisition.results.noDescription")}</p>
          <div className="acquisition-detail-badges">
            {item.category && <StatusPill tone="neutral">{item.category}</StatusPill>}
            {item.rating !== undefined && (
              <span className="acquisition-detail-metric">
                <Star aria-hidden="true" size={14} /> {item.rating.toFixed(1)}
              </span>
            )}
            {item.userCount !== undefined && (
              <span className="acquisition-detail-metric">
                <Download aria-hidden="true" size={14} /> {formatAcquisitionCount(item.userCount)}
              </span>
            )}
            {item.version && <span className="acquisition-detail-metric">v{item.version}</span>}
            {item.manifestVersion !== undefined && <span className="acquisition-detail-metric">MV{item.manifestVersion}</span>}
          </div>
        </div>
        {providerId && (
          <div className="acquisition-detail-hero-actions">
            <button className="command primary" onClick={() => onOpenListing(item, providerId)} type="button">
              <ExternalLink aria-hidden="true" size={15} />
              {providerId === "crxsoso"
                ? t("extension.acquisition.results.openProvider")
                : t("extension.acquisition.openWebStore")}
            </button>
          </div>
        )}
      </div>

      {/* Footer (channel choice) - rendered as part of the top section */}
      {footer}

      {/* Bottom section: two columns */}
      <div className="acquisition-detail-bottom">
        {/* Left: overview with markdown */}
        <section className="acquisition-detail-overview">
          <h4>{t("extension.acquisition.results.overview")}</h4>
          {item.overview ? (
            <div
              className="acquisition-detail-markdown"
              dangerouslySetInnerHTML={{ __html: overviewHtml }}
            />
          ) : (
            <p className="acquisition-detail-no-overview">{t("extension.acquisition.results.noDescription")}</p>
          )}
        </section>

        {/* Right: other information without boxes */}
        <aside className="acquisition-detail-sidebar">
          <h4>{t("extension.acquisition.results.info")}</h4>
          <dl className="acquisition-detail-facts">
            <div className="acquisition-detail-fact">
              <dt>{t("extension.acquisition.storeId")}</dt>
              <dd className="mono-cell">
                <a
                  className="acquisition-detail-store-link"
                  href={chromeWebStoreListingUrl(item.storeId)}
                  onClick={(event) => {
                    event.preventDefault();
                    onOpenListing(item, "chrome-web-store");
                  }}
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  {item.storeId}
                </a>
              </dd>
            </div>
            {item.updatedAt && (
              <div className="acquisition-detail-fact">
                <dt>{t("extension.acquisition.results.updatedAt")}</dt>
                <dd>{formatDetailDate(item.updatedAt, locale)}</dd>
              </div>
            )}
            {item.size && (
              <div className="acquisition-detail-fact">
                <dt>{t("extension.acquisition.results.size")}</dt>
                <dd>{item.size}</dd>
              </div>
            )}
          </dl>
        </aside>
      </div>
    </section>
  );
}

function formatDetailDate(value: string, locale: Locale): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(timestamp);
}

/**
 * Render catalog overview markdown to HTML. Overview text is third-party
 * (CRX搜搜) content, so the renderer deliberately strips raw HTML and
 * external images: only structural markdown (headings, lists, code, quotes,
 * tables, links) survives, and links always open externally.
 */
const overviewRenderer = new Renderer();
overviewRenderer.html = () => "";
overviewRenderer.image = ({ text }) => escapeHtmlText(text);
overviewRenderer.link = ({ href, title, tokens }) => {
  const text = overviewRenderer.parser.parseInline(tokens);
  const safeHref = /^https:\/\//i.test(href) ? href : "";
  if (!safeHref) return text;
  const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : "";
  return `<a href="${escapeHtmlAttribute(safeHref)}"${titleAttr} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
};

function renderOverviewMarkdown(markdown: string): string {
  return marked.parse(markdown, { async: false, renderer: overviewRenderer }) as string;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function formatAcquisitionCount(value: number): string {
  if (!Number.isFinite(value)) return "-";
  if (value < 1_000) return Math.round(value).toString();
  const units: Array<[number, string]> = [
    [1_000_000_000, "B"],
    [1_000_000, "M"],
    [1_000, "K"],
  ];
  for (const [threshold, suffix] of units) {
    if (value < threshold) continue;
    const amount = value / threshold;
    const digits = amount >= 100 ? 0 : 1;
    return `${amount.toFixed(digits).replace(/\.0$/, "")}${suffix}`;
  }
  return Math.round(value).toString();
}

export type ExtensionArtifactProviderFailure = ExtensionAcquisitionUiError & {
  providerId: ExtensionArtifactProviderId;
};

export function ExtensionArtifactChannelChoice({
  embedded = false,
  installed = false,
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
  installed?: boolean;
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
        </div>
        <div className="acquisition-section-actions">
          <button className="command subtle" disabled={busy} onClick={() => onOpenListing(resolution)} type="button">
            <ExternalLink aria-hidden="true" size={15} />
            {t("extension.acquisition.openWebStore")}
          </button>
          {selectedOffer && !installed && (
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
          {selectedOffer && installed && (
            <StatusPill tone="running">{t("extension.acquisition.results.installed")}</StatusPill>
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

      {!installed && providerFailure && alternateOffer && (
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
