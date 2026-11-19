import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const badgeVariants = cva(
  "inline-flex min-h-6 max-w-full items-center gap-1.5 rounded-full border px-2 text-xs font-semibold leading-none",
  {
    variants: {
      tone: {
        neutral: "border-[var(--border)] bg-[var(--surface-strong)] text-[var(--foreground-muted)]",
        primary: "border-[color-mix(in_srgb,var(--primary)_34%,var(--border))] bg-[var(--primary-soft)] text-[var(--primary-strong)]",
        success: "border-[color-mix(in_srgb,var(--success)_34%,var(--border))] bg-[var(--success-soft)] text-[var(--success)]",
        warning: "border-[color-mix(in_srgb,var(--warning)_36%,var(--border))] bg-[var(--warning-soft)] text-[var(--warning)]",
        danger: "border-[color-mix(in_srgb,var(--danger)_36%,var(--border))] bg-[var(--danger-soft)] text-[var(--danger)]",
        accent: "border-[color-mix(in_srgb,var(--accent)_34%,var(--border))] bg-[var(--accent-soft)] text-[var(--accent)]",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
