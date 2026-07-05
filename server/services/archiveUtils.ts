import { createReadStream, createWriteStream, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { AsyncZipDeflate, Unzip, UnzipInflate, Zip, type UnzipFile } from "fflate";

export type ArchiveEntry = {
  archivePath: string;
  filePath?: string;
  bytes?: Uint8Array;
};

const TEXT_ENCODER = new TextEncoder();
const TEXT_DECODER = new TextDecoder();

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

export async function extractZipArchive(inputPath: string, outputDir: string, unsafeMessage: string): Promise<void> {
  const writes: Promise<void>[] = [];
  const unzip = new Unzip((file) => {
    if (!isSafeArchivePath(file.name)) {
      throw Object.assign(new Error(unsafeMessage), { status: 400 });
    }
    const normalizedName = normalizeArchivePath(file.name);
    if (!normalizedName || normalizedName.endsWith("/")) return;
    const write = writeUnzipFile(file, safeJoin(outputDir, normalizedName, unsafeMessage));
    writes.push(write);
  });
  unzip.register(UnzipInflate);
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(inputPath);
    input.on("data", (chunk) => {
      try {
        unzip.push(chunk instanceof Uint8Array ? chunk : Buffer.from(chunk), false);
      } catch (error) {
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
  await Promise.all(writes);
}

export async function readJsonArchiveFile(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(TEXT_DECODER.decode(await fs.readFile(filePath)));
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
  if (rawPath.startsWith("/") || path.isAbsolute(relativePath) || /^[a-z]:\//i.test(rawPath)) return false;
  const normalizedPath = normalizeArchivePath(relativePath);
  if (!normalizedPath || normalizedPath.startsWith("/") || path.isAbsolute(normalizedPath)) return false;
  return !normalizedPath.split("/").some((part) => part === ".." || part === "");
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

function writeUnzipFile(file: UnzipFile, targetPath: string): Promise<void> {
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

function safeJoin(root: string, relativePath: string, unsafeMessage: string): string {
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
