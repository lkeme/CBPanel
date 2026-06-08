import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { SocksProxyAgent } from "socks-proxy-agent";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import type { NetworkCheckResult } from "../../src/shared/entities";
import { buildProxyUrl, defaultProfile, type ProxySettings } from "../../src/shared/profile";
import {
  DEFAULT_APP_SETTINGS,
  resolveNetworkTraceProvider,
  type NetworkTraceSettings,
} from "../../src/shared/settings";

export type ProxyCheckOptions = {
  source?: NetworkCheckResult["source"];
  traceSettings?: NetworkTraceSettings;
};

export class ProxyService {
  constructor(private readonly options: {
    checkTrace?: (proxyUrl: string, providerUrl: string) => Promise<string>;
  } = {}) {}

  async check(proxy: unknown, options: ProxyCheckOptions = {}): Promise<NetworkCheckResult> {
    const proxyPatch = proxy && typeof proxy === "object" ? (proxy as Partial<ProxySettings>) : {};
    const profile = defaultProfile();
    const proxyUrl = buildProxyUrl({ ...profile.proxy, ...proxyPatch });
    if (!proxyUrl) throw Object.assign(new Error("代理未启用或不完整"), { status: 400 });

    const traceSettings = options.traceSettings ?? DEFAULT_APP_SETTINGS.networkTrace;
    const provider = resolveNetworkTraceProvider(traceSettings);
    const started = Date.now();
    const rawTrace = await this.readTrace(proxyUrl, provider.url, traceSettings.timeoutSeconds);
    const traceValues = parseCloudflareTrace(rawTrace);
    if (!traceValues.ip) throw Object.assign(new Error("出口检测响应缺少 ip 字段"), { status: 502 });

    return {
      checkedAt: new Date().toISOString(),
      ok: true,
      ip: traceValues.ip,
      latencyMs: Date.now() - started,
      trace: {
        providerId: provider.id,
        providerName: provider.name,
        providerUrl: provider.url,
        host: traceValues.h,
        loc: traceValues.loc,
        colo: traceValues.colo,
        http: traceValues.http,
        tls: traceValues.tls,
        warp: traceValues.warp,
        gateway: traceValues.gateway,
        raw: traceValues,
      },
      source: options.source ?? "proxy-check",
    };
  }

  private async readTrace(proxyUrl: string, providerUrl: string, timeoutSeconds: number): Promise<string> {
    try {
      if (this.options.checkTrace) return await this.options.checkTrace(proxyUrl, providerUrl);
      return /^socks5:\/\//i.test(proxyUrl)
        ? await this.checkSocks(proxyUrl, providerUrl, timeoutSeconds)
        : await this.checkHttp(proxyUrl, providerUrl, timeoutSeconds);
    } catch (error) {
      throw normalizeProxyCheckError(error);
    }
  }

  private async checkHttp(proxyUrl: string, providerUrl: string, timeoutSeconds: number): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutSeconds * 1000);
    const agent = new ProxyAgent(proxyUrl);
    try {
      const result = await undiciFetch(providerUrl, {
        dispatcher: agent,
        signal: controller.signal,
      });
      if (!result.ok) throw new Error(`出口检测失败：HTTP ${result.status}`);
      return await result.text();
    } finally {
      clearTimeout(timeout);
      await agent.close();
    }
  }

  private async checkSocks(proxyUrl: string, providerUrl: string, timeoutSeconds: number): Promise<string> {
    const agent = new SocksProxyAgent(proxyUrl);
    const requestWithProtocol = new URL(providerUrl).protocol === "http:" ? httpRequest : httpsRequest;
    try {
      return await new Promise<string>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error, value?: string) => {
          if (settled) return;
          settled = true;
          if (error) {
            reject(error);
            return;
          }
          resolve(value ?? "");
        };
        const request = requestWithProtocol(
          providerUrl,
          {
            agent,
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
              finish(undefined, raw);
            });
            result.on("error", finish);
          },
        );
        request.on("timeout", () => {
          request.destroy(new Error("出口检测超时"));
        });
        request.on("error", finish);
        request.end();
      });
    } finally {
      destroySocksAgent(agent);
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
