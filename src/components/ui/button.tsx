import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex min-h-[var(--control-height)] shrink-0 items-center justify-center gap-2 rounded-[var(--radius-control)] border px-3 text-sm font-semibold outline-none transition-colors duration-150 focus-visible:ring-3 focus-visible:ring-[var(--focus-ring)] disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default:
          "border-[var(--border)] bg-[var(--surface-raised)] text-[var(--foreground)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-strong)]",
        primary:
          "border-[var(--primary)] bg-[var(--primary)] text-[var(--primary-foreground)] hover:border-[var(--primary-hover)] hover:bg-[var(--primary-hover)]",
        success:
          "border-[var(--success)] bg-[var(--success)] text-[var(--success-foreground)] hover:bg-[var(--success-hover)]",
        danger:
          "border-[var(--danger)] bg-[var(--danger)] text-[var(--danger-foreground)] hover:bg-[var(--danger-hover)]",
        subtle:
          "border-[var(--border)] bg-[var(--surface-muted)] text-[var(--foreground)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-strong)]",
        ghost: "border-transparent bg-transparent text-[var(--foreground-muted)] hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)]",
        dangerSubtle:
          "border-[color-mix(in_srgb,var(--danger)_28%,var(--border))] bg-[var(--danger-soft)] text-[var(--danger)] hover:bg-[color-mix(in_srgb,var(--danger)_16%,var(--surface))]",
      },
      size: {
        default: "px-3",
        sm: "min-h-8 px-2.5 text-xs",
        icon: "h-[var(--control-height)] w-[var(--control-height)] px-0",
        iconSm: "h-8 min-h-8 w-8 px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} {...props} />
));

Button.displayName = "Button";

export { buttonVariants };
