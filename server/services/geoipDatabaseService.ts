import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { CLOAKBROWSER_GEOIP_DB_URL } from "../../src/shared/githubMirror";

// mmdb files carry this marker in their metadata section near the end. A truncated transfer does
// not, so a download that dies mid-stream cannot be promoted into a database every later launch
// then fails to parse.
const MMDB_METADATA_MARKER = "MaxMind.com";
const METADATA_TAIL_BYTES = 128 * 1024;

export type GeoipDatabaseEnsureOptions = {
  /** Aborting stops this caller waiting; a shared transfer keeps running for other launches. */
  signal?: AbortSignal;
  onProgress?: (receivedBytes: number) => void;
};

export type GeoipDatabaseEnsureResult = {
  path: string;
  downloaded: boolean;
};

/**
 * Fetches the ~70 MB GeoLite2 database into the browser core's cache when it is missing.
 *
 * Upstream's `ensureGeoipDb()` downloads it lazily from inside `maybeResolveGeoip()` — after the
 * launch already began, and before any browser process exists. Behind a slow proxy that transfer
 * outlasts the formal-launch budget, so the launch fails with a generic startup timeout and the
 * operator has no idea a 70 MB fetch was the reason. Doing it here makes the wait visible (progress
 * events) and cancellable independently of the formal-launch deadline.
 *
 * A failed download removes its partial file rather than leaving a truncated database behind: the
 * wrapper treats an existing file as authoritative and would fail every later `geoip: true` launch
 * trying to parse it.
 */
export class GeoipDatabaseService {
  /** One in-flight transfer process-wide, so concurrent launches share it instead of fetching twice. */
  private inFlight?: Promise<GeoipDatabaseEnsureResult>;
  private inFlightAbort?: AbortController;

  constructor(private readonly options: {
    databasePath: () => Promise<string>;
    fetchImpl?: typeof fetch;
    url?: string;
  }) {}

  async databasePath(): Promise<string> {
    return await this.options.databasePath();
  }

  async isPresent(): Promise<boolean> {
    return await isCompleteDatabase(await this.databasePath());
  }

  /**
   * Downloads the database unless a complete one is already cached. Returns `downloaded: false` when
   * the cached file was reused. Throws on failure — callers decide whether a launch may continue.
   */
  async ensure(options: GeoipDatabaseEnsureOptions = {}): Promise<GeoipDatabaseEnsureResult> {
    options.signal?.throwIfAborted();
    const dbPath = await this.databasePath();
    if (await isCompleteDatabase(dbPath)) return { path: dbPath, downloaded: false };

    if (this.inFlight) return await withAbort(this.inFlight, options.signal);

    // The transfer is owned by the service, not by the first caller: a launch that stops waiting must
    // not abort a download another launch is sharing. `stop()` is the only thing that cancels it.
    const controller = new AbortController();
    this.inFlightAbort = controller;
    const work = this.download(dbPath, controller.signal, options.onProgress);
    this.inFlight = work;
    // The shared slot is released by the transfer, never by the caller that happened to start it.
    // Releasing it in this caller's `finally` unregisters a still-running transfer the moment that
    // caller aborts, so the next launch starts a second download of the same file — and both write the
    // same `pid` + `Date.now` temp name, so one rename lands and the other gets ENOENT.
    const release = () => {
      if (this.inFlight === work) {
        this.inFlight = undefined;
        this.inFlightAbort = undefined;
      }
    };
    void work.then(release, release);
    return await withAbort(work, options.signal);
  }

  /** Cancels a transfer still in progress (shutdown). Idempotent. */
  stop(): void {
    this.inFlightAbort?.abort();
  }

  private async download(
    dbPath: string,
    signal: AbortSignal,
    onProgress: ((receivedBytes: number) => void) | undefined,
  ): Promise<GeoipDatabaseEnsureResult> {
    const url = this.options.url ?? CLOAKBROWSER_GEOIP_DB_URL;
    const fetchImpl = this.options.fetchImpl ?? fetch;
    await fs.mkdir(path.dirname(dbPath), { recursive: true });
    // The wrapper runs a background refresh in the same directory; a distinct temporary name keeps
    // the two writes apart. The pid alone is not distinct: two downloads started in the same
    // millisecond for the same process would collide, and the losing rename then reports ENOENT.
    const tempPath = `${dbPath}.tmp-${process.pid}-${Date.now()}-${randomUUID()}`;
    try {
      const response = await fetchImpl(url, { redirect: "follow", signal });
      if (!response.ok || !response.body) {
        throw geoipDownloadError(`GeoIP 数据库下载失败：HTTP ${response.status}`);
      }

      const output = createWriteStream(tempPath);
      let received = 0;
      try {
        for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
          signal.throwIfAborted();
          received += chunk.byteLength;
          if (!output.write(chunk)) {
            await new Promise<void>((resolve, reject) => {
              output.once("drain", resolve);
              output.once("error", reject);
            });
          }
          onProgress?.(received);
        }
      } finally {
        // `end(callback)` fires when the data has been flushed to the OS, not when the file descriptor is
        // closed. On Windows the rename below then intermittently fails with EPERM because the handle is
        // still open; waiting for "close" is the event that actually means the file is released.
        await new Promise<void>((resolve, reject) => {
          output.once("close", () => resolve());
          output.once("error", reject);
          output.end();
        });
      }

      if (!(await hasMmdbMetadata(tempPath))) {
        throw geoipDownloadError("GeoIP 数据库下载不完整：文件缺少 MaxMind 元数据，请稍后重试。");
      }
      await renameWithRetry(tempPath, dbPath);
      return { path: dbPath, downloaded: true };
    } catch (error) {
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      if (signal.aborted) throw abortReason(signal);
      throw error;
    }
  }
}

/**
 * `fs.rename` over an existing file transiently fails on Windows (EPERM/EACCES) while an antivirus or
 * indexer still holds the previous handle. The database is a cache, so a short bounded retry is right:
 * it either lands or the caller reports a real download failure.
 */
async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function isCompleteDatabase(dbPath: string): Promise<boolean> {
  const stats = await fs.stat(dbPath).catch(() => undefined);
  if (!stats?.isFile() || stats.size === 0) return false;
  // A file another process left half-written is worse than no file at all, and this is a tail read,
  // not a parse: launching must not spend tens of milliseconds decoding 70 MB again.
  return await hasMmdbMetadata(dbPath);
}

async function hasMmdbMetadata(filePath: string): Promise<boolean> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stats = await handle.stat();
      const length = Math.min(METADATA_TAIL_BYTES, stats.size);
      if (length <= 0) return false;
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, stats.size - length);
      return buffer.includes(MMDB_METADATA_MARKER);
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}

function withAbort<Result>(work: Promise<Result>, signal: AbortSignal | undefined): Promise<Result> {
  if (!signal) return work;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (signal.aborted) {
      reject(abortReason(signal));
      return;
    }
    signal.addEventListener("abort", () => reject(abortReason(signal)), { once: true });
  });
  return Promise.race([work, aborted]);
}

function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  // `controller.abort()` without a reason yields a bare DOMException AbortError, which names neither the
  // download nor what the operator did. Only a caller-supplied reason is more informative than ours.
  if (reason instanceof Error && reason.name !== "AbortError") return reason;
  return Object.assign(new Error("GeoIP 数据库下载已取消"), { code: "GEOIP_DOWNLOAD_ABORTED" });
}

function geoipDownloadError(message: string): Error {
  return Object.assign(new Error(message), { status: 502, code: "GEOIP_DOWNLOAD_FAILED" });
}
