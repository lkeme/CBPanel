import type { AppSettings, RuntimePlatform, StorageInfo } from "./settings";
import type { Locale } from "../i18n";
import type {
  BrowserEnvironment,
  ExtensionEntity,
  GroupEntity,
  NetworkCheckResult,
  ProxyEntity,
  ProxySubscriptionEntity,
  TagEntity,
  TrashEnvironment,
} from "./entities";
import { resolveLocalizedText, type Translator } from "./reportText";
import { networkCheckCountryCode } from "./networkCheckDisplay";
import { WATERMARK_STYLES, buildWatermarkScript, type WatermarkStyle } from "./watermark";
import { buildVoicesScript, voicesSeed } from "./voices";
import {
  XRAY_IP_STRATEGIES,
  XRAY_UTLS_PREFERENCES,
  type XrayIpStrategy,
  type XrayUtlsPreference,
  describeXrayNode,
  maskXrayShareLink,
  parseXrayShareLink,
  tryParseXrayShareLink,
} from "./xray";

export type ProfileMode = "persistent" | "ephemeral";
/**
 * The SDK entry point a profile launches through. Upstream's three APIs have distinct roles, and only
 * one of them fits a panel model of "one environment = one profile = one session":
 *
 * - `launchPersistentContext()` / `launchContext()` own a BrowserContext, which is what the panel
 *   actually drives (init scripts, extension registration, the start page). They are the two values
 *   this launch path can produce.
 * - `launch()` returns a bare Browser and leaves context management to the caller; the panel never
 *   exposed more than one context, so it never used what `launch()` alone offers. Worse, pairing it
 *   with persistent mode did not pass `userDataDir`, so it silently degraded to an empty profile.
 *
 * Stored profiles and share strings keep the field, but the value is always `playwright-context`.
 */
export type LauncherKind = "playwright-context";
/**
 * `xray` is not a URL scheme CloakBrowser understands: it marks a share-link node (vmess/vless/
 * trojan/ss/…) that the panel's Xray engine turns into a local SOCKS5 proxy at launch.
 */
export type ProxyScheme = "http" | "https" | "socks5" | "xray";
/**
 * The persona the core reports. The upstream docs describe `windows` and `macos` personas only;
 * `linux` was never documented and is normalized away rather than offered as an ordinary setting.
 * `auto` lets the wrapper spoof whatever platform it considers the host's closest match.
 */
export type FingerprintPlatform = "auto" | "windows" | "macos";
export type ColorScheme = "light" | "dark" | "no-preference";
export type ViewportMode = "fixed" | "native";
export type ProfilePresetId = "local-qa" | "residential-proxy" | "returning-session" | "throwaway-session";
export type RuntimeQuickArgId =
  | "fake-shadow-root"
  | "disable-http2"
  | "fingerprint-off"
  | "allow-3p-cookies"
  | "sapi-voices-off";
export type DetectionCheckStatus = "untested" | "pass" | "warn" | "fail";

export interface ProxySettings {
  enabled: boolean;
  raw: string;
  scheme: ProxyScheme;
  host: string;
  port: string;
  username: string;
  password: string;
  bypass: string;
  /** The Xray share link. Only read when `scheme` is `xray`; carries the node's credentials. */
  shareLink: string;
  /**
   * A proxy-library id used as the front proxy of a `[local] -> [front] -> [this proxy] -> [target]`
   * chain, or "" for no chain. Any scheme can be chained: setting this routes the launch through
   * the Xray engine even for a plain socks5/http proxy.
   */
  preProxyId: string;
  /** How the Xray engine resolves the node address when it dials it (dual-stack policy). */
  ipStrategy: XrayIpStrategy;
  /** The node's own uTLS ClientHello, or "" to inherit the global Xray setting. */
  utlsFingerprint: XrayUtlsPreference;
}

export type ProxyUrlParts = Pick<ProxySettings, "scheme" | "host" | "port" | "username" | "password">;

export interface RuntimeProxyOption {
  server: string;
  bypass?: string;
  username?: string;
  password?: string;
}

export type EffectiveWebrtcIpMode = "off" | "auto" | "custom" | "geoip";

export interface FingerprintSettings {
  /**
   * The effective identity, read from three sources in this order: an explicit `--fingerprint=<value>`
   * in Chromium Args, this field (a stored or imported profile may still carry one), and the wrapper's
   * own per-profile seed file. The editor shows which source applies and never writes this field.
   */
  seed: string;
  platform: FingerprintPlatform;
  maxTouchPoints: string;
  storageQuotaMb: string;
  timezone: string;
  locale: string;
  webrtcIp: "off" | "auto" | "custom";
  webrtcIpValue: string;
  noise: boolean;
}

export interface RuntimeSettings {
  launcher: LauncherKind;
  headless: boolean;
  geoip: boolean;
  searchEngine: string;
  /** Page overlay that identifies this environment. `off` injects nothing at all. */
  watermark: WatermarkStyle;
  /**
   * Shapes `speechSynthesis.getVoices()` into a stable per-environment subset. On by default like
   * `geoip`, not off like `watermark`: the raw host list is identical in every environment, so
   * leaving it alone is an anti-leak gap rather than a visible feature.
   */
  voices: boolean;
  /**
   * A launch input, not a stored setting: the directories come from the environment's bound
   * extensions, resolved by the extension service immediately before the browser starts. It is
   * carried on the profile only so the launch/preview pipeline can be a pure function of one object;
   * nothing writes it back to storage.
   */
  extensionPaths: string[];
  extraArgs: string[];
}

export interface ViewportSettings {
  mode: ViewportMode;
  width: number;
  height: number;
  userAgent: string;
  colorScheme: ColorScheme;
}

/**
 * A fixed viewport is not merely a window size: Playwright's device-metrics emulation also rewrites
 * `screen.width/height` and `screen.availWidth/availHeight` to the requested geometry, so every
 * `screen`-reading probe sees the entered size instead of the display the core reports. Measured
 * against the private Chromium 156 build: `viewport: null` reports the real 2560x1440 display, while a
 * fixed 1280x720 reports 1280x720 (with matching `avail`) for the same seed. There is therefore no
 * size that can "contradict" the spoofed screen — the fixed viewport replaces it, and only the native
 * mode lets the page follow the window.
 */
export function viewportRewritesScreen(viewport: Pick<ViewportSettings, "mode">): boolean {
  return viewport.mode === "fixed";
}

export interface AdvancedSettings {
  launchOptionsJson: string;
  contextOptionsJson: string;
}

export interface VerificationSettings {
  detectionChecks: DetectionCheckRecord[];
}

export interface DetectionCheckRecord {
  target: string;
  status: DetectionCheckStatus;
  checkedAt?: string;
  notes: string;
}

export interface BrowserProfile {
  id: string;
  name: string;
  group: string;
  tags: string[];
  notes: string;
  mode: ProfileMode;
  startUrl: string;
  createdAt: string;
  updatedAt: string;
  proxy: ProxySettings;
  fingerprint: FingerprintSettings;
  runtime: RuntimeSettings;
  viewport: ViewportSettings;
  advanced: AdvancedSettings;
  verification: VerificationSettings;
}

export interface ProfileConfigShare {
  kind: typeof PROFILE_CONFIG_SHARE_KIND;
  schemaVersion: typeof PROFILE_CONFIG_SHARE_SCHEMA_VERSION;
  exportedAt: string;
  profile: ProfileConfigShareData;
}

export type ProfileConfigShareData = Pick<
  BrowserProfile,
  | "name"
  | "group"
  | "tags"
  | "notes"
  | "mode"
  | "startUrl"
  | "proxy"
  | "fingerprint"
  | "runtime"
  | "viewport"
  | "advanced"
  | "verification"
>;

export type SessionEventLevel = "info" | "warn" | "error";

export interface SessionEvent {
  at: string;
  level: SessionEventLevel;
  message: string;
  detail?: string;
}

export interface SessionLaunchPlan {
  profileMode: ProfileMode;
  runtimeLauncher: LauncherKind;
  sdkLauncher: LaunchPreview["launcher"];
  resultType: LaunchPreview["resultType"];
  startUrl: string;
  userDataDir?: string;
  proxy: string;
  headless: boolean;
  geoip: boolean;
}

export interface SessionSummary {
  profileId: string;
  status: "launching" | "running" | "stopping" | "stopped" | "error";
  startedAt?: string;
  stoppedAt?: string;
  pageUrl?: string;
  lastError?: string;
  // A stop that never confirmed the browser exited: either it ran out of time or the close threw. The
  // session is not running, but a process may still be alive holding its files — so the panel keeps
  // offering Stop, and must not report the stop as done.
  closeUnconfirmed?: boolean;
  launch?: SessionLaunchPlan;
  events?: SessionEvent[];
}

export type AuditSeverity = "pass" | "warn" | "fail" | "info";
export type AuditCategory = "identity" | "network" | "runtime" | "persistence" | "advanced";

/**
 * A parameter interpolated into a `LocalizedText` template: a plain value, another localized
 * fragment the template embeds (an xray engine role), or a region code the renderer formats with the
 * active locale instead of printing the raw code.
 */
export type LocalizedTextParam = string | number | { region: string } | LocalizedText;

/**
 * User-facing text on a report item.
 *
 * `key` is a dictionary key the renderer translates with the active locale. The builders stay
 * locale-free on purpose: `preflightProfile` runs on the server and the client caches its report, so
 * translating in the builder would freeze a cached report in the language it was fetched with.
 * `text` carries a message this panel does not localize — a server error, an extension failure
 * reason, an xray parse error — as the whole detail.
 */
export type LocalizedText =
  | { key: string; params?: Record<string, LocalizedTextParam> }
  | { text: string };

export function localizedText(key: string, params?: Record<string, LocalizedTextParam>): LocalizedText {
  return params ? { key, params } : { key };
}

/** The detail is the external message itself; the panel has no template to translate around it. */
export function externalText(value: string): LocalizedText {
  return { text: value };
}

export interface AuditItem {
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  title: LocalizedText;
  detail: LocalizedText;
}

export interface ProfileAuditReport {
  score: number;
  summary: {
    pass: number;
    warn: number;
    fail: number;
    info: number;
  };
  items: AuditItem[];
}

export type PreflightSeverity = AuditSeverity;
export type PreflightCategory = AuditCategory | "environment";
export type PreflightActionKind = "install-binary" | "install-xray" | "open-tab" | "open-browser-core-settings";
export type PreflightActionTarget = "runtime" | "proxy" | "fingerprint" | "advanced";

export interface ProfilePreflightAction {
  id: string;
  kind: PreflightActionKind;
  label: LocalizedText;
  target?: PreflightActionTarget;
}

export interface ProfilePreflightItem {
  id: string;
  category: PreflightCategory;
  severity: PreflightSeverity;
  title: LocalizedText;
  detail: LocalizedText;
  actions?: ProfilePreflightAction[];
}

export interface ProfilePreflightEnvironment {
  licenseRequired?: boolean;
  licenseValid?: boolean;
  checkedAt?: string;
  userDataDir?: string;
  binaryInstalled?: boolean;
  binaryPath?: string;
  binaryDetail?: string;
  /** The installed core's Chromium version, used to gate flags that only exist in 156+. */
  browserVersion?: string;
  /** The host OS, which splits the documented version floors (the search-engine flag is lower on Linux). */
  hostPlatform?: RuntimePlatform;
  userDataDirWritable?: boolean;
  userDataDirDetail?: string;
  /** Whether the user data dir already exists, i.e. the profile has written state before. */
  userDataDirExists?: boolean;
  extensionErrors?: Array<{ name: string; detail: string }>;
  extensionWarnings?: Array<{ name: string; detail: string }>;
  /** Font families the host is missing that the upstream docs call the most common block cause. */
  fontCheck?: { missing: string[]; detail?: string };
  networkCheck?: NetworkCheckResult;
  /** Present only when the profile's proxy needs the Xray engine; absent means nothing was asked. */
  xrayEngine?: ProfilePreflightXrayEngine;
}

export interface ProfilePreflightXrayEngine {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  detail?: string;
  /** The front proxy the profile names, resolved: a missing or disabled one is a launch failure. */
  preProxy?: { id: string; name?: string; ok: boolean; detail?: string };
}

export interface ProfilePreflightReport {
  checkedAt: string;
  profileId: string;
  profileName: string;
  ok: boolean;
  summary: ProfileAuditReport["summary"];
  items: ProfilePreflightItem[];
  launch?: SessionLaunchPlan;
  preview?: LaunchPreview;
  /** The merged argv the profile would launch with, for the read-only preview in the panel. */
  argPreview?: EffectiveArgPreview;
}

/**
 * The audit report with its text resolved for export: a snapshot freezes the language of the moment
 * it was generated, so it carries strings rather than dictionary keys.
 */
export interface ProfileSnapshotAuditItem {
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  detail: string;
}

export interface ProfileSnapshot {
  exportedAt: string;
  profile: {
    id: string;
    name: string;
    group: string;
    tags: string[];
    mode: ProfileMode;
    launcher: LauncherKind;
    startUrl: string;
    proxy: string;
    timezone: string;
    locale: string;
    viewport: string;
  };
  audit: {
    score: number;
    summary: ProfileAuditReport["summary"];
    items: ProfileSnapshotAuditItem[];
  };
  launchPreview: LaunchPreview;
  launchCode: string;
}

export interface ProfilePreset {
  id: ProfilePresetId;
  name: string;
  summary: string;
  tags: string[];
}

export interface RuntimeQuickArg {
  id: RuntimeQuickArgId;
  label: string;
  flag: string;
  helpKey?: string;
}

export interface LaunchSnippet {
  id: string;
  title: LocalizedText;
  language: "ts" | "json";
  code: string;
}

export interface StartUrlPreset {
  id: "blank" | "creepjs" | "fingerprint-playground" | "browserleaks-canvas" | "browserleaks-webrtc" | "sannysoft" | "fingerprint-scan";
  label: string;
  url: string;
}

export interface PanelState {
  profiles: BrowserProfile[];
  environments?: BrowserEnvironment[];
  groups?: GroupEntity[];
  tags?: TagEntity[];
  proxies?: ProxyEntity[];
  proxySubscriptions?: ProxySubscriptionEntity[];
  extensions?: ExtensionEntity[];
  trash?: TrashEnvironment[];
  sessions: SessionSummary[];
  meta: {
    dataDir: string;
    profileCount: number;
  };
  settings: AppSettings;
  storage: StorageInfo;
}

export const DEFAULT_START_URL = "https://abrahamjuliot.github.io/creepjs/";
export const PROFILE_CONFIG_SHARE_KIND = "cbpanel.profileConfig";
export const PROFILE_CONFIG_SHARE_SCHEMA_VERSION = 1;
export const PROFILE_CONFIG_SHARE_PREFIX = "CBPANEL_PROFILE_CONFIG_V1.";

export const DETECTION_TARGETS = [
  "https://browserleaks.com/canvas",
  "https://browserleaks.com/webrtc",
  "https://bot.sannysoft.com/",
  "https://abrahamjuliot.github.io/creepjs/",
  "https://fingerprint-scan.com/",
] as const;

export const START_URL_PRESETS: StartUrlPreset[] = [
  { id: "blank", label: "Blank Page", url: "about:blank" },
  { id: "creepjs", label: "CreepJS", url: DEFAULT_START_URL },
  { id: "fingerprint-playground", label: "Fingerprint Playground", url: "https://demo.fingerprint.com/playground" },
  { id: "browserleaks-canvas", label: "BrowserLeaks Canvas", url: "https://browserleaks.com/canvas" },
  { id: "browserleaks-webrtc", label: "BrowserLeaks WebRTC", url: "https://browserleaks.com/webrtc" },
  { id: "sannysoft", label: "SannySoft", url: "https://bot.sannysoft.com/" },
  { id: "fingerprint-scan", label: "Fingerprint Scan", url: "https://fingerprint-scan.com/" },
];

export type StartUrlValidationResult =
  | { ok: true; kind: "empty" | "web" | "system"; value: string; protocol?: string }
  | { ok: false; value: string; reason: "invalid" | "unsupported-protocol"; message: string; protocol?: string };

const SYSTEM_START_URLS = new Set(["about:blank"]);

/**
 * The Chromium major a CloakBrowser version string names, or `undefined` when it does not identify
 * one. Core versions arrive as either four or five numeric parts (`155.0.8059.39.2`, `156.0.x.y`), so
 * the first part is the Chromium major in every case.
 */
export function chromiumMajor(version: string | undefined): number | undefined {
  const match = /^(\d+)(?:\.\d+)+$/.exec(version?.trim() ?? "");
  const major = match ? Number(match[1]) : NaN;
  return Number.isSafeInteger(major) && major > 0 ? major : undefined;
}

/**
 * Whether a dotted version is at least `minimum`, compared part by part (missing parts count as 0).
 * `chromiumMajor` only answers "which major", and the docs sometimes draw a line inside one major
 * (the search-engine flag exists from Linux 155.0.8059.39.2).
 */
export function versionAtLeast(version: string | undefined, minimum: readonly number[]): boolean {
  const parts = version?.trim().split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : NaN));
  if (!parts?.length || parts.some((part) => !Number.isSafeInteger(part))) return false;
  for (let index = 0; index < minimum.length; index += 1) {
    const actual = parts[index] ?? 0;
    if (actual > minimum[index]) return true;
    if (actual < minimum[index]) return false;
  }
  return true;
}

/** `--fingerprint-max-touch-points` exists in Chromium 156+; the search engine flag starts lower on Linux. */
const FINGERPRINT_156_FLAG_MAJOR = 156;
const SEARCH_ENGINE_LINUX_MINIMUM = [155, 0, 8059, 39, 2] as const;

/**
 * Which version-gated fingerprint flags the installed core will silently ignore. The search-engine
 * flag is documented as "155.0.8059.39.2+ on Linux, 156+ on all platforms", so a Linux host on that
 * build must not be warned about it.
 */
function versionGatedFingerprintFlags(
  profile: BrowserProfile,
  major: number | undefined,
  version: string | undefined,
  hostPlatform: RuntimePlatform,
): string[] {
  if (major === undefined || major >= FINGERPRINT_156_FLAG_MAJOR) return [];
  const flags: string[] = [];
  if (profile.fingerprint.maxTouchPoints.trim()) flags.push("--fingerprint-max-touch-points");
  const searchEngineSupported = hostPlatform === "linux"
    && major === SEARCH_ENGINE_LINUX_MINIMUM[0]
    && versionAtLeast(version, SEARCH_ENGINE_LINUX_MINIMUM);
  if (profile.runtime.searchEngine.trim() && !searchEngineSupported) flags.push("--fingerprint-search-engine");
  return flags;
}

/**
 * `--fingerprint-portable-cookies` only has an effect on the first launch after the profile is
 * created: cookies written without it stay machine-bound. A profile that already has a user data dir
 * has therefore missed the window.
 */
function portableCookiesMissedStart(profile: BrowserProfile, userDataDirExists: boolean | undefined): boolean {
  return profile.mode === "persistent"
    && profile.runtime.extraArgs.some((arg) => arg.trim() === "--fingerprint-portable-cookies")
    // An unknown existence state is not proof of a missed window; stay quiet rather than guess.
    && userDataDirExists === true;
}

const IANA_TIMEZONE_RE = /^[A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)*$/;
const BCP47_LOCALE_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/** A literal IP accepted by `--fingerprint-webrtc-ip`; a hostname is not. */
export function validWebrtcIp(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (IPV4_RE.test(text)) return true;
  // IPv6: bracketed or bare; only the character set and structure are checked, not scope syntax.
  const bare = text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
  return bare.includes(":") && /^[0-9A-Fa-f:.]+$/.test(bare);
}

function nonNegativeIntegerText(text: string): boolean {
  return /^\d+$/.test(text) && Number.isSafeInteger(Number(text));
}

export function validateStartUrl(value: string): StartUrlValidationResult {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true, kind: "empty", value: "" };
  if (SYSTEM_START_URLS.has(trimmed.toLowerCase())) return { ok: true, kind: "system", value: trimmed, protocol: "about:" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      ok: false,
      value: trimmed,
      reason: "invalid",
      message: "起始网址必须是完整 URL，例如 https://example.com。",
    };
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return { ok: true, kind: "web", value: trimmed, protocol: parsed.protocol };
  }

  return {
    ok: false,
    value: trimmed,
    reason: "unsupported-protocol",
    message: `不支持 ${parsed.protocol} 协议。起始网址只允许 http://、https:// 或 about:blank。`,
    protocol: parsed.protocol,
  };
}

export const RUNTIME_QUICK_ARGS: RuntimeQuickArg[] = [
  {
    id: "fake-shadow-root",
    label: "FakeShadowRoot",
    flag: "--enable-blink-features=FakeShadowRoot",
    helpKey: "tips.fakeShadowRoot",
  },
  {
    id: "disable-http2",
    label: "Disable HTTP/2",
    flag: "--disable-http2",
    helpKey: "tips.disableHttp2",
  },
  {
    id: "fingerprint-off",
    label: "Fingerprint Off",
    flag: "--fingerprint=off",
    helpKey: "tips.fingerprintOff",
  },
  {
    id: "allow-3p-cookies",
    label: "Allow 3P Cookies",
    flag: "--fingerprint-allow-3p-cookies",
    helpKey: "tips.allow3pCookies",
  },
  {
    id: "sapi-voices-off",
    label: "SAPI Voices Off",
    flag: "--fingerprint-sapi-voices=false",
    helpKey: "tips.sapiVoices",
  },
];

const WRAPPER_OWNED_CHROMIUM_ARGS = new Set(["--no-sandbox"]);

export const PORTABLE_COOKIES_FLAG = "--fingerprint-portable-cookies";

/**
 * Portable cookies are a property of the persistent profile, not a general launch switch: the flag has
 * to be present when a cookie is first written, and an ephemeral profile never writes cookies to disk.
 * Its control therefore lives beside the mode selector rather than in the quick-arg grid.
 */
export function isPortableCookiesEnabled(profile: Pick<BrowserProfile, "runtime">): boolean {
  return profile.runtime.extraArgs.some((arg) => arg.trim() === PORTABLE_COOKIES_FLAG);
}

export function setPortableCookies(profile: BrowserProfile, enabled: boolean): BrowserProfile {
  const existingArgs = profile.runtime.extraArgs.map((arg) => arg.trim()).filter(Boolean);
  const withoutFlag = existingArgs.filter((arg) => arg !== PORTABLE_COOKIES_FLAG);
  const extraArgs = enabled ? [...withoutFlag, PORTABLE_COOKIES_FLAG] : withoutFlag;

  return normalizeProfile({
    ...profile,
    runtime: {
      ...profile.runtime,
      extraArgs,
    },
    updatedAt: nowIso(),
  });
}

export const ENHANCED_PROXY_FLAG = "--fingerprint-transparent-proxy";

/**
 * Enhanced proxy is a modifier of the proxy, not a general launch switch, so it is its own control on
 * the proxy tab instead of a row in the quick-arg grid. It leaves the companion DNS choice at its
 * documented default — Cloudflare DNS over HTTPS, sent through the proxy — because that default is the
 * whole point of the mode, so the flag has no editor and no stored value of its own.
 */
export function isEnhancedProxyEnabled(profile: Pick<BrowserProfile, "runtime">): boolean {
  return profile.runtime.extraArgs.some((arg) => arg.trim() === ENHANCED_PROXY_FLAG);
}

export function setEnhancedProxy(profile: BrowserProfile, enabled: boolean): BrowserProfile {
  const existingArgs = profile.runtime.extraArgs.map((arg) => arg.trim()).filter(Boolean);
  const withoutFlag = existingArgs.filter((arg) => arg !== ENHANCED_PROXY_FLAG);
  const extraArgs = enabled ? [...withoutFlag, ENHANCED_PROXY_FLAG] : withoutFlag;

  return normalizeProfile({
    ...profile,
    runtime: {
      ...profile.runtime,
      extraArgs,
    },
    updatedAt: nowIso(),
  });
}

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    id: "local-qa",
    name: "本地 QA",
    summary: "可见窗口、持久化，会改写时区 / 语言 / WebRTC；适合先验证内核和配置映射。",
    tags: ["local", "qa"],
  },
  {
    id: "residential-proxy",
    name: "住宅代理",
    summary: "会改写代理、GeoIP 与 WebRTC，人类化更谨慎。",
    tags: ["proxy", "geoip"],
  },
  {
    id: "returning-session",
    name: "长期账号",
    summary: "持久化、原生视口、保守输入节奏，适合回访型 profile。",
    tags: ["persistent", "returning"],
  },
  {
    id: "throwaway-session",
    name: "一次性会话",
    summary: "临时上下文、随机身份，适合短生命周期测试。",
    tags: ["ephemeral", "throwaway"],
  },
];

const PROFILE_PRESET_TAGS = new Set(PROFILE_PRESETS.flatMap((preset) => preset.tags));

function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const cleanTags: string[] = [];
  for (const tag of tags) {
    const cleanTag = tag.trim();
    if (!cleanTag || seen.has(cleanTag)) continue;
    seen.add(cleanTag);
    cleanTags.push(cleanTag);
  }
  return cleanTags;
}

function applyPresetTags(currentTags: string[], presetTags: string[]): string[] {
  const userTags = uniqueTags(currentTags).filter((tag) => !PROFILE_PRESET_TAGS.has(tag));
  return uniqueTags([...userTags, ...presetTags]);
}

export function createId(prefix = "profile"): string {
  const random =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}-${random}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function defaultProfile(input: Partial<BrowserProfile> = {}): BrowserProfile {
  const now = nowIso();
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : createId();
  const base: BrowserProfile = {
    id,
    name: "新浏览器配置",
    group: "默认",
    tags: ["qa"],
    notes: "",
    mode: "persistent",
    startUrl: DEFAULT_START_URL,
    createdAt: now,
    updatedAt: now,
    proxy: {
      enabled: false,
      raw: "",
      scheme: "http",
      host: "",
      port: "",
      username: "",
      password: "",
      bypass: "localhost,127.0.0.1",
      shareLink: "",
      preProxyId: "",
      ipStrategy: "auto",
      utlsFingerprint: "",
    },
    fingerprint: {
      seed: "",
      platform: "auto",
      maxTouchPoints: "",
      storageQuotaMb: "",
      timezone: "",
      locale: "",
      webrtcIp: "off",
      webrtcIpValue: "",
      noise: true,
    },
    runtime: {
      launcher: "playwright-context",
      // Headed unless `advanced.launchOptions.headless` overrides it. The upstream anti-detection
      // recommendations all run headed, and the panel has no CDP/screenshot surface that would make a
      // headless session observable or operable.
      headless: false,
      // New profiles start with GeoIP on so timezone/locale follow the proxy (or the current public
      // exit) instead of leaking the host machine's locale. Stored profiles keep their own value:
      // mergeProfile drops undefined, so only sources that omit the field entirely land on this default.
      geoip: true,
      searchEngine: "",
      watermark: "off",
      // On for the same reason as geoip: the host reports one identical voice list to every
      // environment, which is a correlation signal and a platform mismatch for macos/linux profiles.
      // A stored row that predates the field lands here too: mergeProfile drops undefined input and
      // keeps this base value.
      voices: true,
      extensionPaths: [],
      extraArgs: [],
    },
    viewport: {
      mode: "native",
      // The geometry a profile gets once it switches to "fixed". 1920x947 was the headless viewport
      // upstream removed in 0.7.0; keeping it would reproduce the retired behavior by default.
      width: 1920,
      height: 1080,
      userAgent: "",
      colorScheme: "light",
    },
    advanced: {
      launchOptionsJson: "",
      contextOptionsJson: "",
    },
    verification: {
      detectionChecks: defaultDetectionChecks(),
    },
  };

  return { ...mergeProfile(base, input), id };
}

const WATERMARK_STYLE_VALUES: ReadonlySet<string> = new Set(WATERMARK_STYLES);

// A stored row from before the field existed, or a hand-edited/share-string value that is not one of
// the three styles, must never reach the launcher: `off` is the only safe fallback.
function normalizeWatermarkStyle(value: unknown): WatermarkStyle {
  return typeof value === "string" && WATERMARK_STYLE_VALUES.has(value) ? (value as WatermarkStyle) : "off";
}

// A non-boolean `voices` from a hand-edited file or a share string must never reach the launcher: only
// a real boolean is accepted, everything else falls back to the profile's own value (`true` unless the
// stored row explicitly turned shaping off).
function normalizeVoicesToggle(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function mergeProfile(base: BrowserProfile, input: Partial<BrowserProfile>): BrowserProfile {
  const cleanInput = omitUndefined(input);
  return {
    ...base,
    ...cleanInput,
    tags: Array.isArray(cleanInput.tags) ? cleanInput.tags : base.tags,
    proxy: { ...base.proxy, ...omitUndefined(cleanInput.proxy ?? {}) },
    fingerprint: { ...base.fingerprint, ...omitUndefined(cleanInput.fingerprint ?? {}) },
    runtime: {
      ...base.runtime,
      ...omitUndefined(cleanInput.runtime ?? {}),
      watermark: normalizeWatermarkStyle(cleanInput.runtime?.watermark ?? base.runtime.watermark),
      voices: normalizeVoicesToggle(cleanInput.runtime?.voices, base.runtime.voices),
      // The manual path list is gone: a stored profile that still carries one drops it here rather
      // than reaching the launch switches. Extension directories are resolved at launch time by the
      // extension service, so the only stored source of them is the binding table.
      extensionPaths: [],
      extraArgs: Array.isArray(cleanInput.runtime?.extraArgs)
        ? cleanInput.runtime.extraArgs
        : base.runtime.extraArgs,
    },
    viewport: { ...base.viewport, ...omitUndefined(cleanInput.viewport ?? {}) },
    advanced: { ...base.advanced, ...omitUndefined(cleanInput.advanced ?? {}) },
    verification: {
      ...base.verification,
      ...omitUndefined(cleanInput.verification ?? {}),
      detectionChecks: normalizeDetectionChecks(cleanInput.verification?.detectionChecks),
    },
  };
}

export function normalizeProfile(input: Partial<BrowserProfile>): BrowserProfile {
  const profile = defaultProfile(input);
  return {
    ...profile,
    name: profile.name.trim() || "未命名配置",
    group: profile.group.trim() || "默认",
    tags: uniqueTags(profile.tags),
    startUrl: profile.startUrl.trim(),
    proxy: normalizeProxySettings(profile.proxy),
    fingerprint: normalizeFingerprintSettings(profile.fingerprint),
    // Both knobs collapse to one value: the launch path has one shape, and a stored profile that still
    // carries a retired value would otherwise reach the launcher through an untyped row or share string.
    runtime: {
      ...profile.runtime,
      launcher: "playwright-context",
      headless: false,
    },
    updatedAt: profile.updatedAt || nowIso(),
    verification: {
      detectionChecks: normalizeDetectionChecks(profile.verification.detectionChecks),
    },
  };
}

const FINGERPRINT_PLATFORM_VALUES: ReadonlySet<string> = new Set(["auto", "windows", "macos"]);

/**
 * The undocumented `linux` persona normalizes to `auto`, which is the setting that lets the wrapper
 * pick the persona its own stealth layer spoofs anyway.
 */
function normalizeFingerprintPlatform(value: unknown): FingerprintPlatform {
  return typeof value === "string" && FINGERPRINT_PLATFORM_VALUES.has(value)
    ? (value as FingerprintPlatform)
    : "auto";
}

function normalizeFingerprintSettings(fingerprint: FingerprintSettings): FingerprintSettings {
  const settings = fingerprint as FingerprintSettings & {
    brand?: unknown;
    brandVersion?: unknown;
    gpuRenderer?: unknown;
    gpuVendor?: unknown;
    platformVersion?: unknown;
    hardwareConcurrency?: unknown;
    deviceMemory?: unknown;
    screenWidth?: unknown;
    screenHeight?: unknown;
    taskbarHeight?: unknown;
  };
  // The seed-derived overrides and the retired brand fields are dropped rather than carried forward:
  // no reader consumes them any more, and leaving them in the JSON would suggest they still reach the
  // core. A stored value is therefore gone after one normalize pass, which is the intended migration.
  const {
    brand: _brand,
    brandVersion: _brandVersion,
    gpuRenderer: _gpuRenderer,
    gpuVendor: _gpuVendor,
    platformVersion: _platformVersion,
    hardwareConcurrency: _hardwareConcurrency,
    deviceMemory: _deviceMemory,
    screenWidth: _screenWidth,
    screenHeight: _screenHeight,
    taskbarHeight: _taskbarHeight,
    ...rest
  } = settings;
  return {
    ...rest,
    platform: normalizeFingerprintPlatform(rest.platform),
  };
}

export function createProfileConfigShareString(profile: BrowserProfile, exportedAt = nowIso()): string {
  const payload: ProfileConfigShare = {
    kind: PROFILE_CONFIG_SHARE_KIND,
    schemaVersion: PROFILE_CONFIG_SHARE_SCHEMA_VERSION,
    exportedAt,
    profile: profileConfigShareData(profile),
  };
  return `${PROFILE_CONFIG_SHARE_PREFIX}${encodeBase64Url(JSON.stringify(payload))}`;
}

export function parseProfileConfigShareString(value: string): ProfileConfigShare {
  const trimmed = value.trim();
  if (!trimmed.startsWith(PROFILE_CONFIG_SHARE_PREFIX)) {
    throw new Error("Clipboard does not contain an CBPanel profile config string.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(trimmed.slice(PROFILE_CONFIG_SHARE_PREFIX.length)));
  } catch (error) {
    throw new Error(`Invalid CBPanel profile config string: ${(error as Error).message}`);
  }

  if (!isRecord(parsed)) {
    throw new Error("CBPanel profile config payload must be an object.");
  }
  if (parsed.kind !== PROFILE_CONFIG_SHARE_KIND) {
    throw new Error("Unsupported CBPanel profile config kind.");
  }
  if (parsed.schemaVersion !== PROFILE_CONFIG_SHARE_SCHEMA_VERSION) {
    throw new Error("Unsupported CBPanel profile config version.");
  }
  if (typeof parsed.exportedAt !== "string" || !parsed.exportedAt.trim()) {
    throw new Error("CBPanel profile config is missing exportedAt.");
  }
  if (!isRecord(parsed.profile)) {
    throw new Error("CBPanel profile config is missing profile data.");
  }

  return {
    kind: PROFILE_CONFIG_SHARE_KIND,
    schemaVersion: PROFILE_CONFIG_SHARE_SCHEMA_VERSION,
    exportedAt: parsed.exportedAt,
    profile: profileConfigShareData(normalizeProfile(parsed.profile)),
  };
}

export function applyProfileConfigShare(current: BrowserProfile, share: ProfileConfigShare): BrowserProfile {
  return normalizeProfile({
    ...share.profile,
    id: current.id,
    createdAt: current.createdAt,
    updatedAt: nowIso(),
  });
}

function profileConfigShareData(profile: BrowserProfile): ProfileConfigShareData {
  const normalized = normalizeProfile(profile);
  return {
    name: normalized.name,
    group: normalized.group,
    tags: [...normalized.tags],
    notes: normalized.notes,
    mode: normalized.mode,
    startUrl: normalized.startUrl,
    proxy: { ...normalized.proxy },
    fingerprint: { ...normalized.fingerprint },
    runtime: {
      ...normalized.runtime,
      extensionPaths: [],
      extraArgs: [...normalized.runtime.extraArgs],
    },
    viewport: { ...normalized.viewport },
    advanced: { ...normalized.advanced },
    verification: {
      detectionChecks: normalized.verification.detectionChecks.map((check) => ({ ...check })),
    },
  };
}

export function applyProfilePreset(profile: BrowserProfile, presetId: ProfilePresetId): BrowserProfile {
  const next = structuredClone(profile);
  const preset = PROFILE_PRESETS.find((item) => item.id === presetId);

  next.tags = applyPresetTags(next.tags, preset?.tags ?? []);
  next.updatedAt = nowIso();

  switch (presetId) {
    case "local-qa":
      next.group = "默认";
      next.mode = "persistent";
      next.startUrl = next.startUrl || "https://browserleaks.com/canvas";
      next.fingerprint.timezone = next.fingerprint.timezone || "Asia/Shanghai";
      next.fingerprint.locale = next.fingerprint.locale || "zh-CN";
      next.fingerprint.webrtcIp = "off";
      next.runtime.geoip = false;
      // Native, not a fixed 1920x947: upstream removed that headless viewport in 0.7.0, and a fixed
      // viewport also suppresses the `--start-maximized` the wrapper adds when no size is given.
      next.viewport.mode = "native";
      break;

    case "residential-proxy":
      next.group = "代理";
      next.mode = "persistent";
      next.startUrl = "https://browserleaks.com/webrtc";
      next.fingerprint.timezone = "";
      next.fingerprint.locale = "";
      next.fingerprint.webrtcIp = "auto";
      next.runtime.geoip = true;
      next.proxy.enabled = true;
      next.proxy.bypass = next.proxy.bypass || "localhost,127.0.0.1";
      break;

    case "returning-session":
      next.group = "账号";
      next.mode = "persistent";
      next.startUrl = next.startUrl || DEFAULT_START_URL;
      // No seed here on purpose: a persistent profile stores its own seed, and an explicit one would
      // override that stored identity.
      // Native, not fixed: a fixed viewport suppresses `--start-maximized`, which is the opposite of
      // what a returning account wants a maximized window to look like.
      next.viewport.mode = "native";
      next.viewport.colorScheme = "light";
      break;

    case "throwaway-session":
      next.group = "临时";
      next.mode = "ephemeral";
      next.startUrl = next.startUrl || DEFAULT_START_URL;
      // Not a pinned value: clearing is what makes the profile disposable, so a seed stored earlier
      // must not survive into a template whose whole point is a fresh identity per launch.
      next.fingerprint.seed = "";
      next.fingerprint.webrtcIp = "off";
      next.runtime.geoip = false;
      next.viewport.mode = "native";
      break;
  }

  return normalizeProfile(next);
}

export function linesFromText(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function textFromLines(value: string[]): string {
  return value.join("\n");
}

export function defaultDetectionChecks(): DetectionCheckRecord[] {
  return DETECTION_TARGETS.map((target) => ({
    target,
    status: "untested",
    notes: "",
  }));
}

export function normalizeDetectionChecks(input: unknown): DetectionCheckRecord[] {
  const current = Array.isArray(input) ? input : [];
  const byTarget = new Map<string, Partial<DetectionCheckRecord>>();
  for (const item of current) {
    if (!item || typeof item !== "object") continue;
    const record = item as Partial<DetectionCheckRecord>;
    if (typeof record.target !== "string") continue;
    byTarget.set(record.target, record);
  }

  return DETECTION_TARGETS.map((target) => {
    const record = byTarget.get(target);
    const status = isDetectionCheckStatus(record?.status) ? record.status : "untested";
    const checkedAt = typeof record?.checkedAt === "string" && record.checkedAt.trim() ? record.checkedAt.trim() : undefined;
    const notes = typeof record?.notes === "string" ? record.notes : "";
    return {
      target,
      status,
      checkedAt,
      notes,
    };
  });
}

export function updateDetectionCheck(
  profile: BrowserProfile,
  target: string,
  patch: Partial<Pick<DetectionCheckRecord, "status" | "notes" | "checkedAt">>,
): BrowserProfile {
  const checks = normalizeDetectionChecks(profile.verification.detectionChecks);
  const nextStatus = patch.status;
  const detectionChecks = checks.map((record) => {
    if (record.target !== target) return record;
    const status = isDetectionCheckStatus(nextStatus) ? nextStatus : record.status;
    const notes = patch.notes ?? record.notes;
    const touched = patch.status !== undefined || patch.notes !== undefined;
    const checkedAt = status === "untested" && !notes.trim() ? undefined : patch.checkedAt ?? record.checkedAt ?? (touched ? nowIso() : undefined);
    return { ...record, status, notes, checkedAt };
  });

  return normalizeProfile({
    ...profile,
    verification: { detectionChecks },
    updatedAt: nowIso(),
  });
}

export function isRuntimeQuickArgEnabled(profile: BrowserProfile, id: RuntimeQuickArgId): boolean {
  const quickArg = getRuntimeQuickArg(id);
  return profile.runtime.extraArgs.some((arg) => arg.trim() === quickArg.flag);
}

export function setRuntimeQuickArg(profile: BrowserProfile, id: RuntimeQuickArgId, enabled: boolean): BrowserProfile {
  const quickArg = getRuntimeQuickArg(id);
  const existingArgs = profile.runtime.extraArgs.map((arg) => arg.trim()).filter(Boolean);
  const withoutFlag = existingArgs.filter((arg) => arg !== quickArg.flag);
  const extraArgs = enabled ? [...withoutFlag, quickArg.flag] : withoutFlag;

  return normalizeProfile({
    ...profile,
    runtime: {
      ...profile.runtime,
      extraArgs,
    },
    updatedAt: nowIso(),
  });
}

export function parseOptionalJsonObject(label: string, value: string): Record<string, unknown> | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${(error as Error).message}`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是 JSON 对象`);
  }

  if (label === "launchOptions" || label === "launchOptions JSON") {
    const rejected = Object.keys(parsed).filter((key) => !LAUNCH_OPTION_ALLOWED_KEYS.has(key));
    if (rejected.length) {
      throw new Error(
        `launchOptions 中的 ${rejected.join("、")} 会替换面板已计算的启动配置。`
        + "请改用对应控件：Chromium Args / 视口 / 代理 / 内核可执行文件；此处只接受 "
        + [...LAUNCH_OPTION_ALLOWED_KEYS].join("、") + "。",
      );
    }
  }

  // The panel writes these from its own fields, and the wrapper strips the last two (they route through
  // detectable CDP emulation). Accepting them would look like the value applied when it never did.
  if (label === "contextOptions" || label === "contextOptions JSON") {
    const owned = Object.keys(parsed).filter((key) => CONTEXT_OPTION_PANEL_OWNED_KEYS.has(key));
    if (owned.length) {
      throw new Error(`contextOptions 中的 ${owned.join("、")} 由面板字段或 CloakBrowser 接管，请改用对应控件。`);
    }
  }

  return parsed as Record<string, unknown>;
}

export function normalizeProxyScheme(value: string): ProxyScheme | undefined {
  const scheme = value.toLowerCase();
  if (scheme === "http" || scheme === "https" || scheme === "socks5" || scheme === "xray") return scheme;
  return undefined;
}

export function normalizeXrayIpStrategy(value: unknown): XrayIpStrategy {
  return typeof value === "string" && (XRAY_IP_STRATEGIES as readonly string[]).includes(value)
    ? (value as XrayIpStrategy)
    : "auto";
}

/** A stored row from before the field existed, or a hand-edited value, inherits the global setting. */
export function normalizeXrayUtlsPreference(value: unknown): XrayUtlsPreference {
  return typeof value === "string" && (XRAY_UTLS_PREFERENCES as readonly string[]).includes(value)
    ? (value as XrayUtlsPreference)
    : "";
}

/**
 * The stored shape with the engine fields made total. An `xray` proxy keeps `host`/`port` in step
 * with its share link so every place that prints `scheme://host:port` — the table, the library
 * row, the launch plan — shows the node without having to parse the link itself.
 */
export function normalizeProxySettings(proxy: ProxySettings): ProxySettings {
  const scheme = normalizeProxyScheme(proxy.scheme) ?? "http";
  const shareLink = typeof proxy.shareLink === "string" ? proxy.shareLink.trim() : "";
  const normalized: ProxySettings = {
    ...proxy,
    scheme,
    shareLink,
    preProxyId: typeof proxy.preProxyId === "string" ? proxy.preProxyId.trim() : "",
    ipStrategy: normalizeXrayIpStrategy(proxy.ipStrategy),
    utlsFingerprint: normalizeXrayUtlsPreference(proxy.utlsFingerprint),
  };
  if (scheme === "xray") {
    const parsed = tryParseXrayShareLink(shareLink);
    if (parsed) {
      normalized.host = parsed.summary.address;
      normalized.port = String(parsed.summary.port);
    }
    normalized.raw = "";
    normalized.username = "";
    normalized.password = "";
  }
  return normalized;
}

/** Whether a launch through this proxy has to go through the Xray engine rather than straight to CloakBrowser. */
export function proxyRequiresXray(proxy: Pick<ProxySettings, "enabled" | "scheme" | "preProxyId">): boolean {
  return proxy.enabled && (proxy.scheme === "xray" || Boolean(proxy.preProxyId?.trim()));
}

export type XrayRoutingDecisionInput = {
  /** The `xray.nativeProxyRouting` setting. */
  nativeProxyRouting: "auto" | "always" | "never";
  engineInstalled: boolean;
};

/**
 * Whether a launch (and every check) of this proxy goes through the engine once the routing setting
 * is applied: nodes and chains always do, plain proxies follow the setting. The one place both the
 * server and the panel decide it, so the editor's hint and the launch never disagree.
 */
export function proxyUsesXray(
  proxy: Pick<ProxySettings, "enabled" | "scheme" | "preProxyId">,
  decision: XrayRoutingDecisionInput,
): boolean {
  if (!proxy.enabled) return false;
  if (proxyRequiresXray(proxy)) return true;
  if (decision.nativeProxyRouting === "always") return true;
  if (decision.nativeProxyRouting === "auto") return decision.engineInstalled;
  return false;
}

/** The same profile pointed at the engine's local SOCKS5 inbound, which is what CloakBrowser is actually launched with. */
export function withLocalXrayProxy(profile: BrowserProfile, localPort: number): BrowserProfile {
  return {
    ...profile,
    proxy: {
      enabled: true,
      raw: "",
      scheme: "socks5",
      host: "127.0.0.1",
      port: String(localPort),
      username: "",
      password: "",
      bypass: profile.proxy.bypass,
      shareLink: "",
      preProxyId: "",
      ipStrategy: "auto",
      utlsFingerprint: "",
    },
  };
}

/** `protocol · transport · detail` for an xray proxy, or undefined when the link does not parse. */
export function describeXrayProxy(proxy: Pick<ProxySettings, "scheme" | "shareLink">): string | undefined {
  if (proxy.scheme !== "xray") return undefined;
  const parsed = tryParseXrayShareLink(proxy.shareLink);
  return parsed ? describeXrayNode(parsed.summary) : undefined;
}

function xrayProxyUrl(proxy: Pick<ProxySettings, "shareLink">): string | undefined {
  const parsed = tryParseXrayShareLink(proxy.shareLink);
  if (!parsed) return undefined;
  const host = parsed.summary.address.includes(":") ? `[${parsed.summary.address}]` : parsed.summary.address;
  return `xray://${host}:${parsed.summary.port}`;
}

export function parseProxyUrlInput(value: string): ProxyUrlParts | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  try {
    const raw = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
    const url = new URL(raw);
    const scheme = normalizeProxyScheme(url.protocol.replace(":", ""));
    if (!scheme || !url.hostname || !url.port) {
      return undefined;
    }

    return {
      scheme,
      host: url.hostname,
      port: url.port,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
    };
  } catch {
    return undefined;
  }
}

export function proxyUrlFromParts(proxy: ProxyUrlParts): string {
  const host = proxy.host.trim();
  const port = proxy.port.trim();
  if (!host || !port) return "";
  const scheme = normalizeProxyScheme(proxy.scheme);
  if (!scheme) return "";
  // The node's credentials live in the share link, never in the URL.
  if (scheme === "xray") return `xray://${host}:${port}`;

  const auth =
    proxy.username.trim() || proxy.password.trim()
      ? `${encodeURIComponent(proxy.username.trim())}:${encodeURIComponent(proxy.password)}@`
      : "";
  return `${scheme}://${auth}${host}:${port}`;
}

export function buildProxyUrl(proxy: ProxySettings): string | undefined {
  if (!proxy.enabled) return undefined;
  // An xray proxy is complete exactly when its share link parses; `raw` and the parts are display
  // projections of the link, so they are never the authority here.
  if (proxy.scheme === "xray") return xrayProxyUrl(proxy);
  const raw = proxy.raw.trim();
  if (raw) {
    const parsed = parseProxyUrlInput(raw);
    return parsed ? proxyUrlFromParts(parsed) : undefined;
  }
  if (!proxy.host.trim() || !proxy.port.trim()) return undefined;

  return proxyUrlFromParts(proxy);
}

export function buildProxyOption(proxy: ProxySettings): string | RuntimeProxyOption | undefined {
  const proxyUrl = buildProxyUrl(proxy);
  if (!proxyUrl) return undefined;

  const parsed = parseProxyUrlInput(proxyUrl);
  const bypass = proxy.bypass.trim();
  if (!parsed) return proxyUrl;

  if (!bypass && !parsed.username && !parsed.password) return proxyUrl;

  const option: RuntimeProxyOption = {
    server: `${parsed.scheme}://${parsed.host}:${parsed.port}`,
  };
  if (bypass) option.bypass = bypass;
  if (parsed.username) option.username = parsed.username;
  if (parsed.password) option.password = parsed.password;
  return option;
}

/**
 * The WebRTC exit the launch actually ends up with, as one four-valued read-out:
 *
 * - `custom` — the profile stores a literal IP, emitted as `--fingerprint-webrtc-ip=<ip>`.
 * - `geoip`  — a `geoip: true` launch appends `--fingerprint-webrtc-ip=<exit>` from its own lookup
 *              (see `geoipInjectsWebrtcExitIp`), whatever the editor stored. This outranks a stored
 *              `auto`: the wrapper first resolves (or drops) `auto`, then appends the GeoIP exit
 *              address, so with GeoIP injecting the result is the GeoIP address in either case.
 * - `auto`   — stored `--fingerprint-webrtc-ip=auto`, resolved against the **proxy** exit. It is never
 *              resolved from the machine's own public IP, so the wrapper drops the flag without a proxy
 *              — and this is only reachable when GeoIP is not injecting an address of its own.
 * - `off`    — no flag is emitted and the core reports WebRTC as it is.
 *
 * `geoip` is not a stored mode on purpose: the flag it stands for is produced by the wrapper from the
 * same GeoIP lookup that writes timezone and locale, so there is nothing for the editor to persist.
 */
export function effectiveWebrtcIpMode(
  profile: BrowserProfile,
  proxyUrl = buildProxyUrl(profile.proxy),
): EffectiveWebrtcIpMode {
  // A stored literal outranks everything: the wrapper appends its own address only when no
  // `--fingerprint-webrtc-ip` is present, and a literal is one.
  if (profile.fingerprint.webrtcIp === "custom") return "custom";
  if (geoipInjectsWebrtcExitIp(profile, proxyUrl)) return "geoip";
  if (profile.fingerprint.webrtcIp === "auto") return "auto";
  return "off";
}

/**
 * Whether a `geoip: true` launch will append `--fingerprint-webrtc-ip=<exit>` by itself.
 *
 * The wrapper appends it from the exit IP the GeoIP lookup returns, and that lookup returns an exit IP
 * in exactly these cases (cloakbrowser `maybeResolveGeoip`):
 * - timezone and locale are both derived → the lookup always runs and its exit IP is reused;
 * - timezone and locale are both explicit → the lookup runs for the exit IP alone **when a proxy is
 *   configured**; without a proxy that call is skipped as a no-op, because the address would be the
 *   real connection IP the site can already see.
 *
 * A half-explicit pair (one field filled, one derived) still goes through the deriving branch, because
 * that is what the wrapper does — the explicit value is promoted and the other one is filled in.
 */
export function geoipInjectsWebrtcExitIp(
  profile: BrowserProfile,
  proxyUrl = buildProxyUrl(profile.proxy),
): boolean {
  if (!profile.runtime.geoip) return false;
  const timezone = profile.fingerprint.timezone.trim();
  const locale = profile.fingerprint.locale.trim();
  if (!timezone || !locale) return true;
  return Boolean(proxyUrl);
}

export function maskProxyUrl(proxyUrl: string | undefined): string {
  if (!proxyUrl) return "未启用";
  try {
    const url = new URL(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`);
    if (url.username || url.password) {
      url.username = url.username ? decodeURIComponent(url.username) : "";
      url.password = url.password ? "****" : "";
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return proxyUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:****@");
  }
}

export function maskProxyUrlForDisplay(proxyUrl: string | undefined): string {
  if (!proxyUrl) return "未启用";
  try {
    const url = new URL(proxyUrl.includes("://") ? proxyUrl : `http://${proxyUrl}`);
    if (url.username) url.username = decodeURIComponent(url.username);
    if (url.password) url.password = "****";
    return url.toString().replace(/\/$/, "");
  } catch {
    return proxyUrl.replace(/\/\/([^:@/]+):([^@/]+)@/, "//$1:****@");
  }
}

export function maskProfileSecrets(profile: BrowserProfile): BrowserProfile {
  return normalizeProfile({
    ...profile,
    proxy: {
      ...profile.proxy,
      raw: maskProxyUrl(profile.proxy.raw),
      password: profile.proxy.password ? "****" : "",
      shareLink: maskXrayShareLink(profile.proxy.shareLink ?? ""),
    },
    advanced: {
      launchOptionsJson: maskAdvancedJsonString(profile.advanced.launchOptionsJson),
      contextOptionsJson: maskAdvancedJsonString(profile.advanced.contextOptionsJson),
    },
  });
}

function maskAdvancedJsonString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.stringify(maskSensitiveValues(JSON.parse(trimmed)), null, 2);
  } catch {
    return value.replace(/("(?:password|token|secret|credential)"\s*:\s*")([^"]*)(")/gi, "$1****$3");
  }
}

function pushFlag(args: string[], key: string, value: string | number | undefined): void {
  if (value === undefined) return;
  const text = String(value).trim();
  if (!text) return;
  args.push(`${key}=${text}`);
}

export function isWrapperOwnedChromiumArg(arg: string): boolean {
  const normalized = arg.trim().split("=", 1)[0].toLowerCase();
  return WRAPPER_OWNED_CHROMIUM_ARGS.has(normalized);
}

function sanitizeChromiumArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter((arg) => arg && !isWrapperOwnedChromiumArg(arg));
}

/**
 * The only launchOptions keys the field accepts. Every other Playwright launch key either replaces what
 * the panel computed (`args`, `headless`, `proxy`, `executablePath`, `ignoreDefaultArgs`, `env`,
 * `defaultViewport`) or belongs to the wrapper's own compatibility policy (`chromiumSandbox`). Those
 * keys are refused with an error naming the panel control that owns the setting, so nothing can change
 * the launch shape behind the editor's back.
 */
const LAUNCH_OPTION_ALLOWED_KEYS = new Set(["timeout", "slowMo", "downloadsPath", "tracesDir"]);

/**
 * contextOptions is forwarded whole, so only the keys the panel or the wrapper already owns are
 * refused: the panel writes viewport / userAgent / colorScheme from its own fields, and the wrapper
 * strips locale / timezoneId (they route through detectable CDP emulation).
 */
const CONTEXT_OPTION_PANEL_OWNED_KEYS = new Set(["viewport", "userAgent", "colorScheme", "locale", "timezoneId"]);

// `--fingerprint=off` (and its accepted spellings) is a pass-through debug mode: the binary strips
// the injected seed, while GeoIP and an explicit timezone/locale stay applied by design. That is a
// mixed state worth naming rather than silently launching.
const FINGERPRINT_OFF_VALUES = new Set(["off", "false", "0", "disable", "disabled"]);

function chromiumArgKey(arg: string): string {
  return arg.trim().split("=", 1)[0].toLowerCase();
}

/**
 * Whether the profile asks for pass-through, whether through a raw arg or through a seed field that
 * holds one of the reserved values. The seed reaches the binary the same way, so both are the same
 * state for the mixed-mode finding.
 */
function fingerprintOffRawArg(profile: Pick<BrowserProfile, "runtime">): string | undefined {
  return profile.runtime.extraArgs
    .map((arg) => arg.trim())
    .find((arg) => {
      const [key, value = ""] = arg.split("=", 2);
      return key.toLowerCase() === "--fingerprint" && FINGERPRINT_OFF_VALUES.has(value.trim().toLowerCase());
    });
}

function fingerprintOffFromSeed(profile: Pick<BrowserProfile, "fingerprint">): boolean {
  return FINGERPRINT_OFF_VALUES.has(profile.fingerprint.seed.trim().toLowerCase());
}

/**
 * The `--fingerprint=<value>` a profile carries in Chromium Args, excluding the reserved pass-through
 * values (those are the Fingerprint Off quick argument, not an identity).
 */
export function explicitFingerprintArg(profile: Pick<BrowserProfile, "runtime">): string | undefined {
  const arg = profile.runtime.extraArgs
    .map((value) => value.trim())
    .find((value) => {
      const [key, raw = ""] = value.split("=", 2);
      return key.toLowerCase() === "--fingerprint" && raw.trim() && !FINGERPRINT_OFF_VALUES.has(raw.trim().toLowerCase());
    });
  return arg?.split("=", 2)[1]?.trim() || undefined;
}

/**
 * Where the effective identity comes from. The order is the launch order: an explicit `--fingerprint`
 * wins over the stored seed, and both win over the wrapper's own per-profile seed file. A profile with
 * none of them is either random per launch (ephemeral) or seeded on first start (persistent).
 */
export type IdentitySource =
  | { kind: "passthrough" }
  | { kind: "arg"; value: string }
  | { kind: "stored"; value: string }
  | { kind: "persistent-file" }
  | { kind: "ephemeral-random" };

export function identitySource(profile: Pick<BrowserProfile, "mode" | "runtime" | "fingerprint">): IdentitySource {
  // Pass-through outranks everything: the binary strips the seed and the platform spoofing, so no seed
  // file is read and no stored value applies.
  if (fingerprintOffRawArg(profile) || fingerprintOffFromSeed(profile)) {
    return { kind: "passthrough" };
  }
  const arg = explicitFingerprintArg(profile);
  if (arg) return { kind: "arg", value: arg };
  const stored = profile.fingerprint.seed.trim();
  if (stored && !FINGERPRINT_OFF_VALUES.has(stored.toLowerCase())) return { kind: "stored", value: stored };
  return profile.mode === "persistent" ? { kind: "persistent-file" } : { kind: "ephemeral-random" };
}

/**
 * Drops a stored seed so the wrapper's own identity takes over again. It does not rotate anything:
 * a persistent profile keeps using the seed already written into its user data dir.
 */
export function clearStoredSeed(profile: BrowserProfile): BrowserProfile {
  return normalizeProfile({
    ...profile,
    fingerprint: { ...profile.fingerprint, seed: "" },
    updatedAt: nowIso(),
  });
}

/** Fingerprint flags whose generated value a hand-written Chromium arg silently replaces. */
function rawArgsOverridingGenerated(profile: BrowserProfile): string[] {
  const raw = profile.runtime.extraArgs.map((arg) => arg.trim()).filter(Boolean);
  if (!raw.length) return [];
  const generated = new Set(
    buildFingerprintArgs({ ...profile, runtime: { ...profile.runtime, extraArgs: [] } }, profile.runtime.extensionPaths).map(chromiumArgKey),
  );
  const overridden = new Set<string>();
  for (const arg of raw) {
    const key = chromiumArgKey(arg);
    // Pass-through has its own finding; it is not an accidental duplicate of the seed flag.
    if (key === "--fingerprint" && FINGERPRINT_OFF_VALUES.has((arg.split("=", 2)[1] ?? "").trim().toLowerCase())) continue;
    if (generated.has(key)) overridden.add(key);
  }
  return [...overridden];
}

/**
 * What still applies when pass-through is combined with tuning that survives it. `--fingerprint=off`
 * is a debug pass-through: it strips the seed *and* the platform spoofing the wrapper would otherwise
 * apply, so the browser reports the real machine's fingerprint.
 */
function fingerprintOffConflicts(profile: BrowserProfile): string[] {
  if (!fingerprintOffRawArg(profile) && !fingerprintOffFromSeed(profile)) return [];
  const sources: string[] = [];
  if (profile.runtime.geoip) sources.push("GeoIP");
  if (profile.fingerprint.timezone.trim()) sources.push("timezone");
  if (profile.fingerprint.locale.trim()) sources.push("locale");
  return sources;
}

/**
 * How the Pro license and session calls leave the browser. There is no stored control for it: the
 * route is derived from the proxy this profile launches with, so a profile that goes through a proxy
 * sends those calls through it too, and one that does not stays direct.
 *
 * `--license-route=auto` (upstream's default) is "direct first, one retry through --proxy-server", which
 * describes neither case exactly — and is actively wrong without a proxy, where the retry cannot
 * happen. Passing `proxy` / `direct` explicitly makes the two states say what they do, and the value is
 * derived after the Xray rewrite, so a proxied launch writes `proxy` against the engine's loopback
 * SOCKS inbound.
 */
export function licenseRouteFor(profile: Pick<BrowserProfile, "proxy">): "direct" | "proxy" {
  return profile.proxy.enabled && Boolean(buildProxyUrl(profile.proxy)) ? "proxy" : "direct";
}

/**
 * The generated flag list, in launch order. `extensionPaths` is a parameter rather than a profile
 * field: extension directories are a launch input the extension service resolves just before the
 * browser starts, and the profile no longer stores one. Callers that only describe a launch pass the
 * directories the library would load.
 */
export function buildFingerprintArgs(profile: BrowserProfile, extensionPaths: string[] = []): string[] {
  const fp = profile.fingerprint;
  const args: string[] = [];

  pushFlag(args, "--fingerprint", fp.seed);
  if (fp.platform !== "auto") pushFlag(args, "--fingerprint-platform", fp.platform);
  pushFlag(args, "--fingerprint-max-touch-points", fp.maxTouchPoints);
  pushFlag(args, "--fingerprint-search-engine", profile.runtime.searchEngine);
  pushFlag(args, "--license-route", licenseRouteFor(profile));
  pushFlag(args, "--fingerprint-storage-quota", fp.storageQuotaMb);

  if (fp.webrtcIp === "auto") args.push("--fingerprint-webrtc-ip=auto");
  if (fp.webrtcIp === "custom") pushFlag(args, "--fingerprint-webrtc-ip", fp.webrtcIpValue);
  if (!fp.noise) args.push("--fingerprint-noise=false");

  return [...args, ...extensionLoaderArgs(extensionPaths), ...sanitizeChromiumArgs(profile.runtime.extraArgs)];
}

/**
 * The two flags an unpacked directory needs on Chromium 137+.
 *
 * `--load-extension` alone no longer loads anything: Chromium removed that switch in 137, and the
 * kernel the panel ships (156.0.8078.47) was verified to ignore it — including with the documented
 * `--disable-features=DisableLoadExtensionCommandLineSwitch` escape hatch, which that build no longer
 * carries. `--disable-extensions-except` is the flag that still works: on that kernel it alone loaded
 * both the service worker and the content scripts of an unpacked directory in a persistent profile.
 * The panel emits the pair anyway, because older Chromium treats `except` as a pure filter that needs
 * `--load-extension` to name what to load; together they are correct on both sides of the removal.
 *
 * Emitting them here instead of passing the wrapper's `extensionPaths` option keeps the launch shape
 * visible in the effective-argv preview and independent of how the wrapper happens to translate that
 * option. The comma join is the format the switch parses; every caller resolves the directories first
 * (`resolveRuntimeProfile` in the launcher, library paths by construction), because Chromium resolves a
 * relative value against its own working directory.
 */
export function extensionLoaderArgs(extensionPaths: string[]): string[] {
  const paths = extensionPaths.map((entry) => entry.trim()).filter(Boolean);
  if (paths.length === 0) return [];
  const joined = paths.join(",");
  return [`--load-extension=${joined}`, `--disable-extensions-except=${joined}`];
}

export interface EffectiveArgPreview {
  /** The merged argv, in launch order: generated flags, then Chromium Args, then `launchOptions.args`. */
  argv: string[];
  /**
   * Where each flag came from, keyed by `chromiumArgKey`. A flag that appears more than once keeps the
   * winning source, which is the last one in `argv`.
   */
  sources: Record<string, "generated" | "chromium-args">;
}

/**
 * The argv a launch ends up with: panel-generated flags, then user Chromium Args, where a later
 * occurrence of the same flag wins. `launchOptions.args` is not part of it — the allowlist refuses
 * that key, because the wrapper replaces the whole generated list with it rather than appending. The
 * wrapper's own stealth defaults are not expanded here (they ship with the wrapper and change between
 * versions), nor is `--start-maximized` inferred; the UI says so instead of guessing.
 */
export function buildEffectiveArgPreview(
  profile: BrowserProfile,
  extensionPaths: string[] = profile.runtime.extensionPaths,
): EffectiveArgPreview {
  const merged: string[] = [];
  const sources: EffectiveArgPreview["sources"] = {};
  const push = (arg: string, source: EffectiveArgPreview["sources"][string]): void => {
    const text = arg.trim();
    if (!text || isWrapperOwnedChromiumArg(text)) return;
    merged.push(text);
    sources[chromiumArgKey(text)] = source;
  };

  for (const arg of buildFingerprintArgs({ ...profile, runtime: { ...profile.runtime, extraArgs: [] } }, extensionPaths)) {
    push(arg, "generated");
  }
  for (const arg of profile.runtime.extraArgs) push(arg, "chromium-args");

  // One row per flag: the wrapper applies the last occurrence of a duplicated flag, so the surviving
  // position and source are the last one's.
  const lastIndex = new Map<string, number>();
  merged.forEach((arg, index) => lastIndex.set(chromiumArgKey(arg), index));
  const argv = merged.filter((arg, index) => lastIndex.get(chromiumArgKey(arg)) === index);

  return { argv, sources };
}

function upstreamOptionIssues(profile: BrowserProfile): Array<{ id: string; title: string; detail: string; target: PreflightActionTarget; message: string }> {
  const issues: Array<{ id: string; title: string; detail: string; target: PreflightActionTarget; message: string }> = [];
  // The seed has no editor any more: it is a stored identity a share string or an older build may still
  // carry, so there is nothing to type and nothing to validate as a user entry.
  const touch = profile.fingerprint.maxTouchPoints;
  if (typeof touch !== "string" || (touch.trim() && (!/^\d+$/.test(touch.trim()) || !Number.isSafeInteger(Number(touch))))) {
    issues.push({ id: "max-touch-points", title: "form.maxTouchPoints", detail: "error.maxTouchPoints", target: "fingerprint", message: "Maximum touch points must be an empty value or a non-negative safe integer." });
  }
  // A documented numeric flag: a non-integer reaches the binary verbatim and is then undefined behaviour.
  const storageQuota = profile.fingerprint.storageQuotaMb.trim();
  if (storageQuota !== "" && !nonNegativeIntegerText(storageQuota)) {
    issues.push({ id: "numeric-storageQuotaMb", title: "form.storageMb", detail: "error.storageQuota", target: "fingerprint", message: "Storage quota must be an empty value or a non-negative integer." });
  }
  // The binary accepts a literal IP (or `auto`); a hostname cannot be injected as an exit address.
  if (profile.fingerprint.webrtcIp === "custom" && !validWebrtcIp(profile.fingerprint.webrtcIpValue)) {
    issues.push({ id: "webrtc-ip-format", title: "form.webrtcIp", detail: "error.webrtcIpFormat", target: "fingerprint", message: "A custom WebRTC IP must be an IPv4 or IPv6 literal." });
  }
  // Documented as IANA and BCP 47; a typo is silently ignored or, worse, spoofed inconsistently.
  if (profile.fingerprint.timezone.trim() && !IANA_TIMEZONE_RE.test(profile.fingerprint.timezone.trim())) {
    issues.push({ id: "timezone-format", title: "form.timezone", detail: "error.timezoneFormat", target: "fingerprint", message: "Timezone must be an IANA name such as Asia/Shanghai." });
  }
  if (profile.fingerprint.locale.trim() && !BCP47_LOCALE_RE.test(profile.fingerprint.locale.trim())) {
    issues.push({ id: "locale-format", title: "form.locale", detail: "error.localeFormat", target: "fingerprint", message: "Locale must be a BCP 47 tag such as en-US or zh-CN." });
  }
  const engine = profile.runtime.searchEngine;
  let validEngine = typeof engine === "string" && ["", "google", "bing", "duckduckgo", "none"].includes(engine.trim());
  if (!validEngine && typeof engine === "string") {
    try { validEngine = ["http:", "https:"].includes(new URL(engine.trim()).protocol); } catch { /* Not a search URL. */ }
  }
  if (!validEngine) issues.push({ id: "search-engine", title: "form.searchEngine", detail: "error.searchEngine", target: "runtime", message: "Search engine must be google, bing, duckduckgo, none, or an HTTP(S) search URL." });
  // The comma check for extension directories moved to the import path: directories no longer come
  // from a text box, and the extension service refuses a comma-bearing source before it registers one.
  return issues;
}

export interface LaunchPreview {
  launcher: "launchPersistentContext" | "launchContext";
  importPath: "cloakbrowser";
  importName: "launchPersistentContext" | "launchContext";
  resultType: "context";
  options: Record<string, unknown>;
}

export interface LaunchRuntimeHints {
  browserVersion?: string;
  /** Bound extension directories, as resolved from the library; never a stored profile field. */
  extensionPaths?: string[];
}

const BROWSER_VERSION_HINT_RE = /^[0-9]+(?:\.[0-9]+){3,4}$/;

export function browserVersionLaunchHints(browserVersion: string | undefined): LaunchRuntimeHints {
  const version = browserVersion?.trim();
  return version && BROWSER_VERSION_HINT_RE.test(version) ? { browserVersion: version } : {};
}

/**
 * The launch shape for a profile.
 *
 * Extension directories are a launch input: the extension service resolves the bound ones immediately
 * before the browser starts and hands them over on the profile it passes in. The hint exists so a
 * read-only surface — which has no resolved profile — can show the same argv by joining them in from
 * the binding table. Precedence matches the launcher: an explicit hint wins, then whatever the caller
 * already resolved onto the profile, and nothing at all for a surface that has neither.
 */
export function buildLaunchPreview(
  profile: BrowserProfile,
  userDataDir?: string,
  runtimeHints: LaunchRuntimeHints = {},
): LaunchPreview {
  const issue = upstreamOptionIssues(profile)[0];
  if (issue) throw new Error(issue.message);
  const advanced = profile.advanced;
  const proxy = buildProxyUrl(profile.proxy);
  const proxyOption = buildProxyOption(profile.proxy);
  if (profile.proxy.enabled && !proxy) {
    throw new Error(
      profile.proxy.scheme === "xray"
        ? `代理已启用，但 Xray 分享链接无法解析：${xrayShareLinkProblem(profile.proxy.shareLink)}`
        : "代理已启用，但代理 URL 或 host/port 不完整，或协议不受支持。",
    );
  }
  const args = buildFingerprintArgs(profile, runtimeHints.extensionPaths ?? profile.runtime.extensionPaths);
  const launchOptions = parseOptionalJsonObject("launchOptions", advanced.launchOptionsJson);
  const contextOptions = parseOptionalJsonObject("contextOptions", advanced.contextOptionsJson);
  // Humanize is on with the wrapper's own `default` preset and no overrides. The panel never drives
  // element interactions — it opens, navigates and injects — so a preset or a humanConfig object would
  // tune code paths this launch never runs, while an unknown preset throws inside the wrapper *after*
  // the browser process exists.
  const options: Record<string, unknown> = {
    headless: profile.runtime.headless,
    geoip: profile.runtime.geoip,
    humanize: true,
  };

  if (profile.mode === "persistent") {
    options.userDataDir = userDataDir ?? `./data/browser-data/${profile.id}`;
  }
  if (proxyOption) options.proxy = proxyOption;
  if (args.length) options.args = args;
  if (profile.fingerprint.timezone.trim()) options.timezone = profile.fingerprint.timezone.trim();
  if (profile.fingerprint.locale.trim()) options.locale = profile.fingerprint.locale.trim();
  // The extension directories travel as the two Chromium switches `buildFingerprintArgs` emits, not as
  // the wrapper's `extensionPaths` option: see `extensionLoaderArgs` for why the switch pair — not the
  // option — is the part that decides whether an unpacked extension loads at all on Chromium 137+.
  Object.assign(options, browserVersionLaunchHints(runtimeHints.browserVersion));
  options.launchOptions = launchOptions;

  if (profile.viewport.userAgent.trim()) options.userAgent = profile.viewport.userAgent.trim();
  // Native leaves the option absent on purpose. CloakBrowser adds --start-maximized only when no
  // viewport was passed, and its own context builder already defaults to viewport: null; passing
  // null here suppressed that default and left the window without either a fixed size or the
  // maximized geometry the wrapper otherwise establishes.
  if (profile.viewport.mode === "fixed") {
    options.viewport = { width: profile.viewport.width, height: profile.viewport.height };
  }
  options.colorScheme = profile.viewport.colorScheme;
  // `contextOptionsJson` stays in the same option: the wrapper forwards it to `new_context()`, so the
  // field keeps working exactly as it did before the launcher switch was removed.
  if (contextOptions) options.contextOptions = contextOptions;

  return {
    // Persistent -> launchPersistentContext (real user data dir, so cookies, extensions and history
    // survive); ephemeral -> launchContext (browser + context in one call). Both return a
    // BrowserContext, which is the only surface the panel drives.
    launcher: profile.mode === "persistent" ? "launchPersistentContext" : "launchContext",
    importPath: "cloakbrowser",
    importName: profile.mode === "persistent" ? "launchPersistentContext" : "launchContext",
    resultType: "context",
    options: pruneUndefined(options),
  };
}

export function buildSessionLaunchPlan(profile: BrowserProfile, userDataDir?: string): SessionLaunchPlan {
  const preview = buildLaunchPreview(profile, userDataDir);
  return {
    profileMode: profile.mode,
    runtimeLauncher: profile.runtime.launcher,
    sdkLauncher: preview.launcher,
    resultType: preview.resultType,
    startUrl: profile.startUrl.trim(),
    userDataDir:
      typeof preview.options.userDataDir === "string"
        ? preview.options.userDataDir
        : userDataDir,
    proxy: maskProxyUrl(buildProxyUrl(profile.proxy)),
    headless: profile.runtime.headless,
    geoip: profile.runtime.geoip,
  };
}

export function preflightProfile(
  profile: BrowserProfile,
  environment: ProfilePreflightEnvironment = {},
): ProfilePreflightReport {
  const items: ProfilePreflightItem[] = [];
  const checkedAt = environment.checkedAt ?? nowIso();
  for (const issue of upstreamOptionIssues(profile)) {
    pushPreflight(items, { id: issue.id, category: "runtime", severity: "fail", title: localizedText(issue.title), detail: localizedText(issue.detail), actions: [openTabAction(issue.target, "preflightItem.action.adjustRuntimeOption")] });
  }
  const proxyUrl = buildProxyUrl(profile.proxy);
  const webrtcMode = effectiveWebrtcIpMode(profile, proxyUrl);
  let preview: LaunchPreview | undefined;
  let launch: SessionLaunchPlan | undefined;

  pushPreflight(items, preflightFromAudit(validateJsonAudit("launch-json", "advanced", {
    title: "preflightItem.launchJson.title",
    empty: "preflightItem.launchJson.detail.empty",
    valid: "preflightItem.launchJson.detail.valid",
  }, "launchOptions JSON", profile.advanced.launchOptionsJson)));
  pushPreflight(items, preflightFromAudit(validateJsonAudit("context-json", "advanced", {
    title: "preflightItem.contextJson.title",
    empty: "preflightItem.contextJson.detail.empty",
    valid: "preflightItem.contextJson.detail.valid",
  }, "contextOptions JSON", profile.advanced.contextOptionsJson)));

  const overriddenRawArgs = rawArgsOverridingGenerated(profile);
  if (overriddenRawArgs.length > 0) {
    pushPreflight(items, {
      id: "raw-arg-override",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.rawArgOverride.title"),
      detail: localizedText("preflightItem.rawArgOverride.detail", { flags: overriddenRawArgs.join(", ") }),
      actions: [openTabAction("advanced", "preflightItem.action.checkArgs")],
    });
  }

  const fingerprintOffSources = fingerprintOffConflicts(profile);
  if (fingerprintOffSources.length > 0) {
    pushPreflight(items, {
      id: "fingerprint-off-mixed",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.fingerprintOffMixed.title"),
      detail: localizedText("preflightItem.fingerprintOffMixed.detail", { sources: fingerprintOffSources.join(", ") }),
      actions: [
        openTabAction("runtime", "preflightItem.action.adjustRuntimeOption"),
        openTabAction("fingerprint", "preflightItem.action.clearTimezoneLocale"),
      ],
    });
  }

  try {
    preview = buildLaunchPreview(profile, environment.userDataDir);
    launch = buildSessionLaunchPlan(profile, environment.userDataDir);
    pushPreflight(items, {
      id: "launch-preview",
      category: "runtime",
      severity: "pass",
      title: localizedText("preflightItem.launchPreview.title"),
      detail: localizedText("preflightItem.launchPreview.detail.generated", {
        launcher: preview.launcher,
        resultType: preview.resultType,
      }),
    });
  } catch (error) {
    pushPreflight(items, {
      id: "launch-preview",
      category: "runtime",
      severity: "fail",
      title: localizedText("preflightItem.launchPreview.title"),
      detail: externalText((error as Error).message),
      actions: [openTabAction("advanced", "preflightItem.action.checkJson")],
    });
  }

  if (environment.licenseRequired || environment.licenseValid === false) {
    pushPreflight(items, {
      id: "browser-license",
      category: "environment",
      severity: "fail",
      title: localizedText("preflightItem.license.title"),
      detail: localizedText(environment.licenseRequired ? "error.browserCoreLicenseRequired" : "error.browserCoreLicenseInvalid"),
      actions: [{ id: "configure-license", kind: "open-browser-core-settings", label: localizedText("preflightItem.action.configureLicense") }],
    });
  }

  if (environment.binaryInstalled === undefined) {
    pushPreflight(items, {
      id: "binary",
      category: "environment",
      severity: "info",
      title: localizedText("preflightItem.binary.title"),
      detail: localizedText("preflightItem.binary.detail.unknown"),
    });
  } else {
    pushPreflight(items, {
      id: "binary",
      category: "environment",
      severity: environment.binaryInstalled ? "pass" : "fail",
      title: localizedText("preflightItem.binary.title"),
      detail: environment.binaryInstalled
        ? environment.binaryPath
          ? localizedText("preflightItem.binary.detail.installed", { path: environment.binaryPath })
          : localizedText("preflightItem.binary.detail.installedNoPath")
        : environment.binaryDetail
          ? externalText(environment.binaryDetail)
          : localizedText("preflightItem.binary.detail.missing"),
      actions: environment.binaryInstalled || environment.licenseRequired || environment.licenseValid === false
        ? undefined
        : [{ id: "install-binary", kind: "install-binary", label: localizedText("preflightItem.action.installBinary") }],
    });
  }

  if (profile.mode === "persistent") {
    if (environment.userDataDirWritable === undefined) {
      pushPreflight(items, {
        id: "user-data-dir",
        category: "persistence",
        severity: "info",
        title: localizedText("preflightItem.userDataDir.title"),
        detail: environment.userDataDir
          ? localizedText("preflightItem.userDataDir.detail.path", { path: environment.userDataDir })
          : localizedText("preflightItem.userDataDir.detail.noProbe"),
      });
    } else {
      pushPreflight(items, {
        id: "user-data-dir",
        category: "persistence",
        severity: environment.userDataDirWritable ? "pass" : "fail",
        title: localizedText("preflightItem.userDataDir.title"),
        detail: environment.userDataDirWritable
          ? localizedText("preflightItem.userDataDir.detail.writable", { path: environment.userDataDir ?? "profile data dir" })
          : environment.userDataDirDetail
            ? externalText(environment.userDataDirDetail)
            : localizedText("preflightItem.userDataDir.detail.notWritable"),
        actions: environment.userDataDirWritable ? undefined : [openTabAction("runtime", "preflightItem.action.checkMode")],
      });
    }
  } else {
    pushPreflight(items, {
      id: "user-data-dir",
      category: "persistence",
      severity: "info",
      title: localizedText("preflightItem.userDataDir.title"),
      detail: localizedText("preflightItem.userDataDir.detail.ephemeral"),
    });
  }

  if (profile.proxy.enabled) {
    const xrayNode = describeXrayProxy(profile.proxy);
    pushPreflight(items, {
      id: "proxy-config",
      category: "network",
      severity: proxyUrl ? "pass" : "fail",
      title: localizedText("preflightItem.proxyConfig.title"),
      detail: proxyUrl
        ? xrayNode
          ? localizedText("preflightItem.proxyConfig.detail.xrayNode", { proxy: maskProxyUrl(proxyUrl), node: xrayNode })
          : localizedText("preflightItem.proxyConfig.detail.configured", { proxy: maskProxyUrl(proxyUrl) })
        : profile.proxy.scheme === "xray"
          ? localizedText("preflightItem.proxyConfig.detail.unparsable", { message: xrayShareLinkProblem(profile.proxy.shareLink) })
          : localizedText("preflightItem.proxyConfig.detail.incomplete"),
      actions: proxyUrl ? undefined : [openTabAction("proxy", "preflightItem.action.completeProxy")],
    });
    // A hard requirement (node or chain) is reported even without engine information; a plain proxy
    // routed through the engine by settings is reported when the environment says it will be.
    if (proxyRequiresXray(profile.proxy) || environment.xrayEngine) pushXrayEnginePreflight(items, profile, environment.xrayEngine);
  } else {
    pushPreflight(items, {
      id: "proxy-config",
      category: "network",
      severity: "info",
      title: localizedText("preflightItem.proxyConfig.title"),
      detail: localizedText("preflightItem.proxyConfig.detail.disabled"),
    });
  }

  if (proxyUrl) {
    pushPreflight(items, networkCheckPreflight(environment.networkCheck));
  }

  if (profile.runtime.geoip && !proxyUrl) {
    pushPreflight(items, {
      id: "geoip-without-proxy",
      category: "network",
      severity: "pass",
      title: localizedText("preflightItem.geoipWithoutProxy.title"),
      detail: localizedText("preflightItem.geoipWithoutProxy.detail"),
    });
  }

  if (profile.runtime.geoip) {
    if (profile.fingerprint.timezone.trim() || profile.fingerprint.locale.trim()) {
      pushPreflight(items, {
        id: "geoip-explicit-overrides",
        category: "network",
        severity: "warn",
        title: localizedText("preflightItem.geoipExplicitOverrides.title"),
        detail: localizedText("preflightItem.geoipExplicitOverrides.detail"),
        actions: [openTabAction("fingerprint", "preflightItem.action.clearTimezoneLocale")],
      });
    }
  }

  // `auto` is resolved from the proxy exit and dropped without one; there is no fallback to the local
  // public IP other than the GeoIP append. So this only warns when nothing else supplies an address —
  // `effectiveWebrtcIpMode` already folds the GeoIP injection ahead of `auto`.
  if (webrtcMode === "auto" && !proxyUrl) {
    pushPreflight(items, {
      id: "webrtc-auto-without-proxy",
      category: "network",
      severity: "warn",
      title: localizedText("preflightItem.webrtcAutoWithoutProxy.title"),
      detail: localizedText("preflightItem.webrtcAutoWithoutProxy.detail"),
      actions: [openTabAction("proxy", "preflightItem.action.configureProxy"), openTabAction("fingerprint", "preflightItem.action.adjustWebrtc")],
    });
  }

  if (webrtcMode === "geoip") {
    pushPreflight(items, {
      id: "webrtc-geoip-effective",
      category: "network",
      severity: "pass",
      title: localizedText("preflightItem.webrtcGeoipEffective.title"),
      detail: localizedText(
        proxyUrl
          ? "preflightItem.webrtcGeoipEffective.detail.proxy"
          : "preflightItem.webrtcGeoipEffective.detail.local",
      ),
    });
  }

  if (profile.fingerprint.webrtcIp === "custom" && !profile.fingerprint.webrtcIpValue.trim()) {
    pushPreflight(items, {
      id: "webrtc-custom-empty",
      category: "network",
      severity: "fail",
      title: localizedText("preflightItem.webrtcCustomEmpty.title"),
      detail: localizedText("preflightItem.webrtcCustomEmpty.detail"),
      actions: [openTabAction("fingerprint", "preflightItem.action.fillIp")],
    });
  }

  pushPreflight(items, validateStartUrlPreflight(profile.startUrl));
  pushPreflight(items, validateViewportPreflight(profile));

  // 156+ gates: a pinned or offline older core ignores these flags without saying so. An unknown host
  // platform leaves the stricter (156+) reading in place rather than guessing Linux's lower floor.
  const gatedFlags = versionGatedFingerprintFlags(
    profile,
    chromiumMajor(environment.browserVersion),
    environment.browserVersion,
    environment.hostPlatform ?? "unknown",
  );
  if (gatedFlags.length > 0) {
    pushPreflight(items, {
      id: "version-gated-flags",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.versionGatedFlags.title"),
      detail: localizedText("preflightItem.versionGatedFlags.detail", {
        version: environment.browserVersion ?? "",
        flags: gatedFlags.join(", "),
      }),
      actions: [openTabAction("fingerprint", "preflightItem.action.adjustRuntimeOption")],
    });
  }

  // The upstream docs name missing emoji/CJK/Windows fonts as the most common cause of blocks once
  // proxy, GeoIP and headed mode are right. The probe is host-level; only its result reaches here.
  if (environment.fontCheck && environment.fontCheck.missing.length > 0) {
    pushPreflight(items, {
      id: "host-fonts",
      category: "environment",
      severity: "warn",
      title: localizedText("preflightItem.hostFonts.title"),
      detail: environment.fontCheck.detail
        ? externalText(environment.fontCheck.detail)
        : localizedText("preflightItem.hostFonts.detail", { fonts: environment.fontCheck.missing.join(", ") }),
    });
  }

  // A macOS persona needs real Mac fonts and a large display; the docs call the missing-font case a
  // common block reason, so the choice is named rather than silently accepted.
  if (profile.fingerprint.platform === "macos") {
    pushPreflight(items, {
      id: "macos-persona",
      category: "identity",
      severity: "info",
      title: localizedText("preflightItem.macosPersona.title"),
      detail: localizedText("preflightItem.macosPersona.detail"),
    });
  }

  // `--fingerprint-portable-cookies` has to be on for the first write; a profile with an existing
  // user data dir has already written cookies the flag cannot migrate.
  if (portableCookiesMissedStart(profile, environment.userDataDirExists)) {
    pushPreflight(items, {
      id: "portable-cookies-timing",
      category: "persistence",
      severity: "warn",
      title: localizedText("preflightItem.portableCookiesTiming.title"),
      detail: localizedText("preflightItem.portableCookiesTiming.detail"),
      actions: [openTabAction("runtime", "preflightItem.action.checkArgs")],
    });
  }

  // SOCKS5 (and an authenticated HTTP proxy) are applied at the browser process; the Playwright
  // request client (`context.request` / `page.request` / `route.fetch()`) bypasses them. The panel
  // uses none of those today, so this is a standing note rather than a fault.
  if (profile.proxy.enabled && proxyUrl) {
    pushPreflight(items, {
      id: "proxy-request-client",
      category: "network",
      severity: "info",
      title: localizedText("preflightItem.proxyRequestClient.title"),
      detail: localizedText("preflightItem.proxyRequestClient.detail"),
    });
  }

  if (environment.extensionWarnings?.length) {
    for (const [index, extension] of environment.extensionWarnings.entries()) {
      pushPreflight(items, {
        id: `extension-warning-${index}`,
        category: "runtime",
        severity: "warn",
        title: localizedText("preflightItem.extensionWarning.title"),
        detail: localizedText("preflightItem.extensionWarning.detail", { name: extension.name, detail: extension.detail }),
        actions: [openTabAction("runtime", "preflightItem.action.checkExtensions")],
      });
    }
  }

  if (environment.extensionErrors?.length) {
    for (const [index, extension] of environment.extensionErrors.entries()) {
      pushPreflight(items, {
        id: `extension-error-${index}`,
        category: "runtime",
        severity: "fail",
        title: localizedText("preflightItem.extensionError.title"),
        detail: localizedText("preflightItem.extensionError.detail", { name: extension.name, detail: extension.detail }),
        actions: [openTabAction("runtime", "preflightItem.action.checkExtensions")],
      });
    }
  } else if (profile.runtime.extensionPaths.length === 0) {
    // Nothing bound. Extension directories are resolved from the binding table, so an empty resolved
    // list is the only evidence of "no extensions", and it covers both a profile with no bindings and
    // a surface that never resolved any.
    if (!environment.extensionWarnings?.length) {
      pushPreflight(items, {
        id: "extensions",
        category: "runtime",
        severity: "info",
        title: localizedText("preflightItem.extensions.title"),
        detail: localizedText("preflightItem.extensions.detail.none"),
      });
    }
  } else if (profile.mode !== "persistent") {
    pushPreflight(items, {
      id: "extension-persistence",
      category: "runtime",
      severity: "fail",
      title: localizedText("preflightItem.extensionPersistence.title"),
      detail: localizedText("preflightItem.extensionPersistence.detail.ephemeral"),
      actions: [openTabAction("runtime", "preflightItem.action.checkMode")],
    });
  }

  const summary = summarizeSeverity(items);
  return {
    checkedAt,
    profileId: profile.id,
    profileName: profile.name,
    ok: summary.fail === 0,
    summary,
    items,
    launch,
    preview: preview ? maskLaunchPreview(preview) : undefined,
    // Cheap and pure, so it is always there rather than only when the launch preview succeeded: a
    // profile that cannot launch is exactly when reading its merged argv helps.
    argPreview: buildEffectiveArgPreview(profile),
  };
}

export function generateLaunchSnippets(profile: BrowserProfile): LaunchSnippet[] {
  const preview = maskLaunchPreview(buildLaunchPreview(profile));
  return [
    {
      id: "current-launch",
      title: localizedText("launchSnippet.currentLaunch.title"),
      language: "ts",
      code: generateLaunchCodeFromPreview(profile, preview),
    },
    {
      id: "launch-preview-json",
      title: localizedText("launchSnippet.launchPreviewJson.title"),
      language: "json",
      code: `${JSON.stringify(preview, null, 2)}\n`,
    },
    {
      id: "binary-tools",
      title: localizedText("launchSnippet.binaryTools.title"),
      language: "ts",
      code: `import { binaryInfo, ensureBinary, clearCache } from 'cloakbrowser';

console.log(binaryInfo());
await ensureBinary();
clearCache();`,
    },
  ];
}

export function generateLaunchCode(profile: BrowserProfile): string {
  const preview = buildLaunchPreview(profile);
  return generateLaunchCodeFromPreview(profile, preview);
}

/**
 * An init script as a template literal: the generated snippet keeps the script's own line breaks,
 * while backslashes, backticks and `${` are escaped so profile data can neither terminate the literal
 * nor interpolate into it when the snippet is copied and run.
 */
function initScriptLiteral(script: string): string {
  const escaped = script.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
  return `\`${escaped}\``;
}

function generateLaunchCodeFromPreview(profile: BrowserProfile, preview: LaunchPreview): string {
  const optionsJson = JSON.stringify(preview.options, null, 2);
  const startUrl = profile.startUrl.trim();
  // Every caller-side init script the launcher installs after the launch call, so the snippet cannot
  // claim the panel does less than it does. Each entry is empty when its feature is off, exactly like
  // the launcher: the snippet then shows no injection call at all, and a profile with both off stays
  // byte-identical to the pre-shaping output.
  const initScripts = [
    buildWatermarkScript(profile.name, profile.runtime.watermark),
    buildVoicesScript(
      voicesSeed(profile.fingerprint.seed, profile.id),
      profile.fingerprint.locale,
      profile.runtime.voices,
    ),
  ].filter(Boolean);
  const contextInjections = initScripts
    .map((script) => `\nawait context.addInitScript(${initScriptLiteral(script)});`)
    .join("");

  const firstPage =
    startUrl.length > 0
      ? `\nconst page = context.pages()[0] ?? await context.newPage();\nawait page.goto(${JSON.stringify(
          startUrl,
        )}, { waitUntil: 'domcontentloaded' });`
      : "\nconst page = context.pages()[0] ?? await context.newPage();";

  return `import { ${preview.importName} } from '${preview.importPath}';

const context = await ${preview.importName}(${optionsJson});${contextInjections}${firstPage}

// await context.close();`;
}

export function createProfileSnapshot(
  profile: BrowserProfile,
  t: Translator,
  locale: Locale,
  exportedAt = nowIso(),
): ProfileSnapshot {
  const proxy = buildProxyUrl(profile.proxy);
  const launchPreview = maskLaunchPreview(buildLaunchPreview(profile));
  const audit = auditProfile(profile);
  return {
    exportedAt,
    profile: {
      id: profile.id,
      name: profile.name,
      group: profile.group,
      tags: [...profile.tags],
      mode: profile.mode,
      launcher: profile.runtime.launcher,
      startUrl: profile.startUrl,
      proxy: maskProxyUrl(proxy),
      timezone: profile.fingerprint.timezone.trim() || (profile.runtime.geoip ? "geoip" : ""),
      locale: profile.fingerprint.locale.trim() || (profile.runtime.geoip ? "geoip" : ""),
      viewport:
        profile.viewport.mode === "native" ? "native" : `${profile.viewport.width}x${profile.viewport.height}`,
    },
    // A snapshot freezes the language it was exported in: the items are resolved to strings here, so
    // the JSON export carries text rather than dictionary keys.
    audit: {
      score: audit.score,
      summary: audit.summary,
      items: audit.items.map((item) => ({
        id: item.id,
        category: item.category,
        severity: item.severity,
        title: resolveLocalizedText(item.title, t, locale),
        detail: resolveLocalizedText(item.detail, t, locale),
      })),
    },
    launchPreview,
    launchCode: generateLaunchCodeFromPreview(profile, launchPreview),
  };
}

export function snapshotToMarkdown(snapshot: ProfileSnapshot, t: Translator): string {
  const lines = [
    `# ${t("snapshot.heading.title", { name: snapshot.profile.name })}`,
    "",
    `- ${t("snapshot.field.exportedAt", { value: snapshot.exportedAt })}`,
    `- ${t("snapshot.field.profileId", { value: snapshot.profile.id })}`,
    `- ${t("snapshot.field.group", { value: snapshot.profile.group })}`,
    `- ${t("snapshot.field.tags", { value: snapshot.profile.tags.length ? snapshot.profile.tags.join(", ") : "-" })}`,
    `- ${t("snapshot.field.mode", { value: snapshot.profile.mode })}`,
    `- ${t("snapshot.field.launcher", { value: snapshot.profile.launcher })}`,
    `- ${t("snapshot.field.proxy", { value: snapshot.profile.proxy })}`,
    `- ${t("snapshot.field.timezone", { value: snapshot.profile.timezone || "-" })}`,
    `- ${t("snapshot.field.locale", { value: snapshot.profile.locale || "-" })}`,
    `- ${t("snapshot.field.viewport", { value: snapshot.profile.viewport })}`,
    "",
    `## ${t("snapshot.heading.score", { score: snapshot.audit.score })}`,
    "",
    t("snapshot.summary", {
      pass: snapshot.audit.summary.pass,
      warn: snapshot.audit.summary.warn,
      fail: snapshot.audit.summary.fail,
      info: snapshot.audit.summary.info,
    }),
    "",
    `## ${t("snapshot.heading.items")}`,
    "",
    ...snapshot.audit.items.map((item) =>
      t("snapshot.item", { severity: item.severity, title: item.title, detail: item.detail }),
    ),
    "",
    `## ${t("snapshot.heading.launchPreview")}`,
    "",
    "```json",
    JSON.stringify(snapshot.launchPreview, null, 2),
    "```",
    "",
    `## ${t("snapshot.heading.launchCode")}`,
    "",
    "```ts",
    snapshot.launchCode,
    "```",
    "",
  ];

  return lines.join("\n");
}

export function auditProfile(profile: BrowserProfile): ProfileAuditReport {
  const items: AuditItem[] = [];
  for (const issue of upstreamOptionIssues(profile)) {
    pushAudit(items, { id: issue.id, category: "runtime", severity: "fail", title: localizedText(issue.title), detail: localizedText(issue.detail) });
  }
  const proxy = buildProxyUrl(profile.proxy);
  const webrtcMode = effectiveWebrtcIpMode(profile, proxy);

  pushAudit(items, {
    id: "persistent-profile",
    category: "persistence",
    severity: profile.mode === "persistent" ? "pass" : "warn",
    title: localizedText("profileAudit.persistentProfile.title"),
    detail: localizedText(
      profile.mode === "persistent"
        ? "profileAudit.persistentProfile.detail.persistent"
        : "profileAudit.persistentProfile.detail.ephemeral",
    ),
  });

  pushAudit(items, {
    id: "proxy",
    category: "network",
    severity: proxy ? "pass" : "warn",
    title: localizedText("profileAudit.proxy.title"),
    detail: proxy
      ? localizedText("profileAudit.proxy.detail.configured", { proxy: maskProxyUrl(proxy) })
      : localizedText("profileAudit.proxy.detail.missing"),
  });

  pushAudit(items, {
    id: "geoip-alignment",
    category: "network",
    severity: profile.runtime.geoip || Boolean(profile.fingerprint.timezone && profile.fingerprint.locale) ? "pass" : "warn",
    title: localizedText("profileAudit.geoipAlignment.title"),
    detail: localizedText(
      profile.runtime.geoip
        ? proxy
          ? "profileAudit.geoipAlignment.detail.geoipProxy"
          : "profileAudit.geoipAlignment.detail.geoipLocal"
        : profile.fingerprint.timezone && profile.fingerprint.locale
          ? "profileAudit.geoipAlignment.detail.explicit"
          : "profileAudit.geoipAlignment.detail.missing",
    ),
  });

  pushAudit(items, {
    id: "webrtc",
    category: "network",
    // `auto` without a proxy is the one stored choice that silently does nothing: the wrapper drops the
    // flag. Every other mode either applies something (`custom`, `geoip`) or is honestly off.
    severity: webrtcMode === "off" || (webrtcMode === "auto" && !proxy) ? "warn" : "pass",
    title: localizedText("profileAudit.webrtc.title"),
    detail: localizedText(
      webrtcMode === "geoip"
        ? proxy
          ? "profileAudit.webrtc.detail.geoipProxy"
          : "profileAudit.webrtc.detail.geoipLocal"
        : webrtcMode === "auto"
          ? proxy
            ? "profileAudit.webrtc.detail.autoProxy"
            : "profileAudit.webrtc.detail.autoWithoutProxy"
          : webrtcMode === "custom"
            ? "profileAudit.webrtc.detail.custom"
            : "profileAudit.webrtc.detail.off",
    ),
  });

  pushAudit(items, {
    id: "headless",
    category: "runtime",
    // The profile field is fixed headed; only an advanced launchOptions override can make a session
    // invisible, and that is what the audit reports.
    // The profile field is fixed headed and launchOptions can no longer override it, so this row is a
    // statement of what every launch does rather than a per-profile verdict.
    severity: "pass",
    title: localizedText("profileAudit.headless.title"),
    detail: localizedText("profileAudit.headless.detail.headed"),
  });

  if (profile.runtime.watermark !== "off") {
    pushAudit(items, {
      id: "watermark",
      category: "runtime",
      severity: "warn",
      title: localizedText("profileAudit.watermark.title"),
      detail: localizedText("profileAudit.watermark.detail.enabled", { watermark: profile.runtime.watermark }),
    });
  }

  const seedArg = buildFingerprintArgs(profile).reverse().find((arg) => arg.split("=")[0] === "--fingerprint");
  const seedDisabled = seedArg === "--fingerprint=off";
  pushAudit(items, {
    id: "fingerprint-seed",
    category: "identity",
    severity: seedArg && !seedDisabled ? "pass" : "info",
    title: localizedText("profileAudit.fingerprintSeed.title"),
    detail: localizedText(
      seedDisabled
        ? "profileAudit.fingerprintSeed.detail.disabled"
        : seedArg
          ? "profileAudit.fingerprintSeed.detail.set"
          : profile.mode === "persistent"
            ? "profileAudit.fingerprintSeed.detail.persisted"
            : "profileAudit.fingerprintSeed.detail.random",
    ),
  });

  pushAudit(items, {
    id: "viewport",
    category: "identity",
    severity: profile.viewport.mode === "native" ? "info" : "pass",
    title: localizedText("preflightItem.viewport.title"),
    detail: localizedText(
      profile.viewport.mode === "native"
        ? "profileAudit.viewport.detail.native"
        : "profileAudit.viewport.detail.fixed",
      profile.viewport.mode === "native"
        ? undefined
        : { width: profile.viewport.width, height: profile.viewport.height },
    ),
  });

  pushAudit(items, validateJsonAudit("launch-json", "advanced", {
    title: "preflightItem.launchJson.title",
    empty: "preflightItem.launchJson.detail.empty",
    valid: "preflightItem.launchJson.detail.valid",
  }, "launchOptions JSON", profile.advanced.launchOptionsJson));
  pushAudit(items, validateJsonAudit("context-json", "advanced", {
    title: "preflightItem.contextJson.title",
    empty: "preflightItem.contextJson.detail.empty",
    valid: "preflightItem.contextJson.detail.valid",
  }, "contextOptions JSON", profile.advanced.contextOptionsJson));
  const overriddenRawArgs = rawArgsOverridingGenerated(profile);
  if (overriddenRawArgs.length > 0) {
    pushAudit(items, {
      id: "raw-arg-override",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.rawArgOverride.title"),
      detail: localizedText("preflightItem.rawArgOverride.detail", { flags: overriddenRawArgs.join(", ") }),
    });
  }

  const fingerprintOffSources = fingerprintOffConflicts(profile);
  if (fingerprintOffSources.length > 0) {
    pushAudit(items, {
      id: "fingerprint-off-mixed",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.fingerprintOffMixed.title"),
      detail: localizedText("preflightItem.fingerprintOffMixed.detail", { sources: fingerprintOffSources.join(", ") }),
    });
  }

  const summary = summarizeAudit(items);
  return {
    score: auditScore(summary),
    summary,
    items,
  };
}

function pruneUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => {
      if (item === undefined) return false;
      if (Array.isArray(item)) return item.length > 0;
      if (typeof item === "string") return item.trim().length > 0;
      return true;
    }),
  );
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as Partial<T>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function encodeBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function decodeBase64Url(value: string): string {
  const normalized = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function maskLaunchPreview(preview: LaunchPreview): LaunchPreview {
  return {
    ...preview,
    options: maskSensitiveValues(preview.options) as Record<string, unknown>,
  };
}

function maskSensitiveValues(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSensitiveValues);
  if (!value || typeof value !== "object") return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/password|token|secret|credential/i.test(key)) {
      result[key] = "****";
    } else if (key === "proxy" && typeof item === "string") {
      result[key] = maskProxyUrl(item);
    } else {
      result[key] = maskSensitiveValues(item);
    }
  }
  return result;
}

function getRuntimeQuickArg(id: RuntimeQuickArgId): RuntimeQuickArg {
  const quickArg = RUNTIME_QUICK_ARGS.find((item) => item.id === id);
  if (!quickArg) throw new Error(`Unknown runtime quick arg: ${id}`);
  return quickArg;
}

function isDetectionCheckStatus(value: unknown): value is DetectionCheckStatus {
  return value === "untested" || value === "pass" || value === "warn" || value === "fail";
}

function pushAudit(items: AuditItem[], item: AuditItem): void {
  items.push(item);
}

function pushPreflight(items: ProfilePreflightItem[], item: ProfilePreflightItem): void {
  items.push(item);
}

function preflightFromAudit(item: AuditItem): ProfilePreflightItem {
  return {
    id: item.id,
    category: item.category,
    severity: item.severity,
    title: item.title,
    detail: item.detail,
    actions: item.severity === "fail" ? [openTabAction("advanced", "preflightItem.action.checkJson")] : undefined,
  };
}

function openTabAction(target: PreflightActionTarget, labelKey: string): ProfilePreflightAction {
  return {
    id: `open-${target}`,
    kind: "open-tab",
    label: localizedText(labelKey),
    target,
  };
}

function xrayShareLinkProblem(shareLink: string): string {
  try {
    parseXrayShareLink(shareLink);
    return "未知错误";
  } catch (error) {
    return (error as Error).message;
  }
}

/** Which role the engine plays for this proxy: the phrase is a dictionary entry of its own. */
function xrayEngineRole(profile: BrowserProfile): LocalizedText {
  return localizedText(
    profile.proxy.preProxyId.trim()
      ? "preflightItem.xrayEngine.role.chained"
      : profile.proxy.scheme === "xray"
        ? "preflightItem.xrayEngine.role.node"
        : "preflightItem.xrayEngine.role.native",
  );
}

// The engine is a second binary next to the browser core, and a proxy that needs it cannot launch
// without it — so its absence is a failure with an install action, exactly like the core's.
function pushXrayEnginePreflight(
  items: ProfilePreflightItem[],
  profile: BrowserProfile,
  engine: ProfilePreflightXrayEngine | undefined,
): void {
  const chained = Boolean(profile.proxy.preProxyId.trim());
  const role = xrayEngineRole(profile);
  if (!engine) {
    pushPreflight(items, {
      id: "xray-engine",
      category: "environment",
      severity: "info",
      title: localizedText("preflightItem.xrayEngine.title"),
      detail: localizedText("preflightItem.xrayEngine.detail.unknown", { role }),
    });
    return;
  }
  pushPreflight(items, {
    id: "xray-engine",
    category: "environment",
    severity: engine.installed ? "pass" : "fail",
    title: localizedText("preflightItem.xrayEngine.title"),
    detail: engine.installed
      ? engine.binaryPath
        ? localizedText("preflightItem.xrayEngine.detail.installed", {
            version: engine.version ? ` ${engine.version}` : "",
            path: engine.binaryPath,
          })
        : localizedText("preflightItem.xrayEngine.detail.installedNoPath", {
            version: engine.version ? ` ${engine.version}` : "",
          })
      : engine.detail
        ? externalText(engine.detail)
        : localizedText("preflightItem.xrayEngine.detail.missing", { role }),
    actions: engine.installed ? undefined : [{ id: "install-xray", kind: "install-xray", label: localizedText("preflightItem.action.installXray") }],
  });
  if (chained) {
    const preProxy = engine.preProxy;
    pushPreflight(items, {
      id: "xray-pre-proxy",
      category: "network",
      severity: preProxy ? (preProxy.ok ? "pass" : "fail") : "info",
      title: localizedText("preflightItem.xrayPreProxy.title"),
      detail: preProxy
        ? preProxy.ok
          ? localizedText("preflightItem.xrayPreProxy.detail.linked", { name: preProxy.name ?? preProxy.id })
          : preProxy.detail
            ? externalText(preProxy.detail)
            : localizedText("preflightItem.xrayPreProxy.detail.unavailable")
        : localizedText("preflightItem.xrayPreProxy.detail.unknown"),
      actions: preProxy && !preProxy.ok ? [openTabAction("proxy", "preflightItem.action.adjustPreProxy")] : undefined,
    });
  }
}

function validateStartUrlPreflight(startUrl: string): ProfilePreflightItem {
  const result = validateStartUrl(startUrl);
  if (result.ok && result.kind === "empty") {
    return {
      id: "start-url",
      category: "runtime",
      severity: "info",
      title: localizedText("preflightItem.startUrl.title"),
      detail: localizedText("preflightItem.startUrl.detail.empty"),
    };
  }

  if (result.ok) {
    return {
      id: "start-url",
      category: "runtime",
      severity: "pass",
      title: localizedText("preflightItem.startUrl.title"),
      detail: localizedText(
        result.kind === "system" ? "preflightItem.startUrl.detail.system" : "preflightItem.startUrl.detail.web",
        { value: result.value },
      ),
    };
  }

  return {
    id: "start-url",
    category: "runtime",
    severity: "fail",
    title: localizedText("preflightItem.startUrl.title"),
    // The validator words its message for the editor form; the report re-keys the reason so the
    // failure reads in the panel's language.
    detail: localizedText(
      result.reason === "unsupported-protocol"
        ? "preflightItem.startUrl.detail.unsupportedProtocol"
        : "preflightItem.startUrl.detail.invalid",
      result.reason === "unsupported-protocol" ? { protocol: result.protocol ?? "" } : undefined,
    ),
    actions: [openTabAction("runtime", "preflightItem.action.fixStartUrl")],
  };
}

function validateViewportPreflight(profile: BrowserProfile): ProfilePreflightItem {
  if (profile.viewport.mode === "native") {
    return {
      id: "viewport",
      category: "identity",
      severity: "info",
      title: localizedText("preflightItem.viewport.title"),
      detail: localizedText("preflightItem.viewport.detail.native"),
    };
  }

  const widthOk = Number.isFinite(profile.viewport.width) && profile.viewport.width >= 320;
  const heightOk = Number.isFinite(profile.viewport.height) && profile.viewport.height >= 320;
  return {
    id: "viewport",
    category: "identity",
    severity: widthOk && heightOk ? "pass" : "fail",
    title: localizedText("preflightItem.viewport.title"),
    detail:
      widthOk && heightOk
        ? localizedText("preflightItem.viewport.detail.fixed", {
            width: profile.viewport.width,
            height: profile.viewport.height,
          })
        : localizedText("preflightItem.viewport.detail.invalid"),
    actions: widthOk && heightOk ? undefined : [openTabAction("runtime", "preflightItem.action.fixViewport")],
  };
}

/**
 * The exit check joins an IP, a region, a colo and a latency. Only the region has a display name that
 * depends on the reader's language, so the builder keeps it as its own template slot with the region
 * code as the value (`{ region }`) and joins the parts around it; the renderer formats the code.
 */
function networkCheckSummaryDetail(check: NetworkCheckResult): LocalizedText {
  const ip = check.ip?.trim() ?? "";
  // The name and the raw trace value are only fallbacks for a probe that reported no usable code, so
  // an empty (or whitespace-only) entry falls through instead of ending the chain.
  const region =
    networkCheckCountryCode(check) ?? (check.geo?.countryName?.trim() || check.trace?.loc?.trim() || "");
  const tailParts = [check.trace?.colo?.trim(), ...(typeof check.latencyMs === "number" && Number.isFinite(check.latencyMs) ? [`${check.latencyMs}ms`] : [])].filter(
    (part): part is string => Boolean(part),
  );
  if (!ip && !region && tailParts.length === 0) return localizedText("preflightItem.networkCheck.detail.passEmpty");

  return localizedText("preflightItem.networkCheck.detail.pass", {
    head: ip ? `${ip}${region ? " · " : ""}` : "",
    region: region ? { region } : "",
    tail: tailParts.length ? `${ip || region ? " · " : ""}${tailParts.join(" · ")}` : "",
  });
}

function networkCheckPreflight(check: NetworkCheckResult | undefined): ProfilePreflightItem {
  if (!check) {
    return {
      id: "network-check",
      category: "network",
      severity: "warn",
      title: localizedText("preflightItem.networkCheck.title"),
      detail: localizedText("preflightItem.networkCheck.detail.missing"),
      actions: [openTabAction("proxy", "preflightItem.action.checkProxy")],
    };
  }

  if (!check.ok) {
    return {
      id: "network-check",
      category: "network",
      severity: "warn",
      title: localizedText("preflightItem.networkCheck.title"),
      detail: check.error
        ? localizedText("preflightItem.networkCheck.detail.failed", { error: check.error })
        : localizedText("preflightItem.networkCheck.detail.failedUnknown"),
      actions: [openTabAction("proxy", "preflightItem.action.recheckProxy")],
    };
  }

  return {
    id: "network-check",
    category: "network",
    severity: "pass",
    title: localizedText("preflightItem.networkCheck.title"),
    detail: networkCheckSummaryDetail(check),
  };
}

interface JsonAuditKeys {
  title: string;
  empty: string;
  valid: string;
}

function validateJsonAudit(
  id: string,
  category: AuditCategory,
  keys: JsonAuditKeys,
  jsonLabel: string,
  value: string,
): AuditItem {
  const title = localizedText(keys.title);
  if (!value.trim()) {
    return {
      id,
      category,
      severity: "info",
      title,
      detail: localizedText(keys.empty),
    };
  }

  try {
    parseOptionalJsonObject(jsonLabel, value);
    return {
      id,
      category,
      severity: "pass",
      title,
      detail: localizedText(keys.valid),
    };
  } catch (error) {
    return {
      id,
      category,
      severity: "fail",
      title,
      detail: externalText((error as Error).message),
    };
  }
}

function summarizeAudit(items: AuditItem[]): ProfileAuditReport["summary"] {
  return summarizeSeverity(items);
}

function summarizeSeverity(items: Array<{ severity: AuditSeverity }>): ProfileAuditReport["summary"] {
  return items.reduce(
    (summary, item) => {
      summary[item.severity] += 1;
      return summary;
    },
    { pass: 0, warn: 0, fail: 0, info: 0 },
  );
}

function auditScore(summary: ProfileAuditReport["summary"]): number {
  const total = summary.pass + summary.warn + summary.fail;
  if (!total) return 100;
  return Math.max(0, Math.round(((summary.pass * 100 + summary.warn * 55) / total) - summary.fail * 15));
}
