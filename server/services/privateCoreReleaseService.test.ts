import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  PrivateCoreReleaseService,
  isPrivateArchiveName,
  parsePrivateChecksums,
  parsePrivateRepositoryUrl,
  privateReleaseFromApi,
} from "./privateCoreReleaseService";
import type { BrowserCorePrivateRelease } from "../../src/shared/browserCore";

const PLATFORM = "windows-x64";
const ARCHIVE = `cloakbrowser-${PLATFORM}.zip`;
const REPOSITORY = "owner/private-core";
const TOKEN = "test-private-token-never-a-real-credential";
const ARCHIVE_TEXT = "verified archive fixture bytes";
const HASH = createHash("sha256").update(ARCHIVE_TEXT).digest("hex");

function apiRelease(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 1,
    name: "CloakBrowser Pro 156.0.8078.47.1 (含 version.dll · VERIFIED)",
    tag_name: "156.0.8078.47.1",
    draft: false,
    prerelease: false,
    published_at: "2026-11-01T00:00:00Z",
    assets: [{ id: 11, name: ARCHIVE, size: ARCHIVE_TEXT.length }, { id: 12, name: "SHA256SUMS" }],
    ...patch,
  };
}

function release(): BrowserCorePrivateRelease {
  const value = privateReleaseFromApi(apiRelease(), PLATFORM, REPOSITORY);
  assert.ok(value);
  return value;
}

function service(fetchImpl: typeof fetch, signal?: AbortSignal, onDownloadProgress?: (received: number, total: number | undefined) => void): PrivateCoreReleaseService {
  return new PrivateCoreReleaseService({ fetchImpl, signal, token: TOKEN, repositoryUrl: `https://github.com/${REPOSITORY}`, onDownloadProgress });
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof Error && (error as Error & { code?: string }).code === code;
}

test("private releases require an independent uppercase VERIFIED marker and exactly one five-part version", () => {
  const valid = privateReleaseFromApi(apiRelease(), PLATFORM, REPOSITORY);
  assert.equal(valid?.version, "156.0.8078.47.1");
  assert.equal(valid?.verified, true);
  assert.equal(valid?.assets[0].downloadUrl, `https://api.github.com/repos/${REPOSITORY}/releases/assets/11`);
  for (const name of [
    "CloakBrowser Pro 156.0.8078.47.1 (原版)",
    "CloakBrowser Pro 156.0.8078.47.1 (verified)",
    "CloakBrowser Pro 156.0.8078.47.1 (UNVERIFIED)",
    "CloakBrowser Pro 156.0.8078.47.1 (VERIFIED_build)",
    "CloakBrowser Pro 156.0.8078.47 VERIFIED",
    "CloakBrowser Pro 156.0.8078.47.1.2 VERIFIED",
    "CloakBrowser Pro 156.0.8078.47.1 / 155.0.8059.39.1 VERIFIED",
    "CloakBrowser Pro 9007199254740992.0.8078.47.1 VERIFIED",
  ]) {
    assert.equal(privateReleaseFromApi(apiRelease({ name }), PLATFORM, REPOSITORY), undefined, name);
  }
  assert.equal(privateReleaseFromApi(apiRelease({ draft: true }), PLATFORM, REPOSITORY), undefined);
  assert.equal(privateReleaseFromApi(apiRelease({ prerelease: true }), PLATFORM, REPOSITORY), undefined);
});

test("private releases require exact platform asset names and one exact SHA256SUMS asset", () => {
  for (const name of ["chrome.zip", `${ARCHIVE}.backup`, "cloakbrowser-linux-x64.zip", "Cloakbrowser-windows-x64.zip"]) {
    assert.equal(isPrivateArchiveName(name, PLATFORM), false, name);
    assert.equal(privateReleaseFromApi(apiRelease({ assets: [{ id: 11, name }, { id: 12, name: "SHA256SUMS" }] }), PLATFORM, REPOSITORY), undefined);
  }
  for (const assets of [
    [{ id: 11, name: ARCHIVE }],
    [{ id: 11, name: ARCHIVE }, { id: 12, name: "sha256sums" }],
    [{ id: 11, name: ARCHIVE }, { id: 12, name: "SHA256SUMS" }, { id: 13, name: "SHA256SUMS" }],
    [{ id: 11, name: ARCHIVE }, { id: 13, name: ARCHIVE }, { id: 12, name: "SHA256SUMS" }],
  ]) assert.equal(privateReleaseFromApi(apiRelease({ assets }), PLATFORM, REPOSITORY), undefined);
  assert.equal(isPrivateArchiveName("cloakbrowser-macos-arm64.tar.gz", "macos-arm64"), true);
  assert.equal(isPrivateArchiveName("cloakbrowser-linux-arm64.tgz", "linux-arm64"), true);
});

test("private repository URLs strip page suffixes, queries and fragments and reject credentials and other hosts", () => {
  assert.equal(parsePrivateRepositoryUrl(`https://github.com/${REPOSITORY}`), REPOSITORY);
  assert.equal(parsePrivateRepositoryUrl(`https://github.com/${REPOSITORY}.git/`), REPOSITORY);
  // A pasted URL carries the page it was copied from; the repository is the part that identifies it.
  for (const [value, expected] of [
    [`https://github.com/${REPOSITORY}/releases`, REPOSITORY],
    [`https://github.com/${REPOSITORY}/tree/main`, REPOSITORY],
    [`https://github.com/${REPOSITORY}?token=secret`, REPOSITORY],
    [`https://github.com/${REPOSITORY}#fragment`, REPOSITORY],
    [`https://github.com/${REPOSITORY}/releases/tag/v1?tab=readme#top`, REPOSITORY],
    [`https://www.github.com/${REPOSITORY}`, REPOSITORY],
    [`github.com/${REPOSITORY}`, REPOSITORY],
  ] as const) assert.equal(parsePrivateRepositoryUrl(value), expected, value);
  for (const value of [
    `http://github.com/${REPOSITORY}`,
    `https://user:password@github.com/${REPOSITORY}`,
    `https://github.com:444/${REPOSITORY}`,
    `https://github.com.evil.test/${REPOSITORY}`,
  ]) assert.throws(() => parsePrivateRepositoryUrl(value), hasCode("PRIVATE_REPOSITORY_INVALID"), value);
});

test("Darwin runtime tags select and download canonical macOS assets for the same architecture", async () => {
  for (const architecture of ["arm64", "x64"] as const) {
    const runtimePlatform = `darwin-${architecture}`;
    const archiveName = `cloakbrowser-macos-${architecture}.tar.gz`;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/releases?")) return Response.json([apiRelease({ assets: [
        { id: 11, name: archiveName },
        { id: 12, name: "SHA256SUMS" },
        { id: 13, name: `cloakbrowser-macos-${architecture === "arm64" ? "x64" : "arm64"}.tar.gz` },
      ] })]);
      return url.endsWith("/12") ? new Response(`${HASH}  ${archiveName}\n`) : new Response(ARCHIVE_TEXT);
    }) as typeof fetch;
    const provider = service(fetchImpl);
    const releases = await provider.list(runtimePlatform);
    assert.equal(releases.length, 1);
    assert.equal(releases[0].assets[0].name, archiveName);
    assert.equal(releases[0].assets[0].platform, runtimePlatform);
    const downloaded = await provider.download(releases[0], runtimePlatform);
    assert.equal(downloaded.archive.name, archiveName);
    assert.equal(downloaded.sha256, HASH);
  }
});

test("private release pagination sorts numeric versions before publication time and id", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(url.href);
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${TOKEN}`);
    assert.equal(init?.redirect, "manual");
    if (url.searchParams.get("page") === "1") return Response.json([
      apiRelease({ id: 1, name: "CloakBrowser Pro 155.0.8059.39.1 VERIFIED", published_at: "2026-11-09T00:00:00Z" }),
      apiRelease({ id: 2, published_at: "2026-11-01T00:00:00Z" }),
    ], { headers: { link: '<https://api.github.com/repos/owner/private-core/releases?page=2>; rel="next"' } });
    return Response.json([
      apiRelease({ id: 3, published_at: "2026-11-03T00:00:00Z" }),
      apiRelease({ id: 4, published_at: "2026-11-03T00:00:00Z" }),
    ]);
  }) as typeof fetch;
  const releases = await service(fetchImpl).list(PLATFORM);
  assert.deepEqual(releases.map((value) => value.id), [4, 3, 2, 1]);
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("page=2"));
});

test("private checksums require one exact filename match and reject conflicting duplicate entries", () => {
  assert.equal(parsePrivateChecksums(`${HASH.toUpperCase()}  ${ARCHIVE}\r\n`, ARCHIVE), HASH);
  assert.equal(parsePrivateChecksums(`${HASH} *./${ARCHIVE}\n`, ARCHIVE), HASH);
  for (const text of [
    `${HASH}  other.zip`,
    `${HASH}  dir/${ARCHIVE}`,
    `${HASH}  ..\\${ARCHIVE}`,
    `${HASH}  ${ARCHIVE}\n${HASH}  ${ARCHIVE}`,
    `invalid  ${ARCHIVE}`,
  ]) assert.equal(parsePrivateChecksums(text, ARCHIVE), undefined);
});

test("private downloads verify SHA256SUMS before accepting archive bytes", async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return String(input).endsWith("/12") ? new Response(`${HASH}  ${ARCHIVE}\n`) : new Response(ARCHIVE_TEXT);
  }) as typeof fetch;
  const result = await service(fetchImpl).download(release(), PLATFORM);
  assert.equal(result.sha256, HASH);
  assert.equal(new TextDecoder().decode(result.bytes), ARCHIVE_TEXT);
  assert.ok(calls[0].endsWith("/12"));
  assert.ok(calls[1].endsWith("/11"));
});

test("the archive download reports byte progress with the declared total, and reports nothing else", async () => {
  const samples: Array<{ received: number; total: number | undefined }> = [];
  const body = new TextEncoder().encode(ARCHIVE_TEXT);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/12")) return new Response(`${HASH}  ${ARCHIVE}`);
    // A real response object streams; a string body has no content length, which is the case the
    // progress report must survive without inventing a total.
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(body.subarray(0, 8));
        controller.enqueue(body.subarray(8));
        controller.close();
      },
    }), { headers: { "content-length": String(body.length) } });
  }) as typeof fetch;
  await service(fetchImpl, undefined, (received, total) => samples.push({ received, total })).download(release(), PLATFORM);
  assert.deepEqual(samples, [
    { received: 8, total: body.length },
    { received: body.length, total: body.length },
  ]);
  // The checksum request is small and is not the archive; its progress must not be reported as bytes of
  // the download, or the size on screen would jump around while verifying.
  assert.equal(samples.length, 2);
});

test("an archive response without a content length reports progress with no total", async () => {
  const samples: Array<{ received: number; total: number | undefined }> = [];
  const body = new TextEncoder().encode(ARCHIVE_TEXT);
  const fetchImpl = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("/12")) return new Response(`${HASH}  ${ARCHIVE}`);
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(body);
        controller.close();
      },
    }));
  }) as typeof fetch;
  await service(fetchImpl, undefined, (received, total) => samples.push({ received, total })).download(release(), PLATFORM);
  assert.deepEqual(samples, [{ received: body.length, total: undefined }]);
});

test("private downloads refuse missing, ambiguous and mismatching archive checksums", async () => {  for (const [sums, code, expectedCalls] of [
    [`${HASH} other.zip`, "PRIVATE_RELEASE_CHECKSUM_MISSING", 1],
    [`${HASH} ${ARCHIVE}\n${HASH} ${ARCHIVE}`, "PRIVATE_RELEASE_CHECKSUM_MISSING", 1],
    [`${"0".repeat(64)} ${ARCHIVE}`, "PRIVATE_RELEASE_CHECKSUM_MISMATCH", 2],
  ] as const) {
    let calls = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => { calls += 1; return String(input).endsWith("/12") ? new Response(sums) : new Response(ARCHIVE_TEXT); }) as typeof fetch;
    await assert.rejects(service(fetchImpl).download(release(), PLATFORM), hasCode(code));
    assert.equal(calls, expectedCalls);
  }
});

test("private download redirects strip GitHub authorization before following an approved CDN", async () => {
  const calls: { url: string; authorization: string | null }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    if (url.endsWith("/12")) return new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/checksums?signature=fixture" } });
    if (url.includes("/checksums")) return new Response(`${HASH} ${ARCHIVE}`);
    if (url.endsWith("/11")) return new Response(null, { status: 302, headers: { location: "https://objects.githubusercontent.com/archive?signature=fixture" } });
    return new Response(ARCHIVE_TEXT);
  }) as typeof fetch;
  await service(fetchImpl).download(release(), PLATFORM);
  assert.equal(calls.length, 4);
  for (const call of calls) assert.equal(call.authorization, call.url.startsWith("https://api.github.com/") ? `Bearer ${TOKEN}` : null);
});

test("private download redirects reject unapproved hosts without forwarding any request", async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response(null, { status: 302, headers: { location: "https://unapproved.test/asset" } }); }) as typeof fetch;
  await assert.rejects(service(fetchImpl).download(release(), PLATFORM), hasCode("PRIVATE_RELEASE_REDIRECT_REJECTED"));
  assert.equal(calls, 1);
});

test("private provider cancellation reaches the in-flight fetch signal", async () => {
  const controller = new AbortController();
  let entered: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    assert.ok(init?.signal);
    entered?.();
    return new Promise<Response>((_resolve, reject) => {
      const signal = init.signal!;
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
  }) as typeof fetch;
  const pending = service(fetchImpl, controller.signal).list(PLATFORM);
  await started;
  const cancellation = new Error("operator cancelled fixture");
  controller.abort(cancellation);
  await assert.rejects(pending, (error) => error === cancellation);
});

test("private provider rejects catalog, checksum and archive responses over their size limits", async () => {
  let cancelled = 0;
  const oversized = (length: number) => new Response(new ReadableStream({ cancel() { cancelled += 1; } }), { headers: { "content-length": String(length) } });
  await assert.rejects(service((async () => oversized(8 * 1024 * 1024 + 1)) as typeof fetch).list(PLATFORM), hasCode("PRIVATE_RELEASE_TOO_LARGE"));
  await assert.rejects(service((async () => oversized(1024 * 1024 + 1)) as typeof fetch).download(release(), PLATFORM), hasCode("PRIVATE_RELEASE_TOO_LARGE"));
  const archiveFetch = (async (input: RequestInfo | URL) => String(input).endsWith("/12") ? new Response(`${HASH} ${ARCHIVE}`) : oversized(1024 * 1024 * 1024 + 1)) as typeof fetch;
  await assert.rejects(service(archiveFetch).download(release(), PLATFORM), hasCode("PRIVATE_RELEASE_TOO_LARGE"));
  assert.equal(cancelled, 3);
});

test("private provider enforces streamed size limits even without Content-Length", async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)); },
    cancel() { cancelled = true; },
  });
  await assert.rejects(service((async () => new Response(stream)) as typeof fetch).list(PLATFORM), hasCode("PRIVATE_RELEASE_TOO_LARGE"));
  assert.equal(cancelled, true);
});
