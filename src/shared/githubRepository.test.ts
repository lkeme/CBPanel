import assert from "node:assert/strict";
import test from "node:test";

import {
  githubRepositoryPath,
  normalizeGithubRepositoryUrl,
  parseGithubRepositoryUrl,
} from "./githubRepository";

test("a repository URL keeps only the host and the first two path segments", () => {
  assert.deepEqual(parseGithubRepositoryUrl("https://github.com/owner/repository"), { owner: "owner", repository: "repository" });
  for (const value of [
    "https://github.com/owner/repository/tree/main/apps/site",
    "https://github.com/owner/repository/releases/tag/v1.0.0",
    "https://github.com/owner/repository?tab=readme-ov-file",
    "https://github.com/owner/repository#install",
    "https://github.com/owner/repository/tree/main?tab=readme-ov-file#install",
    "https://github.com/owner/repository/",
    "  https://github.com/owner/repository  ",
  ]) {
    assert.equal(normalizeGithubRepositoryUrl(value), "https://github.com/owner/repository", value);
  }
});

test("the scheme may be omitted and .git is the same repository", () => {
  assert.equal(normalizeGithubRepositoryUrl("github.com/owner/repository"), "https://github.com/owner/repository");
  assert.equal(normalizeGithubRepositoryUrl("https://github.com/owner/repository.git"), "https://github.com/owner/repository");
  assert.equal(normalizeGithubRepositoryUrl("https://www.github.com/owner/repository"), "https://github.com/owner/repository");
});

test("values that are not a GitHub repository are rejected", () => {
  for (const value of [
    "",
    "   ",
    "owner/repository",
    "https://gitlab.com/owner/repository",
    "https://github.com.evil.test/owner/repository",
    "https://user:password@github.com/owner/repository",
    "https://github.com:444/owner/repository",
    "http://github.com/owner/repository",
    "https://github.com/owner",
    "https://github.com/owner/",
    "https://github.com/../repository",
    "https://github.com/owner/..",
    "https://github.com/owner repo/repository",
  ]) {
    assert.equal(parseGithubRepositoryUrl(value), undefined, value);
  }
});

test("the API path is owner/repository", () => {
  assert.equal(githubRepositoryPath("https://github.com/owner/repository/tree/main"), "owner/repository");
  assert.equal(githubRepositoryPath("https://github.com/owner/repository.git"), "owner/repository");
  assert.equal(githubRepositoryPath("not a url"), undefined);
});
