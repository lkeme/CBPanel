import assert from "node:assert/strict";
import test from "node:test";
import { CLOAKBROWSER_GEOIP_DB_URL, rewriteGithubDownloadUrl } from "./githubMirror";

test("rewriteGithubDownloadUrl normalizes CloakBrowser official URLs to mirrored GitHub release URLs", () => {
  const result = rewriteGithubDownloadUrl(
    "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
    "https://gh-proxy.com/",
  );

  assert.equal(
    result?.rewrittenUrl,
    "https://gh-proxy.com/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/cloakbrowser-windows-x64.zip",
  );
  assert.equal(result?.kind, "cloakbrowser-core");
});

test("rewriteGithubDownloadUrl mirrors CloakBrowser checksum and GeoIP database URLs", () => {
  assert.equal(
    rewriteGithubDownloadUrl(
      "https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/SHA256SUMS",
      "https://ghproxy.vip///",
    )?.rewrittenUrl,
    "https://ghproxy.vip/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/SHA256SUMS",
  );
  assert.equal(
    rewriteGithubDownloadUrl(
      "https://cloakbrowser.dev/chromium-v146.0.7680.177.5/SHA256SUMS.sig",
      "https://ghproxy.vip///",
    )?.rewrittenUrl,
    "https://ghproxy.vip/https://github.com/CloakHQ/cloakbrowser/releases/download/chromium-v146.0.7680.177.5/SHA256SUMS.sig",
  );
  assert.equal(
    rewriteGithubDownloadUrl(CLOAKBROWSER_GEOIP_DB_URL, "https://ghproxy.vip/")?.rewrittenUrl,
    "https://ghproxy.vip/https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb",
  );
});

test("rewriteGithubDownloadUrl does not rewrite unrelated GitHub or API URLs", () => {
  assert.equal(rewriteGithubDownloadUrl("https://api.github.com/repos/CloakHQ/cloakbrowser/releases", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://github.com/example/repo/archive/main.zip", "https://gh-proxy.com/"), undefined);
  assert.equal(rewriteGithubDownloadUrl("https://release-assets.githubusercontent.com/example", "https://gh-proxy.com/"), undefined);
});
