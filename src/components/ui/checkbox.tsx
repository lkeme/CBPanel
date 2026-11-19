import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check } from "lucide-react";
import { cn } from "../../lib/utils";

export const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "grid h-4.5 w-4.5 shrink-0 place-items-center rounded-[5px] border border-[var(--border-strong)] bg-[var(--surface)] text-[var(--primary-foreground)] outline-none transition-colors focus-visible:ring-3 focus-visible:ring-[var(--focus-ring)] data-[state=checked]:border-[var(--primary)] data-[state=checked]:bg-[var(--primary)]",
      className,
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator>
      <Check size={13} strokeWidth={3} aria-hidden="true" />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
));

Checkbox.displayName = "Checkbox";
