import assert from "node:assert/strict";
import test from "node:test";

import { readHostDiagnostics } from "./hostDiagnostics";

// The host block has to answer on whatever machine CI runs on: no probe may throw, and the three
// fields the payload always carried must survive so an older consumer keeps working.
test("host diagnostics always report the kernel family, architecture and Node version", async () => {
  const host = await readHostDiagnostics();

  assert.equal(typeof host.os, "string");
  assert.ok(host.os.length > 0);
  assert.equal(host.arch, process.arch);
  assert.equal(host.node, process.version);
  // The optional fields are strings when present, never empty placeholders.
  for (const value of [host.osName, host.osVersion]) {
    assert.ok(value === undefined || value.trim().length > 0, `expected a non-empty value, got ${JSON.stringify(value)}`);
  }
});
