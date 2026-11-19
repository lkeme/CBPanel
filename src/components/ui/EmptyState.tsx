import type { ReactNode } from "react";

import { cn } from "../../lib/utils";

/**
 * The one empty state every module renders when it has nothing to list: a soft icon badge, a title,
 * an optional explanation and an optional primary action. It stretches to the space its container
 * leaves, so a nearly empty window centres the panel instead of leaving a stranded block at the top.
 */
export function EmptyState({
  action,
  className,
  description,
  icon,
  title,
}: {
  action?: ReactNode;
  className?: string;
  description?: string;
  icon?: ReactNode;
  title: string;
}) {
  return (
    <div className={cn("empty-panel", className)} role="status">
      {icon && <span className="empty-panel-icon" aria-hidden="true">{icon}</span>}
      <strong className="empty-panel-title">{title}</strong>
      {description && <p className="empty-panel-description">{description}</p>}
      {action && <div className="empty-panel-action">{action}</div>}
    </div>
  );
}
