import type { ReactNode } from "react";

export type RegistrySummaryTone = "running" | "error" | "warning" | "info";

export type RegistrySummaryItem = {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  tone?: RegistrySummaryTone;
  title?: string;
};

/**
 * The at-a-glance numbers above a registry list — the same chip language the profile details
 * panel uses, so a registry reads like the rest of the workbench rather than a bare list.
 */
export function RegistrySummaryStrip({ items }: { items: RegistrySummaryItem[] }) {
  return (
    <dl className="summary-strip registry-summary-strip">
      {items.map((item) => (
        <div className={item.tone ? `summary-chip ${item.tone}` : "summary-chip"} key={item.label} title={item.title}>
          <dt>
            {item.icon && <span className="summary-chip-icon" aria-hidden="true">{item.icon}</span>}
            {item.label}
          </dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}
