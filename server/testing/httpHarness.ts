import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Boots the real entry point as a child process so route-level contracts can be asserted over HTTP.
 *
 * Deliberately not an app factory: `server/index.ts` is a module-level script — the data directory, every
 * service instance, all routes and `listen` are evaluated on import — so exporting `createApp` would mean
 * rewriting the whole top-level wiring for the sake of a test. A child process also covers what a factory
 * would skip: the real middleware chain, the shell-mode auth branch and the process-wide env reads.
 *
 * The file is intentionally not named `*.test.ts`; `npm test` globs `server/**\/*.test.ts` and would run it.
 */

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY_PATH = path.join(ROOT_DIR, "server", "index.ts");
// A cold `tsx` boot with a fresh SQLite file is ~700ms locally; the budget is for a loaded CI runner, and
// it only decides how long a *broken* boot takes to report.
const READY_TIMEOUT_MS = 60_000;
const READY_POLL_INTERVAL_MS = 25;
const EXIT_TIMEOUT_MS = 5_000;
// Every request is bounded, because nothing above it is: `node:test` applies no default case timeout (and
// `npm test` passes no `--test-timeout`), and an unanswered `fetch` sits on undici's 300s headersTimeout
// before rejecting with a bare `TypeError: fetch failed` that names neither the method nor the route. A
// route that wedges would therefore stall a CI run for five minutes per call and then report nothing usable.
// The budget is far above any route here — the slowest answers in well under a second — so it only ever
// fires on a genuine wedge.
const REQUEST_TIMEOUT_MS = 30_000;
// Enough of the child's output to name the cause (a stack trace, or EADDRINUSE from `listen`).
const OUTPUT_TAIL_LIMIT = 4_000;

export type HarnessResponse = {
  status: number;
  body: unknown;
};

export type PanelHarness = {
  /** The child's `CBPANEL_DATA_DIR`, so a test can stage `browser-data/<id>` directly on disk. */
  readonly dataDir: string;
  readonly baseUrl: string;
  request(method: string, route: string, body?: unknown): Promise<HarnessResponse>;
  /** Kills the child and removes the data directory. Safe to call twice, and after a failed start. */
  dispose(): Promise<void>;
};

export async function startPanelHarness(): Promise<PanelHarness> {
  // Under the system temp directory, never the repository's own `data/`: these tests delete browser data
  // by design, and pointing them at the developer's panel state would be unrecoverable.
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-http-harness-"));
  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let output = "";
  let spawnError: Error | undefined;
  let disposal: Promise<void> | undefined;

  // The promise is cached rather than a boolean flag: a second caller waits for the first cleanup instead
  // of returning while the child is still alive.
  const dispose = async (): Promise<void> => {
    disposal ??= (async () => {
      await stopChild(child, exited);
      // maxRetries covers Windows, where the child's SQLite handle can outlive the process by a beat: an rm
      // that loses that race leaves behind a temp directory nothing will ever clean up.
      await fs.rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return disposal;
  };

  try {
    const port = await reserveFreePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ["--import", "tsx", ENTRY_PATH], {
      cwd: ROOT_DIR,
      env: childEnv(dataDir, port),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // Consumed, not ignored: an unread pipe fills up and stalls the child, and the tail is the only
    // diagnosis available when the readiness probe never succeeds.
    const collect = (chunk: Buffer | string): void => {
      output = `${output}${chunk.toString()}`.slice(-OUTPUT_TAIL_LIMIT);
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.once("error", (error) => {
      spawnError = error;
    });
    exited = new Promise<void>((resolve) => {
      child?.once("exit", () => resolve());
    });

    await waitForReady(baseUrl, () => ({ child, output, spawnError }));

    return {
      dataDir,
      baseUrl,
      request: (method, route, body) => request(baseUrl, method, route, body),
      dispose,
    };
  } catch (error) {
    // The failure path has to clean up too: a harness that threw still owns a child process and a temp
    // directory, and the caller has no handle to either.
    await dispose();
    throw error;
  }
}

/**
 * Every `CBPANEL_*` key is dropped rather than inherited: a developer shell exporting `CBPANEL_SHELL` or
 * `CBPANEL_DESKTOP_TOKEN` would put the child in desktop mode, where `/api` answers 401 and the whole
 * suite fails for a reason that has nothing to do with the code under test.
 *
 * `CBPANEL_API_ONLY` keeps the frontend out. Web mode without it awaits `createFrontendMiddleware()`,
 * which boots a Vite dev server and a watcher over the repository — seconds of work for assets no route
 * test reads. Every `/api` route is registered either way.
 */
function childEnv(dataDir: string, port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("CBPANEL_")) continue;
    env[key] = value;
  }
  env.CBPANEL_DATA_DIR = dataDir;
  env.CBPANEL_API_ONLY = "1";
  env.PORT = String(port);
  return env;
}

/**
 * Binds port 0, reads what the OS handed out, then releases it before the child claims it. Two harnesses
 * starting at once therefore get different ports instead of racing for a hard-coded one. The window
 * between the release and the child's `listen` is not closable from here — if something else takes the
 * port, the child dies with EADDRINUSE and that line is in the timeout error's output tail.
 */
async function reserveFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      probe.close(() => {
        if (port > 0) resolve(port);
        else reject(new Error("Could not read a free port from the probe socket."));
      });
    });
  });
}

/**
 * `GET /` is the readiness probe because in API-only mode nothing on that path reads the database or the
 * filesystem: the one middleware ahead of the handler is the advanced-web-entry check, which returns on its
 * first line for any shell other than `desktop`, and the handler itself answers a literal. So the probe
 * succeeds exactly when `listen` has taken effect, never earlier and never after a slow dependency.
 */
async function waitForReady(
  baseUrl: string,
  state: () => { child: ChildProcess | undefined; output: string; spawnError: Error | undefined },
): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const { child, output, spawnError } = state();
    if (spawnError) throw describeStartFailure(`could not be spawned: ${spawnError.message}`, output);
    // A child that exited will never answer, and waiting out the full budget only delays the report.
    if (child && child.exitCode !== null) {
      throw describeStartFailure(`exited with code ${child.exitCode} before it was ready`, output);
    }
    try {
      // Bounded by whatever is left of the budget, so `READY_TIMEOUT_MS` is the real ceiling. Without a
      // signal a child that accepted the connection and then stalled would hold this `await` for undici's
      // 300s headersTimeout, and the deadline below — which is only read once the fetch settles — would
      // never get a chance to fire.
      const response = await fetch(`${baseUrl}/`, {
        signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
      });
      await response.arrayBuffer();
      if (response.ok) return;
    } catch {
      // Not listening yet.
    }
    if (Date.now() >= deadline) {
      throw describeStartFailure(`did not become ready within ${READY_TIMEOUT_MS}ms at ${baseUrl}`, output);
    }
    await delay(READY_POLL_INTERVAL_MS);
  }
}

function describeStartFailure(reason: string, output: string): Error {
  const tail = output.trim();
  return new Error(`The panel harness ${reason}.${tail ? `\n--- child output ---\n${tail}` : ""}`);
}

async function stopChild(child: ChildProcess | undefined, exited: Promise<void>): Promise<void> {
  // No pid means the spawn itself failed, and there is no "exit" event coming to wait for.
  if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill();
  if (await settled(exited, EXIT_TIMEOUT_MS)) return;
  // A shutdown that will not finish must not wedge the test run: the graceful handler awaits
  // sessionService.stopAll(), which a launch still in flight can hold open.
  child.kill("SIGKILL");
  await settled(exited, EXIT_TIMEOUT_MS);
}

async function request(baseUrl: string, method: string, route: string, body?: unknown): Promise<HarnessResponse> {
  let response: Response;
  try {
    response = await fetch(new URL(route, baseUrl), {
      method,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  } catch (error) {
    // Rewritten rather than propagated: both shapes fetch throws here — the abort and a refused or reset
    // connection — say nothing about which call produced them, and the stack is inside undici. Naming the
    // method and route is the difference between a diagnosis and a rerun.
    const reason = (error as Error).name === "TimeoutError"
      ? `did not answer within ${REQUEST_TIMEOUT_MS}ms`
      : `could not be sent: ${(error as Error).message}`;
    throw Object.assign(new Error(`The panel harness request ${method} ${route} ${reason}.`), { cause: error });
  }
  return { status: response.status, body: await readBody(response) };
}

/**
 * A 204 carries no body at all and `response.json()` would throw on the empty string, so it reads as
 * `undefined`. A non-JSON answer is returned as text rather than discarded — an HTML error page reaching
 * an API route is exactly the kind of failure an assertion needs to be able to print.
 */
async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function settled(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function delay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}
