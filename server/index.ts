import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserProfile,
  type PanelState,
  type ProxySettings,
  buildProxyUrl,
  defaultProfile,
  maskProfileSecrets,
  normalizeProfile,
} from "../src/shared/profile";
import type { NetworkCheckResult, ProxyEntity, SystemDiagnostics } from "../src/shared/entities";
import { resolveNetworkTraceProvider } from "../src/shared/settings";
import {
  payloadTooLargeMessage,
  readBindEnvironmentIds,
  readDirectoryMode,
  readExtensionWriteBody,
  readImportConflictHeaders,
  readImportConflictOptions,
  readUnbindEnvironmentIds,
  readUploadedArchive,
} from "./lib/extensionRequest";
import { launchProfileFromRequest, stopProfileFromRequest } from "./lib/sessionRequest";
import { BinaryService } from "./services/binaryService";
import { AppBackupService } from "./services/appBackupService";
import { DesktopRuntimeService } from "./services/desktopRuntimeService";
import { ExtensionService } from "./services/extensionService";
import { EnvironmentDataService } from "./services/environmentDataService";
import { EnvironmentPackageService } from "./services/environmentPackageService";
import { GithubMirrorProbeService } from "./services/githubMirrorProbeService";
import { installPackagedInspectorShim } from "./services/packagedRuntime";
import { ProxyService } from "./services/proxyService";
import {
  browserEvaluateCallbackSerializationHealth,
  SessionService,
} from "./services/sessionService";
import { SqlitePanelRepository } from "./storage/sqliteStore";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const DATA_DIR = process.env.CBPANEL_DATA_DIR
  ? path.resolve(process.env.CBPANEL_DATA_DIR)
  : path.join(ROOT_DIR, "data");
const STORE_PATH = path.join(DATA_DIR, "profiles.json");
const BROWSER_DATA_DIR = path.join(DATA_DIR, "browser-data");
const EXTENSION_RUNTIME_DIR = path.join(DATA_DIR, "extension-runtimes");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = "127.0.0.1";
const SHELL_MODE = process.env.CBPANEL_SHELL === "desktop" ? "desktop" : "web";
const DESKTOP_TOKEN = process.env.CBPANEL_DESKTOP_TOKEN;
const API_ONLY = process.env.CBPANEL_API_ONLY === "1";
const PORTABLE = Boolean(process.env.CBPANEL_PORTABLE);
const DESKTOP_CORS_HEADERS = "authorization,content-type,x-cbpanel-token,x-cbpanel-conflict-disposition,x-cbpanel-conflict-extension-id";
const DESKTOP_CORS_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
const PACKAGED_RUNTIME = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
const RELEASE_SMOKE = process.env.CBPANEL_RELEASE_SMOKE === "1";
const EXTENSION_UPLOAD_LIMIT = "200mb";

// Must run before anything loads cloakbrowser or playwright-core: the packaged Node has no inspector.
installPackagedInspectorShim();

const repository = new SqlitePanelRepository({
  dataDir: DATA_DIR,
  legacyJsonPath: STORE_PATH,
  portable: PORTABLE,
});

const binaryService = new BinaryService({
  dataDir: DATA_DIR,
  portable: PORTABLE,
  readSettings: () => repository.getSettings(),
  saveSettings: (patch) => repository.saveSettings(patch),
  // Read lazily: sessionService is constructed below, and the prune needs the answer at call time.
  hasActiveSessions: () => activeEnvironmentIds().size > 0,
  // Also lazy, for the same reason: proxyService is constructed below. Injected rather than imported so
  // BinaryService owns only the GeoLite2 cache path and ProxyService owns only the exit probe.
  resolveLaunchGeo: async (proxyUrl) => {
    const result = await proxyService.resolveLaunchGeo({ enabled: true, raw: proxyUrl }, {
      traceSettings: (await repository.getSettings()).networkTrace,
      geoipDbPath: await binaryService.resolveGeoipDbPath(),
    });
    return {
      exitIp: result.ip,
      timezone: result.geo?.timezone,
      locale: result.geo?.locale,
      unresolvedReason: result.geoUnresolvedReason,
    };
  },
});

// One definition for every service that rm's or renames a file a browser may have open: the browser
// core's cache, the extension directories, the environment packages. It lives on SessionService because
// only that knows about a stop whose close was never confirmed — a session that is no longer launchable
// but whose process may still be alive. Read lazily: sessionService is constructed below.
function activeEnvironmentIds(): Set<string> {
  return sessionService.profileIdsHoldingRuntime();
}

function activeDataOperation(): string | undefined {
  if (appBackupService.hasOperationInFlight()) return "执行应用备份或恢复";
  if (environmentPackageService.hasOperationInFlight()) return "导入或导出环境包";
  return undefined;
}

function assertNoDataOperationInFlight(): void {
  const operation = activeDataOperation();
  if (!operation) return;
  throw Object.assign(new Error(`环境数据正在${operation}，请等它完成后再开始其他数据操作。`), {
    status: 409,
    code: "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS",
  });
}

const extensionService = new ExtensionService({
  repository,
  extensionCacheDir: path.join(DATA_DIR, "extensions"),
  extensionArchiveDir: path.join(DATA_DIR, "extension-archives"),
  extensionRuntimeDir: EXTENSION_RUNTIME_DIR,
  browserDataDir: BROWSER_DATA_DIR,
  activeEnvironmentIds,
});
void extensionService.sweepCacheArtifacts().catch(() => undefined);
const sessionService = new SessionService({
  browserDataDir: BROWSER_DATA_DIR,
  readBinaryInfo: () => binaryService.readInfo(),
  extensionService,
  readEnvironment: (id) => repository.getEnvironment(id),
  checkNetwork: (profile) => checkProfileNetwork(profile),
  readSettings: () => repository.getSettings(),
  // Read at call time, not captured: an operation can start after a launch has begun.
  activeCacheOperation: () => binaryService.activeCacheOperation(),
  activeDataOperation,
});
const proxyService = new ProxyService();
const environmentDataService = new EnvironmentDataService({
  browserDataDir: BROWSER_DATA_DIR,
  extensionRuntimeDir: EXTENSION_RUNTIME_DIR,
});
const environmentPackageService = new EnvironmentPackageService({
  repository,
  browserDataDir: BROWSER_DATA_DIR,
  extensionCacheDir: path.join(DATA_DIR, "extensions"),
  activeEnvironmentIds,
});
const appBackupService = new AppBackupService({
  repository,
  browserDataDir: BROWSER_DATA_DIR,
  extensionCacheDir: path.join(DATA_DIR, "extensions"),
  extensionRuntimeDir: EXTENSION_RUNTIME_DIR,
  activeEnvironmentIds,
});
const githubMirrorProbeService = new GithubMirrorProbeService();
const desktopRuntimeService = new DesktopRuntimeService({
  shellMode: SHELL_MODE,
  host: HOST,
  port: PORT,
  portable: PORTABLE,
});

function isRuntimeDataPath(inputPath: string): boolean {
  const absolutePath = path.isAbsolute(inputPath) ? inputPath : path.join(ROOT_DIR, inputPath);
  const normalizedPath = path.normalize(absolutePath);
  const normalizedDataDir = path.normalize(DATA_DIR);
  const comparablePath = process.platform === "win32" ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableDataDir = process.platform === "win32" ? normalizedDataDir.toLowerCase() : normalizedDataDir;
  return comparablePath === comparableDataDir || comparablePath.startsWith(`${comparableDataDir}${path.sep}`);
}

async function panelState(): Promise<PanelState> {
  const [
    profiles,
    environments,
    groups,
    tags,
    proxies,
    extensions,
    extensionSources,
    trash,
    settings,
    storage,
  ] = await Promise.all([
    repository.listProfiles(),
    repository.listEnvironments(),
    repository.listGroups(),
    repository.listTags(),
    repository.listProxies(),
    repository.listExtensions(),
    repository.listExtensionSources(),
    repository.listTrashEnvironments(),
    repository.getSettings(),
    repository.getInfo(),
  ]);
  return {
    profiles,
    environments,
    groups,
    tags,
    proxies,
    extensions,
    extensionSources,
    trash,
    sessions: sessionService.listSessions(),
    meta: {
      dataDir: DATA_DIR,
      profileCount: profiles.length,
    },
    settings,
    storage,
  };
}

// A stored proxy with its credentials, or a 404. One lookup for every route that needs the real values.
async function findProxyWithSecrets(proxyId: string): Promise<ProxyEntity> {
  const proxy = (await repository.listProxies({ includeSecrets: true })).find((item) => item.id === proxyId);
  if (!proxy) throw Object.assign(new Error("代理不存在"), { status: 404 });
  return proxy;
}

// A stored proxy as the profile-shaped patch the proxy service takes. `raw` is cleared on purpose: the
// entity carries discrete parts, and a stale raw URL would win over them in buildProxyUrl.
function proxySettingsFrom(proxy: ProxyEntity): Partial<ProxySettings> {
  return {
    enabled: true,
    raw: "",
    scheme: proxy.scheme,
    host: proxy.host,
    port: proxy.port,
    username: proxy.username,
    password: proxy.password,
    bypass: proxy.bypass,
  };
}

async function proxyUrlForEntity(proxyId: string): Promise<string> {
  const proxy = await findProxyWithSecrets(proxyId);
  const proxyUrl = buildProxyUrl({ ...defaultProfile().proxy, ...proxySettingsFrom(proxy) });
  if (!proxyUrl) throw Object.assign(new Error("代理配置不完整"), { status: 400 });
  return proxyUrl;
}

// `proxyUrl` mirrors `cloakbrowser info --proxy <url>`: given one, the diagnostics also report the exit
// IP, timezone and locale a `geoip: true` launch through that proxy would apply. Without one nothing is
// resolved and no network call is made, which is how upstream leaves plain `info`.
async function systemDiagnostics(proxyUrl?: string): Promise<SystemDiagnostics> {
  const [storage, extensionSources, extensions, settings, browserCoreDiagnostics] = await Promise.all([
    repository.getInfo(),
    repository.listExtensionSources(),
    repository.listExtensions(),
    repository.getSettings(),
    binaryService.readWrapperDiagnostics({ quick: true, proxy: proxyUrl }),
  ]);
  const traceProvider = resolveNetworkTraceProvider(settings.networkTrace);
  const sessions = sessionService.listSessions();
  const extensionErrors = extensions
    .filter((extension) => extension.lastError)
    .map((extension) => ({
      at: extension.lastCheckedAt ?? extension.updatedAt,
      source: `extension:${extension.name}`,
      message: extension.lastError ?? "",
    }));
  const sourceErrors = extensionSources
    .filter((source) => source.lastError)
    .map((source) => ({
      at: source.lastRefreshedAt ?? source.updatedAt,
      source: `extension-source:${source.name}`,
      message: source.lastError ?? "",
    }));

  return {
    checkedAt: new Date().toISOString(),
    schemaVersion: 3,
    dataDir: DATA_DIR,
    databasePath: storage.databasePath,
    portable: storage.portable,
    storage: {
      kind: "sqlite",
      migratedFromJson: storage.migratedFromJson,
      migrationError: storage.migrationError,
    },
    sessions: {
      total: sessions.length,
      running: sessions.filter((session) => session.status === "running").length,
      launching: sessions.filter((session) => session.status === "launching").length,
      error: sessions.filter((session) => session.status === "error").length,
    },
    networkTrace: {
      providerId: traceProvider.id,
      providerName: traceProvider.name,
      providerUrl: traceProvider.url,
      timeoutSeconds: settings.networkTrace.timeoutSeconds,
    },
    extensionSources: {
      total: extensionSources.length,
      enabled: extensionSources.filter((source) => source.status === "enabled").length,
      lastError: sourceErrors.at(-1)?.message,
    },
    extensionCache: {
      directory: path.join(DATA_DIR, "extensions"),
      installedCount: extensions.filter((extension) => extension.installState === "installed").length,
    },
    browserCoreDiagnostics,
    recentErrors: [...extensionErrors, ...sourceErrors]
      .sort((left, right) => right.at.localeCompare(left.at))
      .slice(0, 20),
  };
}

async function checkProfileNetwork(profile: BrowserProfile): Promise<NetworkCheckResult> {
  const environment = await repository.getEnvironment(profile.id);
  const settings = await repository.getSettings();
  const result = await proxyService
    .check(profile.proxy, {
      source: "environment-check",
      traceSettings: settings.networkTrace,
    })
    .catch((error) => networkCheckFailure(error));
  await repository.saveEnvironmentNetworkCheck(profile.id, result);
  if (environment?.proxyId) await repository.saveProxyCheckResult(environment.proxyId, result);
  return result;
}

type ReleaseSmokeDependencyHealth = {
  packaged: boolean;
  dependencies: Array<{
    name: string;
    ok: boolean;
    version?: string;
    error?: string;
  }>;
};

async function releaseSmokeDependencyHealth(): Promise<ReleaseSmokeDependencyHealth> {
  const dependencies = await Promise.all([
    inspectReleaseSmokeDependency("playwright-core", () => import("playwright-core")),
    inspectReleaseSmokeDependency("puppeteer-core", () => import("puppeteer-core")),
    inspectReleaseSmokeDependency("socks-proxy-agent", () => import("socks-proxy-agent")),
    inspectReleaseSmokeDependency("undici", () => import("undici")),
  ]);
  const callbackHealth = browserEvaluateCallbackSerializationHealth();
  const failedCallbacks = callbackHealth.filter((callback) => !callback.ok);
  dependencies.push({
    name: "browser-evaluate-serialization",
    ok: failedCallbacks.length === 0,
    ...(failedCallbacks.length > 0
      ? {
          error: failedCallbacks
            .map((callback) => `${callback.name}: ${callback.error ?? "unknown serialization failure"}`)
            .join("; "),
        }
      : {}),
  });
  return {
    packaged: PACKAGED_RUNTIME,
    dependencies,
  };
}

async function inspectReleaseSmokeDependency(
  name: string,
  loader: () => Promise<unknown>,
): Promise<ReleaseSmokeDependencyHealth["dependencies"][number]> {
  try {
    const module = await loader();
    return {
      name,
      ok: true,
      version: readModuleVersion(module),
    };
  } catch (error) {
    return {
      name,
      ok: false,
      error: (error as Error).message,
    };
  }
}

function readModuleVersion(module: unknown): string | undefined {
  if (!module || typeof module !== "object") return undefined;
  const record = module as Record<string, unknown>;
  const version = record.version ?? (record.default && typeof record.default === "object" ? (record.default as Record<string, unknown>).version : undefined);
  return typeof version === "string" ? version : undefined;
}

function networkCheckFailure(error: unknown): NetworkCheckResult {
  return {
    checkedAt: new Date().toISOString(),
    ok: false,
    source: "environment-check",
    error: (error as Error).message,
  };
}

function requireDesktopToken(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (SHELL_MODE !== "desktop") {
    next();
    return;
  }

  if (!DESKTOP_TOKEN) {
    response.status(503).json({ error: "Desktop sidecar token is not configured" });
    return;
  }

  if (hasDesktopShellToken(request)) {
    next();
    return;
  }

  void allowAdvancedWebEntryApi(request)
    .then((allowed) => {
      if (allowed) {
        next();
        return;
      }
      response.status(401).json({ error: "Desktop API token is invalid" });
    })
    .catch((error) => sendError(response, error));
}

function requireDesktopShellToken(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (SHELL_MODE !== "desktop") {
    response.status(404).json({ error: "Desktop shutdown is not available in web mode" });
    return;
  }

  if (!DESKTOP_TOKEN) {
    response.status(503).json({ error: "Desktop sidecar token is not configured" });
    return;
  }

  if (!hasDesktopShellToken(request)) {
    response.status(401).json({ error: "Desktop API token is invalid" });
    return;
  }

  next();
}

function hasDesktopShellToken(request: express.Request): boolean {
  if (!DESKTOP_TOKEN) return false;
  const authorization = request.header("authorization");
  const headerToken = request.header("x-cbpanel-token");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  return headerToken === DESKTOP_TOKEN || bearerToken === DESKTOP_TOKEN;
}

function desktopSidecarCors(request: express.Request, response: express.Response, next: express.NextFunction): void {
  if (SHELL_MODE !== "desktop") {
    next();
    return;
  }

  const origin = request.header("origin");
  if (origin && isAllowedDesktopOrigin(origin)) {
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Headers", DESKTOP_CORS_HEADERS);
  response.setHeader("Access-Control-Allow-Methods", DESKTOP_CORS_METHODS);

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
}

function isAllowedDesktopOrigin(origin: string): boolean {
  if (origin === "tauri://localhost" || origin === "https://tauri.localhost" || origin === "http://tauri.localhost") {
    return true;
  }

  try {
    const parsed = new URL(origin);
    return parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost";
  } catch {
    return false;
  }
}

async function allowAdvancedWebEntryApi(request: express.Request): Promise<boolean> {
  if (SHELL_MODE !== "desktop" || !API_ONLY) return false;
  if (!isLoopbackAddress(request.socket.remoteAddress) || !isLoopbackHost(request.hostname)) return false;
  if (!isSameMaintenanceOrigin(request)) return false;
  return (await repository.getSettings()).desktop.advancedWebEntry;
}

async function allowAdvancedWebEntryPage(request: express.Request): Promise<boolean> {
  if (SHELL_MODE !== "desktop" || !API_ONLY) return false;
  if (!isLoopbackAddress(request.socket.remoteAddress) || !isLoopbackHost(request.hostname)) return false;
  return (await repository.getSettings()).desktop.advancedWebEntry;
}

function isSameMaintenanceOrigin(request: express.Request): boolean {
  const origin = request.header("origin");
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" || parsed.protocol === "https:")
      && isLoopbackHost(parsed.hostname)
      && parsed.port === String(PORT)
    );
  } catch {
    return false;
  }
}

function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  return value === "127.0.0.1" || value === "::1" || value === "::ffff:127.0.0.1";
}

const extensionUploadBody = express.raw({ type: "application/octet-stream", limit: EXTENSION_UPLOAD_LIMIT });

function sendError(response: express.Response, error: unknown): void {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  const usage = typeof error === "object" && error && "usage" in error ? error.usage : undefined;
  const candidates = typeof error === "object" && error && "candidates" in error ? error.candidates : undefined;
  const matchBy = typeof error === "object" && error && "matchBy" in error ? error.matchBy : undefined;
  const permissions = typeof error === "object" && error && "permissions" in error ? error.permissions : undefined;
  response.status(Number.isFinite(status) ? status : 500).json({
    error: (error as Error).message || "未知错误",
    ...(code ? { code } : {}),
    ...(usage ? { usage } : {}),
    ...(candidates ? { candidates } : {}),
    ...(matchBy ? { matchBy } : {}),
    ...(permissions ? { permissions } : {}),
  });
}

async function createApp(): Promise<express.Express> {
  const app = express();
  app.use("/api", desktopSidecarCors);
  app.use(express.json({ limit: "2mb" }));
  app.use("/api", requireDesktopToken);

  app.get("/api/state", async (_request, response) => {
    try {
      response.json(await panelState());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/settings", async (_request, response) => {
    try {
      response.json(await repository.getSettings());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/settings", async (request, response) => {
    try {
      response.json(await repository.saveSettings(request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/storage/info", async (_request, response) => {
    try {
      response.json(await repository.getInfo());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/storage/migrate", async (_request, response) => {
    try {
      response.json(await repository.migrateLegacyJson());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/storage/browser-data/prune", async (_request, response) => {
    try {
      // A restore or a package import creates `browser-data/<id>` before the row that names it exists, so
      // in that window every directory it has laid down matches this route's definition of an orphan — and
      // this route would answer by deleting the data being restored. The two flows sit behind modal
      // dialogs in the panel, so only a direct API call can overlap them, but that is enough: the loss is
      // not recoverable. Refused loudly rather than deferred, the way clearCache refuses over a running
      // session (server/services/binaryService.ts) — a prune is an explicit request, and reporting a
      // successful cleanup that ate a restore is the worse outcome.
      if (appBackupService.hasRestoreInFlight() || environmentPackageService.hasImportInFlight()) {
        throw Object.assign(new Error("正在恢复或导入环境数据，请等它完成后再清理 browser-data 目录"), {
          status: 409,
          code: "ENVIRONMENT_DATA_OPERATION_IN_PROGRESS",
        });
      }
      // Passed as a resolver, not as a list: the service lists the directories first and only then asks for
      // the registered ids, and that order is what makes an environment created while this route runs safe.
      // Reading the ids here would miss one registered a moment later, while the readdir that followed
      // already saw its brand new data directory — and that directory would be deleted as an orphan.
      //
      // Trashed environments must count as known too: their directories are what restoreEnvironment brings
      // a profile back to, so a prune that only knew the active ids would delete exactly the data a
      // restore needs.
      response.json(await environmentDataService.pruneOrphanEnvironmentData(async () => {
        const [environments, trashed] = await Promise.all([
          repository.listEnvironments(),
          repository.listTrashEnvironments(),
        ]);
        return [
          ...environments.map((environment) => environment.id),
          ...trashed.map((item) => item.environment.id),
          ...sessionService.profileIdsHoldingRuntime(),
        ];
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/desktop/runtime", (_request, response) => {
    response.json(desktopRuntimeService.info());
  });

  app.post("/api/desktop/shutdown", requireDesktopShellToken, (_request, response) => {
    response.status(202).json({ ok: true });
    setImmediate(() => {
      void shutdown().finally(() => process.exit(0));
    });
  });

  app.get("/api/environments", async (_request, response) => {
    try {
      response.json(await repository.listEnvironments());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments", async (request, response) => {
    try {
      response.status(201).json(await repository.createEnvironment(request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/batch-update", async (request, response) => {
    try {
      const environmentIds = Array.isArray(request.body?.environmentIds) ? request.body.environmentIds : [];
      const patch = request.body?.patch ?? {};
      const updated = [];
      for (const environmentId of environmentIds) {
        updated.push(await repository.updateEnvironment(String(environmentId), patch));
      }
      response.json(updated);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/environments/export", async (request, response) => {
    try {
      const scope = request.query.scope === "trash" || request.query.scope === "all" ? request.query.scope : "active";
      const includeSecrets = request.query.secrets === "full";
      const active = scope === "trash" ? [] : await repository.listEnvironments();
      const trash = scope === "active" ? [] : await repository.listTrashEnvironments();
      response.setHeader("Content-Disposition", "attachment; filename=cbpanel-environments.json");
      const maskEnvironment = (environment: Awaited<ReturnType<typeof repository.listEnvironments>>[number]) => ({
        ...environment,
        runtimeProfile: includeSecrets ? environment.runtimeProfile : maskProfileSecrets(environment.runtimeProfile),
      });
      response.json({
        schemaVersion: 2,
        scope,
        exportedAt: new Date().toISOString(),
        environments: active.map(maskEnvironment),
        trash: trash.map((item) => ({
          ...item,
          environment: maskEnvironment(item.environment),
        })),
        groups: await repository.listGroups(),
        tags: await repository.listTags(),
        proxies: await repository.listProxies({ includeSecrets }),
        extensions: await repository.listExtensions(),
        extensionSources: await repository.listExtensionSources(),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/import", async (request, response) => {
    try {
      const incoming = request.body as { profiles?: unknown[]; environments?: Array<{ runtimeProfile?: unknown }> };
      const profiles = Array.isArray(incoming.profiles)
        ? incoming.profiles
        : Array.isArray(incoming.environments)
          ? incoming.environments.map((environment) => environment.runtimeProfile ?? environment)
          : undefined;
      if (!profiles) {
        throw Object.assign(new Error("导入文件缺少 profiles 或 environments 数组"), { status: 400 });
      }
      const result = await repository.importProfiles(profiles);
      response.json({
        imported: result.imported,
        environments: await repository.listEnvironments(),
      });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environment-packages/export", (request, response) => {
    try {
      assertNoDataOperationInFlight();
      const outputPath = typeof request.body?.outputPath === "string" ? request.body.outputPath.trim() : "";
      if (!outputPath) throw Object.assign(new Error("Environment package output path is required."), { status: 400 });
      const environmentIds = Array.isArray(request.body?.environmentIds)
        ? request.body.environmentIds.map((id: unknown) => String(id)).filter(Boolean)
        : undefined;
      const operation = environmentPackageService.startExport({ environmentIds, outputPath });
      response.status(202).json({ operationId: operation.id, operation });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environment-packages/import", (request, response) => {
    try {
      assertNoDataOperationInFlight();
      const inputPath = typeof request.body?.inputPath === "string" ? request.body.inputPath.trim() : "";
      if (!inputPath) throw Object.assign(new Error("Environment package input path is required."), { status: 400 });
      const operation = environmentPackageService.startImport({ inputPath });
      response.status(202).json({ operationId: operation.id, operation });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/environment-packages/operations/:id", (request, response) => {
    const operation = environmentPackageService.getOperation(request.params.id);
    if (!operation) {
      response.status(404).json({ error: "Environment package operation does not exist." });
      return;
    }
    response.json(operation);
  });

  app.post("/api/app-backups/export", (request, response) => {
    try {
      assertNoDataOperationInFlight();
      const outputPath = typeof request.body?.outputPath === "string" ? request.body.outputPath.trim() : "";
      if (!outputPath) throw Object.assign(new Error("App backup output path is required."), { status: 400 });
      const operation = appBackupService.startExport({ outputPath });
      response.status(202).json({ operationId: operation.id, operation });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/app-backups/restore", (request, response) => {
    try {
      assertNoDataOperationInFlight();
      const inputPath = typeof request.body?.inputPath === "string" ? request.body.inputPath.trim() : "";
      if (!inputPath) throw Object.assign(new Error("App backup input path is required."), { status: 400 });
      const operation = appBackupService.startRestore({ inputPath });
      response.status(202).json({ operationId: operation.id, operation });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/app-backups/operations/:id", (request, response) => {
    const operation = appBackupService.getOperation(request.params.id);
    if (!operation) {
      response.status(404).json({ error: "App backup operation does not exist." });
      return;
    }
    response.json(operation);
  });

  app.get("/api/environments/:id", async (request, response) => {
    try {
      const environment = await repository.getEnvironment(request.params.id);
      if (!environment || environment.deletedAt) throw Object.assign(new Error("环境不存在"), { status: 404 });
      response.json(environment);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/environments/:id", async (request, response) => {
    try {
      response.json(await repository.updateEnvironment(request.params.id, request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/:id/duplicate", async (request, response) => {
    try {
      response.status(201).json(await repository.duplicateEnvironment(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/environments/:id", async (request, response) => {
    try {
      if (sessionService.hasActiveSession(request.params.id)) {
        throw Object.assign(new Error("先停止运行中的会话，再删除环境"), { status: 409 });
      }
      await repository.softDeleteEnvironment(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/:id/launch", async (request, response) => {
    try {
      response.json(await launchProfileFromRequest(
        request.params.id,
        request.body,
        (profileId) => repository.getProfile(profileId),
        sessionService,
        "环境不存在",
      ));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/:id/preflight", async (request, response) => {
    try {
      const profile = await repository.getProfile(request.params.id);
      if (!profile) throw Object.assign(new Error("环境不存在"), { status: 404 });
      response.json(await sessionService.preflight(profile));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/:id/network-check", async (request, response) => {
    try {
      const environment = await repository.getEnvironment(request.params.id);
      const profile = await repository.getProfile(request.params.id);
      if (!environment || environment.deletedAt || !profile) {
        throw Object.assign(new Error("环境不存在"), { status: 404 });
      }

      response.json(await checkProfileNetwork(profile));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/environments/:id/stop", async (request, response) => {
    try {
      response.json(await stopProfileFromRequest(request.params.id, request.body, sessionService));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/groups", async (_request, response) => {
    try {
      response.json(await repository.listGroups());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/groups", async (request, response) => {
    try {
      response.status(201).json(await repository.createGroup(request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/groups/:id", async (request, response) => {
    try {
      response.json(await repository.updateGroup(request.params.id, request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/groups/:id", async (request, response) => {
    try {
      await repository.deleteGroup(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/groups/:id/merge", async (request, response) => {
    try {
      response.json(await repository.mergeGroup(request.params.id, String(request.body?.targetId ?? "")));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/tags", async (_request, response) => {
    try {
      response.json(await repository.listTags());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/tags", async (request, response) => {
    try {
      response.status(201).json(await repository.createTag(request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/tags/:id", async (request, response) => {
    try {
      response.json(await repository.updateTag(request.params.id, request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/tags/:id", async (request, response) => {
    try {
      await repository.deleteTag(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/tags/:id/merge", async (request, response) => {
    try {
      response.json(await repository.mergeTag(request.params.id, String(request.body?.targetId ?? "")));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/tags/batch-assign", async (request, response) => {
    try {
      response.json(await repository.assignTags(request.body?.environmentIds ?? [], request.body?.tagIds ?? []));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/tags/batch-remove", async (request, response) => {
    try {
      response.json(await repository.removeTags(request.body?.environmentIds ?? [], request.body?.tagIds ?? []));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/proxies", async (_request, response) => {
    try {
      response.json(await repository.listProxies());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/proxies/:id", async (request, response) => {
    try {
      const includeSecrets = request.query.secrets === "1" || request.query.secrets === "true";
      const proxy = (await repository.listProxies({ includeSecrets })).find((item) => item.id === request.params.id);
      if (!proxy) throw Object.assign(new Error("Proxy not found"), { status: 404 });
      response.json(proxy);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/proxies", async (request, response) => {
    try {
      response.status(201).json(await repository.createProxy(request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/proxies/:id", async (request, response) => {
    try {
      response.json(await repository.updateProxy(request.params.id, request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/proxies/:id/duplicate", async (request, response) => {
    try {
      response.status(201).json(await repository.duplicateProxy(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/proxies/:id", async (request, response) => {
    try {
      await repository.deleteProxy(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/proxies/:id/replace-references", async (request, response) => {
    try {
      const targetId = typeof request.body?.targetId === "string" && request.body.targetId.trim() ? request.body.targetId : undefined;
      response.json(await repository.replaceProxyReferences(request.params.id, targetId));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/proxies/:id/check", async (request, response) => {
    try {
      const proxy = await findProxyWithSecrets(request.params.id);
      try {
        const settings = await repository.getSettings();
        const result = await proxyService.check(proxySettingsFrom(proxy), {
          traceSettings: settings.networkTrace,
          source: "proxy-check",
        });
        await repository.saveProxyCheckResult(request.params.id, result);
        response.json(result);
      } catch (error) {
        await repository.saveProxyCheckResult(request.params.id, {
          checkedAt: new Date().toISOString(),
          ok: false,
          source: "proxy-check",
          error: (error as Error).message,
        });
        throw error;
      }
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/extensions", async (_request, response) => {
    try {
      response.json(await repository.listExtensions());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions", async (request, response) => {
    try {
      const body = readExtensionWriteBody(request.body, { allowSourceKind: true });
      if (body.sourceKind === "remote-zip" || body.sourceKind === "remote-crx") {
        response.status(201).json(await extensionService.createRemote(body));
        return;
      }
      response.status(201).json(await repository.createExtension(body));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/extensions/:id", async (request, response) => {
    try {
      const patch = readExtensionWriteBody(request.body, { allowSourceKind: false });
      response.json(await repository.updateExtension(request.params.id, patch));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/extensions/:id", async (request, response) => {
    try {
      await extensionService.deleteExtension(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-directory", async (request, response) => {
    try {
      const mode = readDirectoryMode(request.body?.mode);
      const conflict = readImportConflictOptions(request.body);
      response.status(201).json(await extensionService.importDirectory(String(request.body?.path ?? ""), mode, conflict));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-directory/preview", async (request, response) => {
    try {
      response.json(await extensionService.previewDirectory(String(request.body?.path ?? "")));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-directories", async (request, response) => {
    try {
      const paths = Array.isArray(request.body?.paths) ? request.body.paths.map((item: unknown) => String(item)) : [];
      const conflict = readImportConflictOptions(request.body);
      response.status(201).json(await extensionService.importDirectories(paths, readDirectoryMode(request.body?.mode), conflict));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-zip", async (request, response) => {
    try {
      const conflict = readImportConflictOptions(request.body);
      response.status(201).json(await extensionService.importZip(String(request.body?.path ?? ""), conflict));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-crx", async (request, response) => {
    try {
      const conflict = readImportConflictOptions(request.body);
      response.status(201).json(await extensionService.importCrx(String(request.body?.path ?? ""), conflict));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/upload-zip", extensionUploadBody, async (request, response) => {
    try {
      const conflict = readImportConflictHeaders(request.headers as Record<string, unknown>);
      response.status(201).json(await extensionService.importUploadedArchive(readUploadedArchive(request.body), "zip", conflict));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/upload-crx", extensionUploadBody, async (request, response) => {
    try {
      const conflict = readImportConflictHeaders(request.headers as Record<string, unknown>);
      response.status(201).json(await extensionService.importUploadedArchive(readUploadedArchive(request.body), "crx", conflict));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/install", async (request, response) => {
    try {
      response.json(await extensionService.install(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/check", async (request, response) => {
    try {
      response.json(await extensionService.check(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/extensions/:id/icon", async (request, response) => {
    try {
      const asset = await extensionService.readIconAsset(request.params.id);
      // Freshness is keyed on the entity's updatedAt by the client cache, so never store this.
      response.set("Cache-Control", "no-store");
      // A manifest without icons is an ordinary state, not a failure: 204 keeps it out of the
      // client's console while the cache still records "no icon, do not ask again".
      if (!asset) {
        response.status(204).end();
        return;
      }
      response.json(asset);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/check-update", async (request, response) => {
    try {
      response.json(await extensionService.checkUpdate(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/update", async (request, response) => {
    try {
      response.json(await extensionService.update(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/reinstall", async (request, response) => {
    try {
      response.json(await extensionService.reinstall(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/migrate-identity", async (request, response) => {
    try {
      response.json(await extensionService.migrateIdentity(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/bind-environments", async (request, response) => {
    try {
      const environmentIds = readBindEnvironmentIds(request.body?.environmentIds);
      response.json(await repository.bindExtensionToEnvironments(request.params.id, environmentIds));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/unbind-environments", async (request, response) => {
    try {
      const environmentIds = readUnbindEnvironmentIds(request.body?.environmentIds);
      const environments = await repository.unbindExtensionFromEnvironments(request.params.id, environmentIds);
      await extensionService.cleanupRuntimeBindings(
        request.params.id,
        environments.map((environment) => environment.id),
      );
      response.json(environments);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/extension-sources", async (_request, response) => {
    try {
      response.json(await repository.listExtensionSources());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extension-sources", async (request, response) => {
    try {
      response.status(201).json(await repository.createExtensionSource(request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/extension-sources/:id", async (request, response) => {
    try {
      response.json(await repository.updateExtensionSource(request.params.id, request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extension-sources/:id/refresh", async (request, response) => {
    try {
      response.json(await extensionService.refreshSource(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/extension-sources/:id", async (request, response) => {
    try {
      await repository.deleteExtensionSource(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/trash/environments", async (_request, response) => {
    try {
      response.json(await repository.listTrashEnvironments());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/trash/environments/:id/restore", async (request, response) => {
    try {
      response.json(await repository.restoreEnvironment(request.params.id));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/trash/environments/:id", async (request, response) => {
    try {
      // profileIdsHoldingRuntime, not hasActiveSession: this route deletes files, and the rule every rm
      // path follows is that a stop whose close was never confirmed still counts as holding them.
      // hasActiveSession answers the other question — "may this profile be launched" — and lets exactly
      // that session through. Refused loudly because this is the one row the user pointed at.
      if (sessionService.profileIdsHoldingRuntime().has(request.params.id)) {
        throw Object.assign(new Error("先停止运行中的会话，再永久删除环境"), { status: 409 });
      }
      await repository.permanentlyDeleteEnvironment(request.params.id);
      // Best-effort, and strictly after the rows are gone: a directory a live browser still holds must
      // not turn a delete that already committed into a failure. What survives stays reclaimable through
      // the browser-data prune action, which is the only place this route could report it anyway.
      await environmentDataService.removeEnvironmentData([request.params.id]);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/trash/environments", async (_request, response) => {
    try {
      // The ids must be read before the rows are deleted; afterwards nothing names the directories left
      // behind. `deleted` stays in the response because the trash view reports its count.
      const trashedIds = (await repository.listTrashEnvironments()).map((item) => item.environment.id);
      const cleared = await repository.clearTrashEnvironments();
      // Deliberately not the 409 the single delete raises: this is a batch the user asked to empty, and one
      // session stuck in an unconfirmed close would otherwise block reclaiming every other environment's
      // data. The rows all go; the held directories are skipped and reported, and the browser-data prune
      // reclaims them once the process is gone. Same split as `clearCache` (refuses, explicit request)
      // against `pruneToSingleBuild` (defers, side effect) in server/services/binaryService.ts.
      //
      // Read after the rows are gone rather than before, so it is the freshest answer available at the
      // moment of the rm. A trashed environment cannot be launched, so waiting can only drop an id from
      // this set, never add one.
      const cleanup = await environmentDataService.removeEnvironmentData(trashedIds, sessionService.profileIdsHoldingRuntime());
      response.json({ ...cleared, dataRemoved: cleanup.removed.length, warnings: cleanup.warnings });
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/system/diagnostics", async (request, response) => {
    try {
      // A proxy id, never a proxy URL: the id is not a secret and is safe in a query string, while the
      // credentials stay server-side. Absent means "do not resolve", which keeps this route free of
      // network calls exactly as before.
      const proxyId = typeof request.query.proxyId === "string" ? request.query.proxyId.trim() : "";
      response.json(await systemDiagnostics(proxyId ? await proxyUrlForEntity(proxyId) : undefined));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/profiles", async (request, response) => {
    try {
      const profile = await repository.createProfile(normalizeProfile(defaultProfile(request.body ?? {})));
      response.status(201).json(profile);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.put("/api/profiles/:id", async (request, response) => {
    try {
      const updated = await repository.updateProfile(request.params.id, request.body ?? {});
      response.json(updated);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/profiles/:id/duplicate", async (request, response) => {
    try {
      const copy = await repository.duplicateProfile(request.params.id);
      response.status(201).json(copy);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/profiles/:id", async (request, response) => {
    try {
      if (sessionService.hasActiveSession(request.params.id)) {
        throw Object.assign(new Error("先停止运行中的会话，再删除配置"), { status: 409 });
      }
      await repository.deleteProfile(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/profiles/export", async (_request, response) => {
    try {
      response.setHeader("Content-Disposition", "attachment; filename=cbpanel-profiles.json");
      response.json(await repository.exportProfiles());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/profiles/import", async (request, response) => {
    try {
      const incoming = request.body as { profiles?: unknown[] };
      if (!Array.isArray(incoming.profiles)) {
        throw Object.assign(new Error("导入文件缺少 profiles 数组"), { status: 400 });
      }
      response.json(await repository.importProfiles(incoming.profiles));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/profiles/:id/launch", async (request, response) => {
    try {
      response.json(await launchProfileFromRequest(
        request.params.id,
        request.body,
        (profileId) => repository.getProfile(profileId),
        sessionService,
        "配置不存在",
      ));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/profiles/:id/preflight", async (request, response) => {
    try {
      const profile = await repository.getProfile(request.params.id);
      if (!profile) throw Object.assign(new Error("配置不存在"), { status: 404 });
      response.json(await sessionService.preflight(profile));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/profiles/:id/stop", async (request, response) => {
    try {
      response.json(await stopProfileFromRequest(request.params.id, request.body, sessionService));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/sessions", (_request, response) => {
    response.json(sessionService.listSessions());
  });

  app.get("/api/binary", async (_request, response) => {
    try {
      response.json(await binaryService.readPublicInfo());
    } catch (error) {
      sendError(response, error);
    }
  });

  if (RELEASE_SMOKE) {
    app.get("/api/release-smoke/dependencies", async (_request, response) => {
      try {
        response.json(await releaseSmokeDependencyHealth());
      } catch (error) {
        sendError(response, error);
      }
    });
  }

  app.post("/api/binary/install", async (_request, response) => {
    try {
      response.json(await binaryService.install());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/binary/update", async (_request, response) => {
    try {
      response.json(await binaryService.update());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/binary/clear-cache", async (_request, response) => {
    try {
      response.json(await binaryService.clearCache());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/browser-core", async (_request, response) => {
    try {
      response.json((await binaryService.readPublicInfo()).core);
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/browser-core/check-update", async (_request, response) => {
    try {
      response.json(await binaryService.checkUpdate());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/browser-core/operation/cancel", (_request, response) => {
    // Synchronous: the abort is signalled here, and the operation's own request finishes rejecting on its
    // own. Waiting for that would make cancelling as slow as the thing being cancelled.
    response.json(binaryService.cancelOperation());
  });

  app.post("/api/browser-core/import/analyze", async (request, response) => {
    try {
      response.json(await binaryService.analyzeImportZip(String(request.body?.path ?? ""), {
        targetTier: request.body?.targetTier === "pro" ? "pro" : request.body?.targetTier === "free" ? "free" : undefined,
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/browser-core/import/install", async (request, response) => {
    try {
      response.json(await binaryService.installImportZip(String(request.body?.path ?? ""), {
        targetTier: request.body?.targetTier === "pro" ? "pro" : request.body?.targetTier === "free" ? "free" : undefined,
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/proxy/check", async (request, response) => {
    try {
      response.json(await proxyService.check(request.body?.proxy, {
        traceSettings: (await repository.getSettings()).networkTrace,
        source: "proxy-check",
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  // The panel's `cloakbrowser info --proxy <url>`: the exit IP plus the timezone and locale a
  // `geoip: true` launch would inject, read from the browser core's own GeoLite2 cache rather than from
  // the trace provider's opinion about the IP. Credentials travel in the body, never a query string, and
  // the result is not persisted — it answers a question about a draft, it is not the proxy's status.
  app.post("/api/proxy/geoip", async (request, response) => {
    try {
      response.json(await proxyService.resolveLaunchGeo(request.body?.proxy, {
        traceSettings: (await repository.getSettings()).networkTrace,
        geoipDbPath: await binaryService.resolveGeoipDbPath(),
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/network/github-mirrors/check", async (request, response) => {
    try {
      const [settings, binaryInfo] = await Promise.all([
        repository.getSettings(),
        binaryService.readInfo(),
      ]);
      response.json(await githubMirrorProbeService.check(settings, binaryInfo.version, {
        providerId: request.body?.providerId,
        customGithubMirrorPrefix: request.body?.customGithubMirrorPrefix,
      }));
    } catch (error) {
      sendError(response, error);
    }
  });

  if (API_ONLY) {
    let advancedFrontend: express.RequestHandler | undefined;
    app.use(async (request, response, next) => {
      if (request.path.startsWith("/api")) {
        next();
        return;
      }
      try {
        if (!(await allowAdvancedWebEntryPage(request))) {
          next();
          return;
        }
        advancedFrontend ??= await createFrontendMiddleware();
        advancedFrontend(request, response, next);
      } catch (error) {
        sendError(response, error);
      }
    });
    app.get("/", (_request, response) => {
      response.json({
        ok: true,
        shell: SHELL_MODE,
        apiOnly: true,
      });
    });
  } else {
    app.use(await createFrontendMiddleware());
  }

  // Express recognizes error middleware by arity; without it body parser rejections (oversized
  // uploads above all) reach the default handler and answer an HTML page instead of API JSON.
  app.use((error: unknown, _request: express.Request, response: express.Response, next: express.NextFunction) => {
    if (response.headersSent) {
      next(error);
      return;
    }
    const tooLargeMessage = payloadTooLargeMessage(error);
    if (tooLargeMessage) {
      sendError(response, Object.assign(new Error(tooLargeMessage), { status: 413 }));
      return;
    }
    sendError(response, error);
  });

  return app;
}

async function createFrontendMiddleware(): Promise<express.RequestHandler> {
  if (process.env.NODE_ENV === "production" || PACKAGED_RUNTIME) {
    const distDir = await resolveFrontendDistDir();
    if (!distDir) {
      return (_request, response) => {
        response.status(503).json({
          ok: false,
          shell: SHELL_MODE,
          apiOnly: API_ONLY,
          error: "Frontend assets are not available. Run npm run build before packaging CBPanel.",
        });
      };
    }
    const staticMiddleware = express.static(distDir);
    return (request, response, next) => {
      staticMiddleware(request, response, (error) => {
        if (error) {
          next(error);
          return;
        }
        if (request.method !== "GET" && request.method !== "HEAD") {
          next();
          return;
        }
        response.sendFile(path.join(distDir, "index.html"));
      });
    };
  }

  const viteModule = "vite";
  const { createServer: createViteServer } = await import(viteModule);
  const vite = await createViteServer({
    server: {
      middlewareMode: true,
      watch: {
        ignored: isRuntimeDataPath,
      },
    },
    appType: "spa",
    root: ROOT_DIR,
  });
  return vite.middlewares;
}

async function resolveFrontendDistDir(): Promise<string | undefined> {
  const candidates = uniquePaths([
    path.join(ROOT_DIR, "dist"),
    path.join(ROOT_DIR, "..", "dist"),
    path.join(path.dirname(__filename), "..", "..", "dist"),
    path.join(process.cwd(), "dist"),
  ]);
  for (const candidate of candidates) {
    try {
      await fs.access(path.join(candidate, "index.html"));
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return undefined;
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((item) => path.normalize(item)))];
}

let server: http.Server;
let shutdownPromise: Promise<void> | undefined;

async function main(): Promise<void> {
  const app = await createApp();
  server = http.createServer(app);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`CBPanel running at http://127.0.0.1:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
  });
}

async function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    await sessionService.stopAll();
    repository.close();
    server?.close();
  })();
  return shutdownPromise;
}

process.on("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
process.on("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
