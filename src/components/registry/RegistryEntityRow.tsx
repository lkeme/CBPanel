import type { CSSProperties, ReactNode } from "react";
import { FolderKanban, Tag } from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export type RegistryEntityChip = {
  icon?: ReactNode;
  label: string;
  tone?: "running" | "info" | "warning" | "muted";
  title?: string;
};

/**
 * One group or tag as a dense two-line row: the colour tile, the name and its badges on the first
 * line; the numbers, the description and a preview of the environments behind it on the second; a
 * hairline usage bar underneath. Rows are narrow enough for two or three columns on a wide window.
 */
export function RegistryEntityRow({
  actions,
  badges,
  chips,
  color,
  description,
  disabled = false,
  kind,
  locale,
  name,
  onOpen,
  openLabel,
  previewMore,
  previews,
  t,
  updatedAt,
  usage,
}: {
  actions: ReactNode;
  badges?: ReactNode;
  chips: RegistryEntityChip[];
  color?: string;
  description?: string;
  disabled?: boolean;
  kind: "group" | "tag";
  locale: Locale;
  name: string;
  onOpen: () => void;
  openLabel: string;
  previewMore: number;
  previews: string[];
  t: Translate;
  updatedAt?: string;
  usage?: { count: number; total: number };
}) {
  const percent = usage && usage.total > 0 ? Math.round((usage.count / usage.total) * 100) : 0;
  const style = color ? ({ "--entity-color": color } as CSSProperties) : undefined;
  const updatedText = updatedAt ? formatRelativeTime(updatedAt, locale) : undefined;
  const trimmedDescription = description?.trim() ?? "";

  return (
    <div className={`entity-row entity-${kind}${disabled ? " tone-muted" : ""}`} style={style}>
      <button className="entity-row-tile" onClick={onOpen} type="button" aria-label={openLabel} title={openLabel}>
        {kind === "group" ? <FolderKanban size={16} aria-hidden="true" /> : <Tag size={16} aria-hidden="true" />}
      </button>
      <div className="entity-row-body">
        <div className="entity-row-headline">
          <button className="entity-row-name" onClick={onOpen} type="button" title={`${name} · ${openLabel}`}>
            {name}
          </button>
          {badges}
          {updatedText && (
            <small className="entity-row-updated" title={new Date(updatedAt ?? "").toLocaleString(locale)}>
              {updatedText}
            </small>
          )}
        </div>
        <div className="entity-row-detail">
          <span className="entity-row-stats">
            {chips.map((chip) => (
              <span className={`entity-stat${chip.tone ? ` ${chip.tone}` : ""}`} key={chip.label} title={chip.title ?? chip.label}>
                {chip.icon && <span className="entity-stat-icon" aria-hidden="true">{chip.icon}</span>}
                {chip.label}
              </span>
            ))}
          </span>
          {trimmedDescription && (
            <span className="entity-row-description" title={trimmedDescription}>
              {trimmedDescription}
            </span>
          )}
          <span className="entity-row-previews">
            {previews.length === 0 ? (
              <small>{t("registry.noEnvironments")}</small>
            ) : (
              previews.map((preview) => (
                <span className="entity-preview" key={preview} title={preview}>
                  {preview}
                </span>
              ))
            )}
            {previewMore > 0 && <span className="entity-preview more">+{previewMore}</span>}
          </span>
        </div>
        {usage && usage.total > 0 && (
          <div
            aria-label={t("registry.usageShare", { percent })}
            className="entity-usage"
            role="img"
            title={t("registry.usageShare", { percent })}
          >
            <span className="entity-usage-bar" style={{ width: `${Math.max(2, percent)}%` }} />
          </div>
        )}
      </div>
      <div className="entity-row-actions">{actions}</div>
    </div>
  );
}

/** "3 minutes ago" for recent times, a plain date past a month. */
export function formatRelativeTime(value: string, locale: Locale): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value;
  const now = Date.now();
  const diff = now - time;
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (diff < hour) return formatter.format(-Math.max(1, Math.round(diff / minute)), "minute");
  if (diff < day) return formatter.format(-Math.round(diff / hour), "hour");
  if (diff < 30 * day) return formatter.format(-Math.round(diff / day), "day");
  return new Date(time).toLocaleDateString(locale);
}
