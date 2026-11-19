import { createHash } from "node:crypto";
import type { BrowserCorePrivateRelease, BrowserCorePrivateReleaseAsset } from "../../src/shared/browserCore";
import { githubRepositoryPath } from "../../src/shared/githubRepository";

const MAX_CATALOG_BYTES = 8 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 1024 * 1024;
const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
const MAX_PAGES = 100;
const DOWNLOAD_HOSTS = new Set(["api.github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com", "github-releases.githubusercontent.com"]);

export class PrivateCoreReleaseService {
  constructor(private readonly options: {
    fetchImpl: typeof fetch;
    token: string;
    repositoryUrl: string;
    signal?: AbortSignal;
    /** Bytes received for the archive so far, and the declared total when the CDN sends one. */
    onDownloadProgress?: (received: number, total: number | undefined) => void;
  }) {}

  async list(platform: string): Promise<BrowserCorePrivateRelease[]> {
    const repo = parsePrivateRepositoryUrl(this.options.repositoryUrl);
    const releases: BrowserCorePrivateRelease[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const response = await this.open(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, "application/vnd.github+json", 15_000);
      const body = await readBounded(response, MAX_CATALOG_BYTES);
      let payload: unknown;
      try { payload = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); } catch { throw privateError("PRIVATE_RELEASES_SCHEMA_ERROR", "GitHub returned invalid release metadata.", 502); }
      if (!Array.isArray(payload)) throw privateError("PRIVATE_RELEASES_SCHEMA_ERROR", "GitHub did not return a release list.", 502);
      for (const value of payload) {
        const release = privateReleaseFromApi(value, platform, repo);
        if (release) releases.push(release);
      }
      const hasNext = /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
      if (!hasNext && payload.length < 100) break;
      if (page === MAX_PAGES) throw privateError("PRIVATE_RELEASES_LIMIT", "The private repository has too many release pages.", 502);
    }
    return releases.sort((a, b) => comparePrivateVersions(b.version, a.version) || Date.parse(b.publishedAt ?? "1970-01-01") - Date.parse(a.publishedAt ?? "1970-01-01") || b.id - a.id);
  }

  async download(release: BrowserCorePrivateRelease, platform: string): Promise<{ bytes: Uint8Array; archive: BrowserCorePrivateReleaseAsset; sha256: string }> {
    const archive = release.assets.find((asset) => isPrivateArchiveName(asset.name, platform));
    const sums = release.assets.find((asset) => asset.name === "SHA256SUMS");
    if (!archive || !sums) throw privateError("PRIVATE_RELEASE_ASSET_MISSING", "The verified release is missing its archive or SHA256SUMS.", 400);
    const checksums = new TextDecoder("utf-8", { fatal: true }).decode(await readBounded(await this.open(sums.downloadUrl, "application/octet-stream", 30_000), MAX_CHECKSUM_BYTES));
    const expected = parsePrivateChecksums(checksums, archive.name);
    if (!expected) throw privateError("PRIVATE_RELEASE_CHECKSUM_MISSING", "SHA256SUMS has no unambiguous checksum for the selected archive.", 502);
    const bytes = await readBounded(await this.open(archive.downloadUrl, "application/octet-stream", 10 * 60_000), MAX_ARCHIVE_BYTES, this.options.onDownloadProgress);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (expected !== sha256) throw privateError("PRIVATE_RELEASE_CHECKSUM_MISMATCH", "Private release SHA256 verification failed.", 502);
    return { bytes, archive, sha256 };
  }

  private async open(rawUrl: string, accept: string, timeout: number): Promise<Response> {
    let url = new URL(rawUrl);
    const signal = this.options.signal ? AbortSignal.any([this.options.signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    for (let hop = 0; hop <= 5; hop += 1) {
      if (url.protocol !== "https:" || url.username || url.password || url.port || !DOWNLOAD_HOSTS.has(url.hostname)) throw privateError("PRIVATE_RELEASE_REDIRECT_REJECTED", "GitHub returned an unsupported download address.", 502);
      const headers: Record<string, string> = { Accept: accept, "User-Agent": "CBPanel-private-core", "X-GitHub-Api-Version": "2022-11-28" };
      // Signed asset URLs carry their own authorization. Never forward a GitHub token to a CDN.
      if (url.hostname === "api.github.com") headers.Authorization = `Bearer ${this.options.token}`;
      const response = await this.options.fetchImpl(url.href, { headers, signal, redirect: "manual" });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location || hop === 5) throw privateError("PRIVATE_RELEASE_REDIRECT_REJECTED", "GitHub returned an unsupported download redirect.", 502);
        url = new URL(location, url);
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw privateError("PRIVATE_RELEASES_HTTP_ERROR", `GitHub request failed: HTTP ${response.status}.`, response.status === 401 || response.status === 403 || response.status === 404 ? response.status : 502);
      }
      return response;
    }
    throw privateError("PRIVATE_RELEASE_REDIRECT_REJECTED", "GitHub returned too many redirects.", 502);
  }
}

/**
 * The `owner/repository` form the GitHub API addresses. Extra path segments, a query and a fragment
 * are the page the operator copied from, not part of the repository's identity, so they are dropped
 * together with them; `shared/githubRepository` is the single rule the panel and the server share.
 */
export function parsePrivateRepositoryUrl(value: string): string {
  const repository = githubRepositoryPath(value);
  if (!repository) throw privateError("PRIVATE_REPOSITORY_INVALID", "Use a standard HTTPS GitHub repository URL.", 400);
  return repository;
}

export function privateReleaseFromApi(value: unknown, platform: string, repository: string): BrowserCorePrivateRelease | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (record.draft === true || record.prerelease === true || typeof record.name !== "string" || !/(?:^|[^A-Za-z0-9_])VERIFIED(?:$|[^A-Za-z0-9_])/.test(record.name)) return undefined;
  const versions = [...record.name.matchAll(/(?<![\d.])\d+(?:\.\d+){4}(?![\d.])/g)];
  if (versions.length !== 1 || versions[0][0].split(".").some((part) => !Number.isSafeInteger(Number(part))) || !Array.isArray(record.assets)) return undefined;
  const assets = record.assets.flatMap((value): BrowserCorePrivateReleaseAsset[] => {
    if (!value || typeof value !== "object") return [];
    const asset = value as Record<string, unknown>;
    if (typeof asset.name !== "string" || (!isPrivateArchiveName(asset.name, platform) && asset.name !== "SHA256SUMS") || typeof asset.id !== "number" || !Number.isSafeInteger(asset.id) || asset.id <= 0) return [];
    return [{ name: asset.name, downloadUrl: `https://api.github.com/repos/${repository}/releases/assets/${asset.id}`, platform, size: typeof asset.size === "number" ? asset.size : undefined }];
  });
  if (assets.filter((asset) => isPrivateArchiveName(asset.name, platform)).length !== 1 || assets.filter((asset) => asset.name === "SHA256SUMS").length !== 1) return undefined;
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) return undefined;
  return { id: record.id, title: record.name, version: versions[0][0], tagName: typeof record.tag_name === "string" ? record.tag_name : undefined, publishedAt: typeof record.published_at === "string" ? record.published_at : undefined, assets, verified: true };
}

export function isPrivateArchiveName(fileName: string, platform: string): boolean {
  const assetPlatform = platform.replace(/^darwin-/, "macos-");
  return ["zip", "tar.gz", "tgz"].some((extension) => fileName === `cloakbrowser-${assetPlatform}.${extension}`);
}

export function parsePrivateChecksums(content: string, name: string): string | undefined {
  const hashes = content.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]{64})\s+\*?(?:\.\/)?([^/\\]+)\s*$/.exec(line.trim());
    return match?.[2] === name ? [match[1].toLowerCase()] : [];
  });
  return hashes.length === 1 ? hashes[0] : undefined;
}

function comparePrivateVersions(a: string, b: string): number {
  const right = b.split(".").map(Number);
  for (const [index, part] of a.split(".").map(Number).entries()) if (part !== right[index]) return part - right[index];
  return 0;
}

async function readBounded(
  response: Response,
  maxBytes: number,
  onProgress?: (received: number, total: number | undefined) => void,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maxBytes) { await response.body?.cancel(); throw privateError("PRIVATE_RELEASE_TOO_LARGE", "GitHub response exceeds the allowed size.", 413); }
  const total = declared && Number(declared) > 0 ? Number(declared) : undefined;
  const reader = response.body?.getReader();
  if (!reader) throw privateError("PRIVATE_RELEASE_EMPTY_BODY", "GitHub returned an empty response.", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      size += result.value.length;
      if (size > maxBytes) throw privateError("PRIVATE_RELEASE_TOO_LARGE", "GitHub response exceeds the allowed size.", 413);
      chunks.push(result.value);
      onProgress?.(size, total);
    }
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

function privateError(code: string, message: string, status: number): Error { return Object.assign(new Error(message), { code, status }); }
