import { useEffect, useRef, type KeyboardEvent } from "react";

// `:disabled` also matches controls disabled by an ancestor <fieldset>;
// `[disabled]` does not. Source-channel saves disable the whole fieldset, so
// using the attribute selector would let Tab escape through radios that the
// browser itself no longer considers focusable.
const FOCUSABLE_SELECTOR = "a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex='-1'])";

export interface ExtensionAcquisitionDialogFocusTarget {
  focus(): void;
}

export function handleExtensionAcquisitionDialogKey({
  activeElement,
  closeDisabled,
  event,
  focusable,
  onClose,
  panel,
}: {
  activeElement: unknown;
  closeDisabled: boolean;
  event: {
    key: string;
    shiftKey: boolean;
    preventDefault(): void;
    stopPropagation(): void;
  };
  focusable: readonly ExtensionAcquisitionDialogFocusTarget[];
  onClose: () => void;
  panel?: ExtensionAcquisitionDialogFocusTarget | null;
}): void {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (!closeDisabled) onClose();
    return;
  }
  if (event.key !== "Tab") return;
  if (focusable.length === 0) {
    event.preventDefault();
    panel?.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable.at(-1)!;
  if (event.shiftKey && (activeElement === first || activeElement === panel)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

export function restoreExtensionAcquisitionDialogFocus(
  target: (ExtensionAcquisitionDialogFocusTarget & { isConnected: boolean }) | null,
): void {
  if (target?.isConnected) target.focus();
}

export function useExtensionAcquisitionDialogFocus({
  closeDisabled,
  onClose,
}: {
  closeDisabled: boolean;
  onClose: () => void;
}) {
  const layerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => {
      const requested = layerRef.current?.querySelector<HTMLElement>("[data-acquisition-autofocus]");
      (requested ?? panelRef.current)?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      restoreExtensionAcquisitionDialogFocus(returnFocusRef.current);
    };
  }, []);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const focusable = [...(layerRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? [])]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    handleExtensionAcquisitionDialogKey({
      activeElement: document.activeElement,
      closeDisabled,
      event,
      focusable,
      onClose,
      panel: panelRef.current,
    });
  }

  return { handleKeyDown, layerRef, panelRef };
}
