import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionEntity } from "../../src/shared/entities";
import { pathExists } from "./archiveUtils";

export const EXTENSION_LIFECYCLE_INJECTOR_VERSION = 2;
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

export type ExtensionRuntimeInitialBehavior = "install" | "preserve";

export type ExtensionRuntimeMaterializeInput = {
  environmentId: string;
  extension: ExtensionEntity;
  lifecycleRevision?: string;
  /** Overrides legacy browser-state inference for restore/import rebases. */
  initialBehavior?: ExtensionRuntimeInitialBehavior;
  /** Allows first creation but rejects replacement when a prior browser close is unconfirmed. */
  allowReplaceExisting?: boolean;
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
  initialBehavior: ExtensionRuntimeInitialBehavior;
};

const CONFIG_FILE = "config.js";
const BOOTSTRAP_FILE = "bootstrap.js";
const SIGNATURE_FILE = "materialization.json";
const CLASSIC_ORIGINAL_WORKER_FILE = "__cbpanel_lifecycle_original__.js";
const MATERIALIZATION_METADATA_PATH = `${EXTENSION_LIFECYCLE_NAMESPACE}/${SIGNATURE_FILE}`;

/**
 * Creates disposable per-environment extension copies. Only these copies are adapted; the canonical
 * cache and reference-mode source directories are read-only inputs.
 */
export class ExtensionRuntimeService {
  /** Serializes preflight/launch races for the same derived directory without blocking other pairs. */
  private readonly materializations = new Map<string, Promise<void>>();
  /** Keeps destructive environment sweeps from crossing a publish that starts immediately after a probe. */
  private readonly environmentOperations = new Map<string, Promise<void>>();

  constructor(private readonly options: ExtensionRuntimeServiceOptions) {}

  async materialize(input: ExtensionRuntimeMaterializeInput): Promise<ExtensionRuntimeMaterializeResult> {
    const outputDir = this.resolveRuntimePath(input.environmentId, input.extension.id);
    assertPathHasNoComma(outputDir);
    const previous = this.materializations.get(outputDir) ?? Promise.resolve();
    const work = previous.then(
      () => this.runEnvironmentOperation(
        path.dirname(outputDir),
        () => this.materializeOnce(input, outputDir),
      ),
      () => this.runEnvironmentOperation(
        path.dirname(outputDir),
        () => this.materializeOnce(input, outputDir),
      ),
    );
    const tail = work.then(() => undefined, () => undefined);
    this.materializations.set(outputDir, tail);
    try {
      return await work;
    } finally {
      if (this.materializations.get(outputDir) === tail) this.materializations.delete(outputDir);
    }
  }

  private async materializeOnce(
    input: ExtensionRuntimeMaterializeInput,
    outputDir: string,
  ): Promise<ExtensionRuntimeMaterializeResult> {
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

    const initialBehavior = input.initialBehavior ?? (input.lifecycleRevision
      ? "install"
      : await this.legacyInitialBehavior(input.environmentId));
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
    if (input.extension.directoryMode === "reference") {
      const verifiedManifest = await readRuntimeManifest(sourcePath);
      if (JSON.stringify(verifiedManifest) !== JSON.stringify(manifest)) throw sourceChangedDuringMaterialization();
    }
    const signature = materializationSignature(manifest, config, background, sourceRevision);
    await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
    if (await hasMaterializationSignature(outputDir, signature)) {
      // Integrity verification can take long enough for a reference-mode source to change after its
      // signature was computed. Recheck at the reuse boundary so this launch never selects runtime A
      // after the user has already changed the canonical source to B.
      if (
        input.extension.directoryMode === "reference"
        && await fingerprintDirectory(sourcePath) !== sourceRevision
      ) throw sourceChangedDuringMaterialization();
      return { path: outputDir, protected: true };
    }
    if (input.allowReplaceExisting === false && await lstatIfExists(outputDir)) throw replacementForbidden();

    await this.publishRuntimeCopy(
      sourcePath,
      outputDir,
      manifest,
      config,
      background,
      signature,
      input.extension.directoryMode === "reference" ? sourceRevision : undefined,
      input.allowReplaceExisting !== false,
    );
    return { path: outputDir, protected: true };
  }

  async removeEnvironment(environmentId: string): Promise<boolean> {
    const directory = this.resolveEnvironmentPath(environmentId);
    await assertRuntimePathIsSafe(this.options.runtimeDir, directory, "extension runtime environment");
    if (this.hasActiveMaterializationInEnvironment(directory)) return false;
    return this.runEnvironmentOperation(directory, async () => {
      if (!(await pathExists(directory))) return false;
      await assertDirectoryHasNoSymbolicLinkChildren(directory, "extension runtime output");
      await fs.rm(directory, { recursive: true, force: true });
      return true;
    });
  }

  async removeExtension(
    extensionId: string,
    environmentIds?: Iterable<string>,
    excludedEnvironmentIds: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    assertDirectChildName(extensionId, "extension id");
    const requested = environmentIds ? new Set(environmentIds) : undefined;
    await assertRuntimePathIsSafe(this.options.runtimeDir, this.options.runtimeDir, "extension runtime root");
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(this.options.runtimeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.isSymbolicLink()
        && !excludedEnvironmentIds.has(entry.name)
        && (!requested || requested.has(entry.name))
      ) throw unsafeRuntimePath("extension runtime environment");
      if (
        !entry.isDirectory()
        || excludedEnvironmentIds.has(entry.name)
        || (requested && !requested.has(entry.name))
      ) continue;
      assertDirectChildName(entry.name, "environment id");
      const outputDir = this.resolveRuntimePath(entry.name, extensionId);
      if (this.materializations.has(outputDir)) continue;
      const environmentDir = path.dirname(outputDir);
      await this.runEnvironmentOperation(environmentDir, async () => {
        await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
        await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
      });
    }
  }

  async sweepArtifacts(): Promise<void> {
    await assertRuntimePathIsSafe(this.options.runtimeDir, this.options.runtimeDir, "extension runtime root");
    let environments: import("node:fs").Dirent[];
    try {
      environments = await fs.readdir(this.options.runtimeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const environment of environments) {
      if (environment.isSymbolicLink()) throw unsafeRuntimePath("extension runtime environment");
      if (!environment.isDirectory()) continue;
      const environmentDir = path.join(this.options.runtimeDir, environment.name);
      if (this.hasActiveMaterializationInEnvironment(environmentDir)) continue;
      await this.runEnvironmentOperation(environmentDir, async () => {
        await assertRuntimePathIsSafe(this.options.runtimeDir, environmentDir, "extension runtime environment");
        let entries: import("node:fs").Dirent[];
        try {
          entries = await fs.readdir(environmentDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          if (entry.isSymbolicLink() && isSwapArtifact(entry.name)) {
            throw unsafeRuntimePath("extension runtime swap artifact");
          }
          if (!entry.isDirectory() || !isSwapArtifact(entry.name)) continue;
          const artifactPath = path.join(environmentDir, entry.name);
          await assertRuntimePathIsSafe(this.options.runtimeDir, artifactPath, "extension runtime swap artifact");
          await fs.rm(artifactPath, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    }
  }

  async sweepBindings(
    bindingsByEnvironment: ReadonlyMap<string, ReadonlySet<string>>,
    holdingRuntime: ReadonlySet<string> = new Set(),
  ): Promise<void> {
    await assertRuntimePathIsSafe(this.options.runtimeDir, this.options.runtimeDir, "extension runtime root");
    let environments: import("node:fs").Dirent[];
    try {
      environments = await fs.readdir(this.options.runtimeDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const environment of environments) {
      if (environment.isSymbolicLink() && !holdingRuntime.has(environment.name)) {
        throw unsafeRuntimePath("extension runtime environment");
      }
      if (!environment.isDirectory() || holdingRuntime.has(environment.name)) continue;
      const environmentDir = path.join(this.options.runtimeDir, environment.name);
      if (this.hasActiveMaterializationInEnvironment(environmentDir)) continue;
      await this.runEnvironmentOperation(environmentDir, async () => {
        await assertRuntimePathIsSafe(this.options.runtimeDir, environmentDir, "extension runtime environment");
        const allowed = bindingsByEnvironment.get(environment.name);
        if (!allowed) {
          await assertDirectoryHasNoSymbolicLinkChildren(environmentDir, "extension runtime output");
          await fs.rm(environmentDir, { recursive: true, force: true }).catch(() => undefined);
          return;
        }
        let extensions: import("node:fs").Dirent[];
        try {
          extensions = await fs.readdir(environmentDir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const extension of extensions) {
          if (
            extension.isSymbolicLink()
            && !isSwapArtifact(extension.name)
            && !allowed.has(extension.name)
          ) throw unsafeRuntimePath("extension runtime output");
          if (!extension.isDirectory() || isSwapArtifact(extension.name) || allowed.has(extension.name)) continue;
          const outputDir = path.join(environmentDir, extension.name);
          await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
          await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
        }
      });
    }
  }

  private async legacyInitialBehavior(environmentId: string): Promise<ExtensionRuntimeInitialBehavior> {
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

  private hasActiveMaterializationInEnvironment(environmentDir: string): boolean {
    for (const outputDir of this.materializations.keys()) {
      if (path.dirname(outputDir) === environmentDir) return true;
    }
    return false;
  }

  private async runEnvironmentOperation<T>(environmentDir: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.environmentOperations.get(environmentDir) ?? Promise.resolve();
    const work = previous.then(operation, operation);
    const tail = work.then(() => undefined, () => undefined);
    this.environmentOperations.set(environmentDir, tail);
    try {
      return await work;
    } finally {
      if (this.environmentOperations.get(environmentDir) === tail) {
        this.environmentOperations.delete(environmentDir);
      }
    }
  }

  private async publishRuntimeCopy(
    sourcePath: string,
    outputDir: string,
    manifest: RuntimeManifest,
    config: RuntimeConfig,
    background: BackgroundAdapter,
    signature: string,
    expectedSourceRevision: string | undefined,
    allowReplaceExisting: boolean,
  ): Promise<void> {
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const tempDir = `${outputDir}.tmp-${suffix}`;
    const asideDir = `${outputDir}.old-${suffix}`;
    await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
    await fs.mkdir(path.dirname(outputDir), { recursive: true });
    await assertRuntimePathIsSafe(this.options.runtimeDir, path.dirname(outputDir), "extension runtime environment");
    if (await lstatIfExists(tempDir)) throw new Error(`Extension runtime temporary path already exists: ${tempDir}`);
    if (await lstatIfExists(asideDir)) throw new Error(`Extension runtime aside path already exists: ${asideDir}`);
    let movedAside = false;
    try {
      await fs.cp(sourcePath, tempDir, { recursive: true });
      await assertTemporaryMutationPathsAreSafe(tempDir, background);
      if (expectedSourceRevision !== undefined && await fingerprintDirectory(tempDir) !== expectedSourceRevision) {
        throw sourceChangedDuringMaterialization();
      }
      await injectLifecycleAdapter(tempDir, manifest, config, background);
      const integritySha256 = await fingerprintDirectory(tempDir, MATERIALIZATION_METADATA_PATH);
      await writeMaterializationMetadata(tempDir, signature, integritySha256);
      if (expectedSourceRevision !== undefined && await fingerprintDirectory(sourcePath) !== expectedSourceRevision) {
        throw sourceChangedDuringMaterialization();
      }
      await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
      if (!allowReplaceExisting && await lstatIfExists(outputDir)) throw replacementForbidden();
      movedAside = await renameIfExists(outputDir, asideDir);
      await fs.rename(tempDir, outputDir);
      await assertRuntimePathIsSafe(this.options.runtimeDir, asideDir, "extension runtime aside");
      await fs.rm(asideDir, { recursive: true, force: true }).catch(() => undefined);
    } catch (error) {
      if (movedAside) await fs.rename(asideDir, outputDir).catch(() => undefined);
      throw error;
    } finally {
      if (await lstatIfExists(tempDir)) {
        await assertRuntimePathIsSafe(this.options.runtimeDir, tempDir, "extension runtime temporary path");
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
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
): Promise<void> {
  const namespaceDir = path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE);
  if (await lstatIfExists(namespaceDir)) {
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
    const configSrc = `/${EXTENSION_LIFECYCLE_NAMESPACE}/${CONFIG_FILE}`;
    const bootstrapSrc = `/${EXTENSION_LIFECYCLE_NAMESPACE}/${BOOTSTRAP_FILE}`;
    const injection = `<script src="${escapeHtmlAttribute(configSrc)}"></script><script src="${escapeHtmlAttribute(bootstrapSrc)}"></script>`;
    await fs.writeFile(pagePath, injectBeforeFirstScript(pageHtml, injection), "utf8");
  }

  await fs.writeFile(path.join(runtimePath, "manifest.json"), `${JSON.stringify(nextManifest, null, 2)}\n`, "utf8");
}

async function writeMaterializationMetadata(
  runtimePath: string,
  signature: string,
  integritySha256: string,
): Promise<void> {
  await fs.writeFile(
    path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE, SIGNATURE_FILE),
    `${JSON.stringify({ injectorVersion: EXTENSION_LIFECYCLE_INJECTOR_VERSION, signature, integritySha256 }, null, 2)}\n`,
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

async function fingerprintDirectory(root: string, excludedRelativePath?: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = path.posix.join(relativeDirectory, entry.name);
      if (relative === excludedRelativePath) continue;
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
      } else {
        throw new Error(`Unsupported extension entry type: ${relative}`);
      }
    }
  }
  await visit(root, "");
  return hash.digest("hex");
}

async function hasMaterializationSignature(outputDir: string, signature: string): Promise<boolean> {
  try {
    await assertRegularNonSymbolicPath(outputDir, MATERIALIZATION_METADATA_PATH, "materialization metadata");
    const parsed = JSON.parse(
      await fs.readFile(path.join(outputDir, EXTENSION_LIFECYCLE_NAMESPACE, SIGNATURE_FILE), "utf8"),
    ) as { injectorVersion?: unknown; signature?: unknown; integritySha256?: unknown };
    if (
      parsed.injectorVersion !== EXTENSION_LIFECYCLE_INJECTOR_VERSION
      || parsed.signature !== signature
      || typeof parsed.integritySha256 !== "string"
    ) return false;
    return await fingerprintDirectory(outputDir, MATERIALIZATION_METADATA_PATH) === parsed.integritySha256;
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

async function assertTemporaryMutationPathsAreSafe(root: string, background: BackgroundAdapter): Promise<void> {
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw unsafeRuntimePath("temporary runtime root");
  await assertRegularNonSymbolicPath(root, "manifest.json", "runtime manifest");
  if (background.kind === "mv3-classic" || background.kind === "mv3-module") {
    await assertRegularNonSymbolicPath(root, background.original, "runtime background service worker");
  } else if (background.kind === "mv2-page") {
    await assertRegularNonSymbolicPath(root, background.page, "runtime background page");
  }
  if (background.kind === "mv3-classic") {
    await assertNonSymbolicPathParents(root, background.preservedOriginal, "reserved runtime worker");
    if (await lstatIfExists(path.join(root, ...background.preservedOriginal.split("/")))) {
      throw new Error(`Extension uses reserved worker path: ${background.preservedOriginal}`);
    }
  }
}

async function assertRegularNonSymbolicPath(root: string, relativePath: string, label: string): Promise<void> {
  let candidate = root;
  const segments = relativePath.split("/");
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) throw unsafeRuntimePath(label);
    if (index < segments.length - 1 && !stat.isDirectory()) throw unsafeRuntimePath(label);
    if (index === segments.length - 1 && !stat.isFile()) throw unsafeRuntimePath(label);
  }
}

async function assertNonSymbolicPathParents(root: string, relativePath: string, label: string): Promise<void> {
  let candidate = root;
  const parentSegments = relativePath.split("/").slice(0, -1);
  for (const segment of parentSegments) {
    candidate = path.join(candidate, segment);
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw unsafeRuntimePath(label);
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

async function assertRuntimePathIsSafe(runtimeRoot: string, target: string, label: string): Promise<void> {
  const root = path.resolve(runtimeRoot);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(root, resolvedTarget);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw unsafeRuntimePath(label);
  }
  await assertExistingPathSegmentsAreNotSymbolicLinks(root, "extension runtime root");
  if (relative) await assertExistingPathSegmentsAreNotSymbolicLinks(resolvedTarget, label);
}

async function assertExistingPathSegmentsAreNotSymbolicLinks(target: string, label: string): Promise<void> {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let candidate = parsed.root;
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    candidate = path.join(candidate, segment);
    const stat = await lstatIfExists(candidate);
    if (!stat) break;
    if (stat.isSymbolicLink()) throw unsafeRuntimePath(label);
    if (index < segments.length - 1 && !stat.isDirectory()) throw unsafeRuntimePath(label);
  }
}

async function assertDirectoryHasNoSymbolicLinkChildren(directory: string, label: string): Promise<void> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  if (entries.some((entry) => entry.isSymbolicLink())) throw unsafeRuntimePath(label);
}

async function lstatIfExists(candidate: string): Promise<import("node:fs").Stats | undefined> {
  try {
    return await fs.lstat(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function unsafeRuntimePath(label: string): Error {
  return Object.assign(new Error(`${label} cannot traverse a symbolic link, junction, or reparse point`), {
    status: 409,
    code: "EXTENSION_RUNTIME_UNSAFE_PATH",
  });
}

function sourceChangedDuringMaterialization(): Error {
  return Object.assign(new Error("Extension source changed while its runtime copy was being materialized"), {
    status: 409,
    code: "EXTENSION_RUNTIME_SOURCE_CHANGED",
  });
}

function replacementForbidden(): Error {
  return Object.assign(new Error("Extension runtime replacement is forbidden until the previous browser close is confirmed"), {
    status: 409,
    code: "EXTENSION_RUNTIME_REPLACEMENT_FORBIDDEN",
  });
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
      statePromise = readState().then((state) => {
        if (state === undefined) return { status: "missing" };
        if (
          !state
          || state.schemaVersion !== 1
          || typeof state.version !== "string"
          || typeof state.packageRevision !== "string"
          || typeof state.bindingRevision !== "string"
        ) {
          console.error("CBPanel lifecycle protection found invalid state");
          return { status: "failed" };
        }
        return { status: "loaded", state };
      }, (error) => {
        console.error("CBPanel lifecycle protection could not read state", error);
        return { status: "failed" };
      });
    }
    return statePromise;
  }

  async function persistCurrentState() {
    const next = currentState();
    try {
      await writeState(next);
      statePromise = Promise.resolve({ status: "loaded", state: next });
      return true;
    } catch (error) {
      console.error("CBPanel lifecycle protection could not write state", error);
      statePromise = Promise.resolve({ status: "failed" });
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
    const loaded = await loadState();
    if (loaded.status === "failed") {
      console.error("CBPanel lifecycle protection suppressed install/update because its state could not be read safely");
      emitStartup();
      return;
    }
    if (details?.reason !== "install") {
      if (await persistCurrentState()) emitInstalled(details);
      else {
        console.error("CBPanel lifecycle protection suppressed native install/update because its state could not be persisted");
        emitStartup();
      }
      return;
    }
    if (loaded.status === "missing") {
      const persisted = await persistCurrentState();
      if (config.initialBehavior === "preserve") emitStartup();
      else if (persisted) emitInstalled(details);
      else console.error("CBPanel lifecycle protection suppressed install because its state could not be persisted");
      return;
    }
    const previous = loaded.state;
    const versionChanged = previous.version !== config.version;
    const packageChanged = previous.packageRevision !== config.packageRevision;
    const bindingChanged = previous.bindingRevision !== config.bindingRevision;
    const preserveRebase = config.initialBehavior === "preserve" && bindingChanged;
    if (preserveRebase) {
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
    const loaded = await loadState();
    if (loaded.status === "failed") {
      emitStartup();
      return;
    }
    if (loaded.status === "missing") {
      if (config.initialBehavior === "preserve") {
        await persistCurrentState();
        emitStartup();
      }
      return;
    }
    const previous = loaded.state;
    if (config.initialBehavior === "preserve" && previous.bindingRevision !== config.bindingRevision) {
      await persistCurrentState();
      emitStartup();
      return;
    }
    if (
      previous.version !== config.version
      || previous.packageRevision !== config.packageRevision
      || (
        previous.bindingRevision !== config.bindingRevision
        && config.initialBehavior !== "preserve"
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
