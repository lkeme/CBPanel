import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function artifactKind(name) {
  if (name === "CBPanel-win-portable.zip") return "windows-portable";
  if (/^CBPanel_.+_x64-setup\.exe$/.test(name)) return "windows-installer";
  if (name === "CBPanel-linux-x64.AppImage") return "linux-appimage";
  if (/^CBPanel-macos-(?:arm64|x64)\.dmg$/.test(name)) return "macos-dmg";
  return undefined;
}

export function resolveReleaseTag(refName, version) {
  if (typeof version !== "string" || !version.trim()) throw new Error("Missing project version.");
  const tagPattern = /^v\d+\.\d+\.\d+[0-9A-Za-z.+-]*$/;
  if (refName && tagPattern.test(refName)) return refName;
  const tag = `v${version}`;
  if (!tagPattern.test(tag)) throw new Error(`Invalid release tag: ${tag}`);
  return tag;
}

/**
 * A tag push must describe the version being built, otherwise the release name, the
 * installer filename and the update manifest disagree with each other. A prerelease
 * suffix (`v1.2.3-rc.1`) is accepted; a different base version is not.
 */
export function assertTagMatchesVersion(tag, version) {
  if (tag !== `v${version}` && !tag.startsWith(`v${version}-`)) {
    throw new Error(`Release tag ${tag} does not match package.json version ${version}.`);
  }
}

export async function prepareRelease(directory, { repository, tag, sha, version, requiredKinds = [] }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error("Invalid GitHub repository.");
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error("Invalid build commit SHA.");
  const assets = [];
  const names = new Set();
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const filePath = path.join(current, entry.name);
      if (entry.isFile() && entry.name === "app-update-manifest.json") continue;
      if (entry.isDirectory()) {
        await visit(filePath);
      } else if (entry.isFile()) {
        const kind = artifactKind(entry.name);
        if (!kind) throw new Error(`Unexpected release asset: ${entry.name}`);
        if (names.has(entry.name)) throw new Error(`Duplicate release asset: ${entry.name}`);
        const bytes = await fs.readFile(filePath);
        if (bytes.length === 0) throw new Error(`Empty release asset: ${entry.name}`);
        names.add(entry.name);
        assets.push({ name: entry.name, filePath, kind, size: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      } else {
        throw new Error(`Unsupported release entry: ${entry.name}`);
      }
    }
  }
  await visit(directory);
  if (!assets.length) throw new Error("No release assets were downloaded.");
  for (const kind of requiredKinds) {
    if (!assets.some((asset) => asset.kind === kind)) throw new Error(`Missing release artifact: ${kind}`);
  }
  assets.sort((left, right) => left.name.localeCompare(right.name));
  const manifest = {
    version,
    commit: sha,
    generatedAt: new Date().toISOString(),
    signing: { codeSigned: false, updaterSigned: false },
    artifacts: assets.map(({ name, kind, size, sha256 }) => ({
      kind,
      fileName: name,
      size,
      sha256,
      url: `https://github.com/${repository}/releases/download/${tag}/${name}`,
    })),
    notes: ["Release artifacts are not code-signed or updater-signed."],
  };
  const manifestPath = path.join(directory, "app-update-manifest.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  assets.push({ name: "app-update-manifest.json", filePath: manifestPath });
  return { assets, manifest };
}

export async function publishRelease({ directory, repository, refName, sha, version, token, requiredKinds = [], fetchImpl = fetch }) {
  // Validate every local file before touching the remote release.
  const tag = resolveReleaseTag(refName, version);
  assertTagMatchesVersion(tag, version);
  const { assets } = await prepareRelease(directory, { repository, tag, sha, version, requiredKinds });
  if (!token) throw new Error("GITHUB_TOKEN is required to publish the release.");
  const apiBase = `https://api.github.com/repos/${repository}`;
  async function request(endpoint, { method = "GET", body, allowMissing = false, upload = false } = {}) {
    const response = await fetchImpl(upload ? endpoint : `${apiBase}${endpoint}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body === undefined ? {} : { "Content-Type": upload ? "application/octet-stream" : "application/json" }),
      },
      ...(body === undefined ? {} : { body: upload ? body : JSON.stringify(body) }),
    });
    if (allowMissing && response.status === 404) return undefined;
    if (!response.ok) throw new Error(`GitHub ${method} ${endpoint}: HTTP ${response.status} ${await response.text()}`);
    if (response.status === 204) return undefined;
    return response.json();
  }
  async function list(endpoint) {
    const items = [];
    for (let page = 1; ; page++) {
      const batch = await request(`${endpoint}?per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) return items;
    }
  }

  const description = {
    tag_name: tag,
    target_commitish: sha,
    name: tag,
    body: `CBPanel ${tag}.\n\n[Workflow run](https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID ?? ""})\n\nRelease artifacts are unsigned.`,
    // A suffixed tag (`v1.2.3-rc.1`) is a prerelease and must never become "latest".
    prerelease: tag !== `v${version}`,
  };
  let release = await request(`/releases/tags/${tag}`, { allowMissing: true });
  if (release && !release.draft) {
    // A published release is immutable from this workflow's perspective.
    throw new Error(`Release ${tag} is already published.`);
  }
  release ??= await request("/releases", { method: "POST", body: { ...description, draft: true } });

  // A previous attempt may have stopped mid-upload; reuse the draft but drop partial assets.
  for (const asset of await list(`/releases/${release.id}/assets`)) {
    await request(`/releases/assets/${asset.id}`, { method: "DELETE" });
  }
  const uploadBase = release.upload_url.replace(/\{.*$/, "");
  for (const asset of assets) {
    const uploadUrl = new URL(uploadBase);
    uploadUrl.searchParams.set("name", asset.name);
    const bytes = await fs.readFile(asset.filePath);
    const uploaded = await request(uploadUrl.toString(), { method: "POST", body: bytes, upload: true });
    if (uploaded.state !== "uploaded" || uploaded.size !== bytes.length || uploaded.name !== asset.name) {
      throw new Error(`Incomplete release upload: ${asset.name}`);
    }
  }

  const published = await request(`/releases/${release.id}`, {
    method: "PATCH",
    body: { ...description, draft: false, make_latest: description.prerelease ? "false" : "true" },
  });
  if (published.draft) throw new Error(`Release ${tag} was not published.`);
  return `https://github.com/${repository}/releases/tag/${tag}`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const metadata = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  const url = await publishRelease({
    directory: path.resolve(process.argv[2] ?? "release-assets"),
    repository: process.env.GITHUB_REPOSITORY ?? "",
    refName: process.env.CBPANEL_RELEASE_TAG || process.env.GITHUB_REF_NAME || "",
    sha: process.env.GITHUB_SHA ?? "",
    version: metadata.version,
    // release.yml builds every platform, so a release missing one of them is a broken release.
    requiredKinds: ["windows-installer", "windows-portable", "linux-appimage", "macos-dmg"],
    token: process.env.GITHUB_TOKEN,
  });
  console.log(`Release published: ${url}`);
}
