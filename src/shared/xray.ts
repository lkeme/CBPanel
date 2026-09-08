/**
 * The Xray "universal network engine": everything CBPanel needs to turn a share link
 * (vmess:// vless:// trojan:// ss:// socks:// http://) into an Xray-core outbound, and to turn one
 * or two outbounds into a complete Xray config that exposes a local SOCKS5 inbound for CloakBrowser.
 *
 * Pure and isomorphic on purpose: the panel parses links for previews and validation in the
 * browser, the server parses the very same links when it writes the config a launch runs on, and
 * the two must never disagree. Nothing here touches the filesystem, a process or a socket — that is
 * server/services/xrayService.ts.
 *
 * Adapted from GeekezBrowser's utils.js, rewritten with types, stricter validation and the
 * transports/securities Xray-core supports today (REALITY, XHTTP, gRPC, mKCP, WebSocket, H2,
 * HTTPUpgrade, QUIC).
 */

export type XrayProtocol = "vmess" | "vless" | "trojan" | "shadowsocks" | "socks" | "http";
export type XrayNetwork = "tcp" | "ws" | "grpc" | "h2" | "kcp" | "quic" | "xhttp" | "httpupgrade";
export type XraySecurity = "none" | "tls" | "reality";
export type XrayLogLevel = "none" | "error" | "warning" | "info" | "debug";

/**
 * How the outbound that dials the remote node resolves its address. Maps onto Xray's
 * `sockopt.domainStrategy`; "auto" leaves it to the OS resolver, which is dual-stack by default.
 */
export type XrayIpStrategy = "auto" | "ipv4-first" | "ipv6-first" | "ipv4-only" | "ipv6-only";

/** The uTLS ClientHello a TLS/REALITY node connection imitates. "auto" follows the profile's fingerprint brand. */
export type XrayUtlsFingerprint = "auto" | "chrome" | "firefox" | "safari" | "edge" | "ios" | "android" | "random" | "randomized";

export const XRAY_PROTOCOLS: readonly XrayProtocol[] = ["vmess", "vless", "trojan", "shadowsocks", "socks", "http"];
export const XRAY_IP_STRATEGIES: readonly XrayIpStrategy[] = ["auto", "ipv4-first", "ipv6-first", "ipv4-only", "ipv6-only"];
export const XRAY_UTLS_FINGERPRINTS: readonly XrayUtlsFingerprint[] = [
  "auto",
  "chrome",
  "firefox",
  "safari",
  "edge",
  "ios",
  "android",
  "random",
  "randomized",
];
export const XRAY_LOG_LEVELS: readonly XrayLogLevel[] = ["none", "error", "warning", "info", "debug"];
export const XRAY_MAIN_OUTBOUND_TAG = "proxy-main";
export const XRAY_PRE_OUTBOUND_TAG = "proxy-pre";
export const XRAY_INBOUND_TAG = "socks-in";

export interface XrayTlsSettings {
  serverName?: string;
  fingerprint?: string;
  alpn?: string[];
}

export interface XrayRealitySettings {
  show: false;
  serverName: string;
  fingerprint?: string;
  publicKey: string;
  shortId: string;
  spiderX: string;
}

export interface XrayStreamSettings {
  network: XrayNetwork;
  security: XraySecurity;
  tlsSettings?: XrayTlsSettings;
  realitySettings?: XrayRealitySettings;
  tcpSettings?: Record<string, unknown>;
  wsSettings?: Record<string, unknown>;
  grpcSettings?: Record<string, unknown>;
  httpSettings?: Record<string, unknown>;
  kcpSettings?: Record<string, unknown>;
  quicSettings?: Record<string, unknown>;
  xhttpSettings?: Record<string, unknown>;
  httpupgradeSettings?: Record<string, unknown>;
  sockopt?: { domainStrategy?: string };
}

export interface XrayOutbound {
  tag: string;
  protocol: XrayProtocol;
  settings: Record<string, unknown>;
  streamSettings?: XrayStreamSettings;
  proxySettings?: { tag: string; transportLayer: boolean };
  mux?: { enabled: boolean; concurrency?: number };
}

/** Everything about a node that is safe to show and search without leaking a credential. */
export interface XrayNodeSummary {
  protocol: XrayProtocol;
  address: string;
  port: number;
  network: XrayNetwork;
  security: XraySecurity;
  remark: string;
  /** One-line transport detail such as "ws /path" or "reality sni.example.com". */
  transportDetail?: string;
  warnings: string[];
}

export interface ParsedXrayShareLink {
  outbound: XrayOutbound;
  summary: XrayNodeSummary;
}

export type XrayShareLinkErrorCode =
  | "EMPTY"
  | "UNSUPPORTED_PROTOCOL"
  | "MALFORMED"
  | "INVALID_ADDRESS"
  | "INVALID_PORT"
  | "UNSUPPORTED_TRANSPORT";

export class XrayShareLinkError extends Error {
  readonly code: XrayShareLinkErrorCode;

  constructor(code: XrayShareLinkErrorCode, message: string) {
    super(message);
    this.name = "XrayShareLinkError";
    this.code = code;
  }
}

/** The proxy fields the engine reads. Structural so the panel's ProxySettings and ProxyEntity both fit. */
export interface XrayUpstreamProxy {
  scheme: "http" | "https" | "socks5" | "xray";
  host: string;
  port: string;
  username: string;
  password: string;
  shareLink: string;
}

export interface XrayConfigOptions {
  localPort: number;
  listen?: string;
  main: XrayOutbound;
  /** The front proxy of a `[local] -> [pre] -> [main] -> [target]` chain. */
  pre?: XrayOutbound;
  ipStrategy?: XrayIpStrategy;
  /** Applied to every TLS/REALITY stream whose link did not pin its own `fp`. */
  utlsFingerprint?: string;
  logLevel?: XrayLogLevel;
  udp?: boolean;
}

export interface XrayConfig {
  log: { loglevel: XrayLogLevel };
  inbounds: Array<Record<string, unknown>>;
  outbounds: Array<XrayOutbound | Record<string, unknown>>;
  routing: Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Share link parsing
// ---------------------------------------------------------------------------------------------

export function detectXrayShareLinkProtocol(link: string): XrayProtocol | undefined {
  const value = link.trim();
  if (!value) return undefined;
  const lower = value.toLowerCase();
  if (lower.startsWith("vmess://")) return "vmess";
  if (lower.startsWith("vless://")) return "vless";
  if (lower.startsWith("trojan://")) return "trojan";
  if (lower.startsWith("ss://")) return "shadowsocks";
  if (/^socks5h?:\/\//.test(lower) || lower.startsWith("socks://")) return "socks";
  if (lower.startsWith("http://") || lower.startsWith("https://")) return "http";
  // host:port, host:port:user:pass — the colon form proxy vendors hand out. Anything with the right
  // head is claimed here so the parser, not the detector, reports a wrong number of parts.
  if (!value.includes("://") && /^[^\s:/]+:\d{1,5}(?::[^\s:]*)*$/.test(value)) return "socks";
  return undefined;
}

export function parseXrayShareLink(link: string, tag = XRAY_MAIN_OUTBOUND_TAG): ParsedXrayShareLink {
  const value = link.trim();
  if (!value) throw new XrayShareLinkError("EMPTY", "分享链接不能为空");
  const protocol = detectXrayShareLinkProtocol(value);
  if (!protocol) {
    throw new XrayShareLinkError(
      "UNSUPPORTED_PROTOCOL",
      "不支持的分享链接；支持 vmess://、vless://、trojan://、ss://、socks://、http:// 以及 host:port[:user:pass]。",
    );
  }
  switch (protocol) {
    case "vmess":
      return parseVmess(value, tag);
    case "vless":
      return parseVless(value, tag);
    case "trojan":
      return parseTrojan(value, tag);
    case "shadowsocks":
      return parseShadowsocks(value, tag);
    case "socks":
      return value.includes("://") ? parseSocksUrl(value, tag) : parseHostPortCredentials(value, tag);
    case "http":
      return parseHttpUrl(value, tag);
  }
}

export function tryParseXrayShareLink(link: string, tag = XRAY_MAIN_OUTBOUND_TAG): ParsedXrayShareLink | undefined {
  try {
    return parseXrayShareLink(link, tag);
  } catch {
    return undefined;
  }
}

/** The remark a link carries (`ps` for VMess, the `#fragment` elsewhere), or "". */
export function xrayShareLinkRemark(link: string): string {
  const value = link.trim();
  if (!value) return "";
  try {
    if (value.toLowerCase().startsWith("vmess://")) {
      const payload = readVmessPayload(value);
      return payload.kind === "json" ? stringField(payload.json.ps) : payload.remark;
    }
    const hash = value.indexOf("#");
    if (hash === -1) return "";
    return safeDecodeUriComponent(value.slice(hash + 1)).trim();
  } catch {
    return "";
  }
}

/**
 * Splits pasted text or a subscription body into candidate links. A body without any `://` that
 * looks like base64 is decoded first, which is how every subscription provider ships its list.
 */
export function extractXrayShareLinks(text: string): string[] {
  return classifySubscriptionText(text).links;
}

export type SubscriptionTextKind = "links" | "html" | "clash-yaml" | "json" | "empty";

export interface SubscriptionTextClassification {
  kind: SubscriptionTextKind;
  /** Candidate link lines; empty unless `kind` is "links". */
  links: string[];
  decodedFromBase64: boolean;
}

/**
 * What a subscription body actually is, decided before any line is parsed as a link. A provider
 * that answers with its login page, a Clash YAML or a sing-box JSON produces hundreds of "not a
 * link" failures if each line is judged on its own; naming the format once is the useful answer.
 */
export function classifySubscriptionText(text: string): SubscriptionTextClassification {
  let content = text.trim();
  let decodedFromBase64 = false;
  if (!content) return { kind: "empty", links: [], decodedFromBase64 };
  if (!content.includes("://") && looksLikeBase64(content.replace(/\s+/g, ""))) {
    try {
      const decoded = decodeBase64Content(content).trim();
      // Plain words are valid base64 alphabet too ("line one is not a node" decodes to bytes), so the
      // decode only counts when what came out reads as text.
      if (isMostlyPrintableText(decoded)) {
        content = decoded;
        decodedFromBase64 = true;
      }
    } catch {
      // Not base64 after all; judge the raw text.
    }
  }
  const head = content.slice(0, 600).toLowerCase();
  if (/^<!doctype\s+html|^<html[\s>]|<head[\s>]|<body[\s>]|^<\?xml/.test(head)) {
    return { kind: "html", links: [], decodedFromBase64 };
  }
  if (/^[[{]/.test(content)) {
    try {
      JSON.parse(content);
      return { kind: "json", links: [], decodedFromBase64 };
    } catch {
      // Not JSON; keep going.
    }
  }
  if (!content.includes("://") && /^(proxies|proxy-groups|proxy-providers|rules|mixed-port|port|socks-port|dns)\s*:/m.test(content)) {
    return { kind: "clash-yaml", links: [], decodedFromBase64 };
  }
  const links = content
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#") && !line.startsWith("//"));
  return { kind: links.length ? "links" : "empty", links, decodedFromBase64 };
}

/** `insecure=1` / `allowInsecure=1` is no longer honoured by Xray-core; the link still parses, the flag is dropped. */
export function hasUnsupportedInsecureParam(link: string): boolean {
  const params = readSearchParams(link);
  if (!params) return false;
  for (const [key, value] of params.entries()) {
    const normalizedKey = key.trim().toLowerCase();
    if ((normalizedKey === "insecure" || normalizedKey === "allowinsecure") && isTruthyParam(value)) return true;
  }
  return false;
}

/** `protocol://****@host:port#remark` — enough to recognise a node, nothing that authenticates to it. */
export function maskXrayShareLink(link: string): string {
  const value = link.trim();
  if (!value) return "";
  if (isMaskedXrayShareLink(value)) return value;
  const parsed = tryParseXrayShareLink(value);
  if (!parsed) return "****";
  const { protocol, address, port, remark } = parsed.summary;
  const fragment = remark ? `#${encodeURIComponent(remark)}` : "";
  return `${protocol}://****@${formatAddress(address)}:${port}${fragment}`;
}

export function isMaskedXrayShareLink(link: string): boolean {
  return /^[a-z0-9]+:\/\/\*\*\*\*@/i.test(link.trim()) || link.trim() === "****";
}

export function describeXrayNode(summary: Pick<XrayNodeSummary, "protocol" | "network" | "security" | "transportDetail">): string {
  const transport = summary.security === "none" ? summary.network : `${summary.network}+${summary.security}`;
  return summary.transportDetail ? `${summary.protocol} · ${transport} · ${summary.transportDetail}` : `${summary.protocol} · ${transport}`;
}

// ---------------------------------------------------------------------------------------------
// Outbounds from the panel's own proxy model
// ---------------------------------------------------------------------------------------------

/**
 * The outbound for whatever proxy the panel stored: a share link when the scheme is `xray`, and a
 * plain socks/http outbound for the native schemes so they can sit behind a front proxy too.
 */
export function xrayOutboundFromProxy(proxy: XrayUpstreamProxy, tag = XRAY_MAIN_OUTBOUND_TAG): ParsedXrayShareLink {
  if (proxy.scheme === "xray") return parseXrayShareLink(proxy.shareLink, tag);
  const address = normalizeAddress(proxy.host);
  const port = parsePort(proxy.port);
  const users = proxy.username.trim() || proxy.password
    ? [{ user: proxy.username.trim(), pass: proxy.password }]
    : [];
  if (proxy.scheme === "socks5") {
    return {
      outbound: { tag, protocol: "socks", settings: { servers: [{ address, port, users }] } },
      summary: { protocol: "socks", address, port, network: "tcp", security: "none", remark: "", warnings: [] },
    };
  }
  const security: XraySecurity = proxy.scheme === "https" ? "tls" : "none";
  const outbound: XrayOutbound = {
    tag,
    protocol: "http",
    settings: { servers: [{ address, port, users }] },
  };
  if (security === "tls") {
    outbound.streamSettings = { network: "tcp", security, tlsSettings: { serverName: address } };
  }
  return {
    outbound,
    summary: { protocol: "http", address, port, network: "tcp", security, remark: "", warnings: [] },
  };
}

// ---------------------------------------------------------------------------------------------
// Config generation
// ---------------------------------------------------------------------------------------------

export function deriveUtlsFingerprint(
  preference: XrayUtlsFingerprint,
  fingerprint: { brand?: string } = {},
): string {
  if (preference !== "auto") return preference;
  const brand = (fingerprint.brand ?? "").toLowerCase();
  if (brand.includes("edge")) return "edge";
  if (brand.includes("firefox")) return "firefox";
  if (brand.includes("safari")) return "safari";
  return "chrome";
}

export function sockoptDomainStrategy(strategy: XrayIpStrategy | undefined): string | undefined {
  switch (strategy) {
    case "ipv4-first":
      return "UseIPv4v6";
    case "ipv6-first":
      return "UseIPv6v4";
    case "ipv4-only":
      return "UseIPv4";
    case "ipv6-only":
      return "UseIPv6";
    default:
      return undefined;
  }
}

/**
 * One SOCKS5 inbound on the loopback, everything routed to the main outbound. When a front proxy is
 * given, the main outbound dials through it at the transport layer, so REALITY/WS/gRPC on the main
 * node keep working behind the chain — the layout v2rayN uses for its 前置代理.
 */
export function buildXrayConfig(options: XrayConfigOptions): XrayConfig {
  const listen = options.listen ?? "127.0.0.1";
  const main = cloneOutbound(options.main, XRAY_MAIN_OUTBOUND_TAG);
  const pre = options.pre ? cloneOutbound(options.pre, XRAY_PRE_OUTBOUND_TAG) : undefined;
  const domainStrategy = sockoptDomainStrategy(options.ipStrategy);

  for (const outbound of [main, pre]) {
    if (!outbound) continue;
    applyUtlsFingerprint(outbound, options.utlsFingerprint);
  }
  // The dialing outbound is the one that resolves a hostname locally: with a chain that is the
  // front proxy, since the main node's address travels to the front proxy as a name.
  const dialing = pre ?? main;
  if (domainStrategy) {
    dialing.streamSettings = {
      ...(dialing.streamSettings ?? { network: "tcp", security: "none" }),
      sockopt: { ...(dialing.streamSettings?.sockopt ?? {}), domainStrategy },
    };
  }
  if (pre) main.proxySettings = { tag: pre.tag, transportLayer: true };

  const outbounds: XrayConfig["outbounds"] = [main];
  if (pre) outbounds.push(pre);
  outbounds.push(
    {
      tag: "direct",
      protocol: "freedom",
      settings: domainStrategy ? { domainStrategy } : {},
    },
    { tag: "block", protocol: "blackhole", settings: {} },
  );

  return {
    log: { loglevel: options.logLevel ?? "warning" },
    inbounds: [
      {
        tag: XRAY_INBOUND_TAG,
        listen,
        port: options.localPort,
        protocol: "socks",
        settings: { auth: "noauth", udp: options.udp ?? true },
        sniffing: { enabled: true, destOverride: ["http", "tls", "quic"], routeOnly: false },
      },
    ],
    outbounds,
    routing: {
      domainStrategy: "AsIs",
      rules: [{ type: "field", inboundTag: [XRAY_INBOUND_TAG], outboundTag: main.tag }],
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Protocol parsers
// ---------------------------------------------------------------------------------------------

type TransportParams = {
  network?: string;
  security?: string;
  host?: string;
  path?: string;
  serviceName?: string;
  mode?: string;
  headerType?: string;
  seed?: string;
  quicSecurity?: string;
  quicKey?: string;
  sni?: string;
  fingerprint?: string;
  alpn?: string;
  publicKey?: string;
  shortId?: string;
  spiderX?: string;
};

type VmessPayload =
  | { kind: "json"; json: Record<string, unknown> }
  | { kind: "legacy"; security: string; id: string; address: string; port: string; remark: string; params: URLSearchParams };

function readVmessPayload(link: string): VmessPayload {
  const body = link.slice("vmess://".length);
  const query = body.indexOf("?");
  const encoded = (query === -1 ? body : body.slice(0, query)).split("#")[0] ?? "";
  const decoded = decodeBase64OrThrow(encoded, "vmess 链接不是有效的 base64 JSON");
  try {
    const json = JSON.parse(decoded) as unknown;
    if (json && typeof json === "object" && !Array.isArray(json)) return { kind: "json", json: json as Record<string, unknown> };
  } catch {
    // Shadowrocket style: base64(security:uuid@host:port)?remarks=...
  }
  const match = decoded.match(/^([^:]+):([^@]+)@(.+):(\d+)$/);
  if (!match) throw new XrayShareLinkError("MALFORMED", "vmess 链接不是有效的 base64 JSON");
  const params = query === -1 ? new URLSearchParams() : new URLSearchParams(body.slice(query + 1).split("#")[0]);
  return {
    kind: "legacy",
    security: match[1],
    id: match[2],
    address: match[3],
    port: match[4],
    remark: safeDecodeUriComponent(params.get("remarks") ?? params.get("remark") ?? ""),
    params,
  };
}

function parseVmess(link: string, tag: string): ParsedXrayShareLink {
  const payload = readVmessPayload(link);
  if (payload.kind === "legacy") {
    const address = normalizeAddress(payload.address);
    const port = parsePort(payload.port);
    const stream = buildStreamSettings({
      network: payload.params.get("obfs") === "websocket" ? "ws" : "tcp",
      security: isTruthyParam(payload.params.get("tls")) ? "tls" : "none",
      host: payload.params.get("obfsParam") ?? payload.params.get("peer") ?? undefined,
      path: payload.params.get("path") ?? undefined,
    }, address);
    return finishNode(tag, "vmess", address, port, {
      vnext: [{ address, port, users: [{ id: payload.id, alterId: 0, security: payload.security || "auto" }] }],
    }, stream, payload.remark, []);
  }

  const json = payload.json;
  const address = normalizeAddress(stringField(json.add));
  const port = parsePort(stringField(json.port));
  const id = stringField(json.id);
  if (!id) throw new XrayShareLinkError("MALFORMED", "vmess 链接缺少用户 id");
  const network = stringField(json.net) || "tcp";
  const headerType = stringField(json.type);
  const stream = buildStreamSettings({
    network,
    security: stringField(json.tls),
    host: stringField(json.host),
    path: stringField(json.path),
    serviceName: stringField(json.path) || stringField(json.serviceName),
    mode: network === "grpc" ? (headerType === "multi" ? "multi" : "gun") : stringField(json.mode),
    headerType: network === "grpc" ? undefined : headerType,
    seed: stringField(json.path),
    quicSecurity: stringField(json.host),
    quicKey: stringField(json.path),
    sni: stringField(json.sni),
    fingerprint: stringField(json.fp),
    alpn: stringField(json.alpn),
  }, address);
  const alterId = Number.parseInt(stringField(json.aid) || "0", 10);
  return finishNode(tag, "vmess", address, port, {
    vnext: [{
      address,
      port,
      users: [{ id, alterId: Number.isFinite(alterId) ? alterId : 0, security: stringField(json.scy) || "auto" }],
    }],
  }, stream, stringField(json.ps), []);
}

function parseVless(link: string, tag: string): ParsedXrayShareLink {
  const url = parseUrl(link, "vless");
  const address = normalizeAddress(url.hostname);
  const port = parsePort(url.port);
  const id = safeDecodeUriComponent(url.username);
  if (!id) throw new XrayShareLinkError("MALFORMED", "vless 链接缺少用户 id");
  const params = url.searchParams;
  const warnings: string[] = [];
  if (hasUnsupportedInsecureParam(link)) warnings.push("allowInsecure 参数已不受 Xray-core 支持，将被忽略。");
  const stream = buildStreamSettings(transportParamsFromQuery(params), address);
  const user: Record<string, unknown> = { id, encryption: params.get("encryption") || "none" };
  const flow = params.get("flow")?.trim();
  if (flow) user.flow = flow;
  return finishNode(tag, "vless", address, port, { vnext: [{ address, port, users: [user] }] }, stream, fragmentRemark(url), warnings);
}

function parseTrojan(link: string, tag: string): ParsedXrayShareLink {
  const url = parseUrl(link, "trojan");
  const address = normalizeAddress(url.hostname);
  const port = parsePort(url.port);
  const password = safeDecodeUriComponent(url.username) + (url.password ? `:${safeDecodeUriComponent(url.password)}` : "");
  if (!password) throw new XrayShareLinkError("MALFORMED", "trojan 链接缺少密码");
  const params = url.searchParams;
  const warnings: string[] = [];
  if (hasUnsupportedInsecureParam(link)) warnings.push("allowInsecure 参数已不受 Xray-core 支持，将被忽略。");
  const transport = transportParamsFromQuery(params);
  // Trojan is TLS by definition; a link that says nothing means "tls", not "none".
  if (!params.has("security")) transport.security = "tls";
  const stream = buildStreamSettings(transport, address);
  return finishNode(tag, "trojan", address, port, { servers: [{ address, port, password }] }, stream, fragmentRemark(url), warnings);
}

function parseShadowsocks(link: string, tag: string): ParsedXrayShareLink {
  const withoutScheme = link.slice("ss://".length);
  const hash = withoutScheme.indexOf("#");
  const remark = hash === -1 ? "" : safeDecodeUriComponent(withoutScheme.slice(hash + 1)).trim();
  let body = hash === -1 ? withoutScheme : withoutScheme.slice(0, hash);
  const queryIndex = body.indexOf("?");
  const query = queryIndex === -1 ? new URLSearchParams() : new URLSearchParams(body.slice(queryIndex + 1));
  if (queryIndex !== -1) body = body.slice(0, queryIndex);
  body = body.replace(/\/+$/, "");

  let method = "";
  let password = "";
  let address = "";
  let portText = "";

  const at = body.lastIndexOf("@");
  if (at === -1) {
    // Legacy: ss://base64(method:password@host:port)
    const decoded = decodeBase64OrThrow(body, "ss 链接不是有效的 SIP002 或 legacy 格式");
    const match = decoded.match(/^(.+?):(.*)@(.+):(\d+)$/);
    if (!match) throw new XrayShareLinkError("MALFORMED", "ss 链接不是有效的 SIP002 或 legacy 格式");
    [, method, password, address, portText] = match;
  } else {
    const userInfo = body.slice(0, at);
    const server = body.slice(at + 1);
    const credentials = decodeShadowsocksUserInfo(userInfo);
    method = credentials.method;
    password = credentials.password;
    const hostPort = splitHostPort(server);
    address = hostPort.host;
    portText = hostPort.port;
  }

  address = normalizeAddress(address);
  const port = parsePort(portText);
  if (!method) throw new XrayShareLinkError("MALFORMED", "ss 链接缺少加密方法");

  const server: Record<string, unknown> = { address, port, method, password };
  if (isTruthyParam(query.get("uot"))) server.uot = true;
  const warnings: string[] = [];
  let stream: XrayStreamSettings | undefined;
  const plugin = query.get("plugin");
  if (plugin) {
    const pluginOptions = parsePluginOptions(plugin);
    if (pluginOptions.name === "obfs-local" || pluginOptions.name === "simple-obfs") {
      const obfs = pluginOptions.options.get("obfs");
      const obfsHost = pluginOptions.options.get("obfs-host") ?? "";
      if (obfs === "http") {
        stream = buildStreamSettings({ network: "tcp", headerType: "http", host: obfsHost, path: "/" }, address);
      } else {
        warnings.push(`simple-obfs ${obfs ?? ""} 模式不受 Xray-core 支持，插件参数已忽略。`.replace("  ", " "));
      }
    } else if (pluginOptions.name === "v2ray-plugin") {
      const mode = pluginOptions.options.get("mode") ?? "websocket";
      if (mode === "websocket") {
        stream = buildStreamSettings({
          network: "ws",
          security: pluginOptions.options.has("tls") ? "tls" : "none",
          host: pluginOptions.options.get("host") ?? "",
          path: pluginOptions.options.get("path") ?? "/",
        }, address);
      } else {
        warnings.push(`v2ray-plugin ${mode} 模式不受支持，插件参数已忽略。`);
      }
    } else {
      warnings.push(`未知插件 ${pluginOptions.name} 已忽略。`);
    }
  }
  const parsed = finishNode(tag, "shadowsocks", address, port, { servers: [server] }, stream, remark, warnings);
  parsed.outbound.mux = { enabled: false, concurrency: -1 };
  return parsed;
}

function parseSocksUrl(link: string, tag: string): ParsedXrayShareLink {
  const normalized = link.replace(/^socks5h?:\/\//i, "socks://");
  const url = parseUrl(normalized, "socks");
  const address = normalizeAddress(url.hostname);
  const port = url.port ? parsePort(url.port) : 1080;
  const credentials = decodeSocksUserInfo(url);
  const users = credentials ? [{ user: credentials.user, pass: credentials.pass }] : [];
  return finishNode(tag, "socks", address, port, { servers: [{ address, port, users }] }, undefined, fragmentRemark(url), []);
}

function parseHostPortCredentials(link: string, tag: string): ParsedXrayShareLink {
  const parts = link.split(":");
  if (parts.length !== 2 && parts.length !== 4) {
    throw new XrayShareLinkError("MALFORMED", "host:port 格式需要是 host:port 或 host:port:user:pass");
  }
  const address = normalizeAddress(parts[0]);
  const port = parsePort(parts[1]);
  const users = parts.length === 4 ? [{ user: parts[2], pass: parts[3] }] : [];
  return finishNode(tag, "socks", address, port, { servers: [{ address, port, users }] }, undefined, "", []);
}

function parseHttpUrl(link: string, tag: string): ParsedXrayShareLink {
  const url = parseUrl(link, "http");
  const address = normalizeAddress(url.hostname);
  const port = url.port ? parsePort(url.port) : url.protocol === "https:" ? 443 : 80;
  const users = url.username
    ? [{ user: safeDecodeUriComponent(url.username), pass: safeDecodeUriComponent(url.password) }]
    : [];
  const stream = url.protocol === "https:"
    ? buildStreamSettings({ network: "tcp", security: "tls", sni: url.hostname }, address)
    : undefined;
  return finishNode(tag, "http", address, port, { servers: [{ address, port, users }] }, stream, fragmentRemark(url), []);
}

// ---------------------------------------------------------------------------------------------
// Stream settings
// ---------------------------------------------------------------------------------------------

function transportParamsFromQuery(params: URLSearchParams): TransportParams {
  const read = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = params.get(key);
      if (value !== null && value.trim()) return value.trim();
    }
    return undefined;
  };
  return {
    network: read("type", "net"),
    security: read("security"),
    host: read("host"),
    path: read("path"),
    serviceName: read("serviceName", "servicename"),
    mode: read("mode"),
    headerType: read("headerType"),
    seed: read("seed"),
    quicSecurity: read("quicSecurity"),
    quicKey: read("key"),
    sni: read("sni", "peer"),
    fingerprint: read("fp"),
    alpn: read("alpn"),
    publicKey: read("pbk"),
    shortId: read("sid"),
    spiderX: read("spx"),
  };
}

function normalizeNetwork(raw: string | undefined): XrayNetwork {
  const value = (raw ?? "").trim().toLowerCase();
  switch (value) {
    case "":
    case "tcp":
    case "raw":
      return "tcp";
    case "ws":
    case "websocket":
      return "ws";
    case "grpc":
    case "gun":
      return "grpc";
    case "h2":
    case "http":
      return "h2";
    case "kcp":
    case "mkcp":
      return "kcp";
    case "quic":
      return "quic";
    case "xhttp":
    case "splithttp":
      return "xhttp";
    case "httpupgrade":
      return "httpupgrade";
    default:
      throw new XrayShareLinkError("UNSUPPORTED_TRANSPORT", `不支持的传输方式：${value}`);
  }
}

function normalizeSecurity(raw: string | undefined): XraySecurity {
  const value = (raw ?? "").trim().toLowerCase();
  switch (value) {
    case "":
    case "none":
    case "0":
    case "false":
      return "none";
    case "tls":
    case "xtls":
    case "1":
    case "true":
      return "tls";
    case "reality":
      return "reality";
    default:
      throw new XrayShareLinkError("UNSUPPORTED_TRANSPORT", `不支持的安全层：${value}`);
  }
}

function buildStreamSettings(params: TransportParams, address: string): XrayStreamSettings {
  const network = normalizeNetwork(params.network);
  const security = normalizeSecurity(params.security);
  const stream: XrayStreamSettings = { network, security };
  const host = params.host?.trim() ?? "";
  const path = params.path?.trim() || "/";

  switch (network) {
    case "tcp":
      if ((params.headerType ?? "none").toLowerCase() === "http") {
        stream.tcpSettings = {
          header: {
            type: "http",
            request: {
              version: "1.1",
              method: "GET",
              path: [path],
              headers: {
                Host: host ? host.split(",").map((item) => item.trim()).filter(Boolean) : [],
                "User-Agent": [],
                "Accept-Encoding": ["gzip, deflate"],
                Connection: ["keep-alive"],
                Pragma: "no-cache",
              },
            },
          },
        };
      }
      break;
    case "ws":
      stream.wsSettings = { path, ...(host ? { host, headers: { Host: host } } : {}) };
      break;
    case "grpc":
      stream.grpcSettings = {
        serviceName: params.serviceName?.trim() ?? "",
        multiMode: (params.mode ?? "").toLowerCase() === "multi",
        ...(host ? { authority: host } : {}),
      };
      break;
    case "h2":
      stream.httpSettings = { path, host: host ? host.split(",").map((item) => item.trim()).filter(Boolean) : [] };
      break;
    case "kcp":
      stream.kcpSettings = {
        header: { type: params.headerType?.trim() || "none" },
        ...(params.seed?.trim() ? { seed: params.seed.trim() } : {}),
      };
      break;
    case "quic":
      stream.quicSettings = {
        security: params.quicSecurity?.trim() || "none",
        key: params.quicKey?.trim() ?? "",
        header: { type: params.headerType?.trim() || "none" },
      };
      break;
    case "xhttp":
      stream.xhttpSettings = { path, mode: params.mode?.trim() || "auto", ...(host ? { host } : {}) };
      break;
    case "httpupgrade":
      stream.httpupgradeSettings = { path, ...(host ? { host } : {}) };
      break;
  }

  const sni = params.sni?.trim() || (network === "ws" || network === "h2" || network === "xhttp" || network === "httpupgrade" ? host.split(",")[0]?.trim() : "") || address;
  if (security === "tls") {
    stream.tlsSettings = {
      serverName: sni,
      ...(params.fingerprint?.trim() ? { fingerprint: params.fingerprint.trim() } : {}),
      ...(params.alpn?.trim() ? { alpn: params.alpn.split(",").map((item) => item.trim()).filter(Boolean) } : {}),
    };
  } else if (security === "reality") {
    if (!params.publicKey?.trim()) throw new XrayShareLinkError("MALFORMED", "REALITY 链接缺少 pbk 公钥");
    // An x25519 public key is 32 bytes, which base64url encodes to exactly 43 characters; Xray refuses
    // anything else at start-up, so refusing it here keeps a bad link out of the library.
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.publicKey.trim())) {
      throw new XrayShareLinkError("MALFORMED", "REALITY 公钥（pbk）格式无效：应为 43 位 base64url 字符");
    }
    stream.realitySettings = {
      show: false,
      serverName: params.sni?.trim() || "",
      ...(params.fingerprint?.trim() ? { fingerprint: params.fingerprint.trim() } : {}),
      publicKey: params.publicKey.trim(),
      shortId: params.shortId?.trim() ?? "",
      spiderX: params.spiderX?.trim() ?? "",
    };
  }
  return stream;
}

function transportDetail(stream: XrayStreamSettings | undefined): string | undefined {
  if (!stream) return undefined;
  const parts: string[] = [];
  if (stream.network === "ws" && stream.wsSettings) parts.push(`ws ${String(stream.wsSettings.path ?? "/")}`);
  if (stream.network === "grpc" && stream.grpcSettings) parts.push(`grpc ${String(stream.grpcSettings.serviceName ?? "")}`.trim());
  if (stream.network === "xhttp" && stream.xhttpSettings) parts.push(`xhttp ${String(stream.xhttpSettings.mode ?? "auto")}`);
  if (stream.network === "kcp" && stream.kcpSettings) parts.push(`mkcp ${String((stream.kcpSettings.header as { type?: string } | undefined)?.type ?? "none")}`);
  if (stream.network === "h2" && stream.httpSettings) parts.push(`h2 ${String(stream.httpSettings.path ?? "/")}`);
  if (stream.network === "httpupgrade" && stream.httpupgradeSettings) parts.push(`httpupgrade ${String(stream.httpupgradeSettings.path ?? "/")}`);
  if (stream.security === "reality" && stream.realitySettings?.serverName) parts.push(`reality ${stream.realitySettings.serverName}`);
  if (stream.security === "tls" && stream.tlsSettings?.serverName) parts.push(`tls ${stream.tlsSettings.serverName}`);
  return parts.length ? parts.join(" · ") : undefined;
}

function finishNode(
  tag: string,
  protocol: XrayProtocol,
  address: string,
  port: number,
  settings: Record<string, unknown>,
  stream: XrayStreamSettings | undefined,
  remark: string,
  warnings: string[],
): ParsedXrayShareLink {
  const outbound: XrayOutbound = { tag, protocol, settings };
  if (stream) outbound.streamSettings = stream;
  return {
    outbound,
    summary: {
      protocol,
      address,
      port,
      network: stream?.network ?? "tcp",
      security: stream?.security ?? "none",
      remark: remark.trim(),
      transportDetail: transportDetail(stream),
      warnings,
    },
  };
}

function applyUtlsFingerprint(outbound: XrayOutbound, fingerprint: string | undefined): void {
  const stream = outbound.streamSettings;
  if (!stream || !fingerprint) return;
  if (stream.security === "tls") {
    stream.tlsSettings = { ...(stream.tlsSettings ?? {}) };
    if (!stream.tlsSettings.fingerprint) stream.tlsSettings.fingerprint = fingerprint;
  }
  if (stream.security === "reality" && stream.realitySettings && !stream.realitySettings.fingerprint) {
    stream.realitySettings = { ...stream.realitySettings, fingerprint };
  }
}

function cloneOutbound(outbound: XrayOutbound, tag: string): XrayOutbound {
  return { ...(JSON.parse(JSON.stringify(outbound)) as XrayOutbound), tag };
}

// ---------------------------------------------------------------------------------------------
// Small parsing helpers
// ---------------------------------------------------------------------------------------------

export function decodeBase64Content(value: string): string {
  const normalized = value.trim().replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8").decode(bytes);
}

export function looksLikeBase64(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9+/=_-]+$/.test(value);
}

function isMostlyPrintableText(text: string): boolean {
  if (!text) return false;
  if (text.includes("�")) return false;
  let printable = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x20 || code === 0x09 || code === 0x0a || code === 0x0d) printable += 1;
  }
  return printable / [...text].length >= 0.95;
}

function decodeBase64OrThrow(value: string, message: string): string {
  try {
    return decodeBase64Content(value);
  } catch {
    throw new XrayShareLinkError("MALFORMED", message);
  }
}

function parseUrl(link: string, expectedProtocol: string): URL {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    throw new XrayShareLinkError("MALFORMED", `${expectedProtocol} 链接格式无效`);
  }
  if (!url.hostname) throw new XrayShareLinkError("INVALID_ADDRESS", `${expectedProtocol} 链接缺少服务器地址`);
  return url;
}

function fragmentRemark(url: URL): string {
  return url.hash ? safeDecodeUriComponent(url.hash.slice(1)).trim() : "";
}

function decodeShadowsocksUserInfo(userInfo: string): { method: string; password: string } {
  const decodedInfo = safeDecodeUriComponent(userInfo);
  if (decodedInfo.includes(":")) {
    // SIP002 with a plaintext (percent-encoded) userinfo, the shape Shadowsocks-2022 keys use.
    const colon = decodedInfo.indexOf(":");
    return { method: decodedInfo.slice(0, colon), password: decodedInfo.slice(colon + 1) };
  }
  let decoded: string;
  try {
    decoded = decodeBase64Content(userInfo);
  } catch {
    throw new XrayShareLinkError("MALFORMED", "ss 链接的用户信息既不是 base64 也不是 method:password");
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) throw new XrayShareLinkError("MALFORMED", "ss 链接的用户信息缺少 method:password");
  return { method: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

function decodeSocksUserInfo(url: URL): { user: string; pass: string } | undefined {
  if (!url.username && !url.password) return undefined;
  if (url.password || url.username.includes("%3A") || url.username.includes(":")) {
    return { user: safeDecodeUriComponent(url.username), pass: safeDecodeUriComponent(url.password) };
  }
  // v2rayN writes socks://base64(user:pass)@host:port.
  if (looksLikeBase64(url.username)) {
    try {
      const decoded = decodeBase64Content(url.username);
      const colon = decoded.indexOf(":");
      if (colon !== -1) return { user: decoded.slice(0, colon), pass: decoded.slice(colon + 1) };
    } catch {
      // Not base64; treat the username as a plain user without a password.
    }
  }
  return { user: safeDecodeUriComponent(url.username), pass: "" };
}

function parsePluginOptions(plugin: string): { name: string; options: Map<string, string> } {
  const [name = "", ...rest] = safeDecodeUriComponent(plugin).split(";");
  const options = new Map<string, string>();
  for (const item of rest) {
    const equals = item.indexOf("=");
    if (equals === -1) options.set(item.trim(), "");
    else options.set(item.slice(0, equals).trim(), item.slice(equals + 1).trim());
  }
  return { name: name.trim(), options };
}

function splitHostPort(value: string): { host: string; port: string } {
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close === -1) throw new XrayShareLinkError("INVALID_ADDRESS", "IPv6 地址缺少右括号");
    const host = trimmed.slice(1, close);
    const port = trimmed.slice(close + 1).replace(/^:/, "");
    return { host, port };
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon === -1) return { host: trimmed, port: "" };
  return { host: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
}

function normalizeAddress(value: string): string {
  let address = value.trim();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  if (!address || /[\s/]/.test(address)) throw new XrayShareLinkError("INVALID_ADDRESS", "服务器地址无效");
  return address;
}

function formatAddress(address: string): string {
  return address.includes(":") ? `[${address}]` : address;
}

function parsePort(value: string | number | undefined): number {
  const port = typeof value === "number" ? value : Number.parseInt(String(value ?? "").trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new XrayShareLinkError("INVALID_PORT", "端口必须在 1-65535 之间");
  return port;
}

function stringField(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function isTruthyParam(value: string | null | undefined): boolean {
  const normalized = (value ?? "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "tls";
}

function readSearchParams(link: string): URLSearchParams | undefined {
  const value = link.trim();
  const query = value.indexOf("?");
  if (query === -1) return undefined;
  const hash = value.indexOf("#", query);
  return new URLSearchParams(hash === -1 ? value.slice(query + 1) : value.slice(query + 1, hash));
}

function safeDecodeUriComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * What makes two share links the same node: the outbound they generate — endpoint, credentials and
 * transport — without the remark (a `#fragment`, or `ps` inside a VMess payload) and without the
 * panel's own tag. A subscription that renames a node still lists the same node.
 */
export function xrayNodeIdentity(link: string): string {
  const parsed = tryParseXrayShareLink(link.trim());
  if (!parsed) return `link:${link.trim().replace(/#.*$/, "")}`;
  const { tag: _tag, ...outbound } = parsed.outbound as XrayOutbound & { tag?: string };
  return `outbound:${JSON.stringify(outbound)}`;
}

/**
 * The identity of a library proxy: for an xray entry its node, for a native proxy its endpoint and
 * credentials. Names, notes, chains and IP strategy are the panel's metadata and take no part.
 */
export function proxyNodeIdentity(proxy: {
  scheme: string;
  host: string;
  port: string;
  username?: string;
  password?: string;
  shareLink?: string;
}): string {
  if (proxy.scheme === "xray") return `xray:${xrayNodeIdentity(proxy.shareLink ?? "")}`;
  return `${proxy.scheme}://${proxy.username ?? ""}:${proxy.password ?? ""}@${proxy.host}:${proxy.port}`;
}
