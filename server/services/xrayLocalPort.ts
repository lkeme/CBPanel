import { createSocket } from "node:dgram";
import { createServer, connect } from "node:net";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * A loopback port that is free for both TCP and UDP at once. Xray's SOCKS inbound binds both
 * (UDP for `udp: true`), and a port that only the TCP side can take makes the engine fail to start
 * with a bind error that looks like a random crash. Adapted from GeekezBrowser's local-proxy-port.js.
 */
export async function allocateLocalProxyPort(options: { host?: string; maxAttempts?: number } = {}): Promise<number> {
  const host = options.host ?? LOOPBACK_HOST;
  const maxAttempts = options.maxAttempts ?? 20;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const port = await listenTcpOnFreePort(host);
      try {
        await bindUdp(host, port);
        return port;
      } finally {
        // The TCP listener was released by listenTcpOnFreePort before the UDP probe; nothing to close.
      }
    } catch (error) {
      lastError = error;
    }
  }
  throw Object.assign(new Error(`Unable to allocate a local TCP/UDP proxy port after ${maxAttempts} attempts`), {
    code: "LOCAL_PROXY_PORT_UNAVAILABLE",
    cause: lastError,
  });
}

/** Xray's own words for "the inbound could not bind", so a retry on a fresh port is targeted rather than blind. */
export function isXrayLocalBindFailure(logText: string, port?: number): boolean {
  const text = String(logText ?? "");
  if (!text) return false;
  const bindFailure = /failed to (?:start|listen)[\s\S]*?(?:listen\s+(?:tcp|udp)|address already in use|bind:|access permissions|forbidden by its access permissions|WSAEACCES|WSAEADDRINUSE)/i;
  const genericBind = /(?:address already in use|bind: permission denied|WSAEACCES|WSAEADDRINUSE|EADDRINUSE)/i;
  if (!bindFailure.test(text) && !genericBind.test(text)) return false;
  if (!Number.isInteger(port)) return true;
  return new RegExp(`(?:127\\.0\\.0\\.1|localhost|\\[::1\\]|0\\.0\\.0\\.0|:):${Number(port)}\\b`).test(text);
}

/** True once something accepts TCP connections on the port — how the engine signals its inbound is up. */
export function isLocalPortListening(port: number, host = LOOPBACK_HOST, timeoutMs = 300): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = connect({ host, port });
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function waitForLocalPortReady(
  port: number,
  timeoutMs: number,
  options: { host?: string; stillAlive?: () => boolean; intervalMs?: number } = {},
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const intervalMs = options.intervalMs ?? 50;
  while (Date.now() < deadline) {
    if (options.stillAlive && !options.stillAlive()) return false;
    if (await isLocalPortListening(port, options.host)) return true;
    await sleep(intervalMs);
  }
  return false;
}

function listenTcpOnFreePort(host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host, port: 0, exclusive: true }, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("Could not read the port of the probe listener."))));
    });
  });
}

function bindUdp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(error);
    });
    socket.bind({ address: host, port, exclusive: true }, () => {
      socket.close(() => resolve());
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
