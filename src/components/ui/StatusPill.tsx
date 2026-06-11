import type React from "react";

import { cn } from "../../lib/utils";

export type StatusPillTone =
  | "error"
  | "launching"
  | "neutral"
  | "running"
  | "stopped"
  | "stopping"
  | "warning";

export function StatusPill({
  children,
  className,
  tone = "neutral",
  ...props
}: React.HTMLAttributes<HTMLSpanElement> & {
  tone?: StatusPillTone;
}) {
  return (
    <span className={cn("pill", tone !== "neutral" && tone, className)} {...props}>
      {children}
    </span>
  );
}
