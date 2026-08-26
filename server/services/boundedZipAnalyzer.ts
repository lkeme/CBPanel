import { createHash } from "node:crypto";
import { createInflateRaw } from "node:zlib";
import type { Stats } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_DATA_DESCRIPTOR = 0x08074b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const ZIP64_EXTRA_FIELD = 0x0001;
const UNICODE_PATH_EXTRA_FIELD = 0x7075;
const ZIP_EOCD_MIN_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 0xffff;
const ZIP_LOCAL_HEADER_BYTES = 30;
const ZIP_CENTRAL_HEADER_BYTES = 46;
const ZIP_STREAM_CHUNK_BYTES = 64 * 1024;
const UTF8_FLAG = 1 << 11;
const DATA_DESCRIPTOR_FLAG = 1 << 3;
const ENCRYPTED_FLAGS = (1 << 0) | (1 << 6) | (1 << 13);
const ALLOWED_GENERAL_FLAGS = (1 << 1) | (1 << 2) | DATA_DESCRIPTOR_FLAG | UTF8_FLAG;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_REGULAR_FILE = 0x8000;
const UNIX_DIRECTORY = 0x4000;
const DOS_DIRECTORY_ATTRIBUTE = 0x10;
const DOS_VOLUME_ATTRIBUTE = 0x08;
const WINDOWS_REPARSE_POINT_ATTRIBUTE = 0x400;
const WINDOWS_RESERVED_BASENAME = /^(?:con|prn|aux|nul|clock\$|(?:com|lpt)(?:[1-9]|\u00b9|\u00b2|\u00b3))$/i;
const WINDOWS_FORBIDDEN_CHARACTERS = /[<>:"|?*\u0000-\u001f\u007f]/;
export interface ExtensionArchiveLimits {
  maxArchiveBytes: number;
  maxCentralDirectoryBytes: number;
  maxEntries: number;
  maxFilesystemNodes: number;
  maxFilesystemPathBytes: number;
  maxFileExpandedBytes: number;
  maxDirectoryCompressedBytes: number;
  maxTotalExpandedBytes: number;
  maxCompressionRatio: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxManifestSearchDepth: number;
  maxManifestBytes: number;
  maxLocaleMessagesBytes: number;
  maxTemporaryDiskBytes: number;
  temporaryEntryOverheadBytes: number;
}

export const EXTENSION_ARCHIVE_LIMITS: Readonly<ExtensionArchiveLimits> = Object.freeze({
  maxArchiveBytes: 200 * 1024 * 1024,
  maxCentralDirectoryBytes: 32 * 1024 * 1024,
  maxEntries: 20_000,
  maxFilesystemNodes: 50_000,
  maxFilesystemPathBytes: 32 * 1024 * 1024,
  maxFileExpandedBytes: 128 * 1024 * 1024,
  maxDirectoryCompressedBytes: 64 * 1024,
  maxTotalExpandedBytes: 512 * 1024 * 1024,
  maxCompressionRatio: 200,
  maxPathBytes: 1024,
  maxPathDepth: 32,
  maxManifestSearchDepth: 3,
  maxManifestBytes: 4 * 1024 * 1024,
  maxLocaleMessagesBytes: 4 * 1024 * 1024,
  maxTemporaryDiskBytes: 640 * 1024 * 1024,
  temporaryEntryOverheadBytes: 4096,
});

export type ExtensionArchiveErrorCode =
  | "EXTENSION_ARCHIVE_INVALID"
  | "EXTENSION_ARCHIVE_UNSUPPORTED"
  | "EXTENSION_ARCHIVE_ENCRYPTED"
  | "EXTENSION_ARCHIVE_LIMIT_EXCEEDED"
  | "EXTENSION_ARCHIVE_PATH_UNSAFE"
  | "EXTENSION_ARCHIVE_PATH_COLLISION"
  | "EXTENSION_ARCHIVE_LINK_FORBIDDEN"
  | "EXTENSION_ARCHIVE_MANIFEST_MISSING"
  | "EXTENSION_ARCHIVE_MANIFEST_AMBIGUOUS"
  | "EXTENSION_ARCHIVE_STAGE_INVALID"
  | "ACQUISITION_CANCELLED";

export class ExtensionArchiveAnalysisError extends Error {
  readonly status: number;

  constructor(
    readonly code: ExtensionArchiveErrorCode,
    message: string,
    status = code === "ACQUISITION_CANCELLED" ? 409 : 422,
  ) {
    super(message);
    this.name = code === "ACQUISITION_CANCELLED" ? "AbortError" : "ExtensionArchiveAnalysisError";
    this.status = status;
  }
}

export type BoundedZipArchiveInput =
  | {
      archivePath: string;
      zipBytes?: never;
      archiveOffset?: number;
      archiveLength?: number;
    }
  | {
      zipBytes: Uint8Array;
      archivePath?: never;
      archiveOffset?: number;
      archiveLength?: number;
    };

export type AnalyzeAndStageBoundedZipInput = BoundedZipArchiveInput & {
  outputDir: string;
  limits?: Partial<ExtensionArchiveLimits>;
  signal?: AbortSignal;
};

export interface StagedTreeFingerprint {
  sha256: string;
  fileCount: number;
  filesystemNodeCount: number;
  expandedBytes: number;
}

export interface BoundedZipAnalysis {
  archiveBytes: number;
  compressedBytes: number;
  expandedBytes: number;
  entryCount: number;
  filesystemNodeCount: number;
  fileCount: number;
  stagedFileCount: number;
  stagedFilesystemNodeCount: number;
  stagedExpandedBytes: number;
  outputDir: string;
  stagedRoot: string;
  manifestPath: string;
  manifestRelativePath: string;
  treeSha256: string;
}

type ArchiveSource = {
  readonly length: number;
  read(offset: number, length: number): Promise<Buffer>;
  stream(offset: number, length: number, signal?: AbortSignal): Readable;
  assertStable(): Promise<void>;
  close(): Promise<void>;
};

type ZipEntry = {
  readonly rawName: Buffer;
  readonly normalizedPath: string;
  readonly segments: readonly string[];
  readonly directory: boolean;
  readonly flags: number;
  readonly compressionMethod: 0 | 8;
  readonly crc32: number;
  readonly compressedSize: number;
  readonly expandedSize: number;
  readonly localHeaderOffset: number;
  dataOffset?: number;
  rangeEnd?: number;
};

type ParsedArchive = {
  readonly entries: ZipEntry[];
  readonly manifestEntry: ZipEntry;
  readonly centralDirectoryOffset: number;
  readonly compressedBytes: number;
  readonly expandedBytes: number;
  readonly fileCount: number;
  readonly filesystemNodeCount: number;
};

type NormalizedPath = {
  readonly value: string;
  readonly segments: readonly string[];
};

type PathKind = "file" | "directory";

type ExtractionBudget = {
  expandedBytes: number;
  filesystemNodeCount: number;
};

type TreeCollectionBudget = {
  expandedBytes: number;
  fileCount: number;
  filesystemNodeCount: number;
  pathBytes: number;
  windowsPaths: Map<string, string>;
};

type ArchivePathBudget = {
  filesystemNodeCount: number;
  pathBytes: number;
};

type StagedTreeNode = {
  absolutePath: string;
  relativePath: string;
  kind: "directory" | "file";
  size: number;
  identity: NodeIdentity;
  canonicalPath: string;
};

type NodeIdentity = {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });
const CRC32_TABLE = createCrc32Table();

/**
 * Validates every central/local ZIP record before creating output, then streams
 * one file at a time into an isolated staging directory. The function never
 * publishes into the canonical extension cache.
 */
export async function analyzeAndStageBoundedZip(
  input: AnalyzeAndStageBoundedZipInput,
): Promise<BoundedZipAnalysis> {
  const limits = resolveLimits(input.limits);
  const outputDir = validateStagingDirectoryPath(input.outputDir);
  let source: ArchiveSource | undefined;
  let ownsStage = false;

  try {
    throwIfAborted(input.signal);
    source = await openArchiveSource(input, limits.maxArchiveBytes);
    if (source.length > limits.maxArchiveBytes) {
      throw archiveLimitError("Extension archive exceeds the compressed-byte limit.");
    }
    const parsed = await parseArchive(source, limits, input.signal);
    await prepareStagingDirectory(outputDir);
    ownsStage = true;
    await extractEntries(
      source,
      parsed.entries,
      parsed.filesystemNodeCount,
      outputDir,
      limits,
      input.signal,
    );

    const manifestRelativePath = parsed.manifestEntry.normalizedPath;
    const manifestPath = path.join(outputDir, ...parsed.manifestEntry.segments);
    const manifestParentSegments = parsed.manifestEntry.segments.slice(0, -1);
    const stagedRoot = path.join(outputDir, ...manifestParentSegments);
    const stagedEntries = parsed.entries.filter((entry) => (
      !entry.directory && isEntryInsideRoot(entry.segments, manifestParentSegments)
    ));
    const stagedExpandedBytes = stagedEntries.reduce((total, entry) => total + entry.expandedSize, 0);
    const stagedFilesystemNodeCount = countStagedFilesystemNodes(parsed.entries, manifestParentSegments);
    const tree = await fingerprintStagedExtensionTree(stagedRoot, {
      maxFiles: limits.maxEntries,
      maxFilesystemNodes: limits.maxFilesystemNodes,
      maxExpandedBytes: limits.maxTotalExpandedBytes,
      maxPathBytes: limits.maxPathBytes,
      maxPathDepth: limits.maxPathDepth,
      maxTotalPathBytes: limits.maxFilesystemPathBytes,
      signal: input.signal,
    });
    if (
      tree.fileCount !== stagedEntries.length
      || tree.filesystemNodeCount !== stagedFilesystemNodeCount
      || tree.expandedBytes !== stagedExpandedBytes
    ) {
      throw archiveInvalidError("Staged extension tree differs from the validated archive entries.");
    }
    await source.assertStable();
    throwIfAborted(input.signal);
    ownsStage = false;
    return Object.freeze({
      archiveBytes: source.length,
      compressedBytes: parsed.compressedBytes,
      expandedBytes: parsed.expandedBytes,
      entryCount: parsed.entries.length,
      filesystemNodeCount: parsed.filesystemNodeCount,
      fileCount: parsed.fileCount,
      stagedFileCount: tree.fileCount,
      stagedFilesystemNodeCount: tree.filesystemNodeCount,
      stagedExpandedBytes: tree.expandedBytes,
      outputDir,
      stagedRoot,
      manifestPath,
      manifestRelativePath,
      treeSha256: tree.sha256,
    });
  } catch (error) {
    if (ownsStage) await fs.rm(outputDir, { recursive: true, force: true }).catch(() => undefined);
    throw normalizeArchiveFailure(error);
  } finally {
    await source?.close().catch(() => undefined);
  }
}

export async function fingerprintStagedExtensionTree(
  root: string,
  options: {
    maxFiles?: number;
    maxFilesystemNodes?: number;
    maxExpandedBytes?: number;
    maxPathBytes?: number;
    maxPathDepth?: number;
    maxTotalPathBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<StagedTreeFingerprint> {
  const resolvedRoot = path.resolve(root);
  const maxFiles = positiveSafeInteger(options.maxFiles ?? EXTENSION_ARCHIVE_LIMITS.maxEntries, "tree file limit");
  const maxFilesystemNodes = positiveSafeInteger(
    options.maxFilesystemNodes ?? EXTENSION_ARCHIVE_LIMITS.maxFilesystemNodes,
    "tree filesystem-node limit",
  );
  const maxExpandedBytes = positiveSafeInteger(
    options.maxExpandedBytes ?? EXTENSION_ARCHIVE_LIMITS.maxTotalExpandedBytes,
    "tree expanded-byte limit",
  );
  const maxPathBytes = positiveSafeInteger(
    options.maxPathBytes ?? EXTENSION_ARCHIVE_LIMITS.maxPathBytes,
    "tree path-byte limit",
  );
  const maxPathDepth = positiveSafeInteger(
    options.maxPathDepth ?? EXTENSION_ARCHIVE_LIMITS.maxPathDepth,
    "tree path-depth limit",
  );
  const maxTotalPathBytes = positiveSafeInteger(
    options.maxTotalPathBytes ?? EXTENSION_ARCHIVE_LIMITS.maxFilesystemPathBytes,
    "tree total path-byte limit",
  );
  const rootStats = await safeLstat(resolvedRoot, "Staged extension root is missing or unreadable.");
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw archiveLinkError("Staged extension root must be a real directory.");
  }
  const rootIdentity = nodeIdentity(rootStats);
  const canonicalRoot = await safeRealpath(resolvedRoot);
  const nodes: StagedTreeNode[] = [];
  await collectStagedTreeNodes(
    resolvedRoot,
    canonicalRoot,
    "",
    nodes,
    { expandedBytes: 0, fileCount: 0, filesystemNodeCount: 0, pathBytes: 0, windowsPaths: new Map() },
    maxFiles,
    maxFilesystemNodes,
    maxExpandedBytes,
    maxPathBytes,
    maxPathDepth,
    maxTotalPathBytes,
    options.signal,
  );
  assertSameNodeIdentity(
    rootIdentity,
    nodeIdentity(await safeLstat(resolvedRoot, "Staged extension root changed during fingerprinting.")),
  );
  if (await safeRealpath(resolvedRoot) !== canonicalRoot) {
    throw archiveLinkError("Staged extension root changed or became linked during fingerprinting.");
  }
  nodes.sort((left, right) => Buffer.compare(Buffer.from(left.relativePath, "utf8"), Buffer.from(right.relativePath, "utf8")));

  const treeHash = createHash("sha256").update("CBPanel extension tree v2\0", "utf8");
  let expandedBytes = 0;
  let fileCount = 0;
  for (const node of nodes) {
    throwIfAborted(options.signal);
    const pathBytes = Buffer.from(node.relativePath, "utf8");
    treeHash.update(node.kind === "directory" ? Uint8Array.of(0) : Uint8Array.of(1));
    treeHash.update(uint32Buffer(pathBytes.byteLength));
    treeHash.update(pathBytes);
    if (node.kind === "directory") {
      assertSameNodeIdentity(
        node.identity,
        nodeIdentity(await safeLstat(node.absolutePath, "Staged extension directory changed during fingerprinting.")),
      );
      if (await safeRealpath(node.absolutePath) !== node.canonicalPath) {
        throw archiveLinkError("Staged extension directory changed or became linked during fingerprinting.");
      }
      continue;
    }
    const fileSha256 = await fingerprintStagedFile(node, options.signal);
    expandedBytes += node.size;
    fileCount += 1;
    treeHash.update(uint64Buffer(node.size));
    treeHash.update(fileSha256);
  }
  assertSameNodeIdentity(
    rootIdentity,
    nodeIdentity(await safeLstat(resolvedRoot, "Staged extension root changed during fingerprinting.")),
  );
  if (await safeRealpath(resolvedRoot) !== canonicalRoot) {
    throw archiveLinkError("Staged extension root changed or became linked during fingerprinting.");
  }
  throwIfAborted(options.signal);

  return Object.freeze({
    sha256: treeHash.digest("hex"),
    fileCount,
    filesystemNodeCount: nodes.length,
    expandedBytes,
  });
}

function resolveLimits(overrides: Partial<ExtensionArchiveLimits> | undefined): ExtensionArchiveLimits {
  const merged = { ...EXTENSION_ARCHIVE_LIMITS, ...overrides };
  for (const key of Object.keys(EXTENSION_ARCHIVE_LIMITS) as Array<keyof ExtensionArchiveLimits>) {
    const value = merged[key];
    if (key === "maxCompressionRatio") {
      if (!Number.isFinite(value) || value < 1) throw new TypeError(`${key} must be a finite number of at least one.`);
      continue;
    }
    if (key === "maxManifestSearchDepth") {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${key} must be a non-negative safe integer.`);
      continue;
    }
    positiveSafeInteger(value, key);
  }
  return Object.freeze(merged);
}

function validateStagingDirectoryPath(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 32_768) {
    throw archiveStageError("Extension staging directory is invalid.");
  }
  const resolved = path.resolve(value);
  if (resolved === path.parse(resolved).root) {
    throw archiveStageError("Extension staging directory cannot be a filesystem root.");
  }
  return resolved;
}

async function prepareStagingDirectory(outputDir: string): Promise<void> {
  let stats: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stats = await fs.lstat(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (stats) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw archiveStageError("Extension staging path must be a real directory.");
    }
    if ((await fs.readdir(outputDir)).length > 0) {
      throw archiveStageError("Extension staging directory must be empty.");
    }
    return;
  }
  await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const created = await fs.lstat(outputDir);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw archiveStageError("Extension staging directory could not be created safely.");
  }
}

async function openArchiveSource(input: BoundedZipArchiveInput, maxArchiveBytes: number): Promise<ArchiveSource> {
  if (input.zipBytes !== undefined) {
    return openBufferSource(input.zipBytes, input.archiveOffset, input.archiveLength, maxArchiveBytes);
  }
  return openFileSource(input.archivePath, input.archiveOffset, input.archiveLength);
}

function openBufferSource(
  bytes: Uint8Array,
  requestedOffset: number | undefined,
  requestedLength: number | undefined,
  maxArchiveBytes: number,
): ArchiveSource {
  if (!(bytes instanceof Uint8Array)) throw archiveInvalidError("Extension archive bytes are invalid.");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const range = validateArchiveRange(buffer.byteLength, requestedOffset, requestedLength);
  if (range.length > maxArchiveBytes) {
    throw archiveLimitError("Extension archive exceeds the compressed-byte limit.");
  }
  // Byte callers retain ownership of their Uint8Array. Snapshot the verified
  // range once so a caller-side mutation cannot change bytes between central
  // directory validation, extraction, and fingerprinting.
  const selected = Buffer.from(buffer.subarray(range.offset, range.offset + range.length));
  return {
    length: selected.byteLength,
    read: async (offset, length) => {
      assertReadableRange(selected.byteLength, offset, length);
      return selected.subarray(offset, offset + length);
    },
    stream: (offset, length, signal) => {
      assertReadableRange(selected.byteLength, offset, length);
      return Readable.from(bufferChunks(selected.subarray(offset, offset + length), signal));
    },
    close: async () => undefined,
    assertStable: async () => undefined,
  };
}

async function openFileSource(
  archivePath: string,
  requestedOffset: number | undefined,
  requestedLength: number | undefined,
): Promise<ArchiveSource> {
  if (typeof archivePath !== "string" || !archivePath.trim() || archivePath.length > 32_768) {
    throw archiveInvalidError("Extension archive path is invalid.");
  }
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(archivePath, "r");
    const stats = await handle.stat();
    if (!stats.isFile()) throw archiveInvalidError("Extension archive must be a regular file.");
    const range = validateArchiveRange(stats.size, requestedOffset, requestedLength);
    const sourceHandle = handle;
    handle = undefined;
    return {
      length: range.length,
      read: (offset, length) => readFileRange(sourceHandle, range.offset, range.length, offset, length),
      stream: (offset, length, signal) => {
        assertReadableRange(range.length, offset, length);
        return Readable.from(fileRangeChunks(sourceHandle, range.offset + offset, length, signal));
      },
      assertStable: async () => {
        const current = await sourceHandle.stat();
        if (
          current.size !== stats.size
          || current.dev !== stats.dev
          || current.ino !== stats.ino
          || current.mtimeMs !== stats.mtimeMs
          || current.ctimeMs !== stats.ctimeMs
        ) {
          throw archiveInvalidError("Extension archive changed during package analysis.");
        }
      },
      close: () => sourceHandle.close(),
    };
  } catch (error) {
    await handle?.close().catch(() => undefined);
    throw error;
  }
}

function validateArchiveRange(
  availableBytes: number,
  requestedOffset: number | undefined,
  requestedLength: number | undefined,
): { offset: number; length: number } {
  if (!Number.isSafeInteger(availableBytes) || availableBytes < 0) {
    throw archiveInvalidError("Extension archive size is invalid.");
  }
  const offset = requestedOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > availableBytes) {
    throw archiveInvalidError("Extension archive offset is invalid.");
  }
  const length = requestedLength ?? availableBytes - offset;
  if (!Number.isSafeInteger(length) || length < 0 || length > availableBytes - offset) {
    throw archiveInvalidError("Extension archive length is invalid.");
  }
  return { offset, length };
}

async function readFileRange(
  handle: FileHandle,
  baseOffset: number,
  sourceLength: number,
  offset: number,
  length: number,
): Promise<Buffer> {
  assertReadableRange(sourceLength, offset, length);
  const output = Buffer.allocUnsafe(length);
  let consumed = 0;
  while (consumed < length) {
    const { bytesRead } = await handle.read(
      output,
      consumed,
      length - consumed,
      baseOffset + offset + consumed,
    );
    if (bytesRead <= 0) throw archiveInvalidError("Extension archive is truncated.");
    consumed += bytesRead;
  }
  return output;
}

async function* bufferChunks(bytes: Buffer, signal?: AbortSignal): AsyncGenerator<Buffer> {
  for (let offset = 0; offset < bytes.byteLength; offset += ZIP_STREAM_CHUNK_BYTES) {
    if (signal?.aborted) return;
    yield bytes.subarray(offset, Math.min(bytes.byteLength, offset + ZIP_STREAM_CHUNK_BYTES));
  }
}

async function* fileRangeChunks(
  handle: FileHandle,
  absoluteOffset: number,
  length: number,
  signal?: AbortSignal,
): AsyncGenerator<Buffer> {
  let consumed = 0;
  while (consumed < length) {
    if (signal?.aborted) return;
    const chunk = Buffer.allocUnsafe(Math.min(ZIP_STREAM_CHUNK_BYTES, length - consumed));
    const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, absoluteOffset + consumed);
    if (bytesRead <= 0) throw archiveInvalidError("Extension archive entry data is truncated.");
    consumed += bytesRead;
    yield chunk.subarray(0, bytesRead);
  }
}

function assertReadableRange(sourceLength: number, offset: number, length: number): void {
  if (
    !Number.isSafeInteger(offset)
    || !Number.isSafeInteger(length)
    || offset < 0
    || length < 0
    || offset > sourceLength
    || length > sourceLength - offset
  ) {
    throw archiveInvalidError("Extension archive record points outside the package.");
  }
}

async function parseArchive(
  source: ArchiveSource,
  limits: ExtensionArchiveLimits,
  signal?: AbortSignal,
): Promise<ParsedArchive> {
  throwIfAborted(signal);
  if (source.length < ZIP_EOCD_MIN_BYTES) {
    throw archiveInvalidError("Extension archive is truncated or is not a ZIP package.");
  }
  const tailLength = Math.min(source.length, ZIP_EOCD_MIN_BYTES + ZIP_MAX_COMMENT_BYTES);
  const tailOffset = source.length - tailLength;
  const tail = await source.read(tailOffset, tailLength);
  const eocdIndex = findEndOfCentralDirectory(tail);
  if (eocdIndex < 0) {
    throw archiveInvalidError("Extension archive end record is missing or truncated.");
  }
  const eocdOffset = tailOffset + eocdIndex;
  if (
    eocdOffset >= 20
    && (await source.read(eocdOffset - 20, 4)).readUInt32LE(0) === ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR
  ) {
    throw archiveUnsupportedError("ZIP64 extension packages are not supported.");
  }

  const diskNumber = tail.readUInt16LE(eocdIndex + 4);
  const centralDirectoryDisk = tail.readUInt16LE(eocdIndex + 6);
  const entriesOnDisk = tail.readUInt16LE(eocdIndex + 8);
  const entryCount = tail.readUInt16LE(eocdIndex + 10);
  const centralDirectorySize = tail.readUInt32LE(eocdIndex + 12);
  const centralDirectoryOffset = tail.readUInt32LE(eocdIndex + 16);

  if (diskNumber !== 0 || centralDirectoryDisk !== 0 || entriesOnDisk !== entryCount) {
    throw archiveUnsupportedError("Multi-disk extension archives are not supported.");
  }
  if (
    entryCount === 0xffff
    || centralDirectorySize === 0xffffffff
    || centralDirectoryOffset === 0xffffffff
  ) {
    throw archiveUnsupportedError("ZIP64 extension packages are not supported.");
  }
  if (entryCount === 0) throw archiveInvalidError("Extension archive is empty.");
  if (entryCount > limits.maxEntries) {
    throw archiveLimitError("Extension archive contains too many entries.");
  }
  if (centralDirectorySize > limits.maxCentralDirectoryBytes) {
    throw archiveLimitError("Extension archive central directory exceeds its memory limit.");
  }
  if (
    centralDirectoryOffset > eocdOffset
    || centralDirectorySize > eocdOffset - centralDirectoryOffset
    || centralDirectoryOffset + centralDirectorySize !== eocdOffset
  ) {
    throw archiveInvalidError("Extension archive central directory boundaries are invalid.");
  }

  const centralDirectory = await source.read(centralDirectoryOffset, centralDirectorySize);
  const parsed = parseCentralDirectory(centralDirectory, entryCount, centralDirectoryOffset, limits);
  await validateLocalRecords(source, parsed.entries, centralDirectoryOffset, limits, signal);
  return parsed;
}

function findEndOfCentralDirectory(tail: Buffer): number {
  for (let index = tail.byteLength - ZIP_EOCD_MIN_BYTES; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) !== ZIP_END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = tail.readUInt16LE(index + 20);
    if (index + ZIP_EOCD_MIN_BYTES + commentLength === tail.byteLength) return index;
  }
  return -1;
}

function parseCentralDirectory(
  bytes: Buffer,
  entryCount: number,
  centralDirectoryOffset: number,
  limits: ExtensionArchiveLimits,
): ParsedArchive {
  const entries: ZipEntry[] = [];
  const explicitPaths = new Set<string>();
  const pathKinds = new Map<string, PathKind>();
  const windowsPaths = new Map<string, string>();
  const pathBudget: ArchivePathBudget = { filesystemNodeCount: 0, pathBytes: 0 };
  const manifestEntries: ZipEntry[] = [];
  let cursor = 0;
  let compressedBytes = 0;
  let expandedBytes = 0;
  let fileCount = 0;

  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + ZIP_CENTRAL_HEADER_BYTES > bytes.byteLength) {
      throw archiveInvalidError("Extension archive central directory is truncated.");
    }
    if (bytes.readUInt32LE(cursor) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
      throw archiveInvalidError("Extension archive central directory contains an invalid record.");
    }
    const versionMadeBy = bytes.readUInt16LE(cursor + 4);
    const creatorSystem = versionMadeBy >>> 8;
    const flags = bytes.readUInt16LE(cursor + 8);
    const compressionMethod = bytes.readUInt16LE(cursor + 10);
    const crc32 = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const entryExpandedSize = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const diskStart = bytes.readUInt16LE(cursor + 34);
    const externalAttributes = bytes.readUInt32LE(cursor + 38);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const recordEnd = cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (recordEnd > bytes.byteLength) {
      throw archiveInvalidError("Extension archive central directory record is truncated.");
    }
    if (nameLength === 0) throw archivePathError("Extension archive contains an empty entry path.");
    if (nameLength > limits.maxPathBytes) {
      throw archiveLimitError("Extension archive entry path exceeds the byte limit.");
    }
    if (diskStart !== 0) throw archiveUnsupportedError("Multi-disk extension archives are not supported.");
    if (localHeaderOffset === 0xffffffff || compressedSize === 0xffffffff || entryExpandedSize === 0xffffffff) {
      throw archiveUnsupportedError("ZIP64 extension packages are not supported.");
    }
    validateGeneralPurposeFlags(flags, compressionMethod);
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw archiveUnsupportedError("Extension archive uses an unsupported compression method.");
    }

    const rawName = bytes.subarray(cursor + ZIP_CENTRAL_HEADER_BYTES, cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength);
    const extraStart = cursor + ZIP_CENTRAL_HEADER_BYTES + nameLength;
    const extraFields = parseExtraFields(bytes.subarray(extraStart, extraStart + extraLength));
    if (extraFields.has(ZIP64_EXTRA_FIELD)) {
      throw archiveUnsupportedError("ZIP64 extension packages are not supported.");
    }
    const decodedName = decodeEntryName(rawName, flags, extraFields);
    const directory = classifyEntryKind(decodedName, creatorSystem, externalAttributes);
    const normalized = normalizeEntryPath(decodedName, directory, limits);
    registerArchivePath(
      normalized,
      directory ? "directory" : "file",
      explicitPaths,
      pathKinds,
      windowsPaths,
      pathBudget,
      limits,
    );

    compressedBytes = checkedTotal(
      compressedBytes,
      compressedSize,
      limits.maxArchiveBytes,
      "Extension archive compressed entries exceed the package limit.",
    );
    if (directory) {
      if (
        entryExpandedSize !== 0
        || crc32 !== 0
        || (compressionMethod === 0 && compressedSize !== 0)
      ) {
        throw archiveInvalidError("Extension archive directory entry contains non-empty data.");
      }
      if (compressedSize > limits.maxDirectoryCompressedBytes) {
        throw archiveLimitError("Extension archive directory metadata exceeds its compressed-byte limit.");
      }
    } else {
      if (entryExpandedSize > limits.maxFileExpandedBytes) {
        throw archiveLimitError("Extension archive contains a file larger than the per-file limit.");
      }
      if (compressionMethod === 0 && compressedSize !== entryExpandedSize) {
        throw archiveInvalidError("Stored extension archive entry has inconsistent sizes.");
      }
      if (entryExpandedSize > 0 && compressedSize === 0) {
        throw archiveInvalidError("Extension archive entry has an impossible compressed size.");
      }
      if (entryExpandedSize > Math.max(1, compressedSize) * limits.maxCompressionRatio) {
        throw archiveLimitError("Extension archive entry exceeds the compression-ratio limit.");
      }
      expandedBytes = checkedTotal(
        expandedBytes,
        entryExpandedSize,
        limits.maxTotalExpandedBytes,
        "Extension archive exceeds the total expanded-byte limit.",
      );
      fileCount += 1;
    }

    const entry: ZipEntry = {
      rawName: Buffer.from(rawName),
      normalizedPath: normalized.value,
      segments: normalized.segments,
      directory,
      flags,
      compressionMethod,
      crc32,
      compressedSize,
      expandedSize: entryExpandedSize,
      localHeaderOffset,
    };
    entries.push(entry);
    if (!directory && normalized.segments.at(-1) === "manifest.json") {
      const manifestDepth = normalized.segments.length - 1;
      if (manifestDepth > limits.maxManifestSearchDepth) {
        throw archiveLimitError("Extension Manifest is nested beyond the configured search depth.");
      }
      if (entryExpandedSize > limits.maxManifestBytes) {
        throw archiveLimitError("Extension Manifest exceeds the metadata-file limit.");
      }
      manifestEntries.push(entry);
    }
    if (!directory && isLocaleMessagesPath(normalized.segments) && entryExpandedSize > limits.maxLocaleMessagesBytes) {
      throw archiveLimitError("Extension locale messages exceed the metadata-file limit.");
    }
    cursor = recordEnd;
  }

  if (cursor !== bytes.byteLength) {
    throw archiveInvalidError("Extension archive central directory contains trailing or unreferenced data.");
  }
  if (manifestEntries.length === 0) {
    throw new ExtensionArchiveAnalysisError(
      "EXTENSION_ARCHIVE_MANIFEST_MISSING",
      "Extension archive does not contain an exact manifest.json file within the allowed depth.",
    );
  }
  if (manifestEntries.length !== 1) {
    throw new ExtensionArchiveAnalysisError(
      "EXTENSION_ARCHIVE_MANIFEST_AMBIGUOUS",
      "Extension archive contains multiple manifest.json files.",
    );
  }
  const filesystemNodeCount = pathKinds.size;
  if (filesystemNodeCount !== pathBudget.filesystemNodeCount) throw archiveInvalidError("Archive path budget is inconsistent.");
  const estimatedTemporaryBytes = expandedBytes + (filesystemNodeCount * limits.temporaryEntryOverheadBytes);
  if (!Number.isSafeInteger(estimatedTemporaryBytes) || estimatedTemporaryBytes > limits.maxTemporaryDiskBytes) {
    throw archiveLimitError("Extension archive exceeds the temporary-disk budget.");
  }

  return {
    entries,
    manifestEntry: manifestEntries[0]!,
    centralDirectoryOffset,
    compressedBytes,
    expandedBytes,
    fileCount,
    filesystemNodeCount,
  };
}

function validateGeneralPurposeFlags(flags: number, compressionMethod: number): void {
  if ((flags & ENCRYPTED_FLAGS) !== 0) {
    throw new ExtensionArchiveAnalysisError(
      "EXTENSION_ARCHIVE_ENCRYPTED",
      "Encrypted extension archives are not supported.",
    );
  }
  if ((flags & ~ALLOWED_GENERAL_FLAGS) !== 0 || (compressionMethod === 0 && (flags & 0x0006) !== 0)) {
    throw archiveUnsupportedError("Extension archive uses unsupported ZIP flags.");
  }
}

function parseExtraFields(bytes: Buffer): Map<number, Buffer> {
  const fields = new Map<number, Buffer>();
  let offset = 0;
  while (offset < bytes.byteLength) {
    if (offset + 4 > bytes.byteLength) throw archiveInvalidError("Extension archive extra field is truncated.");
    const id = bytes.readUInt16LE(offset);
    const size = bytes.readUInt16LE(offset + 2);
    const end = offset + 4 + size;
    if (end > bytes.byteLength) throw archiveInvalidError("Extension archive extra field length is invalid.");
    if (fields.has(id)) throw archiveInvalidError("Extension archive repeats an ambiguous extra field.");
    fields.set(id, bytes.subarray(offset + 4, end));
    offset = end;
  }
  return fields;
}

function decodeEntryName(rawName: Buffer, flags: number, extraFields: Map<number, Buffer>): string {
  let primary: string;
  if ((flags & UTF8_FLAG) !== 0) {
    primary = decodeUtf8(rawName, "Extension archive entry path is not valid UTF-8.");
  } else {
    if ([...rawName].some((byte) => byte > 0x7f)) {
      primary = "";
    } else {
      primary = rawName.toString("ascii");
    }
  }

  const unicodePath = extraFields.get(UNICODE_PATH_EXTRA_FIELD);
  if (!unicodePath) {
    if (!primary) {
      throw archiveUnsupportedError("Non-ASCII ZIP paths require a valid Unicode path field.");
    }
    return primary;
  }
  if (unicodePath.byteLength < 6 || unicodePath[0] !== 1) {
    throw archiveInvalidError("Extension archive Unicode path field is invalid.");
  }
  if (unicodePath.readUInt32LE(1) !== crc32Of(rawName)) {
    throw archiveInvalidError("Extension archive Unicode path field does not match its entry name.");
  }
  const decodedUnicode = decodeUtf8(
    unicodePath.subarray(5),
    "Extension archive Unicode path field is not valid UTF-8.",
  );
  if (primary && (flags & UTF8_FLAG) !== 0 && primary.normalize("NFC") !== decodedUnicode.normalize("NFC")) {
    throw archiveInvalidError("Extension archive contains conflicting entry path encodings.");
  }
  return decodedUnicode;
}

function decodeUtf8(bytes: Uint8Array, message: string): string {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw archiveInvalidError(message);
  }
}

function classifyEntryKind(name: string, creatorSystem: number, externalAttributes: number): boolean {
  const unixMode = externalAttributes >>> 16;
  const unixFileType = unixMode & UNIX_FILE_TYPE_MASK;
  const nameMarksDirectory = name.endsWith("/");
  const attributesMarkDirectory = (externalAttributes & DOS_DIRECTORY_ATTRIBUTE) !== 0;
  const unixMarksDirectory = unixFileType === UNIX_DIRECTORY;
  const unixMarksRegular = unixFileType === UNIX_REGULAR_FILE;

  if ((externalAttributes & WINDOWS_REPARSE_POINT_ATTRIBUTE) !== 0) {
    throw archiveLinkError("Extension archive contains a reparse-point entry.");
  }
  if ((externalAttributes & DOS_VOLUME_ATTRIBUTE) !== 0) {
    throw archiveLinkError("Extension archive contains a special filesystem entry.");
  }
  if (unixFileType !== 0 && !unixMarksDirectory && !unixMarksRegular) {
    throw archiveLinkError("Extension archive contains a symbolic link or special filesystem entry.");
  }
  if (creatorSystem === 3 && unixMarksRegular && nameMarksDirectory) {
    throw archiveInvalidError("Extension archive entry type conflicts with its path.");
  }
  if (creatorSystem === 3 && unixMarksDirectory && !nameMarksDirectory && !attributesMarkDirectory) {
    throw archiveInvalidError("Extension archive directory metadata is ambiguous.");
  }
  return nameMarksDirectory || attributesMarkDirectory || unixMarksDirectory;
}

function normalizeEntryPath(
  decodedName: string,
  directory: boolean,
  limits: ExtensionArchiveLimits,
): NormalizedPath {
  if (!decodedName || decodedName.includes("\\")) {
    throw archivePathError("Extension archive contains an unsafe path separator.");
  }
  if (decodedName.startsWith("/") || decodedName.startsWith("//") || /^[a-z]:/i.test(decodedName)) {
    throw archivePathError("Extension archive contains an absolute, drive, or UNC path.");
  }
  const withoutDirectoryMarker = directory && decodedName.endsWith("/")
    ? decodedName.slice(0, -1)
    : decodedName;
  if (!withoutDirectoryMarker || (!directory && decodedName.endsWith("/"))) {
    throw archivePathError("Extension archive entry path is invalid.");
  }
  const segments = withoutDirectoryMarker.normalize("NFC").split("/");
  if (segments.length > limits.maxPathDepth) {
    throw archiveLimitError("Extension archive entry path exceeds the depth limit.");
  }
  for (const segment of segments) validatePathSegment(segment);
  const value = segments.join("/");
  if (Buffer.byteLength(value, "utf8") > limits.maxPathBytes) {
    throw archiveLimitError("Extension archive entry path exceeds the byte limit after normalization.");
  }
  return { value, segments };
}

function validatePathSegment(segment: string): void {
  if (!segment || segment === "." || segment === "..") {
    throw archivePathError("Extension archive contains traversal or empty path segments.");
  }
  if (WINDOWS_FORBIDDEN_CHARACTERS.test(segment) || segment.includes(":")) {
    throw archivePathError("Extension archive contains a Windows-unsafe or alternate-stream path.");
  }
  if (/[. ]$/.test(segment)) {
    throw archivePathError("Extension archive contains a path ending in a dot or space.");
  }
  const basename = segment.split(".", 1)[0]!;
  if (WINDOWS_RESERVED_BASENAME.test(basename)) {
    throw archivePathError("Extension archive contains a reserved Windows device path.");
  }
}

function registerArchivePath(
  normalized: NormalizedPath,
  kind: PathKind,
  explicitPaths: Set<string>,
  pathKinds: Map<string, PathKind>,
  windowsPaths: Map<string, string>,
  budget: ArchivePathBudget,
  limits: ExtensionArchiveLimits,
): void {
  if (explicitPaths.has(normalized.value)) {
    throw archiveCollisionError("Extension archive contains duplicate normalized paths.");
  }
  explicitPaths.add(normalized.value);
  for (let length = 1; length <= normalized.segments.length; length += 1) {
    const candidate = normalized.segments.slice(0, length).join("/");
    const candidateKind: PathKind = length === normalized.segments.length ? kind : "directory";
    const existingKind = pathKinds.get(candidate);
    if (existingKind && existingKind !== candidateKind) {
      throw archiveCollisionError("Extension archive contains a file/directory path collision.");
    }
    const windowsKey = candidate.toLowerCase();
    const existingWindowsPath = windowsPaths.get(windowsKey);
    if (existingWindowsPath && existingWindowsPath !== candidate) {
      throw archiveCollisionError("Extension archive contains a Windows case-insensitive path collision.");
    }
    if (!existingKind) {
      const candidateBytes = Buffer.byteLength(candidate, "utf8");
      if (budget.filesystemNodeCount >= limits.maxFilesystemNodes) {
        throw archiveLimitError("Extension archive expands to too many filesystem nodes.");
      }
      if (budget.pathBytes > limits.maxFilesystemPathBytes - candidateBytes) {
        throw archiveLimitError("Extension archive path prefixes exceed the allocation budget.");
      }
      budget.filesystemNodeCount += 1;
      budget.pathBytes += candidateBytes;
    }
    pathKinds.set(candidate, candidateKind);
    windowsPaths.set(windowsKey, candidate);
  }
}

function isLocaleMessagesPath(segments: readonly string[]): boolean {
  return segments.length >= 3
    && segments.at(-3) === "_locales"
    && segments.at(-1) === "messages.json";
}

function checkedTotal(current: number, addition: number, limit: number, message: string): number {
  const total = current + addition;
  if (!Number.isSafeInteger(total) || total > limit) throw archiveLimitError(message);
  return total;
}

async function validateLocalRecords(
  source: ArchiveSource,
  entries: ZipEntry[],
  centralDirectoryOffset: number,
  limits: ExtensionArchiveLimits,
  signal?: AbortSignal,
): Promise<void> {
  const ordered = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  if (ordered[0]?.localHeaderOffset !== 0) {
    throw archiveInvalidError("Extension ZIP payload contains an unreferenced prefix.");
  }
  let expectedOffset = 0;
  for (const [index, entry] of ordered.entries()) {
    throwIfAborted(signal);
    if (entry.localHeaderOffset !== expectedOffset) {
      const repeatedOffset = entry.localHeaderOffset < expectedOffset;
      if (repeatedOffset) {
        throw archiveLinkError("Extension archive contains overlapping or shared entry data.");
      }
      throw archiveInvalidError("Extension archive contains unreferenced data between entries.");
    }
    const fixed = await source.read(entry.localHeaderOffset, ZIP_LOCAL_HEADER_BYTES);
    if (fixed.readUInt32LE(0) !== ZIP_LOCAL_FILE_HEADER) {
      throw archiveInvalidError("Extension archive local file header is invalid.");
    }
    const localFlags = fixed.readUInt16LE(6);
    const localCompressionMethod = fixed.readUInt16LE(8);
    const localCrc32 = fixed.readUInt32LE(14);
    const localCompressedSize = fixed.readUInt32LE(18);
    const localExpandedSize = fixed.readUInt32LE(22);
    const localNameLength = fixed.readUInt16LE(26);
    const localExtraLength = fixed.readUInt16LE(28);
    const variableLength = localNameLength + localExtraLength;
    if (
      entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES > centralDirectoryOffset
      || variableLength > centralDirectoryOffset - entry.localHeaderOffset - ZIP_LOCAL_HEADER_BYTES
    ) {
      throw archiveInvalidError("Extension archive local file header is truncated.");
    }
    const variable = await source.read(entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES, variableLength);
    const localName = variable.subarray(0, localNameLength);
    const localExtras = parseExtraFields(variable.subarray(localNameLength));
    if (localExtras.has(ZIP64_EXTRA_FIELD)) {
      throw archiveUnsupportedError("ZIP64 extension packages are not supported.");
    }
    if (!localName.equals(entry.rawName)) {
      throw archiveInvalidError("Extension archive local and central entry paths disagree.");
    }
    if (localFlags !== entry.flags || localCompressionMethod !== entry.compressionMethod) {
      throw archiveInvalidError("Extension archive local and central compression metadata disagree.");
    }
    const localDecodedName = decodeEntryName(localName, localFlags, localExtras);
    const localNormalized = normalizeEntryPath(localDecodedName, entry.directory, limits);
    if (localNormalized.value !== entry.normalizedPath) {
      throw archiveInvalidError("Extension archive local and central path encodings disagree.");
    }
    const usesDescriptor = (entry.flags & DATA_DESCRIPTOR_FLAG) !== 0;
    if (!usesDescriptor) {
      if (
        localCrc32 !== entry.crc32
        || localCompressedSize !== entry.compressedSize
        || localExpandedSize !== entry.expandedSize
      ) {
        throw archiveInvalidError("Extension archive local and central sizes or checksum disagree.");
      }
    } else if (
      (localCrc32 !== 0 && localCrc32 !== entry.crc32)
      || (localCompressedSize !== 0 && localCompressedSize !== entry.compressedSize)
      || (localExpandedSize !== 0 && localExpandedSize !== entry.expandedSize)
    ) {
      throw archiveInvalidError("Extension archive data-descriptor metadata is inconsistent.");
    }

    const dataOffset = entry.localHeaderOffset + ZIP_LOCAL_HEADER_BYTES + variableLength;
    if (entry.compressedSize > centralDirectoryOffset - dataOffset) {
      throw archiveInvalidError("Extension archive entry data is truncated.");
    }
    let rangeEnd = dataOffset + entry.compressedSize;
    if (usesDescriptor) {
      const nextRecordOffset = ordered[index + 1]?.localHeaderOffset ?? centralDirectoryOffset;
      rangeEnd = await validateDataDescriptor(source, rangeEnd, nextRecordOffset, entry);
    }
    entry.dataOffset = dataOffset;
    entry.rangeEnd = rangeEnd;
    expectedOffset = rangeEnd;
  }
  if (expectedOffset !== centralDirectoryOffset) {
    throw archiveInvalidError("Extension archive contains unreferenced data before its central directory.");
  }
}

async function validateDataDescriptor(
  source: ArchiveSource,
  descriptorOffset: number,
  nextRecordOffset: number,
  entry: ZipEntry,
): Promise<number> {
  if (nextRecordOffset - descriptorOffset < 12) {
    throw archiveInvalidError("Extension archive data descriptor is truncated.");
  }
  const available = Math.min(16, nextRecordOffset - descriptorOffset);
  const descriptor = await source.read(descriptorOffset, available);
  const signaturelessMatches = nextRecordOffset === descriptorOffset + 12
    && descriptor.readUInt32LE(0) === entry.crc32
    && descriptor.readUInt32LE(4) === entry.compressedSize
    && descriptor.readUInt32LE(8) === entry.expandedSize;
  if (signaturelessMatches) return descriptorOffset + 12;
  const signedMatches = descriptor.byteLength >= 16
    && nextRecordOffset === descriptorOffset + 16
    && descriptor.readUInt32LE(0) === ZIP_DATA_DESCRIPTOR
    && descriptor.readUInt32LE(4) === entry.crc32
    && descriptor.readUInt32LE(8) === entry.compressedSize
    && descriptor.readUInt32LE(12) === entry.expandedSize;
  if (signedMatches) return descriptorOffset + 16;
  throw archiveInvalidError("Extension archive data descriptor is invalid.");
}

async function extractEntries(
  source: ArchiveSource,
  entries: ZipEntry[],
  filesystemNodeCount: number,
  outputDir: string,
  limits: ExtensionArchiveLimits,
  signal?: AbortSignal,
): Promise<void> {
  const budget: ExtractionBudget = { expandedBytes: 0, filesystemNodeCount };
  const ordered = [...entries].sort((left, right) => left.localHeaderOffset - right.localHeaderOffset);
  for (const entry of ordered) {
    throwIfAborted(signal);
    const target = path.join(outputDir, ...entry.segments);
    assertPathContained(outputDir, target);
    if (entry.directory) {
      await validateDirectoryEntryData(source, entry, signal);
      await fs.mkdir(target, { recursive: true, mode: 0o700 });
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await extractFileEntry(source, entry, target, budget, limits, signal);
  }
  const expectedExpandedBytes = entries.reduce(
    (total, entry) => total + (entry.directory ? 0 : entry.expandedSize),
    0,
  );
  if (budget.expandedBytes !== expectedExpandedBytes) {
    throw archiveInvalidError("Extension archive expanded-byte total is inconsistent.");
  }
}

async function validateDirectoryEntryData(
  source: ArchiveSource,
  entry: ZipEntry,
  signal?: AbortSignal,
): Promise<void> {
  if (entry.dataOffset === undefined) throw archiveInvalidError("Extension archive entry was not fully validated.");
  const input = source.stream(entry.dataOffset, entry.compressedSize, signal);
  const inflater = entry.compressionMethod === 8 ? createInflateRaw() : undefined;
  inflater?.on("error", () => undefined);
  const forwardInputError = (error: Error): void => {
    inflater?.destroy(error);
  };
  input.on("error", forwardInputError);
  const readable = inflater ? input.pipe(inflater) : input;
  try {
    for await (const value of readable) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      if (chunk.byteLength !== 0) {
        throw archiveInvalidError("Extension archive directory entry expands to file data.");
      }
    }
    if (inflater && inflater.bytesWritten !== entry.compressedSize) {
      throw archiveInvalidError("Extension archive directory compression stream contains trailing data.");
    }
  } catch (error) {
    if (isCancellation(error, signal)) throw acquisitionCancelledError();
    if (error instanceof ExtensionArchiveAnalysisError) throw error;
    throw archiveInvalidError("Extension archive directory entry is corrupt or truncated.");
  } finally {
    input.destroy();
    inflater?.destroy();
  }
}

async function extractFileEntry(
  source: ArchiveSource,
  entry: ZipEntry,
  target: string,
  budget: ExtractionBudget,
  limits: ExtensionArchiveLimits,
  signal?: AbortSignal,
): Promise<void> {
  if (entry.dataOffset === undefined) throw archiveInvalidError("Extension archive entry was not fully validated.");
  const input = source.stream(entry.dataOffset, entry.compressedSize, signal);
  const inflater = entry.compressionMethod === 8 ? createInflateRaw() : undefined;
  inflater?.on("error", () => undefined);
  const forwardInputError = (error: Error): void => {
    inflater?.destroy(error);
  };
  input.on("error", forwardInputError);
  const readable = inflater ? input.pipe(inflater) : input;
  let output: FileHandle | undefined;
  let expandedBytes = 0;
  const crc = new StreamingCrc32();

  try {
    output = await fs.open(target, "wx", 0o600);
    for await (const value of readable) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      expandedBytes += chunk.byteLength;
      if (expandedBytes > entry.expandedSize || expandedBytes > limits.maxFileExpandedBytes) {
        throw archiveLimitError("Extension archive expanded beyond its declared per-file size.");
      }
      budget.expandedBytes += chunk.byteLength;
      const temporaryBytes = budget.expandedBytes
        + (limits.temporaryEntryOverheadBytes * budget.filesystemNodeCount);
      if (
        budget.expandedBytes > limits.maxTotalExpandedBytes
        || temporaryBytes > limits.maxTemporaryDiskBytes
      ) {
        throw archiveLimitError("Extension archive exceeded its expanded or temporary-disk budget.");
      }
      crc.update(chunk);
      await writeAll(output, chunk);
    }
    if (inflater && inflater.bytesWritten !== entry.compressedSize) {
      throw archiveInvalidError("Extension archive compression stream contains trailing data.");
    }
    if (expandedBytes !== entry.expandedSize || crc.digest() !== entry.crc32) {
      throw archiveInvalidError("Extension archive entry size or CRC-32 checksum is invalid.");
    }
  } catch (error) {
    if (isCancellation(error, signal)) throw acquisitionCancelledError();
    if (error instanceof ExtensionArchiveAnalysisError) throw error;
    throw archiveInvalidError("Extension archive entry is corrupt or truncated.");
  } finally {
    input.destroy();
    inflater?.destroy();
    await output?.close().catch(() => undefined);
    if (expandedBytes !== entry.expandedSize || crc.digest() !== entry.crc32) {
      await fs.rm(target, { force: true }).catch(() => undefined);
    }
  }
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (bytesWritten <= 0) throw archiveInvalidError("Extension staging file could not be written.");
    offset += bytesWritten;
  }
}

async function collectStagedTreeNodes(
  root: string,
  canonicalRoot: string,
  relativeDirectory: string,
  nodes: StagedTreeNode[],
  budget: TreeCollectionBudget,
  maxFiles: number,
  maxFilesystemNodes: number,
  maxExpandedBytes: number,
  maxPathBytes: number,
  maxPathDepth: number,
  maxTotalPathBytes: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const currentPath = relativeDirectory
    ? path.join(root, ...relativeDirectory.split("/"))
    : root;
  const beforeStats = await safeLstat(currentPath, "Staged extension directory is missing or unreadable.");
  if (!beforeStats.isDirectory() || beforeStats.isSymbolicLink()) {
    throw archiveLinkError("Staged extension tree contains a linked or non-directory parent.");
  }
  const beforeIdentity = nodeIdentity(beforeStats);
  const canonicalCurrent = await safeRealpath(currentPath);
  if (!isCanonicalPathInside(canonicalCurrent, canonicalRoot, relativeDirectory === "")) {
    throw archiveLinkError("Staged extension directory escapes its canonical root.");
  }
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    throw archiveInvalidError("Staged extension tree is missing or unreadable.");
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.name, "utf8"), Buffer.from(right.name, "utf8")));
  for (const entry of entries) {
    throwIfAborted(signal);
    const normalizedName = entry.name.normalize("NFC");
    if (normalizedName !== entry.name) {
      throw archiveCollisionError("Staged extension tree contains a non-normalized path.");
    }
    validatePathSegment(normalizedName);
    const relativePath = relativeDirectory ? `${relativeDirectory}/${normalizedName}` : normalizedName;
    registerStagedNodeBudget(
      relativePath,
      budget,
      maxFilesystemNodes,
      maxPathBytes,
      maxPathDepth,
      maxTotalPathBytes,
    );
    const absolutePath = path.join(root, ...relativePath.split("/"));
    const stats = await safeLstat(absolutePath, "Staged extension entry is missing or unreadable.");
    if (stats.isSymbolicLink()) {
      throw archiveLinkError("Staged extension tree contains a symbolic link.");
    }
    const canonicalPath = await safeRealpath(absolutePath);
    if (!isCanonicalPathInside(canonicalPath, canonicalRoot, false)) {
      throw archiveLinkError("Staged extension entry escapes its canonical root.");
    }
    if (stats.isDirectory()) {
      nodes.push({
        absolutePath,
        relativePath,
        kind: "directory",
        size: 0,
        identity: nodeIdentity(stats),
        canonicalPath,
      });
      await collectStagedTreeNodes(
        root,
        canonicalRoot,
        relativePath,
        nodes,
        budget,
        maxFiles,
        maxFilesystemNodes,
        maxExpandedBytes,
        maxPathBytes,
        maxPathDepth,
        maxTotalPathBytes,
        signal,
      );
      continue;
    }
    if (!stats.isFile()) {
      throw archiveLinkError("Staged extension tree contains a special filesystem node.");
    }
    if (stats.nlink !== 1) {
      throw archiveLinkError("Staged extension tree contains a hard-linked file.");
    }
    if (budget.fileCount >= maxFiles) throw archiveLimitError("Staged extension tree contains too many files.");
    budget.fileCount += 1;
    budget.expandedBytes += stats.size;
    if (!Number.isSafeInteger(budget.expandedBytes) || budget.expandedBytes > maxExpandedBytes) {
      throw archiveLimitError("Staged extension tree exceeds the expanded-byte limit.");
    }
    nodes.push({
      absolutePath,
      relativePath,
      kind: "file",
      size: stats.size,
      identity: nodeIdentity(stats),
      canonicalPath,
    });
  }
  assertSameNodeIdentity(
    beforeIdentity,
    nodeIdentity(await safeLstat(currentPath, "Staged extension directory changed during traversal.")),
  );
  if (await safeRealpath(currentPath) !== canonicalCurrent) {
    throw archiveLinkError("Staged extension directory changed or became linked during traversal.");
  }
}

function registerStagedNodeBudget(
  relativePath: string,
  budget: TreeCollectionBudget,
  maxFilesystemNodes: number,
  maxPathBytes: number,
  maxPathDepth: number,
  maxTotalPathBytes: number,
): void {
  const pathBytes = Buffer.byteLength(relativePath, "utf8");
  if (pathBytes > maxPathBytes) throw archiveLimitError("Staged extension path exceeds the byte limit.");
  if (relativePath.split("/").length > maxPathDepth) {
    throw archiveLimitError("Staged extension path exceeds the depth limit.");
  }
  if (budget.filesystemNodeCount >= maxFilesystemNodes) {
    throw archiveLimitError("Staged extension tree contains too many filesystem nodes.");
  }
  if (budget.pathBytes > maxTotalPathBytes - pathBytes) {
    throw archiveLimitError("Staged extension path prefixes exceed the allocation budget.");
  }
  const windowsKey = relativePath.toLowerCase();
  const existing = budget.windowsPaths.get(windowsKey);
  if (existing && existing !== relativePath) {
    throw archiveCollisionError("Staged extension tree contains a Windows case-insensitive path collision.");
  }
  budget.windowsPaths.set(windowsKey, relativePath);
  budget.filesystemNodeCount += 1;
  budget.pathBytes += pathBytes;
}

async function fingerprintStagedFile(node: StagedTreeNode, signal?: AbortSignal): Promise<Buffer> {
  if (await safeRealpath(node.absolutePath) !== node.canonicalPath) {
    throw archiveLinkError("Staged extension file changed or became linked during fingerprinting.");
  }
  const fileHash = createHash("sha256");
  const handle = await fs.open(node.absolutePath, "r");
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1) {
      throw archiveLinkError("Staged extension file is linked or no longer regular.");
    }
    assertSameNodeIdentity(node.identity, nodeIdentity(before));
    const stream = handle.createReadStream({ autoClose: false, signal });
    let consumed = 0;
    for await (const value of stream) {
      throwIfAborted(signal);
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      consumed += chunk.byteLength;
      if (consumed > node.size) throw archiveInvalidError("Staged extension file grew during fingerprinting.");
      fileHash.update(chunk);
    }
    const after = await handle.stat();
    assertSameNodeIdentity(node.identity, nodeIdentity(after));
    if (consumed !== node.size) throw archiveInvalidError("Staged extension file changed during fingerprinting.");
  } finally {
    await handle.close().catch(() => undefined);
  }
  return fileHash.digest();
}

async function safeLstat(target: string, message: string): Promise<Stats> {
  try {
    return await fs.lstat(target);
  } catch {
    throw archiveInvalidError(message);
  }
}

async function safeRealpath(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch {
    throw archiveLinkError("Staged extension path cannot be resolved without following an unsafe link.");
  }
}

function nodeIdentity(stats: Stats): NodeIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function assertSameNodeIdentity(expected: NodeIdentity, actual: NodeIdentity): void {
  if (
    expected.dev !== actual.dev
    || expected.ino !== actual.ino
    || expected.size !== actual.size
    || expected.mtimeMs !== actual.mtimeMs
    || expected.ctimeMs !== actual.ctimeMs
  ) {
    throw archiveInvalidError("Staged extension filesystem node changed during analysis.");
  }
}

function isCanonicalPathInside(target: string, root: string, allowRoot: boolean): boolean {
  const comparableTarget = process.platform === "win32" ? target.toLowerCase() : target;
  const comparableRoot = process.platform === "win32" ? root.toLowerCase() : root;
  return (allowRoot && comparableTarget === comparableRoot)
    || comparableTarget.startsWith(`${comparableRoot}${path.sep}`);
}

function countStagedFilesystemNodes(entries: ZipEntry[], rootSegments: readonly string[]): number {
  const nodes = new Set<string>();
  for (const entry of entries) {
    if (!isEntryInsideRoot(entry.segments, rootSegments)) continue;
    const relativeSegments = entry.segments.slice(rootSegments.length);
    for (let length = 1; length <= relativeSegments.length; length += 1) {
      nodes.add(relativeSegments.slice(0, length).join("/"));
    }
  }
  return nodes.size;
}

function isEntryInsideRoot(entrySegments: readonly string[], rootSegments: readonly string[]): boolean {
  return rootSegments.every((segment, index) => entrySegments[index] === segment);
}

function assertPathContained(root: string, target: string): void {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const comparableRoot = process.platform === "win32" ? resolvedRoot.toLowerCase() : resolvedRoot;
  const comparableTarget = process.platform === "win32" ? resolvedTarget.toLowerCase() : resolvedTarget;
  if (comparableTarget === comparableRoot || !comparableTarget.startsWith(`${comparableRoot}${path.sep}`)) {
    throw archivePathError("Extension archive entry resolves outside its staging directory.");
  }
}

class StreamingCrc32 {
  private value = 0xffffffff;

  update(bytes: Uint8Array): void {
    let current = this.value;
    for (const byte of bytes) current = CRC32_TABLE[(current ^ byte) & 0xff]! ^ (current >>> 8);
    this.value = current;
  }

  digest(): number {
    return (this.value ^ 0xffffffff) >>> 0;
  }
}

function crc32Of(bytes: Uint8Array): number {
  const crc = new StreamingCrc32();
  crc.update(bytes);
  return crc.digest();
}

function createCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function uint32Buffer(value: number): Buffer {
  const output = Buffer.allocUnsafe(4);
  output.writeUInt32LE(value, 0);
  return output;
}

function uint64Buffer(value: number): Buffer {
  const output = Buffer.allocUnsafe(8);
  output.writeBigUInt64LE(BigInt(value), 0);
  return output;
}

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
  return value;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw acquisitionCancelledError();
}

function isCancellation(error: unknown, signal: AbortSignal | undefined): boolean {
  return Boolean(
    signal?.aborted
    || (error instanceof ExtensionArchiveAnalysisError && error.code === "ACQUISITION_CANCELLED")
    || (error instanceof Error && error.name === "AbortError"),
  );
}

function normalizeArchiveFailure(error: unknown): ExtensionArchiveAnalysisError {
  if (error instanceof ExtensionArchiveAnalysisError) return error;
  if (error instanceof Error && error.name === "AbortError") return acquisitionCancelledError();
  return archiveInvalidError("Extension archive could not be read or safely staged.");
}

function acquisitionCancelledError(): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("ACQUISITION_CANCELLED", "Extension package analysis was cancelled.");
}

function archiveInvalidError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_INVALID", message);
}

function archiveUnsupportedError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_UNSUPPORTED", message);
}

function archiveLimitError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_LIMIT_EXCEEDED", message);
}

function archivePathError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_PATH_UNSAFE", message);
}

function archiveCollisionError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_PATH_COLLISION", message);
}

function archiveLinkError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_LINK_FORBIDDEN", message);
}

function archiveStageError(message: string): ExtensionArchiveAnalysisError {
  return new ExtensionArchiveAnalysisError("EXTENSION_ARCHIVE_STAGE_INVALID", message);
}
