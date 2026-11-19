import * as React from "react";
import { cn } from "../../lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...props }, ref) => (
  <input
    ref={ref}
    className={cn(
      "h-[var(--control-height)] w-full min-w-0 rounded-[var(--radius-control)] border border-[var(--border)] bg-[var(--surface-muted)] px-3 text-sm text-[var(--foreground)] outline-none transition-colors placeholder:text-[var(--foreground-soft)] focus:border-[var(--primary)] focus:ring-3 focus:ring-[var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-55",
      className,
    )}
    {...props}
  />
));

Input.displayName = "Input";
