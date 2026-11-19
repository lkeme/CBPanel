import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  allocateLocalProxyPort,
  isLocalPortListening,
  isXrayLocalBindFailure,
  waitForLocalPortReady,
} from "./xrayLocalPort";

test("allocateLocalProxyPort hands out a loopback port that is free for TCP and UDP", async () => {
  const port = await allocateLocalProxyPort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536);
  assert.equal(await isLocalPortListening(port), false);
});

test("isLocalPortListening and waitForLocalPortReady follow a real listener", async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    assert.equal(await isLocalPortListening(port), true);
    assert.equal(await waitForLocalPortReady(port, 500), true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert.equal(await isLocalPortListening(port), false);
  assert.equal(await waitForLocalPortReady(port, 120, { intervalMs: 20 }), false);
  let alive = true;
  const started = Date.now();
  const ready = waitForLocalPortReady(port, 5_000, { intervalMs: 10, stillAlive: () => alive });
  alive = false;
  assert.equal(await ready, false);
  assert.ok(Date.now() - started < 2_000, "an exited process short-circuits the wait");
});

test("isXrayLocalBindFailure recognises Xray bind errors for the port in question", () => {
  const log = "Failed to start: main: failed to load config files: [config.json] > app/proxyman/inbound: failed to listen tcp 127.0.0.1:34567 > bind: address already in use";
  assert.equal(isXrayLocalBindFailure(log, 34567), true);
  assert.equal(isXrayLocalBindFailure(log, 34568), false);
  assert.equal(isXrayLocalBindFailure(log), true);
  assert.equal(isXrayLocalBindFailure("Xray 25.1.1 started", 34567), false);
  assert.equal(isXrayLocalBindFailure("", 1), false);
  const windows = "Failed to start: ... listen tcp 127.0.0.1:5000: bind: An attempt was made to access a socket in a way forbidden by its access permissions.";
  assert.equal(isXrayLocalBindFailure(windows, 5000), true);
});
