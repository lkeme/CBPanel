import type { BrowserCoreUpdateCheck } from "./browserCore";

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
export type BrowserCoreDownloadSourceMode = "official" | "custom";
export type BrowserCoreChecksumPolicy = "strict" | "skip";
export type BrowserCoreTierMode = "free" | "pro";
export type BrowserCoreVersionMode = "latest" | "pinned";
export type BrowserCoreEnvValueKind = "text" | "path" | "directory" | "url" | "boolean" | "number" | "secret";
export type GithubMirrorProviderId =
  | "off"
  | "auto-best"
  | "gh-proxy-lipk"
  | "ghfast-top"
  | "ghproxy-net"
  | "ghproxy-vip"
  | "gh-proxy-com"
  | "custom";

export interface AppSettings {
  appearance: AppearanceSettings;
  table: TableSettings;
  desktop: DesktopSettings;
  storage: StorageSettings;
  binary: BinarySettings;
  networkTrace: NetworkTraceSettings;
}

export type AppSettingsPatch = {
  [Key in keyof AppSettings]?: Partial<AppSettings[Key]>;
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
  closeToTray: boolean;
  platformChrome: PlatformChrome;
  rememberWindowState: boolean;
  sidebarMode: SidebarMode;
}

export interface StorageSettings {
  primary: "sqlite";
  autoMigrateLegacyJson: boolean;
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
  envSettingsVersion: number;
  checkForUpdatesOnStartup: boolean;
  lastUpdateCheck?: BrowserCoreUpdateCheck;
  preferExistingCache: boolean;
  customBinaryPathEnabled: boolean;
  customBinaryPath: string;
  cacheDirMode: BrowserCoreCacheDirMode;
  customCacheDir: string;
  downloadSourceMode: BrowserCoreDownloadSourceMode;
  customDownloadBaseUrl: string;
  tierMode: BrowserCoreTierMode;
  licenseKey: string;
  browserVersionMode: BrowserCoreVersionMode;
  pinnedBrowserVersion: string;
  internalAutoUpdate: boolean;
  checksumPolicy: BrowserCoreChecksumPolicy;
  geoipTimeoutSeconds: number | null;
  customEnvVars: BrowserCoreEnvVarSetting[];
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
  kind: "json" | "sqlite";
  databasePath?: string;
  legacyJsonPath?: string;
  migrationBackupPath?: string;
  migrationError?: string;
  portable: boolean;
  migratedFromJson: boolean;
}

export interface DesktopRuntimeInfo {
  shell: ShellMode;
  platform: RuntimePlatform;
  chrome: PlatformChrome;
  portable: boolean;
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
  { id: "launcher", visible: false, width: 140, order: 80 },
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
  { id: "gh-proxy-lipk", name: "gh-proxy.lipk.org", prefix: "https://gh-proxy.lipk.org/" },
  { id: "ghfast-top", name: "ghfast.top", prefix: "https://ghfast.top/" },
  { id: "ghproxy-net", name: "ghproxy.net", prefix: "https://ghproxy.net/" },
  { id: "ghproxy-vip", name: "ghproxy.vip", prefix: "https://ghproxy.vip/" },
  { id: "gh-proxy-com", name: "gh-proxy.com", prefix: "https://gh-proxy.com/" },
];

export const FORCED_UI_FONT_FAMILY =
  '"SarasaUiSC-Regular", "Segoe UI Variable", "Segoe UI", "Microsoft YaHei UI", system-ui, sans-serif';
export const DEFAULT_MONO_FONT_FAMILY = "Consolas, \"Cascadia Mono\", \"JetBrains Mono\", monospace";

export const BUILTIN_CLOAKBROWSER_ENV_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_DOWNLOAD_URL",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_SKIP_CHECKSUM",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_LICENSE_KEY",
] as const;

export type BuiltinCloakBrowserEnvKey = (typeof BUILTIN_CLOAKBROWSER_ENV_KEYS)[number];

export const OPTIONAL_CLOAKBROWSER_ENV_KEYS = [
  "CLOAKBROWSER_BINARY_PATH",
  "CLOAKBROWSER_DOWNLOAD_URL",
  "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
  "CLOAKBROWSER_VERSION",
  "CLOAKBROWSER_LICENSE_KEY",
] as const;

export type OptionalCloakBrowserEnvKey = (typeof OPTIONAL_CLOAKBROWSER_ENV_KEYS)[number];

export const MANAGED_CLOAKBROWSER_ENV_KEYS = [
  "CLOAKBROWSER_CACHE_DIR",
  "CLOAKBROWSER_AUTO_UPDATE",
  "CLOAKBROWSER_SKIP_CHECKSUM",
] as const;

export type ManagedCloakBrowserEnvKey = (typeof MANAGED_CLOAKBROWSER_ENV_KEYS)[number];

export const CLOAKBROWSER_ENV_SUGGESTION_KEYS = [
  ...OPTIONAL_CLOAKBROWSER_ENV_KEYS,
  "CLOAKBROWSER_WIDEVINE_CDM",
  "CLOAKBROWSER_WIDEVINE",
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
    closeToTray: false,
    platformChrome: "native",
    rememberWindowState: true,
    sidebarMode: "expanded",
  },
  storage: {
    primary: "sqlite",
    autoMigrateLegacyJson: true,
  },
  binary: {
    envSettingsVersion: 1,
    checkForUpdatesOnStartup: true,
    lastUpdateCheck: undefined,
    preferExistingCache: true,
    customBinaryPathEnabled: false,
    customBinaryPath: "",
    cacheDirMode: "auto",
    customCacheDir: "",
    downloadSourceMode: "official",
    customDownloadBaseUrl: "",
    tierMode: "free",
    licenseKey: "",
    browserVersionMode: "latest",
    pinnedBrowserVersion: "",
    internalAutoUpdate: false,
    checksumPolicy: "strict",
    geoipTimeoutSeconds: 12,
    customEnvVars: [
      {
        id: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
        key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
        value: "12",
        enabled: true,
        sensitive: false,
        description: "",
        valueKind: "number",
      },
    ],
  },
  networkTrace: {
    providerId: DEFAULT_NETWORK_TRACE_PROVIDER_ID,
    customProviderUrl: "",
    timeoutSeconds: 8,
    githubMirrorProviderId: DEFAULT_GITHUB_MIRROR_PROVIDER_ID,
    customGithubMirrorPrefix: "",
  },
};

export function normalizeSettings(input: AppSettingsPatch = {}): AppSettings {
  const base = DEFAULT_APP_SETTINGS;
  const appearance: Partial<AppearanceSettings> = input.appearance ?? {};
  const table: Partial<TableSettings> = input.table ?? {};
  const desktop: Partial<DesktopSettings> = input.desktop ?? {};
  const storage: Partial<StorageSettings> = input.storage ?? {};
  const binary: Partial<BinarySettings> = input.binary ?? {};
  const networkTrace: Partial<NetworkTraceSettings> = input.networkTrace ?? {};
  const closeBehavior = normalizeDesktopCloseBehavior(
    desktop.closeBehavior,
    desktop.closeToTray,
    base.desktop.closeBehavior,
  );
  const envSettingsVersion = normalizeEnvSettingsVersion(binary.envSettingsVersion);
  const customEnvVars = normalizeBrowserCoreEnvVars(
    binary.customEnvVars === undefined ? base.binary.customEnvVars : binary.customEnvVars,
    envSettingsVersion,
    binary.geoipTimeoutSeconds,
  );

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
      closeToTray: closeBehavior === "tray",
      platformChrome: enumValue(desktop.platformChrome, ["native", "custom"], base.desktop.platformChrome),
      rememberWindowState: booleanValue(desktop.rememberWindowState, base.desktop.rememberWindowState),
      sidebarMode: enumValue(desktop.sidebarMode, ["expanded", "collapsed"], base.desktop.sidebarMode),
    },
    storage: {
      primary: "sqlite",
      autoMigrateLegacyJson: booleanValue(storage.autoMigrateLegacyJson, base.storage.autoMigrateLegacyJson),
    },
    binary: {
      envSettingsVersion: 1,
      checkForUpdatesOnStartup: booleanValue(
        binary.checkForUpdatesOnStartup ?? (binary as { autoCheckUpdates?: unknown }).autoCheckUpdates,
        base.binary.checkForUpdatesOnStartup,
      ),
      lastUpdateCheck: normalizeBrowserCoreUpdateCheck(binary.lastUpdateCheck),
      preferExistingCache: booleanValue(binary.preferExistingCache, base.binary.preferExistingCache),
      customBinaryPathEnabled: booleanValue(binary.customBinaryPathEnabled, base.binary.customBinaryPathEnabled),
      customBinaryPath: stringValueAllowEmpty(binary.customBinaryPath, base.binary.customBinaryPath),
      cacheDirMode: enumValue(binary.cacheDirMode, ["auto", "custom"], base.binary.cacheDirMode),
      customCacheDir: stringValueAllowEmpty(binary.customCacheDir, base.binary.customCacheDir),
      downloadSourceMode: enumValue(binary.downloadSourceMode, ["official", "custom"], base.binary.downloadSourceMode),
      customDownloadBaseUrl: normalizeUrlBase(binary.customDownloadBaseUrl, base.binary.customDownloadBaseUrl),
      tierMode: enumValue(binary.tierMode, ["free", "pro"], base.binary.tierMode),
      licenseKey: normalizeLicenseKey(binary.licenseKey, base.binary.licenseKey),
      browserVersionMode: enumValue(binary.browserVersionMode, ["latest", "pinned"], base.binary.browserVersionMode),
      pinnedBrowserVersion: normalizeBrowserVersionPin(binary.pinnedBrowserVersion, base.binary.pinnedBrowserVersion),
      internalAutoUpdate: booleanValue(binary.internalAutoUpdate, base.binary.internalAutoUpdate),
      checksumPolicy: enumValue(binary.checksumPolicy, ["strict", "skip"], base.binary.checksumPolicy),
      geoipTimeoutSeconds: normalizeNullableNumber(binary.geoipTimeoutSeconds, 1, 60, base.binary.geoipTimeoutSeconds),
      customEnvVars,
    },
    networkTrace: normalizeNetworkTraceSettings(networkTrace),
  };
}

export function mergeSettings(current: AppSettings, patch: AppSettingsPatch): AppSettings {
  const desktopPatch: Partial<DesktopSettings> = patch.desktop ?? {};
  const nextCloseBehavior =
    desktopPatch.closeBehavior
    ?? (desktopPatch.closeToTray !== undefined ? (desktopPatch.closeToTray ? "tray" : "ask") : current.desktop.closeBehavior);
  const desktop: DesktopSettings = {
    ...current.desktop,
    ...desktopPatch,
    closeBehavior: nextCloseBehavior,
    closeToTray: nextCloseBehavior === "tray",
  };

  return normalizeSettings({
    appearance: { ...current.appearance, ...(patch.appearance ?? {}) },
    table: { ...current.table, ...(patch.table ?? {}) },
    desktop,
    storage: { ...current.storage, ...(patch.storage ?? {}) },
    binary: { ...current.binary, ...(patch.binary ?? {}) },
    networkTrace: { ...current.networkTrace, ...(patch.networkTrace ?? {}) },
  });
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

function normalizeEnvSettingsVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : 0;
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
    githubMirrorProviderId: enumValue(
      input.githubMirrorProviderId,
      ["off", "auto-best", "gh-proxy-lipk", "ghfast-top", "ghproxy-net", "ghproxy-vip", "gh-proxy-com", "custom"],
      DEFAULT_GITHUB_MIRROR_PROVIDER_ID,
    ),
    customGithubMirrorPrefix: normalizeUrlPrefix(input.customGithubMirrorPrefix, ""),
  };
}

function normalizeBrowserCoreUpdateCheck(value: unknown): BrowserCoreUpdateCheck | undefined {
  if (!value || typeof value !== "object") return undefined;
  const input = value as Partial<BrowserCoreUpdateCheck>;
  const checkedAt = stringValueAllowEmpty(input.checkedAt, "");
  const currentVersion = stringValueAllowEmpty(input.currentVersion, "");
  if (!checkedAt || !Number.isFinite(Date.parse(checkedAt)) || !currentVersion || typeof input.updateAvailable !== "boolean") {
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
    downloadLinks: normalizeBrowserCoreDownloadLinks(input.downloadLinks),
    blockedReason: blockedReason || undefined,
    error: error || undefined,
  };
}

function normalizeBrowserCoreDownloadLinks(value: unknown): BrowserCoreUpdateCheck["downloadLinks"] {
  if (!value || typeof value !== "object") return undefined;
  const input = value as NonNullable<BrowserCoreUpdateCheck["downloadLinks"]>;
  const version = stringValueAllowEmpty(input.version, "");
  const platform = stringValueAllowEmpty(input.platform, "");
  const primaryUrl = stringValueAllowEmpty(input.primaryUrl, "");
  const checksumUrl = stringValueAllowEmpty(input.checksumUrl, "");
  if (!version || !platform || !primaryUrl) return undefined;
  const fallbackUrl = stringValueAllowEmpty(input.fallbackUrl, "");
  const fallbackChecksumUrl = stringValueAllowEmpty(input.fallbackChecksumUrl, "");
  const signatureUrl = stringValueAllowEmpty(input.signatureUrl, "");
  const fallbackSignatureUrl = stringValueAllowEmpty(input.fallbackSignatureUrl, "");
  return {
    tier: enumValue(input.tier, ["free", "pro"], "free"),
    version,
    platform,
    primaryUrl,
    fallbackUrl: fallbackUrl || undefined,
    checksumUrl: checksumUrl || undefined,
    signatureUrl: signatureUrl || undefined,
    fallbackChecksumUrl: fallbackChecksumUrl || undefined,
    fallbackSignatureUrl: fallbackSignatureUrl || undefined,
    requiresLicense: booleanValue(input.requiresLicense, false) || undefined,
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

function normalizeDesktopCloseBehavior(
  closeBehavior: unknown,
  legacyCloseToTray: unknown,
  fallback: DesktopCloseBehavior,
): DesktopCloseBehavior {
  if (closeBehavior === "ask" || closeBehavior === "tray" || closeBehavior === "quit") return closeBehavior;
  if (legacyCloseToTray === true) return "tray";
  if (legacyCloseToTray === false) return "ask";
  return fallback;
}

function stringValue(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringValueAllowEmpty(value: unknown, fallback: string): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function normalizeUrlBase(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  return value.trim().replace(/\/+$/, "");
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

function normalizeNullableNumber(value: unknown, min: number, max: number, fallback: number | null): number | null {
  if (value === null || value === undefined || value === "") return fallback;
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isFinite(numeric)) return fallback;
  return Math.round(Math.min(max, Math.max(min, numeric)));
}

function normalizeFontSize(value: unknown, oldDefault: number, min: number, max: number, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  if (Math.round(value) === oldDefault) return fallback;
  return clampNumber(value, min, max, fallback);
}

function normalizeBrowserCoreEnvVars(
  value: unknown,
  envSettingsVersion: number,
  legacyGeoipTimeoutSeconds: unknown,
): BrowserCoreEnvVarSetting[] {
  const rows = normalizeCustomEnvVars(value);
  if (envSettingsVersion >= 1 || rows.some((item) => item.key === "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS")) {
    return rows;
  }
  return [...rows, defaultGeoipTimeoutEnvVar(legacyGeoipTimeoutSeconds)];
}

function defaultGeoipTimeoutEnvVar(legacyGeoipTimeoutSeconds: unknown): BrowserCoreEnvVarSetting {
  const timeoutSeconds = normalizeNullableNumber(legacyGeoipTimeoutSeconds, 1, 60, 12) ?? 12;
  return {
    id: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
    key: "CLOAKBROWSER_GEOIP_TIMEOUT_SECONDS",
    value: String(timeoutSeconds),
    enabled: true,
    sensitive: false,
    description: "",
    valueKind: "number",
  };
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
  const key = value.trim().toUpperCase();
  if (!/^CLOAKBROWSER_[A-Z0-9_]+$/.test(key)) return undefined;
  return key;
}

export function isBuiltinCloakBrowserEnvKey(value: unknown): value is BuiltinCloakBrowserEnvKey {
  return typeof value === "string" && (BUILTIN_CLOAKBROWSER_ENV_KEYS as readonly string[]).includes(value);
}

export function isManagedCloakBrowserEnvKey(value: unknown): value is ManagedCloakBrowserEnvKey {
  return typeof value === "string" && (MANAGED_CLOAKBROWSER_ENV_KEYS as readonly string[]).includes(value);
}
