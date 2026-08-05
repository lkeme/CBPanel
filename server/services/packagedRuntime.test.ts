import assert from "node:assert/strict";
import test from "node:test";
import { installPackagedInspectorShim } from "./packagedRuntime";

type ModuleLoader = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

function loaderWithoutInspector(): { loader: ModuleLoader; requests: string[] } {
  const requests: string[] = [];
  const loader: ModuleLoader = {
    _load(request: string) {
      requests.push(request);
      if (request === "inspector" || request === "node:inspector") {
        throw Object.assign(new Error("Inspector is not available"), { code: "ERR_INSPECTOR_NOT_AVAILABLE" });
      }
      return { request };
    },
  };
  return { loader, requests };
}

test("installPackagedInspectorShim serves a stub for both inspector specifiers when the builtin is unavailable", () => {
  const { loader, requests } = loaderWithoutInspector();
  assert.equal(installPackagedInspectorShim(loader), true);

  const stub = loader._load("inspector", null, false) as { url: () => undefined };
  assert.equal(loader._load("node:inspector", null, false), stub);
  assert.equal(stub.url(), undefined);
  assert.deepEqual(requests, ["node:inspector"]);
});

test("installPackagedInspectorShim keeps unrelated requests on the original loader", () => {
  const { loader, requests } = loaderWithoutInspector();
  installPackagedInspectorShim(loader);

  assert.deepEqual(loader._load("node:path", null, false), { request: "node:path" });
  assert.deepEqual(requests, ["node:inspector", "node:path"]);
});

test("the inspector stub answers only what a build without inspector can answer", () => {
  const { loader } = loaderWithoutInspector();
  installPackagedInspectorShim(loader);
  const stub = loader._load("inspector", null, false) as {
    close: () => undefined;
    open: () => void;
    waitForDebugger: () => void;
    Session: new () => unknown;
  };

  assert.equal(stub.close(), undefined);
  for (const call of [() => stub.open(), () => stub.waitForDebugger(), () => new stub.Session()]) {
    assert.throws(call, (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ERR_INSPECTOR_NOT_AVAILABLE");
      assert.match((error as Error).message, /packaged sidecar/);
      return true;
    });
  }
});

test("installPackagedInspectorShim leaves a runtime that has the inspector builtin untouched", () => {
  const requests: string[] = [];
  const load = (request: string) => {
    requests.push(request);
    return { request };
  };
  const loader: ModuleLoader = { _load: load };

  assert.equal(installPackagedInspectorShim(loader), false);
  assert.equal(loader._load, load);
  assert.deepEqual(requests, ["node:inspector"]);
});

test("installPackagedInspectorShim patches a loader once", () => {
  const { loader } = loaderWithoutInspector();
  assert.equal(installPackagedInspectorShim(loader), true);
  const patched = loader._load;

  assert.equal(installPackagedInspectorShim(loader), false);
  assert.equal(loader._load, patched);
});

test("installPackagedInspectorShim is a no-op on a development runtime with a real inspector", () => {
  assert.equal(process.features.inspector, true);
  assert.equal(installPackagedInspectorShim(), false);
});
