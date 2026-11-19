import { parse as parseYaml } from "yaml";

/**
 * mihomo / Clash YAML nodes as share links.
 *
 * The library stores one kind of node — a share link the Xray engine can rebuild at launch — so a
 * Clash file is converted entry by entry instead of growing a second storage shape. Conversion is
 * deliberately lossy in one direction only: fields with a share-link counterpart are carried over,
 * everything else (dialer tuning, group membership) belongs to the client, not to the panel.
 */

export interface ClashConversionResult {
  links: string[];
  failures: Array<{ link: string; error: string }>;
  /** Entries the file declared, usable or not. */
  total: number;
  /** `proxy-providers` entries, which point at remote node lists and carry no nodes themselves. */
  providerCount: number;
}

type ClashMapping = Record<string, unknown>;

function text(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

function mapping(value: unknown): ClashMapping {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as ClashMapping) : {};
}

function firstText(value: unknown): string {
  if (Array.isArray(value)) return text(value.find((item) => text(item)));
  return text(value);
}

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fragment(name: string): string {
  return name ? `#${encodeURIComponent(name)}` : "";
}

function credentials(user: string, password: string): string {
  if (!user) return "";
  return `${encodeURIComponent(user)}${password ? `:${encodeURIComponent(password)}` : ""}@`;
}

/** The transport fields vmess/vless/trojan share, in the query vocabulary v2rayN emits. */
function transportParams(proxy: ClashMapping): URLSearchParams {
  const network = text(proxy.network) || "tcp";
  const reality = mapping(proxy["reality-opts"]);
  const tls = proxy.tls === true || Object.keys(reality).length > 0;
  const params = new URLSearchParams();
  params.set("type", network);
  if (tls) params.set("security", Object.keys(reality).length > 0 ? "reality" : "tls");
  const sni = text(proxy.servername) || text(proxy.sni);
  if (sni) params.set("sni", sni);
  const fingerprint = text(proxy["client-fingerprint"]) || text(proxy.fingerprint);
  if (fingerprint) params.set("fp", fingerprint);
  const alpn = Array.isArray(proxy.alpn) ? proxy.alpn.map(text).filter(Boolean) : [];
  if (alpn.length) params.set("alpn", alpn.join(","));
  if (proxy["skip-cert-verify"] === true) params.set("insecure", "1");
  if (Object.keys(reality).length > 0) {
    const publicKey = text(reality["public-key"]);
    if (publicKey) params.set("pbk", publicKey);
    const shortId = text(reality["short-id"]);
    if (shortId) params.set("sid", shortId);
  }
  if (network === "ws" || network === "httpupgrade" || network === "xhttp") {
    const options = mapping(proxy[`${network}-opts`]);
    const path = text(options.path);
    if (path) params.set("path", path);
    const host = text(mapping(options.headers).Host) || firstText(options.host);
    if (host) params.set("host", host);
    if (network === "xhttp") {
      const mode = text(options.mode);
      if (mode) params.set("mode", mode);
    }
  }
  if (network === "grpc") {
    const options = mapping(proxy["grpc-opts"]);
    const serviceName = text(options["grpc-service-name"]);
    if (serviceName) params.set("serviceName", serviceName);
  }
  if (network === "http" || network === "h2") {
    const options = mapping(proxy["h2-opts"] ?? proxy["http-opts"]);
    const path = firstText(options.path);
    if (path) params.set("path", path);
    const host = firstText(options.host) || text(mapping(options.headers).Host);
    if (host) params.set("host", host);
  }
  return params;
}

function vmessLink(proxy: ClashMapping, name: string, server: string, port: string): string {
  const uuid = text(proxy.uuid);
  if (!uuid) throw new Error("vmess 节点缺少 uuid");
  const params = transportParams(proxy);
  const network = params.get("type") ?? "tcp";
  const payload: Record<string, unknown> = {
    v: "2",
    ps: name,
    add: server,
    port,
    id: uuid,
    aid: text(proxy.alterId) || "0",
    scy: text(proxy.cipher) || "auto",
    net: network,
    type: "none",
    host: params.get("host") ?? "",
    path: params.get("path") ?? "",
    tls: params.get("security") === "tls" ? "tls" : "",
    sni: params.get("sni") ?? "",
    alpn: params.get("alpn") ?? "",
    fp: params.get("fp") ?? "",
  };
  if (network === "grpc") payload.path = params.get("serviceName") ?? "";
  return `vmess://${base64Utf8(JSON.stringify(payload))}`;
}

function vlessLink(proxy: ClashMapping, name: string, server: string, port: string): string {
  const uuid = text(proxy.uuid);
  if (!uuid) throw new Error("vless 节点缺少 uuid");
  const params = transportParams(proxy);
  params.set("encryption", "none");
  const flow = text(proxy.flow);
  if (flow) params.set("flow", flow);
  return `vless://${encodeURIComponent(uuid)}@${server}:${port}?${params.toString()}${fragment(name)}`;
}

function trojanLink(proxy: ClashMapping, name: string, server: string, port: string): string {
  const password = text(proxy.password);
  if (!password) throw new Error("trojan 节点缺少 password");
  const params = transportParams(proxy);
  if (!params.has("security")) params.set("security", "tls");
  return `trojan://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}${fragment(name)}`;
}

function shadowsocksLink(proxy: ClashMapping, name: string, server: string, port: string): string {
  const method = text(proxy.cipher);
  const password = text(proxy.password);
  if (!method || !password) throw new Error("shadowsocks 节点缺少 cipher 或 password");
  const params = new URLSearchParams();
  const pluginName = text(proxy.plugin);
  const options = mapping(proxy["plugin-opts"]);
  if (pluginName === "obfs" || pluginName === "simple-obfs") {
    params.set("plugin", `obfs-local;obfs=${text(options.mode) || "http"};obfs-host=${text(options.host)}`);
  } else if (pluginName === "v2ray-plugin") {
    const parts = [`mode=${text(options.mode) || "websocket"}`];
    if (text(options.host)) parts.push(`host=${text(options.host)}`);
    if (text(options.path)) parts.push(`path=${text(options.path)}`);
    if (options.tls === true) parts.push("tls");
    params.set("plugin", `v2ray-plugin;${parts.join(";")}`);
  } else if (pluginName) {
    throw new Error(`不支持的 shadowsocks 插件：${pluginName}`);
  }
  const query = params.toString();
  return `ss://${base64Utf8(`${method}:${password}`)}@${server}:${port}${query ? `?${query}` : ""}${fragment(name)}`;
}

function hysteria2Link(proxy: ClashMapping, name: string, server: string, port: string): string {
  const password = text(proxy.password) || text(proxy.auth);
  if (!password) throw new Error("hysteria2 节点缺少 password");
  const params = new URLSearchParams();
  const sni = text(proxy.sni) || text(proxy.servername);
  if (sni) params.set("sni", sni);
  if (proxy["skip-cert-verify"] === true) params.set("insecure", "1");
  const obfs = text(proxy.obfs);
  if (obfs) {
    params.set("obfs", obfs);
    const obfsPassword = text(proxy["obfs-password"]);
    if (obfsPassword) params.set("obfs-password", obfsPassword);
  }
  const up = text(proxy.up);
  if (up) params.set("up", up);
  const down = text(proxy.down);
  if (down) params.set("down", down);
  const ports = text(proxy.ports);
  if (ports) params.set("mport", ports);
  const fingerprint = text(proxy.fingerprint);
  if (fingerprint) params.set("pinSHA256", fingerprint);
  return `hysteria2://${encodeURIComponent(password)}@${server}:${port}?${params.toString()}${fragment(name)}`;
}

function nativeLink(proxy: ClashMapping, name: string, server: string, port: string, scheme: "socks5" | "http" | "https"): string {
  const user = text(proxy.username);
  const password = text(proxy.password);
  return `${scheme}://${credentials(user, password)}${server}:${port}${fragment(name)}`;
}

function convertProxy(proxy: ClashMapping, index: number): string {
  const type = text(proxy.type).toLowerCase();
  const name = text(proxy.name) || `${type || "node"}-${index + 1}`;
  const server = text(proxy.server);
  const port = text(proxy.port);
  if (!server || !port) throw new Error(`${type || "未知类型"} 节点缺少 server 或 port`);
  switch (type) {
    case "vmess":
      return vmessLink(proxy, name, server, port);
    case "vless":
      return vlessLink(proxy, name, server, port);
    case "trojan":
      return trojanLink(proxy, name, server, port);
    case "ss":
    case "shadowsocks":
      return shadowsocksLink(proxy, name, server, port);
    case "hysteria2":
    case "hy2":
      return hysteria2Link(proxy, name, server, port);
    case "socks5":
      return nativeLink(proxy, name, server, port, "socks5");
    case "http":
      return nativeLink(proxy, name, server, port, proxy.tls === true ? "https" : "http");
    case "ssr":
    case "snell":
    case "tuic":
    case "wireguard":
    case "hysteria":
      throw new Error(`不支持的 Clash 节点类型：${type}`);
    default:
      throw new Error(`未知的 Clash 节点类型：${type || "(空)"}`);
  }
}

/**
 * Converts a mihomo / Clash YAML document into share links. A malformed document throws; a bad entry
 * becomes one failure line so the rest of the file still imports.
 */
export function clashYamlToShareLinks(source: string): ClashConversionResult {
  let document: unknown;
  try {
    document = parseYaml(source);
  } catch (error) {
    throw new Error(`Clash 配置解析失败：${(error as Error).message}`);
  }
  const root = mapping(document);
  if (!Object.keys(root).length) throw new Error("Clash 配置为空。");
  const proxies = Array.isArray(root.proxies) ? root.proxies.filter((entry): entry is ClashMapping => Boolean(entry) && typeof entry === "object") : [];
  const providers = root["proxy-providers"];
  const providerCount = Array.isArray(providers)
    ? providers.length
    : providers && typeof providers === "object"
      ? Object.keys(providers).length
      : 0;

  const links: string[] = [];
  const failures: ClashConversionResult["failures"] = [];
  proxies.forEach((proxy, index) => {
    const label = text(proxy.name) || `#${index + 1}`;
    try {
      links.push(convertProxy(proxy, index));
    } catch (error) {
      failures.push({ link: `clash:${text(proxy.type) || "unknown"}:${label}`, error: (error as Error).message });
    }
  });
  return { links, failures, total: proxies.length, providerCount };
}
