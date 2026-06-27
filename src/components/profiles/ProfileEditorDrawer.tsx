import { type ComponentType } from "react";
import {
  CircleStop,
  ClipboardPaste,
  Copy,
  Fingerprint,
  Layers3,
  ListChecks,
  Network,
  Play,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import type { TranslationKey } from "../../i18n";
import type { BrowserProfile } from "../../shared/profile";
import type { BrowserEnvironment, ExtensionEntity, GroupEntity, ProxyEntity, TagEntity } from "../../shared/entities";
import { Drawer } from "../ui/form-controls";
import { ProfileEditorAdvancedTab } from "./ProfileEditorAdvancedTab";
import { ProfileEditorFingerprintTab } from "./ProfileEditorFingerprintTab";
import { ProfileEditorProxyTab } from "./ProfileEditorProxyTab";
import { ProfileEditorRuntimeTab } from "./ProfileEditorRuntimeTab";

export type ProfileEditorTab = "runtime" | "proxy" | "fingerprint" | "advanced";

const tabs: Array<{ key: ProfileEditorTab; labelKey: TranslationKey; icon: ComponentType<{ size?: number }> }> = [
  { key: "runtime", labelKey: "nav.runtime", icon: Settings2 },
  { key: "proxy", labelKey: "nav.proxy", icon: Network },
  { key: "fingerprint", labelKey: "nav.fingerprint", icon: Fingerprint },
  { key: "advanced", labelKey: "nav.advanced", icon: SlidersHorizontal },
];
export function ProfileEditorDrawer(props: {
  activeTab: ProfileEditorTab;
  busy: string;
  checkPreflight: () => Promise<void>;
  checkProxy: () => Promise<void>;
  close: () => void;
  deleteProfile: () => Promise<void>;
  draftIsNew: boolean;
  draft: BrowserProfile;
  duplicateProfile: () => Promise<void>;
  environments: BrowserEnvironment[];
  extensions: ExtensionEntity[];
  groups: GroupEntity[];
  localProxyDraftIds: Set<string>;
  nameError: string;
  tags: TagEntity[];
  boundExtensionIds: string[];
  proxies: ProxyEntity[];
  proxyCheck: string;
  proxyLibraryDraftIds: Record<string, string>;
  browserCoreMissing: boolean;
  running: boolean;
  saveDraft: () => Promise<BrowserProfile | null>;
  saveDraftProxyToLibrary: () => Promise<void>;
  setActiveTab: (tab: ProfileEditorTab) => void;
  setDraftProxyLibraryId: (draftId: string, proxyId: string) => void;
  setDraftExtensionBinding: (extension: ExtensionEntity, bound: boolean) => Promise<void>;
  setDraft: (draft: BrowserProfile) => void;
  setDraftProxyLocal: (draftId: string) => void;
  stopProfile: () => Promise<void>;
  copyManagedProxyToLocal: () => void;
  launchProfile: () => Promise<void>;
  importConfigFromClipboard: () => Promise<void>;
  shareConfigToClipboard: () => Promise<void>;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const { activeTab, close, draft, draftIsNew, running, saveDraft, setActiveTab, t } = props;
  return (
    <Drawer
      title={draft.name}
      close={close}
      subtitle={t("editor.subtitle")}
      t={props.t}
      contentClassName="drawer-editor-shell"
      actions={
        <div className="drawer-actions compact-command-bar">
          <button className="command primary" disabled={props.busy === "save"} onClick={() => void saveDraft()} type="button">
            <Save size={15} />
            {t("actions.save")}
          </button>
          <button className="command subtle" onClick={() => void props.shareConfigToClipboard()} type="button">
            <Copy size={15} />
            {t("actions.shareConfig")}
          </button>
          <button className="command subtle" onClick={() => void props.importConfigFromClipboard()} type="button">
            <ClipboardPaste size={15} />
            {t("actions.importConfig")}
          </button>
          <button className="command" disabled={props.browserCoreMissing || props.busy === "preflight"} onClick={() => void props.checkPreflight()} title={props.browserCoreMissing ? t("browserCore.missingAction") : undefined} type="button">
            <ListChecks size={15} />
            {t("actions.preflight")}
          </button>
          {running ? (
            <button className="command danger" onClick={() => void props.stopProfile()} type="button">
              <CircleStop size={15} />
              {t("actions.stop")}
            </button>
          ) : (
            <button className="command success" disabled={props.browserCoreMissing} onClick={() => void props.launchProfile()} title={props.browserCoreMissing ? t("browserCore.missingAction") : undefined} type="button">
              <Play size={15} />
              {t("actions.launch")}
            </button>
          )}
          <button className="command subtle" disabled={draftIsNew || props.busy === "duplicate"} onClick={() => void props.duplicateProfile()} type="button">
            <Layers3 size={15} />
            {t("actions.duplicate")}
          </button>
          <button className="command danger subtle" onClick={() => void props.deleteProfile()} type="button">
            <Trash2 size={15} />
            {draftIsNew ? t("actions.cancel") : t("actions.delete")}
          </button>
        </div>
      }
    >
      <div className="editor-layout">
        <nav className="editor-section-nav" aria-label={props.t("aria.profileEditorSections")}>
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return (
              <button className={activeTab === tab.key ? "active" : ""} key={tab.key} onClick={() => setActiveTab(tab.key)} type="button">
                <Icon size={16} aria-hidden="true" />
                <span>{t(tab.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="editor-scroll">
          <div key={activeTab} className="editor-tab-content motion-tab-content">
            {activeTab === "runtime" && (
              <ProfileEditorRuntimeTab
                draft={draft}
                groups={props.groups}
                nameError={props.nameError}
                setDraft={props.setDraft}
                tags={props.tags}
                t={t}
              />
            )}
            {activeTab === "proxy" && (
              <ProfileEditorProxyTab
                draft={draft}
                setDraft={props.setDraft}
                busy={props.busy}
                copyManagedProxyToLocal={props.copyManagedProxyToLocal}
                environments={props.environments}
                localProxyDraftIds={props.localProxyDraftIds}
                proxies={props.proxies}
                proxyCheck={props.proxyCheck}
                proxyLibraryDraftIds={props.proxyLibraryDraftIds}
                checkProxy={props.checkProxy}
                saveDraftProxyToLibrary={props.saveDraftProxyToLibrary}
                setDraftProxyLibraryId={props.setDraftProxyLibraryId}
                setDraftProxyLocal={props.setDraftProxyLocal}
                t={t}
              />
            )}
            {activeTab === "fingerprint" && <ProfileEditorFingerprintTab draft={draft} setDraft={props.setDraft} t={t} />}
            {activeTab === "advanced" && (
              <ProfileEditorAdvancedTab
                draft={draft}
                setDraft={props.setDraft}
                busy={props.busy}
                extensions={props.extensions}
                boundExtensionIds={props.boundExtensionIds}
                setDraftExtensionBinding={props.setDraftExtensionBinding}
                t={t}
                draftIsNew={draftIsNew}
              />
            )}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
