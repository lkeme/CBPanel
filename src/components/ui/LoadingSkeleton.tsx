import { cn } from "../../lib/utils";

export function LoadingSkeleton({
  className,
  rows = 3,
  variant = "panel",
}: {
  className?: string;
  rows?: number;
  variant?: "panel" | "drawer" | "modal";
}) {
  return (
    <div className={cn("loading-skeleton", `loading-skeleton-${variant}`, className)} aria-busy="true" aria-live="polite">
      <div className="loading-skeleton-head">
        <span className="loading-skeleton-mark" />
        <span className="loading-skeleton-title" />
      </div>
      <div className="loading-skeleton-lines">
        {Array.from({ length: rows }).map((_, index) => (
          <span className="loading-skeleton-line" key={index} />
        ))}
      </div>
    </div>
  );
}
