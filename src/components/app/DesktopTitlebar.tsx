import { invoke } from "@tauri-apps/api/core";
import { Minus, Square, X } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import { formatAppBrandLabel, type AppVersionInfo } from "../../shared/appVersion";
import { AppMark } from "./AppMark";

export function DesktopTitlebar({
  closeWindow,
  t,
  versions,
}: {
  closeWindow: () => void;
  t: (key: TranslationKey) => string;
  versions?: AppVersionInfo;
}) {
  const brandLabel = formatAppBrandLabel(versions);

  function runWindowCommand(action: "minimize" | "toggleMaximize") {
    const command =
      action === "minimize"
        ? "cbpanel_window_minimize"
        : "cbpanel_window_toggle_maximize";
    try {
      void invoke(command).catch((error) => console.warn("Tauri window command failed", error));
    } catch (error) {
      console.warn("Tauri window command failed", error);
    }
  }

  function stopTitlebarControlEvent(event: React.SyntheticEvent) {
    event.stopPropagation();
  }

  return (
    <header className="desktop-titlebar">
      <div
        className="titlebar-drag-region"
        data-tauri-drag-region
        onDoubleClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          runWindowCommand("toggleMaximize");
        }}
      >
        <AppMark className="titlebar-app-mark app-icon-mark" dragRegion />
        <span data-tauri-drag-region>{brandLabel}</span>
        {versions?.wrapper && <small className="titlebar-versions" data-tauri-drag-region>| {versions.wrapper}</small>}
      </div>
      <div
        className="window-controls"
        onDoubleClick={stopTitlebarControlEvent}
        onMouseDown={stopTitlebarControlEvent}
      >
        <button
          aria-label={t("actions.minimize")}
          title={t("actions.minimize")}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail > 1) return;
            runWindowCommand("minimize");
          }}
          type="button"
        >
          <Minus size={15} aria-hidden="true" />
        </button>
        <button
          aria-label={t("actions.maximize")}
          title={t("actions.maximize")}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail > 1) return;
            runWindowCommand("toggleMaximize");
          }}
          type="button"
        >
          <Square size={13} aria-hidden="true" />
        </button>
        <button
          className="close"
          aria-label={t("actions.close")}
          title={t("actions.close")}
          onClick={(event) => {
            event.stopPropagation();
            if (event.detail > 1) return;
            closeWindow();
          }}
          type="button"
        >
          <X size={15} aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}
