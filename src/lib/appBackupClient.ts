import { invoke, isTauri } from "@tauri-apps/api/core";

import type { TranslationKey } from "../i18n";
import type { AppBackupOperation, AppBackupOperationResult } from "../shared/appBackup";
import type { ConfirmDialogState } from "../components/ui/ConfirmDialog";
import { api, errorMessage } from "./apiClient";

type ToastKind = "success" | "error" | "info";

type AppBackupClientContext = {
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toast: (kind: ToastKind, text: string) => void;
  setBusy: (busy: string) => void;
  setAppBackupOperation: (operation: AppBackupOperation | null) => void;
};

type RestoreClientContext = AppBackupClientContext & {
  setConfirmDialog: (state: ConfirmDialogState) => void;
  afterRestore: () => Promise<void>;
};

export async function runAppBackupExport(context: AppBackupClientContext): Promise<void> {
  if (!isTauri()) {
    context.toast("error", context.t("appBackup.desktopOnly"));
    return;
  }
  context.setBusy("app-backup-export");
  try {
    const outputPath = await invoke<string | null>("cbpanel_select_app_backup_save_path", { filename: "cbpanel-full-backup.cbpb" });
    if (!outputPath) return;
    const operation = await startAppBackupOperation(context, "/api/app-backups/export", { outputPath });
    toastAppBackupResult(context, "export", operation.result);
  } catch (error) {
    context.toast("error", errorMessage(error));
  } finally {
    context.setBusy("");
  }
}

export async function requestAppBackupRestore(context: RestoreClientContext): Promise<void> {
  if (!isTauri()) {
    context.toast("error", context.t("appBackup.desktopOnly"));
    return;
  }
  let inputPath: string | null;
  try {
    inputPath = await invoke<string | null>("cbpanel_select_app_backup_open_path");
  } catch (error) {
    context.toast("error", errorMessage(error));
    return;
  }
  if (!inputPath) return;
  context.setConfirmDialog({
    title: context.t("appBackup.restoreTitle"),
    body: context.t("appBackup.restoreBody"),
    confirmLabel: context.t("appBackup.restore"),
    tone: "danger",
    busyKey: "app-backup-restore",
    onConfirm: () => restoreAppBackupPath(context, inputPath),
  });
}

async function restoreAppBackupPath(context: RestoreClientContext, inputPath: string): Promise<void> {
  context.setBusy("app-backup-restore");
  try {
    const operation = await startAppBackupOperation(context, "/api/app-backups/restore", { inputPath });
    context.setConfirmDialog(null);
    await context.afterRestore();
    toastAppBackupResult(context, "restore", operation.result);
  } catch (error) {
    context.toast("error", errorMessage(error));
  } finally {
    context.setBusy("");
  }
}

async function startAppBackupOperation(
  context: AppBackupClientContext,
  url: string,
  body: Record<string, unknown>,
): Promise<AppBackupOperation> {
  const started = await api<{ operationId: string; operation: AppBackupOperation }>(url, {
    method: "POST",
    body: JSON.stringify(body),
  });
  context.setAppBackupOperation(started.operation);
  return pollAppBackupOperation(context, started.operationId);
}

async function pollAppBackupOperation(context: AppBackupClientContext, operationId: string): Promise<AppBackupOperation> {
  try {
    for (;;) {
      const operation = await api<AppBackupOperation>(`/api/app-backups/operations/${operationId}`);
      context.setAppBackupOperation(operation.status === "succeeded" || operation.status === "failed" ? null : operation);
      if (operation.status === "succeeded") return operation;
      if (operation.status === "failed") throw new Error(operation.error ?? operation.message);
      await delay(700);
    }
  } catch (error) {
    context.setAppBackupOperation(null);
    throw error;
  }
}

function toastAppBackupResult(
  context: AppBackupClientContext,
  type: "export" | "restore",
  result: AppBackupOperationResult | undefined,
): void {
  const counts = result?.counts;
  context.toast("success", context.t(type === "export" ? "appBackup.exportDone" : "appBackup.restoreDone", {
    environments: counts?.environments ?? 0,
    trash: counts?.trashEnvironments ?? 0,
    browserData: counts?.browserData ?? 0,
    extensions: counts?.runtimeExtensions ?? 0,
    warnings: result?.warnings.length ?? 0,
  }));
  const warning = result?.warnings[0];
  if (warning) context.toast("info", context.t("appBackup.warning", { message: warning }));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
