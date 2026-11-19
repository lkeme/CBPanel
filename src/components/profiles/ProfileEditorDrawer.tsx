import { type ComponentType } from "react";
import {
  CircleStop,
  ClipboardPaste,
  Copy,
  Fingerprint,
  Layers3,
  ListChecks,
  LoaderCircle,
  Network,
  Play,
  Save,
  Settings2,
  SlidersHorizontal,
  Trash2,
} from "lucide-react";

import type { Locale, TranslationKey } from "../../i18n";
import type { BrowserProfile } from "../../shared/profile";
import type { BrowserEnvironment, ExtensionEntity, GroupEntity, ProxyEntity, TagEntity, XrayEngineStatus } from "../../shared/entities";
import type { XrayNativeProxyRouting } from "../../shared/settings";
import type { XrayUtlsFingerprint } from "../../shared/xray";
import { Drawer } from "../ui/form-controls";
import { ProfileEditorAdvancedTab } from "./ProfileEditorAdvancedTab";
import { ProfileEditorFingerprintTab } from "./ProfileEditorFingerprintTab";
import { ProfileEditorIdentityPanel } from "./ProfileEditorIdentityPanel";
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
  /** The display locale, so the library check summary matches the proxy table's column. */
  locale: Locale;
  nameError: string;
  tags: TagEntity[];
  boundExtensionIds: string[];
  proxies: ProxyEntity[];
  proxyCheck: string;
  proxyLibraryDraftIds: Record<string, string>;
  browserCoreMissing: boolean;
  canStop: boolean;
  stopPending: boolean;
  resolveProxyGeoip: () => Promise<void>;
  /** Asks the server to delete the stored seed; the confirmation dialog lives in the workbench. */
  rotateIdentity: () => void;
  /** A live session may still hold the seed file, and the server refuses the rotation while it does. */
  identityRotationBlocked: boolean;
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
  installXray?: () => Promise<unknown>;
  globalUtlsFingerprint?: XrayUtlsFingerprint;
  nativeProxyRouting?: XrayNativeProxyRouting;
  xrayStatus?: XrayEngineStatus | null;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const { activeTab, canStop, close, draft, draftIsNew, saveDraft, setActiveTab, stopPending, t } = props;
  return (
    <Drawer
      title={draft.name}
      close={close}
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
          {canStop ? (
            <button
              className={`command danger ${stopPending ? "loading" : ""}`}
              disabled={stopPending}
              onClick={() => void props.stopProfile()}
              type="button"
            >
              {stopPending ? <LoaderCircle size={15} aria-hidden="true" /> : <CircleStop size={15} />}
              {stopPending ? t("status.stopping") : t("actions.stop")}
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
        <div className="editor-side">
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
          {/* The identity read-out is a property of the whole environment, so it sits at the foot of
              the tab column instead of inside one tab: it stays visible and in sync whichever tab is
              open, and it is out of the way of the form itself. */}
          <ProfileEditorIdentityPanel
            draft={draft}
            draftIsNew={draftIsNew}
            identityRotationBlocked={props.identityRotationBlocked}
            rotateIdentity={props.rotateIdentity}
            setDraft={props.setDraft}
            t={t}
          />
        </div>

        <div className="editor-scroll">
          <div key={activeTab} className="editor-tab-content motion-tab-content">
            {activeTab === "runtime" && (
              <ProfileEditorRuntimeTab
                boundExtensionIds={props.boundExtensionIds}
                busy={props.busy}
                draft={draft}
                draftIsNew={draftIsNew}
                extensions={props.extensions}
                groups={props.groups}
                nameError={props.nameError}
                setDraft={props.setDraft}
                setDraftExtensionBinding={props.setDraftExtensionBinding}
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
                locale={props.locale}
                proxies={props.proxies}
                proxyCheck={props.proxyCheck}
                proxyLibraryDraftIds={props.proxyLibraryDraftIds}
                checkProxy={props.checkProxy}
                globalUtlsFingerprint={props.globalUtlsFingerprint}
                installXray={props.installXray}
                nativeProxyRouting={props.nativeProxyRouting}
                xrayStatus={props.xrayStatus}
                resolveProxyGeoip={props.resolveProxyGeoip}
                saveDraftProxyToLibrary={props.saveDraftProxyToLibrary}
                setDraftProxyLibraryId={props.setDraftProxyLibraryId}
                setDraftProxyLocal={props.setDraftProxyLocal}
                t={t}
              />
            )}
            {activeTab === "fingerprint" && (
              <ProfileEditorFingerprintTab
                draft={draft}
                setDraft={props.setDraft}
                t={t}
              />
            )}
            {activeTab === "advanced" && (
              <ProfileEditorAdvancedTab
                draft={draft}
                setDraft={props.setDraft}
                t={t}
              />
            )}
          </div>
        </div>
      </div>
    </Drawer>
  );
}
