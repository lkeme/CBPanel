import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PrivateCoreSecretStore } from "./privateCoreSecretStore";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((done) => { resolve = done; }), resolve: () => resolve() };
}

function verifiedFixturePath(directory: string): string {
  const resolved = path.resolve(directory);
  const relative = path.relative(path.resolve(os.tmpdir()), resolved);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "fixture cleanup must stay under the system temporary directory");
  assert.ok(path.basename(resolved).startsWith("private-core-"), "fixture cleanup must name a private-core test directory");
  return resolved;
}

async function removeFixture(directory: string): Promise<void> {
  await fs.rm(verifiedFixturePath(directory), { recursive: true, force: true });
}

function credentialProcess(directory: string, pauseAt?: "published-lock" | "preparing-lock") {
  const script = `
    import fs from "node:fs/promises";
    import path from "node:path";
    import { PrivateCoreSecretStore } from ${JSON.stringify(new URL("./privateCoreSecretStore.ts", import.meta.url).href)};
    const directory = process.argv[1];
    const pauseAt = process.argv[2];
    const lockPath = path.join(directory, "private-core-credential-id.lock");
    const pause = async () => {
      process.send({ state: "paused" });
      setInterval(() => {}, 1000);
      await new Promise(() => {});
    };
    if (pauseAt === "published-lock") {
      const rename = fs.rename;
      fs.rename = async (source, target) => {
        await rename(source, target);
        if (target === lockPath) await pause();
      };
    } else if (pauseAt === "preparing-lock") {
      const mkdir = fs.mkdir;
      fs.mkdir = async (directory, options) => {
        const result = await mkdir(directory, options);
        if (String(directory).startsWith(lockPath + ".") && String(directory).endsWith(".pending")) await pause();
        return result;
      };
    }
    let target;
    const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform: "win32", env: {}, run: async (_file, _args, input) => {
      target = JSON.parse(input).target;
      return "";
    } });
    await store.read();
    process.send({ state: "completed", target }, () => process.disconnect());
  `;
  const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, directory, pauseAt ?? ""], { windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = "";
  child.stderr!.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<void>((resolve) => { child.once("close", () => resolve()); });
  const message = new Promise<{ state: string; target?: string }>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("Credential fixture child timed out.")); }, 10_000);
    child.once("message", (value) => { clearTimeout(timeout); resolve(value as { state: string; target?: string }); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Credential fixture child exited before its result (${code}): ${stderr}`)); });
  });
  return { child, message, exited, stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await exited; } };
}

test("desktop credentials use OS stores and stdin, with cached reads and no token in process arguments", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-credential-fixture-"));
  const calls: Array<{ file: string; args: string[]; input?: string }> = [];
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform: "win32", env: {}, run: async (file, args, input) => {
    calls.push({ file, args, input });
    return "fixture-value";
  } });
  try {
  assert.equal(await store.read(), "fixture-value");
  assert.equal(await store.read(), "fixture-value");
  assert.equal(calls.length, 1);
  await store.write("new-fixture-token");
  assert.equal(await store.read(), "new-fixture-token");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => !call.args.join(" ").includes("new-fixture-token")));
  assert.equal(JSON.parse(calls[1].input ?? "{}").token, "new-fixture-token");
  await store.write("");
  assert.equal(await store.read(), undefined);
  } finally { await removeFixture(directory); }
});

test("Web credentials use an independent owner-only file and the environment takes precedence", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-secret-test-"));
  const env: NodeJS.ProcessEnv = {};
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: false, env });
  try {
    await store.write("web-fixture-token");
    assert.equal(await store.read(), "web-fixture-token");
    assert.equal((await fs.readdir(directory)).join(","), "private-github-token");
    if (process.platform !== "win32") assert.equal((await fs.stat(path.join(directory, "private-github-token"))).mode & 0o777, 0o600);
    env.CBPANEL_PRIVATE_GITHUB_TOKEN = "environment-fixture-token";
    assert.equal(await store.read(), "environment-fixture-token");
    await assert.rejects(store.write(""), { code: "PRIVATE_TOKEN_ENV_MANAGED" });
    await assert.rejects(store.write("replacement-fixture-token"), { code: "PRIVATE_TOKEN_ENV_MANAGED" });
    delete env.CBPANEL_PRIVATE_GITHUB_TOKEN;
    await store.write("");
    assert.equal(await store.read(), undefined);
    assert.deepEqual(await fs.readdir(directory), []);
    await assert.rejects(store.write("bad\ntoken"), { code: "PRIVATE_TOKEN_INVALID" });
  } finally { await removeFixture(directory); }
});

test("macOS and Linux writes send secrets over stdin and unavailable keyrings report a sanitized error", async () => {
  for (const platform of ["darwin", "linux"] as const) {
    const calls: Array<{ args: string[]; input?: string }> = [];
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-os-mock-"));
    const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform, env: {}, run: async (_file, args, input) => { calls.push({ args, input }); return ""; } });
    try {
      await store.write("platform-fixture-token");
      assert.ok(!calls[0].args.join(" ").includes("platform-fixture-token"));
      assert.ok(calls[0].input?.includes("platform-fixture-token"));
    } finally { await removeFixture(directory); }
  }
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-keyring-failure-"));
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform: "linux", env: {}, run: async () => { throw new Error("sensitive internal detail"); } });
  try {
    await assert.rejects(store.read(), (error: Error & { code?: string }) => error.code === "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" && !error.message.includes("sensitive internal detail"));
  } finally { await removeFixture(directory); }
});

test("Windows Credential Manager roundtrip uses an isolated temporary target", { skip: process.platform !== "win32" }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-credential-roundtrip-"));
  const original = path.join(directory, "private-core-original");
  const moved = path.join(directory, "private-core-moved");
  const options = { dataDir: original, desktop: true, env: {} };
  const first = new PrivateCoreSecretStore(options);
  let cleanupStore = first;
  try {
    await first.write("cbpanel-fixture-for-os-store");
    assert.equal(await new PrivateCoreSecretStore(options).read(), "cbpanel-fixture-for-os-store");
    await fs.rename(verifiedFixturePath(original), verifiedFixturePath(moved));
    cleanupStore = new PrivateCoreSecretStore({ ...options, dataDir: moved });
    assert.equal(await cleanupStore.read(), "cbpanel-fixture-for-os-store");
    await cleanupStore.write("");
    assert.equal(await new PrivateCoreSecretStore({ ...options, dataDir: moved }).read(), undefined);
    assert.deepEqual(await fs.readdir(moved), ["private-core-credential-id"]);
  } finally { await cleanupStore.write(""); await removeFixture(directory); }
});

test("an in-flight OS read cannot overwrite a newer write's cached credential", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-read-order-"));
  const reading = deferred();
  const finishRead = deferred();
  let stored = "old-fixture";
  let writeStarted = false;
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform: "win32", env: {}, run: async (_file, _args, input) => {
    const request = JSON.parse(input ?? "{}");
    if (request.action === "read") {
      const snapshot = stored;
      reading.resolve();
      await finishRead.promise;
      return snapshot;
    }
    writeStarted = true;
    stored = request.token;
    return "";
  } });
  try {
    const oldRead = store.read();
    await reading.promise;
    const write = store.write("new-fixture");
    const newRead = store.read();
    await Promise.resolve();
    assert.equal(writeStarted, false);
    finishRead.resolve();
    assert.equal(await oldRead, "old-fixture");
    await write;
    assert.equal(await newRead, "new-fixture");
    assert.equal(await store.read(), stored);
  } finally { finishRead.resolve(); await removeFixture(directory); }
});

test("concurrent writes, reads and clears observe their invocation order", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-write-order-"));
  const writing = deferred();
  const finishWrite = deferred();
  const mutations: string[] = [];
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform: "win32", env: {}, run: async (_file, _args, input) => {
    const request = JSON.parse(input ?? "{}");
    mutations.push(`${request.action}:${request.token}`);
    if (request.action === "write" && request.token === "first-fixture") {
      writing.resolve();
      await finishWrite.promise;
    }
    return "";
  } });
  try {
    const first = store.write("first-fixture");
    await writing.promise;
    const second = store.write("second-fixture");
    const middle = store.read();
    const clear = store.write("");
    const final = store.read();
    await Promise.resolve();
    assert.deepEqual(mutations, ["write:first-fixture"]);
    finishWrite.resolve();
    await Promise.all([first, second, clear]);
    assert.equal(await middle, "second-fixture");
    assert.equal(await final, undefined);
    assert.deepEqual(mutations, ["write:first-fixture", "write:second-fixture", "delete:"]);
  } finally { finishWrite.resolve(); await removeFixture(directory); }
});

test("failed writes and clears preserve the prior credential and do not block later operations", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-failed-write-"));
  let stored = "initial-fixture";
  let failClear = false;
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, platform: "win32", env: {}, run: async (_file, _args, input) => {
    const request = JSON.parse(input ?? "{}");
    if (request.action === "read") return stored;
    if (request.token === "rejected-fixture" || (request.action === "delete" && failClear)) throw new Error("fixture OS storage failure");
    stored = request.action === "delete" ? "" : request.token;
    return "";
  } });
  try {
    assert.equal(await store.read(), "initial-fixture");
    const rejected = store.write("rejected-fixture");
    const afterRejected = store.read();
    await assert.rejects(rejected, { code: "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" });
    assert.equal(await afterRejected, "initial-fixture");
    await store.write("accepted-fixture");
    failClear = true;
    const rejectedClear = store.write("");
    const afterRejectedClear = store.read();
    await assert.rejects(rejectedClear, { code: "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" });
    assert.equal(await afterRejectedClear, "accepted-fixture");
    assert.equal(stored, "accepted-fixture");
    failClear = false;
    await store.write("");
    assert.equal(await store.read(), undefined);
  } finally { await removeFixture(directory); }
});

test("Web credential writes remain atomic across instances and leave no shared temporary file", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-web-concurrent-"));
  const first = new PrivateCoreSecretStore({ dataDir: directory, desktop: false, env: {} });
  const second = new PrivateCoreSecretStore({ dataDir: directory, desktop: false, env: {} });
  try {
    await Promise.all([first.write("first-fixture"), second.write("second-fixture")]);
    assert.ok(["first-fixture", "second-fixture"].includes((await first.read()) ?? ""));
    const a = first.write("ordered-first-fixture");
    const b = first.write("ordered-second-fixture");
    const c = first.read();
    const d = first.write("");
    const e = first.read();
    await Promise.all([a, b, d]);
    assert.equal(await c, "ordered-second-fixture");
    assert.equal(await e, undefined);
    assert.deepEqual(await fs.readdir(directory), []);
    await first.write("retained-fixture");
    await assert.rejects(first.write("invalid\nfixture"), { code: "PRIVATE_TOKEN_INVALID" });
    assert.equal(await first.read(), "retained-fixture");
    assert.deepEqual(await fs.readdir(directory), ["private-github-token"]);
  } finally { await removeFixture(directory); }
});

test("Web instances serialize repeated replacements, reads and clears for the same normalized path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-web-replacements-"));
  const alias = process.platform === "win32" ? directory.toUpperCase() : `${directory}${path.sep}.`;
  const stores = Array.from({ length: 8 }, (_, index) => new PrivateCoreSecretStore({ dataDir: index % 2 ? alias : directory, desktop: false, env: {} }));
  try {
    for (let round = 0; round < 20; round += 1) {
      const writes = stores.map((store, index) => store.write(`round-${round}-${index}-fixture`));
      const beforeClear = stores[0].read();
      const clear = stores[1].write("");
      const afterClear = stores[2].read();
      await Promise.all([...writes, clear]);
      assert.equal(await beforeClear, `round-${round}-7-fixture`);
      assert.equal(await afterClear, undefined);
      assert.deepEqual(await fs.readdir(directory), []);
    }
  } finally { await removeFixture(directory); }
});

test("a failed Web replacement preserves the old credential and does not poison other instances' queue", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-web-failure-"));
  const first = new PrivateCoreSecretStore({ dataDir: directory, desktop: false, env: {} });
  const second = new PrivateCoreSecretStore({ dataDir: directory, desktop: false, env: {} });
  const rename = fs.rename;
  try {
    await first.write("retained-fixture");
    fs.rename = async (source, target) => {
      if (String(target) === path.join(directory, "private-github-token")) throw Object.assign(new Error("Fixture destination is temporarily locked."), { code: "EPERM" });
      await rename(source, target);
    };
    const rejected = first.write("rejected-fixture");
    const afterRejected = second.read();
    await assert.rejects(rejected, { code: "EPERM" });
    assert.equal(await afterRejected, "retained-fixture");
    assert.deepEqual(await fs.readdir(directory), ["private-github-token"]);
    fs.rename = rename;
    await second.write("accepted-fixture");
    assert.equal(await first.read(), "accepted-fixture");
  } finally { fs.rename = rename; await removeFixture(directory); }
});

test("a live identity lock is retained and a new process recovers it after its owner is terminated", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-killed-owner-"));
  const owner = credentialProcess(directory, "published-lock");
  const recoveries: ReturnType<typeof credentialProcess>[] = [];
  try {
    assert.equal((await owner.message).state, "paused");
    const lockPath = path.join(directory, "private-core-credential-id.lock");
    const before = await fs.readdir(lockPath);
    assert.ok(before.some((name) => name.startsWith(`owner-${owner.child.pid}-`)));
    const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, env: {}, run: async () => { throw new Error("A live owner must prevent access."); } });
    await assert.rejects(store.read(), { code: "PRIVATE_TOKEN_STORAGE_UNAVAILABLE" });
    assert.deepEqual(await fs.readdir(lockPath), before);
    await assert.rejects(fs.stat(path.join(directory, "private-core-credential-id")), { code: "ENOENT" });
    await owner.stop();
    recoveries.push(...Array.from({ length: 4 }, () => credentialProcess(directory)));
    const results = await Promise.all(recoveries.map((recovery) => recovery.message));
    await Promise.all(recoveries.map((recovery) => recovery.exited));
    const identity = (await fs.readFile(path.join(directory, "private-core-credential-id"), "utf8")).trim();
    assert.ok(results.every((result) => result.state === "completed" && result.target === `CBPanel/private-core/${identity}`));
    assert.deepEqual(await fs.readdir(directory), ["private-core-credential-id"]);
  } finally { await owner.stop(); await Promise.all(recoveries.map((recovery) => recovery.stop())); await removeFixture(directory); }
});

test("a new process recovers preparation interrupted immediately after mkdir and an older empty lock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-killed-preparation-"));
  const owner = credentialProcess(directory, "preparing-lock");
  let recovery: ReturnType<typeof credentialProcess> | undefined;
  try {
    assert.equal((await owner.message).state, "paused");
    const entries = await fs.readdir(directory);
    assert.equal(entries.length, 1);
    assert.match(entries[0], new RegExp(`\\.lock\\.${owner.child.pid}\\..*\\.pending$`));
    assert.deepEqual(await fs.readdir(path.join(directory, entries[0])), []);
    await owner.stop();
    await fs.mkdir(path.join(directory, "private-core-credential-id.lock"));
    recovery = credentialProcess(directory);
    assert.equal((await recovery.message).state, "completed");
    await recovery.exited;
    assert.deepEqual(await fs.readdir(directory), ["private-core-credential-id"]);
  } finally { await owner.stop(); await recovery?.stop(); await removeFixture(directory); }
});

test("concurrent Desktop instances publish one stable credential identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-identity-concurrent-"));
  const targets = new Set<string>();
  const options = { dataDir: directory, desktop: true, platform: "win32" as const, env: {}, run: async (_file: string, _args: string[], input?: string) => {
    targets.add(JSON.parse(input ?? "{}").target);
    return "";
  } };
  try {
    await Promise.all(Array.from({ length: 8 }, () => new PrivateCoreSecretStore(options).read()));
    assert.equal(targets.size, 1);
    const identity = (await fs.readFile(path.join(directory, "private-core-credential-id"), "utf8")).trim();
    assert.match(identity, /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/);
    assert.equal([...targets][0], `CBPanel/private-core/${identity}`);
    assert.deepEqual(await fs.readdir(directory), ["private-core-credential-id"]);
  } finally { await removeFixture(directory); }
});

test("moving a Desktop data directory keeps the same credential and a damaged identity is not replaced", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-portable-identity-"));
  const original = path.join(directory, "private-core-original");
  const moved = path.join(directory, "private-core-moved");
  const credentials = new Map<string, string>();
  let commands = 0;
  const run = async (_file: string, _args: string[], input?: string) => {
    commands += 1;
    const request = JSON.parse(input ?? "{}");
    if (request.action === "read") return credentials.get(request.target) ?? "";
    if (request.action === "delete") credentials.delete(request.target);
    else credentials.set(request.target, request.token);
    return "";
  };
  const options = { desktop: true, platform: "win32" as const, env: {}, run };
  try {
    await new PrivateCoreSecretStore({ ...options, dataDir: original }).write("portable-fixture-token");
    const identity = await fs.readFile(path.join(original, "private-core-credential-id"), "utf8");
    await fs.rename(verifiedFixturePath(original), verifiedFixturePath(moved));
    assert.equal(await new PrivateCoreSecretStore({ ...options, dataDir: moved }).read(), "portable-fixture-token");
    assert.equal(credentials.size, 1);
    await fs.writeFile(path.join(moved, "private-core-credential-id"), "damaged-identity", "utf8");
    const before = commands;
    const damaged = new PrivateCoreSecretStore({ ...options, dataDir: moved });
    await assert.rejects(damaged.read(), { code: "PRIVATE_TOKEN_IDENTITY_INVALID" });
    await assert.rejects(damaged.write("replacement-fixture"), { code: "PRIVATE_TOKEN_IDENTITY_INVALID" });
    assert.equal(commands, before);
    assert.equal(await fs.readFile(path.join(moved, "private-core-credential-id"), "utf8"), "damaged-identity");
    await fs.writeFile(path.join(moved, "private-core-credential-id"), identity, "utf8");
    assert.equal(await damaged.read(), "portable-fixture-token");
    await damaged.write("");
    assert.equal(credentials.size, 0);
  } finally { await removeFixture(directory); }
});

test("an environment-managed Desktop token does not create a credential identity", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "private-core-env-identity-"));
  const store = new PrivateCoreSecretStore({ dataDir: directory, desktop: true, env: { CBPANEL_PRIVATE_GITHUB_TOKEN: "environment-fixture" }, run: async () => { throw new Error("OS store must not be called"); } });
  try {
    assert.equal(await store.read(), "environment-fixture");
    await assert.rejects(store.write(""), { code: "PRIVATE_TOKEN_ENV_MANAGED" });
    assert.deepEqual(await fs.readdir(directory), []);
  } finally { await removeFixture(directory); }
});
