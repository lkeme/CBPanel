import Module from "node:module";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Humanize reads this source at runtime; a successful Playwright import is insufficient. */
export async function assertPackagedHumanizeSource(): Promise<void> {
  const require = Module.createRequire(import.meta.url);
  const packagePath = require.resolve("playwright-core/package.json");
  const source = await fs.readFile(path.join(path.dirname(packagePath), "lib", "coreBundle.js"), "utf8");
  assert.match(source, /generated\/injectedScriptSource\.ts/, "Playwright's humanize engine source is missing.");
}

/** Opt-in release probe: no downloads, external navigation, or existing user profile writes. */
export async function assertPackagedHumanizeBrowser(): Promise<void> {
  const binaryPath = process.env.CLOAKBROWSER_BINARY_PATH?.trim();
  assert.ok(binaryPath, "CLOAKBROWSER_BINARY_PATH is required for the humanize release probe.");
  await fs.access(binaryPath);
  const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "cbpanel-humanize-smoke-"));
  let context: import("playwright-core").BrowserContext | undefined;
  try {
    const { launchPersistentContext } = await import("cloakbrowser");
    context = await launchPersistentContext({
      userDataDir,
      headless: true,
      humanize: true,
      args: ["--fingerprint=123456"],
      launchOptions: { timeout: 20_000 },
    });
    // Using the pre-existing first page catches upstream's persistent-page patch ordering.
    const page = context.pages()[0];
    assert.ok(page, "Persistent context did not create its first page.");
    assert.ok("_cloakHuman" in page, "Persistent first page was not humanized.");
    page.setDefaultTimeout(5_000);
    const html = '<label>Name<input id="name"></label><button onclick="document.querySelector(\'#result\').textContent=document.querySelector(\'#name\').value">Submit</button><p id="result">pending</p><span class="duplicate">one</span><span class="duplicate">two</span>';
    await page.goto(`data:text/html,${encodeURIComponent(html)}`, { waitUntil: "domcontentloaded" });
    await page.getByLabel("Name").fill("humanize-ok");
    assert.equal(await page.getByLabel("Name").inputValue(), "humanize-ok");
    await page.getByRole("button", { name: "Submit" }).click();
    assert.equal(await page.locator("#result").innerText(), "humanize-ok");
    await assert.rejects(page.locator(".duplicate").click(), /strict mode violation/i);
    await assert.rejects(page.locator("#missing").click({ timeout: 100 }), /timeout/i);
  } finally {
    try {
      await context?.close();
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
}

type ModuleLoader = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const INSPECTOR_REQUESTS = new Set(["inspector", "node:inspector"]);
const patchedLoaders = new WeakSet<ModuleLoader>();

/**
 * `@yao-pkg/pkg` builds its Node binaries with `--without-inspector`, so inside the packaged
 * sidecar `require("inspector")` throws `ERR_INSPECTOR_NOT_AVAILABLE` and `process.features.inspector`
 * is `false`. playwright-core's client bundle requires the builtin eagerly — only to ask
 * `inspector.url()` whether a JS debugger is attached — so without a stub `import("playwright-core")`
 * fails, which takes down every Playwright session launch and the packaged dependency probe with it.
 *
 * Serving a stub is honest here: a binary without inspector support can never have a debugger
 * attached, so `url()` really is `undefined` and there really is nothing to `close()`. The rest of the
 * surface cannot be emulated and throws instead of pretending to work.
 *
 * Returns whether the shim was installed on this loader.
 */
export function installPackagedInspectorShim(
  loader: ModuleLoader = Module as unknown as ModuleLoader,
): boolean {
  if (patchedLoaders.has(loader)) return false;
  if (builtinInspectorLoads(loader)) return false;

  const stub = packagedInspectorStub();
  const load = loader._load;
  loader._load = function patchedLoad(request: string, parent: unknown, isMain: boolean) {
    if (INSPECTOR_REQUESTS.has(request)) return stub;
    return load.call(this, request, parent, isMain);
  };
  patchedLoaders.add(loader);
  return true;
}

function builtinInspectorLoads(loader: ModuleLoader): boolean {
  try {
    loader._load("node:inspector", null, false);
    return true;
  } catch {
    return false;
  }
}

function packagedInspectorStub(): Record<string, unknown> {
  const unavailable = (): never => {
    throw Object.assign(new Error("Inspector is not available in the packaged sidecar."), {
      code: "ERR_INSPECTOR_NOT_AVAILABLE",
    });
  };
  return {
    url: () => undefined,
    close: () => undefined,
    open: unavailable,
    waitForDebugger: unavailable,
    Session: class Session {
      constructor() {
        unavailable();
      }
    },
  };
}
