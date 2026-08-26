import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { X } from "lucide-react";

import type { Locale } from "../../i18n";

export type ExtensionAcquisitionUiKey =
  | "actions.bind"
  | "actions.cancel"
  | "actions.cancelOperation"
  | "actions.close"
  | "actions.install"
  | "actions.open"
  | "actions.refresh"
  | "actions.update"
  | "extension.state.downloading"
  | "extension.state.installFailed"
  | "extension.state.installed"
  | "extension.state.invalidManifest"
  | "extension.state.localMissing"
  | "extension.state.notInstalled"
  | "extension.state.updateAvailable"
  | "extension.acquisition.aliasesExcluded"
  | "extension.acquisition.bindNext"
  | "extension.acquisition.cancelled"
  | "extension.acquisition.catalogAttribution"
  | "extension.acquisition.channel.description"
  | "extension.acquisition.channel.googleDescription"
  | "extension.acquisition.channel.mirrorDescription"
  | "extension.acquisition.channel.noneBody"
  | "extension.acquisition.channel.noneTitle"
  | "extension.acquisition.channel.providerError"
  | "extension.acquisition.channel.selected"
  | "extension.acquisition.channel.start"
  | "extension.acquisition.channel.title"
  | "extension.acquisition.channel.tryMirror"
  | "extension.acquisition.confirm.create"
  | "extension.acquisition.confirm.description"
  | "extension.acquisition.confirm.permissionApproval"
  | "extension.acquisition.confirm.reuse"
  | "extension.acquisition.confirm.title"
  | "extension.acquisition.confirm.upgrade"
  | "extension.acquisition.conflict.blocked"
  | "extension.acquisition.conflict.blocking.ambiguousMetadata"
  | "extension.acquisition.conflict.blocking.developerIdentityMismatch"
  | "extension.acquisition.conflict.blocking.installedIdentityMissing"
  | "extension.acquisition.conflict.eligible"
  | "extension.acquisition.conflict.ineligible"
  | "extension.acquisition.conflict.match.developerIdentity"
  | "extension.acquisition.conflict.match.metadataStoreId"
  | "extension.acquisition.conflict.match.storeIdentity"
  | "extension.acquisition.conflicts"
  | "extension.acquisition.disclosure.accept"
  | "extension.acquisition.disclosure.dataContext"
  | "extension.acquisition.disclosure.dataQuery"
  | "extension.acquisition.disclosure.dataTitle"
  | "extension.acquisition.disclosure.description"
  | "extension.acquisition.disclosure.noRequestOnCancel"
  | "extension.acquisition.disclosure.notGoogle"
  | "extension.acquisition.disclosure.title"
  | "extension.acquisition.discrepancy.catalog"
  | "extension.acquisition.discrepancy.name"
  | "extension.acquisition.discrepancy.package"
  | "extension.acquisition.discrepancy.version"
  | "extension.acquisition.discrepancies"
  | "extension.acquisition.done"
  | "extension.acquisition.error"
  | "extension.acquisition.health.checkedAt"
  | "extension.acquisition.health.healthy"
  | "extension.acquisition.health.notChecked"
  | "extension.acquisition.health.unavailable"
  | "extension.acquisition.identity"
  | "extension.acquisition.identity.matches"
  | "extension.acquisition.identity.proofDerivedId"
  | "extension.acquisition.identity.requestedId"
  | "extension.acquisition.loadMore"
  | "extension.acquisition.loading"
  | "extension.acquisition.openWebStore"
  | "extension.acquisition.package"
  | "extension.acquisition.package.description"
  | "extension.acquisition.package.entryCount"
  | "extension.acquisition.package.expandedBytes"
  | "extension.acquisition.package.fileCount"
  | "extension.acquisition.package.filesystemNodeCount"
  | "extension.acquisition.package.format"
  | "extension.acquisition.package.icon"
  | "extension.acquisition.package.manifestSha256"
  | "extension.acquisition.package.manifestVersion"
  | "extension.acquisition.package.name"
  | "extension.acquisition.package.sha256"
  | "extension.acquisition.package.size"
  | "extension.acquisition.package.treeSha256"
  | "extension.acquisition.package.version"
  | "extension.acquisition.permissions"
  | "extension.acquisition.permissions.host"
  | "extension.acquisition.permissions.none"
  | "extension.acquisition.permissions.optional"
  | "extension.acquisition.permissions.optionalHost"
  | "extension.acquisition.permissions.required"
  | "extension.acquisition.preflight.expiresAt"
  | "extension.acquisition.preflight.title"
  | "extension.acquisition.progress.analyzing"
  | "extension.acquisition.progress.committing"
  | "extension.acquisition.progress.created"
  | "extension.acquisition.progress.downloading"
  | "extension.acquisition.progress.ready"
  | "extension.acquisition.progress.verifying"
  | "extension.acquisition.results.cancelled"
  | "extension.acquisition.results.choose"
  | "extension.acquisition.results.emptyBody"
  | "extension.acquisition.results.emptyTitle"
  | "extension.acquisition.results.error"
  | "extension.acquisition.results.loading"
  | "extension.acquisition.results.loadingMore"
  | "extension.acquisition.results.retry"
  | "extension.acquisition.results.summary"
  | "extension.acquisition.results.title"
  | "extension.acquisition.risk.high"
  | "extension.acquisition.risk.low"
  | "extension.acquisition.risk.medium"
  | "extension.acquisition.risk.optional"
  | "extension.acquisition.risk.reason.allUrls"
  | "extension.acquisition.risk.reason.contentScriptAllUrls"
  | "extension.acquisition.risk.reason.highPrivilege"
  | "extension.acquisition.risk.reason.tabsMetadata"
  | "extension.acquisition.risks"
  | "extension.acquisition.session.bytesDownloaded"
  | "extension.acquisition.session.expired"
  | "extension.acquisition.session.rejected"
  | "extension.acquisition.session.retry"
  | "extension.acquisition.source.allOff"
  | "extension.acquisition.source.allOffHelp"
  | "extension.acquisition.source.crxsosoArtifactDescription"
  | "extension.acquisition.source.crxsosoArtifactName"
  | "extension.acquisition.source.crxsosoSearchDescription"
  | "extension.acquisition.source.crxsosoSearchName"
  | "extension.acquisition.source.description"
  | "extension.acquisition.source.disabled"
  | "extension.acquisition.source.enabled"
  | "extension.acquisition.source.googleArtifactDescription"
  | "extension.acquisition.source.googleArtifactName"
  | "extension.acquisition.source.loading"
  | "extension.acquisition.source.operation.download"
  | "extension.acquisition.source.operation.openListing"
  | "extension.acquisition.source.operation.resolve"
  | "extension.acquisition.source.operation.search"
  | "extension.acquisition.source.operations"
  | "extension.acquisition.source.saving"
  | "extension.acquisition.source.title"
  | "extension.acquisition.source.trust.google"
  | "extension.acquisition.source.trust.thirdParty"
  | "extension.acquisition.storeId"
  | "extension.acquisition.success.description"
  | "extension.acquisition.success.title"
  | "extension.acquisition.transport"
  | "extension.acquisition.transport.duration"
  | "extension.acquisition.transport.fetchedAt"
  | "extension.acquisition.transport.finalHost"
  | "extension.acquisition.transport.provider"
  | "extension.acquisition.verification"
  | "extension.acquisition.verification.developerAlgorithm"
  | "extension.acquisition.verification.developerKey"
  | "extension.acquisition.verification.evidenceOnly"
  | "extension.acquisition.verification.level"
  | "extension.acquisition.verification.publisherAlgorithm"
  | "extension.acquisition.verification.trustRoot";

export type ExtensionAcquisitionUiTranslator = (
  key: ExtensionAcquisitionUiKey,
  params?: Record<string, string | number>,
) => string;

export function formatAcquisitionBytes(bytes: number, locale: Locale): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB"] as const;
  let value = bytes / 1024;
  let unit: (typeof units)[number] = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: value >= 10 ? 1 : 2 }).format(value)} ${unit}`;
}

export function formatAcquisitionDateTime(value: string, locale: Locale): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(timestamp);
}

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

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

/**
 * Registry acquisition dialogs are intentionally local to the feature. They retain the project's
 * existing modal classes while adding the focus trap, Escape handling, description linkage and
 * focus return that the older shell cannot currently guarantee.
 */
export function ExtensionAcquisitionDialog({
  actions,
  children,
  closeDisabled = false,
  closeLabel,
  description,
  onClose,
  panelClassName = "registry-editor-panel",
  showCloseButton = true,
  title,
}: {
  actions?: ReactNode;
  children: ReactNode;
  closeDisabled?: boolean;
  closeLabel: string;
  description?: ReactNode;
  onClose: () => void;
  panelClassName?: string;
  showCloseButton?: boolean;
  title: ReactNode;
}) {
  const titleId = useId();
  const descriptionId = useId();
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

  return (
    <div
      aria-describedby={description ? descriptionId : undefined}
      aria-labelledby={titleId}
      aria-modal="true"
      className="modal-layer acquisition-modal-layer"
      onKeyDown={handleKeyDown}
      ref={layerRef}
      role="dialog"
    >
      <div
        aria-hidden="true"
        className="modal-scrim"
        onMouseDown={(event) => {
          if (!closeDisabled && event.currentTarget === event.target) onClose();
        }}
      />
      <section
        aria-busy={closeDisabled || undefined}
        className={`modal-panel acquisition-modal-panel ${panelClassName}`.trim()}
        ref={panelRef}
        tabIndex={-1}
      >
        <header className={`modal-header ${showCloseButton ? "with-close" : ""}`}>
          <div className="modal-title-block">
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descriptionId}>{description}</p>}
          </div>
          {showCloseButton && (
            <button
              aria-label={closeLabel}
              className="icon-button modal-close-button"
              disabled={closeDisabled}
              onClick={onClose}
              title={closeLabel}
              type="button"
            >
              <X aria-hidden="true" size={16} />
            </button>
          )}
        </header>
        <div className="modal-body">{children}</div>
        {actions && <footer className="modal-footer">{actions}</footer>}
      </section>
    </div>
  );
}
