import type {
  ProxyEntity,
  ProxyImportResult,
  ProxySubscriptionEntity,
  ProxySubscriptionRefreshResult,
} from "../../src/shared/entities";
import {
  type SubscriptionTextKind,
  classifySubscriptionText,
  maskXrayShareLink,
  parseXrayShareLink,
  proxyNodeIdentity,
} from "../../src/shared/xray";

/**
 * Remembered subscriptions and the imports that feed the proxy library.
 *
 * A subscription's members are the proxies whose `subscriptionId` names it. A refresh re-reads the
 * address and makes the members match what it lists now: nodes that appeared are created, nodes
 * that vanished are deleted, nodes still listed are kept (renamed if only their remark changed).
 * Two rules protect the user's own work:
 *   - a member an environment launches through, or another proxy chains through, is never deleted
 *     or replaced by a refresh — it leaves the subscription and lives on as a standalone proxy;
 *   - a standalone proxy is never touched: a node that already exists outside the subscription is
 *     skipped rather than duplicated or adopted (the one exception is an entry the plain import of
 *     the same address created earlier, which a newly remembered subscription takes over).
 */

export interface ProxySubscriptionRepository {
  listProxies(options?: { includeSecrets?: boolean }): Promise<ProxyEntity[]>;
  createProxy(input: Partial<ProxyEntity>): Promise<ProxyEntity>;
  updateProxy(id: string, patch: Partial<ProxyEntity>): Promise<ProxyEntity>;
  deleteProxy(id: string): Promise<void>;
  listProxyUsage(): Promise<Map<string, { environmentIds: string[]; chainedProxyIds: string[] }>>;
  listProxySubscriptions(options?: { includeSecrets?: boolean }): Promise<ProxySubscriptionEntity[]>;
  getProxySubscription(id: string, options?: { includeSecrets?: boolean }): Promise<ProxySubscriptionEntity | undefined>;
  createProxySubscription(input: Partial<ProxySubscriptionEntity>): Promise<ProxySubscriptionEntity>;
  updateProxySubscription(id: string, patch: Partial<ProxySubscriptionEntity>): Promise<ProxySubscriptionEntity>;
  saveProxySubscriptionRefresh(id: string, result: ProxySubscriptionRefreshResult): Promise<ProxySubscriptionEntity>;
  deleteProxySubscription(id: string, options: { proxies: "keep" | "delete" }): Promise<{ detached: string[]; deleted: string[] }>;
}

export interface ProxySubscriptionRememberInput {
  name?: string;
  autoRefresh?: boolean;
  refreshIntervalHours?: number;
  notes?: string;
}

export interface ProxySubscriptionRefreshOutcome {
  subscription: ProxySubscriptionEntity;
  result: ProxySubscriptionRefreshResult;
}

export const PROXY_IMPORT_LINK_LIMIT = 500;
// Enough failures to see the pattern, not enough to bury the summary.
export const PROXY_IMPORT_FAILURE_LIMIT = 20;
const SUBSCRIPTION_FETCH_TIMEOUT_MS = 20_000;
const SUBSCRIPTION_BODY_LIMIT = 4 * 1024 * 1024;
const SCHEDULER_INTERVAL_MS = 5 * 60_000;
const SCHEDULER_INITIAL_DELAY_MS = 20_000;

type ParsedNode = { link: string; key: string; input: Partial<ProxyEntity> };

/** Everything one pass over a body did, before it is shaped into an import or a refresh result. */
type ApplyOutcome = {
  imported: ProxyEntity[];
  failures: Array<{ link: string; error: string }>;
  kept: number;
  removed: number;
  detached: number;
  skipped: number;
  adopted: number;
  total: number;
};

export class ProxySubscriptionService {
  private readonly repository: ProxySubscriptionRepository;
  private readonly fetchBody: (url: string) => Promise<string>;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private timer: NodeJS.Timeout | undefined;
  private schedulerRun: Promise<void> | undefined;
  /** One refresh per subscription at a time; a manual click during the scheduler's pass joins it. */
  private readonly inFlight = new Map<string, Promise<ProxySubscriptionRefreshOutcome>>();

  constructor(options: {
    repository: ProxySubscriptionRepository;
    fetchBody?: (url: string) => Promise<string>;
    now?: () => Date;
    log?: (message: string) => void;
  }) {
    this.repository = options.repository;
    this.fetchBody = options.fetchBody ?? fetchSubscriptionBody;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? ((message) => console.warn(message));
  }

  /** Pasted share links or a subscription body, as standalone library entries. */
  async importLinks(text: string, options: { sourceUrl?: string } = {}): Promise<ProxyImportResult> {
    const outcome = await this.applyBody(text, { sourceUrl: options.sourceUrl });
    return importResultFrom(outcome, options.sourceUrl);
  }

  /**
   * Fetch an address and import what it lists. With `remember`, the address becomes a subscription
   * (or refreshes the one already remembered for it) and the imported nodes are its members.
   */
  async importSubscription(url: string, options: { remember?: ProxySubscriptionRememberInput } = {}): Promise<ProxyImportResult> {
    const address = validateSubscriptionUrl(url);
    const body = await this.fetchBody(address);
    if (!options.remember) return this.importLinks(body, { sourceUrl: address });

    let subscription = (await this.repository.listProxySubscriptions({ includeSecrets: true })).find((item) => item.url === address);
    if (!subscription) {
      subscription = await this.repository.createProxySubscription({ ...options.remember, url: address });
    }
    const outcome = await this.applySubscriptionBody(subscription, body);
    const result = importResultFrom(outcome, address);
    result.subscription = await this.repository.getProxySubscription(subscription.id) ?? subscription;
    return result;
  }

  /** Remember an address and read it once; nothing is stored when the address cannot be read. */
  async createSubscription(input: Partial<ProxySubscriptionEntity>): Promise<ProxySubscriptionRefreshOutcome> {
    const address = validateSubscriptionUrl(typeof input.url === "string" ? input.url : "");
    const body = await this.fetchBody(address);
    const subscription = await this.repository.createProxySubscription({ ...input, url: address });
    const outcome = await this.applySubscriptionBody(subscription, body);
    return { subscription: await this.repository.getProxySubscription(subscription.id) ?? subscription, result: refreshResultFrom(outcome, this.now()) };
  }

  async refresh(id: string): Promise<ProxySubscriptionRefreshOutcome> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const run = this.refreshNow(id).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, run);
    return run;
  }

  /** Every enabled subscription, or with `onlyDue` just those whose interval has elapsed. Failures are reported, not thrown. */
  async refreshAll(options: { onlyDue?: boolean } = {}): Promise<Array<{ id: string; name: string; result: ProxySubscriptionRefreshResult }>> {
    const now = this.now();
    const subscriptions = (await this.repository.listProxySubscriptions()).filter((subscription) =>
      subscription.status !== "disabled" && (!options.onlyDue || (subscription.autoRefresh && isRefreshDue(subscription, now))),
    );
    const results: Array<{ id: string; name: string; result: ProxySubscriptionRefreshResult }> = [];
    for (const subscription of subscriptions) {
      try {
        const outcome = await this.refresh(subscription.id);
        results.push({ id: subscription.id, name: subscription.name, result: outcome.result });
      } catch (error) {
        results.push({
          id: subscription.id,
          name: subscription.name,
          result: { ...emptyRefreshResult(this.now()), ok: false, error: (error as Error).message },
        });
      }
    }
    return results;
  }

  /** Periodically refreshes the subscriptions that asked for it; the timer never keeps the process alive. */
  startScheduler(options: { intervalMs?: number; initialDelayMs?: number } = {}): void {
    if (this.timer) return;
    const intervalMs = options.intervalMs ?? SCHEDULER_INTERVAL_MS;
    const tick = () => {
      this.schedulerRun ??= this.refreshAll({ onlyDue: true })
        .then((results) => {
          for (const entry of results) {
            if (!entry.result.ok) this.log(`订阅「${entry.name}」自动刷新失败：${entry.result.error ?? "unknown error"}`);
          }
        })
        .catch((error) => this.log(`订阅自动刷新失败：${(error as Error).message}`))
        .finally(() => {
          this.schedulerRun = undefined;
          if (this.timer) {
            this.timer = setTimeout(tick, intervalMs);
            this.timer.unref();
          }
        });
    };
    this.timer = setTimeout(tick, options.initialDelayMs ?? SCHEDULER_INITIAL_DELAY_MS);
    this.timer.unref();
  }

  stopScheduler(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async refreshNow(id: string): Promise<ProxySubscriptionRefreshOutcome> {
    const subscription = await this.repository.getProxySubscription(id, { includeSecrets: true });
    if (!subscription) throw Object.assign(new Error("订阅不存在"), { status: 404 });
    let body: string;
    try {
      body = await this.fetchBody(subscription.url);
    } catch (error) {
      const result: ProxySubscriptionRefreshResult = { ...emptyRefreshResult(this.now()), ok: false, error: (error as Error).message };
      await this.repository.saveProxySubscriptionRefresh(id, result);
      throw error;
    }
    let outcome: ApplyOutcome;
    try {
      outcome = await this.applySubscriptionBody(subscription, body, { saveOutcome: false });
    } catch (error) {
      const result: ProxySubscriptionRefreshResult = { ...emptyRefreshResult(this.now()), ok: false, error: (error as Error).message };
      await this.repository.saveProxySubscriptionRefresh(id, result);
      throw error;
    }
    const result = refreshResultFrom(outcome, this.now());
    const saved = await this.repository.saveProxySubscriptionRefresh(id, result);
    return { subscription: saved, result };
  }

  private async applySubscriptionBody(
    subscription: ProxySubscriptionEntity,
    body: string,
    options: { saveOutcome?: boolean } = {},
  ): Promise<ApplyOutcome> {
    let outcome: ApplyOutcome;
    try {
      outcome = await this.applyBody(body, { sourceUrl: subscription.url, subscriptionId: subscription.id });
    } catch (error) {
      if (options.saveOutcome !== false) {
        await this.repository.saveProxySubscriptionRefresh(subscription.id, {
          ...emptyRefreshResult(this.now()),
          ok: false,
          error: (error as Error).message,
        });
      }
      throw error;
    }
    if (options.saveOutcome !== false) {
      await this.repository.saveProxySubscriptionRefresh(subscription.id, refreshResultFrom(outcome, this.now()));
    }
    return outcome;
  }

  /**
   * One pass over a body. Without a subscription every parsable node that is new becomes a standalone
   * proxy. With one, the pass is a reconciliation of that subscription's members against the body.
   */
  private async applyBody(text: string, options: { sourceUrl?: string; subscriptionId?: string }): Promise<ApplyOutcome> {
    const classification = classifySubscriptionText(text);
    if (classification.kind !== "links") throw subscriptionFormatError(classification.kind);
    const links = classification.links;
    if (links.length > PROXY_IMPORT_LINK_LIMIT) {
      throw Object.assign(new Error(`一次最多导入 ${PROXY_IMPORT_LINK_LIMIT} 个节点。`), { status: 400, code: "PROXY_IMPORT_TOO_MANY" });
    }
    const failures: ApplyOutcome["failures"] = [];
    const nodes: ParsedNode[] = [];
    for (const link of links) {
      try {
        const input = proxyInputFromShareLink(link, options.sourceUrl);
        nodes.push({ link, key: proxyNodeIdentity(inputIdentity(input)), input });
      } catch (error) {
        failures.push({ link: describeUnusableLine(link), error: (error as Error).message });
      }
    }
    if (nodes.length === 0) {
      // Not one usable line: that is one fact about the body, not hundreds of facts about its lines.
      const sample = failures[0];
      throw Object.assign(
        new Error(
          `共 ${links.length} 行，没有任何一行是可识别的节点链接（例如 ${sample.link}：${sample.error}）。`
          + "支持 vmess://、vless://、trojan://、ss://、socks://、http:// 链接或 base64 订阅内容。",
        ),
        { status: 400, code: "PROXY_IMPORT_UNRECOGNIZED" },
      );
    }

    const subscriptionId = options.subscriptionId ?? "";
    const all = await this.repository.listProxies({ includeSecrets: true });
    const usage = subscriptionId ? await this.repository.listProxyUsage() : new Map<string, unknown>();
    const outcome: ApplyOutcome = { imported: [], failures, kept: 0, removed: 0, detached: 0, skipped: 0, adopted: 0, total: links.length };

    // Members in use leave the subscription first, so nothing below can delete or replace them.
    const members = subscriptionId ? all.filter((proxy) => proxy.subscriptionId === subscriptionId) : [];
    const activeMembers: ProxyEntity[] = [];
    for (const member of members) {
      if (usage.has(member.id)) {
        await this.repository.updateProxy(member.id, { subscriptionId: "" });
        outcome.detached += 1;
      } else {
        activeMembers.push(member);
      }
    }
    const activeMemberIds = new Set(activeMembers.map((member) => member.id));
    const memberByKey = new Map(activeMembers.map((member) => [proxyNodeIdentity(member), member]));
    const othersByKey = new Map<string, ProxyEntity>();
    for (const proxy of all) {
      if (activeMemberIds.has(proxy.id)) continue;
      const key = proxyNodeIdentity(proxy);
      if (!othersByKey.has(key)) othersByKey.set(key, proxy);
    }
    const sourceNotes = options.sourceUrl ? [subscriptionNote(options.sourceUrl), `订阅：${options.sourceUrl}`] : [];

    const seen = new Set<string>();
    for (const node of nodes) {
      if (seen.has(node.key)) continue;
      seen.add(node.key);
      const member = memberByKey.get(node.key);
      if (member) {
        outcome.kept += 1;
        await this.renameKeptMember(member, node);
        continue;
      }
      const other = othersByKey.get(node.key);
      if (other) {
        // The plain import of this very address created it earlier: a subscription remembered now
        // takes it over, unless the user has since bound it somewhere.
        const adoptable = Boolean(subscriptionId)
          && !other.subscriptionId
          && !usage.has(other.id)
          && sourceNotes.includes(other.notes);
        if (adoptable) {
          await this.repository.updateProxy(other.id, { subscriptionId, notes: "" });
          outcome.adopted += 1;
        } else {
          outcome.skipped += 1;
        }
        continue;
      }
      try {
        const created = await this.repository.createProxy({
          ...node.input,
          ...(subscriptionId ? { subscriptionId, notes: "" } : {}),
        });
        outcome.imported.push(created);
      } catch (error) {
        failures.push({ link: describeUnusableLine(node.link), error: (error as Error).message });
      }
    }

    // Members the address no longer lists — and that nothing uses — go with it.
    for (const member of activeMembers) {
      if (seen.has(proxyNodeIdentity(member))) continue;
      await this.repository.deleteProxy(member.id);
      outcome.removed += 1;
    }
    return outcome;
  }

  /** A member whose remark changed keeps its identity but follows the new name, unless the user renamed it. */
  private async renameKeptMember(member: ProxyEntity, node: ParsedNode): Promise<void> {
    if (member.scheme !== "xray" || member.shareLink === node.link) return;
    const previousRemark = member.xrayNode?.remark ?? "";
    const nextName = typeof node.input.name === "string" ? node.input.name : "";
    const patch: Partial<ProxyEntity> = { shareLink: node.link };
    if (nextName && (member.name === previousRemark || member.name === `${member.host}:${member.port}`)) patch.name = nextName;
    await this.repository.updateProxy(member.id, patch);
  }
}

export function isRefreshDue(subscription: Pick<ProxySubscriptionEntity, "lastRefresh" | "refreshIntervalHours">, now: Date): boolean {
  const last = subscription.lastRefresh ? Date.parse(subscription.lastRefresh.checkedAt) : Number.NaN;
  if (!Number.isFinite(last)) return true;
  return now.getTime() - last >= subscription.refreshIntervalHours * 60 * 60_000;
}

function emptyRefreshResult(now: Date): ProxySubscriptionRefreshResult {
  return { checkedAt: now.toISOString(), ok: true, added: 0, kept: 0, removed: 0, detached: 0, skipped: 0, failed: 0, total: 0 };
}

function refreshResultFrom(outcome: ApplyOutcome, now: Date): ProxySubscriptionRefreshResult {
  return {
    checkedAt: now.toISOString(),
    ok: true,
    added: outcome.imported.length + outcome.adopted,
    kept: outcome.kept,
    removed: outcome.removed,
    detached: outcome.detached,
    skipped: outcome.skipped,
    failed: outcome.failures.length,
    total: outcome.total,
  };
}

function importResultFrom(outcome: ApplyOutcome, sourceUrl: string | undefined): ProxyImportResult {
  return {
    imported: outcome.imported,
    failed: outcome.failures.slice(0, PROXY_IMPORT_FAILURE_LIMIT),
    failedTotal: outcome.failures.length,
    skipped: outcome.skipped + outcome.kept,
    ...(outcome.adopted > 0 ? { adopted: outcome.adopted } : {}),
    total: outcome.total,
    ...(sourceUrl ? { sourceUrl } : {}),
  };
}

function inputIdentity(input: Partial<ProxyEntity>): Parameters<typeof proxyNodeIdentity>[0] {
  return {
    scheme: input.scheme ?? "http",
    host: input.host ?? "",
    port: input.port ?? "",
    username: input.username,
    password: input.password,
    shareLink: input.shareLink,
  };
}

/** The note a plain import leaves: the address's host only, never its token. */
export function subscriptionNote(url: string): string {
  try {
    return `订阅：${new URL(url).host}`;
  } catch {
    return `订阅：${url}`;
  }
}

/** A socks/http link is stored as the native proxy it is; every other protocol is an xray node. */
export function proxyInputFromShareLink(link: string, sourceUrl?: string): Partial<ProxyEntity> {
  const parsed = parseXrayShareLink(link);
  const { summary } = parsed;
  const name = summary.remark || `${summary.address}:${summary.port}`;
  const notes = sourceUrl ? subscriptionNote(sourceUrl) : "";
  if (summary.protocol === "socks" || summary.protocol === "http") {
    const server = (parsed.outbound.settings as { servers: Array<{ address: string; port: number; users?: Array<{ user: string; pass: string }> }> }).servers[0];
    const user = server.users?.[0];
    return {
      name,
      scheme: summary.protocol === "socks" ? "socks5" : summary.security === "tls" ? "https" : "http",
      host: server.address,
      port: String(server.port),
      username: user?.user ?? "",
      password: user?.pass ?? "",
      notes,
    };
  }
  return { name, scheme: "xray", shareLink: link, notes };
}

export function subscriptionFormatError(kind: Exclude<SubscriptionTextKind, "links">): Error {
  switch (kind) {
    case "html":
      return Object.assign(
        new Error("订阅地址返回的是网页而不是节点列表：可能需要登录、token 已失效，或被网关/防火墙拦截。请先在浏览器中打开订阅地址确认。"),
        { status: 400, code: "PROXY_IMPORT_UNSUPPORTED_FORMAT" },
      );
    case "clash-yaml":
      return Object.assign(
        new Error("订阅内容是 Clash 配置（YAML），CBPanel 暂不支持；请在订阅面板改用 base64 / v2rayN 格式的订阅链接。"),
        { status: 400, code: "PROXY_IMPORT_UNSUPPORTED_FORMAT" },
      );
    case "json":
      return Object.assign(
        new Error("订阅内容是 JSON（例如 sing-box 配置），CBPanel 暂不支持；请改用 base64 / v2rayN 格式的订阅链接。"),
        { status: 400, code: "PROXY_IMPORT_UNSUPPORTED_FORMAT" },
      );
    default:
      return Object.assign(
        new Error("没有可导入的节点链接；支持 vmess://、vless://、trojan://、ss://、socks://、http:// 链接或 base64 订阅内容。"),
        { status: 400, code: "PROXY_IMPORT_EMPTY" },
      );
  }
}

/** A line that never parsed may still hold a credential, so only its scheme and a short prefix travel back. */
export function describeUnusableLine(line: string): string {
  const masked = maskXrayShareLink(line);
  if (masked !== "****") return masked;
  const scheme = line.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1];
  if (scheme) return `${scheme}://…`;
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

export function validateSubscriptionUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw Object.assign(new Error("订阅地址无效。"), { status: 400, code: "PROXY_SUBSCRIPTION_URL_INVALID" });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw Object.assign(new Error("订阅地址必须是 http:// 或 https://。"), { status: 400, code: "PROXY_SUBSCRIPTION_URL_INVALID" });
  }
  // The address is kept as typed: a token may not survive WHATWG re-serialisation unchanged.
  return url.trim();
}

export async function fetchSubscriptionBody(url: string): Promise<string> {
  const address = validateSubscriptionUrl(url);
  let response: Response;
  try {
    response = await fetch(address, {
      headers: { "user-agent": "CBPanel/0.1 (subscription)", accept: "text/plain,*/*" },
      signal: AbortSignal.timeout(SUBSCRIPTION_FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
  } catch (error) {
    throw Object.assign(new Error(`订阅下载失败：${(error as Error).message}`), { status: 502, code: "PROXY_SUBSCRIPTION_FETCH_FAILED" });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`订阅下载失败：HTTP ${response.status}`), { status: 502, code: "PROXY_SUBSCRIPTION_FETCH_FAILED" });
  }
  const body = await response.text();
  if (body.length > SUBSCRIPTION_BODY_LIMIT) {
    throw Object.assign(new Error("订阅内容超过 4 MB，已拒绝。"), { status: 413, code: "PROXY_SUBSCRIPTION_TOO_LARGE" });
  }
  return body;
}
