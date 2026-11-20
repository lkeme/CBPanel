import type { AppUpdateCheck } from "./appUpdate";
import { APP_UPDATE_ARTIFACT_KINDS } from "./appUpdate";
import type { BrowserCoreUpdateCheck } from "./browserCore";
import type { XrayUpdateCheck } from "./entities";
import {
  EXTENSION_ACQUISITION_DISCLOSURE_VERSION,
  type ExtensionArtifactProviderId,
} from "./extensionAcquisition";
import {
  XRAY_LOG_LEVELS,
  XRAY_UTLS_FINGERPRINTS,
  type XrayLogLevel,
  type XrayUtlsFingerprint,
} from "./xray";

export type ShellMode = "web" | "desktop";
export type PlatformChrome = "native" | "custom";
export type RuntimePlatform = "windows" | "macos" | "linux" | "unknown";
export type ThemeMode = "system" | "light" | "dark";
export type LanguageMode = "system" | "zh-CN" | "en-US";
export type TableDensity = "compact" | "comfortable";
export type SidebarMode = "expanded" | "collapsed";
export type SortDirection = "asc" | "desc";
export type DesktopCloseBehavior = "ask" | "tray" | "quit";
export type BrowserCoreCacheDirMode = "auto" | "custom";
export type BrowserCoreTierMode = "free" | "pro";
export type BrowserCoreVersionMode = "latest" | "pinned";
export type BrowserCoreReleaseChannel = "stable" | "preview";
/** The two supported CloakBrowser binary channels. Offline is a mode of either channel. */
export type BrowserCoreChannel = "official" | "private";
export type BrowserCoreChannelMode = "online" | "offline";
export type BrowserCoreEnvValueKind = "text" | "path" | "directory" | "url" | "boolean" | "number" | "secret";
export type GithubMirrorProviderId =
  | "off"
  | "auto-best"
  | "gh-qfmc0721"
  | "g-z321-cc-cd"
  | "github-tbap-top"
  | "gh-proxy-org"
  | "ghproxy-net"
  | "gh-proxy-com"
  | "custom";

export interface AppSettings {
  appearance: AppearanceSettings;
  table: TableSettings;
  desktop: DesktopSettings;
  binary: BinarySettings;
  networkTrace: NetworkTraceSettings;
  extensionAcquisition: ExtensionAcquisitionSettings;
  xray: XraySettings;
  appUpdate: AppUpdateSettings;
}

/** CBPanel's own version checks. Separate from `binary`, which is the CloakBrowser core. */
export interface AppUpdateSettings {
  /** Always on; the 24h TTL in `shouldRunStartupAppUpdateCheck` bounds the request rate. */
  lastUpdateCheck?: AppUpdateCheck;
}

/**
 * The Xray engine that turns share-link nodes and chained proxies into a local SOCKS5 proxy for
 * CloakBrowser. The binary is downloaded on demand into the data directory; an operator can point
 * the panel at their own build instead.
 */
/**
 * Whether plain http/https/socks5 proxies also go through the engine. "auto" does so whenever the
 * engine is installed and falls back to CloakBrowser's own proxy support otherwise; "always" makes the
 * engine a hard requirement for every proxy; "never" reserves it for share-link nodes and chains.
 */
export type XrayNativeProxyRouting = "auto" | "always" | "never";

export const XRAY_NATIVE_PROXY_ROUTINGS: readonly XrayNativeProxyRouting[] = ["auto", "always", "never"];

export interface XraySettings {
  /** An operator-supplied xray binary. Empty means the panel-managed download. */
  customBinaryPath: string;
  nativeProxyRouting: XrayNativeProxyRouting;
  logLevel: XrayLogLevel;
  /** The uTLS ClientHello TLS/REALITY node connections imitate; "auto" follows the profile's fingerprint brand. */
  utlsFingerprint: XrayUtlsFingerprint;
  checkForUpdatesOnStartup: boolean;
  lastUpdateCheck?: XrayUpdateCheck;
}

export type AppSettingsPatch = {
  [Key in Exclude<keyof AppSettings, "extensionAcquisition">]?: Partial<AppSettings[Key]>;
} & {
  extensionAcquisition?: Partial<ExtensionAcquisitionSettings>;
};

export interface AppearanceSettings {
  theme: ThemeMode;
  language: LanguageMode;
  density: TableDensity;
  uiFontFamily: string;
  monoFontFamily: string;
  baseFontSize: number;
  tableFontSize: number;
  codeFontSize: number;
}

export interface ProfileColumnConfig {
  id: string;
  visible: boolean;
  width?: number;
  order: number;
}

export interface ProfileSortConfig {
  columnId: string;
  direction: SortDirection;
}

export interface TableSettings {
  columns: ProfileColumnConfig[];
  sort: ProfileSortConfig;
  showInspector: boolean;
  pageSize: number;
}

export interface DesktopSettings {
  advancedWebEntry: boolean;
  closeBehavior: DesktopCloseBehavior;
  platformChrome: PlatformChrome;
  sidebarMode: SidebarMode;
}

/**
 * The catalog search provider is built in and always available once the
 * disclosure has been accepted.  Only one artifact channel can be selected.
 */
export interface ExtensionAcquisitionSettings {
  artifactProviderId: ExtensionArtifactProviderId;
  crxsosoDisclosureVersionAccepted: number;
}

export interface BrowserCoreEnvVarSetting {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  sensitive: boolean;
  description: string;
  valueKind: BrowserCoreEnvValueKind;
}

export interface BinarySettings {
  lastUpdateCheck?: BrowserCoreUpdateCheck;
  customBinaryPathEnabled: boolean;
  customBinaryPath: string;
  cacheDirMode: BrowserCoreCacheDirMode;
  customCacheDir: string;
  /**
   * Derived from the license and written back by the binary service — it selects the cache layout, not
   * a user preference. Not exposed by any control, and not read from a stored row.
   */
  tierMode: BrowserCoreTierMode;
  licenseKey: string;
  browserVersionMode: BrowserCoreVersionMode;
  pinnedBrowserVersion: string;
  releaseChannel: BrowserCoreReleaseChannel;
  customEnvVars: BrowserCoreEnvVarSetting[];
  /** Which CloakBrowser channel supplies the active runtime. */
  coreChannel: BrowserCoreChannel;
  /** Whether the active channel may use its online update service. */
  coreChannelMode: BrowserCoreChannelMode;
  /** Private release repository URL. The token is stored outside app_settings. */
  privateRepositoryUrl: string;
  /** Whether advanced private-channel controls have been unlocked. */
  privateChannelUnlocked: boolean;
  /** The currently selected private release version, if one was installed. */
  privateReleaseVersion?: string;
}

export type NetworkTraceProviderKind =
  | "cloudflare-trace"
  | "tencent-ip2city-jsonp"
  | "aliyun-dns-detect-jsonp"
  | "header-ip"
  | "static-header-ip";

export type NetworkTraceProviderCategory =
  | "domestic"
  | "international"
  | "ai"
  | "nsfw"
  | "crypto"
  | "static";

export type NetworkTraceProviderMethod = "GET" | "HEAD";

export interface NetworkTraceProvider {
  id: string;
  name: string;
  url: string;
  kind: NetworkTraceProviderKind;
  category: NetworkTraceProviderCategory;
  tags?: string[];
  icon?: string;
  actualDomain?: string;
  method?: NetworkTraceProviderMethod;
}

export interface GithubMirrorProvider {
  id: Exclude<GithubMirrorProviderId, "off" | "auto-best" | "custom">;
  name: string;
  prefix: string;
}

export interface NetworkTraceSettings {
  providerId: string;
  customProviderUrl: string;
  timeoutSeconds: number;
  githubMirrorProviderId: GithubMirrorProviderId;
  customGithubMirrorPrefix: string;
}

export interface StorageInfo {
  kind: "sqlite";
  databasePath?: string;
  portable: boolean;
}

export interface DesktopRuntimeInfo {
  shell: ShellMode;
  platform: RuntimePlatform;
  chrome: PlatformChrome;
  portable: boolean;
  /** The packaged CloakBrowser wrapper and CBPanel's own version, for the window title. */
  versions: {
    wrapper?: string;
    app?: string;
  };
  api: {
    host: string;
    port: number;
    tokenRequired: boolean;
  };
  sidecar: {
    status: "starting" | "ready" | "error" | "stopped" | "not-applicable";
    detail?: string;
  };
}

export const DEFAULT_PROFILE_COLUMNS: ProfileColumnConfig[] = [
  { id: "select", visible: true, width: 46, order: 0 },
  { id: "name", visible: true, width: 240, order: 10 },
  { id: "status", visible: true, width: 56, order: 20 },
  { id: "group", visible: true, width: 104, order: 30 },
  { id: "tags", visible: false, width: 126, order: 40 },
  { id: "ip", visible: true, width: 190, order: 50 },
  { id: "proxy", visible: false, width: 180, order: 60 },
  { id: "mode", visible: true, width: 56, order: 70 },
  { id: "startUrl", visible: false, width: 220, order: 90 },
  { id: "updatedAt", visible: true, width: 118, order: 100 },
  { id: "actions", visible: true, width: 112, order: 110 },
];

const LEGACY_STATUS_DEFAULT_WIDTH = 104;
const LEGACY_MODE_DEFAULT_WIDTH = 78;
const LEGACY_UPDATED_AT_DEFAULT_WIDTH = 96;
const NARROW_PROFILE_COLUMN_IDS = new Set(["status", "mode"]);

export const DEFAULT_NETWORK_TRACE_PROVIDER_ID = "alibaba-dns-detect";
export const DEFAULT_GITHUB_MIRROR_PROVIDER_ID: GithubMirrorProviderId = "off";
export const ADVANCED_WEB_ENTRY_CODE = "CBPANEL-DEV";

export const BUILTIN_NETWORK_TRACE_PROVIDERS: NetworkTraceProvider[] = [
  {
    id: "alibaba-dns-detect",
    name: "Alibaba DNS Detect",
    url: "https://dns-detect.alicdn.com/api/detect/DescribeDNSLookup",
    kind: "aliyun-dns-detect-jsonp",
    category: "domestic",
    tags: ["Alibaba", "JSONP", "DNS"],
    icon: "阿",
    actualDomain: "dns-detect.alicdn.com",
  },
  {
    id: "netease-nosdn",
    name: "NetEase NOS CDN",
    url: "https://necaptcha.nosdn.127.net/ab7f4275c1744aa28e0a8f3a1c58c532.png",
    kind: "header-ip",
    category: "domestic",
    tags: ["NetEase", "cdn-user-ip"],
    icon: "易",
    actualDomain: "necaptcha.nosdn.127.net",
    method: "HEAD",
  },
  {
    id: "bytedance-cn-perfops",
    name: "ByteDance China",
    url: "https://perfops.byte-test.com/500b-bench.jpg",
    kind: "static-header-ip",
    category: "domestic",
    tags: ["ByteDance", "static", "x-request-ip"],
    icon: "抖",
    actualDomain: "perfops.byte-test.com",
    method: "HEAD",
  },
  {
    id: "tencent-ip2city",
    name: "Tencent IP2City",
    url: "https://r.inews.qq.com/api/ip2city?otype=jsonp",
    kind: "tencent-ip2city-jsonp",
    category: "domestic",
    tags: ["Tencent", "JSONP"],
    icon: "腾",
    actualDomain: "r.inews.qq.com",
  },
  {
    id: "cloudflare-cn",
    name: "Cloudflare China Network",
    url: "https://perfops.cloudflareperf.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "domestic",
    tags: ["Cloudflare", "China", "trace"],
    icon: "中",
    actualDomain: "perfops.cloudflareperf.com",
  },
  {
    id: "qualcomm-cn",
    name: "Qualcomm China",
    url: "https://www.qualcomm.cn/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "domestic",
    tags: ["Qualcomm", "China", "trace"],
    icon: "Q",
    actualDomain: "www.qualcomm.cn",
  },
  {
    id: "cloudflare-www",
    name: "Cloudflare",
    url: "https://ip.skk.moe/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["Cloudflare", "trace"],
    icon: "CF",
    actualDomain: "ip.skk.moe",
  },
  {
    id: "bytedance-global-perfops",
    name: "ByteDance Global",
    url: "https://perfops2.byte-test.com/500b-bench.jpg",
    kind: "static-header-ip",
    category: "international",
    tags: ["ByteDance", "global", "static"],
    icon: "BD",
    actualDomain: "perfops2.byte-test.com",
    method: "HEAD",
  },
  {
    id: "discord",
    name: "Discord",
    url: "https://gateway.discord.gg/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["social", "trace"],
    icon: "D",
    actualDomain: "gateway.discord.gg",
  },
  {
    id: "visa",
    name: "Visa",
    url: "https://www.visa.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["finance", "trace"],
    icon: "V",
    actualDomain: "www.visa.com",
  },
  {
    id: "x",
    name: "X",
    url: "https://x.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["social", "trace"],
    icon: "X",
    actualDomain: "x.com",
  },
  {
    id: "medium",
    name: "Medium",
    url: "https://medium.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["publishing", "trace"],
    icon: "M",
    actualDomain: "medium.com",
  },
  {
    id: "gitlab",
    name: "GitLab",
    url: "https://gitlab.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["developer", "trace"],
    icon: "GL",
    actualDomain: "gitlab.com",
  },
  {
    id: "nodejs",
    name: "Node.js",
    url: "https://nodejs.org/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["developer", "trace"],
    icon: "JS",
    actualDomain: "nodejs.org",
  },
  {
    id: "crunchyroll",
    name: "Crunchyroll",
    url: "https://crunchyroll.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "international",
    tags: ["streaming", "trace"],
    icon: "CR",
    actualDomain: "crunchyroll.com",
  },
  {
    id: "chatgpt",
    name: "ChatGPT",
    url: "https://chatgpt.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["OpenAI", "trace"],
    icon: "AI",
    actualDomain: "chatgpt.com",
  },
  {
    id: "sora",
    name: "Sora",
    url: "https://sora.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["OpenAI", "video", "trace"],
    icon: "SO",
    actualDomain: "sora.com",
  },
  {
    id: "openai",
    name: "OpenAI",
    url: "https://openai.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["OpenAI", "trace"],
    icon: "OA",
    actualDomain: "openai.com",
  },
  {
    id: "claude-ai",
    name: "Claude",
    url: "https://claude.ai/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["Anthropic", "trace"],
    icon: "C",
    actualDomain: "claude.ai",
  },
  {
    id: "grok",
    name: "Grok",
    url: "https://grok.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["xAI", "trace"],
    icon: "G",
    actualDomain: "grok.com",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    url: "https://anthropic.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["Anthropic", "trace"],
    icon: "AN",
    actualDomain: "anthropic.com",
  },
  {
    id: "perplexity",
    name: "Perplexity",
    url: "https://www.perplexity.ai/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "ai",
    tags: ["AI search", "trace"],
    icon: "P",
    actualDomain: "www.perplexity.ai",
  },
  {
    id: "e-hentai",
    name: "E-Hentai",
    url: "https://e-hentai.org/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "EH",
    actualDomain: "e-hentai.org",
  },
  {
    id: "missav-ws",
    name: "MissAV WS",
    url: "https://missav.ws/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "MV",
    actualDomain: "missav.ws",
  },
  {
    id: "missav-ai",
    name: "MissAV AI",
    url: "https://missav.ai/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "MV",
    actualDomain: "missav.ai",
  },
  {
    id: "missav-live",
    name: "MissAV Live",
    url: "https://missav.live/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "MV",
    actualDomain: "missav.live",
  },
  {
    id: "hanime1-me",
    name: "Hanime1.me",
    url: "https://hanime1.me/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "H1",
    actualDomain: "hanime1.me",
  },
  {
    id: "hanimeone-me",
    name: "Hanimeone.me",
    url: "https://hanimeone.me/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "HN",
    actualDomain: "hanimeone.me",
  },
  {
    id: "hanime1-com",
    name: "Hanime1.com",
    url: "https://hanime1.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "H1",
    actualDomain: "hanime1.com",
  },
  {
    id: "javchu",
    name: "JavChu",
    url: "https://javchu.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "JC",
    actualDomain: "javchu.com",
  },
  {
    id: "jkforum-av",
    name: "JKForum AV",
    url: "https://av.jkforum.net/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "forum", "trace"],
    icon: "JK",
    actualDomain: "av.jkforum.net",
  },
  {
    id: "javdb",
    name: "JavDB",
    url: "https://javdb.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "nsfw",
    tags: ["NSFW", "trace"],
    icon: "JD",
    actualDomain: "javdb.com",
  },
  {
    id: "coinbase",
    name: "Coinbase",
    url: "https://coinbase.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "crypto",
    tags: ["exchange", "trace"],
    icon: "CB",
    actualDomain: "coinbase.com",
  },
  {
    id: "okx",
    name: "OKX",
    url: "https://www.okx.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "crypto",
    tags: ["exchange", "trace"],
    icon: "OK",
    actualDomain: "www.okx.com",
  },
  {
    id: "jsdelivr",
    name: "jsDelivr",
    url: "https://testingcf.jsdelivr.net/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "static",
    tags: ["CDN", "static", "trace"],
    icon: "JS",
    actualDomain: "testingcf.jsdelivr.net",
  },
  {
    id: "cdnjs",
    name: "cdnjs",
    url: "https://cdnjs.cloudflare.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "static",
    tags: ["CDN", "Cloudflare", "trace"],
    icon: "CD",
    actualDomain: "cdnjs.cloudflare.com",
  },
  {
    id: "cloudflare-mirrors",
    name: "Cloudflare Mirrors",
    url: "https://cloudflaremirrors.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "static",
    tags: ["mirror", "Cloudflare", "trace"],
    icon: "CM",
    actualDomain: "cloudflaremirrors.com",
  },
  {
    id: "npm-registry",
    name: "npm Registry",
    url: "https://registry.npmjs.org/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "static",
    tags: ["developer", "package", "trace"],
    icon: "npm",
    actualDomain: "registry.npmjs.org",
  },
  {
    id: "kali-download",
    name: "Kali Download",
    url: "https://kali.download/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "static",
    tags: ["linux", "mirror", "trace"],
    icon: "K",
    actualDomain: "kali.download",
  },
  {
    id: "unpkg",
    name: "UNPKG",
    url: "https://app.unpkg.com/cdn-cgi/trace",
    kind: "cloudflare-trace",
    category: "static",
    tags: ["CDN", "package", "trace"],
    icon: "U",
    actualDomain: "app.unpkg.com",
  },
];

export const BUILTIN_GITHUB_MIRROR_PROVIDERS: GithubMirrorProvider[] = [
  { id: "gh-proxy-com", name: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
  { id: "gh-qfmc0721", name: "gh.qfmc0721.cc.cd", prefix: "https://gh.qfmc0721.cc.cd/" },
  { id: "g-z321-cc-cd", name: "g.z321.cc.cd", prefix: "https://g.z321.cc.cd/" },
  { id: "github-tbap-top", name: "github.tbap.top", prefix: "https://github.tbap.top/" },
  { id: "gh-proxy-org", name: "gh-proxy.org", prefix: "https://gh-proxy.org/" },
  { id: "ghproxy-net", name: "ghproxy.net", prefix: "https://ghproxy.net/" },
];

/** The mirror a fresh install starts on; `DEFAULT_GITHUB_MIRROR_PROVIDER_ID` still means "off". */
export const PREFERRED_GITHUB_MIRROR_PROVIDER_ID: Exclude<GithubMirrorProviderId, "off" | "auto-best" | "custom"> = "gh-proxy-com";

/**
 * Providers retired from the list. Their ids still normalize to a working mirror, because a stored
 * setting would otherwise fall back to "off" and silently stop accelerating anything.
 */
const RETIRED_GITHUB_MIRROR_PROVIDER_IDS: Record<string, Exclude<GithubMirrorProviderId, "off" | "auto-best" | "custom">> = {
  "ghproxy-vip": "gh-proxy-com",
  "ghfast-top": "gh-proxy-com",
  "gh-proxy-lipk": "gh-proxy-com",
};

export const GITHUB_MIRROR_PROVIDER_IDS: readonly GithubMirrorProviderId[] = [
  "off",
  "auto-best",
  ...BUILTIN_GITHUB_MIRROR_PROVIDERS.map((provider) => provider.id),
  "custom",
];

export const FORCED_UI_FONT_FAMILY =
  '"SarasaUiSC-Regular", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
export const DEFAULT_MONO_FONT_FAMILY = "Consolas, \"Cascadia Mono\", \"JetBrains Mono\", monospace";

export const BUILTIN_CLOAKBROWSER_ENV_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_LICENSE_KEY",
  "CLOAKBROWSER_RELEASE_CHANNEL",
] as const;

export type BuiltinCloakBrowserEnvKey = (typeof BUILTIN_CLOAKBROWSER_ENV_KEYS)[number];

/**
 * Variables the panel owns outright. A stored row for one of these is dropped during normalization:
 * there is no setting it could legitimately override, and keeping it would suggest it still applies.
 */
export const MANAGED_CLOAKBROWSER_ENV_KEYS = [
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_AUTO_UPDATE",
] as const;

export type ManagedCloakBrowserEnvKey = (typeof MANAGED_CLOAKBROWSER_ENV_KEYS)[number];

/**
 * Variables with a dedicated control that a custom row would silently outrank (`custom` wins over
 * `settings` in env resolution). New rows are refused; a row that already exists stays visible and
 * is not edited from here, so the operator can see why the panel setting appears not to apply.
 */
export const PANEL_SETTING_CLOAKBROWSER_ENV_KEYS = [
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_RELEASE_CHANNEL",
  "CLOAKBROWSER_LICENSE_KEY",
] as const;

export type PanelSettingCloakBrowserEnvKey = (typeof PANEL_SETTING_CLOAKBROWSER_ENV_KEYS)[number];

export const CLOAKBROWSER_ENV_SUGGESTION_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_SUPPRESS_FONT_WARNING",
] as const;

export type CloakBrowserEnvSuggestionKey = (typeof CLOAKBROWSER_ENV_SUGGESTION_KEYS)[number];

export const DEFAULT_APP_SETTINGS: AppSettings = {
  appearance: {
    theme: "system",
    language: "system",
    density: "comfortable",
    uiFontFamily: FORCED_UI_FONT_FAMILY,
    monoFontFamily: DEFAULT_MONO_FONT_FAMILY,
    baseFontSize: 16,
    tableFontSize: 15,
    codeFontSize: 14,
  },
  table: {
    columns: DEFAULT_PROFILE_COLUMNS,
    sort: {
      columnId: "updatedAt",
      direction: "desc",
    },
    showInspector: false,
    pageSize: 25,
  },
  desktop: {
    advancedWebEntry: false,
    closeBehavior: "ask",
    platformChrome: "native",
    sidebarMode: "expanded",
  },
  binary: {
    lastUpdateCheck: undefined,
    customBinaryPathEnabled: false,
    customBinaryPath: "",
    cacheDirMode: "auto",
    customCacheDir: "",
    tierMode: "pro",
    licenseKey: "",
    browserVersionMode: "latest",
    pinnedBrowserVersion: "",
    releaseChannel: "stable",
    customEnvVars: [
      {
        id: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
        key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
        value: "20",
        enabled: true,
        sensitive: false,
        description: "",
        valueKind: "number",
      },
    ],
    coreChannel: "official",
    coreChannelMode: "online",
    privateRepositoryUrl: "",
    privateChannelUnlocked: false,
    privateReleaseVersion: undefined,
  },
  networkTrace: {
    providerId: DEFAULT_NETWORK_TRACE_PROVIDER_ID,
    customProviderUrl: "",
    timeoutSeconds: 8,
    githubMirrorProviderId: DEFAULT_GITHUB_MIRROR_PROVIDER_ID,
    customGithubMirrorPrefix: "",
  },
  extensionAcquisition: {
    artifactProviderId: "crxsoso",
    crxsosoDisclosureVersionAccepted: 0,
  },
  xray: {
    customBinaryPath: "",
    nativeProxyRouting: "auto",
    logLevel: "warning",
    utlsFingerprint: "auto",
    checkForUpdatesOnStartup: false,
    lastUpdateCheck: undefined,
  },
  appUpdate: {
    lastUpdateCheck: undefined,
  },
};

export function normalizeSettings(input: AppSettingsPatch = {}): AppSettings {
  const base = DEFAULT_APP_SETTINGS;
  const appearance: Partial<AppearanceSettings> = input.appearance ?? {};
  const table: Partial<TableSettings> = input.table ?? {};
  const desktop: Partial<DesktopSettings> = input.desktop ?? {};
  const binary: Partial<BinarySettings> = input.binary ?? {};
  const networkTrace: Partial<NetworkTraceSettings> = input.networkTrace ?? {};
  const extensionAcquisition: Partial<ExtensionAcquisitionSettings> = input.extensionAcquisition ?? {};
  const xray: Partial<XraySettings> = input.xray ?? {};
  const appUpdate: Partial<AppUpdateSettings> = input.appUpdate ?? {};
  const closeBehavior = normalizeDesktopCloseBehavior(desktop.closeBehavior, base.desktop.closeBehavior);
  const customEnvVars = normalizeCustomEnvVars(
    binary.customEnvVars === undefined ? base.binary.customEnvVars : binary.customEnvVars,
  );
  const licenseKey = normalizeLicenseKey(binary.licenseKey, base.binary.licenseKey);

  return {
    appearance: {
      theme: enumValue(appearance.theme, ["system", "light", "dark"], base.appearance.theme),
      language: enumValue(appearance.language, ["system", "zh-CN", "en-US"], base.appearance.language),
      density: enumValue(appearance.density, ["compact", "comfortable"], base.appearance.density),
      uiFontFamily: normalizeUiFontFamily(appearance.uiFontFamily),
      monoFontFamily: stringValue(appearance.monoFontFamily, base.appearance.monoFontFamily),
      baseFontSize: normalizeFontSize(appearance.baseFontSize, 14, 12, 22, base.appearance.baseFontSize),
      tableFontSize: normalizeFontSize(appearance.tableFontSize, 13, 11, 20, base.appearance.tableFontSize),
      codeFontSize: normalizeFontSize(appearance.codeFontSize, 12, 11, 20, base.appearance.codeFontSize),
    },
    table: {
      columns: normalizeColumns(table.columns),
      sort: normalizeSort(table.sort),
      showInspector: booleanValue(table.showInspector, base.table.showInspector),
      pageSize: normalizePageSize(table.pageSize, base.table.pageSize),
    },
    desktop: {
      advancedWebEntry: booleanValue(desktop.advancedWebEntry, base.desktop.advancedWebEntry),
      closeBehavior,
      platformChrome: enumValue(desktop.platformChrome, ["native", "custom"], base.desktop.platformChrome),
      sidebarMode: enumValue(desktop.sidebarMode, ["expanded", "collapsed"], base.desktop.sidebarMode),
    },
    binary: {
      lastUpdateCheck: normalizeBrowserCoreUpdateCheck(binary.lastUpdateCheck),
      customBinaryPathEnabled: booleanValue(binary.customBinaryPathEnabled, base.binary.customBinaryPathEnabled),
      customBinaryPath: stringValueAllowEmpty(binary.customBinaryPath, base.binary.customBinaryPath),
      cacheDirMode: enumValue(binary.cacheDirMode, ["auto", "custom"], base.binary.cacheDirMode),
      customCacheDir: stringValueAllowEmpty(binary.customCacheDir, base.binary.customCacheDir),
      tierMode: "pro",
      licenseKey,
      browserVersionMode: enumValue(binary.browserVersionMode, ["latest", "pinned"], base.binary.browserVersionMode),
      pinnedBrowserVersion: normalizeBrowserVersionPin(binary.pinnedBrowserVersion, base.binary.pinnedBrowserVersion),
      releaseChannel: enumValue(binary.releaseChannel, ["stable", "preview"], base.binary.releaseChannel),
      customEnvVars,
      coreChannel: enumValue(binary.coreChannel, ["official", "private"], base.binary.coreChannel),
      coreChannelMode: enumValue(binary.coreChannelMode, ["online", "offline"], base.binary.coreChannelMode),
      privateRepositoryUrl: stringValueAllowEmpty(binary.privateRepositoryUrl, base.binary.privateRepositoryUrl),
      privateChannelUnlocked: booleanValue(binary.privateChannelUnlocked, base.binary.privateChannelUnlocked),
      privateReleaseVersion: normalizeOptionalBrowserVersion(binary.privateReleaseVersion),
    },
    networkTrace: normalizeNetworkTraceSettings(networkTrace),
    extensionAcquisition: {
      artifactProviderId: normalizeExtensionArtifactProviderId(extensionAcquisition),
      crxsosoDisclosureVersionAccepted: normalizeDisclosureVersion(
        extensionAcquisition.crxsosoDisclosureVersionAccepted,
      ),
    },
    xray: {
      customBinaryPath: stringValueAllowEmpty(xray.customBinaryPath, base.xray.customBinaryPath),
      nativeProxyRouting: enumValue(xray.nativeProxyRouting, XRAY_NATIVE_PROXY_ROUTINGS, base.xray.nativeProxyRouting),
      logLevel: enumValue(xray.logLevel, XRAY_LOG_LEVELS, base.xray.logLevel),
      utlsFingerprint: enumValue(xray.utlsFingerprint, XRAY_UTLS_FINGERPRINTS, base.xray.utlsFingerprint),
      checkForUpdatesOnStartup: booleanValue(xray.checkForUpdatesOnStartup, base.xray.checkForUpdatesOnStartup),
      lastUpdateCheck: normalizeXrayUpdateCheck(xray.lastUpdateCheck),
    },
    appUpdate: {
      lastUpdateCheck: normalizeAppUpdateCheck(appUpdate.lastUpdateCheck),
    },
  };
}

function normalizeXrayUpdateCheck(value: unknown): XrayUpdateCheck | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.checkedAt !== "string" || !record.checkedAt.trim()) return undefined;
  const optionalString = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : undefined;
  return {
    checkedAt: record.checkedAt,
    currentVersion: optionalString("currentVersion"),
    latestVersion: optionalString("latestVersion"),
    updateAvailable: record.updateAvailable === true,
    downloadUrl: optionalString("downloadUrl"),
    error: optionalString("error"),
  };
}

export function mergeSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const desktop: DesktopSettings = {
    ...current.desktop,
    ...(patch.desktop ?? {}),
  };

  const extensionPatch = patch.extensionAcquisition;
  const extensionAcquisition = extensionPatch
    ? {
      artifactProviderId:
        extensionPatch.artifactProviderId !== undefined
          ? extensionPatch.artifactProviderId
          : current.extensionAcquisition.artifactProviderId,
      crxsosoDisclosureVersionAccepted:
        extensionPatch.crxsosoDisclosureVersionAccepted
        ?? current.extensionAcquisition.crxsosoDisclosureVersionAccepted,
    }
    : current.extensionAcquisition;

  return normalizeSettings({
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    table: { ...current.table, ...(patch.table ?? {}) },
    desktop,
    binary: { ...current.binary, ...(patch.binary ?? {}) },
    networkTrace: { ...current.networkTrace, ...(patch.networkTrace ?? {}) },
    extensionAcquisition,
    xray: { ...current.xray, ...(patch.xray ?? {}) },
    appUpdate: { ...current.appUpdate, ...(patch.appUpdate ?? {}) },
  });
}

/** Normalize the canonical artifact channel. */
export function normalizeExtensionArtifactProviderId(
  input: Partial<ExtensionAcquisitionSettings> | undefined,
): ExtensionArtifactProviderId {
  return input?.artifactProviderId === "chrome-web-store" ? "chrome-web-store" : "crxsoso";
}

function normalizeDisclosureVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) return 0;
  const version = Number(value);
  return version <= EXTENSION_ACQUISITION_DISCLOSURE_VERSION ? version : 0;
}

export function resolveLanguageMode(mode: LanguageMode, browserLanguage = "en-US"): Exclude<LanguageMode, "system"> {
  if (mode === "zh-CN" || mode === "en-US") return mode;
  return browserLanguage.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

function normalizeColumns(input: unknown): ProfileColumnConfig[] {
  const known = new Map(DEFAULT_PROFILE_COLUMNS.map((column) => [column.id, column]));
  const incoming = Array.isArray(input) ? input : [];
  const byId = new Map<string, Partial<ProfileColumnConfig>>();
  let looksLikeOldProxyIpDefault = false;

  for (const item of incoming) {
    if (!item || typeof item !== "object") continue;
    const column = item as Partial<ProfileColumnConfig>;
    if (typeof column.id !== "string" || !known.has(column.id) || byId.has(column.id)) continue;
    byId.set(column.id, column);
  }

  const incomingProxy = byId.get("proxy");
  const incomingIp = byId.get("ip");
  const incomingStatus = byId.get("status");
  const incomingMode = byId.get("mode");
  const incomingUpdatedAt = byId.get("updatedAt");
  looksLikeOldProxyIpDefault =
    incomingProxy?.visible === true
    && incomingIp?.visible === true
    && (incomingIp.width === undefined || incomingIp.width <= 112);
  const looksLikeOldStatusDefault =
    incomingStatus?.width === undefined || incomingStatus.width === LEGACY_STATUS_DEFAULT_WIDTH;
  const looksLikeOldModeDefault =
    incomingMode?.width === undefined || incomingMode.width === LEGACY_MODE_DEFAULT_WIDTH;
  const looksLikeOldUpdatedAtDefault =
    incomingUpdatedAt?.width === undefined || incomingUpdatedAt.width === LEGACY_UPDATED_AT_DEFAULT_WIDTH;

  const normalized = DEFAULT_PROFILE_COLUMNS.map((fallback) => {
    const column = byId.get(fallback.id);
    const width =
      fallback.id === "select"
        ? 46
        : (fallback.id === "ip" || fallback.id === "proxy") && looksLikeOldProxyIpDefault
          ? fallback.width
        : fallback.id === "status" && looksLikeOldStatusDefault
          ? fallback.width
        : fallback.id === "mode" && looksLikeOldModeDefault
          ? fallback.width
        : fallback.id === "updatedAt" && looksLikeOldUpdatedAtDefault
          ? fallback.width
        : typeof column?.width === "number" && Number.isFinite(column.width)
          ? normalizeColumnWidth(fallback.id, column.width)
          : fallback.width;
    return {
      id: fallback.id,
      visible:
        fallback.id === "select" || fallback.id === "actions"
          ? true
          : fallback.id === "proxy" && looksLikeOldProxyIpDefault
          ? false
          : typeof column?.visible === "boolean"
            ? column.visible
            : fallback.visible,
      width,
      order:
        (fallback.id === "ip" || fallback.id === "proxy") && looksLikeOldProxyIpDefault
          ? fallback.order
        : fallback.id === "select" || fallback.id === "actions"
          ? fallback.order
        :
        typeof column?.order === "number" && Number.isFinite(column.order)
          ? Math.round(column.order)
          : fallback.order,
    };
  });

  return normalized.sort((left, right) => left.order - right.order);
}

function normalizeColumnWidth(columnId: string, width: number): number {
  const minWidth = NARROW_PROFILE_COLUMN_IDS.has(columnId) ? 48 : 64;
  return Math.round(Math.min(360, Math.max(minWidth, width)));
}

function normalizeSort(input: unknown): ProfileSortConfig {
  if (!input || typeof input !== "object") return DEFAULT_APP_SETTINGS.table.sort;
  const sort = input as Partial<ProfileSortConfig>;
  const knownIds = new Set(DEFAULT_PROFILE_COLUMNS.map((column) => column.id));
  return {
    columnId: typeof sort.columnId === "string" && knownIds.has(sort.columnId) ? sort.columnId : "updatedAt",
    direction: enumValue(sort.direction, ["asc", "desc"], "desc"),
  };
}

function normalizePageSize(value: unknown, fallback: number): number {
  return enumNumberValue(value, [25, 50, 100], fallback);
}

export function normalizeNetworkTraceSettings(input: Partial<NetworkTraceSettings> = {}): NetworkTraceSettings {
  const providerId =
    typeof input.providerId === "string"
    && (input.providerId === "custom" || BUILTIN_NETWORK_TRACE_PROVIDERS.some((provider) => provider.id === input.providerId))
      ? input.providerId
      : DEFAULT_NETWORK_TRACE_PROVIDER_ID;
  return {
    providerId,
    customProviderUrl: normalizeTraceUrl(input.customProviderUrl, ""),
    timeoutSeconds: normalizeNumber(input.timeoutSeconds, 8, 2, 30),
    githubMirrorProviderId: normalizeGithubMirrorProviderId(input.githubMirrorProviderId),
    customGithubMirrorPrefix: normalizeUrlPrefix(input.customGithubMirrorPrefix, ""),
  };
}

function normalizeBrowserCoreUpdateCheck(value: unknown): BrowserCoreUpdateCheck | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<BrowserCoreUpdateCheck>;
  const checkedAt = stringValueAllowEmpty(input.checkedAt, "");
  const currentVersion = stringValueAllowEmpty(input.currentVersion, "");
  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt)) || typeof input.currentVersion !== "string" || typeof input.updateAvailable !== "boolean") {
    return undefined;
  }
  const latestVersion = stringValueAllowEmpty(input.latestVersion, "");
  const error = stringValueAllowEmpty(input.error, "");
  const blockedReason = stringValueAllowEmpty(input.blockedReason, "");
  return {
    checkedAt,
    targetTier: optionalEnumValue<NonNullable<BrowserCoreUpdateCheck["targetTier"]>>(input.targetTier, ["free", "pro"]),
    versionMode: optionalEnumValue<NonNullable<BrowserCoreUpdateCheck["versionMode"]>>(input.versionMode, ["latest", "pinned"]),
    currentVersion,
    latestVersion: latestVersion || undefined,
    updateAvailable: input.updateAvailable,
    blockedReason: blockedReason || undefined,
    // A code, so an unknown one is dropped rather than carried into the panel as an untranslatable
    // caveat. Dropping only the caveat and keeping the check is deliberate: the comparison itself is
    // still the last thing the server actually did.
    baselineCaveat: optionalEnumValue<NonNullable<BrowserCoreUpdateCheck["baselineCaveat"]>>(
      input.baselineCaveat,
      ["offline-import-tier-mismatch"],
    ),
    error: error || undefined,
    errorCode: typeof input.errorCode === "string" ? input.errorCode : undefined,
  };
}

function normalizeAppUpdateCheck(value: unknown): AppUpdateCheck | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const attemptedAt = stringValueAllowEmpty(record.attemptedAt, "");
  if (!attemptedAt || !Number.isFinite(Date.parse(attemptedAt))) return undefined;
  if (typeof record.currentVersion !== "string" || typeof record.updateAvailable !== "boolean") return undefined;
  const optionalString = (key: string): string | undefined =>
    typeof record[key] === "string" && (record[key] as string).trim() ? (record[key] as string).trim() : undefined;
  const checkedAt = optionalString("checkedAt");
  return {
    attemptedAt,
    checkedAt: checkedAt && Number.isFinite(Date.parse(checkedAt)) ? checkedAt : undefined,
    currentVersion: record.currentVersion.trim(),
    latestVersion: optionalString("latestVersion"),
    updateAvailable: record.updateAvailable,
    releaseUrl: normalizeAppUpdateReleaseUrl(optionalString("releaseUrl")),
    download: normalizeAppUpdateDownload(record.download),
    error: optionalString("error"),
    errorCode: optionalString("errorCode"),
  };
}

function normalizeAppUpdateReleaseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "github.com" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function normalizeAppUpdateDownload(value: unknown): AppUpdateCheck["download"] | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (typeof kind !== "string" || !(APP_UPDATE_ARTIFACT_KINDS as readonly string[]).includes(kind)) return undefined;
  const fileName = typeof record.fileName === "string" ? record.fileName.trim() : "";
  const url = typeof record.url === "string" ? record.url.trim() : "";
  if (!fileName || !url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== "github.com") return undefined;
  } catch {
    return undefined;
  }
  return {
    kind: kind as NonNullable<AppUpdateCheck["download"]>["kind"],
    fileName,
    url,
    sha256: typeof record.sha256 === "string" && /^[a-f0-9]{64}$/i.test(record.sha256) ? record.sha256.toLowerCase() : undefined,
    size: typeof record.size === "number" && Number.isFinite(record.size) && record.size >= 0 ? record.size : undefined,
  };
}

export function resolveNetworkTraceProvider(input: Partial<NetworkTraceSettings> = {}): NetworkTraceProvider {
  const settings = normalizeNetworkTraceSettings(input);
  if (settings.providerId === "custom" && settings.customProviderUrl) {
    return {
      id: "custom",
      name: "Custom",
      url: settings.customProviderUrl,
      kind: "cloudflare-trace",
      category: "static",
      tags: ["custom", "trace"],
      icon: "*",
    };
  }
  return BUILTIN_NETWORK_TRACE_PROVIDERS.find((provider) => provider.id === settings.providerId)
    ?? BUILTIN_NETWORK_TRACE_PROVIDERS.find((provider) => provider.id === DEFAULT_NETWORK_TRACE_PROVIDER_ID)
    ?? BUILTIN_NETWORK_TRACE_PROVIDERS[0];
}

export function resolveGithubMirrorPrefix(input: Partial<NetworkTraceSettings> = {}): string | undefined {
  const settings = normalizeNetworkTraceSettings(input);
  if (settings.githubMirrorProviderId === "off") return undefined;
  if (settings.githubMirrorProviderId === "auto-best") return undefined;
  if (settings.githubMirrorProviderId === "custom") return settings.customGithubMirrorPrefix || undefined;
  return BUILTIN_GITHUB_MIRROR_PROVIDERS.find((provider) => provider.id === settings.githubMirrorProviderId)?.prefix;
}

function enumNumberValue(value: unknown, allowed: readonly number[], fallback: number): number {
  return typeof value === "number" && allowed.includes(value) ? value : fallback;
}

/**
 * A retired mirror keeps accelerating: mapping it forward is the only outcome that neither drops
 * the operator's acceleration nor asks them to notice a setting they never touched.
 */
function normalizeGithubMirrorProviderId(value: unknown): GithubMirrorProviderId {
  const retired = typeof value === "string" ? RETIRED_GITHUB_MIRROR_PROVIDER_IDS[value] : undefined;
  return retired ?? enumValue(value, GITHUB_MIRROR_PROVIDER_IDS, DEFAULT_GITHUB_MIRROR_PROVIDER_ID);
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function enumValue<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : fallback;
}

function optionalEnumValue<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && allowed.includes(value as T) ? (value as T) : undefined;
}

function normalizeDesktopCloseBehavior(closeBehavior: unknown, fallback: DesktopCloseBehavior): DesktopCloseBehavior {
  if (closeBehavior === "ask" || closeBehavior === "tray" || closeBehavior === "quit") return closeBehavior;
  return fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringValueAllowEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeLicenseKey(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function normalizeBrowserVersionPin(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /^[0-9]+(?:\.[0-9]+){3,4}$/.test(trimmed) ? trimmed : fallback;
}

function normalizeOptionalBrowserVersion(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[0-9]+(?:\.[0-9]+){4}$/.test(trimmed) ? trimmed : undefined;
}

function normalizeTraceUrl(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : fallback;
  } catch {
    return fallback;
  }
}

function normalizeUrlPrefix(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return fallback;
    return `${url.toString().replace(/\/+$/, "")}/`;
  } catch {
    return fallback;
  }
}

function normalizeUiFontFamily(value: unknown): string {
  const family = stringValue(value, FORCED_UI_FONT_FAMILY);
  const withoutDuplicateSarasa = family
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item && item !== '"SarasaUiSC-Regular"');
  return ['"SarasaUiSC-Regular"', ...withoutDuplicateSarasa].join(", ");
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

function normalizeFontSize(value: unknown, oldDefault: number, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (Math.round(value) === oldDefault) return fallback;
  return clampNumber(value, min, max, fallback);
}


function normalizeCustomEnvVars(value: unknown): BrowserCoreEnvVarSetting[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const managed = new Set<string>(MANAGED_CLOAKBROWSER_ENV_KEYS);
  const result: BrowserCoreEnvVarSetting[] = [];

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const input = item as Partial<BrowserCoreEnvVarSetting>;
    const key = normalizeCloakBrowserEnvKey(input.key);
    if (!key || managed.has(key) || seen.has(key)) continue;
    seen.add(key);
    result.push({
      id: typeof input.id === "string" && input.id.trim() ? input.id.trim() : key,
      key,
      value: typeof input.value === "string" ? input.value : "",
      enabled: booleanValue(input.enabled, true),
      sensitive: booleanValue(input.sensitive, defaultEnvSensitive(key)),
      description: typeof input.description === "string" ? input.description.trim() : "",
      valueKind: enumValue(
        input.valueKind,
        ["text", "path", "directory", "url", "boolean", "number", "secret"],
        defaultEnvSensitive(key) || input.sensitive ? "secret" : defaultEnvValueKind(key),
      ),
    });
  }

  return result;
}

function defaultEnvSensitive(key: string): boolean {
  return /TOKEN|SECRET|PASSWORD|CREDENTIAL|KEY/i.test(key);
}

function defaultEnvValueKind(key: string): BrowserCoreEnvValueKind {
  if (key === "CLOAKBROWSER_LICENSE_KEY") return "secret";
  if (key === "CLOAKBROWSER_VERSION") return "text";
  if (key.endsWith("_DIR") || key.endsWith("_CDM")) return "directory";
  if (key.endsWith("_URL")) return "url";
  if (key.endsWith("_SECONDS") || key.endsWith("_TIMEOUT")) return "number";
  return "text";
}

export function normalizeCloakBrowserEnvKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const input = value.trim().toUpperCase();
  if (!input) return undefined;
  const key = input.startsWith("CLOAKBROWSER_") ? input : `CLOAKBROWSER_${input}`;
  if (!/^CLOAKBROWSER_[A-Z0-9_]+$/.test(key)) return undefined;
  if (key === "CLOAKBROWSER_DOWNLOAD_URL" || key === "CLOAKBROWSER_SKIP_CHECKSUM") return undefined;
  return key;
}

export function isBuiltinCloakBrowserEnvKey(value: unknown): value is BuiltinCloakBrowserEnvKey {
  return typeof value === "string" && (BUILTIN_CLOAKBROWSER_ENV_KEYS as readonly string[]).includes(value);
}

export function isManagedCloakBrowserEnvKey(value: unknown): value is ManagedCloakBrowserEnvKey {
  return typeof value === "string" && (MANAGED_CLOAKBROWSER_ENV_KEYS as readonly string[]).includes(value);
}

/** A key whose value the panel's own controls own; adding a row for it is refused at the editor. */
export function isPanelSettingCloakBrowserEnvKey(value: unknown): value is PanelSettingCloakBrowserEnvKey {
  return typeof value === "string" && (PANEL_SETTING_CLOAKBROWSER_ENV_KEYS as readonly string[]).includes(value);
}
