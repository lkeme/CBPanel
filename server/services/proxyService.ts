import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { NetworkCheckResult, NetworkGeoResult } from "../../src/shared/entities";
import { buildProxyUrl, defaultProfile, type ProxySettings } from "../../src/shared/profile";
import {
  DEFAULT_APP_SETTINGS,
  resolveNetworkTraceProvider,
  type NetworkTraceProvider,
  type NetworkTraceProviderMethod,
  type NetworkTraceSettings,
} from "../../src/shared/settings";

export type ProxyCheckOptions = {
  source?: NetworkCheckResult["source"];
  traceSettings?: NetworkTraceSettings;
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
  } = {}) {}

  async check(proxy: unknown, options: ProxyCheckOptions = {}): Promise<NetworkCheckResult> {
    const proxyPatch = proxy && typeof proxy === "object" ? (proxy as Partial<ProxySettings>) : {};
    const profile = defaultProfile();
    const proxyUrl = buildProxyUrl({ ...profile.proxy, ...proxyPatch });
    if (!proxyUrl) throw Object.assign(new Error("代理未启用或不完整"), { status: 400 });

    const traceSettings = options.traceSettings ?? DEFAULT_APP_SETTINGS.networkTrace;
    const provider = resolveNetworkTraceProvider(traceSettings);
    const traceRequest = buildTraceRequest(provider);
    const started = Date.now();
    const traceResponse = await this.readTrace(proxyUrl, traceRequest, traceSettings.timeoutSeconds);
    const traceValues = parseNetworkTraceResponse(provider, traceResponse, traceRequest.callbackName);
    if (!traceValues.ip) throw Object.assign(new Error(`出口检测响应缺少 ip 字段：${provider.name}`), { status: 502 });
    const enrichedGeo = await this.lookupGeo(traceValues.ip, traceSettings.timeoutSeconds, traceValues.needsGeo === true);
    const geo = mergeGeo(traceValues.geo, enrichedGeo);

    return {
      checkedAt: new Date().toISOString(),
      ok: true,
      ip: traceValues.ip,
      latencyMs: Date.now() - started,
      geo,
      trace: {
        providerId: provider.id,
        providerName: provider.name,
        providerUrl: provider.url,
        host: traceValues.host,
        loc: traceValues.loc,
        colo: traceValues.colo,
        http: traceValues.http,
        tls: traceValues.tls,
        warp: traceValues.warp,
        gateway: traceValues.gateway,
        raw: traceValues.raw,
      },
      source: options.source ?? "proxy-check",
    };
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
    const agent = new SocksProxyAgent(proxyUrl);
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
  if (lower.includes("socket closed") || lower.includes("socket hang up") || lower.includes("econnreset")) {
    return "代理连接已关闭，出口检测失败。请确认代理仍可用后重试。";
  }
  if (lower.includes("timeout") || message.includes("超时")) {
    return "代理出口检测超时。请确认代理质量或调高检测超时后重试。";
  }
  if (lower.includes("connect") || lower.includes("econnrefused") || lower.includes("enotfound") || lower.includes("ehostunreach")) {
    return "无法连接到代理服务器。请检查协议、主机、端口和账号密码。";
  }
  return message || "代理出口检测失败";
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
  if (!match) throw Object.assign(new Error("出口检测 JSONP 响应格式无效"), { status: 502 });
  const [, callbackName, jsonText] = match;
  if (expectedCallback && callbackName !== expectedCallback) {
    throw Object.assign(new Error("出口检测 JSONP callback 不匹配"), { status: 502 });
  }
  try {
    const parsed = JSON.parse(jsonText.trim()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch (error) {
    throw Object.assign(new Error(`出口检测 JSONP JSON 无法解析：${(error as Error).message}`), { status: 502 });
  }
  throw Object.assign(new Error("出口检测 JSONP payload 不是对象"), { status: 502 });
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
