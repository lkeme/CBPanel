import { useEffect, useState, type ReactNode } from "react";
import { Search, SearchX } from "lucide-react";

import { EmptyState } from "../ui/EmptyState";
import { ModuleHeader } from "../runtime/ModuleHeader";
import { matchesQuery } from "./registrySearch";

/**
 * One page surface for every workbench view: an optional toolbar band above a single card,
 * mirroring the environment table. Sidebar pages already own their heading in the page header, so
 * they pass no `title`; only a sub-view that names itself (the extension acquisition workspace)
 * renders the inner heading.
 */
export function RegistryModuleShell({
  body,
  bodyClassName,
  children,
  flush = false,
  icon,
  title,
  toolbar,
}: {
  body?: string;
  /** Modifier for the scrolling body slot, e.g. `is-empty` so an empty panel fills it. */
  bodyClassName?: string;
  children: ReactNode;
  /** Drops the card chrome so the inner surface (the proxy table card) is the only card. */
  flush?: boolean;
  icon?: ReactNode;
  title?: string;
  toolbar?: ReactNode;
}) {
  return (
    <div className="module-frame">
      {toolbar && <div className="registry-toolbar">{toolbar}</div>}
      <section className={flush ? "module-surface is-flush" : "module-surface"}>
        {title && <ModuleHeader body={body ?? ""} icon={icon} title={title} />}
        <div className={bodyClassName ? `module-surface-body ${bodyClassName}` : "module-surface-body"}>{children}</div>
      </section>
    </div>
  );
}

export function RegistryModuleEmpty({
  action,
  body,
  icon,
  title,
}: {
  action?: ReactNode;
  body?: string;
  icon?: ReactNode;
  title: string;
}) {
  return <EmptyState action={action} description={body} icon={icon} title={title} />;
}

/**
 * Registry views share one toolbar shape: create action, search box, right-aligned count.
 * Search state lives here so switching views unmounts it and the query resets on its own.
 */
export type RegistryListPagination = {
  pageSize: number;
  /** Sizes offered by the per-page control; omit to keep the page size fixed. */
  pageSizeOptions?: readonly number[];
  pageSizeLabel?: string;
  onPageSizeChange?: (pageSize: number) => void;
  prevLabel: string;
  nextLabel: string;
  indicator: (current: number, total: number) => string;
  range: (start: number, end: number, total: number) => string;
};

export type RegistryListToolbarContext<T> = {
  filtered: boolean;
  items: T[];
  pagedItems: T[];
  query: string;
  setQuery: (query: string) => void;
  visibleItems: T[];
};

export function RegistryListShell<T>({
  action,
  beforeList,
  beforeListWhenEmpty = false,
  emptyBody,
  emptyTitle,
  filterEmptyBody,
  filterEmptyTitle,
  filterResetLabel,
  footer,
  haystack,
  icon,
  items,
  listClassName,
  listRole,
  listHeader,
  /** Renders the search and summary row inside the list card instead of the module toolbar. */
  listToolbar,
  pagination,
  renderItem,
  searchPlaceholder,
  summaryText,
  query: controlledQuery,
  onQueryChange,
}: {
  action: ReactNode;
  /** Rendered between the toolbar and the list; sees the items on the current page so a batch bar can select them. */
  beforeList?: (context: { pagedItems: T[]; visibleItems: T[] }) => ReactNode;
  /** Render `beforeList` even when there are no items, e.g. for the sources a list is fed from. */
  beforeListWhenEmpty?: boolean;
  emptyBody: string;
  /** Headline for the never-had-any-items state; the module's own title is a poor empty-state title. */
  emptyTitle: string;
  filterEmptyBody: string;
  filterEmptyTitle: string;
  filterResetLabel: string;
  /** Rendered after the list, still inside the scrolling body. */
  footer?: ReactNode;
  haystack: (item: T) => string;
  icon: ReactNode;
  items: T[];
  listClassName: string;
  /** The ARIA role of the list container, when the rows are a real table rather than a stack of cards. */
  listRole?: "table";
  /** Rendered as the first child of the list container, e.g. a table header that needs the current page. */
  listHeader?: (context: { pagedItems: T[]; visibleItems: T[] }) => ReactNode;
  /**
   * Renders the search, summary and batch row inside a card that also holds the list and its
   * pagination, so the table reads as one surface. The module toolbar then holds `action` alone.
   */
  listToolbar?: (context: RegistryListToolbarContext<T>) => ReactNode;
  /** Pages the filtered list; the page resets whenever the query, page size or item count changes. */
  pagination?: RegistryListPagination;
  renderItem: (item: T) => ReactNode;
  searchPlaceholder: string;
  summaryText: (shown: number, total: number, filtered: boolean) => string;
  query?: string;
  onQueryChange?: (query: string) => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const [page, setPage] = useState(1);
  const query = controlledQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const filtered = Boolean(query.trim());
  const visibleItems = filtered ? items.filter((item) => matchesQuery(haystack(item), query)) : items;
  const pageSize = pagination?.pageSize ?? 0;
  const totalPages = pageSize > 0 ? Math.max(1, Math.ceil(visibleItems.length / pageSize)) : 1;
  const currentPage = Math.min(page, totalPages);
  const pagedItems = pageSize > 0 ? visibleItems.slice((currentPage - 1) * pageSize, currentPage * pageSize) : visibleItems;

  useEffect(() => {
    setPage(1);
  }, [query, items.length, pageSize]);

  const hasItems = items.length > 0;
  const hasVisibleItems = visibleItems.length > 0;
  // A list fed by a pinned panel (the proxy subscriptions) keeps that panel at the top of the body
  // and centres only the empty state below it; otherwise the empty state owns the whole height.
  const pinnedBeforeList = Boolean(beforeList) && beforeListWhenEmpty;
  // `is-empty` centres every child; a pinned panel must stay full width at the top instead, so the
  // empty state moves into its own slot that takes the remaining height.
  const usesEmptySlot = pinnedBeforeList && !hasVisibleItems;
  // One empty state, two placements: inside the slot that takes the height left below a pinned
  // panel, or filling the whole body when nothing else is rendered above it.
  const renderEmpty = (empty: { action?: ReactNode; body?: string; icon?: ReactNode; title: string }) =>
    usesEmptySlot ? (
      <div className="registry-empty-slot">
        <RegistryModuleEmpty {...empty} />
      </div>
    ) : (
      <RegistryModuleEmpty {...empty} />
    );
  const emptyState = {
    action:
      filtered && hasItems ? (
        <button className="command subtle" onClick={() => setQuery("")} type="button">
          {filterResetLabel}
        </button>
      ) : undefined,
    body: filtered && hasItems ? filterEmptyBody : emptyBody,
    icon: filtered && hasItems ? <SearchX size={26} aria-hidden="true" /> : icon,
    title: filtered && hasItems ? filterEmptyTitle : emptyTitle,
  };
  const list =
    hasVisibleItems ? (
      <div className={listClassName} role={listRole}>
        {listHeader?.({ pagedItems, visibleItems })}
        {pagedItems.map(renderItem)}
      </div>
    ) : (
      renderEmpty(emptyState)
    );
  const paginationFooter =
    pagination && visibleItems.length > 0 ? (
      <footer className="registry-pagination">
        <div className="pagination-summary">
          <span>
            {pagination.range(
              (currentPage - 1) * pagination.pageSize + 1,
              Math.min(currentPage * pagination.pageSize, visibleItems.length),
              visibleItems.length,
            )}
          </span>
        </div>
        <div className="pagination-controls">
          {pagination.pageSizeOptions && pagination.onPageSizeChange && (
            <div className="pagination-size">
              <span>{pagination.pageSizeLabel}</span>
              <div className="pagination-size-options" role="group" aria-label={pagination.pageSizeLabel}>
                {pagination.pageSizeOptions.map((option) => (
                  <button
                    aria-pressed={option === pagination.pageSize}
                    className={option === pagination.pageSize ? "active" : ""}
                    key={option}
                    onClick={() => pagination.onPageSizeChange?.(option)}
                    type="button"
                  >
                    {option}
                  </button>
                ))}
              </div>
            </div>
          )}
          <button className="command subtle" disabled={currentPage <= 1} onClick={() => setPage(Math.max(1, currentPage - 1))} type="button">
            {pagination.prevLabel}
          </button>
          <span className="page-indicator">{pagination.indicator(currentPage, totalPages)}</span>
          <button
            className="command subtle"
            disabled={currentPage >= totalPages}
            onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
            type="button"
          >
            {pagination.nextLabel}
          </button>
        </div>
      </footer>
    ) : null;

  return (
    <RegistryModuleShell
      // A list that owns its toolbar puts search, rows and paging in one card; the shell then
      // renders no second card around it.
      flush={Boolean(listToolbar)}
      // A populated list keeps its own card layout; with nothing to show the body hands its whole
      // height to the empty panel, so the state centres in the window instead of hugging the header.
      bodyClassName={usesEmptySlot ? "empty-with-pinned" : hasVisibleItems || pinnedBeforeList ? undefined : "is-empty"}
      toolbar={
        // The shell renders this outside the scrolling body, so the create action stays reachable.
        hasItems && !listToolbar ? (
          <>
            {action}
            <label className="search-box registry-search" aria-label={searchPlaceholder}>
              <Search size={16} aria-hidden="true" />
              <input onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} value={query} />
            </label>
            <small className="registry-filter-summary" aria-live="polite">
              {summaryText(visibleItems.length, items.length, filtered)}
            </small>
          </>
        ) : (
          action
        )
      }
    >
      {beforeList && (hasItems || beforeListWhenEmpty) && beforeList({ pagedItems, visibleItems })}
      {listToolbar ? (
        <div className="registry-list-surface">
          {listToolbar({ filtered, items, pagedItems, query, setQuery, visibleItems })}
          {list}
          {paginationFooter}
        </div>
      ) : (
        <>
          {list}
          {paginationFooter}
        </>
      )}
      {footer}
    </RegistryModuleShell>
  );
}
