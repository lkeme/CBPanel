import type React from "react";

import { cn } from "../../lib/utils";

export function closeOnFocusLeave(event: React.FocusEvent<HTMLElement>, onClose: () => void) {
  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose();
}

export function isComposingInput(event: React.KeyboardEvent<HTMLElement>) {
  return event.nativeEvent.isComposing || event.key === "Process";
}

export function nextChoiceIndex(currentIndex: number, itemCount: number, direction: 1 | -1) {
  if (itemCount <= 0) return -1;
  if (currentIndex < 0) return direction > 0 ? 0 : itemCount - 1;
  return (currentIndex + direction + itemCount) % itemCount;
}

export function clampChoiceIndex(index: number, itemCount: number) {
  if (itemCount <= 0) return -1;
  if (index < 0) return 0;
  return Math.min(index, itemCount - 1);
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
