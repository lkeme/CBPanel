import { useEffect, useState } from "react";

import type { TranslationKey } from "../../i18n";
import { DialogShell } from "./DialogShell";

type ConfirmDialogContext = {
  choice?: string;
};

type ConfirmDialogChoice = {
  value: string;
  label: string;
  description?: string;
};

export type ConfirmDialogState = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  dangerLabel?: string;
  hideCancel?: boolean;
  showCloseButton?: boolean;
  tone?: "danger" | "warning";
  busyKey?: string;
  onConfirm: (context: ConfirmDialogContext) => Promise<void>;
  onDanger?: (context: ConfirmDialogContext) => Promise<void>;
  choice?: {
    defaultValue: string;
    footerNote?: string;
    options: ConfirmDialogChoice[];
  };
} | null;

export function ConfirmDialog({
  busy,
  close,
  state,
  t,
}: {
  busy: string;
  close: () => void;
  state: NonNullable<ConfirmDialogState>;
  t: (key: TranslationKey) => string;
}) {
  const isBusy = Boolean(state.busyKey && busy === state.busyKey);
  const defaultChoice = state.choice?.defaultValue ?? state.choice?.options[0]?.value ?? "";
  const [selectedChoice, setSelectedChoice] = useState(defaultChoice);

  useEffect(() => {
    setSelectedChoice(defaultChoice);
  }, [defaultChoice, state]);

  const context = { choice: selectedChoice || undefined };

  return (
    <DialogShell
      actions={
        <>
          {state.choice?.footerNote && <span className="confirm-footer-note">{state.choice.footerNote}</span>}
          {!state.hideCancel && (
            <button className="command subtle" disabled={isBusy} onClick={close} type="button">
              {state.cancelLabel ?? t("actions.cancel")}
            </button>
          )}
          {state.dangerLabel && state.onDanger && (
            <button className="command danger" disabled={isBusy} onClick={() => void state.onDanger?.(context)} type="button">
              {state.dangerLabel}
            </button>
          )}
          <button className={`command ${state.tone === "danger" ? "danger" : "primary"}`} disabled={isBusy} onClick={() => void state.onConfirm(context)} type="button">
            {state.confirmLabel}
          </button>
        </>
      }
      close={close}
      closeDisabled={isBusy}
      labelledBy="confirm-dialog-title"
      panelClassName={`confirm-panel ${state.choice ? "confirm-choice-panel" : ""}`}
      showCloseButton={state.showCloseButton}
      t={t}
      title={state.title}
    >
      <p>{state.body}</p>
      {state.choice && (
        <fieldset className="confirm-choice-group">
          {state.choice.options.map((option) => (
            <label
              className={`confirm-choice ${selectedChoice === option.value ? "active" : ""}`}
              key={option.value}
            >
              <input
                checked={selectedChoice === option.value}
                disabled={isBusy}
                name="confirm-choice"
                onChange={() => setSelectedChoice(option.value)}
                type="radio"
                value={option.value}
              />
              <span className="confirm-choice-mark" aria-hidden="true" />
              <span className="confirm-choice-text">
                <span>{option.label}</span>
                {option.description && <small>{option.description}</small>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
    </DialogShell>
  );
}
