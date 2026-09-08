import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type { XrayServiceOptions } from "../services/xrayService";

/**
 * A stand-in for the Xray-core binary that the XrayService tests drive through the service's
 * `spawnImpl`/`execFileImpl` seams. It is a Node script rather than a shell script so the same
 * tests run on the Windows CI runner, where a `#!/bin/sh` file cannot be executed.
 *
 * `version` prints the banner the real binary prints; `run -c <config>` reads the config, listens
 * on the SOCKS inbound's port and stays up until told to stop. The `FAKE_XRAY_*` variables the
 * spawn wrapper injects choose the failure mode of one particular launch.
 */
const FAKE_ENGINE_SOURCE = `
import fs from "node:fs";
import net from "node:net";

const args = process.argv.slice(2);
if (args[0] === "version") {
  console.log("Xray 9.9.9-test (Xray, Penetrates Everything.) Custom (go1.99 test/amd64)");
  process.exit(0);
}
if (args[0] !== "run") {
  console.error("unexpected arguments: " + args.join(" "));
  process.exit(2);
}
const config = JSON.parse(fs.readFileSync(args[2], "utf8"));
const port = config.inbounds[0].port;
if (process.env.FAKE_XRAY_FAIL_BIND === "1") {
  console.error("Failed to start: main: failed to load config files: [config.json] > app/proxyman/inbound: failed to listen tcp 127.0.0.1:" + port + " > bind: address already in use");
  process.exit(23);
}
if (process.env.FAKE_XRAY_EXIT_CODE) {
  console.error("Failed to start: main: failed to load config files: [config.json] > fake failure");
  process.exit(Number(process.env.FAKE_XRAY_EXIT_CODE));
}
const server = net.createServer((socket) => {
  socket.on("error", () => undefined);
  socket.end();
});
server.listen(port, "127.0.0.1", () => {
  console.log("Xray 9.9.9-test started on " + port);
});
const crashAfterMs = Number(process.env.FAKE_XRAY_CRASH_AFTER_MS || "0");
if (crashAfterMs > 0) {
  setTimeout(() => {
    console.error("fake engine crashing on purpose");
    process.exit(9);
  }, crashAfterMs);
}
const stop = () => {
  server.close();
  process.exit(0);
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
`;

export type FakeEngineLaunchPlan = {
  failBind?: boolean;
  exitCode?: number;
  crashAfterMs?: number;
};

export type FakeXrayEngine = {
  scriptPath: string;
  spawnCount: number;
  /** Decides how the next launch behaves; the plan is consumed by one spawn. */
  plans: FakeEngineLaunchPlan[];
  spawnImpl: NonNullable<XrayServiceOptions["spawnImpl"]>;
  execFileImpl: NonNullable<XrayServiceOptions["execFileImpl"]>;
};

export async function writeFakeXrayEngine(directory: string): Promise<FakeXrayEngine> {
  const scriptPath = path.join(directory, "fake-xray.mjs");
  await fs.writeFile(scriptPath, FAKE_ENGINE_SOURCE);
  const engine: FakeXrayEngine = {
    scriptPath,
    spawnCount: 0,
    plans: [],
    spawnImpl: ((_command: string, args: readonly string[], options: Parameters<typeof spawn>[2]) => {
      engine.spawnCount += 1;
      const plan = engine.plans.shift() ?? {};
      const env: NodeJS.ProcessEnv = { ...(options?.env ?? process.env) };
      if (plan.failBind) env.FAKE_XRAY_FAIL_BIND = "1";
      if (plan.exitCode !== undefined) env.FAKE_XRAY_EXIT_CODE = String(plan.exitCode);
      if (plan.crashAfterMs !== undefined) env.FAKE_XRAY_CRASH_AFTER_MS = String(plan.crashAfterMs);
      return spawn(process.execPath, [scriptPath, ...args], { ...options, env });
    }) as unknown as typeof spawn,
    execFileImpl: ((_file: string, args: readonly string[], options: unknown, callback: unknown) =>
      execFile(process.execPath, [scriptPath, ...args], options as Parameters<typeof execFile>[2], callback as never)
    ) as unknown as typeof execFile,
  };
  return engine;
}
