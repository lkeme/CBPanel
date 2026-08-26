import {
  CircleAlert,
  CircleX,
  Download,
  ExternalLink,
  PackageSearch,
  RefreshCw,
  SearchX,
  Store,
} from "lucide-react";
import { useId } from "react";

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
  formatAcquisitionDateTime,
  type ExtensionAcquisitionUiTranslator,
} from "./extensionAcquisitionUi";

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
  onRetry,
  page,
  selectedStoreId,
  status,
  t,
}: {
  discoveryKind?: "search" | "resolve";
  error?: string;
  locale: Locale;
  onCancel: () => void;
  onChoose: (item: ExtensionCatalogItem) => void;
  onLoadMore: () => void;
  onOpenListing: (item: ExtensionCatalogItem) => void;
  onRetry: () => void;
  page?: ExtensionCatalogSearchPage;
  selectedStoreId?: string;
  status: ExtensionDiscoveryStatus;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const headingId = useId();
  const failureMessage = discoveryKind === "resolve"
    ? error
      ? `${t("extension.acquisition.error")}: ${error}`
      : t("extension.acquisition.error")
    : error || t("extension.acquisition.results.error", { message: "" });
  if (status === "idle") return null;

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
          <span>{failureMessage}</span>
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
          <h3 id={headingId}>{t("extension.acquisition.results.title")}</h3>
          <p aria-live="polite">
            {t("extension.acquisition.results.summary", { count: page.items.length, query: page.query })}
          </p>
        </div>
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
          <span>{failureMessage}</span>
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
        <div className="acquisition-result-list" role="list">
          {page.items.map((item) => (
            <CatalogResultCard
              item={item}
              key={item.storeId}
              locale={locale}
              onChoose={onChoose}
              onOpenListing={onOpenListing}
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
    </section>
  );
}

function CatalogResultCard({
  item,
  locale,
  onChoose,
  onOpenListing,
  selected,
  t,
}: {
  item: ExtensionCatalogItem;
  locale: Locale;
  onChoose: (item: ExtensionCatalogItem) => void;
  onOpenListing: (item: ExtensionCatalogItem) => void;
  selected: boolean;
  t: ExtensionAcquisitionUiTranslator;
}) {
  const titleId = useId();
  const details = [
    item.category,
  ].filter(Boolean);

  return (
    <article
      aria-labelledby={titleId}
      className={`acquisition-result-card ${selected ? "selected" : ""}`.trim()}
      role="listitem"
    >
      <span className="acquisition-result-icon" aria-hidden="true">
        <PackageSearch size={22} />
      </span>
      <div className="acquisition-result-copy">
        <div className="acquisition-result-heading">
          <h4 id={titleId}>{item.name}</h4>
          {selected && <StatusPill tone="running">{t("extension.acquisition.channel.selected")}</StatusPill>}
        </div>
        {item.description && <p>{item.description}</p>}
        <span className="mono-cell">{item.storeId}</span>
        {details.length > 0 && <small>{details.join(" · ")}</small>}
        <small>
          {t("extension.acquisition.catalogAttribution", {
            provider: item.catalogProviderId,
            time: formatAcquisitionDateTime(item.observedAt, locale),
          })}
        </small>
      </div>
      <div className="acquisition-result-actions">
        <button className="command subtle" onClick={() => onOpenListing(item)} type="button">
          <ExternalLink aria-hidden="true" size={15} />
          {t("extension.acquisition.openWebStore")}
        </button>
        <button className="command primary" onClick={() => onChoose(item)} type="button">
          {t("extension.acquisition.results.choose")}
        </button>
      </div>
    </article>
  );
}

export type ExtensionArtifactProviderFailure = {
  message: string;
  providerId: ExtensionArtifactProviderId;
};

export function ExtensionArtifactChannelChoice({
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
  const mirrorOffer = resolution.offers.find((offer) => offer.artifactProviderId === "crxsoso");
  const googleFailed = providerFailure?.providerId === "chrome-web-store";
  const busy = Boolean(startingProviderId);

  return (
    <section aria-labelledby={headingId} className="acquisition-channel-choice">
      <header className="acquisition-section-header">
        <div>
          <h3 id={headingId}>{t("extension.acquisition.channel.title")}</h3>
          <p>{t("extension.acquisition.channel.description")}</p>
        </div>
        <button className="command subtle" disabled={busy} onClick={() => onOpenListing(resolution)} type="button">
          <ExternalLink aria-hidden="true" size={15} />
          {t("extension.acquisition.openWebStore")}
        </button>
      </header>

      <dl className="acquisition-identity-summary">
        <div>
          <dt>{t("extension.acquisition.storeId")}</dt>
          <dd className="mono-cell">{resolution.storeId}</dd>
        </div>
      </dl>

      {providerFailure && (
        <div className="inline-error acquisition-provider-error" role="alert">
          <CircleX aria-hidden="true" size={16} />
          <span>{t("extension.acquisition.channel.providerError", { message: providerFailure.message })}</span>
        </div>
      )}

      {resolution.offers.length === 0 ? (
        <div className="module-empty acquisition-channel-empty">
          <Store aria-hidden="true" size={20} />
          <strong>{t("extension.acquisition.channel.noneTitle")}</strong>
          <span>{t("extension.acquisition.channel.noneBody")}</span>
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

      {googleFailed && mirrorOffer && (
        <div className="diagnostic-note warning acquisition-mirror-fallback">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{t("extension.acquisition.channel.mirrorDescription")}</span>
          <button
            className="command subtle"
            disabled={busy}
            onClick={() => void onStart(mirrorOffer)}
            type="button"
          >
            {t("extension.acquisition.channel.tryMirror")}
          </button>
        </div>
      )}

      {selectedOffer && (
        <div className="acquisition-confirmation-actions">
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
          {busy && onCancel && (
            <button className="command subtle" onClick={() => void onCancel()} type="button">
              {t("actions.cancelOperation")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
