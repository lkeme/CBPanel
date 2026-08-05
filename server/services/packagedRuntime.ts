import Module from "node:module";

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
