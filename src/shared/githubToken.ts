export type GithubTokenKind = "fine-grained" | "classic";

// Fine-grained tokens open with `github_pat_` and classic ones with `ghp_`; both continue with a
// base62 secret. The tail has a minimum length rather than an exact one: the prefix identifies the
// kind, and the connection test is what proves the credential itself.
const FINE_GRAINED = /^github_pat_[A-Za-z0-9_]{40,}$/;
const CLASSIC = /^ghp_[A-Za-z0-9]{36,}$/;

/**
 * Which supported GitHub credential shape this value has, or `undefined` when it is neither. An empty
 * value is "nothing typed", not an invalid key, so it is `undefined` here and the caller decides
 * whether a previously saved key stands in for it.
 */
export function githubTokenKind(value: string): GithubTokenKind | undefined {
  const token = value.trim();
  if (FINE_GRAINED.test(token)) return "fine-grained";
  if (CLASSIC.test(token)) return "classic";
  return undefined;
}
