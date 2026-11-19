export interface GithubRepository {
  owner: string;
  repository: string;
}

const NAME_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * Reads a GitHub repository out of a pasted value. Copying a link out of a browser routinely carries
 * the page the operator was looking at (`.../repository/tree/main`, `...?tab=readme-ov-file#readme`), so
 * only the host and the first two path segments identify the repository; a query, a fragment, a port
 * and every further segment are ordinary noise and are dropped. Embedded credentials are refused
 * outright rather than partially stripped: they mean the value is not a repository link.
 *
 * A missing scheme is filled with HTTPS because that is the only form this app stores and reaches.
 */
export function parseGithubRepositoryUrl(value: string): GithubRepository | undefined {
  const raw = value.trim();
  if (!raw) return undefined;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "github.com" && hostname !== "www.github.com") return undefined;
  const [owner, name] = url.pathname.split("/").filter(Boolean);
  if (!owner || !name || !NAME_SEGMENT.test(owner) || !NAME_SEGMENT.test(name)) return undefined;
  if (isRelativeSegment(owner) || isRelativeSegment(name)) return undefined;
  const repository = name.replace(/\.git$/i, "");
  if (!repository || isRelativeSegment(repository)) return undefined;
  return { owner, repository };
}

/** The canonical `owner/repository` pair the GitHub API addresses. */
export function githubRepositoryPath(value: string): string | undefined {
  const repository = parseGithubRepositoryUrl(value);
  return repository ? `${repository.owner}/${repository.repository}` : undefined;
}

/** The canonical URL this app stores; the pasted noise never reaches the server. */
export function normalizeGithubRepositoryUrl(value: string): string | undefined {
  const repository = parseGithubRepositoryUrl(value);
  return repository ? `https://github.com/${repository.owner}/${repository.repository}` : undefined;
}

function isRelativeSegment(value: string): boolean {
  return value === "." || value === "..";
}
