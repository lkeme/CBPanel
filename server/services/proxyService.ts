import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { NetworkCheckResult, NetworkGeoResult, NetworkTraceResult, ProxyLatencyResult } from "../../src/shared/entities";
import { buildProxyUrl, defaultProfile, type ProxySettings } from "../../src/shared/profile";
import {
  DEFAULT_APP_SETTINGS,
  resolveNetworkTraceProvider,
  type NetworkTraceProvider,
  type NetworkTraceProviderMethod,
  type NetworkTraceSettings,
} from "../../src/shared/settings";
import { readLaunchGeoFromDb, type LaunchGeoDbLookup } from "./launchGeoipService";

export type ProxyCheckOptions = {
  source?: NetworkCheckResult["source"];
  traceSettings?: NetworkTraceSettings;
};

export type ProxyLatencyOptions = {
  timeoutSeconds?: number;
  targets?: string[];
};

/**
 * Small, always-on endpoints that answer a HEAD in one round trip. Raced, because no single one is
 * reachable from every exit: gstatic and Cloudflare are blocked behind some domestic proxies, the
 * Microsoft connectivity check is reachable from nearly everywhere.
 */
export const LATENCY_PROBE_TARGETS = [
  "https://www.gstatic.com/generate_204",
  "https://cp.cloudflare.com/generate_204",
  "http://www.msftconnecttest.com/connecttest.txt",
] as const;

// A provider that answers with something other than its trace format is retried once before the
// check is called off: the JSONP endpoints in particular are rate-limited and answer a bare error
// page now and then, and one retry turns most of those into a result instead of a red row.
const TRACE_FORMAT_RETRIES = 1;

// Mirrors `cloakbrowser info --proxy <url>`: what a `geoip: true` launch through this proxy would
// actually inject, which is a different question from `check()`'s "what does the trace provider see".
export type LaunchGeoOptions = {
  traceSettings?: NetworkTraceSettings;
  /** The browser core's own GeoLite2 cache path, supplied by the caller from BinaryService. Reading the same file the wrapper reads is what makes the answer match the launch; absent means the database has not been downloaded yet. */
  geoipDbPath?: string;
};

export type ProxyTraceRequest = {
  providerId: string;
  url: string;
  method: NetworkTraceProviderMethod;
  callbackName?: string;
};

export type ProxyTraceResponse = {
  url: string;
  status?: number;
  text: string;
  headers: Record<string, string>;
};

export type ParsedNetworkTrace = {
  ip?: string;
  host?: string;
  loc?: string;
  colo?: string;
  http?: string;
  tls?: string;
  warp?: string;
  gateway?: string;
  raw: Record<string, string>;
  geo?: NetworkGeoResult;
  needsGeo?: boolean;
};

export class ProxyService {
  constructor(private readonly options: {
    checkTrace?: (
      proxyUrl: string,
      providerUrl: string,
      request: ProxyTraceRequest,
    ) => Promise<string | Partial<ProxyTraceResponse>>;
    geoLookup?: (ip: string, timeoutSeconds: number) => Promise<NetworkGeoResult | undefined>;
    readLaunchGeo?: (dbPath: string | undefined, ip: string) => Promise<LaunchGeoDbLookup>;
  } = {}) {}

  async check(proxy: unknown, options: ProxyCheckOptions = {}): Promise<NetworkCheckResult> {
    const proxyUrl = proxyUrlFrom(proxy);
    const traceSettings = options.traceSettings ?? DEFAULT_APP_SETTINGS.networkTrace;
    const exit = await this.resolveExit(proxyUrl, traceSettings);
    const enrichedGeo = await this.lookupGeo(exit.ip, traceSettings.timeoutSeconds, exit.values.needsGeo === true);
    const geo = mergeGeo(exit.values.geo, enrichedGeo);

    return {
      checkedAt: new Date().toISOString(),
      ok: true,
      ip: exit.ip,
      // Measured to here, not to the end of resolveExit: this check has always reported the whole
      // round trip including the geo enrichment, and narrowing it to the trace alone would silently
      // change every latency the proxy table shows.
      latencyMs: Date.now() - exit.startedAt,
      geo,
      trace: traceResultFrom(exit.provider, exit.values),
      source: options.source ?? "proxy-check",
    };
  }

  // The exit-IP half is `check()`'s, verbatim — same providers, protocols, timeout and error
  // normalization. Only the timezone/locale half differs: it comes from the browser core's GeoLite2
  // cache rather than a third-party geo service, because the point is to report what the launch will
  // inject, not what a lookup service believes about the IP.
  async resolveLaunchGeo(proxy: unknown, options: LaunchGeoOptions = {}): Promise<NetworkCheckResult> {
    const proxyUrl = proxyUrlFrom(proxy);
    const traceSettings = options.traceSettings ?? DEFAULT_APP_SETTINGS.networkTrace;
    const exit = await this.resolveExit(proxyUrl, traceSettings);
    const lookup = await this.readLaunchGeo(options.geoipDbPath, exit.ip);

    return {
      checkedAt: new Date().toISOString(),
      ok: true,
      ip: exit.ip,
      // Mirrors check(): the whole round trip. The database read is local, so in practice this is the
      // proxy's latency either way.
      latencyMs: Date.now() - exit.startedAt,
      // Deliberately not merged with the trace's own country: the locale has to follow the country the
      // GeoLite2 database reports, since that is the one the launch maps to a locale. The trace block
      // below still carries the provider's view for display.
      geo: compactGeo({
        countryCode: lookup.countryCode,
        timezone: lookup.timezone,
        locale: lookup.locale,
      }),
      trace: traceResultFrom(exit.provider, exit.values),
      source: "launch-geoip",
    };
  }

  /**
   * The proxy's exit IP plus the raw trace it came from. One path for every caller, so a protocol or
   * timeout fix lands everywhere. Returns `startedAt` rather than an elapsed time: the callers measure
   * different spans, and letting this one decide would quietly redefine what `check()`'s latency means.
   */
  private async resolveExit(
    proxyUrl: string,
    traceSettings: NetworkTraceSettings,
  ): Promise<{ ip: string; provider: NetworkTraceProvider; values: ParsedNetworkTrace; startedAt: number }> {
    const provider = resolveNetworkTraceProvider(traceSettings);
    let lastFormatError: Error | undefined;
    for (let attempt = 0; attempt <= TRACE_FORMAT_RETRIES; attempt += 1) {
      // A fresh request each time: JSONP providers bind the callback name to the request.
      const traceRequest = buildTraceRequest(provider);
      const startedAt = Date.now();
      const traceResponse = await this.readTrace(proxyUrl, traceRequest, traceSettings.timeoutSeconds);
      try {
        const values = parseNetworkTraceResponse(provider, traceResponse, traceRequest.callbackName);
        if (!values.ip) throw traceFormatError("响应中没有 ip 字段");
        return { ip: values.ip, provider, values, startedAt };
      } catch (error) {
        if (!isTraceFormatError(error)) throw error;
        lastFormatError = describeTraceFormatError(provider, traceResponse, error as Error);
      }
    }
    throw lastFormatError ?? traceFormatError("响应格式无效");
  }

  /**
   * One round trip through the proxy to the first probe endpoint that answers. The exit check
   * measures a trace provider; this measures the proxy, which is the number an operator compares
   * nodes by. Goes through the same transports as the check, so a proxy that fails here fails there.
   */
  async measureLatency(proxy: unknown, options: ProxyLatencyOptions = {}): Promise<ProxyLatencyResult> {
    const proxyUrl = proxyUrlFrom(proxy);
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_APP_SETTINGS.networkTrace.timeoutSeconds;
    const targets = options.targets?.length ? options.targets : [...LATENCY_PROBE_TARGETS];
    const checkedAt = new Date().toISOString();
    const attempts = targets.map(async (target) => {
      const startedAt = performance.now();
      await this.readTrace(proxyUrl, { providerId: "latency-probe", url: target, method: "HEAD" }, timeoutSeconds);
      return { target, latencyMs: Math.max(1, Math.round(performance.now() - startedAt)) };
    });
    try {
      const winner = await Promise.any(attempts);
      return { checkedAt, ok: true, latencyMs: winner.latencyMs, target: winner.target };
    } catch (error) {
      const failures = error instanceof AggregateError ? error.errors : [error];
      const first = failures[0] instanceof Error ? failures[0] : new Error(String(failures[0]));
      throw Object.assign(new Error(`真延迟检测失败：${first.message}`), {
        status: errorStatus(first),
        code: "PROXY_LATENCY_FAILED",
      });
    }
  }

  private async readLaunchGeo(dbPath: string | undefined, ip: string): Promise<LaunchGeoDbLookup> {
    return this.options.readLaunchGeo
      ? await this.options.readLaunchGeo(dbPath, ip)
      : await readLaunchGeoFromDb(dbPath, ip);
  }

  private async readTrace(
    proxyUrl: string,
    request: ProxyTraceRequest,
    timeoutSeconds: number,
  ): Promise<ProxyTraceResponse> {
    try {
      if (this.options.checkTrace) {
        return normalizeTraceResponse(await this.options.checkTrace(proxyUrl, request.url, request), request.url);
      }
      return /^socks5:\/\//i.test(proxyUrl)
        ? await this.checkSocks(proxyUrl, request, timeoutSeconds)
        : await this.checkHttp(proxyUrl, request, timeoutSeconds);
    } catch (error) {
      throw normalizeProxyCheckError(error);
    }
  }

  private async checkHttp(
    proxyUrl: string,
    request: ProxyTraceRequest,
    timeoutSeconds: number,
  ): Promise<ProxyTraceResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const agent = new ProxyAgent(proxyUrl);
    try {
      const result = await undiciFetch(request.url, {
        dispatcher: agent,
        method: request.method,
        signal: controller.signal,
      });
      if (!result.ok) throw new Error(`出口检测失败：HTTP ${result.status}`);
      return {
        url: result.url || request.url,
        status: result.status,
        text: await result.text(),
        headers: headersToRecord(result.headers),
      };
    } finally {
      clearTimeout(timeout);
      await agent.close();
    }
  }

  private async checkSocks(
    proxyUrl: string,
    request: ProxyTraceRequest,
    timeoutSeconds: number,
  ): Promise<ProxyTraceResponse> {
    // `socks5h`, not `socks5`: Chromium hands the hostname to a SOCKS5 proxy and lets the far end resolve
    // it, so the check must do the same or it measures a different path — and with the Xray engine on the
    // loopback, a locally resolved name (a fake-IP resolver, a split-horizon DNS) would be sent to the
    // node as an address the node cannot reach.
    const agent = new SocksProxyAgent(proxyUrl.replace(/^socks5:\/\//i, "socks5h://"));
    const requestWithProtocol = new URL(request.url).protocol === "http:" ? httpRequest : httpsRequest;
    try {
      return await new Promise<ProxyTraceResponse>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: ProxyTraceResponse) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error);
            return;
          }
          resolve(value ?? { url: request.url, text: "", headers: {} });
        };
        const outgoing = requestWithProtocol(
          request.url,
          {
            agent,
            method: request.method,
            timeout: timeoutSeconds * 1000,
          },
          (result) => {
            let raw = "";
            result.setEncoding("utf8");
            result.on("data", (chunk) => {
              raw += chunk;
            });
            result.on("end", () => {
              if (result.statusCode && (result.statusCode < 200 || result.statusCode >= 300)) {
                finish(new Error(`出口检测失败：HTTP ${result.statusCode}`));
                return;
              }
              finish(undefined, {
                url: request.url,
                status: result.statusCode,
                text: raw,
                headers: nodeHeadersToRecord(result.headers),
              });
            });
            result.on("error", finish);
          },
        );
        outgoing.on("timeout", () => {
          outgoing.destroy(new Error("出口检测超时"));
        });
        outgoing.on("error", finish);
        outgoing.end();
      });
    } finally {
      destroySocksAgent(agent);
    }
  }

  private async lookupGeo(
    ip: string,
    timeoutSeconds: number,
    enabled: boolean,
  ): Promise<NetworkGeoResult | undefined> {
    if (!enabled) return undefined;
    try {
      return this.options.geoLookup
        ? await this.options.geoLookup(ip, timeoutSeconds)
        : await fetchIpSbGeo(ip, timeoutSeconds);
    } catch {
      return undefined;
    }
  }
}

function destroySocksAgent(agent: SocksProxyAgent): void {
  const maybeDestroyable = agent as { destroy?: () => void };
  maybeDestroyable.destroy?.();
}

/** A proxy patch as the panel sends it, resolved against the default profile so partial input still yields a complete URL. */
function proxyUrlFrom(proxy: unknown): string {
  const proxyPatch = proxy && typeof proxy === "object" ? (proxy as Partial<ProxySettings>) : {};
  const proxyUrl = buildProxyUrl({ ...defaultProfile().proxy, ...proxyPatch });
  if (!proxyUrl) throw Object.assign(new Error("代理未启用或不完整"), { status: 400 });
  return proxyUrl;
}

function traceResultFrom(provider: NetworkTraceProvider, values: ParsedNetworkTrace): NetworkTraceResult {
  return {
    providerId: provider.id,
    providerName: provider.name,
    providerUrl: provider.url,
    host: values.host,
    loc: values.loc,
    colo: values.colo,
    http: values.http,
    tls: values.tls,
    warp: values.warp,
    gateway: values.gateway,
    raw: values.raw,
  };
}

export function normalizeProxyCheckError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return Object.assign(new Error(proxyCheckErrorMessage(message)), {
    status: errorStatus(error),
    code: "PROXY_CHECK_FAILED",
  });
}

function errorStatus(error: unknown): number {
  if (typeof error === "object" && error && "status" in error) {
    const status = Number(error.status);
    if (Number.isFinite(status)) return status;
  }
  return 502;
}

function proxyCheckErrorMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes("socks5 authentication failed") || lower.includes("authentication failed") || lower.includes("http 407") || lower.includes("proxy authentication required")) {
    return "代理拒绝了账号密码（认证失败）。请检查用户名和密码。";
  }
  if (lower.includes("socket closed") || lower.includes("socket hang up") || lower.includes("econnreset") || lower.includes("epipe")) {
    return "代理连接已关闭，出口检测失败。代理可能已失效、拒绝了该目标或正在限流，请稍后重试。";
  }
  if (lower.includes("timeout") || lower.includes("timed out") || message.includes("超时")) {
    return "代理出口检测超时。代理响应过慢或目标被阻断；可调高检测超时或更换检测端点后重试。";
  }
  if (lower.includes("enotfound") || lower.includes("eai_again") || lower.includes("getaddrinfo")) {
    return "无法解析代理服务器主机名。请检查主机名拼写和本机 DNS。";
  }
  if (lower.includes("econnrefused")) {
    return "代理服务器拒绝连接（端口未开放或服务未运行）。请检查主机和端口。";
  }
  if (lower.includes("ehostunreach") || lower.includes("enetunreach")) {
    return "代理服务器不可达（路由不可达）。请检查网络或代理地址。";
  }
  // The far end closed the tunnel before the TLS handshake even started: with a SOCKS/HTTP proxy that
  // means the proxy (or the engine's node) could not connect to the target — not a TLS problem.
  if (lower.includes("before secure tls connection") || lower.includes("disconnected before secure")) {
    return "代理未能连通目标（节点不可达、拒绝连接或链路中断），连接在 TLS 握手前被断开。";
  }
  if (lower.includes("certificate") || lower.includes("self signed") || lower.includes("self-signed") || lower.includes("unable to verify") || lower.includes("tls")) {
    return `与目标建立 TLS 连接失败：${message}。代理可能在拦截或替换证书。`;
  }
  if (lower.includes("socks")) {
    return `SOCKS 握手失败：${message}。请确认协议是 SOCKS5 且代理允许该目标。`;
  }
  if (lower.includes("connect")) {
    return "无法连接到代理服务器。请检查协议、主机、端口和账号密码。";
  }
  return message || "代理出口检测失败";
}

const TRACE_FORMAT_ERROR = Symbol("trace-format-error");

function traceFormatError(detail: string): Error {
  return Object.assign(new Error(detail), { status: 502, [TRACE_FORMAT_ERROR]: true });
}

function isTraceFormatError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as Record<symbol, unknown>)[TRACE_FORMAT_ERROR] === true;
}

/** Names the provider and shows the start of what it actually sent, so a blocked page or a rate-limit notice is recognisable at a glance. */
function describeTraceFormatError(provider: NetworkTraceProvider, response: ProxyTraceResponse, error: Error): Error {
  const excerpt = response.text.replace(/\s+/g, " ").trim().slice(0, 80);
  const status = typeof response.status === "number" ? `HTTP ${response.status}` : "无状态码";
  const looksLikeHtml = /^\s*<(!doctype|html|head|body)/i.test(response.text);
  const hint = looksLikeHtml
    ? "端点返回了网页而不是检测数据，通常是代理注入了拦截页或该端点被屏蔽"
    : "端点返回了无法解析的内容，可能被限流或屏蔽";
  return Object.assign(
    new Error(`出口检测端点 ${provider.name} 响应异常（${status}，${error.message}）：${hint}；已重试仍失败，可在设置 → 网络切换检测端点。${excerpt ? ` 响应开头：${excerpt}` : ""}`),
    { status: 502, code: "PROXY_CHECK_TRACE_INVALID" },
  );
}

export function parseNetworkTraceResponse(
  provider: NetworkTraceProvider,
  response: ProxyTraceResponse,
  callbackName?: string,
): ParsedNetworkTrace {
  if (provider.kind === "cloudflare-trace") return parseCloudflareTraceResponse(response.text);
  if (provider.kind === "tencent-ip2city-jsonp") return parseTencentIp2CityJsonp(response.text, callbackName);
  if (provider.kind === "aliyun-dns-detect-jsonp") return parseAliyunDnsDetectJsonp(response.text, callbackName);
  return parseHeaderIpTraceResponse(response);
}

export function parseCloudflareTraceResponse(text: string): ParsedNetworkTrace {
  const values = parseCloudflareTrace(text);
  return {
    ip: values.ip,
    host: values.h,
    loc: values.loc,
    colo: values.colo,
    http: values.http,
    tls: values.tls,
    warp: values.warp,
    gateway: values.gateway,
    raw: values,
    needsGeo: false,
  };
}

export function parseCloudflareTrace(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (key) values[key] = value;
  }
  return values;
}

export function parseTencentIp2CityJsonp(text: string, expectedCallback?: string): ParsedNetworkTrace {
  const payload = parseJsonpObject(text, expectedCallback);
  const raw = flattenJsonPayload(payload);
  const ip = readString(payload, "ip");
  const country = readString(payload, "country");
  const province = readString(payload, "province");
  const city = readString(payload, "city");
  const district = readString(payload, "district");
  const isp = readString(payload, "isp");
  const loc = joinLocation(country, province, city, district);
  addRawValue(raw, "ip", ip);
  addRawValue(raw, "loc", loc);
  addRawValue(raw, "isp", isp);
  return {
    ip,
    loc,
    raw,
    geo: compactGeo({
      countryName: country,
      cityName: city || province,
    }),
    needsGeo: true,
  };
}

export function parseAliyunDnsDetectJsonp(text: string, expectedCallback?: string): ParsedNetworkTrace {
  const payload = parseJsonpObject(text, expectedCallback);
  const raw = flattenJsonPayload(payload);
  const content = readRecord(payload, "content");
  const ip = readString(content, "localIp") ?? readString(content, "clientIp") ?? readString(content, "ip");
  const country = readString(content, "ipCountry") ?? readString(content, "country");
  const province = readString(content, "ipProvince") ?? readString(content, "province");
  const city = readString(content, "ipCity") ?? readString(content, "city");
  const isp = readString(content, "ipIsp") ?? readString(content, "isp");
  const loc = joinLocation(country, province, city);
  addRawValue(raw, "ip", ip);
  addRawValue(raw, "loc", loc);
  addRawValue(raw, "isp", isp);
  return {
    ip,
    loc,
    raw,
    geo: compactGeo({
      countryName: country,
      cityName: city || province,
    }),
    needsGeo: true,
  };
}

export function parseHeaderIpTraceResponse(response: ProxyTraceResponse): ParsedNetworkTrace {
  const raw = captureHeaderTrace(response);
  for (const header of IP_HEADER_CANDIDATES) {
    const value = response.headers[header];
    const ip = value ? extractFirstIp(value) : undefined;
    if (ip) {
      raw.ip = ip;
      raw.ipHeader = header;
      return { ip, raw, needsGeo: true };
    }
  }
  const bodyIp = extractFirstIp(response.text);
  if (bodyIp) {
    raw.ip = bodyIp;
    raw.ipHeader = "body";
    return { ip: bodyIp, raw, needsGeo: true };
  }
  return { raw, needsGeo: true };
}

function buildTraceRequest(provider: NetworkTraceProvider): ProxyTraceRequest {
  const method = provider.method ?? defaultProviderMethod(provider);
  if (provider.kind === "tencent-ip2city-jsonp") {
    const callbackName = jsonpCallbackName("cbpanelTencent");
    const url = new URL(provider.url);
    url.searchParams.set("otype", "jsonp");
    url.searchParams.set("callback", callbackName);
    return { providerId: provider.id, url: url.toString(), method: "GET", callbackName };
  }
  if (provider.kind === "aliyun-dns-detect-jsonp") {
    const callbackName = jsonpCallbackName("cbpanelAliyun");
    const subdomain = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const url = new URL(`https://${subdomain}.dns-detect.alicdn.com/api/detect/DescribeDNSLookup`);
    url.searchParams.set("cb", callbackName);
    return { providerId: provider.id, url: url.toString(), method: "GET", callbackName };
  }
  return { providerId: provider.id, url: provider.url, method };
}

function defaultProviderMethod(provider: NetworkTraceProvider): NetworkTraceProviderMethod {
  return provider.kind === "header-ip" || provider.kind === "static-header-ip" ? "HEAD" : "GET";
}

function jsonpCallbackName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeTraceResponse(
  response: string | Partial<ProxyTraceResponse>,
  fallbackUrl: string,
): ProxyTraceResponse {
  if (typeof response === "string") {
    return { url: fallbackUrl, text: response, headers: {} };
  }
  return {
    url: typeof response.url === "string" && response.url ? response.url : fallbackUrl,
    status: response.status,
    text: typeof response.text === "string" ? response.text : "",
    headers: normalizeHeaderRecord(response.headers ?? {}),
  };
}

function headersToRecord(headers: { forEach: (callback: (value: string, key: string) => void) => void }): Record<string, string> {
  const values: Record<string, string> = {};
  headers.forEach((value, key) => {
    values[key.toLowerCase()] = value;
  });
  return values;
}

function nodeHeadersToRecord(headers: Record<string, string | string[] | number | undefined>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    values[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return values;
}

function normalizeHeaderRecord(headers: Record<string, string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    values[key.toLowerCase()] = String(value);
  }
  return values;
}

function captureHeaderTrace(response: ProxyTraceResponse): Record<string, string> {
  const raw: Record<string, string> = {
    url: response.url,
  };
  if (typeof response.status === "number") raw.status = String(response.status);
  for (const header of TRACE_HEADER_CAPTURE_NAMES) {
    const value = response.headers[header];
    if (value) raw[header] = value;
  }
  return raw;
}

const IP_HEADER_CANDIDATES = [
  "cdn-user-ip",
  "x-request-ip",
  "x-response-cinfo",
  "x-real-ip",
  "x-forwarded-for",
  "cf-connecting-ip",
  "true-client-ip",
] as const;

const TRACE_HEADER_CAPTURE_NAMES = [
  ...IP_HEADER_CANDIDATES,
  "content-type",
  "server",
  "via",
  "cf-ray",
  "x-cache",
] as const;

function extractFirstIp(value: string): string | undefined {
  const ipv4Matches = value.match(/\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g) ?? [];
  for (const candidate of ipv4Matches) {
    if (isIP(candidate)) return candidate;
  }
  const ipv6Matches = value.match(/\b(?:[a-f0-9]{1,4}:){2,}[a-f0-9]{0,4}\b/gi) ?? [];
  for (const candidate of ipv6Matches) {
    if (isIP(candidate)) return candidate;
  }
  return undefined;
}

function parseJsonpObject(text: string, expectedCallback?: string): Record<string, unknown> {
  const trimmed = text.trim().replace(/^﻿/, "");
  const match = trimmed.match(/^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\(([\s\S]*)\)\s*;?$/);
  if (!match) throw traceFormatError("JSONP 响应格式无效");
  const [, callbackName, jsonText] = match;
  if (expectedCallback && callbackName !== expectedCallback) {
    throw traceFormatError("JSONP callback 不匹配");
  }
  try {
    const parsed = JSON.parse(jsonText.trim()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    throw traceFormatError(`JSONP JSON 无法解析：${(error as Error).message}`);
  }
  throw traceFormatError("JSONP payload 不是对象");
}

function flattenJsonPayload(value: unknown, prefix = "", output: Record<string, string> = {}): Record<string, string> {
  if (value === null || value === undefined) return output;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (prefix) output[prefix] = String(value);
    return output;
  }
  if (Array.isArray(value)) {
    if (prefix) output[prefix] = JSON.stringify(value);
    return output;
  }
  if (typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      flattenJsonPayload(nested, prefix ? `${prefix}.${key}` : key, output);
    }
  }
  return output;
}

function readRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested as Record<string, unknown> : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const nested = (value as Record<string, unknown>)[key];
  if (typeof nested === "string") return nested.trim() || undefined;
  if (typeof nested === "number" && Number.isFinite(nested)) return String(nested);
  return undefined;
}

function addRawValue(raw: Record<string, string>, key: string, value: string | undefined): void {
  if (value) raw[key] = value;
}

function joinLocation(...parts: Array<string | undefined>): string | undefined {
  const value = parts.filter(Boolean).join(" / ");
  return value || undefined;
}

function compactGeo(geo: NetworkGeoResult): NetworkGeoResult | undefined {
  const result: NetworkGeoResult = {};
  if (geo.countryCode) result.countryCode = geo.countryCode;
  if (geo.countryName) result.countryName = geo.countryName;
  if (geo.cityName) result.cityName = geo.cityName;
  if (geo.timezone) result.timezone = geo.timezone;
  if (geo.locale) result.locale = geo.locale;
  return Object.keys(result).length ? result : undefined;
}

function mergeGeo(
  base: NetworkGeoResult | undefined,
  enrichment: NetworkGeoResult | undefined,
): NetworkGeoResult | undefined {
  return compactGeo({ ...(base ?? {}), ...(enrichment ?? {}) });
}

async function fetchIpSbGeo(ip: string, timeoutSeconds: number): Promise<NetworkGeoResult | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
  try {
    const result = await undiciFetch(`https://api.ip.sb/geoip/${encodeURIComponent(ip)}`, {
      headers: {
        "accept": "application/json",
        "user-agent": "CBPanel Network Trace",
      },
      signal: controller.signal,
    });
    if (!result.ok) return undefined;
    const payload = await result.json() as unknown;
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    return compactGeo({
      countryCode: stringField(record.country_code),
      countryName: stringField(record.country),
      cityName: stringField(record.city),
      timezone: stringField(record.timezone),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
