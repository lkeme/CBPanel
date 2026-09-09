import { createHash } from "node:crypto";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { unzipSync } from "fflate";
import type { XrayEngineInstance, XrayEngineOperationType, XrayEngineStatus, XrayUpdateCheck } from "../../src/shared/entities";
import { XRAY_CORE_GITHUB_RELEASE_BASE_URL, rewriteGithubDownloadUrl } from "../../src/shared/githubMirror";
import { type ProxySettings, proxyRequiresXray } from "../../src/shared/profile";
import type { AppSettings, AppSettingsPatch } from "../../src/shared/settings";
import {
  XRAY_MAIN_OUTBOUND_TAG,
  XRAY_PRE_OUTBOUND_TAG,
  type XrayConfig,
  buildXrayConfig,
  deriveUtlsFingerprint,
  maskXrayShareLink,
  xrayOutboundFromProxy,
} from "../../src/shared/xray";
import { allocateLocalProxyPort, isXrayLocalBindFailure, sleep, waitForLocalPortReady } from "./xrayLocalPort";

const XRAY_RELEASES_API_URL = "https://api.github.com/repos/XTLS/Xray-core/releases/latest";
const XRAY_OS_TOKENS: Record<string, string> = { darwin: "macos", linux: "linux", win32: "windows" };
const XRAY_ARCH_TOKENS: Record<string, string> = { arm64: "arm64-v8a", x64: "64", ia32: "32" };
// The inbound is usually up within a few hundred milliseconds; the budget is for a cold disk.
const PORT_READY_TIMEOUT_MS = 4_000;
const MAX_BIND_ATTEMPTS = 3;
const MAX_AUTO_RESTARTS = 3;
const STOP_GRACE_MS = 2_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const LOG_TAIL_LIMIT = 8_000;
const VERSION_PROBE_TIMEOUT_MS = 5_000;

export type XrayStartRequest = {
  /** The session (profile id) or check that owns the process; one process per owner. */
  ownerId: string;
  proxy: ProxySettings;
  /** The front proxy, already resolved by the caller from the library. */
  preProxy?: ProxySettings;
  fingerprint?: { brand?: string };
  /** Session-log hook for lifecycle events (started, restarted, gave up). */
  onEvent?: (level: "info" | "warn" | "error", message: string, detail?: string) => void;
};

export type XrayInstanceHandle = {
  port: number;
  /** `socks5://127.0.0.1:<port>` — the URL CloakBrowser and the exit check are pointed at. */
  localProxyUrl: string;
  upstream: string;
  preProxy?: string;
  stop: () => Promise<void>;
};

export type XrayServiceOptions = {
  dataDir: string;
  readSettings: () => Promise<AppSettings>;
  saveSettings?: (patch: AppSettingsPatch) => Promise<AppSettings>;
  fetchImpl?: typeof fetch;
  /** The GitHub mirror prefix the network settings resolve to, or undefined for a direct download. */
  resolveMirrorPrefix?: () => Promise<string | undefined>;
  /** Seams for tests: spawn the engine and probe its version through something other than the real binary. */
  spawnImpl?: typeof spawn;
  execFileImpl?: typeof execFile;
  platform?: NodeJS.Platform;
  arch?: string;
  log?: (level: "info" | "warn" | "error", message: string) => void;
};

type ManagedInstance = {
  ownerId: string;
  port: number;
  configPath: string;
  logPath: string;
  config: XrayConfig;
  upstream: string;
  preProxy?: string;
  startedAt: string;
  restarts: number;
  child?: ChildProcess;
  stopping: boolean;
  logTail: string;
  onEvent?: XrayStartRequest["onEvent"];
  restartPromise?: Promise<void>;
};

/**
 * Owns the Xray-core binary and every Xray process the panel runs. Each browser session that needs
 * the engine gets its own process on its own loopback SOCKS port, so sessions cannot see or break
 * each other's proxy, and a process that dies under a running browser is restarted on the same
 * port so the browser's proxy setting stays valid — the recovery loop GeekezBrowser runs.
 */
export class XrayService {
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly execFileImpl: typeof execFile;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly instances = new Map<string, ManagedInstance>();
  private operation?: { type: XrayEngineOperationType; startedAt: string; abort: AbortController };
  private lastError?: string;
  private versionCache?: { binaryPath: string; mtimeMs: number; version?: string };
  private exitHookInstalled = false;

  constructor(private readonly options: XrayServiceOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.execFileImpl = options.execFileImpl ?? execFile;
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
  }

  // ---------------------------------------------------------------------------------------------
  // Binary
  // ---------------------------------------------------------------------------------------------

  /** `data/xray/bin/<platform>-<arch>`: one directory per target so a copied data directory never runs the wrong build. */
  managedBinaryDir(): string {
    return path.join(this.options.dataDir, "xray", "bin", `${this.platform}-${this.arch}`);
  }

  managedBinaryPath(): string {
    return path.join(this.managedBinaryDir(), this.binaryFileName());
  }

  releaseAssetName(): string | undefined {
    const osToken = XRAY_OS_TOKENS[this.platform];
    const archToken = this.platform === "linux" && this.arch === "arm" ? "arm32-v7a" : XRAY_ARCH_TOKENS[this.arch];
    return osToken && archToken ? `Xray-${osToken}-${archToken}.zip` : undefined;
  }

  async resolveBinary(): Promise<{ binaryPath: string; source: XrayEngineStatus["source"]; binaryDir: string }> {
    const settings = await this.options.readSettings();
    const custom = settings.xray.customBinaryPath.trim();
    if (custom) {
      return {
        binaryPath: custom,
        binaryDir: path.dirname(custom),
        source: (await fileExists(custom)) ? "custom" : "missing",
      };
    }
    const managed = this.managedBinaryPath();
    return {
      binaryPath: managed,
      binaryDir: this.managedBinaryDir(),
      source: (await fileExists(managed)) ? "managed" : "missing",
    };
  }

  async readStatus(): Promise<XrayEngineStatus> {
    const settings = await this.options.readSettings();
    const binary = await this.resolveBinary();
    const installed = binary.source !== "missing";
    return {
      installed,
      source: binary.source,
      binaryPath: binary.binaryPath,
      binaryDir: binary.binaryDir,
      version: installed ? await this.readVersion(binary.binaryPath) : undefined,
      releaseAsset: this.releaseAssetName(),
      lastUpdateCheck: settings.xray.lastUpdateCheck,
      operation: this.operation ? { type: this.operation.type, startedAt: this.operation.startedAt } : undefined,
      instances: this.listInstances(),
      lastError: this.lastError,
    };
  }

  listInstances(): XrayEngineInstance[] {
    return [...this.instances.values()].map((instance) => ({
      ownerId: instance.ownerId,
      port: instance.port,
      pid: instance.child?.pid,
      startedAt: instance.startedAt,
      upstream: instance.upstream,
      preProxy: instance.preProxy,
      restarts: instance.restarts,
    }));
  }

  activeOperation(): XrayEngineOperationType | undefined {
    return this.operation?.type;
  }

  cancelOperation(): boolean {
    if (!this.operation) return false;
    this.operation.abort.abort(new Error("Xray engine operation cancelled by the operator."));
    return true;
  }

  async checkUpdate(): Promise<XrayUpdateCheck> {
    return this.runExclusively("check-update", async (signal) => {
      const binary = await this.resolveBinary();
      const currentVersion = binary.source === "missing" ? undefined : await this.readVersion(binary.binaryPath);
      let check: XrayUpdateCheck;
      try {
        const release = await this.fetchLatestRelease(signal);
        check = {
          checkedAt: new Date().toISOString(),
          currentVersion,
          latestVersion: release.version,
          updateAvailable: !currentVersion || compareVersions(release.version, currentVersion) > 0,
          downloadUrl: release.downloadUrl,
        };
      } catch (error) {
        check = {
          checkedAt: new Date().toISOString(),
          currentVersion,
          updateAvailable: false,
          error: (error as Error).message,
        };
      }
      await this.options.saveSettings?.({ xray: { lastUpdateCheck: check } });
      return check;
    });
  }

  /**
   * Downloads the latest release for this platform into the managed directory. An update is the
   * same operation; the archive replaces whatever build is there. Refused while an engine process is
   * running, because on Windows the running binary cannot be overwritten and elsewhere a swap under a
   * live process is a restart waiting to fail.
   */
  async install(): Promise<XrayEngineStatus> {
    if (this.instances.size > 0) {
      throw Object.assign(new Error("Xray 引擎正在被会话使用；请先停止使用该引擎的会话再安装或更新。"), {
        status: 409,
        code: "XRAY_INSTANCES_RUNNING",
      });
    }
    const assetName = this.releaseAssetName();
    if (!assetName) {
      throw Object.assign(new Error(`Xray-core 没有适用于 ${this.platform}-${this.arch} 的发行包。`), {
        status: 400,
        code: "XRAY_UNSUPPORTED_PLATFORM",
      });
    }
    await this.runExclusively("install", async (signal) => {
      const release = await this.fetchLatestRelease(signal);
      this.log("info", `Downloading Xray-core ${release.version} (${assetName})`);
      const archive = await this.download(release.downloadUrl, signal);
      const expectedDigest = await this.fetchDigest(release.digestUrl, signal);
      if (expectedDigest) {
        const actual = createHash("sha256").update(archive).digest("hex");
        if (actual.toLowerCase() !== expectedDigest.toLowerCase()) {
          throw Object.assign(new Error(`Xray-core 下载包校验失败：SHA-256 不匹配。`), { status: 502, code: "XRAY_CHECKSUM_MISMATCH" });
        }
      } else {
        this.log("warn", "Xray-core digest file unavailable; the archive was installed without a checksum.");
      }
      await this.installArchive(archive);
      this.versionCache = undefined;
      const version = await this.readVersion(this.managedBinaryPath());
      await this.options.saveSettings?.({
        xray: {
          lastUpdateCheck: {
            checkedAt: new Date().toISOString(),
            currentVersion: version,
            latestVersion: release.version,
            updateAvailable: false,
            downloadUrl: release.downloadUrl,
          },
        },
      });
      this.log("info", `Xray-core ${version ?? release.version} installed at ${this.managedBinaryPath()}`);
    });
    return this.readStatus();
  }

  // ---------------------------------------------------------------------------------------------
  // Instances
  // ---------------------------------------------------------------------------------------------

  isRequired(proxy: ProxySettings): boolean {
    return proxyRequiresXray(proxy);
  }

  async start(request: XrayStartRequest): Promise<XrayInstanceHandle> {
    if (this.instances.has(request.ownerId)) await this.stop(request.ownerId);
    const binary = await this.resolveBinary();
    if (binary.source === "missing") {
      throw Object.assign(new Error("Xray 引擎未安装；该代理需要 Xray-core 中转，请先在设置中安装 Xray 引擎。"), {
        status: 409,
        code: "XRAY_ENGINE_MISSING",
      });
    }
    const settings = await this.options.readSettings();
    const main = xrayOutboundFromProxy(request.proxy, XRAY_MAIN_OUTBOUND_TAG);
    const pre = request.preProxy ? xrayOutboundFromProxy(request.preProxy, XRAY_PRE_OUTBOUND_TAG) : undefined;
    const upstream = maskUpstream(request.proxy);
    const preProxy = request.preProxy ? maskUpstream(request.preProxy) : undefined;
    // A link can parse and still carry something the engine will not honour (allowInsecure, an
    // unsupported plugin); the session log is where the operator can see that before blaming the node.
    for (const warning of [...main.summary.warnings, ...(pre?.summary.warnings ?? [])]) {
      request.onEvent?.("warn", "Xray 节点参数提示", warning);
    }
    // A proxy's own uTLS choice wins over the global setting; an empty one inherits it. Each outbound
    // resolves separately because the main node and the front proxy are different TLS hops.
    const globalUtls = settings.xray.utlsFingerprint;
    const utlsFingerprint = {
      main: deriveUtlsFingerprint(request.proxy.utlsFingerprint || globalUtls, request.fingerprint ?? {}),
      pre: request.preProxy
        ? deriveUtlsFingerprint(request.preProxy.utlsFingerprint || globalUtls, request.fingerprint ?? {})
        : undefined,
    };
    const instanceDir = path.join(this.options.dataDir, "xray", "instances", safeFileName(request.ownerId));
    await fs.mkdir(instanceDir, { recursive: true });
    const configPath = path.join(instanceDir, "config.json");
    const logPath = path.join(instanceDir, "xray.log");
    await fs.writeFile(logPath, "");

    const instance: ManagedInstance = {
      ownerId: request.ownerId,
      port: 0,
      configPath,
      logPath,
      config: { log: { loglevel: "warning" }, inbounds: [], outbounds: [], routing: {} },
      upstream,
      preProxy,
      startedAt: new Date().toISOString(),
      restarts: 0,
      stopping: false,
      logTail: "",
      onEvent: request.onEvent,
    };
    this.instances.set(request.ownerId, instance);
    this.installExitHook();

    try {
      let lastFailure = "";
      for (let attempt = 1; attempt <= MAX_BIND_ATTEMPTS; attempt += 1) {
        instance.port = await allocateLocalProxyPort();
        instance.config = buildXrayConfig({
          localPort: instance.port,
          main: main.outbound,
          pre: pre?.outbound,
          ipStrategy: request.proxy.ipStrategy,
          utlsFingerprint,
          logLevel: settings.xray.logLevel,
        });
        await fs.writeFile(configPath, `${JSON.stringify(instance.config, null, 2)}\n`);
        instance.logTail = "";
        const child = this.spawnEngine(binary.binaryPath, binary.binaryDir, instance);
        const ready = await waitForLocalPortReady(instance.port, PORT_READY_TIMEOUT_MS, {
          stillAlive: () => child.exitCode === null && child.signalCode === null,
        });
        if (ready && child.exitCode === null) {
          this.attachExitRecovery(instance, child);
          request.onEvent?.(
            "info",
            "Xray 引擎已启动",
            `${preProxy ? `${preProxy} → ` : ""}${upstream} ← socks5://127.0.0.1:${instance.port}`,
          );
          return this.handleFor(instance);
        }
        lastFailure = child.exitCode !== null
          ? `xray exited before the inbound was ready (code ${child.exitCode})`
          : `local SOCKS port ${instance.port} not ready within ${PORT_READY_TIMEOUT_MS}ms`;
        await killProcess(child);
        if (attempt < MAX_BIND_ATTEMPTS && isXrayLocalBindFailure(instance.logTail, instance.port)) {
          this.log("warn", `Xray local port ${instance.port} could not be bound; retrying on another port.`);
          await sleep(150);
          continue;
        }
        break;
      }
      throw Object.assign(new Error(`Xray 引擎启动失败：${lastFailure}${logSummary(instance.logTail)}`), {
        status: 502,
        code: "XRAY_STARTUP_FAILED",
      });
    } catch (error) {
      this.instances.delete(request.ownerId);
      this.lastError = (error as Error).message;
      throw error;
    }
  }

  async stop(ownerId: string): Promise<void> {
    const instance = this.instances.get(ownerId);
    if (!instance) return;
    instance.stopping = true;
    this.instances.delete(ownerId);
    await instance.restartPromise?.catch(() => undefined);
    if (instance.child) await killProcess(instance.child);
    instance.child = undefined;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.instances.keys()].map((ownerId) => this.stop(ownerId)));
  }

  /**
   * A short-lived engine for an exit check: start, hand the local URL to the probe, always stop. A
   * probe that fails through the engine gets the engine's own last complaint appended — "no such
   * host", "connection refused", a rejected handshake — because from the probe's side every one of
   * those looks like the same closed socket.
   */
  async withTemporaryProxy<T>(
    request: Omit<XrayStartRequest, "ownerId">,
    work: (localProxyUrl: string) => Promise<T>,
  ): Promise<T> {
    const ownerId = `check:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const handle = await this.start({ ...request, ownerId });
    try {
      return await work(handle.localProxyUrl);
    } catch (error) {
      const hint = engineLogHint(this.instances.get(ownerId)?.logTail ?? "");
      if (hint && error instanceof Error && !error.message.includes(hint)) {
        error.message = `${error.message} Xray：${hint}`;
      }
      throw error;
    } finally {
      await handle.stop();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------------------------

  private handleFor(instance: ManagedInstance): XrayInstanceHandle {
    return {
      port: instance.port,
      localProxyUrl: `socks5://127.0.0.1:${instance.port}`,
      upstream: instance.upstream,
      preProxy: instance.preProxy,
      stop: () => this.stop(instance.ownerId),
    };
  }

  private spawnEngine(binaryPath: string, binaryDir: string, instance: ManagedInstance): ChildProcess {
    const child = this.spawnImpl(binaryPath, ["run", "-c", instance.configPath], {
      cwd: binaryDir,
      env: { ...process.env, XRAY_LOCATION_ASSET: binaryDir },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    instance.child = child;
    const collect = (chunk: Buffer | string) => {
      const text = chunk.toString();
      instance.logTail = `${instance.logTail}${text}`.slice(-LOG_TAIL_LIMIT);
      void fs.appendFile(instance.logPath, text).catch(() => undefined);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      instance.logTail = `${instance.logTail}\n[spawn error] ${error.message}`.slice(-LOG_TAIL_LIMIT);
    });
    return child;
  }

  private attachExitRecovery(instance: ManagedInstance, child: ChildProcess): void {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (instance.stopping || instance.child !== child || this.instances.get(instance.ownerId) !== instance) return;
      instance.child = undefined;
      const reason = `code=${code ?? "none"} signal=${signal ?? "none"}`;
      instance.onEvent?.("warn", "Xray 引擎进程退出", reason);
      this.log("warn", `Xray engine for ${instance.ownerId} exited unexpectedly (${reason}).`);
      instance.restartPromise = this.restart(instance, reason).finally(() => {
        instance.restartPromise = undefined;
      });
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      onExit(child.exitCode, child.signalCode);
      return;
    }
    child.once("exit", onExit);
  }

  private async restart(instance: ManagedInstance, reason: string): Promise<void> {
    const settings = await this.options.readSettings();
    if (!settings.xray.autoRestart) {
      instance.onEvent?.("error", "Xray 引擎未自动重启", "设置中已关闭自动重启；该会话的代理已失效。");
      return;
    }
    if (instance.restarts >= MAX_AUTO_RESTARTS) {
      instance.onEvent?.("error", "Xray 引擎重启次数已达上限", `${MAX_AUTO_RESTARTS} 次后放弃；该会话的代理已失效。`);
      return;
    }
    await sleep(500);
    if (instance.stopping || this.instances.get(instance.ownerId) !== instance) return;
    const binary = await this.resolveBinary();
    if (binary.source === "missing") {
      instance.onEvent?.("error", "Xray 引擎无法重启", "二进制文件已不存在。");
      return;
    }
    instance.restarts += 1;
    instance.logTail = "";
    const child = this.spawnEngine(binary.binaryPath, binary.binaryDir, instance);
    const ready = await waitForLocalPortReady(instance.port, PORT_READY_TIMEOUT_MS, {
      stillAlive: () => child.exitCode === null && child.signalCode === null,
    });
    if (instance.stopping || this.instances.get(instance.ownerId) !== instance) {
      await killProcess(child);
      return;
    }
    if (ready && child.exitCode === null) {
      this.attachExitRecovery(instance, child);
      instance.onEvent?.("info", "Xray 引擎已恢复", `第 ${instance.restarts} 次重启（${reason}），端口 ${instance.port} 保持不变。`);
      return;
    }
    await killProcess(child);
    instance.onEvent?.("error", "Xray 引擎重启失败", `${reason}${logSummary(instance.logTail)}`);
    if (instance.restarts < MAX_AUTO_RESTARTS) await this.restart(instance, reason);
  }

  private async runExclusively<T>(type: XrayEngineOperationType, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.operation) {
      throw Object.assign(new Error(`Xray 引擎正在执行 ${this.operation.type}，请稍后再试。`), {
        status: 409,
        code: "XRAY_OPERATION_IN_PROGRESS",
      });
    }
    const abort = new AbortController();
    this.operation = { type, startedAt: new Date().toISOString(), abort };
    const timeout = setTimeout(() => abort.abort(new Error("Xray engine operation timed out.")), DOWNLOAD_TIMEOUT_MS);
    try {
      const result = await run(abort.signal);
      if (type !== "check-update") this.lastError = undefined;
      return result;
    } catch (error) {
      this.lastError = (error as Error).message;
      throw abort.signal.aborted
        ? Object.assign(new Error("Xray 引擎操作已取消。"), { status: 409, code: "XRAY_OPERATION_CANCELLED" })
        : error;
    } finally {
      clearTimeout(timeout);
      this.operation = undefined;
    }
  }

  private async fetchLatestRelease(signal: AbortSignal): Promise<{ version: string; downloadUrl: string; digestUrl: string }> {
    const assetName = this.releaseAssetName();
    if (!assetName) {
      throw Object.assign(new Error(`Xray-core 没有适用于 ${this.platform}-${this.arch} 的发行包。`), {
        status: 400,
        code: "XRAY_UNSUPPORTED_PLATFORM",
      });
    }
    const prefix = await this.options.resolveMirrorPrefix?.().catch(() => undefined);
    const candidates = prefix ? [XRAY_RELEASES_API_URL, `${prefix}${XRAY_RELEASES_API_URL}`] : [XRAY_RELEASES_API_URL];
    let lastError: unknown;
    for (const url of candidates) {
      try {
        const response = await this.fetchImpl(url, {
          headers: { accept: "application/vnd.github+json", "user-agent": "CBPanel Xray Engine" },
          signal,
        });
        if (!response.ok) throw new Error(`GitHub API returned HTTP ${response.status}`);
        const release = await response.json() as { tag_name?: unknown };
        const tag = typeof release.tag_name === "string" ? release.tag_name.trim() : "";
        if (!/^v?\d+\.\d+\.\d+/.test(tag)) throw new Error("GitHub release response has no usable tag_name");
        const downloadUrl = `${XRAY_CORE_GITHUB_RELEASE_BASE_URL}/${tag}/${assetName}`;
        return {
          version: tag.replace(/^v/, ""),
          downloadUrl: rewriteGithubDownloadUrl(downloadUrl, prefix)?.rewrittenUrl ?? downloadUrl,
          digestUrl: rewriteGithubDownloadUrl(`${downloadUrl}.dgst`, prefix)?.rewrittenUrl ?? `${downloadUrl}.dgst`,
        };
      } catch (error) {
        lastError = error;
        if (signal.aborted) break;
      }
    }
    throw Object.assign(new Error(`无法获取 Xray-core 最新版本：${(lastError as Error)?.message ?? "unknown error"}`), {
      status: 502,
      code: "XRAY_RELEASE_LOOKUP_FAILED",
    });
  }

  private async download(url: string, signal: AbortSignal): Promise<Buffer> {
    const response = await this.fetchImpl(url, { headers: { "user-agent": "CBPanel Xray Engine" }, signal });
    if (!response.ok) throw Object.assign(new Error(`下载 Xray-core 失败：HTTP ${response.status}`), { status: 502 });
    return Buffer.from(await response.arrayBuffer());
  }

  private async fetchDigest(url: string, signal: AbortSignal): Promise<string | undefined> {
    try {
      const response = await this.fetchImpl(url, { headers: { "user-agent": "CBPanel Xray Engine" }, signal });
      if (!response.ok) return undefined;
      return parseSha256Digest(await response.text());
    } catch {
      return undefined;
    }
  }

  private async installArchive(archive: Buffer): Promise<void> {
    const entries = unzipSync(new Uint8Array(archive));
    const binaryName = this.binaryFileName();
    const wanted = new Set([binaryName, "geoip.dat", "geosite.dat", "LICENSE", "README.md"]);
    const binaryDir = this.managedBinaryDir();
    const staging = `${binaryDir}.staging-${Date.now().toString(36)}`;
    await fs.rm(staging, { recursive: true, force: true });
    await fs.mkdir(staging, { recursive: true });
    let sawBinary = false;
    for (const [entryName, data] of Object.entries(entries)) {
      const baseName = path.posix.basename(entryName);
      if (entryName.endsWith("/") || !wanted.has(baseName)) continue;
      await fs.writeFile(path.join(staging, baseName), data);
      if (baseName === binaryName) sawBinary = true;
    }
    if (!sawBinary) {
      await fs.rm(staging, { recursive: true, force: true });
      throw Object.assign(new Error(`Xray-core 发行包中没有 ${binaryName}。`), { status: 502, code: "XRAY_ARCHIVE_INVALID" });
    }
    if (this.platform !== "win32") await fs.chmod(path.join(staging, binaryName), 0o755);
    const previous = `${binaryDir}.old-${Date.now().toString(36)}`;
    await fs.mkdir(path.dirname(binaryDir), { recursive: true });
    if (await fileExists(binaryDir)) await fs.rename(binaryDir, previous);
    try {
      await fs.rename(staging, binaryDir);
    } catch (error) {
      if (await fileExists(previous)) await fs.rename(previous, binaryDir).catch(() => undefined);
      throw error;
    }
    await fs.rm(previous, { recursive: true, force: true }).catch(() => undefined);
  }

  private async readVersion(binaryPath: string): Promise<string | undefined> {
    let mtimeMs: number;
    try {
      mtimeMs = (await fs.stat(binaryPath)).mtimeMs;
    } catch {
      return undefined;
    }
    if (this.versionCache && this.versionCache.binaryPath === binaryPath && this.versionCache.mtimeMs === mtimeMs) {
      return this.versionCache.version;
    }
    const version = await new Promise<string | undefined>((resolve) => {
      this.execFileImpl(
        binaryPath,
        ["version"],
        { timeout: VERSION_PROBE_TIMEOUT_MS, windowsHide: true, cwd: path.dirname(binaryPath) },
        (error, stdout) => {
          if (error && !stdout) {
            resolve(undefined);
            return;
          }
          const match = String(stdout).match(/Xray\s+v?(\d+\.\d+\.\d+(?:[-+.][0-9A-Za-z.]+)?)/i);
          resolve(match ? match[1] : undefined);
        },
      );
    });
    this.versionCache = { binaryPath, mtimeMs, version };
    return version;
  }

  private binaryFileName(): string {
    return this.platform === "win32" ? "xray.exe" : "xray";
  }

  private installExitHook(): void {
    if (this.exitHookInstalled) return;
    this.exitHookInstalled = true;
    // A hard exit of the panel must not leave engines listening on loopback ports for ever; this is
    // the one thing that still runs when stopAll() never got the chance to.
    process.once("exit", () => {
      for (const instance of this.instances.values()) {
        instance.stopping = true;
        try {
          instance.child?.kill();
        } catch {
          // Already gone.
        }
      }
    });
  }

  private log(level: "info" | "warn" | "error", message: string): void {
    if (this.options.log) {
      this.options.log(level, message);
      return;
    }
    if (level === "error") console.error(`[xray] ${message}`);
    else if (level === "warn") console.warn(`[xray] ${message}`);
    else console.log(`[xray] ${message}`);
  }
}

/** Prefers the semantic version order Xray tags use; a non-numeric segment sorts as newer than nothing. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string) => value.replace(/^v/, "").split(/[.-]/).map((part) => Number.parseInt(part, 10));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const x = Number.isFinite(a[index]) ? a[index] : 0;
    const y = Number.isFinite(b[index]) ? b[index] : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/** Xray ships `<asset>.dgst` files with lines like `SHA2-256= <hex>`; any 64-hex value after a SHA-256 label counts. */
export function parseSha256Digest(text: string): string | undefined {
  const match = text.match(/SHA2?-?256\s*[=:]\s*([0-9a-fA-F]{64})/);
  return match ? match[1] : undefined;
}

function maskUpstream(proxy: ProxySettings): string {
  if (proxy.scheme === "xray") return maskXrayShareLink(proxy.shareLink) || "xray://?";
  return `${proxy.scheme}://${proxy.host}:${proxy.port}`;
}

/** The last line of an engine log that explains a failure, without its timestamp and bracket noise. */
export function engineLogHint(logTail: string): string | undefined {
  const lines = logTail.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const relevant = [...lines].reverse().find((line) => /failed|rejected|refused|no such host|timeout|unreachable|reset by peer|invalid/i.test(line));
  if (!relevant) return undefined;
  const cleaned = relevant
    .replace(/^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?\s*/, "")
    .replace(/^\[[A-Za-z]+\]\s*/, "")
    .replace(/^from tcp:[^ ]+ accepted [^ ]+ \[[^\]]+\]\s*/, "")
    .trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 200)}…` : cleaned;
}

function logSummary(logTail: string): string {
  const trimmed = logTail.trim();
  if (!trimmed) return "";
  const lines = trimmed.split(/\r?\n/).filter(Boolean);
  return `；引擎日志：${lines.slice(-3).join(" | ").slice(0, 600)}`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120) || "instance";
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function killProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    child.kill();
  } catch {
    return;
  }
  const graceful = await Promise.race([exited.then(() => true), sleep(STOP_GRACE_MS).then(() => false)]);
  if (graceful) return;
  try {
    child.kill("SIGKILL");
  } catch {
    // Already gone.
  }
  await Promise.race([exited, sleep(STOP_GRACE_MS)]);
}
