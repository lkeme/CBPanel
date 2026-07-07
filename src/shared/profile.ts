import type { AppSettings, StorageInfo } from "./settings";
import type {
  BrowserEnvironment,
  ExtensionEntity,
  ExtensionSourceEntity,
  GroupEntity,
  NetworkCheckResult,
  ProxyEntity,
  TagEntity,
  TrashEnvironment,
} from "./entities";
import { networkCheckSummaryText } from "./networkCheckDisplay";

export type ProfileMode = "persistent" | "ephemeral";
export type LauncherKind = "playwright-context" | "playwright-browser" | "puppeteer-browser";
export type ProxyScheme = "http" | "https" | "socks5";
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
  fontsDir: string;
  timezone: string;
  locale: string;
  location: string;
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
  launch?: SessionLaunchPlan;
  events?: SessionEvent[];
}

export type AuditSeverity = "pass" | "warn" | "fail" | "info";
export type AuditCategory = "identity" | "network" | "runtime" | "persistence" | "advanced";

export interface AuditItem {
  id: string;
  category: AuditCategory;
  severity: AuditSeverity;
  title: string;
  detail: string;
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
export type PreflightActionKind = "install-binary" | "open-tab";
export type PreflightActionTarget = "runtime" | "proxy" | "fingerprint" | "advanced";

export interface ProfilePreflightAction {
  id: string;
  kind: PreflightActionKind;
  label: string;
  target?: PreflightActionTarget;
}

export interface ProfilePreflightItem {
  id: string;
  category: PreflightCategory;
  severity: PreflightSeverity;
  title: string;
  detail: string;
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
  fontsDirCheck?: { path: string; exists: boolean; detail?: string };
  networkCheck?: NetworkCheckResult;
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
  audit: ProfileAuditReport;
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
  title: string;
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
  extensions?: ExtensionEntity[];
  extensionSources?: ExtensionSourceEntity[];
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
    id: "license-through-proxy",
    label: "License via Proxy",
    flag: "--license-through-proxy",
  },
];

const UNSAFE_CHROMIUM_ARGS = new Set(["--no-sandbox"]);

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
      fontsDir: "",
      timezone: "",
      locale: "",
      location: "",
      webrtcIp: "off",
      webrtcIpValue: "",
      noise: true,
    },
    runtime: {
      launcher: "playwright-context",
      headless: false,
      stealthArgs: true,
      geoip: false,
      humanize: true,
      humanPreset: "default",
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
    proxy: {
      ...profile.proxy,
      scheme: normalizeProxyScheme(profile.proxy.scheme) ?? "http",
    },
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
      next.runtime.headless = true;
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
  if (scheme === "http" || scheme === "https" || scheme === "socks5") return scheme;
  return undefined;
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

  const auth =
    proxy.username.trim() || proxy.password.trim()
      ? `${encodeURIComponent(proxy.username.trim())}:${encodeURIComponent(proxy.password)}@`
      : "";
  return `${scheme}://${auth}${host}:${port}`;
}

export function buildProxyUrl(proxy: ProxySettings): string | undefined {
  if (!proxy.enabled) return undefined;
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

export function isUnsafeChromiumArg(arg: string): boolean {
  const normalized = arg.trim().split("=", 1)[0].toLowerCase();
  return UNSAFE_CHROMIUM_ARGS.has(normalized);
}

function sanitizeChromiumArgs(args: string[]): string[] {
  return args.map((arg) => arg.trim()).filter((arg) => arg && !isUnsafeChromiumArg(arg));
}

function sanitizeLaunchOptions(launchOptions: Record<string, unknown> | undefined): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {
    chromiumSandbox: true,
    ...(launchOptions ?? {}),
  };

  if (Array.isArray(sanitized.args)) {
    sanitized.args = sanitized.args.filter((arg) => typeof arg !== "string" || !isUnsafeChromiumArg(arg));
  }
  if (sanitized.chromiumSandbox === false) sanitized.chromiumSandbox = true;
  return sanitized;
}

function hasUnsafeLaunchConfiguration(profile: BrowserProfile): boolean {
  if (profile.runtime.extraArgs.some(isUnsafeChromiumArg)) return true;
  try {
    const launchOptions = parseOptionalJsonObject("launchOptions", profile.advanced.launchOptionsJson);
    return (
      launchOptions?.chromiumSandbox === false ||
      (Array.isArray(launchOptions?.args) && launchOptions.args.some((arg) => typeof arg === "string" && isUnsafeChromiumArg(arg)))
    );
  } catch {
    return false;
  }
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
  pushFlag(args, "--fingerprint-fonts-dir", fp.fontsDir);
  pushFlag(args, "--fingerprint-location", fp.location);

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

export function buildLaunchPreview(profile: BrowserProfile, userDataDir?: string): LaunchPreview {
  const advanced = profile.advanced;
  const proxy = buildProxyUrl(profile.proxy);
  const proxyOption = buildProxyOption(profile.proxy);
  if (profile.proxy.enabled && !proxy) {
    throw new Error("代理已启用，但代理 URL 或 host/port 不完整，或协议不受支持。");
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

  pushPreflight(items, preflightFromAudit(validateJsonAudit("launch-json", "advanced", "launchOptions JSON", profile.advanced.launchOptionsJson)));
  pushPreflight(items, preflightFromAudit(validateJsonAudit("context-json", "advanced", "contextOptions JSON", profile.advanced.contextOptionsJson)));
  pushPreflight(items, preflightFromAudit(validateJsonAudit("human-json", "advanced", "humanConfig JSON", profile.advanced.humanConfigJson)));

  if (hasUnsafeLaunchConfiguration(profile)) {
    pushPreflight(items, {
      id: "chromium-sandbox",
      category: "runtime",
      severity: "warn",
      title: "Chromium 沙箱",
      detail: "检测到 --no-sandbox 或 chromiumSandbox=false；CBPanel 会忽略该不安全配置并强制启用 Chromium sandbox。",
      actions: [openTabAction("advanced", "移除不安全参数")],
    });
  }

  try {
    preview = buildLaunchPreview(profile, environment.userDataDir);
    launch = buildSessionLaunchPlan(profile, environment.userDataDir);
    pushPreflight(items, {
      id: "launch-preview",
      category: "runtime",
      severity: "pass",
      title: "启动参数",
      detail: `${preview.launcher} / ${preview.resultType} 可生成。`,
    });
  } catch (error) {
    pushPreflight(items, {
      id: "launch-preview",
      category: "runtime",
      severity: "fail",
      title: "启动参数",
      detail: (error as Error).message,
      actions: [openTabAction("advanced", "检查 JSON")],
    });
  }

  if (environment.binaryInstalled === undefined) {
    pushPreflight(items, {
      id: "binary",
      category: "environment",
      severity: "info",
      title: "CloakBrowser 内核",
      detail: "当前报告未包含内核安装状态。",
    });
  } else {
    pushPreflight(items, {
      id: "binary",
      category: "environment",
      severity: environment.binaryInstalled ? "pass" : "fail",
      title: "CloakBrowser 内核",
      detail: environment.binaryInstalled
        ? environment.binaryPath
          ? `已安装：${environment.binaryPath}`
          : "已安装。"
        : environment.binaryDetail ?? "未安装；启动前需要先安装或更新 CloakBrowser 内核。",
      actions: environment.binaryInstalled ? undefined : [{ id: "install-binary", kind: "install-binary", label: "安装内核" }],
    });
  }

  if (profile.mode === "persistent") {
    if (environment.userDataDirWritable === undefined) {
      pushPreflight(items, {
        id: "user-data-dir",
        category: "persistence",
        severity: "info",
        title: "用户数据目录",
        detail: environment.userDataDir ?? "当前报告未包含目录写入探针。",
      });
    } else {
      pushPreflight(items, {
        id: "user-data-dir",
        category: "persistence",
        severity: environment.userDataDirWritable ? "pass" : "fail",
        title: "用户数据目录",
        detail: environment.userDataDirWritable
          ? `可写：${environment.userDataDir ?? "profile data dir"}`
          : environment.userDataDirDetail ?? "持久化目录不可写。",
        actions: environment.userDataDirWritable ? undefined : [openTabAction("runtime", "检查模式")],
      });
    }
  } else {
    pushPreflight(items, {
      id: "user-data-dir",
      category: "persistence",
      severity: "info",
      title: "用户数据目录",
      detail: "临时上下文不会复用持久化用户数据目录。",
    });
  }

  if (profile.mode === "persistent" && profile.runtime.launcher === "playwright-browser") {
    pushPreflight(items, {
      id: "persistent-playwright-browser",
      category: "runtime",
      severity: "warn",
      title: "持久化映射",
      detail: "Playwright Browser 模式不会把 userDataDir 交给 launch；需要长期状态时优先使用 Playwright Context 或 Puppeteer 持久化。",
      actions: [openTabAction("runtime", "调整运行器")],
    });
  }

  if (profile.proxy.enabled) {
    pushPreflight(items, {
      id: "proxy-config",
      category: "network",
      severity: proxyUrl ? "pass" : "fail",
      title: "代理配置",
      detail: proxyUrl ? `已配置 ${maskProxyUrl(proxyUrl)}。` : "代理已启用，但 URL 或 host/port 不完整。",
      actions: proxyUrl ? undefined : [openTabAction("proxy", "补全代理")],
    });
  } else {
    pushPreflight(items, {
      id: "proxy-config",
      category: "network",
      severity: "info",
      title: "代理配置",
      detail: "未启用代理，启动会使用当前机器出口。",
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
      title: "GeoIP 联动",
      detail: "GeoIP 已启用且未配置代理；CloakBrowser 会按当前机器公网出口推断时区和语言。",
    });
  }

  if (profile.runtime.geoip) {
    if (profile.fingerprint.timezone.trim() || profile.fingerprint.locale.trim()) {
      pushPreflight(items, {
        id: "geoip-explicit-overrides",
        category: "network",
        severity: "warn",
        title: "GeoIP 显式覆盖",
        detail: "已启用 GeoIP，但显式 timezone/locale 会优先生效；如需跟随代理或当前公网出口，请清空这两个字段。",
        actions: [openTabAction("fingerprint", "清空时区/语言")],
      });
    }
  }

  if (profile.fingerprint.webrtcIp === "auto" && !webrtcAutoHasNetworkAnchor(profile, proxyUrl)) {
    pushPreflight(items, {
      id: "webrtc-auto-without-network-anchor",
      category: "network",
      severity: "warn",
      title: "WebRTC Auto",
      detail: "WebRTC auto 没有代理，也不会从 GeoIP 解析到可注入的出口 IP；CloakBrowser 会移除 auto 参数。",
      actions: [openTabAction("proxy", "配置代理"), openTabAction("fingerprint", "调整 WebRTC")],
    });
  }

  if (webrtcMode === "geoip") {
    pushPreflight(items, {
      id: "webrtc-geoip-effective",
      category: "network",
      severity: "pass",
      title: "WebRTC GeoIP",
      detail: proxyUrl
        ? "GeoIP 已启用且代理有效；CloakBrowser 解析到代理出口后会自动注入 WebRTC 出口 IP。"
        : "GeoIP 已启用；CloakBrowser 会按当前机器公网出口解析并保持 WebRTC 出口一致。",
    });
  }

  if (profile.fingerprint.webrtcIp === "custom" && !profile.fingerprint.webrtcIpValue.trim()) {
    pushPreflight(items, {
      id: "webrtc-custom-empty",
      category: "network",
      severity: "fail",
      title: "WebRTC 指定 IP",
      detail: "WebRTC 模式为 custom，但没有填写 IP 值。",
      actions: [openTabAction("fingerprint", "填写 IP")],
    });
  }

  pushPreflight(items, validateStartUrlPreflight(profile.startUrl));
  pushPreflight(items, validateViewportPreflight(profile));

  if (environment.extensionErrors?.length) {
    for (const [index, extension] of environment.extensionErrors.entries()) {
      pushPreflight(items, {
        id: `extension-error-${index}`,
        category: "runtime",
        severity: "fail",
        title: "扩展安装",
        detail: `${extension.name}: ${extension.detail}`,
        actions: [openTabAction("advanced", "检查扩展")],
      });
    }
  } else if (profile.runtime.extensionPaths.length === 0) {
    pushPreflight(items, {
      id: "extensions",
      category: "runtime",
      severity: "info",
      title: "扩展路径",
      detail: "未配置扩展。",
    });
  } else if (environment.extensionChecks?.length) {
    for (const extension of environment.extensionChecks) {
      pushPreflight(items, {
        id: `extension-${extension.path}`,
        category: "runtime",
        severity: extension.exists ? "pass" : "fail",
        title: "扩展路径",
        detail: extension.exists ? `存在：${extension.path}` : extension.detail ?? `路径不存在：${extension.path}`,
        actions: extension.exists ? undefined : [openTabAction("advanced", "检查路径")],
      });
    }
  } else {
    pushPreflight(items, {
      id: "extensions",
      category: "runtime",
      severity: "warn",
      title: "扩展路径",
      detail: "已配置扩展路径，但当前报告未验证这些路径是否存在。",
    });
  }

  if (profile.fingerprint.fontsDir.trim()) {
    const check = environment.fontsDirCheck;
    pushPreflight(items, {
      id: "fonts-dir",
      category: "identity",
      severity: check ? (check.exists ? "pass" : "fail") : "warn",
      title: "字体目录",
      detail: check
        ? check.exists
          ? `存在：${check.path}`
          : check.detail ?? `路径不存在：${check.path}`
        : "已配置字体目录，但当前报告未验证该路径是否存在。",
      actions: check?.exists ? undefined : [openTabAction("advanced", "检查路径")],
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
      title: "当前启动代码",
      language: "ts",
      code: generateLaunchCodeFromPreview(profile, preview),
    },
    {
      id: "launch-preview-json",
      title: "启动预览 JSON",
      language: "json",
      code: `${JSON.stringify(preview, null, 2)}\n`,
    },
    {
      id: "binary-tools",
      title: "Binary 工具",
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

function generateLaunchCodeFromPreview(profile: BrowserProfile, preview: LaunchPreview): string {
  const optionsJson = JSON.stringify(preview.options, null, 2);
  const startUrl = profile.startUrl.trim();

  if (preview.resultType === "context") {
    const firstPage =
      startUrl.length > 0
        ? `\nconst page = context.pages()[0] ?? await context.newPage();\nawait page.goto(${JSON.stringify(
            startUrl,
          )}, { waitUntil: 'domcontentloaded' });`
        : "\nconst page = context.pages()[0] ?? await context.newPage();";

    return `import { ${preview.importName} } from '${preview.importPath}';

const context = await ${preview.importName}(${optionsJson});${firstPage}

// await context.close();`;
  }

  if (preview.importPath === "cloakbrowser") {
    const contextOptionsJson = JSON.stringify(preview.contextOptions ?? {}, null, 2);
    const gotoLine = startUrl
      ? `\nawait page.goto(${JSON.stringify(startUrl)}, { waitUntil: 'domcontentloaded' });`
      : "";

    return `import { launch } from 'cloakbrowser';

const browser = await launch(${optionsJson});
const context = await browser.newContext(${contextOptionsJson});
const page = await context.newPage();${gotoLine}

// await browser.close();`;
  }

  const setup = buildPuppeteerPageSetup(profile);
  const setupLines = [
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

export function createProfileSnapshot(profile: BrowserProfile, exportedAt = nowIso()): ProfileSnapshot {
  const proxy = buildProxyUrl(profile.proxy);
  const launchPreview = maskLaunchPreview(buildLaunchPreview(profile));
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
    audit: auditProfile(profile),
    launchPreview,
    launchCode: generateLaunchCodeFromPreview(profile, launchPreview),
  };
}

export function snapshotToMarkdown(snapshot: ProfileSnapshot): string {
  const lines = [
    `# ${snapshot.profile.name} 体检快照`,
    "",
    `- 导出时间：${snapshot.exportedAt}`,
    `- 配置 ID：${snapshot.profile.id}`,
    `- 分组：${snapshot.profile.group}`,
    `- 标签：${snapshot.profile.tags.length ? snapshot.profile.tags.join(", ") : "-"}`,
    `- 模式：${snapshot.profile.mode}`,
    `- SDK：${snapshot.profile.launcher}`,
    `- 代理：${snapshot.profile.proxy}`,
    `- 时区：${snapshot.profile.timezone || "-"}`,
    `- 语言：${snapshot.profile.locale || "-"}`,
    `- 视口：${snapshot.profile.viewport}`,
    "",
    `## 体检分：${snapshot.audit.score}`,
    "",
    `通过 ${snapshot.audit.summary.pass} · 警告 ${snapshot.audit.summary.warn} · 失败 ${snapshot.audit.summary.fail} · 信息 ${snapshot.audit.summary.info}`,
    "",
    "## 体检项",
    "",
    ...snapshot.audit.items.map((item) => `- [${item.severity}] ${item.title}：${item.detail}`),
    "",
    "## 启动预览",
    "",
    "```json",
    JSON.stringify(snapshot.launchPreview, null, 2),
    "```",
    "",
    "## 启动代码",
    "",
    "```ts",
    snapshot.launchCode,
    "```",
    "",
  ];

  return lines.join("\n");
}

export function profileScore(profile: BrowserProfile): Array<{ label: string; ok: boolean; detail: string }> {
  const proxy = buildProxyUrl(profile.proxy);
  return [
    {
      label: "持久化",
      ok: profile.mode === "persistent",
      detail: profile.mode === "persistent" ? "保存 Cookie 和本地状态" : "临时上下文更容易像无痕会话",
    },
    {
      label: "代理",
      ok: Boolean(proxy),
      detail: proxy ? maskProxyUrl(proxy) : "未配置代理",
    },
    {
      label: "时区/语言",
      ok: profile.runtime.geoip || Boolean(profile.fingerprint.timezone && profile.fingerprint.locale),
      detail: profile.runtime.geoip ? "由代理或当前公网出口自动解析" : "建议显式设置或启用 GeoIP",
    },
    {
      label: "人类化",
      ok: profile.runtime.humanize,
      detail: profile.runtime.humanize ? profile.runtime.humanPreset : "未启用",
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
    title: "持久化 Profile",
    detail:
      profile.mode === "persistent"
        ? "使用真实用户数据目录，Cookie、缓存和本地状态会跨会话保留。"
        : "临时上下文更像无痕会话；需要长期账号状态时应使用持久模式。",
  });

  pushAudit(items, {
    id: "launcher-kind",
    category: "runtime",
    severity: profile.runtime.launcher === "puppeteer-browser" ? "warn" : "pass",
    title: "SDK 运行器",
    detail:
      profile.runtime.launcher === "puppeteer-browser"
        ? "Puppeteer 可用，但官方更推荐 Playwright 处理高对抗检测场景。"
        : profile.runtime.launcher === "playwright-browser"
          ? "使用 Playwright 裸 Browser 模式，适合需要手动管理多个 context 的集成。"
          : "使用 Playwright Context 包装器，适合面板管理单个 profile 会话。",
  });

  pushAudit(items, {
    id: "proxy",
    category: "network",
    severity: proxy ? "pass" : "warn",
    title: "代理出口",
    detail: proxy ? `已配置 ${maskProxyUrl(proxy)}。` : "未配置代理；公网出口会直接暴露当前机器网络。",
  });

  pushAudit(items, {
    id: "geoip-alignment",
    category: "network",
    severity: profile.runtime.geoip || Boolean(profile.fingerprint.timezone && profile.fingerprint.locale) ? "pass" : "warn",
    title: "时区/语言联动",
    detail: profile.runtime.geoip
      ? proxy
        ? "GeoIP 已启用，会尝试让时区和语言跟代理出口一致。"
        : "GeoIP 已启用，会尝试让时区和语言跟当前机器公网出口一致。"
      : profile.fingerprint.timezone && profile.fingerprint.locale
        ? "已显式设置时区和语言。"
        : "建议启用 GeoIP，或显式填写 timezone 和 locale。",
  });

  pushAudit(items, {
    id: "webrtc",
    category: "network",
    severity: webrtcMode === "off" || (webrtcMode === "auto" && !webrtcAutoAnchored) ? "warn" : "pass",
    title: "WebRTC 出口",
    detail:
      webrtcMode === "geoip"
        ? proxy
          ? "GeoIP 已启用且代理有效；CloakBrowser 解析到代理出口后会自动注入 WebRTC 出口 IP。"
          : "GeoIP 已启用；CloakBrowser 会按当前机器公网出口保持 WebRTC 出口一致。"
        : webrtcMode === "auto"
        ? proxy
          ? "WebRTC IP 会自动跟随代理出口。"
          : webrtcAutoAnchored
            ? "WebRTC IP 会通过 GeoIP 解析当前机器公网出口。"
            : "WebRTC auto 没有代理，也不会从 GeoIP 解析到可注入的出口 IP。"
        : webrtcMode === "custom"
          ? "WebRTC IP 使用手动指定值，确认它与代理出口一致。"
          : "WebRTC IP 未配置；目标站点可能看到本机或不一致的候选地址。",
  });

  pushAudit(items, {
    id: "humanize",
    category: "runtime",
    severity: profile.runtime.humanize ? "pass" : "warn",
    title: "人类化输入",
    detail: profile.runtime.humanize
      ? `已启用 ${profile.runtime.humanPreset} preset。`
      : "未启用 humanize，自动化输入/鼠标/滚动会更机械。",
  });

  pushAudit(items, {
    id: "headless",
    category: "runtime",
    severity: profile.runtime.headless ? "warn" : "pass",
    title: "窗口模式",
    detail: profile.runtime.headless ? "无头模式更省资源，但部分站点仍会提高风险分。" : "可见窗口更接近人工调试场景。",
  });

  pushAudit(items, {
    id: "fingerprint-seed",
    category: "identity",
    severity: profile.fingerprint.seed.trim() ? "pass" : "info",
    title: "指纹 Seed",
    detail: profile.fingerprint.seed.trim()
      ? "固定 seed 会让同一 profile 复用稳定身份。"
      : "未填写 seed 时 CloakBrowser 会生成随机身份；适合一次性会话，不适合长期回访。",
  });

  pushAudit(items, {
    id: "viewport",
    category: "identity",
    severity: profile.viewport.mode === "native" ? "info" : "pass",
    title: "视口",
    detail:
      profile.viewport.mode === "native"
        ? "使用原生视口，不向 Playwright 注入 viewport。"
        : `${profile.viewport.width}x${profile.viewport.height} 固定视口会进入 context 配置。`,
  });

  pushAudit(items, validateJsonAudit("launch-json", "advanced", "launchOptions JSON", profile.advanced.launchOptionsJson));
  pushAudit(items, validateJsonAudit("context-json", "advanced", "contextOptions JSON", profile.advanced.contextOptionsJson));
  pushAudit(items, validateJsonAudit("human-json", "advanced", "humanConfig JSON", profile.advanced.humanConfigJson));

  if (hasUnsafeLaunchConfiguration(profile)) {
    pushAudit(items, {
      id: "chromium-sandbox",
      category: "runtime",
      severity: "warn",
      title: "Chromium 沙箱",
      detail: "检测到 --no-sandbox 或 chromiumSandbox=false；启动映射会忽略该配置并保持沙箱开启。",
    });
  }

  if (profile.runtime.launcher === "puppeteer-browser" && profile.advanced.contextOptionsJson.trim()) {
    pushAudit(items, {
      id: "puppeteer-context-options",
      category: "advanced",
      severity: "info",
      title: "Puppeteer contextOptions",
      detail: "Puppeteer 模式不会使用 Playwright contextOptions；这些设置只影响 Playwright Browser/Context。",
    });
  }

  if (!profile.runtime.stealthArgs && profile.runtime.extraArgs.length === 0) {
    pushAudit(items, {
      id: "stealth-args-disabled",
      category: "runtime",
      severity: "fail",
      title: "Stealth Args 已关闭",
      detail: "关闭默认 stealth args 且未提供自定义 args，会削弱 CloakBrowser 默认保护。",
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
    actions: item.severity === "fail" ? [openTabAction("advanced", "检查 JSON")] : undefined,
  };
}

function openTabAction(target: PreflightActionTarget, label: string): ProfilePreflightAction {
  return {
    id: `open-${target}`,
    kind: "open-tab",
    label,
    target,
  };
}

function validateStartUrlPreflight(startUrl: string): ProfilePreflightItem {
  const result = validateStartUrl(startUrl);
  if (result.ok && result.kind === "empty") {
    return {
      id: "start-url",
      category: "runtime",
      severity: "info",
      title: "起始网址",
      detail: "未配置起始网址，启动后只创建空白页。",
    };
  }

  if (result.ok) {
    return {
      id: "start-url",
      category: "runtime",
      severity: "pass",
      title: "起始网址",
      detail: result.kind === "system" ? `系统页面：${result.value}` : `有效：${result.value}`,
    };
  }

  return {
    id: "start-url",
    category: "runtime",
    severity: "fail",
    title: "起始网址",
    detail: result.message,
    actions: [openTabAction("runtime", "修正网址")],
  };
}

function validateViewportPreflight(profile: BrowserProfile): ProfilePreflightItem {
  if (profile.viewport.mode === "native") {
    return {
      id: "viewport",
      category: "identity",
      severity: "info",
      title: "视口",
      detail: "使用原生视口，启动参数会传入 viewport: null。",
    };
  }

  const widthOk = Number.isFinite(profile.viewport.width) && profile.viewport.width >= 320;
  const heightOk = Number.isFinite(profile.viewport.height) && profile.viewport.height >= 320;
  return {
    id: "viewport",
    category: "identity",
    severity: widthOk && heightOk ? "pass" : "fail",
    title: "视口",
    detail:
      widthOk && heightOk
        ? `${profile.viewport.width}x${profile.viewport.height}。`
        : "固定视口宽高必须是大于等于 320 的有效数字。",
    actions: widthOk && heightOk ? undefined : [openTabAction("runtime", "修正视口")],
  };
}

function networkCheckPreflight(check: NetworkCheckResult | undefined): ProfilePreflightItem {
  if (!check) {
    return {
      id: "network-check",
      category: "network",
      severity: "warn",
      title: "出口检查",
      detail: "尚未记录代理出口检查；建议先检查代理，确认出口 IP、地区代码和延迟。",
      actions: [openTabAction("proxy", "检查代理")],
    };
  }

  if (!check.ok) {
    return {
      id: "network-check",
      category: "network",
      severity: "warn",
      title: "出口检查",
      detail: check.error ? `最近一次检查失败：${check.error}` : "最近一次出口检查失败。",
      actions: [openTabAction("proxy", "重新检查")],
    };
  }

  return {
    id: "network-check",
    category: "network",
    severity: "pass",
    title: "出口检查",
    detail: networkCheckSummaryText(check, {
      emptyText: "出口检查通过",
      locale: "zh-CN",
    }),
  };
}

function validateJsonAudit(id: string, category: AuditCategory, title: string, value: string): AuditItem {
  if (!value.trim()) {
    return {
      id,
      category,
      severity: "info",
      title,
      detail: "未配置。",
    };
  }

  try {
    parseOptionalJsonObject(title, value);
    return {
      id,
      category,
      severity: "pass",
      title,
      detail: "JSON 对象有效，会进入启动配置。",
    };
  } catch (error) {
    return {
      id,
      category,
      severity: "fail",
      title,
      detail: (error as Error).message,
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
