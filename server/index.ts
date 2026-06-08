import express from "express";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserProfile,
  type PanelState,
  defaultProfile,
  maskProfileSecrets,
  normalizeProfile,
} from "../src/shared/profile";
import type { NetworkCheckResult, SystemDiagnostics } from "../src/shared/entities";
import { resolveNetworkTraceProvider } from "../src/shared/settings";
import { BinaryService } from "./services/binaryService";
import { DesktopRuntimeService } from "./services/desktopRuntimeService";
import { ExtensionService } from "./services/extensionService";
import { GithubMirrorProbeService } from "./services/githubMirrorProbeService";
import { ProxyService } from "./services/proxyService";
import { SessionService } from "./services/sessionService";
import { SqlitePanelRepository } from "./storage/sqliteStore";

const __filename = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(__filename), "..");
const DATA_DIR = process.env.CBPANEL_DATA_DIR
  ? path.resolve(process.env.CBPANEL_DATA_DIR)
  : path.join(ROOT_DIR, "data");
const STORE_PATH = path.join(DATA_DIR, "profiles.json");
const BROWSER_DATA_DIR = path.join(DATA_DIR, "browser-data");
const PORT = Number(process.env.PORT ?? 4173);
const HOST = "127.0.0.1";
const SHELL_MODE = process.env.CBPANEL_SHELL === "desktop" ? "desktop" : "web";
const DESKTOP_TOKEN = process.env.CBPANEL_DESKTOP_TOKEN;
const API_ONLY = process.env.CBPANEL_API_ONLY === "1";
const PORTABLE = Boolean(process.env.CBPANEL_PORTABLE);
const DESKTOP_CORS_HEADERS = "authorization,content-type,x-cbpanel-token";
const DESKTOP_CORS_METHODS = "GET,POST,PUT,DELETE,OPTIONS";
const PACKAGED_RUNTIME = Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg);
const RELEASE_SMOKE = process.env.CBPANEL_RELEASE_SMOKE === "1";

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
});
const extensionService = new ExtensionService({
  repository,
  extensionCacheDir: path.join(DATA_DIR, "extensions"),
});
const sessionService = new SessionService({
  browserDataDir: BROWSER_DATA_DIR,
  readBinaryInfo: () => binaryService.readInfo(),
  extensionService,
  readEnvironment: (id) => repository.getEnvironment(id),
  checkNetwork: (profile) => checkProfileNetwork(profile),
  readSettings: () => repository.getSettings(),
});
const proxyService = new ProxyService();
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

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(BROWSER_DATA_DIR, { recursive: true });
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

async function systemDiagnostics(): Promise<SystemDiagnostics> {
  const [storage, extensionSources, extensions, settings] = await Promise.all([
    repository.getInfo(),
    repository.listExtensionSources(),
    repository.listExtensions(),
    repository.getSettings(),
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
    schemaVersion: 2,
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

  const authorization = request.header("authorization");
  const headerToken = request.header("x-cbpanel-token");
  const bearerToken = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : undefined;
  if (headerToken === DESKTOP_TOKEN || bearerToken === DESKTOP_TOKEN) {
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

function sendError(response: express.Response, error: unknown): void {
  const status = typeof error === "object" && error && "status" in error ? Number(error.status) : 500;
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : undefined;
  const usage = typeof error === "object" && error && "usage" in error ? error.usage : undefined;
  response.status(Number.isFinite(status) ? status : 500).json({
    error: (error as Error).message || "未知错误",
    ...(code ? { code } : {}),
    ...(usage ? { usage } : {}),
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

  app.get("/api/desktop/runtime", (_request, response) => {
    response.json(desktopRuntimeService.info());
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
      const profile = await repository.getProfile(request.params.id);
      if (!profile) throw Object.assign(new Error("环境不存在"), { status: 404 });
      response.json(await sessionService.launchProfile(profile));
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
      response.json(await sessionService.stopProfile(request.params.id));
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

  app.get("/api/proxies", async (request, response) => {
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
      const proxy = (await repository.listProxies({ includeSecrets: true })).find((item) => item.id === request.params.id);
      if (!proxy) throw Object.assign(new Error("代理不存在"), { status: 404 });
      try {
        const settings = await repository.getSettings();
        const result = await proxyService.check({
          enabled: true,
          raw: "",
          scheme: proxy.scheme,
          host: proxy.host,
          port: proxy.port,
          username: proxy.username,
          password: proxy.password,
          bypass: proxy.bypass,
        }, {
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
      const body = request.body ?? {};
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
      response.json(await repository.updateExtension(request.params.id, request.body ?? {}));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/extensions/:id", async (request, response) => {
    try {
      await repository.deleteExtension(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-directory", async (request, response) => {
    try {
      response.status(201).json(await extensionService.importDirectory(String(request.body?.path ?? "")));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-zip", async (request, response) => {
    try {
      response.status(201).json(await extensionService.importZip(String(request.body?.path ?? "")));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/import-crx", async (request, response) => {
    try {
      response.status(201).json(await extensionService.importCrx(String(request.body?.path ?? "")));
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

  app.post("/api/extensions/:id/bind-environments", async (request, response) => {
    try {
      response.json(await repository.bindExtensionToEnvironments(request.params.id, request.body?.environmentIds ?? []));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/extensions/:id/unbind-environments", async (request, response) => {
    try {
      const environmentIds = Array.isArray(request.body?.environmentIds) ? request.body.environmentIds : undefined;
      response.json(await repository.unbindExtensionFromEnvironments(request.params.id, environmentIds));
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
      await repository.permanentlyDeleteEnvironment(request.params.id);
      response.status(204).end();
    } catch (error) {
      sendError(response, error);
    }
  });

  app.delete("/api/trash/environments", async (_request, response) => {
    try {
      response.json(await repository.clearTrashEnvironments());
    } catch (error) {
      sendError(response, error);
    }
  });

  app.get("/api/system/diagnostics", async (_request, response) => {
    try {
      response.json(await systemDiagnostics());
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
      const profile = await repository.getProfile(request.params.id);
      if (!profile) throw Object.assign(new Error("配置不存在"), { status: 404 });
      response.json(await sessionService.launchProfile(profile));
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
      response.json(await sessionService.stopProfile(request.params.id));
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

  app.post("/api/browser-core/import/analyze", async (request, response) => {
    try {
      response.json(await binaryService.analyzeImportZip(String(request.body?.path ?? "")));
    } catch (error) {
      sendError(response, error);
    }
  });

  app.post("/api/browser-core/import/install", async (request, response) => {
    try {
      response.json(await binaryService.installImportZip(String(request.body?.path ?? "")));
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

async function main(): Promise<void> {
  const app = await createApp();
  server = http.createServer(app);
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`CBPanel running at http://127.0.0.1:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
  });
}

async function shutdown(): Promise<void> {
  await sessionService.stopAll();
  repository.close();
  server?.close();
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
