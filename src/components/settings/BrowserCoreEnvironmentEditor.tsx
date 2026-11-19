import { useState } from "react";
import { FilePlus2, Trash2 } from "lucide-react";

import type { TranslationKey } from "../../i18n";
import {
  CLOAKBROWSER_ENV_SUGGESTION_KEYS,
  type BinarySettings,
  type BrowserCoreEnvValueKind,
  type BrowserCoreEnvVarSetting,
  isManagedCloakBrowserEnvKey,
  isPanelSettingCloakBrowserEnvKey,
  normalizeCloakBrowserEnvKey,
} from "../../shared/settings";
import { Switch } from "../ui/switch";
import { EnvKeyCombobox } from "./EnvKeyCombobox";

export function BrowserCoreEnvironmentEditor({ binary, saveBinary, t }: {
  binary: BinarySettings;
  saveBinary: (patch: Partial<BinarySettings>) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const blank = (): BrowserCoreEnvVarSetting => ({
    id: crypto.randomUUID(), key: "", value: "", enabled: true,
    sensitive: false, description: "", valueKind: "text",
  });
  const [draft, setDraft] = useState<BrowserCoreEnvVarSetting>(blank);
  const customRows = binary.customEnvVars;
  const keyOptions = CLOAKBROWSER_ENV_SUGGESTION_KEYS;
  const normalizedKey = normalizeCloakBrowserEnvKey(draft.key);
  const duplicate = Boolean(normalizedKey && customRows.some((item) => item.key === normalizedKey));
  const blockedManaged = Boolean(normalizedKey && isManagedCloakBrowserEnvKey(normalizedKey));
  const blockedPanelSetting = Boolean(normalizedKey && isPanelSettingCloakBrowserEnvKey(normalizedKey));
  const canAdd = Boolean(normalizedKey && draft.value.trim() && !duplicate && !blockedManaged && !blockedPanelSetting);

  function updateCustomEnv(id: string, patch: Partial<BrowserCoreEnvVarSetting>) {
    saveBinary({ customEnvVars: customRows.map((item) => item.id === id ? { ...item, ...patch } : item) });
  }

  function addCustomEnv() {
    if (!canAdd || !normalizedKey) return;
    saveBinary({ customEnvVars: [...customRows, {
      ...draft, id: crypto.randomUUID(), key: normalizedKey,
      sensitive: envSensitiveForKey(normalizedKey),
      valueKind: envValueKindForKey(normalizedKey, draft.valueKind),
    }] });
    setDraft(blank());
  }

  function keyPatch(key: string, valueKind: BrowserCoreEnvValueKind) {
    return { key, sensitive: envSensitiveForKey(key), valueKind: envValueKindForKey(key, valueKind) };
  }

  return (
    <div className="custom-env-editor">
      {customRows.length > 0 && <div className="custom-env-list">
        {customRows.map((item) => {
          const panelOwned = isPanelSettingCloakBrowserEnvKey(item.key);
          return (
          <div className={`custom-env-card${item.enabled ? "" : " disabled"}${panelOwned ? " panel-owned" : ""}`} key={item.id}
            title={panelOwned ? t("browserCore.envPanelSettingWarning", { key: item.key }) : envDescription(item.key, t) || undefined}>
            <Switch aria-label={`${t("browserCore.envEnabled")} ${item.key}`} checked={item.enabled}
              className="toggle-switch" onCheckedChange={(enabled) => updateCustomEnv(item.id, { enabled })} />
            <input aria-label={`${t("browserCore.envKeyOptions")} ${item.key}`} className="mono-cell"
              disabled={panelOwned}
              title={item.key} value={item.key.replace(/^CLOAKBROWSER_/, "")}
              onChange={(event) => updateCustomEnv(item.id, { key: event.target.value })}
              onBlur={(event) => {
                const key = normalizeCloakBrowserEnvKey(event.target.value);
                if (key && !isManagedCloakBrowserEnvKey(key)) updateCustomEnv(item.id, keyPatch(key, item.valueKind));
              }} />
            <input aria-label={`${t("browserCore.envValue")} ${item.key}`} autoComplete="off" className="mono-cell"
              type={item.sensitive || envSensitiveForKey(item.key) ? "password" : "text"} value={item.value}
              onChange={(event) => updateCustomEnv(item.id, { value: event.target.value })}
              placeholder={t("browserCore.envValuePlaceholder")} />
            <button aria-label={`${t("actions.delete")} ${item.key}`} className="icon-button compact danger"
              onClick={() => saveBinary({ customEnvVars: customRows.filter((row) => row.id !== item.id) })}
              title={t("actions.delete")} type="button">
              <Trash2 size={15} aria-hidden="true" />
            </button>
            {panelOwned && <small className="custom-env-note">{t("browserCore.envPanelSettingWarning", { key: item.key })}</small>}
          </div>
          );
        })}
      </div>}
      <div className="custom-env-add-wrap">
        <div className="custom-env-card custom-env-add">
          <EnvKeyCombobox options={keyOptions} t={t} value={draft.key}
            onChange={(key) => setDraft((current) => ({ ...current, ...keyPatch(key, current.valueKind) }))} />
          <input aria-label={t("browserCore.envValue")} autoComplete="off" className="mono-cell"
            type={draft.sensitive ? "password" : "text"} value={draft.value}
            onChange={(event) => setDraft((current) => ({ ...current, value: event.target.value }))}
            onKeyDown={(event) => { if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); addCustomEnv(); } }}
            placeholder={t("browserCore.envValuePlaceholder")} />
          <button aria-label={t("browserCore.addEnv")} className="icon-button compact"
            disabled={!canAdd} onClick={addCustomEnv} title={t("browserCore.addEnv")} type="button">
            <FilePlus2 size={16} aria-hidden="true" />
          </button>
        </div>
        {blockedManaged && <div className="inline-error" role="alert">{t("browserCore.envManagedBlocked")}</div>}
        {blockedPanelSetting && <div className="inline-error" role="alert">{t("browserCore.envPanelSettingBlocked")}</div>}
      </div>
    </div>
  );
}

function envValueKindForKey(key: string, fallback: BrowserCoreEnvValueKind): BrowserCoreEnvValueKind {
  if (key === "CLOAKBROWSER_BINARY_PATH") return "path";
  if (key === "CLOAKBROWSER_LICENSE_KEY") return "secret";
  if (key === "CLOAKBROWSER_VERSION" || key === "CLOAKBROWSER_RELEASE_CHANNEL") return "text";
  if (key.endsWith("_DIR") || key.endsWith("_CDM")) return "directory";
  if (key.endsWith("_URL")) return "url";
  if (key.endsWith("_SECONDS") || key.endsWith("_TIMEOUT")) return "number";
  if (key === "CLOAKBROWSER_WIDEVINE" || key === "CLOAKBROWSER_SUPPRESS_FONT_WARNING") return "boolean";
  return fallback === "secret" ? "text" : fallback;
}
function envSensitiveForKey(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(key);
}

function envDescription(key: string, t: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  const suggestionKey = `browserCore.envSuggestion.${key}` as TranslationKey;
  const description = t(suggestionKey);
  return description === suggestionKey ? "" : description;
}
