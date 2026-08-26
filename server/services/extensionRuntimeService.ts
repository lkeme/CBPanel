import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { ExtensionEntity } from "../../src/shared/entities";
import { pathExists } from "./archiveUtils";

export const EXTENSION_LIFECYCLE_INJECTOR_VERSION = 4;
export const EXTENSION_LIFECYCLE_NAMESPACE = "cbpanel_lifecycle";

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
  /** Adopts a missing lifecycle baseline without turning later binding changes into preserve rebases. */
  preserveMissingState?: boolean;
  /** Allows first creation but rejects replacement when a prior browser close is unconfirmed. */
  allowReplaceExisting?: boolean;
};

export type ExtensionRuntimeMaterializeResult = {
  path: string;
  protected: boolean;
  warning?: string;
  registration?: {
    browserExtensionId: string;
    workerRelativePath: string;
    runtimeRevision: string;
    signature: string;
    migrationRequired: boolean;
  };
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
  preserveMissingState: boolean;
  runtimeRevision: string;
};

type MaterializationMetadata = {
  injectorVersion: number;
  signature: string;
  integritySha256: string;
  registeredSignature?: string;
  preserveMissingState?: boolean;
};

const CONFIG_FILE = "config.js";
const BOOTSTRAP_FILE = "bootstrap.js";
const SIGNATURE_FILE = "materialization.json";
const MATERIALIZATION_METADATA_PATH = `${EXTENSION_LIFECYCLE_NAMESPACE}/${SIGNATURE_FILE}`;
const WINDOWS_CHROMIUM_FILE_PATH_LIMIT = 259;

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

  async markRegistrationReady(runtimePath: string, signature: string): Promise<void> {
    const outputDir = assertDirectRuntimeOutputPath(this.options.runtimeDir, runtimePath);
    await this.runEnvironmentOperation(path.dirname(outputDir), async () => {
      await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
      if (!(await hasMaterializationSignature(outputDir, signature))) throw staleRegistrationMetadata();
      const metadata = await readMaterializationMetadata(outputDir);
      if (!metadata || metadata.signature !== signature) throw staleRegistrationMetadata();
      if (metadata.registeredSignature === signature) return;
      await assertRegularNonSymbolicPath(outputDir, MATERIALIZATION_METADATA_PATH, "materialization metadata");
      await fs.writeFile(
        path.join(outputDir, EXTENSION_LIFECYCLE_NAMESPACE, SIGNATURE_FILE),
        `${JSON.stringify({ ...metadata, registeredSignature: signature }, null, 2)}\n`,
        "utf8",
      );
    });
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

    await assertRuntimePathIsSafe(this.options.runtimeDir, outputDir, "extension runtime output");
    const previousMetadata = await readMaterializationMetadata(outputDir);
    const initialBehavior = input.initialBehavior ?? (input.lifecycleRevision
      ? "install"
      : await this.legacyInitialBehavior(input.environmentId));
    const sourceRevision = input.extension.directoryMode === "reference"
      ? await fingerprintDirectory(sourcePath)
      : input.extension.manifestSha256 ?? input.extension.lastInstalledAt ?? input.extension.version;
    if (input.extension.directoryMode === "reference") {
      const verifiedManifest = await readRuntimeManifest(sourcePath);
      if (JSON.stringify(verifiedManifest) !== JSON.stringify(manifest)) throw sourceChangedDuringMaterialization();
    }
    const mv3Background = background.kind === "mv3-classic" || background.kind === "mv3-module"
      ? background
      : undefined;
    const browserExtensionId = mv3Background ? browserExtensionIdFromManifestKey(manifestKey!) : undefined;
    const browserEntryExists = browserExtensionId
      ? await browserProfileHasExtension(this.options.browserDataDir, input.environmentId, browserExtensionId)
      : false;
    const preserveMissingState = input.preserveMissingState ?? (
      initialBehavior === "preserve"
      || previousMetadata?.preserveMissingState === true
      || (browserEntryExists && previousMetadata?.injectorVersion !== EXTENSION_LIFECYCLE_INJECTOR_VERSION)
    );
    const packageRevision = input.extension.directoryMode === "reference"
      ? sourceRevision
      : input.extension.lastInstalledAt ?? input.extension.manifestSha256 ?? input.extension.version;
    const semanticConfig: Omit<RuntimeConfig, "runtimeRevision"> = {
      schemaVersion: 1,
      version: input.extension.version,
      packageRevision,
      bindingRevision: input.lifecycleRevision ?? "legacy",
      initialBehavior,
      preserveMissingState,
    };
    const runtimeRevision = lifecycleRuntimeRevision(manifest, background, sourceRevision, semanticConfig);
    const config: RuntimeConfig = {
      ...semanticConfig,
      runtimeRevision,
    };
    const signature = materializationSignature(manifest, config, background, sourceRevision);
    const mv3Resources = mv3Background
      ? mv3ResourcePaths(signature, mv3Background.original)
      : undefined;
    if (mv3Resources) {
      assertWindowsExtensionRuntimePathBudget(
        input.extension.name,
        outputDir,
        Object.values(mv3Resources),
      );
    }
    const workerRelativePath = mv3Resources?.wrapper;
    const registration = browserExtensionId && workerRelativePath ? {
      browserExtensionId,
      workerRelativePath,
      runtimeRevision,
      signature,
      migrationRequired: previousMetadata?.registeredSignature !== signature,
    } : undefined;
    if (await hasMaterializationSignature(outputDir, signature)) {
      // Integrity verification can take long enough for a reference-mode source to change after its
      // signature was computed. Recheck at the reuse boundary so this launch never selects runtime A
      // after the user has already changed the canonical source to B.
      if (
        input.extension.directoryMode === "reference"
        && await fingerprintDirectory(sourcePath) !== sourceRevision
      ) throw sourceChangedDuringMaterialization();
      return { path: outputDir, protected: true, registration };
    }
    if (input.allowReplaceExisting === false && await lstatIfExists(outputDir)) throw replacementForbidden();

    const registeredSignature = registration && (
      previousMetadata?.registeredSignature === signature || !browserEntryExists
        ? signature
        : previousMetadata?.registeredSignature
    );
    if (registration) registration.migrationRequired = registeredSignature !== signature;

    await this.publishRuntimeCopy(
      sourcePath,
      outputDir,
      manifest,
      config,
      background,
      signature,
      registeredSignature,
      preserveMissingState,
      input.extension.directoryMode === "reference" ? sourceRevision : undefined,
      input.allowReplaceExisting !== false,
    );
    return { path: outputDir, protected: true, registration };
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
    registeredSignature: string | undefined,
    preserveMissingState: boolean,
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
      await injectLifecycleAdapter(tempDir, manifest, config, background, signature);
      const integritySha256 = await fingerprintDirectory(tempDir, MATERIALIZATION_METADATA_PATH);
      await writeMaterializationMetadata(
        tempDir,
        signature,
        integritySha256,
        registeredSignature,
        preserveMissingState,
      );
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
  | { kind: "mv3-classic"; original: string }
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
    return { kind: "mv3-classic", original };
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
  if (await lstatIfExists(namespaceDir)) {
    throw lifecycleReservedPath(EXTENSION_LIFECYCLE_NAMESPACE);
  }
  await fs.mkdir(namespaceDir, { recursive: false });
  const mv3Resources = background.kind === "mv3-classic" || background.kind === "mv3-module"
    ? mv3ResourcePaths(signature, background.original)
    : undefined;
  const configRelativePath = mv3Resources?.config ?? `${EXTENSION_LIFECYCLE_NAMESPACE}/${CONFIG_FILE}`;
  const bootstrapRelativePath = mv3Resources?.bootstrap ?? `${EXTENSION_LIFECYCLE_NAMESPACE}/${BOOTSTRAP_FILE}`;
  await fs.writeFile(
    path.join(runtimePath, ...configRelativePath.split("/")),
    `globalThis.__CBPANEL_LIFECYCLE_CONFIG__ = ${JSON.stringify(config)};\n`,
    "utf8",
  );
  await fs.writeFile(
    path.join(runtimePath, ...bootstrapRelativePath.split("/")),
    LIFECYCLE_BOOTSTRAP,
    "utf8",
  );

  const nextManifest = structuredClone(manifest);
  const nextBackground = { ...(nextManifest.background ?? {}) };
  nextManifest.background = nextBackground;
  if (background.kind === "mv3-classic") {
    const wrapperRelativePath = mv3Resources!.wrapper;
    const wrapperPath = path.join(runtimePath, ...wrapperRelativePath.split("/"));
    if (await lstatIfExists(wrapperPath)) throw lifecycleReservedPath(wrapperRelativePath);
    await fs.writeFile(
      wrapperPath,
      `importScripts(chrome.runtime.getURL(${JSON.stringify(configRelativePath)}), chrome.runtime.getURL(${JSON.stringify(bootstrapRelativePath)}), chrome.runtime.getURL(${JSON.stringify(background.original)}));\n`,
      "utf8",
    );
    nextBackground.service_worker = wrapperRelativePath;
  } else if (background.kind === "mv3-module") {
    const wrapperRelativePath = mv3Resources!.wrapper;
    const wrapperPath = path.join(runtimePath, ...wrapperRelativePath.split("/"));
    if (await lstatIfExists(wrapperPath)) throw lifecycleReservedPath(wrapperRelativePath);
    const wrapperDirectory = path.posix.dirname(wrapperRelativePath);
    const configSpecifier = relativeModuleSpecifier(wrapperDirectory, configRelativePath);
    const bootstrapSpecifier = relativeModuleSpecifier(wrapperDirectory, bootstrapRelativePath);
    const originalSpecifier = relativeModuleSpecifier(wrapperDirectory, background.original);
    await fs.writeFile(
      wrapperPath,
      `import ${JSON.stringify(configSpecifier)};\nimport ${JSON.stringify(bootstrapSpecifier)};\nimport ${JSON.stringify(originalSpecifier)};\n`,
      "utf8",
    );
    nextBackground.service_worker = wrapperRelativePath;
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
  registeredSignature: string | undefined,
  preserveMissingState: boolean,
): Promise<void> {
  await fs.writeFile(
    path.join(runtimePath, EXTENSION_LIFECYCLE_NAMESPACE, SIGNATURE_FILE),
    `${JSON.stringify({
      injectorVersion: EXTENSION_LIFECYCLE_INJECTOR_VERSION,
      signature,
      integritySha256,
      ...(registeredSignature ? { registeredSignature } : {}),
      preserveMissingState,
    }, null, 2)}\n`,
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

function lifecycleRuntimeRevision(
  manifest: RuntimeManifest,
  background: BackgroundAdapter,
  sourceRevision: string,
  config: Omit<RuntimeConfig, "runtimeRevision">,
): string {
  return createHash("sha256")
    .update(JSON.stringify({
      injectorVersion: EXTENSION_LIFECYCLE_INJECTOR_VERSION,
      manifest,
      background,
      sourceRevision,
      config,
    }))
    .digest("hex");
}

function browserExtensionIdFromManifestKey(manifestKey: string): string {
  const idHex = createHash("sha256").update(Buffer.from(manifestKey, "base64")).digest("hex").slice(0, 32);
  return [...idHex].map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))).join("");
}

async function browserProfileHasExtension(
  browserDataDir: string,
  environmentId: string,
  browserExtensionId: string,
): Promise<boolean> {
  const securePreferences = path.join(
    browserDataDir,
    assertDirectChildName(environmentId, "environment id"),
    "Default",
    "Secure Preferences",
  );
  try {
    const parsed = JSON.parse((await fs.readFile(securePreferences, "utf8")).replace(/^\uFEFF/, "")) as {
      extensions?: { settings?: Record<string, unknown> };
    };
    return Object.hasOwn(parsed.extensions?.settings ?? {}, browserExtensionId);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    // An unreadable existing profile must not be mistaken for a fresh install. Leave registration
    // pending so Session can perform and confirm the idempotent management-toggle migration.
    return true;
  }
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
    const parsed = await readMaterializationMetadata(outputDir);
    if (!parsed) return false;
    if (
      parsed.injectorVersion !== EXTENSION_LIFECYCLE_INJECTOR_VERSION
      || parsed.signature !== signature
    ) return false;
    return await fingerprintDirectory(outputDir, MATERIALIZATION_METADATA_PATH) === parsed.integritySha256;
  } catch {
    return false;
  }
}

async function readMaterializationMetadata(outputDir: string): Promise<MaterializationMetadata | undefined> {
  try {
    await assertRegularNonSymbolicPath(outputDir, MATERIALIZATION_METADATA_PATH, "materialization metadata");
    const parsed = JSON.parse(
      await fs.readFile(path.join(outputDir, EXTENSION_LIFECYCLE_NAMESPACE, SIGNATURE_FILE), "utf8"),
    ) as Partial<MaterializationMetadata>;
    if (
      typeof parsed.injectorVersion !== "number"
      || typeof parsed.signature !== "string"
      || typeof parsed.integritySha256 !== "string"
      || (parsed.registeredSignature !== undefined && typeof parsed.registeredSignature !== "string")
      || (parsed.preserveMissingState !== undefined && typeof parsed.preserveMissingState !== "boolean")
    ) return undefined;
    return parsed as MaterializationMetadata;
  } catch {
    return undefined;
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

function staleRegistrationMetadata(): Error {
  return Object.assign(new Error("Extension runtime registration no longer matches the materialized output"), {
    status: 409,
    code: "EXTENSION_RUNTIME_REGISTRATION_STALE",
  });
}

function lifecycleReservedPath(relativePath: string): Error {
  return Object.assign(new Error(`Extension uses reserved path ${relativePath}`), {
    status: 409,
    code: "EXTENSION_LIFECYCLE_RESERVED_PATH",
  });
}

function extensionRuntimePathTooLong(
  extensionName: string,
  offendingPath: string,
  pathLength: number,
): Error {
  return Object.assign(new Error(
    `扩展 ${extensionName} 的受保护运行时文件路径过长，Chromium 无法可靠加载` +
      `（当前 ${pathLength} 个字符，上限 ${WINDOWS_CHROMIUM_FILE_PATH_LIMIT} 个字符）：${offendingPath}。` +
      "请将 CBPanel 便携目录移动到更靠近磁盘根目录的短路径（例如 C:\\CBPanel 或 E:\\CBPanel）后重试。",
  ), {
    status: 409,
    code: "EXTENSION_RUNTIME_PATH_TOO_LONG",
  });
}

/** @internal Enforces the file-path budget used by Chromium's unpacked-extension loader on Windows. */
export function assertWindowsExtensionRuntimePathBudget(
  extensionName: string,
  outputDir: string,
  generatedRelativePaths: Iterable<string>,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  const absoluteOutputDir = path.win32.resolve(outputDir);
  let offending: { path: string; length: number } | undefined;
  for (const relativePath of generatedRelativePaths) {
    const absolutePath = path.win32.resolve(absoluteOutputDir, relativePath.replaceAll("/", "\\"));
    if (
      absolutePath.length > WINDOWS_CHROMIUM_FILE_PATH_LIMIT
      && (!offending || absolutePath.length > offending.length)
    ) {
      offending = { path: absolutePath, length: absolutePath.length };
    }
  }
  if (offending) throw extensionRuntimePathTooLong(extensionName, offending.path, offending.length);
}

function relativeModuleSpecifier(fromDirectory: string, target: string): string {
  const relative = path.posix.relative(fromDirectory === "." ? "" : fromDirectory, target);
  return relative.startsWith(".") ? relative : `./${relative}`;
}

function mv3ResourcePaths(
  signature: string,
  originalWorker: string,
): { config: string; bootstrap: string; wrapper: string } {
  // Keep enough entropy to make collisions impractical without needlessly consuming the portable
  // Windows path budget. The full absolute path guard still rejects an overlong installation root,
  // and the complete signature remains in materialization.json.
  const revision = Buffer.from(signature.slice(0, 32), "hex").toString("base64url");
  const suffix = `v${EXTENSION_LIFECYCLE_INJECTOR_VERSION}-${revision}`;
  const originalDirectory = path.posix.dirname(originalWorker);
  const wrapperName = `${EXTENSION_LIFECYCLE_NAMESPACE}-worker-${suffix}.js`;
  return {
    config: `${EXTENSION_LIFECYCLE_NAMESPACE}/config-${suffix}.js`,
    bootstrap: `${EXTENSION_LIFECYCLE_NAMESPACE}/bootstrap-${suffix}.js`,
    // A classic worker resolves its own relative importScripts() calls against the registered worker
    // URL, not against the imported source file. Keep the versioned wrapper beside the canonical entry
    // so nested workers retain their original URL base. Doing the same for module workers also preserves
    // code that intentionally derives resources from self.location while static imports keep their own base.
    wrapper: originalDirectory === "." ? wrapperName : `${originalDirectory}/${wrapperName}`,
  };
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

function assertDirectRuntimeOutputPath(runtimeRoot: string, runtimePath: string): string {
  const root = path.resolve(runtimeRoot);
  const output = path.resolve(runtimePath);
  const relative = path.relative(root, output);
  const segments = relative.split(path.sep).filter(Boolean);
  if (
    !relative
    || path.isAbsolute(relative)
    || relative.startsWith(`..${path.sep}`)
    || segments.length !== 2
  ) throw unsafeRuntimePath("extension runtime output");
  assertDirectChildName(segments[0]!, "environment id");
  assertDirectChildName(segments[1]!, "extension id");
  return output;
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
  let nativeLifecycleObserved = false;
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
      runtimeRevision: config.runtimeRevision,
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
          || (state.runtimeRevision !== undefined && typeof state.runtimeRevision !== "string")
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
    if (startupDispatched) return;
    const loaded = await loadState();
    if (loaded.status === "failed") {
      console.error("CBPanel lifecycle protection suppressed install/update because its state could not be read safely");
      emitStartup();
      return;
    }
    if (loaded.status === "missing") {
      const persisted = await persistCurrentState();
      const repeatedCommandLineLifecycle = details?.reason === "install" || details?.reason === "update";
      if (config.preserveMissingState && repeatedCommandLineLifecycle) emitStartup();
      else if (persisted) emitInstalled(details);
      else console.error("CBPanel lifecycle protection suppressed install/update because its state could not be persisted");
      return;
    }
    if (details?.reason === "chrome_update" || details?.reason === "shared_module_update") {
      if (await persistCurrentState()) emitInstalled(details);
      else {
        console.error("CBPanel lifecycle protection suppressed native install/update because its state could not be persisted");
        emitStartup();
      }
      return;
    }
    const previous = loaded.state;
    const versionChanged = previous.version !== config.version;
    const packageChanged = previous.packageRevision !== config.packageRevision;
    const bindingChanged = previous.bindingRevision !== config.bindingRevision;
    const runtimeChanged = previous.runtimeRevision !== config.runtimeRevision;
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
    if (runtimeChanged) {
      await persistCurrentState();
      emitStartup();
      return;
    }
    // Extensions.loadUnpacked emits native reason="update" even when only CBPanel's versioned wrapper
    // registration changed (or a pending migration is retried). Once semantic metadata is equal, that is
    // command-line maintenance noise just like repeated reason="install", not a plugin package update.
    emitStartup();
  }

  async function handleStartup() {
    if (startupDispatched) return;
    const loaded = await loadState();
    if (loaded.status === "failed") {
      emitStartup();
      return;
    }
    if (loaded.status === "missing") {
      if (config.preserveMissingState) {
        await persistCurrentState();
        emitStartup();
      }
      return;
    }
    const previous = loaded.state;
    const versionChanged = previous.version !== config.version;
    const packageChanged = previous.packageRevision !== config.packageRevision;
    const bindingChanged = previous.bindingRevision !== config.bindingRevision;
    const runtimeChanged = previous.runtimeRevision !== config.runtimeRevision;
    if (config.initialBehavior === "preserve" && bindingChanged) {
      await persistCurrentState();
      emitStartup();
      return;
    }
    if (versionChanged || packageChanged || bindingChanged) {
      if (await persistCurrentState()) {
        emitInstalled({
          reason: "update",
          previousVersion: previous.version || config.version,
        });
      } else {
        console.error("CBPanel lifecycle protection suppressed startup-derived update because its state could not be persisted");
        emitStartup();
      }
      return;
    }
    if (runtimeChanged) await persistCurrentState();
    emitStartup();
  }

  async function handleActivationFallback() {
    const loaded = await loadState();
    if (nativeLifecycleObserved || loaded.status === "failed") return;
    if (loaded.status === "missing") {
      if (config.preserveMissingState) {
        await persistCurrentState();
        emitStartup();
      }
      return;
    }
    const previous = loaded.state;
    const versionChanged = previous.version !== config.version;
    const packageChanged = previous.packageRevision !== config.packageRevision;
    const bindingChanged = previous.bindingRevision !== config.bindingRevision;
    const runtimeChanged = previous.runtimeRevision !== config.runtimeRevision;
    const preserveRebase = config.initialBehavior === "preserve" && bindingChanged;
    if (preserveRebase) {
      await persistCurrentState();
      emitStartup();
      return;
    }
    if (versionChanged || packageChanged || bindingChanged) {
      if (await persistCurrentState()) {
        emitInstalled({
          reason: "update",
          previousVersion: previous.version || config.version,
        });
      } else {
        console.error("CBPanel lifecycle protection suppressed activation update because its state could not be persisted");
      }
      return;
    }
    if (runtimeChanged) {
      await persistCurrentState();
      emitStartup();
    }
  }

  function enqueue(task) {
    queue = queue.then(task, task).catch((error) => {
      console.error("CBPanel lifecycle protection failed", error);
    });
  }

  nativeInstalledAdd((details) => {
    nativeLifecycleObserved = true;
    enqueue(() => handleInstalled(details));
  });
  nativeStartupAdd(() => {
    nativeLifecycleObserved = true;
    enqueue(handleStartup);
  });
  setTimeout(() => {
    if (!nativeLifecycleObserved) enqueue(handleActivationFallback);
  }, 0);
})();
`;
