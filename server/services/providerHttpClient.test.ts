import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ExtensionProviderError,
  ProviderHttpClient,
  type ProviderHttpRequest,
} from "./providerHttpClient";

const CATALOG_HOSTS = new Set(["catalog.test", "delivery.test"]);

function providerRequest(overrides: Partial<ProviderHttpRequest> = {}): ProviderHttpRequest {
  return {
    url: "https://catalog.test/search",
    kind: "catalog",
    hostPolicy: (hostname) => CATALOG_HOSTS.has(hostname),
    maxBytes: 1024,
    headerTimeoutMs: 250,
    idleTimeoutMs: 250,
    totalTimeoutMs: 1_000,
    ...overrides,
  };
}

function fetchStub(
  implementation: (input: Parameters<typeof fetch>[0], init?: RequestInit) => Promise<Response>,
): typeof fetch {
  return implementation as typeof fetch;
}

function inputUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

async function expectProviderError(
  promise: Promise<unknown>,
  code: ExtensionProviderError["code"],
  status?: number,
): Promise<ExtensionProviderError> {
  let found: ExtensionProviderError | undefined;
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof ExtensionProviderError);
    assert.equal(error.code, code);
    if (status !== undefined) assert.equal(error.status, status);
    found = error;
    return true;
  });
  assert.ok(found);
  return found;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false);
}

test("readJson follows reviewed redirects manually and strips cross-host credentials", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const policyCalls: Array<[string, number]> = [];
  const client = new ProviderHttpClient({
    fetchImpl: fetchStub(async (input, init) => {
      const url = inputUrl(input);
      requests.push({ url, init });
      if (requests.length === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://delivery.test/result?opaque=provider-token" },
        });
      }
      return Response.json({ items: [1, 2, 3] });
    }),
  });

  const result = await client.readJson(providerRequest({
    url: "https://catalog.test/search?q=value#browser-only",
    init: {
      method: "POST",
      body: "query=value",
      headers: {
        authorization: "Bearer provider-secret",
        cookie: "session=provider-secret",
        referer: "https://catalog.test/private?token=provider-secret",
        "x-provider-token": "provider-secret",
        "content-type": "application/x-www-form-urlencoded",
      },
    },
    hostPolicy: (hostname, hop) => {
      policyCalls.push([hostname, hop]);
      return CATALOG_HOSTS.has(hostname);
    },
  }));

  assert.deepEqual(result, { value: { items: [1, 2, 3] }, finalHost: "delivery.test", status: 200 });
  assert.deepEqual(policyCalls, [["catalog.test", 0], ["delivery.test", 1]]);
  assert.equal(requests[0]?.url, "https://catalog.test/search?q=value");
  assert.equal(requests[0]?.init?.redirect, "manual");
  assert.equal(requests[1]?.init?.method, "GET");
  assert.equal(requests[1]?.init?.body, undefined);
  const redirectedHeaders = new Headers(requests[1]?.init?.headers);
  assert.equal(redirectedHeaders.has("authorization"), false);
  assert.equal(redirectedHeaders.has("cookie"), false);
  assert.equal(redirectedHeaders.has("referer"), false);
  assert.equal(redirectedHeaders.has("x-provider-token"), false);
  assert.equal(redirectedHeaders.has("content-type"), false);
  assert.equal(requests[1]?.init?.credentials, "omit");
});

test("unsafe initial URLs and host-policy failures are rejected before fetch", async (context) => {
  const unsafeUrls = [
    "http://catalog.test/search",
    "https://user:password@catalog.test/search",
    "https://catalog.test:444/search",
    "https://catalog.test./search",
    "https://catalog.test\\@delivery.test/search",
    "//catalog.test/search",
  ];
  for (const url of unsafeUrls) {
    await context.test(url, async () => {
      let fetchCalls = 0;
      const client = new ProviderHttpClient({
        fetchImpl: fetchStub(async () => {
          fetchCalls += 1;
          return Response.json({});
        }),
      });
      await expectProviderError(
        client.readJson(providerRequest({ url })),
        "EXTENSION_CATALOG_REDIRECT_REJECTED",
        502,
      );
      assert.equal(fetchCalls, 0);
    });
  }

  await context.test("disallowed host", async () => {
    let fetchCalls = 0;
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => {
        fetchCalls += 1;
        return Response.json({});
      }),
    });
    await expectProviderError(
      client.readJson(providerRequest({ hostPolicy: () => false })),
      "EXTENSION_CATALOG_REDIRECT_REJECTED",
    );
    assert.equal(fetchCalls, 0);
  });
});

test("redirect loops, redirect escapes, and excessive hops use typed safe errors", async (context) => {
  await context.test("catalog loop", async () => {
    let fetchCalls = 0;
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => {
        fetchCalls += 1;
        return new Response(null, { status: 302, headers: { location: "/search" } });
      }),
    });
    const error = await expectProviderError(
      client.readJson(providerRequest({ url: "https://catalog.test/search?token=do-not-leak" })),
      "EXTENSION_CATALOG_REDIRECT_REJECTED",
    );
    assert.equal(fetchCalls, 2);
    assert.equal(error.message.includes("do-not-leak"), false);
  });

  await context.test("redirect escape", async () => {
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => new Response(null, {
        status: 307,
        headers: { location: "https://outside.test/package?token=do-not-leak" },
      })),
    });
    const error = await expectProviderError(
      client.readJson(providerRequest()),
      "EXTENSION_CATALOG_REDIRECT_REJECTED",
    );
    assert.equal(error.message.includes("outside.test"), false);
    assert.equal(error.message.includes("do-not-leak"), false);
  });

  await context.test("artifact redirect cap", async () => {
    let fetchCalls = 0;
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => {
        fetchCalls += 1;
        return new Response(null, {
          status: 302,
          headers: { location: `https://delivery.test/hop-${fetchCalls}` },
        });
      }),
    });
    await expectProviderError(
      client.readJson(providerRequest({
        kind: "artifact",
        url: "https://delivery.test/hop-0",
        maxRedirects: 99,
      })),
      "ARTIFACT_REDIRECT_LOOP",
    );
    assert.equal(fetchCalls, 6);
  });
});

test("catalog HTTP, network, schema, and response-size failures stay distinct and UI-safe", async (context) => {
  await context.test("rate limit", async () => {
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(null, { status: 429 })) });
    await expectProviderError(client.readJson(providerRequest()), "EXTENSION_CATALOG_RATE_LIMITED", 429);
  });

  await context.test("generic HTTP", async () => {
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(null, { status: 503 })) });
    await expectProviderError(client.readJson(providerRequest()), "EXTENSION_CATALOG_HTTP_ERROR", 502);
  });

  await context.test("network details are hidden", async () => {
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => {
        throw new Error("socket failed for https://catalog.test/?token=provider-secret");
      }),
    });
    const error = await expectProviderError(client.readJson(providerRequest()), "EXTENSION_CATALOG_NETWORK", 502);
    assert.equal(error.message.includes("catalog.test"), false);
    assert.equal(error.message.includes("provider-secret"), false);
  });

  await context.test("invalid JSON", async () => {
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response("not-json")) });
    await expectProviderError(client.readJson(providerRequest()), "EXTENSION_CATALOG_SCHEMA_CHANGED", 502);
  });

  await context.test("invalid UTF-8", async () => {
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => new Response(Uint8Array.of(0xc3, 0x28))),
    });
    await expectProviderError(client.readJson(providerRequest()), "EXTENSION_CATALOG_SCHEMA_CHANGED", 502);
  });

  await context.test("declared oversize", async () => {
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => new Response("{}", { headers: { "content-length": "3" } })),
    });
    await expectProviderError(
      client.readJson(providerRequest({ maxBytes: 2 })),
      "EXTENSION_CATALOG_RESPONSE_TOO_LARGE",
      502,
    );
  });

  await context.test("chunked oversize", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"a\":"));
        controller.enqueue(new TextEncoder().encode("123}"));
        controller.close();
      },
    });
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(body)) });
    await expectProviderError(
      client.readJson(providerRequest({ maxBytes: 8 })),
      "EXTENSION_CATALOG_RESPONSE_TOO_LARGE",
    );
  });
});

test("header, idle, total, and caller-cancellation boundaries abort in-flight work", async (context) => {
  await context.test("header timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    });
    await expectProviderError(
      client.readJson(providerRequest({ headerTimeoutMs: 15, totalTimeoutMs: 500 })),
      "EXTENSION_CATALOG_TIMEOUT",
      504,
    );
    assert.equal(observedSignal?.aborted, true);
  });

  await context.test("body idle timeout", async () => {
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(body)) });
    await expectProviderError(
      client.readJson(providerRequest({ idleTimeoutMs: 15, totalTimeoutMs: 500 })),
      "EXTENSION_CATALOG_TIMEOUT",
    );
  });

  await context.test("total timeout is not reset by active chunks", async () => {
    let stopped = false;
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 8));
        if (!stopped) controller.enqueue(Uint8Array.of(0x20));
      },
      cancel() {
        stopped = true;
      },
    });
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(body)) });
    await expectProviderError(
      client.readJson(providerRequest({ idleTimeoutMs: 100, totalTimeoutMs: 25 })),
      "EXTENSION_CATALOG_TIMEOUT",
    );
  });

  await context.test("caller cancellation", async () => {
    const abortController = new AbortController();
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let observedSignal: AbortSignal | undefined;
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async (_input, init) => {
        observedSignal = init?.signal ?? undefined;
        requestStarted?.();
        return new Promise<Response>(() => undefined);
      }),
    });
    const pending = client.readJson(providerRequest({ signal: abortController.signal }));
    await started;
    abortController.abort();
    await expectProviderError(pending, "ACQUISITION_CANCELLED", 499);
    assert.equal(observedSignal?.aborted, true);
  });

  await context.test("already cancelled makes zero requests", async () => {
    const abortController = new AbortController();
    abortController.abort();
    let fetchCalls = 0;
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => {
        fetchCalls += 1;
        return Response.json({});
      }),
    });
    await expectProviderError(
      client.readJson(providerRequest({ signal: abortController.signal })),
      "ACQUISITION_CANCELLED",
    );
    assert.equal(fetchCalls, 0);
  });
});

test("downloadToFile streams bytes, hashes them, and atomically removes its part file", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-provider-http-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "package.crx");
  const chunks = [Buffer.from("first-"), Buffer.from("second")];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
  const fetchedAt = new Date("2026-08-27T01:02:03.000Z");
  const client = new ProviderHttpClient({
    fetchImpl: fetchStub(async () => new Response(body, {
      headers: { "content-length": String(chunks.reduce((size, chunk) => size + chunk.length, 0)) },
    })),
    now: () => fetchedAt,
  });

  const result = await client.downloadToFile(providerRequest({
    kind: "artifact",
    url: "https://delivery.test/package.crx",
  }), destination);
  const expected = Buffer.concat(chunks);
  assert.deepEqual(await fs.readFile(destination), expected);
  assert.deepEqual(result, {
    path: destination,
    size: expected.length,
    sha256: createHash("sha256").update(expected).digest("hex"),
    finalHost: "delivery.test",
    fetchedAt: fetchedAt.toISOString(),
  });
  assert.equal(await pathExists(`${destination}.part`), false);
});

test("download failures and cancellation remove owned partial files", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-provider-http-failure-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));

  await context.test("chunked oversize", async () => {
    const destination = path.join(root, "oversize.crx");
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => new Response(Buffer.from("too-large"))),
    });
    await expectProviderError(
      client.downloadToFile(providerRequest({ kind: "artifact", maxBytes: 3 }), destination),
      "ARTIFACT_TOO_LARGE",
      413,
    );
    assert.equal(await pathExists(destination), false);
    assert.equal(await pathExists(`${destination}.part`), false);
  });

  await context.test("total timeout", async () => {
    const destination = path.join(root, "timeout.crx");
    const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) });
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(body)) });
    await expectProviderError(
      client.downloadToFile(providerRequest({
        kind: "artifact",
        idleTimeoutMs: 500,
        totalTimeoutMs: 15,
      }), destination),
      "ARTIFACT_TIMEOUT",
      504,
    );
    assert.equal(await pathExists(destination), false);
    assert.equal(await pathExists(`${destination}.part`), false);
  });

  await context.test("caller cancellation", async () => {
    const destination = path.join(root, "cancelled.crx");
    const abortController = new AbortController();
    let streamStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      streamStarted = resolve;
    });
    const body = new ReadableStream<Uint8Array>({
      pull() {
        streamStarted?.();
        return new Promise<void>(() => undefined);
      },
    });
    const client = new ProviderHttpClient({ fetchImpl: fetchStub(async () => new Response(body)) });
    const pending = client.downloadToFile(providerRequest({
      kind: "artifact",
      signal: abortController.signal,
    }), destination);
    await started;
    abortController.abort();
    await expectProviderError(pending, "ACQUISITION_CANCELLED", 499);
    assert.equal(await pathExists(destination), false);
    assert.equal(await pathExists(`${destination}.part`), false);
  });

  await context.test("cancellation during atomic publication reclaims the destination", async () => {
    const destination = path.join(root, "publish-cancelled.crx");
    const abortController = new AbortController();
    const originalRename = fs.rename.bind(fs);
    context.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
      await originalRename(...args);
      abortController.abort();
    });
    const client = new ProviderHttpClient({
      fetchImpl: fetchStub(async () => new Response(Buffer.from("complete-package"))),
    });

    await expectProviderError(
      client.downloadToFile(providerRequest({
        kind: "artifact",
        signal: abortController.signal,
      }), destination),
      "ACQUISITION_CANCELLED",
      499,
    );
    assert.equal(await pathExists(destination), false);
    assert.equal(await pathExists(`${destination}.part`), false);
  });
});

test("download refuses to steal an existing part file and makes no request", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-provider-http-owned-"));
  context.after(() => fs.rm(root, { recursive: true, force: true }));
  const destination = path.join(root, "package.crx");
  const partPath = `${destination}.part`;
  await fs.writeFile(partPath, "belongs-to-another-operation", "utf8");
  let fetchCalls = 0;
  const client = new ProviderHttpClient({
    fetchImpl: fetchStub(async () => {
      fetchCalls += 1;
      return new Response("package");
    }),
  });

  await expectProviderError(
    client.downloadToFile(providerRequest({ kind: "artifact" }), destination),
    "ARTIFACT_NETWORK",
    409,
  );
  assert.equal(fetchCalls, 0);
  assert.equal(await fs.readFile(partPath, "utf8"), "belongs-to-another-operation");
});
