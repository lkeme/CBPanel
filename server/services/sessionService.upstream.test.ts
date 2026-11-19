import assert from "node:assert/strict";
import test from "node:test";
import { defaultProfile } from "../../src/shared/profile";
import { SessionService } from "./sessionService";

class NoLaunchSessionService extends SessionService {
  spawned = false;
  protected override async startRuntime(): Promise<never> {
    this.spawned = true;
    throw new Error("License failure must be caught before spawning a browser");
  }
}

for (const installed of [true, false]) {
  for (const invalid of [true, false]) {
    test(`preflight and launch agree on ${invalid ? "rejected" : "missing"} license with installed=${installed}`, async () => {
      const service = new NoLaunchSessionService({ browserDataDir: "data/review-unused-browser-dir",
        readBinaryInfo: async () => ({ installed, binaryPath: "C:/fixture/chrome.exe", version: "156.0.8078.47.1", licenseRequired: !invalid, licenseValid: invalid ? false : undefined }),
      });
      const profile = defaultProfile({ id: `license-review-${installed}-${invalid}`, mode: "ephemeral" });
      const preflight = await service.preflight(profile);
      assert.equal(preflight.ok, false);
      const item = preflight.items.find((entry) => entry.id === "browser-license");
      assert.equal(item?.severity, "fail");
      assert.equal(item?.actions?.[0]?.kind, "open-browser-core-settings");
      assert.equal(preflight.items.some((entry) => entry.actions?.some((action) => action.kind === "install-binary")), false);
      await assert.rejects(service.launchProfile(profile), { code: invalid ? "BROWSER_CORE_LICENSE_INVALID" : "BROWSER_CORE_LICENSE_REQUIRED" });
      assert.equal(service.spawned, false);
    });
  }
}
