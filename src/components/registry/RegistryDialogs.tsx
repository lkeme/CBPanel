import React, { useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";

import type { TranslationKey } from "../../i18n";
import type {
  ExtensionDirectoryCandidate,
  ExtensionDirectoryImportResult,
  ExtensionDirectoryPreviewResult,
  ExtensionSourceEntity,
  GroupEntity,
  ProxyEntity,
  TagEntity,
} from "../../shared/entities";
import { type ProxyScheme, nowIso, parseProxyUrlInput, proxyUrlFromParts } from "../../shared/profile";
import { DialogShell } from "../ui/DialogShell";
import { Field, Segmented, ToggleField } from "../ui/form-controls";
import { PasswordInput } from "../ui/PasswordInput";
import { SelectMenu } from "../ui/SelectMenu";
import { maskManagedProxyForDisplay } from "../profiles/proxyDisplay";

export type TextInputDialogState = {
  title: string;
  body?: string;
  bodyCode?: string;
  label: string;
  placeholder?: string;
  confirmLabel: string;
  defaultValue?: string;
  secret?: boolean;
  busyKey?: string;
  validate?: (value: string) => string | null;
  onConfirm: (value: string) => Promise<void>;
} | null;

export type ExtensionImportDialogState =
  | { kind: "directory" | "zip" | "crx" }
  | { kind: "remote" }
  | null;

function proxyEditorInitialDraft(proxy?: ProxyEntity): ProxyEntity {
  const timestamp = nowIso();
  return {
    id: proxy?.id ?? "",
    name: proxy?.name ?? "",
    scheme: proxy?.scheme ?? "http",
    host: proxy?.host ?? "",
    port: proxy?.port ?? "",
    username: proxy?.username ?? "",
    password: proxy?.password ?? "",
    bypass: proxy?.bypass ?? "localhost,127.0.0.1",
    notes: proxy?.notes ?? "",
    status: proxy?.status ?? "enabled",
    lastCheck: proxy?.lastCheck,
    createdAt: proxy?.createdAt ?? timestamp,
    updatedAt: proxy?.updatedAt ?? timestamp,
  };
}

function registryEntityInitialDraft(kind: "group" | "tag", entity?: GroupEntity | TagEntity): GroupEntity | TagEntity {
  const timestamp = nowIso();
  const base = {
    id: entity?.id ?? "",
    name: entity?.name ?? "",
    color: entity?.color ?? (kind === "group" ? "#0891b2" : "#7c3aed"),
    description: entity?.description ?? "",
    order: entity?.order ?? 0,
    status: entity?.status ?? "enabled",
    createdAt: entity?.createdAt ?? timestamp,
    updatedAt: entity?.updatedAt ?? timestamp,
  };
  if (kind === "group") return { ...base, isDefault: "isDefault" in (entity ?? {}) ? Boolean((entity as GroupEntity).isDefault) : false } as GroupEntity;
  return base as TagEntity;
}

function fileInputPath(input: HTMLInputElement): string {
  const file = input.files?.[0] as (File & { path?: string }) | undefined;
  return file?.path ?? input.value;
}

export function TextInputDialog({
  busy,
  close,
  state,
  t,
}: {
  busy: string;
  close: () => void;
  state: NonNullable<TextInputDialogState>;
  t: (key: TranslationKey) => string;
}) {
  const [value, setValue] = useState(state.defaultValue ?? "");
  const [error, setError] = useState("");
  const isBusy = Boolean(state.busyKey && busy === state.busyKey);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const nextError = state.validate?.(value) ?? null;
    if (nextError) {
      setError(nextError);
      return;
    }
    setError("");
    void state.onConfirm(value);
  }

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button className="command primary" disabled={isBusy} type="submit">
            {state.confirmLabel}
          </button>
        </>
      }
      asForm
      close={close}
      closeDisabled={isBusy}
      description={state.body ? renderDialogBody(state.body, state.bodyCode) : undefined}
      labelledBy="text-input-dialog-title"
      onSubmit={submit}
      panelClassName="input-panel"
      t={t}
      title={state.title}
    >
      <label className="modal-input-field">
        <span>{state.label}</span>
        <input
          autoFocus
          disabled={isBusy}
          placeholder={state.placeholder}
          type={state.secret ? "password" : "text"}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            if (error) setError("");
          }}
        />
      </label>
      {error && <div className="result-line danger">{error}</div>}
    </DialogShell>
  );
}

function renderDialogBody(body: string, code?: string): React.ReactNode {
  if (!code || !body.includes(code)) return body;
  const [before, after] = body.split(code);
  return (
    <>
      {before}
      <code className="inline-code">{code}</code>
      {after}
    </>
  );
}

export function RegistryEntityDialog({
  busy,
  close,
  entity,
  kind,
  mode,
  saveGroup,
  saveTag,
  t,
}: {
  busy: string;
  close: () => void;
  entity?: GroupEntity | TagEntity;
  kind: "group" | "tag";
  mode: "create" | "edit";
  saveGroup: (mode: "create" | "edit", input: Partial<GroupEntity>, group?: GroupEntity) => Promise<void>;
  saveTag: (mode: "create" | "edit", input: Partial<TagEntity>, tag?: TagEntity) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [draft, setDraft] = useState(() => registryEntityInitialDraft(kind, entity));
  const nameError = draft.name.trim() ? "" : t(kind === "group" ? "registry.editor.groupNameRequired" : "registry.editor.tagNameRequired");
  const busyKey = mode === "create" ? `${kind}-create` : entity ? `${kind}-update:${entity.id}` : `${kind}-update`;
  const isBusy = busy === busyKey;
  const canSave = !nameError;
  const title =
    kind === "group"
      ? t(mode === "create" ? "registry.editor.createGroupTitle" : "registry.editor.editGroupTitle")
      : t(mode === "create" ? "registry.editor.createTagTitle" : "registry.editor.editTagTitle");

  const updateDraft = (patch: Partial<GroupEntity & TagEntity>) => setDraft((current) => ({ ...current, ...patch }));

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button
            className="command primary"
            disabled={!canSave || isBusy}
            onClick={() => {
              if (kind === "group") void saveGroup(mode, draft as Partial<GroupEntity>, entity as GroupEntity | undefined);
              else void saveTag(mode, draft as Partial<TagEntity>, entity as TagEntity | undefined);
            }}
            type="button"
          >
            {t("actions.save")}
          </button>
        </>
      }
      bodyClassName="modal-body registry-editor-body"
      close={close}
      closeDisabled={isBusy}
      description={t(kind === "group" ? "registry.editor.groupDescription" : "registry.editor.tagDescription")}
      labelledBy="registry-editor-title"
      panelClassName="registry-editor-panel"
      t={t}
      title={title}
    >
      <div className="form-grid two compact-section">
        <Field label={t(kind === "group" ? "registry.editor.groupName" : "registry.editor.tagName")} wide error={nameError}>
          <input value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} placeholder={t(kind === "group" ? "registry.editor.groupPlaceholder" : "registry.editor.tagPlaceholder")} />
        </Field>
        <Field label={t("registry.editor.color")}>
          <input className="color-input" value={draft.color} onChange={(event) => updateDraft({ color: event.target.value })} placeholder="#0891b2" />
        </Field>
        <Field label={t("registry.editor.order")}>
          <input type="number" value={draft.order} onChange={(event) => updateDraft({ order: Number(event.target.value) })} />
        </Field>
        <Field label={t("form.notes")} wide>
          <textarea value={draft.description} onChange={(event) => updateDraft({ description: event.target.value })} placeholder={t("registry.editor.descriptionPlaceholder")} />
        </Field>
        <ToggleField
          checked={draft.status !== "disabled"}
          disabled={kind === "group" && "isDefault" in draft && draft.isDefault}
          label={t("proxy.editor.status")}
          onChange={(enabled) => updateDraft({ status: enabled ? "enabled" : "disabled" })}
        />
      </div>
      <div className="registry-editor-preview">
        <span className="registry-color-dot" style={{ background: draft.color }} aria-hidden="true" />
        <strong>{draft.name || t(kind === "group" ? "actions.newGroup" : "actions.newTag")}</strong>
        <small>{draft.description || t("registry.editor.noDescription")}</small>
      </div>
    </DialogShell>
  );
}

export function RegistryMergeDialog({
  busy,
  close,
  entity,
  groups,
  kind,
  mergeGroup,
  mergeTag,
  referenceCount,
  showProfiles,
  tags,
  t,
}: {
  busy: string;
  close: () => void;
  entity: GroupEntity | TagEntity;
  groups: GroupEntity[];
  kind: "group" | "tag";
  mergeGroup: (group: GroupEntity, targetId: string) => Promise<void>;
  mergeTag: (tag: TagEntity, targetId: string) => Promise<void>;
  referenceCount: number;
  showProfiles: (entity: GroupEntity | TagEntity) => void;
  tags: TagEntity[];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const candidates = (kind === "group" ? groups : tags).filter((item) => item.id !== entity.id);
  const [targetId, setTargetId] = useState(candidates[0]?.id ?? "");
  const isBusy = busy === `${kind}-merge:${entity.id}`;
  const targetOptions = candidates.map((candidate) => ({
    value: candidate.id,
    label: candidate.name,
    meta: candidate.description || t(candidate.status === "disabled" ? "status.disabled" : "status.enabled"),
  }));

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button
            className="command danger"
            disabled={!targetId || isBusy}
            onClick={() => {
              if (kind === "group") void mergeGroup(entity as GroupEntity, targetId);
              else void mergeTag(entity as TagEntity, targetId);
            }}
            type="button"
          >
            {t("actions.merge")}
          </button>
        </>
      }
      close={close}
      closeDisabled={isBusy}
      description={t(kind === "group" ? "registry.merge.groupBody" : "registry.merge.tagBody", { count: referenceCount })}
      labelledBy="registry-merge-title"
      panelClassName="reference-panel"
      t={t}
      title={t(kind === "group" ? "registry.merge.groupTitle" : "registry.merge.tagTitle", { name: entity.name })}
    >
      <div className="reference-summary">
        <span>{t("registry.merge.source")}</span>
        <strong>{entity.name}</strong>
        <small>{entity.description || t("registry.editor.noDescription")}</small>
      </div>
      <Field label={t("registry.merge.target")}>
        <SelectMenu
          disabled={targetOptions.length === 0}
          value={targetId}
          placeholder={t("registry.merge.noTarget")}
          options={targetOptions}
          onChange={setTargetId}
        />
      </Field>
      <div className="reference-action-grid">
        <button
          className="command"
          onClick={() => {
            showProfiles(entity);
            close();
          }}
          type="button"
        >
          {t("registry.merge.viewProfiles")}
        </button>
      </div>
    </DialogShell>
  );
}

export function ExtensionImportDialog({
  addRemoteExtension,
  busy,
  close,
  importArchive,
  importDirectories,
  importDirectory,
  previewDirectory,
  state,
  t,
}: {
  addRemoteExtension: (input: { sourceUrl: string; sha256: string }) => Promise<void>;
  busy: string;
  close: () => void;
  importArchive: (kind: "zip" | "crx", filePath: string) => Promise<void>;
  importDirectories: (paths: string[]) => Promise<ExtensionDirectoryImportResult | null>;
  importDirectory: (directory: string) => Promise<void>;
  previewDirectory: (directory: string) => Promise<ExtensionDirectoryPreviewResult | null>;
  state: NonNullable<ExtensionImportDialogState>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [pathValue, setPathValue] = useState("");
  const [pathError, setPathError] = useState("");
  const [directoryPreview, setDirectoryPreview] = useState<ExtensionDirectoryPreviewResult | null>(null);
  const [directoryImportResult, setDirectoryImportResult] = useState<ExtensionDirectoryImportResult | null>(null);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState<Set<string>>(() => new Set());
  const [sourceUrl, setSourceUrl] = useState("");
  const [sha256, setSha256] = useState("");
  const title =
    state.kind === "remote"
      ? t("extension.import.remoteTitle")
      : state.kind === "directory"
        ? t("extension.import.directoryTitle")
        : t(state.kind === "zip" ? "extension.import.zipTitle" : "extension.import.crxTitle");
  const busyKey =
    state.kind === "remote"
      ? "extension-remote-create"
      : state.kind === "directory"
        ? "extension-import-directory"
        : `extension-import-${state.kind}`;
  const isBusy = busy === busyKey;
  const selectedCandidates = directoryPreview?.candidates.filter((candidate) => selectedCandidateIds.has(candidate.id)) ?? [];
  const hasDirectoryPreview = state.kind === "directory" && Boolean(directoryPreview?.candidates.length);
  const canSubmit =
    state.kind === "remote"
      ? Boolean(sourceUrl.trim() && sha256.trim())
      : hasDirectoryPreview
        ? selectedCandidates.length > 0
        : Boolean(pathValue.trim());

  async function pickDirectory() {
    if (!isTauri()) return;
    try {
      const directory = await invoke<string | null>("cbpanel_select_extension_directory");
      if (directory) {
        setPathValue(directory);
        setPathError("");
        setDirectoryPreview(null);
        setDirectoryImportResult(null);
        setSelectedCandidateIds(new Set());
      }
    } catch (error) {
      setPathError(error instanceof Error ? error.message : String(error));
    }
  }

  async function submit() {
    if (state.kind === "remote") {
      await addRemoteExtension({ sourceUrl, sha256 });
      return;
    }
    if (state.kind !== "directory") {
      await importArchive(state.kind, pathValue);
      return;
    }
    if (hasDirectoryPreview) {
      const result = await importDirectories(selectedCandidates.map((candidate) => candidate.path));
      setDirectoryImportResult(result);
      if (result?.failed.length) {
        const failedPaths = new Set(result.failed.map((item) => item.path));
        setSelectedCandidateIds(new Set(directoryPreview?.candidates.filter((candidate) => failedPaths.has(candidate.path)).map((candidate) => candidate.id)));
      }
      return;
    }

    setDirectoryImportResult(null);
    const preview = await previewDirectory(pathValue);
    if (!preview) return;
    if (preview.direct) {
      await importDirectory(preview.direct.path);
      return;
    }
    setDirectoryPreview(preview);
    setSelectedCandidateIds(new Set());
  }

  function toggleCandidate(candidateId: string, selected: boolean) {
    setSelectedCandidateIds((current) => {
      const next = new Set(current);
      if (selected) next.add(candidateId);
      else next.delete(candidateId);
      return next;
    });
  }

  function resetDirectoryPreview() {
    setDirectoryPreview(null);
    setDirectoryImportResult(null);
    setSelectedCandidateIds(new Set());
  }

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button
            className="command primary"
            disabled={!canSubmit || isBusy}
            onClick={() => {
              void submit();
            }}
            type="button"
          >
            {state.kind === "remote"
              ? t("actions.addRemoteExtension")
              : hasDirectoryPreview
                ? t("extension.import.importSelected")
                : t("actions.import")}
          </button>
        </>
      }
      close={close}
      closeDisabled={isBusy}
      description={t("extension.import.description")}
      labelledBy="extension-import-title"
      panelClassName="registry-editor-panel"
      t={t}
      title={title}
    >
      {state.kind === "remote" ? (
        <div className="form-grid two compact-section">
          <Field label={t("extension.import.sourceUrl")} wide>
            <input value={sourceUrl} onChange={(event) => setSourceUrl(event.target.value)} placeholder={t("extension.import.remotePlaceholder")} />
          </Field>
          <Field label={t("module.extensionSha256")} wide>
            <input className="mono-cell" value={sha256} onChange={(event) => setSha256(event.target.value)} placeholder={t("extension.import.sha256Placeholder")} />
          </Field>
        </div>
      ) : (
        <div className="form-grid two compact-section">
          <Field label={t("form.path")} wide>
            <div className="path-picker-row">
              <input
                value={pathValue}
                onChange={(event) => {
                  setPathValue(event.target.value);
                  if (pathError) setPathError("");
                  if (directoryPreview) resetDirectoryPreview();
                  else if (directoryImportResult) setDirectoryImportResult(null);
                }}
                placeholder={t(state.kind === "directory" ? "extension.import.directoryPlaceholder" : "extension.import.filePlaceholder")}
              />
              {state.kind === "directory" && isTauri() && (
                <button className="command subtle" disabled={isBusy} onClick={() => void pickDirectory()} type="button">
                  {t("extension.import.pickDirectory")}
                </button>
              )}
            </div>
            {pathError && <div className="result-line danger">{pathError}</div>}
          </Field>
          {(state.kind === "zip" || state.kind === "crx") && (
            <Field label={t("extension.import.pickFile")} wide>
              <input
                accept={state.kind === "zip" ? ".zip,application/zip" : ".crx,application/x-chrome-extension"}
                onChange={(event) => setPathValue(fileInputPath(event.currentTarget))}
                type="file"
              />
            </Field>
          )}
        </div>
      )}
      {state.kind === "directory" && directoryPreview && directoryPreview.candidates.length > 0 && (
        <ExtensionDirectoryCandidatePreview
          candidates={directoryPreview.candidates}
          selectedIds={selectedCandidateIds}
          t={t}
          toggleCandidate={toggleCandidate}
        />
      )}
      {state.kind === "directory" && directoryImportResult?.failed.length ? (
        <ExtensionDirectoryImportFailures failed={directoryImportResult.failed} t={t} />
      ) : null}
      <div className="preflight-empty">{t("extension.import.webPathNote")}</div>
    </DialogShell>
  );
}

function ExtensionDirectoryCandidatePreview({
  candidates,
  selectedIds,
  t,
  toggleCandidate,
}: {
  candidates: ExtensionDirectoryCandidate[];
  selectedIds: Set<string>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  toggleCandidate: (candidateId: string, selected: boolean) => void;
}) {
  const selectedCount = candidates.filter((candidate) => selectedIds.has(candidate.id)).length;

  return (
    <div className="extension-import-preview">
      <div className="extension-import-preview-header">
        <strong>{t("extension.import.previewTitle")}</strong>
        <span>{t("extension.import.selectedCount", { selected: selectedCount, total: candidates.length })}</span>
      </div>
      <div className="extension-import-candidates">
        {candidates.map((candidate) => (
          <label className="extension-import-candidate" key={candidate.id}>
            <input
              checked={selectedIds.has(candidate.id)}
              onChange={(event) => toggleCandidate(candidate.id, event.currentTarget.checked)}
              type="checkbox"
            />
            <span className="extension-import-candidate-main">
              <span className="extension-import-candidate-title">
                <strong>{candidate.name}</strong>
                <small>{candidate.version}</small>
              </span>
              <span className="extension-import-candidate-meta">
                <span className="mono-cell">{candidate.extensionId}</span>
                <span className="mono-cell">{candidate.path}</span>
              </span>
            </span>
          </label>
        ))}
      </div>
    </div>
  );
}

function ExtensionDirectoryImportFailures({
  failed,
  t,
}: {
  failed: ExtensionDirectoryImportResult["failed"];
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  return (
    <div className="extension-import-failures">
      <strong>{t("extension.import.failedTitle", { count: failed.length })}</strong>
      <div className="extension-import-failure-list">
        {failed.map((item) => (
          <div className="extension-import-failure" key={item.path}>
            <span className="mono-cell">{item.path}</span>
            <small>{item.error}</small>
          </div>
        ))}
      </div>
    </div>
  );
}

export function ExtensionSourceDialog({
  busy,
  close,
  mode,
  saveSource,
  source,
  t,
}: {
  busy: string;
  close: () => void;
  mode: "create" | "edit";
  saveSource: (mode: "create" | "edit", input: Partial<ExtensionSourceEntity>, source?: ExtensionSourceEntity) => Promise<void>;
  source?: ExtensionSourceEntity;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [draft, setDraft] = useState(() => ({
    name: source?.name ?? "",
    url: source?.url ?? "",
    status: source?.status ?? "enabled",
    allowUnsignedAssets: source?.allowUnsignedAssets ?? false,
  }));
  const nameError = draft.name.trim() ? "" : t("extension.source.nameRequired");
  const urlError = draft.url.trim() ? "" : t("extension.source.urlRequired");
  const busyKey = mode === "create" ? "extension-source-create" : source ? `extension-source-update:${source.id}` : "extension-source-update";
  const isBusy = busy === busyKey;
  const canSave = !nameError && !urlError;

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button className="command primary" disabled={!canSave || isBusy} onClick={() => void saveSource(mode, draft, source)} type="button">
            {t("actions.save")}
          </button>
        </>
      }
      close={close}
      closeDisabled={isBusy}
      description={t("extension.source.description")}
      labelledBy="extension-source-title"
      panelClassName="registry-editor-panel"
      t={t}
      title={t(mode === "create" ? "extension.source.createTitle" : "extension.source.editTitle")}
    >
      <div className="form-grid two compact-section">
        <Field label={t("extension.source.name")} wide error={nameError}>
          <input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder={t("extension.source.namePlaceholder")} />
        </Field>
        <Field label={t("extension.source.url")} wide error={urlError}>
          <input value={draft.url} onChange={(event) => setDraft((current) => ({ ...current, url: event.target.value }))} placeholder={t("extension.source.urlPlaceholder")} />
        </Field>
        <ToggleField
          checked={draft.status !== "disabled"}
          label={t("proxy.editor.status")}
          onChange={(enabled) => setDraft((current) => ({ ...current, status: enabled ? "enabled" : "disabled" }))}
        />
        <ToggleField
          checked={draft.allowUnsignedAssets}
          help={t("extension.source.unsignedHelp")}
          label={t("actions.allowUnsigned")}
          onChange={(allowUnsignedAssets) => setDraft((current) => ({ ...current, allowUnsignedAssets }))}
        />
      </div>
    </DialogShell>
  );
}

export function ProxyReferenceDialog({
  busy,
  close,
  deleteProxy,
  proxy,
  proxies,
  referenceCount,
  replaceAndDelete,
  replaceReferences,
  showProfiles,
  t,
  type,
  unbindAndDelete,
  unbindReferences,
}: {
  busy: string;
  close: () => void;
  deleteProxy: (proxy: ProxyEntity) => Promise<void>;
  proxy: ProxyEntity;
  proxies: ProxyEntity[];
  referenceCount: number;
  replaceAndDelete: (proxy: ProxyEntity, targetId: string) => Promise<void>;
  replaceReferences: (proxy: ProxyEntity, targetId: string) => Promise<void>;
  showProfiles: (proxyId: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
  type: "replace" | "unbind" | "delete";
  unbindAndDelete: (proxy: ProxyEntity) => Promise<void>;
  unbindReferences: (proxy: ProxyEntity) => Promise<void>;
}) {
  const candidates = proxies.filter((item) => item.id !== proxy.id);
  const [targetId, setTargetId] = useState(candidates[0]?.id ?? "");
  const isReplace = type === "replace";
  const titleKey = type === "delete" ? "proxy.references.deleteTitle" : type === "unbind" ? "proxy.references.unbindTitle" : "proxy.references.replaceTitle";
  const bodyKey = type === "delete" ? "proxy.references.deleteBody" : type === "unbind" ? "proxy.references.unbindBody" : "proxy.references.replaceBody";
  const busyKey = type === "replace" ? `proxy-replace:${proxy.id}` : type === "unbind" ? `proxy-unbind:${proxy.id}` : `proxy-delete:${proxy.id}`;
  const isBusy = busy === busyKey;
  const shouldChooseReplacement = isReplace || (type === "delete" && referenceCount > 0 && candidates.length > 0);

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          {type === "delete" && referenceCount > 0 && targetId && (
            <button className="command danger" disabled={isBusy} onClick={() => void replaceAndDelete(proxy, targetId)} type="button">
              {t("proxy.references.replaceAndDelete")}
            </button>
          )}
          {type === "delete" && referenceCount === 0 && (
            <button className="command danger" disabled={isBusy} onClick={() => void deleteProxy(proxy)} type="button">
              {t("actions.delete")}
            </button>
          )}
          {type === "replace" && (
            <button className="command primary" disabled={!targetId || isBusy} onClick={() => void replaceReferences(proxy, targetId)} type="button">
              {t("actions.replaceReferences")}
            </button>
          )}
          {type === "unbind" && (
            <button className="command danger" disabled={isBusy} onClick={() => void unbindReferences(proxy)} type="button">
              {t("actions.unbindReferences")}
            </button>
          )}
        </>
      }
      close={close}
      closeDisabled={isBusy}
      description={t(bodyKey, { count: referenceCount })}
      labelledBy="proxy-reference-title"
      panelClassName="reference-panel"
      t={t}
      title={t(titleKey, { name: proxy.name })}
    >
      <div className="reference-summary">
        <span>{t("proxy.references.currentProxy")}</span>
        <strong>{proxy.name}</strong>
        <small className="mono-cell">{maskManagedProxyForDisplay(proxy)}</small>
      </div>
      {shouldChooseReplacement && (
        <Field label={t("proxy.references.target")}>
          <SelectMenu
            disabled={candidates.length === 0}
            value={targetId}
            placeholder={t("proxy.references.noTarget")}
            options={candidates.map((candidate) => ({
              value: candidate.id,
              label: candidate.name,
              meta: `${candidate.scheme}://${candidate.host}:${candidate.port}`,
            }))}
            onChange={setTargetId}
          />
        </Field>
      )}
      {type === "delete" && referenceCount > 0 && (
        <div className="reference-action-grid">
          <button
            className="command"
            onClick={() => {
              showProfiles(proxy.id);
              close();
            }}
            type="button"
          >
            {t("proxy.actions.viewProfiles")}
          </button>
          <button className="command danger subtle" disabled={isBusy} onClick={() => void unbindAndDelete(proxy)} type="button">
            {t("proxy.references.unbindAndDelete")}
          </button>
        </div>
      )}
      {type === "delete" && referenceCount === 0 && <p className="muted-line">{t("proxy.delete.body")}</p>}
    </DialogShell>
  );
}

export function ProxyEditorDialog({
  busy,
  close,
  mode,
  proxy,
  saveProxy,
  t,
}: {
  busy: string;
  close: () => void;
  mode: "create" | "edit";
  proxy?: ProxyEntity;
  saveProxy: (mode: "create" | "edit", input: Partial<ProxyEntity>, proxy?: ProxyEntity) => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [draft, setDraft] = useState<ProxyEntity>(() => proxyEditorInitialDraft(proxy));
  const [proxyUrlText, setProxyUrlText] = useState(() => proxyUrlFromParts(draft));
  const [proxyUrlError, setProxyUrlError] = useState("");
  const nameError = draft.name.trim() ? "" : t("proxy.editor.validationName");
  const hostError = draft.host.trim() ? "" : t("proxy.editor.validationHost");
  const portError = draft.port.trim() ? "" : t("proxy.editor.validationPort");
  const canSave = !nameError && !hostError && !portError && !proxyUrlError;
  const busyKey = mode === "create" ? "proxy-create" : proxy ? `proxy-update:${proxy.id}` : "proxy-update";
  const isBusy = busy === busyKey;

  const updateParts = (patch: Partial<ProxyEntity>) => {
    const next = { ...draft, ...patch };
    setDraft(next);
    setProxyUrlError("");
    setProxyUrlText(proxyUrlFromParts(next));
  };

  const updateRaw = (value: string) => {
    const parsed = parseProxyUrlInput(value);
    setProxyUrlText(value);
    setProxyUrlError(value.trim() && !parsed ? t("error.proxyUrlInvalid") : "");
    if (!value.trim()) return;
    if (!parsed) return;
    setDraft((current) => ({
      ...current,
      ...parsed,
    }));
  };

  return (
    <DialogShell
      actions={
        <>
          <button className="command subtle" disabled={isBusy} onClick={close} type="button">
            {t("actions.cancel")}
          </button>
          <button className="command primary" disabled={!canSave || isBusy} onClick={() => void saveProxy(mode, draft, proxy)} type="button">
            {t("actions.save")}
          </button>
        </>
      }
      bodyClassName="modal-body proxy-editor-body"
      close={close}
      closeDisabled={isBusy}
      description={t("proxy.editor.description")}
      labelledBy="proxy-editor-title"
      panelClassName="proxy-editor-panel"
      t={t}
      title={t(mode === "create" ? "proxy.editor.createTitle" : "proxy.editor.editTitle")}
    >
      <div className="form-grid two compact-section">
        <Field label={t("proxy.editor.name")} wide error={nameError}>
          <input value={draft.name} onChange={(event) => updateParts({ name: event.target.value })} placeholder={t("proxy.editor.namePlaceholder")} />
        </Field>
        <Field label={t("form.proxyUrl")} wide error={proxyUrlError}>
          <input value={proxyUrlText} onChange={(event) => updateRaw(event.target.value)} placeholder={t("placeholder.proxyUrl")} />
        </Field>
        <Field label={t("form.scheme")} wide help={t("tips.proxyScheme")}>
          <Segmented<ProxyScheme>
            value={draft.scheme}
            options={[
              { value: "http", label: "HTTP" },
              { value: "https", label: "HTTPS" },
              { value: "socks5", label: "SOCKS5" },
            ]}
            onChange={(scheme) => updateParts({ scheme })}
          />
        </Field>
        <Field label={t("form.host")} error={hostError}>
          <input value={draft.host} onChange={(event) => updateParts({ host: event.target.value })} placeholder={t("placeholder.proxyHost")} />
        </Field>
        <Field label={t("form.port")} error={portError}>
          <input value={draft.port} onChange={(event) => updateParts({ port: event.target.value })} placeholder={t("placeholder.proxyPort")} />
        </Field>
        <Field label={t("form.username")}>
          <input autoComplete="off" value={draft.username} onChange={(event) => updateParts({ username: event.target.value })} placeholder={t("placeholder.proxyUsername")} />
        </Field>
        <Field label={t("form.password")}>
          <PasswordInput value={draft.password} onChange={(password) => updateParts({ password })} t={t} />
        </Field>
        <Field label={t("form.bypass")} wide>
          <input value={draft.bypass} onChange={(event) => updateParts({ bypass: event.target.value })} placeholder={t("placeholder.proxyBypass")} />
        </Field>
        <Field label={t("form.notes")} wide>
          <textarea value={draft.notes} onChange={(event) => updateParts({ notes: event.target.value })} placeholder={t("placeholder.notes")} />
        </Field>
        <ToggleField
          checked={draft.status !== "disabled"}
          label={t("proxy.editor.status")}
          onChange={(enabled) => updateParts({ status: enabled ? "enabled" : "disabled" })}
        />
      </div>
      <div className="proxy-editor-preview">
        <span>{t("proxy.editor.preview")}</span>
        <strong className="mono-cell">{maskManagedProxyForDisplay(draft)}</strong>
      </div>
    </DialogShell>
  );
}
