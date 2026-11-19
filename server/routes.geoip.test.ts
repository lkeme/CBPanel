import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import type { CloakBrowserDiagnostics } from "../src/shared/browserCore";
import type { SystemDiagnostics } from "../src/shared/entities";
import { startPanelHarness, type PanelHarness } from "./testing/httpHarness";

/**
 * Route-level wiring of the launch-GeoIP resolution — CBPanel's mirror of `cloakbrowser info --proxy`.
 *
 * Its own file rather than a section of `routes.test.ts`: that file's contracts are all about environment
 * deletion, and its shared child process is staged for that. What can only be seen here is the plumbing —
 * that `?proxyId=` is read at all, that an unknown id is refused before any probe runs, and above all that
 * a diagnostics call *without* a proxy still resolves nothing. The service-level behaviour is already
 * pinned by `binaryService.test.ts` and `proxyService.test.ts`, which cannot see any of that.
 *
 * Every case below is deliberately network-free: no case supplies a reachable proxy, so nothing here
 * depends on an egress path being available in CI.
 */

let panel: PanelHarness;

before(async () => {
  panel = await startPanelHarness();
});

after(async () => {
  await panel?.dispose();
});

// The contract that keeps the panel's routine polling free: upstream leaves plain `info` without a single
// network call, and this route is polled on every visit to the system view. A `resolved` block appearing
// here would mean every diagnostics read had started probing a proxy.
test("diagnostics without a proxy id resolve no GeoIP and report the cache path", async () => {
  const response = await panel.request("GET", "/api/system/diagnostics");

  assert.equal(response.status, 200);
  const geoip = wrapperDiagnostics(response.body).geoip;
  assert.equal(geoip?.resolved, undefined);
  // The database row itself is unconditional — it is a filesystem probe, not a resolution.
  assert.match(geoip?.path ?? "", /GeoLite2-City\.mmdb$/);
  assert.equal(typeof geoip?.dbPresent, "boolean");
});

// An empty parameter is what a UI sends when its proxy picker is on "none". It has to read as "do not
// resolve" rather than as a lookup for the proxy whose id is the empty string, which would 404 the whole
// diagnostics payload over a control that was simply left unset.
test("an empty proxy id is treated as no proxy at all", async () => {
  const response = await panel.request("GET", "/api/system/diagnostics?proxyId=");

  assert.equal(response.status, 200);
  assert.equal(wrapperDiagnostics(response.body).geoip?.resolved, undefined);
});

// Refused before any probe: resolving an id that is not in the library would otherwise fall through to a
// proxy-less resolution and report the machine's own exit as if it were the proxy's.
test("an unknown proxy id is refused with 404", async () => {
  const response = await panel.request("GET", "/api/system/diagnostics?proxyId=not-a-real-proxy");

  assert.equal(response.status, 404);
  assert.match((response.body as { error?: string }).error ?? "", /代理不存在/);
});

// The route exists and validates before reaching for the network. An incomplete proxy is the one input
// that can be rejected without an egress path, so it is what pins the route's presence in CI.
test("the launch-geoip route rejects an incomplete proxy before probing", async () => {
  const response = await panel.request("POST", "/api/proxy/geoip", {
    proxy: { enabled: true, host: "", port: "" },
  });

  assert.equal(response.status, 400);
  assert.match((response.body as { error?: string }).error ?? "", /代理未启用或不完整/);
});

test("the launch-geoip route rejects a disabled proxy", async () => {
  const response = await panel.request("POST", "/api/proxy/geoip", {
    proxy: { enabled: false, raw: "http://proxy.example.test:8080" },
  });

  assert.equal(response.status, 400);
});

function wrapperDiagnostics(body: unknown): CloakBrowserDiagnostics {
  const diagnostics = (body as SystemDiagnostics).browserCoreDiagnostics;
  assert.ok(diagnostics, "diagnostics payload is missing browserCoreDiagnostics");
  return diagnostics;
}
