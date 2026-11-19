import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { GeoipDatabaseService } from "./geoipDatabaseService";

const MMDB_BODY = `not-a-real-database${"x".repeat(64)}MaxMind.com`;

function service(root: string, fetchImpl: typeof fetch): GeoipDatabaseService {
  return new GeoipDatabaseService({
    databasePath: async () => path.join(root, "geoip", "GeoLite2-City.mmdb"),
    fetchImpl,
    url: "https://mirror.example/GeoLite2-City.mmdb",
  });
}

function streamBody(chunks: Uint8Array[], options: { failAfter?: number } = {}): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (options.failAfter !== undefined && index >= options.failAfter) {
        controller.error(new Error("socket reset"));
        return;
      }
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

async function tempRoot(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), "cbp-geoip-db-"));
}

test("a missing database is downloaded once and reused afterwards", async () => {
  const root = await tempRoot();
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(streamBody([Buffer.from(MMDB_BODY)]), { status: 200 });
  }) as unknown as typeof fetch;
  const database = service(root, fetchImpl);

  const first = await database.ensure();
  assert.equal(first.downloaded, true);
  assert.equal(await database.isPresent(), true);

  const second = await database.ensure();
  assert.equal(second.downloaded, false);
  assert.equal(calls, 1, "a complete database must not be fetched again");
  await fs.rm(root, { recursive: true, force: true });
});

test("a truncated transfer is refused and leaves no partial database behind", async () => {
  const root = await tempRoot();
  const fetchImpl = (async () => new Response(
    streamBody([Buffer.from("partial-data-without-metadata")]),
    { status: 200 },
  )) as unknown as typeof fetch;
  const database = service(root, fetchImpl);

  await assert.rejects(database.ensure(), (error) => {
    assert.equal((error as { code?: string }).code, "GEOIP_DOWNLOAD_FAILED");
    return true;
  });
  assert.equal(await database.isPresent(), false);
  // A leftover .tmp file would still be 70 MB on disk after a failed retry loop.
  const entries = await fs.readdir(path.join(root, "geoip"));
  assert.deepEqual(entries, []);
  await fs.rm(root, { recursive: true, force: true });
});

test("a transfer that dies mid-stream removes its temporary file", async () => {
  const root = await tempRoot();
  const fetchImpl = (async () => new Response(
    streamBody([Buffer.from("first-chunk"), Buffer.from("second-chunk")], { failAfter: 1 }),
    { status: 200 },
  )) as unknown as typeof fetch;
  const database = service(root, fetchImpl);

  await assert.rejects(database.ensure());
  await assert.rejects(fs.access(path.join(root, "geoip", "GeoLite2-City.mmdb.tmp-fixed")));
  const entries = await fs.readdir(path.join(root, "geoip"));
  assert.equal(entries.some((entry) => entry.includes(".tmp-")), false);
  await fs.rm(root, { recursive: true, force: true });
});

test("progress is reported while the transfer is running", async () => {
  const root = await tempRoot();
  const fetchImpl = (async () => new Response(
    streamBody([Buffer.from("a".repeat(1024 * 1024)), Buffer.from(MMDB_BODY)]),
    { status: 200 },
  )) as unknown as typeof fetch;
  const database = service(root, fetchImpl);
  const seen: number[] = [];

  await database.ensure({ onProgress: (received) => seen.push(received) });

  assert.ok(seen.length >= 2);
  assert.ok(seen.every((value, index) => index === 0 || value > seen[index - 1]!));
  await fs.rm(root, { recursive: true, force: true });
});

test("one aborted caller stops waiting without cancelling the shared transfer", async () => {
  const root = await tempRoot();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let transferStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    transferStarted = resolve;
  });
  const fetchImpl = (async () => {
    transferStarted();
    await gate;
    return new Response(streamBody([Buffer.from(MMDB_BODY)]), { status: 200 });
  }) as unknown as typeof fetch;
  const database = service(root, fetchImpl);

  const controller = new AbortController();
  const waiting = database.ensure({ signal: controller.signal });
  // The shared transfer is registered only after the cache path resolves, so abort must land once the
  // fetch itself is in flight — that is the state a Stop actually finds it in.
  await started;
  controller.abort(new Error("launch stopped"));
  await assert.rejects(waiting, /launch stopped/);

  // A second caller that arrives after the abort joins the same transfer and still completes.
  const joined = database.ensure();
  release();
  const result = await joined;
  assert.equal(result.downloaded, true);
  await fs.rm(root, { recursive: true, force: true });
});

test("shutdown stops an in-flight transfer", async () => {
  const root = await tempRoot();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const fetchImpl = ((_input: unknown, init?: RequestInit) => {
    entered();
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
  }) as unknown as typeof fetch;
  const database = service(root, fetchImpl);

  const waiting = database.ensure();
  // ensure() awaits the cache path before it opens the transfer, so stop() must land after the fetch is
  // actually in flight — that is the state shutdown finds it in.
  await started;
  database.stop();
  await assert.rejects(waiting, /GeoIP 数据库下载已取消/);
  await fs.rm(root, { recursive: true, force: true });
});

test("an existing file without MaxMind metadata is not trusted as the database", async () => {
  const root = await tempRoot();
  const dbPath = path.join(root, "geoip", "GeoLite2-City.mmdb");
  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await fs.writeFile(dbPath, "truncated", "utf8");
  let calls = 0;
  const fetchImpl = (async () => {
    calls += 1;
    return new Response(streamBody([Buffer.from(MMDB_BODY)]), { status: 200 });
  }) as unknown as typeof fetch;

  const database = service(root, fetchImpl);
  const result = await database.ensure();

  assert.equal(result.downloaded, true);
  assert.equal(calls, 1);
  await fs.rm(root, { recursive: true, force: true });
});
