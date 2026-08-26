import { useState, type ReactNode } from "react";
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
export function RegistryListShell<T>({
  action,
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
  renderItem,
  searchPlaceholder,
  summaryText,
  title,
  query: controlledQuery,
  onQueryChange,
}: {
  action: ReactNode;
  body: string;
  emptyBody: string;
  /** Extra class for the never-had-any-items state, e.g. the trash view's solid panel. */
  emptyClassName?: string;
  emptyTitle: string;
  filterEmptyBody: string;
  filterEmptyTitle: string;
  filterResetLabel: string;
  /** Rendered after the list, still inside the scrolling body — the extension sources subsection. */
  footer?: ReactNode;
  haystack: (item: T) => string;
  icon: ReactNode;
  items: T[];
  listClassName: string;
  renderItem: (item: T) => ReactNode;
  searchPlaceholder: string;
  summaryText: (shown: number, total: number, filtered: boolean) => string;
  title: string;
  query?: string;
  onQueryChange?: (query: string) => void;
}) {
  const [localQuery, setLocalQuery] = useState("");
  const query = controlledQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const filtered = Boolean(query.trim());
  const visibleItems = filtered ? items.filter((item) => matchesQuery(haystack(item), query)) : items;

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
      <div className={listClassName}>
        {visibleItems.map(renderItem)}
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
      {footer}
    </RegistryModuleShell>
  );
}
