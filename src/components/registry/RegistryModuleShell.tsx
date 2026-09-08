import { useEffect, useState, type ReactNode } from "react";
import { Search } from "lucide-react";

import { ModuleHeader } from "../runtime/ModuleHeader";
import { matchesQuery } from "./registrySearch";

export function RegistryModuleShell({
  body,
  children,
  icon,
  title,
  toolbar,
}: {
  body: string;
  children: ReactNode;
  icon: ReactNode;
  title: string;
  toolbar?: ReactNode;
}) {
  return (
    <section className="module-surface">
      <ModuleHeader icon={icon} title={title} body={body} />
      {toolbar && <div className="registry-toolbar">{toolbar}</div>}
      <div className="module-surface-body">{children}</div>
    </section>
  );
}

export function RegistryModuleEmpty({
  body,
  className = "",
  title,
}: {
  body: string;
  className?: string;
  title: string;
}) {
  return (
    <div className={`module-empty ${className}`.trim()}>
      <strong>{title}</strong>
      <span>{body}</span>
    </div>
  );
}

/**
 * Registry views share one toolbar shape: create action, search box, right-aligned count.
 * Search state lives here so switching views unmounts it and the query resets on its own.
 */
export type RegistryListPagination = {
  pageSize: number;
  prevLabel: string;
  nextLabel: string;
  indicator: (current: number, total: number) => string;
  range: (start: number, end: number, total: number) => string;
};

export function RegistryListShell<T>({
  action,
  beforeList,
  beforeListWhenEmpty = false,
  body,
  emptyBody,
  emptyClassName,
  emptyTitle,
  filterEmptyBody,
  filterEmptyTitle,
  filterResetLabel,
  footer,
  haystack,
  icon,
  items,
  listClassName,
  pagination,
  renderItem,
  searchPlaceholder,
  summaryText,
  title,
  query: controlledQuery,
  onQueryChange,
}: {
  action: ReactNode;
  /** Rendered between the toolbar and the list; sees the items on the current page so a batch bar can select them. */
  beforeList?: (context: { pagedItems: T[]; visibleItems: T[] }) => ReactNode;
  /** Render `beforeList` even when there are no items, e.g. for the sources a list is fed from. */
  beforeListWhenEmpty?: boolean;
  body: string;
  emptyBody: string;
  /** Extra class for the never-had-any-items state, e.g. the trash view's solid panel. */
  emptyClassName?: string;
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
  /** Pages the filtered list; the page resets whenever the query or the item count changes. */
  pagination?: RegistryListPagination;
  renderItem: (item: T) => ReactNode;
  searchPlaceholder: string;
  summaryText: (shown: number, total: number, filtered: boolean) => string;
  title: string;
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
  }, [query, items.length]);

  return (
    <RegistryModuleShell
      icon={icon}
      title={title}
      body={body}
      toolbar={
        // The shell renders this outside the scrolling body, so the create action stays reachable.
        <>
          {action}
          {items.length > 0 && (
            <>
              <label className="search-box registry-search" aria-label={searchPlaceholder}>
                <Search size={16} aria-hidden="true" />
                <input onChange={(event) => setQuery(event.target.value)} placeholder={searchPlaceholder} value={query} />
              </label>
              <small className="registry-filter-summary" aria-live="polite">
                {summaryText(visibleItems.length, items.length, filtered)}
              </small>
            </>
          )}
        </>
      }
    >
      {beforeList && (items.length > 0 || beforeListWhenEmpty) && beforeList({ pagedItems, visibleItems })}
      <div className={listClassName}>
        {pagedItems.map(renderItem)}
        {items.length === 0 && <RegistryModuleEmpty title={emptyTitle} body={emptyBody} className={emptyClassName} />}
        {items.length > 0 && visibleItems.length === 0 && (
          <div className="module-empty registry-filter-empty">
            <strong>{filterEmptyTitle}</strong>
            <span>{filterEmptyBody}</span>
            <button className="command subtle" onClick={() => setQuery("")} type="button">
              {filterResetLabel}
            </button>
          </div>
        )}
      </div>
      {pagination && visibleItems.length > pagination.pageSize && (
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
      )}
      {footer}
    </RegistryModuleShell>
  );
}
