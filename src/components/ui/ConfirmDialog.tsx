import { useState } from "react";

import type { TranslationKey } from "../../i18n";
import { Checkbox } from "./checkbox";
import { DialogShell } from "./DialogShell";

type ConfirmDialogContext = {
  rememberChoice: boolean;
};

export type ConfirmDialogState = {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  dangerLabel?: string;
  tone?: "danger" | "warning";
  busyKey?: string;
  onConfirm: (context: ConfirmDialogContext) => Promise<void>;
  onDanger?: (context: ConfirmDialogContext) => Promise<void>;
  rememberChoice?: {
    label: string;
    defaultChecked?: boolean;
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
  const [rememberChoice, setRememberChoice] = useState(state.rememberChoice?.defaultChecked ?? false);

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {state.cancelLabel ?? t("actions.cancel")}
          </button>
          {state.dangerLabel && state.onDanger && (
            <button className="command danger" disabled={isBusy} onClick={() => void state.onDanger?.({ rememberChoice })} type="button">
              {state.dangerLabel}
            </button>
          )}
          <button className={`command ${state.tone === "danger" ? "danger" : "primary"}`} disabled={isBusy} onClick={() => void state.onConfirm({ rememberChoice })} type="button">
            {state.confirmLabel}
          </button>
        </>
      }
      close={close}
      closeDisabled={isBusy}
      labelledBy="confirm-dialog-title"
      panelClassName="confirm-panel"
      t={t}
      title={state.title}
    >
      <p>{state.body}</p>
      {state.rememberChoice && (
        <label className="confirm-remember-choice">
          <Checkbox
            checked={rememberChoice}
            disabled={isBusy}
            onCheckedChange={(checked) => setRememberChoice(checked === true)}
          />
          <span>{state.rememberChoice.label}</span>
        </label>
      )}
    </DialogShell>
  );
}
