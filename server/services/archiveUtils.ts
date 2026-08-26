import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncZipDeflate, Unzip, UnzipInflate, Zip, type UnzipFile } from "fflate";

export type ArchiveEntry = {
  archivePath: string;
  filePath?: string;
  bytes?: Uint8Array;
};

export type ArchiveExtractionLimits = {
  maxArchiveBytes?: number;
  maxEntries?: number;
  maxFileExpandedBytes?: number;
  maxTotalExpandedBytes?: number;
  maxTemporaryDiskBytes?: number;
  temporaryEntryOverheadBytes?: number;
  maxPathBytes?: number;
  maxPathDepth?: number;
  maxTotalPathBytes?: number;
  maxFilesystemNodes?: number;
};

const DEFAULT_EXTRACTION_LIMITS: Required<ArchiveExtractionLimits> = Object.freeze({
  maxArchiveBytes: 256 * 1024 * 1024,
  maxEntries: 50_000,
  maxFileExpandedBytes: 128 * 1024 * 1024,
  maxTotalExpandedBytes: 640 * 1024 * 1024,
  maxTemporaryDiskBytes: 768 * 1024 * 1024,
  temporaryEntryOverheadBytes: 4096,
  maxPathBytes: 1024,
  maxPathDepth: 32,
  maxTotalPathBytes: 32 * 1024 * 1024,
  maxFilesystemNodes: 50_000,
});

const TEXT_ENCODER = new TextEncoder();

export function jsonArchiveEntry(archivePath: string, value: unknown): ArchiveEntry {
  return {
    archivePath,
    bytes: TEXT_ENCODER.encode(`${JSON.stringify(value, null, 2)}\n`),
  };
}

export async function directoryArchiveEntries(root: string, archiveRoot: string): Promise<ArchiveEntry[]> {
  const entries: ArchiveEntry[] = [];
  await collectDirectoryEntries(path.resolve(root), normalizeArchivePath(archiveRoot), entries);
  return entries;
}

export async function writeZipArchive(
  outputPath: string,
  entries: ArchiveEntry[],
  onProgress: (current: number, total: number, archivePath: string) => void,
): Promise<void> {
  const tempPath = `${outputPath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const output = createWriteStream(tempPath);
  let failed: Error | undefined;
  const zip = new Zip((error, data, final) => {
    if (error) {
      failed = error;
      output.destroy(error);
      return;
    }
    output.write(data, () => {
      if (final) output.end();
    });
  });

  try {
    for (const [index, entry] of entries.entries()) {
      if (failed) throw failed;
      onProgress(index + 1, entries.length, entry.archivePath);
      await addZipEntry(zip, entry);
    }
    zip.end();
    await new Promise<void>((resolve, reject) => {
      output.once("finish", resolve);
      output.once("error", reject);
    });
    if (failed) throw failed;
    await fs.rename(tempPath, outputPath);
  } catch (error) {
    zip.terminate();
    output.destroy();
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function extractZipArchive(
  inputPath: string,
  outputDir: string,
  unsafeMessage: string,
  options: { limits?: ArchiveExtractionLimits } = {},
): Promise<void> {
  const limits = { ...DEFAULT_EXTRACTION_LIMITS, ...(options.limits ?? {}) };
  await assertOrdinaryExtractionRoot(outputDir);
  const writes: Promise<void>[] = [];
  const budget = { compressedBytes: 0, entries: 0, expandedBytes: 0, nodes: 0, totalPathBytes: 0 };
  let firstFailure: Error | undefined;
  const pathKinds = new Map<string, "file" | "directory">();
  const portablePaths = new Map<string, string>();
  const unzip = new Unzip((file) => {
    if (firstFailure) throw firstFailure;
    budget.entries += 1;
    if (budget.entries > limits.maxEntries) {
      firstFailure = archiveLimitError("Archive contains too many entries.");
      throw firstFailure;
    }
    if (!isSafeArchivePath(file.name)) {
      throw Object.assign(new Error(unsafeMessage), { status: 400 });
    }
    const normalizedName = normalizeArchivePath(file.name).normalize("NFC");
    budget.nodes += registerArchivePath(normalizedName, pathKinds, portablePaths, unsafeMessage, limits, budget);
    if (budget.nodes > limits.maxFilesystemNodes) {
      firstFailure = archiveLimitError("Archive expands to too many filesystem nodes.");
      throw firstFailure;
    }
    if (!normalizedName || normalizedName.endsWith("/")) return;
    const write = writeUnzipFile(
      file,
      safeJoin(outputDir, normalizedName, unsafeMessage),
      (bytes, fileBytes) => {
        budget.expandedBytes += bytes;
        if (
          fileBytes > limits.maxFileExpandedBytes
          || budget.expandedBytes > limits.maxTotalExpandedBytes
          || budget.expandedBytes + (budget.nodes * limits.temporaryEntryOverheadBytes) > limits.maxTemporaryDiskBytes
        ) {
          firstFailure = archiveLimitError("Archive exceeds the bounded extraction budget.");
          throw firstFailure;
        }
      },
    );
    writes.push(write);
  });
  unzip.register(UnzipInflate);
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(inputPath);
    input.on("data", (chunk) => {
      try {
        const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
        budget.compressedBytes += bytes.byteLength;
        if (budget.compressedBytes > limits.maxArchiveBytes) {
          firstFailure = archiveLimitError("Archive exceeds the compressed-byte limit.");
          input.destroy(firstFailure);
          return;
        }
        unzip.push(bytes, false);
      } catch (error) {
        firstFailure = error as Error;
        input.destroy(error as Error);
      }
    });
    input.once("end", () => {
      try {
        unzip.push(new Uint8Array(), true);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    input.once("error", reject);
  });
  try {
    await Promise.all(writes);
  } catch (error) {
    throw firstFailure ?? error;
  }
}

function archiveLimitError(message: string): Error {
  return Object.assign(new Error(message), { status: 400, code: "ARCHIVE_RESOURCE_LIMIT" });
}

async function assertOrdinaryExtractionRoot(root: string): Promise<void> {
  const absolute = path.resolve(root);
  await fs.mkdir(absolute, { recursive: true });
  const stats = await fs.lstat(absolute);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw Object.assign(new Error("Archive extraction root must be an ordinary directory."), { status: 400 });
  }
  if (await fs.realpath(absolute) !== absolute) {
    throw Object.assign(new Error("Archive extraction root must not traverse a linked directory."), { status: 400 });
  }
}

function registerArchivePath(
  archivePath: string,
  pathKinds: Map<string, "file" | "directory">,
  portablePaths: Map<string, string>,
  unsafeMessage: string,
  limits: Required<ArchiveExtractionLimits>,
  budget: { totalPathBytes: number },
): number {
  const isDirectory = archivePath.endsWith("/");
  const segments = archivePath.replace(/\/$/, "").split("/");
  let added = 0;
  if (segments.length > limits.maxPathDepth) throw archiveLimitError("Archive path is too deep.");
  let cumulativeBytes = 0;
  for (let index = 1; index <= segments.length; index += 1) {
    cumulativeBytes += Buffer.byteLength(segments[index - 1] ?? "", "utf8") + (index > 1 ? 1 : 0);
    if (cumulativeBytes > limits.maxPathBytes || budget.totalPathBytes + cumulativeBytes > limits.maxTotalPathBytes) {
      throw archiveLimitError("Archive paths exceed the bounded path budget.");
    }
    const candidate = segments.slice(0, index).join("/");
    const kind = index === segments.length && !isDirectory ? "file" : "directory";
    const existing = pathKinds.get(candidate);
    if (existing && (existing !== kind || index === segments.length)) {
      throw Object.assign(new Error(unsafeMessage), { status: 400 });
    }
    const portableKey = candidate.toLowerCase();
    const portableExisting = portablePaths.get(portableKey);
    if (portableExisting && portableExisting !== candidate) {
      throw Object.assign(new Error(unsafeMessage), { status: 400 });
    }
    if (!existing) {
      pathKinds.set(candidate, kind);
      portablePaths.set(portableKey, candidate);
      added += 1;
    }
  }
  budget.totalPathBytes += cumulativeBytes;
  return added;
}

export async function readJsonArchiveFile(filePath: string, maxBytes = 16 * 1024 * 1024): Promise<unknown> {
  try {
    const stats = await fs.lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > maxBytes) {
      throw new Error("JSON archive entry exceeds its bounded size or is not a regular file");
    }
    const bytes = await fs.readFile(filePath);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(bytes);
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (error) {
    throw Object.assign(new Error(`Invalid package JSON ${path.basename(filePath)}: ${(error as Error).message}`), { status: 400 });
  }
}

export async function copyDirectory(source: string, target: string): Promise<void> {
  if (await pathExists(target)) {
    throw Object.assign(new Error(`Import target already exists: ${target}`), { status: 409 });
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(source, target, { recursive: true, force: false });
}

export async function replaceDirectory(source: string, target: string): Promise<void> {
  const tempTarget = `${target}.restore-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rm(tempTarget, { recursive: true, force: true });
  try {
    await fs.cp(source, tempTarget, { recursive: true, force: false });
    await fs.rm(target, { recursive: true, force: true });
    await fs.rename(tempTarget, target);
  } catch (error) {
    await fs.rm(tempTarget, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function pathExists(itemPath: string): Promise<boolean> {
  try {
    await fs.access(itemPath);
    return true;
  } catch {
    return false;
  }
}

export function normalizeArchivePath(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+/, "");
}

export function isSafeArchivePath(relativePath: string): boolean {
  const rawPath = relativePath.replace(/\\/g, "/");
  // `c:x` is drive-relative, not absolute, so path.isAbsolute misses it while path.resolve still
  // sends it to that drive's working directory. Any single-letter drive spec is rejected outright.
  if (rawPath.startsWith("/") || path.isAbsolute(relativePath) || /^[a-z]:/i.test(rawPath)) return false;
  const normalizedPath = normalizeArchivePath(relativePath);
  if (!normalizedPath || normalizedPath.startsWith("/") || path.isAbsolute(normalizedPath)) return false;
  if (/[\u0000-\u001f\u007f]/.test(normalizedPath)) return false;
  // A leading `./` (or the root marker `.`) is a conventional ZIP spelling and
  // remains contained after path.resolve. Interior dot segments are rejected.
  if (normalizedPath === ".") return true;
  const withoutLeadingDot = normalizedPath.startsWith("./") ? normalizedPath.slice(2) : normalizedPath;
  // A single trailing slash marks a directory entry and denotes the same path as the name without it.
  // Interior empty segments stay rejected: `a//b` is a malformed name, not a directory marker.
  return !withoutLeadingDot.replace(/\/$/, "").split("/").some((part) => (
    part === ".."
    || part === "."
    || part === ""
    || part.includes(":")
    || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
  ));
}

/**
 * Resolves an archive entry to an absolute path under `root`, or throws. The name check alone is not
 * enough — only comparing resolved paths proves containment — so every extraction goes through here
 * rather than trusting the archive library to normalize hostile names for us.
 */
export function safeJoin(root: string, relativePath: string, unsafeMessage: string): string {
  if (!isSafeArchivePath(relativePath)) {
    throw Object.assign(new Error(unsafeMessage), { status: 400 });
  }
  const targetPath = path.resolve(root, relativePath);
  const rootPath = path.resolve(root);
  const comparableTarget = process.platform === "win32" ? targetPath.toLowerCase() : targetPath;
  const comparableRoot = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  if (comparableTarget !== comparableRoot && !comparableTarget.startsWith(`${comparableRoot}${path.sep}`)) {
    throw Object.assign(new Error(unsafeMessage), { status: 400 });
  }
  return targetPath;
}

async function collectDirectoryEntries(root: string, archiveRoot: string, entries: ArchiveEntry[], current = root): Promise<void> {
  const dirents = await fs.readdir(current, { withFileTypes: true });
  for (const dirent of dirents) {
    const filePath = path.join(current, dirent.name);
    const relative = path.relative(root, filePath).replace(/\\/g, "/");
    const archivePath = normalizeArchivePath(`${archiveRoot}/${relative}`);
    if (dirent.isDirectory()) {
      await collectDirectoryEntries(root, archiveRoot, entries, filePath);
    } else if (dirent.isFile()) {
      entries.push({ archivePath, filePath });
    }
  }
}

async function addZipEntry(zip: Zip, entry: ArchiveEntry): Promise<void> {
  const file = new AsyncZipDeflate(entry.archivePath, { level: 6 });
  zip.add(file);
  if (entry.bytes) {
    file.push(entry.bytes, true);
    return;
  }
  if (!entry.filePath) {
    file.push(new Uint8Array(), true);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(entry.filePath as string);
    stream.on("data", (chunk) => file.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk)));
    stream.on("end", () => {
      file.push(new Uint8Array(), true);
      resolve();
    });
    stream.on("error", reject);
  });
}

function writeUnzipFile(file: UnzipFile, targetPath: string, onBytes?: (bytes: number, fileBytes: number) => void): Promise<void> {
  let fileBytes = 0;
  mkdirSync(path.dirname(targetPath), { recursive: true });
  const output = createWriteStream(targetPath);
  const done = new Promise<void>((resolve, reject) => {
    output.once("finish", resolve);
    output.once("error", reject);
  });
  file.ondata = (error, chunk, final) => {
    if (error) {
      output.destroy(error);
      return;
    }
    try {
      fileBytes += chunk.byteLength;
      onBytes?.(chunk.byteLength, fileBytes);
    } catch (budgetError) {
      output.destroy(budgetError as Error);
      return;
    }
    output.write(chunk, () => {
      if (final) output.end();
    });
  };
  try {
    file.start();
  } catch (error) {
    output.destroy(error as Error);
  }
  return done;
}
