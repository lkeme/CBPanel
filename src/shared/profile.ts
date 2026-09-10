import type { AppSettings, StorageInfo } from "./settings";
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
export type LauncherKind = "playwright-context" | "playwright-browser" | "puppeteer-browser";
/**
 * `xray` is not a URL scheme CloakBrowser understands: it marks a share-link node (vmess/vless/
 * trojan/ss/…) that the panel's Xray engine turns into a local SOCKS5 proxy at launch.
 */
export type ProxyScheme = "http" | "https" | "socks5" | "xray";
export type FingerprintPlatform = "auto" | "windows" | "macos" | "linux";
export type ColorScheme = "light" | "dark" | "no-preference";
export type HumanPreset = "default" | "careful";
export type ViewportMode = "fixed" | "native";
export type ProfilePresetId = "local-qa" | "residential-proxy" | "returning-session" | "throwaway-session";
export type RuntimeQuickArgId =
  | "fake-shadow-root"
  | "disable-http2"
  | "fingerprint-off"
  | "allow-3p-cookies"
  | "windows-font-metrics"
  | "license-through-proxy";
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
  seed: string;
  platform: FingerprintPlatform;
  brand: string;
  brandVersion: string;
  platformVersion: string;
  hardwareConcurrency: string;
  deviceMemory: string;
  screenWidth: number;
  screenHeight: number;
  storageQuotaMb: string;
  taskbarHeight: string;
  gpuVendor: string;
  gpuRenderer: string;
  timezone: string;
  locale: string;
  webrtcIp: "off" | "auto" | "custom";
  webrtcIpValue: string;
  noise: boolean;
}

export interface RuntimeSettings {
  launcher: LauncherKind;
  headless: boolean;
  stealthArgs: boolean;
  geoip: boolean;
  humanize: boolean;
  humanPreset: HumanPreset;
  /** Page overlay that identifies this environment. `off` injects nothing at all. */
  watermark: WatermarkStyle;
  /**
   * Shapes `speechSynthesis.getVoices()` into a stable per-environment subset. On by default like
   * `geoip`, not off like `watermark`: the raw host list is identical in every environment, so
   * leaving it alone is an anti-leak gap rather than a visible feature.
   */
  voices: boolean;
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

export interface AdvancedSettings {
  launchOptionsJson: string;
  contextOptionsJson: string;
  humanConfigJson: string;
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
  humanize: boolean;
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
export type PreflightActionKind = "install-binary" | "install-xray" | "open-tab";
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
  checkedAt?: string;
  userDataDir?: string;
  binaryInstalled?: boolean;
  binaryPath?: string;
  binaryDetail?: string;
  userDataDirWritable?: boolean;
  userDataDirDetail?: string;
  extensionChecks?: Array<{ path: string; exists: boolean; detail?: string }>;
  extensionErrors?: Array<{ name: string; detail: string }>;
  extensionWarnings?: Array<{ name: string; detail: string }>;
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
  },
  {
    id: "disable-http2",
    label: "Disable HTTP/2",
    flag: "--disable-http2",
  },
  {
    id: "fingerprint-off",
    label: "Fingerprint Off",
    flag: "--fingerprint=off",
  },
  {
    id: "allow-3p-cookies",
    label: "Allow 3P Cookies",
    flag: "--fingerprint-allow-3p-cookies",
  },
  {
    id: "windows-font-metrics",
    label: "Windows Font Metrics",
    flag: "--fingerprint-windows-font-metrics",
  },
  {
    id: "license-through-proxy",
    label: "License via Proxy",
    flag: "--license-through-proxy",
  },
];

const WRAPPER_OWNED_CHROMIUM_ARGS = new Set(["--no-sandbox"]);

export const PROFILE_PRESETS: ProfilePreset[] = [
  {
    id: "local-qa",
    name: "本地 QA",
    summary: "可见窗口、持久化、固定 seed，适合先验证内核和配置映射。",
    tags: ["local", "qa"],
  },
  {
    id: "residential-proxy",
    name: "住宅代理",
    summary: "代理 + GeoIP + WebRTC auto，人类化更谨慎。",
    tags: ["proxy", "geoip"],
  },
  {
    id: "returning-session",
    name: "长期账号",
    summary: "持久化、固定身份、保守输入节奏，适合回访型 profile。",
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
      brand: "",
      brandVersion: "",
      platformVersion: "",
      hardwareConcurrency: "",
      deviceMemory: "",
      screenWidth: 1920,
      screenHeight: 1080,
      storageQuotaMb: "",
      taskbarHeight: "",
      gpuVendor: "",
      gpuRenderer: "",
      timezone: "",
      locale: "",
      webrtcIp: "off",
      webrtcIpValue: "",
      noise: true,
    },
    runtime: {
      launcher: "playwright-context",
      headless: false,
      stealthArgs: true,
      // New profiles start with GeoIP on so timezone/locale follow the proxy (or the current public
      // exit) instead of leaking the host machine's locale. Stored profiles keep their own value:
      // mergeProfile drops undefined, so only sources that omit the field entirely land on this default.
      geoip: true,
      humanize: true,
      humanPreset: "default",
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
      width: 1920,
      height: 947,
      userAgent: "",
      colorScheme: "light",
    },
    advanced: {
      launchOptionsJson: "",
      contextOptionsJson: "",
      humanConfigJson: "",
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
      extensionPaths: Array.isArray(cleanInput.runtime?.extensionPaths)
        ? cleanInput.runtime.extensionPaths
        : base.runtime.extensionPaths,
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
    updatedAt: profile.updatedAt || nowIso(),
    verification: {
      detectionChecks: normalizeDetectionChecks(profile.verification.detectionChecks),
    },
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
    throw new Error("Clipboard does not contain a CBPanel profile config string.");
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
      next.fingerprint.seed = next.fingerprint.seed || "42069";
      next.fingerprint.timezone = next.fingerprint.timezone || "Asia/Shanghai";
      next.fingerprint.locale = next.fingerprint.locale || "zh-CN";
      next.fingerprint.webrtcIp = "off";
      next.runtime.launcher = "playwright-context";
      next.runtime.headless = false;
      next.runtime.stealthArgs = true;
      next.runtime.geoip = false;
      next.runtime.humanize = true;
      next.runtime.humanPreset = "default";
      next.viewport.mode = "fixed";
      next.viewport.width = 1920;
      next.viewport.height = 947;
      break;

    case "residential-proxy":
      next.group = "代理";
      next.mode = "persistent";
      next.startUrl = "https://browserleaks.com/webrtc";
      next.fingerprint.seed = next.fingerprint.seed || "99887";
      next.fingerprint.timezone = "";
      next.fingerprint.locale = "";
      next.fingerprint.webrtcIp = "auto";
      next.runtime.launcher = "playwright-context";
      next.runtime.headless = false;
      next.runtime.stealthArgs = true;
      next.runtime.geoip = true;
      next.runtime.humanize = true;
      next.runtime.humanPreset = "careful";
      next.proxy.enabled = true;
      next.proxy.bypass = next.proxy.bypass || "localhost,127.0.0.1";
      break;

    case "returning-session":
      next.group = "账号";
      next.mode = "persistent";
      next.startUrl = next.startUrl || DEFAULT_START_URL;
      next.fingerprint.seed = next.fingerprint.seed || "73531";
      next.runtime.launcher = "playwright-context";
      next.runtime.headless = false;
      next.runtime.stealthArgs = true;
      next.runtime.humanize = true;
      next.runtime.humanPreset = "careful";
      next.viewport.mode = "fixed";
      next.viewport.colorScheme = "light";
      break;

    case "throwaway-session":
      next.group = "临时";
      next.mode = "ephemeral";
      next.startUrl = next.startUrl || DEFAULT_START_URL;
      next.fingerprint.seed = "";
      next.fingerprint.webrtcIp = "off";
      next.runtime.launcher = "playwright-context";
      next.runtime.headless = false;
      next.runtime.stealthArgs = true;
      next.runtime.geoip = false;
      next.runtime.humanize = false;
      next.runtime.humanPreset = "default";
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

export function effectiveWebrtcIpMode(
  profile: BrowserProfile,
  proxyUrl = buildProxyUrl(profile.proxy),
): EffectiveWebrtcIpMode {
  if (profile.fingerprint.webrtcIp === "custom") return "custom";
  if (profile.fingerprint.webrtcIp === "auto") return "auto";
  if (profile.runtime.geoip && geoipCanProvideExitIp(profile, proxyUrl)) {
    return "geoip";
  }
  return "off";
}

export function geoipCanProvideExitIp(
  profile: BrowserProfile,
  proxyUrl = buildProxyUrl(profile.proxy),
): boolean {
  return Boolean(proxyUrl) || !profile.fingerprint.timezone.trim() || !profile.fingerprint.locale.trim();
}

function webrtcAutoHasNetworkAnchor(
  profile: BrowserProfile,
  proxyUrl = buildProxyUrl(profile.proxy),
): boolean {
  return Boolean(proxyUrl) || (profile.runtime.geoip && geoipCanProvideExitIp(profile, proxyUrl));
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
      humanConfigJson: maskAdvancedJsonString(profile.advanced.humanConfigJson),
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

function sanitizeLaunchOptions(launchOptions: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...(launchOptions ?? {}) };

  // CloakBrowser owns the browser compatibility policy and forwards this option to Playwright, whose
  // supported default is false. Forcing true makes Chromium 151 start a process but never complete the
  // remote-debugging-pipe handshake, even with no extensions or fingerprint flags. Remove both legacy
  // true and false overrides so wrapper upgrades retain one authoritative default.
  delete sanitized.chromiumSandbox;

  if (Array.isArray(sanitized.args)) {
    sanitized.args = sanitized.args.filter((arg) => typeof arg !== "string" || !isWrapperOwnedChromiumArg(arg));
  }
  return sanitized;
}

function hasUnsupportedChromiumSandboxOverride(profile: BrowserProfile): boolean {
  try {
    const launchOptions = parseOptionalJsonObject("launchOptions", profile.advanced.launchOptionsJson);
    return launchOptions?.chromiumSandbox === true;
  } catch {
    return false;
  }
}

function chromiumSandboxOverrideDetail(profile: BrowserProfile): LocalizedText {
  return localizedText(
    profile.runtime.launcher === "puppeteer-browser"
      ? "preflightItem.chromiumSandbox.detail.puppeteer"
      : "preflightItem.chromiumSandbox.detail.playwright",
  );
}

export function buildFingerprintArgs(profile: BrowserProfile): string[] {
  const fp = profile.fingerprint;
  const args: string[] = [];

  pushFlag(args, "--fingerprint", fp.seed);
  if (fp.platform !== "auto") pushFlag(args, "--fingerprint-platform", fp.platform);
  pushFlag(args, "--fingerprint-brand", fp.brand);
  pushFlag(args, "--fingerprint-brand-version", fp.brandVersion);
  pushFlag(args, "--fingerprint-platform-version", fp.platformVersion);
  pushFlag(args, "--fingerprint-hardware-concurrency", fp.hardwareConcurrency);
  pushFlag(args, "--fingerprint-device-memory", fp.deviceMemory);
  pushFlag(args, "--fingerprint-screen-width", fp.screenWidth);
  pushFlag(args, "--fingerprint-screen-height", fp.screenHeight);
  pushFlag(args, "--fingerprint-storage-quota", fp.storageQuotaMb);
  pushFlag(args, "--fingerprint-taskbar-height", fp.taskbarHeight);
  pushFlag(args, "--fingerprint-gpu-vendor", fp.gpuVendor);
  pushFlag(args, "--fingerprint-gpu-renderer", fp.gpuRenderer);

  if (fp.webrtcIp === "auto") args.push("--fingerprint-webrtc-ip=auto");
  if (fp.webrtcIp === "custom") pushFlag(args, "--fingerprint-webrtc-ip", fp.webrtcIpValue);
  if (!fp.noise) args.push("--fingerprint-noise=false");

  return [...args, ...sanitizeChromiumArgs(profile.runtime.extraArgs)];
}

export interface LaunchPreview {
  launcher:
    | "launchPersistentContext"
    | "launchContext"
    | "launch"
    | "puppeteerLaunch"
    | "puppeteerLaunchPersistentContext";
  importPath: "cloakbrowser" | "cloakbrowser/puppeteer";
  importName: "launchPersistentContext" | "launchContext" | "launch";
  resultType: "context" | "browser";
  options: Record<string, unknown>;
  contextOptions?: Record<string, unknown>;
}

export interface LaunchRuntimeHints {
  browserVersion?: string;
}

const BROWSER_VERSION_HINT_RE = /^[0-9]+(?:\.[0-9]+){3,4}$/;

export function browserVersionLaunchHints(browserVersion: string | undefined): LaunchRuntimeHints {
  const version = browserVersion?.trim();
  return version && BROWSER_VERSION_HINT_RE.test(version) ? { browserVersion: version } : {};
}

export function buildLaunchPreview(
  profile: BrowserProfile,
  userDataDir?: string,
  runtimeHints: LaunchRuntimeHints = {},
): LaunchPreview {
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
  const args = buildFingerprintArgs(profile);
  const launchOptions = sanitizeLaunchOptions(parseOptionalJsonObject("launchOptions", advanced.launchOptionsJson));
  const contextOptions = parseOptionalJsonObject("contextOptions", advanced.contextOptionsJson);
  const humanConfig = parseOptionalJsonObject("humanConfig", advanced.humanConfigJson);
  const options: Record<string, unknown> = {
    headless: profile.runtime.headless,
    stealthArgs: profile.runtime.stealthArgs,
    geoip: profile.runtime.geoip,
    humanize: profile.runtime.humanize,
    humanPreset: profile.runtime.humanPreset,
  };

  if (profile.mode === "persistent" && profile.runtime.launcher !== "playwright-browser") {
    options.userDataDir = userDataDir ?? `./data/browser-data/${profile.id}`;
  }
  if (proxyOption) options.proxy = proxyOption;
  if (args.length) options.args = args;
  if (profile.fingerprint.timezone.trim()) options.timezone = profile.fingerprint.timezone.trim();
  if (profile.fingerprint.locale.trim()) options.locale = profile.fingerprint.locale.trim();
  if (profile.runtime.extensionPaths.length) options.extensionPaths = profile.runtime.extensionPaths;
  if (humanConfig) options.humanConfig = humanConfig;
  Object.assign(options, browserVersionLaunchHints(runtimeHints.browserVersion));
  options.launchOptions = launchOptions;

  if (profile.runtime.launcher === "playwright-context") {
    if (profile.viewport.userAgent.trim()) options.userAgent = profile.viewport.userAgent.trim();
    options.viewport = profile.viewport.mode === "native" ? null : { width: profile.viewport.width, height: profile.viewport.height };
    options.colorScheme = profile.viewport.colorScheme;
    if (contextOptions) options.contextOptions = contextOptions;

    return {
      launcher: profile.mode === "persistent" ? "launchPersistentContext" : "launchContext",
      importPath: "cloakbrowser",
      importName: profile.mode === "persistent" ? "launchPersistentContext" : "launchContext",
      resultType: "context",
      options: pruneUndefined(options),
    };
  }

  if (profile.runtime.launcher === "playwright-browser") {
    return {
      launcher: "launch",
      importPath: "cloakbrowser",
      importName: "launch",
      resultType: "browser",
      options: pruneUndefined(options),
      contextOptions: buildPlaywrightContextOptions(profile),
    };
  }

  return {
    launcher: profile.mode === "persistent" ? "puppeteerLaunchPersistentContext" : "puppeteerLaunch",
    importPath: "cloakbrowser/puppeteer",
    importName: profile.mode === "persistent" ? "launchPersistentContext" : "launch",
    resultType: "browser",
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
    humanize: profile.runtime.humanize,
  };
}

export function preflightProfile(
  profile: BrowserProfile,
  environment: ProfilePreflightEnvironment = {},
): ProfilePreflightReport {
  const items: ProfilePreflightItem[] = [];
  const checkedAt = environment.checkedAt ?? nowIso();
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
  pushPreflight(items, preflightFromAudit(validateJsonAudit("human-json", "advanced", {
    title: "preflightItem.humanJson.title",
    empty: "preflightItem.humanJson.detail.empty",
    valid: "preflightItem.humanJson.detail.valid",
  }, "humanConfig JSON", profile.advanced.humanConfigJson)));

  if (hasUnsupportedChromiumSandboxOverride(profile)) {
    pushPreflight(items, {
      id: "chromium-sandbox",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.chromiumSandbox.title"),
      detail: chromiumSandboxOverrideDetail(profile),
      actions: [openTabAction("advanced", "preflightItem.action.removeOverride")],
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
      actions: environment.binaryInstalled ? undefined : [{ id: "install-binary", kind: "install-binary", label: localizedText("preflightItem.action.installBinary") }],
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

  if (profile.mode === "persistent" && profile.runtime.launcher === "playwright-browser") {
    pushPreflight(items, {
      id: "persistent-playwright-browser",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.persistentPlaywrightBrowser.title"),
      detail: localizedText("preflightItem.persistentPlaywrightBrowser.detail"),
      actions: [openTabAction("runtime", "preflightItem.action.adjustLauncher")],
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

  if (profile.fingerprint.webrtcIp === "auto" && !webrtcAutoHasNetworkAnchor(profile, proxyUrl)) {
    pushPreflight(items, {
      id: "webrtc-auto-without-network-anchor",
      category: "network",
      severity: "warn",
      title: localizedText("preflightItem.webrtcAutoWithoutAnchor.title"),
      detail: localizedText("preflightItem.webrtcAutoWithoutAnchor.detail"),
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

  if (environment.extensionWarnings?.length) {
    for (const [index, extension] of environment.extensionWarnings.entries()) {
      pushPreflight(items, {
        id: `extension-warning-${index}`,
        category: "runtime",
        severity: "warn",
        title: localizedText("preflightItem.extensionWarning.title"),
        detail: localizedText("preflightItem.extensionWarning.detail", { name: extension.name, detail: extension.detail }),
        actions: [openTabAction("advanced", "preflightItem.action.checkExtensions")],
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
        actions: [openTabAction("advanced", "preflightItem.action.checkExtensions")],
      });
    }
  } else if (profile.runtime.extensionPaths.length === 0) {
    if (!environment.extensionWarnings?.length) {
      pushPreflight(items, {
        id: "extensions",
        category: "runtime",
        severity: "info",
        title: localizedText("preflightItem.extensions.title"),
        detail: localizedText("preflightItem.extensions.detail.none"),
      });
    }
  } else if (environment.extensionChecks?.length) {
    for (const extension of environment.extensionChecks) {
      pushPreflight(items, {
        id: `extension-${extension.path}`,
        category: "runtime",
        severity: extension.exists ? "pass" : "fail",
        title: localizedText("preflightItem.extensions.title"),
        detail: extension.exists
          ? localizedText("preflightItem.extensions.detail.exists", { path: extension.path })
          : extension.detail
            ? externalText(extension.detail)
            : localizedText("preflightItem.extensions.detail.missing", { path: extension.path }),
        actions: extension.exists ? undefined : [openTabAction("advanced", "preflightItem.action.checkPaths")],
      });
    }
  } else {
    pushPreflight(items, {
      id: "extensions",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.extensions.title"),
      detail: localizedText("preflightItem.extensions.detail.unverified"),
    });
  }

  if (
    profile.runtime.extensionPaths.length > 0
    && (profile.runtime.launcher === "playwright-browser" || profile.mode !== "persistent")
  ) {
    pushPreflight(items, {
      id: "extension-persistence",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.extensionPersistence.title"),
      detail: localizedText(
        profile.runtime.launcher === "playwright-browser"
          ? "preflightItem.extensionPersistence.detail.browser"
          : "preflightItem.extensionPersistence.detail.ephemeral",
      ),
      actions: [openTabAction("runtime", "preflightItem.action.adjustLauncher")],
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
  };
}

export function buildPlaywrightContextOptions(profile: BrowserProfile): Record<string, unknown> {
  const raw = parseOptionalJsonObject("contextOptions", profile.advanced.contextOptionsJson) ?? {};
  const { locale: _locale, timezoneId: _timezoneId, ...contextOptions } = raw;
  if (profile.viewport.userAgent.trim()) contextOptions.userAgent = profile.viewport.userAgent.trim();
  contextOptions.viewport =
    profile.viewport.mode === "native" ? null : { width: profile.viewport.width, height: profile.viewport.height };
  contextOptions.colorScheme = profile.viewport.colorScheme;
  return pruneUndefined(contextOptions);
}

export function buildPuppeteerPageSetup(profile: BrowserProfile): {
  userAgent?: string;
  viewport?: { width: number; height: number };
} {
  return pruneUndefined({
    userAgent: profile.viewport.userAgent.trim() || undefined,
    viewport: profile.viewport.mode === "fixed" ? { width: profile.viewport.width, height: profile.viewport.height } : undefined,
  }) as {
    userAgent?: string;
    viewport?: { width: number; height: number };
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

  if (preview.resultType === "context") {
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

  if (preview.importPath === "cloakbrowser") {
    const contextOptionsJson = JSON.stringify(preview.contextOptions ?? {}, null, 2);
    const gotoLine = startUrl
      ? `\nawait page.goto(${JSON.stringify(startUrl)}, { waitUntil: 'domcontentloaded' });`
      : "";

    return `import { launch } from 'cloakbrowser';

const browser = await launch(${optionsJson});
const context = await browser.newContext(${contextOptionsJson});${contextInjections}
const page = await context.newPage();${gotoLine}

// await browser.close();`;
  }

  const setup = buildPuppeteerPageSetup(profile);
  const setupLines = [
    ...initScripts.map((script) => `await page.evaluateOnNewDocument(${initScriptLiteral(script)});`),
    setup.userAgent ? `await page.setUserAgent(${JSON.stringify(setup.userAgent)});` : "",
    setup.viewport ? `await page.setViewport(${JSON.stringify(setup.viewport)});` : "",
    startUrl ? `await page.goto(${JSON.stringify(startUrl)}, { waitUntil: 'domcontentloaded' });` : "",
  ].filter(Boolean);

  return `import { ${preview.importName} } from 'cloakbrowser/puppeteer';

const browser = await ${preview.importName}(${optionsJson});
const pages = await browser.pages();
const page = pages[0] ?? await browser.newPage();${setupLines.length ? `\n${setupLines.join("\n")}` : ""}

// await browser.close();`;
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

export function profileScore(profile: BrowserProfile): Array<{ label: LocalizedText; ok: boolean; detail: LocalizedText }> {
  const proxy = buildProxyUrl(profile.proxy);
  return [
    {
      label: localizedText("profileScore.persistence.label"),
      ok: profile.mode === "persistent",
      detail: localizedText(
        profile.mode === "persistent"
          ? "profileScore.persistence.detail.persistent"
          : "profileScore.persistence.detail.ephemeral",
      ),
    },
    {
      label: localizedText("profileScore.proxy.label"),
      ok: Boolean(proxy),
      detail: proxy
        ? localizedText("profileScore.proxy.detail.configured", { proxy: maskProxyUrl(proxy) })
        : localizedText("profileScore.proxy.detail.missing"),
    },
    {
      label: localizedText("profileScore.geoip.label"),
      ok: profile.runtime.geoip || Boolean(profile.fingerprint.timezone && profile.fingerprint.locale),
      detail: localizedText(
        profile.runtime.geoip ? "profileScore.geoip.detail.auto" : "profileScore.geoip.detail.manual",
      ),
    },
    {
      label: localizedText("profileScore.humanize.label"),
      ok: profile.runtime.humanize,
      detail: profile.runtime.humanize
        ? localizedText("profileScore.humanize.detail.on", {
            preset: localizedText(profile.runtime.humanPreset === "careful" ? "form.careful" : "form.default"),
          })
        : localizedText("profileScore.humanize.detail.off"),
    },
  ];
}

export function auditProfile(profile: BrowserProfile): ProfileAuditReport {
  const items: AuditItem[] = [];
  const proxy = buildProxyUrl(profile.proxy);
  const webrtcMode = effectiveWebrtcIpMode(profile, proxy);
  const webrtcAutoAnchored = webrtcAutoHasNetworkAnchor(profile, proxy);

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
    id: "launcher-kind",
    category: "runtime",
    severity: profile.runtime.launcher === "puppeteer-browser" ? "warn" : "pass",
    title: localizedText("profileAudit.launcherKind.title"),
    detail: localizedText(
      profile.runtime.launcher === "puppeteer-browser"
        ? "profileAudit.launcherKind.detail.puppeteer"
        : profile.runtime.launcher === "playwright-browser"
          ? "profileAudit.launcherKind.detail.playwrightBrowser"
          : "profileAudit.launcherKind.detail.playwrightContext",
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
    severity: webrtcMode === "off" || (webrtcMode === "auto" && !webrtcAutoAnchored) ? "warn" : "pass",
    title: localizedText("profileAudit.webrtc.title"),
    detail: localizedText(
      webrtcMode === "geoip"
        ? proxy
          ? "profileAudit.webrtc.detail.geoipProxy"
          : "profileAudit.webrtc.detail.geoipLocal"
        : webrtcMode === "auto"
        ? proxy
          ? "profileAudit.webrtc.detail.autoProxy"
          : webrtcAutoAnchored
            ? "profileAudit.webrtc.detail.autoAnchored"
            : "profileAudit.webrtc.detail.autoUnanchored"
        : webrtcMode === "custom"
          ? "profileAudit.webrtc.detail.custom"
          : "profileAudit.webrtc.detail.off",
    ),
  });

  pushAudit(items, {
    id: "humanize",
    category: "runtime",
    severity: profile.runtime.humanize ? "pass" : "warn",
    title: localizedText("profileAudit.humanize.title"),
    detail: profile.runtime.humanize
      ? localizedText("profileAudit.humanize.detail.on", { preset: profile.runtime.humanPreset })
      : localizedText("profileAudit.humanize.detail.off"),
  });

  pushAudit(items, {
    id: "headless",
    category: "runtime",
    severity: profile.runtime.headless ? "warn" : "pass",
    title: localizedText("profileAudit.headless.title"),
    detail: localizedText(
      profile.runtime.headless ? "profileAudit.headless.detail.headless" : "profileAudit.headless.detail.headed",
    ),
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

  pushAudit(items, {
    id: "fingerprint-seed",
    category: "identity",
    severity: profile.fingerprint.seed.trim() ? "pass" : "info",
    title: localizedText("profileAudit.fingerprintSeed.title"),
    detail: localizedText(
      profile.fingerprint.seed.trim()
        ? "profileAudit.fingerprintSeed.detail.set"
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
  pushAudit(items, validateJsonAudit("human-json", "advanced", {
    title: "preflightItem.humanJson.title",
    empty: "preflightItem.humanJson.detail.empty",
    valid: "preflightItem.humanJson.detail.valid",
  }, "humanConfig JSON", profile.advanced.humanConfigJson));

  if (hasUnsupportedChromiumSandboxOverride(profile)) {
    pushAudit(items, {
      id: "chromium-sandbox",
      category: "runtime",
      severity: "warn",
      title: localizedText("preflightItem.chromiumSandbox.title"),
      detail: chromiumSandboxOverrideDetail(profile),
    });
  }

  if (profile.runtime.launcher === "puppeteer-browser" && profile.advanced.contextOptionsJson.trim()) {
    pushAudit(items, {
      id: "puppeteer-context-options",
      category: "advanced",
      severity: "info",
      title: localizedText("profileAudit.puppeteerContextOptions.title"),
      detail: localizedText("profileAudit.puppeteerContextOptions.detail"),
    });
  }

  if (!profile.runtime.stealthArgs && profile.runtime.extraArgs.length === 0) {
    pushAudit(items, {
      id: "stealth-args-disabled",
      category: "runtime",
      severity: "fail",
      title: localizedText("profileAudit.stealthArgsDisabled.title"),
      detail: localizedText("profileAudit.stealthArgsDisabled.detail"),
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
    contextOptions: preview.contextOptions ? (maskSensitiveValues(preview.contextOptions) as Record<string, unknown>) : undefined,
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
