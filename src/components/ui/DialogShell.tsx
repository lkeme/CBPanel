import type React from "react";

import type { TranslationKey } from "../../i18n";

export function DialogShell({
  actions,
  bodyClassName,
  children,
  close,
  closeDisabled = false,
  description,
  labelledBy,
  panelClassName = "",
  t,
  title,
  asForm = false,
  onSubmit,
}: {
  actions?: React.ReactNode;
  bodyClassName?: string;
  children: React.ReactNode;
  close: () => void;
  closeDisabled?: boolean;
  description?: React.ReactNode;
  labelledBy: string;
  panelClassName?: string;
  t: (key: TranslationKey) => string;
  title: React.ReactNode;
  asForm?: boolean;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}) {
  const panelClasses = `modal-panel ${panelClassName}`.trim();
  const bodyClasses = bodyClassName ?? "modal-body";
  const panel = (
    <>
      <header className="modal-header">
        <h2 id={labelledBy}>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      <div className={bodyClasses}>{children}</div>
      {actions && <footer className="modal-footer">{actions}</footer>}
    </>
  );

  return (
    <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
      <button className="modal-scrim" aria-label={t("actions.close")} onClick={closeDisabled ? undefined : close} type="button" />
      {asForm ? (
        <form className={panelClasses} onSubmit={onSubmit}>
          {panel}
        </form>
      ) : (
        <section className={panelClasses}>{panel}</section>
      )}
    </div>
  );
}
