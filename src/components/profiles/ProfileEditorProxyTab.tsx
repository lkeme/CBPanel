import { useEffect, useState } from "react";

import type { TranslationKey } from "../../i18n";
import {
  type BrowserProfile,
  type ProxySettings,
  buildProxyUrl,
  parseProxyUrlInput,
  proxyUrlFromParts,
} from "../../shared/profile";
import type { BrowserEnvironment, ProxyEntity } from "../../shared/entities";
import { Field, Segmented } from "../ui/form-controls";
import { Switch } from "../ui/switch";
import { ManagedProxyPicker, ManualProxyFields, ProxyCheckPanel, type ProxySourceMode } from "./ProfileEditorProxyFields";

export function ProfileEditorProxyTab({
  copyManagedProxyToLocal,
  draft,
  environments,
  setDraft,
  setDraftProxyLibraryId,
  setDraftProxyLocal,
  busy,
  localProxyDraftIds,
  proxies,
  proxyLibraryDraftIds,
  proxyCheck,
  checkProxy,
  saveDraftProxyToLibrary,
  t,
}: {
  copyManagedProxyToLocal: () => void;
  draft: BrowserProfile;
  environments: BrowserEnvironment[];
  setDraft: (draft: BrowserProfile) => void;
  setDraftProxyLibraryId: (draftId: string, proxyId: string) => void;
  setDraftProxyLocal: (draftId: string) => void;
  busy: string;
  localProxyDraftIds: Set<string>;
  proxies: ProxyEntity[];
  proxyLibraryDraftIds: Record<string, string>;
  proxyCheck: string;
  checkProxy: () => Promise<void>;
  saveDraftProxyToLibrary: () => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const environmentProxyId = environments.find((environment) => environment.id === draft.id)?.proxyId ?? "";
  const forcedLocal = localProxyDraftIds.has(draft.id);
  const selectedLibraryProxyId = forcedLocal ? "" : proxyLibraryDraftIds[draft.id] || environmentProxyId;
  const proxyMode: ProxySourceMode = selectedLibraryProxyId ? "managed" : "local";
  const [proxyUrlError, setProxyUrlError] = useState("");
  const [proxyUrlText, setProxyUrlText] = useState(() => draft.proxy.raw || proxyUrlFromParts(draft.proxy));

  useEffect(() => {
    setProxyUrlError("");
    setProxyUrlText(draft.proxy.raw || proxyUrlFromParts(draft.proxy));
  }, [draft.id, draft.proxy]);

  const applyManagedProxy = (proxyId: string) => {
    const proxy = proxies.find((item) => item.id === proxyId);
    if (!proxy) return;
    setDraftProxyLibraryId(draft.id, proxyId);
    setProxyUrlText("");
    setProxyUrlError("");
    setDraft({
      ...draft,
      proxy: {
        ...draft.proxy,
        enabled: true,
        raw: "",
        scheme: proxy.scheme,
        host: proxy.host,
        port: proxy.port,
        username: proxy.username,
        password: proxy.password,
        bypass: proxy.bypass,
      },
    });
  };
  const proxyEnabled = draft.proxy.enabled;
  const usingManagedProxy = proxyEnabled && proxyMode === "managed";
  const selectedManagedProxy = proxies.find((proxy) => proxy.id === selectedLibraryProxyId);
  const currentProxyUrl = buildProxyUrl(draft.proxy) ?? "";
  const canSaveProxyToLibrary = proxyEnabled && !usingManagedProxy && !proxyUrlError && Boolean(currentProxyUrl);
  const updateProxyParts = (patch: Partial<ProxySettings>) => {
    const nextProxy = { ...draft.proxy, ...patch, raw: "" };
    const nextRaw = proxyUrlFromParts(nextProxy);
    setProxyUrlError("");
    setProxyUrlText(nextRaw);
    setDraft({
      ...draft,
      proxy: {
        ...nextProxy,
        raw: nextRaw,
      },
    });
  };
  const updateProxyRaw = (value: string) => {
    const parsed = parseProxyUrlInput(value);
    setProxyUrlText(value);
    setProxyUrlError(value.trim() && !parsed ? t("error.proxyUrlInvalid") : "");
    if (!value.trim()) {
      setDraft({
        ...draft,
        proxy: {
          ...draft.proxy,
          raw: "",
          host: "",
          port: "",
          username: "",
          password: "",
        },
      });
      return;
    }
    if (!parsed) return;
    setDraft({
      ...draft,
      proxy: {
        ...draft.proxy,
        ...parsed,
        raw: value,
      },
    });
  };

  return (
    <div className="form-grid two">
      <div className="proxy-source-row wide">
        <Field label={t("form.proxySource")} help={proxyMode === "managed" ? t("form.proxyManagedHint") : t("form.proxyLocalHint")}>
          <Segmented<ProxySourceMode>
            value={proxyMode}
            options={[
              { value: "local", label: t("form.proxyLocal") },
              { value: "managed", label: t("form.proxyLibrary") },
            ]}
            onChange={(mode) => {
              if (mode === "local") {
                setDraftProxyLocal(draft.id);
                return;
              }
              const nextProxyId = selectedLibraryProxyId || proxies[0]?.id;
              if (nextProxyId) applyManagedProxy(nextProxyId);
            }}
          />
        </Field>
        <Switch
          aria-label={t("form.proxyEnabled")}
          checked={proxyEnabled}
          className="toggle-switch"
          onCheckedChange={(enabled) => {
            if (!enabled) setDraftProxyLocal(draft.id);
            setDraft({ ...draft, proxy: { ...draft.proxy, enabled } });
          }}
        />
      </div>
      {proxyMode === "managed" && (
        <ManagedProxyPicker
          applyManagedProxy={applyManagedProxy}
          proxies={proxies}
          proxyEnabled={proxyEnabled}
          selectedLibraryProxyId={selectedLibraryProxyId}
          t={t}
        />
      )}
      <ManualProxyFields
        draft={draft}
        proxyEnabled={proxyEnabled}
        proxyUrlError={proxyUrlError}
        proxyUrlText={proxyUrlText}
        t={t}
        updateProxyParts={updateProxyParts}
        updateProxyRaw={updateProxyRaw}
        usingManagedProxy={usingManagedProxy}
      />
      <ProxyCheckPanel
        busy={busy}
        canSaveProxyToLibrary={canSaveProxyToLibrary}
        checkProxy={checkProxy}
        copyManagedProxyToLocal={copyManagedProxyToLocal}
        currentProxyUrl={currentProxyUrl}
        proxyEnabled={proxyEnabled}
        proxyUrlError={proxyUrlError}
        saveDraftProxyToLibrary={saveDraftProxyToLibrary}
        selectedManagedProxy={selectedManagedProxy}
        t={t}
        usingManagedProxy={usingManagedProxy}
      />
      {proxyCheck && <div className="result-line wide">{proxyCheck}</div>}
    </div>
  );
}
