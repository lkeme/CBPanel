import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertTagMatchesVersion, prepareRelease, publishRelease, resolveReleaseTag } from "./publish-release.mjs";

const metadata = { repository: "example/cbpanel", sha: "a".repeat(40), version: "1.2.3", refName: "v1.2.3" };

async function fixture(run: (directory: string) => Promise<void>) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-release-"));
  try { await run(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

async function asset(directory: string, relative: string, content = "fixture") {
  const filePath = path.join(directory, relative);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf8");
}

test("release assets flatten platform handoffs into one manifest with versioned URLs", async () => fixture(async (directory) => {
  await asset(directory, "windows/release/CBPanel-win-portable.zip", "portable");
  await asset(directory, "windows/release/app-update-manifest.json", "old Windows manifest");
  await asset(directory, "mac/release/CBPanel-macos-arm64.dmg", "macOS");
  await asset(directory, "mac/release/app-update-manifest.json", "old macOS manifest");
  const { assets, manifest } = await prepareRelease(directory, { ...metadata, tag: "v1.2.3" });
  assert.deepEqual(assets.map((item) => item.name), ["CBPanel-macos-arm64.dmg", "CBPanel-win-portable.zip", "app-update-manifest.json"]);
  assert.equal(manifest.commit, metadata.sha);
  const portable = manifest.artifacts.find((item) => item.fileName.endsWith(".zip"));
  assert.equal(portable?.sha256, createHash("sha256").update("portable").digest("hex"));
  assert.equal(portable?.size, 8);
  assert.equal(portable?.url, "https://github.com/example/cbpanel/releases/download/v1.2.3/CBPanel-win-portable.zip");
}));

test("the release tag comes from the pushed tag or falls back to the project version", () => {
  assert.equal(resolveReleaseTag("v1.2.3", "1.2.3"), "v1.2.3");
  assert.equal(resolveReleaseTag("v1.2.3-beta.1", "1.2.3"), "v1.2.3-beta.1");
  assert.equal(resolveReleaseTag("master", "1.2.3"), "v1.2.3");
  assert.equal(resolveReleaseTag(undefined, "1.2.3"), "v1.2.3");
  // A branch ref that merely looks like a version is not trusted over package.json.
  assert.equal(resolveReleaseTag("release-1.2", "1.2.3"), "v1.2.3");
  assert.throws(() => resolveReleaseTag("v1.2.3", ""), /Missing project version/);
  assert.throws(() => resolveReleaseTag(undefined, "1.2"), /Invalid release tag/);
});

test("a tag that disagrees with package.json is rejected", () => {
  assert.doesNotThrow(() => assertTagMatchesVersion("v1.2.3", "1.2.3"));
  // A prerelease tag still ships the same installer filename and manifest version.
  assert.doesNotThrow(() => assertTagMatchesVersion("v1.2.3-rc.1", "1.2.3"));
  assert.throws(() => assertTagMatchesVersion("v1.2.4", "1.2.3"), /does not match package\.json version/);
  assert.throws(() => assertTagMatchesVersion("v1.2", "1.2.3"), /does not match package\.json version/);
});

test("missing, empty, unexpected and duplicate assets fail before any remote mutation", async () => {
  for (const scenario of ["missing", "empty", "unexpected", "duplicate"] as const) {
    await fixture(async (directory) => {
      if (scenario === "empty") await asset(directory, "CBPanel-win-portable.zip", "");
      if (scenario === "unexpected") await asset(directory, "secret.env");
      if (scenario === "duplicate") {
        await asset(directory, "one/CBPanel-win-portable.zip");
        await asset(directory, "two/CBPanel-win-portable.zip");
      }
      let calls = 0;
      await assert.rejects(publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: async () => { calls++; throw new Error("Unexpected request"); } }));
      assert.equal(calls, 0);
    });
  }
});

type RecordedRequest = { url: string; method: string; body?: Record<string, unknown> };

function githubFixture({ existingDraft = false, existingPublished = false, failUpload = false, failPromotion = false } = {}) {
  const requests: RecordedRequest[] = [];
  const releases = new Map<number, { id: number; tag_name: string; draft: boolean; upload_url: string }>();
  const assets = new Map<number, Array<{ id: number; name: string; size: number; state: string }>>();
  function release(id: number, tag: string, draft: boolean) {
    const item = { id, tag_name: tag, draft, upload_url: `https://uploads.github.com/repos/example/cbpanel/releases/${id}/assets{?name,label}` };
    releases.set(id, item);
    assets.set(id, []);
    return item;
  }
  if (existingDraft) release(42, "v1.2.3", true);
  if (existingPublished) release(42, "v1.2.3", false);
  let nextId = 1000;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const endpoint = new URL(url).pathname.replace("/repos/example/cbpanel", "");
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    requests.push({ url, method, body });
    const missingResponse = () => new Response(null, { status: 404 });
    if (endpoint === "/releases" && method === "POST") return Response.json(release(nextId++, String(body?.tag_name), Boolean(body?.draft)));
    const tagged = endpoint.match(/^\/releases\/tags\/(.+)$/)?.[1];
    if (tagged && method === "GET") {
      const found = [...releases.values()].find((item) => item.tag_name === tagged);
      return found ? Response.json(found) : missingResponse();
    }
    const assetRelease = endpoint.match(/^\/releases\/(\d+)\/assets$/)?.[1];
    if (assetRelease && method === "GET") {
      const page = Number(new URL(url).searchParams.get("page"));
      return Response.json((assets.get(Number(assetRelease)) ?? []).slice((page - 1) * 100, page * 100));
    }
    if (assetRelease && method === "POST") {
      if (failUpload) return new Response("upload failed", { status: 503 });
      const created = { id: nextId++, name: new URL(url).searchParams.get("name")!, size: (init?.body as Buffer).byteLength, state: "uploaded" };
      assets.get(Number(assetRelease))!.push(created);
      return Response.json(created);
    }
    const releaseId = endpoint.match(/^\/releases\/(\d+)$/)?.[1];
    if (releaseId && method === "PATCH") {
      const item = releases.get(Number(releaseId));
      if (!item) return missingResponse();
      if (body?.draft === false && failPromotion) return new Response("promotion failed", { status: 503 });
      Object.assign(item, body);
      return Response.json(item);
    }
    const assetId = endpoint.match(/^\/releases\/assets\/(\d+)$/)?.[1];
    if (assetId && method === "DELETE") {
      for (const [id, entries] of assets) assets.set(id, entries.filter((asset) => asset.id !== Number(assetId)));
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${url}`);
  };
  return { requests, fetchImpl, releases, assets };
}

test("all assets are uploaded to a draft before the release is published", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture();
  const url = await publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: api.fetchImpl });
  assert.equal(url, "https://github.com/example/cbpanel/releases/tag/v1.2.3");
  const uploads = api.requests.filter((item) => item.url.startsWith("https://uploads.github.com"));
  assert.equal(uploads.length, 2);
  const promotion = api.requests.findIndex((item) => item.body?.draft === false);
  assert.ok(promotion > api.requests.findLastIndex((item) => item.url.startsWith("https://uploads.github.com")));
  assert.equal(api.releases.size, 1);
  assert.equal([...api.releases.values()][0].tag_name, "v1.2.3");
  assert.equal([...api.releases.values()][0].draft, false);
}));

test("an already published release is never overwritten", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture({ existingPublished: true });
  await assert.rejects(publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: api.fetchImpl }), /already published/);
  assert.equal(api.requests.some((item) => item.method === "POST" || item.method === "PATCH" || item.method === "DELETE"), false);
}));

test("an upload failure leaves the draft unpublished", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture({ failUpload: true });
  await assert.rejects(publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: api.fetchImpl }), /HTTP 503/);
  assert.equal(api.requests.some((item) => item.body?.draft === false), false);
  assert.equal([...api.releases.values()][0].draft, true);
}));

test("a promotion failure keeps the draft retryable", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture({ failPromotion: true });
  await assert.rejects(publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: api.fetchImpl }), /HTTP 503/);
  assert.equal([...api.releases.values()][0].draft, true);
  assert.equal([...api.releases.values()][0].tag_name, "v1.2.3");
}));

test("missing outputs from a built platform are rejected before remote mutation", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture();
  await assert.rejects(
    publishRelease({ ...metadata, directory, requiredKinds: ["windows-portable", "macos-dmg"], token: "fixture-token", fetchImpl: api.fetchImpl }),
    /Missing release artifact: macos-dmg/,
  );
  assert.equal(api.requests.length, 0);
}));

test("a prerelease tag publishes as a prerelease and never becomes latest", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture();
  await publishRelease({ ...metadata, refName: "v1.2.3-rc.1", directory, token: "fixture-token", fetchImpl: api.fetchImpl });
  const creation = api.requests.find((item) => item.method === "POST" && item.url.endsWith("/releases"));
  const promotion = api.requests.find((item) => item.body?.draft === false);
  assert.equal(creation?.body?.prerelease, true);
  assert.equal(promotion?.body?.prerelease, true);
  assert.equal(promotion?.body?.make_latest, "false");
  assert.equal([...api.releases.values()][0].tag_name, "v1.2.3-rc.1");
}));

test("a stable tag publishes as latest", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture();
  await publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: api.fetchImpl });
  const promotion = api.requests.find((item) => item.body?.draft === false);
  assert.equal(promotion?.body?.prerelease, false);
  assert.equal(promotion?.body?.make_latest, "true");
}));

test("retrying a failed upload reuses the draft and clears partial assets across pages", async () => fixture(async (directory) => {
  await asset(directory, "CBPanel-win-portable.zip");
  const api = githubFixture({ existingDraft: true });
  api.assets.set(42, Array.from({ length: 101 }, (_, index) => ({ id: 5000 + index, name: `partial-${index}`, size: 1, state: "uploaded" })));
  await publishRelease({ ...metadata, directory, token: "fixture-token", fetchImpl: api.fetchImpl });
  assert.equal(api.requests.filter((item) => item.method === "POST" && item.url.endsWith("/releases")).length, 0);
  assert.equal(api.requests.filter((item) => item.method === "DELETE" && item.url.includes("/releases/assets/")).length, 101);
  assert.deepEqual(api.assets.get(42)?.map((entry) => entry.name), ["CBPanel-win-portable.zip", "app-update-manifest.json"]);
  assert.equal([...api.releases.values()][0].draft, false);
}));
