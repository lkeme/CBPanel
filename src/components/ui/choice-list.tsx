import type React from "react";

import { cn } from "../../lib/utils";

export function closeOnFocusLeave(event: React.FocusEvent<HTMLElement>, onClose: () => void) {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
}

export function ChoiceList({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={cn("choice-list", className)} role="listbox" {...props}>
      {children}
    </div>
  );
}

export function ChoiceOption({
  active = false,
  className,
  keepFocus = false,
  onMouseDown,
  type = "button",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  keepFocus?: boolean;
}) {
  return (
    <button
      {...props}
      aria-selected={props["aria-selected"] ?? active}
      className={cn("choice-option", active && "active", className)}
      onMouseDown={(event) => {
        if (keepFocus) event.preventDefault();
        onMouseDown?.(event);
      }}
      role={props.role ?? "option"}
      type={type}
    />
  );
}

export function ChoiceEmpty({
  className,
  children,
  ...props
}: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span className={cn("choice-empty", className)} {...props}>
      {children}
    </span>
  );
}
