import assert from "node:assert/strict";
import test from "node:test";
import { CLOAKBROWSER_GEOIP_DB_URL, rewriteGithubDownloadUrl } from "./githubMirror";

test("rewriteGithubDownloadUrl leaves the retired official archive path alone", () => {
  // The official core is license-gated now; this shape 404s at the origin, so rewriting it would only
  // point a mirror at a dead asset.
  assert.equal(
    rewriteGithubDownloadUrl(
      "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
      "https://gh-proxy.com/",
    ),
    undefined,
  );
  assert.equal(
    rewriteGithubDownloadUrl(
      "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
      "https://gh-proxy.com/",
    ),
    undefined,
  );
});

test("rewriteGithubDownloadUrl mirrors the GeoIP database URL", () => {
  assert.equal(
    rewriteGithubDownloadUrl(
      CLOAKBROWSER_GEOIP_DB_URL,
      "https://ghproxy.net///",
    )?.rewrittenUrl,
    "https://ghproxy.net/https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb",
  );
});

test("rewriteGithubDownloadUrl mirrors the public Pro checksum manifest but never the authenticated archive", () => {
  const expected = "https://gh-proxy.com/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v156.0.8078.47.1-pro/SHA256SUMS";

  const sums = rewriteGithubDownloadUrl(
    "https://cloakbrowser.dev/releases/pro/chromium-v156.0.8078.47.1/SHA256SUMS",
    "https://gh-proxy.com/",
  );
  assert.equal(sums?.rewrittenUrl, expected);
  assert.equal(sums?.kind, "cloakbrowser-pro-manifest");

  const sig = rewriteGithubDownloadUrl(
    "https://cloakbrowser.dev/releases/pro/chromium-v156.0.8078.47.1/SHA256SUMS.sig",
    "https://gh-proxy.com/",
  );
  assert.equal(sig?.rewrittenUrl, `${expected}.sig`);
  assert.equal(sig?.kind, "cloakbrowser-pro-manifest");

  // The archive request carries a bearer token, so it must stay on the official origin.
  assert.equal(
    rewriteGithubDownloadUrl("https://cloakbrowser.dev/api/download/156.0.8078.47.1", "https://gh-proxy.com/"),
    undefined,
  );
  assert.equal(
    rewriteGithubDownloadUrl("https://cloakbrowser.dev/releases/pro/chromium-v156.0.8078.47.1/other.txt", "https://gh-proxy.com/"),
    undefined,
  );
});

test("rewriteGithubDownloadUrl does not rewrite unrelated GitHub or API URLs", () => {
  assert.equal(rewriteGithubDownloadUrl("https://cloakbrowser.dev/api/license/validate", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://cloakbrowser.dev/api/download/latest?channel=preview", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://api.github.com/repos/CloakHQ/cloakbrowser/releases", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://github.com/example/repo/archive/main.zip", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://release-assets.githubusercontent.com/example", "https://gh-proxy.com/"), undefined);
});
