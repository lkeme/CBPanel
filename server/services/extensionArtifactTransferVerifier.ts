import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { ExtensionEntity } from "../../src/shared/entities";
import {
  verifyChromeWebStoreCrx3File,
  type Crx3VerificationFacts,
} from "./crx3Verifier";
import {
  fingerprintManifest,
  preflightExtensionPackage,
} from "./extensionPackagePreflight";
import { fingerprintStagedExtensionTree } from "./boundedZipAnalyzer";

export class ExtensionArtifactTransferValidationError extends Error {
  readonly status = 400;

  readonly code = "EXTENSION_ARTIFACT_TRANSFER_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "ExtensionArtifactTransferValidationError";
  }
}

export interface ValidateTransferredExtensionArtifactOptions {
  extension: ExtensionEntity;
  artifactPath: string;
  expectedSha256: string;
  validationDir: string;
  unpackedRoot?: string;
  verifyFile?: typeof verifyChromeWebStoreCrx3File;
  preflightPackage?: typeof preflightExtensionPackage;
}

/** Re-establishes trust from retained bytes; no exporting-machine proof claim is accepted on faith. */
export async function validateTransferredExtensionArtifact(
  options: ValidateTransferredExtensionArtifactOptions,
): Promise<void> {
  const { extension } = options;
  if (!extension.storeIdentity || !extension.provenance || !extension.manifestKey) {
    throw transferInvalid(`Retained extension evidence is incomplete for ${extension.id}.`);
  }
  const stats = await fs.lstat(options.artifactPath).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw transferInvalid(`Retained extension artifact is missing or linked for ${extension.id}.`);
  }
  if (await sha256File(options.artifactPath) !== options.expectedSha256) {
    throw transferInvalid(`Retained extension artifact fingerprint is invalid for ${extension.id}.`);
  }
  let verification: Crx3VerificationFacts;
  try {
    verification = await (options.verifyFile ?? verifyChromeWebStoreCrx3File)(
      options.artifactPath,
      extension.storeIdentity.storeId,
    );
  } catch {
    throw transferInvalid(`Retained extension CRX3 proof is invalid for ${extension.id}.`);
  }
  try {
    const packageFacts = await (options.preflightPackage ?? preflightExtensionPackage)({
      archivePath: options.artifactPath,
      archiveOffset: verification.zipOffset,
      archiveLength: verification.zipSize,
      stagingDir: options.validationDir,
    });
    assertTransferredEvidence(extension, options.expectedSha256, verification, packageFacts);
    const verifiedManifestRaw = await readBoundedManifest(path.join(packageFacts.stagedRoot, "manifest.json"));
    const verifiedManifest = JSON.parse(verifiedManifestRaw.charCodeAt(0) === 0xfeff ? verifiedManifestRaw.slice(1) : verifiedManifestRaw) as Record<string, unknown>;
    if (
      typeof verifiedManifest.key === "string"
      && verifiedManifest.key
      && verifiedManifest.key !== verification.developerSpkiBase64
    ) {
      throw transferInvalid(`Retained extension signed Manifest key conflicts with its CRX developer proof for ${extension.id}.`);
    }
    await applyVerifiedManifestKey(packageFacts.stagedRoot, verification.developerSpkiBase64);
    const verifiedCommittedTree = await fingerprintStagedExtensionTree(packageFacts.stagedRoot, {
      maxFiles: 20_000,
      maxFilesystemNodes: 50_000,
      maxExpandedBytes: 512 * 1024 * 1024,
    });
    if (extension.provenance.verification.treeSha256 !== verifiedCommittedTree.sha256) {
      throw transferInvalid(`Retained extension tree fingerprint disagrees with its CRX for ${extension.id}.`);
    }
    if (options.unpackedRoot) {
      const manifestPath = path.join(options.unpackedRoot, "manifest.json");
      const manifestStats = await fs.lstat(manifestPath).catch(() => undefined);
      if (!manifestStats?.isFile() || manifestStats.isSymbolicLink() || manifestStats.nlink !== 1) {
        throw transferInvalid(`Retained extension unpacked Manifest is invalid for ${extension.id}.`);
      }
      const raw = await readBoundedManifest(manifestPath);
      const manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>;
      if (
        manifest.key !== verification.developerSpkiBase64
        || fingerprintManifest(manifest) !== packageFacts.manifestSha256
      ) {
        throw transferInvalid(`Retained extension unpacked identity disagrees with its CRX for ${extension.id}.`);
      }
      // A matching Manifest is not enough: the archive can pair it with altered JS or resources.
      // Normalize the verifier-produced tree with the exact developer key used by the committed
      // runtime, then compare every file and directory node before the caller publishes the archive tree.
      const verifiedTree = await snapshotExtensionTree(packageFacts.stagedRoot, true);
      const transferredTree = await snapshotExtensionTree(options.unpackedRoot, true);
      if (!sameTreeSnapshot(verifiedTree, transferredTree)) {
        throw transferInvalid(`Retained extension unpacked files disagree with its verified CRX for ${extension.id}.`);
      }
      const transferredRoot = path.join(path.dirname(options.validationDir), `.transferred-tree-${extension.id}`);
      try {
        await fs.cp(options.unpackedRoot, transferredRoot, { recursive: true, force: false, verbatimSymlinks: true });
        await applyVerifiedManifestKey(transferredRoot, verification.developerSpkiBase64);
        const committedTree = await fingerprintStagedExtensionTree(transferredRoot, {
          maxFiles: 20_000,
          maxFilesystemNodes: 50_000,
          maxExpandedBytes: 512 * 1024 * 1024,
        });
        if (committedTree.sha256 !== verifiedCommittedTree.sha256) {
          throw transferInvalid(`Retained extension tree fingerprint disagrees with its CRX for ${extension.id}.`);
        }
      } finally {
        await fs.rm(transferredRoot, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  } catch (error) {
    if (error instanceof ExtensionArtifactTransferValidationError) throw error;
    throw transferInvalid(`Retained extension package facts are invalid for ${extension.id}.`);
  } finally {
    await fs.rm(options.validationDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function applyVerifiedManifestKey(directory: string, key: string): Promise<void> {
  const manifestPath = path.join(directory, "manifest.json");
  const raw = await fs.readFile(manifestPath, "utf8");
  const manifest = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<string, unknown>;
  if (manifest.key === key) return;
  manifest.key = key;
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

type TreeSnapshot = Map<string, { kind: "file" | "directory"; digest?: string; size?: number }>;

async function snapshotExtensionTree(root: string, normalizeManifest: boolean): Promise<TreeSnapshot> {
  const resolvedRoot = path.resolve(root);
  const rootStats = await fs.lstat(resolvedRoot).catch(() => undefined);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw transferInvalid("Transferred extension tree root is not an ordinary directory.");
  }
  if (await fs.realpath(resolvedRoot) !== resolvedRoot) {
    throw transferInvalid("Transferred extension tree root traverses a linked directory.");
  }
  const snapshot: TreeSnapshot = new Map();
  const canonicalRoot = await fs.realpath(resolvedRoot);
  let nodes = 0;
  let files = 0;
  let bytes = 0;
  let pathBytes = 0;
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    if (++nodes > 50_000) throw transferInvalid("Transferred extension tree exceeds the filesystem-node limit.");
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const relativeBytes = Buffer.byteLength(relativePath, "utf8");
      if (relativeBytes > 1024 || relativePath.split("/").length > 32 || (pathBytes += relativeBytes) > 32 * 1024 * 1024) {
        throw transferInvalid("Transferred extension tree path budget is exceeded.");
      }
      const absolutePath = path.join(directory, entry.name);
      const stats = await fs.lstat(absolutePath);
      const canonicalPath = await fs.realpath(absolutePath).catch(() => undefined);
      if (
        !canonicalPath
        || !isPathInside(canonicalPath, canonicalRoot)
        || stats.isSymbolicLink()
        || !stats.isDirectory() && !stats.isFile()
        || stats.isFile() && stats.nlink !== 1
      ) {
        throw transferInvalid("Transferred extension tree contains a linked or special filesystem node.");
      }
      if (stats.isDirectory()) {
        snapshot.set(relativePath, { kind: "directory" });
        await visit(absolutePath, relativePath);
        continue;
      }
      if (++files > 20_000 || (bytes += stats.size) > 512 * 1024 * 1024) {
        throw transferInvalid("Transferred extension tree exceeds the resource limit.");
      }
      const digest = normalizeManifest && relativePath === "manifest.json"
        ? canonicalManifestDigest(await readBoundedManifest(absolutePath))
        : await sha256FileChecked(absolutePath, stats, canonicalPath);
      snapshot.set(relativePath, { kind: "file", digest, size: stats.size });
      const after = await fs.lstat(absolutePath);
      if (after.size !== stats.size || after.mtimeMs !== stats.mtimeMs || await fs.realpath(absolutePath) !== canonicalPath) {
        throw transferInvalid("Transferred extension tree changed during validation.");
      }
    }
  }
  await visit(resolvedRoot, "");
  return snapshot;
}

async function sha256FileChecked(
  filePath: string,
  before: import("node:fs").Stats,
  canonicalPath: string,
): Promise<string> {
  const hash = await sha256File(filePath);
  const after = await fs.lstat(filePath);
  if (
    after.size !== before.size
    || after.mtimeMs !== before.mtimeMs
    || after.nlink !== 1
    || await fs.realpath(filePath) !== canonicalPath
  ) {
    throw transferInvalid("Transferred extension file changed during validation.");
  }
  return hash;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalManifestDigest(raw: string): string {
  let value: unknown;
  try {
    value = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    throw transferInvalid("Transferred extension Manifest is not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw transferInvalid("Transferred extension Manifest is not an object.");
  }
  const manifest = { ...(value as Record<string, unknown>) };
  delete manifest.key;
  return createHash("sha256").update(stableJson(manifest), "utf8").digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function readBoundedManifest(filePath: string): Promise<string> {
  const stats = await fs.lstat(filePath);
  if (stats.size > 4 * 1024 * 1024) throw transferInvalid("Transferred extension Manifest exceeds its size limit.");
  const bytes = await fs.readFile(filePath);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw transferInvalid("Transferred extension Manifest is not valid UTF-8.");
  }
}

function sameTreeSnapshot(left: TreeSnapshot, right: TreeSnapshot): boolean {
  if (left.size !== right.size) return false;
  for (const [relativePath, expected] of left) {
    const actual = right.get(relativePath);
    if (!actual || actual.kind !== expected.kind || actual.digest !== expected.digest) return false;
    if (expected.kind === "file" && relativePath !== "manifest.json" && actual.size !== expected.size) return false;
  }
  return true;
}

function assertTransferredEvidence(
  extension: ExtensionEntity,
  artifactSha256: string,
  verification: Crx3VerificationFacts,
  packageFacts: Awaited<ReturnType<typeof preflightExtensionPackage>>,
): void {
  const provenance = extension.provenance;
  if (
    !provenance
    || provenance.verification.level !== "cws-publisher-verified"
    || provenance.artifact.format !== "crx3"
    || !provenance.artifact.retained
    || provenance.artifact.sha256 !== artifactSha256
    || extension.sha256 !== verification.crxSha256
    || provenance.artifact.size !== verification.crxSize
    || provenance.verification.proofDerivedStoreId !== verification.developerDerivedId
    || provenance.verification.developerKeySha256 !== verification.developerSpkiSha256
    || provenance.verification.publisherKeySha256 !== verification.publisherSpkiSha256
    || provenance.verification.publisherTrustRootId !== verification.publisherTrustRootId
    || provenance.verification.publisherTrustRootVersion !== verification.publisherTrustRootVersion
    || provenance.verification.manifestSha256 !== packageFacts.manifestSha256
    || extension.manifestSha256 !== packageFacts.manifestSha256
    || extension.manifestKey !== verification.developerSpkiBase64
    || extension.name !== packageFacts.name
    || extension.version !== packageFacts.version
    || extension.manifestVersion !== packageFacts.manifestVersion
    || !sameStrings(extension.permissions, packageFacts.permissions)
    || !sameStrings(extension.hostPermissions, packageFacts.hostPermissions)
    || !sameStrings(extension.optionalPermissions ?? [], packageFacts.optionalPermissions)
    || !sameStrings(extension.optionalHostPermissions ?? [], packageFacts.optionalHostPermissions)
  ) {
    throw transferInvalid(`Retained extension evidence disagrees with verified package ${extension.id}.`);
  }
}

async function sha256File(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  const hash = createHash("sha256");
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    return hash.digest("hex");
  } finally {
    await handle.close();
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function transferInvalid(message: string): ExtensionArtifactTransferValidationError {
  return new ExtensionArtifactTransferValidationError(message);
}
