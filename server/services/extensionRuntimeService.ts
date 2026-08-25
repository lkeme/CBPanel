import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionEntity } from "../../src/shared/entities";
import { pathExists } from "./archiveUtils";

export const EXTENSION_LIFECYCLE_INJECTOR_VERSION = 1;
export const EXTENSION_LIFECYCLE_NAMESPACE = "__cbpanel_lifecycle__";

type RuntimeManifest = {
  key?: unknown;
  version?: unknown;
  manifest_version?: unknown;
  background?: {
    service_worker?: unknown;
    type?: unknown;
    scripts?: unknown;
    page?: unknown;
  };
  [key: string]: unknown;
};

type InitialBehavior = "install" | "preserve";

export type ExtensionRuntimeMaterializeInput = {
  environmentId: string;
  extension: ExtensionEntity;
  lifecycleRevision?: string;
};

export type ExtensionRuntimeMaterializeResult = {
  path: string;
  protected: boolean;
  warning?: string;
};

type ExtensionRuntimeServiceOptions = {
  runtimeDir: string;
  browserDataDir: string;
};

type RuntimeConfig = {
  schemaVersion: 1;
  version: string;
  packageRevision: string;
  bindingRevision: string;
  initialBehavior: InitialBehavior;
};

const CONFIG_FILE = "config.js";
const BOOTSTRAP_FILE = "bootstrap.js";
const SIGNATURE_FILE = "materialization.json";
const CLASSIC_ORIGINAL_WORKER_FILE = "__cbpanel_lifecycle_original__.js";

/**
 * Creates disposable per-environment extension copies. Only these copies are adapted; the canonical
 * cache and reference-mode source directories are read-only inputs.
 */
export class ExtensionRuntimeService {
  constructor(private readonly options: ExtensionRuntimeServiceOptions) {}

  async materialize(input: ExtensionRuntimeMaterializeInput): Promise<ExtensionRuntimeMaterializeResult> {
    const sourcePath = path.resolve(input.extension.localPath ?? "");
    if (!input.extension.localPath) throw new Error(`Extension ${input.extension.name} has no local path`);
    assertPathHasNoComma(sourcePath);
    const manifest = await readRuntimeManifest(sourcePath);
    const manifestKey = typeof manifest.key === "string" && manifest.key.trim() ? manifest.key.trim() : undefined;
    if (input.extension.directoryMode === "reference") {
      if (!input.extension.manifestKey || !manifestKey || manifestKey !== input.extension.manifestKey) {
        return {
          path: sourcePath,
          protected: false,
          warning: "引用模式扩展缺少稳定 manifest.key，无法启用启动生命周期保护；请重新以复制模式导入。",
        };
      }
    }
    const background = await classifyBackground(manifest, sourcePath);
    if (!background) return { path: sourcePath, protected: false };
    await assertLifecycleSourceIsSafe(sourcePath, background);
    if (input.extension.directoryMode !== "reference" && (!input.extension.manifestKey || manifestKey !== input.extension.manifestKey)) {
      throw Object.assign(new Error(`Extension ${input.extension.name} does not have a stable manifest.key`), {
        status: 409,
        code: "EXTENSION_LIFECYCLE_IDENTITY_UNSTABLE",
      });
    }

    const initialBehavior = input.lifecycleRevision
      ? "install"
      : await this.legacyInitialBehavior(input.environmentId);
    const config: RuntimeConfig = {
      schemaVersion: 1,
      version: input.extension.version,
      packageRevision: input.extension.lastInstalledAt ?? input.extension.manifestSha256 ?? input.extension.version,
      bindingRevision: input.lifecycleRevision ?? "legacy",
      initialBehavior,
    };
    const sourceRevision = input.extension.directoryMode === "reference"
      ? await fingerprintDirectory(sourcePath)
      : input.extension.manifestSha256 ?? input.extension.lastInstalledAt ?? input.extension.version;
    const signature = materializationSignature(manifest, config, background, sourceRevision);
    const outputDir = this.resolveRuntimePath(input.environmentId, input.extension.id);
    assertPathHasNoComma(outputDir);
    if (await hasMaterializationSignature(outputDir, signature)) {
      return { path: outputDir, protected: true };
    }

    await this.publishRuntimeCopy(sourcePath, outputDir, manifest, config, background, signature);
    return { path: outputDir, protected: true };
  }

  async removeEnvironment(environmentId: string): Promise<boolean> {
    const directory = this.resolveEnvironmentPath(environmentId);
    if (!(await pathExists(directory))) return false;
    await fs.rm(directory, { recursive: true, force: true });
    return true;
  }

  async removeExtension(
    extensionId: string,
    environmentIds?: Iterable<string>,
    excludedEnvironmentIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    assertDirectChildName(extensionId, "extension id");
    const requested = environmentIds ? new Set(environmentIds) : undefined;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.options.runtimeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        !entry.isDirectory()
        || excludedEnvironmentIds.has(entry.name)
        || (requested && !requested.has(entry.name))
      ) continue;
      assertDirectChildName(entry.name, "environment id");
      await fs.rm(path.join(this.options.runtimeDir, entry.name, extensionId), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async sweepArtifacts(): Promise<void> {
    let environments: import("node:fs").Dirent[];
    try {
      environments = await fs.readdir(this.options.runtimeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const environment of environments) {
      if (!environment.isDirectory()) continue;
      const environmentDir = path.join(this.options.runtimeDir, environment.name);
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(environmentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || !isSwapArtifact(entry.name)) continue;
        await fs.rm(path.join(environmentDir, entry.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  async sweepBindings(
    bindingsByEnvironment: ReadonlyMap<string, ReadonlySet<string>>,
    holdingRuntime: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    let environments: import("node:fs").Dirent[];
    try {
      environments = await fs.readdir(this.options.runtimeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const environment of environments) {
      if (!environment.isDirectory() || holdingRuntime.has(environment.name)) continue;
      const allowed = bindingsByEnvironment.get(environment.name);
      if (!allowed) {
        await fs.rm(path.join(this.options.runtimeDir, environment.name), { recursive: true, force: true }).catch(() => undefined);
        continue;
      }
      const environmentDir = path.join(this.options.runtimeDir, environment.name);
      let extensions: import("node:fs").Dirent[];
      try {
        extensions = await fs.readdir(environmentDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const extension of extensions) {
        if (!extension.isDirectory() || isSwapArtifact(extension.name) || allowed.has(extension.name)) continue;
        await fs.rm(path.join(environmentDir, extension.name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }

  private async legacyInitialBehavior(environmentId: string): Promise<InitialBehavior> {
    const userDataDir = path.join(this.options.browserDataDir, assertDirectChildName(environmentId, "environment id"));
    const evidence = [
      path.join(userDataDir, "Local State"),
      path.join(userDataDir, "Default", "Preferences"),
    ];
    for (const candidate of evidence) {
      if (await pathExists(candidate)) return "preserve";
    }
    return "install";
  }

  private resolveEnvironmentPath(environmentId: string): string {
    return path.join(this.options.runtimeDir, assertDirectChildName(environmentId, "environment id"));
  }

  private resolveRuntimePath(environmentId: string, extensionId: string): string {
    return path.join(
      this.resolveEnvironmentPath(environmentId),
      assertDirectChildName(extensionId, "extension id"),
    );
  }

  private async publishRuntimeCopy(
    sourcePath: string,
    outputDir: string,
    manifest: RuntimeManifest,
    config: RuntimeConfig,
    background: BackgroundAdapter,
    signature: string,
  ): Promise<void> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempDir = `${outputDir}.tmp-${suffix}`;
    const asideDir = `${outputDir}.old-${suffix}`;
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    await fs.rm(tempDir, { recursive: true, force: true });
    let movedAside = false;
    try {
      await fs.cp(sourcePath, tempDir, { recursive: true });
      await injectLifecycleAdapter(tempDir, manifest, config, background, signature);
      movedAside = await renameIfExists(outputDir, asideDir);
      await fs.rename(tempDir, outputDir);
      await fs.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      if (movedAside) await fs.rename(asideDir, outputDir).catch(() => undefined);
      throw error;
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

type BackgroundAdapter =
  | { kind: "mv3-classic"; original: string; preservedOriginal: string }
  | { kind: "mv3-module"; original: string }
  | { kind: "mv2-scripts"; scripts: string[] }
  | { kind: "mv2-page"; page: string };

async function classifyBackground(manifest: RuntimeManifest, sourcePath: string): Promise<BackgroundAdapter | undefined> {
  const background = manifest.background;
  if (!background || typeof background !== "object") return undefined;
  const manifestVersion = Number(manifest.manifest_version);
  if (manifestVersion === 3 && typeof background.service_worker === "string" && background.service_worker.trim()) {
    const original = normalizeManifestPath(background.service_worker, "background.service_worker");
    await assertManifestFileExists(sourcePath, original);
    if (background.type === "module") return { kind: "mv3-module", original };
    return {
      kind: "mv3-classic",
      original,
      preservedOriginal: path.posix.join(path.posix.dirname(original), CLASSIC_ORIGINAL_WORKER_FILE),
    };
  }
  if (manifestVersion === 2 && typeof background.page === "string" && background.page.trim()) {
    const page = normalizeManifestPath(background.page, "background.page");
    await assertManifestFileExists(sourcePath, page);
    return { kind: "mv2-page", page };
  }
  if (manifestVersion === 2 && Array.isArray(background.scripts)) {
    const scripts = background.scripts.map((value) => {
      if (typeof value !== "string") throw new Error("background.scripts must contain only paths");
      return normalizeManifestPath(value, "background.scripts");
    });
    await Promise.all(scripts.map((script) => assertManifestFileExists(sourcePath, script)));
    if (scripts.length > 0) return { kind: "mv2-scripts", scripts };
  }
  return undefined;
}

async function assertManifestFileExists(root: string, relativePath: string): Promise<void> {
  const candidate = path.join(root, ...relativePath.split("/"));
  try {
    const stat = await fs.stat(candidate);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    throw new Error(`Extension background entry does not exist: ${relativePath}`);
  }
}

async function injectLifecycleAdapter(
  runtimePath: string,
  manifest: RuntimeManifest,
  config: RuntimeConfig,
  background: BackgroundAdapter,
  signature: string,
): Promise<void> {
  const namespaceDir = path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE);
  if (await pathExists(namespaceDir)) {
    throw Object.assign(new Error(`Extension uses reserved path ${EXTENSION_LIFECYCLE_NAMESPACE}`), {
      status: 409,
      code: "EXTENSION_LIFECYCLE_RESERVED_PATH",
    });
  }
  await fs.mkdir(namespaceDir, { recursive: false });
  await fs.writeFile(
    path.join(namespaceDir, CONFIG_FILE),
    `globalThis.__CBPANEL_LIFECYCLE_CONFIG__ = ${JSON.stringify(config)};\n`,
    "utf8",
  );
  await fs.writeFile(path.join(namespaceDir, BOOTSTRAP_FILE), LIFECYCLE_BOOTSTRAP, "utf8");

  const nextManifest = structuredClone(manifest);
  const nextBackground = { ...(nextManifest.background ?? {}) };
  nextManifest.background = nextBackground;
  if (background.kind === "mv3-classic") {
    const wrapperPath = path.join(runtimePath, ...background.original.split("/"));
    const preservedOriginalPath = path.join(runtimePath, ...background.preservedOriginal.split("/"));
    if (await pathExists(preservedOriginalPath)) {
      throw new Error(`Extension uses reserved worker path: ${background.preservedOriginal}`);
    }
    await fs.rename(wrapperPath, preservedOriginalPath);
    await fs.writeFile(
      wrapperPath,
      `importScripts(chrome.runtime.getURL(${JSON.stringify(`${EXTENSION_LIFECYCLE_NAMESPACE}/${CONFIG_FILE}`)}), chrome.runtime.getURL(${JSON.stringify(`${EXTENSION_LIFECYCLE_NAMESPACE}/${BOOTSTRAP_FILE}`)}), chrome.runtime.getURL(${JSON.stringify(background.preservedOriginal)}));\n`,
      "utf8",
    );
  } else if (background.kind === "mv3-module") {
    const originalPath = path.join(runtimePath, ...background.original.split("/"));
    const originalSource = await fs.readFile(originalPath, "utf8");
    const originalDirectory = path.posix.dirname(background.original);
    const configSpecifier = relativeModuleSpecifier(originalDirectory, `${EXTENSION_LIFECYCLE_NAMESPACE}/${CONFIG_FILE}`);
    const bootstrapSpecifier = relativeModuleSpecifier(originalDirectory, `${EXTENSION_LIFECYCLE_NAMESPACE}/${BOOTSTRAP_FILE}`);
    await fs.writeFile(
      originalPath,
      `import ${JSON.stringify(configSpecifier)};\nimport ${JSON.stringify(bootstrapSpecifier)};\n${originalSource}`,
      "utf8",
    );
  } else if (background.kind === "mv2-scripts") {
    nextBackground.scripts = [
      `${EXTENSION_LIFECYCLE_NAMESPACE}/${CONFIG_FILE}`,
      `${EXTENSION_LIFECYCLE_NAMESPACE}/${BOOTSTRAP_FILE}`,
      ...background.scripts,
    ];
  } else {
    const pagePath = path.join(runtimePath, ...background.page.split("/"));
    const pageHtml = await fs.readFile(pagePath, "utf8");
    const pageDir = path.posix.dirname(background.page);
    const configSrc = relativeHtmlPath(pageDir, `${EXTENSION_LIFECYCLE_NAMESPACE}/${CONFIG_FILE}`);
    const bootstrapSrc = relativeHtmlPath(pageDir, `${EXTENSION_LIFECYCLE_NAMESPACE}/${BOOTSTRAP_FILE}`);
    const injection = `<script src="${escapeHtmlAttribute(configSrc)}"></script><script src="${escapeHtmlAttribute(bootstrapSrc)}"></script>`;
    await fs.writeFile(pagePath, injectBeforeFirstScript(pageHtml, injection), "utf8");
  }

  await fs.writeFile(path.join(runtimePath, "manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
  await fs.writeFile(
    path.join(namespaceDir, SIGNATURE_FILE),
    `${JSON.stringify({ injectorVersion: EXTENSION_LIFECYCLE_INJECTOR_VERSION, signature }, null, 2)}\n`,
    "utf8",
  );
}

function materializationSignature(
  manifest: RuntimeManifest,
  config: RuntimeConfig,
  background: BackgroundAdapter,
  sourceRevision: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify({ injectorVersion: EXTENSION_LIFECYCLE_INJECTOR_VERSION, manifest, config, background, sourceRevision }))
    .digest("hex");
}

async function fingerprintDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`l\0${relative}\0${await fs.readlink(absolute)}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await fs.readFile(absolute));
        hash.update("\0");
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

async function hasMaterializationSignature(outputDir: string, signature: string): Promise<boolean> {
  try {
    const parsed = JSON.parse(
      await fs.readFile(path.join(outputDir, EXTENSION_LIFECYCLE_NAMESPACE, SIGNATURE_FILE), "utf8"),
    ) as { injectorVersion?: unknown; signature?: unknown };
    return parsed.injectorVersion === EXTENSION_LIFECYCLE_INJECTOR_VERSION && parsed.signature === signature;
  } catch {
    return false;
  }
}

async function readRuntimeManifest(directory: string): Promise<RuntimeManifest> {
  const raw = (await fs.readFile(path.join(directory, "manifest.json"), "utf8")).replace(/^\uFEFF/, "");
  const manifest = JSON.parse(raw) as RuntimeManifest;
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("Invalid extension manifest");
  return manifest;
}

function normalizeManifestPath(value: string, field: string): string {
  const clean = value.trim().replaceAll("\\", "/");
  if (clean.startsWith("/") || /^[a-z]:/i.test(clean) || path.win32.isAbsolute(value.trim())) {
    throw new Error(`${field} must be relative to the extension directory`);
  }
  const normalized = path.posix.normalize(clean);
  if (!clean || normalized === "." || normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`${field} escapes the extension directory`);
  }
  return normalized;
}

async function assertLifecycleSourceIsSafe(root: string, background: BackgroundAdapter): Promise<void> {
  await assertPathContainsNoSymbolicLink(root, "manifest.json", "manifest.json");
  if (background.kind === "mv3-classic" || background.kind === "mv3-module") {
    await assertPathContainsNoSymbolicLink(root, background.original, "background service worker");
  } else if (background.kind === "mv2-page") {
    await assertPathContainsNoSymbolicLink(root, background.page, "background page");
  }
}

async function assertPathContainsNoSymbolicLink(root: string, relativePath: string, label: string): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink()) throw unsafeSymbolicLink(label);
  let candidate = root;
  for (const segment of relativePath.split("/")) {
    candidate = path.join(candidate, segment);
    if ((await fs.lstat(candidate)).isSymbolicLink()) throw unsafeSymbolicLink(label);
  }
}

function unsafeSymbolicLink(label: string): Error {
  return Object.assign(new Error(`Extension ${label} cannot contain a symbolic link`), {
    status: 409,
    code: "EXTENSION_LIFECYCLE_SYMBOLIC_LINK",
  });
}

function relativeHtmlPath(fromDirectory: string, target: string): string {
  const relative = path.posix.relative(fromDirectory === "." ? "" : fromDirectory, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function relativeModuleSpecifier(fromDirectory: string, target: string): string {
  const relative = path.posix.relative(fromDirectory === "." ? "" : fromDirectory, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function injectBeforeFirstScript(html: string, injection: string): string {
  const scriptIndex = findFirstScriptTag(html);
  if (scriptIndex !== undefined) return `${html.slice(0, scriptIndex)}${injection}${html.slice(scriptIndex)}`;
  const headEnd = /<\/head\s*>/i.exec(html);
  if (headEnd?.index !== undefined) return `${html.slice(0, headEnd.index)}${injection}${html.slice(headEnd.index)}`;
  return `${injection}${html}`;
}

function findFirstScriptTag(html: string): number | undefined {
  const lower = html.toLowerCase();
  const rawTextElements = new Set(["style", "textarea", "title", "xmp", "template", "noscript"]);
  let cursor = 0;
  while (cursor < html.length) {
    const open = html.indexOf("<", cursor);
    if (open < 0) return undefined;
    if (html.startsWith("<!--", open)) {
      const close = html.indexOf("-->", open + 4);
      if (close < 0) return undefined;
      cursor = close + 3;
      continue;
    }
    if (html.startsWith("<![CDATA[", open)) {
      const close = html.indexOf("]]>", open + 9);
      if (close < 0) return undefined;
      cursor = close + 3;
      continue;
    }
    const tagEnd = findHtmlTagEnd(html, open + 1);
    if (tagEnd === undefined) return undefined;
    const tag = /^\/?\s*([a-z][a-z0-9:-]*)(?=[\s/>])/i.exec(html.slice(open + 1, tagEnd));
    if (!tag) {
      cursor = tagEnd + 1;
      continue;
    }
    const closing = /^\//.test(html.slice(open + 1).trimStart());
    const name = tag[1]!.toLowerCase();
    if (!closing && name === "script") return open;
    if (!closing && rawTextElements.has(name)) {
      const closingStart = lower.indexOf(`</${name}`, tagEnd + 1);
      if (closingStart < 0) return undefined;
      const closingEnd = findHtmlTagEnd(html, closingStart + 2 + name.length);
      if (closingEnd === undefined) return undefined;
      cursor = closingEnd + 1;
      continue;
    }
    cursor = tagEnd + 1;
  }
  return undefined;
}

function findHtmlTagEnd(html: string, start: number): number | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = start; index < html.length; index += 1) {
    const character = html[index];
    if (quote) {
      if (character === quote) quote = undefined;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === ">") return index;
  }
  return undefined;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function assertDirectChildName(value: string, label: string): string {
  const clean = value.trim();
  if (!clean || clean === "." || clean === ".." || clean !== path.basename(clean) || clean.includes(",")) {
    throw Object.assign(new Error(`Invalid ${label}: ${value}`), { status: 400 });
  }
  return clean;
}

function assertPathHasNoComma(value: string): void {
  if (value.includes(",")) {
    throw Object.assign(new Error(`Extension path cannot contain a comma: ${value}`), { status: 400 });
  }
}

async function renameIfExists(source: string, destination: string): Promise<boolean> {
  try {
    await fs.rename(source, destination);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function isSwapArtifact(name: string): boolean {
  return name.includes(".tmp-") || name.includes(".old-");
}

const LIFECYCLE_BOOTSTRAP = `(() => {
  "use strict";
  const config = globalThis.__CBPANEL_LIFECYCLE_CONFIG__;
  if (!config || config.schemaVersion !== 1 || !globalThis.chrome?.runtime) return;
  const installedEvent = chrome.runtime.onInstalled;
  const startupEvent = chrome.runtime.onStartup;
  if (!installedEvent || !startupEvent) return;

  const installedListeners = new Set();
  const startupListeners = new Set();
  const nativeInstalledAdd = installedEvent.addListener.bind(installedEvent);
  const nativeStartupAdd = startupEvent.addListener.bind(startupEvent);
  let startupDispatched = false;
  let statePromise;
  let queue = Promise.resolve();

  function patchEvent(event, listeners) {
    const methods = {
      addListener(listener) { if (typeof listener === "function") listeners.add(listener); },
      removeListener(listener) { listeners.delete(listener); },
      hasListener(listener) { return listeners.has(listener); },
      hasListeners() { return listeners.size > 0; },
    };
    const originals = new Map();
    const applied = [];
    try {
      for (const [name, method] of Object.entries(methods)) {
        originals.set(name, Object.getOwnPropertyDescriptor(event, name));
        Object.defineProperty(event, name, { configurable: true, value: method });
        applied.push(name);
      }
    } catch (error) {
      for (const name of applied.reverse()) {
        const descriptor = originals.get(name);
        if (descriptor) Object.defineProperty(event, name, descriptor);
        else delete event[name];
      }
      throw error;
    }
    return () => {
      for (const name of [...applied].reverse()) {
        const descriptor = originals.get(name);
        if (descriptor) Object.defineProperty(event, name, descriptor);
        else delete event[name];
      }
    };
  }

  let rollbackInstalled;
  try {
    rollbackInstalled = patchEvent(installedEvent, installedListeners);
    patchEvent(startupEvent, startupListeners);
  } catch (error) {
    if (rollbackInstalled) rollbackInstalled();
    throw new Error("CBPanel lifecycle protection could not patch runtime events", { cause: error });
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open("__cbpanel_extension_lifecycle_v1", 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("lifecycle")) request.result.createObjectStore("lifecycle");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB open failed"));
    });
  }

  async function readState() {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction("lifecycle", "readonly");
        const request = transaction.objectStore("lifecycle").get("state");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("IndexedDB read failed"));
      });
    } finally {
      database.close();
    }
  }

  async function writeState(state) {
    const database = await openDatabase();
    try {
      await new Promise((resolve, reject) => {
        const transaction = database.transaction("lifecycle", "readwrite");
        transaction.objectStore("lifecycle").put(state, "state");
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error || new Error("IndexedDB write failed"));
        transaction.onabort = () => reject(transaction.error || new Error("IndexedDB write aborted"));
      });
    } finally {
      database.close();
    }
  }

  function currentState() {
    return {
      schemaVersion: 1,
      version: config.version,
      packageRevision: config.packageRevision,
      bindingRevision: config.bindingRevision,
    };
  }

  async function loadState() {
    if (!statePromise) {
      statePromise = readState().catch((error) => {
        console.error("CBPanel lifecycle protection could not read state", error);
        return undefined;
      });
    }
    return statePromise;
  }

  async function persistCurrentState() {
    const next = currentState();
    try {
      await writeState(next);
      statePromise = Promise.resolve(next);
      return true;
    } catch (error) {
      console.error("CBPanel lifecycle protection could not write state", error);
      statePromise = undefined;
      return false;
    }
  }

  function emit(listeners, value, hasValue) {
    for (const listener of [...listeners]) {
      try {
        if (hasValue) listener(value);
        else listener();
      } catch (error) {
        console.error("Extension lifecycle listener failed", error);
      }
    }
  }

  function emitStartup() {
    if (startupDispatched) return;
    startupDispatched = true;
    emit(startupListeners, undefined, false);
  }

  function emitInstalled(details) {
    // A real install/update launch delivers onInstalled, not onStartup as well. Chromium may still
    // raise both native events for a command-line extension, so the same latch suppresses the latter.
    startupDispatched = true;
    emit(installedListeners, details, true);
  }

  async function handleInstalled(details) {
    const previous = await loadState();
    if (!previous || previous.schemaVersion !== 1) {
      const persisted = await persistCurrentState();
      if (config.initialBehavior === "preserve") emitStartup();
      else if (persisted) emitInstalled(details);
      else console.error("CBPanel lifecycle protection suppressed install because its state could not be persisted");
      return;
    }
    const versionChanged = previous.version !== config.version;
    const packageChanged = previous.packageRevision !== config.packageRevision;
    const bindingChanged = previous.bindingRevision !== config.bindingRevision;
    const legacyAdoption = config.initialBehavior === "preserve"
      && config.bindingRevision === "legacy"
      && previous.bindingRevision !== "legacy";
    if (legacyAdoption) {
      await persistCurrentState();
      emitStartup();
      return;
    }
    if (versionChanged || packageChanged || bindingChanged) {
      if (await persistCurrentState()) {
        emitInstalled({
          ...details,
          reason: "update",
          previousVersion: previous.version || config.version,
        });
      } else {
        console.error("CBPanel lifecycle protection suppressed update because its state could not be persisted");
      }
      return;
    }
    emitStartup();
  }

  async function handleStartup() {
    const previous = await loadState();
    if (!previous || previous.schemaVersion !== 1) {
      if (config.initialBehavior === "preserve") {
        await persistCurrentState();
        emitStartup();
      }
      return;
    }
    if (
      config.initialBehavior === "preserve"
      && config.bindingRevision === "legacy"
      && previous.bindingRevision !== "legacy"
    ) {
      await persistCurrentState();
      emitStartup();
      return;
    }
    if (
      previous.version !== config.version
      || previous.packageRevision !== config.packageRevision
      || (
        previous.bindingRevision !== config.bindingRevision
        && !(config.initialBehavior === "preserve" && config.bindingRevision === "legacy")
      )
    ) return;
    if (previous.bindingRevision !== config.bindingRevision) await persistCurrentState();
    emitStartup();
  }

  function enqueue(task) {
    queue = queue.then(task, task).catch((error) => {
      console.error("CBPanel lifecycle protection failed", error);
    });
  }

  nativeInstalledAdd((details) => enqueue(() => handleInstalled(details)));
  nativeStartupAdd(() => enqueue(handleStartup));
})();
`;
